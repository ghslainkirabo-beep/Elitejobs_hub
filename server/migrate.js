// Moving the Hub from the office PC into the cloud, in one step.
//
//  Office PC (IT → "Move Hub to cloud"):  send(target, code)
//    streams every Hub data file to  <target>/api/restore  (gzip, one JSON line per file),
//    then writes moved.json so this old Hub only points people to the new address.
//  Cloud server (fresh, empty):           receive(req, res, ip)
//    accepts the stream once, only with the one-time code printed when the server was set up,
//    writes the files, remembers the office's internet address, then restarts itself.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Only Hub data moves — never this PC's app caches or installer files.
const FILES = ['activity.jsonl', 'ai.json', 'attendance-settings.json', 'attendance.json', 'data.json', 'devices.json', 'it-key.txt', 'office-passcode.txt',
  'reports.jsonl', 'trusted-devices.json', 'update-source.json', 'hub-update-history.json', 'website-jobs.json', 'inquiries.json', 'inquiry-grants.json', 'sms-config.json', 'clients.json', 'ledger.json',
  'vflow.json', 'vflow-grants.json', 'db-passkeys.json', 'cvs.json', 'int-reports.jsonl', 'subscriptions.json'];
const DIRS = ['docs', 'ui-live', 'urgent-photos', 'inquiry-files'];
const isUrgentFile = n => /^urgent-[\w-]+\.json$/.test(n);

// Automated tests only: allow a plain local address (http://127.0.0.1:port) as the target.
const TEST = process.env.HUB_MOVE_TEST === '1';
const okTarget = t => /^https:\/\/[\w.-]+$/.test(t) || (TEST && /^http:\/\/127\.0\.0\.1:\d+$/.test(t));

module.exports = function makeMigrate({ DATA_DIR, loadState, appendActivity, CLOUD, onRestored }) {
  const MOVED = path.join(DATA_DIR, 'moved.json');
  const DONE = path.join(DATA_DIR, 'restore-done.json');
  const movedTo = () => { try { const m = JSON.parse(fs.readFileSync(MOVED, 'utf8')); return okTarget(m.to) ? m.to : null; } catch (e) { return null; } };

  function list() {
    const out = [];
    for (const n of fs.readdirSync(DATA_DIR)) if (FILES.includes(n) || isUrgentFile(n)) out.push(n);
    const walk = rel => { const abs = path.join(DATA_DIR, rel); if (!fs.existsSync(abs)) return; for (const n of fs.readdirSync(abs)) { const r = rel + '/' + n, st = fs.statSync(path.join(DATA_DIR, r)); if (st.isDirectory()) walk(r); else if (st.isFile()) out.push(r); } };
    DIRS.forEach(walk);
    return out;
  }

  // ---------- office PC: send everything ----------
  function send(target, code, who) {
    target = String(target || '').trim().replace(/\/+$/, '');
    if (!okTarget(target)) throw Object.assign(new Error('Use the cloud address, like https://hub.elitejobsrwanda.com'), { status: 400 });
    if (!/^[A-Z0-9]{8,40}$/.test(String(code || ''))) throw Object.assign(new Error('Type the move code shown when the cloud server was set up.'), { status: 400 });
    if (movedTo()) throw Object.assign(new Error('This Hub has already moved to ' + movedTo()), { status: 409 });
    // Ask first, send nothing yet: only an Elitejobs cloud Hub that is waiting for this move may receive the data
    return probe(target).then(info => {
      if (!info || info.hub !== 'elitejobs') throw Object.assign(new Error(target + ' is not an Elitejobs cloud Hub (for example, it may be the jobs website). Nothing was sent. Use the Hub address you set in Cloudflare Tunnel, like https://hub.elitejobsrwanda.com'), { status: 400 });
      if (!info.waiting) throw Object.assign(new Error('The cloud Hub at ' + target + ' is not waiting for a move' + (info.why ? ' (' + info.why + ')' : '') + '. Nothing was sent.'), { status: 409 });
      return push(target, code, who);
    });
  }
  function probe(target) {
    return new Promise(resolve => {
      const u = new URL(target + '/api/restore'), lib = u.protocol === 'https:' ? https : http;
      const r = lib.get(u, { timeout: 15000 }, res => { let body = ''; res.on('data', d => { if (body.length < 4000) body += d; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch (e) { resolve(null); } }); });
      r.on('timeout', () => r.destroy()); r.on('error', () => resolve(null));
    });
  }
  // Sent in small parts (Cloudflare's free plan refuses any single upload over 100 MB):
  // every part is its own request, sent in order and retried if the internet drops.
  const PART = 8 * 1024 * 1024; // about 8 MB of files per request (a big file is split across parts)
  function* lines(files) {
    for (const rel of files) {
      const buf = fs.readFileSync(path.join(DATA_DIR, rel));
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      const n = Math.max(1, Math.ceil(buf.length / PART));
      for (let k = 0; k < n; k++) { const d = buf.subarray(k * PART, (k + 1) * PART); yield { size: d.length, line: JSON.stringify({ p: rel, k, n, at: k * PART, d: d.toString('base64'), h: k === n - 1 ? h : undefined }) + '\n' }; }
    }
  }
  function postPart(target, code, sess, i, last, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(target + '/api/restore'), lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip', 'Content-Length': body.length, 'X-Restore-Code': code, 'X-Restore-Session': sess, 'X-Restore-Part': String(i), 'X-Restore-Last': last ? '1' : '0' }, timeout: 5 * 60000 }, res => {
        let t = ''; res.on('data', d => t += d); res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch (e) {} if (res.statusCode === 200) return resolve(j); reject(Object.assign(new Error(j.error || ('The cloud Hub answered ' + res.statusCode)), { status: 502, final: res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 408 && res.statusCode !== 429 })); });
      });
      req.on('timeout', () => req.destroy(new Error('The cloud Hub took too long to answer.')));
      req.on('error', e => reject(Object.assign(new Error('Could not reach the cloud Hub: ' + e.message), { status: 502 })));
      req.end(body);
    });
  }
  async function push(target, code, who) {
    const files = list(), sess = crypto.randomBytes(12).toString('hex');
    const send1 = async (i, last, text) => {
      const body = zlib.gzipSync(Buffer.from(text, 'utf8'));
      for (let tryN = 1; ; tryN++) {
        try { return await postPart(target, code, sess, i, last, body); }
        catch (e) { if (e.final || tryN >= 5) throw e; await new Promise(r => setTimeout(r, 3000 * tryN)); }
      }
    };
    let buf = [], size = 0, i = 0;
    for (const x of lines(files)) {
      if (size && size + x.size > PART) { await send1(i++, false, buf.join('')); buf = []; size = 0; }
      buf.push(x.line); size += x.size;
    }
    buf.push(JSON.stringify({ end: files.length }) + '\n');
    await send1(i, true, buf.join(''));
    fs.writeFileSync(MOVED, JSON.stringify({ to: target, at: Date.now(), by: who || '' }));
    appendActivity({ t: Date.now(), who: who || 'IT', what: 'Moved the Hub to ' + target + ' (' + files.length + ' files, ' + (i + 1) + ' parts). This office PC now only points everyone there.' });
    return { ok: true, files: files.length, movedTo: target };
  }

  // ---------- cloud server: say whether a move is expected (no secrets, no data) ----------
  function ready() {
    const want = !!process.env.HUB_RESTORE_CODE, s = loadState();
    const why = !want ? 'not set up to receive a move' : fs.existsSync(DONE) ? 'it already received the office data' : (s && s.staff && s.staff.length) ? 'it already has people in it' : '';
    return { hub: 'elitejobs', waiting: !why, why };
  }

  // ---------- cloud server: receive once ----------
  const safeRel = rel => typeof rel === 'string' && rel.length < 300 && !rel.includes('..') && !path.isAbsolute(rel) && !rel.includes('\\') &&
    (FILES.includes(rel) || isUrgentFile(rel) || DIRS.some(d => rel.startsWith(d + '/')));
  let S = null; // the move in progress: { id, tmp, next, n, t }
  function receive(req, res, ip) {
    const fail = (code, msg) => { if (S && code === 400) { try { fs.rmSync(S.tmp, { recursive: true, force: true }); } catch (e) {} S = null; } res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
    const want = process.env.HUB_RESTORE_CODE || '';
    const got = String(req.headers['x-restore-code'] || '');
    if (!want) return fail(404, 'This Hub is not waiting for a move.');
    if (fs.existsSync(DONE)) return fail(409, 'This cloud Hub already received the office data.');
    const s = loadState(); if (s && s.staff && s.staff.length) return fail(409, 'This cloud Hub already has people in it.');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return fail(401, 'Wrong move code.');
    // older office Hubs send everything as one part without these headers
    const id = String(req.headers['x-restore-session'] || 'single'), part = +(req.headers['x-restore-part'] || 0), last = req.headers['x-restore-session'] ? req.headers['x-restore-last'] === '1' : true;
    if (S && S.id !== id && Date.now() - S.t > 30 * 60000) { try { fs.rmSync(S.tmp, { recursive: true, force: true }); } catch (e) {} S = null; } // a move that stopped half-way
    if (part === 0 && (!S || S.id !== id)) {
      if (S) return fail(409, 'A move is already running.');
      S = { id, tmp: path.join(DATA_DIR, '.restore-' + Date.now()), next: 0, done: new Set(), t: Date.now(), busy: false };
      fs.mkdirSync(S.tmp, { recursive: true });
    }
    if (!S || S.id !== id) return fail(409, 'This move was interrupted. Start it again from the office Hub.');
    if (S.busy) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'That part is still being saved.' })); }
    if (part === S.next - 1 && !last) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, part, again: true })); } // a retry of a part we already have
    if (part !== S.next) return fail(400, 'A part of the move arrived out of order. Start it again from the office Hub.');
    S.busy = true; S.t = Date.now();
    const M = S;
    let rest = '', ended = false, bad = null;
    const handle = line => {
      if (!line || bad) return;
      let o; try { o = JSON.parse(line); } catch (e) { bad = 'Damaged data.'; return; }
      if (o.end !== undefined) { ended = o.end === M.done.size; if (!ended) bad = 'Some files went missing on the way.'; return; }
      if (!safeRel(o.p)) { bad = 'Unexpected file ' + String(o.p).slice(0, 60); return; }
      const k = +o.k || 0, n = +o.n || 1, abs = path.join(M.tmp, o.p), buf = Buffer.from(String(o.d || ''), 'base64');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // written at its place in the file, so a part sent again after a dropped connection does no harm
      if (k === 0) fs.writeFileSync(abs, buf); else { const fd = fs.openSync(abs, 'r+'); try { fs.writeSync(fd, buf, 0, buf.length, +o.at || 0); } finally { fs.closeSync(fd); } }
      if (k === n - 1) { if (crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== o.h) { bad = 'A file was damaged on the way: ' + o.p; return; } M.done.add(o.p); }
    };
    const gun = zlib.createGunzip();
    let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > 4e9) { bad = 'Too big.'; req.destroy(); } });
    req.on('close', () => { if (!over) M.busy = false; }); // the connection dropped: the office sends this part again
    req.pipe(gun);
    gun.on('data', chunk => { rest += chunk.toString('utf8'); let i; while ((i = rest.indexOf('\n')) >= 0) { handle(rest.slice(0, i)); rest = rest.slice(i + 1); } });
    gun.on('error', () => { bad = bad || 'Damaged data.'; });
    gun.on('end', () => {
      over = true; M.busy = false;
      if (bad) return fail(400, bad);
      if (!last) { M.next++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, part })); }
      if (!ended) return fail(400, 'The move did not finish. Try again.');
      const tmp = M.tmp, n = M.done.size; S = null;
      // swap the received files in (the fresh server's own keys are replaced by the office's — so every PC and phone keeps working)
      const walk = rel => { for (const nme of fs.readdirSync(path.join(tmp, rel))) { const r = rel ? rel + '/' + nme : nme, abs = path.join(tmp, r); if (fs.statSync(abs).isDirectory()) walk(r); else { const dst = path.join(DATA_DIR, r); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(abs, dst); } } };
      walk('');
      fs.rmSync(tmp, { recursive: true, force: true });
      // the office's internet address = where this move came from (used for "office only" attendance)
      try { const f = path.join(DATA_DIR, 'attendance-settings.json'); let c = {}; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} c.officeIps = [ip].concat((c.officeIps || []).filter(x => x !== ip)).slice(0, 5); delete c.base; fs.writeFileSync(f, JSON.stringify(c)); } catch (e) {}
      fs.writeFileSync(DONE, JSON.stringify({ at: Date.now(), files: n, from: ip }));
      try { fs.appendFileSync(path.join(DATA_DIR, 'activity.jsonl'), JSON.stringify({ t: Date.now(), who: 'IT', what: 'The Hub arrived in the cloud from the office (' + n + ' files, from ' + ip + ').' }) + '\n'); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, files: n }));
      // restart so the office's keys and data load fresh (the service manager starts it again)
      if (onRestored) setTimeout(onRestored, 300);
    });
  }

  return { movedTo, send, receive, list, ready };
};
