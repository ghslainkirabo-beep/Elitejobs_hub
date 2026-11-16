// Job seeker subscriptions — the application limit.
// • A job seeker is known by their phone number (the last 9 digits), across urgent applications and website applications.
// • While Admin has the limit switched on, everyone gets a number of free applications (5 unless Admin changes it),
//   counted from the day the limit was switched on. After that, they need a plan.
// • A plan (Admin makes them: name, applications — 0 means unlimited — days, price) is started by staff at the desk
//   after the person pays. The price is never shown on the website.
// • Every minute the Hub tells the website how many applications each person has left (by a one-way code of the phone,
//   never the number itself). The website refuses one more application when someone has none left, and says why.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ DATA_DIR, urgent, appendActivity, broadcast, smsLast }) {
  const F = n => path.join(DATA_DIR, n), SB = F('subscriptions.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const kDay = t => new Date((t || Date.now()) + 72e5).toISOString().slice(0, 10);
  const who = p => ({ id: p.id, name: p.name, role: p.role });
  const log = (p, text) => appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text });
  const nine = ph => { const d = String(ph || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
  const hashOf = k => crypto.createHash('sha256').update('ejq:' + k).digest('hex').slice(0, 24); // the website computes the same

  const realAdmin = p => !!(p && p.role === 'admin' && !String(p.name).includes('@'));
  const desk = p => !!p && (realAdmin(p) || ['front', 'rec'].includes(p.role));
  const needDesk = p => { if (!desk(p)) throw err('Subscriptions are for Admin, Front Desk and Reception.', 403); };
  const needAdmin = p => { if (!realAdmin(p)) throw err('Only Admin can change this.', 403); };

  const load = () => Object.assign({ on: false, onSince: 0, free: 5, plans: [], people: {} }, rj(SB, {}));
  const save = d => wj(SB, d);

  // every application the Hub holds, by person
  function apps() {
    const out = [];
    for (const a of rj(F('urgent-apps.json'), [])) { const d = a.data || {}, k = nine(d.phone); if (k) out.push({ k, id: a.id, name: d.name || '', phone: d.phone, title: d.position || a.title || 'Urgent job', t: a.created || a.got || 0, src: 'Urgent' }); }
    for (const x of rj(F('inquiries.json'), [])) { const k = nine(x.phone); if (k) out.push({ k, id: x.id, name: x.name || '', phone: x.phone, title: x.title || 'Application', t: x.created || x.got || 0, src: 'Website' }); }
    return out;
  }
  const activeSub = (P, now) => (P && P.subs || []).filter(x => x.start <= now && now < x.end).sort((a, b) => b.start - a.start)[0] || null;
  function standing(D, k, mine, now = Date.now()) {
    const P = D.people[k], sub = activeSub(P, now);
    if (sub) { const used = mine.filter(a => a.t >= sub.start).length; return { sub, used, left: sub.apps ? Math.max(0, sub.apps - used) : null, unlimited: !sub.apps }; }
    const used = D.on ? mine.filter(a => a.t >= D.onSince).length : 0;
    return { sub: null, used, left: D.on ? Math.max(0, D.free - used) : null, free: true };
  }

  // ---------- website: tell it who has how many left ----------
  let pushing = false, lastPush = { t: 0, ok: false, err: '' };
  async function push() {
    if (pushing || fs.existsSync(F('moved.json'))) return; pushing = true;
    try {
      const D = load(), all = apps(), by = {}, people = {}, plans = {}, now = Date.now();
      for (const a of all) (by[a.k] = by[a.k] || []).push(a);
      for (const k of new Set(Object.keys(by).concat(Object.keys(D.people)))) {
        const st = standing(D, k, by[k] || [], now);
        if (st.unlimited) people[hashOf(k)] = 100000; else if (st.left != null) people[hashOf(k)] = st.left;
        if (st.sub) plans[hashOf(k)] = { n: st.sub.name, e: st.sub.end, a: st.sub.apps };
      }
      const seen = all.filter(a => now - a.t < 30 * 6e4).map(a => a.id);
      await urgent.remote('/api/hub/quota', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: D.on, free: D.free, people, plans, seen }) });
      lastPush = { t: now, ok: true, err: '' };
    } catch (e) { lastPush = { t: Date.now(), ok: false, err: e.message }; } finally { pushing = false; }
  }
  setInterval(push, 60000).unref(); setTimeout(push, 20000);

  // ---------- what the screens call ----------
  const planOut = (p, x) => ({ id: x.id, name: x.name, apps: x.apps, days: x.days, price: x.price, off: !!x.off });
  function view(p, q) {
    needDesk(p); const D = load(), all = apps(), by = {}, now = Date.now();
    for (const a of all) (by[a.k] = by[a.k] || []).push(a);
    const t = String(q.q || '').trim().toLowerCase(), digits = nine(t) || t.replace(/\D/g, '').replace(/^(250|0)/, '');
    let keys = Object.keys(by).concat(Object.keys(D.people).filter(k => !by[k]));
    if (t) keys = keys.filter(k => (digits.length >= 3 && k.includes(digits.slice(-9))) || (by[k] || []).some(a => a.name.toLowerCase().includes(t)) || ((D.people[k] || {}).name || '').toLowerCase().includes(t));
    const card = k => {
      const mine = (by[k] || []).sort((a, b) => b.t - a.t), st = standing(D, k, mine, now), P = D.people[k] || {};
      return { k, name: (mine[0] && mine[0].name) || P.name || '—', phone: (mine[0] && mine[0].phone) || P.phone || ('0' + k), total: mine.length, used: st.used, left: st.left, unlimited: !!st.unlimited,
        sub: st.sub ? { name: st.sub.name, end: st.sub.end, apps: st.sub.apps } : null, apps: mine.slice(0, 12).map(a => ({ title: a.title, t: a.t, src: a.src })),
        history: (P.subs || []).slice().sort((a, b) => b.start - a.start).map(x => ({ id: x.id, name: x.name, start: x.start, end: x.end, apps: x.apps, by: x.by.name, method: x.method, price: x.price })) };
    };
    const cards = keys.map(card);
    const tiles = { people: Object.keys(by).length, atLimit: D.on ? cards.filter(c => c.left === 0).length : 0, active: Object.keys(D.people).filter(k => activeSub(D.people[k], now)).length,
      month: Object.values(D.people).flatMap(P => P.subs || []).filter(x => kDay(x.start).slice(0, 7) === kDay().slice(0, 7)).length };
    const list = t ? cards.sort((a, b) => b.total - a.total).slice(0, 40)
      : cards.filter(c => c.sub || c.left === 0).sort((a, b) => (a.left === 0 ? 0 : 1) - (b.left === 0 ? 0 : 1) || b.total - a.total).slice(0, 40);
    return { on: D.on, onSince: D.onSince, free: D.free, plans: D.plans.map(x => planOut(p, x)), list, tiles, admin: realAdmin(p), push: lastPush, sms: smsLast ? smsLast() : null, q: t };
  }
  function settings(p, b) {
    needAdmin(p); const D = load();
    if (b.on !== undefined) { const on = !!b.on; if (on && !D.on) D.onSince = Date.now(); D.on = on; log(p, on ? `switched ON the application limit (${D.free} free per person)` : 'switched OFF the application limit'); }
    if (b.free !== undefined) { const f = parseInt(b.free, 10); if (!(f >= 0 && f <= 100)) throw err('Free applications must be between 0 and 100.'); if (f !== D.free) log(p, `set free applications to ${f}`); D.free = f; }
    save(D); broadcast({ type: 'subs' }); push(); return { ok: true };
  }
  function plan(p, b) {
    needAdmin(p); const D = load(), name = s(b.name, 40); if (name.length < 2) throw err('Give the plan a name, like “Monthly”.');
    const apps = parseInt(b.apps, 10), days = parseInt(b.days, 10), price = Math.round(Number(String(b.price || '').replace(/[\s,]/g, '')));
    if (!(apps >= 0 && apps <= 1000)) throw err('Applications: a number, or 0 for unlimited.'); if (!(days >= 1 && days <= 730)) throw err('Days: between 1 and 730.'); if (!(price >= 0 && price < 1e8)) throw err('Write the price in RWF.');
    const id = String(b.id || ''), x = id && D.plans.find(y => y.id === id);
    if (x) Object.assign(x, { name, apps, days, price, off: !!b.off }); else D.plans.push({ id: 'PL-' + Date.now().toString(36).toUpperCase(), name, apps, days, price });
    save(D); log(p, `${x ? 'changed' : 'made'} the subscription plan “${name}”`); broadcast({ type: 'subs' }); return { ok: true };
  }
  function start(p, b) {
    needDesk(p); const D = load(), k = nine(b.phone); if (!k) throw err('Write the person’s phone number.');
    const pl = D.plans.find(x => x.id === b.plan && !x.off); if (!pl) throw err('Choose a plan.');
    const method = ['cash', 'momo', 'bank'].includes(b.method) ? b.method : 'momo';
    const P = D.people[k] || (D.people[k] = { name: s(b.name, 60), phone: s(b.phone, 20), subs: [] });
    if (!P.name && b.name) P.name = s(b.name, 60);
    const cur = activeSub(P, Date.now()), from = cur ? cur.end : Date.now();     // a new plan starts when the current one ends
    const x = { id: 'SB-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(), plan: pl.id, name: pl.name, apps: pl.apps, start: from, end: from + pl.days * 864e5, price: pl.price, method, by: who(p), t: Date.now() };
    P.subs.push(x); save(D); log(p, `started the “${pl.name}” plan for ${P.name || '0' + k}`); broadcast({ type: 'subs' }); push();
    return { ok: true, sub: x };
  }
  function stop(p, b) {
    needAdmin(p); const D = load(), P = D.people[nine(b.phone)], x = P && P.subs.find(y => y.id === b.id); if (!x) throw err('This plan no longer exists.', 404);
    x.end = Math.min(x.end, Date.now()); if (x.start > x.end) x.start = x.end; save(D); log(p, `ended the “${x.name}” plan of ${P.name || 'a job seeker'}`); broadcast({ type: 'subs' }); push(); return { ok: true };
  }
  // money from plans, for the private ledger
  function monthMoney(month) { const D = load(); return Object.values(D.people).flatMap(P => P.subs || []).filter(x => kDay(x.t).slice(0, 7) === month).reduce((a, x) => a + (x.price || 0), 0); }

  return { view, settings, plan, start, stop, push, monthMoney, desk };
};
