// Smart match — for a vacancy (or any position typed in), the best people Elitejobs already knows: everyone who applied
// before (urgent and website applications) and everyone interviewed, ranked by how well their past applications and work
// fit the position, their interview marks, how recently they were active, and whether they're free (not just placed).
// It never invents anything: every reason shown comes from what the person sent or what the interview staff wrote.
const fs = require('fs'), path = require('path');

module.exports = function ({ DATA_DIR, rightsOf }) {
  const F = n => path.join(DATA_DIR, n);
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const nine = ph => { const d = String(ph || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
  const { toks, overlap, norm } = require('./words.js');
  function people() {
    const by = {}, P = (k, name, phone) => by[k] || (by[k] = { k, name, phone, apps: [], ints: [], placed: [], last: 0, lives: '', edu: '', gender: '', langs: '', docs: { cv: false, dip: false } });
    for (const a of rj(F('urgent-apps.json'), [])) { const d = a.data || {}, k = nine(d.phone); if (!k) continue; const p = P(k, d.name, d.phone);
      p.apps.push({ title: d.position || a.title || '', exp: [d.experience, d.lastJob].filter(Boolean).join(' · '), t: a.created || 0, post: a.post, src: 'Urgent' }); p.last = Math.max(p.last, a.created || 0);
      p.lives = p.lives || d.lives || ''; p.edu = p.edu || d.education || ''; p.gender = p.gender || d.gender || ''; p.langs = p.langs || d.languages || '';
      (d.files || []).forEach(f => { if (f === 'cv') p.docs.cv = true; if (f === 'dip') p.docs.dip = true; }); }
    for (const x of rj(F('inquiries.json'), [])) { const k = nine(x.phone); if (!k) continue; const p = P(k, x.name, x.phone);
      p.apps.push({ title: x.title || '', exp: (x.exp || []).map(e => e.role + (e.at ? ' at ' + e.at : '')).join(' · '), t: x.created || 0, src: 'Website' }); p.last = Math.max(p.last, x.created || 0);
      p.lives = p.lives || (x.live && [x.live.s, x.live.d].filter(Boolean).join(', ')) || ''; p.edu = p.edu || x.edu || ''; p.gender = p.gender || x.gender || ''; }
    for (const v of rj(F('vflow.json'), { vacs: [] }).vacs || []) for (const c of Object.values((v.int && v.int.cands) || {})) {
      const k = nine(c.phone); if (!k) continue; const p = P(k, c.name, c.phone);
      if (c.status === 'done' && c.final != null) p.ints.push({ title: v.title, mark: c.final, t: (c.finished && c.finished.t) || v.created || 0, qualified: c.push ? !!c.push.qualified : null });
      if (c.served) p.placed.push({ title: v.title, employer: v.employer || '', t: c.served.t });
    }
    return by;
  }

  // one requirement checked against what the person actually sent us: Met / To verify / Contradicted / Not met, with the evidence
  const MUST = /\b(must|required|mandatory|obligatoire|need(s|ed)?|ni ngombwa)\b/i;
  function reqsOf(v, title) {
    const out = [{ id: 'pos', label: `Has done or applied for ${title}`, must: true, kind: 'pos' }];
    if (v) {
      String(v.reqs || '').split(/\r?\n|;|•/).map(x => x.trim()).filter(x => x.length > 2).slice(0, 8).forEach((x, n) => out.push({ id: 'r' + n, label: x, must: MUST.test(x), kind: 'text' }));
      if (v.rules && v.rules.gender && v.rules.gender !== 'any') out.push({ id: 'g', label: v.rules.gender === 'f' ? 'A woman (employer’s rule)' : 'A man (employer’s rule)', must: true, kind: 'gender', want: v.rules.gender });
      if (v.rules && v.rules.cv) out.push({ id: 'cv', label: 'Sent a CV', must: false, kind: 'cv' });
      if (v.rules && v.rules.dip) out.push({ id: 'dip', label: 'Sent a diploma or certificate', must: false, kind: 'dip' });
      if (v.loc) out.push({ id: 'loc', label: `Lives near ${v.loc}`, must: false, kind: 'loc', where: v.loc });
    }
    out.push({ id: 'free', label: 'Free to start (not placed in the last 60 days)', must: true, kind: 'free' });
    return out;
  }
  function check(r, x, want, now) {
    const all = [x.apps.map(a => a.title + ' ' + a.exp).join(' '), x.edu, x.langs, x.lives].join(' ');
    if (r.kind === 'pos') { const a = x.apps.find(a => overlap(want, toks(a.title)) > 0) || x.ints.find(i => overlap(want, toks(i.title)) > 0);
      return a ? { st: 'met', ev: a.mark != null ? `Interviewed for ${a.title}: ${Math.round(a.mark * 10) / 10}/20` : `Applied for ${a.title}` } : { st: 'verify', ev: 'Related experience only — ask on the call' }; }
    if (r.kind === 'text') { const need = toks(r.label), m = overlap(need, toks(all)); if (!need.size) return { st: 'verify', ev: '' };
      if (m >= 0.5) { const a = x.apps.find(a => overlap(need, toks(a.title + ' ' + a.exp)) >= 0.5); return { st: 'met', ev: a ? (a.exp || a.title).slice(0, 90) : 'Matches what they wrote' }; }
      return { st: x.apps.length ? 'verify' : 'unmet', ev: x.apps.length ? 'Not in what they sent us — ask on the call' : 'Nothing on record' }; }
    if (r.kind === 'gender') return !x.gender ? { st: 'verify', ev: 'Gender not on record' } : x.gender === r.want ? { st: 'met', ev: 'From their application' } : { st: 'contra', ev: 'Their application says otherwise' };
    if (r.kind === 'cv') return x.docs.cv ? { st: 'met', ev: 'A CV is on file' } : { st: 'verify', ev: 'No CV on file yet' };
    if (r.kind === 'dip') return x.docs.dip ? { st: 'met', ev: 'A certificate is on file' } : { st: 'verify', ev: 'No certificate on file yet' };
    if (r.kind === 'loc') { if (!x.lives) return { st: 'verify', ev: 'Where they live isn’t on record' }; const o = overlap(toks(r.where), toks(x.lives)); return o > 0 ? { st: 'met', ev: `Lives in ${x.lives}` } : { st: 'verify', ev: `Lives in ${x.lives}` }; }
    if (r.kind === 'free') { const lp = x.placed.sort((a, b) => b.t - a.t)[0]; return lp && now - lp.t < 60 * 864e5 ? { st: 'contra', ev: `Placed ${Math.round((now - lp.t) / 864e5)} days ago as ${lp.title}` } : { st: 'met', ev: 'No recent placement on record' }; }
    return { st: 'verify', ev: '' };
  }
  function suggest(p, q) {
    const R = rightsOf(p) || {}; if (!(R.view || R.admin || R.rm)) throw err('Admin hasn’t given you access to vacancies.', 403);
    const vacs = rj(F('vflow.json'), { vacs: [] }).vacs || [], v = q.vac ? vacs.find(x => x.id === q.vac) : null;
    const title = v ? v.title : String(q.title || '').slice(0, 80).trim();
    const open = vacs.filter(x => x.stage !== 'done').sort((a, b) => b.created - a.created).slice(0, 30).map(x => ({ id: x.id, title: x.title, employer: x.employer || '' }));
    if (title.length < 2) return { title: '', vac: null, total: 0, list: [], vacs: open, reqs: [] };
    const want = toks(title), now = Date.now(), REQ = reqsOf(v, title);
    const already = new Set(); if (v && v.post && v.post.id) rj(F('urgent-apps.json'), []).filter(a => a.post === v.post.id).forEach(a => already.add(nine((a.data || {}).phone)));
    const out = [], near = [];
    for (const x of Object.values(people())) {
      if (already.has(x.k)) continue;
      const parts = []; let s = 0; const add = (label, pts) => { pts = Math.round(pts); if (pts) { parts.push({ label, pts }); s += pts; } };
      const tm = Math.max(0, ...x.apps.map(a => overlap(want, toks(a.title)))); if (tm > 0) add('Applied for this position', 50 * tm);
      const em = Math.max(0, ...x.apps.map(a => overlap(want, toks(a.exp)))); if (em > 0) add('Experience in this work', 25 * em);
      const im = x.ints.filter(i => overlap(want, toks(i.title)) > 0).sort((a, b) => b.mark - a.mark)[0] || x.ints.sort((a, b) => b.mark - a.mark)[0];
      if (im) add(`Interview mark (${Math.round(im.mark * 10) / 10}/20)`, (im.mark / 20) * (overlap(want, toks(im.title)) > 0 ? 30 : 12));
      if (s < 10) continue;
      const days = (now - x.last) / 864e5; add('Active recently', days < 30 ? 8 : days < 120 ? 4 : 0);
      const checks = REQ.map(r => ({ id: r.id, label: r.label, must: r.must, ...check(r, x, want, now) }));
      checks.filter(c => c.st === 'met' && c.id !== 'pos' && c.id !== 'free').forEach(c => add(`Meets: ${c.label.slice(0, 40)}`, c.must ? 6 : 3));
      const bad = checks.filter(c => c.must && (c.st === 'contra' || c.st === 'unmet'));
      bad.forEach(c => add(`Fails a must-have: ${c.label.slice(0, 40)}`, -25));
      const row = { k: x.k, name: x.name, phone: x.phone, lives: x.lives, edu: x.edu, score: Math.max(1, Math.min(99, s)), parts, checks, fails: bad.map(c => c.id), busy: bad.some(c => c.id === 'free'), last: x.last, apps: x.apps.length,
        why: checks.filter(c => c.st === 'met').map(c => c.ev).filter(Boolean).slice(0, 3) };
      (bad.length ? near : out).push(row);
    }
    out.sort((a, b) => b.score - a.score); near.sort((a, b) => b.score - a.score);
    // nobody meets every must-have: say which one, if relaxed, lets the most people through
    let relax = null;
    if (!out.length && near.length) { const cnt = {}; near.forEach(x => { if (x.fails.length === 1) cnt[x.fails[0]] = (cnt[x.fails[0]] || 0) + 1; });
      const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; if (best) relax = { id: best[0], label: (REQ.find(r => r.id === best[0]) || {}).label, n: best[1] }; }
    return { title, vac: v ? { id: v.id, title: v.title, employer: v.employer || '', need: v.need } : null, total: out.length, list: out.slice(0, 60), near: near.slice(0, 20), nearTotal: near.length, relax, reqs: REQ.map(r => ({ id: r.id, label: r.label, must: r.must })), vacs: open };
  }
  return { suggest };
};
