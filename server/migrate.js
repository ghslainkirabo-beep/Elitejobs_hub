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
  'reports.jsonl', 'trusted-devices.json', 'update-source.json', 'hub-update-history.json'];
const DIRS = ['docs', 'ui-live', 'urgent-photos'];
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
    const files = list();
    return new Promise((resolve, reject) => {
      const u = new URL(target + '/api/restore');
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip', 'X-Restore-Code': code, 'X-Restore-Files': String(files.length) }, timeout: 15 * 60000 }, res => {
        let body = ''; res.on('data', d => body += d); res.on('end', () => {
          let j = {}; try { j = JSON.parse(body); } catch (e) {}
          if (res.statusCode !== 200) return reject(Object.assign(new Error(j.error || ('The cloud Hub answered ' + res.statusCode)), { status: 502 }));
          fs.writeFileSync(MOVED, JSON.stringify({ to: target, at: Date.now(), by: who || '' }));
          appendActivity({ t: Date.now(), who: who || 'IT', what: 'Moved the Hub to ' + target + ' (' + files.length + ' files). This office PC now only points everyone there.' });
          resolve({ ok: true, files: files.length, movedTo: target });
        });
      });
      req.on('timeout', () => req.destroy(new Error('The cloud Hub took too long to answer.')));
      req.on('error', e => reject(Object.assign(new Error('Could not reach the cloud Hub: ' + e.message), { status: 502 })));
      const gz = zlib.createGzip(); gz.pipe(req);
      (async () => {
        for (const rel of files) {
          const buf = fs.readFileSync(path.join(DATA_DIR, rel));
          if (!gz.write(JSON.stringify({ p: rel, d: buf.toString('base64'), h: crypto.createHash('sha256').update(buf).digest('hex') }) + '\n')) await new Promise(r => gz.once('drain', r));
        }
        gz.write(JSON.stringify({ end: files.length }) + '\n'); gz.end();
      })().catch(e => req.destroy(e));
    });
  }

  // ---------- cloud server: receive once ----------
  const safeRel = rel => typeof rel === 'string' && rel.length < 300 && !rel.includes('..') && !path.isAbsolute(rel) && !rel.includes('\\') &&
    (FILES.includes(rel) || isUrgentFile(rel) || DIRS.some(d => rel.startsWith(d + '/')));
  let busy = false;
  function receive(req, res, ip) {
    const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
    const want = process.env.HUB_RESTORE_CODE || '';
    const got = String(req.headers['x-restore-code'] || '');
    if (!want) return fail(404, 'This Hub is not waiting for a move.');
    if (fs.existsSync(DONE)) return fail(409, 'This cloud Hub already received the office data.');
    const s = loadState(); if (s && s.staff && s.staff.length) return fail(409, 'This cloud Hub already has people in it.');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return fail(401, 'Wrong move code.');
    if (busy) return fail(409, 'A move is already running.');
    busy = true;
    const tmp = path.join(DATA_DIR, '.restore-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    let rest = '', n = 0, ended = false, bad = null;
    const handle = line => {
      if (!line || bad) return;
      let o; try { o = JSON.parse(line); } catch (e) { bad = 'Damaged data.'; return; }
      if (o.end !== undefined) { ended = o.end === n; if (!ended) bad = 'Some files went missing on the way.'; return; }
      if (!safeRel(o.p)) { bad = 'Unexpected file ' + String(o.p).slice(0, 60); return; }
      const buf = Buffer.from(String(o.d || ''), 'base64');
      if (crypto.createHash('sha256').update(buf).digest('hex') !== o.h) { bad = 'A file was damaged on the way: ' + o.p; return; }
      const abs = path.join(tmp, o.p); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); n++;
    };
    const gun = zlib.createGunzip();
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 4e9) { bad = 'Too big.'; req.destroy(); } });
    req.pipe(gun);
    gun.on('data', chunk => { rest += chunk.toString('utf8'); let i; while ((i = rest.indexOf('\n')) >= 0) { handle(rest.slice(0, i)); rest = rest.slice(i + 1); } });
    gun.on('error', () => { bad = bad || 'Damaged data.'; });
    gun.on('end', () => {
      busy = false;
      if (bad || !ended) { fs.rmSync(tmp, { recursive: true, force: true }); return fail(400, bad || 'The move did not finish. Try again.'); }
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

  return { movedTo, send, receive, list };
};
