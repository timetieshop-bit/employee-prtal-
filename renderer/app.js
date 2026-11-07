// Show the app version everywhere it's displayed — the clearest proof an update
// actually applied (the number changes after an update).
(() => {
  const v = (window.portal && window.portal.appVersion) ? window.portal.appVersion() : '';
  const label = v ? 'v' + v : '';
  const a = document.getElementById('app-version');
  const b = document.getElementById('app-version-top');
  if (a) a.textContent = label;
  if (b) b.textContent = label;
})();

// --- Pre-login update gate ---
// While the app checks/downloads an update on launch, hold the login button and
// show what's happening. If an update installs, the app relaunches on its own.
(() => {
  const box = document.getElementById('update-box');
  const statusEl = document.getElementById('update-status');
  const pctEl = document.getElementById('update-pct');
  const fill = document.getElementById('update-fill');
  const btn = document.getElementById('login-submit');
  const user = document.getElementById('username');
  const pass = document.getElementById('password');
  if (!box || !window.portal || !window.portal.onUpdateStatus) return;
  const MSG = {
    checking: 'Checking for updates…',
    downloading: 'Downloading update…',
    installing: 'Installing update — the app will restart…',
  };
  let watchdog = null;
  const lockForm = (on) => {
    [user, pass].forEach((f) => { if (f) f.disabled = on; });
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Please wait…' : 'Sign in'; }
  };
  const release = () => {
    box.hidden = true;
    if (fill) { fill.classList.remove('indet'); fill.style.width = '0%'; }
    if (pctEl) pctEl.textContent = '';
    lockForm(false);
  };
  const setIndeterminate = () => {
    if (!fill) return;
    fill.classList.add('indet');
    if (pctEl) pctEl.textContent = '';
  };
  window.portal.onUpdateStatus((status) => {
    if (status === 'ready') { if (watchdog) clearTimeout(watchdog); release(); return; }
    box.hidden = false;
    if (statusEl) statusEl.textContent = MSG[status] || '';
    if (btn) btn.textContent = status === 'installing' ? 'Updating…' : 'Please wait…';
    lockForm(true);
    // Checking / installing have no percentage — show an indeterminate sweep.
    if (status !== 'downloading') setIndeterminate();
    // Don't let a stalled check, slow download, or FAILED install trap the user
    // on the login screen. A normal install restarts the app well within these
    // windows; if it doesn't (e.g. the installer was blocked/quarantined by
    // Defender), we release the gate so they can sign in with the current build.
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(release, status === 'installing' ? 25000 : 20000);
  });
  if (window.portal.onUpdateProgress) {
    window.portal.onUpdateProgress((pct) => {
      box.hidden = false;
      lockForm(true);
      const v = Math.round(pct);
      if (statusEl) statusEl.textContent = MSG.downloading;
      if (fill) { fill.classList.remove('indet'); fill.style.width = v + '%'; }
      if (pctEl) pctEl.textContent = v + '%';
      // Active download — keep extending the watchdog so it won't fire mid-download.
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(release, 30000);
    });
  }
})();

// --- New-message sound + desktop notification ---
let audioCtx = null;
let lastUnreadTotal = null;
// Browsers suspend audio until the user interacts with the page, which made the
// ping fire only "sometimes". Create + resume the context on the first gesture so
// it's always ready, and re-request notification permission up front.
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}
['pointerdown', 'keydown', 'click'].forEach((ev) =>
  window.addEventListener(ev, unlockAudio, { once: false, passive: true }));
try {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
} catch (_) {}

function playPing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'triangle';
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    o.frequency.setValueAtTime(1245, audioCtx.currentTime + 0.11);
    o.frequency.setValueAtTime(880, audioCtx.currentTime + 0.22);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.6, audioCtx.currentTime + 0.01); // louder
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.42);
    o.start(); o.stop(audioCtx.currentTime + 0.43);
  } catch (_) {}
}
function notifyIncoming(title, body) {
  playPing();
  try {
    const away = document.getElementById('chat-panel').hidden || !document.hasFocus();
    if (away && window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body: body ? String(body).slice(0, 120) : '', silent: true });
    }
  } catch (_) {}
}
// In-app long card notification for new messages — reliable regardless of OS
// notification quirks. Plays a ping, slides a card in at the top, auto-hides.
let msgToastTimer = null;
function showMsgToast(title, body, onClick) {
  playPing();
  const el = document.getElementById('msg-toast');
  if (!el) { notifyIncoming(title, body); return; }
  const t = document.getElementById('msg-toast-title');
  const b = document.getElementById('msg-toast-body');
  if (t) t.textContent = title;
  if (b) b.textContent = body ? String(body).slice(0, 140) : '';
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  el.onclick = () => { hideMsgToast(); if (onClick) try { onClick(); } catch (_) {} };
  if (msgToastTimer) clearTimeout(msgToastTimer);
  msgToastTimer = setTimeout(hideMsgToast, 7000);
  // Best-effort OS notification too (works when the window is in the background).
  try {
    const away = document.getElementById('chat-panel').hidden || !document.hasFocus();
    if (away && window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body: body ? String(body).slice(0, 120) : '', silent: true });
    }
  } catch (_) {}
}
function hideMsgToast() {
  const el = document.getElementById('msg-toast');
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => { el.hidden = true; }, 460); // match the slide-up transition
}
// Escape HTML, then highlight #tags and @mentions.
function renderBody(text) {
  return escapeHtml(text).replace(/(^|\s)([#@][\w-]+)/g,
    (m, pre, tag) => `${pre}<span class="chat-tag ${tag[0] === '#' ? 'hash' : 'at'}">${tag}</span>`);
}

// --- View elements ---
const loginView = document.getElementById('login-view');
const portalView = document.getElementById('portal-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const whoName = document.getElementById('who-name');
const shiftClock = document.getElementById('shift-clock');

// --- Browser / tabs ---
const views = document.getElementById('views');
const address = document.getElementById('address');
const HOME_URL = 'https://www.google.com';
// Like Chrome: when a tab is sitting on the Google homepage, show the address
// bar empty (so the placeholder shows) instead of the literal URL.
function isHomeUrl(u) {
  try {
    const x = new URL(u);
    return /(^|\.)google\.[a-z.]+$/i.test(x.hostname) && (x.pathname === '/' || x.pathname === '');
  } catch (_) { return false; }
}
function addrFor(u) { return isHomeUrl(u) ? '' : (u || ''); }
let tabs = [];        // { id, view, title, url, loading }
let activeId = null;  // id of the visible tab
let tabSeq = 0;

let shiftTimer = null;
let heartbeatTimer = null;
let pendingLogin = null; // login result held while the consent screen is shown

// ---------- Auth ----------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  const res = await window.portal.login(username, password);
  if (!res.ok) {
    if (res.error === 'network') {
      loginError.textContent = 'Cannot reach the server. Check your connection and try again.';
    } else if (res.error === 'outside_shift') {
      const w = res.shift && res.shift.window ? ` Your shift is ${res.shift.window}.` : '';
      loginError.textContent = `You can only sign in during your shift hours.${w}`;
    } else {
      loginError.textContent = 'Invalid username or password';
    }
    loginError.hidden = false;
    return;
  }

  // First-time users must accept the monitoring notice before the portal opens.
  if (res.needConsent) {
    pendingLogin = res;
    showConsent(res.consentText);
    return;
  }
  enterPortal(res);
});

// ---------- Consent ----------
const consentView = document.getElementById('consent-view');
const consentBody = document.getElementById('consent-body');

function showConsent(text) {
  consentBody.textContent = text || 'This device is monitored while the portal is running.';
  loginView.hidden = true;
  consentView.hidden = false;
}

document.getElementById('consent-agree').addEventListener('click', async () => {
  await window.portal.acceptConsent();
  consentView.hidden = true;
  if (pendingLogin) { enterPortal(pendingLogin); pendingLogin = null; }
});

document.getElementById('consent-decline').addEventListener('click', () => {
  // Declining closes the app.
  window.close();
});

// ---------- Enter the portal ----------
let policy = { blocklist: [], allowlist: [], blockedApps: [] };
let features = {};
let myUserId = null;
let hasExitPassword = false;
let shiftEndMs = 0;

function enterPortal(res) {
  whoName.textContent = res.fullName || res.username;
  policy = res.policy || policy;
  features = res.features || features;
  hasExitPassword = !!res.hasExitPassword;
  if (res.shiftName) document.getElementById('shift-label').textContent = res.shiftName;

  loginView.hidden = true;
  consentView.hidden = true;
  portalView.hidden = false;

  // Only now does the embedded browser start loading — nothing is fetched
  // through the proxy until the employee has signed in.
  if (!tabs.length) createTab(HOME_URL);

  startShiftClock(res);
  startHeartbeat();
  startChat();
  startActivityPoll();
  if (window.cameraMonitor) window.cameraMonitor.apply(features);
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {}
}

// ---------- Heartbeat (keeps the employee shown as online) ----------
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  window.portal.heartbeat();
  const iv = Math.max(10000, Number(features.heartbeatMs) || 45000);
  heartbeatTimer = setInterval(() => window.portal.heartbeat(), iv);
}

// The main process pushes updated policy + flags after each server poll, so
// site lists and timings change live without a re-login.
window.portal.onPolicyUpdate((data) => {
  if (!data) return;
  if (data.policy) policy = data.policy;
  if (data.features) {
    const prev = features.heartbeatMs;
    features = data.features;
    if (features.heartbeatMs !== prev) startHeartbeat();
    if (window.cameraMonitor) window.cameraMonitor.apply(features);
  }
});

// ---------- Shift countdown (authoritative from the server) ----------
function startShiftClock(res) {
  // Work out how much time is left from the server's own clock, then count
  // down locally. Subtracting two server timestamps cancels any timezone
  // difference, so the remaining time is correct regardless of PC timezone.
  const toMs = (s) => (s ? new Date(String(s).replace(' ', 'T')).getTime() : 0);
  // Prefer the explicit shift end from the server; fall back to start + 8h.
  let endMs;
  if (res.shiftEndsAt) {
    endMs = toMs(res.shiftEndsAt);
  } else {
    endMs = toMs(res.shiftStart) + 8 * 3600 * 1000;
  }
  const remainingAtLogin = endMs - toMs(res.serverNow);
  const localEnd = Date.now() + remainingAtLogin;

  // Remember the shift end and tell the main process (it lets the window close
  // without a password once the shift is over).
  shiftEndMs = localEnd;
  window.portal.setShiftEnd(localEnd);

  // "Late by…" — how far past the scheduled start the employee signed in.
  const lateEl = document.getElementById('shift-late');
  const startMs = toMs(res.shiftStartsAt);
  const lateMs = startMs ? (toMs(res.serverNow) - startMs) : 0;
  if (lateMs > 60 * 1000) {
    lateEl.textContent = '⏱ Late by ' + fmtHM(lateMs);
    lateEl.hidden = false;
  } else {
    lateEl.hidden = true;
  }

  if (shiftTimer) clearInterval(shiftTimer);
  let endedNotified = false;

  const tick = () => {
    const remaining = localEnd - Date.now();
    if (remaining <= 0) {
      shiftClock.textContent = 'Shift ended';
      shiftClock.classList.add('done');
      if (!endedNotified) {
        endedNotified = true;
        // Warn, but let them finish (per policy).
        showWarn('Your shift has ended. You can finish up and close the portal.');
      }
      clearInterval(shiftTimer);
      return;
    }
    shiftClock.textContent = formatHMS(remaining);
  };

  tick();
  shiftTimer = setInterval(tick, 1000);
}

function formatHMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Short "2h 15m" / "45m" form for the late indicator.
function fmtHM(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ======================= TABS =======================
function activeTab() { return tabs.find((t) => t.id === activeId) || null; }
function activeView() { const t = activeTab(); return t ? t.view : null; }

// Turn address-bar text into a real URL (or a Google search).
function toTarget(value) {
  const v = value.trim();
  if (!v) return null;
  const looksLikeUrl = /^(https?:\/\/)/i.test(v) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v);
  return looksLikeUrl
    ? (/^https?:\/\//i.test(v) ? v : `https://${v}`)
    : `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function createTab(url = HOME_URL, activate = true, opts = {}) {
  const id = ++tabSeq;
  const view = document.createElement('webview');
  view.setAttribute('partition', 'persist:work'); // shared proxied, locked session
  // Allow pages to open popups/target=_blank; the main process intercepts them
  // (window-open handler) and we turn each into a new in-app tab via nav:external.
  view.setAttribute('allowpopups', '');
  view.className = 'view';
  view.style.display = 'none';
  views.appendChild(view);

  // A "protected" tab holds a server-assigned Google Sheet: the address bar
  // shows the sheet NAME (never the URL), stays read-only, and the bookmark star
  // is hidden, so the processor can use the sheet without seeing its link.
  const tab = {
    id, view, title: opts.displayName || 'New tab', url, loading: true,
    protected: !!opts.protected, displayName: opts.displayName || '',
  };
  tabs.push(tab);

  view.addEventListener('page-title-updated', (e) => {
    // Protected tabs keep the sheet name as their title (don't leak the doc's own title).
    if (!tab.protected) tab.title = e.title || tab.title;
    renderTabs();
  });
  view.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons.length) { tab.favicon = e.favicons[0]; renderTabs(); }
  });
  view.addEventListener('did-start-loading', () => {
    tab.loading = true; renderTabs(); if (tab.id === activeId) setLoadbar();
  });
  view.addEventListener('did-stop-loading', () => {
    tab.loading = false; renderTabs(); if (tab.id === activeId) setLoadbar();
    // Protected sheet tabs are a server-assigned destination — never a violation.
    if (!tab.protected) maybeCaptureViolation(tab); // capture AFTER the page has painted
  });
  view.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    if (id === activeId) { applyAddrForTab(tab); refreshStar(); }
    if (!tab.protected) checkSiteFor(tab, e.url);
  });
  view.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (id === activeId) { applyAddrForTab(tab); refreshStar(); }
  });
  view.addEventListener('found-in-page', (e) => {
    if (id === activeId && e.result) updateFindCount(e.result);
  });
  // Clipboard isolation is handled by the webview preload (runs before page
  // scripts), so nothing extra is injected here.

  view.src = url;
  if (activate) activateTab(id); else renderTabs();
  return tab;
}

// Set the address bar for a tab: a protected (sheet) tab shows its name and
// locks the bar; a normal tab shows the URL and unlocks it.
function applyAddrForTab(t) {
  if (t && t.protected) {
    address.value = t.displayName || t.title || 'Sheet';
    address.readOnly = true;
    address.classList.add('protected');
    if (addrBm) addrBm.hidden = true;
  } else {
    address.value = t ? addrFor(t.url) : '';
    address.readOnly = false;
    address.classList.remove('protected');
    if (addrBm) addrBm.hidden = false;
  }
}

function activateTab(id) {
  activeId = id;
  for (const t of tabs) t.view.style.display = (t.id === id ? 'flex' : 'none');
  const t = activeTab();
  applyAddrForTab(t);
  if (typeof refreshStar === 'function' && !(t && t.protected)) refreshStar();
  hideWarn();
  document.getElementById('blocked-overlay').hidden = true;
  setLoadbar();
  renderTabs();
}

function setLoadbar() {
  const t = activeTab();
  document.getElementById('loadbar').hidden = !(t && t.loading);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [t] = tabs.splice(idx, 1);
  try { t.view.remove(); } catch (_) {}
  if (!tabs.length) { createTab(HOME_URL); return; } // always keep at least one
  if (activeId === id) activateTab(tabs[Math.max(0, idx - 1)].id);
  else renderTabs();
}

let tabNewEl = null; // the "+" button; kept as a reference so it survives re-renders
function renderTabs() {
  const strip = document.getElementById('tabs');
  if (!tabNewEl) tabNewEl = document.getElementById('tab-new');
  strip.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '');
    const title = (t.title || 'New tab').trim() || 'New tab';
    el.innerHTML =
      `${t.loading
        ? '<span class="tab-dot loading"></span>'
        : (t.favicon
          ? `<img class="tab-fav" src="${escapeHtml(t.favicon)}" onerror="this.outerHTML='&lt;span class=&quot;tab-dot&quot;&gt;&lt;/span&gt;'" />`
          : '<span class="tab-dot"></span>')}
       <span class="tab-title">${escapeHtml(title)}</span>
       <span class="tab-close" title="Close tab">×</span>`;
    el.title = title;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) { e.stopPropagation(); closeTab(t.id); }
      else activateTab(t.id);
    });
    strip.appendChild(el);
  }
  // Keep "+" as the last child, directly after the last tab — consistent placement.
  if (tabNewEl) strip.appendChild(tabNewEl);
}

// ---------- Address bar + nav buttons (act on the active tab) ----------
function navigate(input) {
  const t0 = activeTab();
  if (t0 && t0.protected) return; // address bar is locked on sheet tabs
  const target = toTarget(input);
  if (!target) return;
  const t = activeTab();
  if (t) {
    // Instant feedback: don't wait for did-start-loading (which can lag).
    t.loading = true;
    renderTabs();
    setLoadbar();
    t.view.src = target;
  } else {
    createTab(target);
  }
}

address.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(address.value); });

// ---------- Server-assigned Google Sheets (processors) ----------
let mySheets = [];
const sheetsBtn = document.getElementById('btn-sheets');
const sheetsMenu = document.getElementById('sheets-menu');

function renderSheets() {
  if (sheetsBtn) sheetsBtn.hidden = !(mySheets && mySheets.length);
  if (!sheetsMenu) return;
  sheetsMenu.innerHTML = '';
  for (const s of mySheets) {
    const item = document.createElement('button');
    item.className = 'sheets-item';
    item.textContent = s.name;
    item.title = s.name;
    item.addEventListener('click', () => { sheetsMenu.hidden = true; openSheet(s); });
    sheetsMenu.appendChild(item);
  }
}

if (sheetsBtn) sheetsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!sheetsMenu) return;
  if (sheetsMenu.hidden) {
    const r = sheetsBtn.getBoundingClientRect();
    sheetsMenu.style.top = Math.round(r.bottom + 4) + 'px';
    sheetsMenu.style.left = Math.round(r.left) + 'px';
    sheetsMenu.hidden = false;
  } else {
    sheetsMenu.hidden = true;
  }
});
// Close the menu when clicking elsewhere.
document.addEventListener('click', (e) => {
  if (sheetsMenu && !sheetsMenu.hidden && e.target !== sheetsBtn && !sheetsMenu.contains(e.target)) {
    sheetsMenu.hidden = true;
  }
});

// Open one assigned sheet in a protected tab. The real URL is resolved by the
// main process just-in-time and loaded straight into the webview; the address
// bar only ever shows the sheet's name.
async function openSheet(s) {
  if (!s || !s.id) return;
  // If it's already open in a protected tab, just focus it.
  const existing = tabs.find((t) => t.protected && t.sheetId === s.id);
  if (existing) { activateTab(existing.id); return; }
  let res = null;
  try { res = await portal.sheetUrl(s.id); } catch (_) {}
  if (!res || !res.ok || !res.url) {
    alert('Could not open "' + s.name + '". Please try again.');
    return;
  }
  const tab = createTab(res.url, true, { protected: true, displayName: s.name });
  tab.sheetId = s.id;
}

if (window.portal && portal.onSheetsList) portal.onSheetsList((list) => { mySheets = list || []; renderSheets(); });
try { mySheets = (window.portal && portal.sheetsList && portal.sheetsList()) || []; } catch (_) { mySheets = []; }
renderSheets();

// ---- Bookmarks ----
const SEED_BOOKMARKS = [
  { name: 'paypeico', url: 'https://s8dh29fjkl0qwvxyr3ptmzbe1nc5au7ogt.paypeico.com/' },
  { name: 'dialer', url: 'https://aitech.btsdialer.com' },
];
function loadBookmarks() {
  try {
    const raw = localStorage.getItem('bookmarks');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  // First run: seed the two work links.
  try { localStorage.setItem('bookmarks', JSON.stringify(SEED_BOOKMARKS)); } catch (_) {}
  return SEED_BOOKMARKS.slice();
}
function saveBookmarks(list) { try { localStorage.setItem('bookmarks', JSON.stringify(list)); } catch (_) {} }
let bmMenuEl = null;
function closeBmMenu() { if (bmMenuEl) { bmMenuEl.remove(); bmMenuEl = null; } }
document.addEventListener('click', closeBmMenu);
function openBmMenu(anchor, index) {
  closeBmMenu();
  const menu = document.createElement('div');
  menu.className = 'bm-menu';
  menu.innerHTML = '<button class="bm-menu-item" data-a="rename">✏️ Rename</button>' +
    '<button class="bm-menu-item del" data-a="remove">🗑 Remove</button>';
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.style.left = Math.round(r.left) + 'px';
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.querySelector('[data-a="remove"]').addEventListener('click', () => {
    const cur = loadBookmarks(); cur.splice(index, 1); saveBookmarks(cur); closeBmMenu(); renderBookmarks(); refreshStar();
  });
  menu.querySelector('[data-a="rename"]').addEventListener('click', () => { closeBmMenu(); startRename(index); });
  bmMenuEl = menu;
}
function startRename(index) {
  const wrap = document.getElementById('bm-list');
  const chip = wrap && wrap.children[index];
  if (!chip) return;
  const b = loadBookmarks()[index];
  if (!b) return;
  chip.classList.add('editing');
  chip.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'bm-rename';
  input.value = b.name;
  input.maxLength = 40;
  chip.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = input.value.trim(); if (v) { const cur = loadBookmarks(); if (cur[index]) { cur[index].name = v; saveBookmarks(cur); } } }
    renderBookmarks();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
  input.addEventListener('blur', () => commit(true));
}
function renderBookmarks() {
  const list = loadBookmarks();
  const wrap = document.getElementById('bm-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  list.forEach((b, i) => {
    const letter = ((b.name || '?').trim()[0] || '?').toUpperCase();
    const el = document.createElement('span');
    el.className = 'bm-chip';
    el.innerHTML = `<button class="bm-open" title="${escapeHtml(b.url)}"><span class="bm-fav">${escapeHtml(letter)}</span><span class="bm-nm">${escapeHtml(b.name)}</span></button>` +
      `<button class="bm-kebab" title="Options" aria-label="Bookmark options">⋮</button>`;
    el.querySelector('.bm-open').addEventListener('click', () => navigate(b.url));
    el.querySelector('.bm-kebab').addEventListener('click', (e) => { e.stopPropagation(); openBmMenu(el, i); });
    wrap.appendChild(el);
  });
}
// The exact URL currently loaded in the active tab (the real deep link, not just
// the domain). Falls back to the tab record or the address field.
function currentPageUrl() {
  const v = activeView();
  try { if (v && typeof v.getURL === 'function') { const u = v.getURL(); if (u && !/^about:/.test(u)) return u; } } catch (_) {}
  const t = activeTab();
  if (t && t.url && !/^about:/.test(t.url)) return t.url;
  return address.value || '';
}
function bookmarkName(url) {
  const t = activeTab();
  if (t && t.title && t.title !== url && !/^https?:\/\//.test(t.title)) return t.title.slice(0, 28);
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/$/, '');
    const host = u.hostname.replace(/^www\./, '');
    return (path && path !== '' ? host + path : host).slice(0, 28);
  } catch (_) { return url.slice(0, 28); }
}
const addrBm = document.getElementById('addr-bm');
function refreshStar() {
  if (!addrBm) return;
  const url = currentPageUrl();
  const saved = loadBookmarks().some((b) => b.url === url);
  addrBm.classList.toggle('saved', saved);
  addrBm.title = saved ? 'Remove bookmark' : 'Bookmark this page';
}
if (addrBm) addrBm.addEventListener('click', () => {
  const url = currentPageUrl();
  if (!url || /^about:/.test(url)) return;
  const list = loadBookmarks();
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) list.splice(i, 1);                               // toggle off
  else list.push({ name: bookmarkName(url), url });            // bookmark the full link
  saveBookmarks(list); renderBookmarks(); refreshStar();
});
renderBookmarks();
refreshStar();


// ---- Unified live captions (Deepgram): in-app browser audio AND phone calls ----
(function () {
  const btn = document.getElementById('bcc-btn');
  const bar = document.getElementById('bcc-bar');
  const pill = document.getElementById('bcc-pill');
  const elStatus = document.getElementById('bcc-status');
  const elFinal = document.getElementById('bcc-final');
  const elPartial = document.getElementById('bcc-partial');
  const elTitle = bar ? bar.querySelector('.bcc-title') : null;
  const head = bar ? bar.querySelector('.bcc-head') : null;
  if (!btn || !bar || !window.BrowserCaptions) return;

  btn.hidden = false; // always offered; reports if unconfigured

  // One smart toggle. When ON: caption the phone call if a call is active,
  // otherwise caption the in-app browser. Source switches automatically as calls
  // start and end. phone.js registers an audio tap and signals call state.
  let enabled = false;       // user intent (the top-bar button)
  let callActive = false;    // a phone call is in progress
  let callRate = 16000;      // PCM sample rate of the call audio
  let phone = null;          // { startTap, stopTap } from phone.js
  let dgStream = null;       // Deepgram stream for the phone source
  let curSource = 'none';    // 'none' | 'browser' | 'phone'
  let collapsed = false, finalText = '', idleTimer = null;
  const IDLE_MS = 6000;

  function setStatus(s) { if (elStatus) elStatus.textContent = s; }
  function setTitle(t) { if (elTitle) elTitle.textContent = t; }
  function showBar() { collapsed = false; bar.hidden = false; if (pill) pill.hidden = true; }
  function hideAll() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } bar.hidden = true; if (pill) pill.hidden = true; }
  function resetText() { finalText = ''; if (elFinal) elFinal.textContent = ''; if (elPartial) elPartial.textContent = ''; }
  function expand() { if (!enabled) return; collapsed = false; bar.hidden = false; if (pill) pill.hidden = true; }
  function collapse() { if (!enabled) return; collapsed = true; bar.hidden = true; if (pill) { pill.hidden = false; pill.classList.remove('speaking'); } }
  function armIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (enabled) collapse(); }, IDLE_MS); }

  function onText(text, isFinal) {
    if (collapsed) expand();
    armIdle();
    if (isFinal) {
      finalText = (finalText + ' ' + text).trim();
      if (finalText.length > 220) finalText = finalText.slice(-220);
      if (elFinal) elFinal.textContent = finalText;
      if (elPartial) elPartial.textContent = '';
    } else if (elPartial) {
      elPartial.textContent = (finalText ? ' ' : '') + text;
    }
  }

  async function startBrowserSrc() {
    if (curSource === 'browser') return;
    stopPhoneSrc();
    resetText(); setTitle('Live captions'); showBar(); armIdle();
    curSource = 'browser';
    const ok = await window.BrowserCaptions.start(onText, setStatus);
    if (!ok && curSource === 'browser') { curSource = 'none'; enabled = false; paintBtn(); hideAll(); }
  }
  function stopBrowserSrc() {
    if (curSource !== 'browser') return;
    try { window.BrowserCaptions.stop(); } catch (_) {}
    curSource = 'none';
  }
  function startPhoneSrc() {
    if (curSource === 'phone') return;
    stopBrowserSrc();
    resetText(); setTitle('Call captions'); showBar(); armIdle(); setStatus('Listening…');
    try { dgStream = window.BrowserCaptions.openStream(callRate || 16000, onText, setStatus); } catch (_) { dgStream = null; }
    curSource = 'phone';
    if (phone && phone.startTap) { try { phone.startTap(); } catch (_) {} }
  }
  function stopPhoneSrc() {
    if (phone && phone.stopTap) { try { phone.stopTap(); } catch (_) {} }
    if (dgStream) { try { dgStream.close(); } catch (_) {} dgStream = null; }
    if (curSource === 'phone') curSource = 'none';
  }

  function refresh() {
    if (!enabled) { stopBrowserSrc(); stopPhoneSrc(); hideAll(); return; }
    if (callActive) startPhoneSrc();
    else startBrowserSrc();
  }
  function paintBtn() {
    btn.classList.toggle('on', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    if (pill) { const t = document.getElementById('bcc-pill-tx'); if (t) t.textContent = 'Captions'; }
  }
  function toggle() { enabled = !enabled; paintBtn(); refresh(); }

  // Exposed to phone.js
  window.TopCaptions = {
    registerPhone: (o) => { phone = o; },
    callStarted: (rate) => { callActive = true; callRate = rate || 16000; if (enabled) refresh(); },
    callEnded: () => { callActive = false; stopPhoneSrc(); if (enabled) refresh(); else hideAll(); },
    pushExternal: (i16) => { if (dgStream) { try { dgStream.push(i16); } catch (_) {} } },
    isEnabled: () => enabled,
  };

  btn.addEventListener('click', toggle);
  const closeBtn = document.getElementById('bcc-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { enabled = false; paintBtn(); refresh(); });
  const minBtn = document.getElementById('bcc-min');
  if (minBtn) minBtn.addEventListener('click', () => { if (idleTimer) clearTimeout(idleTimer); collapse(); });
  if (pill) pill.addEventListener('click', () => { expand(); armIdle(); });

  // ---- Draggable + resizable caption bar (position/size remembered) ----
  const BOX_KEY = 'bccBox';
  function applySavedBox() {
    let box = null;
    try { box = JSON.parse(localStorage.getItem(BOX_KEY) || 'null'); } catch (_) {}
    if (!box) return;
    bar.classList.add('floating');
    if (box.w) bar.style.width = box.w + 'px';
    if (box.h) bar.style.height = box.h + 'px';
    // Clamp into the viewport so it can't be lost off-screen.
    const w = box.w || bar.offsetWidth || 360;
    const h = box.h || bar.offsetHeight || 120;
    const left = Math.min(Math.max(0, box.left), Math.max(0, window.innerWidth - 60));
    const top = Math.min(Math.max(0, box.top), Math.max(0, window.innerHeight - 40));
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
  }
  function saveBox() {
    try {
      const r = bar.getBoundingClientRect();
      localStorage.setItem(BOX_KEY, JSON.stringify({
        left: Math.round(r.left), top: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      }));
    } catch (_) {}
  }
  // Drag by the header (ignore clicks on its buttons).
  if (head) {
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = bar.getBoundingClientRect();
      bar.classList.add('floating');
      bar.style.width = r.width + 'px';
      bar.style.height = r.height + 'px';
      bar.style.left = r.left + 'px';
      bar.style.top = r.top + 'px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      const offX = e.clientX - r.left;
      const offY = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      head.classList.add('dragging');
      const move = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - offX), window.innerWidth - 40);
        const top = Math.min(Math.max(0, ev.clientY - offY), window.innerHeight - 30);
        bar.style.left = left + 'px';
        bar.style.top = top + 'px';
      };
      const up = () => {
        head.classList.remove('dragging');
        try { head.releasePointerCapture(e.pointerId); } catch (_) {}
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        saveBox();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
  // Persist size when the user drags the resize handle.
  if (window.ResizeObserver) {
    let rt = null;
    const ro = new ResizeObserver(() => {
      if (bar.hidden) return;
      if (rt) clearTimeout(rt);
      rt = setTimeout(saveBox, 400);
    });
    ro.observe(bar);
  }
  applySavedBox();
})();

// ---- Find in page (Ctrl+F) ----
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
let findLast = '';
function updateFindCount(r) {
  if (!findCount) return;
  findCount.textContent = r && r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : (findInput.value ? '0/0' : '');
}
function doFind(forward) {
  const v = activeView(); const q = findInput.value;
  if (!v) return;
  if (!q) { try { v.stopFindInPage('clearSelection'); } catch (_) {} findCount.textContent = ''; findLast = ''; return; }
  try {
    if (q === findLast) v.findInPage(q, { forward, findNext: true });
    else v.findInPage(q);
    findLast = q;
  } catch (_) {}
}
function openFind() {
  if (!findBar) return;
  findBar.hidden = false;
  findInput.focus(); findInput.select();
  if (findInput.value) doFind(true);
}
function closeFind() {
  if (!findBar) return;
  findBar.hidden = true;
  findLast = '';
  const v = activeView(); if (v) { try { v.stopFindInPage('clearSelection'); } catch (_) {} }
}
if (findInput) {
  findInput.addEventListener('input', () => doFind(true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  document.getElementById('find-next').addEventListener('click', () => doFind(true));
  document.getElementById('find-prev').addEventListener('click', () => doFind(false));
  document.getElementById('find-close').addEventListener('click', closeFind);
}
// Ctrl+F from the chrome itself (when focus is in the portal, not the webview).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(); }
});
if (window.portal.onFindOpen) window.portal.onFindOpen(openFind);
if (window.portal.onFindClose) window.portal.onFindClose(closeFind);

// ---- Download finished → toast ----
if (window.portal.onDownloadDone) window.portal.onDownloadDone((info) => {
  if (!info) return;
  showMsgToast(info.ok ? '⬇ Download complete' : '⚠ Download failed', info.name || '');
});

// ---- HTTP auth prompt (site 401, e.g. VICIdial admin) ----
(function () {
  const modal = document.getElementById('auth-modal');
  const form = document.getElementById('auth-form');
  const sub = document.getElementById('auth-sub');
  const user = document.getElementById('auth-user');
  const pass = document.getElementById('auth-pass');
  if (!modal || !form || !window.portal.onHttpAuth) return;
  const close = () => { modal.hidden = true; user.value = ''; pass.value = ''; };
  window.portal.onHttpAuth((info) => {
    sub.textContent = (info && info.host)
      ? `${info.host} requires a username and password.`
      : 'This site requires a username and password.';
    modal.hidden = false;
    setTimeout(() => user.focus(), 30);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    window.portal.httpAuthSubmit({ username: user.value, password: pass.value });
    close();
  });
  document.getElementById('auth-cancel').addEventListener('click', () => {
    window.portal.httpAuthCancel();
    close();
  });
})();

document.getElementById('nav-back').addEventListener('click', () => {
  const v = activeView(); if (v && v.canGoBack()) v.goBack();
});
document.getElementById('nav-forward').addEventListener('click', () => {
  const v = activeView(); if (v && v.canGoForward()) v.goForward();
});
document.getElementById('nav-reload').addEventListener('click', () => {
  const v = activeView(); if (v) v.reload();
});
document.getElementById('tab-new').addEventListener('click', () => {
  createTab(HOME_URL);
  address.focus();
});

// ======================= WEBSITE CONTROL =======================
const SEARCH_HOSTS = ['google.', 'bing.com', 'duckduckgo.com'];

function classifySite(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return 'allow'; }
  if (host === '') return 'allow';
  const full = (host + url).toLowerCase();

  if ((policy.blocklist || []).some((p) => p && full.includes(p))) return 'block';
  if (SEARCH_HOSTS.some((h) => host.includes(h))) return 'allow';
  if ((policy.allowlist || []).some((p) => p && full.includes(p))) return 'allow';
  return 'warn';
}

function checkSiteFor(tab, url) {
  if (!url || url.startsWith('about:')) return;
  const verdict = classifySite(url);
  const isActive = tab.id === activeId;
  if (verdict === 'block') {
    if (isActive) showBlocked(url);
    tab.view.stop();
    tab.view.src = 'about:blank';
  } else if (verdict === 'warn') {
    // Off-allowlist visits are still logged silently (screenshot on load), but we
    // no longer show the banner — it was unnecessary noise for the user.
    tab.pendingViolation = url;
  } else if (isActive) {
    hideWarn();
  }
}

// Called on did-stop-loading: if this tab had a flagged visit, grab a screenshot
// now that the page is painted and report it.
function maybeCaptureViolation(tab) {
  const url = tab.pendingViolation;
  if (!url) return;
  tab.pendingViolation = null;
  // A short extra delay lets late content and images settle before capture.
  setTimeout(async () => {
    let shot = '';
    try {
      const img = await tab.view.capturePage();
      shot = img.isEmpty() ? '' : img.toDataURL();
    } catch (_) { /* capture can fail on some pages; still log the URL */ }
    window.portal.reportViolation(url, shot);
  }, 900);
}

// Warning banner
const warnBanner = document.getElementById('warn-banner');
function showWarn(text) {
  document.getElementById('warn-text').textContent = text;
  warnBanner.hidden = false;
}
function hideWarn() { warnBanner.hidden = true; }
document.getElementById('warn-dismiss').addEventListener('click', hideWarn);

// Blocked overlay
const blockedOverlay = document.getElementById('blocked-overlay');
function showBlocked(url) {
  document.getElementById('blocked-url').textContent = url;
  blockedOverlay.hidden = false;
}
document.getElementById('blocked-back').addEventListener('click', () => {
  blockedOverlay.hidden = true;
  const v = activeView();
  if (v && v.canGoBack()) v.goBack(); else if (v) v.src = HOME_URL;
});
// Hard-block from the network filter (main process)
window.portal.onNavBlocked((url) => showBlocked(url));

// Popups/new windows are denied in main and sent here; open each as a NEW TAB
// so the employee stays inside the locked, proxied browser.
window.portal.onNavExternal((url) => { if (url) createTab(url); });

// ======================= INTERNAL CLIPBOARD (portal chrome) =======================
// Same rule as the webview: copy/cut/paste work INSIDE the portal via an in-app
// buffer; nothing crosses to or from the OS clipboard. Covers the address bar,
// chat box, etc.
const portalSel = () => {
  let s = '';
  try { s = String(window.getSelection ? window.getSelection() : ''); } catch (_) {}
  if (s) return s;
  try {
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.value === 'string') {
      const a = el.selectionStart, b = el.selectionEnd;
      if (a != null && b != null && b > a) return el.value.substring(a, b);
    }
  } catch (_) {}
  return '';
};
document.addEventListener('copy', (e) => {
  if (!window.portal.clipLock()) return;
  const s = portalSel();
  e.preventDefault();
  if (s) window.portal.clipSet(s);
}, true);
document.addEventListener('cut', (e) => {
  if (!window.portal.clipLock()) return;
  const s = portalSel();
  e.preventDefault();
  if (s) window.portal.clipSet(s);
  try { document.execCommand('delete'); } catch (_) {}
}, true);
document.addEventListener('paste', (e) => {
  if (!window.portal.clipLock()) return;
  e.preventDefault();
  const t = (window.portal.clipPaste ? window.portal.clipPaste() : window.portal.clipGet()) || '';
  if (t) { try { document.execCommand('insertText', false, t); } catch (_) {} }
}, true);
// Right-click menu and drag stay blocked (they'd reach the OS clipboard).
['contextmenu', 'dragstart', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => { if (window.portal.clipLock()) e.preventDefault(); }, true));

// ======================= EXIT PASSWORD GATE =======================
const exitModal = document.getElementById('exit-modal');
const exitForm = document.getElementById('exit-form');
const exitError = document.getElementById('exit-error');
let exitMode = 'close';

function openExitModal(mode) {
  exitMode = mode;
  document.getElementById('exit-title').textContent =
    mode === 'minimize' ? 'Enter exit password to minimize' : 'Enter exit password to close';
  document.getElementById('exit-pw').value = '';
  exitError.hidden = true;
  exitModal.hidden = false;
  document.getElementById('exit-pw').focus();
}
window.portal.onExitRequest((mode) => openExitModal(mode));

// Exit button in the header: after the shift has ended (or if no exit password
// is set) it closes straight away; during the shift it asks for the password.
document.getElementById('exit-btn').addEventListener('click', () => {
  const shiftOver = shiftEndMs && Date.now() >= shiftEndMs;
  if (shiftOver || !hasExitPassword) {
    window.portal.doExit('close');
  } else {
    openExitModal('close');
  }
});

// Minimize button: keeps the app running (no lost work), gated by the same exit
// password during the shift. After the shift, or with no exit password, it just
// minimizes.
document.getElementById('minimize-btn').addEventListener('click', () => {
  const shiftOver = shiftEndMs && Date.now() >= shiftEndMs;
  if (shiftOver || !hasExitPassword) {
    window.portal.doExit('minimize');
  } else {
    openExitModal('minimize');
  }
});

exitForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  exitError.hidden = true;
  const pw = document.getElementById('exit-pw').value;
  const res = await window.portal.verifyExit(pw);
  if (res && res.ok) {
    exitModal.hidden = true;
    window.portal.doExit(exitMode);
  } else {
    exitError.hidden = false;
  }
});

document.getElementById('exit-cancel').addEventListener('click', () => {
  exitModal.hidden = true;
});

// ======================= CHAT (direct only) =======================
const chatPanel = document.getElementById('chat-panel');
let chatContactsTimer = null;
let chatMsgTimer = null;
let countdownTimer = null;
let chatActive = null;       // the contact we're talking to
let lastMsgId = 0;           // highest message id we've rendered
let lastSenderMine = null;   // for grouping consecutive bubbles
let lastMsgDate = '';        // for day separators
let serverSkew = 0;          // server clock minus local clock (ms)
let myRole = 'employee';
let myWorkStatus = 'free';
let convTakers = [];         // processors (for the admin assign picker)
let contactsById = {};       // id -> contact (for opening from a toast/alert)

function startChat() {
  renderList();
  if (chatContactsTimer) clearInterval(chatContactsTimer);
  chatContactsTimer = setInterval(() => { if (!chatActive) renderList(); }, 8000);
}
function renderList() { loadContacts(); }

// ---- Background activity poll (always on): unread badge, new-message toast,
//      home-screen incoming-sale alert, queue banner — even with chat closed. ----
let activityTimer = null;
let lastDirectUnread = null;
let alertSaleId = null;
function startActivityPoll() {
  if (activityTimer) clearInterval(activityTimer);
  checkActivity();
  activityTimer = setInterval(checkActivity, 3000); // snappy badges + sale alerts
}

// Segmented wait picker (30s / 1 min): clicking a segment marks it active and
// stores the value on the parent's data-secs. One delegated handler for all.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.wait-seg button');
  if (!b) return;
  const seg = b.closest('.wait-seg');
  seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  seg.dataset.secs = b.dataset.secs;
});
async function checkActivity() {
  const res = await window.portal.activity();
  if (!res || !res.ok) return;
  // Keep the shared clock offset fresh even on the home screen (no chat open),
  // so the sale + wait countdowns are accurate regardless of the device clock.
  if (res.serverNow) serverSkew = Date.parse(res.serverNow.replace(' ', 'T')) - Date.now();

  // Unread badge (single source of truth, sticky until actually read).
  const db_ = document.getElementById('badge-direct');
  const du = res.directUnread || 0;
  if (du > 0) { db_.textContent = du; db_.hidden = false; } else db_.hidden = true;

  // New direct message → in-app card, unless I'm already in that conversation.
  const viewingSender = res.directLatest && chatActive && chatActive.id === res.directLatest.from_id;
  if (lastDirectUnread !== null && du > lastDirectUnread && res.directLatest && !viewingSender) {
    const fromC = headContact(res.directLatest.from_id, res.directLatest.from);
    bumpHeadUnread(fromC); // open/raise a dock head for this person (up to 3) + badge it
    showMsgToast('New message · ' + res.directLatest.from, res.directLatest.body,
      () => openConversationWith(res.directLatest.from_id, res.directLatest.from));
  }
  lastDirectUnread = du;

  // While a sale is snoozed, clear its "already announced" flag so that when the
  // wait timer expires and it re-prompts, it pings + notifies the processor again.
  if (res.myWait && res.myWait.id) announcedSaleIds.delete(res.myWait.id);

  // Incoming sale alert (home screen) — unless I'm already in the dispatcher's chat.
  const s = res.pendingSale;
  const viewingDispatcher = chatActive && s && chatActive.id === s.employee_id;
  if (s && !viewingDispatcher) showSaleAlert(s, res.pendingCount || 1); else hideSaleAlert();

  // My sale was processed → notify me (the employee who sent it), once per sale.
  const sp = res.saleProcessed;
  if (sp && sp.id && !announcedProcessedIds.has(sp.id)) {
    announcedProcessedIds.add(sp.id);
    showMsgToast('✅ Sale processed', 'Your sale was processed by ' + (sp.by || 'the processor') + '.');
  }

  // Queue banner (home screen).
  const qb = document.getElementById('queue-banner');
  const q = res.queueCount || 0;
  if (q > 0) { qb.textContent = '⏳ ' + q + ' sale' + (q > 1 ? 's' : '') + ' in your queue'; qb.hidden = false; }
  else qb.hidden = true;

  // "You snoozed a sale" countdown banner (processor's own wait).
  renderWaitBanner(res.myWait);
}

// Home-screen countdown for a sale the processor snoozed (their own "wait").
let waitBannerSale = null;
function renderWaitBanner(mw) {
  const el = document.getElementById('wait-banner');
  waitBannerSale = mw || null;
  if (!mw || !mw.until) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `⏳ You snoozed ${escapeHtml(mw.employee || 'a')} sale · back in <b class="wb-cd">—</b>`;
}
setInterval(() => {
  const el = document.getElementById('wait-banner');
  if (!waitBannerSale || !waitBannerSale.until || el.hidden) return;
  const cd = el.querySelector('.wb-cd');
  const remain = Math.ceil((Date.parse(waitBannerSale.until.replace(' ', 'T')) - (Date.now() + serverSkew)) / 1000);
  if (cd) cd.textContent = remain > 0 ? remain + 's' : 'now';
}, 500);

// ---- Home-screen incoming-sale alert ----
let alertSale = null;
const announcedSaleIds = new Set(); // sales we've already pinged for this session
const announcedProcessedIds = new Set(); // processed-sale confirmations already pinged
function showSaleAlert(sale, count) {
  const el = document.getElementById('sale-alert');
  alertSale = sale;
  alertSaleId = sale.id;
  // Ping once per distinct sale id, so a 2nd/3rd incoming sale always announces
  // even while an earlier one is still on screen.
  if (!announcedSaleIds.has(sale.id)) {
    announcedSaleIds.add(sale.id);
    playPing();
    try {
      if ((document.getElementById('chat-panel').hidden || !document.hasFocus())
          && window.Notification && Notification.permission === 'granted') {
        new Notification('New sale · ' + (sale.employee || 'employee'), { body: (sale.body || '').slice(0, 120), silent: true });
      }
    } catch (_) {}
  }
  document.getElementById('sale-alert-from').textContent = 'From ' + (sale.employee || '—');
  document.getElementById('sale-alert-body').textContent = sale.body || '';
  const more = document.getElementById('sale-alert-more');
  const extra = (count || 1) - 1;
  if (extra > 0) { more.textContent = '+ ' + extra + ' more waiting'; more.hidden = false; } else more.hidden = true;
  el.hidden = false;
}
function hideSaleAlert() {
  document.getElementById('sale-alert').hidden = true;
  alertSaleId = null;
  alertSale = null;
}
document.getElementById('sale-alert-process').addEventListener('click', async () => {
  if (!alertSale) return;
  const sale = alertSale;
  const res = await window.portal.saleAction(sale.id, 'processing');
  hideSaleAlert();
  if (res && res.ok) openConversationWith(sale.employee_id, sale.employee, 'employee');
  else showWarn('That sale was just taken or reassigned.');
});
document.getElementById('sale-alert-wait').addEventListener('click', async () => {
  if (!alertSale) return;
  const secs = Number(document.getElementById('sale-alert-waitseg').dataset.secs) || 30;
  await window.portal.saleAction(alertSale.id, 'wait', secs);
  hideSaleAlert(); // reappears after the snooze if still pending (re-prompt)
});

// Countdown for the home-screen sale alert (the taker's 30s response SLA).
setInterval(() => {
  if (!alertSale || document.getElementById('sale-alert').hidden) return;
  const el = document.getElementById('sale-alert-count');
  const disp = alertSale.dispatched_at;
  if (!disp) { el.textContent = ''; return; }
  const remain = Math.ceil(30 - (Date.now() + serverSkew - Date.parse(disp.replace(' ', 'T'))) / 1000);
  if (remain > 0) { el.textContent = remain + 's'; el.className = 'sale-countdown'; }
  else { el.textContent = 'respond now'; el.className = 'sale-countdown overdue'; }
}, 500);

function openPanelIn() {
  chatPanel.hidden = false;
  renderList();
}
function openConversationWith(id, name, role) {
  openPanelIn();
  const c = contactsById[id] || { id, full_name: name || ('User ' + id), username: '', role: role || 'employee' };
  openConversation(c);
}
document.getElementById('btn-direct').addEventListener('click', openPanelIn);
document.getElementById('chat-close').addEventListener('click', () => {
  // Stop the conversation poll so it can't keep marking messages read in the
  // background (that caused the processor's unread badge to flicker on/off).
  closeConversation();
  chatPanel.hidden = true;
  if (typeof renderDock === 'function') renderDock();
});
document.getElementById('chat-back').addEventListener('click', closeConversation);

// ===== Minimized conversation dock (Messenger-style, up to 3) =====
const MAX_HEADS = 3;
let openHeads = [];       // contact objects currently docked (oldest first)
const headUnread = {};    // id -> unread count accumulated while docked/not viewing
const chatDock = document.getElementById('chat-dock');

function headContact(id, name, role) {
  return contactsById[id] || { id, full_name: name || ('User ' + id), username: '', role: role || 'employee' };
}
function addHead(c) {
  if (!c || !c.id) return;
  if (!openHeads.some((h) => h.id === c.id)) {
    openHeads.push(c);
    while (openHeads.length > MAX_HEADS) { const dropped = openHeads.shift(); delete headUnread[dropped.id]; }
  }
  renderDock();
}
function removeHead(id) {
  openHeads = openHeads.filter((h) => h.id !== id);
  delete headUnread[id];
  renderDock();
}
// New message arrived from c: make sure there's a head, and badge it unless the
// user is actively viewing that conversation.
function bumpHeadUnread(c) {
  addHead(c);
  if (!chatActive || chatActive.id !== c.id || chatPanel.hidden) {
    headUnread[c.id] = (headUnread[c.id] || 0) + 1;
    renderDock();
  }
}
function renderDock() {
  if (!chatDock) return;
  chatDock.innerHTML = '';
  openHeads.forEach((c) => {
    const name = c.full_name || c.username || ('User ' + c.id);
    const unread = headUnread[c.id] || 0;
    const isActive = chatActive && chatActive.id === c.id && !chatPanel.hidden;
    const proc = (contactsById[c.id] || c).processing ? ' processing' : '';
    const el = document.createElement('div');
    el.className = 'chat-head-chip' + (isActive ? ' active' : '') + (unread ? ' has-unread' : '') + proc;
    el.innerHTML =
      `<button class="chip-open" title="${escapeHtml(name)}">
         <span class="avatar sm" style="background:${avatarColor(c.id)}">${escapeHtml(initials(name))}</span>
         <span class="chip-name">${escapeHtml(name)}</span>
         ${unread ? `<span class="badge">${unread}</span>` : ''}
       </button>
       <button class="chip-close" title="Close">×</button>`;
    el.querySelector('.chip-open').addEventListener('click', () => openHead(c));
    el.querySelector('.chip-close').addEventListener('click', (e) => { e.stopPropagation(); removeHead(c.id); });
    chatDock.appendChild(el);
  });
}
function openHead(c) {
  headUnread[c.id] = 0;
  chatPanel.hidden = false;
  openConversation(c);
  renderDock();
}
function minimizeChat() {
  if (chatActive) addHead(chatActive);   // keep the conversation as a dock head
  closeConversation();                    // stop the convo poll (no read-flicker)
  chatPanel.hidden = true;
  renderDock();
}
document.getElementById('chat-min').addEventListener('click', minimizeChat);

// ---- Floating chat window: draggable (by header) + resizable, remembered ----
(function () {
  const panel = document.getElementById('chat-panel');
  const head = panel ? panel.querySelector('.chat-head') : null;
  if (!panel || !head) return;
  const KEY = 'chatPanelBox';
  try {
    const box = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (box) {
      panel.classList.add('floating');
      if (box.w) panel.style.width = box.w + 'px';
      if (box.h) panel.style.height = box.h + 'px';
      const left = Math.min(Math.max(0, box.left), window.innerWidth - 80);
      const top = Math.min(Math.max(0, box.top), window.innerHeight - 60);
      panel.style.left = left + 'px'; panel.style.top = top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }
  } catch (_) {}
  const save = () => {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem(KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    } catch (_) {}
  };
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    panel.classList.add('floating');
    panel.style.width = r.width + 'px'; panel.style.height = r.height + 'px';
    panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    const offX = e.clientX - r.left, offY = e.clientY - r.top;
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
    head.classList.add('dragging');
    const move = (ev) => {
      panel.style.left = Math.min(Math.max(0, ev.clientX - offX), window.innerWidth - 60) + 'px';
      panel.style.top = Math.min(Math.max(0, ev.clientY - offY), window.innerHeight - 40) + 'px';
    };
    const up = () => { head.classList.remove('dragging'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); save(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    e.preventDefault();
  });
  if (window.ResizeObserver) {
    let rt = null;
    new ResizeObserver(() => { if (panel.hidden) return; if (rt) clearTimeout(rt); rt = setTimeout(save, 400); }).observe(panel);
  }
})();

// ---- Avatar helpers ----
const AVATAR_COLORS = [
  '#4c8dff', '#22b8a6', '#e0803a', '#b06ef0', '#e05c8a',
  '#3aa0e0', '#5cc46a', '#d9a62e', '#8a7bf0', '#e0655c',
];
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function roleClass(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'role-admin';
  if (r === 'hr') return 'role-hr';
  if (r === 'processor') return 'role-proc';
  return 'role-emp';
}

// ---- Time helpers ----
function parseServerDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
function fmtTime(s) {
  const d = parseServerDate(s);
  if (!d) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(s) {
  const d = parseServerDate(s);
  if (!d) return '';
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- Contact list ----
function statusClass(status) {
  if (status === 'free') return 'st-free';
  if (status === 'busy') return 'st-busy';
  if (status === 'offline') return 'st-offline';
  return '';
}
async function loadContacts() {
  const res = await window.portal.chatContacts();
  if (!res || !res.ok) return;
  const list = document.getElementById('chat-list');
  const empty = document.getElementById('chat-list-empty');
  list.innerHTML = '';
  const contacts = (res.contacts || []).slice();
  empty.hidden = contacts.length > 0;

  // Priority: whoever I'm actively processing a sale with floats to the top,
  // then unread, then the server's order.
  contacts.sort((a, b) => {
    const pa = a.processing ? 1 : 0, pb = b.processing ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ua = a.unread ? 1 : 0, ub = b.unread ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return 0;
  });

  for (const c of contacts) {
    contactsById[c.id] = c;
    const name = c.full_name || c.username;
    const item = document.createElement('div');
    item.className = 'chat-item' + (chatActive && chatActive.id === c.id ? ' active' : '') + (c.processing ? ' processing' : '');
    const stCls = statusClass(c.status);
    // When a sale is in progress between us, that takes over the sub-line.
    let sub;
    if (c.processing_dir === 'mine') sub = `<span class="proc-label">● Processing your sale</span>`;
    else if (c.processing_dir === 'handling') sub = `<span class="proc-label">● Processing ${escapeHtml((name.split(' ')[0]))}'s sale</span>`;
    else {
      const stLabel = c.status ? `<span class="st-label ${stCls}">${c.status === 'free' ? 'available' : c.status}</span>` : '';
      sub = stLabel || '@' + escapeHtml(c.username);
    }
    item.innerHTML =
      `<div class="avatar-wrap ${stCls}${c.processing ? ' processing' : ''}"><div class="avatar" style="background:${avatarColor(c.id)}">${escapeHtml(initials(name))}</div></div>
       <div class="chat-item-main">
         <div class="chat-item-name">${escapeHtml(name)}</div>
         <div class="chat-item-sub">${sub}</div>
       </div>
       <div class="chat-item-right">
         <span class="role-chip ${roleClass(c.role)}">${escapeHtml(c.role)}</span>
         ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
       </div>`;
    item.addEventListener('click', () => openConversation(c));
    list.appendChild(item);
  }

  // Keep the open conversation's header presence ring in sync.
  if (chatActive && contactsById[chatActive.id]) {
    const c = contactsById[chatActive.id];
    const avWrap = document.getElementById('chat-convo-av');
    if (avWrap) avWrap.className = 'avatar-wrap ' + statusClass(c.status);
    const st = c.status ? (c.status === 'free' ? 'available' : c.status) : c.role;
    document.getElementById('chat-with-role').textContent = (c.username ? '@' + c.username + ' · ' : '') + st;
  }
}

// ---- Open / close a conversation ----
function openConversation(c) {
  chatActive = c;
  headUnread[c.id] = 0; // viewing it clears its docked unread
  if (chatMsgTimer) { clearInterval(chatMsgTimer); chatMsgTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  lastMsgId = 0; lastSenderMine = null; lastMsgDate = ''; lastSalesSig = '';

  const name = c.full_name || c.username;
  const av = document.getElementById('chat-convo-avatar');
  av.textContent = initials(name);
  av.style.background = avatarColor(c.id);
  const avWrap = document.getElementById('chat-convo-av');
  if (avWrap) avWrap.className = 'avatar-wrap ' + statusClass((contactsById[c.id] || c).status);
  document.getElementById('chat-with-name').textContent = name;
  const st = (contactsById[c.id] || c).status;
  const stText = st ? (st === 'free' ? 'available' : st) : c.role;
  document.getElementById('chat-with-role').textContent = (c.username ? '@' + c.username + ' · ' : '') + stText;
  document.getElementById('chat-messages').innerHTML = '';
  const salesEl = document.getElementById('group-sales');
  salesEl.innerHTML = ''; salesEl.hidden = false;

  const input = document.getElementById('chat-text');
  updateSaleHint(c);
  updateWorkToggle();

  chatPanel.classList.add('showing');
  input.focus();

  loadConversation(true);
  chatMsgTimer = setInterval(() => loadConversation(false), 2000); // responsive while a sale is live
  countdownTimer = setInterval(tickCountdowns, 500);
  loadContacts();
  if (typeof renderDock === 'function') renderDock();
}

function closeConversation() {
  chatActive = null;
  if (chatMsgTimer) { clearInterval(chatMsgTimer); chatMsgTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const salesEl = document.getElementById('group-sales');
  salesEl.innerHTML = ''; salesEl.hidden = true;
  document.getElementById('sale-hint').hidden = true;
  document.getElementById('work-toggle').hidden = true;
  chatPanel.classList.remove('showing');
  renderList();
}

// Employee hint + the #sale compose button: only for employees chatting a taker.
function updateSaleHint(c) {
  const el = document.getElementById('sale-hint');
  const btn = document.getElementById('sale-compose-btn');
  const isSaleTarget = c && myRole === 'employee' && (c.role === 'processor' || c.role === 'admin');
  if (btn) btn.hidden = !isSaleTarget;
  if (!el || !c) return;
  if (isSaleTarget) {
    const st = (contactsById[c.id] || {}).status;
    if (c.role === 'processor' && st === 'busy') {
      el.innerHTML = '⚠ This processor is <b>busy</b> — send the sale to an admin instead.';
      el.className = 'sale-hint warn';
    } else if (c.role === 'processor' && st === 'offline') {
      el.innerHTML = '⚠ This processor is <b>offline</b> — send the sale to an admin instead.';
      el.className = 'sale-hint warn';
    } else {
      el.innerHTML = 'Type <b>#sale</b> and the details to send a sale.';
      el.className = 'sale-hint';
    }
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// Admin availability toggle (busy/free), shown in the conversation header.
function updateWorkToggle() {
  const t = document.getElementById('work-toggle');
  if (myRole !== 'admin') { t.hidden = true; return; }
  t.hidden = false;
  const busy = myWorkStatus === 'busy';
  t.textContent = busy ? 'Busy' : 'Available';
  t.className = 'work-toggle ' + (busy ? 'busy' : 'free');
  t.onclick = async () => {
    await window.portal.setWorkStatus(busy ? 'free' : 'busy');
    myWorkStatus = busy ? 'free' : 'busy';
    updateWorkToggle();
    loadConversation(false);
  };
}

// ---- Sales strip (cards) inside the conversation ----
let salesCache = {};
let lastSalesSig = '';
function salesSignature(sales) {
  return sales.map((s) =>
    `${s.id}:${s.state}:${s.claimed_by}:${s.my_wait_count}:${s.can_claim}:${s.can_process}:${s.can_assign}:${s.target_id}:${s.wait_until || ''}:${s.my_wait_until || ''}`
  ).join('|');
}
function renderSales(sales) {
  salesCache = {};
  for (const s of sales) salesCache[s.id] = s;
  const sig = salesSignature(sales);
  if (sig === lastSalesSig) return; // avoid rebuild churn (keeps dropdown selection)
  lastSalesSig = sig;

  // Preserve an assign dropdown selection across rebuilds.
  const active = document.activeElement;
  let keepSaleId = null, keepVal = null;
  if (active && active.classList && active.classList.contains('assign-sel')) {
    const card = active.closest('.sale-card');
    if (card) { keepSaleId = Number(card.dataset.saleId); keepVal = active.value; }
  }

  const wrap = document.getElementById('group-sales');
  wrap.innerHTML = '';
  for (const s of sales) wrap.appendChild(saleCard(s));

  if (keepSaleId) {
    const sel = document.querySelector(`.sale-card[data-sale-id="${keepSaleId}"] .assign-sel`);
    if (sel) { sel.value = keepVal; sel.focus(); }
  }
}

function saleCard(s) {
  const card = document.createElement('div');
  card.className = 'sale-card state-' + s.state;
  card.dataset.saleId = s.id;

  const badge = {
    pending: 'NEW', queued: 'QUEUED', processing: 'PROCESSING', processed: 'PROCESSED',
  }[s.state] || s.state;

  let meta = `From ${escapeHtml(s.employee)}`;
  if (s.target && s.target_id && s.target_id !== s.employee_id && s.state !== 'processing' && s.state !== 'processed') {
    meta += ` → ${escapeHtml(s.target)}`;
  }
  if (s.state === 'processing' || s.state === 'processed') {
    meta += ` · ${s.state === 'processed' ? 'Processed' : 'Processing'} by ${escapeHtml(s.claimed_name || '—')}`;
    if (s.response_secs != null) meta += ` · responded ${s.response_secs}s${s.late ? ' (late)' : ''}`;
  }

  const waitCd = (until) => `<span class="sale-wait-cd" data-until="${escapeHtml(until || '')}"></span>`;

  let controls = '';
  if (s.state === 'pending' && s.can_claim && s.my_wait_until) {
    controls = `<div class="sale-actions">
        <span class="muted">You said wait · back in</span> ${waitCd(s.my_wait_until)}
        <button class="sale-btn process" data-act="processing">Process now</button>
      </div>`;
  } else if (s.state === 'pending' && s.can_claim) {
    controls = `<div class="sale-actions">
        <button class="sale-btn process" data-act="processing">Processing</button>
        <div class="wait-seg" data-secs="30">
          <button type="button" data-secs="30" class="active">30s</button>
          <button type="button" data-secs="60">1 min</button>
        </div>
        <button class="sale-btn wait" data-act="wait">Wait${s.my_wait_count ? ' (' + s.my_wait_count + ')' : ''}</button>
        <span class="sale-countdown" data-disp="${escapeHtml(s.dispatched_at || '')}"></span>
      </div>`;
  } else if (s.state === 'pending' || s.state === 'queued') {
    // The dispatcher (or an onlooker) — no "respond now"; show wait/queue status.
    if (s.wait_until) {
      controls = `<div class="sale-actions"><span class="muted">${escapeHtml(s.target || 'Handler')} is on it · responding in</span> ${waitCd(s.wait_until)}</div>`;
    } else if (s.state === 'queued') {
      controls = `<div class="sale-actions"><span class="muted">Queued${s.target ? ' for ' + escapeHtml(s.target) : ''} — will prompt them once free.</span></div>`;
    } else {
      controls = `<div class="sale-actions"><span class="muted">Waiting for a response…</span></div>`;
    }
  } else if (s.state === 'processing' && s.can_process) {
    controls = `<div class="sale-actions"><button class="sale-btn done" data-act="processed">Mark processed</button></div>`;
  }

  // Admin routing: assign/reassign an open sale to a processor.
  let assignBlock = '';
  if (s.can_assign) {
    const opts = (convTakers || []).map((t) =>
      `<option value="${t.id}">${escapeHtml(t.name)}${t.status ? ' (' + t.status + ')' : ''}</option>`).join('');
    assignBlock = `<div class="sale-actions assign-row">
        <select class="assign-sel">${opts || '<option value="">(no processors)</option>'}</select>
        <button class="sale-btn assign" data-act="assign">Assign</button>
      </div>`;
  }

  card.innerHTML = `
    <div class="sale-top"><span class="sale-badge ${s.state}">${badge}</span>
      <span class="sale-meta">${meta}</span></div>
    <div class="sale-body">${renderBody(s.body)}</div>
    ${controls}
    ${assignBlock}`;

  card.querySelectorAll('.sale-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      let secs, pid;
      if (act === 'wait') {
        const seg = b.parentNode.querySelector('.wait-seg');
        secs = seg ? Number(seg.dataset.secs) : 30;
      }
      if (act === 'assign') {
        const sel = b.parentNode.querySelector('.assign-sel');
        pid = sel ? Number(sel.value) : 0;
        if (!pid) return;
      }
      b.disabled = true;
      const res = await window.portal.saleAction(s.id, act, secs, pid);
      if (act === 'processing' && res && !res.ok && res.result === 'taken') {
        showWarn('That sale was just taken or reassigned.');
      }
      loadConversation(false);
    });
  });
  return card;
}

function tickCountdowns() {
  // Response SLA (takers only): 30s from dispatch, then "respond now".
  document.querySelectorAll('.sale-countdown').forEach((el) => {
    const disp = el.dataset.disp;
    if (!disp) { el.textContent = ''; return; }
    const elapsed = (Date.now() + serverSkew - Date.parse(disp.replace(' ', 'T'))) / 1000;
    const remain = Math.ceil(30 - elapsed);
    if (remain > 0) { el.textContent = `${remain}s`; el.className = 'sale-countdown'; }
    else { el.textContent = 'respond now'; el.className = 'sale-countdown overdue'; }
  });
  // Wait countdown (both sides): live count down to a snooze expiry.
  document.querySelectorAll('.sale-wait-cd').forEach((el) => {
    const until = el.dataset.until;
    if (!until) { el.textContent = ''; return; }
    const remain = Math.ceil((Date.parse(until.replace(' ', 'T')) - (Date.now() + serverSkew)) / 1000);
    if (remain > 0) { el.textContent = `${remain}s`; el.className = 'sale-wait-cd'; }
    else { el.textContent = 'now'; el.className = 'sale-wait-cd done'; }
  });
}

// ---- Messages ----
let directPollBusy = false;
async function loadConversation(scroll) {
  if (!chatActive) return;
  if (chatPanel.hidden) return; // panel closed — don't mark messages read in the background
  if (directPollBusy) return; // prevent overlapping polls appending a message twice
  directPollBusy = true;
  const convoId = chatActive.id;
  let res;
  try {
    res = await window.portal.chatMessages(convoId, lastMsgId);
  } finally {
    directPollBusy = false;
  }
  if (!res || !res.ok) return;
  if (!chatActive || chatActive.id !== convoId) return; // conversation changed mid-poll

  serverSkew = res.serverNow ? (Date.parse(res.serverNow.replace(' ', 'T')) - Date.now()) : serverSkew;
  if (res.me) { myRole = res.me.role; if (res.me.work_status) myWorkStatus = res.me.work_status; }
  convTakers = res.takers || [];
  renderSales(res.sales || []);
  updateWorkToggle();
  updateSaleHint(chatActive);

  const box = document.getElementById('chat-messages');
  let incoming = 0;
  for (const m of res.messages) {
    lastMsgId = Math.max(lastMsgId, m.id);
    if (!m.mine && !scroll) incoming++;

    const day = fmtDay(m.created_at);
    if (day && day !== lastMsgDate) {
      lastMsgDate = day;
      const sep = document.createElement('div');
      sep.className = 'chat-day';
      sep.innerHTML = `<span>${escapeHtml(day)}</span>`;
      box.appendChild(sep);
      lastSenderMine = null;
    }

    const grouped = lastSenderMine === m.mine;
    lastSenderMine = m.mine;

    const row = document.createElement('div');
    row.className = 'msg ' + (m.mine ? 'mine' : 'theirs') + (grouped ? ' grouped' : '');
    row.innerHTML =
      `<div class="bubble">${renderBody(m.body)}<span class="msg-time">${escapeHtml(fmtTime(m.created_at))}</span></div>`;
    box.appendChild(row);
  }

  if (incoming > 0) notifyIncoming(chatActive.full_name || chatActive.username || 'New message', '');
  if (res.messages.length || scroll) box.scrollTop = box.scrollHeight;
}

// Enter sends, Shift+Enter inserts a new line. Textarea grows with content.
const chatTextEl = document.getElementById('chat-text');
function autoGrowChat() { chatTextEl.style.height = 'auto'; chatTextEl.style.height = Math.min(110, chatTextEl.scrollHeight) + 'px'; }
chatTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('chat-form').requestSubmit();
  }
});
chatTextEl.addEventListener('input', autoGrowChat);

// #sale button: insert the tag automatically so employees don't type it.
document.getElementById('sale-compose-btn').addEventListener('click', () => {
  const t = chatTextEl.value.trimStart();
  if (!/^#sale\b/i.test(t)) {
    chatTextEl.value = '#sale ' + (t ? t : '');
  }
  chatTextEl.focus();
  const end = chatTextEl.value.length;
  try { chatTextEl.setSelectionRange(end, end); } catch (_) {}
  autoGrowChat();
});

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-text');
  const text = input.value.trim();
  if (!text || !chatActive) return;
  input.value = '';
  autoGrowChat();
  const res = await window.portal.chatSend(chatActive.id, text);
  if (res && res.ok) {
    loadConversation(true); // shows the new message, or the new sale card if #sale
  } else if (res && res.busy) {
    showMsgToast('Processor busy', (res.target || 'That processor') + ' is busy right now — send this sale to an admin instead.');
  } else if (res && res.error === 'not_taker') {
    showMsgToast('Can’t send sale', '#sale can only be sent to a processor or an admin.');
  } else if (res && !res.ok) {
    showMsgToast('Not sent', 'Your message could not be sent. Please try again.');
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
