// Job photos from Pixabay.
// • The Pixabay key is kept only on the Hub server (IT or Admin enter it once). It is never sent to browsers or to GitHub.
// • Searches are kept for 24 hours, as Pixabay asks, and the search results show that the photos come from Pixabay.
// • Pixabay photos can't be shown from Pixabay's own address on other websites, so when someone chooses a photo the Hub
//   downloads it once and stores it on our own website (/api/media/…). Every page then shows our copy.
// • "Default photos" fills each field (waiter, driver, nurse…) with real Pixabay photos for jobs posted without a photo.
'use strict';
const fs = require('fs'), path = require('path');

module.exports = function photos({ DATA_DIR, urgent, appendActivity }) {
  const KEY = path.join(DATA_DIR, 'pixabay.json'), CACHE = path.join(DATA_DIR, 'photo-cache.json'), USED = path.join(DATA_DIR, 'photo-media.json');
  const DAY = 864e5;
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
  const err = (m, c = 400) => Object.assign(new Error(m), { code: c });
  const signed = p => { if (!p) throw err('Sign in first.', 401); if (p.on === false) throw err('Your access is suspended.', 403); };
  const boss = p => p && !String(p.name || '').includes('@') && (p.role === 'it' || p.role === 'admin');
  const key = () => (rj(KEY, {}).key || process.env.PIXABAY_KEY || '').trim();
  const site = () => { try { return urgent.siteOf() || ''; } catch (e) { return ''; } };

  let filling = null, fillState = { busy: false, done: 0, total: 0, last: null, error: '' };
  function status(p) { signed(p); const k = rj(KEY, {}); return { on: !!key(), by: k.by || '', t: k.t || 0, site: site(), canSet: boss(p), fill: fillState }; }
  async function setKey(p, b) {
    signed(p); if (!boss(p)) throw err('Only IT or Admin can set the photo key.', 403);
    const k = String((b && b.key) || '').trim();
    if (!k) { wj(KEY, {}); appendActivity({ t: Date.now(), who: p.name, what: 'removed the Pixabay photo key' }); return { ok: true, on: false }; }
    if (!/^[0-9]{5,12}-[a-f0-9]{20,40}$/i.test(k)) throw err('That doesn’t look like a Pixabay key. It looks like 12345678-abcdef0123456789abcdef012.');
    const r = await fetch('https://pixabay.com/api/?' + new URLSearchParams({ key: k, q: 'office', per_page: '3' }), { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r) throw err('Couldn’t reach Pixabay. Check the internet and try again.', 502);
    if (r.status === 400 || r.status === 401 || r.status === 403) throw err('Pixabay refused this key. Copy it again from pixabay.com/api/docs.', 400);
    wj(KEY, { key: k, by: p.name, t: Date.now() });
    appendActivity({ t: Date.now(), who: p.name, what: 'set the Pixabay photo key (kept on the Hub server only)' });
    return { ok: true, on: true };
  }

  // ---- search, kept 24 hours ----
  function cache() { const c = rj(CACHE, {}), now = Date.now(); let ch = false; for (const q of Object.keys(c)) if (now - c[q].t > DAY) { delete c[q]; ch = true; } if (ch) wj(CACHE, c); return c; }
  const norm = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  async function search(p, q) {
    signed(p); const k = key(); if (!k) throw err('Photos need the Pixabay key. IT or Admin adds it once in IT → System control → Job photos.', 409);
    q = norm(q); if (!q) return { items: [], from: 'Pixabay' };
    const c = cache();
    if (!c[q]) {
      const r = await fetch('https://pixabay.com/api/?' + new URLSearchParams({ key: k, q, image_type: 'photo', safesearch: 'true', per_page: '40', min_width: '900', lang: 'en' }), { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r) throw err('Couldn’t reach Pixabay. Check the internet.', 502);
      if (r.status === 429) throw err('Too many photo searches in a short time. Wait a minute and try again.', 429);
      if (!r.ok) throw err('Pixabay answered ' + r.status + '.', 502);
      const j = await r.json();
      c[q] = { t: Date.now(), hits: (j.hits || []).map(h => ({ id: 'px' + h.id, t: h.webformatURL, big: h.largeImageURL, w: h.imageWidth, h: h.imageHeight, tags: String(h.tags || '').slice(0, 120), by: String(h.user || '').slice(0, 60), page: h.pageURL })) };
      wj(CACHE, c);
    }
    const used = rj(USED, {});
    return { items: c[q].hits.map(h => ({ id: h.id, t: h.t, tags: h.tags, by: h.by, page: h.page, u: used[h.id] || '' })), from: 'Pixabay' };
  }

  // ---- choose: download once, store on our website, return our own address ----
  const MEDIA = /^\/api\/media\/[A-Za-z0-9_-]{6,40}$/;
  async function store(h) {
    const used = rj(USED, {}); if (used[h.id]) return used[h.id];
    let buf = null, mime = 'image/jpeg';
    for (const u of [h.big, h.t]) {
      if (!u) continue;
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (!r || !r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer()); mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!/^image\/(jpeg|png|webp)$/.test(mime) || b.length < 2000) continue;
      if (b.length <= 1.5e6) { buf = b; break; }
    }
    if (!buf) throw err('Couldn’t download this photo from Pixabay. Choose another one.', 502);
    const r = await urgent.remote('/api/hub/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ b64: buf.toString('base64'), mime, page: h.page, by: h.by, tags: h.tags }) });
    const j = await r.json(); if (!j.url || !MEDIA.test(j.url)) throw err('The website didn’t keep the photo. Try again.', 502);
    const u2 = rj(USED, {}); u2[h.id] = j.url; wj(USED, u2);
    return j.url;
  }
  async function use(p, id) {
    signed(p); id = String(id || '');
    const h = Object.values(cache()).flatMap(x => x.hits).find(x => x.id === id);
    if (!h) { const u = rj(USED, {})[id]; if (u) return { url: u, site: site() }; throw err('Search again: this photo is older than 24 hours.', 409); }
    return { url: await store(h), by: h.by, site: site() };
  }

  // ---- default photos for each field and job, for posts without their own photo ----
  // keys match the website's card groups (tpl / job word) and the field pages (slug)
  const DEFAULTS = {
    'tpl:hosp': ['african waiter restaurant', 'african waitress', 'african chef kitchen'], 'tpl:clean': ['african cleaner cleaning'], 'tpl:secur': ['african security guard'],
    'tpl:drive': ['african driver car', 'delivery truck africa'], 'tpl:tech': ['african software developer'], 'tpl:fin': ['african accountant', 'african cashier'], 'tpl:sales': ['african sales shop'],
    'tpl:health': ['african nurse hospital'], 'tpl:build': ['african construction worker'], 'tpl:edu': ['african teacher classroom'], 'tpl:office': ['african receptionist office', 'african office team'], 'tpl:gen': ['african people working'],
    'job:waiter': ['african waiter'], 'job:waitress': ['african waitress'], 'job:bartender': ['african bartender'], 'job:barman': ['african bartender'], 'job:cashier': ['african cashier'], 'job:accountant': ['african accountant'],
    'job:receptionist': ['african receptionist'], 'job:manager': ['african manager office'], 'job:supervisor': ['african supervisor'], 'job:driver': ['african driver'], 'job:sales': ['african saleswoman shop'], 'job:counter': ['african shop counter'],
    'field:cleaning': ['african cleaner'], 'field:agriculture-environment': ['african farmer field'], 'field:construction-trades': ['african construction worker'], 'field:education-childcare': ['african teacher classroom'],
    'field:energy-mining': ['african engineer solar'], 'field:health-care': ['african nurse'], 'field:it-technology': ['african programmer laptop'], 'field:manufacturing': ['african factory worker'],
    'field:ngo-public': ['african community work'], 'field:other': ['african people working'], 'field:property': ['african real estate'], 'field:security': ['african security guard'], 'field:sports-fitness': ['african fitness trainer'],
    'field:tourism-beauty-media': ['african hair salon'], 'field:driving-logistics': ['african driver'], 'field:sales-marketing': ['african sales shop'], 'field:finance': ['african accountant'],
    'field:hospitality': ['african waiter restaurant'], 'field:office-admin': ['african office receptionist']
  };
  function fillDefaults(p) {
    signed(p); if (!boss(p)) throw err('Only IT or Admin can refresh the default photos.', 403);
    if (!key()) throw err('Add the Pixabay key first.', 409);
    if (filling) throw err('Default photos are already being filled.', 409);
    const E = Object.entries(DEFAULTS); fillState = { busy: true, done: 0, total: E.length, last: fillState.last, error: '' };
    filling = (async () => {
      const map = {}; let n = 0;
      for (const [k, qs] of E) {
        const want = k.startsWith('job:') ? 1 : 3, got = [];
        for (const q of qs) {
          if (got.length >= want) break;
          let items = []; try { items = (await search(p, q)).items; } catch (e) { fillState.error = e.message; }
          for (const it of items) { if (got.length >= want) break; try { const h = Object.values(cache()).flatMap(x => x.hits).find(x => x.id === it.id); got.push(await store(h)); n++; } catch (e) { /* next photo */ } }
        }
        if (got.length) map[k] = got;
        fillState.done++;
      }
      await urgent.remote('/api/hub/fieldpics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ map }) });
      appendActivity({ t: Date.now(), who: p.name, what: `filled the website's default job photos from Pixabay (${Object.keys(map).length} groups, ${n} photos)` });
      fillState = { busy: false, done: E.length, total: E.length, last: { t: Date.now(), groups: Object.keys(map).length, photos: n, by: p.name }, error: '' };
    })().catch(e => { fillState = Object.assign(fillState, { busy: false, error: e.message }); }).finally(() => { filling = null; });
    return { ok: true, started: true, total: E.length };
  }
  return { status, setKey, search, use, fillDefaults };
};
