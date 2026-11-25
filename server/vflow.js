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
  // Grant power: every step of the life cycle is a power Admin gives to people, whatever their position.
  // Until Admin decides for someone, the job title gives the usual power (HR states and does the HR step, and so on).
  const POWERS = ['start', 'post', 'cc', 'hr', 'int', 'rm', 'db'];
  function powers(p) {                       // only what is written in the grants (used by Urgent hiring too)
    if (!p) return {};
    const u = rj(GR, { users: {} }).users[p.id] || {};
    return { post: u.post === true, review: u.cc !== undefined ? !!u.cc : p.role === 'cc' && u.view !== false };
  }
  function rights(p) {
    if (!p) return { view: false };
    if (isAdmin(p)) return { admin: true, start: true, rm: true, view: true, db: true, post: true, review: true, cc: true, hr: true, int: true };
    const g = rj(GR, { users: {}, unlocked: {} }), u = g.users[p.id] || {};
    const off = u.view === false;                                  // an older “no access” stays respected
    const pw = (k, def) => u[k] !== undefined ? !!u[k] : (!off && def);
    const start = pw('start', p.role === 'hr' || p.role === 'rcm'), cc = pw('cc', p.role === 'cc'), hr = pw('hr', p.role === 'hr'), int = pw('int', p.role === 'int'), rm = pw('rm', p.role === 'rcm');
    const db = !!u.db || (g.unlocked[p.id] || 0) > Date.now();
    let post = false, review = false; try { const U = urgent.rights(p); post = !!U.post; review = !!U.review; } catch (e) {}
    if (u.post !== undefined) post = !!u.post;
    if (cc) review = true;
    const view = start || rm || cc || hr || int || post || u.view === true;
    return { start, post, cc, hr, int, rm, view, db, review };
  }
  const needAdmin = p => { if (!isAdmin(p)) throw err('Only Admin can change who takes part in vacancies.', 403); };

  // ---------- the vacancies ----------
  const load = () => { const db = rj(VF, { vacs: [] }); if (fileAway(db)) save(db); return db; };
  const save = db => wj(VF, db);
  const find = (db, id) => { const v = db.vacs.find(x => x.id === id); if (!v) throw err('This vacancy no longer exists.', 404); return v; };
  const hist = (v, p, text) => { v.hist = (v.hist || []).concat({ t: Date.now(), by: p.name, uid: p.id, text }).slice(-200); };
  const applicantsOf = v => v.post && v.post.id ? urgent.allApps().filter(a => a.post === v.post.id) : [];
  const STAGES = ['post', 'call', 'hr', 'notice', 'upcoming', 'remarks', 'done'];

  // the applicant limit is reached (or the post has ended with people in it): the Call Center's step opens
  const limitReached = (v, n) => n > 0 && ((v.post && v.post.cap ? n >= v.post.cap : true) || (v.post && v.post.ends && Date.now() >= v.post.ends));
  const mineUp = (v, p) => !!(v.int && ((v.int.mine || {})[p.id] || v.int.saved || (!v.int.mine && v.int.by && v.int.by.id === p.id)));
  const TURN = { post: 'the poster', call: 'the Call Center', hr: 'HR', notice: 'the interviewers', upcoming: 'the interviewers', remarks: 'the recruiter' };
  // what one person may see of one vacancy. Everyone in the life cycle sees the Approve button; it works only for whose turn it is.
  function shape(v, p, R) {
    const apps = applicantsOf(v), waiting = apps.filter(a => a.status !== 'done').length;
    const me = { act: 'wait', ready: false, why: `Waiting for ${TURN[v.stage] || 'the step before'}` };
    if (v.stage === 'post' && R.post) {
      if (v.post && v.post.claimed && v.post.claimed.id !== p.id && Date.now() - v.post.claimed.t < 2 * 36e5) me.why = `${v.post.claimed.name} is posting it now`;
      else { me.act = 'post'; me.ready = true; me.why = ''; }
    } else if (v.stage === 'call' && R.cc) {
      me.act = 'call';
      if (limitReached(v, apps.length) || v.oc) { me.ready = true; me.why = ''; }
      else me.why = v.post && v.post.cap ? `Opens at the limit: ${apps.length} of ${v.post.cap} have applied` : 'Waiting for the first person to apply';
    } else if (v.stage === 'hr' && (R.hr || R.admin)) { me.act = 'complete'; me.ready = true; me.why = ''; }
    else if (v.stage === 'post' && !R.post) me.why = 'Waiting for the poster';
    else if ((v.stage === 'notice' || (v.stage === 'upcoming' && !mineUp(v, p))) && R.int) { me.act = 'interview'; me.ready = true; me.why = ''; }
    else if (v.stage === 'remarks' && (R.rm || R.admin)) { me.act = 'decide'; me.ready = true; me.why = ''; }
    return { ...v, oc: v.oc ? { opened: v.oc.opened } : null, achieved: achieved(v), canEdit: canEdit(v, p, R), applicants: apps.length, cap: (v.post && v.post.cap) || 0, waiting, me, mineToDelete: v.starter.id === p.id };
  }
  // my tasks: a vacancy stays with everyone whose step is now or still to come. When your part is finished, it leaves you.
  const STEP_OF = { post: 'post', cc: 'call', hr: 'hr', int: 'notice' };
  function involved(v, p, R) {
    if (v.stage === 'done') return false;
    if (v.stage === 'upcoming') return !!R.int && !mineUp(v, p);
    if (v.stage === 'remarks') return !!(R.rm || R.admin || v.starter.id === p.id);
    if (R.admin || R.rm || v.starter.id === p.id) return true;
    const now = STAGES.indexOf(v.stage);
    return Object.keys(STEP_OF).some(k => R[k] && STAGES.indexOf(STEP_OF[k]) >= now);
  }
  // a vacancy is achieved when the recruiter has approved it and every interviewed person has a final answer
  function achieved(v) {
    if (v.stage !== 'done' || !v.rm) return null;
    const C = Object.values((v.int && v.int.cands) || {}).filter(c => c.status === 'done');
    if (!C.length || C.some(c => !c.push || (c.push.qualified && !(c.served && c.served.v !== undefined)))) return null;
    return { t: Math.max(...C.map(c => (c.served && c.served.t) || c.push.t)), served: C.filter(c => c.served && c.served.v).length };
  }
  const canEdit = (v, p, R) => v.stage === 'call' && !v.oc && !!v.post && !!v.post.id && (R.post || R.admin);
  // only the person who stated a vacancy can delete it. It leaves everyone's tasks; the record is kept in the database.
  async function remove(p, id) {
    if (!p) throw err('Sign in first.', 401);
    const db = load(), v = find(db, id);
    if (v.starter.id !== p.id) throw err(`Only ${v.starter.name}, who stated it, can delete this vacancy.`, 403);
    if (v.stage === 'upcoming' || v.stage === 'done') throw err('Interviews have started for this vacancy, so it can’t be deleted.', 409);
    if (v.post && v.post.id && v.stage === 'call') { try { await urgent.remote(`/api/hub/posts/${encodeURIComponent(v.post.id)}/remove`, { method: 'POST' }); } catch (e) { /* already ended */ } }
    hist(v, p, 'deleted the vacancy'); v.deleted = { ...who(p), t: Date.now(), stage: v.stage };
    db.vacs = db.vacs.filter(x => x.id !== id); db.trash = (db.trash || []).concat(v).slice(-500); save(db);
    log(p, `deleted the vacancy “${v.title}”${v.post && v.post.id ? ' (its job came down from the website)' : ''}`);
    broadcast({ type: 'urgent', kind: 'posts' }); ping();
    return { ok: true };
  }
  function mine(p) {
    if (!p) throw err('Sign in first.', 401);
    const R = rights(p), db = load(), live = db.vacs.filter(v => v.stage !== 'done');
    if (!R.view) return { rights: R, tasks: [], locked: live.length };
    return { rights: R, tasks: live.filter(v => involved(v, p, R)).map(v => shape(v, p, R)), locked: 0 };
  }
  function list(p, scope) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to vacancies.', 403);
    const db = load(), want = { active: v => !['done', 'upcoming', 'remarks'].includes(v.stage), remarks: v => v.stage === 'remarks', notices: v => v.stage === 'notice', upcoming: v => v.stage === 'upcoming', all: () => true }[scope] || (() => true);
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
  function posted(p, id, postId, title, cap, ends) {
    const db = load(), v = db.vacs.find(x => x.id === id); if (!v || v.stage !== 'post') return;
    cap = Math.max(0, Math.min(500, parseInt(cap, 10) || 0));
    v.post = { id: postId, title: s(title, 80), by: who(p), t: Date.now(), cap, ends: Number(ends) || 0 }; v.stage = 'call';
    hist(v, p, `published it as an urgent job${cap ? ' — limit ' + cap + ' applicants' : ''}`); save(db);
    log(p, `posted the vacancy “${v.title}” as an urgent job${cap ? ' (limit ' + cap + ')' : ''}`); ping();
  }
  // 3 · Vacancy on call. Approve (at the applicant limit) opens the vacancy in the Call Center's room. Each caller takes one
  // applicant at a time: the others see that person blurred ("being called") until a result is saved, then the person leaves
  // every caller's list and the caller is written on them. Finish closes the calling for everyone and sends the list to HR —
  // never while somebody is still on a call. A vacancy that isn't finished stays in the room as a draft.
  const OC_HOLD = 20 * 6e4;
  const OUT = { coming: 'Coming on site', member: 'Already a member', 'not-available': 'Not available', 'not-interested': 'Not engaged', 'no-answer': 'Didn’t pick up' };
  const live = c => !!c && Date.now() - c.t < OC_HOLD;
  const needCc = R => { if (!(R.cc || R.admin)) throw err('This step belongs to the Call Center.', 403); };
  function ocOpen(p, id) {
    const R = rights(p); needCc(R);
    const db = load(), v = find(db, id); if (v.stage !== 'call') throw err('This vacancy isn’t at the calling step.', 409);
    const apps = applicantsOf(v); if (!v.oc && !limitReached(v, apps.length)) throw err(v.post && v.post.cap ? `Calling opens at the applicant limit: ${apps.length} of ${v.post.cap} have applied.` : 'No one has applied yet.', 409);
    if (!v.oc) { v.oc = { opened: { ...who(p), t: Date.now() }, claims: {}, by: {} }; hist(v, p, 'approved it — calling started in Vacancy on call'); save(db); log(p, `opened “${v.title}” in Vacancy on call (${apps.length} applicants)`); ping(); }
    return { ok: true };
  }
  function ocView(v, p) {
    const apps = applicantsOf(v), oc = v.oc || { claims: {}, by: {} };
    const L = apps.map(a => { const c = oc.claims[a.id], done = a.status === 'done';
      return { app: a.id, name: s(a.data.name, 60), phone: s(a.data.phone, 30), wa: s(a.data.whatsapp, 30), email: s(a.data.email, 100), lives: s(a.data.lives, 80), gender: a.data.gender || '',
        docs: Object.keys(a.docs || {}), done, outcome: done ? a.outcome : '', note: done ? s(a.note, 200) : '', calledBy: done ? (oc.by[a.id] || { name: a.reviewer || '' }).name : '',
        calling: !done && live(c) ? { name: c.name, mine: c.id === p.id } : null }; });
    const lastAct = Math.max(oc.opened ? oc.opened.t : 0, ...Object.values(oc.claims || {}).map(c => c.t), ...Object.values(oc.by || {}).map(x => x.t));
    return { id: v.id, title: v.title, employer: v.employer || '', loc: v.loc || '', need: v.need, cap: (v.post && v.post.cap) || 0, opened: oc.opened, left: L.filter(x => !x.done), done: L.filter(x => x.done),
      busy: L.filter(x => x.calling && !x.calling.mine).map(x => x.calling.name), mineNow: L.filter(x => x.calling && x.calling.mine).map(x => x.app),
      draft: !L.some(x => x.calling) && Date.now() - lastAct > 2 * 36e5 };
  }
  function ocList(p) {
    const R = rights(p); needCc(R);
    return { list: load().vacs.filter(v => v.stage === 'call' && v.oc).sort((a, b) => a.oc.opened.t - b.oc.opened.t).map(v => ocView(v, p)), outcomes: OUT };
  }
  function ocClaim(p, id, app, on) {
    const R = rights(p); needCc(R);
    const db = load(), v = find(db, id); if (v.stage !== 'call' || !v.oc) throw err('This vacancy isn’t on call any more.', 409);
    const a = applicantsOf(v).find(x => x.id === app); if (!a) throw err('This applicant isn’t on this vacancy.', 404);
    if (a.status === 'done') throw err(`${s(a.data.name, 40)} was already called by ${(v.oc.by[app] || { name: a.reviewer || 'someone' }).name}.`, 409);
    const c = v.oc.claims[app];
    if (on) { if (live(c) && c.id !== p.id) throw err(`${c.name} is calling ${s(a.data.name, 40)} now.`, 409); v.oc.claims[app] = { id: p.id, name: p.name, t: Date.now() }; }
    else if (c && c.id === p.id) delete v.oc.claims[app];
    save(db); ping(); return { ok: true };
  }
  async function ocResult(p, b) {
    const R = rights(p); needCc(R);
    const id = String(b.id || ''), app = String(b.app || ''); if (!OUT[b.outcome]) throw err('Choose what happened on the call.');
    let db = load(), v = find(db, id); if (v.stage !== 'call' || !v.oc) throw err('This vacancy isn’t on call any more.', 409);
    const c = v.oc.claims[app]; if (live(c) && c.id !== p.id) throw err(`${c.name} is calling this person now.`, 409);
    const a0 = applicantsOf(v).find(x => x.id === app); if (!a0) throw err('This applicant isn’t on this vacancy.', 404);
    if (a0.status === 'done') throw err(`${s(a0.data.name, 40)} was already called.`, 409);
    await urgent.outcome(p, { id: app, outcome: b.outcome, note: s(b.note, 300) });
    db = load(); v = find(db, id); delete v.oc.claims[app]; v.oc.by[app] = { ...who(p), t: Date.now(), outcome: b.outcome };
    hist(v, p, `called ${s(a0.data.name, 40)}: ${OUT[b.outcome]}`); save(db); ping();
    return { ok: true };
  }
  async function callApprove(p, id) {                       // Finish: the calling is over for everyone
    const R = rights(p); needCc(R);
    const db = load(), v = find(db, id); if (v.stage !== 'call') throw err('This vacancy isn’t at the calling step.', 409);
    const apps = applicantsOf(v); if (!apps.length) throw err('No one has applied yet.', 409);
    if (!v.oc && !limitReached(v, apps.length)) throw err(`The Call Center’s step opens at the applicant limit: ${apps.length} of ${v.post.cap} have applied.`, 409);
    const busy = Object.values((v.oc && v.oc.claims) || {}).filter(c => live(c) && c.id !== p.id);
    if (busy.length) throw err(`${busy[0].name} is still on a call. Finish works when nobody is calling.`, 409);
    if (!apps.some(a => a.status === 'done')) throw err('Call at least one applicant first.', 409);
    try { await urgent.remote(`/api/hub/posts/${encodeURIComponent(v.post.id)}/remove`, { method: 'POST' }); } catch (e) { /* already ended on the website */ }
    const by = (v.oc && v.oc.by) || {};
    v.call = { by: who(p), t: Date.now(), day: kDay(), list: apps.map(a => ({ app: a.id, name: s(a.data.name, 60), phone: s(a.data.phone, 30), wa: s(a.data.whatsapp, 30), email: s(a.data.email, 100), lives: s(a.data.lives, 80), gender: a.data.gender || '', outcome: a.status === 'done' ? a.outcome || '' : 'not-called', note: s(a.note, 200), calledBy: a.status === 'done' ? (by[a.id] || { name: a.reviewer || '' }).name : '' })) };
    if (v.oc) v.oc.claims = {};
    const called = v.call.list.filter(x => x.outcome !== 'not-called').length;
    v.stage = 'hr'; hist(v, p, `finished the calls: ${called} of ${apps.length} called — the post came down and it went to HR`); save(db);
    log(p, `finished the calls for “${v.title}”: ${called} called, ${v.call.list.filter(x => x.outcome === 'coming').length} coming on site`);
    broadcast({ type: 'urgent', kind: 'posts' }); ping();
    return { ok: true };
  }
  // 4 · HR completes: only the people coming on site stay. The vacancy goes to Notices for the interview staff.
  function complete(p, id) {
    const R = rights(p); if (!(R.hr || R.admin)) throw err('This step belongs to HR.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'hr') throw err('This vacancy isn’t waiting for HR.', 409);
    if (!v.hrf) throw err('Press Filter first: it keeps only the people coming on site.', 409);
    const keep = v.call.list.filter(x => x.outcome === 'coming'); if (!keep.length) throw err('Nobody is coming on site, so there is no one to interview.', 409);
    v.hr = { by: who(p), t: Date.now(), keep, removed: v.call.list.length - keep.length }; v.stage = 'notice';
    hist(v, p, `completed it — ${keep.length} coming on site kept, ${v.hr.removed} removed`); save(db);
    log(p, `completed the vacancy “${v.title}”: ${keep.length} coming on site go to interviews`); ping();
    return { ok: true };
  }
  function hrOpen(p, id) {
    const R = rights(p); if (!(R.hr || R.admin)) throw err('This step belongs to HR.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'hr') throw err('This vacancy isn’t waiting for HR.', 409);
    if (!v.hro) { v.hro = { ...who(p), t: Date.now() }; hist(v, p, 'approved it — HR review opened'); save(db); ping(); }
    return { ok: true };
  }
  function hrFilter(p, id) {
    const R = rights(p); if (!(R.hr || R.admin)) throw err('This step belongs to HR.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'hr') throw err('This vacancy isn’t waiting for HR.', 409);
    v.hrf = { by: who(p), t: Date.now() }; const n = v.call.list.filter(x => x.outcome === 'coming').length;
    hist(v, p, `filtered: ${n} coming on site kept`); save(db); ping(); return { ok: true, kept: n };
  }
  // 5 · interview staff approve: the vacancy takes its place in Upcoming
  function intApprove(p, id) {
    const R = rights(p); if (!R.int && !R.admin) throw err('This step belongs to the interviewers.', 403);
    const db = load(), v = find(db, id); if (!['notice', 'upcoming'].includes(v.stage)) throw err('This vacancy isn’t waiting for the interviewers.', 409);
    if (v.stage === 'notice') { v.int = { by: who(p), t: Date.now(), cands: {}, mine: {} }; v.stage = 'upcoming'; }
    v.int.mine = v.int.mine || {}; if (v.int.mine[p.id]) throw err('It’s already in your Upcoming.', 409);
    v.int.mine[p.id] = { name: p.name, t: Date.now() };
    hist(v, p, 'approved it — it’s in their Upcoming'); save(db);
    log(p, `approved “${v.title}” for interviews (${v.hr.keep.length} expected)`); ping();
    return { ok: true };
  }

  // the poster changes a posted vacancy (limit, pay, place, end time, description): the website changes at the same time
  async function editVac(p, b) {
    const R = rights(p), db = load(), v = find(db, String(b.id || ''));
    if (!canEdit(v, p, R)) throw err(v.stage !== 'call' ? 'Only a posted vacancy that is still taking applicants can be changed.' : v.oc ? 'Calling has started, so the post can’t change any more.' : 'Changing posted vacancies belongs to the posters.', 403);
    const ch = [], meta = {};
    const title = b.title !== undefined ? s(b.title, 80) : v.title; if (title.length < 3) throw err('Write the position.');
    if (title !== v.title) ch.push(`title “${title}”`);
    const n = x => Math.max(0, Number(String(x).replace(/[^\d.]/g, '')) || 0);
    const salMin = b.salMin !== undefined ? n(b.salMin) : v.salMin, salMax = b.salMax !== undefined ? n(b.salMax) : v.salMax;
    if (salMin && salMax && salMin > salMax) throw err('The lowest pay can’t be higher than the highest pay.');
    const cap = b.cap !== undefined ? Math.max(1, Math.min(500, parseInt(b.cap, 10) || 0)) : v.post.cap;
    const apps = applicantsOf(v).length; if (cap && cap < apps) throw err(`${apps} people have already applied, so the limit can’t go under ${apps}.`);
    const need = b.need !== undefined ? Math.max(1, Math.min(200, parseInt(b.need, 10) || 1)) : v.need;
    const loc = b.loc !== undefined ? s(b.loc, 80) : v.loc, desc = b.desc !== undefined ? s(b.desc, 600) : v.desc, reqs = b.reqs !== undefined ? s(b.reqs, 600) : v.reqs;
    if (!loc) throw err('Write where the job is.');
    const body = { id: v.post.id, title, cap, meta: { salMin, salMax, loc, desc } };
    if (b.until) body.until = b.until;
    await urgent.editPost(p, body);
    if (salMin !== v.salMin || salMax !== v.salMax) ch.push(`pay ${salMin || '—'}–${salMax || '—'}`);
    if (cap !== v.post.cap) ch.push(`limit ${v.post.cap || '—'} → ${cap}`);
    if (loc !== v.loc) ch.push(`place “${loc}”`); if (need !== v.need) ch.push(`${need} needed`); if (desc !== v.desc || reqs !== v.reqs) ch.push('description');
    if (b.until) { const t = Date.parse(b.until); if (t > Date.now()) { v.post.ends = t; ch.push('new end time'); } }
    Object.assign(v, { title, salMin, salMax, loc, desc, reqs, need }); v.post.cap = cap; v.post.title = title;
    hist(v, p, `edited the posted vacancy: ${ch.join(', ') || 'no change'}`); save(db);
    log(p, `edited the posted vacancy “${title}” (${ch.join(', ') || 'no change'}) — the website changed too`); ping();
    return { ok: true };
  }

  // The vacancy report: every vacancy ever stated, where it is, its numbers, and one report per day written by the Hub
  // from what really happened that day — until the recruiter's last decision. Achieved vacancies turn green.
  function report(p, q) {
    const R = rights(p); if (!(R.admin || R.rm || R.start || R.hr)) throw err('The vacancy report is for Admin, the recruiter, HR and whoever states vacancies.', 403);
    const V = load().vacs.filter(v => !q.id || v.id === q.id).sort((a, b) => b.created - a.created).slice(0, q.id ? 1 : 200);
    return { vacs: V.map(v => {
      const apps = v.call ? v.call.list : applicantsOf(v).map(a => ({ outcome: a.status === 'done' ? a.outcome : '' }));
      const C = Object.values((v.int && v.int.cands) || {}), done = C.filter(c => c.status === 'done');
      const m = { applied: apps.length, called: apps.filter(x => x.outcome && x.outcome !== 'not-called').length, coming: apps.filter(x => x.outcome === 'coming').length,
        fetched: v.hr ? v.hr.keep.length : 0, interviewed: done.length, excellent: done.filter(c => c.final >= 18).length, good: done.filter(c => c.final >= 15 && c.final < 18).length, failed: done.filter(c => c.final < 15).length,
        qualified: done.filter(c => c.push && c.push.qualified).length, served: done.filter(c => c.served && c.served.v).length };
      const step = STAGES.indexOf(v.stage), ach = achieved(v);
      const steps = [['Stated', v.starter], ['Posted', v.post && v.post.by ? { ...v.post.by, t: v.post.t } : null], ['Called', v.call ? { ...v.call.by, t: v.call.t } : null], ['HR', v.hr ? { ...v.hr.by, t: v.hr.t } : null],
        ['Interviews', v.int ? { ...v.int.by, t: v.int.t } : null], ['Remarks', v.remarks || (v.rm ? v.closed : null)], ['Decided', v.rm ? { ...v.rm } : null]].map(([l, x]) => ({ l, by: x ? x.name || x.by || '' : '', t: x ? x.t : 0 }));
      const days = {}; (v.hist || []).forEach(h => { const d = kDay(h.t); (days[d] = days[d] || []).push({ t: h.t, by: h.by, text: h.text }); });
      return { id: v.id, title: v.title, employer: v.employer || '', need: v.need, stage: v.stage, created: v.created, starter: v.starter.name, pct: ach ? 100 : Math.round(step / (STAGES.length - 1) * 100),
        achieved: ach, m, steps, daily: Object.keys(days).sort().reverse().map(d => ({ day: d, items: days[d] })) };
    }) };
  }

  // The data check: every vacancy record is tested against the same strict rules, so a damaged or impossible record
  // is seen at once (it is reported, never silently changed).
  const STAGE_SET = new Set(STAGES), OUT_SET = new Set([...Object.keys(OUT), 'not-called', '']), PHONE = /^[+0-9 ()-]{7,20}$/;
  function checkVac(v) {
    const bad = [], need = (ok, why) => { if (!ok) bad.push(why); };
    need(/^VAC-[A-Z0-9]+$/.test(v.id || ''), 'id'); need(typeof v.title === 'string' && v.title.length >= 3, 'title'); need(STAGE_SET.has(v.stage), 'stage');
    need(Number.isInteger(v.need) && v.need >= 1 && v.need <= 200, 'people needed'); need(v.starter && v.starter.id && v.starter.name, 'stated by'); need(Number(v.created) > 0, 'date');
    need(!(v.salMin && v.salMax) || v.salMin <= v.salMax, 'pay range');
    const at = STAGES.indexOf(v.stage);
    if (at >= 1) need(v.post && v.post.id, 'post'); if (at >= 2) need(v.call && Array.isArray(v.call.list), 'call list'); if (at >= 3) need(v.hr && Array.isArray(v.hr.keep), 'HR list'); if (at >= 4) need(v.int && v.int.cands, 'interviews');
    ((v.call && v.call.list) || []).forEach(x => { need(OUT_SET.has(x.outcome || ''), 'call result of ' + (x.name || x.app)); need(!x.phone || PHONE.test(x.phone), 'phone of ' + (x.name || x.app)); });
    Object.values((v.int && v.int.cands) || {}).forEach(c => {
      need(c.name && c.app, 'recipient'); need(!c.phone || PHONE.test(c.phone), 'phone of ' + c.name);
      Object.values(c.rows || {}).forEach(r => { if (r.scores) { need(r.scores.every(x => x >= 0 && x <= 5), 'marks of ' + c.name); need(r.s20 >= 0 && r.s20 <= 20, 'mark /20 of ' + c.name); } });
      if (c.status === 'done') need(c.final >= 0 && c.final <= 20, 'final mark of ' + c.name);
    });
    return bad;
  }
  function health(p) {
    const R = rights(p); if (!(R.admin || R.rm || R.start || R.hr || (p && p.role === 'it'))) throw err('The data check is for Admin, IT and the recruiters.', 403);
    const db = load(), issues = db.vacs.map(v => ({ id: v.id, title: v.title, bad: checkVac(v) })).filter(x => x.bad.length);
    return { checked: db.vacs.length, ok: db.vacs.length - issues.length, issues, t: Date.now() };
  }

  // ---------- Admin: grants ----------
  // the Grant power room: one row per person, one switch per step. Every change is written in Activity.
  const POWER_NAME = { start: 'State a vacancy', post: 'Post the vacancy', cc: 'Call Center step', hr: 'HR step', int: 'Interviewer', rm: 'Recruitment manager', db: 'Elitejobs database' };
  function grantsView(p) {
    needAdmin(p);
    const g = rj(GR, { users: {}, unlocked: {} });
    return { powers: POWERS.map(k => ({ k, name: POWER_NAME[k] })), staff: staffOf().filter(x => !isAdmin(x) && x.on !== false).map(x => {
      const R = rights(x), u = g.users[x.id] || {};
      return { id: x.id, name: x.name, role: x.role, dept: x.dept || '', ...Object.fromEntries(POWERS.map(k => [k, k === 'db' ? !!u.db : !!R[k]])), set: Object.fromEntries(POWERS.map(k => [k, u[k] !== undefined])) };
    }) };
  }
  function setGrant(p, b) {
    needAdmin(p);
    const key = b.key === 'view' ? 'view' : b.key; if (!POWERS.includes(key) && key !== 'view') throw err('Unknown power.');
    const x = staffOf().find(y => y.id === b.uid); if (!x) throw err('That person isn’t in the system.', 404);
    const g = rj(GR, { users: {}, unlocked: {} }); g.users[x.id] = { ...(g.users[x.id] || {}), [key]: !!b.on }; wj(GR, g);
    log(p, `${b.on ? 'gave' : 'took'} the power “${POWER_NAME[key] || 'vacancy viewer'}” ${b.on ? 'to' : 'from'} ${x.name}`); ping();
    broadcast({ type: 'urgent', kind: 'grants' });
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
    const all = staffOf().filter(x => x.on !== false && !isAdmin(x) && rights(x).int);
    const att = rj(F('attendance.json'), {}), day = att[localDay(Date.now())] || att[kDay()] || {};
    return all.map(x => ({ id: x.id, name: x.name, here: !!(day[x.id] && !day[x.id].out) }));   // every interviewer in the company has a row
  }
  // the Upcoming card opens when a person from its list checks in at reception for an interview today (or staff start it)
  function arrived(v) {
    const vis = (stateOf().visitors || []).filter(x => x.t && kDay(x.t) === kDay() && x.why === 'Interview');
    const names = new Set(vis.map(x => norm(x.name)));
    return ((v.hr && v.hr.keep) || []).filter(x => names.has(norm(x.name))).map(x => x.app);
  }
  const s20 = r => Math.round(r.scores.reduce((a, b) => a + b, 0) / (r.scores.length * 5) * 200) / 10;
  const finalOf = c => { const R = Object.values(c.rows).filter(r => r.scores); return R.length ? Math.round(R.reduce((a, r) => a + r.s20, 0) / R.length * 10) / 10 : 0; };
  // the form walks the interviewers in order: each one marks after the one before (or after they were noted as not here)
  const turnOf = c => (c.order || Object.keys(c.rows)).find(id => c.rows[id] && !c.rows[id].scores && !c.rows[id].absent) || null;
  const lastOf = c => [...(c.order || Object.keys(c.rows))].reverse().find(id => c.rows[id] && !c.rows[id].absent) || null;
  const pendingFor = (c, uid) => c.status === 'open' && (c.mode === 'hand' ? !!(c.rows[uid] && !c.rows[uid].scores && !c.rows[uid].absent) : turnOf(c) === uid);
  function upView(v, p) {
    const C = Object.values((v.int && v.int.cands) || {}), arr = arrived(v);
    return { ...v, open: true, arrived: arr, cands: C, mineWaiting: C.filter(c => pendingFor(c, p.id)).length, applicants: 0, me: {} };
  }
  function upcoming(p) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to vacancies.', 403);
    return { officers: officers(), vacs: load().vacs.filter(v => v.stage === 'upcoming' && (R.admin || R.rm || mineUp(v, p))).sort((a, b) => b.int.t - a.int.t).map(v => ({ ...upView(v, p), closesAt: at1730(v.int.t) })) };
  }
  const needInt = (p, R) => { if (!(R.int || R.admin)) throw err('Only the interview staff can do this.', 403); };
  function startInt(p, id) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    v.int.started = { ...who(p), t: Date.now() }; hist(v, p, 'started the interviews'); save(db); log(p, `started the interviews for “${v.title}”`); ping();
    return { ok: true };
  }
  // The interviewers choose how they work today, once per vacancy card (they can change it for the next recipients):
  //  · Sequence: the form passes from one interviewer to the next in the order they sit; the last one presses Finish.
  //  · Handover: each interviewer marks their own row whenever they are free; when every row is marked the Hub adds it up.
  // Only the interviewers chosen as here today get a row. Suspended or removed people never appear.
  function session(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    const mode = b.mode === 'hand' ? 'hand' : 'seq', O = officers(), known = new Set(O.map(o => o.id));
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))].filter(x => known.has(x));
    if (!ids.length) throw err('Choose who is interviewing today.');
    const n = Math.max(1, Math.min(O.length, parseInt(b.n, 10) || ids.length)); if (ids.length !== n) throw err(`You said ${n} interviewer${n === 1 ? '' : 's'}; choose exactly ${n}.`);
    v.int.session = { mode, ids, by: who(p), t: Date.now() };
    const names = ids.map(x => (O.find(o => o.id === x) || {}).name).join(mode === 'seq' ? ' → ' : ', ');
    hist(v, p, `set the interviews to ${mode === 'seq' ? 'Sequence' : 'Handover'} with ${ids.length}: ${names}`); save(db);
    log(p, `set the interviews for “${v.title}” to ${mode === 'seq' ? 'Sequence' : 'Handover'} (${names})`); ping();
    return { ok: true };
  }
  function addCand(p, id, app, walk) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    let k;
    if (walk) {
      const name = s(walk.name, 60), phone = s(walk.phone, 30); if (name.length < 3) throw err('Write the recipient’s full name.'); if (!/^[+0-9 ()-]{9,16}$/.test(phone)) throw err('Check the phone number, for example 0788 123 456.');
      const em = s(walk.email, 100); if (em && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em)) throw err('Check the email address, or leave it empty.');
      app = 'W-' + Date.now().toString(36).toUpperCase(); k = { app, name, phone, wa: walk.wa ? phone : '', email: em, lives: s(walk.lives, 80), gender: ['f', 'm'].includes(walk.gender) ? walk.gender : '', walkin: true };
    } else { k = v.hr.keep.find(x => x.app === app); if (!k) throw err('This person isn’t on the list for this vacancy.', 404); }
    v.int.cands = v.int.cands || {}; if (v.int.cands[app]) throw err(`${k.name} is already being interviewed.`, 409);
    if (Object.keys(v.int.cands).length >= Math.max(v.need || 1, v.hr.keep.length) + 20) throw err('This vacancy already has its recipients.', 409);
    v.int.started = v.int.started || { ...who(p), t: Date.now() };
    let O = officers(); if (!O.length) throw err('No interviewer is registered in the Hub.', 409);
    const S = v.int.session;
    if (S) { O = S.ids.map(x => O.find(o => o.id === x)).filter(Boolean); if (!O.length) throw err('The interviewers chosen for today aren’t in the Hub any more. Choose them again.', 409); }
    else if (O.some(o => o.id === p.id)) O = [O.find(o => o.id === p.id), ...O.filter(o => o.id !== p.id)]; else O = [{ id: p.id, name: p.name }, ...O];
    v.int.cands[app] = { app, name: k.name, phone: k.phone, wa: k.wa, email: k.email, lives: k.lives, gender: k.gender, position: v.title, vac: v.id,
      added: { ...who(p), t: Date.now() }, walkin: !!k.walkin, status: 'open', mode: S ? S.mode : 'seq', rows: Object.fromEntries(O.map(o => [o.id, { uid: o.id, name: o.name }])), order: O.map(o => o.id) };
    hist(v, p, `started the interview of ${k.name}`); save(db); log(p, `started the interview of ${k.name} (${v.title})`); ping();
    return { ok: true };
  }
  function score(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'open') throw err('This interview is closed.', 409);
    const row = c.rows[p.id]; if (!row) throw err('You aren’t one of the interviewers on this form.', 403);
    if (row.scores) throw err('You already marked this person.', 409);
    const turn = c.mode === 'hand' ? p.id : turnOf(c); if (turn !== p.id) throw err(`It’s ${c.rows[turn] ? c.rows[turn].name : 'another interviewer'}’s turn first. The form comes to you when they press Done yet.`, 409);
    const sc = (Array.isArray(b.scores) ? b.scores : []).map(Number);
    if (sc.length < 1 || sc.length > 20) throw err('Choose between 1 and 20 questions.');
    if (sc.some(x => !(x >= 0 && x <= 5) || Math.round(x * 2) !== x * 2)) throw err('Each question is marked from 0 to 5 (halves allowed).');
    const topic = s(b.topic, 120);
    Object.assign(row, { topic, scores: sc, absent: false, t: Date.now() }); row.s20 = s20(row);
    hist(v, p, `marked ${c.name}: ${row.s20}/20`);
    // Handover: when the last row is marked the Hub puts the marks together by itself
    if (c.mode === 'hand' && Object.values(c.rows).every(r => r.scores || r.absent)) {
      Object.assign(c, { status: 'done', final: finalOf(c), finished: { id: 'hub', name: 'All interviewers', t: Date.now() }, day: kDay() });
      hist(v, p, `${c.name} finished by every interviewer: ${c.final}/20`);
    }
    save(db); log(p, `marked ${c.name} for ${v.title}: ${row.s20}/20 (${sc.length} questions on ${topic})`); ping();
    return { ok: true, s20: row.s20, final: c.status === 'done' ? c.final : null };
  }
  function unscore(p, b) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'open') throw err('This interview is closed.', 409);
    const row = c.rows[p.id]; if (!row || !row.scores) throw err('You haven’t marked this person yet.', 409);
    if (Date.now() - row.t > 10500) throw err('Undo works only in the first 10 seconds.', 409);
    const after = c.mode !== 'hand' && c.order.slice(c.order.indexOf(p.id) + 1).some(id => c.rows[id] && (c.rows[id].scores || c.rows[id].absent));
    if (after) throw err('The next interviewer has already marked.', 409);
    const was = row.s20; delete row.scores; delete row.s20; delete row.topic; delete row.t;
    hist(v, p, `took back their marks for ${c.name}`); save(db); log(p, `undid their marks for ${c.name} (${was}/20)`); ping();
    return { ok: true };
  }
  // Save keeps the vacancy, with all its recipients, in every interviewer's Upcoming. Push sends it to Interview results now.
  function saveUp(p, id) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    if (!Object.keys(v.int.cands || {}).length) throw err('Add at least one recipient first.', 409);
    v.int.saved = { ...who(p), t: Date.now() }; hist(v, p, 'saved it for every interviewer'); save(db); log(p, `saved “${v.title}” in every interviewer’s Upcoming`); ping();
    return { ok: true };
  }
  function pushUp(p, id) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'upcoming') throw err('This vacancy isn’t in Upcoming.', 409);
    if (!Object.keys(v.int.cands || {}).length) throw err('Add at least one recipient first.', 409);
    closeVac(v, p, `finished the vacancy card — it went to Interview remarks`); save(db); log(p, `finished “${v.title}”: it went to Interview remarks`); ping();
    return { ok: true };
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
    if (!R.admin && lastOf(c) !== p.id) throw err(`Finish belongs to the last interviewer, ${c.rows[lastOf(c)] ? c.rows[lastOf(c)].name : ''}.`, 403);
    Object.assign(c, { status: 'done', final: finalOf(c), finished: { ...who(p), t: Date.now() }, day: kDay() });
    hist(v, p, `finished ${c.name}: ${c.final}/20`); save(db); log(p, `finished the interview of ${c.name} for ${v.title}: ${c.final}/20`); ping();
    return { ok: true, final: c.final };
  }
  function rewind(p, id) {
    const R = rights(p); needInt(p, R);
    const db = load(), v = find(db, id); if (v.stage !== 'remarks') throw err('Only a vacancy in Interview remarks can be rewound.', 409);
    v.stage = 'upcoming'; v.int.t = Date.now(); delete v.remarks; delete v.closed; v.int.mine = v.int.mine || {}; v.int.mine[p.id] = v.int.mine[p.id] || { name: p.name, t: Date.now() };
    hist(v, p, 'rewound it to Upcoming to add more recipients'); save(db); log(p, `rewound “${v.title}” to Upcoming (late recipients)`); ping();
    return { ok: true };
  }
  // the recruiter approves the remarks: the vacancy goes to Interview results for the decisions
  function rmApprove(p, id) {
    const R = rights(p); if (!(R.rm || R.admin)) throw err('This step belongs to the recruiter.', 403);
    const db = load(), v = find(db, id); if (v.stage !== 'remarks') throw err('This vacancy isn’t waiting in Interview remarks.', 409);
    v.stage = 'done'; v.rm = { ...who(p), t: Date.now() }; v.closed = { ...(v.closed || {}), t: Date.now(), day: kDay(), by: p.name };
    const day = (Object.values(v.int.cands || {}).find(c => c.status === 'done') || {}).day || kDay();
    hist(v, p, 'approved the interview remarks — decisions are open in Interview results'); save(db); log(p, `approved the interview remarks of “${v.title}”`); ping();
    return { ok: true, day };
  }
  function remarks(p) {
    const R = rights(p); if (!(R.int || R.rm || R.admin)) throw err('Interview remarks are for the interviewers and the recruiter.', 403);
    return { vacs: load().vacs.filter(v => v.stage === 'remarks').sort((a, b) => b.remarks.t - a.remarks.t).map(v => ({ id: v.id, title: v.title, employer: v.employer || '', remarks: v.remarks, session: v.int.session || null,
      expected: ((v.hr && v.hr.keep) || []).length, cands: Object.values(v.int.cands || {}).sort((a, b) => (b.final || 0) - (a.final || 0)), canRewind: !!(R.int || R.admin), canApprove: !!(R.rm || R.admin) })) };
  }
  // every finished interview, one list — for Interview results, the call list and the Waiting list
  const finished = () => load().vacs.flatMap(v => Object.values((v.int && v.int.cands) || {}).filter(c => c.status === 'done').map(c => ({ ...c, vacTitle: v.title, employer: v.employer, vacStage: v.stage })));
  const band = m => m >= 18 ? 'excellent' : m >= 15 ? 'good' : 'failed';
  function results(p, q) {
    const R = rights(p); if (!R.view) throw err('Admin hasn’t given you access to interview results.', 403);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : kDay(), t = norm(q.q), min = Number(q.min) || 0;
    const all = finished(), days = [...new Set(all.map(c => c.day))].sort().reverse().slice(0, 60).map(d => ({ d, n: all.filter(c => c.day === d).length }));
    const L = all.filter(c => c.vacStage === 'done' && (t ? true : c.day === day) && (!t || norm(c.vacTitle + ' ' + c.name + ' ' + c.phone).includes(t)) && c.final >= min).sort((a, b) => b.final - a.final).map(c => ({ ...c, band: band(c.final) }));
    return { day, days, list: L, bands: { failed: 'Under 15 — failed', good: '15 to 17.9 — good', excellent: '18 and above — excellent' }, canPush: R.rm || R.admin, canSl: !!(R.rm || R.hr || R.admin) };
  }
  // The recruiter decides: Qualified or Not qualified, and what happened when they called the person.
  // Qualified people coming on site wait in the recruiter's Draft until the employer has met them: then Served or Not served.
  const CONTACT = { coming: 'Coming on site', 'no-answer': 'Didn’t pick up', 'not-available': 'Not available', 'not-interested': 'Not engaged' };
  function push(p, b) {
    const R = rights(p); if (!(R.rm || R.admin)) throw err('Only the recruiter decides.', 403);
    const db = load(), v = find(db, String(b.id || '')), c = v.int && v.int.cands && v.int.cands[b.app];
    if (!c || c.status !== 'done') throw err('This interview isn’t finished.', 409);
    if (c.served && c.served.v !== undefined) throw err(`${c.name} is already marked ${c.served.v ? 'served' : 'not served'}.`, 409);
    if (c.push && c.push.by.id !== p.id && !R.admin) throw err(`${c.push.by.name} already decided for ${c.name}.`, 409);
    const contact = b.qualified ? (CONTACT[b.contact] ? b.contact : '') : '';
    if (b.qualified && !contact) throw err('Say what happened when you called them: coming on site, didn’t pick up, not available or not engaged.');
    c.push = { by: who(p), t: Date.now(), qualified: !!b.qualified, contact };
    hist(v, p, `${b.qualified ? 'qualified' : 'did not qualify'} ${c.name} (${c.final}/20)${contact ? ' — ' + CONTACT[contact] : ''}`); save(db);
    log(p, `${b.qualified ? 'qualified' : 'did not qualify'} ${c.name} (${v.title}, ${c.final}/20)${contact ? ': ' + CONTACT[contact] : ''}`); ping();
    return { ok: true };
  }
  function draft(p) {
    const R = rights(p); if (!(R.rm || R.admin)) throw err('The Draft belongs to the recruiter.', 403);
    const all = finished().filter(c => c.push && c.push.qualified);
    return { waiting: all.filter(c => c.push.contact === 'coming' && !(c.served && c.served.v !== undefined)).sort((a, b) => a.push.t - b.push.t),
      recall: all.filter(c => c.push.contact !== 'coming' && !(c.served && c.served.v !== undefined)).sort((a, b) => a.push.t - b.push.t),
      done: all.filter(c => c.served && c.served.v !== undefined).sort((a, b) => b.served.t - a.served.t).slice(0, 60), contact: CONTACT };
  }
  function callList(p) {
    const R = rights(p); if (!(R.cc || R.admin || R.rm)) return { list: [] };
    return { list: finished().filter(c => c.push && c.push.qualified && !c.called && !c.served).sort((a, b) => a.push.t - b.push.t) };
  }
  function called(p, b) {
    const R = rights(p); if (!(R.cc || R.admin)) throw err('This step belongs to the Call Center.', 403);
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
    if (!c || !(c.called || (c.push && c.push.qualified))) throw err('Only qualified people can be served.', 409);
    c.served = { v: !!b.v, by: who(p), t: Date.now(), day: kDay() }; hist(v, p, `${c.name}: ${b.v ? 'served' : 'not served'}`); save(db);
    log(p, `ticked ${c.name} (${v.title}) as ${b.v ? 'served' : 'not served'}`); ping();
    return { ok: true };
  }

  // ================= Stage 3 · daily tasks, interview reports, dashboard, filing by date, database rooms =================
  // At midnight (Kigali) a vacancy whose interviews are over is filed under the day they ended. Nothing is deleted.
  // 17:30 Kigali: every vacancy card still in Upcoming goes to Interview results with its recipients, finished or not.
  const K = 72e5, D = 864e5;
  const at1730 = t => { const day0 = Math.floor((t + K) / D) * D - K, c = day0 + (17 * 60 + 30) * 6e4; return t < c ? c : c + D; };
  function closeVac(v, by, why) {
    Object.values((v.int && v.int.cands) || {}).forEach(c => { if (c.status === 'open') { const n = Object.values(c.rows).filter(r => r.scores).length;
      Object.assign(c, { status: 'done', unfinished: true, final: n ? finalOf(c) : 0, marked: n, finished: { id: by.id || 'hub', name: by.name, t: Date.now() }, day: kDay() }); } });
    v.stage = 'remarks'; v.remarks = { t: Date.now(), day: kDay(), why, by: by.name }; v.closed = { t: Date.now(), day: kDay(), why, by: by.name };
    v.hist = (v.hist || []).concat({ t: Date.now(), by: by.name, text: why });
  }
  function fileAway(db) {
    let ch = false;
    (db.vacs || []).forEach(v => { if (v.stage === 'upcoming' && v.int && Date.now() >= at1730(v.int.t)) { closeVac(v, { name: 'Hub' }, 'moved to Interview remarks at 17:30'); ch = true; } });
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
    const R = rights(p); if (!(R.int || R.admin)) throw err('Interview reports are written by the interviewers.', 403);
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
  function canRead(p, R, r) { return R.admin || r.by.id === p.id || (r.to.includes('hr') && R.hr) || (r.to.includes('rm') && R.rm); }
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
      calledBack: fin.filter(c => c.called && c.called.day === today).length, served: fin.filter(c => c.served && kDay(c.served.t) === today).length,
      filed: V.filter(v => v.stage === 'done').length };
    // numbers that count themselves, over the last 90 days: how far people get, how long it takes, placements each month
    const since = Date.now() - 90 * 864e5, R90 = V.filter(v => v.created >= since);
    const nApplied = R90.reduce((a, v) => a + (v.call ? v.call.list.length : applicantsOf(v).length), 0), nComing = R90.reduce((a, v) => a + (v.hr ? v.hr.keep.length : 0), 0);
    const C90 = R90.flatMap(v => Object.values((v.int && v.int.cands) || {}).map(c => ({ c, v }))), nInt = C90.filter(x => x.c.status === 'done').length, nQ = C90.filter(x => x.c.push && x.c.push.qualified).length;
    const days = C90.filter(x => x.c.served && x.v.post).map(x => (x.c.served.t - x.v.post.t) / 864e5), month = {};
    fin.filter(c => c.served).forEach(c => { const m = kDay(c.served.t).slice(0, 7); month[m] = (month[m] || 0) + 1; });
    const pct = (a, b) => b ? Math.round(a / b * 100) : null;
    const numbers = { applied: nApplied, coming: nComing, interviewed: nInt, qualified: nQ, toComing: pct(nComing, nApplied), toInterview: pct(nInt, nComing), toQualified: pct(nQ, nInt),
      daysToServe: days.length ? r1(days.reduce((a, b) => a + b, 0) / days.length) : null, perMonth: Object.entries(month).sort().slice(-6).map(([m, n]) => ({ m, n })) };
    const rows = live.sort((a, b) => b.created - a.created).map(v => {
      const apps = applicantsOf(v), C = Object.values((v.int && v.int.cands) || {}), done = C.filter(c => c.status === 'done');
      const step = STAGES.indexOf(v.stage), pct = Math.round(((step + (v.stage === 'upcoming' && v.hr.keep.length ? done.length / v.hr.keep.length : 0)) / 5) * 100);
      return { id: v.id, title: v.title, employer: v.employer || '', stage: v.stage, pct: Math.min(100, pct), created: v.created, starter: v.starter.name,
        poster: v.post && (v.post.by || v.post.claimed || {}).name || '', caller: v.call ? v.call.by.name : '', hr: v.hr ? v.hr.by.name : '',
        applied: v.call ? v.call.list.length : apps.length, toCall: v.stage === 'call' ? apps.filter(x => x.status !== 'done').length : 0,
        coming: v.hr ? v.hr.keep.length : v.call ? v.call.list.filter(x => x.outcome === 'coming').length : 0,
        interviewed: done.length, inRoom: C.length - done.length, best: done.length ? Math.max(...done.map(c => c.final)) : null };
    });
    return { day: today, numbers, tiles, rows, people: Object.values(acts).map(o => ({ name: o.name, n: o.n, vacs: [...o.vacs] })).sort((a, b) => b.n - a.n) };
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
      // applications for opening jobs sent on the website (the 4-chapter form) are applicants too
      const IQ = { open: 'waiting', sms: 'sms', called: 'called' };
      items = items.concat(rj(F('inquiries.json'), []).map(x => ({ day: kDay(x.created || x.got), t: x.created || x.got, k: norm([x.name, x.phone, x.email, x.title, x.live && x.live.d, x.live && x.live.s].join(' ')),
        v: { id: x.id, name: x.name || '', phone: x.phone || '', wa: x.wa || '', email: x.email || '', lives: [x.live && x.live.s, x.live && x.live.d].filter(Boolean).join(', '), gender: x.gender || '', job: (x.title || 'Application') + ' (website)',
          outcome: x.outcome || IQ[x.status] || x.status || '', vac: '', calledBy: x.by || '', note: x.note || '' } })));
    }
    if (room === 'ints') items = finished().map(c => ({ day: c.day, t: c.finished.t, k: norm(c.name + ' ' + c.vacTitle + ' ' + c.phone), v: { name: c.name, phone: c.phone, email: c.email, position: c.vacTitle, employer: c.employer, final: c.final, rows: Object.values(c.rows).map(r => ({ name: r.name, s20: r.s20 == null ? null : r.s20, topic: r.topic || '', q: r.scores ? r.scores.length : 0, absent: !!r.absent })), push: c.push ? { q: c.push.qualified, by: c.push.by.name } : null, called: c.called ? c.called.by.name : '', served: c.served ? c.served.v : null } }));
    if (room === 'reports') {
      const staff = (() => { try { return fs.readFileSync(F('reports.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } })();
      items = readIR().map(r => ({ day: r.day, t: r.t, k: norm('interview ' + r.by.name + ' ' + (r.summary || '') + ' ' + JSON.stringify(r.stats || {}).replace(/[{}\[\]"]/g, ' ')), v: { kind: 'interview', id: r.id, by: r.by.name, to: r.to.map(x => TO[x]), summary: r.summary, tot: r.stats.tot, tpl: r.tpl } }))
        .concat(staff.map(r => ({ day: kDay(r.t), t: r.t, k: norm(r.name + ' ' + r.dept + ' ' + r.period + ' ' + (r.text || '')), v: { kind: 'staff', id: r.id, by: r.name, dept: r.dept, label: r.label, period: r.period, text: r.text, ai: r.ai } })));
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

  // employer shortlist: a private link on the website with first names and marks only; the employer taps Interview or Not this one
  async function makeShortlist(p, b) {
    const R = rights(p); if (!(R.rm || R.hr || R.admin)) throw err('Shortlists are sent by the recruitment manager or HR.', 403);
    const db = load(), v = find(db, String(b.id || '')), C = Object.values((v.int && v.int.cands) || {}).filter(c => (b.apps || []).includes(c.app) && c.status === 'done');
    if (!C.length) throw err('Choose at least one person with a finished interview.');
    const short = n => { const w = String(n || '').trim().split(/\s+/); return w[0] + (w[1] ? ' ' + w[1][0] + '.' : ''); };
    const PB = rj(path.join(DATA_DIR, 'people.json'), { by: {} }).by || {}, CK = { id: 'National ID seen', refs: 'References called', licence: 'Driving licence checked', diploma: 'Diploma checked', health: 'Health certificate seen' };
    const ph9 = x => { const d = String(x || '').replace(/\D/g, '').slice(-9); return d.length === 9 ? d : ''; };
    const people = C.map(c => { const P = PB['p' + ph9(c.phone)] || {}, ck = P.consent ? Object.keys(P.checks || {}).map(k => '✓ ' + (CK[k] || k)) : [];
      return { ref: c.app, name: short(c.name), mark: c.final, points: ck.concat(Object.values(c.rows).map(r => r.topic).filter(Boolean)).slice(0, 5) }; });
    const r = await urgent.remote('/api/hub/shortlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v.title, employer: v.employer || '', days: 7, people }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw err(j.error || 'The website didn’t answer. Check the website connection.', 502);
    v.shortlists = (v.shortlists || []).concat({ id: j.id, url: j.url, t: Date.now(), by: who(p), n: people.length }); hist(v, p, `sent a shortlist of ${people.length} to the employer`); save(db);
    log(p, `sent a private shortlist of ${people.length} for “${v.title}” to the employer`); ping();
    return { url: j.url, id: j.id };
  }
  async function shortlistAnswers(p, id) {
    const R = rights(p); if (!(R.rm || R.hr || R.admin)) throw err('Shortlists are for the recruitment manager or HR.', 403);
    const v = find(load(), id), out = [];
    for (const s of v.shortlists || []) { try { const r = await urgent.remote('/api/hub/shortlist/' + encodeURIComponent(s.id)); const j = await r.json(); out.push({ ...s, until: j.until, people: j.people || [] }); } catch (e) { out.push({ ...s, err: 'Not reachable now' }); } }
    return { list: out };
  }
  return { health, ocOpen, ocList, ocClaim, ocResult, hrOpen, session, rewind, rmApprove, remarks, draft, editVac, report, makeShortlist, shortlistAnswers, hrFilter, unscore, saveUp, pushUp, remove, powers, upcoming, startInt, addCand, score, absent, finish, results, push, callList, called, waiting, served, rights, mine, dailyTasks, dailyText, intPreview, intSend, intReports, irGet, dashboard, dbRoom, dbExport, list, create, claimPost, posted, callApprove, complete, intApprove, grantsView, setGrant, keysView, forge, revoke, unlock, dbList, kDay };
};
