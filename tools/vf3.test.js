// Vacancy life cycle v3: Vacancy on call (callers lock people), HR, Sequence/Handover sessions, Interview remarks
// with Rewind, the recruiter's decisions with a Draft, Achieved, the vacancy report, and editing a posted vacancy.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'vf3-'));
const staff = [{ id: 'A', name: 'Admin', role: 'admin' }, { id: 'H', name: 'Hana HR', role: 'hr' }, { id: 'C1', name: 'Cleo Caller', role: 'cc' }, { id: 'C2', name: 'Carl Caller', role: 'cc' },
  { id: 'I1', name: 'Ines', role: 'int' }, { id: 'I2', name: 'Ivan', role: 'int' }, { id: 'I3', name: 'Iris', role: 'int' }, { id: 'X', name: 'Xavi Gone', role: 'int', on: false },
  { id: 'P', name: 'Krizzo', role: 'sm' }, { id: 'R', name: 'Rita Recruiter', role: 'rcm' }];
let apps = []; const edits = [], removed = [], acts = [];
const urgent = { rights: p => ({ post: p.id === 'P', review: ['C1', 'C2'].includes(p.id) }), allApps: () => apps,
  outcome: async (p, b) => { const a = apps.find(x => x.id === b.id); Object.assign(a, { status: 'done', outcome: b.outcome, note: b.note, reviewer: p.name }); },
  editPost: async (p, b) => { edits.push(b); return { ok: true }; },
  remote: async u => { removed.push(u); return { ok: true, json: async () => ({}) }; } };
const vf = require(path.join(__dirname, '..', 'server', 'vflow.js'))({ DATA_DIR: D, urgent, staffOf: () => staff, stateOf: () => ({}), appendActivity: a => acts.push(a.text), broadcast: () => {}, note: () => {} });
const S = id => staff.find(x => x.id === id), T = (id, vid) => vf.mine(S(id)).tasks.find(v => v.id === vid);
const throws = async (f, re) => { try { await f(); assert.fail('should refuse'); } catch (e) { assert.match(e.message, re); } };
const set = (id, k) => vf.setGrant(S('A'), { uid: id, key: k, on: true });
(async () => {
  set('P', 'start'); set('P', 'post'); set('R', 'rm');
  // 1 · state + 2 · post with a limit of 4
  const v = vf.create(S('P'), { title: 'Receptionist', need: 2, loc: 'Kigali', salMin: 150000, salMax: 200000 }).vac;
  vf.claimPost(S('P'), v.id); vf.posted(S('P'), v.id, 'UJ-1', 'Receptionist', 4, Date.now() + 864e5);
  apps = ['Mina', 'Bosco', 'Clare'].map((n, i) => ({ id: 'a' + i, post: 'UJ-1', status: 'new', data: { name: n, phone: '078800000' + i } }));
  // the poster edits the posted vacancy: the website changes too
  assert.equal(T('P', v.id).canEdit, true);
  await throws(() => vf.editVac(S('P'), { id: v.id, cap: 2 }), /can’t go under 3/);
  await throws(() => vf.editVac(S('H'), { id: v.id, cap: 6 }), /belongs to the posters/);
  await vf.editVac(S('P'), { id: v.id, cap: 3, salMax: 220000 });
  assert.equal(edits[0].cap, 3); assert.equal(edits[0].meta.salMax, 220000); assert.equal(edits[0].id, 'UJ-1');
  // the limit is reached (3 of 3): callers' Approve opens Vacancy on call
  assert.equal(T('C1', v.id).me.ready, true);
  await throws(() => vf.ocClaim(S('C1'), v.id, 'a0', true), /isn’t on call/);
  vf.ocOpen(S('C1'), v.id); assert.equal(T('P', v.id).canEdit, false, 'no editing once calling started');
  // Cleo takes Mina: Carl sees Mina being called and can't take her or save a result for her
  vf.ocClaim(S('C1'), v.id, 'a0', true);
  let L = vf.ocList(S('C2')).list[0]; assert.equal(L.left.find(x => x.app === 'a0').calling.name, 'Cleo Caller'); assert.deepEqual(L.busy, ['Cleo Caller']);
  await throws(() => vf.ocClaim(S('C2'), v.id, 'a0', true), /Cleo Caller is calling Mina/);
  await throws(() => vf.ocResult(S('C2'), { id: v.id, app: 'a0', outcome: 'coming' }), /Cleo Caller is calling/);
  // Finish is refused while somebody is on a call
  vf.ocClaim(S('C2'), v.id, 'a1', true);
  await throws(() => vf.callApprove(S('C2'), v.id), /Cleo Caller is still on a call/);
  await throws(() => vf.ocResult(S('C1'), { id: v.id, app: 'a0', outcome: 'maybe' }), /what happened/);
  await vf.ocResult(S('C1'), { id: v.id, app: 'a0', outcome: 'coming' });
  await vf.ocResult(S('C2'), { id: v.id, app: 'a1', outcome: 'member' });
  L = vf.ocList(S('C1')).list[0]; assert.equal(L.left.length, 1); assert.equal(L.done.find(x => x.app === 'a0').calledBy, 'Cleo Caller'); assert.equal(L.done.find(x => x.app === 'a1').outcome, 'member');
  await throws(() => vf.ocClaim(S('C2'), v.id, 'a0', true), /already called by Cleo Caller/);
  // Clare not called yet: Finish is allowed (nobody is mid-call) — she is kept as "not called"
  await vf.callApprove(S('C2'), v.id);
  assert.ok(removed.some(u => u.includes('UJ-1/remove')));
  assert.equal(vf.ocList(S('C1')).list.length, 0, 'gone from every caller');
  // 4 · HR: Approve, Fetch (coming on site), Push
  assert.equal(T('H', v.id).me.ready, true); vf.hrOpen(S('H'), v.id);
  assert.equal(vf.hrFilter(S('H'), v.id).kept, 1); vf.complete(S('H'), v.id);
  // 5 · interviewers approve; a Sequence session with the 2 who are here (Iris is away, Xavi was removed)
  vf.intApprove(S('I1'), v.id); vf.intApprove(S('I2'), v.id);
  await throws(() => vf.session(S('I1'), { id: v.id, mode: 'seq', n: 3, ids: ['I2', 'I1'] }), /choose exactly 3/);
  vf.session(S('I1'), { id: v.id, mode: 'seq', n: 2, ids: ['I2', 'I1', 'X'] });
  vf.addCand(S('I1'), v.id, 'a0');
  let c = vf.upcoming(S('I1')).vacs[0].cands[0]; assert.deepEqual(c.order, ['I2', 'I1'], 'the order chosen, only the ones here'); assert.equal(c.mode, 'seq');
  await throws(() => vf.score(S('I1'), { id: v.id, app: 'a0', scores: [5] }), /Ivan’s turn first/);
  vf.score(S('I2'), { id: v.id, app: 'a0', scores: [5, 5, 4, 4, 5, 5, 4, 4] }); vf.score(S('I1'), { id: v.id, app: 'a0', scores: [5, 4, 5, 4] });
  await throws(() => vf.finish(S('I2'), { id: v.id, app: 'a0' }), /last interviewer, Ines/);
  assert.equal(vf.finish(S('I1'), { id: v.id, app: 'a0' }).final, 18);
  // Handover for the next one: each marks in any order, the Hub adds it up when the last row is in
  vf.session(S('I2'), { id: v.id, mode: 'hand', n: 2, ids: ['I1', 'I2'] });
  vf.addCand(S('I2'), v.id, '', { name: 'Late Walker', phone: '0788 222 333' });
  const w = vf.upcoming(S('I1')).vacs[0].cands.find(x => x.walkin).app;
  vf.score(S('I1'), { id: v.id, app: w, scores: [3, 3, 4] });
  assert.equal(vf.score(S('I2'), { id: v.id, app: w, scores: [3, 4] }).final, 13.7);
  // the vacancy card's Finish → Interview remarks; Rewind brings it back for a latecomer
  vf.pushUp(S('I1'), v.id);
  assert.equal(vf.remarks(S('R')).vacs[0].cands.length, 2); assert.equal(T('R', v.id).me.act, 'decide');
  assert.equal(vf.results(S('R'), {}).list.length, 0, 'results wait for the recruiter');
  vf.rewind(S('I2'), v.id); assert.equal(vf.upcoming(S('I2')).vacs[0].id, v.id); vf.pushUp(S('I2'), v.id);
  // 6 · the recruiter approves → Interview results with bands
  const ok = vf.rmApprove(S('R'), v.id); assert.ok(ok.day);
  const res = vf.results(S('R'), {}).list; assert.equal(res.find(x => x.name === 'Mina').band, 'excellent'); assert.equal(res.find(x => x.name === 'Late Walker').band, 'failed');
  assert.equal(T('P', v.id), undefined);
  await throws(() => vf.push(S('R'), { id: v.id, app: 'a0', qualified: true }), /what happened when you called/);
  vf.push(S('R'), { id: v.id, app: 'a0', qualified: true, contact: 'coming' }); vf.push(S('R'), { id: v.id, app: w, qualified: false });
  assert.equal(vf.list(S('A'), 'all').vacs.find(x => x.id === v.id).achieved, null, 'not achieved before served');
  assert.equal(vf.draft(S('R')).waiting[0].name, 'Mina');
  vf.served(S('R'), { id: v.id, app: 'a0', v: true });
  const got = vf.list(S('A'), 'all').vacs.find(x => x.id === v.id); assert.ok(got.achieved); assert.equal(got.achieved.served, 1);
  assert.equal(vf.list(S('A'), 'active').vacs.length, 0, 'done vacancies leave Vacancies');
  // the vacancy report: numbers, steps and the Hub's daily report
  const rp = vf.report(S('P'), {}).vacs[0]; assert.equal(rp.pct, 100); assert.equal(rp.m.applied, 3); assert.equal(rp.m.called, 2); assert.equal(rp.m.interviewed, 2); assert.equal(rp.m.served, 1);
  assert.ok(rp.daily[0].items.length > 10); assert.equal(rp.steps[0].by, 'Krizzo');
  await throws(() => vf.report(S('C1'), {}), /vacancy report is for/);
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
