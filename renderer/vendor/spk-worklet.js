// Speaker worklet: receives 8 kHz Int16 PCM frames (decoded RTP) from the main
// thread, buffers them, and upsamples to the audio context rate for playback.
class SpkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = 8000 / sampleRate; // 8k input samples advanced per output sample
    this.size = 8000 * 3;          // ~3 s ring buffer @ 8k
    this.buf = new Float32Array(this.size);
    this.w = 0; this.r = 0; this.phase = 0;
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
    for (let n = 0; n < out.length; n++) {
      if (this._avail() > 2) {
        const a = this.buf[this.r];
        const b = this.buf[(this.r + 1) % this.size];
        out[n] = a + (b - a) * this.phase;
        this.phase += this.step;
        while (this.phase >= 1) { this.phase -= 1; this.r = (this.r + 1) % this.size; }
      } else {
        out[n] = 0; // underrun → silence
      }
    }
    return true;
  }
}
registerProcessor('spk-8k', SpkProcessor);
