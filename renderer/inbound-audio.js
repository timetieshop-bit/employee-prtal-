// Renderer audio bridge for the inbound ACD phone (third phone). Independent of
// NativeAudio (Phone 2) so an inbound call has its own mic capture + speaker
// path. Mic frames (Int16 @8k) go to the main process (→ RTP to the queue
// service); decoded RTP audio from the service plays back here.
window.InboundAudio = (function () {
  let ctx = null, micNode = null, spkNode = null, micStream = null, micSource = null, started = false;
  let pcmTap = null; // optional tap on the caller PCM for live captions

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
      spkNode = new AudioWorkletNode(ctx, 'spk-8k', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      spkNode.connect(ctx.destination);
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      micSource = ctx.createMediaStreamSource(micStream);
      micNode = new AudioWorkletNode(ctx, 'mic-8k', { numberOfInputs: 1, numberOfOutputs: 0 });
      micNode.port.onmessage = (e) => {
        const f = e.data;
        try { window.portal.inboundMic(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)); } catch (_) {}
      };
      micSource.connect(micNode);
      started = true;
      return true;
    } catch (e) { stop(); return false; }
  }

  function stop() {
    started = false;
    try { micSource && micSource.disconnect(); } catch (_) {}
    try { micNode && micNode.disconnect(); } catch (_) {}
    try { spkNode && spkNode.disconnect(); } catch (_) {}
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ctx && ctx.close(); } catch (_) {}
    ctx = null; micNode = null; spkNode = null; micStream = null; micSource = null;
  }

  return { start, stop, isStarted: () => started, setPcmTap: (fn) => { pcmTap = fn || null; } };
})();
