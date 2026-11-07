// Offline live captions using Vosk (WASM, fully local — no cloud, no per-minute
// cost). Transcribes a MediaStream (the remote/customer audio) and reports partial
// + final text via a callback. The speech model is downloaded once from modelUrl
// (hosted by you) and cached by the browser.
window.PhoneCaptions = (function () {
  let voskLoading = null;
  let model = null, modelUrlLoaded = null;
  let recognizer = null, audioContext = null, sourceNode = null, workletNode = null;
  let running = false;

  // Lazily inject the (large) vosk.js engine only when captions are first used.
  function loadVosk() {
    if (window.Vosk) return Promise.resolve(true);
    if (voskLoading) return voskLoading;
    voskLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'vendor/vosk.js';
      s.onload = () => resolve(!!window.Vosk);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return voskLoading;
  }

  async function start(stream, modelUrl, onText, onStatus) {
    if (running) return;
    if (!stream) { onStatus && onStatus('no-audio'); return; }
    if (!modelUrl) { onStatus && onStatus('no-model'); return; }
    onStatus && onStatus('loading-engine');
    const ok = await loadVosk();
    if (!ok || !window.Vosk) { onStatus && onStatus('engine-failed'); return; }

    try {
      onStatus && onStatus('loading-model');
      if (!model || modelUrlLoaded !== modelUrl) {
        model = await window.Vosk.createModel(modelUrl);
        modelUrlLoaded = modelUrl;
      }
      const channel = new MessageChannel();
      model.registerPort(channel.port1);

      audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      recognizer = new model.KaldiRecognizer(sampleRate);
      recognizer.setWords(true);
      recognizer.on('result', (m) => { if (m && m.result && onText) onText(m.result.text || '', true); });
      recognizer.on('partialresult', (m) => { if (m && m.result && onText) onText(m.result.partial || '', false); });

      await audioContext.audioWorklet.addModule('vendor/recognizer-processor.js');
      workletNode = new AudioWorkletNode(audioContext, 'recognizer-processor', {
        channelCount: 1, numberOfInputs: 1, numberOfOutputs: 1,
      });
      workletNode.port.postMessage({ action: 'init', recognizerId: recognizer.id }, [channel.port2]);
      workletNode.connect(audioContext.destination); // pulls the node; it outputs silence

      sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNode.connect(workletNode);

      running = true;
      onStatus && onStatus('live');
    } catch (e) {
      onStatus && onStatus('error');
      stop();
    }
  }

  function stop() {
    running = false;
    try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
    try { if (workletNode) workletNode.disconnect(); } catch (_) {}
    try { if (audioContext) audioContext.close(); } catch (_) {}
    sourceNode = null; workletNode = null; audioContext = null; recognizer = null;
    // Keep `model` loaded so re-enabling captions on the next call is instant.
  }

  return { start, stop, isRunning: () => running };
})();
