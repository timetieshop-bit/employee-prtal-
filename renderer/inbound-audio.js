// Renderer audio bridge for the inbound ACD phone (third phone). Independent of
// NativeAudio (Phone 2) so an inbound call has its own mic capture + speaker
// path. Mic frames (Int16 @8k) go to the main process (→ RTP to the queue
// service); decoded RTP audio from the service plays back here.
window.InboundAudio = (function () {
  let ctx = null, micNode = null, spkNode = null, micStream = null, micSource = null, started = false;
  let nsNode = null;              // noise-gate worklet (ns-gate) in the mic chain
  let pcmTap = null;              // optional tap on the caller PCM for live captions
  let micDeviceId = '';           // chosen mic (empty = system default)
  let suppression = 0;            // background-noise suppression 0..10
  let levelCb = null;             // mic-level meter callback (0..1)
  // Idle mic test (settings panel open, no call): own tiny capture for the meter.
  let monCtx = null, monStream = null, monSrc = null, monAn = null, monRAF = 0;

  // Live knobs — a change applies immediately when a call is up, else it's just
  // remembered for the next call (start() reads both).
  function setDevice(id) {
    id = id || '';
    const changed = id !== micDeviceId;
    micDeviceId = id;
    if (changed && started) { stop(); start(); } // re-open capture on the new device
  }
  function setSuppression(n) {
    suppression = Math.max(0, Math.min(10, parseInt(n, 10) || 0));
    if (nsNode) { try { nsNode.port.postMessage({ strength: suppression }); } catch (_) {} }
  }
  function onLevel(fn) { levelCb = fn || null; }
  function micConstraints() {
    const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (micDeviceId) a.deviceId = { exact: micDeviceId };
    return { audio: a };
  }
  async function enumerateMics() {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      // Labels are blank until mic permission is granted — unlock once, then retry.
      if (!list.some((d) => d.kind === 'audioinput' && d.label)) {
        try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch (_) {}
        list = await navigator.mediaDevices.enumerateDevices();
      }
      return list.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
    } catch (_) { return []; }
  }

  if (window.portal && window.portal.onInboundAudio) {
    window.portal.onInboundAudio((buf) => {
      try {
        const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf.buffer || buf);
        const pcm = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
        if (pcmTap) { try { pcmTap(pcm.slice()); } catch (_) {} }
        if (!spkNode) return;
        const copy = pcm.slice();
        spkNode.port.postMessage(copy, [copy.buffer]);
      } catch (_) {}
    });
  }

  async function start() {
    if (started) return true;
    try {
      // Run the whole pipeline at 8 kHz so the browser's high-quality resampler
      // does the mic downsample (device rate → 8k) with proper anti-aliasing,
      // instead of our naive one. This removes the grainy distortion on the
      // agent→customer path. Falls back to the default rate if 8k isn't allowed
      // (the worklets still resample, now with a box low-pass).
      try { ctx = new AudioContext({ sampleRate: 8000 }); }
      catch (_) { ctx = new AudioContext(); }
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule('vendor/spk-worklet.js');
      await ctx.audioWorklet.addModule('vendor/mic-worklet.js');
      try { await ctx.audioWorklet.addModule('vendor/ns-worklet.js'); } catch (_) {}
      spkNode = new AudioWorkletNode(ctx, 'spk-8k', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      spkNode.connect(ctx.destination);
      micStream = await navigator.mediaDevices.getUserMedia(micConstraints());
      micSource = ctx.createMediaStreamSource(micStream);
      micNode = new AudioWorkletNode(ctx, 'mic-8k', { numberOfInputs: 1, numberOfOutputs: 0 });
      micNode.port.onmessage = (e) => {
        const f = e.data;
        try { window.portal.inboundMic(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)); } catch (_) {}
      };
      // Insert the noise-gate between the mic and the resampler (strength 0 = clean
      // bypass). It also drives the mic-level meter in the settings panel.
      try {
        nsNode = new AudioWorkletNode(ctx, 'ns-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        nsNode.port.postMessage({ strength: suppression });
        nsNode.port.onmessage = (e) => { if (levelCb && e.data && typeof e.data.level === 'number') levelCb(e.data.level); };
        micSource.connect(nsNode); nsNode.connect(micNode);
      } catch (_) { nsNode = null; micSource.connect(micNode); } // fall back to the direct chain
      started = true;
      return true;
    } catch (e) { stop(); return false; }
  }

  function stop() {
    started = false;
    try { micSource && micSource.disconnect(); } catch (_) {}
    try { nsNode && nsNode.disconnect(); } catch (_) {}
    try { micNode && micNode.disconnect(); } catch (_) {}
    try { spkNode && spkNode.disconnect(); } catch (_) {}
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ctx && ctx.close(); } catch (_) {}
    ctx = null; micNode = null; nsNode = null; spkNode = null; micStream = null; micSource = null;
  }

  // Idle preview for the settings panel: open the chosen mic on its own and feed a
  // simple level meter, so the agent can see the mic working and pick the right one
  // without being on a call. Does NOT touch the call/RTP path.
  async function monitorStart(deviceId) {
    monitorStop();
    try {
      const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      if (deviceId) a.deviceId = { exact: deviceId };
      monStream = await navigator.mediaDevices.getUserMedia({ audio: a });
      monCtx = new AudioContext();
      if (monCtx.state === 'suspended') await monCtx.resume();
      monSrc = monCtx.createMediaStreamSource(monStream);
      monAn = monCtx.createAnalyser(); monAn.fftSize = 512;
      monSrc.connect(monAn);
      const buf = new Uint8Array(monAn.fftSize);
      const tick = () => {
        if (!monAn) return;
        monAn.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v; }
        if (levelCb) levelCb(peak);
        monRAF = requestAnimationFrame(tick);
      };
      tick();
      return true;
    } catch (_) { monitorStop(); return false; }
  }
  function monitorStop() {
    if (monRAF) { cancelAnimationFrame(monRAF); monRAF = 0; }
    try { monSrc && monSrc.disconnect(); } catch (_) {}
    try { monStream && monStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { monCtx && monCtx.close(); } catch (_) {}
    monCtx = null; monStream = null; monSrc = null; monAn = null;
    if (levelCb) levelCb(0);
  }

  return {
    start, stop, isStarted: () => started, setPcmTap: (fn) => { pcmTap = fn || null; },
    setDevice, setSuppression, onLevel, enumerateMics, monitorStart, monitorStop,
    getSettings: () => ({ deviceId: micDeviceId, suppression }),
  };
})();
