// Pet personality files (pet/*.json, pet/personality.md) merged with what the
// firmware actually offers. Firmware moves without a behavior get one
// automatically, and references to moves/faces/sounds that don't exist are
// reported as warnings instead of failing at the robot.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

  return { behaviors, sounds, personality, warnings };
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
    description: `Make the pet react. Behaviors:\n${menu}`,
    parameters: {
      type: 'object',
      properties: {
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
      required: ['steps'],
    },
  };
}
