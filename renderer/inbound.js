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

  const INBOUND_BUILD = '0.9.35';
  let cfg = null, viewTimer = null, logLines = [];
  let callTimer = null, callStart = 0;
  let muteOn = false, holdOn = false;
  let availActive = false;      // our chosen availability
  let onCall = null;            // { caller, via } while connected
  let lastRoster = [];

  function log(line) {
    logLines.push('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (logLines.length > 300) logLines = logLines.slice(-300);
    const pre = $('inb-logs-pre'); if (pre) pre.textContent = logLines.join('\n');
    try { P.acdLog && P.acdLog(line); } catch (_) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- config ----
  function applyConfig(c) {
    cfg = c && typeof c === 'object' ? c : null;
    if (!cfg) { btn.hidden = true; panel.hidden = true; stopPolling(); return; }
    btn.hidden = false;
    const tx = $('inbound-btn-tx'); if (tx) tx.textContent = cfg.label || 'Support';
    const title = $('inb-title'); if (title) title.textContent = cfg.label || 'Support';
    log('Inbound ' + INBOUND_BUILD + ' configured (ext ' + (cfg.ext || '?') + ' → ' + (cfg.serviceHost || '?') + ':' + (cfg.servicePort || '?') + ')');
    startPolling();
    try { P.inboundStart && P.inboundStart(cfg); } catch (_) {}
  }
  try { applyConfig(P.inboundConfig()); } catch (_) {}
  if (P.onInboundConfig) P.onInboundConfig(applyConfig);

  // ---- panel open/close (✕ and the pill never hang up a call) ----
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refreshView(); });
  $('inb-min').addEventListener('click', () => { panel.hidden = true; });

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

  // ---- single availability toggle ----
  $('inb-toggle').addEventListener('click', async () => {
    const next = availActive ? 'pause' : 'active';
    try { const r = await P.acdSet(next); if (r && r.view) paintView(r.view); } catch (_) {}
    log('availability → ' + next);
  });

  // ---- polling ----
  function startPolling() { stopPolling(); refreshView(); viewTimer = setInterval(refreshView, 2500); }
  function stopPolling() { if (viewTimer) { clearInterval(viewTimer); viewTimer = null; } }
  async function refreshView() { try { const r = await P.acdView(); if (r && r.ok && r.view) paintView(r.view); } catch (_) {} }

  function paintView(v) {
    const st = (v.me && v.me.status) || 'offline';
    availActive = (st === 'active' || st === 'incall');
    const registered = !!(v.me && v.me.registered);

    // toggle look
    const tg = $('inb-toggle'), tx = $('inb-toggle-tx');
    tg.dataset.on = availActive ? '1' : '0';
    tg.classList.toggle('on', availActive);
    tx.textContent = availActive ? 'Active — taking calls' : 'Paused';

    // status pill
    const reg = $('inb-reg');
    if (reg) {
      const label = !registered ? 'offline' : (st === 'incall' ? 'on a call' : (availActive ? 'ready' : 'paused'));
      reg.textContent = label; reg.className = 'inb-reg ' + (registered ? (st === 'incall' ? 'incall' : (availActive ? 'active' : 'paused')) : 'offline');
    }
    const dot = $('inbound-dot'); if (dot) dot.title = registered ? 'Registered' : 'Not registered';

    // queue count + badge
    const qc = (v.queue && v.queue.count) || 0;
    $('inb-qcount').textContent = qc;
    const badge = $('inbound-qbadge');
    if (badge) { if (qc > 0 && !onCall) { badge.textContent = qc; badge.hidden = false; } else badge.hidden = true; }

    lastRoster = v.roster || [];
    paintRoster(lastRoster);

    // reflect a server-known call if the native layer hasn't surfaced it
    if (!onCall && v.call && v.call.state === 'connected') showOnCall({ caller: v.call.caller, via: v.call.name || v.call.did }, v.call.dur || 0);
  }

  function paintRoster(roster) {
    const wrap = $('inb-roster'); if (!wrap) return;
    if (!roster.length) { wrap.innerHTML = '<div class="inb-muted">No one online.</div>'; return; }
    wrap.innerHTML = roster.map((r) =>
      '<div class="inb-ra"><span class="inb-pill ' + r.status + '">' + r.status + '</span>' +
      '<span class="inb-ra-nm">' + esc(r.name) + (r.self ? ' <span class="inb-muted">(you)</span>' : '') + '</span></div>').join('');
  }

  // ---- on-call UI ----
  function setPillOnCall(on) {
    btn.classList.toggle('oncall', on);
    const tx = $('inbound-btn-tx'); if (tx && cfg) tx.textContent = on ? 'On call' : (cfg.label || 'Support');
  }
  function showOnCall(info, startSecs) {
    onCall = info;
    $('inb-call-num').textContent = info.caller || 'Unknown';
    $('inb-call-via').textContent = info.via ? ('on ' + info.via) : 'inbound call';
    $('inb-oncall').hidden = false;
    panel.hidden = false;
    callStart = Date.now() - (startSecs || 0) * 1000;
    startCallTimer();
    setPillOnCall(true);
    const b = $('inbound-qbadge'); if (b) b.hidden = true;
  }
  function hideOnCall() {
    onCall = null; stopCallTimer();
    $('inb-oncall').hidden = true; $('inb-xfer-list').hidden = true;
    holdOn = muteOn = false; paintToggles();
    setPillOnCall(false);
  }
  function startCallTimer() {
    stopCallTimer();
    callTimer = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.now() - callStart) / 1000));
      $('inb-call-timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }
  function stopCallTimer() { if (callTimer) { clearInterval(callTimer); callTimer = null; } }

  // ---- call controls ----
  function bridge(name, ...a) { try { if (P[name]) return P[name](...a); } catch (_) {} log('(' + name + ' unavailable)'); }
  $('inb-end').addEventListener('click', () => { log('end'); bridge('inboundHangup'); });
  $('inb-hold').addEventListener('click', () => { holdOn = !holdOn; bridge('inboundHold', holdOn); paintToggles(); log('hold ' + holdOn); });
  $('inb-mute').addEventListener('click', () => { muteOn = !muteOn; bridge('inboundMute', muteOn); paintToggles(); log('mute ' + muteOn); });
  function paintToggles() {
    $('inb-hold').classList.toggle('on', holdOn);
    $('inb-hold').innerHTML = holdOn ? '▶<span>Resume</span>' : '⏸<span>Hold</span>';
    $('inb-mute').classList.toggle('on', muteOn);
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

  // ---- copy ----
  $('inb-call-copy').addEventListener('click', () => {
    const num = $('inb-call-num').textContent.trim();
    if (num && num !== '—') { try { navigator.clipboard.writeText(num); } catch (_) {} log('copied ' + num); }
  });

  // ---- logs ----
  $('inb-logs-btn').addEventListener('click', () => {
    const l = $('inb-logs'); l.hidden = !l.hidden;
    if (!l.hidden) $('inb-logs-pre').textContent = logLines.join('\n') || '—';
  });

  // ---- native call events ----
  if (P.onInboundEvent) P.onInboundEvent((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'incoming') {
      log('incoming from ' + ev.caller + (ev.via ? ' on ' + ev.via : '') + ' — answering');
      try { P.inboundAnswer && P.inboundAnswer(); } catch (_) {} // auto-answer while active
    } else if (ev.type === 'answered') {
      showOnCall({ caller: ev.caller, via: ev.via }, 0);
      try { window.InboundAudio && window.InboundAudio.start(); } catch (_) {}
      try { if (window.TopCaptions) window.TopCaptions.callStarted(8000); } catch (_) {}
      startCaptionTap();
      log('answered');
    } else if (ev.type === 'ended') {
      try { window.InboundAudio && window.InboundAudio.setPcmTap(null); } catch (_) {}
      try { window.InboundAudio && window.InboundAudio.stop(); } catch (_) {}
      try { if (window.TopCaptions) window.TopCaptions.callEnded(); } catch (_) {}
      hideOnCall();
      log('call ended (' + (ev.reason || '') + ')');
    } else if (ev.type === 'registered') { log('registered to queue service ✓'); }
    else if (ev.type === 'registerFailed') { log('REGISTER FAILED: ' + (ev.reason || '')); }
    else if (ev.type === 'status') { log(ev.text || ''); }
    else if (ev.type === 'debug') { log('· ' + (ev.text || '')); }
  });

  // Feed the inbound audio to the global captions engine; it only transcribes
  // when the global captions button is on (isEnabled()).
  function startCaptionTap() {
    try {
      if (!window.InboundAudio) return;
      window.InboundAudio.setPcmTap((i16) => { if (window.TopCaptions && window.TopCaptions.isEnabled && window.TopCaptions.isEnabled()) window.TopCaptions.pushExternal(i16); });
    } catch (_) {}
  }

  log('Inbound phone script ' + INBOUND_BUILD + ' loaded');
})();
