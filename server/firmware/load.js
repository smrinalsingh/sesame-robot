// Reads the firmware sources (the files you flash) and turns them into what the
// simulator needs: runnable move code, the command list, timing settings,
// face bitmaps and the robot's own web UI. Nothing here is a copy of firmware
// logic: edit the firmware and the next load() picks it up.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  tokenize, matchBracket, parseTopLevel, emitBlock, emitFunction, emitInit, FirmwareSyntaxError,
} from './clang.js';

export const FILES = {
  main: 'sesame-firmware-main.ino',
  moves: 'movement-sequences.h',
  faces: 'face-bitmaps.h',
  portal: 'captive-portal.h',
};

// Hardware-facing helpers the simulator provides itself (the "HAL").
// Async ones take time on the real robot, so the sim awaits them too.
export const HAL_ASYNC = new Set(['setServoAngle', 'delayWithFace', 'pressingCheck', 'delay', '__yield']);
export const HAL_NAMES = [
  'setServoAngle', 'setFace', 'setFaceMode', 'setFaceWithMode', 'delayWithFace', 'enterIdle', 'exitIdle',
  'pressingCheck', 'playSound', 'recordInput', 'Serial', 'F', 'millis', 'micros', 'random', 'constrain',
  'min', 'max', 'abs', 'map', 'delay', '__yield', 'String',
];
const JS_RESERVED = new Set(['yield', 'await', 'let', 'var', 'function', 'arguments', 'eval', 'of', 'in', 'G', 'HAL']);

function read(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) throw new FirmwareSyntaxError('file not found', name, 0);
  return readFileSync(p, 'utf8');
}

function renameReserved(toks) {
  for (const t of toks) if (t.t === 'id' && JS_RESERVED.has(t.v)) t.v = `__${t.v}`;
  return toks;
}

function evalInit(src) {
  const s = src.trim();
  if (/^-?\d+(\.\d+)?[uUlLfF]*$/.test(s)) return Number(s.replace(/[uUlLfF]+$/, ''));
  if (/^0x[0-9a-f]+$/i.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^"(.*)"$/.test(s)) return JSON.parse(s);
  if (/^\{[^{}]*\}$/.test(s)) return s.slice(1, -1).split(',').map((x) => evalInit(x)).filter((x) => x !== undefined);
  return undefined; // not a plain literal (pointers, objects, ...) - not needed by the sim
}

// Top-level `type name = literal;` globals in the .ino (column 0 only).
function parseInoGlobals(src) {
  const globals = {};
  const re = /^(?:static\s+)?(?:const\s+)?(?:unsigned\s+)?(?:int|long|bool|String|int8_t|uint8_t|uint16_t|uint32_t|float|double|byte)\s+(\w+)\s*(\[\d*\])?\s*=\s*(.+?);/;
  for (const line of src.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const v = evalInit(m[3]);
    if (v !== undefined) globals[m[1]] = v;
  }
  return globals;
}

function parseFaceFps(src) {
  const m = src.match(/faceFpsEntries\[\]\s*=\s*\{([\s\S]*?)\n\};/);
  const out = {};
  if (!m) return out;
  for (const e of m[1].matchAll(/\{\s*"(\w+)"\s*,\s*(\d+)\s*\}/g)) out[e[1]] = Number(e[2]);
  return out;
}

function activeArray(src, name) {
  for (const line of src.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(new RegExp(`${name}\\s*\\[\\d*\\]\\s*=\\s*\\{([^}]*)\\}`));
    if (m) return m[1].split(',').map((x) => Number(x.trim()));
  }
  return null;
}

function activeDefine(src, name) {
  for (const line of src.split('\n')) {
    const m = line.match(new RegExp(`^\\s*#define\\s+${name}\\s+(.+?)\\s*(//.*)?$`));
    if (m) return evalInit(m[1]) ?? m[1];
  }
  return null;
}

// The `if (currentCommand != "") { ... }` block inside loop(): the command table.
function extractDispatch(src) {
  const toks = renameReserved(tokenize(src, FILES.main));
  const loopIdx = toks.findIndex((t, i) => t.v === 'loop' && toks[i - 1]?.v === 'void' && toks[i + 1]?.v === '(');
  if (loopIdx < 0) throw new FirmwareSyntaxError('could not find void loop()', FILES.main, 0);
  const bodyOpen = toks.findIndex((t, i) => i > loopIdx && t.v === '{');
  const bodyClose = matchBracket(toks, bodyOpen, FILES.main);
  for (let k = bodyOpen; k < bodyClose; k++) {
    if (toks[k].v === 'if' && toks[k + 1]?.v === '(' && toks[k + 2]?.v === 'currentCommand' && toks[k + 3]?.v === '!=') {
      const condClose = matchBracket(toks, k + 1, FILES.main);
      if (toks[condClose + 1]?.v !== '{') break;
      const blockClose = matchBracket(toks, condClose + 1, FILES.main);
      return { toks: toks.slice(k, blockClose + 1), line: toks[k].line };
    }
  }
  throw new FirmwareSyntaxError('could not find the `if (currentCommand != "")` command dispatch in loop()', FILES.main, toks[loopIdx].line);
}

// cmd == "forward") runWalkPose();   ->  { forward: 'runWalkPose' }
function commandsFromDispatch(toks) {
  const cmds = [];
  for (let k = 0; k < toks.length - 4; k++) {
    if (toks[k].v === 'cmd' && toks[k + 1].v === '==' && toks[k + 2].t === 'str') {
      const name = JSON.parse(toks[k + 2].v);
      let j = k + 3;
      while (j < toks.length && toks[j].t !== 'id') j++;
      cmds.push({ name, fn: toks[j]?.v ?? null });
    }
  }
  return cmds;
}

function parseFaces(src) {
  const list = [...(src.match(/#define\s+FACE_LIST([\s\S]*?)\n\s*\n/)?.[1] ?? '').matchAll(/X\((\w+)\)/g)].map((m) => m[1]);
  const bitmaps = {};
  for (const m of src.matchAll(/epd_bitmap_(\w+)\s*\[\s*\]\s*PROGMEM\s*=\s*\{([^}]*)\}/g)) {
    const bytes = m[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => Number(x));
    bitmaps[m[1]] = Buffer.from(bytes).toString('base64');
  }
  const faces = {};
  for (const name of list) {
    const frames = [];
    for (let i = 0; i < 6; i++) {
      const key = i === 0 ? name : `${name}_${i}`;
      if (!bitmaps[key]) break; // firmware stops at the first missing frame (countFrames)
      frames.push(bitmaps[key]);
    }
    faces[name] = frames;
  }
  faces.default = faces.defualt ?? []; // firmware maps "default" to the misspelled defualt frames
  return { list: list.filter((n) => n !== 'defualt').concat('default'), faces };
}

export function loadFirmware(dir) {
  const mainSrc = read(dir, FILES.main);
  const movesSrc = read(dir, FILES.moves);
  const facesSrc = read(dir, FILES.faces);
  const portalSrc = existsSync(join(dir, FILES.portal)) ? read(dir, FILES.portal) : '';

  const inoGlobals = parseInoGlobals(mainSrc);
  const top = parseTopLevel(movesSrc, FILES.moves);
  for (const f of top.functions) renameReserved(f.bodyToks);

  const definedFns = top.functions.map((f) => f.name);
  const ctx = {
    file: FILES.moves,
    asyncFns: new Set([...HAL_ASYNC, ...definedFns]),
    globals: new Set([...top.externVars, ...Object.keys(inoGlobals)]),
    protoDefaults: top.protoDefaults,
  };
  for (const g of ctx.globals) if (HAL_NAMES.includes(g)) ctx.globals.delete(g);

  const parts = ['"use strict";', `const { ${HAL_NAMES.join(', ')} } = HAL;`];
  for (const e of top.enums) parts.push(`const ${e.name} = ${e.value};`);
  for (const c of top.consts) {
    if (ctx.globals.has(c.name)) continue;
    parts.push(`const ${c.name} = ${c.init ? emitInit(c.init) : c.isArray ? '[]' : '0'};`);
  }
  for (const f of top.functions) parts.push(emitFunction(f, ctx));

  const dispatch = extractDispatch(mainSrc);
  const dctx = { ...ctx, file: FILES.main };
  parts.push(`async function __dispatch() { /* ${FILES.main}:${dispatch.line} */\n${emitBlock(dispatch.toks, dctx)}\n}`);
  parts.push(`return { __dispatch, ${definedFns.join(', ')} };`);
  const code = parts.join('\n');

  // Compile now so syntax problems surface at load time, with the JS shown.
  let factory;
  try {
    factory = new Function('HAL', 'G', code);
  } catch (e) {
    const err = new FirmwareSyntaxError(`simulator could not compile the firmware moves (${e.message})`, FILES.moves, 0);
    err.code = code;
    throw err;
  }

  const fnByName = new Map(top.functions.map((f) => [f.name, f]));
  const usesPressing = (name, seen = new Set()) => {
    const f = fnByName.get(name);
    if (!f || seen.has(name)) return false;
    seen.add(name);
    return f.bodyToks.some((t) => t.v === 'pressingCheck');
  };
  const commands = commandsFromDispatch(dispatch.toks).map((c) => ({ ...c, continuous: usesPressing(c.fn) }));

  const { list: faceList, faces } = parseFaces(facesSrc);
  const indexHtml = portalSrc.match(/R"rawliteral\(([\s\S]*?)\)rawliteral"/)?.[1] ?? null;

  return {
    code,
    factory,
    commands,
    faceList,
    faces,
    faceFps: parseFaceFps(mainSrc),
    globals: inoGlobals,
    externVars: [...top.externVars],
    servoNames: top.enums.filter((e) => /^[RL][1-4]$/.test(e.name)).sort((a, b) => a.value - b.value).map((e) => e.name),
    servoPins: activeArray(mainSrc, 'servoPins'),
    apSsid: activeDefine(mainSrc, 'AP_SSID'),
    indexHtml,
    sounds: [...new Set([...movesSrc.matchAll(/playSound\(\s*"([^"]+)"/g)].map((m) => m[1]))],
  };
}
