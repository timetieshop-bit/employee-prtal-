// Loads JsSIP reliably. External file because the app's CSP forbids inline scripts.
// Tries the locally bundled copy first (needs no network), then CDN fallbacks that
// the CSP's script-src already allows. Exposes window.__sipReady (a Promise) that
// resolves true when window.JsSIP is available, false if every source failed.
window.__sipReady = new Promise((resolve) => {
  const sources = [
    'vendor/jssip.min.js',
    'https://cdn.jsdelivr.net/npm/jssip@3.10.1/dist/jssip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js',
    'https://unpkg.com/jssip@3.10.1/dist/jssip.min.js',
  ];
  let i = 0;
  const ok = () => !!(window.JsSIP && window.JsSIP.UA);
  function tryNext() {
    if (ok()) { resolve(true); return; }
    if (i >= sources.length) { window.__sipMissing = true; resolve(false); return; }
    const s = document.createElement('script');
    s.src = sources[i++];
    s.onload = () => { ok() ? resolve(true) : tryNext(); };
    s.onerror = () => tryNext();
    document.head.appendChild(s);
  }
  tryNext();
});
