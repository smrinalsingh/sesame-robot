// Tiny .env loader (no dependency). Values already in process.env win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = join(ROOT, '.env')) {
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k];
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REALTIME_MODEL', 'ROBOT_URL', 'PORT', 'SIM_PORT']) {
    if (process.env[k] && !out[k]) out[k] = process.env[k];
  }
  return out;
}
