// ===========================================================================
// Training / screen-share — runs inside the employee portal.
//   • Admin side (inside the "Live agents" panel): tick several online agents,
//     press "Share my screen" to broadcast this portal window to them, and talk
//     two-way. Viewing an individual agent's screen is the existing 👁 View.
//   • Agent side (everyone): when an admin shares with me, a live overlay shows
//     the trainer's screen and I can hear/talk to them.
// Screen frames and audio chunks relay over HTTP through the main process.
// ===========================================================================
(function train() {
  if (!window.portal || !window.portal.trainPoll) return;
  const $ = (id) => document.getElementById(id);

  // ---- base64 <-> bytes ----
  function b64(u8) { let s = ''; const C = 0x8000; for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C)); return btoa(s); }
  function unb64(str) { const bin = atob(str); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

  // ---- G.711 µ-law codec ----
  function linToUlaw(sample) {
    const BIAS = 0x84, CLIP = 32635;
    let sign = (sample >> 8) & 0x80; if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP; sample += BIAS;
    let exp = 7; for (let m = 0x4000; (sample & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const mant = (sample >> (exp + 3)) & 0x0f;
    return (~(sign | (exp << 4) | mant)) & 0xff;
  }
  function ulawToLin(u) {
    u = ~u & 0xff;
    const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
    let s = ((mant << 3) + 0x84) << exp; s -= 0x84;
    return sign ? -s : s;
  }

  // ---- shared audio engine (one mic + one output; mixes multiple talkers) ----
  const audio = (function () {
    let ctx = null, stream = null, src = null, proc = null, onChunk = null, muted = false, running = false;
    const nextAt = {}; // from_user -> next scheduled playout time (for mixing)

    function to8kUlaw(inp, rate) {
      const ratio = rate / 8000;
      const outLen = Math.max(0, Math.floor(inp.length / ratio));
      const out = new Uint8Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const a = Math.floor(i * ratio), b = Math.floor((i + 1) * ratio);
        let sum = 0, n = 0; for (let j = a; j < b && j < inp.length; j++) { sum += inp[j]; n++; }
        let s = (n ? sum / n : 0) * 32767; if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        out[i] = linToUlaw(s | 0);
      }
      return out;
    }
    async function start(cb) {
      if (running) { onChunk = cb; return true; }
      onChunk = cb;
      try { ctx = new AudioContext({ sampleRate: 8000 }); } catch (_) { try { ctx = new AudioContext(); } catch (e) { return false; } }
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        src = ctx.createMediaStreamSource(stream);
        proc = ctx.createScriptProcessor(1024, 1, 1); // ~128ms chunks @ 8k
        proc.onaudioprocess = (e) => {
          if (!onChunk || muted) return;
          const u = to8kUlaw(e.inputBuffer.getChannelData(0), ctx.sampleRate);
          if (u.length) { try { onChunk(b64(u)); } catch (_) {} }
        };
        src.connect(proc); proc.connect(ctx.destination); // output stays silent (we never write it)
        running = true;
        return true;
      } catch (_) { return false; }
    }
    function play(fromId, u8) {
      if (!ctx || !u8 || !u8.length) return;
      const buf = ctx.createBuffer(1, u8.length, 8000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < u8.length; i++) ch[i] = ulawToLin(u8[i]) / 32768;
      const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
      const now = ctx.currentTime;
      let t = nextAt[fromId] || 0;
      if (t < now + 0.04) t = now + 0.04;      // small lead; we fell behind → catch up
      if (t > now + 0.7) t = now + 0.1;        // too far ahead → resync, cap latency
      try { s.start(t); } catch (_) {}
      nextAt[fromId] = t + buf.duration;
    }
    function setMuted(m) { muted = !!m; }
    function stop() {
      running = false; onChunk = null;
      try { if (proc) { proc.disconnect(); proc.onaudioprocess = null; } } catch (_) {}
      try { if (src) src.disconnect(); } catch (_) {}
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (ctx) ctx.close(); } catch (_) {}
      ctx = stream = src = proc = null;
      for (const k in nextAt) delete nextAt[k];
    }
    return { start, play, setMuted, stop, isRunning: () => running };
  })();

  // A tiny audio-pull loop shared by both roles: pulls chunks for `adminId` and
  // plays them (trainer hears agents; agents hear trainer). Returns a stop fn.
  function startAudioPull(adminId) {
    let since = 0, stopped = false, busy = false;
    const tick = async () => {
      if (stopped || busy) return; busy = true;
      try {
        const r = await window.portal.trainAudioGet(adminId, since);
        if (r && Array.isArray(r.chunks)) {
          for (const c of r.chunks) audio.play(c.from, unb64(c.b64));
          if (typeof r.last === 'number' && r.last > since) since = r.last;
        }
      } catch (_) {} finally { busy = false; }
    };
    const timer = setInterval(tick, 250);
    return () => { stopped = true; clearInterval(timer); };
  }

  // =========================================================================
  // ADMIN SIDE — share my screen with the selected agents
  // =========================================================================
  (function admin() {
    const bar = $('tr-bar'), selAll = $('tr-selall'), shareBtn = $('tr-share');
    const live = $('tr-live'), liveN = $('tr-live-n'), micBtn = $('tr-mic'), stopBtn = $('tr-stop');
    if (!shareBtn || !live) return;

    let sharing = false, adminId = 0, stopPull = null, micOn = true, setTargetsTimer = null;
    const selected = new Set(); // survives the list's periodic re-render

    function selectedUids() { return Array.from(selected); }
    function pushTargets() { if (sharing) { clearTimeout(setTargetsTimer); setTargetsTimer = setTimeout(() => window.portal.trainSetTargets(selectedUids()).catch(() => {}), 300); } }
    function refreshBar() {
      // Re-apply the remembered selection to freshly-rendered rows.
      document.querySelectorAll('.sv-sel').forEach((b) => { b.checked = selected.has(parseInt(b.dataset.uid, 10)); });
      const n = selected.size;
      shareBtn.disabled = sharing || n === 0;
      shareBtn.textContent = n ? ('▶ Share my screen (' + n + ')') : '▶ Share my screen';
      const boxes = Array.from(document.querySelectorAll('.sv-sel'));
      if (selAll) selAll.checked = boxes.length > 0 && boxes.every((b) => selected.has(parseInt(b.dataset.uid, 10)));
    }
    // Called by supervise.js after it (re)renders the list.
    window.__trainOnList = refreshBar;

    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('sv-sel')) {
        const uid = parseInt(t.dataset.uid, 10);
        if (t.checked) selected.add(uid); else selected.delete(uid);
        refreshBar(); pushTargets();
      }
    });
    if (selAll) selAll.addEventListener('change', () => {
      const on = selAll.checked;
      document.querySelectorAll('.sv-sel').forEach((b) => { const uid = parseInt(b.dataset.uid, 10); if (on) selected.add(uid); else selected.delete(uid); });
      refreshBar(); pushTargets();
    });

    async function startShare() {
      const uids = selectedUids();
      if (!uids.length || sharing) return;
      shareBtn.disabled = true;
      let r = null; try { r = await window.portal.trainStart(uids); } catch (_) {}
      if (!r || r.ok === false) { shareBtn.disabled = false; return; }
      adminId = r.admin_id || 0;
      sharing = true; micOn = true;
      if (bar) bar.hidden = true; live.hidden = false;
      updateCount(uids.length);
      // audio: talk to agents + hear them
      await audio.start((chunk) => { if (adminId) window.portal.trainAudioPost(adminId, chunk).catch(() => {}); });
      audio.setMuted(false); setMicBtn();
      if (adminId) stopPull = startAudioPull(adminId);
    }
    async function stopShare() {
      sharing = false;
      if (stopPull) { stopPull(); stopPull = null; }
      audio.stop();
      try { await window.portal.trainStop(); } catch (_) {}
      live.hidden = true; if (bar) bar.hidden = false;
      adminId = 0; refreshBar();
    }
    function updateCount(n) { if (liveN) liveN.textContent = String(n); }
    function setMicBtn() { if (micBtn) { micBtn.textContent = micOn ? '🎙️ Mic on' : '🔇 Mic off'; micBtn.classList.toggle('off', !micOn); } }

    shareBtn.addEventListener('click', startShare);
    stopBtn.addEventListener('click', stopShare);
    if (micBtn) micBtn.addEventListener('click', () => { micOn = !micOn; audio.setMuted(!micOn); setMicBtn(); });

    // Keep the live count in step with the current selection while sharing.
    setInterval(() => { if (sharing) updateCount(selectedUids().length); }, 2000);
    refreshBar();
  })();

  // =========================================================================
  // AGENT SIDE — overlay shown while an admin shares their screen with me
  // =========================================================================
  (function agent() {
    const ov = $('tr-overlay'), img = $('tr-ov-img'), who = $('tr-ov-who'), empty = $('tr-ov-empty');
    const micBtn = $('tr-ov-mic'), minBtn = $('tr-ov-min'), restore = $('tr-ov-restore'), box = ov && ov.querySelector('.tr-ov-box');
    if (!ov || !img) return;

    let active = false, adminId = 0, framePull = null, stopPull = null, gotFrame = false, micOn = true, pulling = false;

    async function pullFrame() {
      if (!active || pulling) return; pulling = true;
      try {
        const r = await window.portal.trainFrame(adminId);
        if (r && r.status === 200 && r.dataUrl) { img.src = r.dataUrl; gotFrame = true; img.style.display = 'block'; if (empty) empty.style.display = 'none'; }
      } catch (_) {} finally { pulling = false; }
    }
    function setMicBtn() { if (micBtn) { micBtn.textContent = micOn ? '🎙️ Mic on' : '🔇 Mic off'; micBtn.classList.toggle('off', !micOn); } }

    async function begin(id, trainer) {
      if (active) return;
      active = true; adminId = id; gotFrame = false; micOn = true;
      if (who) who.textContent = trainer || 'Trainer';
      img.removeAttribute('src'); img.style.display = 'none'; if (empty) empty.style.display = 'flex';
      ov.hidden = false; if (restore) restore.hidden = true; if (box) box.style.display = '';
      pullFrame(); framePull = setInterval(pullFrame, 500);
      await audio.start((chunk) => { if (adminId) window.portal.trainAudioPost(adminId, chunk).catch(() => {}); });
      audio.setMuted(false); setMicBtn();
      stopPull = startAudioPull(adminId);
    }
    function end() {
      active = false; adminId = 0;
      if (framePull) { clearInterval(framePull); framePull = null; }
      if (stopPull) { stopPull(); stopPull = null; }
      audio.stop();
      ov.hidden = true; if (restore) restore.hidden = true;
      img.removeAttribute('src');
    }

    if (micBtn) micBtn.addEventListener('click', () => { micOn = !micOn; audio.setMuted(!micOn); setMicBtn(); });
    if (minBtn) minBtn.addEventListener('click', () => { if (box) box.style.display = 'none'; if (restore) restore.hidden = false; });
    if (restore) restore.addEventListener('click', () => { if (box) box.style.display = ''; restore.hidden = true; });

    // Poll: am I being trained right now?
    async function poll() {
      let r = null; try { r = await window.portal.trainPoll(); } catch (_) {}
      if (r && r.training && r.admin_id) {
        if (!active) begin(r.admin_id, r.trainer);
        else if (r.admin_id !== adminId) { end(); begin(r.admin_id, r.trainer); }
      } else if (active) { end(); }
    }
    setInterval(poll, 2500);
    setTimeout(poll, 1500);
  })();
})();
