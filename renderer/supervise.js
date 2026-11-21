// ===========================================================================
// Admin live-agent supervision — runs INSIDE the employee portal for admins.
//
// Mirrors the web admin panel's viewer, but talks to the server through the
// main process (window.portal.sv*) so the renderer never needs the server URL
// or auth token. Two pieces:
//   1) a slide-out panel listing agents who are online right now;
//   2) a full-screen viewer that streams the chosen agent's screen as JPEG
//      frames and, when the admin takes control, relays clicks/keystrokes back
//      so a trainer can drive the agent's portal to assist them.
// ===========================================================================
(function supervise() {
  if (!window.portal || !window.portal.svList) return;

  const btn        = document.getElementById('sv-btn');
  const badge      = document.getElementById('sv-online-badge');
  const panel      = document.getElementById('sv-panel');
  const panelClose = document.getElementById('sv-panel-close');
  const refreshBtn = document.getElementById('sv-refresh');
  const listEl     = document.getElementById('sv-list');
  const emptyEl    = document.getElementById('sv-list-empty');
  if (!btn || !panel) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ----- Online-agent panel -----------------------------------------------
  let listTimer = null, panelOpen = false;

  async function loadList() {
    let res = null;
    try { res = await window.portal.svList(); } catch (_) {}
    const users = (res && Array.isArray(res.users)) ? res.users : [];
    // Online agents only, and never offer to watch yourself.
    const online = users.filter((u) => u.online && u.username !== loggedInUserName());
    renderList(online);
    if (badge) {
      if (online.length) { badge.textContent = String(online.length); badge.hidden = false; }
      else badge.hidden = true;
    }
  }

  function loggedInUserName() {
    try { return (typeof loggedInUser !== 'undefined' && loggedInUser) ? loggedInUser : ''; } catch (_) { return ''; }
  }

  function renderList(online) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!online.length) { if (emptyEl) emptyEl.hidden = false; return; }
    if (emptyEl) emptyEl.hidden = true;
    for (const u of online) {
      const name = u.full_name || u.username;
      const initial = (name || '?').trim().charAt(0).toUpperCase();
      const row = document.createElement('div');
      row.className = 'sv-row';
      row.innerHTML = `
        <span class="sv-ava">${esc(initial)}</span>
        <span class="sv-row-main">
          <span class="sv-row-name">${esc(name)}</span>
          <span class="sv-row-sub"><span class="sv-dot"></span>Online · @${esc(u.username)}</span>
        </span>
        <button class="sv-watch-btn" data-uid="${u.id}" data-name="${esc(name)}" title="View this agent's screen">👁 View</button>`;
      listEl.appendChild(row);
    }
  }

  function openPanel() {
    panel.hidden = false; panelOpen = true;
    loadList();
    if (listTimer) clearInterval(listTimer);
    listTimer = setInterval(loadList, 6000); // refresh the list while it's open
  }
  function closePanel() {
    panel.hidden = true; panelOpen = false;
    if (listTimer) { clearInterval(listTimer); listTimer = null; }
  }

  btn.addEventListener('click', () => { panelOpen ? closePanel() : openPanel(); });
  if (panelClose) panelClose.addEventListener('click', closePanel);
  if (refreshBtn) refreshBtn.addEventListener('click', loadList);
  if (listEl) listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sv-watch-btn');
    if (b) viewer.open(parseInt(b.dataset.uid, 10), b.dataset.name);
  });

  // Keep the badge warm even when the panel is closed, so an admin notices who's
  // online — but cheaply (every 20s).
  setInterval(() => { if (!panelOpen && btn && !btn.hidden) loadList(); }, 20000);
  // Prime once shortly after load (role may already be admin).
  setTimeout(() => { if (btn && !btn.hidden) loadList(); }, 2500);

  // ----- Full-screen viewer -----------------------------------------------
  const viewer = (function () {
    const modal   = document.getElementById('sv-modal');
    const img     = document.getElementById('sv-img');
    const whoEl   = document.getElementById('sv-who');
    const statusEl= document.getElementById('sv-status');
    const emptyV  = document.getElementById('sv-empty');
    const ctrlBtn = document.getElementById('sv-control');
    const closeBtn= document.getElementById('sv-modal-close');
    if (!modal || !img) return { open() {} };

    let uid = 0, stopped = true, gotFrame = false, pullTimer = null, hbTimer = null, pulling = false;
    let control = false, evQueue = [], flushTimer = null, lastMove = 0;

    function showEmpty(msg) {
      if (emptyV) { emptyV.style.display = 'flex'; const t = emptyV.querySelector('div:last-child'); if (t && msg) t.textContent = msg; }
      img.style.display = 'none';
    }
    function showImg() { if (emptyV) emptyV.style.display = 'none'; img.style.display = 'block'; }

    async function pullFrame() {
      if (stopped || pulling) return;
      pulling = true;
      try {
        const r = await window.portal.svFrame(uid);
        if (r && r.status === 200 && r.dataUrl) {
          img.src = r.dataUrl; gotFrame = true; showImg();
          if (!control) statusEl.textContent = '';
        } else if (r && (r.status === 204 || r.status === 0)) {
          if (!gotFrame) showEmpty('Waiting for the agent’s screen…');
        } else if (r && (r.status === 401 || r.status === 403)) {
          showEmpty('Not authorized to view this screen.');
        }
      } catch (_) { if (!gotFrame) showEmpty('Connecting…'); }
      finally { pulling = false; }
    }

    async function heartbeat() {
      if (stopped) return;
      try { await window.portal.svHeartbeat(uid); } catch (_) {}
    }

    // ---- remote control (training assist) ----
    function norm(e) {
      const r = img.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    }
    async function flush() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!evQueue.length || stopped || !uid) return;
      const events = evQueue.splice(0, evQueue.length);
      try { await window.portal.svInput(uid, events); } catch (_) {}
    }
    function q(ev) { evQueue.push(ev); if (evQueue.length >= 25) flush(); else if (!flushTimer) flushTimer = setTimeout(flush, 55); }

    function setControl(on) {
      control = !!on;
      if (ctrlBtn) {
        ctrlBtn.textContent = control ? '🛑 Stop control' : '🖱️ Take control';
        ctrlBtn.classList.toggle('on', control);
      }
      img.style.cursor = control ? 'crosshair' : 'default';
      statusEl.textContent = control ? 'you are controlling this screen' : '';
      if (control) img.focus();
    }

    img.addEventListener('mousedown', (e) => { if (!control) return; e.preventDefault(); img.focus(); const p = norm(e); q({ t: 'd', x: p.x, y: p.y, b: e.button === 2 ? 'right' : 'left' }); });
    img.addEventListener('mouseup',   (e) => { if (!control) return; e.preventDefault(); const p = norm(e); q({ t: 'u', x: p.x, y: p.y, b: e.button === 2 ? 'right' : 'left' }); });
    img.addEventListener('mousemove', (e) => { if (!control) return; const now = Date.now(); if (now - lastMove < 70) return; lastMove = now; const p = norm(e); q({ t: 'm', x: p.x, y: p.y }); });
    img.addEventListener('wheel',     (e) => { if (!control) return; e.preventDefault(); const p = norm(e); q({ t: 'w', x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }); }, { passive: false });
    img.addEventListener('contextmenu', (e) => { if (control) e.preventDefault(); });
    img.addEventListener('keydown', (e) => {
      if (!control) return;
      e.preventDefault();
      const mods = [];
      if (e.ctrlKey) mods.push('control'); if (e.shiftKey) mods.push('shift'); if (e.altKey) mods.push('alt'); if (e.metaKey) mods.push('meta');
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) q({ t: 'char', ch: e.key });
      else q({ t: 'key', k: e.key, mods });
    });

    async function open(id, name) {
      uid = id; stopped = false; gotFrame = false; setControl(false);
      whoEl.textContent = name || ('User #' + id);
      statusEl.textContent = '';
      img.removeAttribute('src'); showEmpty('Connecting to the agent’s screen…');
      modal.hidden = false;
      try { await window.portal.svStart(uid); } catch (_) {}
      pullFrame(); heartbeat();
      pullTimer = setInterval(pullFrame, 500);  // ~2 fps
      hbTimer   = setInterval(heartbeat, 4000); // keep the session alive
    }
    async function close() {
      stopped = true; setControl(false);
      if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
      if (hbTimer)   { clearInterval(hbTimer);   hbTimer = null; }
      modal.hidden = true;
      img.removeAttribute('src');
      const was = uid; uid = 0;
      try { await window.portal.svStop(was); } catch (_) {}
    }

    if (closeBtn) closeBtn.addEventListener('click', close);
    if (ctrlBtn)  ctrlBtn.addEventListener('click', () => setControl(!control));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && !control) close(); });

    return { open, close };
  })();
})();
