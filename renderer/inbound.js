// ===========================================================================
// Inbound ACD phone (the third phone). Compact, draggable, captions-capable.
// No keypad or contacts — inbound only. Availability (active/pause), live queue
// count, agent roster, caller display + copy, hold/mute/transfer/end.
//
// Server presence/queue come from acd_agent.php (polled via the main process).
// The live call itself is handled by the native inbound SIP stack and surfaced
// through window.portal.onInbound* events; where those aren't present yet the
// UI still reflects the server's view of the agent's current call.
// ===========================================================================
(function inbound() {
  const P = window.portal;
  if (!P || !P.inboundConfig) return;
  const $ = (id) => document.getElementById(id);

  const btn    = $('inbound-btn');
  const panel  = $('inbound-panel');
  if (!btn || !panel) return;

  const INBOUND_BUILD = '0.9.34';
  let cfg = null;
  let viewTimer = null;
  let logLines = [];
  let callTimer = null, callStart = 0;
  let ccOn = false, muteOn = false, holdOn = false;
  let ringing = null;   // { caller, via } while a call is ringing at this agent
  let onCall = null;    // { caller, via } while connected
  let lastRoster = [];

  function log(line) {
    const ts = new Date().toLocaleTimeString();
    logLines.push('[' + ts + '] ' + line);
    if (logLines.length > 300) logLines = logLines.slice(-300);
    const pre = $('inb-logs-pre'); if (pre) pre.textContent = logLines.join('\n');
    try { P.acdLog && P.acdLog(line); } catch (_) {}
  }

  // ---- config gating ----
  function applyConfig(c) {
    cfg = c && typeof c === 'object' ? c : null;
    if (!cfg) { btn.hidden = true; panel.hidden = true; stopPolling(); return; }
    btn.hidden = false;
    const tx = $('inbound-btn-tx'); if (tx) tx.textContent = cfg.label || 'Support';
    const title = $('inb-title'); if (title) title.textContent = cfg.label || 'Support';
    log('Inbound phone ' + INBOUND_BUILD + ' configured (ext ' + (cfg.ext || '?') + ', service ' + (cfg.serviceHost || '?') + ':' + (cfg.servicePort || '?') + ')');
    startPolling();
    // Ask the native layer (if present) to register this agent to the queue service.
    try { P.inboundStart && P.inboundStart(cfg); } catch (_) {}
  }
  try { applyConfig(P.inboundConfig()); } catch (_) {}
  if (P.onInboundConfig) P.onInboundConfig(applyConfig);

  // ---- panel open/close + dragging ----
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refreshView(); });
  $('inb-min').addEventListener('click', () => { panel.hidden = true; });

  (function drag() {
    const head = $('inb-drag'); if (!head) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.inb-ic')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(4, Math.min(window.innerWidth - 80, nx));
      ny = Math.max(4, Math.min(window.innerHeight - 60, ny));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ---- availability ----
  async function setAvail(action) {
    try { const r = await P.acdSet(action); if (r && r.view) paintView(r.view); } catch (_) {}
    log('availability → ' + action);
  }
  $('inb-active').addEventListener('click', () => setAvail('active'));
  $('inb-pause').addEventListener('click', () => setAvail('pause'));

  // ---- polling the server view (presence, queue, roster, my call) ----
  function startPolling() {
    stopPolling();
    refreshView();
    viewTimer = setInterval(refreshView, 2500);
  }
  function stopPolling() { if (viewTimer) { clearInterval(viewTimer); viewTimer = null; } }

  async function refreshView() {
    try { const r = await P.acdView(); if (r && r.ok && r.view) paintView(r.view); } catch (_) {}
  }

  function paintView(v) {
    // availability buttons
    const st = (v.me && v.me.status) || 'offline';
    $('inb-active').classList.toggle('on', st === 'active');
    $('inb-pause').classList.toggle('on', st === 'paused');
    const reg = $('inb-reg');
    if (reg) {
      reg.textContent = (v.me && v.me.registered) ? (st === 'incall' ? 'on a call' : (st === 'paused' ? 'paused' : 'ready')) : 'offline';
      reg.className = 'inb-reg ' + st;
    }
    const dot = $('inbound-dot'); if (dot) dot.title = (v.me && v.me.registered) ? 'Registered' : 'Not registered';

    // queue count
    const qc = (v.queue && v.queue.count) || 0;
    $('inb-qcount').textContent = qc;
    const badge = $('inbound-qbadge');
    if (badge) { if (qc > 0) { badge.textContent = qc; badge.hidden = false; } else badge.hidden = true; }

    // roster
    lastRoster = v.roster || [];
    paintRoster(lastRoster);

    // Reflect the server's view of my current call only if the native layer
    // hasn't already taken over the display (native events win).
    if (!ringing && !onCall && v.call) {
      if (v.call.state === 'connected') showOnCall({ caller: v.call.caller, via: v.call.name || v.call.did }, v.call.dur || 0);
      else if (v.call.state === 'ringing') showIncoming({ caller: v.call.caller, via: v.call.name || v.call.did });
    }
    if ((!v.call) && !ringingFromNative && !onCallFromNative) { hideIncoming(); if (!onCallFromNative) hideOnCall(); }
  }

  function paintRoster(roster) {
    const wrap = $('inb-roster'); if (!wrap) return;
    const others = roster;
    if (!others.length) { wrap.innerHTML = '<div class="inb-muted">No one online.</div>'; return; }
    wrap.innerHTML = others.map((r) =>
      '<div class="inb-ra"><span class="inb-pill ' + r.status + '">' + r.status + '</span>' +
      '<span class="inb-ra-nm">' + escapeHtml(r.name) + (r.self ? ' <span class="inb-muted">(you)</span>' : '') + '</span></div>'
    ).join('');
  }

  // ---- incoming / on-call UI ----
  function showIncoming(info) {
    ringing = info;
    $('inb-ring-num').textContent = info.caller || 'Unknown';
    $('inb-ring-via').textContent = info.via ? ('on ' + info.via) : '';
    $('inb-incoming').hidden = false;
    $('inb-oncall').hidden = true;
    panel.hidden = false;
    playRing(true);
  }
  function hideIncoming() { ringing = null; $('inb-incoming').hidden = true; playRing(false); }

  function showOnCall(info, startSecs) {
    onCall = info;
    hideIncoming();
    $('inb-call-num').textContent = info.caller || 'Unknown';
    $('inb-call-via').textContent = info.via ? ('on ' + info.via) : '';
    $('inb-oncall').hidden = false;
    panel.hidden = false;
    callStart = Date.now() - (startSecs || 0) * 1000;
    startCallTimer();
  }
  function hideOnCall() {
    onCall = null; stopCallTimer();
    $('inb-oncall').hidden = true;
    $('inb-xfer-list').hidden = true;
    holdOn = muteOn = false; paintToggles();
  }

  function startCallTimer() {
    stopCallTimer();
    callTimer = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.now() - callStart) / 1000));
      $('inb-call-timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }
  function stopCallTimer() { if (callTimer) { clearInterval(callTimer); callTimer = null; } }

  // ---- ringtone (WebAudio; no asset needed) ----
  let ac = null, ringOsc = null, ringGain = null, ringInt = null;
  function playRing(on) {
    try {
      if (on) {
        if (ringInt) return;
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        const beat = () => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.frequency.value = 480; o.type = 'sine';
          g.gain.setValueAtTime(0.0001, ac.currentTime);
          g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.9);
          o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 1);
        };
        beat(); ringInt = setInterval(beat, 2000);
      } else if (ringInt) { clearInterval(ringInt); ringInt = null; }
    } catch (_) {}
  }

  // ---- call controls (native layer; guarded until wired) ----
  function callBridge(name, ...args) {
    try { if (P[name]) return P[name](...args); } catch (_) {}
    log('(' + name + ' not available yet)');
    return null;
  }
  $('inb-answer').addEventListener('click', () => { log('answer'); callBridge('inboundAnswer'); });
  $('inb-reject').addEventListener('click', () => { log('reject'); callBridge('inboundReject'); hideIncoming(); });
  $('inb-end').addEventListener('click', () => { log('end'); callBridge('inboundHangup'); });
  $('inb-hold').addEventListener('click', () => { holdOn = !holdOn; callBridge('inboundHold', holdOn); paintToggles(); log('hold ' + holdOn); });
  $('inb-mute').addEventListener('click', () => { muteOn = !muteOn; callBridge('inboundMute', muteOn); paintToggles(); log('mute ' + muteOn); });

  function paintToggles() {
    $('inb-hold').classList.toggle('on', holdOn);
    $('inb-hold').textContent = holdOn ? '▶ Resume' : '⏸ Hold';
    $('inb-mute').classList.toggle('on', muteOn);
  }

  // ---- transfer ----
  $('inb-xfer').addEventListener('click', () => {
    const list = $('inb-xfer-list');
    if (!list.hidden) { list.hidden = true; return; }
    const targets = lastRoster.filter((r) => !r.self && r.status === 'active');
    list.innerHTML = targets.length
      ? targets.map((r) => '<button class="inb-xfer-t" data-uid="' + r.user_id + '">' + escapeHtml(r.name) + '</button>').join('')
      : '<div class="inb-muted" style="padding:6px 8px">No available agents to transfer to.</div>';
    list.hidden = false;
  });
  $('inb-xfer-list').addEventListener('click', (e) => {
    const b = e.target.closest('.inb-xfer-t'); if (!b) return;
    const uid = Number(b.dataset.uid);
    log('transfer → user ' + uid);
    callBridge('inboundTransfer', uid);
    $('inb-xfer-list').hidden = true;
  });

  // ---- copy caller number ----
  function copyNum(id) {
    const t = $(id); if (!t) return;
    const num = t.textContent.trim();
    if (!num || num === '—') return;
    try { navigator.clipboard.writeText(num); } catch (_) {}
    log('copied caller ' + num);
  }
  $('inb-ring-copy').addEventListener('click', () => copyNum('inb-ring-num'));
  $('inb-call-copy').addEventListener('click', () => copyNum('inb-call-num'));

  // ---- captions + logs toggles ----
  $('inb-cc').addEventListener('click', () => {
    ccOn = !ccOn;
    $('inb-cc').setAttribute('aria-pressed', ccOn ? 'true' : 'false');
    $('inb-cc').classList.toggle('on', ccOn);
    applyCaptionTap();
    log('captions ' + ccOn);
  });
  // Feed the inbound call audio to the shared captions engine while enabled.
  function applyCaptionTap() {
    try {
      if (!window.InboundAudio) return;
      if (ccOn && onCallFromNative) window.InboundAudio.setPcmTap((i16) => { if (window.TopCaptions) window.TopCaptions.pushExternal(i16); });
      else window.InboundAudio.setPcmTap(null);
    } catch (_) {}
  }
  $('inb-logs-btn').addEventListener('click', () => {
    const l = $('inb-logs'); l.hidden = !l.hidden;
    if (!l.hidden) $('inb-logs-pre').textContent = logLines.join('\n') || '—';
  });

  // ---- native call events (lit up by the inbound SIP stack in the next phase) ----
  let ringingFromNative = false, onCallFromNative = false;
  if (P.onInboundEvent) P.onInboundEvent((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'incoming') { ringingFromNative = true; showIncoming({ caller: ev.caller, via: ev.via }); log('INVITE from ' + ev.caller + (ev.via ? ' on ' + ev.via : '')); }
    else if (ev.type === 'answered') {
      ringingFromNative = false; onCallFromNative = true; showOnCall({ caller: ev.caller, via: ev.via }, 0);
      try { window.InboundAudio && window.InboundAudio.start(); } catch (_) {}
      try { if (window.TopCaptions) window.TopCaptions.callStarted(8000); } catch (_) {}
      applyCaptionTap();
      log('answered');
    }
    else if (ev.type === 'ended') {
      ringingFromNative = false; onCallFromNative = false; hideOnCall(); hideIncoming();
      try { window.InboundAudio && window.InboundAudio.setPcmTap(null); } catch (_) {}
      try { window.InboundAudio && window.InboundAudio.stop(); } catch (_) {}
      try { if (window.TopCaptions) window.TopCaptions.callEnded(); } catch (_) {}
      log('call ended (' + (ev.reason || '') + ')');
    }
    else if (ev.type === 'registered') { log('registered to queue service'); }
    else if (ev.type === 'registerFailed') { log('register FAILED: ' + (ev.reason || '')); }
    else if (ev.type === 'status') { log(ev.text || ''); }
    else if (ev.type === 'debug') { log('· ' + (ev.text || '')); }
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  log('Inbound phone script ' + INBOUND_BUILD + ' loaded');
})();
