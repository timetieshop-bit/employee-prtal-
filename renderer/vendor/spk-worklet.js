// Speaker worklet: receives 8 kHz Int16 PCM frames (decoded RTP) from the main
// thread, buffers them through an ADAPTIVE JITTER BUFFER, and upsamples to the
// audio context rate for playback.
//
// Why the jitter buffer matters: RTP packets never arrive perfectly evenly. On a
// low-jitter link (office LAN) they land every ~20 ms like clockwork; on a home
// / Wi-Fi link they bunch up and spread out. If we start draining the instant a
// sample arrives (no cushion), any such spread empties the buffer between bursts
// and the listener hears smooth audio, then a ~1 s dead gap, then smooth again —
// NOT garble, just underrun. The cure is to hold a small target cushion ("prime")
// so normal arrival jitter is absorbed, re-prime fully after an underrun instead
// of chattering in and out of silence, and let the cushion grow on a bad link and
// relax again on a good one. This is what makes a softphone feel smooth on the
// same home connections where a zero-depth buffer stutters.
class SpkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = 8000 / sampleRate; // 8k input samples advanced per output sample
    this.size = 8000 * 4;          // 4 s ring buffer @ 8k
    this.buf = new Float32Array(this.size);
    this.w = 0; this.r = 0; this.phase = 0;

    // Hold a steady ~100 ms like Asterisk/Vicidial's fixed jitterbuffer (jbmaxsize=100)
    // rather than shrinking back toward near-zero between bursts — a too-shallow floor
    // is what let gaps re-form on rough home links. It still GROWS on trouble, it just
    // never drops below a solid 100 ms cushion.
    this.FLOOR = 800;   // 100 ms @ 8k — minimum target cushion (matches jbmaxsize=100)
    this.CEIL  = 2800;  // 350 ms — max target cushion on a rough link
    this.prime = 880;   // 110 ms — current target cushion (adaptive, floored at 100 ms)
    this.playing = false; // false = filling (output muted) until `prime` is reached
    this.stable = 0;      // consecutive clean output samples since the last underrun

    this.port.onmessage = (e) => {
      const d = e.data; // Int16Array @8k
      for (let i = 0; i < d.length; i++) {
        this.buf[this.w] = d[i] / 32768;
        this.w = (this.w + 1) % this.size;
        if (this.w === this.r) this.r = (this.r + 1) % this.size; // overflow: drop oldest
      }
    };
  }
  _avail() { return (this.w - this.r + this.size) % this.size; }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    // Cap latency: if far more than the target has piled up (a burst, or the
    // sender's clock running slightly fast), skip forward to the target depth
    // rather than drifting seconds behind the live call.
    const HIGH = this.prime + 1600; // target + 200 ms
    if (this._avail() > HIGH) { this.r = (this.r + (this._avail() - this.prime)) % this.size; }

    // (Re)prime: don't start — or restart after an underrun — until the target
    // cushion has accumulated. While filling, output silence.
    if (!this.playing) {
      if (this._avail() >= this.prime) this.playing = true;
      else { for (let n = 0; n < out.length; n++) out[n] = 0; return true; }
    }

    for (let n = 0; n < out.length; n++) {
      if (this._avail() > 2) {
        const a = this.buf[this.r];
        const b = this.buf[(this.r + 1) % this.size];
        out[n] = a + (b - a) * this.phase;
        this.phase += this.step;
        while (this.phase >= 1) { this.phase -= 1; this.r = (this.r + 1) % this.size; }
        // Clean playback for a while → relax the cushion back toward the floor so
        // we don't hold needless latency on a link that has settled down.
        if (++this.stable > sampleRate * 8) { this.stable = 0; if (this.prime > this.FLOOR) this.prime -= 80; }
      } else {
        // Underrun. Go quiet, WIDEN the cushion so the refill absorbs more jitter
        // next time, and wait for a full re-prime before resuming (prevents the
        // rapid in/out-of-silence chatter). Bumps once per underrun event, because
        // once playing=false the top-of-process fill branch takes over until we
        // have re-primed.
        for (let m = n; m < out.length; m++) out[m] = 0;
        this.playing = false;
        this.stable = 0;
        this.prime = Math.min(this.CEIL, this.prime + 240);
        break;
      }
    }
    return true;
  }
}
registerProcessor('spk-8k', SpkProcessor);
