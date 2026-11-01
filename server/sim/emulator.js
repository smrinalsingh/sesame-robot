// Simulated robot. Runs the firmware's own move code (transpiled by
// server/firmware) against a stand-in for the hardware: servos, OLED, timers.
// The helper functions below mirror the ones in sesame-firmware-main.ino
// (setServoAngle, setFace, delayWithFace, pressingCheck, the idle blink and
// face animation). They are the only firmware behaviour reimplemented here.
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const ABORT = Symbol('reboot');
const FACE_ANIM_LOOP = 0;
const FACE_ANIM_ONCE = 1;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class Emulator extends EventEmitter {
  constructor(fw) {
    super();
    this.gen = 0;
    this.servos = new Array(8).fill(null); // null = never written (servo limp)
    this.lastServoT = new Array(8).fill(0);
    this.load(fw);
    this.loopRunning = false;
    this.tick = setInterval(() => this.updateFaceAndIdle(), 5);
    this.runLoop();
  }

  // (Re)boot with firmware `fw`, like flashing the robot. Servos keep their
  // last physical position; everything else starts fresh.
  load(fw) {
    this.gen++;
    this.fw = fw;
    this.boot = performance.now();
    const G = {};
    for (const [k, v] of Object.entries(fw.globals)) G[k] = Array.isArray(v) ? [...v] : v;
    for (const k of fw.externVars) if (!(k in G)) G[k] = 0;
    G.currentCommand = '';
    this.G = G;
    this.face = { name: '', frames: null, count: 0, index: 0, mode: FACE_ANIM_LOOP, fps: 0, dir: 1, finished: false, lastMs: 0 };
    this.idle = { active: false, blinkActive: false, nextBlinkMs: 0, repeatsLeft: 0 };
    this.mod = fw.factory(this.makeHal(this.gen), G);
    this.setFace('rest');
    this.emit('boot', { gen: this.gen });
  }

  millis() { return Math.floor(performance.now() - this.boot); }

  makeHal(gen) {
    const self = this;
    const G = () => self.G;
    const check = () => { if (gen !== self.gen) throw ABORT; };
    const delayWithFace = async (ms) => { check(); await sleepMs(Number(ms)); check(); };
    const serialLine = { buf: '' };
    const Serial = {
      print: (x) => { serialLine.buf += String(x); },
      println: (x = '') => { self.emit('serial', serialLine.buf + String(x)); serialLine.buf = ''; },
      printf: (fmt, ...a) => { serialLine.buf += fmt.replace(/%[-0-9.]*[dsfiuxc]/g, () => String(a.shift())); },
    };
    const hal = {
      // --- mirrors setServoAngle() in sesame-firmware-main.ino
      setServoAngle: async (channel, angle) => {
        channel = Math.trunc(channel);
        if (channel < 8 && channel >= 0) {
          const adjusted = Math.min(180, Math.max(0, Math.trunc(angle) + (G().servoSubtrim?.[channel] ?? 0)));
          self.writeServo(channel, adjusted);
          await delayWithFace(G().motorCurrentDelay ?? 20);
        }
      },
      // --- mirrors pressingCheck()
      pressingCheck: async (cmd, ms) => {
        const start = performance.now();
        while (performance.now() - start < ms) {
          check();
          if (G().currentCommand !== cmd) {
            await self.mod.runStandPose(1);
            return false;
          }
          await sleepMs(Math.min(5, ms - (performance.now() - start)));
        }
        return true;
      },
      delayWithFace,
      delay: delayWithFace,
      __yield: async () => { check(); await sleepMs(0); },
      setFace: (n) => self.setFace(String(n)),
      setFaceMode: (m) => self.setFaceMode(m),
      setFaceWithMode: (n, m) => { self.setFaceMode(m); self.setFace(String(n)); },
      enterIdle: () => self.enterIdle(),
      exitIdle: () => { self.idle.active = false; self.idle.blinkActive = false; },
      playSound: (name) => { self.emit('serial', `SOUND ${name}`); self.emit('sound', { name: String(name) }); },
      recordInput: () => {},
      Serial,
      F: (x) => x,
      String: (x) => String(x),
      millis: () => self.millis(),
      micros: () => Math.floor((performance.now() - self.boot) * 1000),
      random: (a, b) => (b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a))),
      constrain: (x, a, b) => Math.min(b, Math.max(a, x)),
      min: Math.min,
      max: Math.max,
      abs: Math.abs,
      map: (x, a, b, c, d) => Math.trunc(((x - a) * (d - c)) / (b - a) + c),
    };
    return hal;
  }

  writeServo(ch, angle) {
    this.servos[ch] = angle;
    this.emit('servo', { ch, angle, t: Date.now() });
  }

  // --- mirrors setFace(): unknown names fall back to "default"; a face with
  // no frames leaves the last image on screen (that's what the OLED does).
  setFace(name) {
    const f = this.face;
    if (name === f.name && f.frames) return;
    f.name = name;
    f.index = 0;
    f.lastMs = 0;
    f.dir = 1;
    f.finished = false;
    f.fps = this.faceFpsFor(name);
    const key = Object.keys(this.fw.faces).find((k) => k.toLowerCase() === name.toLowerCase());
    let frames = key ? this.fw.faces[key] : this.fw.faces.default;
    if (!frames?.length) {
      frames = this.fw.faces.default ?? [];
      f.name = 'default';
      f.fps = this.faceFpsFor('default');
    }
    f.frames = frames;
    f.count = frames.length;
    if (f.count > 0) this.emit('face', { name: f.name, frame: 0 });
  }

  setFaceMode(mode) {
    this.face.mode = mode;
    this.face.dir = 1;
    this.face.finished = false;
  }

  faceFpsFor(name) {
    const e = Object.entries(this.fw.faceFps).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return e ? e[1] : this.G.faceFps ?? 8;
  }

  enterIdle() {
    this.idle.active = true;
    this.idle.blinkActive = false;
    this.idle.repeatsLeft = 0;
    this.setFaceMode(2);
    this.setFace('idle');
    this.scheduleBlink(3000, 7000);
  }

  scheduleBlink(a, b) { this.idle.nextBlinkMs = this.millis() + a + Math.floor(Math.random() * (b - a)); }

  // --- mirrors updateAnimatedFace() + updateIdleBlink()
  updateFaceAndIdle() {
    const f = this.face;
    if (f.frames && f.count > 1 && !(f.mode === FACE_ANIM_ONCE && f.finished)) {
      const now = this.millis();
      const fps = Math.max(1, f.fps > 0 ? f.fps : this.G.faceFps ?? 8);
      if (now - f.lastMs >= 1000 / fps) {
        f.lastMs = now;
        if (f.mode === FACE_ANIM_LOOP) f.index = (f.index + 1) % f.count;
        else if (f.mode === FACE_ANIM_ONCE) {
          if (f.index + 1 >= f.count) { f.index = f.count - 1; f.finished = true; } else f.index++;
        } else if (f.dir > 0) {
          if (f.index + 1 >= f.count) { f.dir = -1; if (f.index > 0) f.index--; } else f.index++;
        } else if (f.index === 0) { f.dir = 1; if (f.count > 1) f.index++; } else f.index--;
        this.emit('face', { name: f.name, frame: f.index });
      }
    }
    const idle = this.idle;
    if (!idle.active) return;
    if (!idle.blinkActive) {
      if (this.millis() >= idle.nextBlinkMs) {
        idle.blinkActive = true;
        if (idle.repeatsLeft === 0 && Math.random() < 0.3) idle.repeatsLeft = 1;
        this.setFaceMode(FACE_ANIM_ONCE);
        this.setFace('idle_blink');
      }
      return;
    }
    if (f.mode === FACE_ANIM_ONCE && f.finished) {
      idle.blinkActive = false;
      this.setFaceMode(2);
      this.setFace('idle');
      if (idle.repeatsLeft > 0) { idle.repeatsLeft--; this.scheduleBlink(120, 220); } else this.scheduleBlink(3000, 7000);
    }
  }

  // --- mirrors loop(): run whatever currentCommand says.
  async runLoop() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    while (!this.closed) {
      const cmd = this.G.currentCommand;
      if (cmd !== '') {
        const gen = this.gen;
        this.emit('run', { command: cmd });
        try {
          await this.mod.__dispatch();
        } catch (e) {
          if (e !== ABORT) {
            this.emit('fault', { command: cmd, message: e?.message ?? String(e) });
            if (gen === this.gen) this.G.currentCommand = '';
          }
        }
        this.emit('idle', { command: cmd });
      }
      await sleepMs(5);
    }
  }

  // ---- inputs (what the HTTP handlers do on the real robot) ----
  command(cmd) {
    if (cmd !== 'stop') {
      this.G.currentCommand = cmd;
      this.idle.active = false;
      this.idle.blinkActive = false;
    } else this.G.currentCommand = '';
  }

  servoDirect(index, angle) {
    const sub = this.G.servoSubtrim?.[index] ?? 0;
    this.writeServo(index, Math.min(180, Math.max(0, angle + sub)));
  }

  snapshot() {
    return {
      currentCommand: this.G.currentCommand,
      face: { name: this.face.name, frame: this.face.index },
      servos: this.servos,
      settings: { frameDelay: this.G.frameDelay, walkCycles: this.G.walkCycles, motorCurrentDelay: this.G.motorCurrentDelay, faceFps: this.G.faceFps },
    };
  }

  close() { this.closed = true; this.gen++; clearInterval(this.tick); }
}
