'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Codex CLI's turn/start protocol rejects any prompt above exactly 1 MiB
// characters, regardless of the selected model's advertised token window.
// A user-level context setting may be larger, but the local broker must never
// forward a value that disables protection beyond this transport hard limit.
const CODEX_CLI_MAX_INPUT_CHARS = 1_048_576;
const CODEX_BRIDGE_DEFAULT_CONTEXT_CHARS = 600_000;


function _isFile(candidate) {
  if (!candidate) return false;
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function resolveCodexBin(explicit = '') {
  const configured = String(explicit || process.env.EASYDEAL_CODEX_BIN || '').trim();
  if (_isFile(configured)) return path.resolve(configured);

  const names = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex'];
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    for (const name of names) candidates.push(path.join(process.env.APPDATA, 'npm', name));
  }
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ''), name));
  }
  for (const candidate of candidates) {
    if (_isFile(candidate)) return path.resolve(candidate);
  }

  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(locator, ['codex'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      if (_isFile(line.trim())) return path.resolve(line.trim());
    }
  } catch {}
  return null;
}

function resolvePythonBin(explicit = '') {
  const configured = String(explicit || '').trim();
  if (_isFile(configured)) return path.resolve(configured);
  if (configured && /[\\/]/.test(configured)) return null;

  const command = configured || (process.platform === 'win32' ? 'python' : 'python3');
  const names = process.platform === 'win32'
    ? Array.from(new Set([command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]))
    : Array.from(new Set([command, 'python3', 'python']));
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      if (_isFile(candidate)) return path.resolve(candidate);
    }
  }

  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(locator, [command], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      if (_isFile(line.trim())) return path.resolve(line.trim());
    }
  } catch {}
  return null;
}

function _reservePort(preferred = 51281) {
  const attempt = (port) => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  return attempt(preferred).catch(() => attempt(0));
}

function _health(baseUrl, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/health`, {
      method: 'GET',
      headers: { 'x-api-key': token },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = JSON.parse(raw); } catch { body = { detail: raw.slice(0, 500) }; }
        resolve({ http_status: res.statusCode || 0, ...body });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Codex CLI bridge health check timed out')));
    req.once('error', reject);
    req.end();
  });
}

function _normalizeRuntime(runtime = {}) {
  const proxyMode = ['auto', 'manual', 'off'].includes(runtime.proxyMode)
    ? runtime.proxyMode : 'auto';
  const requestedContextChars = Number(runtime.contextChars);
  const requestedOrDefault = Number.isInteger(requestedContextChars)
    && requestedContextChars >= 64_000 && requestedContextChars <= 4_000_000
    ? requestedContextChars : CODEX_BRIDGE_DEFAULT_CONTEXT_CHARS;
  const contextChars = Math.min(requestedOrDefault, CODEX_CLI_MAX_INPUT_CHARS);
  return {
    model: String(runtime.model || '').trim(),
    proxyMode,
    proxyUrl: proxyMode === 'manual' ? String(runtime.proxyUrl || '').trim() : '',
    contextChars,
  };
}

function _applyProxyEnv(env, runtime) {
  if (runtime.proxyMode === 'manual') {
    if (!runtime.proxyUrl) throw new Error('Codex CLI 手动代理地址为空');
    env.HTTPS_PROXY = runtime.proxyUrl;
    env.HTTP_PROXY = runtime.proxyUrl;
    env.https_proxy = runtime.proxyUrl;
    env.http_proxy = runtime.proxyUrl;
    env.NO_PROXY = 'localhost,127.0.0.1,::1,.local';
    env.no_proxy = env.NO_PROXY;
  } else if (runtime.proxyMode === 'off') {
    env.HTTPS_PROXY = '';
    env.HTTP_PROXY = '';
    env.https_proxy = '';
    env.http_proxy = '';
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  return env;
}

function _killProcessTree(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { child.kill('SIGTERM'); } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, shell: false,
      });
      killer.once('close', finish);
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      });
    } catch {
      try { child.kill('SIGKILL'); } catch {}
      finish();
    }
    const timer = setTimeout(finish, 5000);
    timer.unref?.();
  });
}


class CodexCliBridge {
  constructor({ pythonBin, scriptPath, workspaceDir, codexBin = '', log = null } = {}) {
    this.pythonBin = pythonBin || 'python';
    this.scriptPath = scriptPath || '';
    this.workspaceDir = workspaceDir || '';
    this.codexBin = codexBin || '';
    this.log = typeof log === 'function' ? log : () => {};
    this.child = null;
    this.port = null;
    this.token = null;
    this.baseUrl = null;
    this._startPromise = null;
    this._lastOutput = '';
    this._runtime = _normalizeRuntime();
    this._runtimeKey = '';
  }

  _validate() {
    const python = resolvePythonBin(this.pythonBin);
    if (!python) throw new Error(`内置 Python 不存在: ${this.pythonBin}`);
    if (!_isFile(this.scriptPath)) throw new Error(`Codex CLI bridge 脚本不存在: ${this.scriptPath}`);
    try {
      if (!fs.statSync(this.workspaceDir).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`EasyDeal 工作目录不存在: ${this.workspaceDir}`);
    }
    const codex = resolveCodexBin(this.codexBin);
    if (!codex) {
      throw new Error('未找到 Codex CLI；请先安装 Codex CLI，并运行 codex login 完成登录');
    }
    return { codex, python };
  }

  async start(runtime = {}) {
    const normalized = _normalizeRuntime(runtime);
    const runtimeKey = JSON.stringify(normalized);
    if (this._startPromise) {
      const pending = await this._startPromise;
      if (this._runtimeKey === runtimeKey) return pending;
    }
    if (this._runtimeKey && this._runtimeKey !== runtimeKey) await this.stop();
    if (this.child && this.child.exitCode == null && this.baseUrl && this.token) {
      try {
        const status = await _health(this.baseUrl, this.token);
        if (status.http_status === 200 && status.ok) return this._publicResult(status);
      } catch {}
    }
    this._startPromise = this._start(normalized, runtimeKey).finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _start(runtime, runtimeKey) {
    await this.stop();
    const { codex, python } = this._validate();
    this.port = await _reservePort(51281);
    this.token = crypto.randomBytes(48).toString('base64url');
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this._lastOutput = '';

    this._runtime = runtime;
    this._runtimeKey = runtimeKey;
    const env = _applyProxyEnv({
      ...process.env,
      EASYDEAL_CODEX_BRIDGE_TOKEN: this.token,
      EASYDEAL_CODEX_BIN: codex,
      EASYDEAL_CODEX_WORKSPACE: this.workspaceDir,
      EASYDEAL_CODEX_SANDBOX: 'read-only',
      EASYDEAL_CODEX_MODEL: runtime.model,
      EASYDEAL_CODEX_PROXY_MODE: runtime.proxyMode,
      EASYDEAL_CODEX_MAX_CONTEXT_CHARS: String(runtime.contextChars),
      // UTF-8 最坏 4 bytes/char，再给工具 schema / JSON 包装留 1MB。
      EASYDEAL_CODEX_MAX_BODY_BYTES: String(Math.max(8_000_000, runtime.contextChars * 4 + 1_000_000)),
      EASYDEAL_CODEX_PORT: String(this.port),
      PYTHONUNBUFFERED: '1',
    }, runtime);
    const child = spawn(python, [this.scriptPath], {
      cwd: this.workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    const capture = (chunk) => {
      const text = String(chunk || '');
      this._lastOutput = (this._lastOutput + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.log(line.trim());
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) => {
      const message = error?.message || String(error);
      this._lastOutput = (this._lastOutput + message).slice(-4000);
      this.log(`bridge process error: ${message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.token = null;
        this.baseUrl = null;
      }
      this.log(`bridge exited code=${code} signal=${signal || '-'}`);
    });

    let lastError = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode != null) break;
      try {
        const status = await _health(this.baseUrl, this.token, 3000);
        if (status.http_status === 200) {
          if (!status.ok || !status.login_ok) {
            throw new Error(status.detail || status.error || 'Codex CLI 尚未登录');
          }
          return this._publicResult(status);
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = this._lastOutput.trim().slice(-800);
    await this.stop();
    throw new Error(detail || lastError?.message || 'Codex CLI bridge 启动失败');
  }

  _publicResult(status = {}) {
    return {
      ok: true,
      base_url: this.baseUrl,
      token: this.token,
      port: this.port,
      login_ok: status.login_ok !== false,
      detail: status.detail || '',
      codex_bin: resolveCodexBin(this.codexBin),
      workspace: this.workspaceDir,
      sandbox: 'read-only',
      model: status.model ?? this._runtime.model,
      proxy_mode: status.proxy_mode || this._runtime.proxyMode,
      context_chars: this._runtime.contextChars,
    };
  }

  async status({ start = true, runtime = {} } = {}) {
    try {
      const result = start ? await this.start(runtime) : await _health(this.baseUrl, this.token);
      return {
        ok: !!result.ok,
        running: !!(this.child && this.child.exitCode == null),
        login_ok: result.login_ok !== false,
        detail: result.detail || '',
        codex_bin: result.codex_bin || resolveCodexBin(this.codexBin),
        workspace: this.workspaceDir,
        sandbox: 'read-only',
        model: result.model ?? this._runtime.model,
        proxy_mode: result.proxy_mode || this._runtime.proxyMode,
        context_chars: result.context_chars || this._runtime.contextChars,
      };
    } catch (error) {
      return {
        ok: false,
        running: false,
        login_ok: false,
        error: error?.message || String(error),
        codex_bin: resolveCodexBin(this.codexBin),
        workspace: this.workspaceDir,
        sandbox: 'read-only',
        model: this._runtime.model,
        proxy_mode: this._runtime.proxyMode,
        context_chars: this._runtime.contextChars,
      };
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.port = null;
    this.token = null;
    this.baseUrl = null;
    this._runtime = _normalizeRuntime();
    this._runtimeKey = '';
    if (!child || child.exitCode != null) return;
    await _killProcessTree(child);
  }
}


module.exports = {
  CodexCliBridge, resolveCodexBin, resolvePythonBin,
  _normalizeRuntime, _applyProxyEnv,
  CODEX_CLI_MAX_INPUT_CHARS, CODEX_BRIDGE_DEFAULT_CONTEXT_CHARS,
};
