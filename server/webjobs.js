// Regular (non-urgent) jobs on elitejobsrwanda.com, published from the Hub.
// The website builds its job pages from data/jobs.json in its GitHub repository; the Hub edits that
// file through GitHub's API and Cloudflare rebuilds the site by itself (about a minute).
// Who can publish: the real Admin and anyone Admin gave "Publish" (the same grant as Urgent hiring).
// The GitHub key (fine-grained, Contents read+write on the website repository only) is set by IT and never leaves this server.
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');

const FIELDS = { hospitality: 'Hospitality & food', cleaning: 'Cleaning & household', security: 'Security', 'driving-logistics': 'Driving & logistics', 'it-technology': 'IT & technology',
  finance: 'Finance & accounting', 'sales-marketing': 'Sales & marketing', 'health-care': 'Health & care', 'construction-trades': 'Construction & trades', 'education-childcare': 'Education & childcare',
  'office-admin': 'Office & administration', 'agriculture-environment': 'Agriculture & environment', manufacturing: 'Manufacturing & production', 'tourism-beauty-media': 'Tourism, beauty & media',
  'ngo-public': 'NGO & public service', 'energy-mining': 'Energy, mining & utilities', property: 'Property', 'sports-fitness': 'Sports & fitness', other: 'Other',
  // the website's original groups (older jobs)
  corporate: 'Office', operations: 'Sales & transport' };

module.exports = function makeWebJobs({ DATA_DIR, appendActivity, broadcast, need }) {
  const CFG = path.join(DATA_DIR, 'website-jobs.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const err = (m, code) => Object.assign(new Error(m), { code: code || 400 });
  const cfg = () => Object.assign({ repo: 'ghslainkirabo-beep/ElitejobsRwanda-website', branch: 'main', file: 'data/jobs.json', token: '' }, rj(CFG, {}));
  const API = process.env.HUB_GITHUB_API || 'https://api.github.com'; // tests point this at a fake GitHub

  function gh(method, p, body) {
    const c = cfg(); if (!c.token) throw err('IT hasn’t connected the website jobs yet (IT → System control → Website jobs key).', 412);
    const u = new URL(API + p), lib = u.protocol === 'https:' ? https : http, data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const r = lib.request(u, { method, timeout: 20000, headers: { 'User-Agent': 'Elitejobs-Hub', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + c.token, 'X-GitHub-Api-Version': '2022-11-28', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {}
          if (res.statusCode === 401) return reject(err('The website jobs key was refused by GitHub. IT must paste a new one.', 502));
          if (res.statusCode === 403 || res.statusCode === 404) return reject(err('The website jobs key can’t reach the website repository. Check it has Contents read and write on ' + c.repo + '.', 502));
          if (res.statusCode === 409 || res.statusCode === 422) return reject(err('CONFLICT', 409));
          if (res.statusCode >= 300) return reject(err('GitHub answered ' + res.statusCode + (j && j.message ? ': ' + j.message : ''), 502));
          resolve(j); });
      });
      r.on('timeout', () => r.destroy(new Error('GitHub took too long.'))); r.on('error', e => reject(err('Could not reach GitHub: ' + e.message, 502)));
      if (data) r.write(data); r.end();
    });
  }
  async function read() {
    const c = cfg();
    const j = await gh('GET', `/repos/${c.repo}/contents/${c.file}?ref=${encodeURIComponent(c.branch)}`);
    let jobs; try { jobs = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8')); } catch (e) { throw err('The website job list is damaged.', 502); }
    if (!Array.isArray(jobs)) throw err('The website job list is damaged.', 502);
    return { jobs, sha: j.sha };
  }
  async function write(change, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { jobs, sha } = await read();
      const next = change(jobs.slice());
      const c = cfg();
      try {
        await gh('PUT', `/repos/${c.repo}/contents/${c.file}`, { message, branch: c.branch, sha, content: Buffer.from(JSON.stringify(next, null, 2) + '\n').toString('base64') });
        return next;
      } catch (e) { if (e.message !== 'CONFLICT') throw e; } // someone else saved at the same moment: read again and redo
    }
    throw err('The website job list kept changing. Try again.', 409);
  }

  // ---- checking what people type ----
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = (v, max, n) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => clean(x, n)).filter(Boolean).slice(0, max);
  const slug = t => clean(t, 60).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'job';
  const okImg = u => /^https:\/\/images\.unsplash\.com\/[A-Za-z0-9._~\/?&=%:+-]{1,400}$/.test(u);
  function shape(b, jobs, keepId) {
    const title = clean(b.title, 60); if (title.length < 3) throw err('Give the job a title.');
    const category = String(b.category || ''); if (!FIELDS[category] && category !== 'hospitality') throw err('Choose the field.');
    const summary = clean(b.summary, 140); if (summary.length < 10) throw err('Write one short line about the job (at least 10 letters).');
    const description = clean(b.description, 900); if (description.length < 30) throw err('Describe the job in a few sentences (at least 30 letters).');
    const requirements = lines(b.requirements, 8, 140); if (!requirements.length) throw err('Add at least one thing the person needs.');
    let id = keepId || slug(title); if (!keepId) { let n = 2; const base = id; while (jobs.some(j => j.id === id)) id = base + '-' + n++; }
    const job = { id, title, category, location: clean(b.location, 60) || 'Kigali', summary, description, requirements };
    const image = String(b.image || '').trim(); if (image) { if (!okImg(image)) throw err('Use a photo from the photo vault.'); job.image = image.split('&auto=')[0].split('?auto=')[0]; }
    if (b.gender === 'f' || b.gender === 'm') job.gender = b.gender;
    if (b.salmax !== undefined && b.salmax !== '' && [0, 120000, 150000, 200000, 250000].includes(Number(b.salmax))) job.salmax = Number(b.salmax);   // highest salary range people may pick (0 = no limit)   // only when the employer requires it — shown on the card before anyone applies
    const day = lines(b.day, 8, 140); if (day.length) job.day = day;
    const bring = lines(b.bring, 8, 140); job.bring = bring.length ? bring : ['Your CV', 'A copy of your national ID', 'Certificates or training papers, if you have them'];
    const next = (Array.isArray(b.next) ? b.next : []).map(String).filter(x => x !== id && jobs.some(j => j.id === x)).slice(0, 4); if (next.length) job.next = next;
    return job;
  }

  // ---- what the Hub screens call ----
  async function list(p) {
    const r = { fields: FIELDS, configured: !!cfg().token, canPublish: false };
    try { need(p, 'post'); r.canPublish = true; } catch (e) { if (e.code === 401) throw e; }
    if (!r.configured) return Object.assign(r, { jobs: [] });
    const { jobs } = await read(); return Object.assign(r, { jobs });
  }
  async function save(p, b) {
    need(p, 'post');
    let saved, isNew = !b.id;
    const next = await write(jobs => {
      if (b.id) { const i = jobs.findIndex(j => j.id === b.id); if (i < 0) throw err('That job is no longer on the website.', 404); saved = shape(b, jobs, b.id); jobs[i] = saved; }
      else { saved = shape(b, jobs); jobs.unshift(saved); }
      return jobs;
    }, `Hub: ${p.name} ${isNew ? 'published' : 'updated'} “${clean(b.title, 60)}”`);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: (isNew ? 'published the job ' : 'updated the job ') + saved.title + ' on the website' });
    broadcast({ type: 'webjobs' });
    return { ok: true, job: saved, count: next.length };
  }
  async function close(p, id) {
    need(p, 'post');
    let gone;
    const next = await write(jobs => { gone = jobs.find(j => j.id === id); if (!gone) throw err('That job is no longer on the website.', 404);
      return jobs.filter(j => j.id !== id).map(j => j.next ? Object.assign({}, j, { next: j.next.filter(n => n !== id) }) : j); }, `Hub: ${p.name} closed “${id}”`);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: 'closed the job ' + gone.title + ' on the website (removed)' });
    broadcast({ type: 'webjobs' });
    return { ok: true, count: next.length };
  }
  function setKey(b) {
    const c = rj(CFG, {});
    if (b.token !== undefined) { const t = String(b.token || '').trim(); if (t && !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/.test(t)) throw err('That doesn’t look like a GitHub key (it starts with github_pat_).'); c.token = t; }
    if (b.repo) { if (!/^[\w.-]+\/[\w.-]+$/.test(b.repo)) throw err('Repository looks like owner/name.'); c.repo = b.repo; }
    const t = c.token; fs.writeFileSync(CFG + '.tmp', JSON.stringify(c)); fs.renameSync(CFG + '.tmp', CFG);
    return { configured: !!t, repo: cfg().repo };
  }
  const keyView = () => ({ configured: !!cfg().token, repo: cfg().repo });
  return { list, save, close, setKey, keyView, FIELDS };
};
