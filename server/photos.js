// Job photos from Pixabay.
// • The Pixabay key is kept only on the Hub server (IT or Admin enter it once). It is never sent to browsers or to GitHub.
// • Searches are kept for 24 hours, as Pixabay asks, and the search results show that the photos come from Pixabay.
// • Pixabay photos can't be shown from Pixabay's own address on other websites, so when someone chooses a photo the Hub
//   downloads it once and stores it on our own website (/api/media/…). Every page then shows our copy.
// • "Default photos" fills each field (waiter, driver, nurse…) with real Pixabay photos for jobs posted without a photo.
'use strict';
const fs = require('fs'), path = require('path');

module.exports = function photos({ DATA_DIR, urgent, appendActivity }) {
  const KEY = path.join(DATA_DIR, 'pixabay.json'), CACHE = path.join(DATA_DIR, 'photo-cache.json'), USED = path.join(DATA_DIR, 'photo-media.json'), DEF = path.join(DATA_DIR, 'photo-defaults.json');
  // DEF: { map: {group: [urls]}, pin: {group: [urls IT chose]}, ban: [pixabay ids IT removed — never chosen again] }
  const defs = () => Object.assign({ map: {}, pin: {}, ban: [] }, rj(DEF, {}));
  const banned = () => new Set(defs().ban);
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
    const ppl = /afric/.test(q);
    if (!c[q] || c[q].v !== 2) {
      const prm = { key: k, q, image_type: 'photo', safesearch: 'true', per_page: '60', min_width: '900', lang: 'en' }; if (ppl) prm.category = 'people';
      const r = await fetch('https://pixabay.com/api/?' + new URLSearchParams(prm), { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r) throw err('Couldn’t reach Pixabay. Check the internet.', 502);
      if (r.status === 429) throw err('Too many photo searches in a short time. Wait a minute and try again.', 429);
      if (!r.ok) throw err('Pixabay answered ' + r.status + '.', 502);
      const j = await r.json();
      c[q] = { v: 2, t: Date.now(), hits: (j.hits || []).map(h => ({ id: 'px' + h.id, t: h.webformatURL, big: h.largeImageURL, w: h.imageWidth, h: h.imageHeight, tags: String(h.tags || '').slice(0, 120), by: String(h.user || '').slice(0, 60), page: h.pageURL })) };
      wj(CACHE, c);
    }
    const used = rj(USED, {});
    // Pixabay's API ranks by popularity, not by match: when the search asks for African people, photos whose own
    // description says so come first, and the others only if there are too few.
    let hits = c[q].hits;
    hits = hits.filter(h => !ANIMAL.test(h.tags || '') && !FAKE.test(h.tags || ''));
    if (ppl) { const af = hits.filter(isAfrican); hits = af.length >= 4 ? af : af.concat(hits.filter(h => !isAfrican(h) && isPeople(h))); }
    return { items: hits.map(h => ({ id: h.id, t: h.t, tags: h.tags, by: h.by, page: h.page, u: used[h.id] || '' })), from: 'Pixabay' };
  }

  // a photo counts as African people only when its description names Africa (or a country) AND a person — and no animal
  // (Pixabay is full of "African grey parrot" and "African elephant")
  const ANIMAL = /\b(parrot|bird|elephant|lion|giraffe|zebra|animal|animals|wildlife|safari|monkey|gorilla|leopard|cheetah|rhino|buffalo|dog|cat|horse|cow|goat|chicken|fish|insect|butterfly|snake|tree|landscape|sunset|map)\b/i;
  const PERSON = /\b(woman|women|man|men|person|people|girl|boy|lady|guy|worker|workers|portrait|face|smile|smiling|student|teacher|nurse|doctor|waiter|waitress|chef|cook|driver|guard|farmer|businessman|businesswoman|employee|staff|team|female|male|adult|child|children|mother|father)\b/i;
  const AFRICA = /\b(africa|african|africans|black|rwanda|rwandan|kenya|kenyan|nigeria|nigerian|ghana|uganda|tanzania|ethiopia|senegal|cameroon|congo|afro)\b/i;
  const isPeople = h => PERSON.test(h.tags || '') && !ANIMAL.test(h.tags || '') && !/\b(figurine|figure|toy|statue|sculpture|doll|mannequin)\b/i.test(h.tags || '');
  const isAfrican = h => isPeople(h) && AFRICA.test(h.tags || '');
  // ---- a job's photos: up to 6 African people, then up to 4 people of other origins — all of them people, never animals,
  //      the ones whose description names the job first ----
  const STOP = new Set(['african', 'africa', 'people', 'person', 'the', 'and', 'for', 'with', 'at', 'in', 'of']);
  const jobWords = q => norm(q).split(' ').filter(w => w.length > 2 && !STOP.has(w));
  // what a photo's description must name for it to count as that job (the job itself, or where and how it is done)
  const SYN = { waiter: ['waitress', 'serving', 'server', 'restaurant'], waitress: ['waiter', 'serving', 'server', 'restaurant'],
    bartender: ['barman', 'barmaid', 'cocktail', 'bartending'], barman: ['bartender', 'barmaid', 'cocktail'], cashier: ['checkout', 'cash register', 'till'], accountant: ['accounting', 'bookkeeping', 'bookkeeper'],
    receptionist: ['reception', 'front desk'], manager: ['meeting', 'office', 'management'], supervisor: ['supervising', 'warehouse'], driver: ['driving', 'taxi', 'chauffeur', 'truck driver', 'bus driver'],
    sales: ['shop', 'seller', 'vendor', 'retail', 'saleswoman', 'salesman'], saleswoman: ['shop', 'seller', 'vendor'], salesperson: ['shop', 'seller', 'vendor', 'salesman', 'saleswoman'], counter: ['shop', 'shopkeeper'],
    nurse: ['nursing', 'hospital', 'clinic'], doctor: ['physician', 'hospital', 'stethoscope', 'clinic'], chef: ['cooking', 'culinary', 'kitchen'], cook: ['cooking', 'chef', 'kitchen'],
    cleaner: ['cleaning', 'janitor', 'mopping', 'housekeeping'], housekeeper: ['housekeeping', 'maid', 'cleaning'], teacher: ['teaching', 'classroom', 'lesson'], mason: ['bricklayer', 'bricks', 'masonry'],
    electrician: ['electrical', 'wiring'], plumber: ['plumbing'], mechanic: ['car repair', 'auto repair', 'garage', 'engine'], tailor: ['sewing', 'seamstress', 'dressmaker'],
    hairdresser: ['hair salon', 'hairstylist', 'braids', 'braiding', 'haircut'], barber: ['barbershop', 'haircut', 'shaving'], farmer: ['farming', 'agriculture', 'harvest', 'farm'], nanny: ['babysitter', 'childcare'],
    guard: ['security', 'bodyguard', 'guarding'], security: ['guard', 'bodyguard'], welder: ['welding'], carpenter: ['carpentry', 'woodwork'], pharmacist: ['pharmacy', 'drugstore'],
    baker: ['bakery', 'baking'], storekeeper: ['warehouse', 'inventory'], dishwasher: ['dishes', 'washing dishes'], gardener: ['gardening'], secretary: ['typing', 'office'],
    worker: ['working', 'work'], construction: ['builder', 'building site'], software: ['coding', 'programmer', 'developer'], developer: ['coding', 'programmer'],
    programmer: ['coding', 'developer'], office: ['office', 'business'], factory: ['factory', 'industry'], engineer: ['engineering', 'engineer'], salon: ['salon', 'hairdresser'] };
  const terms = W => [...new Set(W.flatMap(w => [w, ...(SYN[w] || [])]))];
  // Pixabay lists a photo's tags most important first: the job (or how it is done) must be one of the first three,
  // so a photo where the job is only a side detail doesn't count
  const head = h => ' ' + String(h.tags || '').toLowerCase().split(',').slice(0, 3).map(x => x.trim()).join(' , ') + ' ';
  const aboutJob = (h, W) => { const t = head(h); return terms(W).some(w => w.includes(' ') ? t.includes(w) : new RegExp('\\b' + w.slice(0, Math.min(w.length, 6)), 'i').test(t)); };
  // never toys, statues, posed fashion shots, drawings or weapons — only real people at work
  const FAKE = /\b(figurine|figure|figures|toy|toys|statue|sculpture|doll|dolls|miniature|puppet|lego|playmobil|mannequin|fashion|glamour|sexy|erotic|lingerie|bikini|pinup|cosplay|costume|halloween|fantasy|zombie|horror|render|illustration|cartoon|drawing|soldier|soldiers|army|military|war|weapon|gun|rifle|pistol)\b/i;
  const real = h => !FAKE.test(h.tags || '');
  let lastCall = 0; const GAP = Number(process.env.PX_PACE || 700); const pace = async () => { const w = lastCall + GAP - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); lastCall = Date.now(); }; // Pixabay allows 100 searches a minute

  async function raw(p, q, people) { // the cached Pixabay hits for one search
    const k = key(); if (!k) throw err('Photos need the Pixabay key. IT or Admin adds it once in IT → System control → Job photos.', 409);
    q = norm(q); const ck = q + (people ? '|people' : ''), c = cache();
    if (!c[ck] || c[ck].v !== 2) {
      const prm = { key: k, q, image_type: 'photo', safesearch: 'true', per_page: '80', min_width: '640', lang: 'en' }; if (people) prm.category = 'people';
      await pace(); const r = await fetch('https://pixabay.com/api/?' + new URLSearchParams(prm), { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r) throw err('Couldn’t reach Pixabay. Check the internet.', 502);
      if (r.status === 429) throw err('Too many photo searches in a short time. Wait a minute and try again.', 429);
      if (!r.ok) throw err('Pixabay answered ' + r.status + '.', 502);
      const j = await r.json();
      c[ck] = { v: 2, t: Date.now(), hits: (j.hits || []).map(h => ({ id: 'px' + h.id, t: h.webformatURL, big: h.largeImageURL, w: h.imageWidth, h: h.imageHeight, tags: String(h.tags || '').slice(0, 120), by: String(h.user || '').slice(0, 60), page: h.pageURL })) };
      wj(CACHE, c);
    }
    return c[ck].hits;
  }
  // only photos whose description names the job (or where it is done): if Pixabay has none, the answer is none — never a
  // nice photo of somebody doing something else. `avoid` keeps one photo from being used for two different jobs.
  async function jobPhotos(p, job, nAf = 6, nFo = 4, avoid) {
    signed(p); const W = jobWords(job); if (!W.length) return { af: [], fo: [] };
    const base = W.join(' '), seen = new Set(avoid || []);
    const by = new Set(), ban = banned(); // one photo per photographer, so the same shoot doesn't show twice
    const take = (L, n, ok) => { const out = []; for (const h of L) { if (out.length >= n) break; if (!seen.has(h.id) && !ban.has(h.id) && !by.has(h.by) && real(h) && aboutJob(h, W) && ok(h)) { seen.add(h.id); by.add(h.by); out.push(h); } } return out; };
    let af = take([...await raw(p, 'african ' + base, true), ...await raw(p, base + ' africa', true)], nAf, isAfrican);
    if (af.length < nAf) af = af.concat(take([...await raw(p, 'black ' + base, true), ...await raw(p, 'african ' + base, false)], nAf - af.length, isAfrican));
    let fo = take(await raw(p, base, true), nFo, h => isPeople(h) && !isAfrican(h));
    if (fo.length < nFo) fo = fo.concat(take(await raw(p, base, false), nFo - fo.length, h => isPeople(h) && !isAfrican(h)));
    return { af, fo };
  }
  async function jobSearch(p, q) {
    const { af, fo } = await jobPhotos(p, q), used = rj(USED, {});
    const out = h => ({ id: h.id, t: h.t, tags: h.tags, by: h.by, page: h.page, u: used[h.id] || '' });
    return { items: [...af.map(h => ({ ...out(h), af: true })), ...fo.map(out)], african: af.length, others: fo.length, from: 'Pixabay' };
  }

  // ---- choose: download once, store on our website, return our own address ----
  const MEDIA = /^\/api\/media\/[A-Za-z0-9_-]{6,40}$/;
  async function store(h) {
    const used = rj(USED, {}); if (used[h.id]) return used[h.id];
    let buf = null, mime = 'image/jpeg';
    for (const u of [h.t, h.big]) {
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
    'job:waiter': ['waiter'], 'job:waitress': ['waitress'], 'job:bartender': ['bartender'], 'job:barman': ['bartender'], 'job:cashier': ['cashier'], 'job:accountant': ['accountant'],
    'job:receptionist': ['receptionist'], 'job:manager': ['manager office'], 'job:supervisor': ['supervisor'], 'job:driver': ['driver'], 'job:sales': ['saleswoman shop'], 'job:counter': ['shop counter'],
    'job:nurse': ['nurse'], 'job:cook': ['cook'], 'job:chef': ['chef'], 'job:cleaner': ['cleaner'], 'job:teacher': ['teacher'], 'job:mason': ['mason'], 'job:electrician': ['electrician'], 'job:plumber': ['plumber'], 'job:mechanic': ['mechanic'], 'job:tailor': ['tailor'], 'job:hairdresser': ['hairdresser'], 'job:farmer': ['farmer'], 'job:housekeeper': ['housekeeper'], 'job:nanny': ['nanny'], 'job:guard': ['guard'], 'job:welder': ['welder'], 'job:carpenter': ['carpenter'], 'job:pharmacist': ['pharmacist'], 'job:doctor': ['doctor'], 'job:baker': ['baker'], 'job:storekeeper': ['storekeeper'], 'job:dishwasher': ['dishwasher'], 'job:gardener': ['gardener'], 'job:secretary': ['secretary'], 'job:salesperson': ['salesperson'], 'job:barber': ['barber'],
    'field:cleaning': ['african cleaner'], 'field:agriculture-environment': ['african farmer field'], 'field:construction-trades': ['african construction worker'], 'field:education-childcare': ['african teacher classroom'],
    'field:energy-mining': ['african engineer solar'], 'field:health-care': ['african nurse'], 'field:it-technology': ['african programmer laptop'], 'field:manufacturing': ['african factory worker'],
    'field:ngo-public': ['african community work'], 'field:other': ['african people working'], 'field:property': ['african real estate'], 'field:security': ['african security guard'], 'field:sports-fitness': ['african fitness trainer'],
    'field:tourism-beauty-media': ['african hair salon'], 'field:driving-logistics': ['african driver'], 'field:sales-marketing': ['african sales shop'], 'field:finance': ['african accountant'],
    'field:hospitality': ['african waiter restaurant'], 'field:office-admin': ['african office receptionist']
  };
  const push = d => urgent.remote('/api/hub/fieldpics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ map: d.map }) });
  function fillDefaults(p) {
    signed(p); if (!boss(p)) throw err('Only IT or Admin can refresh the default photos.', 403);
    if (!key()) throw err('Add the Pixabay key first.', 409);
    if (filling) throw err('Default photos are already being filled.', 409);
    const E = Object.entries(DEFAULTS); fillState = { busy: true, done: 0, total: E.length, last: fillState.last, error: '' };
    filling = (async () => {
      const d0 = defs(), map = {}, usedIds = new Set(); let n = 0;
      for (const [k, qs] of E) {
        const got = [...(d0.pin[k] || [])].slice(0, 8); // the photos IT chose stay first
        for (const q of qs) {
          if (got.length >= 8) break;
          let r = { af: [], fo: [] }; try { r = await jobPhotos(p, q.replace(/\bafrican\b/g, ' '), 5, 3, usedIds); } catch (e) { fillState.error = e.message; }
          for (const h of [...r.af, ...r.fo]) { if (got.length >= 8) break; try { const u = await store(h); usedIds.add(h.id); if (!got.includes(u)) { got.push(u); n++; } } catch (e) { /* next photo */ } }
        }
        if (got.length) map[k] = got;
        fillState.done++;
      }
      const d = defs(); d.map = map; wj(DEF, d); await push(d);
      // tidy up: photos nothing uses any more are deleted from the website, and forgotten here
      try { const pr = await (await urgent.remote('/api/hub/mediaprune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); const del = new Set(pr.deleted || []), U = rj(USED, {}); for (const k of Object.keys(U)) if (del.has(U[k])) delete U[k]; wj(USED, U); } catch (e) { /* next time */ }
      appendActivity({ t: Date.now(), who: p.name, what: `filled the website's default job photos from Pixabay (${Object.keys(map).length} groups, ${n} photos)` });
      fillState = { busy: false, done: E.length, total: E.length, last: { t: Date.now(), groups: Object.keys(map).length, photos: n, by: p.name }, error: '' };
    })().catch(e => { fillState = Object.assign(fillState, { busy: false, error: e.message }); }).finally(() => { filling = null; });
    return { ok: true, started: true, total: E.length };
  }

  // ---- IT checks the default photos by eye: remove a wrong one (it never comes back), add a better one ----
  const GROUPS = () => Object.keys(DEFAULTS);
  async function seeded() { const d = defs(); if (Object.keys(d.map).length) return d; try { const m = await (await fetch(site() + '/api/fieldpics', { signal: AbortSignal.timeout(15000) })).json(); if (m && typeof m === 'object') { d.map = m; wj(DEF, d); } } catch (e) { /* empty until the next fill */ } return d; }
  async function defaultsList(p) { signed(p); if (!boss(p)) throw err('Only IT or Admin can check the default photos.', 403); const d = await seeded(); return { groups: GROUPS().map(k => ({ k, urls: d.map[k] || [], pin: d.pin[k] || [] })), site: site(), banned: d.ban.length }; }
  async function defaultsRemove(p, b) {
    signed(p); if (!boss(p)) throw err('Only IT or Admin can change the default photos.', 403); if (filling) throw err('Wait: the default photos are being filled.', 409);
    const k = String(b.k || ''), url = String(b.url || ''); if (!DEFAULTS[k] || !MEDIA.test(url)) throw err('Choose a photo first.');
    const d = await seeded(); d.map[k] = (d.map[k] || []).filter(u => u !== url); if (d.pin[k]) d.pin[k] = d.pin[k].filter(u => u !== url);
    const id = Object.keys(rj(USED, {})).find(i => rj(USED, {})[i] === url); if (id && !d.ban.includes(id)) d.ban.push(id);
    wj(DEF, d); await push(d);
    appendActivity({ t: Date.now(), who: p.name, what: `removed a default photo from ${k} (it won't be chosen again)` });
    return { ok: true, urls: d.map[k] };
  }
  async function defaultsAdd(p, b) {
    signed(p); if (!boss(p)) throw err('Only IT or Admin can change the default photos.', 403); if (filling) throw err('Wait: the default photos are being filled.', 409);
    const k = String(b.k || ''); if (!DEFAULTS[k]) throw err('Choose a job first.');
    const { url } = await use(p, b.id); const d = await seeded();
    d.pin[k] = [url, ...(d.pin[k] || []).filter(u => u !== url)].slice(0, 8);
    d.map[k] = [url, ...(d.map[k] || []).filter(u => u !== url)].slice(0, 8);
    d.ban = d.ban.filter(i => i !== String(b.id)); wj(DEF, d); await push(d);
    appendActivity({ t: Date.now(), who: p.name, what: `added a default photo to ${k}` });
    return { ok: true, urls: d.map[k] };
  }
  return { status, setKey, search, jobSearch, use, fillDefaults, defaultsList, defaultsRemove, defaultsAdd };
};
