// Minimal MCP stdio client. Spawns a child process speaking the MCP
// JSON-RPC protocol over stdin/stdout, multiplexes requests by id, and
// exposes a simple `callTool(name, args)` API that returns the tool's
// content payload.
//
// We don't pull in @modelcontextprotocol/sdk — the protocol surface we
// need is small and a hand-rolled client keeps native deps to zero.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const PROTOCOL_VERSION = '2024-11-05';

class StdioMcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.command   executable path (e.g. 'python')
   * @param {string[]} opts.args    args (e.g. ['scheduler_mcp.py'])
   * @param {object} [opts.env]
   * @param {string} [opts.cwd]
   * @param {string} [opts.label]   used in log lines
   */
  constructor({ command, args, env = {}, cwd, label = 'mcp' }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.label = label;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buf = '';
    this.ready = false;
    this.toolList = null;
    this.startedAt = 0;
    this.crashed = false;
  }

  async start({ timeoutMs = 10_000 } = {}) {
    if (this.child) return;
    this.startedAt = Date.now();
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      // Forward stderr lines so logs are visible.
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) console.log(`[${this.label}:stderr] ${line}`);
      }
    });
    this.child.on('error', (e) => {
      console.error(`[${this.label}] spawn error:`, e.message);
      this.crashed = true;
      this._failAllPending(new Error(`spawn ${this.command} failed: ${e.message}`));
    });
    this.child.on('exit', (code, signal) => {
      console.log(`[${this.label}] exited code=${code} signal=${signal}`);
      this.crashed = true;
      this.ready = false;
      this._failAllPending(new Error(`mcp server exited (code ${code})`));
      this.emit('exit', { code, signal });
    });

    // Initialize handshake
    const init = await this._send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'easydeal-client', version: '0.1.0' },
    }, timeoutMs);
    this._sendNotification('notifications/initialized', {});
    this.ready = true;
    this.emit('ready', init);
    return init;
  }

  async listTools() {
    if (this.toolList) return this.toolList;
    const r = await this._send('tools/list', {});
    // Return full tool descriptors (name + description + inputSchema). The
    // length is unchanged, so any caller that just used .length still works.
    this.toolList = r?.tools || [];
    return this.toolList;
  }

  /**
   * Call a tool. Tools in this codebase return `{ok, data}` or
   * `{ok:false, error}` JSON envelopes — we parse and unwrap that here so
   * callers get the inner payload directly. If the tool returned plain
   * text (no envelope), we hand it back as-is.
   */
  async callTool(name, args = {}, { timeoutMs = 60_000 } = {}) {
    const r = await this._send('tools/call', { name, arguments: args }, timeoutMs);
    const blocks = r?.content || [];
    // Concatenate text content blocks
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text) return null;
    // Try to parse as our standard envelope
    try {
      const env = JSON.parse(text);
      if (env && typeof env === 'object' && 'ok' in env) {
        if (env.ok) return env.data;
        const err = new Error(env.error || 'tool error');
        err.code = 'TOOL_ERROR';
        throw err;
      }
      return env; // valid JSON but not our envelope
    } catch (e) {
      if (e.code === 'TOOL_ERROR') throw e;
      return text; // plain text response
    }
  }

  async stop({ timeoutMs = 3000 } = {}) {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try { this.child.kill('SIGKILL'); } catch {}
        resolve();
      }, timeoutMs);
      this.child.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.child.kill('SIGTERM'); } catch {}
    });
  }

  // ---------- internal ----------

  _send(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.crashed) {
        return reject(new Error('mcp client not running'));
      }
      const id = this.nextId++;
      const msg = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`mcp write failed: ${e.message}`));
      }
    });
  }

  _sendNotification(method, params) {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { console.warn(`[${this.label}] non-JSON line: ${line.slice(0, 200)}`); continue; }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.id === undefined || msg.id === null) {
      // Notification or unsolicited message — emit so listeners can react.
      this.emit('notification', msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) {
      console.warn(`[${this.label}] reply with unknown id ${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const err = new Error(msg.error.message || 'mcp error');
      err.code = msg.error.code;
      err.data = msg.error.data;
      return p.reject(err);
    }
    p.resolve(msg.result);
  }

  _failAllPending(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { StdioMcpClient };
