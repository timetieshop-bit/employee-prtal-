// Mic capture worklet: resamples the context audio down to 8 kHz mono and posts
// 160-sample (20 ms) Int16 frames to the main thread for RTP transmission.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000; // input samples per 8k output sample
    this.pos = 0;                    // fractional read position within the stream
    this.prev = 0;                   // last sample of previous block (for interpolation)
    this.frame = new Int16Array(160);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // Linear-interpolate from the ctx-rate block down to 8 kHz.
    let p = this.pos;
    while (p < ch.length) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = (i + 1) < ch.length ? ch[i + 1] : ch[ch.length - 1];
      let v = (a + (b - a) * frac) * 32767;
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      this.frame[this.n++] = v | 0;
      if (this.n === 160) { this.port.postMessage(this.frame.slice()); this.n = 0; }
      p += this.ratio;
    }
    this.pos = p - ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor('mic-8k', MicProcessor);
