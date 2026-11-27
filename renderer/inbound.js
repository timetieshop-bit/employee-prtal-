// ===========================================================================
// Inbound ACD phone (third phone). Compact, draggable. Single Active/Pause
// toggle. While Active, a routed call auto-answers. Closing the panel (✕) or
// minimizing never drops a live call — the Support pill shows an on-call badge
// until the agent ends it. Captions use the global captions button only.
// ===========================================================================
(function inbound() {
  const P = window.portal;
  if (!P || !P.inboundConfig) return;
  const $ = (id) => document.getElementById(id);

  const btn   = $('inbound-btn');
  const panel = $('inbound-panel');
  if (!btn || !panel) return;

  const INBOUND_BUILD = '0.9.67';
  let cfg = null, viewTimer = null, logLines = [];
  let sessionStart = Date.now();   // recents show only calls since the phone was turned on this session
  let desiredAvail = null, lastAssert = 0; // the agent's chosen availability, re-asserted if the server drifts
  let callTimer = null, callStart = 0;
  let muteOn = false, holdOn = false;
  let availActive = false;      // our chosen availability
  let powered = false;          // phone off until the agent turns it on
  let onCall = null;            // { caller, via } while connected
  let endedAt = 0;              // when the last call ended (guards re-show)
  let lastRoster = [];

  function log(line) {
    logLines.push('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (logLines.length > 300) logLines = logLines.slice(-300);
    const pre = $('inb-logs-pre'); if (pre) pre.textContent = logLines.join('\n');
    try { P.acdLog && P.acdLog(line); } catch (_) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- recent inbound calls (per-agent, kept locally) ----
  function recentsKey() { return 'inbRecents:' + (cfg && cfg.ext ? cfg.ext : 'x'); }
  function loadRecents() { try { return JSON.parse(localStorage.getItem(recentsKey()) || '[]'); } catch (_) { return []; } }
  function saveRecents(a) { try { localStorage.setItem(recentsKey(), JSON.stringify(a.slice(0, 25))); } catch (_) {} }
  function recordRecent(info, dur) {
    const a = loadRecents();
    a.unshift({ caller: info.caller || 'Unknown', via: info.via || '', t: Date.now(), dur: Math.max(0, Math.round(dur || 0)) });
    saveRecents(a);
    if ($('inb-recent') && !$('inb-recent').hidden) renderRecents();
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function fmtDur(d) { return d ? (Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0')) : '—'; }
  function renderRecents() {
    const el = $('inb-recent-list'); if (!el) return;
    const a = loadRecents().filter((r) => (r.t || 0) >= sessionStart); // this session only
    if (!a.length) { el.innerHTML = '<div class="inb-muted">No calls yet.</div>'; return; }
    el.innerHTML = a.map((r) =>
      '<div class="inb-rec"><span class="inb-rec-ic">↙</span>' +
      '<span class="inb-rec-main"><span class="inb-rec-num">' + esc(r.caller) + '</span>' +
      '<span class="inb-rec-sub">' + (r.via ? esc(r.via) + ' · ' : '') + timeAgo(r.t) + '</span></span>' +
      '<button class="inb-rec-copy" data-num="' + esc(r.caller) + '" title="Copy">⧉</button>' +
      '<span class="inb-rec-dur">' + fmtDur(r.dur) + '</span></div>').join('');
  }

  // ---- config ---- (the phone starts OFF; the agent turns it on to take calls)
  function applyConfig(c) {
    cfg = c && typeof c === 'object' ? c : null;
    if (!cfg) { btn.hidden = true; panel.hidden = true; powerOff(); stopPolling(); return; }
    btn.hidden = false;
    const tx = $('inbound-btn-tx'); if (tx && !onCall) tx.textContent = cfg.label || 'Support';
    const title = $('inb-title'); if (title) title.textContent = cfg.label || 'Support';
    const logo = $('inb-logo'); if (logo) logo.textContent = (cfg.label || 'S').trim().charAt(0).toUpperCase();
    log('Inbound ' + INBOUND_BUILD + ' configured (ext ' + (cfg.ext || '?') + ' → ' + (cfg.serviceHost || '?') + ':' + (cfg.servicePort || '?') + ')');
    if (!powered) {
      // Restore the phone's power across a reload/crash so an agent who was online
      // comes straight back online (then powerOn restores their Active/Pause choice),
      // instead of silently dropping to OFF and missing calls. A fresh install has
      // nothing saved, so it stays OFF until the agent turns it on.
      let wasOn = false;
      try { wasOn = localStorage.getItem('inb-power') === 'on'; } catch (_) {}
      if (wasOn) powerOn(); else showOffState();
    }
  }
  try { applyConfig(P.inboundConfig()); } catch (_) {}
  if (P.onInboundConfig) P.onInboundConfig(applyConfig);

  // ---- power on / off ----
  function reflectPower() {
    const sw = $('inb-power'); if (!sw) return;
    sw.classList.toggle('on', powered);
    const t = sw.querySelector('.inb-switch-txt'); if (t) t.textContent = powered ? 'ON' : 'OFF';
  }
  function showOffState() {
    panel.classList.add('off');
    btn.classList.remove('live', 'oncall');
    const reg = $('inb-reg'); if (reg) { reg.textContent = 'off'; reg.className = 'inb-reg'; }
    reflectPower();
  }
  function powerOn() {
    if (!cfg || powered) return;
    powered = true;
    try { localStorage.setItem('inb-power', 'on'); } catch (_) {} // survive a reload/crash
    sessionStart = Date.now();   // fresh "recent calls (this session)" from now
    panel.classList.remove('off');
    reflectPower();
    log('phone turned ON');
    try { P.inboundStart && P.inboundStart(cfg); } catch (_) {}
    startPolling();
    // Restore the agent's last availability rather than always forcing Pause. A
    // renderer reload (crash recovery, Win11 hiccup, etc.) re-runs powerOn, and
    // blindly pausing here silently knocked a mid-shift Active agent off the queue
    // without them touching anything. First-ever load has nothing saved, so a
    // freshly-logged-in agent still starts Paused (never auto-activated by surprise).
    let startAvail = 'pause';
    try { const v = localStorage.getItem('inb-avail'); if (v === 'active' || v === 'pause') startAvail = v; } catch (_) {}
    setAvail(startAvail);
  }
  function powerOff() {
    if (!powered) { showOffState(); return; }
    powered = false; desiredAvail = null; // stop re-asserting availability once off
    try { localStorage.setItem('inb-power', 'off'); } catch (_) {} // deliberate off — stay off after a reload
    if (onCall) { bridge('inboundHangup'); endCallLocal('phone off'); }
    try { P.acdSet && P.acdSet('pause'); } catch (_) {}
    try { P.inboundStop && P.inboundStop(); } catch (_) {}
    stopPolling(); stopQueueBeep();
    showOffState();
    reflectPower();
    const badge = $('inbound-qbadge'); if (badge) badge.hidden = true;
    setPillOnCall(false);
    log('phone turned OFF');
  }
  $('inb-on-btn').addEventListener('click', powerOn);
  $('inb-power').addEventListener('click', () => { powered ? powerOff() : powerOn(); });
  // Turn the phone off when the agent logs out / the portal exits.
  if (P.onLogout) P.onLogout(() => powerOff());
  window.addEventListener('beforeunload', () => { try { if (powered) P.inboundStop && P.inboundStop(); } catch (_) {} });

  // ---- panel open/close/minimize (never hangs up a call) ----
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refreshView(); });
  $('inb-close').addEventListener('click', () => { panel.hidden = true; });
  $('inb-collapse').addEventListener('click', () => {
    const c = panel.classList.toggle('collapsed');
    $('inb-collapse').textContent = c ? '▣' : '–';
    $('inb-collapse').title = c ? 'Expand' : 'Minimize';
  });
  $('inb-recent-btn').addEventListener('click', () => {
    const r = $('inb-recent'); const show = r.hidden;
    r.hidden = !show; if (show) renderRecents();
    $('inb-recent-btn').classList.toggle('on', show);
  });

  (function drag() {
    const head = $('inb-drag'); if (!head) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.inb-ic')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = Math.max(4, Math.min(window.innerWidth - 80, ox + (e.clientX - sx)));
      let ny = Math.max(4, Math.min(window.innerHeight - 60, oy + (e.clientY - sy)));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ---- availability: segmented Active / Pause ----
  async function setAvail(next) {
    // Remember the agent's intent so a lost/slow request can't silently flip them
    // (the "auto-pause"): paintView re-asserts this if the server drifts.
    desiredAvail = next; lastAssert = Date.now();
    try { localStorage.setItem('inb-avail', next); } catch (_) {} // remember across reloads
    // Reflect the choice immediately so the toggle never looks "stuck" while the
    // server round-trip is in flight; polling reconciles with the real state.
    availActive = (next === 'active');
    const a = $('inb-active'), p = $('inb-pause');
    if (a) a.classList.toggle('on', availActive);
    if (p) p.classList.toggle('on', !availActive);
    try { const r = await P.acdSet(next); if (r && r.view) paintView(r.view); } catch (_) {}
    log('availability → ' + next);
  }
  $('inb-active').addEventListener('click', () => setAvail('active'));
  $('inb-pause').addEventListener('click', () => setAvail('pause'));

  // ---- polling ----
  function startPolling() { stopPolling(); refreshView(); viewTimer = setInterval(refreshView, 2500); }
  function stopPolling() { if (viewTimer) { clearInterval(viewTimer); viewTimer = null; } }
  async function refreshView() { try { const r = await P.acdView(); if (r && r.ok && r.view) paintView(r.view); } catch (_) {} }

  function paintView(v) {
    const st = (v.me && v.me.status) || 'offline';
    const registered = !!(v.me && v.me.registered);
    // Honour the agent's chosen availability. If they chose Active/Pause but the
    // server still reports the opposite (a prior request was lost or slow), keep
    // showing their intent and quietly re-send it, instead of flipping the phone
    // on its own — this is what used to look like the phone "auto-pausing".
    if (powered && registered && desiredAvail && st !== 'incall') {
      const wantActive = (desiredAvail === 'active');
      availActive = wantActive;
      if ((st === 'active') !== wantActive && Date.now() - lastAssert > 3000) {
        lastAssert = Date.now();
        try { P.acdSet(desiredAvail).catch(function () {}); } catch (_) {}
      }
    } else {
      availActive = (st === 'active' || st === 'incall');
    }

    // segmented control look
    $('inb-active').classList.toggle('on', availActive);
    $('inb-pause').classList.toggle('on', !availActive);

    // status pill
    const reg = $('inb-reg');
    if (reg) {
      const label = !registered ? 'offline' : (st === 'incall' ? 'on a call' : (availActive ? 'ready' : 'paused'));
      reg.textContent = label; reg.className = 'inb-reg ' + (registered ? (st === 'incall' ? 'incall' : (availActive ? 'active' : 'paused')) : 'offline');
    }
    const dot = $('inbound-dot'); if (dot) dot.title = registered ? 'Registered' : 'Not registered';
    // Topbar green light only when the phone is on AND registered.
    btn.classList.toggle('live', powered && registered);

    // queue count + waving red bubble
    const qc = (v.queue && v.queue.count) || 0;
    $('inb-qcount').textContent = qc;
    const bubble = $('inb-qbubble'); if (bubble) bubble.classList.toggle('has', qc > 0);
    const qlabel = $('inb-qlabel'); if (qlabel) qlabel.textContent = qc > 0 ? (qc === 1 ? 'call waiting' : 'calls waiting') : 'no one waiting';
    const badge = $('inbound-qbadge');
    if (badge) {
      if (qc > 0) { badge.textContent = qc; badge.hidden = false; badge.classList.toggle('urgent', st === 'incall'); }
      else { badge.hidden = true; badge.classList.remove('urgent'); }
    }
    // Alert rules: paused + waiting → beep; in-call + waiting → red count only;
    // active + idle → the call auto-connects, no alert.
    if (qc > 0 && st === 'paused') startQueueBeep(); else stopQueueBeep();
    const ocw = $('inb-oc-wait');
    if (ocw) { if (onCall && qc > 0) { ocw.textContent = qc + ' waiting in queue'; ocw.hidden = false; } else ocw.hidden = true; }

    lastRoster = v.roster || [];
    paintRoster(lastRoster);

    // Follow the server's call state so a hang-up the phone missed still clears
    // it, and a connected call the phone missed still shows — with a short guard
    // so it can't immediately re-appear right after we end one.
    const serverConnected = !!(v.call && v.call.state === 'connected');
    if (onCall && !serverConnected && (Date.now() - callStart > 4000)) endCallLocal('remote hang-up');
    else if (!onCall && serverConnected && (Date.now() - endedAt > 5000)) showOnCall({ caller: v.call.caller, via: v.call.name || v.call.did }, v.call.dur || 0);
  }

  // ---- queue beep (paused + calls waiting) ----
  let beepCtx = null, beepTimer = null;
  function startQueueBeep() {
    if (beepTimer) return;
    const ding = () => {
      try {
        beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (beepCtx.state === 'suspended') { try { beepCtx.resume(); } catch (_) {} }
        const o = beepCtx.createOscillator(), g = beepCtx.createGain();
        o.frequency.value = 880; o.type = 'triangle'; // richer = louder than a sine
        const t0 = beepCtx.currentTime;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02);
        g.gain.setValueAtTime(0.85, t0 + 0.18);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        o.connect(g); g.connect(beepCtx.destination); o.start(); o.stop(t0 + 0.52);
      } catch (_) {}
    };
    ding(); beepTimer = setInterval(ding, 5000);
  }
  function stopQueueBeep() { if (beepTimer) { clearInterval(beepTimer); beepTimer = null; } }

  function paintRoster(roster) {
    const wrap = $('inb-roster'); if (!wrap) return;
    if (!roster.length) { wrap.innerHTML = '<div class="inb-muted">No one online.</div>'; return; }
    const meta = (s) => s === 'active' ? { cls: 'active', label: 'Active', pulse: true }
      : s === 'incall' ? { cls: 'incall', label: 'On call', pulse: true }
      : s === 'paused' ? { cls: 'paused', label: 'Paused', pulse: false }
      : { cls: 'offline', label: 'Offline', pulse: false };
    wrap.innerHTML = roster.map((r) => {
      const m = meta(r.status);
      return '<div class="inb-ra">' +
        '<span class="inb-ra-nm">' + esc(r.name) + (r.self ? ' <span class="inb-muted">(you)</span>' : '') + '</span>' +
        '<span class="inb-stat ' + m.cls + '"><span class="inb-stat-dot' + (m.pulse ? ' pulse' : '') + '"></span>' + m.label + '</span>' +
        '</div>';
    }).join('');
  }

  // ---- on-call UI ----
  function setPillOnCall(on) {
    btn.classList.toggle('oncall', on);
    const tx = $('inbound-btn-tx'); if (tx && cfg) tx.textContent = on ? 'On call' : (cfg.label || 'Support');
  }
  function showOnCall(info, startSecs) {
    onCall = info;
    $('inb-call-num').textContent = info.caller || 'Unknown';
    $('inb-call-via').textContent = info.via ? (' · on ' + info.via) : '';
    $('inb-oncall').hidden = false;
    panel.classList.add('oncall'); // hides the segmented control + body (CSS)
    panel.hidden = false;
    callStart = Date.now() - (startSecs || 0) * 1000;
    startCallTimer();
    setPillOnCall(true);
  }
  function hideOnCall() {
    onCall = null; stopCallTimer(); endedAt = Date.now();
    $('inb-oncall').hidden = true; $('inb-xfer-list').hidden = true;
    panel.classList.remove('oncall');
    holdOn = muteOn = false; paintToggles();
    setPillOnCall(false);
  }
  // Fully end the call on the phone side (recent entry, audio, captions, UI).
  // Safe to call more than once; subsequent calls no-op.
  function endCallLocal(reason) {
    if (!onCall && $('inb-oncall').hidden) return;
    if (onCall) recordRecent(onCall, (Date.now() - callStart) / 1000);
    try { window.InboundAudio && window.InboundAudio.setPcmTap(null); } catch (_) {}
    try { window.InboundAudio && window.InboundAudio.stop(); } catch (_) {}
    try { if (window.TopCaptions) window.TopCaptions.callEnded(inbCapTap); } catch (_) {}
    hideOnCall();
    log('call ended (' + (reason || '') + ')');
  }
  function startCallTimer() {
    stopCallTimer();
    callTimer = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.now() - callStart) / 1000));
      $('inb-call-timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }
  function stopCallTimer() { if (callTimer) { clearInterval(callTimer); callTimer = null; } }

  // Soft two-note "connected" chime so the agent notices an auto-answered call.
  function playConnectTone() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') { try { ac.resume(); } catch (_) {} }
      const notes = [[660, 0], [880, 0.14]];
      notes.forEach(([f, t]) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = f; o.type = 'triangle'; // richer = louder than a sine
        const s = ac.currentTime + t;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.85, s + 0.02);
        g.gain.setValueAtTime(0.85, s + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.28);
        o.connect(g); g.connect(ac.destination); o.start(s); o.stop(s + 0.3);
      });
      setTimeout(() => { try { ac.close(); } catch (_) {} }, 600);
    } catch (_) {}
  }

  // ---- call controls ----
  function bridge(name, ...a) { try { if (P[name]) return P[name](...a); } catch (_) {} log('(' + name + ' unavailable)'); }
  $('inb-end').addEventListener('click', () => { log('end'); bridge('inboundHangup'); endCallLocal('hangup'); });
  $('inb-hold').addEventListener('click', () => { holdOn = !holdOn; bridge('inboundHold', holdOn); paintToggles(); log('hold ' + holdOn); });
  $('inb-mute').addEventListener('click', () => { muteOn = !muteOn; bridge('inboundMute', muteOn); paintToggles(); log('mute ' + muteOn); });
  function paintToggles() {
    $('inb-hold').classList.toggle('on', holdOn);
    $('inb-hold').innerHTML = holdOn ? '▶<span>Resume</span>' : '⏸<span>Hold</span>';
    $('inb-mute').classList.toggle('on', muteOn);
    $('inb-mute').innerHTML = muteOn ? '🔇<span>Unmute</span>' : '🎙<span>Mute</span>';
    // Unmistakable status under the timer: On hold · Muted / On hold / Muted.
    const st = $('inb-call-state');
    if (st) {
      const parts = [];
      if (holdOn) parts.push('On hold');
      if (muteOn) parts.push('Muted');
      if (parts.length) {
        st.textContent = parts.join(' · ');
        st.className = 'inb-call-state' + (holdOn ? ' is-hold' : ' is-mute');
        st.hidden = false;
      } else { st.hidden = true; }
    }
    // Tint the whole call card so it's obvious at a glance which mode it's in.
    const oc = $('inb-oncall');
    if (oc) { oc.classList.toggle('hold', holdOn); oc.classList.toggle('mute', muteOn && !holdOn); }
  }

  // ---- transfer ----
  $('inb-xfer').addEventListener('click', () => {
    const list = $('inb-xfer-list');
    if (!list.hidden) { list.hidden = true; return; }
    const targets = lastRoster.filter((r) => !r.self && r.status === 'active');
    list.innerHTML = targets.length
      ? targets.map((r) => '<button class="inb-xfer-t" data-uid="' + r.user_id + '">' + esc(r.name) + '</button>').join('')
      : '<div class="inb-muted" style="padding:6px 8px">No available agents.</div>';
    list.hidden = false;
  });
  $('inb-xfer-list').addEventListener('click', (e) => {
    const b = e.target.closest('.inb-xfer-t'); if (!b) return;
    log('transfer → user ' + b.dataset.uid); bridge('inboundTransfer', Number(b.dataset.uid)); $('inb-xfer-list').hidden = true;
  });

  // ---- copy (active call + recents) ----
  function doCopy(text) {
    if (!text) return;
    if (P.copyText) P.copyText(text); else { try { navigator.clipboard.writeText(text); } catch (_) {} }
  }
  $('inb-call-copy').addEventListener('click', () => {
    const num = $('inb-call-num').textContent.trim();
    if (num && num !== '—') { doCopy(num); log('copied ' + num); }
  });
  $('inb-recent-list').addEventListener('click', (e) => {
    const b = e.target.closest('.inb-rec-copy'); if (!b) return;
    doCopy(b.dataset.num);
    b.textContent = '✓'; setTimeout(() => { b.textContent = '⧉'; }, 1200);
  });

  // ---- transient toast inside the phone ----
  let toastTimer = null;
  function toast(text) {
    const el = $('inb-toast'); if (!el) return;
    el.textContent = text; el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 220); }, 3200);
  }

  // ---- native call events ----
  if (P.onInboundEvent) P.onInboundEvent((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'incoming') {
      log('incoming from ' + ev.caller + (ev.via ? ' on ' + ev.via : '') + ' — answering');
      try { P.inboundAnswer && P.inboundAnswer(); } catch (_) {} // auto-answer while active
    } else if (ev.type === 'answered') {
      showOnCall({ caller: ev.caller, via: ev.via }, 0);
      playConnectTone(); // notify the agent a call just auto-connected
      try { window.InboundAudio && window.InboundAudio.start(); } catch (_) {}
      try { if (window.TopCaptions) window.TopCaptions.callStarted(8000, inbCapTap); } catch (_) {}
      log('answered');
    } else if (ev.type === 'ended') {
      if (ev.reason === 'customer-hangup') toast('Customer hung up the call');
      endCallLocal(ev.reason === 'customer-hangup' ? 'customer hung up' : (ev.reason || 'ended'));
    } else if (ev.type === 'registered') { log('registered to queue service ✓'); }
    else if (ev.type === 'registerFailed') { log('REGISTER FAILED: ' + (ev.text || ev.reason || '')); }
    else if (ev.type === 'status') { log(ev.text || ''); }
    else if (ev.type === 'debug') { log('· ' + (ev.text || '')); }
  });

  // This call's caption tap — the unified controller starts/stops it when the
  // inbound call is the one that owns captions (newest live call wins), so it
  // coexists with an outbound consultation call without either clobbering the other.
  const inbCapTap = {
    start: () => { try { window.InboundAudio && window.InboundAudio.setPcmTap((i16) => { if (window.TopCaptions) window.TopCaptions.pushExternal(i16); }); } catch (_) {} },
    stop:  () => { try { window.InboundAudio && window.InboundAudio.setPcmTap(null); } catch (_) {} },
  };

  log('Inbound phone script ' + INBOUND_BUILD + ' loaded');
})();
