// Tiny .env loader (no dependency). Values already in process.env win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// This app lives inside the sesame-robot repo (`pet` branch), so the firmware
// you flash and the printed parts are one folder up: the single source of
// truth. SESAME_ROBOT_DIR in .env can point somewhere else.
export function robotPaths(env = {}) {
  const repo = resolve(ROOT, env.SESAME_ROBOT_DIR || process.env.SESAME_ROBOT_DIR || '..');
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
