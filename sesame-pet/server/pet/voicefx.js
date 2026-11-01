// Turns the realtime (human) voice into a small creature's voice.
//
// Resampling raises pitch and formants together, which is what makes a voice
// sound like it comes from a tiny throat (a cartoon critter, not a human
// singing higher). It also speeds speech up by the same factor, so the realtime
// voice is asked to talk slower first (voiceSpeed), and the pace comes out
// natural. A slow pitch wobble adds a little warble.
//
// Streaming: push() PCM16 chunks as they arrive, flush() at the end.

const RATE = 24000;
const TAPS = 12; // kernel half-width in cutoff periods (quality vs CPU)

export const semitones = (st) => 2 ** (st / 12);

// The `speed` to ask the realtime voice for, so that after the pitch shift
// the speech runs at `pace` (1 = its normal pace).
export function voiceSpeed({ pitch = 0, pace = 1 }) {
  return Math.min(1.5, Math.max(0.25, pace / semitones(pitch)));
}

export class VoiceFx {
  constructor({ pitch = 0, wobble = 0, wobbleRate = 5.5 } = {}) {
    this.ratio = semitones(pitch);
    this.wobble = wobble; // semitones, peak
    this.wobbleRate = wobbleRate; // Hz
    this.bypass = pitch === 0 && wobble === 0;
    this.cutoff = Math.min(1, 1 / (this.ratio * semitones(wobble))) * 0.92; // anti-aliasing
    this.half = Math.ceil(TAPS / this.cutoff);
    this.buf = new Float32Array(0); // input not yet consumed
    this.base = 0; // absolute index of buf[0]
    this.pos = 0; // absolute read position, in input samples
    this.n = 0; // output samples produced
  }

  push(int16) {
    if (this.bypass) return int16;
    const next = new Float32Array(this.buf.length + int16.length);
    next.set(this.buf);
    for (let i = 0; i < int16.length; i++) next[this.buf.length + i] = int16[i] / 32768;
    this.buf = next;
    return this.run(false);
  }

  flush() {
    if (this.bypass) return new Int16Array(0);
    return this.run(true);
  }

  run(final) {
    const { buf, base, half, cutoff } = this;
    const end = base + buf.length; // first index we don't have
    const out = [];
    const lfo = (2 * Math.PI * this.wobbleRate) / RATE;
    while (final ? this.pos < end : Math.floor(this.pos) + half < end) {
      const p = this.pos;
      const i0 = Math.floor(p);
      let acc = 0;
      for (let k = i0 - half + 1; k <= i0 + half; k++) {
        const j = k - base;
        if (j < 0 || j >= buf.length) continue;
        const x = p - k;
        const u = x / half;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u); // Blackman
        const a = Math.PI * cutoff * x;
        acc += buf[j] * (x === 0 ? cutoff : (cutoff * Math.sin(a)) / a) * w;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc * 32768))));
      const r = this.wobble ? this.ratio * semitones(this.wobble * Math.sin(lfo * this.n)) : this.ratio;
      this.pos += r;
      this.n++;
    }
    // Drop input that no future output sample can reach.
    const keepFrom = Math.max(base, Math.floor(this.pos) - half);
    if (keepFrom > base) {
      this.buf = buf.subarray(keepFrom - base);
      this.base = keepFrom;
    }
    return Int16Array.from(out);
  }
}
