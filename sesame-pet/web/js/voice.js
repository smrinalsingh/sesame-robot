// Plays Sesame's spoken lines: PCM16 mono 24 kHz chunks streamed from the hub,
// queued back to back on the synth's audio output. A newer line cuts off the
// older one. busyUntil lets the phone keep its mic quiet while Sesame talks.
const RATE = 24000;

export class VoicePlayer {
  constructor(synth) {
    this.synth = synth;
    this.id = null;
    this.sources = new Set();
    this.endAt = 0;
    this.busyUntil = 0;
  }

  push(id, base64) {
    const { ctx, master, enabled } = this.synth;
    if (!ctx || !enabled) return;
    if (this.id !== null && id < this.id) return; // late audio from an older line
    if (id !== this.id) { this.stop(); this.id = id; }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, RATE);
    const out = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    const now = ctx.currentTime;
    const at = Math.max(now + 0.06, this.endAt);
    src.start(at);
    this.endAt = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.busyUntil = performance.now() + (this.endAt - now) * 1000;
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    this.sources.clear();
    this.endAt = 0;
    this.busyUntil = 0;
  }
}
