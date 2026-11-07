// camera.js — webcam monitoring in the portal renderer.
// Takes periodic snapshots and runs on-device detection (phone, away-from-desk,
// multiple people, covered face). Flagged frames + periodic frames are sent to
// the server via window.portal.cameraEvent(). Everything degrades gracefully:
// if the camera or the ML model can't load, the portal keeps working.

(() => {
  const TF_URL    = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
  const COCO_URL  = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';
  const BLAZE_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.js';

  const state = {
    running: false,
    stream: null,
    video: null,
    model: null,       // coco-ssd (objects / people / phone)
    faceModel: null,   // blazeface (face presence)
    detTimer: null,
    periodicTimer: null,
    cfg: {},
    lastFlag: {},        // reason -> last report time (ms)
    absentSince: 0,
    coveredSince: 0,
    modelLoading: false,
  };

  const FLAG_COOLDOWN_MS = 60 * 1000; // don't report the same flag more than once a minute
  const SUSTAIN_MS = 15 * 1000;       // absence / covered face must persist this long

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function loadModel() {
    if (!state.cfg.detection) return; // AI processing is off — snapshots only
    if (state.model || state.modelLoading) return;
    state.modelLoading = true;
    try {
      if (!window.tf) await loadScript(TF_URL);
      if (!window.cocoSsd) await loadScript(COCO_URL);
      state.model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
      // BlazeFace is only loaded when the "covered face" check is enabled (it's
      // a second model — loading it always wastes memory/CPU on weak machines).
      if (state.cfg.facecovered) {
        try {
          if (!window.blazeface) await loadScript(BLAZE_URL);
          state.faceModel = await window.blazeface.load();
        } catch (_) { state.faceModel = null; }
      }
    } catch (_) {
      state.model = null; // detection unavailable; periodic snapshots still run
    } finally {
      state.modelLoading = false;
      indicator(state.running); // refresh the "AI on/off" status
    }
  }

  function indicator(on) {
    const el = document.getElementById('cam-indicator');
    if (!el) return;
    el.hidden = !on;
    if (on) {
      const det = state.cfg && state.cfg.detection;
      const ai = !det ? ' · AI off'
        : state.model ? ' · AI on' : (state.modelLoading ? ' · AI loading…' : ' · AI off');
      el.textContent = '● Camera on' + ai;
    }
  }

  function videoReady() {
    return state.video && state.video.videoWidth > 0 && state.video.readyState >= 2;
  }
  function waitForVideo(v) {
    return new Promise((resolve) => {
      if (v.videoWidth > 0) return resolve();
      const done = () => { v.removeEventListener('loadeddata', done); resolve(); };
      v.addEventListener('loadeddata', done);
      setTimeout(resolve, 5000); // fail-safe
    });
  }

  function captureDataUrl(w, h) {
    const v = state.video;
    if (!videoReady()) return '';
    const c = document.createElement('canvas');
    c.width = w || v.videoWidth; c.height = h || v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    try { return c.toDataURL('image/jpeg', 0.6); } catch (_) { return ''; }
  }

  function report(reason) {
    const shot = captureDataUrl();
    // Don't send an empty periodic frame (that's what produced "no image" cards).
    if (!shot && reason === 'periodic') return;
    if (window.portal && window.portal.cameraEvent) window.portal.cameraEvent(reason, shot);
  }

  function flag(reason) {
    const now = Date.now();
    if (state.lastFlag[reason] && now - state.lastFlag[reason] < FLAG_COOLDOWN_MS) return;
    state.lastFlag[reason] = now;
    report(reason);
  }

  // Reusable small canvas — detecting on a downscaled frame is much faster.
  let detCanvas = null;
  function detectInput() {
    const v = state.video;
    const w = 320, h = Math.round(w * ((v.videoHeight / v.videoWidth) || 0.75));
    if (!detCanvas) detCanvas = document.createElement('canvas');
    detCanvas.width = w; detCanvas.height = h;
    detCanvas.getContext('2d').drawImage(v, 0, 0, w, h);
    return detCanvas;
  }

  async function detectTick() {
    if (!state.running || !state.model || !videoReady()) return;
    const input = detectInput();
    let preds = [];
    try { preds = await state.model.detect(input, 20); } catch (_) { return; }

    const persons = preds.filter((p) => p.class === 'person' && p.score > 0.45).length;
    const phone = preds.some((p) => p.class === 'cell phone' && p.score > 0.3);
    const now = Date.now();

    if (state.cfg.phone && phone) flag('phone');
    if (state.cfg.multi && persons > 1) flag('multiple_people');

    if (state.cfg.absence) {
      if (persons === 0) {
        state.absentSince = state.absentSince || now;
        if (now - state.absentSince > SUSTAIN_MS) flag('absent');
      } else { state.absentSince = 0; }
    }

    // Face covered = a person is present but no face is detected for a while.
    if (state.cfg.facecovered && state.faceModel && persons >= 1) {
      let faces = [];
      try { faces = await state.faceModel.estimateFaces(input, false); } catch (_) { faces = [{}]; }
      if (faces.length === 0) {
        state.coveredSince = state.coveredSince || now;
        if (now - state.coveredSince > SUSTAIN_MS) flag('face_covered');
      } else { state.coveredSince = 0; }
    }
  }

  function startTimers() {
    clearTimers();
    const periodMs = Math.max(5, state.cfg.intervalMin || 60) * 60 * 1000;
    state.periodicTimer = setInterval(() => report('periodic'), periodMs);
    report('periodic'); // one snapshot at the start of the session
    if (state.cfg.detection) scheduleDetect(1500); // skip the AI loop entirely when off
  }
  // Self-scheduling detection loop that BACKS OFF when inference is slow, so a
  // weak laptop never freezes typing with a detection every few seconds.
  function scheduleDetect(delay) {
    if (!state.running) return;
    state.detTimer = setTimeout(runDetect, delay);
  }
  async function runDetect() {
    if (!state.running) return;
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    try { await detectTick(); } catch (_) {}
    const dt = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
    const everyMs = Math.max(3000, (state.cfg.everySec || 12) * 1000);
    scheduleDetect(Math.max(everyMs, dt * 4)); // never sooner than 4x the detect time
  }
  function clearTimers() {
    if (state.detTimer) clearTimeout(state.detTimer);
    if (state.periodicTimer) clearInterval(state.periodicTimer);
    state.detTimer = state.periodicTimer = null;
  }

  async function start(cfg) {
    state.cfg = cfg;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: false,
      });
    } catch (_) {
      state.stream = null; // camera blocked/unavailable — nothing we can do
      return;
    }
    const v = document.getElementById('cam-video') || document.createElement('video');
    v.id = 'cam-video'; v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.display = 'none';
    if (!v.parentNode) document.body.appendChild(v);
    v.srcObject = state.stream;
    state.video = v;
    try { await v.play(); } catch (_) {}
    await waitForVideo(v);     // don't start capturing until the camera is live
    state.running = true;
    indicator(true);
    loadModel();
    startTimers();
  }

  function stop() {
    state.running = false;
    clearTimers();
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    indicator(false);
  }

  // Public API — called from app.js with the server-controlled feature flags.
  window.cameraMonitor = {
    apply(f) {
      const cfg = {
        enabled: f.cameraMonitor === true,
        detection: f.camDetection !== false, // AI processing master switch
        intervalMin: Number(f.cameraIntervalMin) || 60,
        everySec: Number(f.cameraDetectEverySec) || 12,
        phone: f.camDetectPhone !== false,
        absence: f.camDetectAbsence !== false,
        multi: f.camDetectMulti !== false,
        facecovered: f.camDetectFaceCovered !== false,
      };
      if (!cfg.enabled) { if (state.running) stop(); return; }
      if (!state.running) { start(cfg); }
      else { state.cfg = cfg; startTimers(); } // live-apply interval/detection changes
    },
    stop,
  };
})();
