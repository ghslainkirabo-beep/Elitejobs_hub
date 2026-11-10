// Elitejobs Hub — attendance (QR), staff reports, and security alerts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
let QR = null; try { QR = require('qrcode'); } catch (e) {}

module.exports = function makeOffice(ctx) {
  const { DATA_DIR, loadState, commit, broadcast, activity, appendActivity, ai, PORT } = ctx;
  const ATT = path.join(DATA_DIR, 'attendance.json');
  const DEV = path.join(DATA_DIR, 'devices.json');
  const ACFG = path.join(DATA_DIR, 'attendance-settings.json');
  const REP = path.join(DATA_DIR, 'reports.jsonl');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const wj = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const tok = n => crypto.randomBytes(n).toString('base64url');
  const err = (m, code) => Object.assign(new Error(m), { code });
  const pad = n => String(n).padStart(2, '0');
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  // ---------------- settings ----------------
  function cfg() {
    const c = rj(ACFG, {}); let ch = false;
    if (!c.wall) { c.wall = tok(12); ch = true; }
    if (!/^\d\d:\d\d$/.test(c.start || '') || (c.start === '08:00' && !c.startSet)) { c.start = '09:10'; ch = true; } // late after 09:10 unless Admin chose another time
    if (c.officeOnly === undefined) { c.officeOnly = true; ch = true; }
    if (ch) wj(ACFG, c);
    return c;
  }
  function setCfg(b, req) {
    const c = cfg();
    // cloud: remember the internet address of the office (the one this request comes from)
    if (b.officeHere && req) { const ip = ipOf(req); c.officeIps = [ip].concat((c.officeIps || []).filter(x => x !== ip)).slice(0, 5); }
    if (b.officeClear) c.officeIps = [];
    if (/^\d\d:\d\d$/.test(b.start || '')) { c.start = b.start; c.startSet = true; }
    if (typeof b.officeOnly === 'boolean') c.officeOnly = b.officeOnly;
    if (typeof b.base === 'string') { const v = b.base.trim().replace(/\/+$/, ''); if (v && !/^https?:\/\/[\w.\-]+(:\d+)?$/.test(v)) throw err('Use an address like http://192.168.1.23:8787'); c.base = v; }
    wj(ACFG, c); return publicCfg();
  }
  function rotate() { const c = cfg(); c.wall = tok(12); c.rotated = Date.now(); wj(ACFG, c); return publicCfg(); }

  // ---------------- network: is this request from inside the office? ----------------
  // In the cloud the server sits behind Cloudflare, so the caller's real address comes from the server (ctx.ipOf).
  const ipOf = ctx.ipOf || (req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
  const CLOUD = process.env.HUB_CLOUD === '1';
  const extra = (process.env.HUB_OFFICE_PREFIX || '').split(',').filter(Boolean);
  function isOffice(ip) {
    // Cloud: the office is recognised by its internet address (set by Admin: “This is the office”).
    if (CLOUD) return (cfg().officeIps || []).includes(ip);
    if (ip === '127.0.0.1' || ip === '::1') return true;
    if (extra.some(p => ip.startsWith(p))) return true;
    const p = ip.split('.').map(Number);
    if (p.length !== 4) return /^(fc|fd|fe80)/i.test(ip);
    // 10.x, 172.16-31.x, 192.168.x — private office networks. (100.64.x = Tailscale/home: NOT office.)
    return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
  }
  function lanAddresses() {
    const all = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push(a.address);
    const priv = all.filter(isOffice);
    return priv.length ? priv : all;
  }
  const base = () => cfg().base || process.env.HUB_PUBLIC_URL || ('http://' + (lanAddresses()[0] || '127.0.0.1') + ':' + PORT);
  const wallUrl = () => base() + '/checkin?w=' + cfg().wall;
  function publicCfg() { const c = cfg(); return { start: c.start, officeOnly: c.officeOnly, base: c.base || '', address: base(), rotated: c.rotated || null, addresses: lanAddresses(), cloud: CLOUD, officeIps: c.officeIps || [] }; }

  // ---------------- security alerts ----------------
  const recent = new Map();
  function secEvent(text, targets) {
    const k = text.replace(/\d+:\d+/g, '');
    if (recent.has(k) && Date.now() - recent.get(k) < 10 * 6e4) return;
    recent.set(k, Date.now());
    const s = loadState(); if (!s) return;
    const t = Date.now();
    s.sec = [{ t, text }].concat(s.sec || []).slice(0, 100);
    (targets || ['admin', 'it']).forEach(r => { s.notifs = [{ r, text: '🛡 ' + text, t, read: false, from: 'hub' }].concat(s.notifs || []).slice(0, 200); });
    s.rev = (s.rev || 0) + 1; commit(s);
  }
  function hubNote(targets, text) {
    const s = loadState(); if (!s) return; const t = Date.now();
    [].concat(targets).forEach(r => { s.notifs = [{ r, text, t, read: false, from: 'hub' }].concat(s.notifs || []).slice(0, 200); });
    s.rev = (s.rev || 0) + 1; commit(s);
  }

  // ---------------- phones: each colleague links their own phone, from their own app ----------------
  const linkCodes = new Map();
  const staffById = id => { const s = loadState(); return s && (s.staff || []).find(x => x.id === id); };
  function makeLink(uid) {
    const p = staffById(uid);
    if (!p) throw err('Sign in first.');
    if (p.on === false) throw err('Your access is suspended.');
    for (const [k, v] of linkCodes) if (v.uid === uid || v.exp < Date.now()) linkCodes.delete(k);
    const code = tok(9); linkCodes.set(code, { uid, exp: Date.now() + 10 * 6e4 });
    return { url: base() + '/link?c=' + code, expires: Date.now() + 10 * 6e4 };
  }
  function link(code, ua) {
    const L = linkCodes.get(code);
    if (!L || L.exp < Date.now()) throw err('This link has expired. Open “My attendance” in the Hub app on your computer and scan the new code.');
    linkCodes.delete(code);
    const p = staffById(L.uid); if (!p) throw err('That person is no longer in the system.');
    const devs = rj(DEV, {});
    for (const [k, v] of Object.entries(devs)) if (v.uid === p.id) delete devs[k]; // one phone per person
    const t = tok(24); devs[t] = { uid: p.id, at: Date.now(), ua: String(ua || '').slice(0, 140) };
    wj(DEV, devs);
    appendActivity({ t: Date.now(), by: p.name, uid: p.id, role: p.role, text: 'linked a phone for attendance' });
    return { token: t, name: p.name, id: p.id, dept: p.dept };
  }
  const TITLES = ['Mr', 'Ms', 'Mrs', 'Miss', 'Dr'];
  function setTitle(dev, title) {
    const devs = rj(DEV, {}); if (!devs[dev]) throw err('This phone isn’t linked.', 'NOT_LINKED');
    devs[dev].title = TITLES.includes(title) ? title : ''; wj(DEV, devs); return { ok: true, title: devs[dev].title };
  }
  function whoami(dev) { const d = rj(DEV, {})[dev]; const p = d && staffById(d.uid); return p ? { name: p.name, id: p.id, dept: p.dept } : null; }
  const linkedIds = () => new Set(Object.values(rj(DEV, {})).map(d => d.uid));
  function unlink(uid) { const devs = rj(DEV, {}); for (const [k, v] of Object.entries(devs)) if (v.uid === uid) delete devs[k]; wj(DEV, devs); return { ok: true }; }

  // ---------------- the wall QR scan ----------------
  function scan(b, req) {
    const c = cfg(), ip = ipOf(req);
    if (!b.wall || b.wall !== c.wall) { secEvent('Attendance scan with an old or wrong QR code (from ' + ip + ').'); throw err('This QR code is no longer valid. Ask Admin for the current one.', 'OLD_QR'); }
    if (c.officeOnly && !isOffice(ip)) { secEvent('Attendance scan from outside the office network (' + ip + ') was refused.'); throw err('Check-in only works on the office Wi-Fi. Connect to it, then scan again.', 'OFFSITE'); }
    const d = rj(DEV, {})[b.dev];
    const p = d && staffById(d.uid);
    if (!p) { secEvent('Attendance scan from a phone that isn’t linked to anyone (' + ip + ') was refused.'); throw err('This phone isn’t linked to anyone in the system.', 'NOT_LINKED'); }
    if (p.on === false) { secEvent(p.name + ' tried to check in while their access is suspended.'); throw err('Your access is suspended. Please speak to Admin.', 'SUSPENDED'); }
    const now = Date.now(), day = dayKey(now), att = rj(ATT, {});
    att[day] = att[day] || {};
    let r = att[day][p.id], kind;
    if (!r) {
      // Early = at or before the "late after" time (default 09:10). From the next minute on, late.
      const [h, m] = c.start.split(':').map(Number), st = new Date(now); st.setHours(h, m, 0, 0);
      const lateMin = Math.floor((now - st.getTime()) / 6e4);
      r = { uid: p.id, name: p.name, role: p.role, dept: p.dept, in: now, late: lateMin >= 1 ? lateMin : 0 };
      att[day][p.id] = r; kind = 'in';
    } else if (now - (r.out || r.in) < 2 * 6e4) {
      return { kind: 'repeat', name: p.name, title: d.title || '', time: r.out || r.in, record: r };
    } else { r.out = now; kind = 'out'; }
    wj(ATT, att);
    appendActivity({ t: now, by: p.name, uid: p.id, role: p.role, text: kind === 'in' ? 'checked in at ' + hm(now) + (r.late ? ' (' + r.late + ' min late)' : '') : 'checked out at ' + hm(now) });
    broadcast({ type: 'att', day, records: Object.values(att[day]) });
    const again = Object.keys(att).some(k => k !== day && att[k][p.id]);
    return { kind, name: p.name, title: d.title || '', again, lateAfter: c.start, time: now, late: r.late, record: r };
  }
  function dayView(day) {
    const recs = Object.values((rj(ATT, {})[day]) || {});
    const s = loadState() || { staff: [] }, linked = linkedIds();
    return { day, today: dayKey(Date.now()), settings: publicCfg(), records: recs, staff: (s.staff || []).map(p => ({ id: p.id, name: p.name, role: p.role, dept: p.dept, on: p.on !== false, linked: linked.has(p.id) })) };
  }
  function mine(uid) {
    const att = rj(ATT, {}), out = [];
    Object.keys(att).sort().reverse().slice(0, 60).forEach(d => { if (att[d][uid]) out.push(Object.assign({ day: d }, att[d][uid])); });
    return { linked: linkedIds().has(uid), days: out.slice(0, 30), start: cfg().start };
  }
  async function svg(text, opt) {
    if (!QR) throw err('The QR library is missing from this install.');
    return QR.toString(text, Object.assign({ type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }, opt || {}));
  }
  const LOGO_SVG = '<svg viewBox="-150 -150 300 300" width="90" height="90"><defs><linearGradient id="ejp" x1="0" y1="0" x2="1" y2=".7"><stop offset="0" stop-color="#8e8e98"/><stop offset=".55" stop-color="#d9d9df"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><circle r="142.5" fill="#5b489d"/><path fill="#fff" fill-rule="evenodd" d="M1.7,95.2C0.8,95.0 -6.1,94.7 -8.5,94.7C-10.2,94.7 -12.2,94.3 -13.3,93.8C-13.7,93.6 -14.5,93.4 -15.1,93.3C-17.4,93.0 -20.3,92.2 -24.2,90.9C-25.0,90.7 -26.1,90.3 -26.8,90.2C-28.4,89.7 -31.0,88.6 -32.7,87.7C-33.5,87.2 -34.7,86.7 -35.4,86.4C-36.2,86.2 -37.3,85.6 -38.2,85.1C-39.0,84.6 -39.7,84.2 -39.8,84.2C-39.9,84.2 -40.3,83.9 -40.8,83.6C-41.2,83.3 -42.2,82.8 -42.9,82.4C-45.3,81.2 -46.9,80.2 -48.1,79.4C-48.7,79.0 -49.6,78.4 -50.0,78.1C-50.4,77.8 -51.1,77.3 -51.5,77.0C-51.9,76.6 -52.3,76.3 -52.4,76.3C-53.1,76.3 -54.5,75.4 -55.7,74.1C-56.5,73.4 -57.5,72.5 -58.0,72.2C-58.4,71.8 -59.2,71.1 -59.7,70.5C-60.1,69.9 -60.8,69.2 -61.1,68.9C-61.5,68.6 -61.9,68.3 -62.0,68.1C-62.2,67.7 -64.5,65.4 -67.6,62.3C-69.2,60.8 -69.6,60.2 -72.0,57.1C-73.5,55.1 -74.0,54.3 -74.8,52.6C-75.2,51.8 -75.9,50.8 -76.3,50.3C-77.2,49.4 -77.6,48.7 -78.1,47.4C-78.3,46.9 -78.7,46.2 -79.0,45.9C-79.2,45.5 -79.6,44.8 -79.8,44.3C-80.0,43.7 -80.5,42.7 -81.0,42.0C-81.5,41.3 -82.0,40.3 -82.1,39.8C-82.3,39.3 -82.6,38.5 -82.9,38.0C-83.3,37.1 -84.7,32.8 -84.9,31.8C-85.0,31.5 -85.2,30.9 -85.5,30.5C-85.7,30.1 -86.0,29.3 -86.1,28.8C-86.4,27.2 -86.9,25.4 -87.4,24.2C-87.7,23.4 -87.9,22.6 -88.0,21.4C-88.2,18.4 -89.3,16.9 -91.9,15.6C-92.8,15.2 -93.9,14.5 -94.4,14.1C-94.9,13.7 -95.8,13.1 -96.5,12.8C-97.2,12.5 -98.3,11.8 -98.9,11.4C-99.4,10.9 -100.4,10.2 -101.0,9.8C-101.6,9.5 -102.3,8.9 -102.7,8.6C-103.0,8.3 -103.8,7.8 -104.4,7.4C-105.1,7.1 -105.9,6.6 -106.2,6.3C-108.2,4.5 -109.5,3.2 -112.2,0.0C-112.5,-0.3 -113.5,-1.1 -114.3,-1.8C-116.0,-3.2 -117.5,-4.6 -121.2,-8.5C-124.2,-11.7 -124.6,-12.1 -125.2,-13.6C-126.0,-15.1 -127.7,-17.8 -128.9,-19.2C-129.5,-19.8 -130.1,-20.8 -130.5,-21.7C-130.9,-22.4 -131.5,-23.5 -131.9,-24.0C-132.3,-24.5 -133.0,-25.6 -133.4,-26.4C-133.8,-27.2 -134.4,-28.2 -134.6,-28.5C-134.9,-28.9 -135.3,-29.6 -135.4,-30.2C-136.0,-32.2 -136.4,-32.8 -137.5,-32.9L-138.0,-32.9L-137.3,-35.4C-127.9,-71.4 -104.6,-102.7 -73.0,-121.5C-71.8,-122.3 -70.5,-123.0 -70.2,-123.2C-69.3,-123.8 -69.6,-123.4 -71.0,-122.4C-71.7,-121.9 -72.3,-121.4 -72.3,-121.3C-72.4,-121.3 -72.8,-121.0 -73.2,-120.6C-73.7,-120.3 -74.3,-119.8 -74.7,-119.5C-75.0,-119.2 -75.7,-118.7 -76.3,-118.3C-76.9,-118.0 -77.9,-117.2 -78.6,-116.5C-79.2,-115.8 -80.2,-115.0 -80.8,-114.6C-82.6,-113.2 -86.0,-109.7 -86.6,-108.5C-86.9,-108.0 -87.5,-107.2 -87.9,-106.8C-88.2,-106.4 -88.8,-105.8 -89.1,-105.4C-89.3,-105.1 -90.0,-104.3 -90.5,-103.8C-91.0,-103.3 -91.9,-102.2 -92.4,-101.3C-92.9,-100.4 -93.6,-99.4 -93.9,-99.0C-94.6,-98.3 -96.5,-94.5 -96.9,-93.2C-97.0,-92.9 -97.4,-92.1 -97.8,-91.3C-98.5,-89.9 -98.9,-88.7 -99.2,-86.3C-99.4,-85.3 -99.6,-84.7 -100.0,-84.1C-100.3,-83.6 -100.5,-83.0 -100.6,-82.4C-100.6,-81.8 -100.8,-80.8 -100.9,-80.0C-101.2,-78.3 -101.3,-66.4 -101.0,-64.5C-100.6,-61.3 -100.1,-59.3 -99.7,-58.3C-99.1,-57.2 -98.7,-55.5 -98.7,-54.8C-98.7,-54.6 -98.4,-54.0 -98.2,-53.4C-97.9,-52.8 -97.6,-52.0 -97.5,-51.5C-97.2,-50.2 -96.9,-49.5 -96.2,-48.3C-95.8,-47.8 -95.4,-47.0 -95.3,-46.7C-94.9,-45.5 -94.3,-44.4 -93.6,-43.8C-92.2,-42.6 -92.3,-42.7 -90.4,-39.7C-90.2,-39.3 -89.7,-38.6 -89.3,-38.2C-88.9,-37.8 -88.1,-36.8 -87.7,-36.0C-86.1,-33.5 -84.9,-33.2 -83.0,-34.8C-82.1,-35.5 -81.5,-36.6 -81.2,-38.0C-80.9,-39.0 -80.2,-40.4 -77.7,-45.1C-77.4,-45.8 -76.9,-46.8 -76.8,-47.2C-76.6,-47.6 -76.1,-48.4 -75.7,-48.8C-75.3,-49.3 -74.9,-49.9 -74.7,-50.2C-74.6,-50.5 -74.1,-51.2 -73.7,-51.7C-73.2,-52.2 -72.6,-53.1 -72.3,-53.7C-71.8,-54.7 -71.1,-55.4 -68.0,-58.8C-66.6,-60.4 -66.3,-60.7 -63.9,-63.0C-62.9,-63.9 -61.6,-65.3 -61.0,-66.1C-60.4,-66.9 -59.6,-67.8 -59.2,-68.2C-58.9,-68.5 -58.1,-69.3 -57.4,-69.9C-56.8,-70.6 -55.9,-71.4 -55.4,-71.7C-55.0,-72.0 -54.2,-72.7 -53.6,-73.2C-52.7,-74.2 -51.9,-74.8 -49.0,-76.4C-47.9,-77.0 -47.4,-77.4 -47.0,-77.9C-46.7,-78.4 -46.1,-78.8 -45.2,-79.3C-44.4,-79.7 -43.8,-80.1 -43.8,-80.2C-43.7,-80.2 -43.1,-80.5 -42.3,-80.8C-41.5,-81.1 -40.4,-81.7 -39.7,-82.1C-39.1,-82.5 -38.3,-82.9 -37.9,-83.1C-37.5,-83.3 -36.8,-83.7 -36.3,-84.1C-35.8,-84.5 -35.0,-84.9 -34.6,-85.1C-34.1,-85.2 -33.3,-85.6 -32.7,-85.9C-32.2,-86.2 -31.2,-86.7 -30.6,-86.8C-29.9,-87.0 -28.3,-87.7 -26.9,-88.4C-24.9,-89.4 -24.2,-89.7 -23.2,-89.8C-22.4,-89.9 -21.4,-90.3 -20.7,-90.6C-19.4,-91.1 -16.5,-91.9 -14.9,-92.1C-14.4,-92.1 -13.6,-92.3 -13.3,-92.5C-12.9,-92.7 -12.0,-92.9 -11.2,-93.1C-10.5,-93.2 -9.7,-93.4 -9.3,-93.5C-7.7,-93.9 -5.1,-94.0 4.3,-94.0C16.5,-94.0 20.1,-93.9 20.7,-93.7C20.9,-93.6 21.6,-93.4 22.2,-93.3C22.8,-93.2 23.7,-93.0 24.3,-92.8C24.9,-92.7 26.8,-92.2 28.6,-91.8C30.5,-91.4 32.0,-91.0 32.4,-90.8C33.1,-90.4 36.2,-89.3 37.7,-89.0C38.2,-88.9 39.2,-88.5 39.9,-88.2C40.6,-87.8 41.5,-87.5 41.8,-87.4C42.4,-87.3 44.1,-86.4 44.5,-86.1C44.6,-86.0 45.3,-85.5 46.1,-85.2C48.6,-83.8 49.7,-83.2 50.3,-82.6C51.3,-81.7 51.9,-81.3 53.5,-80.6C54.3,-80.2 55.1,-79.8 55.2,-79.6C55.4,-79.5 55.9,-79.2 56.3,-79.0C57.4,-78.4 60.1,-75.9 60.7,-75.0C60.9,-74.7 61.3,-74.3 61.6,-74.1C62.2,-73.7 64.2,-71.4 65.0,-70.0C65.3,-69.6 65.9,-68.9 66.3,-68.6C66.7,-68.2 67.5,-67.4 68.1,-66.8C68.6,-66.1 69.4,-65.3 69.8,-64.8C70.2,-64.4 70.8,-63.5 71.3,-62.9C71.7,-62.3 72.1,-61.7 72.2,-61.7C72.3,-61.6 72.6,-60.9 73.0,-60.0C73.4,-59.2 74.0,-57.9 74.4,-57.2C75.1,-56.0 75.4,-55.3 76.3,-53.1C76.5,-52.6 76.8,-51.7 76.9,-51.1C77.3,-49.2 78.1,-46.5 78.3,-46.3C78.4,-46.2 78.6,-45.7 78.8,-45.2C79.2,-44.1 79.1,-24.5 78.7,-23.4C78.0,-21.5 77.1,-18.8 76.8,-17.5C76.7,-16.7 76.4,-15.7 76.2,-15.3C76.0,-14.9 75.7,-14.2 75.5,-13.7C75.3,-13.2 74.8,-12.1 74.3,-11.2C73.8,-10.3 73.2,-9.2 73.1,-8.8C72.9,-8.3 72.4,-7.6 72.0,-7.2C71.6,-6.7 71.0,-5.8 70.7,-5.1C70.3,-4.3 69.7,-3.4 69.4,-3.0C69.0,-2.6 68.5,-1.8 68.3,-1.3C67.9,-0.6 67.6,-0.2 66.8,0.5C66.2,1.0 64.8,2.3 63.8,3.6C62.7,4.8 61.3,6.3 60.5,7.0C59.8,7.7 59.0,8.6 58.7,9.0C58.1,9.9 57.8,10.2 56.8,10.7C56.3,11.0 55.6,11.5 55.2,11.9C54.7,12.3 53.8,12.9 52.8,13.4C52.0,13.8 51.0,14.4 50.7,14.7C49.8,15.6 47.7,16.9 46.2,17.4C45.0,17.9 44.1,18.5 43.1,19.4C42.6,19.8 40.0,21.1 38.9,21.5C38.4,21.7 37.3,22.2 36.5,22.6C35.7,23.0 34.6,23.5 34.0,23.7C33.5,23.9 32.6,24.2 32.2,24.5C31.8,24.8 31.3,25.0 31.1,25.0C31.0,25.0 30.1,25.3 29.1,25.6C28.2,25.9 26.9,26.3 26.3,26.4C25.7,26.6 24.9,26.9 24.4,27.2C23.9,27.4 23.1,27.7 22.3,27.8C20.1,28.2 17.7,28.8 14.0,30.2C13.2,30.4 12.6,30.5 10.8,30.5C8.4,30.5 6.5,30.9 5.0,31.6C3.4,32.4 2.0,32.5 -3.7,32.3C-7.1,32.1 -8.4,32.2 -12.4,32.8C-16.5,33.5 -24.9,33.3 -30.4,32.6C-35.3,31.9 -36.2,33.9 -32.3,36.8C-31.8,37.2 -30.9,38.0 -30.2,38.6C-29.6,39.2 -28.6,40.0 -28.0,40.3C-27.4,40.7 -26.6,41.3 -26.2,41.8C-25.7,42.3 -24.9,42.9 -24.2,43.2C-23.5,43.6 -22.5,44.2 -22.1,44.5C-21.6,44.9 -20.8,45.4 -20.2,45.6C-19.7,45.8 -18.9,46.3 -18.5,46.6C-17.3,47.4 -16.4,47.8 -14.9,48.0C-13.6,48.1 -13.4,48.2 -10.7,49.7C-9.7,50.2 -9.5,50.3 -7.9,50.3C-6.6,50.3 -5.8,50.4 -3.9,50.9C1.2,52.3 0.2,52.2 8.4,52.2L15.8,52.2L18.2,51.7C19.5,51.4 21.3,51.0 22.2,50.8C23.1,50.5 24.6,50.3 25.5,50.2C26.6,50.0 27.6,49.8 28.2,49.6C30.4,48.7 31.9,48.2 33.0,47.9C34.4,47.6 35.1,47.2 36.3,46.4C36.8,46.1 37.6,45.8 38.1,45.6C38.7,45.4 39.4,45.0 39.8,44.7C40.2,44.4 41.0,43.9 41.7,43.5C42.4,43.1 43.2,42.5 43.6,42.3C44.5,41.6 45.8,40.7 46.3,40.6C47.2,40.3 49.9,37.9 51.2,36.3C52.9,34.2 56.8,34.4 58.4,36.7C59.0,37.4 60.8,39.0 62.9,40.5C64.8,41.8 66.4,43.1 67.8,44.4C68.4,45.0 69.2,45.7 69.4,45.9C69.7,46.2 70.1,46.6 70.3,46.9C70.5,47.2 71.1,47.7 71.5,48.0C72.0,48.3 72.8,48.9 73.3,49.4C73.8,50.0 74.7,50.6 75.2,50.9C75.8,51.1 76.7,51.8 77.2,52.3C77.8,52.8 79.2,54.0 80.2,54.9C84.3,58.1 85.7,60.1 85.1,61.5C84.9,62.1 80.9,66.1 79.7,67.0C78.2,68.0 76.7,69.2 76.0,69.9C75.6,70.3 75.0,70.8 74.7,71.0C74.3,71.2 73.6,71.9 72.9,72.5C72.3,73.1 71.1,74.0 70.4,74.4C69.6,74.9 68.8,75.4 68.6,75.6C68.4,75.8 67.8,76.2 67.2,76.5C66.6,76.8 65.9,77.3 65.6,77.6C65.0,78.2 63.5,79.0 62.6,79.2C61.9,79.4 60.8,79.9 60.1,80.5C59.0,81.3 57.6,82.1 57.0,82.3C56.6,82.4 56.0,82.7 55.6,83.0C55.1,83.3 54.2,83.8 53.6,84.1C52.9,84.4 52.0,84.9 51.4,85.2C50.9,85.6 50.0,86.0 49.5,86.1C48.2,86.5 47.8,86.6 47.2,87.1C46.9,87.3 46.3,87.6 46.0,87.7C45.5,87.9 41.8,89.3 41.1,89.7C40.9,89.8 39.9,90.0 38.9,90.3C37.9,90.5 36.9,90.8 36.7,90.9C36.2,91.2 32.7,92.3 31.6,92.5C30.4,92.8 28.3,93.2 26.8,93.4C26.0,93.5 25.0,93.8 24.6,94.0C23.7,94.4 24.0,94.4 12.4,95.0C7.7,95.3 2.6,95.3 1.7,95.2ZM-11.8,-10.5C-9.5,-10.7 -7.0,-11.1 -6.0,-11.4C-5.6,-11.5 -4.7,-11.7 -4.1,-11.7C1.2,-12.2 2.2,-12.4 6.5,-13.6C7.0,-13.7 7.8,-13.9 8.2,-13.9C9.7,-14.1 11.7,-14.7 13.3,-15.3C14.2,-15.7 15.7,-16.2 16.8,-16.4C18.5,-16.9 19.4,-17.2 21.1,-18.3C21.6,-18.6 22.4,-19.0 22.9,-19.1C23.4,-19.2 24.2,-19.6 24.7,-19.9C25.1,-20.2 25.9,-20.6 26.3,-20.8C26.8,-20.9 27.6,-21.5 28.2,-22.0C28.8,-22.5 29.7,-23.2 30.2,-23.5C31.2,-24.2 33.8,-26.8 34.1,-27.5C34.3,-27.7 34.8,-28.6 35.3,-29.4L36.2,-30.8L36.2,-32.5C36.2,-34.6 35.8,-36.4 35.0,-38.1C34.6,-38.8 34.3,-39.5 34.3,-39.6C34.3,-40.5 30.0,-45.1 28.0,-46.4C26.4,-47.4 23.5,-48.8 22.2,-49.2C21.6,-49.4 20.3,-49.5 19.3,-49.6C18.4,-49.6 17.3,-49.8 16.9,-49.9C14.1,-50.9 11.0,-51.2 6.1,-51.0C1.0,-50.8 -0.0,-50.7 -2.5,-49.8C-4.1,-49.3 -4.7,-49.2 -5.9,-49.2C-7.1,-49.2 -7.5,-49.1 -9.0,-48.5C-10.0,-48.1 -11.7,-47.6 -12.8,-47.3C-13.8,-47.1 -15.0,-46.6 -15.3,-46.4C-15.7,-46.2 -16.6,-45.7 -17.3,-45.3C-18.9,-44.6 -20.8,-43.3 -22.8,-41.8C-23.5,-41.3 -24.3,-40.7 -24.6,-40.6C-24.9,-40.5 -25.6,-39.9 -26.3,-39.2C-26.9,-38.6 -28.1,-37.6 -28.8,-36.9C-30.0,-35.8 -33.0,-32.8 -34.9,-30.8C-35.4,-30.3 -36.0,-29.5 -36.3,-28.9C-36.6,-28.3 -37.2,-27.5 -37.7,-27.0C-38.1,-26.5 -38.7,-25.6 -39.0,-25.1C-39.3,-24.5 -39.8,-23.6 -40.2,-22.9C-40.7,-22.3 -41.0,-21.7 -41.0,-21.6C-41.0,-21.3 -41.9,-19.5 -42.4,-18.8C-42.6,-18.4 -43.0,-17.7 -43.2,-17.0C-43.4,-16.4 -43.7,-15.7 -44.0,-15.4C-44.6,-14.7 -44.6,-14.2 -44.2,-13.4C-43.9,-12.7 -43.0,-12.2 -42.1,-12.2C-41.4,-12.2 -37.0,-11.3 -36.5,-11.0C-35.2,-10.3 -17.8,-9.9 -11.8,-10.5ZM-4.5,-141.7C-4.4,-141.8 -2.5,-141.8 0.0,-141.8C3.4,-141.8 3.9,-141.8 2.5,-141.7C-0.3,-141.5 -4.8,-141.5 -4.5,-141.7Z"/><path fill="url(#ejp)" fill-rule="evenodd" d="M-65.1,64.8C-65.6,64.3 -66.7,63.2 -67.6,62.3C-69.2,60.8 -69.6,60.2 -72.0,57.1C-73.5,55.1 -74.0,54.3 -74.8,52.6C-75.2,51.8 -75.9,50.8 -76.3,50.3C-77.2,49.4 -77.6,48.7 -78.1,47.4C-78.3,46.9 -78.7,46.2 -79.0,45.9C-79.2,45.5 -79.6,44.8 -79.8,44.3C-80.0,43.7 -80.5,42.7 -81.0,42.0C-81.5,41.3 -82.0,40.3 -82.1,39.8C-82.3,39.3 -82.6,38.5 -82.9,38.0C-83.3,37.1 -84.7,32.8 -84.9,31.8C-85.0,31.5 -85.2,30.9 -85.5,30.5C-85.7,30.1 -86.0,29.3 -86.1,28.8C-86.4,27.3 -86.8,25.8 -87.3,24.6C-87.6,23.6 -87.7,23.2 -87.7,21.0L-87.7,18.5L-85.2,18.5C-82.5,18.5 -81.5,18.7 -79.5,19.9C-79.0,20.3 -77.9,20.7 -77.1,21.0C-76.2,21.3 -74.9,21.8 -74.1,22.1C-73.4,22.5 -71.9,23.0 -71.0,23.3C-70.0,23.6 -68.7,24.1 -68.0,24.4C-67.4,24.7 -65.9,25.2 -64.6,25.6C-63.4,25.9 -61.9,26.4 -61.3,26.6C-60.1,27.2 -58.9,27.5 -57.1,27.8C-55.5,28.1 -54.3,28.4 -53.0,29.0C-51.7,29.6 -50.5,29.8 -47.1,30.3C-45.3,30.6 -43.2,31.1 -41.1,31.9C-40.8,32.0 -40.2,32.2 -39.7,32.4C-39.2,32.5 -38.4,32.7 -38.0,32.7L-37.1,32.7L-37.2,35.5C-37.2,38.0 -37.3,38.4 -37.5,38.6C-37.7,38.7 -37.8,38.9 -37.8,38.9C-37.8,39.0 -38.0,39.2 -38.2,39.4C-38.5,39.6 -38.7,39.9 -38.7,40.1C-38.7,40.3 -38.8,40.5 -38.9,40.5C-39.0,40.5 -39.2,40.7 -39.2,41.0C-39.3,41.2 -39.4,41.6 -39.6,41.7C-39.7,41.9 -39.8,42.1 -39.8,42.2C-39.8,42.4 -40.0,42.5 -40.2,42.5C-40.4,42.5 -40.5,42.6 -40.5,43.0C-40.5,43.3 -40.6,43.5 -40.7,43.5C-40.8,43.5 -40.8,43.7 -40.8,44.0C-40.8,44.4 -40.9,44.5 -41.2,44.5C-41.4,44.5 -41.5,44.6 -41.5,44.8C-41.5,45.0 -41.7,45.2 -41.9,45.3C-42.1,45.5 -42.4,45.7 -42.4,45.9C-42.5,46.0 -42.6,46.2 -42.8,46.2C-43.1,46.2 -43.5,46.6 -43.5,46.9C-43.5,47.1 -43.6,47.2 -43.8,47.2C-44.0,47.2 -44.2,47.3 -44.2,47.5C-44.3,47.7 -44.5,47.8 -44.8,47.8C-45.1,47.8 -45.2,47.9 -45.2,48.2C-45.2,48.3 -45.2,48.5 -45.3,48.5C-45.4,48.5 -45.5,48.7 -45.5,48.9C-45.5,49.2 -45.6,49.4 -45.9,49.5C-46.7,49.8 -47.5,50.7 -47.5,51.3C-47.5,51.7 -47.6,52.1 -47.8,52.3C-48.0,52.5 -48.2,52.7 -48.2,52.8C-48.2,52.9 -48.3,53.1 -48.4,53.1C-48.5,53.2 -48.7,53.3 -48.8,53.5C-48.8,53.7 -49.0,53.8 -49.2,53.8C-49.4,53.8 -49.5,53.9 -49.5,54.0C-49.5,54.1 -49.6,54.2 -49.7,54.2C-49.8,54.2 -50.0,54.3 -50.2,54.5C-50.4,54.7 -50.5,54.9 -50.5,55.0C-50.5,55.1 -50.6,55.2 -50.7,55.2C-50.8,55.2 -50.8,55.3 -50.8,55.5C-50.8,55.7 -50.9,55.8 -51.0,55.8C-51.1,55.8 -51.5,56.6 -51.5,56.9C-51.5,57.1 -51.6,57.2 -51.6,57.2C-51.9,57.2 -52.8,58.1 -52.8,58.3C-52.8,58.4 -52.9,58.5 -53.0,58.5C-53.1,58.5 -53.2,58.6 -53.2,58.7C-53.2,58.8 -53.3,59.0 -53.5,59.2C-54.0,59.7 -54.2,60.0 -54.2,60.2C-54.2,60.4 -54.2,60.5 -54.3,60.5C-54.4,60.5 -54.5,60.7 -54.5,60.8C-54.5,61.1 -54.6,61.2 -55.1,61.2C-55.4,61.2 -55.7,61.2 -55.7,61.3C-55.7,61.4 -55.8,61.5 -56.1,61.7C-56.3,61.8 -56.5,62.0 -56.6,62.2C-56.6,62.4 -56.8,62.5 -56.9,62.5C-57.1,62.5 -57.2,62.7 -57.2,63.0C-57.2,63.3 -57.3,63.5 -57.4,63.5C-57.6,63.5 -57.7,63.8 -57.7,64.4C-57.8,65.3 -57.9,65.3 -58.6,65.5C-59.0,65.6 -60.4,65.7 -61.8,65.7L-64.3,65.7L-65.1,64.8Z"/></svg>';
  async function poster() {
    const q = await svg(wallUrl());
    return `<!doctype html><html><head><meta charset="utf-8"><title>Attendance QR</title><style>
      @page{size:A4;margin:16mm}body{font-family:Segoe UI,system-ui,sans-serif;text-align:center;color:#111;margin:0}
      h1{font-size:38px;margin:10mm 0 4mm}p{font-size:17px;color:#444;margin:2mm 0}.q{width:140mm;margin:8mm auto}.q svg{width:100%;height:auto}
      .s{display:inline-block;text-align:left;font-size:15px;color:#333;margin-top:6mm;line-height:1.7}small{color:#888}</style></head><body>
      <div style="margin-top:6mm">${LOGO_SVG}</div><h1>Scan to check in / check out</h1><p>Elitejobs Rwanda — staff attendance</p><div class="q">${q}</div>
      <div class="s">1. Connect your phone to the office Wi-Fi.<br>2. Open the camera and point it at this code.<br>3. First scan of the day checks you in; a later scan checks you out.<br>4. Arrive by ${cfg().start} to be on time.</div>
      <p><small>Only staff whose phone is linked in the Elitejobs Hub app can check in. Scans from outside the office network are refused.</small></p></body></html>`;
  }

  // ---------------- reports ----------------
  const LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', annual: 'Annual' };
  function windowFor(period, date) {
    const d = date && /^\d{4}-\d\d-\d\d$/.test(date) ? new Date(date + 'T12:00:00') : new Date();
    let from, to, label;
    if (period === 'weekly') { from = new Date(d); from.setDate(d.getDate() - ((d.getDay() + 6) % 7)); from.setHours(0, 0, 0, 0); to = new Date(from); to.setDate(to.getDate() + 7); label = 'Week of ' + from.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
    else if (period === 'monthly') { from = new Date(d.getFullYear(), d.getMonth(), 1); to = new Date(d.getFullYear(), d.getMonth() + 1, 1); label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
    else if (period === 'annual') { from = new Date(d.getFullYear(), 0, 1); to = new Date(d.getFullYear() + 1, 0, 1); label = 'Year ' + d.getFullYear(); }
    else { period = 'daily'; from = new Date(d); from.setHours(0, 0, 0, 0); to = new Date(from); to.setDate(to.getDate() + 1); label = from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
    return { period, from: +from, to: +to, label };
  }
  function attendanceIn(uid, w) {
    const att = rj(ATT, {}), out = [];
    for (const [d, recs] of Object.entries(att)) { const r = recs[uid]; if (r && r.in >= w.from && r.in < w.to) out.push(Object.assign({ day: d }, r)); }
    return out.sort((a, b) => a.in - b.in);
  }
  const CATS = [['Tickets', /ticket/i], ['Calls', /\bcall/i], ['Walk-ins', /walk-in/i], ['Visitors', /visitor|arrived|checked in for|checked out$|expected/i], ['Candidates', /candidate|applicant|moved to|fee received/i], ['Interviews', /interview|scored/i], ['Leave', /leave/i], ['Messages', /message|announce|banner/i]];
  function statsFor(uid, w) {
    const acts = activity().filter(a => a.uid === uid && a.t >= w.from && a.t < w.to);
    const work = acts.filter(a => !/^checked (in|out) at|linked a phone/.test(a.text));
    const att = attendanceIn(uid, w);
    const by = {}; work.forEach(a => { const c = (CATS.find(([, re]) => re.test(a.text)) || ['Other'])[0]; by[c] = (by[c] || 0) + 1; });
    const hours = att.reduce((s, r) => s + (r.out ? (r.out - r.in) / 36e5 : 0), 0);
    const arr = att.map(r => { const d = new Date(r.in); return d.getHours() * 60 + d.getMinutes(); });
    const avg = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    return { acts: work, att, s: { actions: work.length, byType: by, daysPresent: att.length, lateDays: att.filter(r => r.late).length, hoursOnSite: Math.round(hours * 10) / 10, avgArrival: avg === null ? null : pad(Math.floor(avg / 60)) + ':' + pad(avg % 60) } };
  }
  function plainReport(p, w, st) {
    const s = st.s, lines = [];
    lines.push('## Summary');
    lines.push(`${p.name} (${p.dept}, ${p.id}) recorded ${s.actions} action${s.actions === 1 ? '' : 's'} in the system for ${w.label.toLowerCase().startsWith('week') ? 'the ' + w.label.toLowerCase() : w.label}.`);
    lines.push('## Attendance');
    lines.push(s.daysPresent ? `- Days present: ${s.daysPresent}\n- Days late: ${s.lateDays}\n- Average arrival: ${s.avgArrival || '—'}\n- Hours on site (checked out days): ${s.hoursOnSite}` : '- No QR check-ins recorded in this period.');
    lines.push('## Work completed');
    const t = Object.entries(s.byType);
    lines.push(t.length ? t.map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- No recorded work in this period.');
    if (st.acts.length) { lines.push('## Activity'); lines.push(st.acts.slice(-25).map(a => `- ${new Date(a.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${a.text}`).join('\n')); }
    return lines.join('\n');
  }
  const readReports = () => { try { return fs.readFileSync(REP, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
  async function makeReport(uid, period) {
    const p = staffById(uid); if (!p) throw err('Sign in first.');
    if (p.role === 'admin') throw err('Admin receives reports; Admin doesn’t send one.');
    const w = windowFor(period), st = statsFor(uid, w);
    let text = null, byAI = false, aiNote = null;
    if (ai.status().ready) {
      try { text = await ai.staffReport({ who: p.name, id: p.id, role: p.dept, label: w.label, period: w.period, stats: st.s, attendance: st.att.map(r => ({ day: r.day, in: hm(r.in), out: r.out ? hm(r.out) : null, lateMin: r.late })), activity: st.acts.map(a => ({ t: new Date(a.t).toLocaleString('en-GB'), text: a.text })) }); byAI = true; }
      catch (e) { aiNote = e.message; }
    }
    if (!text) text = plainReport(p, w, st);
    const rec = { id: 'RPT-' + tok(5), uid, name: p.name, role: p.role, dept: p.dept, period: w.period, from: w.from, to: w.to, label: w.label, t: Date.now(), stats: st.s, text, ai: byAI, aiNote };
    fs.appendFileSync(REP, JSON.stringify(rec) + '\n');
    appendActivity({ t: rec.t, by: p.name, uid: p.id, role: p.role, text: 'sent a ' + w.period + ' report to Admin' });
    hubNote(['admin'], '📊 ' + p.name + ' (' + p.dept + ') sent their ' + w.period + ' report');
    broadcast({ type: 'report', id: rec.id, period: rec.period, from: rec.from });
    return rec;
  }
  function myReports(uid) { return readReports().filter(r => r.uid === uid).reverse().slice(0, 30).map(r => ({ id: r.id, period: r.period, label: r.label, t: r.t, ai: r.ai })); }
  function getReport(id) { return readReports().find(r => r.id === id) || null; }
  function latestFor(uid, w, reps) { return reps.filter(r => r.uid === uid && r.period === w.period && r.from === w.from).sort((a, b) => b.t - a.t)[0] || null; }
  function overview(period, date) {
    const w = windowFor(period, date), s = loadState() || { staff: [] }, reps = readReports();
    const positions = {};
    (s.staff || []).filter(p => p.role !== 'admin').forEach(p => {
      const st = statsFor(p.id, w), r = latestFor(p.id, w, reps);
      (positions[p.role] = positions[p.role] || []).push({ id: p.id, name: p.name, dept: p.dept, stats: st.s, report: r ? { id: r.id, t: r.t, ai: r.ai } : null });
    });
    return { window: w, positions };
  }
  // ---- downloads: a clean, printable document (opens in any browser or Word; print to PDF) ----
  const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function mdHtml(t) {
    let o = '', inL = false;
    String(t || '').split('\n').forEach(l => {
      const h = l.match(/^#{1,4}\s+(.*)/), b = l.match(/^\s*[-*•]\s+(.*)/);
      if (b) { if (!inL) { o += '<ul>'; inL = true; } o += '<li>' + escH(b[1]) + '</li>'; return; }
      if (inL) { o += '</ul>'; inL = false; }
      if (h) o += '<h3>' + escH(h[1]) + '</h3>'; else if (l.trim()) o += '<p>' + escH(l) + '</p>';
    });
    if (inL) o += '</ul>';
    return o.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }
  function docFor(scope, opts) {
    const w = windowFor(opts.period, opts.date), s = loadState() || { staff: [] }, reps = readReports();
    let people = (s.staff || []).filter(p => p.role !== 'admin');
    if (scope === 'user') people = people.filter(p => p.id === opts.uid);
    if (scope === 'position') people = people.filter(p => p.role === opts.role);
    if (!people.length) throw err('Nobody to include.');
    const byRole = {}; people.forEach(p => (byRole[p.dept] = byRole[p.dept] || []).push(p));
    const card = p => {
      const st = statsFor(p.id, w), r = latestFor(p.id, w, reps), x = st.s;
      return `<section class="person"><div class="ph"><div><h2>${escH(p.name)}</h2><div class="meta">${escH(p.dept)} · ${escH(p.id)}</div></div>
        <div class="badge ${r ? 'ok' : 'none'}">${r ? (r.ai ? 'Report written by Hub AI' : 'Report sent') + ' · ' + new Date(r.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'No report sent — figures from the system'}</div></div>
        <div class="kpis"><div><b>${x.actions}</b><span>actions</span></div><div><b>${x.daysPresent}</b><span>days present</span></div><div><b>${x.lateDays}</b><span>days late</span></div><div><b>${x.avgArrival || '—'}</b><span>avg arrival</span></div><div><b>${x.hoursOnSite}</b><span>hours on site</span></div></div>
        <div class="body">${mdHtml(r ? r.text : plainReport(p, w, st))}</div></section>`;
    };
    const title = scope === 'user' ? people[0].name : scope === 'position' ? people[0].dept : 'All positions';
    return { name: `Elitejobs ${LABEL[w.period]} report - ${title} - ${dayKey(w.from)}.html`.replace(/[\\/:*?"<>|]/g, '-'), html: `<!doctype html><html><head><meta charset="utf-8"><title>${escH(LABEL[w.period] + ' report — ' + title)}</title><style>
      @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#15171f;margin:0;background:#f4f5f9}
      .wrap{max-width:900px;margin:0 auto;padding:28px}header{background:linear-gradient(120deg,#2a1a5e,#6d5dfc 60%,#18c5a3);color:#fff;border-radius:22px;padding:30px 32px;margin-bottom:22px}
      header h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em}header p{margin:0;opacity:.85}h1.role{font-size:13px;letter-spacing:.08em;color:#6d5dfc;margin:26px 0 10px;text-transform:uppercase}
      .person{background:#fff;border:1px solid #e3e5ee;border-radius:18px;padding:22px 24px;margin-bottom:16px;page-break-inside:avoid}
      .ph{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.ph h2{margin:0;font-size:20px}.meta{color:#667;font-size:13px;margin-top:2px}
      .badge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px}.badge.ok{background:#2ecc8f22;color:#17a870}.badge.none{background:#ffa94d22;color:#c27407}
      .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:16px 0}.kpis div{background:#f4f5f9;border-radius:12px;padding:10px 12px}.kpis b{display:block;font-size:20px}.kpis span{font-size:12px;color:#667}
      .body h3{font-size:15px;margin:16px 0 6px;color:#2a1a5e}.body p,.body li{line-height:1.6;font-size:14px}.body ul{padding-left:20px;margin:4px 0}
      footer{color:#889;font-size:12px;text-align:center;margin:22px 0 6px}@media print{body{background:#fff}.wrap{padding:0}}</style></head><body><div class="wrap">
      <header><h1>${escH(LABEL[w.period])} report — ${escH(title)}</h1><p>${escH(w.label)} · Elitejobs Rwanda · generated ${new Date().toLocaleString('en-GB')}</p></header>
      ${Object.entries(byRole).map(([d, ps]) => (scope === 'user' ? '' : `<h1 class="role">${escH(d)} · ${ps.length} ${ps.length === 1 ? 'person' : 'people'}</h1>`) + ps.map(card).join('')).join('')}
      <footer>Figures come from what each person did in Elitejobs Hub and their QR check-ins. Reports marked “written by Hub AI” were drafted by AI from those figures only.</footer></div></body></html>` };
  }

  return { cfg: publicCfg, setCfg, rotate, makeLink, link, whoami, unlink, scan, dayView, mine, svg, poster, wallUrl, setTitle, secEvent, makeReport, myReports, getReport, overview, docFor, isOffice, ipOf };
};
