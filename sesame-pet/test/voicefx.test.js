import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceFx, voiceSpeed, semitones } from '../server/pet/voicefx.js';

const RATE = 24000;
const sine = (hz, secs) => Int16Array.from({ length: RATE * secs }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / RATE)));
const freq = (s) => { // zero crossings in the steady middle part
  let z = 0;
  const a = Math.floor(s.length * 0.1), b = Math.floor(s.length * 0.9);
  for (let i = a + 1; i < b; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) z++;
  return (z / 2) / ((b - a) / RATE);
};
const run = (fx, input, chunk) => {
  const parts = [];
  for (let o = 0; o < input.length; o += chunk) parts.push(fx.push(input.subarray(o, o + chunk)));
  parts.push(fx.flush());
  return Int16Array.from(parts.flatMap((p) => [...p]));
};

test('raises pitch by the requested semitones and shortens by the same factor', () => {
  const out = run(new VoiceFx({ pitch: 5 }), sine(220, 2), 2400);
  assert.ok(Math.abs(freq(out) / (220 * semitones(5)) - 1) < 0.01, `got ${freq(out)} Hz`);
  assert.ok(Math.abs(out.length / (2 * RATE / semitones(5)) - 1) < 0.01);
});

test('streaming in odd chunk sizes gives the same audio as one big chunk', () => {
  const input = sine(330, 1);
  const a = run(new VoiceFx({ pitch: 4, wobble: 0.4 }), input, input.length);
  const b = run(new VoiceFx({ pitch: 4, wobble: 0.4 }), input, 977);
  assert.equal(a.length, b.length);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert.ok(maxDiff <= 1, `max diff ${maxDiff}`);
});

test('no effect means untouched audio, and speed compensates the pitch shift', () => {
  const input = sine(200, 0.5);
  assert.deepEqual(run(new VoiceFx({}), input, 1000), input);
  assert.ok(Math.abs(voiceSpeed({ pitch: 5, pace: 1 }) * semitones(5) - 1) < 1e-9);
  assert.equal(voiceSpeed({ pitch: 12, pace: 0.4 }), 0.25);
});
