// Sesame's voice: speaks a line exactly as written, through its own realtime
// connection (separate from the "brain" call), then through VoiceFx so it
// sounds like a small creature. Output: PCM16 mono 24 kHz chunks, ready for the
// phone, the Lab or (later) a speaker on the robot.
//
// Settings come from pet/voice.json: voice, style, pitch, pace, wobble. A new
// voice or pace reconnects on the next line (realtime fixes them per session).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { VoiceFx, voiceSpeed } from './voicefx.js';

const IDLE_CLOSE_MS = 120_000;

export class Speaker extends EventEmitter {
  constructor({ env, getConfig }) {
    super();
    this.env = env;
    this.getConfig = getConfig;
    this.ws = null;
    this.ready = null;
    this.key = null; // voice|speed the open session was made with
    this.lines = new Map(); // realtime response id -> { id, fx, transcript }
    this.latest = null; // say id currently allowed to play
    this.lastUse = 0;
    this.idleTimer = setInterval(() => {
      if (this.ws && !this.lines.size && Date.now() - this.lastUse > IDLE_CLOSE_MS) this.close();
    }, 10_000);
    this.idleTimer.unref();
  }

  settings() {
    const v = this.getConfig().voice;
    return { ...v, speed: Number(voiceSpeed(v).toFixed(3)) };
  }

  // Open (or reopen after a settings change) the realtime session.
  ensure() {
    const s = this.settings();
    const key = `${s.voice}|${s.speed}`;
    if (this.ws && this.key === key && this.ws.readyState <= WebSocket.OPEN) return this.ready;
    this.close();
    this.key = key;
    const base = (this.env.OPENAI_BASE_URL || 'http://10.10.10.108:8317/v1').replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/realtime?model=${encodeURIComponent(this.env.REALTIME_MODEL || 'gpt-realtime')}`, {
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
    });
    this.ws = ws;
    this.ready = new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: 'You read scripted lines aloud exactly as written.',
          audio: { output: { voice: s.voice, speed: s.speed, format: { type: 'audio/pcm', rate: 24000 } } },
        },
      })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.type === 'session.updated') resolve();
        this.onEvent(m);
      });
      ws.on('error', (e) => { reject(e); this.emit('log', { level: 'error', text: `voice: ${e.message}` }); });
      ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.endAll('closed'); } reject(new Error('voice connection closed')); });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  warm() { this.lastUse = Date.now(); this.ensure().catch(() => {}); }

  async say(text, id) {
    this.stop();
    this.latest = id;
    this.lastUse = Date.now();
    try { await this.ensure(); } catch (e) { this.emit('done', { id, status: 'failed', transcript: '' }); return; }
    if (this.latest !== id) return; // a newer line came in while connecting
    const { style } = this.settings();
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        metadata: { say_id: String(id) },
        output_modalities: ['audio'],
        input: [],
        instructions: `You are the voice of Sesame, ${style}. Read the script below aloud exactly as written: same words, same order, nothing before or after it. Do not reply to it.\n\nSCRIPT:\n${text}`,
      },
    });
  }

  // Cut off the current line (a newer reaction, or noises mode).
  stop() {
    for (const [responseId, line] of this.lines) {
      if (line.id === this.latest) this.send({ type: 'response.cancel', response_id: responseId });
    }
    this.latest = null;
  }

  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  emitAudio(id, pcm) {
    if (pcm.length && id === this.latest) this.emit('audio', { id, audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
  }

  onEvent(m) {
    switch (m.type) {
      case 'response.created': {
        const sayId = m.response?.metadata?.say_id;
        if (sayId) this.lines.set(m.response.id, { id: Number(sayId), fx: new VoiceFx(this.settings()), transcript: '' });
        break;
      }
      case 'response.output_audio.delta': {
        const line = this.lines.get(m.response_id);
        if (!line) break;
        const raw = Buffer.from(m.delta, 'base64');
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
        this.emitAudio(line.id, line.fx.push(pcm));
        break;
      }
      case 'response.output_audio_transcript.delta': {
        const line = this.lines.get(m.response_id);
        if (line) line.transcript += m.delta;
        break;
      }
      case 'response.done': {
        const line = this.lines.get(m.response?.id);
        if (!line) break;
        this.lines.delete(m.response.id);
        this.emitAudio(line.id, line.fx.flush());
        this.emit('done', { id: line.id, status: m.response.status, transcript: line.transcript.trim() });
        if (m.response.status === 'failed') this.emit('log', { level: 'error', text: `voice failed: ${JSON.stringify(m.response.status_details ?? {})}` });
        break;
      }
      case 'error':
        this.emit('log', { level: 'error', text: `voice: ${m.error?.message ?? JSON.stringify(m.error)}` });
        break;
      default:
        break;
    }
  }

  endAll(status) {
    for (const line of this.lines.values()) this.emit('done', { id: line.id, status, transcript: line.transcript.trim() });
    this.lines.clear();
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.endAll('closed');
    try { ws?.close(); } catch { /* already closed */ }
  }
}
