// Live captions powered by Deepgram. Two entry points share one WebSocket core:
//   • BrowserCaptions.start()  — captions the in-app browser (YouTube, VICIdial)
//       by capturing system loopback audio (getDisplayMedia) at 16 kHz.
//   • BrowserCaptions.openStream(sampleRate, onText, onStatus) — a raw PCM sink
//       for the native in-app softphone: returns { push(int16), close() } that
//       the phone feeds its 8 kHz call audio into.
//
// The API key stays on the server; the renderer only ever gets a short-lived
// token. Deepgram's browser WS auth uses a subprotocol — ['token', key] for a
// raw key, ['bearer', token] for a grant token — so we try the expected form
// and fall back to the other if the socket closes immediately.

(function () {
  function dgUrl(sampleRate) {
    return 'wss://api.deepgram.com/v1/listen' +
      '?encoding=linear16&sample_rate=' + (sampleRate || 16000) + '&channels=1' +
      '&model=nova-2&punctuate=true&interim_results=true&smart_format=true';
  }

  // ---- Reusable Deepgram socket that accepts Int16 PCM via push() ----
  // Returns a controller immediately; it connects asynchronously (fetches the
  // token first). Audio pushed before the socket is open is dropped (fine for
  // live captions). onStatus/onText are called as events arrive.
  function openDeepgram(sampleRate, onText, onStatus) {
    let ws = null;
    let alive = true;
    let gotTranscript = false;
    let triedAlt = false;
    let token = null;
    let protos = null;
    const status = (s) => { try { onStatus && onStatus(s); } catch (_) {} };

    function connect(ps) {
      protos = ps;
      gotTranscript = false;
      try { ws = new WebSocket(dgUrl(sampleRate), ps); } catch (_) { status('error'); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => status('live');
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type && msg.type !== 'Results') return;
        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        if (!alt) return;
        const text = (alt.transcript || '').trim();
        if (!text) return;
        gotTranscript = true;
        try { onText && onText(text, !!msg.is_final); } catch (_) {}
      };
      ws.onclose = (ev) => {
        if (alive && !gotTranscript && !triedAlt &&
            (ev.code === 1006 || ev.code === 1008 || ev.code === 4001 || ev.code === 4000)) {
          triedAlt = true;
          const alt = protos[0] === 'bearer' ? ['token', token] : ['bearer', token];
          status('authenticating…');
          setTimeout(() => { if (alive) connect(alt); }, 150);
          return;
        }
        if (alive) status('disconnected');
      };
    }

    (async () => {
      let tok;
      try { tok = await window.portal.dgToken(); } catch (e) { status('error'); return; }
      if (!tok || !tok.ok || !tok.token) {
        status(tok && tok.error === 'not_configured'
          ? 'not set up (add a Deepgram key in the admin portal)' : 'unavailable');
        alive = false; return;
      }
      if (!alive) return;
      token = tok.token;
      connect(tok.kind === 'grant' ? ['bearer', token] : ['token', token]);
    })();

    return {
      push(int16) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(int16.buffer ? int16.buffer : int16); } catch (_) {}
      },
      close() {
        alive = false;
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        try { ws && ws.close(); } catch (_) {} ws = null;
      },
    };
  }

  // ---- Loopback captions for the in-app browser ----
  let stream = null, audioCtx = null, srcNode = null, procNode = null;
  let dg = null, running = false;

  // Float32 [-1,1] @ inRate -> Int16 @ 16k (linear decimation).
  function toPcm16(float32, inRate) {
    const ratio = inRate / 16000;
    const outLen = Math.floor(float32.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = float32[Math.floor(i * ratio)] || 0;
      const c = Math.max(-1, Math.min(1, s));
      out[i] = c < 0 ? c * 0x8000 : c * 0x7fff;
    }
    return out;
  }

  async function start(onText, onStatus) {
    if (running) return true;
    const status = (s) => { try { onStatus && onStatus(s); } catch (_) {} };
    status('starting…');
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) { status('audio capture denied'); return false; }
    stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    if (!stream.getAudioTracks().length) {
      status('no system audio available');
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    running = true;
    dg = openDeepgram(16000, onText, onStatus);
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = audioCtx.createMediaStreamSource(stream);
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);
    const inRate = audioCtx.sampleRate;
    procNode.onaudioprocess = (e) => { if (dg) dg.push(toPcm16(e.inputBuffer.getChannelData(0), inRate)); };
    srcNode.connect(procNode);
    procNode.connect(audioCtx.destination);
    stream.getAudioTracks()[0].addEventListener('ended', () => stop());
    return true;
  }

  function stop() {
    running = false;
    try { dg && dg.close(); } catch (_) {} dg = null;
    try { procNode && procNode.disconnect(); } catch (_) {} procNode = null;
    try { srcNode && srcNode.disconnect(); } catch (_) {} srcNode = null;
    try { audioCtx && audioCtx.close(); } catch (_) {} audioCtx = null;
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {} stream = null;
  }

  window.BrowserCaptions = { start, stop, isRunning: () => running, openStream: openDeepgram };
})();
