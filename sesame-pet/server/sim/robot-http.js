// HTTP front of the simulated robot: the same endpoints and responses as the
// firmware's WebServer (sesame-firmware-main.ino), so anything that talks to
// the real robot talks to the simulator unchanged. "/" serves the firmware's
// own controller page from captive-portal.h.
import { createServer } from 'node:http';

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

// Same lenient parsing as jsonStringField()/handleApiCommand on the robot.
function field(body, key) {
  const k = body.indexOf(`"${key}"`);
  if (k < 0) return '';
  const colon = body.indexOf(':', k + key.length + 2);
  const q1 = body.indexOf('"', colon + 1);
  const q2 = q1 < 0 ? -1 : body.indexOf('"', q1 + 1);
  return colon < 0 || q1 < 0 || q2 < 0 ? '' : body.slice(q1 + 1, q2);
}

export function createRobotHttp(getEmu) {
  return createServer(async (req, res) => {
    const emu = getEmu();
    const url = new URL(req.url, 'http://robot');
    const q = url.searchParams;
    const json = (code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
    emu.emit('http', { method: req.method, path: url.pathname + url.search });

    switch (url.pathname) {
      case '/':
        return emu.fw.indexHtml ? send(res, 200, 'text/html', emu.fw.indexHtml) : send(res, 404, 'text/plain', 'no captive-portal.h');
      case '/cmd':
        if (q.has('pose')) { emu.command(q.get('pose')); return send(res, 200, 'text/plain', 'OK'); }
        if (q.has('go')) { emu.command(q.get('go')); return send(res, 200, 'text/plain', 'OK'); }
        if (q.has('stop')) { emu.command('stop'); return send(res, 200, 'text/plain', 'OK'); }
        if (q.has('motor') && q.has('value')) {
          const m = q.get('motor');
          const angle = parseInt(q.get('value'), 10);
          const num = parseInt(m, 10);
          const byName = emu.fw.servoNames.indexOf(m);
          if (num >= 1 && num <= 8 && angle >= 0 && angle <= 180) { emu.servoDirect(num - 1, angle); return send(res, 200, 'text/plain', 'OK'); }
          if (byName >= 0 && angle >= 0 && angle <= 180) { emu.servoDirect(byName, angle); return send(res, 200, 'text/plain', 'OK'); }
          return send(res, 400, 'text/plain', 'Invalid motor or angle');
        }
        return send(res, 400, 'text/plain', 'Bad Args');
      case '/getSettings': {
        const s = emu.snapshot().settings;
        return json(200, s);
      }
      case '/setSettings':
        for (const k of ['frameDelay', 'walkCycles', 'motorCurrentDelay']) if (q.has(k)) emu.G[k] = parseInt(q.get(k), 10) || 0;
        if (q.has('faceFps')) emu.G.faceFps = Math.max(1, parseInt(q.get('faceFps'), 10) || 1);
        return send(res, 200, 'text/plain', 'OK');
      case '/api/status':
        return json(200, { currentCommand: emu.G.currentCommand, currentFace: emu.face.name, networkConnected: true, apIP: '192.168.4.1', networkIP: 'simulator' });
      case '/api/command': {
        if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
        const body = await readBody(req);
        const face = field(body, 'face');
        const sound = field(body, 'sound');
        const hasCommand = body.includes('"command"');
        const faceOnly = face !== '' && !hasCommand;
        if (!faceOnly && face === '' && sound !== '' && !hasCommand) {
          emu.playSound(sound);
          return json(200, { status: 'ok', message: 'Sound played' });
        }
        let command = '';
        if (!faceOnly) {
          if (!hasCommand) return json(400, { error: 'Missing command field' });
          command = field(body, 'command');
          if (!command) return json(400, { error: 'Invalid command format' });
        }
        if (face) emu.setFace(face);
        if (sound) emu.playSound(sound);
        if (faceOnly) return json(200, { status: 'ok', message: 'Face updated' });
        emu.command(command);
        return json(200, { status: 'ok', message: command === 'stop' ? 'Command stopped' : 'Command executed' });
      }
      case '/api/wifi/status':
        return json(200, { connected: true, ssid: 'simulator', ip: 'simulator', setupState: 'idle', error: '' });
      case '/api/wifi/scan':
        return json(200, { networks: [] });
      default:
        if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
        return emu.fw.indexHtml ? send(res, 200, 'text/html', emu.fw.indexHtml) : send(res, 404, 'text/plain', 'Not found');
    }
  });
}
