// Tiny creature-sound synthesizer. Recipes live in pet/sounds.json (format in
// its _help field). The same code renders to speakers or to a WAV file
// (OfflineAudioContext), so a robot speaker can reuse the exact sounds later.

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

function envelope(param, points, at, dur, scale = 1, exp = false) {
  const pts = points?.length ? points : [[0, 1], [1, 1]];
  param.setValueAtTime(Math.max(exp ? 1 : 0, pts[0][1] * scale), at + pts[0][0] * dur);
  for (let i = 1; i < pts.length; i++) {
    const v = pts[i][1] * scale;
    const t = at + pts[i][0] * dur;
    if (exp) param.exponentialRampToValueAtTime(Math.max(1, v), t);
    else param.linearRampToValueAtTime(v, t);
  }
}

function layerInstance(ctx, dest, L, at, pitch) {
  const dur = L.dur ?? 0.1;
  const end = at + dur + 0.03;
  let src;
  if (L.wave === 'noise') {
    src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
  } else {
    src = ctx.createOscillator();
    src.type = L.wave || 'sine';
    envelope(src.frequency, L.freq ?? [[0, 440], [1, 440]], at, dur, pitch, true);
    if (L.vibrato?.depth) {
      const lfo = ctx.createOscillator();
      const g = ctx.createGain();
      lfo.frequency.value = L.vibrato.rate ?? 6;
      g.gain.value = L.vibrato.depth * pitch;
      lfo.connect(g).connect(src.frequency);
      lfo.start(at);
      lfo.stop(end);
    }
  }
  let node = src;
  if (L.filter) {
    const f = ctx.createBiquadFilter();
    f.type = L.filter.type ?? 'lowpass';
    f.Q.value = L.filter.q ?? 1;
    if (Array.isArray(L.filter.freq)) envelope(f.frequency, L.filter.freq, at, dur, pitch, true);
    else f.frequency.value = (L.filter.freq ?? 2000) * pitch;
    node.connect(f);
    node = f;
  }
  const amp = ctx.createGain();
  amp.gain.value = 0;
  envelope(amp.gain, L.amp ?? [[0, 0], [0.1, 1], [1, 0]], at, dur, L.vol ?? 1);
  node.connect(amp);
  node = amp;
  if (L.tremolo?.depth) {
    const trem = ctx.createGain();
    const d = Math.min(1, L.tremolo.depth);
    trem.gain.value = 1 - d / 2;
    const lfo = ctx.createOscillator();
    const g = ctx.createGain();
    lfo.frequency.value = L.tremolo.rate ?? 10;
    g.gain.value = d / 2;
    lfo.connect(g).connect(trem.gain);
    lfo.start(at);
    lfo.stop(end);
    node.connect(trem);
    node = trem;
  }
  node.connect(dest);
  src.start(at);
  src.stop(end);
}

export function recipeDuration(recipe) {
  let d = 0;
  for (const L of recipe.layers ?? []) {
    const reps = L.repeat ? (L.repeat.count - 1) * (L.repeat.every ?? 0.05) : 0;
    d = Math.max(d, (L.at ?? 0) + reps + (L.dur ?? 0.1));
  }
  return d;
}

// Schedules a recipe at time t0 on ctx; returns its duration in seconds.
export function renderRecipe(ctx, dest, recipe, t0) {
  const out = ctx.createGain();
  out.gain.value = recipe.gain ?? 0.7;
  out.connect(dest);
  const v = recipe.variation ?? 0;
  const pitch = 1 + (Math.random() * 2 - 1) * v;
  for (const L of recipe.layers ?? []) {
    const at = t0 + (L.at ?? 0);
    if (L.repeat) {
      const { count = 1, every = 0.05, pitchStep = 1, jitter = 0 } = L.repeat;
      for (let i = 0; i < count; i++) {
        const p = pitch * pitchStep ** i * (1 + (Math.random() * 2 - 1) * jitter);
        layerInstance(ctx, out, L, at + i * every, p);
      }
    } else layerInstance(ctx, out, L, at, pitch);
  }
  return recipeDuration(recipe);
}

export class Synth {
  constructor() {
    this.ctx = null;
    this.recipes = {};
    this.enabled = true;
    this.busyUntil = 0; // performance.now() ms until which a sound is audible
    this.onplay = null;
  }

  // Must be called from a user gesture the first time (browser autoplay rules).
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }

  setRecipes(r) { this.recipes = r ?? {}; }

  play(name, recipe = this.recipes[name]) {
    if (!this.enabled || !recipe || !this.ctx) return 0;
    const dur = renderRecipe(this.ctx, this.master, recipe, this.ctx.currentTime + 0.005);
    this.busyUntil = Math.max(this.busyUntil, performance.now() + dur * 1000);
    this.onplay?.(name, dur);
    return dur;
  }
}

// Render a recipe to a mono 16-bit WAV (default 22.05 kHz, good for an I2S speaker).
export async function recipeToWav(recipe, sampleRate = 22050) {
  const dur = recipeDuration(recipe) + 0.05;
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * sampleRate), sampleRate);
  renderRecipe(ctx, ctx.destination, recipe, 0);
  const buf = await ctx.startRendering();
  const pcm = buf.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([view], { type: 'audio/wav' });
}
