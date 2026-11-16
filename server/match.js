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
  const norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  const STOP = new Set('and or of the a an for in at to with de et la le du des senior junior assistant head chief lead trainee intern officer staff worker'.split(' '));
  // the same job, written different ways (English, French, Kinyarwanda, short forms)
  const SYN = [['waiter', 'waitress', 'server', 'serveur', 'serveuse', 'umuseriveri'], ['cleaner', 'cleaning', 'housekeeper', 'housekeeping', 'menage', 'nettoyage', 'umukozi wo mu rugo'],
    ['guard', 'security', 'securite', 'gardien', 'umuzamu'], ['driver', 'chauffeur', 'umushoferi', 'motorist'], ['cook', 'chef', 'kitchen', 'cuisinier', 'umutetsi'], ['receptionist', 'reception', 'front desk', 'receptionniste'],
    ['accountant', 'accounting', 'comptable', 'finance', 'bookkeeper'], ['cashier', 'caissier', 'caissiere', 'till'], ['barista', 'bartender', 'barman', 'bar'], ['nurse', 'infirmier', 'infirmiere', 'caregiver', 'care'],
    ['nanny', 'babysitter', 'childcare', 'umurezi'], ['sales', 'seller', 'vendeur', 'vendeuse', 'marketing', 'commercial'], ['teacher', 'enseignant', 'tutor', 'mwarimu'], ['mason', 'builder', 'construction', 'macon', 'umufundi'],
    ['electrician', 'electricien'], ['plumber', 'plombier'], ['it', 'computer', 'technician', 'developer', 'informatique'], ['secretary', 'secretaire', 'admin', 'administrative', 'office'], ['storekeeper', 'store', 'warehouse', 'magasinier', 'stock'],
    ['gardener', 'jardinier', 'garden'], ['tailor', 'couturier', 'umudozi'], ['hairdresser', 'salon', 'coiffeur', 'coiffeuse', 'beauty'], ['mechanic', 'mecanicien', 'garage'], ['delivery', 'rider', 'motard', 'courier']];
  const GROUP = {}; SYN.forEach((g, i) => g.forEach(w => { GROUP[w] = 'g' + i; }));
  const toks = t => { const n = norm(t), out = new Set(); for (const [w, g] of Object.entries(GROUP)) if (w.includes(' ') && n.includes(w)) out.add(g);
    n.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).forEach(w => out.add(GROUP[w] || GROUP[w.replace(/s$/, '')] || w.replace(/s$/, ''))); return out; };
  const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return a.size ? n / a.size : 0; };

  function people() {
    const by = {}, P = (k, name, phone) => by[k] || (by[k] = { k, name, phone, apps: [], ints: [], placed: [], last: 0, lives: '', edu: '', gender: '' });
    for (const a of rj(F('urgent-apps.json'), [])) { const d = a.data || {}, k = nine(d.phone); if (!k) continue; const p = P(k, d.name, d.phone);
      p.apps.push({ title: d.position || a.title || '', exp: [d.experience, d.lastJob].filter(Boolean).join(' · '), t: a.created || 0, post: a.post, src: 'Urgent' }); p.last = Math.max(p.last, a.created || 0);
      p.lives = p.lives || d.lives || ''; p.edu = p.edu || d.education || ''; p.gender = p.gender || d.gender || ''; }
    for (const x of rj(F('inquiries.json'), [])) { const k = nine(x.phone); if (!k) continue; const p = P(k, x.name, x.phone);
      p.apps.push({ title: x.title || '', exp: (x.exp || []).map(e => e.role + (e.at ? ' at ' + e.at : '')).join(' · '), t: x.created || 0, src: 'Website' }); p.last = Math.max(p.last, x.created || 0);
      p.lives = p.lives || (x.live && [x.live.s, x.live.d].filter(Boolean).join(', ')) || ''; p.edu = p.edu || x.edu || ''; p.gender = p.gender || x.gender || ''; }
    for (const v of rj(F('vflow.json'), { vacs: [] }).vacs || []) for (const c of Object.values((v.int && v.int.cands) || {})) {
      const k = nine(c.phone); if (!k) continue; const p = P(k, c.name, c.phone);
      if (c.status === 'done' && c.final != null) p.ints.push({ title: v.title, mark: c.final, t: (c.finished && c.finished.t) || v.created || 0, qualified: c.push ? !!c.push.qualified : null });
      if (c.served && c.served.v) p.placed.push({ title: v.title, employer: v.employer || '', t: c.served.t });
    }
    return by;
  }

  function suggest(p, q) {
    const R = rightsOf(p) || {}; if (!(R.view || R.admin || R.rm)) throw err('Admin hasn’t given you access to vacancies.', 403);
    const vacs = rj(F('vflow.json'), { vacs: [] }).vacs || [], v = q.vac ? vacs.find(x => x.id === q.vac) : null;
    const title = v ? v.title : String(q.title || '').slice(0, 80).trim();
    const open = vacs.filter(x => x.stage !== 'done').sort((a, b) => b.created - a.created).slice(0, 30).map(x => ({ id: x.id, title: x.title, employer: x.employer || '' }));
    if (title.length < 2) return { title: '', vac: null, total: 0, list: [], vacs: open };
    const want = toks(title), gender = v && v.rules && v.rules.gender !== 'any' ? v.rules.gender : '', now = Date.now();
    const already = new Set(); if (v && v.post && v.post.id) rj(F('urgent-apps.json'), []).filter(a => a.post === v.post.id).forEach(a => already.add(nine((a.data || {}).phone)));
    const out = [];
    for (const x of Object.values(people())) {
      if (already.has(x.k) || (gender && x.gender && x.gender !== gender)) continue;
      const why = []; let s = 0;
      const tm = Math.max(0, ...x.apps.map(a => overlap(want, toks(a.title)))); if (tm > 0) { s += 50 * tm; const a = x.apps.find(a => overlap(want, toks(a.title)) === tm); why.push(`Applied for ${a.title}`); }
      const em = Math.max(0, ...x.apps.map(a => overlap(want, toks(a.exp)))); if (em > 0) { s += 25 * em; const a = x.apps.find(a => overlap(want, toks(a.exp)) === em); why.push(`Experience: ${a.exp.slice(0, 80)}`); }
      const im = x.ints.filter(i => overlap(want, toks(i.title)) > 0).sort((a, b) => b.mark - a.mark)[0] || x.ints.sort((a, b) => b.mark - a.mark)[0];
      if (im) { s += (im.mark / 20) * (overlap(want, toks(im.title)) > 0 ? 30 : 12); why.push(`Interview for ${im.title}: ${Math.round(im.mark * 10) / 10}/20${im.qualified ? ', qualified' : ''}`); }
      if (s < 10) continue;
      const days = (now - x.last) / 864e5; s += days < 30 ? 8 : days < 120 ? 4 : 0;
      const lastPlaced = x.placed.sort((a, b) => b.t - a.t)[0], busy = lastPlaced && now - lastPlaced.t < 60 * 864e5;
      if (busy) { s -= 25; why.push(`Placed ${Math.round((now - lastPlaced.t) / 864e5)} days ago as ${lastPlaced.title}${lastPlaced.employer ? ' at ' + lastPlaced.employer : ''}`); }
      out.push({ k: x.k, name: x.name, phone: x.phone, lives: x.lives, edu: x.edu, score: Math.max(1, Math.min(99, Math.round(s))), why, busy: !!busy, last: x.last, apps: x.apps.length });
    }
    out.sort((a, b) => b.score - a.score);
    return { title, vac: v ? { id: v.id, title: v.title, employer: v.employer || '', need: v.need } : null, total: out.length, list: out.slice(0, 40),
      vacs: open };
  }
  return { suggest };
};
