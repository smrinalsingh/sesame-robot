// Phone microphone -> 24 kHz mono PCM16 chunks (what gpt-realtime expects).
// While the pet is making a sound the mic sends silence instead, so the AI
// doesn't hear the phone's own chirps as speech.
const OUT_RATE = 24000;
const CHUNK = 960; // 40 ms

export class Mic {
  constructor({ onChunk, isGated = () => false, onLevel = () => {} }) {
    this.onChunk = onChunk;
    this.isGated = isGated;
    this.onLevel = onLevel;
    this.buf = new Float32Array(0);
    this.t = 0;
    this.out = new Int16Array(CHUNK);
    this.outN = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/js/mic-worklet.js');
    this.ratio = this.ctx.sampleRate / OUT_RATE;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-tap');
    this.node.port.onmessage = (e) => this.push(e.data);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    src.connect(this.node).connect(sink).connect(this.ctx.destination);
  }

  push(chunk) {
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) peak = Math.max(peak, Math.abs(chunk[i]));
    const gated = this.isGated();
    this.onLevel(gated ? 0 : peak);
    const merged = new Float32Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let t = this.t;
    while (t + 1 < merged.length) {
      const i = Math.floor(t);
      const f = t - i;
      const s = gated ? 0 : merged[i] * (1 - f) + merged[i + 1] * f;
      this.out[this.outN++] = Math.max(-32768, Math.min(32767, s * 32767));
      if (this.outN === CHUNK) {
        this.onChunk(this.out.buffer.slice(0));
        this.outN = 0;
      }
      t += this.ratio;
    }
    const used = Math.floor(t);
    this.buf = merged.slice(used);
    this.t = t - used;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
  }
}
