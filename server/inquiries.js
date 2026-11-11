// Open jobs inquiry — the Hub side of the website's "Message us" (name + phone, no WhatsApp).
// • Every minute the Hub collects new messages from the website, keeps them here, then the website deletes its copy.
// • Three rooms by the day the person wrote (Kigali time): Today, Yesterday and Endover (older, still unanswered).
// • Admin decides, per room, which positions may open it. Admin always can.
// • A reply goes to the person's phone by SMS. The moment it's sent, that person leaves the room for everyone,
//   so two colleagues never answer the same person. Everything is written in the activity log.
'use strict';
const fs = require('fs'), path = require('path');

module.exports = function makeInquiries({ DATA_DIR, broadcast, appendActivity, urgent }) {
  const F = n => path.join(DATA_DIR, n);
  const LIST = F('inquiries.json'), GR = F('inquiry-grants.json'), SMS = F('sms-config.json'), FILES = F('inquiry-files');
  fs.mkdirSync(FILES, { recursive: true });
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
  const err = (m, code) => Object.assign(new Error(m), { code: code || 400 });
  const ROOMS = ['today', 'yesterday', 'endover'];
  const ROOM_NAME = { today: 'Today', yesterday: 'Yesterday', endover: 'Endover' };
  const KGL = 2 * 36e5, DAY = 864e5;
  const kDay = t => new Date(t + KGL).toISOString().slice(0, 10);
  const roomOf = (t, now = Date.now()) => { const d = kDay(t); return d === kDay(now) ? 'today' : d === kDay(now - DAY) ? 'yesterday' : 'endover'; };
  const isAdmin = p => !!(p && urgent.rights(p).admin);

  // ---------------- who may open which room (Admin decides, per position) ----------------
  const grants = () => { const g = rj(GR, {}); ROOMS.forEach(r => { if (!Array.isArray(g[r])) g[r] = []; }); return g; };
  function signed(p) {
    if (!p) throw err('Sign in on this device first. If you just signed in here, ask Admin to approve this device.', 401);
    if (p.on === false) throw err('Your access is suspended.', 403);
  }
  const may = (p, room) => isAdmin(p) || grants()[room].includes(p.role);
  function needRoom(p, room) { signed(p); if (!may(p, room)) throw err(`Admin hasn’t opened the ${ROOM_NAME[room]} room for your position yet.`, 403); }
  function grantsView(p) { signed(p); if (!isAdmin(p)) throw err('Only Admin can do this.', 403); return { grants: grants() }; }
  function setGrants(p, b) {
    signed(p); if (!isAdmin(p)) throw err('Only Admin can do this.', 403);
    const room = String(b.room || ''), role = String(b.role || ''), on = !!b.on;
    if (!ROOMS.includes(room)) throw err('Choose a room.');
    if (!/^[a-z]{2,8}$/.test(role) || role === 'admin') throw err('Choose a position.');
    const g = grants(), had = g[room].includes(role);
    if (on && !had) g[room].push(role); if (!on && had) g[room] = g[room].filter(x => x !== role);
    if (on !== had) {
      wj(GR, g);
      appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `${on ? 'opened' : 'closed'} the Open jobs inquiry “${ROOM_NAME[room]}” room for ${String(b.label || role).slice(0, 40)}` });
      broadcast({ type: 'inq', kind: 'grants' });
    }
    return { ok: true, grants: g };
  }

  // ---------------- SMS: Pindo (Rwanda) or Africa's Talking — the key is entered by Admin or IT, never shown back ----------------
  const sms = () => rj(SMS, {});
  function smsView() { const c = sms(); return { provider: c.provider || '', sender: c.sender || '', username: c.username || '', hasKey: !!c.key, ready: !!(c.provider && c.key && (c.provider !== 'at' || c.username)), lastError: c.lastError || '', lastOk: c.lastOk || null }; }
  function setSms(who, b) {
    const c = sms();
    if (b.provider !== undefined) { if (!['pindo', 'at', ''].includes(b.provider)) throw err('Choose Pindo or Africa’s Talking.'); c.provider = b.provider; }
    if (typeof b.key === 'string' && b.key.trim()) c.key = b.key.trim();
    if (b.removeKey) delete c.key;
    if (typeof b.sender === 'string') { const s = b.sender.trim(); if (s && !/^[A-Za-z0-9 .-]{2,11}$/.test(s)) throw err('The sender name is 2 to 11 letters or numbers, like EliteJobs.'); c.sender = s; }
    if (typeof b.username === 'string') c.username = b.username.trim().slice(0, 60);
    c.lastError = ''; wj(SMS, c);
    appendActivity({ t: Date.now(), by: who.name, uid: who.id || '', role: who.role || 'it', text: `updated the SMS settings (${c.provider === 'at' ? 'Africa’s Talking' : c.provider === 'pindo' ? 'Pindo' : 'none'}${b.key ? ', new key' : ''})` });
    return smsView();
  }
  const e164 = ph => { let d = String(ph || '').replace(/\D/g, ''); if (d.startsWith('250')) d = d.slice(3); if (d.startsWith('0')) d = d.slice(1); return /^7\d{8}$/.test(d) ? '+250' + d : null; };
  async function sendSms(to, text) {
    const c = sms(), num = e164(to);
    if (!num) throw err('That isn’t a Rwandan mobile number.');
    if (!c.provider || !c.key) throw err('SMS isn’t set up yet. Admin or IT can add the SMS account in Open jobs → SMS.', 409);
    const base = process.env.HUB_SMS_URL;                         // tests only
    let r, j = null;
    try {
      if (c.provider === 'pindo') {
        r = await fetch((base || 'https://api.pindo.io') + '/v1/sms/', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: num, text, sender: c.sender || 'PindoTest' }), signal: AbortSignal.timeout(20000) });
        try { j = await r.json(); } catch (e) {}
        if (!r.ok) throw err((j && (j.message || j.error || j.detail)) || 'Pindo answered ' + r.status + '.', 502);
        return { id: j && (j.sms_id || j.id) || '', provider: 'Pindo' };
      }
      const host = base || (c.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com');
      const form = new URLSearchParams({ username: c.username || '', to: num, message: text }); if (c.sender) form.set('from', c.sender);
      r = await fetch(host + '/version1/messaging', { method: 'POST', headers: { apiKey: c.key, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(20000) });
      try { j = await r.json(); } catch (e) {}
      const rec = j && j.SMSMessageData && (j.SMSMessageData.Recipients || [])[0];
      if (!r.ok || !rec || ![100, 101, 102].includes(Number(rec.statusCode))) throw err((rec && rec.status) || (j && j.SMSMessageData && j.SMSMessageData.Message) || 'Africa’s Talking answered ' + r.status + '.', 502);
      return { id: rec.messageId || '', provider: 'Africa’s Talking' };
    } catch (e) {
      const m = e.code ? e.message : 'The SMS service couldn’t be reached. Check the internet on the Hub PC.';
      const s = sms(); s.lastError = m; wj(SMS, s); throw err(m, 502);
    } finally { if (r && r.ok) { const s = sms(); s.lastError = ''; s.lastOk = Date.now(); wj(SMS, s); } }
  }
  async function testSms(who, to) { const r = await sendSms(to, 'Elite Jobs Rwanda: this is a test SMS from the Hub. SMS replies are working.'); appendActivity({ t: Date.now(), by: who.name, uid: who.id || '', role: who.role || 'it', text: `sent a test SMS (${r.provider})` }); return { ok: true }; }

  // ---------------- collect from the website ----------------
  let syncing = false;
  async function sync() {
    if (fs.existsSync(F('moved.json')) || syncing) return;
    syncing = true;
    try {
      let r; try { r = await urgent.remote('/api/hub/applications'); } catch (e) { return; }  // not connected yet: nothing to do
      const { inquiries = [] } = await r.json();
      if (!inquiries.length) return;
      const list = rj(LIST, []), ids = [];
      for (const x of inquiries) {
        if (list.some(y => y.id === x.id)) { ids.push(x.id); continue; }
        if (list.some(y => y.status === 'open' && y.phone === x.phone && String(y.title).toLowerCase() === String(x.title).toLowerCase())) { ids.push(x.id); continue; } // already waiting
        // the application's files come to the Hub first; only then may the website delete its copy
        const files = [];
        try {
          const dir = path.join(FILES, x.id.replace(/[^\w-]/g, '')); fs.mkdirSync(dir, { recursive: true });
          for (const f of (x.files || [])) {
            if (!/^(p[0-2]|cv|cert)$/.test(f.k) || !EXT[f.mime]) continue;
            const r = await urgent.remote(`/api/hub/applications/${encodeURIComponent(x.id)}/file/${f.k}`), buf = Buffer.from(await r.arrayBuffer());
            const name = f.k + '.' + EXT[f.mime]; fs.writeFileSync(path.join(dir, name), buf);
            files.push({ k: f.k, mime: f.mime, name: String(f.name || name).slice(0, 80), size: buf.length, file: name });
          }
        } catch (e) { continue; }                                 // try this one again next minute
        const { files: _f, ...rest } = x;
        list.push({ ...rest, created: Number(x.created) || Date.now(), got: Date.now(), title: x.title || 'General message', name: x.name || [x.first, x.last].filter(Boolean).join(' '), status: 'open', files });
        ids.push(x.id);
      }
      wj(LIST, list);
      if (ids.length) await urgent.remote('/api/hub/applications/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      broadcast({ type: 'inq', kind: 'list' });
    } catch (e) { /* tried again next minute */ } finally { syncing = false; }
  }
  setInterval(sync, 60000).unref(); setTimeout(sync, 6000);
  // answered messages are kept 90 days (who answered, when, what), then removed
  setInterval(() => {
    const l = rj(LIST, []), keep = l.filter(x => x.status === 'open' || Date.now() - (x.at || x.created) < 90 * DAY);
    if (keep.length === l.length) return; wj(LIST, keep);
    l.filter(x => !keep.includes(x)).forEach(x => { try { fs.rmSync(path.join(FILES, String(x.id).replace(/[^\w-]/g, '')), { recursive: true, force: true }); } catch (e) {} });
  }, 6 * 36e5).unref();

  // ---------------- the rooms ----------------
  function me(p) {
    signed(p);
    const open = rj(LIST, []).filter(x => x.status === 'open'), now = Date.now(), rooms = {};
    ROOMS.forEach(r => { rooms[r] = { allowed: may(p, r), count: open.filter(x => roomOf(x.created, now) === r).length }; });
    return { rooms, admin: isAdmin(p), sms: smsView().ready };
  }
  function room(p, r) {
    if (!ROOMS.includes(r)) throw err('Choose a room.');
    needRoom(p, r);
    const now = Date.now(), people = rj(LIST, []).filter(x => x.status === 'open' && roomOf(x.created, now) === r).sort((a, b) => a.created - b.created);
    const jobs = new Map();
    people.forEach(x => { const k = x.title.toLowerCase(), j = jobs.get(k) || { key: k, title: x.title, kind: x.kind, job: x.job, cat: x.cat, loc: x.loc, img: x.img, n: 0, members: 0, oldest: x.created }; j.n++; if (x.member) j.members++; if (x.img && !j.img) j.img = x.img; jobs.set(k, j); });
    return { room: r, jobs: [...jobs.values()].sort((a, b) => b.n - a.n || a.oldest - b.oldest), people, sms: smsView().ready };
  }
  const locks = new Set();
  async function reply(p, b) {
    const id = String(b.id || ''), text = String(b.text || '').replace(/\s+\n/g, '\n').trim();
    if (text.length < 2) throw err('Write the message first.');
    if (text.length > 459) throw err('Keep the message under 459 characters (3 SMS).');
    let list = rj(LIST, []), x = list.find(y => y.id === id);
    if (!x) throw err('This message isn’t here any more.', 404);
    needRoom(p, roomOf(x.created));
    if (x.status !== 'open' || locks.has(id)) throw err(x.by ? `${x.by} already answered ${x.name}.` : 'Someone is answering this person right now.', 409);
    locks.add(id);
    try {
      const r = await sendSms(x.phone, text);
      list = rj(LIST, []); x = list.find(y => y.id === id);
      Object.assign(x, { status: 'sms', reply: text, by: p.name, byId: p.id, at: Date.now(), smsId: r.id, via: r.provider });
      wj(LIST, list);
      appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `answered ${x.name} (${x.title}) by SMS` });
      broadcast({ type: 'inq', kind: 'done', id, by: p.name });
      return { ok: true };
    } finally { locks.delete(id); }
  }
  // the main way to answer: call the person, then record what was said. "Didn't pick up" keeps them in the room for another try.
  const CALLED = { coming: 'Coming', tomorrow: 'Coming tomorrow', later: 'Will come later', 'not-interested': 'Not interested', 'not-available': 'Not available', wrong: 'Wrong number', other: 'Talked', 'no-answer': 'Didn’t pick up' };
  function called(p, b) {
    const id = String(b.id || ''), out = CALLED[b.outcome] ? b.outcome : '', note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!out) throw err('Choose what happened on the call.');
    if (out !== 'no-answer' && note.length < 3) throw err('Write a short note of what you talked about.');
    const list = rj(LIST, []), x = list.find(y => y.id === id);
    if (!x) throw err('This message isn’t here any more.', 404);
    needRoom(p, roomOf(x.created));
    if (x.status !== 'open' || locks.has(id)) throw err(x.by ? `${x.by} already answered ${x.name}.` : 'Someone is answering this person right now.', 409);
    if (out === 'no-answer') {
      x.tries = (x.tries || []).concat({ by: p.name, at: Date.now(), note }).slice(-10);
      wj(LIST, list);
      appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `called ${x.name} (${x.title}) — didn’t pick up` });
      broadcast({ type: 'inq', kind: 'list' });
      return { ok: true, kept: true };
    }
    Object.assign(x, { status: 'called', outcome: out, note, by: p.name, byId: p.id, at: Date.now() });
    wj(LIST, list);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `called ${x.name} (${x.title}) — ${CALLED[out]}: ${note}` });
    broadcast({ type: 'inq', kind: 'done', id, by: p.name });
    return { ok: true };
  }
  // what the team already did (calls and SMS), newest first — so everyone sees the notes
  function done(p, r) {
    if (!ROOMS.includes(r)) throw err('Choose a room.');
    needRoom(p, r);
    const now = Date.now();
    return { done: rj(LIST, []).filter(x => x.status !== 'open' && roomOf(x.created, now) === r)
      .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100).map(x => ({ id: x.id, name: x.name, phone: x.phone, title: x.title, status: x.status, outcome: x.outcome ? CALLED[x.outcome] : 'SMS sent', note: x.status === 'sms' ? x.reply : x.note, by: x.by, at: x.at })) };
  }

  // a file of an application (photos, CV, certificate): only for people who can open that room. Opening a certificate is logged.
  function file(p, id, k) {
    const x = rj(LIST, []).find(y => y.id === id); if (!x) throw err('Not found', 404);
    needRoom(p, roomOf(x.created));
    const f = (x.files || []).find(y => y.k === k); if (!f) throw err('Not found', 404);
    if (k === 'cert' || k === 'cv') appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `opened the ${k === 'cert' ? 'certificate' : 'CV'} of ${x.name} (${x.title})` });
    return { path: path.join(FILES, String(x.id).replace(/[^\w-]/g, ''), f.file), type: f.mime, name: f.name };
  }
  // exporting contacts is personal data leaving the Hub: allowed in rooms you can open, always logged
  function exported(p, b) {
    const r = String(b.room || ''); if (!ROOMS.includes(r)) throw err('Choose a room.'); needRoom(p, r);
    const n = Math.max(0, Math.min(5000, Number(b.n) || 0)), fmt = ['xlsx', 'pdf', 'csv'].includes(b.format) ? b.format : 'file';
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `exported ${n} contact${n === 1 ? '' : 's'} (${fmt.toUpperCase()}) from Open jobs inquiry “${ROOM_NAME[r]}”${b.what ? ' — ' + String(b.what).slice(0, 80) : ''}` });
    return { ok: true };
  }

  return { file, exported, me, room, done, reply, called, grantsView, setGrants, smsView, setSms, testSms, sync, isAdmin };
};
