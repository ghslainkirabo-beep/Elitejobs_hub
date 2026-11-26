// Pixabay photos: the key stays on the Hub, searches are kept 24 h, a chosen photo is downloaded once and stored on our
// website, default photos fill in the background.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.PX_PACE = '1';
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'px-'));
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7)]);
let calls = { api: 0, img: 0 }, stored = [], fieldpics = null;
global.fetch = async (u) => {
  u = String(u);
  if (u.startsWith('https://pixabay.com/api/')) {
    calls.api++; const q = new URL(u).searchParams;
    if (q.get('key') === 'bad-123456-ffffffffffffffffffff') return { ok: false, status: 400, json: async () => ({}) };
    const term = q.get('q'), job = term.split(' ').filter(w => !['african', 'africa', 'black'].includes(w)).join(' '), cat = q.get('category') || '';
    const T = [job + ', african, man', job + ', black, woman, smile', 'african grey parrot, bird', job + ', woman, portrait', 'restaurant, interior', 'african, woman, headwrap', job + ', figurine, man', 'african, man, smile, ' + job];
    let h0 = 0; for (const ch of term + cat) h0 = (h0 * 31 + ch.charCodeAt(0)) % 1e6;
    return { ok: true, status: 200, json: async () => ({ hits: Array.from({ length: 24 }, (_, i) => ({ id: h0 * 100 + i, webformatURL: `https://pixabay.com/get/w${i}.jpg`, largeImageURL: `https://pixabay.com/get/l${i}.jpg`, imageWidth: 1920, imageHeight: 1280, tags: T[i % T.length], user: i === 9 ? 'sameshoot' : 'maker' + h0 + '-' + i, pageURL: 'https://pixabay.com/photos/x-' + i })) }) };
  }
  if (u.startsWith('https://pixabay.com/get/')) { calls.img++; return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => JPG }; }
  throw new Error('unexpected ' + u);
};
const urgent = { siteOf: () => 'https://elitejobsrwanda.com', remote: async (p, o) => {
  const b = JSON.parse(o.body);
  if (p === '/api/hub/media') { stored.push(b); assert.equal(Buffer.from(b.b64, 'base64').length, JPG.length); return { json: async () => ({ url: '/api/media/px' + String(stored.length).padStart(6, '0') }) }; }
  if (p === '/api/hub/fieldpics') { fieldpics = b.map; return { json: async () => ({ ok: true }) }; }
  if (p === '/api/hub/mediaprune') return { json: async () => ({ ok: true, deleted: [] }) };
} };
const acts = [];
const px = require(path.join(__dirname, '..', 'server', 'photos.js'))({ DATA_DIR: D, urgent, appendActivity: a => acts.push(a.what) });
const IT = { id: 'E1', name: 'Ghislain', role: 'it' }, HR = { id: 'E2', name: 'Hana', role: 'hr' };
const throws = async (f, re) => { try { await f(); assert.fail('should refuse'); } catch (e) { assert.match(e.message, re); } };
(async () => {
  await throws(() => px.search(HR, 'waiter african'), /Pixabay key/);
  await throws(() => px.setKey(HR, { key: '123456-abcdefabcdefabcdefabcdef' }), /Only IT or Admin/);
  await throws(() => px.setKey(IT, { key: 'not a key' }), /doesn’t look like a Pixabay key/);
  await throws(() => px.setKey(IT, { key: 'bad-123456-ffffffffffffffffffff'.replace('bad-', '') + 'x' }), /look like/);
  await px.setKey(IT, { key: '12345678-abcdefabcdefabcdefabcdef01' });
  assert.equal(px.status(HR).on, true); assert.equal(px.status(HR).canSet, false); assert.ok(!JSON.stringify(px.status(IT)).includes('abcdef'), 'the key never leaves the server');
  // a job search: up to 6 African people, then up to 4 others — people only, never animals or empty rooms
  const r = await px.jobSearch(HR, 'waiter african');
  assert.equal(r.african, 6); assert.equal(r.others, 4); assert.equal(r.from, 'Pixabay');
  assert.ok(r.items.slice(0, 6).every(x => x.af && /african|black/.test(x.tags) && /man|woman/.test(x.tags)), 'African people first');
  assert.ok(r.items.slice(6).every(x => !x.af && !/african|black/.test(x.tags)), 'then other people');
  assert.ok(!r.items.some(x => /parrot|interior/.test(x.tags)), 'never animals or empty rooms');
  assert.ok(!r.items.some(x => /headwrap/.test(x.tags)), 'never an African person doing something else');
  assert.ok(!r.items.some(x => /figurine/.test(x.tags)), 'never toys or statues');
  assert.ok(!r.items.some(x => /smile, waiter$/.test(x.tags)), 'the job must be one of the first three tags');
  assert.ok(r.items.filter(x => x.by === 'sameshoot').length <= 1, 'one photo per photographer');
  assert.ok(r.items.every(x => /waiter/.test(x.tags)), 'every photo is about the job');
  assert.ok(r.items.filter(x => /waiter/.test(x.tags)).length >= 9, 'about the job first');
  const n = calls.api; await px.jobSearch(HR, 'waiter'); assert.equal(calls.api, n, 'kept 24 hours');
  // choose: downloaded once at card size, stored on our website, the same photo twice is not stored twice
  const u1 = await px.use(HR, r.items[0].id); assert.match(u1.url, /^\/api\/media\/px\d+$/); assert.equal(stored.length, 1);
  const u2 = await px.use(HR, r.items[0].id); assert.equal(u2.url, u1.url); assert.equal(stored.length, 1);
  assert.equal((await px.jobSearch(HR, 'waiter')).items[0].u, u1.url, 'the vault shows it is already ours');
  await throws(() => px.use(HR, 'px999999'), /Search again/);
  // default photos fill in the background, then go to the website
  await throws(() => px.fillDefaults(HR), /Only IT or Admin/);
  const st = px.fillDefaults(IT); assert.equal(st.started, true); assert.equal(px.status(IT).fill.busy, true);
  await throws(() => px.fillDefaults(IT), /already being filled/);
  for (let i = 0; i < 200 && px.status(IT).fill.busy; i++) await new Promise(r => setTimeout(r, 20));
  const f = px.status(IT).fill; assert.equal(f.busy, false); assert.ok(f.last.photos >= 40, 'photos stored: ' + f.last.photos);
  assert.ok(fieldpics['job:waiter'].length === 8 && fieldpics['job:nurse'].length === 8 && fieldpics['field:hospitality'].length >= 5, 'about 5 African + 3 others per job');
  assert.ok(Object.values(fieldpics).flat().every(u => /^\/api\/media\/px\d+$/.test(u)));
  assert.ok(!stored.some(x => /parrot|interior/.test(x.tags)), 'never an animal or an empty room');
  assert.ok(!stored.some(x => /headwrap/.test(x.tags)), 'never an unrelated portrait');
  const all = Object.entries(fieldpics).filter(([k]) => k.startsWith('job:')).flatMap(([, v]) => v); assert.equal(new Set(all).size, all.length, 'no photo used for two jobs');
  assert.ok(acts.some(a => /filled the website's default job photos/.test(a)));
  // IT checks the photos by eye: removes a wrong one (never chosen again), adds a better one (stays first after a refresh)
  await throws(() => px.defaultsList(HR), /Only IT or Admin/);
  const L = await px.defaultsList(IT), g = L.groups.find(x => x.k === 'job:waiter'); assert.equal(g.urls.length, 8);
  const bad = g.urls[2], U = JSON.parse(fs.readFileSync(path.join(D, 'photo-media.json'))), badId = Object.keys(U).find(i => U[i] === bad);
  await throws(() => px.defaultsRemove(HR, { k: 'job:waiter', url: bad }), /Only IT or Admin/);
  const rm = await px.defaultsRemove(IT, { k: 'job:waiter', url: bad }); assert.equal(rm.urls.length, 7); assert.ok(!fieldpics['job:waiter'].includes(bad), 'gone from the website');
  assert.ok(!(await px.jobSearch(HR, 'waiter')).items.some(x => x.id === badId), 'a removed photo is never offered again');
  const pick = (await px.jobSearch(HR, 'nurse')).items[0];
  const ad = await px.defaultsAdd(IT, { k: 'job:waiter', id: pick.id }); assert.equal(ad.urls.length, 8); assert.equal(fieldpics['job:waiter'][0], ad.urls[0], 'added first');
  px.fillDefaults(IT); for (let i = 0; i < 200 && px.status(IT).fill.busy; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(fieldpics['job:waiter'][0], ad.urls[0], 'the photo IT chose stays after a refresh'); assert.ok(!fieldpics['job:waiter'].includes(bad), 'the removed one stays out');
  assert.ok(acts.some(a => /removed a default photo/.test(a)) && acts.some(a => /added a default photo/.test(a)), 'shown in the activity log');
  // older than 24 hours: searched again
  const c = JSON.parse(fs.readFileSync(path.join(D, 'photo-cache.json'))); Object.values(c).forEach(x => x.t -= 25 * 36e5); fs.writeFileSync(path.join(D, 'photo-cache.json'), JSON.stringify(c));
  const m = calls.api; await px.jobSearch(HR, 'waiter'); assert.ok(calls.api > m, 'searched again after 24 hours');
  // new rules: the Hub refreshes once by itself, not again
  assert.equal(px.autoRefresh(), true); for (let i = 0; i < 200 && px.status(IT).fill.busy; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(px.autoRefresh(), false, 'only once');
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
