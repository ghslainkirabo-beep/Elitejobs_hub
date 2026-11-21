// Reminders that chase for you: the Hub looks at what it already knows and says, in plain words, who is waiting.
// Nothing here invents data. Each reminder points at the room where the work is done.
// "Done" and "Later" are shared by the office and written to Activity, so everyone sees who handled what.
const fs = require('fs'), path = require('path');

module.exports = function ({ DATA_DIR, urgent, inquiries, appendActivity, broadcast }) {
  const F = n => path.join(DATA_DIR, n), ST = F('reminders-state.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, s = 400) => Object.assign(new Error(m), { code: s });
  const H = 36e5, DAY = 24 * H, KGL = 2 * H;
  const kDay = t => new Date(t + KGL).toISOString().slice(0, 10);
  const ago = ms => { const h = Math.floor(ms / H); return h < 1 ? 'less than an hour' : h < 48 ? h + (h === 1 ? ' hour' : ' hours') : Math.floor(h / 24) + ' days'; };
  const left = ms => { const h = Math.max(0, Math.round(ms / H)); return h < 1 ? 'under an hour' : h + (h === 1 ? ' hour' : ' hours'); };
  const isAbroad = x => !!x && !!x.country && x.country !== 'RW';
  const CN = { AE: 'Dubai (UAE)', QA: 'Qatar', SA: 'Saudi Arabia', KW: 'Kuwait', OM: 'Oman', BH: 'Bahrain', JO: 'Jordan', IL: 'Israel', TR: 'Türkiye', PL: 'Poland', DE: 'Germany', FR: 'France', BE: 'Belgium', NL: 'Netherlands', GB: 'the UK', IE: 'Ireland', CA: 'Canada', US: 'the USA', AU: 'Australia', JP: 'Japan', KR: 'South Korea', CN: 'China', KE: 'Kenya', UG: 'Uganda', TZ: 'Tanzania', BI: 'Burundi', CD: 'DR Congo', ZA: 'South Africa' };
  const cname = c => CN[c] || c || 'abroad';

  let pc = { t: 0, posts: null };
  async function livePosts() {
    if (Date.now() - pc.t < 120000 && pc.posts) return pc.posts;
    try { const r = await urgent.remote('/api/hub/posts'); const j = await r.json(); pc = { t: Date.now(), posts: (j.posts || []).filter(x => !x.removed && x.expires > Date.now()) }; }
    catch (e) { pc = { t: Date.now() - 60000, posts: pc.posts || [] }; }
    return pc.posts;
  }

  async function build(p) {
    if (!p) throw err('Sign in on this device first.', 401);
    const R = urgent.rights(p), now = Date.now(), out = [];
    const add = (id, lvl, title, sub, go, t, who) => out.push({ id, lvl, title, sub, go, t, who });

    if (R.post || R.review) {
      const apps = rj(F('urgent-apps.json'), []);
      // 1. an urgent job is about to end and nobody is coming on site yet
      for (const x of await livePosts()) {
        const ms = x.expires - now; if (ms > DAY) continue;
        const coming = apps.filter(a => a.post === x.id && a.outcome === 'coming').length; if (coming) continue;
        const n = apps.filter(a => a.post === x.id).length;
        add(`end:${x.id}`, ms < 6 * H ? 'now' : 'soon', `“${x.title}” ends in ${left(ms)}`, n ? `${n} applied, but nobody is confirmed as coming on site yet.` : 'Nobody has applied yet. Share it again or extend the end time.', isAbroad(x) ? 'abroad' : 'urgent', x.expires);
      }
      // 2. applicants waiting for a call for more than 2 hours (one reminder for Rwanda, one for abroad)
      if (R.review) for (const ab of [false, true]) {
        const w = apps.filter(a => a.status === 'new' && isAbroad(a) === ab && now - (a.created || a.got) > 2 * H); if (!w.length) continue;
        const old = Math.min(...w.map(a => a.created || a.got));
        add(`wait:${ab ? 'ab' : 'rw'}:${kDay(now)}:${w.length}`, now - old > 6 * H ? 'now' : 'soon', `${w.length} ${w.length === 1 ? 'applicant has' : 'applicants have'} waited over 2 hours for a call${ab ? ' (abroad)' : ''}`, `The first one applied ${ago(now - old)} ago.`, ab ? 'abroad' : 'urgent', old);
      }
    }
    if (R.review) {
      const asks = rj(F('abroad-asks.json'), []);
      for (const a of asks) {
        // 3. an Abroad enquiry not called back within a day
        if (a.status !== 'done' && now - a.created > DAY) add(`ask:${a.id}`, now - a.created > 3 * DAY ? 'now' : 'soon', `Call ${a.name} back about work in ${cname(a.country)}`, `Asked ${ago(now - a.created)} ago${a.work ? ' · wants ' + a.work : ''}. Not called yet.`, 'abroadinq', a.created);
        // 4. didn't answer: try again the next day
        if (a.status === 'done' && a.outcome === 'noanswer' && now - a.reviewedAt > DAY && now - a.reviewedAt < 14 * DAY) add(`retry:${a.id}:${a.reviewedAt}`, 'soon', `Try ${a.name} again`, `Didn’t answer when ${a.reviewer || 'a colleague'} called ${ago(now - a.reviewedAt)} ago (work in ${cname(a.country)}).`, 'abroadinq', a.reviewedAt);
        // 5. after a placement abroad: check in at 1 week, 1 month and 3 months
        if (a.status === 'done' && a.outcome === 'placed') for (const [d, l] of [[7, '1 week'], [30, '1 month'], [90, '3 months']]) {
          const due = a.reviewedAt + d * DAY; if (now >= due && now < due + 21 * DAY) add(`check:${a.id}:${d}`, 'soon', `Check on ${a.name} in ${cname(a.country)}`, `Matched to a job abroad ${l} ago. A short call: are they safe, paid and settled?`, 'abroadinq', due);
        }
      }
    }
    // 6. Open jobs inquiry messages left from earlier days (only the rooms this person may open)
    try {
      const me = inquiries.me(p), open = rj(F('inquiries.json'), []).filter(x => x.status === 'open');
      for (const [r, l] of [['yesterday', 'yesterday'], ['endover', 'earlier days']]) {
        if (!me.rooms[r] || !me.rooms[r].allowed) continue; const n = me.rooms[r].count; if (!n) continue;
        const old = Math.min(...open.map(x => x.created).filter(Boolean), now);
        add(`inq:${r}:${kDay(now)}:${n}`, r === 'endover' ? 'now' : 'soon', `${n} ${n === 1 ? 'message' : 'messages'} from ${l} still not answered`, 'From the website’s “Message us”. Reply or record the call.', 'inq:' + r, old);
      }
    } catch (e) {}
    // 7. Admin only: a charge in the private ledger unpaid for over 2 weeks (no amounts shown here)
    if (R.admin) {
      const L = rj(F('ledger.json'), { list: [] }), C = rj(F('clients.json'), { list: [] });
      for (const e of L.list || []) {
        if (e.paid) continue; const t = Date.parse(e.date + 'T09:00:00+02:00'); if (!(now - t > 14 * DAY)) continue;
        const c = (C.list || []).find(x => x.id === e.client);
        add(`fee:${e.id}`, now - t > 30 * DAY ? 'now' : 'soon', `${c ? c.name : 'A client'} hasn’t paid yet`, `“${e.what}” · charged ${ago(now - t)} ago. Only you see this.`, 'ledger', t);
      }
    }
    const st = rj(ST, { done: {}, later: {} });
    const list = out.filter(r => !st.done[r.id] && !(st.later[r.id] > now)).sort((a, b) => (a.lvl === b.lvl ? a.t - b.t : a.lvl === 'now' ? -1 : 1));
    return { list, count: list.length, now: list.filter(r => r.lvl === 'now').length };
  }

  async function act(p, b) {
    if (!p) throw err('Sign in on this device first.', 401);
    const { list } = await build(p), r = list.find(x => x.id === String(b.id || ''));
    if (!r) throw err('This reminder is already handled.', 404);
    const st = rj(ST, { done: {}, later: {} });
    if (b.act === 'done') st.done[r.id] = { by: p.name, t: Date.now() };
    else if (b.act === 'later') st.later[r.id] = Date.now() + 3 * H;
    else throw err('Choose Done or Later.');
    // keep the file small: forget old entries after 120 days
    const cut = Date.now() - 120 * DAY; for (const k of Object.keys(st.done)) if (st.done[k].t < cut) delete st.done[k]; for (const k of Object.keys(st.later)) if (st.later[k] < Date.now()) delete st.later[k];
    wj(ST, st);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `${b.act === 'done' ? 'marked as handled' : 'put off for 3 hours'} the reminder “${r.title}”` });
    broadcast({ type: 'reminders' }); return { ok: true };
  }
  return { build, act };
};
