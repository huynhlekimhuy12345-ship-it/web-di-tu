// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch { } }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  autoChant: true, chantEveryMin: 3,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: true,                 // also seat viewers who only enter the room
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
let currentScene = 'pagoda'; // overlay scene: 'pagoda' | 'hell' (host-controlled from the panel)
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s) { const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t: 'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity() { if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng', 'cao tang']], ['monk', ['sư', 'su', 'sư thầy', 'su thay', 'thầy', 'thay']], ['nun', ['ni', 'ni cô', 'ni co', 'sư cô', 'su co']],
  ['child', ['tiểu', 'tieu', 'chú tiểu', 'chu tieu', 'bé', 'be']], ['granny', ['bà', 'ba', 'áo nâu', 'ao nau', 'cụ', 'cu']],
  ['woman', ['nữ', 'nu', 'chị', 'chi', 'gái', 'gai']], ['man', ['nam', 'anh', 'trai']],
];
function skinFromText(t) {
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skin, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];
const VERDICT_LABELS = { 'phan-xet': 'phán xét', 'dinh-toi': 'định tội', 'khai-an': 'khai ân', 'giam-an': 'giảm án', 'sieu-do': 'siêu độ' };

function pub(v) { return { id: v.id, name: v.name, skin: v.skin, avatar: v.avatar || '', coins: v.coins, demo: !!v.demo }; }
function snapshot() { return { t: 'state', settings, scene: currentScene, viewers: [...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState }; }

function seat(id, name, opts = {}) {
  let v = viewers.get(id);
  if (v) { v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew: false }; }
  if (viewers.size >= 100) {                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a, b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v: null, isNew: false };
    viewers.delete(quiet.id); broadcast({ t: 'leave', id: quiet.id });
  }
  v = {
    id, name: (name || id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
    avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo
  };
  viewers.set(id, v);
  broadcast({ t: 'join', v: pub(v), cap: capacity() });
  return { v, isNew: true };
}

// Tự động cho người xem rời chánh điện nếu không còn tương tác (sau 3 phút) để nhường chỗ
const IDLE_TIMEOUT_MS = 180_000; // 3 phút
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of viewers.entries()) {
    if (v.demo) continue; // giữ bot demo
    if (now - v.lastAt > IDLE_TIMEOUT_MS) {
      viewers.delete(id);
      broadcast({ t: 'leave', id });
      addLog(`👋 ${v.name} đã rời chánh điện`);
    }
  }
}, 15_000);

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar) {
  text = String(text || '').slice(0, 120);
  const want = skinFromText(text);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!isNew && want && want !== v.skin) { v.skin = want; broadcast({ t: 'skin', id, skin: want }); }
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t: 'chat', id, name: v.name, text });
}

function onGift(id, name, giftName, count, diamonds, avatar) {
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const line = currentScene === 'hell'
    ? `Nam mô Địa Tạng Vương Bồ Tát. Linh hồn ${spoken(v.name)} nhờ công đức ${giftName}${count > 1 ? ', ' + count + ' lần' : ''} mà được cứu rỗi, siêu thoát.`
    : `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm dâng ${giftName}${count > 1 ? ', ' + count + ' lần' : ''}. ${prayer}.`;
  broadcast({ t: 'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag: 'gift', id });
}

function pickPrayer() {
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
    'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s) { return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }
function say(text, meta = {}) { if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
async function pumpTTS() {
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    try { tts.close(); } catch { }
    fs.writeFileSync(path.join(TTS_DIR, file), Buffer.concat(chunks));
    broadcast({ t: 'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch { } }
  } catch (e) { addLog('TTS lỗi: ' + (e?.message || e)); }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null;
function chant() { const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t: 'chant', text }); say(text, { tag: 'chant' }); }
function scheduleChant() { clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();

/* --------------------------------------------------------------- TikTok */
let TIKTOOL_API_KEY = process.env.TIKTOOL_API_KEY || 'tk_ec5f133d5db4aad82917957e061f654f0b6d097b300204d9';
let TikTokLib = null;

async function connectTikTok(uniqueId) {
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t: 'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('@tiktool/live');
    const { TikTokLive } = TikTokLib;
    const conn = new TikTokLive({
      uniqueId,
      apiKey: TIKTOOL_API_KEY,
    });
    const av = u => u?.profilePicture || u?.avatarLargeUrl || '';
    const nm = u => u?.nickname || u?.uniqueId || 'ẩn danh';
    const uid = u => u?.uniqueId || u?.id || 'khach';

    conn.on('chat', d => {
      addLog(`💬 ${nm(d.user)}: ${d.comment}`);
      onChat(uid(d.user), nm(d.user), d.comment, av(d.user));
    });
    conn.on('gift', d => {
      if (d.giftType === 1 && !d.repeatEnd) return; // streak still running
      const gname = d.giftName || 'quà';
      const dia = d.diamondCount || 1;
      const count = d.repeatCount || 1;
      onGift(uid(d.user), nm(d.user), gname, count, dia, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${count}`);
    });
    conn.on('member', d => {
      if (settings.joinOnEnter) {
        const res = seat(uid(d.user), nm(d.user), { avatar: av(d.user) });
        if (res.isNew) addLog(`🚪 ${nm(d.user)} vào phòng`);
      }
    });
    conn.on('like', d => broadcast({ t: 'like', id: uid(d.user), n: d.likeCount || 1 }));
    conn.on('disconnected', () => {
      tiktokState = { ...tiktokState, status: 'disconnected' };
      broadcast({ t: 'tiktok', ...tiktokState });
      addLog('TikTok: mất kết nối');
    });
    conn.on('error', e => addLog('TikTok lỗi: ' + (e?.message || e)));

    await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: conn.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    let errMsg = String(e?.message || e);
    if (errMsg.includes('not currently live')) {
      errMsg = `Kênh @${uniqueId} hiện KHÔNG phát LIVE hoặc phiên LIVE vừa kết thúc.`;
    }
    tiktokState = { status: 'error', uniqueId, error: errMsg };
    addLog(`❌ Không kết nối được @${uniqueId}: ${errMsg}`);
  }
  broadcast({ t: 'tiktok', ...tiktokState });
}
async function disconnectTikTok() {
  if (tiktok) {
    try { tiktok.disconnect(); } catch {}
    tiktok = null;
  }
  tiktokState = { status: 'idle', uniqueId: '', error: '' };
  broadcast({ t: 'tiktok', ...tiktokState });
}

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh', 'Minh Tâm', 'Thiện Đức', 'Huệ An', 'Tịnh Nhã', 'Quảng Trí', 'Chơn Như', 'Pháp Hỷ', 'Nguyên Thanh', 'Tâm Đăng', 'Diệu Liên', 'Trí Hải', 'Phước Lộc', 'Hạnh Nguyện', 'Như Ý', 'Bảo Châu', 'Thanh Lương', 'Từ Tâm', 'An Lạc', 'Giác Hoa', 'Tuệ Minh', 'Liên Hương', 'Thu Hà', 'Ngọc Lan', 'Đức Anh', 'Hải Đăng', 'Mai Anh', 'Phương Thảo', 'Trung Kiên', 'Quang Huy', 'Bảo Ngọc', 'Diệu Linh'];
function fillDemo(n) {
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++) {
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man', 'woman', 'woman', 'man', 'granny', 'monk', 'nun', 'child'][i % 8] });
  }
}
function clearSeats() { viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m) {
  switch (m.cmd) {
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t: 'bell' }); break;
    case 'mo': broadcast({ t: 'mo1' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag: 'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t: 'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
    case 'scene': { const s = m.scene === 'hell' ? 'hell' : 'pagoda'; currentScene = s; broadcast({ t: 'scene', scene: s }); addLog(s === 'hell' ? 'Chuyển overlay sang Sám Hối Địa Ngục' : 'Chuyển overlay sang Chánh Điện Tịnh Tâm'); break; }
    case 'verdict': { const label = VERDICT_LABELS[m.verdict]; if (!label) break; broadcast({ t: 'verdict', verdict: m.verdict, label }); addLog(`⚖️ Phán quyết: ${label}`); break; }
    case 'salvation': { const n = String(m.name || 'Khách').slice(0, 18); const found = [...viewers.values()].find(v => v.name.toLowerCase() === n.toLowerCase()); broadcast({ t: 'salvation', id: found ? found.id : null, name: found ? found.name : n }); addLog(found ? `✨ ${found.name} được cứu rỗi (thử)` : `✨ Linh hồn ${n} được cứu rỗi (thử)`); break; }
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o) { for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace) {
  clearInterval(botTimer); botTimer = null;
  if (on) {
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length] + ' ·bot', { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t: 'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t: 'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t: 'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath) {
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  }
});
function broadcast(msg, only) { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t: 'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`));
