// Website members — everyone with an account on elitejobsrwanda.com, in one chapter of the Hub.
// • The Hub reads the accounts from the website every few minutes (no files; a CV is fetched only when someone opens it, and that is logged).
// • Each member page gathers what that person did: their urgent applications and open-job applications (tagged with their account,
//   or sent with their phone number), how far each one went, their profile, the work they want, and the open vacancies that fit them.
// • Applications still arrive in the usual rooms exactly as before; this chapter only shows them together.
// • The database in three parts: members · people who applied without an account · the sleeping pool (office logs and customer
//   records that are not counted as candidates yet). The sleeping pool stays locked until the office decides how to wake it.
const fs = require('fs'), path = require('path');

module.exports = function ({ DATA_DIR, urgent, rightsOf, appendActivity, broadcast, readState }) {
  const F = n => path.join(DATA_DIR, n), MF = F('members.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const nine = ph => { const d = String(ph || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
  const norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const realAdmin = p => !!(p && p.role === 'admin' && !String(p.name).includes('@'));
  const may = p => { if (!p) return false; if (realAdmin(p) || ['hr', 'front', 'rec'].includes(p.role)) return true; const R = rightsOf(p) || {}; return !!(R.db || R.rm || R.admin); };
  const need = p => { if (!may(p)) throw err('Website members are for Admin, HR, Front Desk, Reception and the recruitment team.', 403); };

  // ---------- reading the accounts from the website ----------
  let syncing = false, last = { t: 0, ok: false, err: '' };
  async function sync() {
    if (syncing || fs.existsSync(F('moved.json'))) return; syncing = true;
    try {
      const r = await urgent.remote('/api/hub/members'); const j = await r.json();
      const old = rj(MF, { list: [] }), had = new Set((old.list || []).map(m => m.id));
      wj(MF, { t: Date.now(), list: j.members || [] });
      const fresh = (j.members || []).filter(m => !had.has(m.id));
      if (old.t && fresh.length) { appendActivity({ t: Date.now(), by: 'Website', uid: '', role: 'web', text: `${fresh.length} new website member${fresh.length > 1 ? 's' : ''}: ${fresh.slice(0, 3).map(m => m.name).join(', ')}${fresh.length > 3 ? '…' : ''}` }); broadcast({ type: 'members' }); }
      last = { t: Date.now(), ok: true, err: '' };
    } catch (e) { last = { t: Date.now(), ok: false, err: e.message }; } finally { syncing = false; }
  }
  setInterval(sync, 3 * 60000).unref(); setTimeout(sync, 12000);

  // ---------- what each person did ----------
  const STEPS = ['Received', 'Called', 'Interview', 'Result', 'Placed'];
  function stepOf(a, cand) {
    if (cand) {
      if (cand.served) return cand.served.v ? { s: 4, say: 'Placed' } : { s: 4, say: 'Not placed', end: 1 };
      if (cand.push) return cand.push.qualified ? { s: 3, say: 'Qualified' } : { s: 3, say: 'Not selected', end: 1 };
      return { s: 2, say: cand.status === 'done' ? 'Interviewed' : 'Interview' };
    }
    if (a.kind === 'web') {
      if (a.status === 'called') return a.outcome === 'no-answer' ? { s: 1, say: 'No answer yet' } : ['coming', 'tomorrow', 'later'].includes(a.outcome) ? { s: 1, say: 'Invited' } : { s: 1, say: 'Closed', end: 1 };
      if (a.status === 'sms') return { s: 1, say: 'SMS sent' };
      return { s: 0, say: 'Received' };
    }
    if (a.status === 'done') return a.outcome === 'coming' ? { s: 1, say: 'Invited' } : a.outcome === 'no-answer' ? { s: 1, say: 'No answer yet' } : { s: 1, say: 'Closed', end: 1 };
    return { s: 0, say: 'Received' };
  }
  function everything() {
    const cands = {}; const vacs = rj(F('vflow.json'), { vacs: [] }).vacs || [];
    for (const v of vacs) for (const c of Object.values((v.int && v.int.cands) || {})) if (c.app) cands[c.app] = c;
    const out = [];
    for (const a of rj(F('urgent-apps.json'), [])) { const d = a.data || {}; out.push({ kind: 'urgent', id: a.id, mid: d.mid || '', k: nine(d.phone), title: d.position || a.title || 'Urgent job', t: a.created || a.got || 0, ...stepOf(a, cands[a.id]) }); }
    for (const x of rj(F('inquiries.json'), [])) out.push({ kind: 'web', id: x.id, mid: x.mid || '', k: nine(x.phone), title: x.title || 'Application', t: x.created || x.got || 0, ...stepOf({ ...x, kind: 'web' }) });
    return { all: out, vacs };
  }
  // open vacancies that fit what the member said they want (fields, jobs, the work they want, their CV job title)
  const STOP = new Set('and or of the a an for in at to with de et la le du des senior junior assistant head chief lead trainee intern officer staff worker job jobs work'.split(' '));
  const toks = t => new Set(norm(t).split(' ').filter(w => w.length > 2 && !STOP.has(w)).map(w => { w = w.replace(/ress$/, 'er').replace(/s$/, ''); return w.length > 5 ? w.replace(/(woman|man|maid)$/, '') : w; }));   // waitress = waiter, barmaid = barman
  function fits(m, vacs, posts) {
    const P = m.profile || {}, C = P.cvd || {}, want = toks([P.roles, P.fields, P.want, C.title, (C.experience || []).map(x => x.role).join(' ')].join(' '));
    if (!want.size) return [];
    const score = title => { const T = toks(title); let n = 0; for (const w of T) if (want.has(w)) n++; return T.size ? n / T.size : 0; };
    const res = [];
    for (const v of vacs) if (v.stage !== 'done') { const s = score(v.title); if (s > 0) res.push({ kind: 'vacancy', title: v.title, where: v.employer || '', s }); }
    for (const p of posts) { const s = score(p.title + ' ' + (p.positions || []).join(' ')); if (s > 0) res.push({ kind: 'urgent', title: p.title, where: p.place || (p.meta && p.meta.loc) || '', s }); }
    return res.sort((a, b) => b.s - a.s).slice(0, 6);
  }
  let postsCache = { t: 0, list: [] };
  async function livePosts() { if (Date.now() - postsCache.t < 120000) return postsCache.list; try { const r = await urgent.remote('/api/urgent'); postsCache = { t: Date.now(), list: (await r.json()).posts || [] }; } catch (e) {} return postsCache.list; }
  const filled = m => { const P = m.profile || {}; const parts = [!!m.phone, !!P.fields, !!P.roles, !!P.district, !!P.shift, !!P.start, !!P.exp, !!P.edu, !!P.langs, !!P.email, !!m.cv || !!P.cvd]; return Math.round(parts.filter(Boolean).length / parts.length * 100); };

  async function view(p, q) {
    need(p); if (Date.now() - last.t > 60000) await sync();
    const M = rj(MF, { list: [] }).list || [], { all, vacs } = everything(), posts = await livePosts();
    const phones = new Set(M.map(m => nine(m.phone)).filter(Boolean));
    const mine = m => all.filter(a => (m.id && a.mid === m.id) || (m.phone && a.k && a.k === nine(m.phone))).sort((a, b) => b.t - a.t);
    const t = norm(q.q || ''), wk = Date.now() - 7 * 864e5;
    let list = M; if (t) list = M.filter(m => norm([m.name, m.phone, (m.profile || {}).email, (m.profile || {}).district, (m.profile || {}).roles].join(' ')).includes(t) || (t.replace(/\D/g, '').length >= 3 && nine(m.phone).includes(t.replace(/\D/g, '').replace(/^(250|0)/, ''))));
    const cards = list.slice(0, 60).map(m => { const apps = mine(m); return { id: m.id, name: m.name, phone: m.phone, since: m.since, proven: m.proven, google: m.google, cv: m.cv, cvMade: !!(m.profile || {}).cvd,
      profile: (({ email, district, fields, roles, shift, start, exp, edu, langs, skills, about, want }) => ({ email, district, fields, roles, shift, start, exp, edu, langs, skills, about, want }))(m.profile || {}),
      done: filled(m), apps: apps.slice(0, 12).map(a => ({ kind: a.kind, title: a.title, t: a.t, s: a.s, say: a.say, end: !!a.end })), napps: apps.length, fits: fits(m, vacs, posts) }; });
    // the three parts of the database
    const st = readState ? readState() : {}, cvs = rj(F('cvs.json'), []);
    const appPhones = new Set(all.map(a => a.k).filter(Boolean));
    const parts = {
      members: { n: M.length, proven: M.filter(m => m.proven).length, google: M.filter(m => m.google).length, week: M.filter(m => m.since > wk).length, withCv: M.filter(m => m.cv || (m.profile || {}).cvd).length, applied: M.filter(m => mine(m).length).length },
      guests: { n: [...appPhones].filter(k => !phones.has(k)).length, apps: all.filter(a => !a.mid && !phones.has(a.k)).length },
      sleeping: { walkins: (st.visitors || []).length, calls: (st.calls || []).length, cvs: Array.isArray(cvs) ? cvs.length : Object.keys(cvs || {}).length, locked: true }
    };
    return { list: cards, total: M.length, parts, sync: last, q: t };
  }
  // a member's own CV file (uploaded on the website); opening it is logged
  async function cv(p, id) {
    need(p); const M = (rj(MF, { list: [] }).list || []).find(m => m.id === id); if (!M) throw err('This member is no longer on the website.', 404);
    const r = await urgent.remote('/api/hub/member-cv/' + encodeURIComponent(id)); const buf = Buffer.from(await r.arrayBuffer());
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `opened the website CV of ${M.name}` });
    return { name: decodeURIComponent(r.headers.get('x-name') || 'CV'), mime: r.headers.get('content-type') || 'application/pdf', b64: buf.toString('base64') };
  }
  return { view, cv, sync, may };
};
