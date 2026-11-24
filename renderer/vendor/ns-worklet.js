// Noise-suppression gate for the inbound mic. A downward expander: audio above a
// (strength-scaled) threshold is treated as speech and passes at full gain, while
// quieter audio — the steady background between words — is ducked. Strength 0 is a
// clean bypass. This runs on the audio thread and sits just before the 8 kHz mic
// resampler, so it cleans the wideband signal before it's crushed to telephony.
// It also reports the post-gate level to the main thread for the mic meter.
class NsGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.strength = 0;   // 0..10
    this.env = 0;        // amplitude envelope follower
    this.gain = 1;       // smoothed gain actually applied
    this.peak = 0;       // running peak for the meter
    this.clock = 0;      // samples since the last meter report
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && typeof d.strength === 'number') this.strength = Math.max(0, Math.min(10, d.strength));
    };
  }
  _params(s) {
    const f = s / 10;
    // Higher strength → higher threshold (gates more background) and a lower floor
    // (ducks it harder). Tuned to be gentle at 1–3 and aggressive at 8–10.
    return { thr: 0.006 + 0.045 * f, floor: 0.6 - 0.58 * f };
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!inp) { out.fill(0); return true; }
    const s = this.strength;
    const bypass = s <= 0;
    const p = bypass ? null : this._params(s);
    const envUp = 0.4, envDn = 0.995, atk = 0.3, rel = 0.02;
    for (let i = 0; i < inp.length; i++) {
      const x = inp[i];
      if (bypass) {
        out[i] = x;
      } else {
        const ax = x < 0 ? -x : x;
        this.env = ax > this.env ? (this.env * (1 - envUp) + ax * envUp) : (this.env * envDn);
        const target = this.env >= p.thr ? 1 : p.floor;
        this.gain += (target - this.gain) * (target > this.gain ? atk : rel);
        out[i] = x * this.gain;
      }
      const o = out[i] < 0 ? -out[i] : out[i];
      if (o > this.peak) this.peak = o;
    }
    this.clock += inp.length;
    if (this.clock >= 2048) { // ~24x/sec at 48 kHz
      this.clock = 0;
      this.port.postMessage({ level: this.peak });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('ns-gate', NsGate);
