// Urgent hiring — the Hub side.
// • Admin grants two separate permissions per person: Post (publish urgent jobs to the
//   website) and Review (see applicants, call them, record the outcome). Admin has both.
// • Every minute the Hub collects new applications from the website's back-end, saves
//   them (with their 3 photos) here in the office, then tells the website to delete them.
// • The website never reaches into the Hub; the Hub always calls out.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function makeUrgent({ DATA_DIR, loadState, broadcast, appendActivity, secEvent }) {
  const F = n => path.join(DATA_DIR, n);
  const GR = F('urgent-grants.json'), CFG = F('urgent-config.json'), APPS = F('urgent-apps.json'), PH = F('urgent-photos');
  fs.mkdirSync(PH, { recursive: true });
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
  const err = (m, code) => Object.assign(new Error(m), { code: code || 400 });
  const staff = () => ((loadState() || {}).staff || []);
  const person = id => staff().find(s => s.id === id);
  const OUTCOMES = { 'no-answer': 'Didn’t pick up', 'not-available': 'Not available', 'not-interested': 'Not interested in the job', 'coming': 'Coming on site' };

  // ---------------- permissions ----------------
  function rights(p) {
    if (!p) return { post: false, review: false, admin: false };
    if (p.role === 'admin' && !p.name.includes('@')) return { post: true, review: true, admin: true }; // only the one real Admin
    const g = rj(GR, {})[p.id] || {};
    return { post: !!g.post, review: !!g.review, admin: false };
  }
  function need(p, what) {
    if (!p) throw err('Sign in on this device first.', 401);
    if (p.on === false) throw err('Your access is suspended.', 403);
    const r = rights(p);
    if (!r[what]) throw err(what === 'admin' ? 'Only Admin can do this.' : 'Admin hasn’t given you this permission.', 403);
    return r;
  }
  function grantsView(p) {
    need(p, 'admin');
    const g = rj(GR, {});
    return { staff: staff().filter(s => !(s.role === 'admin' && !s.name.includes('@'))).map(s => ({ id: s.id, name: s.name, role: s.role, dept: s.dept })), grants: g };
  }
  function setGrant(p, b) {
    need(p, 'admin');
    const who = person(String(b.uid || ''));
    if (!who) throw err('Choose a person.');
    if (who.role === 'admin' && !who.name.includes('@')) throw err('Admin already has every permission.');
    const g = rj(GR, {});
    const post = !!b.post, review = !!b.review;
    if (!post && !review) delete g[who.id]; else g[who.id] = { post, review, by: p.name, t: Date.now() };
    wj(GR, g);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `set urgent-hiring access for ${who.name} (${who.dept}): ${[post && 'post', review && 'review'].filter(Boolean).join(' + ') || 'none'}` });
    broadcast({ type: 'urgent', kind: 'grants' });
    return { ok: true, grants: g };
  }

  // ---------------- connection to the website ----------------
  const cfg = () => rj(CFG, {});
  function cfgView() { const c = cfg(); return { site: c.site || '', hasToken: !!c.token, lastSync: c.lastSync || null, lastError: c.lastError || '', live: !!(c.site && c.token) }; }
  function setCfg(b) {
    const c = cfg(), site = String(b.site || '').trim().replace(/\/+$/, '');
    if (site && !/^https?:\/\/[\w.-]+(:\d+)?$/.test(site)) throw err('Use the website address, like https://elitejobsrwanda.com');
    if (site) c.site = site;
    if (typeof b.token === 'string' && b.token.trim()) c.token = b.token.trim();
    c.lastError = ''; wj(CFG, c); setTimeout(sync, 50); return cfgView();
  }
  async function remote(p, opt = {}) {
    const c = cfg(); if (!c.site || !c.token) throw err('The Hub isn’t connected to the website yet. Admin or IT can connect it in Urgent hiring → Website connection.', 409);
    const r = await fetch(c.site + p, { ...opt, headers: { Authorization: 'Bearer ' + c.token, ...(opt.headers || {}) }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401) throw err('The website refused the Hub’s key. Check the key in Website connection.', 502);
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch (e) {} throw err(m || 'The website answered ' + r.status + '.', 502); }
    return r;
  }

  // ---------------- collecting applications (every minute) ----------------
  let syncing = false;
  async function sync() {
    if (fs.existsSync(F('moved.json'))) return; // this Hub moved to the cloud: the new one collects applications now
    const c = cfg(); if (!c.site || !c.token || syncing) return;
    syncing = true;
    try {
      const { apps } = await (await remote('/api/hub/apps')).json();
      const have = rj(APPS, []), fresh = [];
      let bad = 0;
      for (const a of apps) {
        try {                                                  // one broken application must never block the ones behind it
          if (!have.some(x => x.id === a.id)) {
            const photos = [];
            for (let n = 0; n < 3; n++) {
              try {
                const r = await remote(`/api/hub/apps/${encodeURIComponent(a.id)}/photo/${n}`);
                const ext = (r.headers.get('content-type') || '').includes('png') ? 'png' : (r.headers.get('content-type') || '').includes('webp') ? 'webp' : 'jpg';
                const name = `${a.id}-${n}.${ext}`; fs.writeFileSync(path.join(PH, name), Buffer.from(await r.arrayBuffer())); photos.push(name);
              } catch (e) { /* a missing photo is skipped, the person is still kept */ }
            }
            const rec = { id: a.id, post: a.post, title: a.title || (a.data && a.data.job) || 'Urgent job', created: a.created, got: Date.now(), data: a.data || {}, photos, status: 'new' };
            have.push(rec); fresh.push(rec); wj(APPS, have);
          }
          await remote(`/api/hub/apps/${encodeURIComponent(a.id)}/ack`, { method: 'POST' }); // the website deletes its copy
        } catch (e) { bad++; }
      }
      const c2 = cfg(); c2.lastSync = Date.now(); c2.lastError = bad ? bad + ' application' + (bad > 1 ? 's' : '') + ' couldn’t be collected yet — trying again in a minute' : ''; wj(CFG, c2);
      if (fresh.length) {
        broadcast({ type: 'urgent', kind: 'new', n: fresh.length, title: fresh[0].title });
        appendActivity({ t: Date.now(), by: 'Website', uid: '', role: 'web', text: `${fresh.length} new urgent-job application${fresh.length > 1 ? 's' : ''} arrived from the website` });
      }
    } catch (e) { const c2 = cfg(); c2.lastError = e.message; c2.lastSync = Date.now(); wj(CFG, c2); }
    finally { syncing = false; }
    tidy();
  }
  setInterval(sync, 60000); setTimeout(sync, 4000);
  // time-bound housekeeping: reviewed people are saved by date when their day ends, photos go after 60 days, records after 180 days
  const dayOf = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const posName = a => String((a.data && a.data.position) || a.title || 'Urgent job').trim();
  const posKey = a => posName(a).toLowerCase().replace(/\s+/g, ' ');
  function tidy() {
    let list = rj(APPS, []), ch = false; const now = Date.now(), today = dayOf(now), p60 = now - 60 * 864e5, p180 = now - 180 * 864e5;
    for (const a of list) {
      if (a.status === 'done' && !a.archivedAt && dayOf(a.reviewedAt) < today) { a.archivedAt = now; ch = true; }          // the day ended: saved automatically
      if (a.status === 'done' && a.reviewedAt < p60 && a.photos.length) { a.photos.forEach(n => { try { fs.unlinkSync(path.join(PH, n)); } catch (e) {} }); a.photos = []; ch = true; }
    }
    const keep = list.filter(a => !(a.status === 'done' && a.reviewedAt < p180));
    if (keep.length !== list.length) { list = keep; ch = true; }
    if (ch) { wj(APPS, list); broadcast({ type: 'urgent', kind: 'apps' }); }
  }
  setInterval(tidy, 5 * 60000);
  function finish(p, b) {
    need(p, 'review');
    const key = String(b.key || '').toLowerCase().replace(/\s+/g, ' ');
    const list = rj(APPS, []), mine = list.filter(a => a.status === 'done' && !a.archivedAt && posKey(a) === key);
    if (!mine.length) throw err('Call at least one person in this position first.');
    const now = Date.now(); mine.forEach(a => { a.archivedAt = now; a.finishedBy = p.name; });
    wj(APPS, list);
    appendActivity({ t: now, by: p.name, uid: p.id, role: p.role, text: `finished reviewing “${posName(mine[0])}” — ${mine.length} ${mine.length > 1 ? 'people' : 'person'} saved to Daily review and Urgent job data` });
    broadcast({ type: 'urgent', kind: 'apps' }); return { ok: true, n: mine.length };
  }

  // ---------------- posts (published from the Hub to the website) ----------------
  async function posts(p) {
    const r = rights(p); if (!r.post && !r.review) need(p, 'post');
    const { posts, waiting } = await (await remote('/api/hub/posts')).json();
    const local = rj(APPS, []);
    return { posts: posts.filter(x => !x.removed && x.expires > Date.now()).map(x => ({ ...x, applied: local.filter(a => a.post === x.id).length + (waiting[x.id] || 0), live: !x.removed && x.expires > Date.now() })) };
  }
  async function publish(p, b) {
    need(p, 'post');
    const title = String(b.title || '').trim();
    if (title.length < 3) throw err('Give the job a short title, like “5 waiters for tonight”.');
    const hours = Math.max(1, Math.min(24 * 30, Number(b.hours) || 0));
    const expires = b.until ? Date.parse(b.until) : Date.now() + hours * 36e5;
    if (!(expires > Date.now() + 10 * 6e4)) throw err('Choose when this post should end (at least 10 minutes from now).');
    let body;
    if (b.kind === 'card') {                                   // “Endover”: a full job description shown as a liquid card
      const m = b.meta || {};
      if (!String(m.loc || '').trim()) throw err('Add where the job is.');
      if (Number(m.salMin) && Number(m.salMax) && Number(m.salMin) > Number(m.salMax)) throw err('The lowest pay can’t be higher than the highest pay.');
      body = { kind: 'card', title, tpl: String(b.tpl || 'gen'), meta: m, expires, by: p.name };
    } else {                                                   // classic: a flyer photo
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.image || ''));
      if (!m) throw err('Add the flyer or photo of the job.');
      const positions = (Array.isArray(b.positions) ? b.positions : String(b.positions || '').split('\n')).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 12);
      body = { title, role: b.role, text: b.text, place: b.place, positions, expires, by: p.name, image: { mime: m[1], b64: m[2], w: b.w, h: b.h } };
    }
    const r = await remote('/api/hub/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `published the urgent job “${title}” on the website${b.kind === 'card' ? ' (job card)' : ''} (ends ${new Date(expires).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })})` });
    broadcast({ type: 'urgent', kind: 'posts' });
    return j;
  }
  async function removePost(p, id) {
    need(p, 'post');
    await remote(`/api/hub/posts/${encodeURIComponent(id)}/remove`, { method: 'POST' });
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: 'took an urgent job off the website' });
    broadcast({ type: 'urgent', kind: 'posts' });
    return { ok: true };
  }

  // ---------------- applicants ----------------
  function apps(p) { need(p, 'review'); tidy(); return { apps: rj(APPS, []).sort((a, b) => b.got - a.got).map(a => ({ ...a, photos: a.photos.length })) }; }
  function photo(p, id, n) {
    need(p, 'review');
    const a = rj(APPS, []).find(x => x.id === id), name = a && a.photos[Number(n)];
    if (!name) throw err('That photo isn’t available any more.', 404);
    return { file: path.join(PH, name), type: name.endsWith('png') ? 'image/png' : name.endsWith('webp') ? 'image/webp' : 'image/jpeg' };
  }
  function outcome(p, b) {
    need(p, 'review');
    if (!OUTCOMES[b.outcome]) throw err('Choose what happened on the call.');
    const list = rj(APPS, []), a = list.find(x => x.id === b.id); if (!a) throw err('That candidate isn’t in the list any more.', 404);
    Object.assign(a, { status: 'done', outcome: b.outcome, note: String(b.note || '').slice(0, 400), reviewer: p.name, reviewerId: p.id, reviewedAt: Date.now(), archivedAt: 0 });
    wj(APPS, list);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: `called ${a.data.name} about “${posName(a)}”: ${OUTCOMES[b.outcome]}` });
    broadcast({ type: 'urgent', kind: 'apps' });
    return { ok: true };
  }
  function reopen(p, id) {
    need(p, 'review');
    const list = rj(APPS, []), a = list.find(x => x.id === id); if (!a) throw err('Not found.', 404);
    a.status = 'new'; a.reopenedBy = p.name; a.archivedAt = 0; wj(APPS, list); broadcast({ type: 'urgent', kind: 'apps' }); return { ok: true };
  }
  function me(p) {
    const r = rights(p), list = r.review ? rj(APPS, []) : [];
    return { ...r, newCount: list.filter(a => a.status === 'new').length, connection: (r.admin || r.post || r.review) ? cfgView() : null, outcomes: OUTCOMES };
  }
  function report(p) {
    need(p, 'admin');
    const list = rj(APPS, []), day = 864e5, now = Date.now();
    const sum = arr => Object.fromEntries(Object.keys(OUTCOMES).map(k => [k, arr.filter(a => a.outcome === k).length]));
    const byPost = {}; list.forEach(a => { const k = a.title; (byPost[k] = byPost[k] || { title: k, applied: 0, called: 0, coming: 0 }); byPost[k].applied++; if (a.status === 'done') byPost[k].called++; if (a.outcome === 'coming') byPost[k].coming++; });
    const byRev = {}; list.filter(a => a.status === 'done').forEach(a => { byRev[a.reviewer] = (byRev[a.reviewer] || 0) + 1; });
    return {
      total: list.length, waiting: list.filter(a => a.status === 'new').length, called: list.filter(a => a.status === 'done').length,
      today: list.filter(a => a.got > now - day).length, week: list.filter(a => a.got > now - 7 * day).length,
      outcomes: sum(list), byPost: Object.values(byPost).sort((a, b) => b.applied - a.applied), byReviewer: byRev, labels: OUTCOMES
    };
  }
  return { rights, me, grantsView, setGrant, cfgView, setCfg, sync, posts, publish, removePost, apps, photo, outcome, reopen, finish, report, need };
};
