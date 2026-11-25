// EasyDeal 测试后门 HTTP server — 仅在 process.env.EASYDEAL_TEST_PORT 非空
// 时启用. 正常装的客户端不会暴露任何端口, 零安全风险.
//
// 用途: 让外部测试工具 (Claude MCP wrapper 等) 通过 HTTP 直接:
//   - 触发任意 ipcMain.handle 注册的 IPC handler (跑 strategies / 挂载 / OG 等)
//   - dump 关键状态 (strategies records / wechat status / mt5 instances / token)
//   - 在 renderer process 跑任意 JS (验 DOM / chip / banner / dropdown 等 UI)
//
// 不替代 e2e 真 UI 测试 (用户真鼠标点击) — 但覆盖 95% 后端 + IPC + renderer state
// 的 black-box test. 跟 wechat-sidecar 探活 / strategies.deployCompiled 单元测一样,
// 把"我以为修好了"变成"我跑过一遍能直接验证".

const http = require('node:http');

let _server = null;
let _winRef = null;
let _dumpStateFn = null;

/**
 * 启 test server 监听 127.0.0.1:port (用户态, 没 admin).
 * 只 bind localhost — 不暴露到网络. port=0 让 OS 分配, 但实际 caller 传死端口
 * 方便测试工具直接连.
 *
 * @param {object} ctx
 * @param {number} ctx.port — 监听端口
 * @param {BrowserWindow} ctx.win — 主窗口引用 (renderer eval / IPC fake event 用)
 * @param {Function} ctx.dumpState — 返回当前 process state 的 helper
 *        签名: async () => ({ strategies, mt5_instances, wechat_status, token, ... })
 * @param {Function} ctx.log
 */
function start({ port, win, dumpState, log = console.log }) {
  if (_server) {
    log('[test-ipc] already running');
    return _server;
  }
  _winRef = win;
  _dumpStateFn = dumpState;
  // 拿 Electron ipcMain 内部 handler 表. 注意 _invokeHandlers 是 undocumented
  // private API, 但 Electron 4+ 都稳定. 未来 break 了再 refactor.
  const { ipcMain } = require('electron');
  const _invokeHandlers = ipcMain._invokeHandlers;
  if (!_invokeHandlers) {
    log('[test-ipc] FATAL: ipcMain._invokeHandlers undefined — Electron API changed');
    return null;
  }

  _server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return _send(res, 200, { ok: true, ts: Date.now() });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        const state = await (_dumpStateFn || dumpState)();
        return _send(res, 200, { ok: true, state });
      }
      if (req.method === 'GET' && url.pathname === '/handlers') {
        // list 所有注册的 IPC channel
        return _send(res, 200, {
          ok: true, channels: Array.from(_invokeHandlers.keys()).sort(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/ipc') {
        const body = await _readBody(req);
        const { channel, args = [] } = JSON.parse(body || '{}');
        if (!channel) return _send(res, 400, { ok: false, error: 'channel required' });
        const handler = _invokeHandlers.get(channel);
        if (!handler) {
          return _send(res, 404, {
            ok: false, error: `no handler: ${channel}`,
            available_channels: Array.from(_invokeHandlers.keys()).filter((c) => c.includes(channel.split(':')[0])).sort(),
          });
        }
        // 模拟 ipcRenderer.invoke 路径 — fake event 给 handler 用 .sender
        const fakeEvent = {
          sender: _winRef?.webContents || null,
          senderFrame: null,
          processId: process.pid,
          frameId: 0,
        };
        const result = await handler(fakeEvent, ...args);
        return _send(res, 200, { ok: true, result });
      }
      if (req.method === 'POST' && url.pathname === '/eval') {
        const body = await _readBody(req);
        const { code, timeout_ms = 10000 } = JSON.parse(body || '{}');
        if (!code) return _send(res, 400, { ok: false, error: 'code required' });
        if (!_winRef?.webContents) {
          return _send(res, 503, { ok: false, error: 'main window not ready' });
        }
        // executeJavaScript: 在 renderer 跑 JS. 返回 promise (Electron 自动 serialize)
        const result = await Promise.race([
          _winRef.webContents.executeJavaScript(code, true /* userGesture */),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`eval timeout ${timeout_ms}ms`)), timeout_ms)),
        ]);
        return _send(res, 200, { ok: true, result });
      }
      return _send(res, 404, { ok: false, error: `unknown path: ${url.pathname}` });
    } catch (e) {
      return _send(res, 500, {
        ok: false, error: String(e?.message || e),
        stack: String(e?.stack || '').split('\n').slice(0, 8).join('\n'),
      });
    }
  });

  _server.on('error', (e) => log('[test-ipc] server error:', e?.message || e));
  _server.listen(port, '127.0.0.1', () => {
    log(`[test-ipc] listening on http://127.0.0.1:${port} (handlers=${_invokeHandlers.size})`);
  });
  return _server;
}

async function stop() {
  if (!_server) return;
  await new Promise((r) => _server.close(r));
  _server = null;
  _winRef = null;
  _dumpStateFn = null;
}

/**
 * Rebind win + dumpState without stopping the HTTP server. Used by main.js
 * to inject `win` after createWindow + sidecars init, so subsequent
 * /state can read real values and /eval works.
 */
function rebind({ win, dumpState }) {
  if (win !== undefined) _winRef = win;
  if (dumpState !== undefined) _dumpStateFn = dumpState;
}

function _send(res, status, payload) {
  res.writeHead(status);
  res.end(JSON.stringify(payload, _circularReplacer()));
}

function _readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// 防 IPC handler 返复杂对象含 circular reference (BrowserWindow / EventEmitter 等)
function _circularReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      // 跳过明显非 serializable 的 Electron / Node 对象
      if (value.constructor?.name === 'BrowserWindow') return '[BrowserWindow]';
      if (value.constructor?.name === 'WebContents') return '[WebContents]';
      if (typeof value.pipe === 'function') return '[Stream]';
    }
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'bigint') return value.toString();
    return value;
  };
}

module.exports = { start, stop, rebind };
