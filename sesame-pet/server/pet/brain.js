// One live voice "call" with gpt-realtime through the proxy. Every reply is an
// act() tool call: a short line (`say`) plus behaviors. The conversation is
// text-only; when the owner wants words, the Speaker voices the line.
// Audio in: PCM16 mono 24 kHz from the phone. Typed text works too (Lab).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { actTool } from './config.js';

const IDLE_HANGUP_MS = 120_000;

export class BrainSession extends EventEmitter {
  constructor({ env, getConfig }) {
    super();
    this.env = env;
    this.getConfig = getConfig;
    this.transcription = true;
    this.lastSpeech = Date.now();
    this.closed = false;
  }

  sessionConfig() {
    const cfg = this.getConfig();
    const input = {
      format: { type: 'audio/pcm', rate: 24000 },
      turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 300, silence_duration_ms: 450, create_response: true, interrupt_response: true },
    };
    // Captions only (the model hears the audio itself). The prompt keeps Hinglish in Latin letters.
    if (this.transcription) input.transcription = { model: 'gpt-4o-mini-transcribe', prompt: 'Casual English or Hinglish (Hindi written in Latin letters), talking to a robot pet named Sesame.' };
    return {
      type: 'realtime',
      output_modalities: ['text'],
      instructions: cfg.personality,
      tools: [actTool(cfg)],
      tool_choice: 'required',
      audio: { input },
    };
  }

  start() {
    const base = (this.env.OPENAI_BASE_URL || 'http://10.10.10.108:8317/v1').replace(/^http/, 'ws');
    const url = `${base}/realtime?model=${encodeURIComponent(this.env.REALTIME_MODEL || 'gpt-realtime')}`;
    this.emit('state', { state: 'connecting' });
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` } });
    this.ws.on('open', () => this.send({ type: 'session.update', session: this.sessionConfig() }));
    this.ws.on('message', (raw) => this.onEvent(JSON.parse(raw)));
    this.ws.on('close', (code, reason) => this.end(`closed (${code}${reason?.length ? ` ${reason}` : ''})`));
    this.ws.on('error', (e) => { this.emit('state', { state: 'error', detail: e.message }); this.end(e.message); });
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastSpeech > IDLE_HANGUP_MS) this.end('no one talked for 2 minutes');
    }, 5000);
    return this;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  appendAudio(pcm16) {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm16).toString('base64') });
  }

  sendText(text) {
    this.lastSpeech = Date.now();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
  }

  refreshConfig() { this.send({ type: 'session.update', session: this.sessionConfig() }); }

  onEvent(m) {
    switch (m.type) {
      case 'session.updated':
        if (!this.live) { this.live = true; this.emit('state', { state: 'live' }); }
        break;
      case 'input_audio_buffer.speech_started':
        this.lastSpeech = Date.now();
        this.emit('speech', { state: 'start' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech', { state: 'stop' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (m.transcript?.trim()) this.emit('heard', { text: m.transcript.trim() });
        break;
      case 'response.function_call_arguments.done': {
        let args = {};
        try { args = JSON.parse(m.arguments); } catch { /* ignore */ }
        const steps = Array.isArray(args.steps) ? args.steps.filter((s) => s && typeof s.behavior === 'string') : [];
        const say = typeof args.say === 'string' ? args.say.trim().slice(0, 200) : '';
        this.emit('act', { steps, say });
        // Close the loop without asking for another response (the pet stays quiet).
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: m.call_id, output: '{"ok":true}' } });
        break;
      }
      case 'error': {
        const msg = m.error?.message ?? JSON.stringify(m.error);
        if (this.transcription && /transcription/i.test(msg + (m.error?.param ?? ''))) {
          this.transcription = false; // proxy/account without transcription: carry on without captions
          this.emit('log', { level: 'warn', text: `transcription unavailable (${msg}); continuing without captions` });
          this.refreshConfig();
          break;
        }
        this.emit('log', { level: 'error', text: `realtime: ${msg}` });
        break;
      }
      default:
        break;
    }
  }

  end(reason = 'ended') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.idleTimer);
    try { this.ws?.close(); } catch { /* already closed */ }
    this.emit('state', { state: 'ended', detail: reason });
  }
}
