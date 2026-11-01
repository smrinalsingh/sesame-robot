// Turns behaviors (from the AI or the Lab) into robot API calls, one step at a
// time. A newer request replaces whatever is still queued; walking is cut short
// with "stop", one-shot moves finish first (the firmware can't interrupt them).
import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Executor extends EventEmitter {
  constructor({ robot, getConfig, mirror }) {
    super();
    this.robot = robot;
    this.getConfig = getConfig;
    this.mirror = mirror; // optional: (body) => void, keeps the 3D twin in step with a real robot
    this.token = 0;
  }

  async send(body) {
    if (body.command) this.walking = false;
    this.mirror?.(body);
    return this.robot.command(body);
  }

  async act(steps, source = 'lab') {
    const token = ++this.token;
    const cancelled = () => token !== this.token;
    this.emit('act', { steps, source });
    // A walk from an earlier request keeps going until something replaces it.
    const first = this.getConfig().behaviors[steps[0]?.behavior];
    if (this.walking && !first?.command) await this.send({ command: 'stop' }).catch(() => {});
    for (const step of steps) {
      if (cancelled()) return;
      const b = this.getConfig().behaviors[step.behavior];
      if (!b) { this.emit('step', { behavior: step.behavior, state: 'error', error: 'unknown behavior' }); continue; }
      this.emit('step', { behavior: step.behavior, state: 'start' });
      try {
        await this.runStep(b, step, cancelled);
        this.emit('step', { behavior: step.behavior, state: 'done' });
      } catch (e) {
        this.emit('step', { behavior: step.behavior, state: 'error', error: e.message });
        return;
      }
    }
  }

  async waitOrCancel(ms, cancelled) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cancelled()) return false;
      await sleep(Math.min(100, end - Date.now()));
    }
    return true;
  }

  async runStep(b, step, cancelled) {
    const body = {};
    if (b.command) body.command = b.command;
    if (b.face) body.face = b.face;
    if (b.sound) body.sound = b.sound;
    if (!Object.keys(body).length) return; // e.g. "ignore"

    await this.send(body);
    if (b.command === 'stop') return;
    if (!b.command) { // face/sound reaction
      await this.waitOrCancel(b.hold ?? 1500, cancelled);
      if (b.face) await this.send({ face: 'idle' });
      return;
    }
    if (b.continuous) {
      const secs = Math.min(8, Math.max(0.5, Number(step.seconds ?? b.seconds ?? 2)));
      this.walking = true;
      if (!(await this.waitOrCancel(secs * 1000, cancelled))) return; // the newer request takes over
      await this.send({ command: 'stop' });
      await this.robot.waitIdle({ timeoutMs: 5000 });
      return;
    }
    await this.robot.waitIdle({ timeoutMs: 30000, isCancelled: () => false });
  }
}
