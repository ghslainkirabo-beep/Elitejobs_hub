// CV studio — the data behind it.
//  • One person = everyone who applied with the same phone (or the same email): urgent jobs + opening jobs + CVs made at HQ.
//  • Opening a person fills a CV from everything they ever sent us. Staff only add what is missing.
//  • CVs made here are kept with the person, so the next visit opens them again to edit.
//  • Reading text out of an uploaded CV happens here on our own server. Nothing is sent anywhere.
//  • Every person opened, every document read and every CV saved is written to the activity log.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

module.exports = function ({ DATA_DIR, urgent, appendActivity }) {
  const F = n => path.join(DATA_DIR, n);
  const CVS = F('cvs.json'), INQ = F('inquiries.json'), INQ_FILES = F('inquiry-files');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const err = (m, code = 400) => Object.assign(new Error(m), { code });
  // HQ people who serve applicants. Social media and IT don't open applicants' CVs.
  const ROLES = new Set(['front', 'rec', 'hr', 'admin', 'ops', 'cc', 'int']);
  const need = p => { if (!p) throw err('Sign in first.', 401); if (!ROLES.has(p.role)) throw err('The CV studio is for the people who serve applicants.', 403); };
  const log = (p, text) => appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text });

  const digits = v => String(v || '').replace(/\D/g, '');
  const ph9 = v => { const d = digits(v).slice(-9); return d.length === 9 ? d : ''; };
  const low = v => String(v || '').trim().toLowerCase();
  const norm = v => low(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const keyOf = (phone, email, fallback) => ph9(phone) ? 'p' + ph9(phone) : low(email) ? 'e' + low(email) : fallback;
  const fmtPhone = v => { const d = ph9(v); return d ? `+250 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(v || ''); };
  const EDU = { none: 'No formal school', primary: 'Primary school', olevel: 'O-Level (S3)', alevel: 'A-Level (S6)', tvet: 'TVET certificate', diploma: 'Diploma (A1)', bachelor: 'Bachelor’s degree (A0)', master: 'Master’s degree or higher' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ym = s => { const m = /^(\d{4})-(\d{2})$/.exec(String(s || '')); return m ? `${MON[+m[2] - 1]} ${m[1]}` : String(s || ''); };

  // ---------- every record we hold, as one flat list of "sightings" of a person ----------
  function sightings() {
    const out = [];
    for (const a of urgent.allApps()) {
      const d = a.data || {};
      out.push({ src: 'u', id: a.id, t: a.created || a.got, key: keyOf(d.phone, d.email, 'u:' + a.id), name: d.name, phone: d.phone, email: d.email, gender: d.gender,
        born: d.born, place: d.lives, position: d.position || a.title, rec: a });
    }
    for (const x of rj(INQ, [])) {
      if (!x.phone && !x.email) continue;
      out.push({ src: 'i', id: x.id, t: x.created || x.got, key: keyOf(x.phone, x.email, 'i:' + x.id), name: x.name, phone: x.phone, email: x.email, gender: x.gender,
        born: x.born, place: x.live ? [x.live.s, x.live.d].filter(Boolean).join(', ') : '', position: x.title, rec: x });
    }
    for (const c of rj(CVS, { cvs: [] }).cvs) {
      out.push({ src: 'c', id: c.id, t: c.updated, key: c.key, name: c.data && c.data.name, phone: c.data && c.data.phone, email: c.data && c.data.email, place: c.data && c.data.location, position: c.data && c.data.title, rec: c });
    }
    return out;
  }
  // people stitched together: same phone, or same email, is one person
  function people() {
    const S = sightings(), by = new Map(), alias = new Map();
    const root = k => { while (alias.has(k)) k = alias.get(k); return k; };
    for (const s of S) {                                         // an email seen with a phone points to that phone's person
      const e = low(s.email), p = ph9(s.phone);
      if (e && p && !alias.has('e' + e) && 'e' + e !== 'p' + p) alias.set('e' + e, 'p' + p);
    }
    for (const s of S) { const k = root(s.key); s.key = k; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
    return by;
  }
  const latest = (L, f) => { for (const s of [...L].sort((a, b) => (b.t || 0) - (a.t || 0))) { const v = f(s); if (v) return v; } return ''; };
  function card(key, L) {
    const apps = L.filter(s => s.src !== 'c'), cvs = L.filter(s => s.src === 'c');
    return { key, name: latest(L, s => s.name) || 'Unnamed', phone: fmtPhone(latest(L, s => s.phone)), email: latest(L, s => low(s.email)), gender: latest(L, s => s.gender),
      place: latest(L, s => s.place), positions: [...new Set(apps.map(s => String(s.position || '').trim()).filter(Boolean))].slice(0, 4),
      applied: apps.length, cvs: cvs.length, last: Math.max(0, ...L.map(s => s.t || 0)),
      docs: apps.reduce((n, s) => n + (s.src === 'u' ? Object.keys(s.rec.docs || {}).length : (s.rec.files || []).filter(f => f.k === 'cv' || f.k === 'cert').length), 0) };
  }

  // ---------- search: by name, email or phone ----------
  function search(p, q) {
    need(p);
    const t = norm(q), d = digits(q);
    if (t.length < 2) return { people: [] };
    const out = [];
    for (const [key, L] of people()) {
      const hit = L.some(s => norm(s.name).includes(t) || (t.includes('@') ? low(s.email) === t || low(s.email).startsWith(t) : low(s.email).includes(t)) || (d.length >= 4 && digits(s.phone).includes(d.replace(/^0/, '').replace(/^250/, ''))));
      if (hit) out.push(card(key, L));
    }
    out.sort((a, b) => { const sa = norm(a.name).startsWith(t) ? 1 : 0, sb = norm(b.name).startsWith(t) ? 1 : 0; return sb - sa || b.last - a.last; });
    return { people: out.slice(0, 24) };
  }

  // ---------- open one person: everything we know, already shaped as a CV ----------
  function person(p, key) {
    need(p);
    const L = people().get(String(key || ''));
    if (!L) throw err('This person isn’t in our records any more.', 404);
    const c = card(key, L), apps = L.filter(s => s.src !== 'c').sort((a, b) => (b.t || 0) - (a.t || 0));
    const exp = [], seen = new Set(), add = e => { const k = norm(e.org) + '|' + norm(e.role); if (!e.org || seen.has(k)) return; seen.add(k); exp.push(e); };
    const edu = [], langs = new Set(); let summary = '', title = '';
    for (const s of apps) {
      const r = s.rec;
      if (!title && s.position) title = String(s.position).trim();
      if (s.src === 'i') {
        (r.exp || []).forEach(x => add({ role: x.role || '', org: x.at || '', place: '', from: ym(x.from), to: x.now ? 'Now' : ym(x.to), about: '', points: [], from_src: 'Opening-job application' }));
        if (r.edu && r.edu !== 'none' && !edu.some(e => e.title === EDU[r.edu])) edu.push({ title: EDU[r.edu] || r.edu, school: r.school || '', from: '', to: '' });
      } else {
        const d = r.data || {};
        if (d.lastJob) add({ role: d.position || '', org: d.lastJob, place: '', from: '', to: '', about: d.experience && d.experience !== 'None yet' ? `Experience in this work: ${d.experience}` : '', points: [], from_src: 'Urgent-job application' });
        if (d.education && !edu.some(e => norm(e.title).includes(norm(d.education)))) edu.push({ title: d.education, school: '', from: '', to: '' });
        String(d.languages || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => langs.add(x));
        if (!summary && d.about) summary = d.about;
      }
    }
    const docs = [];
    for (const s of apps) {
      if (s.src === 'u') Object.entries(s.rec.docs || {}).forEach(([k, n]) => docs.push({ ref: `u:${s.id}:${k}`, label: (k === 'cv' ? 'CV' : 'Diploma') + ' · ' + (s.position || 'urgent job'), t: s.t, ext: path.extname(n).slice(1) }));
      else (s.rec.files || []).filter(f => f.k === 'cv' || f.k === 'cert').forEach(f => docs.push({ ref: `i:${s.id}:${f.k}`, label: (f.k === 'cv' ? 'CV' : 'Certificate') + ' · ' + (s.position || 'application'), t: s.t, ext: path.extname(f.file).slice(1), name: f.name }));
    }
    const photos = [];
    for (const s of apps) {
      if (s.src === 'u' && (s.rec.photos || [])[0]) photos.push({ ref: `u:${s.id}:0`, t: s.t });
      if (s.src === 'i') (s.rec.files || []).filter(f => /^p[0-2]$/.test(f.k)).forEach(f => photos.push({ ref: `i:${s.id}:${f.k}`, t: s.t }));
    }
    const fill = { name: c.name, title, phone: c.phone, email: c.email, location: c.place, summary, experience: exp.slice(0, 6), education: edu.slice(0, 4),
      skills: [], languages: [...langs].map(n => ({ name: n, level: /kinyarwanda/i.test(n) ? 'Native' : 'Good' })), certificates: [], references: [] };
    const cvs = L.filter(s => s.src === 'c').map(s => s.rec).sort((a, b) => b.updated - a.updated);
    log(p, `opened ${c.name} in the CV studio`);
    return { card: c, fill, docs: docs.slice(0, 12), photos: photos.slice(0, 6),
      applications: apps.slice(0, 20).map(s => ({ src: s.src, position: s.position, t: s.t })), cvs };
  }

  // ---------- a document or photo a person sent us ----------
  function fileOf(ref) {
    const [src, id, k] = String(ref || '').split(':');
    if (src === 'u') {
      const a = urgent.allApps().find(x => x.id === id); if (!a) return null;
      const n = /^[0-2]$/.test(k) ? (a.photos || [])[+k] : (a.docs || {})[k];
      return n ? { file: urgent.filePath(n), who: (a.data || {}).name, kind: k } : null;
    }
    if (src === 'i') {
      const x = rj(INQ, []).find(y => y.id === id); if (!x) return null;
      const f = (x.files || []).find(y => y.k === k); if (!f) return null;
      return { file: path.join(INQ_FILES, String(x.id).replace(/[^\w-]/g, ''), path.basename(f.file)), who: x.name, kind: k };
    }
    return null;
  }
  const TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  function raw(p, ref) {
    need(p);
    const f = fileOf(ref); if (!f || !fs.existsSync(f.file)) throw err('That file isn’t available any more.', 404);
    if (!/^[0-2]$|^p[0-2]$/.test(f.kind)) log(p, `opened the ${f.kind === 'cv' ? 'CV' : 'diploma/certificate'} of ${String(f.who || 'an applicant').slice(0, 60)} in the CV studio`);
    return { file: f.file, type: TYPES[path.extname(f.file).slice(1).toLowerCase()] || 'application/octet-stream' };
  }

  // ---------- reading the words out of a PDF or Word CV (on this server only) ----------
  function docxText(buf) {                                     // a .docx is a zip; we only need word/document.xml
    let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw err('This Word file looks damaged.');
    let off = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < n; i++) {
      const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lo = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + nl);
      if (name === 'word/document.xml') {
        const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), data = buf.subarray(start, start + csize);
        const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
        return xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br[^>]*\/>/g, '\n').replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      }
      off += 46 + nl + xl + cl;
    }
    throw err('No text found in this Word file.');
  }
  async function pdfText(buf) {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n');
  }
  // headings people use in CVs → which part of our CV they belong to
  const HEADS = [['skills', /^(key |core |technical |professional )?(skills|competenc(e|ies)|abilities|strengths)\b/i], ['languages', /^languages?\b/i],
    ['references', /^(references?|referees?)\b/i], ['certificates', /^(certificat(e|es|ions)|trainings?|courses?)\b/i],
    ['experience', /^(work |professional |employment )?(experience|history|employment)\b/i], ['education', /^(education|academic|qualifications?)\b/i],
    ['summary', /^(profile|summary|about( me)?|objective|career objective|personal statement)\b/i], ['other', /^(personal (details|information)|hobbies|interests|contacts?)\b/i]];
  function shape(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/[•●▪■◦•]/g, '').replace(/\s+/g, ' ').trim()).filter(l => l.length > 1).slice(0, 400);
    const parts = {}; let cur = 'top';
    for (const l of lines) {
      const h = l.length < 40 && HEADS.find(([, re]) => re.test(l.replace(/[:\-–]+$/, '').trim()));
      if (h) { cur = h[0]; continue; }
      (parts[cur] = parts[cur] || []).push(l);
    }
    const split = a => (a || []).flatMap(l => l.split(/\s*[,;|]\s*/)).map(x => x.trim()).filter(x => x.length > 1 && x.length < 50);
    return { lines, sections: { summary: (parts.summary || []).join(' ').slice(0, 900), skills: split(parts.skills).slice(0, 16), languages: split(parts.languages).slice(0, 8),
      certificates: (parts.certificates || []).slice(0, 8), references: (parts.references || []).slice(0, 12), experience: (parts.experience || []).slice(0, 40), education: (parts.education || []).slice(0, 16) },
      email: (String(text).match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i) || [''])[0] };
  }
  async function read(p, ref) {
    need(p);
    const f = fileOf(ref); if (!f || !fs.existsSync(f.file)) throw err('That file isn’t available any more.', 404);
    const ext = path.extname(f.file).slice(1).toLowerCase(), buf = fs.readFileSync(f.file);
    log(p, `read the text of the ${f.kind === 'cv' ? 'CV' : 'certificate'} of ${String(f.who || 'an applicant').slice(0, 60)} in the CV studio`);
    if (ext === 'pdf') { const t = await pdfText(buf).catch(() => ''); if (t.replace(/\s/g, '').length < 40) return { image: true, why: 'This PDF is a scan (a picture of paper), so there are no words to read. Open it and type what you need.' }; return shape(t); }
    if (ext === 'docx') return shape(docxText(buf));
    if (ext === 'doc') return { image: true, why: 'Old Word files (.doc) can’t be read here. Open it and type what you need.' };
    return { image: true, why: 'This is a photo of the CV, so there are no words to read. Open it and type what you need.' };
  }

  // ---------- saving the CVs we make ----------
  const TPLS = new Set(['horizon', 'sand', 'bento', 'halo', 'stone', 'dune', 'ink']), FIN = new Set(['starlight', 'midnight', 'titanium', 'sage']);
  const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const list = (a, max, fn) => (Array.isArray(a) ? a : []).slice(0, max).map(fn).filter(Boolean);
  function cleanData(d) {
    d = d || {};
    const photo = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(d.photo || '')) && String(d.photo).length < 120000 ? d.photo : '';
    return { name: s(d.name, 60), title: s(d.title, 70), phone: s(d.phone, 30), email: s(d.email, 100), location: s(d.location, 70), summary: s(d.summary, 900), photo,
      experience: list(d.experience, 6, e => (s(e.role, 70) || s(e.org, 80)) && { role: s(e.role, 70), org: s(e.org, 80), place: s(e.place, 50), from: s(e.from, 20), to: s(e.to, 20), about: s(e.about, 220), points: list(e.points, 5, x => s(x, 160)) }),
      education: list(d.education, 5, e => s(e.title, 90) && { title: s(e.title, 90), school: s(e.school, 90), from: s(e.from, 20), to: s(e.to, 20) }),
      skills: list(d.skills, 14, x => s(x, 40)), certificates: list(d.certificates, 6, x => s(x, 100)),
      languages: list(d.languages, 6, l => s(l.name, 30) && { name: s(l.name, 30), level: ['Native', 'Fluent', 'Good', 'Basic'].includes(l.level) ? l.level : 'Good' }),
      references: list(d.references, 2, r => s(r.name, 60) && { name: s(r.name, 60), role: s(r.role, 80), phone: s(r.phone, 30) }) };
  }
  function save(p, b) {
    need(p);
    const data = cleanData(b.data); if (data.name.length < 3) throw err('Write the person’s full name.');
    if (!ph9(data.phone) && !low(data.email)) throw err('Add a phone number or an email, so we can find this CV again.');
    const db = rj(CVS, { cvs: [] }), now = Date.now();
    const tpl = TPLS.has(b.tpl) ? b.tpl : 'horizon', finish = FIN.has(b.finish) ? b.finish : 'starlight';
    let c = b.id && db.cvs.find(x => x.id === b.id);
    const key = b.key && people().has(b.key) ? b.key : keyOf(data.phone, data.email, 'c:' + now);
    if (c) { Object.assign(c, { data, tpl, finish, updated: now, key: c.key || key }); c.history = (c.history || []).concat({ by: p.name, t: now }).slice(-20); }
    else { c = { id: 'CV-' + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(), key, data, tpl, finish, by: p.name, byId: p.id, created: now, updated: now, history: [{ by: p.name, t: now }] }; db.cvs.push(c); }
    wj(CVS, db);
    log(p, `${c.created === now ? 'made' : 'updated'} a CV for ${data.name} (${tpl}, ${finish})`);
    return { ok: true, cv: c };
  }
  function remove(p, id) {
    need(p);
    const db = rj(CVS, { cvs: [] }), c = db.cvs.find(x => x.id === id);
    if (!c) throw err('This CV was already removed.', 404);
    if (c.byId !== p.id && p.role !== 'admin') throw err('Only the person who made this CV, or Admin, can remove it.', 403);
    db.cvs = db.cvs.filter(x => x.id !== id); wj(CVS, db);
    log(p, `removed the CV of ${c.data.name}`);
    return { ok: true };
  }
  return { search, person, raw, read, save, remove, ROLES };
};
