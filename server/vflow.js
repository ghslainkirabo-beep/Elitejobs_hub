// Vacancy flow — one vacancy walks a fixed line, and nobody's step opens before the step before it is finished:
//   1 Starter states it (HR, or whoever Admin grants) → 2 Poster publishes it as an urgent job (Endover, pre-filled)
//   → 3 Call Center calls everyone who applied, then approves (the post comes down) → 4 HR completes it
//   (only "coming on site" people stay) → 5 Notices → Interview staff approve → 6 Upcoming (interviews, stage 2).
// Who may take part is Admin's choice (grants). People without a grant only learn that vacancies exist — the details
// never leave the server for them. Everything is kept for good: this file is the vacancy part of Elitejobs database.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ DATA_DIR, urgent, staffOf, stateOf, appendActivity, broadcast }) {
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
  const load = () => rj(VF, { vacs: [] });
  const save = db => wj(VF, db);
  const find = (db, id) => { const v = db.vacs.find(x => x.id === id); if (!v) throw err('This vacancy no longer exists.', 404); return v; };
  const hist = (v, p, text) => { v.hist = (v.hist || []).concat({ t: Date.now(), by: p.name, text }).slice(-80); };
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
    row.absent = { by: p.name, t: Date.now() }; save(db); log(p, `noted that ${row.name} isn’t here for ${c.name}’s interview`); ping();
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

  return { upcoming, startInt, addCand, score, absent, finish, results, push, callList, called, waiting, served, rights, mine, list, create, claimPost, posted, callApprove, complete, intApprove, grantsView, setGrant, keysView, forge, revoke, unlock, dbList, kDay };
};
