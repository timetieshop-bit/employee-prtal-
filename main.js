const { app, BrowserWindow, session, ipcMain, Menu, clipboard, desktopCapturer } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { SipPhone } = require('./native/sip-core.js'); // native UDP SIP/RTP softphone

// QUIC (HTTP/3 over UDP) can bypass or stall against an HTTP proxy, which makes
// Google/reCAPTCHA hang ("just loading") when browsing through a proxy. Force all
// traffic onto TCP so the proxy handles every request.
app.commandLine.appendSwitch('disable-quic');

// The embedded browser is driven by a human agent, but Electron advertises
// itself as an automated client (the "AutomationControlled" blink feature),
// which makes sites like YouTube throw a false "confirm you're not a bot" wall.
// Turning that feature off makes the browser behave like the ordinary Chrome it
// is built on, so legitimate browsing isn't blocked by a false positive.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// Don't leak the real IP over WebRTC when browsing behind the proxy (matches the
// WebView2 browser's behaviour).
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

// Absolute path to the preload injected into every embedded-browser page.
// Enforces clipboard isolation before any page script runs.
const WEBVIEW_PRELOAD = path.join(__dirname, 'renderer', 'webview-preload.js');

// --- Configuration ---------------------------------------------------------

// EDIT THIS to point at the PHP API on your VPS (must be HTTPS).
// Example: 'https://portal.yourdomain.com/api'
const API_BASE = process.env.PORTAL_API || 'https://employee-portal-server.publishsphere.online/api';

const SHIFT_HOURS = 8;

let mainWindow;

// The proxy for the current employee, received from the server at login.
let currentProxy = null;
// The proxy assigned at login, kept so the server flag can turn routing on/off.
let assignedProxy = null;

// The signed-in session token, kept in the main process for monitoring calls.
let currentToken = null;

// Policy config (website lists + blocked/allowed apps) received at login.
let currentPolicy = { blocklist: [], allowlist: [], blockedApps: [], allowedApps: [] };
let currentPhone = null; // SIP softphone config for the signed-in user (or null)
function pushPhone() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('phone:config', currentPhone); } catch (_) {}
  }
}

// Google Sheets assigned to the signed-in user. Names + ids only — the URL is
// NEVER kept here or sent to the renderer; it's resolved on demand via
// sheet_url.php (see the 'sheet:url' handler) so the processor never sees it.
let currentSheets = [];
function pushSheets() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('sheets:list', currentSheets); } catch (_) {}
  }
}

// Server-controlled enforcement flags. Defaults are safe (everything on) so the
// app is locked even before the first server response; the server can loosen or
// tighten any of these live via the poll below.
let currentFeatures = {
  clipboardLock: true, contentProtection: true, appBlocker: true,
  appBlockIntervalMs: 4000, websiteFilter: true, proxyEnabled: true, heartbeatMs: 45000,
  configPollMs: 15000, kioskFullscreen: false, alwaysOnTop: false,
  appMode: 'blocklist', // 'blocklist' = block listed; 'allowlist' = allow only listed
  preventMinimize: false, keepForeground: false, foregroundGraceMs: 5000,
};

// The portal's own install directory — every process running from here (the app
// and its Electron helpers) is always allowed, so allowlist mode never kills us.
const APP_DIR = path.dirname(process.execPath).toLowerCase();

// Handle for the config poll timer.
let configPollTimer = null;

// Auto-updater (optional dependency; absent in a plain dev run).
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { autoUpdater = null; }
let updateTimer = null;
let updateWired = false;
let appliedUpdate = { on: null, mins: null };
let isLoggedIn = false;        // set true after a successful login
let launchUpdatePending = false; // an update is downloading on the login screen

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('update:status', status); } catch (_) {}
  }
}

// Wire the updater's event handlers exactly once.
function wireUpdater() {
  if (!autoUpdater || updateWired) return;
  updateWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', () => {
    if (!isLoggedIn) { launchUpdatePending = true; sendUpdateStatus('downloading'); }
  });
  autoUpdater.on('download-progress', (p) => {
    if (!isLoggedIn && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('update:progress', Math.max(0, Math.min(100, p.percent || 0))); } catch (_) {}
    }
  });
  autoUpdater.on('update-not-available', () => { if (!isLoggedIn) sendUpdateStatus('ready'); });
  autoUpdater.on('update-downloaded', () => {
    // Before login, ALWAYS install right away (update first, then let them log in).
    // After login, 'immediately' relaunches now; otherwise it installs on next quit.
    if (!isLoggedIn || currentFeatures.updateInstall === 'immediately') {
      sendUpdateStatus('installing');
      setTimeout(() => {
        let quit = false;
        app.once('before-quit', () => { quit = true; });
        try { autoUpdater.quitAndInstall(true, true); } catch (_) {}
        // If the installer can't actually run (e.g. an unsigned build blocked or
        // quarantined by Defender/SmartScreen), quitAndInstall fails silently and
        // the app keeps running. Don't trap the user on the login screen — release
        // the gate so they can sign in with the current version.
        setTimeout(() => { if (!quit && !isLoggedIn) sendUpdateStatus('ready'); }, 8000);
      }, 400);
    }
  });
  autoUpdater.on('error', () => { if (!isLoggedIn) sendUpdateStatus('ready'); });
}

// Pre-login check: the update feed (latest.yml) is a public static file, so this
// needs no token. If a newer build exists it downloads and installs before login.
function checkUpdatesAtLaunch() {
  if (!autoUpdater || !app.isPackaged) { sendUpdateStatus('ready'); return; }
  wireUpdater();
  autoUpdater.autoInstallOnAppQuit = true;
  sendUpdateStatus('checking');
  autoUpdater.checkForUpdates().catch(() => sendUpdateStatus('ready'));
}

// Server-controlled auto-update (post-login): re-checks on the admin-set interval
// and either installs on restart (safe) or relaunches immediately.
function applyAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  wireUpdater();
  autoUpdater.autoInstallOnAppQuit = (currentFeatures.updateInstall !== 'immediately');

  // Only (re)schedule when on/off or interval changed — not on every config poll.
  const on = currentFeatures.autoUpdate === true;
  const mins = Math.max(15, Number(currentFeatures.updateCheckMin) || 180);
  if (appliedUpdate.on === on && appliedUpdate.mins === mins) return;
  appliedUpdate = { on, mins };

  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  if (on) {
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    updateTimer = setInterval(check, mins * 60 * 1000);
  }
}

// Exit gating: only active after login, and only if the employee has an exit password.
let gateExit = false;
let allowClose = false;
let allowMinimizeOnce = false;

// When the portal lost focus (ms epoch), used to report how long it was away.
let awaySince = 0;

// Shift end as a local-clock timestamp (ms), sent by the renderer which already
// reconciles it against the server clock. After this, closing needs no password.
let currentShiftEndMs = 0;
function shiftEnded() { return currentShiftEndMs > 0 && Date.now() >= currentShiftEndMs; }

// In-app ("internal") clipboard. Copy/cut inside the portal stores text here
// instead of the OS clipboard, and paste reads from here — so copy/paste works
// INSIDE the portal, but nothing crosses to or from other apps.
let internalClip = '';

// Clipboard history (most-recent first) so an agent can copy several things and
// paste any one of them. Captures copies made anywhere in the app.
let clipHistory = [];
const CLIP_HISTORY_MAX = 25;
function addClip(text) {
  text = String(text || '');
  if (!text.trim()) return;
  clipHistory = clipHistory.filter((t) => t !== text);
  clipHistory.unshift(text);
  if (clipHistory.length > CLIP_HISTORY_MAX) clipHistory.length = CLIP_HISTORY_MAX;
}

// Poll the OS clipboard while focused so copies made by websites (copy buttons
// using navigator.clipboard / execCommand, which don't fire our copy handler)
// also land in the history. Our own writes are deduped by addClip.
let clipWatchTimer = null;
let lastOsClip = '';
function startClipWatch() {
  if (clipWatchTimer) return;
  clipWatchTimer = setInterval(() => {
    if (currentFeatures.clipboardLock === false) return;
    try {
      const t = clipboard.readText();
      if (t && t !== lastOsClip) { lastOsClip = t; internalClip = t; addClip(t); }
    } catch (_) {}
  }, 1000);
}

// Turn ON Windows Clipboard History (Win+V) so agents can keep several copied
// items and paste any one — replacing the in-app clipboard panel. Best-effort.
function enableWinClipboardHistory() {
  if (process.platform !== 'win32') return;
  try {
    execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Clipboard', '/v', 'EnableClipboardHistory',
      '/t', 'REG_DWORD', '/d', '1', '/f'], { windowsHide: true }, () => {});
  } catch (_) {}
}

// Clear the Windows clipboard AND its Win+V history — called before the app
// exits so nothing an agent copied lingers on the machine afterwards.
function clearWinClipboard() {
  return new Promise((resolve) => {
    try { clipboard.clear(); } catch (_) {}
    if (process.platform !== 'win32') return resolve();
    const ps =
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null; ' +
      '[Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel.DataTransfer,ContentType=WindowsRuntime] | Out-Null; ' +
      'try { [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory() | Out-Null } catch {}; ' +
      'try { [Windows.ApplicationModel.DataTransfer.Clipboard]::Clear() | Out-Null } catch {}';
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 4000 }, () => resolve());
    } catch (_) { resolve(); }
  });
}

// App-blocking interval handle.
let appBlockTimer = null;

// Small helper for authenticated API calls from the main process.
async function apiCall(path, method = 'POST', payload = null) {
  const headers = {};
  if (currentToken) headers['X-Auth-Token'] = currentToken;
  if (payload) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}/${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return res.json().catch(() => ({}));
}

// Normalize a site list to bare lower-case domains (drop scheme/path/www).
function cleanProxyDomains(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s || '').trim().toLowerCase())
    .map((s) => s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
    .filter(Boolean);
}

// Three proxy modes (admin-controlled):
//   all        — everything goes through the proxy (original behaviour)
//   allowlist  — ONLY the listed sites go through the proxy; everything else direct
//   blocklist  — the listed sites go DIRECT; everything else through the proxy
async function applyProxy(proxy) {
  const workSession = session.fromPartition('persist:work');
  if (!proxy || !proxy.host) {
    currentProxy = null;
    await workSession.setProxy({ proxyRules: 'direct://' });
    return;
  }
  currentProxy = proxy;
  const mode = currentFeatures.proxyMode || 'all';
  const sites = cleanProxyDomains(currentFeatures.proxySites);
  const proxyRules = `${proxy.host}:${proxy.port}`;

  if (mode === 'allowlist' && sites.length) {
    // Only listed sites (and their subdomains) use the proxy; the rest go direct.
    const pac =
      'function FindProxyForURL(url, host){host=(host||"").toLowerCase();' +
      'var s=' + JSON.stringify(sites) + ';' +
      'for(var i=0;i<s.length;i++){var d=s[i];' +
      'if(host===d||(host.length>d.length&&host.slice(-d.length-1)==="."+d)){return "PROXY ' + proxyRules + '";}}' +
      'return "DIRECT";}';
    await workSession.setProxy({
      mode: 'pac_script',
      pacScript: 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pac).toString('base64'),
    });
    return;
  }
  if (mode === 'blocklist' && sites.length) {
    // Listed sites (and subdomains) bypass the proxy; everything else uses it.
    const bypass = ['<local>'];
    sites.forEach((d) => { bypass.push(d, '*.' + d); });
    await workSession.setProxy({ proxyRules, proxyBypassRules: bypass.join(',') });
    return;
  }
  // 'all' (or an empty list) → everything through the proxy.
  await workSession.setProxy({ proxyRules, proxyBypassRules: '<local>' });
}

function setZoom(wc, delta) {
  try { wc.setZoomLevel(Math.max(-3, Math.min(5, (wc.getZoomLevel() || 0) + delta))); } catch (_) {}
}

// A normal browser right-click menu for the embedded browser.
function showBrowserContextMenu(wc, params) {
  const isGuest = !mainWindow || wc !== mainWindow.webContents;
  const items = [];
  if (params.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => { if (mainWindow) mainWindow.webContents.send('nav:external', params.linkURL); } });
    items.push({ label: 'Copy link address', click: () => { try { clipboard.writeText(params.linkURL); } catch (_) {} } });
    items.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Copy image address', click: () => { try { clipboard.writeText(params.srcURL); } catch (_) {} } });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ label: 'Cut', enabled: !!params.selectionText, click: () => wc.cut() });
    items.push({ label: 'Copy', enabled: !!params.selectionText, click: () => wc.copy() });
    items.push({ label: 'Paste', enabled: params.editFlags && params.editFlags.canPaste, click: () => wc.paste() });
    items.push({ label: 'Select all', click: () => wc.selectAll() });
  } else if (params.selectionText) {
    items.push({ label: 'Copy', click: () => wc.copy() });
    items.push({ label: 'Select all', click: () => wc.selectAll() });
  } else if (isGuest) {
    items.push({ label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() });
    items.push({ label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() });
    items.push({ label: 'Reload', click: () => wc.reload() });
    items.push({ type: 'separator' });
    items.push({ label: 'Select all', click: () => wc.selectAll() });
  }
  if (!items.length) return;
  try {
    const win = BrowserWindow.fromWebContents(wc) || mainWindow;
    Menu.buildFromTemplate(items).popup({ window: win });
  } catch (_) {}
}

// Close the clipboard escape hatches on any webContents (the portal chrome
// and the embedded browser alike).
function lockWebContents(wc) {
  if (!wc) return;

  // 1) Right-click menu — a normal browser context menu (Back/Forward/Reload,
  //    Cut/Copy/Paste, Copy link, Open link in new tab). No "Inspect".
  wc.on('context-menu', (e, params) => { showBrowserContextMenu(wc, params); });

  // 2) Keyboard shortcuts. DevTools, Print and PrintScreen are always swallowed.
  //    Copy/Cut/Paste/Select-All pass through to the page. Find (Ctrl+F) and zoom
  //    (Ctrl +/-/0) are handled here like a normal browser.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    const devtools = key === 'f12' || (mod && input.shift && ['i', 'j', 'c'].includes(key));
    const other = key === 'printscreen' || (mod && key === 'p'); // screenshot / print
    if (devtools || other) { e.preventDefault(); return; }

    const isGuest = !mainWindow || wc !== mainWindow.webContents;
    if (!isGuest) return;
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); setZoom(wc, 0.5); }
    else if (mod && key === '-') { e.preventDefault(); setZoom(wc, -0.5); }
    else if (mod && key === '0') { e.preventDefault(); try { wc.setZoomLevel(0); } catch (_) {} }
    else if (mod && key === 'f') { e.preventDefault(); if (mainWindow) mainWindow.webContents.send('find:open'); }
    else if (key === 'escape') { if (mainWindow) mainWindow.webContents.send('find:close'); }
  });

  // 3) Popups:
  //    - A normal http(s) popup/target=_blank link → open it as a new in-app tab
  //      (keeps everything inside the locked, proxied browser).
  //    - A blank/named popup (about:blank, "") → a form that posts INTO a popup
  //      window. Denying it makes window.open() return null and the submission
  //      silently fails (spinner flashes and dies). Allow it as a controlled
  //      child window on the SAME locked, proxied session so the post completes.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      if (mainWindow) mainWindow.webContents.send('nav:external', url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 640, minimizable: false, maximizable: false,
        autoHideMenuBar: true, backgroundColor: '#ffffff',
        webPreferences: {
          partition: 'persist:work',   // same proxied session + permissions
          preload: WEBVIEW_PRELOAD,
          contextIsolation: false, nodeIntegration: false, sandbox: false,
          devTools: false,
        },
      },
    };
  });

  // Lock any child popup window the same way as the main browser.
  wc.on('did-create-window', (childWin) => {
    try {
      childWin.setContentProtection(true);
      childWin.setMenuBarVisibility(false);
      lockWebContents(childWin.webContents);
    } catch (_) {}
  });

  // 4) Belt-and-suspenders: never let DevTools actually open.
  wc.on('devtools-opened', () => wc.closeDevTools());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#f1f3f4',
    show: false,              // show once ready, already full-screen
    fullscreen: true,         // fill the screen (hides the taskbar), like a game
    resizable: false,         // the window cannot be resized
    maximizable: false,
    minimizable: true,        // governed by the preventMinimize flag at runtime
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // enables the embedded <webview> browser
      devTools: false,  // no DevTools on the portal chrome (would bypass locks)
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => { mainWindow.setFullScreen(true); mainWindow.show(); });

  // Screenshot / screen-record protection: the window shows up black in any
  // capture tool (Windows uses SetWindowDisplayAffinity under the hood).
  mainWindow.setContentProtection(true);

  // --- Clipboard isolation, main-process side -----------------------------
  // The webview preload blocks copy/paste/drag inside pages. These handlers
  // close the escape hatches that live outside the page: menu accelerators,
  // the native right-click menu, DevTools, and popup windows.
  lockWebContents(mainWindow.webContents);

  // Force the right settings onto the embedded browser and inject the
  // clipboard-lock preload before it loads anything.
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = WEBVIEW_PRELOAD;
    // contextIsolation is OFF for the embedded browser so the preload can run its
    // browser-fidelity shims (userAgentData, window.chrome, plugins, WebGL) in the
    // page's own world before the page's scripts — otherwise a Chrome UA with
    // Electron JS signals reads as a bot. nodeIntegration stays OFF (pages get no
    // Node), and the preload keeps its internals private, so the page can't reach
    // require/ipc.
    webPreferences.contextIsolation = false;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.sandbox = false; // so the preload can use ipcRenderer for the internal clipboard
    webPreferences.devTools = false;
    webPreferences.spellcheck = false;
  });

  // Once the embedded browser exists, lock it the same way as the chrome.
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    lockWebContents(guest);
    // The window's content protection already blacks out the webview region
    // in screen captures, so nothing extra is needed on the guest here.
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // --- Close gate: need the exit password DURING the shift; once the shift has
  //     ended the portal closes freely (no password). ---
  mainWindow.on('close', (e) => {
    if (allowClose || !gateExit || shiftEnded()) return;
    e.preventDefault();
    mainWindow.webContents.send('exit:request', 'close');
  });

  // --- Minimize: log it, optionally forbid it, else gate with the password ---
  mainWindow.on('minimize', () => {
    logEvent('app_minimized');
    if (currentFeatures.preventMinimize) { mainWindow.restore(); return; }
    if (!gateExit) return;
    if (allowMinimizeOnce) { allowMinimizeOnce = false; return; }
    mainWindow.restore();
    mainWindow.webContents.send('exit:request', 'minimize');
  });
  mainWindow.on('restore', () => logEvent('app_restored'));

  // Never let anything (F11, the OS) drop the portal out of full screen.
  mainWindow.on('leave-full-screen', () => {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (currentFeatures.kioskFullscreen) mainWindow.setKiosk(true);
      else mainWindow.setFullScreen(true);
    }, 50);
  });

  // --- Focus tracking: catch "sent to the background during duty" ---
  // Every time the portal loses focus we start a timer and log it; when it
  // comes back we log how long it was away. This is the record that answers
  // "it closed/minimized by mistake": the timestamps and durations are on the
  // server, not the employee's word.
  mainWindow.on('blur', () => {
    if (!currentToken) return;
    awaySince = Date.now();
    if (currentFeatures.keepForeground) scheduleForeground();
  });
  mainWindow.on('focus', () => {
    cancelForeground();
    if (!currentToken || !awaySince) return;
    const secs = Math.round((Date.now() - awaySince) / 1000);
    awaySince = 0;
    // One tidy record per away period; ignore sub-3s focus flickers.
    if (secs >= 3) logEvent('focus_gained', String(secs));
  });
}

// Small helper so window events log without repeating the try/catch.
function logEvent(type, meta = null) {
  if (!currentToken) return;
  apiCall('event.php', 'POST', { type, meta }).catch(() => {});
}

// --- Keep-foreground watchdog ----------------------------------------------
// If enabled, a window that loses focus is pulled back to the front after a
// short grace period (so a quick, legitimate glance elsewhere is tolerated but
// parking the portal in the background is not).
let foregroundTimer = null;
function scheduleForeground() {
  cancelForeground();
  const grace = Math.max(2000, Number(currentFeatures.foregroundGraceMs) || 5000);
  foregroundTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !currentToken) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.moveTop) mainWindow.moveTop();
    logEvent('forced_foreground');
  }, grace);
}
function cancelForeground() {
  if (foregroundTimer) { clearTimeout(foregroundTimer); foregroundTimer = null; }
}

// --- Website hard-block (network layer) ------------------------------------
function urlIsBlocked(url) {
  const u = String(url).toLowerCase();
  return (currentPolicy.blocklist || []).some((p) => p && u.includes(p));
}

function setupWebFilter() {
  const ws = session.fromPartition('persist:work');
  ws.webRequest.onBeforeRequest((details, cb) => {
    if (currentFeatures.websiteFilter === false) return cb({});
    if (details.resourceType === 'mainFrame' && urlIsBlocked(details.url)) {
      if (mainWindow) mainWindow.webContents.send('nav:blocked', details.url);
      return cb({ cancel: true });
    }
    cb({});
  });
}

// --- Blocked desktop apps (Windows) ----------------------------------------
//
// The old version ran `taskkill /IM chrome.exe`, which matches only the file
// name on disk — so an employee could rename chrome.exe to notes.exe and walk
// straight past it. This version enumerates every process together with the
// metadata baked into the executable (OriginalFilename, FileDescription,
// ProductName, CompanyName). Those fields come from the binary itself and do
// NOT change when the file is renamed, so "chrome" still matches a renamed
// Chrome. An admin can also pin a specific build by SHA-256 for binaries whose
// metadata has been stripped.

function startAppBlocker() {
  stopAppBlocker();
  if (process.platform !== 'win32') return; // process-killing is Windows-only here
  if (currentFeatures.appBlocker === false) return;
  const iv = Math.max(1000, Number(currentFeatures.appBlockIntervalMs) || 4000);
  appBlockTimer = setInterval(killBlockedApps, iv);
  killBlockedApps();
}
function stopAppBlocker() {
  if (appBlockTimer) { clearInterval(appBlockTimer); appBlockTimer = null; }
}

// Generic words that carry no identifying weight — stripped so "AdsPower
// Browser" is matched by its distinctive word ("adspower"), not by "browser"
// (which would also hit Chrome/Edge).
const STOPWORDS = new Set([
  'browser', 'app', 'application', 'desktop', 'portable', 'the', 'exe',
  'launcher', 'client', 'global', 'setup', 'installer', 'x64', 'x86',
]);

// Processes we must never kill, so a careless list entry can't take the machine
// down via an accidental substring hit.
const PROTECTED = new Set([
  'system', 'system idle process', 'registry', 'memory compression', 'smss',
  'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'fontdrvhost',
  'dwm', 'explorer', 'conhost', 'taskhostw', 'ctfmon', 'sihost', 'runtimebroker',
  // Shell / desktop UI that owns windows — killing these harms the desktop.
  'startmenuexperiencehost', 'shellexperiencehost', 'searchhost', 'searchapp',
  'textinputhost', 'applicationframehost', 'lockapp', 'logonui', 'dllhost',
]);

// Split the admin's blocked-app list into word-matchers and SHA-256 hashes.
//   "chrome.exe"        -> match any process whose identity contains "chrome"
//   "adspower browser"  -> match processes containing "adspower"
//   "sha256:<64hex>"    -> match the exact binary by hash
function parseTokens(list) {
  const matchers = []; // each: { words: [...], raw: '...' }
  const hashes = [];
  for (const raw of (list || [])) {
    let t = String(raw || '').trim().toLowerCase().replace(/^"|"$/g, '');
    if (!t) continue;
    if (t.startsWith('sha256:')) t = t.slice(7);
    if (/^[0-9a-f]{64}$/.test(t)) { hashes.push(t); continue; }

    const cleaned = t.replace(/\.exe$/, '');
    const words = cleaned.split(/[\s_\-.]+/).filter((w) => w && !STOPWORDS.has(w));
    matchers.push({ words: words.length ? words : [cleaned], raw: cleaned });
  }
  return { matchers, hashes };
}

// Cheap SHA-256 with an mtime-keyed cache so we don't re-hash the same binary
// every tick.
const hashCache = new Map();
function fileSha256(p) {
  try {
    const st = fs.statSync(p);
    const hit = hashCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.sha256;
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    hashCache.set(p, { mtimeMs: st.mtimeMs, sha256: sha });
    return sha;
  } catch (_) { return null; }
}

// Enumerate processes via WMI (Win32_Process) for reliable path + command line
// even across sessions, pull each binary's embedded version info from disk, and
// collect window titles. All of these are things a simple rename can't scrub:
// OriginalFilename / ProductName / CompanyName live inside the .exe, and the
// window title and command line usually still name the real product.
// Reading embedded version info is the expensive part, so we skip it for the
// ~100 processes that live under C:\Windows (system stuff can't be the renamed
// AdsPower we're hunting), and read it only for user-launched binaries. That
// cuts the per-tick cost dramatically and keeps the UI responsive.
const PS_ENUM = [
  '$ErrorActionPreference="SilentlyContinue";',
  '$t=@{};Get-Process|?{$_.MainWindowTitle}|%{$t[[string]$_.Id]=$_.MainWindowTitle};',
  '$sr=$env:SystemRoot;',
  '$o=foreach($p in Get-CimInstance Win32_Process){',
  '$v=$null;if($p.ExecutablePath -and $p.ExecutablePath -notlike "$sr*"){try{$v=(Get-Item -LiteralPath $p.ExecutablePath).VersionInfo}catch{}}',
  '[pscustomobject]@{id=$p.ProcessId;name=$p.Name;path=$p.ExecutablePath;cmd=$p.CommandLine;',
  'orig=$v.OriginalFilename;desc=$v.FileDescription;prod=$v.ProductName;comp=$v.CompanyName;',
  'title=$t[[string]$p.ProcessId]}};',
  '$o|ConvertTo-Json -Compress',
].join('');

// Guard against overlapping runs: if a tick is still enumerating when the next
// fires, skip it so slow machines never pile up PowerShell processes.
let appScanBusy = false;

function killBlockedApps() {
  if (process.platform !== 'win32') return;
  if (currentFeatures.appBlocker === false) return;
  if (appScanBusy) return; // previous scan still running

  const allowlistMode = currentFeatures.appMode === 'allowlist';
  const block = parseTokens(currentPolicy.blockedApps);
  const allow = parseTokens(currentPolicy.allowedApps);

  // Nothing to do in blocklist mode with an empty list. Allowlist mode always
  // runs (it denies by default).
  if (!allowlistMode && !block.matchers.length && !block.hashes.length) return;

  appScanBusy = true;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_ENUM],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => {
      appScanBusy = false;
      if (err || !stdout) return;
      let list;
      try { list = JSON.parse(stdout); } catch (_) { return; }
      if (!Array.isArray(list)) list = [list];

      for (const p of list) {
        if (!p || p.id === process.pid) continue;              // never kill ourselves
        const nm = String(p.name || '').toLowerCase().replace(/\.exe$/, '');
        if (PROTECTED.has(nm)) continue;                       // never kill core Windows
        const pathl = String(p.path || '').toLowerCase();

        // Everything we know about this process, lower-cased, as one haystack.
        const hay = [p.name, p.path, p.cmd, p.orig, p.desc, p.prod, p.comp, p.title]
          .filter(Boolean).join(' ').toLowerCase();

        const hashHit = (toks) =>
          toks.hashes.length && pathl && toks.hashes.includes(fileSha256(p.path) || '');
        const nameHit = (toks) => toks.matchers.some((m) => m.words.every((w) => hay.includes(w)));

        if (allowlistMode) {
          // DEFAULT-DENY: kill any user-facing app that isn't on the allowlist.
          // "User-facing" = it owns a visible window (has a title). Background
          // services (no window) are left alone so Windows keeps running, and
          // the shell/desktop processes above are protected. This is what lets
          // us close Notepad/Paint/etc. even though they live under C:\Windows.
          if (pathl && pathl.startsWith(APP_DIR)) continue;   // the portal + helpers
          const hasWindow = !!(p.title && String(p.title).trim());
          if (!hasWindow) continue;                            // invisible service
          const permitted = nameHit(allow) || hashHit(allow);
          if (!permitted) killPid(p.id, p.name || String(p.id));
        } else {
          // BLOCKLIST: kill only what matches the blocked list.
          if (nameHit(block) || hashHit(block)) killPid(p.id, p.name || String(p.id));
        }
      }
    }
  );
}

function killPid(pid, label) {
  // /T also terminates child processes (an anti-detect browser spawns several).
  execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, (err) => {
    if (!err) apiCall('event.php', 'POST', { type: 'app_killed', meta: label }).catch(() => {});
  });
}

// Remembers what window state we've actually applied, so we only touch the
// window when something CHANGES. Re-applying kiosk/fullscreen/always-on-top every
// config poll was making the window visibly "jerk" once a minute.
const appliedWin = { contentProtection: null, kiosk: null, alwaysOnTop: null, minimizable: null };
let appliedBlocker = { on: null, interval: null };
let appliedProxyKey = null;

// --- Apply server-controlled flags to the running app ----------------------
function applyFeatures(feat) {
  if (feat && typeof feat === 'object') currentFeatures = { ...currentFeatures, ...feat };

  if (mainWindow && !mainWindow.isDestroyed()) {
    const cp = currentFeatures.contentProtection !== false;
    if (appliedWin.contentProtection !== cp) {
      mainWindow.setContentProtection(cp);
      appliedWin.contentProtection = cp;
    }

    const kiosk = !!currentFeatures.kioskFullscreen;
    if (appliedWin.kiosk !== kiosk) {
      if (kiosk) { mainWindow.setKiosk(true); mainWindow.setMenuBarVisibility(false); }
      else if (mainWindow.isKiosk()) { mainWindow.setKiosk(false); }
      appliedWin.kiosk = kiosk;
      appliedWin.alwaysOnTop = null; // force the always-on-top below to re-evaluate
    }

    const aot = kiosk || !!currentFeatures.alwaysOnTop;
    if (appliedWin.alwaysOnTop !== aot) {
      mainWindow.setAlwaysOnTop(aot, kiosk ? 'screen-saver' : 'normal');
      appliedWin.alwaysOnTop = aot;
    }

    const minimizable = !currentFeatures.preventMinimize;
    if (appliedWin.minimizable !== minimizable) {
      mainWindow.setMinimizable(minimizable);
      appliedWin.minimizable = minimizable;
    }
  }
  if (!currentFeatures.keepForeground) cancelForeground();

  // Restart the app blocker only when its on/off or interval actually changed.
  const blockerOn = currentFeatures.appBlocker !== false;
  const blockerIv = Math.max(1000, Number(currentFeatures.appBlockIntervalMs) || 4000);
  if (appliedBlocker.on !== blockerOn || appliedBlocker.interval !== blockerIv) {
    appliedBlocker = { on: blockerOn, interval: blockerIv };
    if (!blockerOn) stopAppBlocker();
    else startAppBlocker();
  }

  // Proxy routing on/off (live). Off = browse directly, no proxy.
  const proxyOn = currentFeatures.proxyEnabled !== false;
  // Re-apply whenever on/off, mode, or the site list changes.
  const proxyKey = JSON.stringify([proxyOn, currentFeatures.proxyMode || 'all', currentFeatures.proxySites || []]);
  if (appliedProxyKey !== proxyKey) {
    appliedProxyKey = proxyKey;
    applyProxy(proxyOn ? assignedProxy : null).catch(() => {});
  }

  // Apply server-controlled auto-update settings.
  applyAutoUpdate();

  // Let the renderer know the current policy + flags (site lists, heartbeat).
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('policy:update', {
      policy: currentPolicy, features: currentFeatures,
    });
  }
}

// --- Poll the server so policy/flags change without a rebuild or re-login ---
function startConfigPoll() {
  stopConfigPoll();
  const iv = Math.max(8000, Number(currentFeatures.configPollMs) || 15000);
  configPollTimer = setInterval(async () => {
    if (!currentToken) return;
    try {
      const res = await apiCall('policy.php', 'GET');
      if (!res || !res.ok) return;
      if (res.policy) currentPolicy = res.policy;
      if (res.features) applyFeatures(res.features);
      else applyFeatures(null);
      // Phone config can be toggled live from the admin panel.
      const before = JSON.stringify(currentPhone);
      currentPhone = res.phone || null;
      if (JSON.stringify(currentPhone) !== before) pushPhone();
      // Sheets can be added/removed/renamed live from the admin panel.
      const sheetsBefore = JSON.stringify(currentSheets);
      const nextSheets = Array.isArray(res.sheets) ? res.sheets : [];
      if (JSON.stringify(nextSheets) !== sheetsBefore) { currentSheets = nextSheets; pushSheets(); }
    } catch (_) { /* transient network error; try again next tick */ }
  }, iv);
}
function stopConfigPoll() {
  if (configPollTimer) { clearInterval(configPollTimer); configPollTimer = null; }
}

app.whenReady().then(async () => {
  // Remove the application menu so its Edit roles (Copy / Paste / Cut /
  // Select All) and the View → Toggle DevTools accelerator can't be used to
  // move data in or out of the portal.
  Menu.setApplicationMenu(null);

  // Required for Windows to actually show desktop notifications from the app.
  try { app.setAppUserModelId('com.company.employeeportal'); } catch (_) {}

  // Camera: allow the portal's own window (webcam monitoring); deny camera/mic
  // to the embedded browser so visited websites can never access it.
  const DEF_ALLOW = new Set(['media', 'notifications', 'display-capture', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(DEF_ALLOW.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => DEF_ALLOW.has(perm));

  // Loopback audio capture for in-app browser live captions. The portal
  // renderer calls getDisplayMedia({video,audio}); we hand back a screen source
  // plus the system's loopback audio. The renderer immediately drops the video
  // track and streams only the audio (the call) to Deepgram. Nothing is
  // recorded or shown — the video source is required by Chromium's API but
  // discarded on arrival.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      try { callback({ audio: 'loopback' }); } catch (_) { callback({}); }
    });
  }, { useSystemPicker: false });

  // Embedded browser permissions:
  //  - Allow the MICROPHONE so in-browser WebRTC softphones (e.g. VICIdial's agent
  //    webphone) work.
  //  - Still block the CAMERA (video) from visited websites for privacy.
  //  - Allow benign things like Storage Access (needed by Google's reCAPTCHA).
  //  - Deny the rest of the sensitive set.
  const DENY_PERMS = new Set([
    'geolocation', 'notifications', 'midi', 'midiSysex',
    'hid', 'serial', 'usb', 'bluetooth', 'openExternal',
  ]);
  const workSession = session.fromPartition('persist:work');

  // Present as plain desktop Chrome on Windows. Electron's default UA carries
  // "Electron/<v>" and the app name, which sites like YouTube flag as an
  // automated client ("confirm you're not a bot"). Stripping those tokens makes
  // the embedded browser behave like the user's normal Chrome. We also strip the
  // Electron token from the UA-reducing client-hint header for consistency.
  const CHROME_VER = process.versions.chrome || '126.0.0.0';
  const CH_MAJOR = String(CHROME_VER).split('.')[0] || '126';
  // Present as Microsoft Edge on Windows (same engine the user's WebView2 app
  // uses, which sites don't flag) — the Edg/ token + Edge client-hint brands.
  const CLEAN_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36 Edg/${CHROME_VER}`;
  try { workSession.setUserAgent(CLEAN_UA); } catch (_) {}
  // Stop WebRTC from exposing the real IP behind the proxy (as the WebView2 app does).
  try { workSession.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch (_) {}
  workSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CLEAN_UA;
    // Client hints matching the Edge UA (no "Electron" brand).
    h['sec-ch-ua'] = `"Chromium";v="${CH_MAJOR}", "Microsoft Edge";v="${CH_MAJOR}", "Not.A/Brand";v="24"`;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Windows"';
    cb({ requestHeaders: h });
  });

  workSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (perm === 'media') {
      const types = (details && details.mediaTypes) || [];
      return cb(!types.includes('video')); // mic yes, camera no
    }
    if (perm === 'videoCapture') return cb(false);
    if (perm === 'audioCapture') return cb(true);
    if (perm === 'clipboard-read' || perm === 'clipboard-sanitized-write') return cb(true); // "Paste Details" buttons
    return cb(!DENY_PERMS.has(perm));
  });
  workSession.setPermissionCheckHandler((_wc, perm) => {
    if (perm === 'videoCapture') return false;
    if (perm === 'media' || perm === 'audioCapture') return true; // allow mic
    if (perm === 'clipboard-read' || perm === 'clipboard-sanitized-write') return true;
    return !DENY_PERMS.has(perm);
  });

  createWindow();

  // Check for an update BEFORE login. If a newer build is published, it downloads
  // and installs first, then the app relaunches into the new version for login.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', () => checkUpdatesAtLaunch());
  } else {
    checkUpdatesAtLaunch();
  }

  // When the portal loses focus, wipe the OS clipboard so anything selected
  // inside it can't be carried into another app, and nothing staged in another
  // app is waiting to come in. Event-level blocking above already prevents
  // both; this is a second line of defense.
  // The OS clipboard is allowed to work normally during the session so Windows
  // Clipboard History (Win+V) can hold several copied items. It is wiped — along
  // with the Win+V history — when the agent exits (see clearWinClipboard).
  enableWinClipboardHistory();
  startClipWatch();
  loadAutofill();

  // Downloads: let the embedded browser download files to the OS Downloads
  // folder (unique name), and notify the renderer when each finishes.
  session.fromPartition('persist:work').on('will-download', (_e, item) => {
    try {
      const dir = app.getPath('downloads');
      let name = item.getFilename() || 'download';
      let dest = path.join(dir, name);
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      while (fs.existsSync(dest)) { dest = path.join(dir, `${base} (${n++})${ext}`); }
      item.setSavePath(dest);
      item.once('done', (__e, state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download:done', { name: path.basename(dest), ok: state === 'completed' });
        }
      });
    } catch (_) {}
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The proxy requires authentication. Electron fires 'login' when a 407 comes
// back; we answer it with the current employee's proxy credentials (set at
// login time). Without a signed-in proxy, we let the request proceed normally.
let pendingHttpAuth = null;
app.on('login', (event, webContents, details, authInfo, callback) => {
  if (authInfo.isProxy) {
    if (currentProxy && currentProxy.username) {
      event.preventDefault();
      callback(currentProxy.username, currentProxy.password);
    }
    return; // not our authenticated proxy → leave default handling
  }
  // Site HTTP auth (401 Basic/Digest, e.g. the VICIdial admin login). Electron
  // has no native auth dialog, so we prompt the user ourselves and pass the
  // credentials back; Chromium then caches them for the rest of the session.
  event.preventDefault();
  if (pendingHttpAuth) { try { callback(); } catch (_) {} return; } // one at a time
  if (!mainWindow || mainWindow.isDestroyed()) { try { callback(); } catch (_) {} return; }
  pendingHttpAuth = callback;
  mainWindow.webContents.send('httpauth:prompt', {
    host: authInfo.host || '',
    realm: authInfo.realm || '',
    url: (details && details.url) || '',
  });
});
ipcMain.on('httpauth:submit', (_e, creds) => {
  if (!pendingHttpAuth) return;
  const cb = pendingHttpAuth; pendingHttpAuth = null;
  try { cb((creds && creds.username) || '', (creds && creds.password) || ''); } catch (_) {}
});
ipcMain.on('httpauth:cancel', () => {
  if (!pendingHttpAuth) return;
  const cb = pendingHttpAuth; pendingHttpAuth = null;
  try { cb(); } catch (_) {}
});

// Verify login against the server API (keeps the check off the page JS, and
// the credentials never live inside the app anymore).
ipcMain.handle('auth:login', async (_event, { username, password }) => {
  try {
    const res = await fetch(`${API_BASE}/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      // Pass through a shift-window rejection so the UI can explain it.
      if (data.error === 'outside_shift') {
        return { ok: false, error: 'outside_shift', shift: data.shift || null };
      }
      return { ok: false, error: 'invalid' };
    }

    // Apply this employee's assigned proxy (or default) to the browsing session
    // BEFORE the renderer loads any page in the webview.
    assignedProxy = data.proxy || null;
    const proxyOn = !data.features || data.features.proxyEnabled !== false;
    await applyProxy(proxyOn ? assignedProxy : null);

    // Keep the token for monitoring calls.
    currentToken = data.token;
    isLoggedIn = true; // from here, updates follow the admin install-timing setting

    // Store policy + server flags and turn on enforcement.
    currentPolicy = data.policy || { blocklist: [], allowlist: [], blockedApps: [] };
    gateExit = !!data.hasExitPassword;
    allowClose = false;
    setupWebFilter();
    applyFeatures(data.features || null); // content protection, app blocker, kiosk…
    currentPhone = data.phone || null;    // SIP softphone config (null if off)
    pushPhone();                          // hand it to the renderer right away
    currentSheets = Array.isArray(data.sheets) ? data.sheets : []; // names only
    pushSheets();
    startConfigPoll();                    // keep pulling changes from the server

    return {
      ok: true,
      username: data.user.username,
      fullName: data.user.full_name,
      role: data.user.role,
      token: data.token,
      shiftStart: data.shiftStart,
      shiftStartsAt: data.shiftStartsAt, // scheduled start — needed for "Late by…"
      shiftEndsAt: data.shiftEndsAt,
      shiftName: data.shiftName,
      serverNow: data.serverNow,
      hasExitPassword: !!data.hasExitPassword,
      needConsent: !!data.needConsent,
      consentText: data.consentText || '',
      policy: currentPolicy,
      features: currentFeatures,
      phone: currentPhone,
      sheets: currentSheets,
    };
  } catch (err) {
    // Could not reach the server at all.
    return { ok: false, error: 'network' };
  }
});

// Renderer asks for the current SIP config (on load / after reconnect).
ipcMain.on('phone:get', (e) => { e.returnValue = currentPhone; });

// Renderer asks for the current sheet list (names + ids only, no URLs).
ipcMain.on('sheets:get', (e) => { e.returnValue = currentSheets; });

// Resolve a sheet id → its real URL, for the current user only. The URL is
// fetched from the server here (main process) and returned to the renderer just
// in time to load it, so it never travels in the login/policy payload.
ipcMain.handle('sheet:url', async (_e, id) => {
  try {
    const sid = parseInt(id, 10);
    if (!sid || !currentSheets.some((s) => s.id === sid)) return { ok: false, error: 'not_found' };
    return await apiCall('sheet_url.php?id=' + sid, 'GET');
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// ---- Native (UDP) SIP softphone: direct-to-trunk calling, no WSS/VPS ----
let nativePhone = null;
function nativeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send(channel, data); } catch (_) {} }
}
ipcMain.handle('native:start', (_e, cfg) => {
  try {
    if (nativePhone) { try { nativePhone.stop(); } catch (_) {} nativePhone = null; }
    nativePhone = new SipPhone(cfg);
    ['registered', 'registerFailed', 'ringing', 'answered', 'ended', 'failed', 'status']
      .forEach((ev) => nativePhone.on(ev, (arg) => nativeSend('native:event', { ev, arg })));
    // Incoming decoded audio (Int16 @8k) → renderer speaker.
    nativePhone.on('audio', (pcm) => nativeSend('native:audio', Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
    nativePhone.start();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('native:call', (_e, num) => { if (nativePhone) nativePhone.call(num); return { ok: true }; });
ipcMain.handle('native:hangup', () => { if (nativePhone) nativePhone.hangup(); return { ok: true }; });
ipcMain.handle('native:dtmf', (_e, d) => { if (nativePhone) nativePhone.sendDtmf(d); return { ok: true }; });
ipcMain.handle('native:mute', (_e, on) => { if (nativePhone) nativePhone.mute(on); return { ok: true }; });
ipcMain.handle('native:stop', () => { if (nativePhone) { nativePhone.stop(); nativePhone = null; } return { ok: true }; });
// Outgoing mic audio (Int16 @8k) from the renderer → RTP. Fire-and-forget.
// Mint a short-lived Deepgram token for the in-app browser captions. The API
// key lives on the server; the renderer only ever sees the token this returns.
ipcMain.handle('dg:token', async () => {
  try {
    return await apiCall('dg_token.php', 'POST');
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.on('native:mic', (_e, buf) => {
  if (!nativePhone) return;
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    nativePhone.writeMic(new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2));
  } catch (_) {}
});

// --- Internal clipboard IPC ------------------------------------------------
// Renderer + webview preloads use these (sendSync for reads) to implement an
// in-app clipboard that never touches the OS clipboard.
ipcMain.on('clip:lock', (e) => { e.returnValue = currentFeatures.clipboardLock !== false; });
ipcMain.on('clip:set', (_e, text) => {
  internalClip = String(text || '');
  addClip(internalClip);
  lastOsClip = internalClip;
  // Mirror the in-app buffer onto the OS clipboard WHILE the portal is focused,
  // so pages that read the clipboard programmatically (navigator.clipboard
  // .readText(), e.g. a "Paste Details" button) get the copied text. On blur the
  // OS clipboard is wiped (below), so nothing leaks to other apps.
  try { if (internalClip) clipboard.writeText(internalClip); else clipboard.clear(); } catch (_) {}
});
ipcMain.on('clip:history', (e) => { e.returnValue = clipHistory; });

// --- Basic form autofill (local, non-sensitive field values) ---------------
let autofillStore = {}; // { host: { field: [values] } }
let autofillPath = '';
let autofillSaveTimer = null;
function loadAutofill() {
  try {
    autofillPath = path.join(app.getPath('userData'), 'autofill.json');
    if (fs.existsSync(autofillPath)) autofillStore = JSON.parse(fs.readFileSync(autofillPath, 'utf8')) || {};
  } catch (_) { autofillStore = {}; }
}
function saveAutofillSoon() {
  if (autofillSaveTimer) clearTimeout(autofillSaveTimer);
  autofillSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(autofillPath, JSON.stringify(autofillStore)); } catch (_) {}
  }, 1000);
}
ipcMain.on('autofill:get', (e, { host, field } = {}) => {
  const h = autofillStore[host]; e.returnValue = (h && h[field]) ? h[field] : [];
});
ipcMain.on('autofill:set', (_e, { host, field, value } = {}) => {
  if (!host || !field || !value) return;
  const h = (autofillStore[host] = autofillStore[host] || {});
  let arr = (h[field] = h[field] || []);
  arr = arr.filter((v) => v !== value); arr.unshift(value);
  if (arr.length > 8) arr.length = 8;
  h[field] = arr;
  saveAutofillSoon();
});
// Make a chosen history item the active clipboard entry (ready to paste).
ipcMain.on('clip:pick', (_e, text) => {
  internalClip = String(text || '');
  addClip(internalClip);
  lastOsClip = internalClip;
  try { if (internalClip) clipboard.writeText(internalClip); } catch (_) {}
});
ipcMain.on('clip:clearhistory', (e) => {
  clipHistory = [];
  internalClip = '';
  lastOsClip = '';
  try { clipboard.clear(); } catch (_) {}
  e.returnValue = true;
});
ipcMain.on('clip:get', (e) => { e.returnValue = internalClip; });
// Paste source for inside the portal: prefer the in-app buffer, but fall back to
// the OS clipboard so text copied by a website's "copy" button (which uses
// navigator.clipboard / execCommand and lands on the OS clipboard) can still be
// pasted into fields inside the app.
ipcMain.on('clip:paste', (e) => {
  // Prefer the OS clipboard so Windows Clipboard History (Win+V) and website
  // "copy" buttons paste the exact item the user just picked; fall back to the
  // in-app buffer only if the OS clipboard is empty.
  let t = '';
  try { t = clipboard.readText() || ''; } catch (_) { t = ''; }
  if (!t) t = internalClip;
  e.returnValue = t;
});

// Renderer reports the shift-end timestamp (local ms) after login.
ipcMain.on('shift:end', (_e, ms) => { currentShiftEndMs = Number(ms) || 0; });

// App version (shown in the UI so an update is visibly confirmable).
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

// --- Monitoring IPC --------------------------------------------------------
ipcMain.handle('monitor:heartbeat', async () => {
  try { return await apiCall('heartbeat.php', 'POST'); }
  catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('monitor:event', async (_e, { type, meta }) => {
  try { return await apiCall('event.php', 'POST', { type, meta }); }
  catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('auth:consent', async () => {
  try { return await apiCall('consent.php', 'POST'); }
  catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('auth:logout', async () => {
  try {
    const r = await apiCall('logout.php', 'POST');
    currentToken = null;
    gateExit = false;
    stopAppBlocker();
    stopConfigPoll();
    return r;
  } catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('monitor:violation', async (_e, { url, shot }) => {
  try { return await apiCall('violation.php', 'POST', { url, shot }); }
  catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('camera:event', async (_e, { reason, shot }) => {
  try { return await apiCall('camera.php', 'POST', { reason, shot }); }
  catch (e) { return { ok: false, error: 'network' }; }
});

// --- Exit (close / minimize) password gate ---------------------------------
ipcMain.handle('exit:verify', async (_e, { password }) => {
  try { return await apiCall('exit_check.php', 'POST', { password }); }
  catch (e) { return { ok: false, error: 'network' }; }
});

ipcMain.handle('exit:do', async (_e, { mode }) => {
  if (mode === 'minimize') {
    allowMinimizeOnce = true;
    if (mainWindow) mainWindow.minimize();
    return { ok: true };
  }
  // close
  allowClose = true;
  await reportClose();
  await clearWinClipboard(); // wipe clipboard + Win+V history before leaving
  if (mainWindow) mainWindow.destroy();
  return { ok: true };
});

// --- Chat IPC --------------------------------------------------------------
ipcMain.handle('chat:contacts', async () => {
  try { return await apiCall('chat_contacts.php', 'GET'); }
  catch (e) { return { ok: false, error: 'network' }; }
});
ipcMain.handle('chat:messages', async (_e, { withId, afterId }) => {
  try { return await apiCall(`chat_messages.php?with=${withId}&after=${afterId || 0}`, 'GET'); }
  catch (e) { return { ok: false, error: 'network' }; }
});
ipcMain.handle('chat:send', async (_e, { to, body }) => {
  try { return await apiCall('chat_send.php', 'POST', { to, body }); }
  catch (e) { return { ok: false, error: 'network' }; }
});

// --- Group chat + sale dispatch IPC ---------------------------------------
ipcMain.handle('sale:action', async (_e, { saleId, action, secs, processorId }) => {
  try { return await apiCall('sale_action.php', 'POST', { sale_id: saleId, action, secs, processor_id: processorId }); }
  catch (e) { return { ok: false, error: 'network' }; }
});
ipcMain.handle('work:status', async (_e, { status }) => {
  try { return await apiCall('work_status.php', 'POST', { status }); }
  catch (e) { return { ok: false, error: 'network' }; }
});
ipcMain.handle('group:activity', async () => {
  try { return await apiCall('group_activity.php', 'GET'); } catch (e) { return { ok: false, error: 'network' }; }
});

// Best-effort: tell the server the app is closing (ends the shift).
let reportedClose = false;
async function reportClose() {
  if (reportedClose || !currentToken) return;
  reportedClose = true;
  try { await apiCall('event.php', 'POST', { type: 'app_closed' }); } catch (e) {}
}

app.on('before-quit', async (e) => {
  if (!reportedClose && currentToken) {
    e.preventDefault();
    await reportClose();
    await clearWinClipboard(); // safety net for any other quit path
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
