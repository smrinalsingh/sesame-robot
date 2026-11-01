import { HubLink, attachRobotView } from './hub.js';
import { Mic } from './mic.js';

const $ = (id) => document.getElementById(id);
const link = new HubLink('phone');
const view = await attachRobotView(link, { viewEl: $('view'), oledCanvas: $('oled') });
const { synth } = view;

let callState = 'idle';
let mic = null;
let wakeLock = null;

link.on('open', () => { $('link').className = 'dot on'; });
link.on('close', () => { $('link').className = 'dot off'; setCall('idle'); });
link.on('hello', ({ info }) => {
  $('mode').textContent = info.mode === 'sim' ? '· simulator' : '· robot';
  renderQuick(info);
  if (info.firmwareError) banner(`Firmware error, simulator is on the last good version: ${info.firmwareError}`);
});
link.on('config', ({ info }) => renderQuick(info));
link.on('firmware', (m) => { if (m.ok) { banner(''); renderQuick(m.info); } else banner(`Firmware error: ${m.error}`); });
link.on('robot', ({ online }) => banner(online ? '' : 'Robot is offline. Is it on and on the same WiFi?'));

function banner(text) { $('banner').hidden = !text; $('banner').textContent = text; }

// ---- call
function setCall(state, detail = '') {
  callState = state;
  const b = $('call');
  b.className = `call ${state === 'live' ? 'live' : state === 'connecting' ? 'connecting' : ''}`;
  $('callLabel').textContent = { idle: 'Call', connecting: 'Connecting…', live: 'Listening · tap to hang up' }[state] ?? state;
  if (state === 'idle' && detail) $('callLabel').textContent = `Call ended: ${detail}`;
}

async function startCall() {
  synth.unlock(); // user gesture: allow sounds
  if (!window.isSecureContext) {
    banner('The microphone needs the https:// address (see the terminal).');
    return;
  }
  setCall('connecting');
  try {
    mic = new Mic({
      onChunk: (buf) => link.sendBinary(buf),
      isGated: () => performance.now() < synth.busyUntil + 250,
      onLevel: (lvl) => { $('ring').style.transform = `scale(${1 + Math.min(0.25, lvl * 0.8)})`; },
    });
    await mic.start();
    wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    link.send({ type: 'call.start' });
  } catch (e) {
    banner(`Microphone: ${e.message}`);
    mic?.stop();
    mic = null;
    setCall('idle');
  }
}

function endCall() {
  link.send({ type: 'call.end' });
  mic?.stop();
  mic = null;
  wakeLock?.release?.();
  wakeLock = null;
  setCall('idle');
}

$('call').onclick = () => (callState === 'idle' ? startCall() : endCall());
link.on('call', ({ state, detail, audio }) => {
  if (!audio) return; // a typed Lab session, not this phone's call
  if (state === 'live' && mic) setCall('live');
  if (state === 'ended' || state === 'error') { if (mic) { mic.stop(); mic = null; } setCall('idle', state === 'error' ? detail : (detail === 'hung up' ? '' : detail)); }
});

// ---- what Sesame heard and is doing
link.on('speech', ({ state }) => { if (state === 'start') $('heard').innerHTML = '<span class="muted">…</span>'; });
link.on('heard', ({ text, typed }) => { const h = $('heard'); h.textContent = text; h.classList.toggle('typed', !!typed); });
link.on('act', ({ steps }) => {
  $('acts').replaceChildren(...steps.map((s) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.dataset.behavior = s.behavior;
    c.textContent = s.behavior.replace(/_/g, ' ') + (s.seconds ? ` ${s.seconds}s` : '');
    return c;
  }));
});
link.on('step', ({ behavior, state }) => {
  const c = $('acts').querySelector(`[data-behavior="${CSS.escape(behavior)}"]:not(.done)`);
  if (!c) return;
  c.classList.toggle('active', state === 'start');
  if (state !== 'start') c.classList.add('done');
});

// ---- quick buttons (no talking needed)
function renderQuick(info) {
  const names = Object.entries(info.behaviors).filter(([n, b]) => !b.auto && n !== 'ignore').map(([n]) => n);
  $('quick').replaceChildren(...names.map((n) => {
    const b = document.createElement('button');
    b.textContent = n.replace(/_/g, ' ');
    b.onclick = () => { synth.unlock(); link.send({ type: 'act', steps: [{ behavior: n }] }); };
    return b;
  }));
}

// ---- toggles
$('sound').onclick = () => {
  synth.unlock();
  synth.enabled = !synth.enabled;
  $('sound').textContent = synth.enabled ? '🔊' : '🔈';
};
$('toggle3d').onclick = () => {
  const v = $('view');
  const hidden = v.dataset.flat === '1';
  v.dataset.flat = hidden ? '0' : '1';
  const canvas = v.querySelector('canvas:not(.oled)');
  if (canvas) canvas.style.visibility = hidden ? 'visible' : 'hidden';
  const oled = $('oled');
  Object.assign(oled.style, hidden ? { width: '', left: '', top: '', right: '', bottom: '', transform: '' } : { width: '86%', left: '50%', top: '50%', right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)', maxWidth: '520px' });
};
document.addEventListener('pointerdown', () => synth.unlock(), { once: true });
