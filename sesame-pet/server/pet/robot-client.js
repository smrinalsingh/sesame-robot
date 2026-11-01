// Talks to a robot over its HTTP API. The simulator and the real robot expose
// the same API, so this is the only robot driver there is.
export class RobotClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
    this.online = null;
  }

  async request(path, init = {}, timeoutMs = 2500) {
    try {
      const res = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      this.online = true;
      if (!res.ok) throw new Error(`robot ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (e.name === 'TimeoutError' || e.cause?.code) this.online = false;
      throw e;
    }
  }

  command(body) {
    return this.request('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  status() { return this.request('/api/status'); }

  servo(index, angle) { return this.request(`/cmd?motor=${index + 1}&value=${Math.round(angle)}`); }

  // Resolves once the robot has finished its current command.
  async waitIdle({ timeoutMs = 30000, isCancelled = () => false } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (isCancelled()) return 'cancelled';
      const s = await this.status().catch(() => null);
      if (s && s.currentCommand === '') return 'idle';
      await new Promise((r) => setTimeout(r, 120));
    }
    return 'timeout';
  }
}
