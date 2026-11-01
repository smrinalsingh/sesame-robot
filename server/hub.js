// The hub: serves the phone page and the Lab, relays phone audio to the AI,
// runs the pet's behaviors on the robot, and streams what the (simulated)
// robot is doing to every open page.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { BrainSession } from './pet/brain.js';
import { saveSounds } from './pet/config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.stl': 'model/stl', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

export class Hub {
  constructor(app) {
    this.app = app; // { root, env, mode, robotUrl, getFw, getEmu, robot, executor, getConfig, petDir, firmwareError }
    this.clients = new Set();
    this.brain = null;
    this.brainOwner = null;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    this.wss.on('connection', (ws) => this.onClient(ws));
    this.mounts = [
      ['/vendor/three/', join(app.root, 'node_modules/three/')],
      ['/rig/stl/', `${app.stlDir}/`],
      ['/rig/', join(app.root, 'rig/')],
      ['/', join(app.root, 'web/')],
    ];
  }

  attach(server) {
    server.on('request', (req, res) => this.onHttp(req, res).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e?.message ?? e));
    }));
    server.on('upgrade', (req, sock, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
      this.wss.handleUpgrade(req, sock, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  info() {
    const fw = this.app.getFw();
    const cfg = this.app.getConfig();
    return {
      mode: this.app.mode,
      robotUrl: this.app.robotUrl,
      commands: fw.commands,
      faceList: fw.faceList,
      servoNames: fw.servoNames,
      servoPins: fw.servoPins,
      firmwareSounds: fw.sounds,
      sounds: cfg.sounds,
      behaviors: cfg.behaviors,
      warnings: cfg.warnings,
      firmwareError: this.app.firmwareError(),
      state: this.app.getEmu().snapshot(),
      call: this.brain && !this.brain.closed ? { live: !!this.brain.live } : null,
    };
  }

  async onHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (p === '/api/info') return json(this.info());
    if (p === '/api/faces') return json({ faces: this.app.getFw().faces, faceFps: this.app.getFw().faceFps });
    if (p === '/api/firmware.js') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(this.app.getFw().code); }
    if (p === '/api/sounds' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { sounds } = JSON.parse(body);
      if (!sounds || typeof sounds !== 'object') return json({ error: 'expected {sounds:{...}}' }, 400);
      saveSounds(this.app.petDir, sounds);
      return json({ ok: true });
    }
    if (p === '/' || p === '/phone') return this.serveFile(res, join(this.app.root, 'web/index.html'));
    if (p === '/lab') return this.serveFile(res, join(this.app.root, 'web/lab.html'));
    for (const [prefix, dir] of this.mounts) {
      if (!p.startsWith(prefix)) continue;
      const rel = normalize(decodeURIComponent(p.slice(prefix.length)));
      if (rel.startsWith('..')) break;
      return this.serveFile(res, join(dir, rel));
    }
    res.writeHead(404);
    res.end('not found');
  }

  async serveFile(res, file) {
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }

  onClient(ws) {
    ws.meta = { role: 'lab' };
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', info: this.info() }));
    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.brainOwner === ws) this.endCall('phone disconnected');
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (this.brainOwner === ws && this.brain && !this.brain.closed) this.brain.appendAudio(data);
        return;
      }
      let m;
      try { m = JSON.parse(data); } catch { return; }
      this.onMessage(ws, m).catch((e) => this.log('error', e.message));
    });
  }

  log(level, text) { this.broadcast({ type: 'log', level, text, at: Date.now() }); }

  async onMessage(ws, m) {
    const { executor, robot } = this.app;
    switch (m.type) {
      case 'role': ws.meta.role = m.role; break;
      case 'call.start': this.startCall(ws, { audio: true }); break;
      case 'call.end': if (this.brainOwner === ws) this.endCall('hung up'); break;
      case 'text': {
        if (!this.brain || this.brain.closed) this.startCall(ws, { audio: false });
        this.broadcast({ type: 'heard', text: m.text, typed: true });
        const b = this.brain;
        if (b.live) b.sendText(m.text);
        else {
          const onState = (s) => {
            if (s.state === 'live') b.sendText(m.text);
            if (s.state === 'live' || s.state === 'ended') b.off('state', onState);
          };
          b.on('state', onState);
        }
        break;
      }
      case 'act': executor.act(m.steps, 'lab'); break;
      case 'robot': await executor.send(m.body); break;
      case 'servo': await robot.servo(m.index, m.angle); break;
      default: break;
    }
  }

  startCall(ws, { audio }) {
    if (this.brain && !this.brain.closed) this.endCall('another call started');
    const brain = new BrainSession({ env: this.app.env, getConfig: this.app.getConfig });
    this.brain = brain;
    this.brainOwner = audio ? ws : null;
    brain.on('state', (s) => this.broadcast({ type: 'call', ...s, audio }));
    brain.on('speech', (s) => this.broadcast({ type: 'speech', ...s }));
    brain.on('heard', (h) => this.broadcast({ type: 'heard', ...h }));
    brain.on('log', (l) => this.log(l.level, l.text));
    brain.on('act', ({ steps }) => {
      if (!steps.length) return;
      this.app.executor.act(steps, 'voice');
    });
    brain.start();
  }

  endCall(reason) {
    if (this.brain && !this.brain.closed) this.brain.end(reason);
    this.brainOwner = null;
  }

  configChanged() {
    if (this.brain && !this.brain.closed && this.brain.live) this.brain.refreshConfig();
  }
}
