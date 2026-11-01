// 3D twin of the robot: the printed STL parts, posed by servo angles using the
// joint calibration from Sesame Studio (rig/joints_config.json), with the OLED
// face on its screen. Transforms mirror Studio's viewport so poses match it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const PLA = 0xff6a13; // the orange PLA+ on order
const DEG = Math.PI / 180;
const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

// T(pos) * T(c) * Rz * Ry * Rx * T(-c)   (Studio's _apply_offset_transform)
function offsetMatrix(off, c) {
  const m = new THREE.Matrix4().makeTranslation(off.position[0] + c.x, off.position[1] + c.y, off.position[2] + c.z);
  m.multiply(new THREE.Matrix4().makeRotationZ(off.rotation[2] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationY(off.rotation[1] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationX(off.rotation[0] * DEG));
  m.multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  return m;
}

export function decodeFace(b64) {
  const bin = atob(b64);
  const px = new Uint8Array(128 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      const byte = bin.charCodeAt(y * 16 + (x >> 3));
      px[y * 128 + x] = byte & (0x80 >> (x & 7)) ? 1 : 0;
    }
  }
  return px;
}

export class RobotViewer {
  constructor(container, { servoNames, slewDegPerSec = 450 } = {}) {
    this.container = container;
    this.servoNames = servoNames;
    this.slew = slewDegPerSec;
    this.angles = {}; // shown
    this.targets = {}; // commanded
    this.joints = {};
    this.ready = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    container.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;

    this.scene.add(new THREE.HemisphereLight(0xfff4ea, 0x2a2a35, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-180, 260, 160);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 1000 });
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9db7ff, 0.8);
    rim.position.set(200, 120, -200);
    this.scene.add(rim);

    this.floor = new THREE.Mesh(new THREE.CircleGeometry(260, 64), new THREE.ShadowMaterial({ opacity: 0.28 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.PolarGridHelper(220, 8, 6, 64, 0x555566, 0x3a3a46);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);

    this.root = new THREE.Group(); // lifted so the lowest foot touches the floor
    this.scene.add(this.root);

    this.faceData = new Uint8Array(128 * 64 * 4);
    this.faceTex = new THREE.DataTexture(this.faceData, 128, 64, THREE.RGBAFormat);
    this.faceTex.magFilter = THREE.NearestFilter;
    this.faceTex.minFilter = THREE.LinearFilter;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.lastT = performance.now();
    this.lift = null;
    r.setAnimationLoop(() => this.frame());
  }

  async load(base = '/rig/') {
    const cfg = await (await fetch(`${base}joints_config.json`)).json();
    const loader = new STLLoader();
    const mat = new THREE.MeshStandardMaterial({ color: PLA, roughness: 0.55, metalness: 0.0 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0xd9550c, roughness: 0.6 });
    const load = async (rel) => {
      const geo = loader.parse(await (await fetch(`${base}stl/${rel}`)).arrayBuffer());
      geo.computeBoundingBox();
      geo.computeVertexNormals();
      return geo;
    };
    const mesh = (geo, m, off) => {
      const c = new THREE.Vector3();
      geo.boundingBox.getCenter(c);
      const me = new THREE.Mesh(geo, m);
      me.castShadow = true;
      me.matrixAutoUpdate = false;
      me.matrix.copy(offsetMatrix(off, c));
      return me;
    };

    const body = cfg.body;
    const [frame, bottom, cover] = await Promise.all([load(body.frame_stl), load(body.bottom_stl), body.cover_stl ? load(body.cover_stl) : null]);
    this.root.add(mesh(frame, matDark, body.frame_offset));
    this.root.add(mesh(bottom, mat, body.bottom_offset));
    if (cover) this.root.add(mesh(cover, mat, body.cover_offset));
    this.center = new THREE.Vector3();
    frame.boundingBox.getCenter(this.center);

    const names = Object.keys(cfg.joints);
    const geos = await Promise.all(names.map((n) => load(cfg.joints[n].stl)));
    const groups = {};
    names.forEach((n, i) => {
      const j = cfg.joints[n];
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.add(mesh(geos[i], mat, j.offset));
      groups[n] = g;
      this.joints[n] = { cfg: j, group: g, pivot: new THREE.Vector3(...j.pivot), axis: AXES[j.axis] ?? AXES.Y };
      this.angles[n] = j.rest_angle ?? 90;
    });
    for (const n of names) {
      const parent = cfg.joints[n].parent;
      (parent ? groups[parent] : this.root).add(groups[n]);
    }
    this.addFacePlane(cfg.face_plane);

    // Back the camera off on narrow (portrait phone) views so the legs fit.
    const dist = 330 * Math.max(1, 0.85 / Math.max(0.3, this.camera.aspect));
    this.controls.target.set(this.center.x, 20, this.center.z);
    this.camera.position.set(this.center.x - dist * 0.75, 170, this.center.z + dist * 0.7);
    this.controls.update();
    this.ready = true;
    for (const n of names) this.applyJoint(n);
  }

  // Studio draws the screen as a quad in the local YZ plane.
  addFacePlane(fp) {
    const w = (fp.width_in ?? 0.96) * 25.4;
    const hw = w / 2;
    const hh = (w * 64) / 128 / 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, hh, -hw, 0, hh, hw, 0, -hh, hw, 0, -hh, -hw], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const screen = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.faceTex, side: THREE.DoubleSide, toneMapped: false }));
    screen.matrixAutoUpdate = false;
    const m = new THREE.Matrix4().makeTranslation(...fp.position);
    m.multiply(new THREE.Matrix4().makeRotationZ(fp.rotation[2] * DEG));
    m.multiply(new THREE.Matrix4().makeRotationY(fp.rotation[1] * DEG));
    m.multiply(new THREE.Matrix4().makeRotationX(fp.rotation[0] * DEG));
    screen.matrix.copy(m);
    this.root.add(screen);
  }

  // Firmware order index -> joint name (R1,R2,L1,L2,R4,R3,L3,L4).
  setServo(ch, angle, immediate = false) {
    const name = this.servoNames[ch];
    if (!name || angle == null) return;
    this.targets[name] = angle;
    if (immediate) { this.angles[name] = angle; this.applyJoint(name); }
  }

  setServos(list) { list.forEach((a, ch) => this.setServo(ch, a, true)); }

  // 1-bit 128x64 pixels, rows top-down. Uploaded bottom-up like Studio does.
  setFace(px) {
    const d = this.faceData;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const on = px[(63 - y) * 128 + x];
        const i = (y * 128 + x) * 4;
        d[i] = on ? 225 : 6; d[i + 1] = on ? 240 : 8; d[i + 2] = on ? 255 : 14; d[i + 3] = 255;
      }
    }
    this.faceTex.needsUpdate = true;
  }

  applyJoint(name) {
    const j = this.joints[name];
    if (!j) return;
    let raw = this.angles[name];
    if (j.cfg.invert) raw = 180 - raw;
    const a = (raw - (j.cfg.rest_angle ?? 90)) * DEG;
    const p = j.pivot;
    const m = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
    m.multiply(new THREE.Matrix4().makeRotationAxis(j.axis, a));
    m.multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    j.group.matrix.copy(m);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.ready) {
      const step = this.slew * dt;
      for (const [n, target] of Object.entries(this.targets)) {
        const cur = this.angles[n];
        if (cur === target) continue;
        this.angles[n] = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
        this.applyJoint(n);
      }
      // Sit the lowest point of the robot on the floor (exact vertex check, a few times a second).
      this.frameNo = (this.frameNo ?? 0) + 1;
      if (this.frameNo % 8 === 1) {
        this.root.position.y = 0;
        this.root.updateMatrixWorld(true);
        this.wantLift = -new THREE.Box3().setFromObject(this.root, true).min.y;
      }
      this.lift = this.lift == null ? this.wantLift : this.lift + (this.wantLift - this.lift) * Math.min(1, dt * 8);
      this.root.position.y = this.lift;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// Crisp 2D OLED preview on a <canvas> (128x64, scaled).
export function drawOled(canvas, px) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(128, 64);
  for (let i = 0; i < 128 * 64; i++) {
    const on = px[i];
    img.data[i * 4] = on ? 225 : 4;
    img.data[i * 4 + 1] = on ? 240 : 6;
    img.data[i * 4 + 2] = on ? 255 : 12;
    img.data[i * 4 + 3] = 255;
  }
  canvas.width = 128;
  canvas.height = 64;
  ctx.putImageData(img, 0, 0);
}
