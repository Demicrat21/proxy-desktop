'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, shell, clipboard, protocol, net, Tray, Menu, Notification, nativeImage,
} = require('electron');

const { ProxyCore } = require('./lib/proxy-core');
const { probe } = require('./lib/upstream');
const { SystemProxy } = require('./lib/system-proxy');
const { ExpiryNotifier } = require('./lib/expiry');

const APP_DIR = path.join(__dirname, 'app');
const ORIGIN_HOST = 'localhost'; // same origin the Android build used (https://localhost) → same server-side CORS rules
const ORIGIN = `https://${ORIGIN_HOST}`;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};
const API_HOSTS = /(^|\.)(sslip\.io|px6\.link|px6\.net|proxy6\.net)$/i;

app.setAppUserModelId('net.proxy6.hub.desktop');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null; let tray = null; let quitting = false;
const userData = () => app.getPath('userData');
const f = (n) => path.join(userData(), n);

const core = new ProxyCore();
let sysProxy; let expiry;

const status = { state: 'disconnected', message: null, proxyId: null, proxyLabel: null, mode: 'system', canRouteTraffic: true, debug: null, updatedAt: null };
let connLog = [];
const isRu = () => /^ru/i.test(app.getLocale());
const tr = (ru, en) => (isRu() ? ru : en);

// ---------- helpers: send events to the web UI (main world) ----------
function emitToWeb(eventName, detail) {
  if (!win || win.isDestroyed()) return;
  const code = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)},{detail:${JSON.stringify(detail)}}))`;
  win.webContents.executeJavaScript(code).catch(() => {});
}

function loadLog() { try { connLog = JSON.parse(fs.readFileSync(f('connection-log.json'), 'utf8')); } catch (_) { connLog = []; } if (!Array.isArray(connLog)) connLog = []; }
function saveLog() { try { fs.writeFileSync(f('connection-log.json'), JSON.stringify(connLog.slice(-200))); } catch (_) {} }

function setStatus(patch, log = true) {
  Object.assign(status, patch, { updatedAt: new Date().toISOString() });
  emitToWeb('android-proxy-status', { ...status });
  if (log) {
    connLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: status.updatedAt, state: status.state,
      message: status.message, proxyId: status.proxyId, proxyLabel: status.proxyLabel, mode: status.mode,
      canRouteTraffic: status.canRouteTraffic, debug: status.debug,
    });
    connLog = connLog.slice(-200); saveLog();
  }
  updateTray();
}

// ---------- connection management (serialized) ----------
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn).catch((e) => console.error('[bridge]', e)); return chain; };

function humanError(r) {
  if (r.code === 'AUTH') return tr('Неверный логин или пароль прокси', 'Proxy login or password rejected');
  if (r.code === 'ETIMEDOUT') return tr('Прокси не отвечает (таймаут)', 'Proxy did not respond (timeout)');
  if (r.code === 'ECONNREFUSED') return tr('Прокси отклонил соединение', 'Proxy refused the connection');
  return `${tr('Не удалось подключиться к прокси', 'Could not connect to proxy')}${r.message ? ': ' + r.message : ''}`;
}

async function teardown() {
  await core.stop();
  if (sysProxy) sysProxy.restore(false);
}

function connectImpl(p) {
  return async () => {
    const label = p.label || `${p.host}:${p.port}`;
    setStatus({ state: 'connecting', message: null, proxyId: p.proxyId ?? null, proxyLabel: label, canRouteTraffic: false, debug: null });
    await teardown();
    const up = { protocol: p.protocol === 'socks5' ? 'socks5' : 'http', host: String(p.host), port: Number(p.port), username: p.username || '', password: p.password || '' };
    const r = await probe(up, p.version);
    if (!r.ok) { setStatus({ state: 'error', message: humanError(r), canRouteTraffic: false, debug: { protocol: up.protocol, code: r.code } }); return; }
    let port;
    try { port = await core.start(up, p.domainRules || []); } catch (e) { setStatus({ state: 'error', message: String(e.message || e), canRouteTraffic: false }); return; }
    const sp = sysProxy.enable(`127.0.0.1:${port}`);
    setStatus({
      state: 'connected',
      message: sp.supported ? null : tr('Системный прокси поддерживается только в Windows', 'System proxy is only supported on Windows'),
      canRouteTraffic: sp.supported,
      debug: { appFilterMode: 'all', protocol: up.protocol, localPort: port, rules: (p.domainRules || []).length, platform: process.platform },
    });
  };
}

function disconnectImpl() {
  return async () => {
    await teardown();
    setStatus({ state: 'disconnected', message: null, proxyId: null, proxyLabel: null, canRouteTraffic: true, debug: null });
  };
}

// ---------- bridge (original Android method names) ----------
const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; } };
const trusted = (e) => { try { return new URL(e.senderFrame.url).origin === ORIGIN; } catch (_) { return false; } };

function safeOpen(url) {
  try { const u = new URL(String(url)); if (['http:', 'https:', 'tg:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString()); } catch (_) {}
}

function hideOrQuit() {
  if (status.state === 'connected' || status.state === 'connecting') { if (win) win.hide(); } else { quitting = true; app.quit(); }
}

const asyncMethods = {
  connectProxy: (p) => enqueue(connectImpl(p)),
  reconnectProxy: (p) => enqueue(connectImpl(p)),
  disconnectProxy: () => enqueue(disconnectImpl()),
  updateDomainRules: (p) => { core.updateRules(p.domainRules || []); },
  getConnectionStatus: () => emitToWeb('android-proxy-status', { ...status }),
  getConnectionLog: () => emitToWeb('android-proxy-log', connLog),
  clearConnectionLog: () => { connLog = []; saveLog(); emitToWeb('android-proxy-log', []); },
  // Per-app routing needs a kernel TUN driver; the desktop build applies the proxy system-wide instead.
  getInstalledApps: () => emitToWeb('android-app-list', []),
  syncExpiryNotifications: (p) => expiry.sync(p),
  clearExpiryNotifications: () => expiry.clear(),
  refreshFcmToken: () => {},
  copyToClipboard: (p) => clipboard.writeText(String(p.text ?? '')),
  openExternalUrl: (p) => safeOpen(p.url),
  minimizeApp: () => hideOrQuit(),
  hideKeyboard: () => {}, showKeyboard: () => {},
};

const syncMethods = {
  getClipboardText: () => clipboard.readText(),
  getAppIcon: () => '',
  getFcmToken: () => null,
  getFcmDiagnostics: () => JSON.stringify({ available: false, hasToken: false, tokenPreview: null, status: 'desktop_unsupported', error: null, updatedAt: Date.now() }),
  getDeviceEnvironment: () => JSON.stringify({ isTelevision: false, otaDisabled: true, platform: 'windows-desktop' }),
  getConnectionDiagnostics: () => JSON.stringify({ platform: process.platform, localPort: core.port, stats: core.stats, status }),
};

ipcMain.on('bridge:call', (e, method, payload) => {
  if (!trusted(e) || !asyncMethods[method]) return;
  try { asyncMethods[method](parse(payload)); } catch (err) { console.error('[bridge]', method, err); }
});
ipcMain.on('bridge:sync', (e, method, payload) => {
  if (!trusted(e) || !syncMethods[method]) { e.returnValue = null; return; }
  try { const v = syncMethods[method](parse(payload)); e.returnValue = v === undefined ? null : v; } catch (_) { e.returnValue = null; }
});

// ---------- static files + CORS shim over https://localhost ----------
function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || 'Content-Type, X-Client-Id, Authorization',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
  };
}

function registerProtocol() {
  protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === ORIGIN_HOST) {
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
      const file = path.normalize(path.join(APP_DIR, rel));
      if (!file.startsWith(APP_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
      try {
        const buf = await fs.promises.readFile(file);
        return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
      } catch (_) { return new Response('Not found', { status: 404 }); }
    }
    const isApi = API_HOSTS.test(url.hostname);
    if (isApi && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    const resp = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    if (!isApi) return resp;
    const h = new Headers(resp.headers);
    for (const k of [...h.keys()]) if (k.toLowerCase().startsWith('access-control-')) h.delete(k);
    for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  });
}

// ---------- window / tray ----------
function loadBounds() { try { return JSON.parse(fs.readFileSync(f('window.json'), 'utf8')); } catch (_) { return {}; } }
let boundsTimer = null;
function saveBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => { if (win && !win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) { try { fs.writeFileSync(f('window.json'), JSON.stringify(win.getBounds())); } catch (_) {} } }, 400);
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 480, height: b.height || 860, x: b.x, y: b.y, minWidth: 360, minHeight: 560,
    backgroundColor: '#050505', show: false, autoHideMenuBar: true, title: 'Proxy6',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveBounds); win.on('move', saveBounds);
  win.on('close', (e) => { if (!quitting && (status.state === 'connected' || status.state === 'connecting')) { e.preventDefault(); win.hide(); } });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== ORIGIN) { e.preventDefault(); safeOpen(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { safeOpen(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const c = i.control || i.meta;
    if (i.key === 'F5' || (c && i.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
    else if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (c && (i.key === '=' || i.key === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (c && i.key === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (c && i.key === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
    else if (process.argv.includes('--dev') && c && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.loadURL(`${ORIGIN}/`);
}

function showWindow() { if (!win) return createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function updateTray() {
  if (!tray) return;
  const st = { connected: tr('Подключено', 'Connected'), connecting: tr('Подключение…', 'Connecting…'), disconnected: tr('Отключено', 'Disconnected'), error: tr('Ошибка', 'Error') }[status.state] || status.state;
  tray.setToolTip(`Proxy6 — ${st}${status.proxyLabel && status.state !== 'disconnected' ? ` (${status.proxyLabel})` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('Открыть Proxy6', 'Open Proxy6'), click: showWindow },
    { label: `${st}${status.proxyLabel && status.state === 'connected' ? ` — ${status.proxyLabel}` : ''}`, enabled: false },
    { label: tr('Отключить', 'Disconnect'), enabled: status.state === 'connected' || status.state === 'connecting', click: () => enqueue(disconnectImpl()) },
    { type: 'separator' },
    { label: tr('Выход', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

// ---------- lifecycle ----------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  sysProxy = new SystemProxy(f('system-proxy-backup.json'));
  sysProxy.restore(true); // recover if a previous run crashed while connected
  expiry = new ExpiryNotifier(f('expiry.json'), (title, body) => { if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') }).show(); });
  loadLog();
  registerProtocol();
  createWindow();
  createTray();
  expiry.start();
});

app.on('window-all-closed', () => { if (quitting || status.state === 'disconnected' || status.state === 'error') app.quit(); });

let cleaned = false;
function cleanupSync() {
  if (cleaned) return; cleaned = true;
  try { if (sysProxy) sysProxy.restore(true); } catch (_) {}
  try { core.stop(); } catch (_) {}
}
app.on('before-quit', () => { quitting = true; cleanupSync(); });
app.on('will-quit', cleanupSync);
process.on('exit', cleanupSync);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupSync(); process.exit(0); });
