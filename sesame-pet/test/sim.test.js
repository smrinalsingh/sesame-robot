// Runs every firmware command in the simulator (at 25x speed) and checks the
// emulation behaves like the robot: no faults, the command clears itself,
// timing matches the firmware's delays, and walking stops on "stop".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFirmware } from '../server/firmware/load.js';
import { Emulator } from '../server/sim/emulator.js';
import { robotPaths } from '../server/env.js';

const SPEED = 25;
const FIRMWARE = robotPaths().firmware;
const fw = loadFirmware(FIRMWARE);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runUntilIdle(emu, cmd, maxMs = 20000) {
  const servos = [];
  const sounds = [];
  const faults = [];
  const onServo = (e) => servos.push(e);
  const onSound = (e) => sounds.push({ ...e, t: emu.millis() });
  const onFault = (e) => faults.push(e);
  emu.on('servo', onServo).on('sound', onSound).on('fault', onFault);
  const t0 = emu.millis();
  emu.command(cmd);
  while (emu.G.currentCommand !== '' && emu.millis() - t0 < maxMs) await wait(2);
  const elapsed = emu.millis() - t0;
  emu.off('servo', onServo).off('sound', onSound).off('fault', onFault);
  return { servos, sounds, faults, elapsed };
}

test('firmware loads and exposes its command table', () => {
  const names = fw.commands.map((c) => c.name);
  for (const c of ['forward', 'backward', 'left', 'right', 'rest', 'stand', 'wave', 'dance', 'dead']) assert.ok(names.includes(c), c);
  assert.deepEqual(fw.commands.filter((c) => c.continuous).map((c) => c.name).sort(), ['backward', 'forward', 'left', 'right']);
  assert.deepEqual(fw.servoNames, ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']);
});

test('every one-shot command runs to completion without faults', async () => {
  const emu = new Emulator(fw, { speed: SPEED });
  try {
    for (const c of fw.commands.filter((x) => !x.continuous)) {
      const r = await runUntilIdle(emu, c.name);
      assert.deepEqual(r.faults, [], `${c.name} faulted`);
      assert.equal(emu.G.currentCommand, '', `${c.name} did not finish`);
      assert.ok(r.servos.length > 0, `${c.name} moved no servos`);
    }
  } finally { emu.close(); }
});

test('wave timing matches the firmware delays and chirps on every wave', async () => {
  const emu = new Emulator(fw, { speed: 1 }); // real time: fast-forward blurs millisecond timers
  try {
    const r = await runUntilIdle(emu, 'wave');
    // stand(160) + 200 + 4 writes(80) + 200 + 20 + 300 + 4*(20+300+20+300) + stand(160) = 3680 ms
    assert.ok(Math.abs(r.elapsed - 3680) < 150, `wave took ${r.elapsed}ms`);
    assert.deepEqual(r.sounds.map((s) => s.name), ['trill', 'chirp', 'chirp', 'chirp', 'chirp']);
  } finally { emu.close(); }
});

test('walking continues until stop, then stands', async () => {
  const emu = new Emulator(fw, { speed: SPEED });
  try {
    emu.command('forward');
    await wait(2500 / SPEED);
    assert.equal(emu.G.currentCommand, 'forward');
    emu.command('stop');
    await wait(400 / SPEED);
    const stand = { 0: 135, 1: 45, 2: 45, 3: 135, 4: 0, 5: 180, 6: 0, 7: 180 };
    for (const [ch, a] of Object.entries(stand)) assert.equal(emu.servos[ch], a, `servo ${ch}`);
  } finally { emu.close(); }
});

test('reload while a move runs reboots cleanly', async () => {
  const emu = new Emulator(fw, { speed: SPEED });
  try {
    emu.command('dance');
    await wait(1000 / SPEED);
    emu.load(loadFirmware(FIRMWARE));
    assert.equal(emu.G.currentCommand, '');
    const r = await runUntilIdle(emu, 'bow');
    assert.deepEqual(r.faults, []);
  } finally { emu.close(); }
});
