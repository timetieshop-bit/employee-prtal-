# Employee Portal — Desktop app

Desktop app (Electron) with a login screen, an 8-hour shift countdown, and an
embedded browser that routes all traffic through a configured proxy.

Login is checked against the PHP server (see the `employee-portal-server`
bundle). Before building, open `main.js` and set `API_BASE` to your server:

```js
const API_BASE = 'https://your-domain/portal/api';
```

The proxy is no longer hardcoded in the app. At login the server tells the app
which proxy to use (the employee's assigned proxy, or the default), and the app
routes the embedded browser through it. Manage proxies from the admin panel.

## Run it

Requires Node.js 18+.

```bash
cd employee-portal
npm install
npm start
```

Login: **emp1001** / **224322**

## Build an installer

```bash
npm run dist
```

Produces a Windows `.exe` (NSIS), macOS `.dmg`, or Linux `.AppImage` in `dist/`
depending on the machine you build on.

## What this includes

- **Proxy from the server** — the app receives its assigned proxy at login and
  routes the embedded browser through it. Nothing is hardcoded; proxy auth is
  answered via Electron's `login` event using the server-provided credentials.
- **Embedded browser with tabs** — multiple tabs (new-tab button, per-tab close,
  loading indicator), back/forward/reload, an address bar, and Google search for
  non-URL input. Links that try to open a new window open as a new tab inside the
  portal. Every tab shares the same proxied, locked session and policy checks.
- **Auth page** — login checked against the server API (`auth:login` → `/login.php`).
- **Shift timer** — 8-hour countdown, persisted so a reload doesn't reset it.
- **Clipboard isolation** — nothing can be copied out of the portal and nothing
  can be pasted in from other programs. Copy/cut/paste, right-click menus,
  drag-and-drop, select-all, print, DevTools and pop-up windows are all blocked
  in both the portal chrome and the embedded browser (see
  `renderer/webview-preload.js` and `lockWebContents()` in `main.js`). The OS
  clipboard is also cleared when the window gains or loses focus as a second
  line of defense.

## Files

| File | Role |
|------|------|
| `main.js` | Electron main process: window, proxy config, proxy auth, login check |
| `preload.js` | Secure bridge exposing `window.portal.login()` |
| `renderer/index.html` | Login + portal markup |
| `renderer/app.js` | View switching, shift countdown, browser controls |
| `renderer/styles.css` | Styling |

## Before this goes to real employees (not blocking for the prototype)

- The proxy credentials and the `emp1001` login both live inside the app, so
  anyone with the installed app can read them. Move auth to a server and hand
  out proxy credentials per-user at runtime.
- The proxy is assumed to be HTTP(S). If it's SOCKS5, change the proxy rule in
  `main.js` (`socks5://host:port`) — SOCKS auth handling differs.
