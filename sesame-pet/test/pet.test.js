import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFirmware } from '../server/firmware/load.js';
import { actTool, loadPetConfig, saveVoice } from '../server/pet/config.js';
import { robotPaths, ROOT } from '../server/env.js';

const fw = loadFirmware(robotPaths().firmware);

test('the AI always gets a line to say along with its behaviors', () => {
  const tool = actTool(loadPetConfig(join(ROOT, 'pet'), fw));
  assert.deepEqual(tool.parameters.required, ['say', 'steps']);
  assert.equal(tool.parameters.properties.say.type, 'string');
});

test('voice settings load, save, clamp and keep the rest of voice.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-'));
  cpSync(join(ROOT, 'pet'), dir, { recursive: true });
  const before = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'));
  saveVoice(dir, { mode: 'words', pitch: 99 });
  const cfg = loadPetConfig(dir, fw);
  assert.equal(cfg.voice.mode, 'words');
  assert.equal(cfg.voice.pitch, 12);
  assert.equal(cfg.voice.voice, before.voice);
  assert.equal(JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'))._help, before._help);
  assert.throws(() => saveVoice(dir, { mode: 'shout' }));
});
