// Mic capture worklet: resamples the context audio down to 8 kHz mono and posts
// 160-sample (20 ms) Int16 frames to the main thread for RTP transmission.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000; // input samples per 8k output sample (1 at an 8k ctx)
    this.frame = new Int16Array(160);
    this.n = 0;
    this.acc = 0; this.accN = 0; this.outPos = 0; // box-average accumulator
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // Average each decimation window (a box low-pass) rather than point-sampling,
    // so downsampling doesn't fold high frequencies into the voice band as
    // distortion. At an 8 kHz context (ratio≈1) each window is one sample → a
    // clean copy; the browser already anti-aliased on the way in.
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.accN++;
      this.outPos += 1;
      if (this.outPos >= this.ratio) {
        this.outPos -= this.ratio;
        let v = (this.acc / (this.accN || 1)) * 32767;
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        this.frame[this.n++] = v | 0;
        if (this.n === 160) { this.port.postMessage(this.frame.slice()); this.n = 0; }
        this.acc = 0; this.accN = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-8k', MicProcessor);
