// Diagnostic: checks that gpt-realtime (via the proxy) accepts a tools-only,
// text-output session and answers a typed "user said" turn with a tool call.
// Usage: node scripts/realtime-probe.js "wave at me"
import WebSocket from 'ws';
import { loadEnv } from '../server/env.js';

const env = loadEnv();
const said = process.argv[2] || 'hey buddy, wave at me!';
const url = env.OPENAI_BASE_URL.replace(/^http/, 'ws') + '/realtime?model=' + (env.REALTIME_MODEL || 'gpt-realtime');

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);

ws.on('open', () => {
  log('open');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['text'],
      instructions: 'You are the mind of a small pet robot spider. You never speak. You react only by calling act().',
      tools: [{
        type: 'function', name: 'act', description: 'Perform pet behaviors in order.',
        parameters: {
          type: 'object',
          properties: { steps: { type: 'array', items: { type: 'object', properties: {
            behavior: { type: 'string', enum: ['wave', 'dance', 'walk_forward', 'happy', 'confused', 'ignore'] },
            seconds: { type: 'number' } }, required: ['behavior'] } } },
          required: ['steps'],
        },
      }],
      tool_choice: 'required',
    },
  }));
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: said }] } }));
  ws.send(JSON.stringify({ type: 'response.create' }));
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'response.function_call_arguments.done') log('TOOL', m.name, m.arguments);
  else if (m.type === 'error') log('ERROR', JSON.stringify(m.error));
  else if (m.type === 'session.updated') log('session.updated', JSON.stringify({ out: m.session.output_modalities, tools: m.session.tools?.length, tool_choice: m.session.tool_choice }));
  else if (m.type === 'response.output_text.delta' || m.type.endsWith('.delta')) { /* skip deltas */ }
  else log(m.type);
  if (m.type === 'response.done' || m.type === 'error') { ws.close(); }
});
ws.on('close', (c, r) => { log('closed', c, String(r)); process.exit(0); });
ws.on('error', (e) => { log('ws error', e.message); process.exit(1); });
