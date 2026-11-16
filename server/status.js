// Application status for job seekers — "Where is my application?" on the website.
// Every minute the Hub works out, for each application, how far it has gone (received → call → interview → result → placed)
// and sends only what changed to the website. The website keeps it under a one-way code made from the phone number plus
// a second thing only the person knows (the last 4 digits of their national ID, or their year of birth) — never the number,
// the name or any detail. A person checking sees the position, the date and the step. Nothing else.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ DATA_DIR, urgent, sendSms, smsReady, appendActivity }) {
  const F = n => path.join(DATA_DIR, n), SENT = F('status-sent.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const nine = ph => { const d = String(ph || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
  const keyOf = (k, secret) => crypto.createHash('sha256').update('ejs:' + k + '|' + secret).digest('hex').slice(0, 32); // the website computes the same
  const secrets = (idno, born) => { const out = ['acct'];   // 'acct': for the person's own website account (their phone was proven by SMS)
    const id = String(idno || '').replace(/\D/g, ''); if (id.length >= 8) out.push(id.slice(-4));
    const y = String(born || '').match(/\b(19[4-9]\d|20[0-2]\d)\b/); if (y) out.push(y[1]); return out; };
  const KEEP = 150 * 864e5;

  // step: 0 received · 1 call · 2 interview · 3 result · 4 placed. end: the road stopped here.
  function ofUrgent(a, cand) {
    if (cand) {
      if (cand.served) return cand.served.v ? { s: 4, c: 'placed' } : { s: 4, c: 'notplaced', end: 1 };
      if (cand.called) return { s: 3, c: 'meet' };
      if (cand.push) return cand.push.qualified ? { s: 3, c: 'qualified' } : { s: 3, c: 'notselected', end: 1 };
      if (cand.status === 'done') return { s: 2, c: 'interviewed' };
      return { s: 2, c: 'interview' };
    }
    if (a.status === 'done') return a.outcome === 'coming' ? { s: 1, c: 'invited' } : a.outcome === 'no-answer' ? { s: 1, c: 'noanswer' } : { s: 1, c: 'closed', end: 1 };
    return { s: 0, c: 'received' };
  }
  function ofInquiry(x) {
    if (x.status === 'called') return x.outcome === 'coming' || x.outcome === 'tomorrow' || x.outcome === 'later' ? { s: 1, c: 'invited' } : x.outcome === 'no-answer' ? { s: 1, c: 'noanswer' } : { s: 1, c: 'closed', end: 1 };
    if (x.status === 'sms') return { s: 1, c: 'sms' };
    return { s: 0, c: 'received' };
  }
  function build() {
    const now = Date.now(), cands = {}, by = {};
    for (const v of rj(F('vflow.json'), { vacs: [] }).vacs || []) for (const c of Object.values((v.int && v.int.cands) || {})) if (c.app) cands[c.app] = c;
    const add = (k, sec, item) => { for (const s of sec) (by[keyOf(k, s)] = by[keyOf(k, s)] || []).push(item); };
    for (const a of rj(F('urgent-apps.json'), [])) { const d = a.data || {}, k = nine(d.phone), t = a.created || a.got || 0; if (!k || now - t > KEEP) continue;
      add(k, secrets(d.idno, d.born), { p: String(d.position || a.title || 'Urgent job').slice(0, 60), t, ...ofUrgent(a, cands[a.id]) }); }
    for (const x of rj(F('inquiries.json'), [])) { const k = nine(x.phone), t = x.created || x.got || 0; if (!k || now - t > KEEP) continue;
      add(k, secrets(x.idno, x.born), { p: String(x.title || 'Application').slice(0, 60), t, ...ofInquiry(x) }); }
    for (const h of Object.keys(by)) by[h] = by[h].sort((a, b) => b.t - a.t).slice(0, 12);
    return by;
  }
  let busy = false, last = { t: 0, ok: false, err: '' };
  async function push() {
    if (busy || fs.existsSync(F('moved.json'))) return; busy = true;
    try {
      const cur = build(); let sent = rj(SENT, {}); const set = {}, del = [];
      if (!sent._full || Date.now() - sent._full > 864e5) sent = { _full: Date.now() };   // once a day everything is sent again, in case the website lost it
      const dig = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
      for (const [h, v] of Object.entries(cur)) if (sent[h] !== dig(v)) set[h] = v;
      for (const h of Object.keys(sent)) if (h !== '_full' && !cur[h]) del.push(h);
      const hs = Object.keys(set);
      if (!hs.length && !del.length) wj(SENT, sent);
      for (let i = 0; i < Math.max(hs.length, del.length ? 1 : 0); i += 300) {
        const part = Object.fromEntries(hs.slice(i, i + 300).map(h => [h, set[h]])), d = i === 0 ? del.slice(0, 2000) : [];
        await urgent.remote('/api/hub/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: part, del: d }) });
        for (const h of Object.keys(part)) sent[h] = dig(set[h]); for (const h of d) delete sent[h];
        wj(SENT, sent);
      }
      last = { t: Date.now(), ok: true, err: '' };
    } catch (e) { last = { t: Date.now(), ok: false, err: e.message }; } finally { busy = false; }
  }
  // SMS codes for website accounts: collect, send from the office SMS account, then tell the website (it forgets the code)
  let smsBusy = false, smsLast = { t: 0, ok: true, err: '', n: 0 };
  async function sms() {
    if (smsBusy || fs.existsSync(F('moved.json'))) return; smsBusy = true;
    try {
      let r; try { r = await urgent.remote('/api/hub/sms-out'); } catch (e) { return; }
      const { sms: list = [] } = await r.json(); if (!list.length) return;
      if (!smsReady()) { smsLast = { t: Date.now(), ok: false, err: 'SMS isn’t set up (Access & SMS), so ' + list.length + ' account code' + (list.length > 1 ? 's are' : ' is') + ' waiting.', n: list.length }; return; }
      const done = [];
      for (const x of list) {
        const text = x.why === 'reset' ? `Elite Jobs Rwanda: your code to set a new password is ${x.code}. It works for 30 minutes. Never share it.` : `Elite Jobs Rwanda: your account code is ${x.code}. It works for 30 minutes. Never share it.`;
        try { await sendSms(x.phone, text); done.push(x.phone); } catch (e) { smsLast = { t: Date.now(), ok: false, err: e.message, n: list.length }; }
      }
      if (done.length) { await urgent.remote('/api/hub/sms-out/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phones: done }) }); smsLast = { t: Date.now(), ok: true, err: '', n: done.length };
        appendActivity({ t: Date.now(), by: 'Website', uid: '', role: 'web', text: `sent ${done.length} account code${done.length > 1 ? 's' : ''} by SMS` }); }
    } catch (e) { smsLast = { t: Date.now(), ok: false, err: e.message, n: 0 }; } finally { smsBusy = false; }
  }
  setInterval(sms, 20000).unref(); setTimeout(sms, 8000);
  setInterval(push, 60000).unref(); setTimeout(push, 30000);
  return { push, build, last: () => last, smsLast: () => smsLast };
};
