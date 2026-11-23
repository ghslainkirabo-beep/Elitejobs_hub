// Employers (client CRM) + the private ledger.
// Employers: every company that asks Elitejobs for staff gets one record — contacts, notes, the next follow-up,
// and (worked out from the Vacancy flow, never typed twice) every vacancy stated for them and every person served.
// Who: Admin, the recruitment manager and HR.
// The private ledger: what each employer was charged for the service done on site, and whether it's paid.
// Only the real Admin ever sees it. It lives in its own file, it never reaches the website, the AI, other staff's
// screens or the activity log (the log only says the ledger was changed — never an amount or an employer).
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ DATA_DIR, subsMoney, rightsOf, appendActivity, broadcast }) {
  const F = n => path.join(DATA_DIR, n);
  const CL = F('clients.json'), LG = F('ledger.json'), VF = F('vflow.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const who = p => ({ id: p.id, name: p.name, role: p.role });
  const log = (p, text) => appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text });
  const kDay = t => new Date((t || Date.now()) + 72e5).toISOString().slice(0, 10);
  const nid = k => k + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const ping = () => broadcast({ type: 'crm' });

  // ---------- who may do what ----------
  const realAdmin = p => !!(p && p.role === 'admin' && !String(p.name).includes('@'));
  function may(p) {
    if (!p) return { crm: false, money: false };
    let R = {}; try { R = rightsOf(p) || {}; } catch (e) {}
    return { crm: realAdmin(p) || !!R.rm || p.role === 'hr', money: realAdmin(p) };
  }
  const needCrm = p => { if (!may(p).crm) throw err('Employers belong to Admin, the recruitment manager and HR.', 403); };
  const needMoney = p => { if (!may(p).money) throw err('Only Admin can open the private ledger.', 403); };

  // ---------- matching vacancies to employers ("Kigali Marriott Hotel Ltd" = "kigali marriott hotel") ----------
  const STOP = /\b(ltd|limited|plc|sarl|sa|co|company|inc|group|the|rwanda|rw|kigali branch)\b/g;
  const norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim();
  const keysOf = c => [c.name].concat(c.aka || []).map(norm).filter(Boolean);

  const load = () => rj(CL, { list: [] });
  const save = db => wj(CL, db);
  const find = (db, id) => { const c = db.list.find(x => x.id === id); if (!c) throw err('This employer no longer exists.', 404); return c; };

  // everything the Vacancy flow knows, grouped by employer key
  function facts() {
    const vacs = rj(VF, { vacs: [] }).vacs || [], by = {};
    for (const v of vacs) {
      const k = norm(v.employer); if (!k) continue;
      const b = by[k] || (by[k] = { vacs: [], placed: [] });
      const served = Object.values((v.int && v.int.cands) || {}).filter(c => c.served && c.served.v);
      b.vacs.push({ id: v.id, title: v.title, need: v.need, stage: v.stage, created: v.created, loc: v.loc || '', served: served.length });
      for (const c of served) b.placed.push({ vac: v.id, app: c.app, name: c.name, phone: c.phone || '', title: v.title, t: c.served.t });
    }
    return by;
  }
  const merge = (by, c) => { const o = { vacs: [], placed: [] }; for (const k of new Set(keysOf(c))) if (by[k]) { o.vacs.push(...by[k].vacs); o.placed.push(...by[k].placed); } o.vacs.sort((a, b) => b.created - a.created); o.placed.sort((a, b) => b.t - a.t); return o; };

  const HEALTH = [[60, 'active', 'Active'], [180, 'quiet', 'Quiet'], [Infinity, 'asleep', 'Asleep']];
  function health(c, f) {
    const last = Math.max(c.created || 0, ...(f.vacs.map(v => v.created)), ...(f.placed.map(x => x.t)), ...((c.notes || []).map(n => n.t)));
    if (!f.vacs.length && !f.placed.length) return { k: 'new', l: 'No vacancy yet', last };
    const d = (Date.now() - last) / 864e5; const h = HEALTH.find(x => d <= x[0]); return { k: h[1], l: h[2], last };
  }

  // ---------- the private ledger ----------
  const ledger = () => rj(LG, { list: [] });
  const owed = (L, cid) => L.list.filter(e => e.client === cid && !e.paid).reduce((a, e) => a + e.amount, 0);

  // ---------- what the screens call ----------
  function list(p) {
    needCrm(p); const M = may(p), db = load(), by = facts(), L = M.money ? ledger() : null, today = kDay();
    const out = db.list.filter(c => !c.archived).map(c => {
      const f = merge(by, c), h = health(c, f), main = (c.contacts || [])[0] || {};
      const o = { id: c.id, name: c.name, sector: c.sector || '', area: c.area || '', contact: main.name || '', phone: main.phone || c.phone || '',
        vacs: f.vacs.length, open: f.vacs.filter(v => v.stage !== 'done').length, placed: f.placed.length, lastPlaced: f.placed[0] ? f.placed[0].t : 0,
        follow: c.follow || null, due: !!(c.follow && c.follow.date <= today), health: h };
      if (L) o.owed = owed(L, c.id);
      return o;
    }).sort((a, b) => (b.due - a.due) || (b.health.last - a.health.last));
    // employers typed on vacancies that don't have a record yet — one tap makes them a record
    const known = new Set(db.list.flatMap(keysOf)), loose = [];
    for (const [k, b] of Object.entries(by)) if (!known.has(k)) {
      const v = rj(VF, { vacs: [] }).vacs.find(x => norm(x.employer) === k);
      loose.push({ name: v ? v.employer : k, vacs: b.vacs.length, placed: b.placed.length });
    }
    return { list: out, loose: loose.sort((a, b) => b.vacs - a.vacs).slice(0, 30), archived: db.list.filter(c => c.archived).length, money: M.money, today };
  }

  function one(p, id) {
    needCrm(p); const M = may(p), c = find(load(), id), f = merge(facts(), c);
    const o = { ...c, facts: f, health: health(c, f), money: M.money };
    if (M.money) {
      const L = ledger(), mine = L.list.filter(e => e.client === c.id).sort((a, b) => b.date.localeCompare(a.date));
      const charged = new Set(mine.filter(e => e.link).map(e => e.link.vac + '|' + e.link.app));
      o.ledger = { agree: (L.agree || {})[c.id] || null, list: mine, owed: owed(L, c.id), paid: mine.filter(e => e.paid).reduce((a, e) => a + e.amount, 0), unbilled: f.placed.filter(x => !charged.has(x.vac + '|' + x.app)).length };
      o.facts.placed = f.placed.map(x => ({ ...x, charged: charged.has(x.vac + '|' + x.app) }));
    }
    return o;
  }

  function contactsOf(b) {
    return (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 8).map(x => ({ name: s(x.name, 60), role: s(x.role, 50), phone: s(x.phone, 30), email: s(x.email, 80) }))
      .filter(x => x.name || x.phone || x.email);
  }
  function upsert(p, b) {
    needCrm(p); const db = load(), name = s(b.name, 80); if (name.length < 2) throw err('Write the employer’s name.');
    const k = norm(name), id = String(b.id || '');
    const clash = db.list.find(x => x.id !== id && keysOf(x).includes(k)); if (clash) throw err(`“${clash.name}” is already an employer. Open it instead.`, 409);
    const email = s(b.email, 80); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('That email doesn’t look right.');
    const fields = { name, sector: s(b.sector, 50), area: s(b.area, 60), address: s(b.address, 120), phone: s(b.phone, 30), email, web: s(b.web, 100), tin: s(b.tin, 30),
      about: s(b.about, 600), aka: String(b.aka || '').split(',').map(x => s(x, 80)).filter(Boolean).slice(0, 5), contacts: contactsOf(b) };
    let c;
    if (id) { c = find(db, id); Object.assign(c, fields, { upd: Date.now() }); log(p, `updated the employer ${name}`); }
    else { c = { id: nid('EMP'), ...fields, created: Date.now(), by: who(p), notes: [], follow: null }; db.list.push(c); log(p, `added the employer ${name}`); }
    save(db); ping(); return { ok: true, id: c.id };
  }
  function note(p, b) {
    needCrm(p); const db = load(), c = find(db, String(b.id || '')), text = s(b.text, 800); if (text.length < 2) throw err('Write the note first.');
    const kind = ['call', 'visit', 'mail', 'note'].includes(b.kind) ? b.kind : 'note';
    c.notes = [{ t: Date.now(), by: who(p), kind, text }].concat(c.notes || []).slice(0, 400);
    save(db); log(p, `${{ call: 'logged a call with', visit: 'logged a visit to', mail: 'logged an email with', note: 'wrote a note on' }[kind]} ${c.name}`); ping(); return { ok: true };
  }
  function follow(p, b) {
    needCrm(p); const db = load(), c = find(db, String(b.id || ''));
    if (b.done) { c.follow = null; log(p, `finished the follow-up with ${c.name}`); }
    else {
      const date = String(b.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('Choose the follow-up date.');
      c.follow = { date, what: s(b.what, 140) || 'Follow up', by: who(p), t: Date.now() }; log(p, `set a follow-up with ${c.name} for ${date}`);
    }
    save(db); ping(); return { ok: true };
  }
  function archive(p, b) {
    needCrm(p); const db = load(), c = find(db, String(b.id || '')); c.archived = !!b.v;
    save(db); log(p, `${c.archived ? 'archived' : 'brought back'} the employer ${c.name}`); ping(); return { ok: true };
  }
  // names for the "Employer" box of State a vacancy, so the same company is always typed the same way
  function names(p) { let R = {}; try { R = rightsOf(p) || {}; } catch (e) {} if (!(may(p).crm || R.start)) return { names: [] }; return { names: load().list.filter(c => !c.archived).map(c => c.name).sort() }; }

  // ---------- the private ledger (real Admin only) ----------
  const amt = v => { const n = Math.round(Number(String(v).replace(/[\s,]/g, ''))); if (!(n > 0 && n < 1e10)) throw err('Write the amount in RWF.'); return n; };
  // the agreement with an employer (Admin only, kept in the private ledger file): fee model, payment terms, replacement guarantee
  function agree(p, b) {
    needMoney(p); const db = load(), c = find(db, String(b.client || '')), L = ledger();
    const model = ['fixed', 'percent', 'monthly', 'other'].includes(b.model) ? b.model : 'other';
    L.agree = L.agree || {}; L.agree[c.id] = { model, fee: s(b.fee, 60), terms: Math.max(0, Math.min(180, parseInt(b.terms, 10) || 0)), guarantee: Math.max(0, Math.min(365, parseInt(b.guarantee, 10) || 0)), signed: /^\d{4}-\d{2}-\d{2}$/.test(b.signed || '') ? b.signed : '', note: s(b.note, 300), t: Date.now() };
    wj(LG, L); log(p, 'changed an agreement in the private ledger'); return one(p, c.id);
  }
  function charge(p, b) {
    needMoney(p); const db = load(), c = find(db, String(b.client || '')), L = ledger();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : kDay();
    const what = s(b.what, 140); if (what.length < 2) throw err('Write the service, for example “Placed 3 waiters”.');
    const e = { id: String(b.id || '') || nid('CH'), client: c.id, what, amount: amt(b.amount), date, note: s(b.note, 300), paid: false, t: Date.now() };
    if (b.link && b.link.vac && b.link.app) e.link = { vac: s(b.link.vac, 40), app: s(b.link.app, 60), name: s(b.link.name, 80) };
    const i = L.list.findIndex(x => x.id === e.id);
    if (i >= 0) { const old = L.list[i]; L.list[i] = { ...e, paid: old.paid, paidOn: old.paidOn, method: old.method, link: e.link || old.link }; } else L.list.push(e);
    wj(LG, L); log(p, 'updated the private ledger'); return { ok: true };
  }
  function paid(p, b) {
    needMoney(p); const L = ledger(), e = L.list.find(x => x.id === String(b.id || '')); if (!e) throw err('This charge no longer exists.', 404);
    e.paid = !!b.v; if (e.paid) { e.paidOn = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : kDay(); e.method = ['cash', 'momo', 'bank', 'cheque'].includes(b.method) ? b.method : 'momo'; } else { delete e.paidOn; delete e.method; }
    wj(LG, L); log(p, 'updated the private ledger'); return { ok: true };
  }
  function unCharge(p, b) {
    needMoney(p); const L = ledger(), n = L.list.length; L.list = L.list.filter(x => x.id !== String(b.id || '')); if (L.list.length === n) throw err('This charge no longer exists.', 404);
    wj(LG, L); log(p, 'updated the private ledger'); return { ok: true };
  }
  function money(p, q) {
    needMoney(p); const L = ledger(), db = load(), byId = Object.fromEntries(db.list.map(c => [c.id, c.name]));
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : kDay().slice(0, 7);
    const pm = (() => { const [y, m] = month.split('-').map(Number), d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); })();
    const sum = a => a.reduce((x, e) => x + e.amount, 0);
    const billed = L.list.filter(e => e.date.startsWith(month)), got = L.list.filter(e => e.paid && (e.paidOn || '').startsWith(month));
    const unpaid = L.list.filter(e => !e.paid).map(e => ({ ...e, days: Math.max(0, Math.floor((Date.parse(kDay() + 'T12:00:00Z') - Date.parse(e.date + 'T12:00:00Z')) / 864e5)) }));
    const per = {}; for (const e of L.list.filter(e => e.date.slice(0, 4) === month.slice(0, 4))) per[e.client] = (per[e.client] || 0) + e.amount;
    const months = [...new Set(L.list.map(e => e.date.slice(0, 7)).concat(kDay().slice(0, 7)))].sort().reverse().slice(0, 24);
    // people served (placed) who were never charged — money that slips away
    const by = facts(), charged = new Set(L.list.filter(e => e.link).map(e => e.link.vac + '|' + e.link.app)), unbilled = [];
    for (const c of db.list) for (const x of merge(by, c).placed) if (!charged.has(x.vac + '|' + x.app) && Date.now() - x.t < 120 * 864e5) unbilled.push({ ...x, client: c.id, clientName: c.name });
    const name = e => ({ ...e, clientName: byId[e.client] || '—' });
    return { month, months, subs: subsMoney ? subsMoney(month) : 0, billed: sum(billed), got: sum(got), gotPrev: sum(L.list.filter(e => e.paid && (e.paidOn || '').startsWith(pm))), owed: sum(unpaid), count: billed.length,
      list: billed.map(name).sort((a, b) => b.date.localeCompare(a.date)), unpaid: unpaid.map(name).sort((a, b) => b.days - a.days),
      top: Object.entries(per).map(([id, v]) => ({ id, name: byId[id] || '—', v })).sort((a, b) => b.v - a.v).slice(0, 6), unbilled: unbilled.sort((a, b) => b.t - a.t).slice(0, 40) };
  }

  return { agree, may, list, one, upsert, note, follow, archive, names, charge, paid, unCharge, money };
};
