// Tiny .env loader (no dependency). Values already in process.env win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The robot's own repo (your clone of sesame-robot, on the `pet` branch) is the
// single source of truth for firmware and printed parts. Override with
// SESAME_ROBOT_DIR in .env if it lives somewhere else.
export function robotPaths(env = {}) {
  const repo = resolve(ROOT, env.SESAME_ROBOT_DIR || process.env.SESAME_ROBOT_DIR || '../sesame-robot');
  return { repo, firmware: join(repo, 'firmware'), stl: join(repo, 'hardware/printing/stl') };
}

export function loadEnv(file = join(ROOT, '.env')) {
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k];
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REALTIME_MODEL', 'ROBOT_URL', 'PORT', 'SIM_PORT', 'SESAME_ROBOT_DIR']) {
    if (process.env[k] && !out[k]) out[k] = process.env[k];
  }
  return out;
}
