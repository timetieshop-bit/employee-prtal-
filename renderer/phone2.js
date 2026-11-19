// Second softphone — native UDP (direct-to-trunk, eyeBeam-style). Same dialer UI
// as the primary phone (Keypad / Contacts / Recents, caller-ID picker, in-call
// overlay, minimized bar) but driven entirely by the native SIP/RTP backend in
// the main process. Independent of the WSS phone: both can be on a call at once.
// Config comes from the server as `phone2` (shared trunk2, gated per user).
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('phone2-panel');
  const btn = $('phone2-btn');
  if (!panel || !btn) return;

  let cfg = null;
  let registered = false, inCall = false;
  let muted = false;
  let timerInt = null, callStart = 0;
  let callerId = '';
  let callerIds = [];
  let contacts = [];
  let activePeer = '';
  let wantTap = false;
  let nativeStarted = false;

  const PHONE2_BUILD = '0.9.24';
  const diag = [];
  function logDiag(line) {
    const t = new Date().toTimeString().slice(0, 8);
    diag.push(t + '  ' + line);
    if (diag.length > 300) diag.shift();
    const pre = document.getElementById('phone2-diag-log');
    const dd = document.getElementById('phone2-diag');
    if (pre && dd && dd.style.display !== 'none') {
      pre.textContent = diag.join('\n'); pre.scrollTop = pre.scrollHeight;
    }
  }

  const available = () => !!cfg;

  // ---- Native (UDP) backend events (this phone owns the native backend) ----
  if (window.portal && window.portal.onNativeEvent) {
    window.portal.onNativeEvent((m) => {
      if (!cfg) return;              // only handle while this phone is active
      if (m.ev === 'status' && m.arg) logDiag('• ' + m.arg);
      if (m.ev === 'debug' && m.arg) logDiag(String(m.arg));
      switch (m.ev) {
        case 'registered': setReg(true); break;
        case 'registerFailed': setReg(false); setStatus('Connect failed' + (m.arg ? ': ' + m.arg : '')); break;
        case 'ringing': setState('Ringing…'); break;
        case 'answered': setState('In call'); startTimer(); break;
        case 'ended': logDiag('• call ended'); endCall(); break;
        case 'failed':
          // NOTE: never use alert()/confirm() here — a blocking dialog in Electron
          // breaks keyboard focus app-wide after dismissal. Show it inline instead.
          setState('Failed'); setStatus(m.arg ? String(m.arg) : 'Call failed');
          showFailBanner(m.arg || 'Call failed');
          logDiag('✗ FAILED: ' + (m.arg || 'call failed'));
          endCall();
          break;
        case 'status': if (m.arg) setStatus(String(m.arg)); break; // live diagnostics
      }
    });
  }

  // ---------- config ----------
  function setConfig(c) {
    const changed = JSON.stringify(c || null) !== JSON.stringify(cfg);
    cfg = c || null;
    if (!cfg) { teardown(); btn.hidden = true; panel.hidden = true; return; }
    btn.hidden = false;
    const label = cfg.label || 'Phone 2';
    btn.title = label;
    const bt = $('phone2-btn-tx'); if (bt) bt.textContent = label;
    const tt = $('phone2-title'); if (tt) tt.textContent = label;
    callerIds = Array.isArray(cfg.callerIds) ? cfg.callerIds : [];
    contacts = Array.isArray(cfg.contacts) ? cfg.contacts : [];
    loadCallerId();
    renderSimMenu();
    renderContacts();
    renderRecents();
    if (changed) { teardown(); ensureUA(); }
  }

  // ---------- caller ID (SIM) ----------
  function cidKey() { return 'phone2Cid:' + (cfg ? cfg.user + '@' + cfg.domain : ''); }
  function loadCallerId() {
    let v = '';
    try { v = localStorage.getItem(cidKey()) || ''; } catch (_) {}
    if (callerIds.length) {
      const m = callerIds.find((c) => c.number === v);
      callerId = m ? m.number : (cfg && cfg.callerId) || callerIds[0].number;
    } else {
      callerId = v || (cfg && cfg.callerId) || '';
    }
    paintSim();
  }
  function saveCallerId(v) {
    callerId = (v || '').trim();
    try { localStorage.setItem(cidKey(), callerId); } catch (_) {}
    paintSim(); renderSimMenu();
  }
  function paintSim() {
    const named = callerIds.find((c) => c.number === callerId);
    const nm = $('phone2-sim-name'), nu = $('phone2-sim-num');
    if (nm) nm.textContent = named ? named.label || named.number : (callerId || 'Default');
    if (nu) nu.textContent = named && named.label ? ' · ' + named.number : (named ? '' : '');
  }
  function renderSimMenu() {
    const menu = $('phone2-sim-menu');
    if (!menu) return;
    menu.innerHTML = '';
    callerIds.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'ph-sim-opt' + (c.number === callerId ? ' active' : '');
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = c.label || c.number;
      b.querySelector('span').textContent = c.label ? c.number : '';
      b.addEventListener('click', () => { saveCallerId(c.number); menu.hidden = true; });
      menu.appendChild(b);
    });
    const custom = document.createElement('div');
    custom.className = 'ph-sim-custom';
    custom.innerHTML = '<input id="phone2-cid" type="text" inputmode="tel" placeholder="Custom caller ID" autocomplete="off" /><button id="phone2-cid-save">Set</button>';
    menu.appendChild(custom);
    custom.querySelector('#phone2-cid').value = callerIds.some((c) => c.number === callerId) ? '' : callerId;
    custom.querySelector('#phone2-cid-save').addEventListener('click', () => {
      const v = custom.querySelector('#phone2-cid').value.trim();
      if (v) { saveCallerId(v); menu.hidden = true; }
    });
  }

  // ---------- contacts ----------
  function initials(name) {
    const p = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '#';
    return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  function contactName(num) {
    const c = contacts.find((x) => (x.number || '').replace(/\D/g, '') === (num || '').replace(/\D/g, ''));
    return c ? c.name : '';
  }
  let contactQuery = '';
  function renderContacts() {
    const list = $('phone2-contacts-list'), empty = $('phone2-contacts-empty');
    if (!list) return;
    const q = contactQuery.trim().toLowerCase();
    const filtered = q
      ? contacts.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.number || '').replace(/\s/g, '').includes(q.replace(/\s/g, '')))
      : contacts;
    list.innerHTML = '';
    if (empty) { empty.hidden = filtered.length > 0; empty.textContent = (q && !filtered.length) ? 'No matches.' : 'No contacts yet.'; }
    filtered.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'ph-row';
      row.innerHTML = '<span class="ph-ava"></span><div class="ph-row-main"><div class="ph-row-nm"></div><div class="ph-row-nu"></div></div><button class="ph-row-call" title="Call">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11 11 0 0 0 3.4.55 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.3a1 1 0 0 1 1 1 11 11 0 0 0 .55 3.4 1 1 0 0 1-.25 1z"/></svg></button>';
      row.querySelector('.ph-ava').textContent = initials(c.name);
      row.querySelector('.ph-row-nm').textContent = c.name;
      row.querySelector('.ph-row-nu').textContent = c.number;
      row.addEventListener('click', () => { $('phone2-number').value = c.number; switchPane('keypad'); });
      row.querySelector('.ph-row-call').addEventListener('click', (e) => { e.stopPropagation(); $('phone2-number').value = c.number; placeCall(); });
      list.appendChild(row);
    });
  }

  // ---------- recents ----------
  function recentsKey() { return 'phone2Recents:' + (cfg ? cfg.user : ''); }
  function loadRecents() { try { return JSON.parse(localStorage.getItem(recentsKey()) || '[]'); } catch (_) { return []; } }
  function addRecent(num, dur) {
    if (!num) return;
    const list = loadRecents();
    list.unshift({ num, name: contactName(num), dur: dur || 0, ts: Date.now() });
    try { localStorage.setItem(recentsKey(), JSON.stringify(list.slice(0, 40))); } catch (_) {}
    renderRecents();
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function fmtDur(d) { return d ? (Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0')) : ''; }
  function renderRecents() {
    const list = $('phone2-recents-list'), empty = $('phone2-recents-empty');
    if (!list) return;
    const items = loadRecents();
    list.innerHTML = '';
    if (empty) empty.hidden = items.length > 0;
    items.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'ph-row';
      row.innerHTML = '<span class="ph-ava out">↗</span><div class="ph-row-main"><div class="ph-row-nm"></div><div class="ph-row-nu"></div></div><button class="ph-row-call" title="Call again">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11 11 0 0 0 3.4.55 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.3a1 1 0 0 1 1 1 11 11 0 0 0 .55 3.4 1 1 0 0 1-.25 1z"/></svg></button>';
      row.querySelector('.ph-row-nm').textContent = r.name || r.num;
      row.querySelector('.ph-row-nu').textContent = (r.name ? r.num + ' · ' : '') + timeAgo(r.ts) + (r.dur ? ' · ' + fmtDur(r.dur) : '');
      row.addEventListener('click', () => { $('phone2-number').value = r.num; switchPane('keypad'); });
      row.querySelector('.ph-row-call').addEventListener('click', (e) => { e.stopPropagation(); $('phone2-number').value = r.num; placeCall(); });
      list.appendChild(row);
    });
  }

  try { setConfig(window.portal.phone2Config ? window.portal.phone2Config() : null); } catch (_) {}
  if (window.portal && window.portal.onPhone2Config) window.portal.onPhone2Config(setConfig);

  // ---------- SIP bring-up (native only) ----------
  async function ensureUA() {
    if (!cfg) return;
    if (nativeStarted) return;
    nativeStarted = true; setStatus('Connecting…');
    try { await window.portal.nativeStart(cfg); } catch (_) { setStatus('Could not start phone'); nativeStarted = false; }
  }
  function teardown() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    stopTap();
    if (nativeStarted) {
      try { window.NativeAudio && window.NativeAudio.stop(); } catch (_) {}
      try { window.portal.nativeStop(); } catch (_) {}
      nativeStarted = false;
    }
    registered = false; inCall = false; setReg(false);
  }

  // ---------- UI state ----------
  function setReg(v) {
    registered = v;
    document.querySelectorAll('.phone2-dot').forEach((d) => {
      d.className = 'phone2-dot' + (v ? ' on' : ''); d.title = v ? 'Ready' : 'Not ready';
    });
    const tx = $('phone2-reg-tx'); if (tx) tx.textContent = v ? 'Ready' : 'Offline';
    if (v) setStatus('Ready');
  }
  function setStatus(t) { const s = $('phone2-status'); if (s) s.textContent = t; }
  // Non-blocking failure banner (NEVER alert() — see note in the event handler).
  let failTimer = null;
  function showFailBanner(msg) {
    let el = document.getElementById('phone2-fail');
    if (!el) {
      el = document.createElement('div');
      el.id = 'phone2-fail';
      el.style.cssText = 'margin:8px 12px 0;padding:9px 11px;background:#fdecea;color:#b3261e;border:1px solid #f5c6cb;border-radius:9px;font-size:11.5px;line-height:1.45;position:relative;';
      const body = panel.querySelector('.ph-body');
      if (body) body.insertBefore(el, body.firstChild);
    }
    el.textContent = msg;
    el.style.display = 'block';
    if (failTimer) clearTimeout(failTimer);
    failTimer = setTimeout(() => { if (el) el.style.display = 'none'; }, 12000);
  }
  function setState(t) { const s = $('phone2-state'); if (s) s.textContent = t; }

  function switchPane(which) {
    if (inCall) return;
    ['keypad', 'contacts', 'recents'].forEach((p) => {
      const pane = $('ph2-pane-' + p); if (pane) pane.hidden = p !== which;
    });
    panel.querySelectorAll('.ph2-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === which));
    const menu = $('phone2-sim-menu'); if (menu) menu.hidden = true;
  }

  function showCall(peer, state) {
    inCall = true; activePeer = peer;
    $('phone2-incall').hidden = false;
    $('phone2-peer').textContent = contactName(peer) || peer || 'Call';
    $('phone2-incall-ava').textContent = contactName(peer) ? initials(contactName(peer)) : '#';
    setState(state);
    const dw = $('phone2-dtmf-wrap'); if (dw) dw.hidden = false;
    const kt = $('phone2-keypad-toggle'); if (kt) kt.classList.add('active');
    paintMute(); paintMini();
  }
  function endCall() {
    const dur = (inCall && callStart) ? Math.floor((Date.now() - callStart) / 1000) : 0;
    if (activePeer) addRecent(activePeer, dur);
    inCall = false; muted = false; activePeer = '';
    stopTap();
    if (window.TopCaptions) window.TopCaptions.callEnded();
    stopTimer();
    $('phone2-incall').hidden = true;
    const d = $('phone2-dtmf'); if (d) d.value = '';
    paintMute(); paintMini();
    setStatus(registered ? 'Ready' : 'Offline');
  }
  function startTimer() {
    if (timerInt) return;
    callStart = Date.now();
    timerInt = setInterval(() => {
      const s = Math.floor((Date.now() - callStart) / 1000);
      const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      $('phone2-timer').textContent = txt;
      const mt = $('phone2-mini-timer'); if (mt) mt.textContent = txt;
    }, 500);
  }
  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    $('phone2-timer').textContent = '00:00';
    const mt = $('phone2-mini-timer'); if (mt) mt.textContent = '00:00';
  }

  function minimize() { panel.hidden = true; $('phone2-mini').hidden = false; paintMini(); }
  function expand() { $('phone2-mini').hidden = true; panel.hidden = false; }
  function paintMini() {
    $('phone2-mini-mute').hidden = !inCall;
    $('phone2-mini-hangup').hidden = !inCall;
    $('phone2-mini-peer').textContent = inCall ? (contactName(activePeer) || activePeer || 'On call') : (cfg && cfg.label || 'Phone 2');
    $('phone2-mini-timer').hidden = !inCall;
  }

  // ---------- actions ----------
  async function placeCall() {
    const num = ($('phone2-number').value || '').replace(/[^\d*#+]/g, '');
    if (!num) return;
    await ensureUA();
    if (!registered) { setStatus('Not ready yet'); return; }
    showCall(num, 'Calling…');
    if (window.TopCaptions) window.TopCaptions.callStarted(8000);
    try { await window.NativeAudio.start(); } catch (_) {}
    if (window.TopCaptions && window.TopCaptions.isEnabled && window.TopCaptions.isEnabled()) startTap();
    try { await window.portal.nativeCall(num); } catch (e) { setStatus('Call failed'); endCall(); }
  }
  function hangup() {
    try { window.portal.nativeHangup(); } catch (_) {}
    try { window.NativeAudio.stop(); } catch (_) {}
    endCall();
  }
  function toggleMute() {
    if (!inCall) return;
    muted = !muted;
    try { window.portal.nativeMute(muted); } catch (_) {}
    paintMute();
  }
  function paintMute() {
    const b = $('phone2-mute');
    if (b) { b.classList.toggle('active', muted); b.querySelector('.ctl-ic').textContent = muted ? '🔇' : '🎙️'; b.querySelector('.ctl-tx').textContent = muted ? 'Muted' : 'Mute'; }
    const m = $('phone2-mini-mute'); if (m) { m.textContent = muted ? '🔇' : '🎙️'; m.classList.toggle('active', muted); }
  }
  let toneTimer = null;
  function flashTone(label) {
    setState(label);
    if (toneTimer) clearTimeout(toneTimer);
    toneTimer = setTimeout(() => { if (inCall) setState('In call'); }, 1100);
  }
  function sendTones(raw) {
    const tones = String(raw || '').replace(/[^0-9*#A-Da-d]/g, '');
    if (!tones || !inCall) return;
    try { window.portal.nativeDtmf(tones); } catch (_) {}
    flashTone(tones.length > 1 ? 'Tones: ' + tones : 'Tone ' + tones);
  }
  function press(k) {
    if (inCall) sendTones(k);
    else $('phone2-number').value += k;
  }
  function sendDtmfString(str) { sendTones(str); }

  // ---------- caption audio tap (native inbound PCM) ----------
  function startTap() {
    wantTap = true;
    try { window.NativeAudio && window.NativeAudio.setPcmTap((i16) => { if (window.TopCaptions) window.TopCaptions.pushExternal(i16); }); } catch (_) {}
  }
  function stopTap() {
    wantTap = false;
    try { window.NativeAudio && window.NativeAudio.setPcmTap(null); } catch (_) {}
  }

  // ---------- wiring ----------
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { $('phone2-mini').hidden = true; ensureUA(); }
  });
  $('phone2-close').addEventListener('click', () => { panel.hidden = true; $('phone2-mini').hidden = true; });
  $('phone2-min-btn').addEventListener('click', minimize);
  $('phone2-mini-expand').addEventListener('click', expand);
  $('phone2-mini-mute').addEventListener('click', toggleMute);
  $('phone2-mini-hangup').addEventListener('click', hangup);
  $('phone2-call').addEventListener('click', placeCall);
  $('phone2-hangup').addEventListener('click', hangup);
  $('phone2-mute').addEventListener('click', toggleMute);
  $('phone2-back').addEventListener('click', () => { const el = $('phone2-number'); el.value = el.value.slice(0, -1); });
  $('phone2-keypad').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) press(b.dataset.k); });
  $('phone2-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); placeCall(); } });

  // Tabs (scoped to this panel)
  panel.querySelectorAll('.ph2-tab').forEach((t) => t.addEventListener('click', () => switchPane(t.dataset.pane)));

  // SIM picker
  $('phone2-sim').addEventListener('click', (e) => { e.stopPropagation(); const m = $('phone2-sim-menu'); if (m) m.hidden = !m.hidden; });
  document.addEventListener('click', (e) => {
    const m = $('phone2-sim-menu');
    if (m && !m.hidden && e.target !== $('phone2-sim') && !$('phone2-sim').contains(e.target) && !m.contains(e.target)) m.hidden = true;
  });

  // In-call keypad toggle + DTMF
  const kpToggle = $('phone2-keypad-toggle');
  if (kpToggle) kpToggle.addEventListener('click', () => { const w = $('phone2-dtmf-wrap'); if (w) w.hidden = !w.hidden; kpToggle.classList.toggle('active', w && !w.hidden); });
  const dtmfPad = $('phone2-dtmf-pad');
  if (dtmfPad) dtmfPad.addEventListener('click', (e) => { const b = e.target.closest('button[data-dt]'); if (b) sendDtmfString(b.dataset.dt); });
  $('phone2-dtmf-send').addEventListener('click', () => { sendDtmfString($('phone2-dtmf').value); $('phone2-dtmf').value = ''; });
  $('phone2-dtmf').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendDtmfString(e.target.value); e.target.value = ''; } });

  // Minimized call bar: draggable, position remembered.
  const mini = $('phone2-mini');
  if (mini) {
    try {
      const p = JSON.parse(localStorage.getItem('phone2MiniPos') || 'null');
      if (p) { mini.style.left = p.left + 'px'; mini.style.top = p.top + 'px'; mini.style.right = 'auto'; mini.style.bottom = 'auto'; }
    } catch (_) {}
    mini.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = mini.getBoundingClientRect();
      mini.style.left = r.left + 'px'; mini.style.top = r.top + 'px'; mini.style.right = 'auto'; mini.style.bottom = 'auto';
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      try { mini.setPointerCapture(e.pointerId); } catch (_) {}
      mini.classList.add('dragging');
      const move = (ev) => {
        mini.style.left = Math.min(Math.max(0, ev.clientX - offX), window.innerWidth - 60) + 'px';
        mini.style.top = Math.min(Math.max(0, ev.clientY - offY), window.innerHeight - 30) + 'px';
      };
      const up = () => {
        mini.classList.remove('dragging');
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        try { const rr = mini.getBoundingClientRect(); localStorage.setItem('phone2MiniPos', JSON.stringify({ left: Math.round(rr.left), top: Math.round(rr.top) })); } catch (_) {}
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }

  // Contacts search
  const search = $('phone2-contact-search');
  if (search) search.addEventListener('input', (e) => { contactQuery = e.target.value; renderContacts(); });

  // Drag the whole phone window by its header (position remembered).
  const head = panel.querySelector('.ph-head');
  if (head) {
    try {
      const p = JSON.parse(localStorage.getItem('phone2PanelPos') || 'null');
      if (p) { panel.classList.add('floating'); panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; }
    } catch (_) {}
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      panel.classList.add('floating');
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      head.classList.add('dragging');
      const move = (ev) => {
        panel.style.left = Math.min(Math.max(0, ev.clientX - offX), window.innerWidth - 60) + 'px';
        panel.style.top = Math.min(Math.max(0, ev.clientY - offY), window.innerHeight - 40) + 'px';
      };
      const up = () => {
        head.classList.remove('dragging');
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        try { const rr = panel.getBoundingClientRect(); localStorage.setItem('phone2PanelPos', JSON.stringify({ left: Math.round(rr.left), top: Math.round(rr.top) })); } catch (_) {}
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }

  // ---------- diagnostics panel (for troubleshooting the trunk) ----------
  (function injectDiag() {
    const headRow = panel.querySelector('.ph-head');
    if (headRow) {
      const b = document.createElement('button');
      b.id = 'phone2-diag-btn'; b.className = 'ph-ic-sm'; b.title = 'Diagnostics'; b.textContent = '🛈';
      headRow.insertBefore(b, panel.querySelector('#phone2-min-btn'));
      b.addEventListener('click', () => {
        const d = document.getElementById('phone2-diag');
        const show = d.style.display === 'none';
        d.style.display = show ? 'flex' : 'none';
        if (show) { document.getElementById('phone2-diag-log').textContent = diag.join('\n') || '(no activity yet — make a test call)'; }
      });
    }
    const wrap = document.createElement('div');
    wrap.id = 'phone2-diag';
    wrap.style.cssText = 'position:absolute;inset:0;background:var(--surface);z-index:12;display:none;flex-direction:column;padding:12px;';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
        '<b style="font-size:13px;">Phone 2 diagnostics <span style="color:var(--muted);font-weight:400;">build ' + PHONE2_BUILD + '</span></b>' +
        '<button id="phone2-diag-close" class="ph-ic-sm" title="Close">✕</button></div>' +
      '<pre id="phone2-diag-log" style="flex:1;overflow:auto;margin:0;padding:8px;background:var(--bg,#0d1117);color:#cbd5e1;border-radius:8px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;"></pre>' +
      '<div style="display:flex;gap:8px;margin-top:8px;">' +
        '<button id="phone2-diag-copy" class="pillbtn" style="flex:1;">Copy log</button>' +
        '<button id="phone2-diag-clear" class="pillbtn">Clear</button></div>';
    panel.querySelector('.ph-body').appendChild(wrap);
    wrap.querySelector('#phone2-diag-close').addEventListener('click', () => { wrap.style.display = 'none'; });
    wrap.querySelector('#phone2-diag-clear').addEventListener('click', () => { diag.length = 0; document.getElementById('phone2-diag-log').textContent = ''; });
    wrap.querySelector('#phone2-diag-copy').addEventListener('click', () => {
      const text = 'Phone 2 build ' + PHONE2_BUILD + '\ncfg: ' + JSON.stringify(cfg ? { server: cfg.server, port: cfg.port, domain: cfg.domain, user: cfg.user, authUser: cfg.authUser, register: cfg.register, stun: cfg.stun } : null) + '\n\n' + diag.join('\n');
      try { navigator.clipboard.writeText(text); } catch (_) {}
      const cb = wrap.querySelector('#phone2-diag-copy'); const old = cb.textContent; cb.textContent = 'Copied ✓'; setTimeout(() => { cb.textContent = old; }, 1200);
    });
  })();

  logDiag('Phone 2 build ' + PHONE2_BUILD + ' loaded');
})();
