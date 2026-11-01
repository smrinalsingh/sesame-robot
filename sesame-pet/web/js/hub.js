// WebSocket link to the hub, with auto-reconnect, plus shared robot-view
// wiring used by both the phone page and the Lab.
import { RobotViewer, decodeFace, drawOled } from './viewer.js';
import { Synth } from './synth.js';
import { VoicePlayer } from './voice.js';

export class HubLink extends EventTarget {
  constructor(role) {
    super();
    this.role = role;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws`));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.send({ type: 'role', role: this.role }); this.emit('open'); };
    ws.onclose = () => { this.emit('close'); setTimeout(() => this.connect(), 1500); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      this.emit(m.type, m);
      this.emit('*', m);
    };
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); return this; }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  sendBinary(buf) { if (this.ws.readyState === 1) this.ws.send(buf); }

  get open() { return this.ws.readyState === 1; }
}

// Wires a hub link to a 3D view, a 2D OLED canvas, the synth (pet noises) and
// the voice player (spoken lines).
export async function attachRobotView(link, { viewEl, oledCanvas, synth = new Synth() }) {
  const voice = new VoicePlayer(synth);
  const faces = {};
  let viewer = null;
  let info = null;
  let faceName = null;
  const showFace = (name, frame) => {
    const b64 = faces[name]?.[frame];
    if (!b64) return; // frameless faces leave the last image (like the OLED)
    const px = decodeFace(b64);
    if (oledCanvas) drawOled(oledCanvas, px);
    viewer?.setFace(px);
    faceName = name;
  };
  const loadFaces = async () => Object.assign(faces, (await (await fetch('/api/faces')).json()).faces);

  link.on('hello', async ({ info: i }) => {
    info = i;
    synth.setRecipes(i.sounds);
    await loadFaces();
    if (viewEl && !viewer) {
      viewer = new RobotViewer(viewEl, { servoNames: i.servoNames });
      await viewer.load();
    }
    viewer?.setServos(i.state.servos.map((a) => a ?? 90));
    showFace(i.state.face.name, i.state.face.frame);
  });
  link.on('servo', ({ ch, angle }) => viewer?.setServo(ch, angle));
  link.on('face', ({ name, frame }) => showFace(name, frame));
  link.on('sound', ({ name, muted }) => { if (!muted) synth.play(name); });
  link.on('say.audio', ({ id, audio }) => voice.push(id, audio));
  link.on('say.stop', () => voice.stop());
  link.on('voice.mode', ({ mode }) => { if (info?.voice) info.voice.mode = mode; });
  link.on('firmware', async (m) => { if (m.ok) { info = m.info; await loadFaces(); synth.setRecipes(m.info.sounds); } });
  link.on('config', (m) => { info = m.info; synth.setRecipes(m.info.sounds); });
  return { synth, voice, get viewer() { return viewer; }, get info() { return info; }, get face() { return faceName; } };
}
