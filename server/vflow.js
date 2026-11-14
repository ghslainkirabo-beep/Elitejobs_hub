// Vacancy flow — one vacancy walks a fixed line, and nobody's step opens before the step before it is finished:
//   1 Starter states it (HR, or whoever Admin grants) → 2 Poster publishes it as an urgent job (Endover, pre-filled)
//   → 3 Call Center calls everyone who applied, then approves (the post comes down) → 4 HR completes it
//   (only "coming on site" people stay) → 5 Notices → Interview staff approve → 6 Upcoming (interviews, stage 2).
// Who may take part is Admin's choice (grants). People without a grant only learn that vacancies exist — the details
// never leave the server for them. Everything is kept for good: this file is the vacancy part of Elitejobs database.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ DATA_DIR, urgent, staffOf, stateOf, appendActivity, broadcast, note }) {
  const F = n => path.join(DATA_DIR, n);
  const VF = F('vflow.json'), GR = F('vflow-grants.json'), KEYS = F('db-passkeys.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const log = (p, text) => appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text });
  const kDay = t => new Date((t || Date.now()) + 72e5).toISOString().slice(0, 10);       // Kigali date (UTC+2)
  const kEnd = () => { const D = 864e5, K = 72e5, t = Date.now(); return Math.floor((t + K) / D) * D - K + D; }; // next Kigali midnight
  const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const who = p => ({ id: p.id, name: p.name, role: p.role });
  const ping = () => broadcast({ type: 'vflow' });

  // ---------- rights (Admin decides; sensible defaults so HR can start on day one) ----------
  const isAdmin = p => p && p.role === 'admin' && !String(p.name).includes('@');
  function rights(p) {
    if (!p) return { view: false };
    if (isAdmin(p)) return { admin: true, start: true, rm: true, view: true, db: true, post: true };
    const g = rj(GR, { users: {}, unlocked: {} }), u = g.users[p.id] || {};
    const start = u.start !== undefined ? !!u.start : p.role === 'hr';
    const rm = !!u.rm;
    const view = start || rm || (u.view !== undefined ? !!u.view : ['hr', 'cc', 'int'].includes(p.role));
    const db = !!u.db || (g.unlocked[p.id] || 0) > Date.now();
    let post = false; try { post = !!urgent.rights(p).post; } catch (e) {}
    return { start, rm, view, db, post };
  }
  const needAdmin = p => { if (!isAdmin(p)) throw err('Only Admin can change who takes part in vacancies.', 403); };

  // ---------- the vacancies ----------
  const load = () => { const db = rj(VF, { vacs: [] }); if (fileAway(db)) save(db); return db; };
  const save = db => wj(VF, db);
  const find = (db, id) => { const v = db.vacs.find(x => x.id === id); if (!v) throw err('This vacancy no longer exists.', 404); return v; };
  const hist = (v, p, text) => { v.hist = (v.hist || []).concat({ t: Date.now(), by: p.name, uid: p.id, text }).slice(-200); };
  const applicantsOf = v => v.post && v.post.id ? urgent.allApps().filter(a => a.post === v.post.id) : [];
  const STAGES = ['post', 'call', 'hr', 'notice', 'upcoming', 'done'];

  // what one person may see of one vacancy, and the one button (if any) that is theirs
  function shape(v, p, R) {
    const apps = applicantsOf(v), waiting = apps.filter(a => a.status !== 'done').length;
    const me = { act: '', ready: false, why: '' };
    if (v.stage === 'post' && R.post) {
      if (v.post && v.post.claimed && v.post.claimed.id !== p.id) me.why = `${v.post.claimed.name} is posting it now`;
      else { me.act = 'post'; me.ready = true; }
    } else if (v.stage === 'call' && p.role === 'cc' && R.view) {
      me.act = 'call'; me.ready = apps.length > 0; if (!apps.length) me.why = 'Waiting for the first person to apply';
    } else if (v.stage === 'hr' && (p.role === 'hr' || R.rm || R.admin)) { me.act = 'complete'; me.ready = true; }
    else if (v.stage === 'notice' && p.role === 'int' && R.view) { me.act = 'interview'; me.ready = true; }
    else if (p.role === 'int' && R.view && STAGES.indexOf(v.stage) < STAGES.indexOf('notice')) me.why = 'Your step opens when HR completes the call list';
    else if (p.role === 'cc' && R.view && v.stage === 'post') me.why = 'Waiting for the post';
    return { ...v, applicants: apps.length, waiting, me };
  }
  // my tasks: only the vacancies where I have a part still to play, plus the ones I'm waiting on (button greyed)
  function involved(v, p, R) {
    if (v.stage === 'done' || v.stage === 'upcoming') return false;
    if (R.admin || R.rm) return true;
    if (v.stage === 'post') return R.post || (R.view && ['cc', 'int'].includes(p.role));
    if (v.stage === 'call') return R.view && ['cc', 'int'].includes(p.role);
    if (v.stage === 'hr') return p.role === 'hr' || (R.view && p.role === 'int');
    if (v.stage === 'notice') return R.view && p.role === 'int';
    return false;
  }
  function mine(p) {
    if (!p) throw err('Sign in first.', 401);
    const R = rights(p), db = load(), live = db.vacs.filter(v => v.stage !== 'done');
    if (!R.view && !R.post) return { rights: R, tasks: [], locked: live.length };
    return { rights: R, tasks: live.filter(v => involved(v, p, R)).map(v => shape(v, p, R)), locked: 0 };
  }
  function list(p, scope) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to vacancies.', 403);
    const db = load(), want = { active: v => !['done', 'upcoming'].includes(v.stage), notices: v => v.stage === 'notice', upcoming: v => v.stage === 'upcoming', all: () => true }[scope] || (() => true);
    return { rights: R, vacs: db.vacs.filter(want).sort((a, b) => b.created - a.created).slice(0, 300).map(v => shape(v, p, R)) };
  }

  // 1 · state a vacancy
  function create(p, b) {
    const R = rights(p); if (!R.start) throw err('Admin hasn’t given you the right to state vacancies.', 403);
    const title = s(b.title, 80); if (title.length < 3) throw err('Write the position, for example “Receptionist”.');
    const need = Math.max(1, Math.min(200, parseInt(b.need, 10) || 1));
    const v = { id: 'VAC-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(), title, need,
      employer: s(b.employer, 80), loc: s(b.loc, 80), pay: s(b.pay, 60), desc: s(b.desc, 600), reqs: s(b.reqs, 600),
      salMin: Number(b.salMin) || 0, salMax: Number(b.salMax) || 0,
      rules: { cv: !!b.cv, dip: !!b.dip, gender: ['f', 'm'].includes(b.gender) ? b.gender : 'any' },
      starter: { ...who(p), t: Date.now() }, created: Date.now(), stage: 'post', post: null, call: null, hr: null, int: null, hist: [] };
    hist(v, p, 'stated the vacancy');
    const db = load(); db.vacs.push(v); save(db);
    log(p, `stated a vacancy: ${title}${v.employer ? ' for ' + v.employer : ''} (${need} needed)`); ping();
    return { ok: true, vac: v };
  }
  // 2 · the poster approves → their screen opens Endover with the vacancy filled in. Claiming stops two posters doubling up.
  function claimPost(p, id) {
    const R = rights(p); if (!R.post) throw err('Posting urgent jobs isn’t granted to you (Urgent hiring → Admin).', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'post') throw err('This vacancy is already posted.', 409);
    if (v.post && v.post.claimed && v.post.claimed.id !== p.id && Date.now() - v.post.claimed.t < 2 * 36e5) throw err(`${v.post.claimed.name} is posting it now.`, 409);
    v.post = { claimed: { ...who(p), t: Date.now() } }; hist(v, p, 'started posting it'); save(db); ping();
    return { ok: true, vac: v };
  }
  // called by the server right after a publish that came from a vacancy
  function posted(p, id, postId, title) {
    const db = load(), v = db.vacs.find(x => x.id === id); if (!v || v.stage !== 'post') return;
    v.post = { id: postId, title: s(title, 80), by: who(p), t: Date.now() }; v.stage = 'call';
    hist(v, p, 'published it as an urgent job'); save(db);
    log(p, `posted the vacancy “${v.title}” as an urgent job`); ping();
  }
  // 3 · the call center approves when everyone who applied has been called. The post comes down, so no one applies late.
  async function callApprove(p, id) {
    const R = rights(p); if (!(p.role === 'cc' && R.view) && !R.admin) throw err('This step belongs to the Call Center.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'call') throw err('This vacancy isn’t at the calling step.', 409);
    const apps = applicantsOf(v); if (!apps.length) throw err('No one has applied yet.', 409);
    const left = apps.filter(a => a.status !== 'done'); if (left.length) throw err(`${left.length} ${left.length === 1 ? 'person hasn’t' : 'people haven’t'} been called yet.`, 409);
    try { await urgent.remote(`/api/hub/posts/${encodeURIComponent(v.post.id)}/remove`, { method: 'POST' }); } catch (e) { /* already ended on the website */ }
    v.call = { by: who(p), t: Date.now(), day: kDay(), list: apps.map(a => ({ app: a.id, name: s(a.data.name, 60), phone: s(a.data.phone, 30), wa: s(a.data.whatsapp, 30), email: s(a.data.email, 100), lives: s(a.data.lives, 80), gender: a.data.gender || '', outcome: a.outcome || '', note: s(a.note, 200), calledBy: a.reviewer || '' })) };
    v.stage = 'hr'; hist(v, p, `called all ${apps.length} applicant${apps.length === 1 ? '' : 's'} and approved — the post came down`); save(db);
    log(p, `approved the calls for “${v.title}”: ${apps.length} called, ${v.call.list.filter(x => x.outcome === 'coming').length} coming on site`);
    broadcast({ type: 'urgent', kind: 'posts' }); ping();
    return { ok: true };
  }
  // 4 · HR completes: only the people coming on site stay. The vacancy goes to Notices for the interview staff.
  function complete(p, id) {
    const R = rights(p); if (!(p.role === 'hr' || R.rm || R.admin)) throw err('This step belongs to HR.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'hr') throw err('This vacancy isn’t waiting for HR.', 409);
    const keep = v.call.list.filter(x => x.outcome === 'coming');
    v.hr = { by: who(p), t: Date.now(), keep, removed: v.call.list.length - keep.length }; v.stage = 'notice';
    hist(v, p, `completed it — ${keep.length} coming on site kept, ${v.hr.removed} removed`); save(db);
    log(p, `completed the vacancy “${v.title}”: ${keep.length} coming on site go to interviews`); ping();
    return { ok: true };
  }
  // 5 · interview staff approve: the vacancy takes its place in Upcoming
  function intApprove(p, id) {
    const R = rights(p); if (!(p.role === 'int' && R.view) && !R.admin) throw err('This step belongs to the interview staff.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'notice') throw err('This vacancy isn’t in Notices.', 409);
    v.int = { by: who(p), t: Date.now(), cands: {} }; v.stage = 'upcoming'; hist(v, p, 'approved it for interviews'); save(db);
    log(p, `approved “${v.title}” for interviews (${v.hr.keep.length} expected)`); ping();
    return { ok: true };
  }

  // ---------- Admin: grants ----------
  function grantsView(p) {
    needAdmin(p);
    const g = rj(GR, { users: {}, unlocked: {} });
    return { staff: staffOf().filter(x => x.role !== 'admin').map(x => { const R = rights(x); return { id: x.id, name: x.name, role: x.role, start: R.start, rm: R.rm, view: R.view, db: !!(g.users[x.id] || {}).db, post: R.post }; }) };
  }
  function setGrant(p, b) {
    needAdmin(p);
    const KEYS_OK = ['start', 'rm', 'view', 'db']; if (!KEYS_OK.includes(b.key)) throw err('Unknown right.');
    const x = staffOf().find(y => y.id === b.uid); if (!x) throw err('That person isn’t in the system.', 404);
    const g = rj(GR, { users: {}, unlocked: {} }); g.users[x.id] = { ...(g.users[x.id] || {}), [b.key]: !!b.on }; wj(GR, g);
    const L = { start: 'state vacancies', rm: 'recruitment manager', view: 'vacancy viewer', db: 'Elitejobs database' }[b.key];
    log(p, `${b.on ? 'granted' : 'removed'} “${L}” ${b.on ? 'to' : 'from'} ${x.name}`); ping();
    return grantsView(p);
  }

  // ---------- Elitejobs database: Admin forges passkeys (only the hash is kept, the key is shown once) ----------
  const hash = k => crypto.createHash('sha256').update('ejdb:' + String(k)).digest('hex');
  function keysView(p) { needAdmin(p); return { keys: rj(KEYS, []).map(({ h, ...k }) => k) }; }
  function forge(p, b) {
    needAdmin(p);
    const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', raw = Array.from({ length: 20 }, () => AB[crypto.randomInt(AB.length)]).join(''), key = raw.match(/.{5}/g).join('-'); // no 0/O or 1/I to misread
    const L = rj(KEYS, []); L.push({ id: 'K' + Date.now().toString(36), label: s(b.label, 60) || 'Passkey', by: p.name, t: Date.now(), used: 0, last: null, on: true, h: hash(key) }); wj(KEYS, L);
    log(p, `forged a new Elitejobs database passkey (${s(b.label, 60) || 'Passkey'})`);
    return { key, keys: keysView(p).keys };
  }
  function revoke(p, id) {
    needAdmin(p);
    const L = rj(KEYS, []), k = L.find(x => x.id === id); if (!k) throw err('That passkey is gone.', 404);
    k.on = false; k.revoked = Date.now(); wj(KEYS, L); log(p, `revoked the database passkey “${k.label}”`);
    return keysView(p);
  }
  // a passkey opens the database for that signed-in person until midnight (Kigali). Every opening is logged.
  function unlock(p, key) {
    if (!p) throw err('Sign in first.', 401);
    const L = rj(KEYS, []), k = L.find(x => x.on && x.h === hash(String(key || '').trim().toUpperCase()));
    if (!k) { log(p, 'typed a wrong Elitejobs database passkey'); throw err('That passkey isn’t valid.', 403); }
    k.used++; k.last = Date.now(); k.lastBy = p.name; wj(KEYS, L);
    const g = rj(GR, { users: {}, unlocked: {} }); g.unlocked[p.id] = kEnd(); wj(GR, g);
    log(p, `opened Elitejobs database with the passkey “${k.label}”`);
    return { ok: true, until: g.unlocked[p.id] };
  }
  function dbList(p) {
    const R = rights(p); if (!R.db) throw err('Elitejobs database is locked. Ask Admin for a passkey.', 403);
    return { vacs: load().vacs.sort((a, b) => b.created - a.created) };
  }


  // ================= Stage 2 · interviews → results → push → call → waiting list =================
  const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const localDay = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  // interview officers on duty today: checked in and not out. If nobody uses attendance yet, every active interview officer.
  function officers() {
    const all = staffOf().filter(x => x.role === 'int' && x.on !== false);
    const att = rj(F('attendance.json'), {}), day = att[localDay(Date.now())] || att[kDay()] || {};
    const here = all.filter(x => day[x.id] && !day[x.id].out);
    return (here.length ? here : all).map(x => ({ id: x.id, name: x.name }));
  }
  // the Upcoming card opens when a person from its list checks in at reception for an interview today (or staff start it)
  function arrived(v) {
    const vis = (stateOf().visitors || []).filter(x => x.t && kDay(x.t) === kDay() && x.why === 'Interview');
    const names = new Set(vis.map(x => norm(x.name)));
    return ((v.hr && v.hr.keep) || []).filter(x => names.has(norm(x.name))).map(x => x.app);
  }
  const s20 = r => Math.round(r.scores.reduce((a, b) => a + b, 0) / (r.scores.length * 5) * 200) / 10;
  const finalOf = c => { const R = Object.values(c.rows).filter(r => r.scores); return R.length ? Math.round(R.reduce((a, r) => a + r.s20, 0) / R.length * 10) / 10 : 0; };
  const pendingFor = (c, uid) => c.status === 'open' && c.rows[uid] && !c.rows[uid].scores && !c.rows[uid].absent;
  function upView(v, p) {
    const C = Object.values((v.int && v.int.cands) || {}), arr = arrived(v);
    return { ...v, open: !!(v.int && (v.int.started || arr.length)), arrived: arr, cands: C, mineWaiting: C.filter(c => pendingFor(c, p.id)).length, applicants: 0, me: {} };
  }
  function upcoming(p) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to vacancies.', 403);
    return { officers: officers(), vacs: load().vacs.filter(v => v.stage === 'upcoming').sort((a, b) => b.int.t - a.int.t).map(v => upView(v, p)) };
  }
  const needInt = (p, R) => { if (!((p.role === 'int' && R.view) || R.admin)) throw err('Only the interview staff can do this.', 403); };
  function startInt(p, id) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    v.int.started = { ...who(p), t: Date.now() }; hist(v, p, 'started the interviews'); save(db); log(p, `started the interviews for “${v.title}”`); ping();
    return { ok: true };
  }
  function addCand(p, id, app) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    if (!(v.int.started || arrived(v).length)) throw err('The interviews for this vacancy haven’t started yet.', 409);
    const k = v.hr.keep.find(x => x.app === app); if (!k) throw err('This person isn’t on the list for this vacancy.', 404);
    v.int.cands = v.int.cands || {}; if (v.int.cands[app]) throw err(`${k.name} is already being interviewed.`, 409);
    const O = officers(); if (!O.length) throw err('No interview officer is registered in the Hub.', 409);
    v.int.cands[app] = { app, name: k.name, phone: k.phone, wa: k.wa, email: k.email, lives: k.lives, gender: k.gender, position: v.title, vac: v.id,
      added: { ...who(p), t: Date.now() }, status: 'open', rows: Object.fromEntries(O.map(o => [o.id, { uid: o.id, name: o.name }])), order: O.map(o => o.id) };
    hist(v, p, `started the interview of ${k.name}`); save(db); log(p, `started the interview of ${k.name} (${v.title})`); ping();
    return { ok: true };
  }
  function score(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'open') throw err('This interview is closed.', 409);
    const row = c.rows[p.id]; if (!row) throw err('You aren’t one of the interviewers on this form.', 403);
    const sc = (Array.isArray(b.scores) ? b.scores : []).map(Number);
    if (sc.length < 1 || sc.length > 20) throw err('Choose between 1 and 20 questions.');
    if (sc.some(x => !(x >= 0 && x <= 5) || Math.round(x * 2) !== x * 2)) throw err('Each question is marked from 0 to 5 (halves allowed).');
    const topic = s(b.topic, 120); if (topic.length < 2) throw err('Write the topic you asked about.');
    Object.assign(row, { topic, scores: sc, absent: false, t: Date.now() }); row.s20 = s20(row);
    hist(v, p, `marked ${c.name}: ${row.s20}/20`); save(db); log(p, `marked ${c.name} for ${v.title}: ${row.s20}/20 (${sc.length} questions on ${topic})`); ping();
    return { ok: true, s20: row.s20 };
  }
  function absent(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'open') throw err('This interview is closed.', 409);
    const row = c.rows[b.uid]; if (!row || row.scores) throw err('That row is already marked.', 409);
    row.absent = { by: p.name, t: Date.now() }; hist(v, p, `noted that ${row.name} wasn’t there for ${c.name}’s interview`); save(db); log(p, `noted that ${row.name} isn’t here for ${c.name}’s interview`); ping();
    return { ok: true };
  }
  function finish(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'open') throw err('This interview is already finished.', 409);
    const rows = Object.values(c.rows), done = rows.filter(r => r.scores);
    if (rows.some(r => !r.scores && !r.absent)) throw err('Every interviewer has to mark their row first (or be noted as not here).', 409);
    if (!done.length) throw err('At least one interviewer has to mark this person.', 409);
    Object.assign(c, { status: 'done', final: finalOf(c), finished: { ...who(p), t: Date.now() }, day: kDay() });
    hist(v, p, `finished ${c.name}: ${c.final}/20`); save(db); log(p, `finished the interview of ${c.name} for ${v.title}: ${c.final}/20`); ping();
    return { ok: true, final: c.final };
  }
  // every finished interview, one list — for Interview results, the call list and the Waiting list
  const finished = () => load().vacs.flatMap(v => Object.values((v.int && v.int.cands) || {}).filter(c => c.status === 'done').map(c => ({ ...c, vacTitle: v.title, employer: v.employer })));
  function results(p, q) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to interview results.', 403);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : kDay(), t = norm(q.q), min = Number(q.min) || 0;
    const all = finished(), days = [...new Set(all.map(c => c.day))].sort().reverse().slice(0, 60).map(d => ({ d, n: all.filter(c => c.day === d).length }));
    const L = all.filter(c => c.day === day && (!t || norm(c.vacTitle).includes(t)) && c.final >= min).sort((a, b) => b.final - a.final);
    return { day, days, list: L, canPush: p.role === 'hr' || R.rm || R.admin };
  }
  // HR or the recruitment manager decides once: qualified ones go to the Call Center. The first decision locks it.
  function push(p, b) {
    const R = rights(p); if (!(p.role === 'hr' || R.rm || R.admin)) throw err('Only HR or the recruitment manager can push.', 403);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'done') throw err('This interview isn’t finished.', 409);
    if (c.push) throw err(`${c.push.by.name} already decided for ${c.name}.`, 409);
    c.push = { by: who(p), t: Date.now(), qualified: !!b.qualified };
    hist(v, p, `${b.qualified ? 'qualified' : 'did not qualify'} ${c.name} (${c.final}/20)${b.qualified ? ' — pushed to the Call Center' : ''}`); save(db);
    log(p, `${b.qualified ? 'pushed' : 'marked not qualified:'} ${c.name} (${v.title}, ${c.final}/20)${b.qualified ? ' to the Call Center' : ''}`); ping();
    return { ok: true };
  }
  function callList(p) {
    const R = rights(p); if (!((p.role === 'cc' && R.view) || R.admin || R.rm)) return { list: [] };
    return { list: finished().filter(c => c.push && c.push.qualified && !c.called).sort((a, b) => a.push.t - b.push.t) };
  }
  function called(p, b) {
    const R = rights(p); if (!((p.role === 'cc' && R.view) || R.admin)) throw err('This step belongs to the Call Center.', 403);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || !c.push || !c.push.qualified) throw err('This person wasn’t pushed to the Call Center.', 409);
    if (c.called) throw err(`${c.called.by.name} already called ${c.name}.`, 409);
    c.called = { by: who(p), t: Date.now(), day: kDay(), note: s(b.note, 200) };
    hist(v, p, `called ${c.name} to come and meet the employer`); save(db); log(p, `called ${c.name} (${v.title}) to come and meet the employer`); ping();
    return { ok: true };
  }
  function waiting(p, q) {
    const R = rights(p); if (!(R.rm || R.admin)) throw err('The Waiting list belongs to the recruitment manager.', 403);
    const all = finished().filter(c => c.called), day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : kDay();
    return { day, days: [...new Set(all.map(c => c.called.day))].sort().reverse().slice(0, 60).map(d => ({ d, n: all.filter(c => c.called.day === d).length })), list: all.filter(c => c.called.day === day).sort((a, b) => a.called.t - b.called.t) };
  }
  function served(p, b) {
    const R = rights(p); if (!(R.rm || R.admin)) throw err('Only the recruitment manager can tick this.', 403);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || !c.called) throw err('This person isn’t on the Waiting list.', 409);
    c.served = { v: !!b.v, by: who(p), t: Date.now() }; hist(v, p, `${c.name}: ${b.v ? 'served' : 'not served'}`); save(db);
    log(p, `ticked ${c.name} (${v.title}) as ${b.v ? 'served' : 'not served'}`); ping();
    return { ok: true };
  }

  // ================= Stage 3 · daily tasks, interview reports, dashboard, filing by date, database rooms =================
  // At midnight (Kigali) a vacancy whose interviews are over is filed under the day they ended. Nothing is deleted.
  function fileAway(db) {
    const today = kDay(); let ch = false;
    (db.vacs || []).forEach(v => {
      if (v.stage !== 'upcoming' || !v.int) return;
      const C = Object.values(v.int.cands || {}); if (C.some(c => c.status === 'open')) return;
      const last = C.map(c => c.day).filter(Boolean).sort().pop() || (v.int.started ? kDay(v.int.started.t) : '');
      if (last && last < today) { v.stage = 'done'; v.closed = { t: Date.now(), day: last }; v.hist = (v.hist || []).concat({ t: Date.now(), by: 'Hub', text: 'filed under ' + last + ' at midnight' }); ch = true; }
    });
    return ch;
  }
  // everything one person did on vacancies in a window — for “Daily tasks” in My report
  function dailyTasks(uid, name, from, to) {
    const out = [];
    load().vacs.forEach(v => {
      const items = (v.hist || []).filter(h => h.t >= from && h.t < to && (h.uid ? h.uid === uid : h.by === name)).map(h => ({ t: h.t, text: h.text }));
      if (items.length) out.push({ id: v.id, title: v.title, employer: v.employer || '', stage: v.stage, items });
    });
    return out.sort((a, b) => a.items[0].t - b.items[0].t);
  }
  const hm = t => new Date(t + 72e5).toISOString().slice(11, 16);
  function dailyText(list) {
    if (!list.length) return '';
    return '## Daily tasks\n' + list.map(v => `**${v.title}${v.employer ? ' — ' + v.employer : ''}**\n` + v.items.map(i => `- ${hm(i.t)} ${i.text}`).join('\n')).join('\n');
  }

  // one day of interviews, vacancy by vacancy, with who did what
  const r1 = n => Math.round(n * 10) / 10;
  function dayStats(day) {
    const vacs = [], people = {};
    load().vacs.forEach(v => {
      const C = Object.values((v.int && v.int.cands) || {}).filter(c => c.day === day || (c.status === 'open' && kDay(c.added.t) === day));
      if (!C.length) return;
      const done = C.filter(c => c.status === 'done' && c.day === day), m = done.map(c => c.final).sort((a, b) => b - a);
      done.forEach(c => Object.values(c.rows).forEach(r => {
        const o = people[r.uid] = people[r.uid] || { uid: r.uid, name: r.name, marked: 0, sum: 0, absent: 0, finished: 0, q: 0 };
        if (r.scores) { o.marked++; o.sum += r.s20; o.q += r.scores.length; } else if (r.absent) o.absent++;
      }));
      done.forEach(c => { const f = c.finished; const o = people[f.id] = people[f.id] || { uid: f.id, name: f.name, marked: 0, sum: 0, absent: 0, finished: 0, q: 0 }; o.finished++; });
      vacs.push({ id: v.id, title: v.title, employer: v.employer || '', expected: ((v.hr && v.hr.keep) || []).length, interviewed: done.length, open: C.length - done.length,
        top: m.filter(x => x >= 17).length, mid: m.filter(x => x >= 15 && x < 17).length, low: m.filter(x => x < 15).length,
        best: m.length ? m[0] : null, worst: m.length ? m[m.length - 1] : null, avg: m.length ? r1(m.reduce((a, b) => a + b, 0) / m.length) : null,
        qualified: done.filter(c => c.push && c.push.qualified).length, notq: done.filter(c => c.push && !c.push.qualified).length,
        cands: done.sort((a, b) => b.final - a.final).map(c => ({ name: c.name, final: c.final, rows: Object.values(c.rows).map(r => ({ name: r.name, s20: r.s20 == null ? null : r.s20, q: r.scores ? r.scores.length : 0, topic: r.topic || '', absent: !!r.absent })), push: c.push ? (c.push.qualified ? 'qualified' : 'not qualified') : '' })) });
    });
    const all = vacs.flatMap(v => v.cands.map(c => c.final));
    const tot = { vacancies: vacs.length, expected: vacs.reduce((a, v) => a + v.expected, 0), interviewed: all.length, top: all.filter(x => x >= 17).length, low: all.filter(x => x < 15).length, best: all.length ? Math.max(...all) : null, avg: all.length ? r1(all.reduce((a, b) => a + b, 0) / all.length) : null };
    const team = Object.values(people).map(o => ({ name: o.name, marked: o.marked, finished: o.finished, absent: o.absent, questions: o.q, avgGiven: o.marked ? r1(o.sum / o.marked) : null })).sort((a, b) => b.marked - a.marked);
    return { day, vacs, tot, team };
  }
  function summaryOf(st) {
    if (!st.vacs.length) return 'No interviews were finished on this day.';
    return st.vacs.map(v => `${v.title}: ${v.expected} said they were coming, ${v.interviewed} interviewed` + (v.interviewed ? ` — ${v.top} at 17 or above, ${v.mid} between 15 and 17, ${v.low} under 15, best ${v.best}/20, average ${v.avg}/20` : '') + (v.open ? `; ${v.open} still in interview` : '') + '.').join(' ');
  }
  const IR = F('int-reports.jsonl');
  const readIR = () => { try { return fs.readFileSync(IR, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
  const TPL = ['aurora', 'paper', 'graphite'], TO = { rm: 'Recruitment manager', admin: 'Admin', hr: 'HR manager' };
  function intPreview(p, day) {
    const R = rights(p); if (!((p.role === 'int' && R.view) || R.admin)) throw err('Interview reports are written by the interview staff.', 403);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : kDay(), st = dayStats(d);
    return { ...st, summary: summaryOf(st) };
  }
  function intSend(p, b) {
    const st = intPreview(p, b.day), tpl = TPL.includes(b.tpl) ? b.tpl : 'aurora';
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).filter(x => TO[x]))];
    if (!to.length) throw err('Choose who receives the interview report.');
    if (!st.vacs.length) throw err('No interviews were finished today, so there is nothing to report yet.', 409);
    const rec = { id: 'IR-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(), day: st.day, t: Date.now(), by: who(p), tpl, to, stats: { vacs: st.vacs, tot: st.tot, team: st.team }, summary: st.summary };
    fs.appendFileSync(IR, JSON.stringify(rec) + '\n');
    log(p, `sent the interview report for ${st.day} to ${to.map(x => TO[x]).join(', ')} (${st.tot.interviewed} interviewed on ${st.vacs.length} position${st.vacs.length === 1 ? '' : 's'})`);
    if (note) {
      const roles = new Set(to.filter(x => x !== 'rm'));
      if (to.includes('rm')) { const g = rj(GR, { users: {} }); staffOf().filter(x => g.users[x.id] && g.users[x.id].rm).forEach(x => roles.add(x.role)); }
      note([...roles], `📊 ${p.name} sent the interview report for ${st.day}: ${st.tot.interviewed} interviewed, ${st.tot.top} at 17 or above`);
    }
    broadcast({ type: 'vflow', kind: 'report' });
    return { ok: true, report: rec };
  }
  // who may read a report: Admin, the sender, and whoever it was sent to
  function canRead(p, R, r) { return R.admin || r.by.id === p.id || (r.to.includes('hr') && p.role === 'hr') || (r.to.includes('rm') && R.rm); }
  function intReports(p, q) {
    const R = rights(p), mine = readIR().filter(r => canRead(p, R, r));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : kDay();
    return { day, days: [...new Set(mine.map(r => r.day))].sort().reverse().slice(0, 60).map(d => ({ d, n: mine.filter(r => r.day === d).length })), list: mine.filter(r => r.day === day).reverse() };
  }

  // the Vacancy dashboard: how every live vacancy is moving, and who moved it today
  function dashboard(p) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to vacancies.', 403);
    const today = kDay(), V = load().vacs, live = V.filter(v => v.stage !== 'done');
    const stage = k => live.filter(v => v.stage === k).length;
    const fin = finished(), td = fin.filter(c => c.day === today), marks = td.map(c => c.final);
    const acts = {}; V.forEach(v => (v.hist || []).forEach(h => { if (h.by !== 'Hub' && kDay(h.t) === today) { const o = acts[h.uid || h.by] = acts[h.uid || h.by] || { name: h.by, n: 0, vacs: new Set() }; o.n++; o.vacs.add(v.title); } }));
    const tiles = { live: live.length, posting: stage('post'), calling: stage('call'), hr: stage('hr'), notices: stage('notice'), interviews: stage('upcoming'),
      applied: live.reduce((a, v) => a + applicantsOf(v).length, 0), toCall: live.filter(v => v.stage === 'call').reduce((a, v) => a + applicantsOf(v).filter(x => x.status !== 'done').length, 0),
      coming: live.filter(v => v.hr).reduce((a, v) => a + v.hr.keep.length, 0), interviewed: td.length, avg: marks.length ? r1(marks.reduce((a, b) => a + b, 0) / marks.length) : null,
      top: marks.filter(x => x >= 17).length, qualified: fin.filter(c => c.push && c.push.qualified && kDay(c.push.t) === today).length,
      calledBack: fin.filter(c => c.called && c.called.day === today).length, served: fin.filter(c => c.served && c.served.v && kDay(c.served.t) === today).length,
      filed: V.filter(v => v.stage === 'done').length };
    const rows = live.sort((a, b) => b.created - a.created).map(v => {
      const apps = applicantsOf(v), C = Object.values((v.int && v.int.cands) || {}), done = C.filter(c => c.status === 'done');
      const step = STAGES.indexOf(v.stage), pct = Math.round(((step + (v.stage === 'upcoming' && v.hr.keep.length ? done.length / v.hr.keep.length : 0)) / 5) * 100);
      return { id: v.id, title: v.title, employer: v.employer || '', stage: v.stage, pct: Math.min(100, pct), created: v.created, starter: v.starter.name,
        poster: v.post && (v.post.by || v.post.claimed || {}).name || '', caller: v.call ? v.call.by.name : '', hr: v.hr ? v.hr.by.name : '',
        applied: v.call ? v.call.list.length : apps.length, toCall: v.stage === 'call' ? apps.filter(x => x.status !== 'done').length : 0,
        coming: v.hr ? v.hr.keep.length : v.call ? v.call.list.filter(x => x.outcome === 'coming').length : 0,
        interviewed: done.length, inRoom: C.length - done.length, best: done.length ? Math.max(...done.map(c => c.final)) : null };
    });
    return { day: today, tiles, rows, people: Object.values(acts).map(o => ({ name: o.name, n: o.n, vacs: [...o.vacs] })).sort((a, b) => b.n - a.n) };
  }

  // Elitejobs database rooms — kept by date, searchable, never trimmed
  const ROOMS = ['vacs', 'apps', 'ints', 'reports'];
  function dbRoom(p, q) {
    const R = rights(p); if (!R.db) throw err('Elitejobs database is locked. Ask Admin for a passkey.', 403);
    const room = ROOMS.includes(q.room) ? q.room : 'vacs', t = norm(q.q), V = load().vacs;
    let items = [];
    if (room === 'vacs') items = V.map(v => ({ day: kDay(v.created), t: v.created, k: norm(v.title + ' ' + v.employer + ' ' + v.starter.name), v: { id: v.id, title: v.title, employer: v.employer, need: v.need, stage: v.stage, starter: v.starter.name, poster: v.post && (v.post.by || {}).name || '', caller: v.call ? v.call.by.name : '', hr: v.hr ? v.hr.by.name : '', applied: v.call ? v.call.list.length : 0, coming: v.hr ? v.hr.keep.length : 0, interviewed: Object.values((v.int && v.int.cands) || {}).filter(c => c.status === 'done').length, closed: v.closed ? v.closed.day : '', hist: v.hist || [] } }));
    if (room === 'apps') {
      const outcome = {}; V.forEach(v => v.call && v.call.list.forEach(x => { outcome[x.app] = { vac: v.title, outcome: x.outcome, calledBy: x.calledBy }; }));
      items = urgent.allApps().map(a => ({ day: kDay(a.created || a.got), t: a.created || a.got, k: norm([a.data.name, a.data.phone, a.data.email, a.title, a.data.lives].join(' ')),
        v: { id: a.id, name: a.data.name || '', phone: a.data.phone || '', wa: a.data.whatsapp || '', email: a.data.email || '', lives: a.data.lives || '', gender: a.data.gender || '', job: a.title, outcome: (outcome[a.id] || {}).outcome || a.outcome || '', vac: (outcome[a.id] || {}).vac || '', calledBy: (outcome[a.id] || {}).calledBy || a.reviewer || '', note: a.note || '' } }));
    }
    if (room === 'ints') items = finished().map(c => ({ day: c.day, t: c.finished.t, k: norm(c.name + ' ' + c.vacTitle + ' ' + c.phone), v: { name: c.name, phone: c.phone, email: c.email, position: c.vacTitle, employer: c.employer, final: c.final, rows: Object.values(c.rows).map(r => ({ name: r.name, s20: r.s20 == null ? null : r.s20, topic: r.topic || '', q: r.scores ? r.scores.length : 0, absent: !!r.absent })), push: c.push ? { q: c.push.qualified, by: c.push.by.name } : null, called: c.called ? c.called.by.name : '', served: c.served ? c.served.v : null } }));
    if (room === 'reports') {
      const staff = (() => { try { return fs.readFileSync(F('reports.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } })();
      items = readIR().map(r => ({ day: r.day, t: r.t, k: norm('interview ' + r.by.name), v: { kind: 'interview', id: r.id, by: r.by.name, to: r.to.map(x => TO[x]), summary: r.summary, tot: r.stats.tot, tpl: r.tpl } }))
        .concat(staff.map(r => ({ day: kDay(r.t), t: r.t, k: norm(r.name + ' ' + r.dept + ' ' + r.period), v: { kind: 'staff', id: r.id, by: r.name, dept: r.dept, label: r.label, period: r.period, text: r.text, ai: r.ai } })));
    }
    const days = {}; items.forEach(i => { days[i.day] = (days[i.day] || 0) + 1; });
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : kDay();
    const pick = t ? items.filter(i => i.k.includes(t)) : items.filter(i => i.day === day);
    return { room, day, q: q.q || '', days: Object.keys(days).sort().reverse().slice(0, 90).map(d => ({ d, n: days[d] })), total: items.length,
      list: pick.sort((a, b) => b.t - a.t).slice(0, 300).map(i => ({ day: i.day, t: i.t, ...i.v })) };
  }
  function irGet(p, id) { const R = rights(p), r = readIR().find(x => x.id === id); if (!r || !(canRead(p, R, r) || R.db)) throw err('Report not found.', 404); return r; }
  function dbExport(p, b) {
    const d = dbRoom(p, b); log(p, `downloaded ${d.list.length} record${d.list.length === 1 ? '' : 's'} from Elitejobs database (${{ vacs: 'Vacancies', apps: 'Applicants', ints: 'Interviews', reports: 'Reports' }[d.room]}, ${d.q ? 'search “' + s(d.q, 40) + '”' : d.day})`);
    return d;
  }

  return { upcoming, startInt, addCand, score, absent, finish, results, push, callList, called, waiting, served, rights, mine, dailyTasks, dailyText, intPreview, intSend, intReports, irGet, dashboard, dbRoom, dbExport, list, create, claimPost, posted, callApprove, complete, intApprove, grantsView, setGrant, keysView, forge, revoke, unlock, dbList, kDay };
};
