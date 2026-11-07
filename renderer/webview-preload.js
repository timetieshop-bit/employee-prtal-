// webview-preload.js
// Runs inside every page in the embedded <webview>, before the page's own
// scripts. Implements an INTERNAL clipboard: copy/cut/paste work inside the
// portal, but go through an in-app buffer instead of the OS clipboard — so
// nothing can be copied from the portal to another app, or pasted in from one.
// Drag-and-drop, the right-click menu, DevTools and screenshots stay blocked.

// ============================================================
// Browser-fidelity normalization
// The embedded browser is driven by a human agent, but Electron leaks a few JS
// signals (Electron brands in navigator.userAgentData, no window.chrome, empty
// plugins, a software-WebGL vendor) that, combined with the Chrome UA we send,
// read as "automated client" and trip false "confirm you're not a bot" walls on
// ordinary sites. These shims present the Chromium consistently as the ordinary
// Chrome it is built on. They run in the page's own world (contextIsolation is
// off for the webview) before the page's scripts. Nothing here hides that a real
// person is browsing — it removes a self-inflicted inconsistency.
// ============================================================
(() => {
  try {
    const def = (obj, prop, getter) => {
      try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (_) {}
    };
    const ua = navigator.userAgent || '';
    const m = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    const major = (m && m[1]) || (ua.match(/Chrome\/(\d+)/) || [])[1] || '126';
    const fullVer = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : `${major}.0.0.0`;

    // 1) navigator.webdriver = false (belt-and-suspenders with the Chromium switch)
    def(Navigator.prototype, 'webdriver', () => false);

    // 2) navigator.userAgentData aligned to Microsoft Edge on Windows (no "Electron")
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Microsoft Edge', version: major },
      { brand: 'Not.A/Brand', version: '24' },
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'x86', bitness: '64', brands,
        fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not.A/Brand' ? '24.0.0.0' : fullVer })),
        mobile: false, model: '', platform: 'Windows', platformVersion: '15.0.0',
        uaFullVersion: fullVer, wow64: false,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
    };
    def(Navigator.prototype, 'userAgentData', () => uaData);

    // navigator.languages present
    if (!navigator.languages || !navigator.languages.length) def(Navigator.prototype, 'languages', () => ['en-US', 'en']);

    // 3) window.chrome (runtime / app / csi / loadTimes) like real Chrome
    if (!window.chrome) window.chrome = {};
    const c = window.chrome;
    if (!c.runtime) c.runtime = {};
    if (!c.app) c.app = { isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
    if (!c.csi) c.csi = function () { return { onloadT: Date.now(), startE: Date.now(), pageT: 0, tran: 15 }; };
    if (!c.loadTimes) c.loadTimes = function () {
      const t = Date.now() / 1000;
      return { requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t,
        finishLoadTime: t, firstPaintTime: t, firstPaintAfterLoadTime: 0, navigationType: 'Other',
        wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
    };

    // 4) Non-empty plugins + mimeTypes (PDF viewer), like a real Chrome
    try {
      const mimes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      const mkPlugin = (name) => {
        const p = { name, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: mimes.length };
        mimes.forEach((mm, i) => { p[i] = mm; });
        p.item = (i) => p[i] || null; p.namedItem = (n) => mimes.find((mm) => mm.type === n) || null;
        return p;
      };
      const plugins = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
        'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'].map(mkPlugin);
      mimes.forEach((mm) => { mm.enabledPlugin = plugins[0]; });
      const pArr = plugins.slice();
      pArr.item = (i) => pArr[i] || null; pArr.namedItem = (n) => plugins.find((p) => p.name === n) || null; pArr.refresh = () => {};
      def(Navigator.prototype, 'plugins', () => pArr);
      const mArr = mimes.slice();
      mArr.item = (i) => mArr[i] || null; mArr.namedItem = (n) => mimes.find((mm) => mm.type === n) || null;
      def(Navigator.prototype, 'mimeTypes', () => mArr);
    } catch (_) {}

    // 5) Permissions API consistency: notifications state matches Notification.permission
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const orig = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (d) => {
          if (d && d.name === 'notifications') {
            return Promise.resolve({ state: (window.Notification && Notification.permission) || 'prompt', onchange: null });
          }
          return orig(d);
        };
      }
    } catch (_) {}

    // 6) WebGL vendor/renderer: only replace a software (SwiftShader) value — real
    //    GPUs pass through unchanged — so it never reports the headless renderer.
    try {
      const VENDOR = 'Google Inc. (Intel)';
      const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      const patchGL = (proto) => {
        if (!proto || !proto.getParameter) return;
        const gp = proto.getParameter;
        proto.getParameter = function (p) {
          const v = gp.call(this, p);
          if (p === 37445 && /swiftshader/i.test(String(v))) return VENDOR;   // UNMASKED_VENDOR_WEBGL
          if (p === 37446 && /swiftshader/i.test(String(v))) return RENDERER; // UNMASKED_RENDERER_WEBGL
          return v;
        };
      };
      if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);
    } catch (_) {}
  } catch (_) {}
})();

(() => {
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (_) { ipc = null; }

  // Clipboard isolation on? (server flag). Fail safe = on.
  const lockOn = () => {
    if (!ipc) return true;
    try { return ipc.sendSync('clip:lock'); } catch (_) { return true; }
  };
  const selectionText = () => {
    try { return String(window.getSelection ? window.getSelection() : ''); } catch (_) { return ''; }
  };
  // Text being copied — the normal selection, or (for "copy" buttons that select
  // a hidden input/textarea and run execCommand) the focused field's selection.
  const grabText = () => {
    const s = selectionText();
    if (s) return s;
    try {
      const el = document.activeElement;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.value === 'string') {
        const a = el.selectionStart, b = el.selectionEnd;
        if (a != null && b != null && b > a) return el.value.substring(a, b);
        if (el.value) return el.value;
      }
    } catch (_) {}
    return '';
  };

  const hardStop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); return false; };

  // ---- Copy / cut / paste → internal buffer ----
  window.addEventListener('copy', (e) => {
    if (!lockOn()) return;                 // isolation off → native behaviour
    const s = grabText();
    hardStop(e);
    try { if (e.clipboardData) e.clipboardData.clearData(); } catch (_) {}
    if (s && ipc) ipc.send('clip:set', s);
  }, true);

  window.addEventListener('cut', (e) => {
    if (!lockOn()) return;
    const s = grabText();
    hardStop(e);
    try { if (e.clipboardData) e.clipboardData.clearData(); } catch (_) {}
    if (s && ipc) ipc.send('clip:set', s);
    try { document.execCommand('delete'); } catch (_) {}
  }, true);

  window.addEventListener('paste', (e) => {
    if (!lockOn()) return;
    hardStop(e);
    let t = '';
    // Prefer the in-app buffer; fall back to the OS clipboard so text from a
    // website "copy" button can be pasted into fields inside the app.
    if (ipc) { try { t = ipc.sendSync('clip:paste') || ''; } catch (_) {} }
    if (t) { try { document.execCommand('insertText', false, t); } catch (_) {} }
  }, true);

  // ---- Always blocked: cross-app drag, legacy clipboard variants ----
  // (Right-click is allowed now — a real browser context menu is shown by the
  //  main process.)
  ['dragstart', 'drop', 'dragover', 'beforecopy', 'beforecut', 'beforepaste']
    .forEach((ev) => window.addEventListener(ev, (e) => {
      if (!lockOn() && (ev === 'beforecopy' || ev === 'beforecut' || ev === 'beforepaste')) return;
      hardStop(e);
    }, true));

  // ---- Keys: block print, PrintScreen and DevTools (NOT copy/paste/select) ----
  window.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'printscreen') return hardStop(e);
    if (mod && k === 'p') return hardStop(e);
    if (k === 'f12') return hardStop(e);
    if (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) return hardStop(e);
  }, true);
})();

// ============================================================
// Basic form autofill — remembers non-sensitive text field values locally and
// suggests them via a native datalist. Passwords, card, CVV, OTP, PIN and SSN
// fields are never captured.
// ============================================================
(() => {
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (_) { return; }
  const SENSITIVE = /pass|cvv|cvc|card|ccnum|cc-num|credit|security|secret|ssn|social|otp|\bpin\b/i;
  const host = (location && location.hostname) || '';
  const fieldKey = (el) => String(el.name || el.id || el.getAttribute('autocomplete') || '').trim();
  const eligible = (el) => {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.type || 'text').toLowerCase();
    if (!['text', 'email', 'tel', 'search', 'url', ''].includes(t)) return false;
    const k = fieldKey(el);
    if (!k) return false;
    if (SENSITIVE.test(k) || SENSITIVE.test(t) || SENSITIVE.test(el.className || '')) return false;
    return true;
  };

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!eligible(el) || el.__afAttached) return;
    el.__afAttached = true;
    let vals = [];
    try { vals = ipc.sendSync('autofill:get', { host, field: fieldKey(el) }) || []; } catch (_) {}
    if (!vals.length) return;
    try {
      const id = '__af_' + Math.random().toString(36).slice(2);
      const dl = document.createElement('datalist');
      dl.id = id;
      vals.forEach((v) => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
      (document.body || document.documentElement).appendChild(dl);
      el.setAttribute('list', id);
    } catch (_) {}
  }, true);

  const save = (el) => {
    if (!eligible(el)) return;
    const v = String(el.value || '').trim();
    if (v.length < 2 || v.length > 200) return;
    try { ipc.send('autofill:set', { host, field: fieldKey(el), value: v }); } catch (_) {}
  };
  document.addEventListener('change', (e) => save(e.target), true);
  document.addEventListener('submit', (e) => {
    try { (e.target.querySelectorAll ? e.target.querySelectorAll('input') : []).forEach(save); } catch (_) {}
  }, true);
})();

// ============================================================
// Hide the Google top-bar account controls (Gmail / Images / apps grid /
// Sign in) on Google pages — account sign-in isn't available in the portal, so
// these just confuse. Search itself is untouched.
// ============================================================
(() => {
  try {
    const h = (location.hostname || '').toLowerCase();
    if (!/(^|\.)google\.[a-z.]+$/.test(h)) return;
    const css =
      '#gb, #gbw, #gbwa, #gbar, ' +
      'a[href^="https://mail.google.com/"], a[href*="//mail.google.com/"], ' +
      'a[aria-label="Google apps"], a[aria-label="Sign in"], ' +
      'a[href*="imghp"], a[href*="ServiceLogin"], a[href*="accounts.google.com/ServiceLogin"], ' +
      'a[href*="accounts.google.com/AccountChooser"] { display: none !important; }';
    const style = document.createElement('style');
    style.setAttribute('data-ep', 'hide-gbar');
    style.textContent = css;
    const mount = () => { try { (document.head || document.documentElement).appendChild(style); } catch (_) {} };
    mount();
    if (!document.head) document.addEventListener('DOMContentLoaded', mount, { once: true });
  } catch (_) {}
})();
