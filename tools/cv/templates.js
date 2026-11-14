// Elite Jobs Rwanda CV engine v2: two layouts, each in a light and a dark finish.
// renderCV(data, tpl) -> one A4 HTML page. Self-contained: no outside requests, prints to PDF as-is.
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ini = n => String(n || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
const when = (a, b) => esc(a) + (b ? '&#8202;–&#8202;' + esc(b) : '');
const LV = { native: 5, mother: 5, fluent: 4, 'very good': 4, good: 3, intermediate: 3, fair: 2, basic: 2, beginner: 1 };
const dots = l => { const n = LV[String(l || '').toLowerCase()] || 3; return `<span class="dots" aria-label="${esc(l)}">${[1, 2, 3, 4, 5].map(i => `<b class="${i <= n ? 'on' : ''}"></b>`).join('')}</span>`; };

const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
  mail: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="m3.5 7 8.5 6 8.5-6"/>'),
  pin: svg('<path d="M19 10c0 5.5-7 11-7 11s-7-5.5-7-11a7 7 0 0 1 14 0z"/><circle cx="12" cy="10" r="2.6"/>'),
};
const MARK = require('fs').readFileSync(require('path').join(__dirname, 'logo.svg'), 'utf8');
const ORBIT = `<svg class="orb" viewBox="0 0 120 120" fill="none" stroke="currentColor">${[16, 26, 36, 46, 56].map((r, i) => `<circle cx="60" cy="60" r="${r}" stroke-width=".28" opacity="${(.9 - i * .14).toFixed(2)}"/>`).join('')}<circle cx="${(60 - 26 * Math.cos(.5)).toFixed(2)}" cy="${(60 - 26 * Math.sin(.5)).toFixed(2)}" r="1.3" fill="currentColor" stroke="none"/><circle cx="${(60 - 46 * Math.cos(.18)).toFixed(2)}" cy="${(60 + 46 * Math.sin(.18)).toFixed(2)}" r=".9" fill="currentColor" stroke="none" opacity=".7"/></svg>`;

function parts(d) {
  const exp = (d.experience || []).map(e => `<article class="it">
    <div class="ih"><h3>${esc(e.role)}</h3><time>${when(e.from, e.to)}</time></div>
    <div class="org">${esc(e.org)}${e.place ? `<span class="sep"></span>${esc(e.place)}` : ''}</div>
    ${e.about ? `<p class="ab">${esc(e.about)}</p>` : ''}
    ${(e.points || []).length ? `<ul>${e.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</article>`).join('');
  const edu = (d.education || []).map(e => `<article class="it"><div class="ih"><h3>${esc(e.title)}</h3><time>${when(e.from, e.to)}</time></div><div class="org">${esc(e.school)}</div></article>`).join('');
  return {
    exp, edu,
    contact: [['phone', d.phone], ['mail', d.email], ['pin', d.location]].filter(x => x[1]).map(([k, v]) => `<div class="cn"><span class="ci">${IC[k]}</span><span>${esc(v)}</span></div>`).join(''),
    skills: (d.skills || []).map(s => `<span class="sk">${esc(s)}</span>`).join(''),
    langs: (d.languages || []).map(l => `<div class="lg"><span>${esc(l.name)}</span>${dots(l.level)}</div>`).join(''),
    certs: (d.certificates || []).map(c => `<div class="ct">${esc(c)}</div>`).join(''),
    refs: (d.references || []).map(r => `<div class="rf"><b>${esc(r.name)}</b><span>${esc(r.role)}</span><span class="num">${esc(r.phone)}</span></div>`).join(''),
    face: cls => d.photo ? `<img class="${cls}" src="${esc(d.photo)}" alt="">` : `<div class="${cls} mono"><span>${esc(ini(d.name))}</span></div>`,
    foot: `<footer class="foot">${ORBIT}<div class="lo">${MARK}<div class="nm"><b>EliteJobs<span>Rwanda</span></b><small>elitejobsrwanda.com</small></div></div><div class="tg">CV prepared with<br>Elite Jobs Rwanda</div></footer>`,
  };
}

// Shared type system. One family (Geist), five sizes, three weights. Tabular figures for every date and number.
const BASE = `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:G,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;color:#1C1B20;font-feature-settings:"tnum","ss01"}
.pg{width:210mm;height:297mm;position:relative;overflow:hidden;background:#fff}
h1,h2,h3,p{margin:0}
ul{margin:1.6mm 0 0;padding:0;list-style:none}
li{position:relative;padding-left:3.6mm;margin:.9mm 0;font-size:8.9pt;line-height:1.5;color:#3A3841}
li:before{content:"";position:absolute;left:.4mm;top:.62em;width:1.2mm;height:1.2mm;border-radius:50%;background:var(--acc)}
.it+.it{margin-top:4.6mm}
.ih{display:flex;justify-content:space-between;align-items:baseline;gap:4mm}
.ih h3{font-size:10.3pt;font-weight:650;letter-spacing:-.012em}
time{font-size:8.2pt;color:#8B8692;white-space:nowrap;font-weight:500}
.org{display:flex;align-items:center;gap:2mm;margin-top:.8mm;font-size:8.9pt;color:var(--acc);font-weight:540}
.sep{width:1mm;height:1mm;border-radius:50%;background:currentColor;opacity:.5}
.ab{margin-top:1.4mm;font-size:8.9pt;line-height:1.55;color:#3A3841}
.dots{display:inline-flex;gap:1.1mm}.dots b{width:1.7mm;height:1.7mm;border-radius:50%;background:var(--dot-off)}.dots b.on{background:var(--dot-on)}
.foot{grid-column:1/-1;position:relative;overflow:hidden;height:19mm;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 52mm 0 11mm;background:var(--ft);color:var(--ft-ink);border-top:.5pt solid var(--ft-line)}
.foot .lo{display:flex;align-items:center;gap:3mm;position:relative}
.foot .lo svg{width:9.5mm;height:9.5mm;filter:drop-shadow(0 1mm 1.6mm rgba(0,0,0,.18))}
.foot .nm{display:grid;gap:.3mm}.foot .nm b{font-size:10.5pt;font-weight:720;letter-spacing:-.02em}.foot .nm b span{font-weight:480;opacity:.7;margin-left:1mm}
.foot .nm small{font-size:7.6pt;opacity:.62;letter-spacing:.01em}
.foot .tg{position:relative;font-size:7.6pt;opacity:.62;text-align:right;line-height:1.45;padding-right:4mm;border-right:.5pt solid var(--ft-line)}
.foot .orb{position:absolute;right:-38mm;top:50%;width:110mm;height:110mm;transform:translateY(-50%);color:var(--orb);opacity:.55;pointer-events:none;-webkit-mask-image:linear-gradient(90deg,transparent 18%,#000 58%);mask-image:linear-gradient(90deg,transparent 18%,#000 58%)}
.num{font-variant-numeric:tabular-nums}
`;

// ── Layout 1: sidebar. "Sand" = warm light sidebar · "Dune" = graphite sidebar.
const SIDE = `
.pg{display:grid;grid-template-columns:70mm 1fr;grid-template-rows:1fr 19mm}
.sd{background:var(--sb);color:var(--sb-ink);padding:19mm 9mm 8mm 11mm;display:flex;flex-direction:column;gap:8mm}
.ph{width:32mm;height:32mm;border-radius:50%;object-fit:cover;box-shadow:0 0 0 1.2mm var(--ring),0 3mm 8mm -3mm rgba(0,0,0,.35)}
.mono{display:grid;place-items:center;background:linear-gradient(155deg,var(--m1),var(--m2));color:#fff;font-size:21pt;font-weight:650;letter-spacing:-.02em;position:relative;overflow:hidden}
.mono:after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.22),transparent 48%)}
.sd h2{font-size:8.2pt;font-weight:700;color:var(--sb-head);letter-spacing:.02em;margin-bottom:3mm}
.cn{display:flex;align-items:center;gap:2.6mm;font-size:8.6pt;line-height:1.3;word-break:break-word}.cn+.cn{margin-top:2.4mm}
.ci{width:6.2mm;height:6.2mm;flex:none;border-radius:50%;display:grid;place-items:center;background:var(--ci-bg);color:var(--sb-head)}.ci svg{width:3.3mm;height:3.3mm}
.sks{display:flex;flex-wrap:wrap;gap:1.6mm}
.sk{font-size:8.3pt;padding:1.3mm 2.8mm;border-radius:99px;background:var(--chip);color:var(--sb-ink);box-shadow:inset 0 0 0 .5pt var(--chip-line)}
.lg{display:flex;justify-content:space-between;align-items:center;font-size:8.7pt;padding:1.6mm 0;border-bottom:.5pt solid var(--sb-line)}.lg:last-child{border-bottom:0}
.ct{font-size:8.6pt;line-height:1.45;padding-left:3.4mm;position:relative}.ct:before{content:"";position:absolute;left:0;top:.55em;width:1.3mm;height:1.3mm;border-radius:50%;background:var(--sb-head)}.ct+.ct{margin-top:1.8mm}
.mn{padding:21mm 14mm 8mm 12.5mm}
.mn h1{font-size:28pt;font-weight:760;letter-spacing:-.042em;line-height:1}
.role{font-size:11.6pt;color:var(--acc);font-weight:560;margin-top:2.6mm;letter-spacing:-.01em}
.mn h2{font-size:10pt;font-weight:700;letter-spacing:-.01em;margin:8mm 0 3.6mm;display:flex;align-items:center;gap:3mm}
.mn h2:after{content:"";flex:1;height:.5pt;background:#E4E0D8}
.bio{font-size:10pt;line-height:1.62;color:#2E2C33}
.rfs{display:grid;grid-template-columns:1fr 1fr;gap:4mm}
.rf{display:grid;gap:.6mm;font-size:8.6pt;color:#55525C;padding:3mm 3.6mm;border-radius:2.6mm;background:var(--soft)}.rf b{color:#1C1B20;font-weight:650;font-size:9.2pt}
`;
const sideTpl = vars => d => { const b = parts(d); return [`:root{${vars}}` + SIDE, `<div class="pg">
<aside class="sd">${b.face('ph')}
<section><h2>Contact</h2>${b.contact}</section>
${b.skills ? `<section><h2>Skills</h2><div class="sks">${b.skills}</div></section>` : ''}
${b.langs ? `<section><h2>Languages</h2>${b.langs}</section>` : ''}
${b.certs ? `<section><h2>Certificates</h2>${b.certs}</section>` : ''}
</aside>
<main class="mn"><h1>${esc(d.name)}</h1><div class="role">${esc(d.title)}</div>
${d.summary ? `<h2>About me</h2><p class="bio">${esc(d.summary)}</p>` : ''}
${b.exp ? `<h2>Experience</h2>${b.exp}` : ''}
${b.edu ? `<h2>Education</h2>${b.edu}` : ''}
${b.refs ? `<h2>References</h2><div class="rfs">${b.refs}</div>` : ''}
</main>${b.foot}</div>`]; };

// ── Layout 2: header band. "Ink" = graphite header · "Stone" = warm sand header.
const HEAD = `
.hd{background:var(--hd);color:var(--hd-ink);padding:16mm 18mm 12mm;position:relative}
.hd:after{content:"";position:absolute;left:18mm;bottom:0;width:20mm;height:1mm;border-radius:1mm 1mm 0 0;background:var(--bar)}
.top{display:flex;align-items:center;gap:7mm}
.ph{width:25mm;height:25mm;border-radius:6.6mm;object-fit:cover;flex:none;box-shadow:0 3mm 8mm -3mm rgba(0,0,0,.45)}
.mono{display:grid;place-items:center;background:linear-gradient(155deg,var(--m1),var(--m2));color:#fff;font-size:17pt;font-weight:650;letter-spacing:-.02em;position:relative;overflow:hidden}
.mono:after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.24),transparent 48%);box-shadow:inset 0 0 0 .5pt rgba(255,255,255,.2)}
.hd h1{font-size:28pt;font-weight:760;letter-spacing:-.042em;line-height:1}
.role{font-size:11.4pt;color:var(--hd-role);margin-top:2.4mm;font-weight:560;letter-spacing:-.01em}
.cns{display:flex;flex-wrap:wrap;gap:1.6mm 6mm;margin-top:4.2mm;font-size:8.5pt;color:var(--hd-sub)}
.cn{display:flex;align-items:center;gap:1.8mm}.ci{display:grid;color:var(--hd-role)}.ci svg{width:3.4mm;height:3.4mm}
.bio{font-size:10.4pt;line-height:1.62;color:#2E2C33}
.lead{padding:8.5mm 18mm 0}
.lead h2{margin-top:0}
.bd{display:grid;grid-template-columns:1fr 55mm;gap:10mm;padding:0 18mm 8mm}
h2{font-size:8.4pt;font-weight:700;color:var(--acc);letter-spacing:.02em;margin:7.5mm 0 3.2mm}
.l .it{padding-left:4mm;border-left:.7pt solid #E6E2DA}
.r{border-left:.5pt solid #ECE9E3;padding-left:7mm}
.sks{display:flex;flex-wrap:wrap;gap:1.6mm}
.sk{font-size:8.3pt;padding:1.3mm 2.8mm;border-radius:99px;background:var(--soft);box-shadow:inset 0 0 0 .5pt var(--soft-line)}
.lg{display:flex;justify-content:space-between;align-items:center;font-size:8.8pt;padding:1.5mm 0}
.ct{font-size:8.7pt;line-height:1.45}.ct+.ct{margin-top:1.6mm}
.rf{display:grid;gap:.5mm;font-size:8.5pt;color:#55525C}.rf+.rf{margin-top:3.6mm}.rf b{color:#1C1B20;font-weight:650;font-size:9.1pt}
.pg{display:flex;flex-direction:column}.bd{flex:1}
`;
const headTpl = vars => d => { const b = parts(d); return [`:root{${vars}}` + HEAD, `<div class="pg">
<header class="hd"><div class="top">${b.face('ph')}<div><h1>${esc(d.name)}</h1><div class="role">${esc(d.title)}</div><div class="cns">${b.contact}</div></div></div></header>
${d.summary ? `<section class="lead"><h2>About me</h2><p class="bio">${esc(d.summary)}</p></section>` : ''}
<div class="bd"><div class="l">
${b.exp ? `<h2>Experience</h2>${b.exp}` : ''}
${b.edu ? `<h2>Education</h2>${b.edu}` : ''}
</div><div class="r">
${b.skills ? `<h2>Skills</h2><div class="sks">${b.skills}</div>` : ''}
${b.langs ? `<h2>Languages</h2>${b.langs}` : ''}
${b.certs ? `<h2>Certificates</h2>${b.certs}` : ''}
${b.refs ? `<h2>References</h2>${b.refs}` : ''}
</div></div>${b.foot}</div>`]; };

// Finishes: two calm tones that get along, plus one accent. Any layout can wear any finish.
const F = {
  starlight: { name: 'Starlight', acc: '#5B489D', m1: '#7462B8', m2: '#4A3A86', soft: '#F6F2EA', softLine: '#E3DBCD', light: '#EAE3D6', lightInk: '#1C1B20', lightLine: '#D8CEBD', dark: '#1F1E24', darkHead: '#B7A9F0', ft: '#F3EEE5', orb: '#5B489D', dotOff: '#DDD5C7' },
  midnight:  { name: 'Midnight',  acc: '#2D5B9A', m1: '#5585C8', m2: '#22447A', soft: '#EEF2F7', softLine: '#D9E1EC', light: '#E3E9F1', lightInk: '#141A24', lightLine: '#C9D4E3', dark: '#18202C', darkHead: '#9EBBE8', ft: '#EEF2F7', orb: '#2D5B9A', dotOff: '#D3DCE8' },
  titanium:  { name: 'Titanium',  acc: '#77694F', m1: '#A8997F', m2: '#655842', soft: '#F4F2EE', softLine: '#E2DDD4', light: '#E6E2DB', lightInk: '#1C1B1A', lightLine: '#D2CBC0', dark: '#232325', darkHead: '#D2C3A6', ft: '#F2F0EC', orb: '#77694F', dotOff: '#DFDAD1' },
  sage:      { name: 'Sage',      acc: '#3D6A55', m1: '#5F8E76', m2: '#2C5242', soft: '#F0F4EF', softLine: '#D9E3D8', light: '#DFE7DD', lightInk: '#17201B', lightLine: '#C6D3C4', dark: '#1B2420', darkHead: '#A6CDB6', ft: '#EEF3ED', orb: '#3D6A55', dotOff: '#D3DED2' },
};
const fv = (f, dark, head) => `--acc:${f.acc};--m1:${f.m1};--m2:${f.m2};--soft:${f.soft};--soft-line:${f.softLine};--dot-on:${dark && !head ? f.darkHead : f.acc};--dot-off:${dark && !head ? '#3B3843' : f.dotOff};--ft:${f.ft};--ft-ink:#1C1B20;--ft-line:${f.softLine};--orb:${f.orb};`
  + (head ? (dark ? `--hd:${f.dark};--hd-ink:#fff;--hd-role:${f.darkHead};--hd-sub:#D5D1DB;--bar:${f.darkHead};` : `--hd:${f.light};--hd-ink:${f.lightInk};--hd-role:${f.acc};--hd-sub:#4A4650;--bar:${f.acc};`)
          : (dark ? `--sb:${f.dark};--sb-ink:#E9E6EE;--sb-head:${f.darkHead};--sb-line:#34323B;--chip:#2C2A32;--chip-line:#3B3843;--ci-bg:#2C2A32;--ring:#2C2A32;` : `--sb:${f.light};--sb-ink:${f.lightInk};--sb-head:${f.acc};--sb-line:${f.lightLine};--chip:${f.soft};--chip-line:${f.softLine};--ci-bg:${f.soft};--ring:${f.soft};`));
// ── Three more layouts. They read the finish directly: --acc, --m1/--m2, --soft, --light, --dark, --dhead.
const fAll = f => `--acc:${f.acc};--m1:${f.m1};--m2:${f.m2};--soft:${f.soft};--soft-line:${f.softLine};--light:${f.light};--light-line:${f.lightLine};--dark:${f.dark};--dhead:${f.darkHead};--dot-on:${f.acc};--dot-off:${f.dotOff};--ft:${f.ft};--ft-ink:#1C1B20;--ft-line:${f.softLine};--orb:${f.orb};`;
const RINGS = (n, cls) => `<svg class="${cls}" viewBox="0 0 120 120" fill="none" stroke="currentColor">${Array.from({ length: n }, (_, i) => `<circle cx="60" cy="60" r="${22 + i * 9.5}" stroke-width=".3" opacity="${(.75 - i * .13).toFixed(2)}"/>`).join('')}<circle cx="${(60 + 31.5 * Math.cos(-.75)).toFixed(2)}" cy="${(60 + 31.5 * Math.sin(-.75)).toFixed(2)}" r="1.2" fill="currentColor" stroke="none"/><circle cx="${(60 + 50.5 * Math.cos(2.5)).toFixed(2)}" cy="${(60 + 50.5 * Math.sin(2.5)).toFixed(2)}" r=".9" fill="currentColor" stroke="none" opacity=".6"/></svg>`;
const SHARED = `
.pg{display:flex;flex-direction:column}.body{flex:1;min-height:0}
.sks{display:flex;flex-wrap:wrap;gap:1.6mm}
.sk{font-size:8.3pt;padding:1.3mm 2.8mm;border-radius:99px;background:var(--soft);box-shadow:inset 0 0 0 .5pt var(--soft-line)}
.lg{display:flex;justify-content:space-between;align-items:center;font-size:8.8pt;padding:1.4mm 0}
.ct{font-size:8.7pt;line-height:1.45}.ct+.ct{margin-top:1.5mm}
.rf{display:grid;gap:.5mm;font-size:8.5pt;color:#55525C}.rf b{color:#1C1B20;font-weight:650;font-size:9.1pt}
.mono{display:grid;place-items:center;background:linear-gradient(155deg,var(--m1),var(--m2));color:#fff;font-weight:650;letter-spacing:-.02em;position:relative;overflow:hidden}
.mono:after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.24),transparent 48%)}
.cn{display:flex;align-items:center;gap:1.8mm}.ci{display:grid;color:var(--acc)}.ci svg{width:3.4mm;height:3.4mm}
.bio{font-size:10.2pt;line-height:1.62;color:#2E2C33}
`;

// 5 · Halo — centred. The photo sits in the middle of the company orbit.
const HALO = SHARED + `
.top{position:relative;text-align:center;padding:12mm 20mm 0;overflow:hidden}
.halo{position:absolute;left:50%;top:-31.5mm;width:118mm;height:118mm;transform:translateX(-50%);color:var(--acc);opacity:.5}
.ph{position:relative;width:31mm;height:31mm;border-radius:50%;object-fit:cover;margin:0 auto;font-size:20pt;box-shadow:0 0 0 1.4mm #fff,0 4mm 10mm -4mm rgba(0,0,0,.4)}
.top h1{position:relative;font-size:29pt;font-weight:760;letter-spacing:-.042em;line-height:1;margin-top:6.5mm}
.role{position:relative;font-size:11.6pt;color:var(--acc);font-weight:560;margin-top:2.4mm}
.cns{position:relative;display:flex;justify-content:center;flex-wrap:wrap;gap:1.6mm 6mm;margin-top:4mm;font-size:8.6pt;color:#4A4650}
.top .bio{position:relative;max-width:150mm;margin:6.5mm auto 0;font-size:10pt;color:#3A3841}
.body{display:grid;grid-template-columns:1fr 56mm;gap:10mm;padding:0 18mm 8mm;margin-top:7mm;border-top:.5pt solid #ECE9E3}
h2{font-size:8.4pt;font-weight:700;color:var(--acc);letter-spacing:.02em;margin:6.5mm 0 3.2mm}
.r{border-left:.5pt solid #ECE9E3;padding-left:7mm}
.rf+.rf{margin-top:3.4mm}
`;
const haloTpl = vars => d => { const b = parts(d); return [`:root{${vars}}` + HALO, `<div class="pg">
<header class="top">${RINGS(6, 'halo')}${b.face('ph')}<h1>${esc(d.name)}</h1><div class="role">${esc(d.title)}</div><div class="cns">${b.contact}</div>
${d.summary ? `<p class="bio">${esc(d.summary)}</p>` : ''}</header>
<div class="body"><div>${b.exp ? `<h2>Experience</h2>${b.exp}` : ''}${b.edu ? `<h2>Education</h2>${b.edu}` : ''}</div>
<div class="r">${b.skills ? `<h2>Skills</h2><div class="sks">${b.skills}</div>` : ''}${b.langs ? `<h2>Languages</h2>${b.langs}` : ''}${b.certs ? `<h2>Certificates</h2>${b.certs}` : ''}${b.refs ? `<h2>References</h2>${b.refs}` : ''}</div></div>
${b.foot}</div>`]; };

// 6 · Bento — every section is its own tile; the identity tile is the dark one that pops.
const BENTO = SHARED + `
.pg{background:var(--light)}
.body{display:grid;grid-template-columns:1fr 60mm;grid-auto-rows:min-content;gap:3.6mm;padding:12mm 12mm 8mm;align-content:start}
.tl{background:#fff;border-radius:5mm;padding:5mm 6mm;box-shadow:0 .4mm 1.2mm rgba(0,0,0,.05),inset 0 0 0 .4pt rgba(0,0,0,.04)}
.id{grid-column:1/-1;background:var(--dark);color:#fff;display:flex;align-items:center;gap:6.5mm;padding:7mm 8mm;position:relative;overflow:hidden}
.id .orb2{position:absolute;right:-30mm;top:50%;width:100mm;height:100mm;transform:translateY(-50%);color:var(--dhead);opacity:.4}
.ph{width:24mm;height:24mm;border-radius:6.4mm;object-fit:cover;flex:none;font-size:16pt;position:relative}
.id h1{font-size:25pt;font-weight:760;letter-spacing:-.042em;line-height:1}
.id .role{font-size:11pt;color:var(--dhead);margin-top:2mm;font-weight:560}
.id .cns{display:flex;flex-wrap:wrap;gap:1.4mm 5mm;margin-top:3.4mm;font-size:8.3pt;color:#D5D1DB}.id .ci{color:var(--dhead)}
.id>div{position:relative}
.ab{grid-column:1/-1}
.side{display:grid;gap:3.6mm;align-content:start}
.main{display:grid;gap:3.6mm;align-content:start}
h2{font-size:8.4pt;font-weight:700;color:var(--acc);letter-spacing:.02em;margin:0 0 3mm}
.rf2{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
`;
const bentoTpl = vars => d => { const b = parts(d); return [`:root{${vars}}` + BENTO, `<div class="pg"><div class="body">
<header class="tl id">${RINGS(5, 'orb2')}${b.face('ph')}<div><h1>${esc(d.name)}</h1><div class="role">${esc(d.title)}</div><div class="cns">${b.contact}</div></div></header>
${d.summary ? `<section class="tl ab"><h2>About me</h2><p class="bio">${esc(d.summary)}</p></section>` : ''}
<div class="main">${b.exp ? `<section class="tl"><h2>Experience</h2>${b.exp}</section>` : ''}${b.edu ? `<section class="tl"><h2>Education</h2>${b.edu}</section>` : ''}${b.refs ? `<section class="tl"><h2>References</h2><div class="rf2">${b.refs}</div></section>` : ''}</div>
<div class="side">${b.skills ? `<section class="tl"><h2>Skills</h2><div class="sks">${b.skills}</div></section>` : ''}${b.langs ? `<section class="tl"><h2>Languages</h2>${b.langs}</section>` : ''}${b.certs ? `<section class="tl"><h2>Certificates</h2>${b.certs}</section>` : ''}</div>
</div>${b.foot}</div>`]; };

// 7 · Horizon — a colour band like a sky at dusk; the photo rises over its edge. Labels on the left below.
const HORIZON = SHARED + `
.band{position:relative;height:49mm;padding:13mm 18mm 0;color:#fff;background:radial-gradient(120mm 80mm at 85% 0%,color-mix(in srgb,var(--m1) 70%,transparent),transparent 70%),linear-gradient(160deg,var(--m2),var(--dark));overflow:hidden}
.band .orb3{position:absolute;right:-12mm;top:-34mm;width:120mm;height:120mm;color:#fff;opacity:.28}
.band h1{position:relative;font-size:29pt;font-weight:760;letter-spacing:-.042em;line-height:1;max-width:120mm}
.band .role{position:relative;font-size:11.6pt;color:#fff;opacity:.82;margin-top:2.4mm;font-weight:520}
.band .cns{position:relative;display:flex;flex-wrap:wrap;gap:1.4mm 6mm;margin-top:4.4mm;font-size:8.6pt;color:rgba(255,255,255,.86)}.band .ci{color:#fff}
.ph{position:absolute;right:18mm;top:33mm;width:31mm;height:31mm;border-radius:50%;object-fit:cover;font-size:20pt;box-shadow:0 0 0 1.4mm #fff,0 4mm 10mm -4mm rgba(0,0,0,.45);z-index:2}
.body{padding:3mm 18mm 6mm}
.row{display:grid;grid-template-columns:28mm 1fr;gap:6mm;padding:3.6mm 0;border-bottom:.5pt solid #EEEBE5}
.row:last-child{border-bottom:0}
.lab{font-size:8.6pt;font-weight:700;color:var(--acc);padding-top:.5mm}
.row.ab{padding-right:0}.flt{float:right;width:31mm;height:11mm}.row.ab .bio{font-size:9.7pt}
.two2{display:grid;grid-template-columns:1.5fr 1fr;gap:8mm}.three{display:grid;grid-template-columns:1fr 2fr;gap:6mm}.rfs{gap:5mm!important}
.two2 h3,.three h3{font-size:8.2pt;font-weight:700;color:#8B8692;margin-bottom:2.4mm}
.lg{padding:1.1mm 0}
.rfs{display:grid;grid-template-columns:1fr 1fr;gap:6mm}
`;
const horizonTpl = vars => d => { const b = parts(d); return [`:root{${vars}}` + HORIZON, `<div class="pg" style="position:relative">
<header class="band">${RINGS(6, 'orb3')}<h1>${esc(d.name)}</h1><div class="role">${esc(d.title)}</div><div class="cns">${b.contact}</div></header>${b.face('ph')}
<div class="body">
${d.summary ? `<div class="row ab"><div class="lab">About me</div><p class="bio"><span class="flt"></span>${esc(d.summary)}</p></div>` : ''}
${b.exp ? `<div class="row"><div class="lab">Experience</div><div>${b.exp}</div></div>` : ''}
${b.edu ? `<div class="row"><div class="lab">Education</div><div>${b.edu}</div></div>` : ''}
<div class="row"><div class="lab">Strengths</div><div class="two2">${b.skills ? `<div><h3>Skills</h3><div class="sks">${b.skills}</div></div>` : '<div></div>'}${b.langs ? `<div><h3>Languages</h3>${b.langs}</div>` : '<div></div>'}</div></div>
<div class="row"><div class="lab">Credentials</div><div class="three">${b.certs ? `<div><h3>Certificates</h3>${b.certs}</div>` : '<div></div>'}${b.refs ? `<div class="rfw"><h3>References</h3><div class="rfs">${b.refs}</div></div>` : ''}</div></div>
</div>${b.foot}</div>`]; };

const L = { sand: [sideTpl, false, false], dune: [sideTpl, true, false], ink: [headTpl, true, true], stone: [headTpl, false, true], halo: [haloTpl, 'all'], bento: [bentoTpl, 'all'], horizon: [horizonTpl, 'all'] };
const NAMES = { horizon: 'Horizon', sand: 'Sand', bento: 'Bento', halo: 'Halo', stone: 'Stone', dune: 'Dune', ink: 'Ink' };   // order shown in the picker
function renderCV(d, tpl, finish, fontUrl) {
  const [mk, dark, head] = L[tpl] || L.sand, f = F[finish] || F.starlight;
  const [css, html] = mk(dark === 'all' ? fAll(f) : fv(f, dark, head))(d);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.name)} CV</title><style>@font-face{font-family:G;src:url(${fontUrl || 'Geist-Variable.woff2'}) format("woff2");font-weight:100 900}${BASE}${css}</style></head><body>${html}</body></html>`;
}
if (typeof module !== 'undefined') module.exports = { renderCV, NAMES, FINISHES: F };
