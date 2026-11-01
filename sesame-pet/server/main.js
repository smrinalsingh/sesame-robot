// sesame-pet entry point.
//   npm start                      -> simulator (default)
//   npm start -- --robot http://192.168.1.50   -> real robot (simulator becomes its 3D twin)
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createSocket } from 'node:dgram';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, robotPaths } from './env.js';
import { loadFirmware } from './firmware/load.js';
import { Emulator } from './sim/emulator.js';
import { createRobotHttp } from './sim/robot-http.js';
import { RobotClient } from './pet/robot-client.js';
import { Executor } from './pet/executor.js';
import { loadPetConfig } from './pet/config.js';
import { Hub } from './hub.js';
import { ensureCert, lanAddresses } from './certs.js';

const env = loadEnv();
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const robotUrl = arg('robot', env.ROBOT_URL || 'sim');
const mode = robotUrl === 'sim' ? 'sim' : 'robot';
const PORT_HTTPS = Number(arg('port', env.PORT || 8443));
const PORT_HTTP = Number(env.HTTP_PORT || 8000);
const PORT_SIM = Number(env.SIM_PORT || 8080);
const SOUND_UDP_PORT = 4210;
const PATHS = robotPaths(env);
const FIRMWARE_DIR = PATHS.firmware;
const PET_DIR = join(ROOT, 'pet');

const stamp = () => new Date().toLocaleTimeString();
const say = (...a) => console.log(`[${stamp()}]`, ...a);

// ---- firmware: the single source of truth for moves, faces and timing
if (!existsSync(FIRMWARE_DIR)) {
  console.error(`No firmware at ${FIRMWARE_DIR}.\nRun this from sesame-robot/sesame-pet on the "pet" branch (or set SESAME_ROBOT_DIR in .env).`);
  process.exit(1);
}
let fw;
let firmwareError = null;
try {
  fw = loadFirmware(FIRMWARE_DIR);
} catch (e) {
  console.error(`Firmware could not be loaded: ${e.message}`);
  process.exit(1);
}
const emu = new Emulator(fw);

let petConfig = loadPetConfig(PET_DIR, fw);
for (const w of petConfig.warnings) say('warning:', w);

// ---- robot target
let robot;
let mirror = null;
if (mode === 'sim') {
  createRobotHttp(() => emu).listen(PORT_SIM, '0.0.0.0');
  robot = new RobotClient(`http://127.0.0.1:${PORT_SIM}`);
} else {
  robot = new RobotClient(robotUrl);
  // 3D twin: replay the same commands on the simulator (its sounds stay muted;
  // the real robot announces its own sounds over UDP).
  mirror = (body) => {
    if (body.face) emu.setFace(body.face);
    if (body.command) emu.command(body.command);
  };
}

const executor = new Executor({ robot, getConfig: () => petConfig, mirror });
const hub = new Hub({
  root: ROOT, env, mode, robotUrl, robot, executor, petDir: PET_DIR, stlDir: PATHS.stl,
  getFw: () => fw, getEmu: () => emu, getConfig: () => petConfig, firmwareError: () => firmwareError,
});

// ---- stream robot state to pages
emu.on('servo', (e) => hub.broadcast({ type: 'servo', ch: e.ch, angle: e.angle }));
emu.on('face', (e) => hub.broadcast({ type: 'face', name: e.name, frame: e.frame }));
emu.on('serial', (text) => hub.broadcast({ type: 'serial', text }));
emu.on('fault', (e) => { hub.log('error', `firmware fault in "${e.command}": ${e.message}`); say('fault', e.command, e.message); });
emu.on('run', (e) => hub.broadcast({ type: 'run', command: e.command }));
emu.on('idle', (e) => hub.broadcast({ type: 'done', command: e.command }));
if (mode === 'sim') emu.on('sound', (e) => hub.broadcast({ type: 'sound', name: e.name }));
executor.on('act', (e) => hub.broadcast({ type: 'act', ...e }));
executor.on('step', (e) => hub.broadcast({ type: 'step', ...e }));

// ---- sounds announced by the real robot (firmware playSound -> UDP)
const udp = createSocket('udp4');
udp.on('message', (msg) => hub.broadcast({ type: 'sound', name: msg.toString().trim() }));
udp.on('error', (e) => say(`UDP ${SOUND_UDP_PORT}: ${e.message}`));
udp.bind(SOUND_UDP_PORT);

// ---- live reload: firmware and pet files
function watchDir(dir, onChange) {
  let timer = null;
  watch(dir, () => { clearTimeout(timer); timer = setTimeout(onChange, 250); });
}
watchDir(FIRMWARE_DIR, () => {
  try {
    const next = loadFirmware(FIRMWARE_DIR);
    fw = next;
    firmwareError = null;
    emu.load(fw);
    petConfig = loadPetConfig(PET_DIR, fw);
    hub.broadcast({ type: 'firmware', ok: true, info: hub.info() });
    hub.configChanged();
    say(`firmware reloaded: ${fw.commands.length} commands, ${fw.faceList.length} faces`);
  } catch (e) {
    firmwareError = e.message;
    hub.broadcast({ type: 'firmware', ok: false, error: e.message });
    say('firmware error (simulator keeps the last good version):', e.message);
  }
});
watchDir(PET_DIR, () => {
  try {
    petConfig = loadPetConfig(PET_DIR, fw);
    hub.broadcast({ type: 'config', info: hub.info() });
    hub.configChanged();
    say('pet config reloaded', petConfig.warnings.length ? `(${petConfig.warnings.length} warnings)` : '');
    for (const w of petConfig.warnings) say('warning:', w);
  } catch (e) {
    hub.log('error', `pet config: ${e.message}`);
    say('pet config error:', e.message);
  }
});

// ---- real robot health
if (mode === 'robot') {
  let last = null;
  setInterval(async () => {
    const s = await robot.status().catch(() => null);
    const online = !!s;
    if (online !== last) { hub.broadcast({ type: 'robot', online }); say(`robot ${online ? 'online' : 'OFFLINE'} at ${robotUrl}`); last = online; }
  }, 3000);
}

// ---- servers
const httpsServer = createHttps(ensureCert(join(ROOT, 'certs')));
hub.attach(httpsServer);
httpsServer.listen(PORT_HTTPS, '0.0.0.0');
const httpServer = createHttp();
hub.attach(httpServer);
httpServer.listen(PORT_HTTP, '0.0.0.0');

const lan = lanAddresses()[0] ?? 'localhost';
console.log(`
  Sesame pet hub  (${mode === 'sim' ? 'simulator' : `robot at ${robotUrl}`})
  Phone (voice):  https://${lan}:${PORT_HTTPS}/      accept the certificate warning once
  Lab (laptop):   http://localhost:${PORT_HTTP}/lab
${mode === 'sim' ? `  Sim robot API:  http://localhost:${PORT_SIM}/   (same API + web UI as the real robot)\n` : ''}  Firmware:       ${FIRMWARE_DIR}
  Edit the firmware or pet/*.json and the simulator reloads.
`);
