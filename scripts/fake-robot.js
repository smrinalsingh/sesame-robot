// A stand-alone simulated robot on the network, behaving like the flashed
// firmware: HTTP API on --port (default 9090) and playSound() announced over
// UDP to whoever last called the JSON API. Lets you test robot mode
// (`npm start -- --robot http://localhost:9090`) without hardware.
import { createSocket } from 'node:dgram';
import { loadEnv, robotPaths } from '../server/env.js';
import { loadFirmware } from '../server/firmware/load.js';
import { Emulator } from '../server/sim/emulator.js';
import { createRobotHttp } from '../server/sim/robot-http.js';

const i = process.argv.indexOf('--port');
const port = Number(i >= 0 ? process.argv[i + 1] : 9090);
const emu = new Emulator(loadFirmware(robotPaths(loadEnv()).firmware));
const udp = createSocket('udp4');
let listener = null;

emu.on('http', ({ path }) => { if (path.startsWith('/api/command') || path.startsWith('/api/status')) listener = emu.lastClient; });
emu.on('sound', ({ name }) => { if (listener) udp.send(name, 4210, listener); });
emu.on('serial', (t) => console.log('serial:', t));

const server = createRobotHttp(() => emu);
server.prependListener('request', (req) => { emu.lastClient = req.socket.remoteAddress?.replace(/^::ffff:/, ''); });
server.listen(port, () => console.log(`fake robot on http://localhost:${port}`));
