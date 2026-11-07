// G.711 codecs (pure JS) — PCMU (µ-law, payload type 0) and PCMA (A-law, PT 8).
// Converts between 16-bit linear PCM (Int16) and 8-bit G.711 bytes.

const BIAS = 0x84;   // µ-law bias
const CLIP = 32635;

function linearToUlaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

function ulawToLinear(ulaw) {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

// A-law
function linearToAlaw(sample) {
  let sign = (~sample >> 8) & 0x80;
  if (sign === 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  let compressed;
  if (sample >= 256) {
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    compressed = (exponent << 4) | mantissa;
  } else {
    compressed = sample >> 4;
  }
  return (compressed ^ sign ^ 0x55) & 0xff;
}

function alawToLinear(alaw) {
  alaw ^= 0x55;
  const sign = alaw & 0x80;
  let exponent = (alaw >> 4) & 0x07;
  let mantissa = alaw & 0x0f;
  let sample = (mantissa << 4) + 8;
  if (exponent > 0) sample = (sample + 0x100) << (exponent - 1);
  return sign === 0 ? -sample : sample;
}

// Buffer helpers: Int16Array (PCM) <-> Buffer (G.711 bytes)
function encodeUlaw(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToUlaw(pcm[i]);
  return out;
}
function decodeUlaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ulawToLinear(buf[i]);
  return out;
}
function encodeAlaw(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToAlaw(pcm[i]);
  return out;
}
function decodeAlaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = alawToLinear(buf[i]);
  return out;
}

module.exports = {
  linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear,
  encodeUlaw, decodeUlaw, encodeAlaw, decodeAlaw,
};
