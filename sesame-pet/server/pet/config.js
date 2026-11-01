// Pet personality files (pet/*.json, pet/personality.md) merged with what the
// firmware actually offers. Firmware moves without a behavior get one
// automatically, and references to moves/faces/sounds that don't exist are
// reported as warnings instead of failing at the robot.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VOICE_MODES = ['noises', 'words'];
export const VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'];
const VOICE_DEFAULTS = { mode: 'noises', voice: 'marin', style: 'a tiny, curious robot pet: bright and playful', pitch: 5, pace: 1.05, wobble: 0.3 };
// Knobs for the creature voice (see server/pet/voicefx.js): [min, max].
export const VOICE_RANGES = { pitch: [0, 12], pace: [0.7, 1.4], wobble: [0, 1.5] };

function cleanVoice(v, warnings = []) {
  const out = { ...VOICE_DEFAULTS, ...v };
  if (!VOICE_MODES.includes(out.mode)) { warnings.push(`voice.json: mode "${out.mode}" should be one of ${VOICE_MODES.join(', ')}`); out.mode = VOICE_DEFAULTS.mode; }
  if (!VOICES.includes(out.voice)) { warnings.push(`voice.json: unknown voice "${out.voice}", using ${VOICE_DEFAULTS.voice}`); out.voice = VOICE_DEFAULTS.voice; }
  for (const [k, [lo, hi]] of Object.entries(VOICE_RANGES)) {
    const n = Number(out[k]);
    if (!Number.isFinite(n)) { warnings.push(`voice.json: ${k} should be a number`); out[k] = VOICE_DEFAULTS[k]; } else out[k] = Math.min(hi, Math.max(lo, n));
  }
  return { mode: out.mode, voice: out.voice, style: String(out.style ?? ''), pitch: out.pitch, pace: out.pace, wobble: out.wobble };
}

function loadVoice(dir, warnings) {
  const file = join(dir, 'voice.json');
  return cleanVoice(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}, warnings);
}

export function loadPetConfig(dir, fw) {
  const behaviorsFile = JSON.parse(readFileSync(join(dir, 'behaviors.json'), 'utf8'));
  const soundsFile = JSON.parse(readFileSync(join(dir, 'sounds.json'), 'utf8'));
  const personality = readFileSync(join(dir, 'personality.md'), 'utf8');
  const sounds = soundsFile.sounds ?? {};
  const warnings = [];

  const commands = new Map(fw.commands.map((c) => [c.name, c]));
  const faces = new Set(fw.faceList);
  const behaviors = {};
  for (const [name, b] of Object.entries(behaviorsFile.behaviors ?? {})) {
    if (b.command && b.command !== 'stop' && !commands.has(b.command)) warnings.push(`behavior "${name}": firmware has no "${b.command}" command`);
    if (b.face && !faces.has(b.face)) warnings.push(`behavior "${name}": firmware has no "${b.face}" face`);
    if (b.sound && !sounds[b.sound]) warnings.push(`behavior "${name}": no sound "${b.sound}" in sounds.json`);
    behaviors[name] = { ...b, continuous: !!commands.get(b.command)?.continuous, auto: false };
  }
  const used = new Set(Object.values(behaviors).map((b) => b.command));
  for (const c of fw.commands) {
    if (used.has(c.name) || behaviors[c.name]) continue;
    behaviors[c.name] = { when: `perform the "${c.name}" move`, command: c.name, continuous: c.continuous, auto: true };
  }
  for (const s of fw.sounds) if (!sounds[s]) warnings.push(`firmware plays "${s}" but sounds.json has no such sound`);
  const voice = loadVoice(dir, warnings);

  return { behaviors, sounds, personality, voice, warnings };
}

// Saves voice settings (the noises/words switch, the Lab's voice tuner) into
// pet/voice.json, keeping the rest of the file. Returns the cleaned settings.
export function saveVoice(dir, patch) {
  if (patch.mode !== undefined && !VOICE_MODES.includes(patch.mode)) throw new Error(`voice mode must be one of ${VOICE_MODES.join(', ')}`);
  const file = join(dir, 'voice.json');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const keys = ['mode', 'voice', 'style', ...Object.keys(VOICE_RANGES)];
  const cleaned = cleanVoice({ ...current, ...Object.fromEntries(keys.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) });
  for (const k of keys) current[k] = cleaned[k];
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return cleaned;
}

export function saveSounds(dir, sounds) {
  const file = join(dir, 'sounds.json');
  const current = JSON.parse(readFileSync(file, 'utf8'));
  current.sounds = sounds;
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
}

// Tool definition the realtime model uses to act.
export function actTool(cfg) {
  const names = Object.keys(cfg.behaviors);
  const menu = names.map((n) => `- ${n}: ${cfg.behaviors[n].when ?? ''}${cfg.behaviors[n].continuous ? ' (walking; use seconds)' : ''}`).join('\n');
  return {
    type: 'function',
    name: 'act',
    description: `Make the pet react: what it says and what it does. Behaviors:\n${menu}`,
    parameters: {
      type: 'object',
      properties: {
        say: {
          type: 'string',
          description: "Sesame's own short line for this moment (2-10 words, the owner's language). Depending on the owner's setting it is spoken aloud or shown as a caption under pet noises. Empty only with ignore.",
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              behavior: { type: 'string', enum: names },
              seconds: { type: 'number', description: 'walking/turning duration in seconds (0.5-8)' },
            },
            required: ['behavior'],
          },
        },
      },
      required: ['say', 'steps'],
    },
  };
}
