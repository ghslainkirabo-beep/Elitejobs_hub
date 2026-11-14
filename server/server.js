// Elitejobs Hub server.
// Serves the system to every PC, keeps the one shared company state on disk,
// merges everyone's changes safely, pushes updates to everyone live, and runs
// the AI features.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
// Packaged as an .exe, this file's own folder is read-only, so everything
// the Hub writes lives in DATA_DIR (passed in by electron-main.js).
const DATA_DIR = process.env.HUB_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ACTIVITY = path.join(DATA_DIR, 'activity.jsonl');   // full history, for reports
const BUNDLED_UI = path.join(__dirname, 'public');
const LIVE_UI = path.join(DATA_DIR, 'ui-live');   // a deployed update, if any
const PREV_UI = path.join(DATA_DIR, 'ui-prev');   // the version before it, for rollback
const PREVIEW_UI = path.join(DATA_DIR, 'ui-preview'); // THE HUB UPDATE: waiting for IT's approval
const UPDATES = path.join(DATA_DIR, 'updates');   // app installer updates (electron-updater feed)
const SRC_CFG = path.join(DATA_DIR, 'update-source.json');
const HU_LOG = path.join(DATA_DIR, 'hub-update-history.json');
for (const d of [LIVE_UI, PREV_UI, PREVIEW_UI, UPDATES]) fs.mkdirSync(d, { recursive: true });
const ai = require('./ai.js')(DATA_DIR);
const CLOUD_MODE = process.env.HUB_CLOUD === '1';
const migrate = require('./migrate.js')({ DATA_DIR, loadState: () => loadState(), appendActivity: a => appendActivity(a), CLOUD: CLOUD_MODE, onRestored: () => { console.log('Office data received — restarting.'); process.exit(0); } });
const movedTo = () => migrate.movedTo();

// Versions before 1.1 filled the system with demo people and demo activity.
// The system must start virgin, so set any such old data aside (kept, not deleted).
try {
  const old = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (old && !old.virgin) {
    fs.renameSync(DATA_FILE, path.join(DATA_DIR, 'data-before-1.1-demo.json'));
    console.log('Old demo data set aside as data-before-1.1-demo.json; starting clean.');
  }
} catch (e) {}

// ---- keys ----------------------------------------------------------------
function readOrMakeKey(file, len) {
  try { const k = fs.readFileSync(file, 'utf8').trim(); if (k) return k; } catch (e) {}
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, to avoid typos
  const k = Array.from(crypto.randomBytes(len), b => alphabet[b % alphabet.length]).join('');
  fs.writeFileSync(file, k);
  return k;
}
const OFFICE_KEY = readOrMakeKey(path.join(DATA_DIR, 'office-passcode.txt'), 6);
const IT_KEY = readOrMakeKey(path.join(DATA_DIR, 'it-key.txt'), 10);
console.log('Office passcode: ' + OFFICE_KEY + '   IT key: ' + IT_KEY + '   (saved in ' + DATA_DIR + ')');

// HUB_CLOUD=1: the Hub runs on an internet server behind Cloudflare (Tunnel). Then:
//  - only the tunnel on the same machine can reach it (we listen on 127.0.0.1),
//  - the real caller's address is Cloudflare's CF-Connecting-IP header,
//  - nothing is handed out to "local" callers (every visitor arrives through the local tunnel).
const CLOUD = process.env.HUB_CLOUD === '1';
const sockIp = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const realIp = req => { const s = sockIp(req); if (CLOUD && (s === '127.0.0.1' || s === '::1')) { const h = String(req.headers['cf-connecting-ip'] || '').trim(); if (/^[0-9a-fA-F:.]{3,45}$/.test(h)) return h; } return s; };
const isLocal = req => !CLOUD && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const hasOffice = req => req.headers['x-office-key'] === OFFICE_KEY;
const hasIT = req => req.headers['x-it-key'] === IT_KEY;

// ---- state + safe merging ---------------------------------------------------
const POSITIONS = { admin: 'Admin', it: 'IT Support', hr: 'HR Manager', ops: 'Operations', int: 'Interview Officer', front: 'Front Desk', rec: 'Receptionist', cc: 'Call Center', sm: 'Social Media Manager' };
function blankState() { return { n: 200, virgin: true, empSeq: 0, staff: [], tickets: [], calls: [], cands: [], ints: [], leaves: [], visitors: [], rooms: [], svc: [], msgs: [], notifs: [], log: [], disabled: {} }; }
let STATE = null;
function loadState() {
  if (STATE) return STATE;
  try { STATE = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { STATE = null; }
  return STATE;
}
function saveState(s) {
  STATE = s;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, DATA_FILE); // atomic: a power cut mid-write can't corrupt the data
}
const keyOf = x => (x && x.id) ? 'id:' + x.id : 't:' + (x && x.t) + '|' + (x && x.text);
// Merge two versions of a list: nothing anyone added is lost, and when two
// people changed the same item, the most recent change (_u) wins.
function mergeList(cur, inc) {
  const incKeys = new Set(inc.map(keyOf));
  const curMap = new Map(cur.map(x => [keyOf(x), x]));
  const onlyCur = cur.filter(x => !incKeys.has(keyOf(x)));
  const merged = inc.map(x => { const o = curMap.get(keyOf(x)); return (o && (o._u || 0) > (x._u || 0)) ? o : x; });
  return onlyCur.concat(merged);
}
function recordActivity(cur, out) {
  const seen = new Set((cur.log || []).map(keyOf));
  const fresh = (out.log || []).filter(x => !seen.has(keyOf(x)));
  if (fresh.length) fs.appendFileSync(ACTIVITY, fresh.map(x => JSON.stringify(x)).join('\n') + '\n');
}
function mergeState(cur, inc, it) {
  if (!cur) cur = blankState();
  const out = Object.assign({}, cur, inc);
  for (const k of Object.keys(inc)) {
    if (Array.isArray(cur[k]) && Array.isArray(inc[k])) out[k] = mergeList(cur[k], inc[k]);
  }
  out.staff = cur.staff ? mergeList(cur.staff, (inc.staff || []).filter(x => cur.staff.some(c => c.id === x.id))) : []; // only the Hub creates staff records
  recordActivity(cur, out);
  for (const k of ['notifs', 'log']) {
    if (Array.isArray(out[k])) out[k] = out[k].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, k === 'notifs' ? 200 : 150);
  }
  out.n = Math.max(cur.n || 0, inc.n || 0);
  out.empSeq = cur.empSeq || 0;
  out.virgin = true;
  out.sec = cur.sec || [];
  // Only IT Support (with the IT key) can pause positions or post notices.
  if (!it) { out.disabled = cur.disabled || {}; out.update = cur.update || null; }
  out.rev = (cur.rev || 0) + 1;
  return out;
}
function commit(next) { saveState(next); broadcast({ type: 'state', state: next }); }

// ---- people: the Hub issues company IDs, so they are unique ----------------------
function realHolder(s, role) { return (s.staff || []).filter(x => x.role === role && !x.name.includes('@')).sort((a, b) => a.joined - b.joined)[0] || null; }
function register(name, role, devKey) {
  const s = loadState() || blankState();
  const clean = String(name || '').replace(/[<>&"'`]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (clean.length < 2 || !POSITIONS[role]) throw new Error('A name and a position are needed.');
  // Only ONE real Admin and ONE real IT Support. Anyone else in those positions must put
  // @ in their name (e.g. "@Jean"): they are then a separate, lesser account — never the real one.
  if ((role === 'admin' || role === 'it') && !clean.includes('@')) {
    const real = realHolder(s, role);
    if (real && real.name.toLowerCase() !== clean.toLowerCase()) {
      office.secEvent('Someone tried to sign in as “' + clean + '” in ' + POSITIONS[role] + ', which already belongs to ' + real.name + '. It was refused.', ['admin', 'it']);
      throw Object.assign(new Error(POSITIONS[role] + ' already belongs to ' + real.name + '. There is only one ' + POSITIONS[role] + '. If you also work in ' + POSITIONS[role] + ', sign in again with @ in your name, like @' + clean.split(' ')[0] + '.'), { code: 'ROLE_TAKEN' });
    }
  }
  let p = s.staff.find(x => x.name.toLowerCase() === clean.toLowerCase() && x.role === role);
  const now = Date.now();
  if (!p) {
    s.empSeq = (s.empSeq || 0) + 1;
    p = { id: 'ELR-' + String(s.empSeq).padStart(4, '0'), name: clean, role, dept: POSITIONS[role], joined: now, last: now, on: true, _u: now };
    s.staff.push(p);
    s.log = [{ t: now, by: clean, uid: p.id, role, text: 'joined the system as ' + POSITIONS[role] + ' (' + p.id + ')' }].concat(s.log || []);
    fs.appendFileSync(ACTIVITY, JSON.stringify(s.log[0]) + '\n');
  } else { p.last = now; p._u = now; }
  s.rev = (s.rev || 0) + 1;
  commit(s);
  const trust = bindDevice(p, devKey, s);
  const h = new Date(now).getHours();
  if (h < 6 || h >= 21) office.secEvent(p.name + ' (' + p.dept + ') signed in at ' + new Date(now).toTimeString().slice(0, 5) + ', outside working hours.');
  const other = s.staff.filter(x => x.id !== p.id && x.name.toLowerCase() === clean.toLowerCase());
  if (other.length && p.joined === now) office.secEvent('“' + p.name + '” signed in as ' + p.dept + ' but already exists as ' + other.map(x => x.dept).join(', ') + '. Check this is the same person.');
  return Object.assign({}, p, { device: trust });
}

// ---- devices: each computer/phone/iPad carries its own random key. A person's account
// can only be used for protected rooms (Urgent hiring) from a device that is trusted for
// them. A new device for someone who already has one waits for Admin's approval, and
// both the attempt and the approval are recorded — nobody can quietly use another's account.
const DEV_FILE = path.join(DATA_DIR, 'trusted-devices.json'); // (devices.json is the attendance phones' file)
const devs = () => { try { return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); } catch (e) { return {}; } };
const saveDevs = d => { fs.writeFileSync(DEV_FILE + '.tmp', JSON.stringify(d, null, 1)); fs.renameSync(DEV_FILE + '.tmp', DEV_FILE); };
const hashKey = k => crypto.createHash('sha256').update('ejdev:' + k).digest('hex');
function bindDevice(p, key, s) {
  key = String(key || ''); if (!/^[a-f0-9]{32,64}$/.test(key)) return 'none';
  const d = devs(), h = hashKey(key), cur = d[h];
  if (cur && cur.uid === p.id) { cur.last = Date.now(); saveDevs(d); return cur.ok ? 'trusted' : 'waiting'; }
  const mine = Object.values(d).filter(x => x.uid === p.id && x.ok);
  // first device of a person is trusted — except a second "Admin" while a trusted Admin already exists
  const otherAdmin = false; // a second real Admin can no longer exist (see register)
  const ok = !mine.length;
  d[h] = { uid: p.id, ok, t: Date.now(), last: Date.now(), was: cur ? cur.uid : null };
  saveDevs(d);
  if (!ok) office.secEvent(otherAdmin && !mine.length
    ? '“' + p.name + '” signed in as a new Admin. Their device can’t use protected rooms until the existing Admin approves it (Urgent hiring → Access).'
    : p.name + ' (' + p.dept + ') signed in on a new device. It can’t use protected rooms until Admin approves it (Urgent hiring → Access).', ['admin', 'it']);
  if (cur && cur.uid !== p.id) office.secEvent('A device that belonged to ' + (((s.staff.find(y => y.id === cur.uid)) || {}).name || cur.uid) + ' was used to sign in as ' + p.name + '.', ['admin', 'it']);
  return ok ? 'trusted' : 'waiting';
}
// who is calling, by their device — never by a name they typed
function whoFrom(req) {
  const k = String(req.headers['x-dev-key'] || ''); if (!k) return null;
  const d = devs()[hashKey(k)]; if (!d || !d.ok) return null;
  const s = loadState(); return (s && s.staff.find(x => x.id === d.uid)) || null;
}
const isRealAdmin = p => !!p && p.role === 'admin' && !p.name.includes('@');
function deviceList(admin, it) {
  if (!it && !isRealAdmin(admin)) throw Object.assign(new Error('Only Admin or IT Support can do this.'), { code: 403 });
  const s = loadState() || blankState(), d = devs();
  return Object.entries(d).map(([h, x]) => ({ id: h.slice(0, 16), ok: x.ok, t: x.t, last: x.last, person: (s.staff.find(y => y.id === x.uid) || { name: x.uid }) })).map(x => ({ id: x.id, ok: x.ok, t: x.t, last: x.last, uid: x.person.id, name: x.person.name, dept: x.person.dept })).sort((a, b) => a.ok - b.ok || b.t - a.t);
}
function approveDevice(admin, id, ok, it) {
  deviceList(admin, it);
  const d = devs(), h = Object.keys(d).find(k => k.slice(0, 16) === String(id)); if (!h) throw new Error('That device isn’t in the list.');
  const s = loadState(), who = (s.staff.find(y => y.id === d[h].uid) || { name: d[h].uid });
  if (ok) d[h].ok = true; else delete d[h];
  saveDevs(d);
  const by = isRealAdmin(admin) ? admin : { name: (admin && admin.name) || 'IT Support', id: (admin && admin.id) || '', role: 'it' };
  appendActivity({ t: Date.now(), by: by.name, uid: by.id, role: by.role, text: (ok ? 'approved a new device for ' : 'removed a device of ') + who.name });
  office.secEvent(by.name + (ok ? ' approved a new device for ' : ' removed a device of ') + who.name + '.', ['admin', 'it']);
  return { ok: true };
}
function activity() {
  try { return fs.readFileSync(ACTIVITY, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}
function appendActivity(a) { fs.appendFileSync(ACTIVITY, JSON.stringify(a) + '\n'); }
const office = require('./office.js')({ DATA_DIR, loadState, commit: s => commit(s), broadcast: o => broadcast(o), activity, appendActivity, ai, PORT, ipOf: realIp });
const urgent = require('./urgent.js')({ DATA_DIR, loadState, broadcast: o => broadcast(o), appendActivity, secEvent: (t, w) => office.secEvent(t, w) });
const inquiries = require('./inquiries.js')({ DATA_DIR, broadcast: o => broadcast(o), appendActivity: a => appendActivity(a), urgent });
const cvs = require('./cvs.js')({ DATA_DIR, urgent, appendActivity: a => appendActivity(a) });
const vflow = require('./vflow.js')({ DATA_DIR, urgent, staffOf: () => (loadState().staff || []).filter(x => !x.left), appendActivity: a => appendActivity(a), broadcast: o => broadcast(o) });
const webjobs = require('./webjobs.js')({ DATA_DIR, appendActivity: a => appendActivity(a), broadcast: o => broadcast(o), need: (p, w) => urgent.need(p, w) });

// ---- sign-in anomaly alerts ----
const fails = new Map();
function wrongPasscode(req, what) {
  const ip = realIp(req), now = Date.now();
  const list = (fails.get(ip) || []).filter(t => now - t < 15 * 6e4); list.push(now); fails.set(ip, list);
  if (list.length === 5 || list.length === LOCK_AFTER) office.secEvent(list.length + ' wrong ' + (what || 'office-passcode') + ' attempts in 15 minutes from ' + ip + (list.length >= LOCK_AFTER ? ' — that address is now blocked for 15 minutes.' : '.'));
}
// After too many wrong keys from one address, that address is blocked for 15 minutes (guessing is pointless).
const LOCK_AFTER = 10;
const isLocked = req => (fails.get(realIp(req)) || []).filter(t => Date.now() - t < 15 * 6e4).length >= LOCK_AFTER;
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (!v.some(t => now - t < 15 * 6e4)) fails.delete(k); }, 10 * 6e4).unref();

// ---- UI versions (live updates) -------------------------------------------------
const activeUiDir = () => fs.existsSync(path.join(LIVE_UI, 'index.html')) ? LIVE_UI : BUNDLED_UI;
const hashOf = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
const activeHtml = () => fs.readFileSync(path.join(activeUiDir(), 'index.html'), 'utf8');
function uiVersion() { try { return hashOf(fs.readFileSync(path.join(activeUiDir(), 'index.html'))); } catch (e) { return 'none'; } }
function uiInfo() {
  let at = null; try { at = fs.statSync(path.join(activeUiDir(), 'index.html')).mtimeMs; } catch (e) {}
  let engine = ''; try { engine = require('./package.json').version; } catch (e) {}
  return { v: uiVersion(), source: activeUiDir() === LIVE_UI ? 'deployed' : 'built-in', at, canRollback: fs.existsSync(path.join(PREV_UI, 'index.html')), engine };
}
function goLive(html) {
  const live = path.join(LIVE_UI, 'index.html');
  fs.copyFileSync(path.join(activeUiDir(), 'index.html'), path.join(PREV_UI, 'index.html'));
  fs.writeFileSync(live + '.tmp', html); fs.renameSync(live + '.tmp', live);
  const info = uiInfo();
  broadcast({ type: 'ui', v: info.v });
  return info;
}
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJSON(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

// ---- automatic updates from an online source (e.g. a GitHub file) ------------------
async function checkSource(manual) {
  const cfg = readJSON(SRC_CFG, {});
  if (!cfg.url) return { ok: false, msg: 'No update address set.' };
  try {
    const r = await fetch(cfg.url, { cache: 'no-store', headers: cfg.token ? { Authorization: 'token ' + cfg.token } : {} });
    if (!r.ok) throw new Error('the address answered ' + r.status);
    const html = await r.text();
    ai.checkPage(html);
    const v = hashOf(Buffer.from(html));
    cfg.lastCheck = Date.now(); cfg.lastError = null;
    if (v === uiVersion()) { writeJSON(SRC_CFG, cfg); return { ok: true, msg: 'Already up to date (' + v + ').' }; }
    if (cfg.auto !== false) {
      const info = goLive(html); cfg.lastApplied = { v, t: Date.now() }; writeJSON(SRC_CFG, cfg);
      return { ok: true, msg: 'New version ' + info.v + ' applied for everyone.' };
    }
    fs.writeFileSync(path.join(PREVIEW_UI, 'index.html'), html);
    writeJSON(path.join(PREVIEW_UI, 'meta.json'), { from: 'source', summary: 'A new version arrived from the update address.', t: Date.now() });
    writeJSON(SRC_CFG, cfg);
    return { ok: true, msg: 'New version ' + v + ' is waiting for approval in THE HUB UPDATE.' };
  } catch (e) {
    cfg.lastCheck = Date.now(); cfg.lastError = e.message; writeJSON(SRC_CFG, cfg);
    return { ok: false, msg: 'Update check failed: ' + e.message };
  }
}
setInterval(() => checkSource(false).catch(() => {}), 5 * 60 * 1000);
setTimeout(() => checkSource(false).catch(() => {}), 20000);

// ---- small helpers ----------------------------------------------------------------
function broadcast(obj) { const m = JSON.stringify(obj); wss.clients.forEach(c => { if (c.readyState === 1 && c.authed) c.send(m); }); }
function readBody(req, limit, cb) {
  const chunks = []; let size = 0, dead = false;
  req.on('data', c => { size += c.length; if (size > limit) { dead = true; req.destroy(); } else chunks.push(c); });
  req.on('end', () => { if (!dead) cb(Buffer.concat(chunks)); });
}
const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
function jsonBody(req, res, limit, fn) {
  readBody(req, limit, async buf => {
    let b; try { b = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    try { json(res, 200, await fn(b)); }
    catch (e) { json(res, 400, { error: e.message || String(e) }); }
  });
}
function snapshot(s) {
  s = s || blankState();
  const online = onlineIds();
  return {
    time: new Date().toString(), staffTotal: s.staff.length, onlineNow: s.staff.filter(p => online.has(p.id)).map(p => p.name + ' (' + p.dept + ')'),
    openTickets: s.tickets.filter(t => t.st !== 'resolved').length, callsWaiting: s.calls.filter(c => c.st === 'queued').length,
    visitorsOnSite: s.visitors.filter(v => v.st === 'in').length, candidates: s.cands.length,
    walkInsToday: s.cands.filter(c => c.src === 'walk-in' && new Date(c.t).toDateString() === new Date().toDateString()).length,
    pendingLeave: s.leaves.filter(l => l.st === 'pending').length, interviewsScheduled: s.ints.filter(i => i.st === 'scheduled').length
  };
}

// ---- HTTP ---------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const post = req.method === 'POST';

  // moved to the cloud: this old Hub only points everyone to the new address
  const mv = movedTo();
  if (mv) {
    if (p === '/api/where') return json(res, 200, { movedTo: mv });
    if (p.startsWith('/api/') || p.startsWith('/updates')) return json(res, 410, { error: 'The Hub has moved to ' + mv, movedTo: mv });
    if (p === '/checkin' || p === '/link') {
      // phones keep their link: hand the phone's saved token over to the new address
      const ck = (String(req.headers.cookie || '').match(/(?:^|;\s*)ejd=([A-Za-z0-9_-]+)/) || [])[1] || '';
      return send(res, 200, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Elitejobs Hub moved</title><p style="font-family:sans-serif;padding:24px">Opening the new Hub…</p><script>var t='';try{t=localStorage.getItem('ej-dev')||''}catch(e){}if(!t){var m=document.cookie.match(/(?:^|;\\s*)ejdev=([A-Za-z0-9_-]+)/);if(m)t=m[1]}if(!t)t=${JSON.stringify(ck)};location.replace(${JSON.stringify(mv + p + url.search)}+(t?'#carry='+t:''))</script>`, MIME['.html']);
    }
    res.writeHead(302, { Location: mv + p + url.search }); return res.end();
  }
  if (p === '/api/where') return json(res, 200, { movedTo: null, cloud: CLOUD });
  if (p.startsWith('/api/') && !hasOffice(req) && isLocked(req)) return send(res, 429, 'Too many wrong passcodes from this address. Wait 15 minutes.');
  if (req.headers['x-it-key'] && !hasIT(req)) wrongPasscode(req, 'IT-key');
  if (p === '/api/check-key') { if (!hasOffice(req)) wrongPasscode(req); return send(res, hasOffice(req) ? 204 : 401, ''); }
  if (p === '/api/check-it-key') return send(res, hasIT(req) ? 204 : 401, '');
  // ---- one-time move from the office PC into this (empty) cloud Hub ----
  if (p === '/api/restore' && post) return migrate.receive(req, res, realIp(req));
  // The Hub PC itself never has to type keys: requests from this same machine get them.
  if (p === '/api/local-keys') return isLocal(req) ? json(res, 200, { office: OFFICE_KEY, it: IT_KEY }) : send(res, 403, '');
  if (p === '/api/ui-version') return json(res, 200, uiInfo());

  // ---- phones: attendance check-in (the linked phone is the credential, not the passcode) ----
  if (p === '/checkin' || p === '/link') return fs.readFile(path.join(BUNDLED_UI, 'checkin.html'), (e, d) => e ? send(res, 404, 'missing') : send(res, 200, d, MIME['.html']));
  // The phone's link is also kept in a cookie set by the Hub itself, so it survives
  // iPhone/Android browsers clearing page storage. Name differs from the page's own cookie.
  const devCookie = () => (String(req.headers.cookie || '').match(/(?:^|;\s*)ejd=([A-Za-z0-9_-]+)/) || [])[1] || '';
  const setDev = t => res.setHeader('Set-Cookie', 'ejd=' + t + '; Max-Age=' + (t ? 315360000 : 0) + '; Path=/; HttpOnly; SameSite=Lax');
  if (p === '/api/att/link' && post) return jsonBody(req, res, 1e4, b => { const r = office.link(String(b.code || ''), req.headers['user-agent']); setDev(r.token); return r; });
  if (p === '/api/att/title' && post) return jsonBody(req, res, 1e4, b => office.setTitle(String(b.dev || devCookie()), String(b.title || '')));
  if (p === '/api/att/whoami' && post) return jsonBody(req, res, 1e4, b => ({ me: office.whoami(String(b.dev || devCookie())) }));
  if (p === '/api/att/scan' && post) return readBody(req, 1e4, buf => {
    let b; try { b = JSON.parse(buf.toString('utf8')); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    if (!b.dev) b.dev = devCookie();
    try { json(res, 200, office.scan(b, req)); } catch (e) { if (e.code === 'NOT_LINKED' && devCookie()) setDev(''); json(res, 400, { error: e.message, code: e.code || null }); }
  });

  // everything below needs the office passcode
  if (p.startsWith('/api/') && !hasOffice(req) && !(p.startsWith('/api/deploy') || p === '/api/rollback' || p === '/api/upload-app')) { wrongPasscode(req); return send(res, 401, 'wrong passcode'); }

  // ---- attendance (staff + Admin) ----
  if (p === '/api/att/linkcode' && post) return jsonBody(req, res, 1e4, async b => { const l = office.makeLink(String(b.uid || '')); return Object.assign(l, { svg: await office.svg(l.url) }); });
  if (p === '/api/att/mine') return json(res, 200, office.mine(url.searchParams.get('uid') || ''));
  if (p === '/api/att/unlink' && post) return jsonBody(req, res, 1e4, b => office.unlink(String(b.uid || '')));
  if (p === '/api/att/day') return json(res, 200, office.dayView(url.searchParams.get('day') || ''));
  if (p === '/api/att/qr') return office.svg(office.wallUrl()).then(svg => json(res, 200, { svg, url: office.wallUrl(), settings: office.cfg() })).catch(e => json(res, 400, { error: e.message }));
  if (p === '/api/att/poster') return office.poster().then(html => json(res, 200, { name: 'Elitejobs attendance QR poster.html', html })).catch(e => json(res, 400, { error: e.message }));
  if (p === '/api/att/settings' && post) return jsonBody(req, res, 1e4, b => office.setCfg(b, req));
  if (p === '/api/att/rotate' && post) return jsonBody(req, res, 1e4, () => { const c = office.rotate(); office.secEvent('The attendance QR code was replaced. Print and put up the new one.', ['admin', 'it']); return c; });
  // ---- reports ----
  if (p === '/api/myreport' && post) return jsonBody(req, res, 1e4, b => office.makeReport(String(b.uid || ''), String(b.period || 'daily')));
  if (p === '/api/myreports') return json(res, 200, office.myReports(url.searchParams.get('uid') || ''));
  if (p === '/api/admin/overview') return json(res, 200, office.overview(url.searchParams.get('period') || 'daily', url.searchParams.get('date') || ''));
  if (p === '/api/admin/report') return json(res, 200, office.getReport(url.searchParams.get('id') || ''));
  if (p === '/api/admin/download') { try { return json(res, 200, office.docFor(url.searchParams.get('scope') || 'all', { uid: url.searchParams.get('uid'), role: url.searchParams.get('role'), period: url.searchParams.get('period') || 'daily', date: url.searchParams.get('date') || '' })); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p === '/api/ai/interview' && post) return jsonBody(req, res, 2e4, b => ai.interviewReview(b));

  if (p === '/api/state' && req.method === 'GET') return json(res, 200, loadState() || {});
  if (p === '/api/state' && req.method === 'PUT') {
    return readBody(req, 20e6, buf => {
      let inc; try { inc = JSON.parse(buf.toString('utf8')); } catch (e) { return send(res, 400, 'bad json'); }
      commit(mergeState(loadState(), inc, hasIT(req)));
      send(res, 204, '');
    });
  }
  if (p === '/api/register' && post) return readBody(req, 1e5, buf => {
    let b; try { b = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    try { json(res, 200, register(b.name, b.role, b.dev)); } catch (e) { json(res, e.code === 'ROLE_TAKEN' ? 409 : 400, { error: e.message, code: e.code || null }); }
  });

  // ---- regular jobs on the website (identity = trusted device; permission = Admin's Publish grant) ----
  if (p.startsWith('/api/webjobs')) {
    const me = whoFrom(req);
    const run = fn => Promise.resolve().then(fn).then(r => json(res, 200, r)).catch(e => json(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message || String(e) }));
    if (p === '/api/webjobs' && !post) return run(() => webjobs.list(me));
    // opening jobs are built into the website's code; the Hub only publishes urgent jobs
    if ((p === '/api/webjobs/save' || p === '/api/webjobs/close') && post) return json(res, 410, { error: 'Opening jobs are built into the website now. Publish urgent jobs from Urgent hiring.' });
    return send(res, 404, '');
  }

  // ---- Open jobs inquiry (website "Message us" → rooms → SMS reply). Identity = trusted device; rooms = Admin's grant per position ----
  if (p.startsWith('/api/inq/')) {
    const me = whoFrom(req), q = url.searchParams;
    const run = fn => Promise.resolve().then(fn).then(r => json(res, 200, r)).catch(e => json(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message || String(e) }));
    const body = fn => readBody(req, 1e4, buf => run(() => fn(JSON.parse(buf.toString() || '{}'))));
    const smsWho = () => { if (hasIT(req)) return { name: 'IT', role: 'it' }; if (me && inquiries.isAdmin(me)) return me; throw Object.assign(new Error('Only Admin or IT can change the SMS settings.'), { code: 403 }); };
    if (p === '/api/inq/me') return run(() => inquiries.me(me));
    if (p === '/api/inq/room') return run(() => inquiries.room(me, q.get('r') || ''));
    if (p === '/api/inq/reply' && post) return body(b => inquiries.reply(me, b));
    if (p === '/api/inq/done') return run(() => inquiries.done(me, q.get('r') || ''));
    if (p === '/api/inq/file') { try { const f = inquiries.file(me, q.get('id') || '', q.get('k') || ''); return fs.readFile(f.path, (e, d) => e ? send(res, 404, '') : (res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'private, no-store', 'Content-Disposition': (f.type.startsWith('image/') ? 'inline' : 'inline') + '; filename="' + String(f.name).replace(/[^\w.\- ]/g, '_') + '"', 'X-Content-Type-Options': 'nosniff' }), res.end(d))); } catch (e) { return json(res, e.code || 400, { error: e.message }); } }
    if (p === '/api/inq/exported' && post) return body(b => inquiries.exported(me, b));
    if (p === '/api/inq/called' && post) return body(b => inquiries.called(me, b));
    if (p === '/api/inq/grants' && !post) return run(() => inquiries.grantsView(me));
    if (p === '/api/inq/grants' && post) return body(b => inquiries.setGrants(me, b));
    if (p === '/api/inq/sms' && !post) return run(() => { smsWho(); return inquiries.smsView(); });
    if (p === '/api/inq/sms' && post) return body(b => inquiries.setSms(smsWho(), b));
    if (p === '/api/inq/sms/test' && post) return body(b => inquiries.testSms(smsWho(), b.to));
    if (p === '/api/inq/sync' && post) return run(async () => { if (!me) throw Object.assign(new Error('Sign in first.'), { code: 401 }); await inquiries.sync(); return { ok: true }; });
    return send(res, 404, '');
  }

  // ---- Vacancy flow + Elitejobs database (grants and passkeys by Admin) ----
  if (p.startsWith('/api/vf/')) {
    const me = whoFrom(req), q = url.searchParams;
    const run = fn => Promise.resolve().then(fn).then(r => json(res, 200, r)).catch(e => json(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message || String(e) }));
    const body = (n, fn) => readBody(req, n, buf => run(() => fn(JSON.parse(buf.toString() || '{}'))));
    if (!me) return json(res, 401, { error: 'Sign in first.' });
    if (p === '/api/vf/me') return run(() => vflow.mine(me));
    if (p === '/api/vf/list') return run(() => vflow.list(me, q.get('scope') || 'active'));
    if (p === '/api/vf/create' && post) return body(2e4, b => vflow.create(me, b));
    if (p === '/api/vf/claim' && post) return body(1e4, b => vflow.claimPost(me, String(b.id || '')));
    if (p === '/api/vf/call' && post) return body(1e4, b => vflow.callApprove(me, String(b.id || '')));
    if (p === '/api/vf/complete' && post) return body(1e4, b => vflow.complete(me, String(b.id || '')));
    if (p === '/api/vf/interview' && post) return body(1e4, b => vflow.intApprove(me, String(b.id || '')));
    if (p === '/api/vf/grants') return run(() => vflow.grantsView(me));
    if (p === '/api/vf/grant' && post) return body(1e4, b => vflow.setGrant(me, b));
    if (p === '/api/vf/keys') return run(() => vflow.keysView(me));
    if (p === '/api/vf/keys/forge' && post) return body(1e4, b => vflow.forge(me, b));
    if (p === '/api/vf/keys/revoke' && post) return body(1e4, b => vflow.revoke(me, String(b.id || '')));
    if (p === '/api/vf/db/unlock' && post) return body(1e4, b => vflow.unlock(me, b.key));
    if (p === '/api/vf/db') return run(() => vflow.dbList(me));
    return send(res, 404, '');
  }

  // ---- CV studio: search a person, fill a CV from what they sent us, keep the CVs we make ----
  if (p.startsWith('/api/cv/')) {
    const me = whoFrom(req), q = url.searchParams;
    const run = fn => Promise.resolve().then(fn).then(r => json(res, 200, r)).catch(e => json(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message || String(e) }));
    if (p === '/api/cv/search') return run(() => cvs.search(me, q.get('q') || ''));
    if (p === '/api/cv/person') return run(() => cvs.person(me, q.get('key') || ''));
    if (p === '/api/cv/read') return run(() => cvs.read(me, q.get('ref') || ''));
    if (p === '/api/cv/file') { try { const f = cvs.raw(me, q.get('ref') || ''); return fs.readFile(f.file, (e, d) => e ? send(res, 404, '') : send(res, 200, d, f.type)); } catch (e) { return send(res, e.code || 400, e.message); } }
    if (p === '/api/cv/save' && post) return readBody(req, 4e5, buf => run(() => cvs.save(me, JSON.parse(buf.toString() || '{}'))));
    if (p === '/api/cv/remove' && post) return readBody(req, 1e4, buf => run(() => cvs.remove(me, String(JSON.parse(buf.toString() || '{}').id || ''))));
    return send(res, 404, '');
  }

  // ---- Urgent hiring (identity = trusted device; permission = Admin's grant) ----
  if (p.startsWith('/api/urgent/') || p.startsWith('/api/devices')) {
    const me = whoFrom(req), q = url.searchParams;
    const run = fn => Promise.resolve().then(fn).then(r => json(res, 200, r)).catch(e => json(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message || String(e) }));
    if (p === '/api/urgent/cfg' && !post) return run(() => { if (!hasIT(req)) urgent.need(me, 'admin'); return urgent.cfgView(); });
    if (p === '/api/urgent/me') return run(() => Object.assign(urgent.me(me), { signedIn: !!me }));
    if (p === '/api/devices' && !post) return run(() => deviceList(me, hasIT(req)));
    if (p === '/api/devices' && post) return readBody(req, 1e4, buf => run(() => { const b = JSON.parse(buf.toString() || '{}'); return approveDevice(me, b.id, !!b.ok, hasIT(req)); }));
    if (p === '/api/urgent/grants' && !post) return run(() => urgent.grantsView(me));
    if (p === '/api/urgent/grants' && post) return readBody(req, 1e4, buf => run(() => urgent.setGrant(me, JSON.parse(buf.toString() || '{}'))));
    if (p === '/api/urgent/cfg' && post) return readBody(req, 1e4, buf => run(() => { if (!hasIT(req)) urgent.need(me, 'admin'); return urgent.setCfg(JSON.parse(buf.toString() || '{}')); }));
    if (p === '/api/urgent/sync' && post) return run(async () => { urgent.need(me, urgent.rights(me).review ? 'review' : 'admin'); await urgent.sync(); return urgent.cfgView(); });
    if (p === '/api/urgent/posts' && !post) return run(() => urgent.posts(me));
    if (p === '/api/urgent/posts' && post) return readBody(req, 12e6, buf => run(async () => { const b = JSON.parse(buf.toString() || '{}'), j = await urgent.publish(me, b); if (b.vac && j && j.id) vflow.posted(me, String(b.vac), j.id, b.title); return j; }));
    if (p === '/api/urgent/posts/edit' && post) return readBody(req, 2e4, buf => run(() => urgent.editPost(me, JSON.parse(buf.toString() || '{}'))));
    if (p === '/api/urgent/doc') { try { const f = urgent.doc(me, q.get('app'), q.get('k')); return fs.readFile(f.file, (e, d) => e ? send(res, 404, '') : (res.setHeader('Content-Disposition', `inline; filename="${f.name}"`), send(res, 200, d, f.type))); } catch (e) { return send(res, e.code || 400, e.message); } }
    if (p === '/api/urgent/posts/remove' && post) return readBody(req, 1e4, buf => run(() => urgent.removePost(me, JSON.parse(buf.toString() || '{}').id)));
    if (p === '/api/urgent/apps') return run(() => urgent.apps(me, { scope: q.get('scope') || '', d: q.get('d') || '' }));
    if (p === '/api/urgent/photo') { try { const f = urgent.photo(me, q.get('app'), q.get('n')); return fs.readFile(f.file, (e, d) => e ? send(res, 404, '') : send(res, 200, d, f.type)); } catch (e) { return send(res, e.code || 400, e.message); } }
    if (p === '/api/urgent/outcome' && post) return readBody(req, 1e4, buf => run(() => urgent.outcome(me, JSON.parse(buf.toString() || '{}'))));
    if (p === '/api/urgent/finish' && post) return readBody(req, 1e4, buf => run(() => urgent.finish(me, JSON.parse(buf.toString() || '{}'))));
    if (p === '/api/urgent/reopen' && post) return readBody(req, 1e4, buf => run(() => urgent.reopen(me, JSON.parse(buf.toString() || '{}').id)));
    if (p === '/api/urgent/report') return run(() => urgent.report(me));
    return send(res, 404, '');
  }

  // ---- reports & AI (every position) ----
  if (p === '/api/activity') {
    const uid = url.searchParams.get('uid'), role = url.searchParams.get('role'), since = +url.searchParams.get('since') || 0;
    return json(res, 200, activity().filter(a => (!uid || a.uid === uid) && (!role || a.role === role) && (a.t || 0) >= since).reverse().slice(0, 2000));
  }
  if (p === '/api/ai/status') return json(res, 200, ai.status());
  if (p === '/api/ai/scan' && post) return jsonBody(req, res, 25e6, b => {
    if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(b.mime || '')) throw new Error('Use a photo (JPG/PNG) or a PDF.');
    return ai.scan({ data: String(b.data || ''), mime: b.mime });
  });
  if (p === '/api/ai/triage' && post) return jsonBody(req, res, 1e5, b => ai.triage({ text: b.text, kind: b.kind }));
  if (p === '/api/ai/report' && post) return jsonBody(req, res, 1e5, b => {
    const since = Date.now() - ({ daily: 1, weekly: 7, monthly: 30 }[b.period] || 1) * 864e5;
    const acts = activity().filter(a => (a.t || 0) >= since && (b.uid ? a.uid === b.uid : a.role === b.role)).reverse();
    if (!acts.length) return { text: 'There is no recorded activity for this person in this period yet.' };
    return ai.report({ who: b.who || POSITIONS[b.role], role: POSITIONS[b.role] || b.role, period: b.period, activity: acts, counts: { actions: acts.length } }).then(t => ({ text: t }));
  });
  if (p === '/api/ai/ask' && post) return jsonBody(req, res, 2e5, b => ai.ask({ question: b.question, history: b.history, who: b.who, role: POSITIONS[b.role] || b.role, snapshot: snapshot(loadState()) }).then(t => ({ text: t })));
  if (p === '/api/ai/match' && post) return jsonBody(req, res, 1e5, b => {
    const s = loadState() || blankState();
    const cands = s.cands.filter(c => !['hired', 'rejected'].includes(c.st)).map(c => ({ id: c.id, roleSought: c.role, location: c.location || '', skills: c.skills || '', notes: c.notes || '', stage: c.st }));
    if (!cands.length) return { ranking: [] };
    return ai.match({ vacancy: b.vacancy, candidates: cands });
  });

  // ---- company documents for the assistant (IT) ----
  if (p === '/api/docs' && req.method === 'GET') return json(res, 200, ai.listDocs());
  if (p === '/api/docs' && post) {
    if (!hasIT(req)) return send(res, 401, 'IT key required');
    return readBody(req, 15e6, buf => { try { json(res, 200, ai.saveDoc(url.searchParams.get('name'), buf)); } catch (e) { json(res, 400, { error: e.message }); } });
  }
  if (p === '/api/docs' && req.method === 'DELETE') { if (!hasIT(req)) return send(res, 401, 'IT key required'); return json(res, 200, ai.deleteDoc(url.searchParams.get('name'))); }

  // ---- IT only: move this office Hub into the cloud (one time) ----
  if (p === '/api/it/move' && post) {
    if (!hasIT(req)) return send(res, 401, 'IT key required');
    if (CLOUD) return json(res, 400, { error: 'This Hub is already the cloud Hub.' });
    return jsonBody(req, res, 1e4, b => migrate.send(b.to, String(b.code || '').trim().toUpperCase(), String(b.who || '').slice(0, 60)));
  }
  if (p === '/api/it/webjobs-key') { if (!hasIT(req)) return send(res, 401, 'IT key required'); if (!post) return json(res, 200, webjobs.keyView()); return jsonBody(req, res, 1e4, b => { const r = webjobs.setKey(b); appendActivity({ t: Date.now(), by: 'IT', text: 'changed the website jobs key' }); return r; }); }
  if (p === '/api/it/move-info' && !post) { if (!hasIT(req)) return send(res, 401, 'IT key required'); return json(res, 200, { cloud: CLOUD, movedTo: movedTo(), files: migrate.list().length }); }

  // ---- IT only: AI settings, update source, THE HUB UPDATE ----
  if (p.startsWith('/api/it/') && !hasIT(req)) return send(res, 401, 'IT key required');
  if (p === '/api/it/ai' && post) return jsonBody(req, res, 1e5, b => ai.settings(b));
  if (p === '/api/it/ai/test' && post) return jsonBody(req, res, 1e4, () => ai.triage({ text: 'Test: the office printer is not printing.', kind: 'ticket' }).then(r => ({ ok: true, sample: r })));
  if (p === '/api/it/workbench' && post) return jsonBody(req, res, 2e5, b => ai.workbench({ mode: b.mode, history: b.history, message: b.message, systemContext: b.withCode ? activeHtml() : null }).then(t => ({ text: t })));
  if (p === '/api/it/source' && req.method === 'GET') { const c = readJSON(SRC_CFG, {}); return json(res, 200, Object.assign({}, c, { token: c.token ? 'set' : '' })); }
  if (p === '/api/it/source' && post) return jsonBody(req, res, 1e4, b => {
    const c = readJSON(SRC_CFG, {});
    if (typeof b.url === 'string') { b.url = b.url.trim(); if (b.url && !/^https:\/\//.test(b.url)) throw new Error('Use an https:// address.'); c.url = b.url.trim(); }
    if (typeof b.auto === 'boolean') c.auto = b.auto;
    if (typeof b.token === 'string' && b.token !== 'set') c.token = b.token.trim();
    writeJSON(SRC_CFG, c); return Object.assign({}, c, { token: c.token ? 'set' : '' });
  });
  if (p === '/api/it/source/check' && post) return jsonBody(req, res, 1e4, () => checkSource(true));
  if (p === '/api/it/hubupdate' && post) return jsonBody(req, res, 1e5, async b => {
    if (!b.idea || String(b.idea).trim().length < 8) throw new Error('Describe the idea in a sentence or two.');
    const r = await ai.hubUpdate({ html: activeHtml(), req: { idea: String(b.idea).slice(0, 4000), where: b.where, layout: b.layout, target: b.target, tools: b.tools } });
    fs.writeFileSync(path.join(PREVIEW_UI, 'index.html'), r.html);
    const meta = { from: 'ai', idea: b.idea, target: b.target, summary: r.summary, notes: r.notes, edits: r.edits, t: Date.now(), v: hashOf(Buffer.from(r.html)) };
    writeJSON(path.join(PREVIEW_UI, 'meta.json'), meta);
    const h = readJSON(HU_LOG, []); h.unshift(Object.assign({ status: 'preview' }, meta)); writeJSON(HU_LOG, h.slice(0, 100));
    return meta;
  });
  if (p === '/api/it/hubupdate/pending' && req.method === 'GET') {
    const has = fs.existsSync(path.join(PREVIEW_UI, 'index.html'));
    return json(res, 200, { pending: has ? readJSON(path.join(PREVIEW_UI, 'meta.json'), {}) : null, history: readJSON(HU_LOG, []).slice(0, 20) });
  }
  if (p === '/api/it/hubupdate/approve' && post) return jsonBody(req, res, 1e4, () => {
    const f = path.join(PREVIEW_UI, 'index.html');
    if (!fs.existsSync(f)) throw new Error('There is no preview waiting.');
    const html = fs.readFileSync(f, 'utf8'); ai.checkPage(html);
    const info = goLive(html); fs.unlinkSync(f);
    const h = readJSON(HU_LOG, []); if (h[0] && h[0].status === 'preview') h[0].status = 'deployed'; writeJSON(HU_LOG, h);
    return info;
  });
  if (p === '/api/it/hubupdate/discard' && post) return jsonBody(req, res, 1e4, () => {
    try { fs.unlinkSync(path.join(PREVIEW_UI, 'index.html')); } catch (e) {}
    const h = readJSON(HU_LOG, []); if (h[0] && h[0].status === 'preview') h[0].status = 'discarded'; writeJSON(HU_LOG, h);
    return { ok: true };
  });

  // ---- IT: deploy a new version of the system UI to everyone, live ----
  if (p === '/api/deploy' && post) {
    if (!hasIT(req)) return send(res, 401, 'IT key required');
    return readBody(req, 15e6, buf => {
      const html = buf.toString('utf8');
      try { ai.checkPage(html); } catch (e) { return send(res, 400, 'That file is not a working Elitejobs Hub system page. ' + e.message); }
      json(res, 200, goLive(html));
    });
  }
  if (p === '/api/rollback' && post) {
    if (!hasIT(req)) return send(res, 401, 'IT key required');
    const prev = path.join(PREV_UI, 'index.html');
    if (!fs.existsSync(prev)) return send(res, 400, 'Nothing to roll back to.');
    const live = path.join(LIVE_UI, 'index.html'), cur = path.join(activeUiDir(), 'index.html'), swap = path.join(DATA_DIR, 'swap.html');
    fs.copyFileSync(cur, swap); fs.copyFileSync(prev, live); fs.copyFileSync(swap, prev); fs.unlinkSync(swap);
    const info = uiInfo(); broadcast({ type: 'ui', v: info.v });
    return json(res, 200, info);
  }
  // ---- IT: upload a new app installer (picked up by every PC's auto-updater) ----
  if (p === '/api/upload-app' && post) {
    if (!hasIT(req)) return send(res, 401, 'IT key required');
    const name = url.searchParams.get('name') || '';
    if (!/^(latest\.yml|Elitejobs[ -]Hub[ -]Setup[ -][\d.]+\.exe(\.blockmap)?)$/.test(name)) return send(res, 400, 'Unexpected file name: ' + name);
    const dest = path.join(UPDATES, name), tmp = dest + '.part', out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, dest); send(res, 200, 'saved ' + name); });
    out.on('error', e => send(res, 500, e.message));
    return;
  }
  if (p.startsWith('/api/')) return send(res, 404, 'unknown');

  // ---- the IT safety page: always the built-in copy, so a bad update can't break it ----
  if (p === '/it') return fs.readFile(path.join(BUNDLED_UI, 'it.html'), (e, d) => e ? send(res, 404, 'missing') : send(res, 200, d, MIME['.html']));
  // ---- THE HUB UPDATE preview (read-only copy of the system with the proposed change) ----
  if (p === '/preview') return fs.readFile(path.join(PREVIEW_UI, 'index.html'), (e, d) => e ? send(res, 404, 'No preview waiting.') : send(res, 200, d, MIME['.html']));

  // ---- app auto-update feed ----
  if (p.startsWith('/updates/')) {
    const f = path.join(UPDATES, decodeURIComponent(p.slice('/updates/'.length)));
    if (!f.startsWith(UPDATES + path.sep)) return send(res, 403, '');
    return fs.stat(f, (e, st) => {
      if (e) return send(res, 404, 'no update');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(f).pipe(res);
    });
  }

  // ---- the system itself ----
  const dir = activeUiDir();
  const file = path.join(dir, p === '/' ? 'index.html' : decodeURIComponent(p));
  if (!file.startsWith(dir + path.sep)) return send(res, 403, '');
  fs.readFile(file, (err, data) => {
    if (err) {
      const fb = path.join(BUNDLED_UI, p === '/' ? 'index.html' : decodeURIComponent(p));
      if (!fb.startsWith(BUNDLED_UI + path.sep)) return send(res, 404, 'not found');
      return fs.readFile(fb, (e2, d2) => e2 ? send(res, 404, 'not found') : send(res, 200, d2, MIME[path.extname(fb)]));
    }
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

// ---- live channel + who is online --------------------------------------------------
const wss = new WebSocketServer({ server });
function onlineIds() { const s = new Set(); wss.clients.forEach(c => { if (c.authed && c.uid) s.add(c.uid); }); return s; }
let lastPresence = '';
function pushPresence() { const ids = [...onlineIds()].sort(); const k = ids.join(','); if (k === lastPresence) return; lastPresence = k; broadcast({ type: 'presence', online: ids }); }
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (movedTo()) { ws.close(4010, 'moved'); return; }
  if (isLocked(req)) { ws.close(4029, 'blocked'); return; }
  if (url.searchParams.get('key') !== OFFICE_KEY) { wrongPasscode(req); ws.close(4001, 'wrong passcode'); return; }
  ws.authed = true;
  ws.send(JSON.stringify({ type: 'ui', v: uiVersion() }));
  const s = loadState();
  if (s) ws.send(JSON.stringify({ type: 'state', state: s }));
  ws.send(JSON.stringify({ type: 'presence', online: [...onlineIds()] }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.type === 'hello' && typeof m.uid === 'string') { ws.uid = m.uid.slice(0, 20); lastPresence = ''; pushPresence(); }
  });
  ws.on('close', () => {
    if (ws.uid && !onlineIds().has(ws.uid)) {
      const st = loadState(); const p = st && st.staff.find(x => x.id === ws.uid);
      if (p) { p.last = Date.now(); saveState(st); }
    }
    pushPresence();
  });
});
// keep connections alive through routers that drop idle sockets
setInterval(() => wss.clients.forEach(c => { try { c.ping(); } catch (e) {} }), 25000);

server.on('error', e => console.error('Hub server error:', e.message));
server.listen(PORT, CLOUD ? '127.0.0.1' : '0.0.0.0', () => console.log('Hub listening on ' + (CLOUD ? '127.0.0.1' : '0.0.0.0') + ':' + PORT + (CLOUD ? ' (cloud mode, behind Cloudflare Tunnel)' : '') + ' (data folder: ' + DATA_DIR + ')'));
module.exports = { OFFICE_KEY, IT_KEY, DATA_DIR };
