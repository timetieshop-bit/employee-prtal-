// Softphone over JsSIP (WSS/WebRTC). A real-dialer UI: Keypad / Contacts / Recents
// tabs, caller-ID "SIM" picker under the dial button, fixed-height frame, and an
// in-call overlay. Connection + caller IDs + contacts come from the server. Live
// captions are owned by the unified top-bar control (window.TopCaptions); this
// module just feeds it the call audio when asked.
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('phone-panel');
  const btn = $('phone-btn');
  if (!panel || !btn) return;

  let cfg = null;
  let ua = null, session = null;
  let registered = false, inCall = false;
  let muted = false, held = false;
  let timerInt = null, callStart = 0;
  let building = false;
  let callerId = '';
  let callerIds = [];
  let contacts = [];
  let remoteStream = null;
  let activePeer = '';      // number currently being called
  let wantTap = false;      // captions controller has asked us to capture call audio

  const isNative = () => !!(cfg && cfg.transport === 'udp');
  const hasLib = () => isNative() ? true : (!!(window.JsSIP && window.JsSIP.UA) && !window.__sipMissing);
  const available = () => !!cfg && hasLib();

  // ---- Native (UDP) backend events (kept for the future parallel UDP phone) ----
  if (window.portal && window.portal.onNativeEvent) {
    window.portal.onNativeEvent((m) => {
      if (!isNative()) return;
      switch (m.ev) {
        case 'registered': setReg(true); break;
        case 'registerFailed': setReg(false); setStatus('Register failed' + (m.arg ? ': ' + m.arg : '')); break;
        case 'ringing': setState('Ringing…'); break;
        case 'answered': setState('In call'); startTimer(); break;
        case 'ended': endCall(); break;
        case 'failed': setStatus('Call failed' + (m.arg ? ': ' + m.arg : '')); endCall(); break;
      }
    });
  }

  // ---------- config ----------
  function setConfig(c) {
    const changed = JSON.stringify(c || null) !== JSON.stringify(cfg);
    cfg = c || null;
    if (!cfg) { teardown(); btn.hidden = true; panel.hidden = true; return; }
    btn.hidden = false;
    callerIds = Array.isArray(cfg.callerIds) ? cfg.callerIds : [];
    contacts = Array.isArray(cfg.contacts) ? cfg.contacts : [];
    loadCallerId();
    renderSimMenu();
    renderContacts();
    renderRecents();
    if (changed) { teardown(); ensureUA(); }
  }

  // ---------- caller ID (SIM) ----------
  function cidKey() { return 'phoneCid:' + (cfg ? cfg.user + '@' + cfg.domain : ''); }
  function loadCallerId() {
    let v = '';
    try { v = localStorage.getItem(cidKey()) || ''; } catch (_) {}
    if (callerIds.length) {
      const m = callerIds.find((c) => c.number === v);
      callerId = m ? m.number : callerIds[0].number;
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
    const nm = $('phone-sim-name'), nu = $('phone-sim-num');
    if (nm) nm.textContent = named ? named.label || named.number : (callerId || 'Default');
    if (nu) nu.textContent = named && named.label ? ' · ' + named.number : (named ? '' : '');
  }
  function renderSimMenu() {
    const menu = $('phone-sim-menu');
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
    // Custom entry
    const custom = document.createElement('div');
    custom.className = 'ph-sim-custom';
    custom.innerHTML = '<input id="phone-cid" type="text" inputmode="tel" placeholder="Custom caller ID" autocomplete="off" /><button id="phone-cid-save">Set</button>';
    menu.appendChild(custom);
    custom.querySelector('#phone-cid').value = callerIds.some((c) => c.number === callerId) ? '' : callerId;
    custom.querySelector('#phone-cid-save').addEventListener('click', () => {
      const v = custom.querySelector('#phone-cid').value.trim();
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
  function renderContacts() {
    const list = $('phone-contacts-list'), empty = $('phone-contacts-empty');
    if (!list) return;
    list.innerHTML = '';
    if (empty) empty.hidden = contacts.length > 0;
    contacts.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'ph-row';
      row.innerHTML = '<span class="ph-ava"></span><div class="ph-row-main"><div class="ph-row-nm"></div><div class="ph-row-nu"></div></div><button class="ph-row-call" title="Call">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11 11 0 0 0 3.4.55 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.3a1 1 0 0 1 1 1 11 11 0 0 0 .55 3.4 1 1 0 0 1-.25 1z"/></svg></button>';
      row.querySelector('.ph-ava').textContent = initials(c.name);
      row.querySelector('.ph-row-nm').textContent = c.name;
      row.querySelector('.ph-row-nu').textContent = c.number;
      row.addEventListener('click', () => { $('phone-number').value = c.number; switchPane('keypad'); });
      row.querySelector('.ph-row-call').addEventListener('click', (e) => { e.stopPropagation(); $('phone-number').value = c.number; placeCall(); });
      list.appendChild(row);
    });
  }

  // ---------- recents ----------
  function recentsKey() { return 'phoneRecents:' + (cfg ? cfg.user : ''); }
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
    const list = $('phone-recents-list'), empty = $('phone-recents-empty');
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
      row.addEventListener('click', () => { $('phone-number').value = r.num; switchPane('keypad'); });
      row.querySelector('.ph-row-call').addEventListener('click', (e) => { e.stopPropagation(); $('phone-number').value = r.num; placeCall(); });
      list.appendChild(row);
    });
  }

  try { setConfig(window.portal.phoneConfig ? window.portal.phoneConfig() : null); } catch (_) {}
  if (window.portal && window.portal.onPhoneConfig) window.portal.onPhoneConfig(setConfig);

  // ---------- SIP bring-up ----------
  let nativeStarted = false;
  async function ensureUA() {
    if (isNative()) {
      if (nativeStarted) return;
      nativeStarted = true; setStatus('Connecting…');
      try { await window.portal.nativeStart(cfg); } catch (_) { setStatus('Could not start phone'); nativeStarted = false; }
      return;
    }
    if (ua || building || !cfg) return;
    if (!hasLib() && window.__sipReady) { setStatus('Loading phone…'); try { await window.__sipReady; } catch (_) {} }
    if (!hasLib()) { setStatus(window.__sipMissing ? 'Phone library failed to load' : 'Phone unavailable'); return; }
    building = true;
    try {
      const socket = new window.JsSIP.WebSocketInterface(cfg.ws);
      ua = new window.JsSIP.UA({
        sockets: [socket],
        uri: 'sip:' + cfg.user + '@' + cfg.domain,
        authorization_user: cfg.authUser || cfg.user,
        password: cfg.password,
        display_name: cfg.displayName || cfg.user,
        register: true,
        session_timers: false,
      });
      ua.on('connecting', () => setStatus('Connecting…'));
      ua.on('connected', () => setStatus('Registering…'));
      ua.on('disconnected', () => { setReg(false); setStatus('Reconnecting…'); });
      ua.on('registered', () => setReg(true));
      ua.on('unregistered', () => setReg(false));
      ua.on('registrationFailed', (e) => { setReg(false); setStatus('Register failed' + (e && e.cause ? ': ' + e.cause : '')); });
      ua.on('newRTCSession', (data) => {
        const s = data.session;
        if (s.direction !== 'outgoing') { try { s.terminate(); } catch (_) {} return; }
        const attach = (pc) => {
          try {
            pc.addEventListener('track', (ev) => {
              if (ev.streams && ev.streams[0]) {
                $('sip-remote').srcObject = ev.streams[0];
                remoteStream = ev.streams[0];
                if (wantTap) startWssTap();
              }
            });
          } catch (_) {}
        };
        s.on('peerconnection', (e) => attach(e.peerconnection));
        if (s.connection) attach(s.connection);
      });
      setStatus('Connecting…');
      ua.start();
    } catch (e) { setStatus('Could not start phone'); ua = null; }
    finally { building = false; }
  }
  function teardown() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    stopTap();
    if (window.TopCaptions) window.TopCaptions.callEnded();
    if (nativeStarted) { try { window.NativeAudio && window.NativeAudio.stop(); } catch (_) {} try { window.portal.nativeStop(); } catch (_) {} nativeStarted = false; }
    if (session) { try { session.terminate(); } catch (_) {} session = null; }
    if (ua) { try { ua.stop(); } catch (_) {} ua = null; }
    registered = false; inCall = false; setReg(false);
  }

  // ---------- UI state ----------
  function setReg(v) {
    registered = v;
    // Two dots share the .phone-dot class: the topbar Phone pill and the panel header.
    document.querySelectorAll('.phone-dot').forEach((d) => {
      d.className = 'phone-dot' + (v ? ' on' : ''); d.title = v ? 'Registered' : 'Not registered';
    });
    const tx = $('phone-reg-tx'); if (tx) tx.textContent = v ? 'Ready' : 'Offline';
    if (v) setStatus('Ready');
  }
  function setStatus(t) { const s = $('phone-status'); if (s) s.textContent = t; }
  function setState(t) { const s = $('phone-state'); if (s) s.textContent = t; }

  function switchPane(which) {
    if (inCall) return; // tabs locked during a call
    ['keypad', 'contacts', 'recents'].forEach((p) => {
      const pane = $('ph-pane-' + p); if (pane) pane.hidden = p !== which;
    });
    document.querySelectorAll('.ph-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === which));
    const menu = $('phone-sim-menu'); if (menu) menu.hidden = true;
  }

  function showCall(peer, state) {
    inCall = true; activePeer = peer;
    $('phone-incall').hidden = false;
    $('phone-peer').textContent = contactName(peer) || peer || 'Call';
    $('phone-incall-ava').textContent = contactName(peer) ? initials(contactName(peer)) : '#';
    setState(state);
    // Show the DTMF dialpad by default so IVR tones are one tap away.
    const dw = $('phone-dtmf-wrap'); if (dw) dw.hidden = false;
    const kt = $('phone-keypad-toggle'); if (kt) kt.classList.add('active');
    paintMute(); paintHold(); paintMini();
  }
  function endCall() {
    const dur = (inCall && callStart) ? Math.floor((Date.now() - callStart) / 1000) : 0;
    if (activePeer) addRecent(activePeer, dur);
    inCall = false; muted = false; held = false; session = null; remoteStream = null; activePeer = '';
    stopTap();
    if (window.TopCaptions) window.TopCaptions.callEnded();
    stopTimer();
    $('phone-incall').hidden = true;
    const d = $('phone-dtmf'); if (d) d.value = '';
    paintMute(); paintHold(); paintMini();
    setStatus(registered ? 'Ready' : 'Offline');
  }
  function startTimer() {
    if (timerInt) return;
    callStart = Date.now();
    timerInt = setInterval(() => {
      const s = Math.floor((Date.now() - callStart) / 1000);
      const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      $('phone-timer').textContent = txt;
      const mt = $('phone-mini-timer'); if (mt) mt.textContent = txt;
    }, 500);
  }
  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    $('phone-timer').textContent = '00:00';
    const mt = $('phone-mini-timer'); if (mt) mt.textContent = '00:00';
  }

  function minimize() { panel.hidden = true; $('phone-mini').hidden = false; paintMini(); }
  function expand() { $('phone-mini').hidden = true; panel.hidden = false; }
  function paintMini() {
    $('phone-mini-mute').hidden = !inCall;
    $('phone-mini-hangup').hidden = !inCall;
    $('phone-mini-peer').textContent = inCall ? (contactName(activePeer) || activePeer || 'On call') : 'Phone';
    $('phone-mini-timer').hidden = !inCall;
  }

  // ---------- actions ----------
  async function placeCall() {
    const num = ($('phone-number').value || '').replace(/[^\d*#+]/g, '');
    if (!num) return;
    if (isNative()) {
      await ensureUA();
      if (!registered) { setStatus('Not registered yet'); return; }
      showCall(num, 'Calling…');
      if (window.TopCaptions) window.TopCaptions.callStarted(8000);
      try { await window.NativeAudio.start(); } catch (_) {}
      try { await window.portal.nativeCall(num); } catch (e) { setStatus('Call failed'); endCall(); }
      return;
    }
    if (!ua) await ensureUA();
    if (!ua) { setStatus(available() ? 'Not connected yet' : 'Phone unavailable'); return; }
    if (!registered) { setStatus('Not registered yet'); return; }
    try {
      showCall(num, 'Calling…');
      if (window.TopCaptions) window.TopCaptions.callStarted(16000);
      const extraHeaders = [];
      if (callerId) {
        const cc = callerId.replace(/[^\d+*#]/g, '');
        extraHeaders.push('P-Asserted-Identity: <sip:' + cc + '@' + cfg.domain + '>');
        extraHeaders.push('X-Caller-ID: ' + cc);
      }
      session = ua.call('sip:' + num + '@' + cfg.domain, {
        eventHandlers: {
          progress: () => setState('Ringing…'),
          confirmed: () => { setState('In call'); startTimer(); },
          ended: () => endCall(),
          failed: (e) => { setStatus('Call failed' + (e && e.cause ? ': ' + e.cause : '')); endCall(); },
        },
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: cfg.iceServers || [] },
        extraHeaders,
      });
    } catch (e) { setStatus('Call failed'); endCall(); }
  }
  function hangup() {
    if (isNative()) { try { window.portal.nativeHangup(); } catch (_) {} try { window.NativeAudio.stop(); } catch (_) {} endCall(); return; }
    if (session) { try { session.terminate(); } catch (_) {} }
    endCall();
  }
  function toggleMute() {
    if (!inCall) return;
    muted = !muted;
    if (isNative()) { try { window.portal.nativeMute(muted); } catch (_) {} }
    else if (session) { try { muted ? session.mute({ audio: true }) : session.unmute({ audio: true }); } catch (_) {} }
    paintMute();
  }
  function paintMute() {
    const b = $('phone-mute');
    if (b) { b.classList.toggle('active', muted); b.querySelector('.ctl-ic').textContent = muted ? '🔇' : '🎙️'; b.querySelector('.ctl-tx').textContent = muted ? 'Muted' : 'Mute'; }
    const m = $('phone-mini-mute'); if (m) { m.textContent = muted ? '🔇' : '🎙️'; m.classList.toggle('active', muted); }
  }
  function toggleHold() {
    if (!session || !inCall || isNative()) return;
    held = !held;
    try { held ? session.hold() : session.unhold(); } catch (_) {}
    paintHold();
  }
  function paintHold() {
    const b = $('phone-hold'); if (!b) return;
    b.classList.toggle('active', held);
    b.querySelector('.ctl-ic').textContent = held ? '▶️' : '⏸';
    b.querySelector('.ctl-tx').textContent = held ? 'Resume' : 'Hold';
  }
  function press(k) {
    if (inCall) {
      if (isNative()) { try { window.portal.nativeDtmf(k); } catch (_) {} }
      else if (session) { try { session.sendDTMF(k); } catch (_) {} }
    } else { $('phone-number').value += k; }
  }
  function sendDtmfString(str) {
    const tones = String(str || '').replace(/[^0-9*#A-Da-d]/g, '');
    if (!tones || !inCall) return;
    if (isNative()) { try { window.portal.nativeDtmf(tones); } catch (_) {} }
    else if (session) { try { session.sendDTMF(tones); } catch (_) {} }
  }

  // ---------- caption audio tap (driven by window.TopCaptions) ----------
  let capCtx = null, capSrc = null, capProc = null;
  function f32ToPcm16(f32, inRate, outRate) {
    const ratio = inRate / outRate, outLen = Math.floor(f32.length / ratio), out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) { const s = Math.max(-1, Math.min(1, f32[Math.floor(i * ratio)] || 0)); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }
  function startWssTap() {
    if (!remoteStream || capCtx) return;
    try {
      capCtx = new (window.AudioContext || window.webkitAudioContext)();
      capSrc = capCtx.createMediaStreamSource(remoteStream);
      capProc = capCtx.createScriptProcessor(4096, 1, 1);
      const inRate = capCtx.sampleRate;
      capProc.onaudioprocess = (e) => { if (window.TopCaptions) window.TopCaptions.pushExternal(f32ToPcm16(e.inputBuffer.getChannelData(0), inRate, 16000)); };
      capSrc.connect(capProc); capProc.connect(capCtx.destination);
    } catch (_) {}
  }
  function startTap() {
    wantTap = true;
    if (isNative()) { try { window.NativeAudio && window.NativeAudio.setPcmTap((i16) => { if (window.TopCaptions) window.TopCaptions.pushExternal(i16); }); } catch (_) {} }
    else startWssTap();
  }
  function stopTap() {
    wantTap = false;
    try { window.NativeAudio && window.NativeAudio.setPcmTap(null); } catch (_) {}
    try { capProc && capProc.disconnect(); } catch (_) {} capProc = null;
    try { capSrc && capSrc.disconnect(); } catch (_) {} capSrc = null;
    try { capCtx && capCtx.close(); } catch (_) {} capCtx = null;
  }
  // Let the unified caption controller start/stop our audio capture on demand.
  if (window.TopCaptions && window.TopCaptions.registerPhone) {
    window.TopCaptions.registerPhone({ startTap, stopTap });
  }

  // ---------- wiring ----------
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { $('phone-mini').hidden = true; ensureUA(); }
  });
  $('phone-close').addEventListener('click', () => { panel.hidden = true; $('phone-mini').hidden = true; });
  $('phone-min-btn').addEventListener('click', minimize);
  $('phone-mini-expand').addEventListener('click', expand);
  $('phone-mini-mute').addEventListener('click', toggleMute);
  $('phone-mini-hangup').addEventListener('click', hangup);
  $('phone-call').addEventListener('click', placeCall);
  $('phone-hangup').addEventListener('click', hangup);
  $('phone-mute').addEventListener('click', toggleMute);
  $('phone-hold').addEventListener('click', toggleHold);
  $('phone-back').addEventListener('click', () => { const el = $('phone-number'); el.value = el.value.slice(0, -1); });
  $('phone-keypad').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) press(b.dataset.k); });
  $('phone-number').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); placeCall(); } });

  // Tabs
  document.querySelectorAll('.ph-tab').forEach((t) => t.addEventListener('click', () => switchPane(t.dataset.pane)));

  // SIM picker
  $('phone-sim').addEventListener('click', (e) => { e.stopPropagation(); const m = $('phone-sim-menu'); if (m) m.hidden = !m.hidden; });
  document.addEventListener('click', (e) => {
    const m = $('phone-sim-menu');
    if (m && !m.hidden && e.target !== $('phone-sim') && !$('phone-sim').contains(e.target) && !m.contains(e.target)) m.hidden = true;
  });

  // In-call keypad toggle + DTMF
  const kpToggle = $('phone-keypad-toggle');
  if (kpToggle) kpToggle.addEventListener('click', () => { const w = $('phone-dtmf-wrap'); if (w) w.hidden = !w.hidden; kpToggle.classList.toggle('active', w && !w.hidden); });
  // Dialpad: each tap sends that one tone immediately (one by one).
  const dtmfPad = $('phone-dtmf-pad');
  if (dtmfPad) dtmfPad.addEventListener('click', (e) => { const b = e.target.closest('button[data-dt]'); if (b) sendDtmfString(b.dataset.dt); });
  $('phone-dtmf-send').addEventListener('click', () => { sendDtmfString($('phone-dtmf').value); $('phone-dtmf').value = ''; });
  $('phone-dtmf').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendDtmfString(e.target.value); e.target.value = ''; } });
})();
