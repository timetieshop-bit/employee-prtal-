// Renderer audio bridge for the native (UDP) softphone. Captures the mic, resamples
// to 8 kHz, and ships Int16 frames to the main process (→ RTP); plays decoded RTP
// audio that comes back. All real-time audio stays in the window; only PCM crosses IPC.
window.NativeAudio = (function () {
  let ctx = null, micNode = null, spkNode = null, micStream = null, micSource = null, started = false;

  // Optional tap on the inbound (customer) PCM — used to feed live captions.
  // Set to a function(Int16Array @8k); cleared with null.
  let pcmTap = null;

  // Register the inbound-audio handler once; route to the live speaker node.
  if (window.portal && window.portal.onNativeAudio) {
    window.portal.onNativeAudio((buf) => {
      try {
        const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf.buffer || buf);
        const pcm = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
        // Feed captions first (its own copy), before the speaker transfer neuters it.
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
      ctx = new AudioContext();
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
        const f = e.data; // Int16Array (160 @ 8k)
        try { window.portal.nativeMic(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)); } catch (_) {}
      };
      micSource.connect(micNode);
      started = true;
      return true;
    } catch (e) {
      stop();
      return false;
    }
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

  return {
    start, stop, isStarted: () => started,
    setPcmTap: (fn) => { pcmTap = fn || null; },  // Int16Array @8k, or null to clear
  };
})();
