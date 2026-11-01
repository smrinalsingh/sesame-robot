import { HubLink, attachRobotView } from './hub.js';
import { decodeFace, drawOled } from './viewer.js';
import { recipeToWav } from './synth.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

const link = new HubLink('lab');
const view = await attachRobotView(link, { viewEl: $('view'), oledCanvas: $('oled') });
const { synth, voice } = view;
window.sesame = view; // handy from the browser console
let info = null;
let selectedSound = null;
let servoInputs = [];

// ---- tabs
$('tabs').onclick = (e) => {
  const t = e.target.dataset.tab;
  if (!t) return;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === `tab-${t}`);
};

// ---- log
function log(cls, text) {
  const line = el('div', { className: cls });
  line.append(el('time', { textContent: new Date().toLocaleTimeString() }), text);
  const box = $('log');
  const stick = box.parentElement.scrollTop + box.parentElement.clientHeight >= box.parentElement.scrollHeight - 30;
  box.append(line);
  while (box.childElementCount > 600) box.firstChild.remove();
  if (stick) box.parentElement.scrollTop = box.parentElement.scrollHeight;
}
$('clearLog').onclick = () => $('log').replaceChildren();

// ---- connection + status
link.on('open', () => { $('link').className = 'dot on'; });
link.on('close', () => { $('link').className = 'dot off'; $('mode').textContent = 'hub offline'; });
link.on('hello', ({ info: i }) => { render(i); log('', `connected: ${i.mode === 'sim' ? 'simulator' : `robot ${i.robotUrl}`}`); });
link.on('firmware', (m) => {
  if (m.ok) { render(m.info); flash($('fwStatus')); log('a', 'firmware reloaded'); } else { showFwError(m.error); log('e', `firmware: ${m.error}`); }
});
link.on('config', (m) => { render(m.info); log('a', 'pet config reloaded'); });
link.on('robot', ({ online }) => { $('mode').textContent = `robot ${online ? 'online' : 'OFFLINE'}`; });

function flash(node) { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); }
function showFwError(err) {
  $('fwStatus').innerHTML = '<span class="dot off"></span> firmware error';
  $('fwNotice').replaceChildren(el('div', { className: 'notice err', textContent: `${err}\n\nThe simulator keeps running the last version that loaded.` }));
}

function render(i) {
  info = i;
  showVoiceMode(i.voice?.mode);
  $('mode').textContent = i.mode === 'sim' ? 'simulator' : `robot ${i.robotUrl}`;
  if (i.firmwareError) showFwError(i.firmwareError);
  else { $('fwStatus').innerHTML = `<span class="dot on"></span> firmware loaded ${new Date().toLocaleTimeString()}`; $('fwNotice').replaceChildren(); }
  renderMoves(i);
  renderBehaviors(i);
  renderFaces();
  renderSounds(i);
  renderVoice(i);
  renderServos(i);
}

// ---- moves (firmware dispatch table)
function renderMoves(i) {
  $('moveCount').textContent = `(${i.commands.length})`;
  $('moves').replaceChildren(...i.commands.map((c) => {
    const b = el('button', { innerHTML: `${c.name}<small>${c.fn}${c.continuous ? ' · walks' : ''}</small>` });
    b.dataset.cmd = c.name;
    b.onclick = () => { synth.unlock(); link.send({ type: 'robot', body: { command: c.name } }); };
    return b;
  }));
}
$('stopBtn').onclick = () => link.send({ type: 'robot', body: { command: 'stop' } });
link.on('run', ({ command }) => {
  $('cmd').textContent = command;
  for (const b of $('moves').children) b.classList.toggle('running', b.dataset.cmd === command);
});
link.on('done', () => {
  $('cmd').textContent = 'idle';
  for (const b of $('moves').children) b.classList.remove('running');
});
link.on('face', ({ name }) => { $('faceName').textContent = `face: ${name}`; });

// ---- behaviors
function renderBehaviors(i) {
  $('warnings').replaceChildren(...(i.warnings.length ? [el('div', { className: 'notice warn', textContent: i.warnings.join('\n') })] : []));
  $('behaviors').replaceChildren(...Object.entries(i.behaviors).map(([name, b]) => {
    const parts = [b.command && `move: ${b.command}`, b.face && `face: ${b.face}`, b.sound && `sound: ${b.sound}`, b.seconds && `${b.seconds}s`, b.auto && 'auto from firmware'].filter(Boolean);
    const row = el('div', { className: 'behavior' });
    const run = el('button', { textContent: 'Try' });
    run.onclick = () => { synth.unlock(); link.send({ type: 'act', steps: [{ behavior: name }] }); };
    row.append(el('b', { textContent: name }), run, el('div', { className: 'meta', textContent: `${b.when ?? ''}${parts.length ? ` — ${parts.join(' · ')}` : ''}` }));
    return row;
  }));
}

// ---- faces
async function renderFaces() {
  const { faces } = await (await fetch('/api/faces')).json();
  $('faces').replaceChildren(...info.faceList.map((name) => {
    const b = el('button', { title: name });
    const c = el('canvas', { width: 128, height: 64 });
    const first = faces[name]?.[0];
    if (first) drawOled(c, decodeFace(first));
    b.append(c, `${name}${faces[name]?.length > 1 ? ` · ${faces[name].length}f` : faces[name]?.length ? '' : ' · no image'}`);
    b.onclick = () => link.send({ type: 'robot', body: { face: name } });
    return b;
  }));
}

// ---- sounds
function renderSounds(i) {
  const users = {};
  for (const [n, b] of Object.entries(i.behaviors)) if (b.sound) (users[b.sound] ??= []).push(n);
  $('soundList').replaceChildren(...Object.keys(i.sounds).map((name) => {
    const row = el('div', { className: `sound-row${name === selectedSound ? ' sel' : ''}` });
    const tags = [i.firmwareSounds.includes(name) ? 'firmware' : null, ...(users[name] ?? [])].filter(Boolean);
    row.append(el('span', { textContent: '▶' }), el('span', { className: 'name', textContent: name }), el('span', { className: 'tag', textContent: tags.join(', ') }));
    row.onclick = () => { synth.unlock(); selectSound(name); synth.play(name); };
    return row;
  }));
  if (!selectedSound) selectSound(Object.keys(i.sounds)[0]);
}

function selectSound(name) {
  selectedSound = name;
  $('soundName').textContent = name ? `— ${name}` : '';
  $('recipe').value = name ? JSON.stringify(info.sounds[name], null, 2) : '';
  $('recipeMsg').textContent = '';
  for (const r of $('soundList').children) r.classList.toggle('sel', r.querySelector('.name').textContent === name);
}

function parseRecipe() {
  try { return JSON.parse($('recipe').value); } catch (e) { $('recipeMsg').textContent = `JSON error: ${e.message}`; return null; }
}
$('playRecipe').onclick = () => { synth.unlock(); const r = parseRecipe(); if (r) { synth.play(selectedSound, r); $('recipeMsg').textContent = ''; } };
$('saveRecipe').onclick = async () => {
  const r = parseRecipe();
  if (!r || !selectedSound) return;
  const sounds = { ...info.sounds, [selectedSound]: r };
  const res = await fetch('/api/sounds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sounds }) });
  $('recipeMsg').textContent = res.ok ? 'saved to pet/sounds.json' : `save failed: ${await res.text()}`;
};
$('newSound').onclick = () => {
  const name = prompt('Name for the new sound (letters, digits, _):');
  if (!name || !/^\w+$/.test(name)) return;
  info.sounds[name] = { gain: 0.6, variation: 0.05, layers: [{ wave: 'sine', dur: 0.15, freq: [[0, 1500], [1, 2500]], amp: [[0, 0], [0.1, 1], [1, 0]], vol: 0.8 }] };
  renderSounds(info);
  selectSound(name);
  $('recipeMsg').textContent = 'not saved yet';
};
$('wav').onclick = async () => {
  const r = parseRecipe();
  if (!r) return;
  const a = el('a', { href: URL.createObjectURL(await recipeToWav(r)), download: `${selectedSound}.wav` });
  a.click();
};
$('soundOn').onchange = (e) => { synth.unlock(); synth.enabled = e.target.checked; if (!synth.enabled) voice.stop(); };
link.on('sound', ({ name, muted }) => log('s', `♪ ${name}${muted ? ' (muted: words mode)' : ''}`));

// ---- noises or words
function showVoiceMode(mode) {
  for (const b of $('voiceMode').children) b.classList.toggle('on', b.dataset.mode === mode);
}
$('voiceMode').onclick = (e) => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (!mode) return;
  synth.unlock();
  showVoiceMode(mode);
  link.send({ type: 'voice.mode', mode });
};
link.on('voice.mode', ({ mode }) => { showVoiceMode(mode); log('a', `Sesame now answers with ${mode}`); });
link.on('say', ({ text, spoken }) => log('h', `Sesame ${spoken ? 'says' : '(noises)'}: "${text}"`));

// ---- voice tuner (words mode)
const knobs = {
  pitch: ['vPitch', (v) => `+${Number(v)} st`],
  pace: ['vPace', (v) => `${Number(v).toFixed(2)}×`],
  wobble: ['vWobble', (v) => `${Number(v).toFixed(2)} st`],
};
function renderVoice(i) {
  const { voice: v, voiceOptions: o } = i;
  if (!v || !o) return;
  if (!$('vVoice').options.length) $('vVoice').replaceChildren(...o.voices.map((n) => el('option', { value: n, textContent: n })));
  for (const [k, [id, fmt]] of Object.entries(knobs)) {
    const input = $(id);
    [input.min, input.max] = o.ranges[k];
    if (document.activeElement !== input) input.value = v[k];
    input.nextElementSibling.textContent = fmt(input.value);
  }
  if (document.activeElement !== $('vVoice')) $('vVoice').value = v.voice;
  if (document.activeElement !== $('vStyle')) $('vStyle').value = v.style;
}
const tryLine = () => { synth.unlock(); link.send({ type: 'voice.try', text: $('tryLine').value }); };
function setVoice(patch) {
  synth.unlock();
  link.send({ type: 'voice.set', voice: patch });
  if ($('tryOnChange').checked) tryLine();
}
for (const [k, [id, fmt]] of Object.entries(knobs)) {
  const input = $(id);
  input.oninput = () => { input.nextElementSibling.textContent = fmt(input.value); };
  input.onchange = () => setVoice({ [k]: Number(input.value) });
}
$('vVoice').onchange = () => setVoice({ voice: $('vVoice').value });
$('vStyle').onchange = () => setVoice({ style: $('vStyle').value });
$('tryForm').onsubmit = (e) => { e.preventDefault(); tryLine(); };
link.on('voice.settings', ({ voice }) => { if (info) { info.voice = voice; renderVoice(info); } });

// ---- servos
function renderServos(i) {
  if (servoInputs.length) return;
  $('servos').replaceChildren(...i.servoNames.map((name, ch) => {
    const row = el('div', { className: 'servo' });
    const val = el('span', { textContent: '—' });
    const input = el('input', { type: 'range', min: 0, max: 180, value: i.state.servos[ch] ?? 90 });
    input.oninput = () => { val.textContent = input.value; link.send({ type: 'servo', index: ch, angle: Number(input.value) }); };
    servoInputs[ch] = { input, val };
    row.append(el('span', { textContent: name }), input, val);
    return row;
  }));
}
link.on('servo', ({ ch, angle }) => {
  const s = servoInputs[ch];
  if (s && document.activeElement !== s.input) { s.input.value = angle; s.val.textContent = angle; }
});
$('all90').onclick = () => servoInputs.forEach((_, ch) => link.send({ type: 'servo', index: ch, angle: 90 }));

// ---- talking (typed) + call status + events
$('talk').onsubmit = (e) => {
  e.preventDefault();
  const text = $('say').value.trim();
  if (!text) return;
  synth.unlock();
  link.send({ type: 'text', text });
  $('say').value = '';
};
link.on('call', ({ state, detail, audio }) => {
  $('callStatus').innerHTML = state === 'live' ? `<span class="dot on"></span> ${audio ? 'phone call live' : 'AI session live'}` : state === 'connecting' ? 'AI connecting…' : '';
  log(state === 'error' ? 'e' : 'h', `${audio ? 'call' : 'AI session'} ${state}${detail ? `: ${detail}` : ''}`);
});
link.on('heard', ({ text, typed }) => log('h', `${typed ? 'typed' : 'heard'}: "${text}"`));
link.on('act', ({ steps, source }) => log('a', `${source} → ${steps.map((s) => s.behavior + (s.seconds ? `(${s.seconds}s)` : '')).join(' → ')}`));
link.on('step', ({ behavior, state, error }) => { if (state === 'error') log('e', `${behavior}: ${error}`); });
link.on('log', ({ level, text }) => log(level === 'error' ? 'e' : level === 'warn' ? 'w' : '', text));
link.on('serial', ({ text }) => { if ($('showSerial').checked) log('', `serial: ${text}`); });
document.addEventListener('pointerdown', () => synth.unlock(), { once: true });
