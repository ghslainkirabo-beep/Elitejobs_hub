// CV payments — the room where the office sees every CV plan bought on elitejobsrwanda.com.
// • The only way to pay is on the website, signed in, approved with the payer's own PIN on their phone (Paypack or MTN MoMo).
//   So every payment here was confirmed by mobile money itself: nobody confirms anything by hand.
// • The Hub reads the payments from the website every minute. A new paid plan goes to Activity and to everyone who has the room open.
// • Who can open the room: the real Admin, and anyone Admin gives access to. Every grant and removal is logged.
const fs = require('fs'), path = require('path');

module.exports = function ({ DATA_DIR, urgent, loadState, appendActivity, broadcast }) {
  const F = n => path.join(DATA_DIR, n), GF = F('cvpays-access.json'), SF = F('cvpays-seen.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const realAdmin = p => !!(p && p.role === 'admin' && !String(p.name).includes('@'));
  const staff = () => ((loadState() || {}).staff || []);
  const may = p => !!p && p.on !== false && (realAdmin(p) || !!rj(GF, {})[p.id]);
  const need = p => { if (!p) throw err('Sign in on this device first.', 401); if (!may(p)) throw err('Admin hasn’t given you the CV payments room.', 403); };
  const PN = { silver: 'Silver', platinum: 'Platinum', diamond: 'Diamond' };

  let cache = { t: 0, d: null, err: '' }, busy = null;
  function sync() {
    if (busy) return busy;
    busy = (async () => {
      try {
        if (fs.existsSync(F('moved.json'))) return;
        const r = await urgent.remote('/api/hub/cvpays'), j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The website didn’t answer.');
        const seen = new Set(rj(SF, [])), fresh = (j.pays || []).filter(x => x.status === 'paid' && !seen.has(x.id));
        if (seen.size || cache.d) for (const x of fresh.slice(0, 20)) appendActivity({ t: Date.now(), by: 'Website', uid: '', role: 'web', text: `CV plan paid: ${x.name || 'a member'} · ${PN[x.plan] || x.plan} · ${Number(x.rwf).toLocaleString('en-US')} RWF` });
        if (fresh.length) { wj(SF, [...seen, ...fresh.map(x => x.id)].slice(-5000)); broadcast({ type: 'cvpays' }); }
        cache = { t: Date.now(), d: j, err: '' };
      } catch (e) { cache = { ...cache, t: Date.now(), err: e.message }; }
      finally { busy = null; }
    })();
    return busy;
  }
  setInterval(sync, 60000).unref(); setTimeout(sync, 15000);

  async function view(p) {
    need(p); if (Date.now() - cache.t > 20000 || !cache.d) await sync();
    const d = cache.d || { pays: [], people: {}, provider: null };
    return { pays: d.pays || [], people: d.people || {}, provider: d.provider || null, t: cache.t, err: cache.err, admin: realAdmin(p) };
  }
  async function check(p, id) {
    need(p); if (!/^CP-[A-Z0-9]{6,20}$/.test(String(id))) throw err('Unknown payment.');
    const r = await urgent.remote(`/api/hub/cvpays/${encodeURIComponent(id)}/check`, { method: 'POST' }), j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.error || 'The website didn’t answer.', 502);
    await sync(); return { status: j.status };
  }
  function grants(p) {
    if (!realAdmin(p)) throw err('Only Admin can do this.', 403);
    const g = rj(GF, {});
    return { staff: staff().filter(s => !(s.role === 'admin' && !String(s.name).includes('@'))).map(s => ({ id: s.id, name: s.name, role: s.role, dept: s.dept })), grants: g };
  }
  function setGrant(p, b) {
    if (!realAdmin(p)) throw err('Only Admin can do this.', 403);
    const who = staff().find(s => s.id === String(b.uid || '')); if (!who) throw err('Choose a person.');
    const g = rj(GF, {});
    if (b.on) g[who.id] = { by: p.name, t: Date.now() }; else delete g[who.id];
    wj(GF, g);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `${b.on ? 'gave' : 'removed'} the CV payments room ${b.on ? 'to' : 'from'} ${who.name} (${who.dept || who.role})` });
    broadcast({ type: 'cvpays', kind: 'grants' });
    return { ok: true };
  }
  return { may, view, check, grants, setGrant, sync };
};
