const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, powerSaveBlocker, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const lib = u => String(u).startsWith('https:') ? https : http;

app.setName('Elitejobs Hub');
if (process.env.HUB_USERDATA) app.setPath('userData', process.env.HUB_USERDATA); // used by automated tests only
const PORT = process.env.PORT || 8787;
const CFG_FILE = path.join(app.getPath('userData'), 'hub-config.json');
let win = null, baseURL = null, tray = null, quitting = false;

// Only one copy at a time: a second copy would try to start a second Hub.
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function loadConfig() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { return null; } }
function saveConfig(c) { try { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(c)); } catch (e) {} }

// Don't point the window at the Hub until it actually answers,
// so nobody ever stares at a blank window.
function waitForServer(url, tries, cb) {
  lib(url).get(url, { timeout: 8000 }, res => { res.resume(); cb(true); })
    .on('error', () => { if (tries <= 0) return cb(false); setTimeout(() => waitForServer(url, tries - 1, cb), 250); });
}

function askRole() {
  const choice = dialog.showMessageBoxSync({
    type: 'question', buttons: ['This is the Hub PC', 'Connect to a Hub elsewhere'], defaultId: 0, cancelId: 0,
    title: 'Elitejobs Hub — first time on this PC',
    message: 'Is this the one PC that runs the Hub, or does this PC connect to it?',
    detail: 'On IT Support’s main office computer, choose "This is the Hub PC". On every other computer, choose "Connect to a Hub elsewhere".'
  });
  if (choice === 0) { const c = { role: 'server' }; saveConfig(c); return Promise.resolve(c); }
  return new Promise(resolve => {
    const w = new BrowserWindow({ width: 540, height: 280, resizable: false, title: 'Connect to the Hub', backgroundColor: '#171B18',
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'connect-preload.js') } });
    w.setMenuBarVisibility(false);
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <body style="font-family:Segoe UI,sans-serif;padding:24px;background:#171B18;color:#eee;margin:0">
        <p style="margin-top:0">Type the Hub PC’s address exactly as IT Support gave it to you (for example <b>192.168.1.23</b>):</p>
        <input id="a" autofocus style="width:100%;padding:11px;box-sizing:border-box;border-radius:10px;border:1px solid #444;background:#1E231F;color:#eee;font-size:15px" placeholder="192.168.1.23" />
        <button id="b" style="margin-top:14px;padding:11px 20px;border-radius:10px;border:0;background:#C96F4F;color:#fff;font-weight:600;cursor:pointer;font-size:14px">Connect</button>
        <script>const go=()=>window.hubBridge.send(document.getElementById('a').value.trim());
          document.getElementById('b').onclick=go;document.getElementById('a').addEventListener('keydown',e=>{if(e.key==='Enter')go()});</script>
      </body>`));
    ipcMain.once('hub-address', (e, address) => {
      let a = (address || '').trim();
      a = a.replace(/\/+$/, '');
      // an office PC address (numbers) is http with the Hub's port; a name (hub.elitejobsrwanda.com) is the cloud Hub over https
      if (a && !/^https?:\/\//.test(a)) a = (/^[\d.]+(:\d+)?$/.test(a) || /^localhost(:\d+)?$/.test(a) ? 'http://' : 'https://') + a;
      if (a && /^http:/.test(a) && !/:\d+$/.test(a)) a += ':' + PORT;
      const c = { role: 'client', address: a }; saveConfig(c); w.close(); resolve(c);
    });
  });
}

function errorPage(msg) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
    <body style="font-family:Segoe UI,sans-serif;background:#171B18;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
      <div style="max-width:440px"><div style="font-size:44px">📡</div><h2>Can’t reach the Hub</h2><p style="color:#9aa;line-height:1.6">${msg}</p>
      <button onclick="location.href='${baseURL || ''}'" style="padding:11px 20px;border-radius:10px;border:0;background:#C96F4F;color:#fff;cursor:pointer;font-size:14px">Try again</button>
      <p style="color:#677;font-size:12px;margin-top:18px">Retrying on its own every few seconds…</p></div>
      <script>${baseURL ? `setInterval(()=>fetch('${baseURL}/api/ui-version',{mode:'no-cors',cache:'no-store'}).then(()=>location.href='${baseURL}').catch(()=>{}),4000)` : ''}</script></body>`);
}

// Background self-update: the new version downloads quietly from the Hub PC
// and installs the next time the app is closed. Nobody is interrupted.
function startAutoUpdate() {
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  if (!app.isPackaged) return;
  autoUpdater.setFeedURL({ provider: 'generic', url: baseURL + '/updates' });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {}); // no update published yet, or Hub offline: try again later
  autoUpdater.on('update-downloaded', info => {
    if (win) win.webContents.executeJavaScript(
      `typeof toast=='function'&&toast(${JSON.stringify('⬆ App update ' + (info && info.version || '') + ' is ready. It installs the next time you close the app.')})`).catch(() => {});
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, 30 * 60 * 1000);
}

// ---------- other PCs: open even when the Hub PC is off ----------
// Every time the Hub's screens load, a copy is kept on this PC. If the Hub can't
// be reached, the app opens with that copy and works offline; the screens send
// the work to the Hub by themselves when it's back.
const UI_CACHE = () => path.join(app.getPath('userData'), 'offline-ui.html');
function offlineCache(hub) {
  session.defaultSession.protocol.handle(new URL(hub).protocol.replace(':', ''), async req => {
    const u = req.url;
    if (!u.startsWith(hub + '/')) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    const isPage = req.method === 'GET' && new URL(u).pathname === '/';
    try {
      const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : Buffer.from(await req.arrayBuffer());
      const res = await net.fetch(u, { method: req.method, headers: req.headers, body, bypassCustomProtocolHandlers: true });
      if (isPage && res.ok) { const html = await res.text(); try { fs.writeFileSync(UI_CACHE(), html); } catch (e) {}
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); }
      return res;
    } catch (e) {
      if (isPage && fs.existsSync(UI_CACHE())) return new Response(fs.readFileSync(UI_CACHE()), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Hub-Offline': '1' } });
      return new Response(JSON.stringify({ error: 'The Hub is off right now.' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Hub-Offline': '1' } });
    }
  });
}

// ---------- the Hub PC: keep the Hub running for everyone ----------
// Closing the window only hides it (the Hub keeps serving everyone); the PC is
// kept from going to sleep while the Hub runs; and it starts with Windows.
function hubKeepAlive() {
  try { powerSaveBlocker.start('prevent-app-suspension'); } catch (e) {}
  try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {}
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'public', 'icon-512.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Elitejobs Hub — running for everyone');
    const show = () => { if (win) { win.show(); win.focus(); } };
    tray.on('click', show);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Elitejobs Hub', click: show },
      { type: 'separator' },
      { label: 'Stop the Hub for everyone…', click: () => {
        const c = dialog.showMessageBoxSync({ type: 'warning', buttons: ['Keep it running', 'Stop the Hub'], defaultId: 0, cancelId: 0,
          title: 'Stop the Hub?', message: 'Stop the Hub for everyone?', detail: 'Colleagues can keep working offline, but nothing syncs and nobody can check in until the Hub is running again.' });
        if (c === 1) { quitting = true; app.quit(); } } }
    ]));
  } catch (e) {}
  let told = false;
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!told && tray) { told = true; try { tray.displayBalloon({ title: 'Elitejobs Hub is still running', content: 'Colleagues stay connected. To open it again, click the Elitejobs icon next to the clock.' }); } catch (x) {} }
  });
}

// ---------- the Hub moved (to the cloud): follow it, and keep this PC's sign-in ----------
// The old Hub answers /api/where with the new address. This PC then saves its sign-in, keys and
// settings (they live in the old address's storage), switches to the new address and restarts itself.
const CARRY = () => path.join(app.getPath('userData'), 'carry-storage.json');
function getJSON(url, cb) {
  const r = lib(url).get(url, { timeout: 8000 }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { cb(JSON.parse(b)); } catch (e) { cb(null); } }); });
  r.on('error', () => cb(null)); r.on('timeout', () => r.destroy());
}
function watchMove(cfg, here) {
  let done = false;
  const check = () => { if (done) return; getJSON(here + '/api/where', async j => {
    const to = j && j.movedTo; if (done || !to || !(/^https:\/\/[\w.-]+$/.test(to) || (process.env.HUB_MOVE_TEST === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(to))) || to === baseURL) return;
    done = true;
    try { if (win && String(win.webContents.getURL()).startsWith(here)) fs.writeFileSync(CARRY(), await win.webContents.executeJavaScript('JSON.stringify(Object.assign({},localStorage))')); } catch (e) {}
    saveConfig(cfg.role === 'server' ? { role: 'server', moved: to } : { role: 'client', address: to });
    quitting = true; app.relaunch(); app.exit(0);
  }); };
  setTimeout(check, 4000); setInterval(check, 20000);
}
function applyCarry() {
  if (!fs.existsSync(CARRY())) return;
  const once = async () => {
    if (!String(win.webContents.getURL()).startsWith(baseURL)) return win.webContents.once('did-finish-load', once);
    try {
      const data = JSON.parse(fs.readFileSync(CARRY(), 'utf8'));
      await win.webContents.executeJavaScript(`(()=>{const d=${JSON.stringify(data)};for(const k in d){if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k])}})()`);
      fs.unlinkSync(CARRY()); win.webContents.reload();
    } catch (e) {}
  };
  win.webContents.once('did-finish-load', once);
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  let cfg = loadConfig();
  if (!cfg) cfg = await askRole();

  win = new BrowserWindow({ width: 1360, height: 860, minWidth: 900, minHeight: 600, title: 'Elitejobs Hub', backgroundColor: '#0b0717', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 4000);

  // Ctrl+R reloads; Ctrl+Shift+U opens the IT update page (works even if a bad update broke the screens).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const k = (input.key || '').toLowerCase();
    if (k === 'r' && !input.shift) { e.preventDefault(); win.webContents.reload(); }
    if (k === 'u' && input.shift && baseURL) { e.preventDefault(); win.loadURL(baseURL + '/it'); }
  });
  win.webContents.on('render-process-gone', () => setTimeout(() => win && win.webContents.reload(), 800));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // If the Hub can't be reached mid-day (restarted, PC asleep), show the
  // reconnecting screen instead of a blank window.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && baseURL && String(url).startsWith(baseURL))
      win.loadURL(errorPage('Lost contact with the Hub at <b>' + baseURL + '</b>. It will reconnect by itself when the Hub PC is back.'));
  });

  if (cfg.role === 'server') {
    process.env.HUB_DATA_DIR = app.getPath('userData');
    baseURL = 'http://localhost:' + PORT;
    hubKeepAlive();
    try { require('./server.js'); }
    catch (e) { win.show(); return win.loadURL(errorPage('The Hub could not start on this PC: ' + e.message)); }
    // After the move this PC keeps a small pointer running (old QR codes and PCs that were off find the new Hub),
    // and its own window opens the cloud Hub like every other PC.
    if (cfg.moved) { baseURL = cfg.moved; offlineCache(baseURL); }
    else watchMove(cfg, baseURL);
  } else {
    baseURL = cfg.address;
    offlineCache(baseURL);
    watchMove(cfg, baseURL);
  }
  applyCarry();

  waitForServer(baseURL + '/api/ui-version', cfg.role === 'server' && !cfg.moved ? 40 : (fs.existsSync(UI_CACHE()) ? 10 : 24), ok => {
    if (ok) { win.loadURL(baseURL); startAutoUpdate(); }
    else if ((cfg.role !== 'server' || cfg.moved) && fs.existsSync(UI_CACHE())) { win.loadURL(baseURL); startAutoUpdate(); } // Hub off: open with the saved copy
    else {
      win.show();
      win.loadURL(errorPage(cfg.role === 'server'
        ? 'The Hub didn’t start in time. Close the app and open it again.'
        : 'No answer from <b>' + baseURL + '</b>.<br>Check that the Hub PC is switched on and the app is open on it, and that both PCs are on the office network.'));
    }
  });

  // Automated test hook: screenshot what the window really shows, then quit.
  if (process.env.HUB_SELFTEST) {
    const logs = [];
    win.webContents.on('console-message', (e, level, msg) => logs.push(level + ': ' + msg));
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.HUB_SELFTEST + '.png', img.toPNG());
      const dom = await win.webContents.executeJavaScript(`({url:location.href,keygate:!!document.getElementById('keygate')&&!document.getElementById('keygate').hidden,gate:!!document.getElementById('gate')&&!document.getElementById('gate').hidden,welcomeLoaded:!!(document.getElementById('gf')&&document.getElementById('gf').srcdoc),title:document.title})`).catch(e => ({ err: String(e) }));
      fs.writeFileSync(process.env.HUB_SELFTEST + '.json', JSON.stringify({ dom, logs }, null, 2));
      app.quit();
    }, +(process.env.HUB_SELFTEST_WAIT||5000)));
  }
}

app.whenReady().then(createWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
