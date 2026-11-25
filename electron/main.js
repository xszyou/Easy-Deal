// EasyDeal Client — Electron main process.
//
// Wires together the scheduler, knowledge base, strategies, chat session,
// MCP bridge, and server API client. All renderer-facing surfaces go through
// preload.js -> ipcMain handlers.

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, protocol, net, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Test mode only: log every outbound request this process makes to the EasyDeal
// backend, so a test run can prove the community build only reads public endpoints.
if (process.env.EASYDEAL_TEST_NETLOG) {
  const _netlog = process.env.EASYDEAL_TEST_NETLOG;
  const _record = (method, url) => {
    try {
      if (/fay-agent\.com|aliyuncs\.com/i.test(String(url))) {
        fs.appendFileSync(_netlog, `${new Date().toISOString()} ${method} ${url}\n`);
      }
    } catch {}
  };
  for (const mod of [require('node:http'), require('node:https')]) {
    const orig = mod.request;
    mod.request = function patchedRequest(opts, ...rest) {
      const u = typeof opts === 'string' || opts instanceof URL
        ? String(opts)
        : `${opts.protocol || 'https:'}//${opts.hostname || opts.host}${opts.path || ''}`;
      _record((opts && opts.method) || 'GET', u);
      return orig.call(this, opts, ...rest);
    };
  }
  const _fetch = global.fetch;
  if (_fetch) {
    global.fetch = (input, init = {}) => {
      _record(init.method || 'GET', typeof input === 'string' ? input : input?.url);
      return _fetch(input, init);
    };
  }
}

// 0.2.9 起：file-based 启动诊断日志。EasyDeal 主进程偶尔卡在某个 await
// 后把后续逻辑全跳过（chat.json / .mcp.json / strategies.json 都不写、
// _save 不触发但 IPC 仍然部分工作 = "半僵尸"）。Electron 主进程的
// console.log 在 packaged 模式下写不到任何文件 / 控制台，没法看哪步挂了。
// 改成同步写到 <userData>/startup-trace.log，每条带 ms 时间戳；下次再
// 卡的时候直接看最后一条 trace = 知道卡在哪。
//
// 同步 fs.appendFileSync 故意不用 try/catch 时机（在 init 之前都靠它就
// 行；写不进去就让 main 报错挂掉，强行暴露）。
let _traceLogPath = null;
// 1.3.35: 记录 claude 信任预写的实测结果, 供 collectDiagnosticSnapshot 上报 —
// startup-trace.log 只在本机, 巡检脚本看不到; 这个字段能让服务端诊断直接看出
// 「这台机器写 ~/.claude.json 是不是被 EDR/fs filter 假成功」。
let _claudeTrustWriteResult = null;
function _traceLog(stage, extra) {
  try {
    if (!_traceLogPath) {
      try {
        _traceLogPath = path.join(app.getPath('userData'), 'startup-trace.log');
      } catch {
        // app.getPath 在 ready 之前可能不可用；退回用临时目录
        const os = require('node:os');
        _traceLogPath = path.join(os.tmpdir(), 'easydeal-startup-trace.log');
      }
    }
    const t = new Date().toISOString();
    const line = `[${t}] ${stage}${extra ? ' :: ' + extra : ''}\n`;
    fs.appendFileSync(_traceLogPath, line, 'utf8');
  } catch { /* 写日志失败也不能让主流程挂 */ }
}
_traceLog('main.js loaded');

// 0.3.258: 把 console.log/warn/error 同步追加到 file — packaged Electron
// 主进程的 console 输出找不到位置, 撞 bug 时完全无法诊断 (这次微信单向收消息
// 调了几小时找到 wechat_status 死锁就是这原因). 现在每条 console 都额外
// 写到 <userData>/workspace/logs/easydeal-main.log, 加 timestamp + level.
// 文件 size 超 5MB 时 rename .1 备份 (简单 rotate, 防止无限增长).
const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
let _mainLogPath = null;
function _resolveMainLogPath() {
  if (_mainLogPath) return _mainLogPath;
  try {
    const ud = app.getPath('userData');
    const dir = path.join(ud, 'workspace', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    _mainLogPath = path.join(dir, 'easydeal-main.log');
  } catch {
    const os = require('node:os');
    _mainLogPath = path.join(os.tmpdir(), 'easydeal-main.log');
  }
  return _mainLogPath;
}
function _rotateIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > MAIN_LOG_MAX_BYTES) {
      const bak = p + '.1';
      try { fs.unlinkSync(bak); } catch {}
      try { fs.renameSync(p, bak); } catch {}
    }
  } catch { /* 不存在/无权限都不挡主流程 */ }
}
function _writeMainLog(level, args) {
  try {
    const p = _resolveMainLogPath();
    _rotateIfNeeded(p);
    const t = new Date().toISOString();
    // 把每个 arg 转字符串. object 用 JSON, primitive 用 String().
    const text = args.map((a) => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a;
      if (a instanceof Error) return (a.stack || a.message || String(a));
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    fs.appendFileSync(p, `[${t}] [${level}] ${text}\n`, 'utf8');
  } catch { /* 写不进文件也不能挡主流程 */ }
}
// Hook console.* — 保留原 stdout/stderr 输出 (虽然 packaged 看不到, 但 dev 模式还能看)
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log = (...args) => { _writeMainLog('LOG', args); _origLog(...args); };
console.warn = (...args) => { _writeMainLog('WARN', args); _origWarn(...args); };
console.error = (...args) => { _writeMainLog('ERR', args); _origError(...args); };
console.log('[main-log] file logger installed —', _resolveMainLogPath());

// Register a custom protocol for serving workspace files (knowledge images,
// strategy charts, etc.) into the renderer. Must happen BEFORE app.whenReady.
//   easydeal-asset:///images/foo.png  →  <workspace>/images/foo.png
// We mark it as `secure` so it's allowed to load under https-style CSP, and
// `supportFetchAPI` so renderer fetch() can also use it if needed.
protocol.registerSchemesAsPrivileged([
  { scheme: 'easydeal-asset', privileges: { secure: true, supportFetchAPI: true, stream: true } },
]);

const { KnowledgeBase } = require('./knowledge-base');
const { Strategies } = require('./strategies');
const { deleteHotParamFiles } = require('./strategy-hot-params');
const { ChatSession, extractRemoteClientKeys } = require('./chat-session');
const { ChatSessionManager, stratKey: _stratKey } = require('./chat-session-manager');
const { Attachments } = require('./attachments');
const { SettingsStore } = require('./settings');
const { BacktestsStore } = require('./backtests');
const license = require('./license');
const { COMMUNITY_EDITION } = require('./community-edition');
const marketplace = require('./marketplace');
const { StdioMcpClient } = require('./python-mcp-client');
const { StatsCollector } = require('./stats-collector');
const { OrderGuard } = require('./orderguard');
const { OrderGuardPool } = require('./orderguard-pool');
const { WechatSidecar } = require('./wechat-sidecar');
const { NewsProvider } = require('./news-provider');
const { PreferenceLearner } = require('./preference-learner');
const { TokenStore } = require('./token-store');
const { enumerateMcpTools, enumerateSkills } = require('./skills-discovery');
const { spawnHeadlessClaude, spawnHeadlessClaudeWithSession, resolveClaudeBin } = require('./claude-runner');
// 0.3.152: 全局 timer registry — 后台 ticker 统一注册, 「全停」时联动 pause/resume.
const { timerRegistry } = require('./timer-registry');
const { WechatSessionStore } = require('./wechat-sessions');
const serverApi = require('./server-api');
const mock = require('./mock-data');
const updater = require('./updater');
// 0.3.196: electron-updater 差分下载 wrapper. fallback 路径仍是上面那个 updater.
const autoUpdater = require('./auto-updater');
const {
  normalizeMt5Path,
  planMt5VerificationRetry,
  reconcileMissingMt5Process,
  sameMt5Path,
  validateMt5Instance,
} = require('./mt5-instance');
const { planMount: _planMt5Mount } = require('./mt5-profile');

Menu.setApplicationMenu(null); // Hide File/Edit/View bar globally.

// 0.3.202: 全局 crash guards — 防 uncaught async / native throw 让 main 进程
// 直接闪退. 用户反馈「挂载报错后 easydeal 就闪退了」, 启动 log 看到 14:05 心跳
// 后 9 分钟无消息直接没了, 没 graceful shutdown 痕迹 → 必是 uncaught 路径.
// 这两个 handler:
//   1. log 异常 + stack 到 startup-trace.log + console
//   2. 不主动 app.quit() — 让 Electron 自己决定 (大多数 JS 异常其实不致命)
// 注意: native crash (V8 segfault / dll 崩溃) 仍会闪退, 这两个 handler 救不了.
const _crashLogPath = require('node:path').join(
  (require('electron').app.getPath('userData') || '.'),
  'startup-trace.log',
);
function _logCrash(kind, err) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ❌ ${kind} :: ${String(err?.stack || err?.message || err).slice(0, 2000)}\n`;
  try { require('node:fs').appendFileSync(_crashLogPath, msg, 'utf8'); } catch {}
  try { console.error(msg); } catch {}
}
process.on('uncaughtException', (e) => _logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => _logCrash('unhandledRejection', e));

const SCHEDULER_TICK_MS = 5000;

let win = null;
let tray = null;
let isQuitting = false;        // set to true only when user actively chooses to quit
let kb = null;
let strategies = null;
let chat = null;         // = chatMgr 的全局会话(back-compat; 旧引用继续可用)
let chatMgr = null;      // 1.3.x 多会话管理器(global + strat:<login>:<ea>)
let _lastPersistErrorNotifyAt = 0;   // persist-error 系统通知节流(5min), 防连续失败刷屏
let attachments = null;
let settings = null;
// Runtime-only lifecycle state. Persisted desired state remains in settings;
// observed PIDs/data_path/errors live here and are rebuilt after every boot.
const _mt5Lifecycle = new Map(); // instanceId -> {state,pids,seenRunning,misses,lastError,actualDataDir}
const _mt5LaunchAuthorization = new Map(); // instanceId -> expiry ms
const _mt5RestartAuthorization = new Map(); // explicit attach/restart transition -> expiry ms
const _mt5VerificationChain = new Map(); // instanceId -> {token,pid} of the only live post-launch identity check
let _mt5VerificationSeq = 0;
let _mt5LifecycleTimer = null;
let backtests = null;
let tokenStore = null;
let mobileRelay = null;        // 易策随身手机中继 consumer（绑定模式）
// 0.3.163: 拦截模式 retrofit 中的 EA pending map. 用户点「启用护航 → 拦截模式」时
// 不立即 enableEa, 改成在这里登记, 等 AI 改完 EA 编译成功后由 chat busy listener 自动启用.
// 用户点全停 / AI 失败 → last turn interrupted → 丢弃 pending → EA 保持「未启用」.
let _pendingEnforceRetrofit = new Map();
let schedulerClient = null;     // Long-lived MCP client to scheduler_mcp.py
let schedulerTimer = null;      // Cron poll timer
// 0.4.21: scheduler sidecar start() 失败重试 + 后台 ticker 注册解耦的状态标记.
// 老 bug: 7 个后台 ticker 全注册在 startSchedulerSidecar 里、写在 start() 之后,
// start() 一旦 throw 就 return 走人 → ticker 全不注册 + 无重试 → 后台自动化
// (回测poll/巡检/诊断上报/护航告警/中断恢复/偏好学习/健康检查) 静默死一整个
// session. 这俩 flag 让: (a) start 失败排重试不重复堆, (b) ticker 只注册一次
// 且跟 start 成败解耦 (它们 self-guard 于 schedulerClient.ready).
let _schedulerStartRetryPending = false;
let _backgroundTickersRegistered = false;
// Live heartbeat for the cron poll — used by app:system-tasks to enrich
// the sys_scheduler_poll row with actual last-run / run-count instead of
// the Python record_system_run round trip (which the poll loop doesn't
// use because it's a Node-side ticker, not a Python tool call).
const schedulerPollStats = {
  runCount: 0,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastDurationMs: null,
};
let schedulerFiring = new Set(); // Tasks currently being fired (dedupe)
let statsCollector = null;      // Periodic MT5 stats snapshot
let orderguard = null;          // OrderGuard server (HTTP + MCP) — 0.3.191 Phase 3 起改成 compat proxy 走 ogPool
let ogPool = null;              // 0.3.191 Phase 3: 多 MT5 实例 OG pool
let wechatSidecar  = null;      // WeChat MCP sidecar (long-lived)
let wechatSessions = null;      // Per-WeChat-chat Claude session store (0.1.62+)
let newsProvider     = null;    // 0.3.14: 金十快讯 polling provider

/**
 * Boot-time best-effort: if the user is in Fay mode without a fresh token,
 * fetch the model list and issue a token for the first allowed model. This
 * spares first-time users from having to visit the Token tab before sending
 * their first message.
 *
 * Skips silently if:
 *   - mode != 'fay'                        (user picked something else)
 *   - already has a fresh cached_token     (don't waste a server call)
 *   - no license yet                       (license gate hasn't bound)
 *   - server returns no models             (backend channels not configured)
 *   - any network error                    (logs a warning, doesn't throw)
 *
 * Idempotent — running it twice is harmless. Also re-callable by IPC if we
 * later want a "重置 Fay token" affordance.
 */

// 0.3.50: 模块顶层定义，让 app.whenReady 回调里的 _sharedReissuer + registerIpc
// 里的所有 ipcMain.handle('token:*') 都能引用。之前 _fayContext 嵌在
// registerIpc(workspaceDir) 内部（仅 IPC handlers 可见），_sharedReissuer
// 在 app.whenReady 顶层 scope 引用它 → ReferenceError。这条 bug 长期被
// 「channel-err 正则漏过过去式 exited」掩盖（retry 链根本没触发过），
// 0.3.49 修了正则后第一次暴露（用户撞「reissue 失败 → _fayContext is
// not defined」）。
async function _fayContext() {
  const lic = license.getStatus();   // { key, machine_id, ... }
  return {
    license_key: lic?.key || null,
    machine_id:  lic?.machine_id || null,
  };
}

// 0.3.49: broadcast token cache changes so chat-view's model dropdown can
// re-sync without waiting for tab re-activation. Fires after every
// tokenStore.setFay() — auto-issue, manual switch, fallback reissue.
function _broadcastTokenChange() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('token:cached-changed'); } catch {}
    }
  } catch {}
}

// marginMs: token 剩余寿命 < marginMs 才重签. 开机调用用默认 60s (有 token 就别动);
// 后台续签 timer 传 10min (见 createWindow 里的 setInterval) — 提前续, 不等真过期.
async function _autoIssueFayIfNeeded(marginMs = 60_000) {
  if (!tokenStore) return { ok: false, reason: 'token store not ready' };
  const cfg = tokenStore.data;
  if (cfg.mode !== 'fay') return { ok: false, reason: 'mode is not fay' };
  if (cfg.fay.cached_token && cfg.fay.cached_until > Date.now() + marginMs) {
    return { ok: false, reason: 'token already alive' };
  }
  const lic = license.getStatus();
  if (!lic?.key) return { ok: false, reason: 'no license bound yet' };

  const ctx = {
    license_key: lic.key,
    machine_id:  lic.machine_id || '',
  };

  // 1) Get the model list. Server returns ONLY models this license is
  //    entitled to (trial → just claude-haiku, pro → all).
  let models;
  try {
    const qs = new URLSearchParams(ctx).toString();
    const r = await serverApi.get(`/v1/token/models?${qs}`);
    if (!r.ok) {
      console.warn('[token] auto-issue: list-models failed:', r.error || r);
      return { ok: false, reason: 'models fetch failed' };
    }
    models = r.models || [];
  } catch (e) {
    console.warn('[token] auto-issue: list-models threw:', e.message);
    return { ok: false, reason: 'network error' };
  }

  if (!models.length) {
    console.warn('[token] auto-issue: no models entitled to this license');
    return { ok: false, reason: 'no models' };
  }

  // 2) Pick the first one. Server already orders by preference; we trust it.
  const pick = models[0];
  const modelId = pick.id;

  // 3) Issue a token bound to (license, machine, model).
  try {
    const r = await serverApi.post('/v1/token/issue', { model: modelId, ...ctx });
    if (!r.ok || !r.token) {
      console.warn('[token] auto-issue: issue failed:', r.error || r);
      return { ok: false, reason: 'issue failed' };
    }
    await tokenStore.setFay({
      cached_token: r.token,
      cached_base_url: r.base_url || null,
      cached_model: r.model || modelId,     // server-returned concrete id
      cached_model_requested: modelId,       // what we asked for (likely 'auto')
      cached_until: r.expires_at || (Date.now() + 30 * 60 * 1000),
      context_window: r.context_window || null,   // 1.2.31: 真实窗口 → 主动压缩
    });
    _broadcastTokenChange();
    const tag = (modelId === 'auto' && r.model && r.model !== 'auto')
                ? `auto → ${r.model}` : modelId;
    console.log(`[token] auto-issued Fay token for model=${tag}`);
    return { ok: true, model: modelId };
  } catch (e) {
    console.warn('[token] auto-issue: issue threw:', e.message);
    return { ok: false, reason: 'network error' };
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: 'EasyDeal',
    backgroundColor: '#07080a',
    autoHideMenuBar: true,
    icon: path.resolve(__dirname, '..', 'assets', 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // Forward renderer console + uncaught errors to the main process stdout so
  // we can debug without opening DevTools every time.
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    const tag = ['log', 'warn', 'error'][Math.min(level, 2)] || 'log';
    console.log(`[renderer:${tag}] ${message}${src ? ` (${src}:${line})` : ''}`);
  });

  // Toggle devtools with Ctrl+Shift+I (since we hid the menu).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
    } else if (input.control && input.key.toLowerCase() === 'r') {
      win.webContents.reload();
    }
  });

  // Close button → hide to tray (don't actually quit). This protects all the
  // long-running sidecars (scheduler, stats collector, wechat sidecar) which
  // would otherwise be shut down with the click of an X. To genuinely quit
  // the user must use the tray menu's "彻底退出".
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'win32') {
      try { win.setSkipTaskbar(true); } catch {}
    }
  });
}

// ---------------------------------------------------------------------------
// System tray (Windows): icon + click-to-restore + right-click menu.
// ---------------------------------------------------------------------------

function createTray() {
  if (tray) return;
  // Try a real icon if it exists; otherwise generate a tiny solid-color one
  // so the user gets a tray entry rather than nothing.
  let img;
  const iconCandidates = [
    path.resolve(__dirname, '..', 'assets', 'tray.ico'),
    path.resolve(__dirname, '..', 'assets', 'tray@2x.png'),
    path.resolve(__dirname, '..', 'assets', 'tray.png'),
    path.resolve(__dirname, '..', 'assets', 'icon-32.png'),
  ];
  for (const p of iconCandidates) {
    if (fs.existsSync(p)) { img = nativeImage.createFromPath(p); break; }
  }
  if (!img || img.isEmpty()) {
    // 16x16 solid red square (#FF6363, our brand) — generated inline so we
    // don't need any asset files shipped.
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4 + 0] = 0xFF; // R
      buf[i * 4 + 1] = 0x63; // G
      buf[i * 4 + 2] = 0x63; // B
      buf[i * 4 + 3] = 0xFF; // A
    }
    img = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  tray = new Tray(img);
  tray.setToolTip('EasyDeal');
  tray.on('click', _showWindowFromHidden);
  tray.on('double-click', _showWindowFromHidden);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 EasyDeal', click: _showWindowFromHidden },
    { type: 'separator' },
    { label: '彻底退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// 0.3.55: 把窗口从「关 X 进托盘」状态唤起的统一逻辑。tray click / tray menu
// /「打开 EasyDeal」/ second-instance 重复双击桌面图标都调这里，确保用一份
// 行为：还原任务栏图标（close 时被 setSkipTaskbar(true) 藏了）+ 提到最前。
//
// 用户报「进程没杀掉、再启动看不到界面、要手工杀进程」根因 = 走的是关
// X 默认 close-to-tray 路径（非「彻底退出」），并不是 EasyDeal 没退。证据：
// 用户能在 Task Manager 看到 EasyDeal.exe 进程 + 「再启动打不开」（=单实例
// 锁被那个进程占着，second-instance 路径触发到这里但旧版只 show() 没还原
// 任务栏 → 看上去什么都没发生）。
//
// 注：flashFrame 只在 second-instance 路径走（用户从外部触发，需要吸引注意）；
// tray click 路径走过来用户本身正盯着托盘，不需要闪。
function _showWindowFromHidden({ flash = false } = {}) {
  if (!win) return;
  try {
    if (win.isMinimized()) win.restore();
    if (process.platform === 'win32') {
      try { win.setSkipTaskbar(false); } catch {}
    }
    win.show();
    win.focus();
    try { win.moveTop(); } catch {}
    if (flash && win.flashFrame) {
      try { win.flashFrame(true); } catch {}
    }
  } catch {}
}

// 0.3.253+: test mode — 设 EASYDEAL_TEST_PORT env 时启 test-IPC server.
// 默认切独立 app name + tmp userData + bypass license (安全 fresh fresh).
// 设 EASYDEAL_TEST_REAL=1 时**保留默认 userData + 真 license** — 端到端测真用
// 户场景用 (须先关掉生产 EasyDeal 否则撞 single-instance lock).
if (process.env.EASYDEAL_TEST_PORT) {
  const _useReal = process.env.EASYDEAL_TEST_REAL === '1';
  if (_useReal) {
    console.log(`[test-mode] REAL userData mode — keeping default app.name + userData, real license (must have killed prod EasyDeal first)`);
  } else {
    const _path = require('node:path');
    const _os = require('node:os');
    const _testName = `EasyDeal-test-${process.env.EASYDEAL_TEST_PORT}`;
    app.setName(_testName);
    const _testUserData = _path.join(_os.tmpdir(), _testName);
    try { app.setPath('userData', _testUserData); } catch {}
    console.log(`[test-mode] ISOLATED mode — app.name=${_testName} userData=${_testUserData}`);
  }
}

// 单实例锁 — 之前没加，导致用户多次双击图标会跑出多个 main 进程，每个
// 进程各自起 scheduler / wechat sidecar，跟用户截图里看到的「5 个
// EasyDeal 进程 + 几个 Python」对应。requestSingleInstanceLock() 拿不到锁
// 就直接 quit 自己，把焦点让给已经在跑的那一个。
const _gotInstanceLock = app.requestSingleInstanceLock();
if (!_gotInstanceLock) {
  console.log('[main] another EasyDeal instance is already running — quitting this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户在 EasyDeal 已 hide-to-tray 状态下又双击桌面图标 / 启动器图标
    // → 拉旧实例的窗口出来。共享 _showWindowFromHidden 的逻辑（同一份还原代
    // 码也给 tray click / tray 菜单「打开 EasyDeal」用）。second-instance 路径
    // 加 flash=true 让任务栏闪一下吸引注意——用户原本可能正在做别的事，
    // EasyDeal 突然回来要让人看到。
    _showWindowFromHidden({ flash: true });
  });
}

// 启动时清掉本地装完的 installer-*.exe — 既然我们已经在跑某个版本，
// 任何 installer-X.exe（无论 X 是当前版本还是更老）都完成使命了，
// ~225MB / 个没必要继续占盘。也包含 .partial 残留（中断的下载）。
// 注：这是「启动时清理」，跟 updater.pruneOldInstallers 独立 — 那个是
// 「下载完新版后清旧的」。
async function _pruneInstalledArtifacts() {
  try {
    const updaterMod = require('./updater');
    const dir = updaterMod.updatesDir();
    const fsp = require('node:fs/promises');
    const entries = await fsp.readdir(dir).catch(() => []);
    let cleaned = 0;
    for (const name of entries) {
      if (!name.startsWith('installer-')) continue;
      if (!name.endsWith('.exe') && !name.endsWith('.partial')) continue;
      try {
        await fsp.unlink(path.join(dir, name));
        cleaned += 1;
      } catch {}
    }
    if (cleaned) console.log(`[updater] cleaned ${cleaned} stale installer file(s) on launch`);
  } catch (e) {
    console.warn('[updater] prune-on-launch failed:', e?.message || e);
  }
}

// 0.3.55: 启动时清理上一轮没退干净的 python.exe 子进程
// (scheduler_mcp / easydeal_mcp_server / wechat_mcp / 其他 EasyDeal MCP)。
//
// 背景（用户案例）：before-quit 用 Promise.race 3 秒超时清理 sidecar
// 后就 app.quit() — 主进程退干净了但 stdio 子进程未必（race 是 timeout
// resolve，不是确认 SIGTERM 已让子进程退）。这些 python.exe 残留在 Task
// Manager 里、可能还占着 Flask 8888 / scheduler.db 文件 → 下次启动 MCP 服务
// 起不来 → 用户视感「客户端打开了但啥都不工作」→ 手工杀进程。
//
// 这里在 whenReady 早期、所有 sidecar/MCP spawn 之前扫一遍 ours 的 python.exe
// 孤儿（双重 filter: ExecutablePath 必须在我们 bundled python-runtime 下 +
// CommandLine 必须含我们其中一个 .py 脚本名）+ taskkill。Win32 only，其他
// OS 跳过；任何步骤撞错就静默跳过，绝不能让这一步阻塞 / 干扰用户主流程启动。
async function _killOrphanPythonChildren(opts = {}) {
  // opts.requireDeadParent (default false 即 startup-time 行为) — 若 true 则
  // 仅杀 ParentProcessId 已 dead 的 Python (= 真孤儿); false 则杀所有匹配白名单
  // 的 Python (startup 时 prior session 的 EasyDeal 主进程已死, 所有 child
  // 自然都是孤儿).
  const requireDeadParent = !!opts.requireDeadParent;
  if (process.platform !== 'win32') return { skipped: 'non-win32' };
  // 我们 bundled 的 python-runtime 路径（packaged: resourcesPath/app.asar.unpacked
  // /python-runtime/python.exe；dev mode: repo/python-runtime/python.exe）。
  let ourPython = null;
  try {
    ourPython = resolveBundledFile('python-runtime', 'python.exe');
  } catch {}
  if (!ourPython || !fs.existsSync(ourPython)) {
    return { skipped: 'no-bundled-python' };
  }
  const normOur = String(ourPython).toLowerCase().replace(/\//g, '\\');

  // 我们的 MCP / sidecar 脚本名 — 当且仅当 CommandLine 含其中之一才算 ours。
  // 这套白名单**必须**和 knowledge-base.js 里 .mcp.json 注的 args 一致。
  const ourScripts = [
    'easydeal_mcp_server.py',
    'scheduler_mcp.py',
    'easydeal_settings_mcp_server.py',
    'wechat_mcp.py',
    String.raw`window_capture\server.py`,
    'window_capture/server.py',
  ];

  const cp = require('node:child_process');
  // PowerShell 比 wmic 在 Win11 24H2+ 更稳。`-NoProfile` 跳 profile 加载省 ~200ms。
  // 输出 JSON 让 Node 解析比 csv 更鲁棒。
  // 0.4.13: 增加 ParentProcessId 字段 + 同时拉所有 Process Id 列表 (用 Where 单查
  // python.exe 然后另查所有 PID 太啰嗦, 改一次性拉所有 process 的 PID set, in-Node
  // 判 parent 是否 alive).
  let out;
  try {
    out = cp.execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"',
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    );
  } catch (e) {
    _traceLog('orphan-kill query-failed', String(e?.message || e).slice(0, 120));
    return { skipped: 'query-failed' };
  }
  let procs;
  try {
    procs = JSON.parse(out || '[]');
    if (!Array.isArray(procs)) procs = [procs];   // 单条结果 PowerShell 不输出数组
  } catch {
    return { skipped: 'parse-failed' };
  }

  // 0.4.13: parent-alive check — 跑全量 PID set 一次, 用 Node Set 判活 (没 PS 调用).
  let alivePidSet = null;
  if (requireDeadParent) {
    try {
      const allPidsRaw = cp.execSync(
        'powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty Id"',
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
      );
      alivePidSet = new Set(
        String(allPidsRaw || '').split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)
      );
    } catch (e) {
      _traceLog('orphan-kill pid-set-failed', String(e?.message || e).slice(0, 120));
      // 拉不到 alive PIDs → 保守不杀, 下次再试
      return { skipped: 'pid-set-failed' };
    }
  }

  const victims = [];
  for (const p of procs) {
    if (!p) continue;
    const exe = String(p.ExecutablePath || '').toLowerCase().replace(/\//g, '\\');
    const cmd = String(p.CommandLine || '');
    if (exe !== normOur) continue;
    if (!ourScripts.some((s) => cmd.includes(s))) continue;
    if (!p.ProcessId) continue;
    if (requireDeadParent) {
      // parent 还活着 → 跳过 (活跃 claude turn / Skills probe / stats collector)
      const ppid = Number(p.ParentProcessId || 0);
      if (ppid && alivePidSet.has(ppid)) continue;
    }
    victims.push({ pid: p.ProcessId, cmd: cmd.slice(0, 160) });
  }

  if (!victims.length) {
    _traceLog('orphan-kill', 'none-found');
    return { killed: 0 };
  }

  let killed = 0;
  for (const v of victims) {
    try {
      // 0.3.241: 去掉 `/t` flag — 用户反馈「EasyDeal 关闭了原来所有 MT5」根因.
      // /t = kill child tree, 但 MetaTrader5 Python SDK 的 mt5.initialize(path=X)
      // 在 MT5 不在跑时会 spawn 一个 MT5 进程作为 Python 的 child. 上次会话 Python
      // MCP 没干净退出 → orphan-kill 杀它时 /t 连带把 MT5 child 一起干掉, 用户
      // 看到「所有 MT5 突然关了」.
      // 改成 `/f` 只杀 Python 进程本身, MT5 作为 GUI 应用独立活着.
      // 副作用: 极少数 case 下 MCP spawn 的 helper (mt5tester / metaeditor 等)
      // 不会被一起杀掉, 但这些都不是常驻进程, 短命无害.
      cp.execSync(`taskkill /pid ${v.pid} /f`,
        { stdio: 'ignore', timeout: 3000, windowsHide: true });
      killed += 1;
      _traceLog('orphan-kill killed', `pid=${v.pid} ${v.cmd}`);
    } catch (e) {
      _traceLog('orphan-kill failed', `pid=${v.pid} err=${String(e?.message||e).slice(0,80)}`);
    }
  }
  return { killed, victims: victims.length };
}

// 1.0.8: claude.exe 进程泄漏 reaper —— 跟 _killOrphanPythonChildren 同款思路, 收的是
// claude-code CLI 进程本身 (用户机器一晚堆几十个 ~300MB 的「Claude Code」进程 → 内存爆 → 卡)。
// 根因同 0.4.13 的 python 孤儿: 一个 headless turn (微信 / 定时任务) 的 claude.exe 跑完退出后,
// 它 spawn 的子 claude.exe (worker) 在 Windows 下没有进程组概念, 父一退就变 orphan, 而 0.4.13
// 那个 reaper 只收 python.exe, claude.exe 孤儿没人管 → 反复 spawn 反复漏 → 累积。
// 安全保证 (3 条都满足才杀):
//   1. ExecutablePath 必须 == 我们 bundled 的 claude.exe (排除用户系统装的 claude / 别的同名)
//   2. requireDeadParent 时父 PID 必须已 dead (活跃 turn 的 main claude.exe 父=EasyDeal 还活 → 放过)
//   3. taskkill 用 /f **不带 /t** —— claude 的 python MCP 孙子可能又 mt5.initialize launch 了 MT5,
//      /t 会把 MT5 一起连坐 (0.4.32/0.3.241 踩过的坑)。只杀 claude.exe 本身, MT5 / 孤儿 python
//      各自由 GUI 独立存活 / python reaper 收。
function _killOrphanClaudeChildren(opts = {}) {
  const requireDeadParent = !!opts.requireDeadParent;
  if (process.platform !== 'win32') return { skipped: 'non-win32' };
  let ourClaude = null;
  try { ourClaude = require('./claude-runner').resolveClaudeBin(); } catch {}
  // resolveClaudeBin 兜底会返 'claude' (PATH) — 拿不到绝对路径就没法安全识别 ours, 直接跳过。
  if (!ourClaude || !/[\\/]/.test(ourClaude) || !/claude(\.exe)?$/i.test(ourClaude)) {
    return { skipped: 'no-bundled-claude' };
  }
  try { if (!fs.existsSync(ourClaude)) return { skipped: 'bundled-claude-missing' }; }
  catch { return { skipped: 'stat-failed' }; }
  const normOur = String(ourClaude).toLowerCase().replace(/\//g, '\\');

  const cp = require('node:child_process');
  let out;
  try {
    out = cp.execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'claude.exe\'\\" | Select-Object ProcessId, ParentProcessId, ExecutablePath | ConvertTo-Json -Compress"',
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    );
  } catch (e) {
    _traceLog('claude-reap query-failed', String(e?.message || e).slice(0, 120));
    return { skipped: 'query-failed' };
  }
  let procs;
  try {
    procs = JSON.parse(out || '[]');
    if (!Array.isArray(procs)) procs = [procs];
  } catch { return { skipped: 'parse-failed' }; }

  let alivePidSet = null;
  if (requireDeadParent) {
    try {
      const allPidsRaw = cp.execSync(
        'powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty Id"',
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
      );
      alivePidSet = new Set(
        String(allPidsRaw || '').split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)
      );
    } catch (e) {
      _traceLog('claude-reap pid-set-failed', String(e?.message || e).slice(0, 120));
      return { skipped: 'pid-set-failed' };
    }
  }

  const victims = [];
  for (const p of procs) {
    if (!p) continue;
    const exe = String(p.ExecutablePath || '').toLowerCase().replace(/\//g, '\\');
    if (exe !== normOur) continue;
    if (!p.ProcessId) continue;
    if (requireDeadParent) {
      const ppid = Number(p.ParentProcessId || 0);
      if (ppid && alivePidSet.has(ppid)) continue;   // 父还活 = 活跃 turn 的 main claude → 放过
    }
    victims.push(p.ProcessId);
  }
  if (!victims.length) {
    _traceLog('claude-reap', 'none-found');
    return { killed: 0 };
  }
  let killed = 0;
  for (const pid of victims) {
    try {
      cp.execSync(`taskkill /pid ${pid} /f`,
        { stdio: 'ignore', timeout: 3000, windowsHide: true });
      killed += 1;
      _traceLog('claude-reap killed', `pid=${pid}`);
    } catch (e) {
      _traceLog('claude-reap failed', `pid=${pid} err=${String(e?.message||e).slice(0,80)}`);
    }
  }
  return { killed, victims: victims.length };
}

app.whenReady().then(async () => {
  _traceLog('whenReady ENTER');

  // 0.3.306: 全局设 PYTHONPYCACHEPREFIX 让所有 Python child spawn 默认继承.
  // 让 Python 写 .pyc 到 userData/python-cache/, install dir 保持 immutable
  // (电子更新器差分算法对 install dir files 算 chunk hash 时不会撞 Python 跑时
  // 写新 .pyc 的 byte 差异 → diff 真 work, sha 验证通过, 不再 fallback 全量).
  // 模拟盘 0.3.301-0.3.305 反复「差分完 fallback 全量」根因诊断: build pipeline
  // sanity check (setup.exe sha512 == latest.yml sha512) 通过, 那 fallback 是
  // client side install dir 文件 bytes 跟 OSS setup.exe 解压后不一致 → 最 likely
  // 是 Python 跑时重写 python-runtime/Lib/__pycache__/*.pyc 污染 install dir.
  try {
    const _dataDir = app.getPath('userData') + '\\data';
    if (!process.env.PYTHONPYCACHEPREFIX) {
      process.env.PYTHONPYCACHEPREFIX = require('path').join(_dataDir, 'python-cache');
      _traceLog('PYTHONPYCACHEPREFIX set', process.env.PYTHONPYCACHEPREFIX);
    }
  } catch (e) {
    _traceLog('PYTHONPYCACHEPREFIX set err', String(e?.message || e));
  }

  // 0.3.253+: test-IPC server 提前启 — 不等 createWindow / IPC 注册完, 这样
  // EasyDeal 启动卡哪一步都能 ping 通 test server 看活. dumpState 全部 null-safe
  // (启动早期 strategies/settings/wechat 还没 init), 返 null 是 OK 的.
  const _testPort = parseInt(process.env.EASYDEAL_TEST_PORT || '0', 10);
  if (_testPort > 0) {
    try {
      const _testIpc = require('./test-ipc-server');
      _testIpc.start({
        port: _testPort,
        win: null,    // win 还没创建, eval endpoint 会 503 直到 createWindow 完
        dumpState: async () => {
          // 全部 try/catch 防 init 还没跑完撞 undefined
          const _safe = (fn) => { try { return fn(); } catch { return null; } };
          return {
            app_version: _safe(() => app.getVersion()),
            test_mode: true,
            mt5_instances: _safe(() => settings?.listMt5Instances?.()) || [],
            active_mt5_instance: _safe(() => settings?.data?.activeMt5InstanceId),
            mt5_detected: _safe(() => settings?.detected?.mt5),
            strategies_records_count: _safe(() => Object.keys(strategies?.records || {}).length) ?? 0,
            token_mode: _safe(() => tokenStore?.data?.mode),
            wechat_status: _safe(() => wechatSidecar?.status),
            orderguard_running: _safe(() => !!orderguard?.running),
            license_key: _safe(() => (license?.getStatus?.() || {}).key),
            win_ready: _safe(() => !!win?.webContents),
          };
        },
        log: (m) => console.log(m),
      });
      _traceLog('test-ipc-server started (early)', `port=${_testPort}`);
      // 等 createWindow 完后调 rebind 把 win 注入 — eval endpoint 能 work.
      // rebind 不 stop server (避免 close 异步 + 端口 release race), 直接 mutate.
      global._lateBindTestIpcWin = () => {
        try {
          _testIpc.rebind({
            win,
            dumpState: async () => {
              const _safe = (fn) => { try { return fn(); } catch { return null; } };
              return {
                app_version: _safe(() => app.getVersion()),
                test_mode: true,
                mt5_instances: _safe(() => settings?.listMt5Instances?.()) || [],
                active_mt5_instance: _safe(() => settings?.data?.activeMt5InstanceId),
                mt5_detected: _safe(() => settings?.detected?.mt5),
                strategies_records_count: _safe(() => Object.keys(strategies?.records || {}).length) ?? 0,
                token_mode: _safe(() => tokenStore?.data?.mode),
                wechat_status: _safe(() => wechatSidecar?.status),
                orderguard_running: _safe(() => !!orderguard?.running),
                license_key: _safe(() => (license?.getStatus?.() || {}).key),
                win_ready: _safe(() => !!win?.webContents),
              };
            },
          });
        } catch (e) { console.warn('[test-mode] late-bind failed:', e?.message || e); }
      };
    } catch (e) {
      _traceLog('test-ipc-server EARLY-START failed', String(e?.message || e));
    }
  }

  // 启动后异步清理本地装完的 installer.exe — 不阻塞 ready 流程
  _pruneInstalledArtifacts().catch(() => {});

  // 0.3.55: 杀上一轮没清干净的 python.exe sidecar 孤儿（用户「再启动看不
  // 到界面」case 之一）。在所有 sidecar/MCP spawn 之前跑，避免新起来的 MCP
  // 端口 / 文件锁撞上残留进程。撞错静默 — 绝不阻塞主启动流程。
  try {
    const r = await _killOrphanPythonChildren({ requireDeadParent: false });
    if (r?.killed) {
      console.log(`[startup] cleaned ${r.killed} orphan python.exe child(ren) from previous session`);
    }
  } catch (e) {
    _traceLog('orphan-kill threw', String(e?.message || e).slice(0, 120));
  }
  // 1.0.8: 同样杀上一轮残留的 claude.exe 孤儿 (用户「一堆 Claude Code 进程 + 卡」)。
  // 启动期 requireDeadParent=false → 全杀 (prior session 的 EasyDeal 已死, 它的 claude
  // 子孙全是孤儿; 本会话此刻还没 spawn 任何 turn, 误杀活跃 turn 不可能)。
  try {
    const r = await _killOrphanClaudeChildren({ requireDeadParent: false });
    if (r?.killed) {
      console.log(`[startup] cleaned ${r.killed} orphan claude.exe from previous session`);
    }
  } catch (e) {
    _traceLog('claude-reap threw', String(e?.message || e).slice(0, 120));
  }
  // 0.4.13: 周期 reap orphan MCP child — 修「一晚 1000+ Python 进程」泄漏.
  // 根因: claude-code spawn Python MCP child (easydeal_mcp/scheduler_mcp/wechat_mcp),
  // Windows 没有 Linux 进程组概念, claude 一退出 (timeout SIGTERM kill / 正常 close)
  // Python 孙子变 orphan. 100 turns/hour × 3 MCP × 24/7 → 几千个 orphan 累积.
  // 周期 5 分钟扫一次, 但 requireDeadParent=true → 只杀真孤儿 (parent PID 已 dead),
  // 活跃的 claude turn / Skills probe / stats collector 一律放过.
  setInterval(async () => {
    try {
      const r = await _killOrphanPythonChildren({ requireDeadParent: true });
      if (r?.killed) {
        console.log(`[reap] killed ${r.killed} orphan python.exe child(ren) (parent dead)`);
      }
    } catch (e) {
      _traceLog('reap-orphan-kill threw', String(e?.message || e).slice(0, 120));
    }
    // 1.0.8: 同周期收 claude.exe 孤儿 (用户泄漏)。独立 try, 跟 python 互不连坐。
    // requireDeadParent=true → 只杀父已死的 (worker claude / 上轮残留), 活跃 turn 放过。
    try {
      const rc = await _killOrphanClaudeChildren({ requireDeadParent: true });
      if (rc?.killed) {
        console.log(`[reap] killed ${rc.killed} orphan claude.exe (parent dead)`);
      }
    } catch (e) {
      _traceLog('reap-claude threw', String(e?.message || e).slice(0, 120));
    }
  }, 5 * 60 * 1000);

  // 0.3.13: 启动诊断 — 记录决定 userData 落点的关键 env，以及当前是否
  // 跑在 elevated token 下。
  // 背景：用户报告 installer 装完 .onInstSuccess 自动启动的 EasyDeal 加载
  // 一份「老数据」（3 个 EA），右键退出后从桌面图标重新启动则加载到
  // 「新数据」。最可能根因是 Windows installer detection 触发 UAC →
  // 安装器 elevated → `.onInstSuccess Exec` 的 child 继承 elevated token
  // → APPDATA 可能解析到不同的用户 / 走 UAC 重定向 →
  // app.getPath('userData') 落点跟正常 explorer 启动时不一致。
  // 0.3.13 同时在 nsis 配置里加 `allowElevation: false` 釜底抽薪；这条
  // trace 是兜底诊断，万一以后还有类似报告，trace 一眼能查到错在哪个
  // 用户/路径上。
  try {
    let elevated = 'unknown';
    try {
      const cp = require('node:child_process');
      // `net session` 在 admin 下 exit 0；普通用户 exit 2 (Access Denied)
      cp.execSync('net session', { stdio: 'ignore', windowsHide: true, timeout: 1500 });
      elevated = 'YES';
    } catch (e) {
      elevated = (e && e.status !== undefined) ? 'no' : 'check_failed';
    }
    _traceLog('startup-env',
      `user=${process.env.USERNAME || '?'} `
      + `domain=${process.env.USERDOMAIN || '?'} `
      + `appdata=${process.env.APPDATA || '?'} `
      + `localappdata=${process.env.LOCALAPPDATA || '?'} `
      + `userData=${app.getPath('userData')} `
      + `elevated=${elevated} `
      + `cwd=${process.cwd()} `
      + `argv=${JSON.stringify(process.argv)}`);
  } catch (e) {
    _traceLog('startup-env ERROR', String(e?.message || e));
  }

  const dataDir = path.join(app.getPath('userData'), 'data');
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  _traceLog('paths resolved', `dataDir=${dataDir}`);

  // 1.3.18: 替 workspace 预写 Claude Code 的「工作区信任」。CC 2.1.19x 起未信任的
  // workspace 会忽略 .claude/settings.json 的 permissions.allow(stderr:
  // "Ignoring N permissions.allow entries ... has not been trusted") → 无头
  // spawn(-p 对话 / cron 任务)工具全被拒 → exit 1(用户实测: 对话+奇数单巡检全挂)。
  // 信任存 ~/.claude.json: projects[<abs path>].hasTrustDialogAccepted=true。
  // 幂等: 只补字段, 不动用户文件里其它内容; 任何异常静默(下次启动再试)。
  //
  // 1.3.35 (用户/用户 1.3.19+ 仍复现排查): 根因不是逻辑漏了, 是这段写盘本身
  // 跟 0.3.1 writeprobe 修的是同一类病 —— 个别机器 EDR/fs filter 让
  // fs.writeFileSync 报成功但实际没落盘(readback 都能骗过, 只有内容比对能戳穿,
  // 见 durable-write.js 头注释)。老代码写完直接信了、打一条「written」的 trace,
  // 从没验证过是否真写进去 —— 于是这两位用户每次启动都「显示写成功」但
  // ~/.claude.json 里其实从来没真正带上这两个字段, exit 1 永久复现。改用
  // durableWriteSync(fsync + tmp 内容回读 + rename 重试 + 落地回读目标文件)
  // 并把失败结果打成显眼的 ERROR trace, 方便下次巡检从 diagnostics 里揪出来。
  // 1.4.5 追查(用户 1.4.2 实测反转): claude_trust_write=already_set 证明字段一直在文件里,
  // 「EDR 假成功」不成立(至少对用户), 但他 1.4.2 上 cron 仍撞 trust exit1 —— 用户同字段
  // 同版本却干净了。新主嫌疑: **路径 key 不匹配** —— CC 按它自己解析的项目绝对路径查
  // projects[<path>], 若用户机器上 userData 路径经过 junction/8.3短路径/盘符大小写差异,
  // CC 解析出的 key ≠ 我们预写的 workspaceDir 字符串, 查表 miss → 判未信任。
  // 对策: ①同时给 realpath 变体写信任 ②把 key 匹配诊断(realpath 是否不同/两个 key 是否
  // 都在)带进 claude_trust_write 上报, 下轮巡检直接看用户机器上 realpath 差不差。
  try {
    const cjPath = path.join(require('node:os').homedir(), '.claude.json');
    let cj = {};
    try { cj = JSON.parse(fs.readFileSync(cjPath, 'utf8')); } catch {}
    if (!cj || typeof cj !== 'object') cj = {};
    if (!cj.projects || typeof cj.projects !== 'object') cj.projects = {};
    // 1.4.11 真根因(用户/用户 confirmed): CC 用**正斜杠**存 projects key
    // (本机实证: CC 自建的 `D:/Projects/.../easydeal-client` 是正斜杠), 而我们用 Node
    // path.join 写的是 Windows **反斜杠** `C:\Users\...\workspace` → CC 运行时按正斜杠
    // 查 projects["C:/Users/.../workspace"] 查不到 → 判未信任(claude_trust_write 明明
    // already_set 却仍 exit1 的真因)。1.4.5 的 realpath 双写没打中 —— realpath 在 Windows
    // 还是反斜杠。修法: 正斜杠 key 必写, 反斜杠 + realpath 变体一并写(全覆盖 CC 任何
    // 路径规范化), 三个 key 指向同一 workspace, 幂等。
    const fwdWs = workspaceDir.replace(/\\/g, '/');
    let realWs = null;
    try {
      realWs = (fs.realpathSync.native || fs.realpathSync)(workspaceDir);
      if (realWs === workspaceDir) realWs = null;   // 无差异就不写第二份
    } catch { realWs = null; }
    const wsKeys = [...new Set([fwdWs, workspaceDir, ...(realWs ? [realWs, realWs.replace(/\\/g, '/')] : [])])];
    let dirty = false;
    for (const k of wsKeys) {
      const proj = cj.projects[k] || {};
      if (proj.hasTrustDialogAccepted !== true) {
        proj.hasTrustDialogAccepted = true;
        cj.projects[k] = proj;
        dirty = true;
      }
    }
    // 关键补充: 客户端 spawn 一律带 --dangerously-skip-permissions, 而 CC 2.1.19x 对
    // 该模式要求一次性确认(顶层 bypassPermissionsModeAccepted)。纯 EasyDeal 用户从没
    // 手动跑过 claude → 无此确认 → headless 直接拒(用户 exit 1 的真根因; 开发机早年
    // 确认过所以复现不了)。
    if (cj.bypassPermissionsModeAccepted !== true) {
      cj.bypassPermissionsModeAccepted = true;
      dirty = true;
    }
    // 路径 key 匹配诊断 — 巡检从服务端一眼看出这台机器 realpath 是否与 workspaceDir
    // 不同(不同 = 路径 key 不匹配假说的直接证据)。
    const _keyDiag = {
      realpath_differs: !!realWs,
      realpath: realWs || undefined,
      ws_key_present: !!cj.projects[workspaceDir]?.hasTrustDialogAccepted,
      fwd_key_present: !!cj.projects[fwdWs]?.hasTrustDialogAccepted,   // 1.4.11 正斜杠 key
    };
    if (dirty) {
      const { durableWriteSync } = require('./durable-write');
      const r = durableWriteSync(cjPath, JSON.stringify(cj, null, 2));
      if (r.ok) {
        _traceLog('claude trust/bypass acceptance written', wsKeys.join(' | '));
        _claudeTrustWriteResult = { attempted: true, ok: true, ..._keyDiag };
      } else {
        _traceLog('claude trust/bypass write FAILED (will retry next boot)',
          `reason=${r.reason} error=${r.error || ''} path=${cjPath}`);
        _claudeTrustWriteResult = { attempted: true, ok: false, reason: r.reason, error: r.error || null, ..._keyDiag };
      }
    } else {
      // 字段已是 true(上次真写进去了, 或本来就有) — 无需重写
      _claudeTrustWriteResult = { attempted: false, ok: true, reason: 'already_set', ..._keyDiag };
    }
  } catch (e) {
    _traceLog('claude workspace trust failed (ignored)', String(e?.message || e));
    _claudeTrustWriteResult = { attempted: true, ok: false, reason: 'exception', error: String(e?.message || e) };
  }

  // 0.3.1: 写入透明度 probe —— 之前发现 EasyDeal 主进程 fs.writeFile 报告
  // 成功但文件实际没改（外部进程写同路径正常）。怀疑某 EDR / fs filter
  // 拦了这两个子目录。启动时往 data/ 和 workspace/ 各写一个 probe 文件 +
  // 立刻 statSync 验证 mtime 真的更新；不更新就在 trace 里大喊 FAKED。
  for (const dir of [dataDir, workspaceDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '_writeprobe.tmp');
      const stamp = `probe ${Date.now()}`;
      let beforeMtime = 0;
      try { beforeMtime = fs.statSync(probe).mtimeMs; } catch {}
      fs.writeFileSync(probe, stamp, 'utf8');
      const afterMtime = fs.statSync(probe).mtimeMs;
      const real = afterMtime > beforeMtime;
      const readBack = fs.readFileSync(probe, 'utf8');
      const matches = readBack === stamp;
      _traceLog('writeprobe',
        `dir=${dir} mtime_changed=${real} content_matches=${matches} `
        + `stamp_len=${stamp.length} readback_len=${readBack.length}`);
      try { fs.unlinkSync(probe); } catch {}
    } catch (e) {
      _traceLog('writeprobe ERROR', `dir=${dir} err=${e?.message || e}`);
    }
  }

  // License gate is mandatory. The main window only opens after a
  // successful /v1/login. Cached key on disk → silent re-login.
  _traceLog('license.ensureLoggedIn START');
  try { await license.ensureLoggedIn(app.getPath('userData')); }
  catch (e) { console.error('[license] gate failed:', e?.message || e); _traceLog('license.ensureLoggedIn ERROR', String(e?.message || e)); }
  _traceLog('license.ensureLoggedIn DONE');

  // Map easydeal-asset:///some/path → file:// at <workspace>/some/path.
  // Reject anything that escapes the workspace root.
  protocol.handle('easydeal-asset', (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = path.resolve(workspaceDir, rel);
      const root = path.resolve(workspaceDir) + path.sep;
      if (!abs.startsWith(root)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(abs)) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(abs).toString());
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  });

  _traceLog('settings.init START');
  settings = new SettingsStore(dataDir);
  await settings.init();
  _traceLog('settings.init DONE');
  // 0.3.265: settings.json 损坏检测 — init 时如果 JSON parse 失败, settings
  // 把损坏文件 rename .corrupt-<ts> + 设 _suspectDataloss=true. 这里在 window
  // ready 后弹 error dialog 让用户知道 (防止用户毫无察觉以为 EasyDeal 自己
  // 把数据清了).
  if (settings._suspectDataloss) {
    _traceLog('settings.init :: _suspectDataloss=true — will alert user after window ready');
    setTimeout(() => {
      try {
        dialog.showMessageBox(win, {
          type: 'error',
          title: 'EasyDeal 配置文件损坏',
          message: 'settings.json 上次写入时被中断 (断电 / 进程被强杀 / 磁盘满),\n'
            + 'JSON 已损坏无法读取.',
          detail: '为防止误覆盖您的 MT5 实例 / 策略配置, 配置文件已自动 rename 为\n'
            + '<userData>/data/settings.json.corrupt-<时间戳>\n'
            + '保留供您 / 客服恢复.\n\n'
            + '另一个备份在 settings.json.bak-prev (上次成功保存的版本) — \n'
            + '可直接复制成 settings.json 即可恢复.\n\n'
            + 'EasyDeal 暂时以空配置启动, 请去「设置」tab 检查并重新添加 MT5 实例.',
          buttons: ['知道了'],
          defaultId: 0,
        });
      } catch (e) { console.warn('[settings] alert dialog failed:', e?.message); }
    }, 3000);
  }
  // 1.3.17: 老系统检测 — Win10 <1809 / Server 2016 及以下跑不了 Claude Code 2.x 原生
  // exe(Bun 运行时, 最低 Win10 1809 / Server 2019), AI 进程会秒崩 0xC0000409 且无输出,
  // 客户端历史上误报成「模型暂时不可用」(用户 Server 2016 ECS 实测查偏方向)。
  // 启动时给一次明确提示; chat-session._classifyChatError 也会在崩溃时给同款指向。
  try {
    const _osRelease = require('node:os').release();
    const _osp = String(_osRelease).split('.');
    const _osMajor = Number(_osp[0] || 0), _osBuild = Number(_osp[2] || 0);
    if (process.platform === 'win32' && (_osMajor < 10 || (_osMajor === 10 && _osBuild < 17763))) {
      setTimeout(() => {
        try {
          dialog.showMessageBox(win, {
            type: 'warning',
            title: 'EasyDeal — 系统版本过低',
            message: `本机 Windows 版本（${_osRelease}）低于 AI 引擎的最低要求\nWindows 10 1809 / Windows Server 2019。`,
            detail: 'AI 对话 / 策略编写 / 回测分析等 AI 功能将无法运行（进程启动即崩溃），\n'
              + '这不是模型或网络问题。\n\n'
              + '解决：升级操作系统到 Windows 10(1809+) / Server 2019 / Server 2022。\n'
              + '云服务器（阿里云等）可在控制台「更换操作系统」，数据盘不受影响\n'
              + '（EasyDeal 与 MT5 需重装）。\n\n'
              + '监控 / 行情 / 手机同步等非 AI 功能不受影响，可继续使用。',
            buttons: ['知道了'],
            defaultId: 0,
          });
        } catch (e) { console.warn('[os-check] alert dialog failed:', e?.message); }
      }, 3500);
    }
  } catch {}
  // settings.json 被外部进程（easydeal-settings MCP）改了 → 推 settings:changed
  // 给所有 renderer，让设置页 UI 不用手动刷就能看到 Claude 帮你改的东西。
  //
  // 0.3.52: 外部改动后还要 reapplyWorkspaceFromSettings() 重写 .mcp.json。
  // 之前漏了这步 — settings:set IPC 路径（UI 改）会跟着 reapply，但
  // easydeal-settings MCP 写 settings.json 走 watcher 这条路，main.js 只
  // broadcast UI 刷新就完事 → .mcp.json 里 EA_SYMBOLS / EA_MAGIC_NUMBERS /
  // EASYDEAL_TRADING_WRITE 等 env 留在老值 → 下次 Claude SDK 起新 MCP child
  // 读 .mcp.json 时拿到的还是 stale env。学评 (XBQ8-PX7X) 撞过：他/Claude 用
  // set_monitor_symbols 把 monitor.symbols 改成 ["XAUUSD.c"]，下一轮对话起的
  // MCP child 用的还是默认 EA_SYMBOLS="GOLD,GOLD#,XAUUSD,XAUUSDm,XAUUSDc" →
  // TradingContext init 报「MT5 中不存在币对 GOLD」+ Service startup failed
  // log 三连（虽然 _maybe_reload_settings 后续会补救，但 init 阶段已经污染）。
  settings.setOnExternalChange((resolved) => {
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w && !w.isDestroyed() && w.webContents) {
          w.webContents.send('settings:changed', resolved);
        }
      }
    } catch (e) {
      console.warn('[settings] broadcast settings:changed failed:', e?.message || e);
    }
    // 别 await — onExternalChange 是同步 watcher 回调，不能阻塞它。后台跑就行。
    reapplyWorkspaceFromSettings().catch((e) => {
      console.warn('[settings] reapplyWorkspace after external change failed:', e?.message || e);
    });
  });

  _traceLog('tokenStore.init START');
  tokenStore = new TokenStore(dataDir);
  await tokenStore.init();
  tokenStore.configureCodexBridge({
    pythonBin: settings.getResolved().pythonBin || 'python',
    scriptPath: resolveBundledFile('python', 'easydeal_codex_cli_bridge.py'),
    workspaceDir,
    codexBin: process.env.EASYDEAL_CODEX_BIN || '',
  });
  _traceLog('tokenStore.init DONE');
  require('./_token-accessor').set(tokenStore);   // global access for headless spawns
  // 0.3.38: 把 reissuer 也注到全局 accessor，给 claude-runner.js（headless 微信
  // + 定时任务）调 channel-error retry。chat-session.js 已经有同款机制（通过
  // ChatSession constructor 的 tokenReissuer 参数注入），这里把同一个函数也注到
  // _token-accessor 给 headless 路径用。
  // 0.3.44: 加 tryFallback —— 当 caller 撞 channel error，先调一次 same model
  // 没用（说明 server-side 同款 model 的所有 channel 都死了）就用 tryFallback
  // 拉一遍模型列表挑一个跟当前 cached_model 不同的 issue。返回 { model } 让
  // caller 能在 UI 上告诉用户「由 X 切到 Y」。用户场景：DeepSeek 通道全挂
  // 时自动切到 GLM-5.1，避免用户卡在「API Error: 500」一动不动。
  const _sharedReissuer = async ({ model, tryFallback } = {}) => {
    const ctx = await _fayContext();
    if (!ctx.license_key) throw new Error('no license');
    let pickedModel = model;
    if (tryFallback) {
      // 1.2.x: 选定 model 的通道全挂时, 不再写死切 MiniMax-M2.7 —— 改成「重走 auto」。
      // 让服务端在所有允许 model 的健康通道里挑当前用量最少的那条 (token.py auto 选路
      // 已过滤 cooldown, 不会再选回刚挂进冷却的那个 → 不死循环; GLM 等恢复后还能自动用回)。
      // 这样切过去的是「当下最优通道」而非永远钉在 2.7; 且下面 cached_model 存 'auto'
      // → 之后每次失败都重新走 auto。'auto' 是服务端一等 model (总在列表首位、issue 时
      // 绕过 allowed 校验), 不必再 GET /v1/token/models 挑了。
      pickedModel = 'auto';
    }
    const r = await serverApi.post('/v1/token/issue', { model: pickedModel, ...ctx });
    if (!r.ok || !r.token) throw new Error(r.error || 'reissue failed');
    // ⚠ 2026-06-24 修复「无法使用」根因: fallback 以前在这里存 cached_model='auto',
    // 但 cached_model 会被注入成 ANTHROPIC_MODEL, 而 claude-code 发请求前拿它去 /v1/models
    // 预检 —— 'auto' 不是具体 model → "selected model (auto) may not exist" 直接拒, 然后又
    // 触发 fallback, 死循环式报错(用户客户即此)。改为**永远存 server 解析出的具体 model**
    // (issue 已把 'auto' 翻成 effective_model 返回 r.model); auto 的"每次选最优"由代理端
    // 兜底重选保证(token.py: 无论 token 绑 auto 还是具体 model 都按 least-loaded 重路由),
    // 不依赖这里存 'auto'。intent 记到 cached_model_requested 供 UI 显示/续签参考。
    const resolvedModel = r.model || (pickedModel !== 'auto' ? pickedModel : null) || null;
    await tokenStore.setFay({
      cached_token: r.token,
      cached_base_url: r.base_url || null,
      cached_model: resolvedModel,                          // 具体 model, 绝不存 'auto'
      cached_model_requested: tryFallback ? 'auto' : (model || null),
      cached_until: r.expires_at || (Date.now() + 30 * 60 * 1000),
      context_window: r.context_window || null,   // 1.2.31: 真实窗口 → 主动压缩
    });
    _broadcastTokenChange();
    console.log(`[reissue] fay ${tryFallback ? 'FALLBACK ' : ''}token model=${r.model || pickedModel} channel_id=${r.channel_id}`);
    return { ok: true, model: r.model || pickedModel, fallback: !!tryFallback };
  };
  require('./_token-accessor').setReissuer(_sharedReissuer);

  // First-launch convenience: if the user is on Fay mode (now the default
  // for new installs) and has a license but no fresh token, auto-pick the
  // first allowed model and issue a token. Fire-and-forget so a slow server
  // doesn't block boot. If it fails the user falls back to the Token tab.
  _autoIssueFayIfNeeded().catch((e) => {
    console.warn('[token] auto-issue fay failed:', e?.message || e);
  });

  // 1.0.5: Fay token 后台主动续签 — 每 4 分钟检查一次, token 离过期 < 10min 就提前
  // 重签. 根因 (用户 反复反馈「Fay 通道 token 要点『使用』再签发才能用」): token TTL
  // 只有 30min, 之前只有 3 条续签路径 —— (a) 手动点「使用」(b) spawn 报 channel 错才
  // 反应式重签 (而且那个正则不匹配 401-token 过期) (c) 开机一次性签. 没有任何「挂机时
  // token 静默过期了主动续」的逻辑 → 用户挂机 >30min 回来 token 已死, 只能手动点「使用」.
  // 现在后台定时续, token 永不过期, 用户无感. _autoIssueFayIfNeeded 内部已 gate:
  // 非 fay 模式 / token 还有 >10min → 直接返回不发网络请求, 所以这条 timer 很轻.
  setInterval(() => {
    _autoIssueFayIfNeeded(10 * 60 * 1000).catch(() => {});
  }, 4 * 60 * 1000);

  _traceLog('kb new + reapplyWorkspaceFromSettings START');
  kb = new KnowledgeBase(workspaceDir);
  await reapplyWorkspaceFromSettings();
  _traceLog('reapplyWorkspaceFromSettings DONE');
  try {
    await require('./bundled-eas').installBundledEas({
      bundledDir: resolveBundledFile('bundled-eas'),
      workspaceDir,
      dataDir: path.join(app.getPath('userData'), 'data'),
      log: (m) => console.log('[bundled-eas]', m),
    });
  } catch (e) {
    console.warn('[bundled-eas] install failed:', e?.message || e);
  }
  try {
    await require('./bundled-eas').removeServerSyncedDocs({
      workspaceDir,
      log: (m) => console.log('[bundled-docs]', m),
    });
    await require('./bundled-eas').syncBundledDocs({
      docsDir: resolveBundledFile('docs'),
      workspaceDir,
      log: (m) => console.log('[bundled-docs]', m),
    });
  } catch (e) {
    console.warn('[bundled-docs] sync failed:', e?.message || e);
  }
  if (!settings.getResolved().easydealScript) {
    console.warn('[easydeal] python MCP script not found — set in 设置 tab or place the easy-deal repo as a sibling of easydeal-client/');
  } else {
    console.log(`[easydeal] python MCP will be spawned from: ${settings.getResolved().easydealScript}`);
    const synced = await kb.syncReferenceDocs({ easydealScript: settings.getResolved().easydealScript });
    if (synced.length) console.log(`[kb] synced reference docs: ${synced.join(', ')}`);
  }

  strategies = new Strategies(workspaceDir, dataDir);
  await strategies.init();

  attachments = new Attachments(workspaceDir);
  await attachments.init();

  backtests = new BacktestsStore(path.join(dataDir, 'backtests.json'),
    () => settings.getResolved().pythonBin, resolveBundledFile('python', 'wind_backtests.py'));

  _traceLog('chat.init START');
  // 1.3.x 多会话: 用 ChatSessionManager 持有 global + 每(账户,策略)一条独立 ChatSession。
  // 全局会话行为与旧版完全一致(文件 chat.json / channel 'chat')。`chat` 保留为全局会话引用,
  // 旧代码路径(定时自愈/carryover 等)继续只作用全局, 不受多会话影响。
  chatMgr = new ChatSessionManager({
    workspaceDir,
    dataDir,
    tokenStore,
    tokenReissuer: _sharedReissuer,
    buildGlobalContext: () => buildLiveWorkspaceContext(workspaceDir),
    buildStrategyContext: (login, ea) => buildStrategyContext(workspaceDir, login, ea),
    // 1.4.x「附加远程会话」: 每次 spawn 前现写 per-session 的 remote mcp-config
    // (带当前 token — 不吃 .mcp.json env 快照 stale 的亏, 见 ~1055 学评案例)。
    // 1.5.x: scope 不再固定只读, 改为跟随通讯栏远程控制授权的档位(用户拍板「与
    // 通讯栏请求远程控制的权限一致」)。attachment 里存的 scope 来自 grant 候选
    // (chat:remote-candidates), 服务端每次调用仍按真实 grant 闸 — 客户端声明
    // 高了照样 403, 这里只决定 MCP 暴露哪些工具。
    remoteMcpProvider: (session) => {
      try {
        // 2026-08-08 多台附加: 每台被控机一个独立 MCP server(各自的 target/scope)。
        // 工具名由 Claude Code 按 server 名加前缀(mcp__<server>__<tool>), 所以天然隔离,
        // 不会 A 的 get_status 跑到 B 上。单台时 server 名仍叫 `remote`(见
        // ChatSession.remoteServerName 的注释: 改名会让存量会话记住的工具名失效)。
        const atts = (typeof session?.getRemoteAttachments === 'function')
          ? session.getRemoteAttachments()
          : (session?.remoteAttachment ? [session.remoteAttachment] : []);
        if (!atts.length) return null;
        const token = (() => { try { return require('./license')._activeToken(); } catch { return null; } })();
        if (!token) return null;
        const s2 = (settings && settings.getResolved) ? settings.getResolved() : {};
        const proxyScript = s2.easydealScript
          ? path.join(path.dirname(s2.easydealScript), 'remote_proxy_mcp.py')
          : path.join(__dirname, '..', 'python', 'remote_proxy_mcp.py');
        if (!fs.existsSync(proxyScript)) return null;
        const dir = path.join(dataDir, 'remote-attach');
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(session.sessionKey || 'global').replace(/[^A-Za-z0-9_-]/g, '_');
        const fp = path.join(dir, `${safe}.mcp.json`);
        const { ChatSession: _CS } = require('./chat-session');
        const servers = {};
        atts.forEach((att, i) => {
          if (!att?.clientKey) return;
          const name = _CS.remoteServerName(
            att.clientKey, i, atts.length, !!(session?._forceQualifiedRemoteNames),
          );
          servers[name] = { command: s2.pythonBin || 'python', args: [proxyScript], env: {
            EASYDEAL_REMOTE_TARGET: att.clientKey,
            EASYDEAL_REMOTE_TOKEN: token,
            EASYDEAL_REMOTE_BASE: require('./server-api').baseUrl(),
            EASYDEAL_REMOTE_SCOPE: (['read', 'manage', 'trade'].includes(att.scope) ? att.scope : 'read'),
          } };
        });
        if (!Object.keys(servers).length) return null;
        fs.writeFileSync(fp, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
        return fp;
      } catch (e) {
        console.warn('[chat] remote-attach mcp-config 写入失败:', e?.message || e);
        return null;
      }
    },
    // 把所有会话(全局+策略)的 UI 事件转发给 renderer, 带 sessionKey(第2参); renderer 过滤到
    // 当前激活会话。取代下面老的「只转发全局 chat」循环。
    onEvent: (sessionKey, ev, payload) => {
      try { win?.webContents.send(`chat:${ev}`, payload, sessionKey); } catch {}
      // 用户案例: 升级强制退出后发现最近对话没持久化(之前记录都在)——根因是
      // durableWriteSync 失败时早就 emit persist-error, 但之前完全没人监听, 用户对
      // "正在悄悄丢数据"毫无察觉。这里加系统级通知兜底(渲染层横幅见 chat-view.js),
      // 覆盖"没在看 AI tab / 窗口最小化"的情况。节流 5min 一次防连续失败刷屏。
      if (ev === 'persist-error') {
        try {
          const now = Date.now();
          if (!_lastPersistErrorNotifyAt || (now - _lastPersistErrorNotifyAt) > 5 * 60_000) {
            _lastPersistErrorNotifyAt = now;
            if (Notification.isSupported()) {
              new Notification({
                title: '⚠ EasyDeal 对话记录保存失败',
                body: `原因: ${payload?.reason || '未知'}。请检查磁盘空间/权限，必要时重启客户端，避免继续丢失最新对话。`,
              }).show();
            }
            console.error('[chat] persist-error', sessionKey, payload);
          }
        } catch {}
      }
    },
  });
  await chatMgr.init();
  chat = await chatMgr.getGlobal();
  _traceLog('chat.init DONE');

  // 0.3.163: OrderGuard 拦截模式状态机修复 — 用户反馈「让 AI 修改完，再由 AI 去改变状态」.
  // 之前 enableEa 是在 deployIntercept 之前调的, 用户点全停 / AI 改 EA 失败时
  // OG 服务里 enabled=true 但 EA 没真插入拦截调用 → UI 显示「已启用」但其实是假启用.
  // 修法: 拦截模式不立即 enableEa, 改成把 {magic, thresholds} 存进 _pendingEnforceRetrofit,
  // 监听 chat 'busy' false 事件, 检查最后一条 assistant turn 是否:
  //   (a) 含「✅ 已为 <eaName> 加上 OrderGuard」成功标记 → enableEa
  //   (b) interrupted 或 dismissed (全停 / 用户中断) → 丢弃 pending
  //   (c) 都不是 → 继续等下次 busy false 事件
  chat.on('busy', async (busy) => {
    if (busy) return;                              // 只关心 idle 边沿
    if (_pendingEnforceRetrofit.size === 0) return;
    const last = [...chat.history].reverse().find((t) => t.role === 'assistant');
    if (!last) return;
    for (const [eaName, cfg] of Array.from(_pendingEnforceRetrofit.entries())) {
      const wasInterrupted = !!(last.interrupted || last.dismissed_at_ts);
      const contentStr     = typeof last.content === 'string' ? last.content : '';
      // 0.3.284: 放宽 success marker 识别. 用户实测 case:
      // AI 检测到 EA 已经集成过 OrderGuard, 回「GMarket 已经完整集成了 OrderGuard
      // 拦截 ... 无需备份、修改或编译 — 代码已经就绪」 — 语义上等价于「成功」,
      // 但不带原 ✅ 标记 → 老逻辑认不到 → 永远等不到 enable → 护航 tab 显示 0.
      // 现在加多个变种: 「已完整集成」/「代码已就绪」/「无需修改」(必须同时含 eaName).
      const mentionsEa = contentStr.includes(eaName);
      const hasSuccessMarker = contentStr.includes(`✅ 已为 ${eaName}`);
      const hasAlreadyIntegrated = mentionsEa && (
        /已[经]?完整?(集成|接入).*OrderGuard/i.test(contentStr) ||
        /OrderGuard.*已[经]?完整?(集成|接入)/i.test(contentStr) ||
        /代码已[经]?(就绪|完备|集成)/i.test(contentStr) ||
        /无需.*?(备份|修改|编译|改动)/i.test(contentStr)
      );
      const isSuccess = !wasInterrupted && (hasSuccessMarker || hasAlreadyIntegrated);
      if (isSuccess && !hasSuccessMarker) {
        console.log(`[orderguard] retrofit ${eaName} success detected via fuzzy match (already-integrated path)`);
      }
      if (isSuccess) {
        // 0.3.238: 修「AI 说已护航实质没有」根因 — 之前 await enableEa() 返 {ok:false}
        // 时没检查 ok 字段直接 fall through 到「success」分支, UI 收到 enabled:true
        // 通知用户以为成了, 实际 OG 没 enable. 现在严格 check r.ok, 失败时通过
        // orderguard:auto-enable-failed IPC 通知 renderer 弹 alert 显详细错误.
        let result = null;
        let exc = null;
        try {
          result = await orderguard.enableEa(eaName, cfg.magic, 'enforce', cfg.thresholds);
        } catch (e) {
          exc = e;
        }
        if (exc) {
          console.error(`[orderguard] auto-enable ${eaName} threw:`, exc);
          if (win && !win.isDestroyed()) {
            win.webContents.send('orderguard:auto-enable-failed', {
              ea_name: eaName,
              stage: 'exception',
              error: String(exc?.message || exc),
              stack: String(exc?.stack || '').slice(0, 800),
            });
          }
        } else if (!result?.ok) {
          console.error(`[orderguard] auto-enable ${eaName} returned !ok:`, result);
          if (win && !win.isDestroyed()) {
            win.webContents.send('orderguard:auto-enable-failed', {
              ea_name: eaName,
              stage: result?.stage || 'og_http',
              error: result?.error || 'OG /enable returned !ok',
              og_response: result,
            });
          }
        } else {
          console.log(`[orderguard] auto-enabled ${eaName} (enforce) after retrofit success`);
          if (win && !win.isDestroyed()) {
            win.webContents.send('orderguard:state-changed', { ea_name: eaName, enabled: true, mode: 'enforce' });
          }
        }
        _pendingEnforceRetrofit.delete(eaName);
      } else if (wasInterrupted) {
        console.log(`[orderguard] retrofit ${eaName} interrupted/dismissed → NOT enabling`);
        _pendingEnforceRetrofit.delete(eaName);
      }
      // 其它情况 (AI 输出还没含成功标志也不算中断, 罕见): 留 pending, 下次 busy false 再判.
      // 但加一个 30min 超时兜底, 避免 map 泄漏
      if (cfg.startedAt && Date.now() - cfg.startedAt > 30 * 60_000) {
        console.log(`[orderguard] retrofit ${eaName} timed out 30min → discarding`);
        _pendingEnforceRetrofit.delete(eaName);
      }
    }
  });

  _traceLog('startSchedulerSidecar START');
  await startSchedulerSidecar(dataDir, workspaceDir);
  _traceLog('startSchedulerSidecar DONE');
  // 0.3.207: 启动期 reconcile user_intent → kill-flag — 让用户上次 EasyDeal 关掉
  // 的 MT5 实例继续保持「被关闭」状态, OG / stats-collector / account-info 启动
  // 后第一时间看到 flag 不会尝试 attach 把它拉起来.
  try {
    await _reconcileKillFlagsFromUserIntent();
  } catch (e) {
    console.warn('[startup] reconcile kill-flags failed:', e?.message || e);
  }
  // 0.3.225: 原本会按 user_intent='running' 把上次开过的实例跨重启自动拉起。
  // 1.2.x (用户明确要求「EasyDeal 启动阶段永远不自动打开 MT5」): **停用启动期自启**。
  //   MT5 一律由用户在「MT5」tab 手动点「▶ 启动」才开。reconcile-kill-flags (上面) 保留:
  //   上次关掉(intent=stopped)的实例仍写 flag, OG/stats/account-info 不会去 attach 拉起;
  //   actually-running 的实例 (用户手动开/Windows 自启) 仍正常被监控, 不受影响。
  // 注: 该函数体保留, 只是不在启动期调用 —— 以后若要做成「设置项」可重新接上。
  // try {
  //   await _autoLaunchRunningInstances();
  // } catch (e) {
  //   console.warn('[startup] auto-launch instances failed:', e?.message || e);
  // }
  console.log('[startup] auto-launch MT5 disabled (用户要求: 启动不自动打开 MT5)');
  startStatsCollector();
  startOrderGuard();
  // 0.3.196: 初始化 electron-updater (差分下载 + 静默装). 进度推 renderer 通过
  // 'app:autoupdater-event' channel. 单独的 IPC handler 见下面 ipcMain.handle.
  try {
    autoUpdater.init({
      getMainWindow: () => win,
      log: (m) => console.log('[autoUpdater]', m),
    });
  } catch (e) {
    console.warn('[autoUpdater] init failed (will fall back to old full-installer path):', e?.message || e);
  }
  // 0.3.14: 启动金十快讯 polling provider。每 30s 拉一次最新快讯，落地到
  // <data>/news-buffer.json 给 MCP 子进程 + IPC 给渲染端订阅；同时关键词
  // 命中 → push 系统通知到 chat。
  startNewsProvider(dataDir);
  // Cache workspaceDir so ensureWechatSidecar can find it later without
  // threading an extra arg through every wechat IPC handler.
  _wechatWorkspaceDir = workspaceDir;
  _traceLog('registerIpc + createWindow START');
  registerIpc(workspaceDir);
  startMt5LifecycleSupervisor();
  await createWindow();
  _traceLog('createWindow DONE');
  createTray();
  _traceLog('createTray DONE — startup essentially complete');

  // 0.3.253+: test-IPC 早期启 (whenReady 入口), 这里把 win 注入让 eval endpoint
  // work + dumpState 拿到 wechat/orderguard/strategies 真值.
  if (process.env.EASYDEAL_TEST_PORT && typeof global._lateBindTestIpcWin === 'function') {
    try {
      global._lateBindTestIpcWin();
      _traceLog('test-ipc-server late-bound to win');
    } catch (e) {
      _traceLog('test-ipc-server late-bind FAILED', String(e?.message || e));
    }
  }

  // 0.2.9: 心跳，每 60s 写一行；卡死 / event loop 阻塞时心跳就停。
  // 用户重启后看 trace log 里最后一行 heartbeat 时间 = event loop 死的
  // 时刻。
  // 0.3.152: 迁到 timer-registry (critical=true, debug 用, panic 时也跑).
  timerRegistry.register({
    id: 'trace-heartbeat',
    description: 'event loop 心跳 (60s, debug 用 — 卡死时停, 看 trace log 最后一行)',
    intervalMs: 60_000,
    critical: true,
    fn: async () => {
      _traceLog('heartbeat', `mem=${Math.round(process.memoryUsage().rss/1024/1024)}MB`);
    },
  });
  // Now that the main window exists, dismiss the gate window if any.
  license.setMainWindow(win);
  // 0.3.152: 注册 license heartbeat 到 timer-registry (critical=true, panic 时不停).
  // license.js 自己管 setInterval, 这里只是让「监控」tab 能列出来.
  try {
    timerRegistry.registerService({
      id: 'license-heartbeat',
      description: 'License 心跳 + tier 同步 (60s, critical)',
      critical: true,
      pause:  async () => { /* critical: noop — 停了用户会被踢下线 */ },
      resume: async () => { /* critical: noop */ },
      status: () => license.heartbeatStatus ? license.heartbeatStatus() : {},
    });
  } catch {}
  license.closeGateIfOpen();

  // Eagerly start the WeChat sidecar after the main window is up. Used to
  // be lazy (only on user click 获取二维码 / 刷新), but users complained
  // the topbar 「微信」chip showed 「未登录」 until they opened the settings
  // page and clicked 刷新 — even when PC WeChat was already running and
  // logged in. Now we kick off ensureWechatSidecar() right after window
  // creation; it spawns the Python child, queries iLink, and emits
  // 'wechat:status' which the topbar listens for. Fire-and-forget — if
  // PC WeChat isn't installed / running, the sidecar fails silently and
  // the chip stays 未登录, no startup blocking.

  // 1.3.x: chat UI 事件转发已由 ChatSessionManager.onEvent 统一处理(全局+策略, 带 sessionKey)。
  // 这里不再单独转发全局 chat, 避免重复。tool-use 仍挂全局 chat(下方) —— 策略创建通知/微信回流
  // 是全局关注点, 只需全局会话触发一次。

  // Strategy-creation notifier — when Claude calls Write on a path matching
  // strategies/*.mq5 (or .ex5), push a notice to chat + WeChat (3h window).
  // Idempotent via _notifiedStrategyFiles so a single Write -> one notice
  // even if Claude over-writes the same file later in the same session.
  chat.on('tool-use', (t) => {
    try {
      handleStrategyCreationToolUse(t);
    } catch (e) {
      console.warn('[strategy-notify] tool-use handler failed:', e.message);
    }
  });

  // Capture bot-side WeChat replies issued by Claude through its per-turn
  // MCP child (mcp__wechat__send_message). These bypass our long-lived
  // sidecar entirely, so we mirror them into sidecar.recentByChat here so
  // the next inbound from the same WeChat user gets the full back-and-forth
  // as prompt context.
  chat.on('tool-use', (t) => {
    try {
      if (t?.name === 'mcp__wechat__send_message'
          && t.input?.to_user_id && t.input?.text) {
        wechatSidecar?.recordOutbound?.(t.input.to_user_id, t.input.text);
        // 0.3.269: 记 Claude 主动调 send_message 的时间, 让 _fireWechatBatch
        // 的 r.result fallback 跳过 (Claude 已经发过, 不需要兜底重复发).
        // 修「fallback 又把 Claude 回复的 r.result 重发一次 + 把 mcp ack
        // 文本 "消息已发送" 也发出去」的双发 bug.
        if (!globalThis._lastClaudeSendByChat) globalThis._lastClaudeSendByChat = new Map();
        globalThis._lastClaudeSendByChat.set(String(t.input.to_user_id), Date.now());
      }
    } catch (e) {
      console.warn('[wechat-ctx] tool-use mirror failed:', e.message);
    }
  });

  // 易策随身「手机中继」(线 B) — 绑定模式桌面侧 consumer。1.1.17 起启用:
  // relay 对 404 (server 没部署线 B app_desktop 端点, 如当前 prod) 自带 10min 长退避
  // 自我静默, 所以常开安全; 本地试机/线 B server 上线后自然激活。
  // 指向本地 dev server 测试: 启动时设 EASYDEAL_API_URL=http://<ip>:8099。
  try {
    const { startMobileRelay } = require('./mobile-relay');
    mobileRelay = startMobileRelay({
      getLicense: () => { try { return license.getStatus(); } catch { return {}; } },
      // 安全中继(2026-07-31): 用当前桌面 session token 换可撤销的 relay 凭证, 之后所有
      // 中继请求签名。没有它, 服务端只能靠可泄露的 X-License-Key 认人 —— 陌生手机号
      // 强绑序列号那次走的就是那条路。见 electron/relay-credential.js。
      getSessionToken: () => { try { return license._activeToken(); } catch { return null; } },
      // 多会话: 不传 key(或 falsy) → 全局会话(同步返回, 老调用不变);
      // 传 sessionKey(strat:<login>:<ea>) → 该策略会话(返回 Promise, relay 侧 await)。
      getChat: (sessionKey) => (sessionKey && chatMgr) ? chatMgr.get(sessionKey) : chat,
      // AI 沟通全量同步要读 data/ 下的 wechat-recent / remote-ai-chats store
      dataDir: path.join(app.getPath('userData'), 'data'),
      callTool: (tool, args, opts) => callEasydealMcpOnce(tool, args, opts),
      // 给持仓上报做「在跑 EA → magic」归属(只取 is_mounted 的, 修同 magic 串账)。
      // 1.3.x: 改用 _resolveStrategiesListArgs() 跟 UI 的 strategies:list IPC 同款(带
      // mt5InstancesList) —— 之前这里只传默认实例路径, 绑在非默认实例上的 EA(如实盘
      // GMarket_easydeal版 绑 EXNESS2, 默认实例是 EXNESS)永远查错实例的日志/.chr, 上报
      // run_state 恒「deployed_unconfirmed」, 即使桌面 UI 正确显示「运行中」(用户实测:
      // 桌面显运行中, app 却显已部署未确认)。
      getRunningEas: async () => {
        try {
          return await strategies.list(await _resolveStrategiesListArgs());
        } catch { return []; }
      },
      // 数据大屏 K 线: 序列号授权给大屏时上传各实例 EA 窗口品种的 K 线(见 mobile-relay._reportKlines)
      getBoardKlineSources: () => _boardKlineSources(),
      log: (m) => console.log('[mobile-relay]', m),
    });
  } catch (e) {
    console.warn('[mobile-relay] start failed:', e?.message || e);
  }

  // 序列号远程控制 — 被控端引擎 (线 A, 一期). 订阅 server SSE, 收操盘手指令**确定性执行**
  // (callEasydealMcpOnce, 不碰本机 AI 会话). 含经验推送 push_preferences/knowledge/og_rules.
  // 只在登录后订阅 (内部 getToken 为空时自旋等登录). 失败不影响主流程.
  try {
    require('./remote-control').startRemoteControl({
      baseUrl: require('./server-api').baseUrl(),
      getToken: () => { try { return require('./license')._activeToken(); } catch { return null; } },
      callTool: (tool, args, opts) => callEasydealMcpOnce(tool, args, opts),
      workspaceDir,
      applyOgRules: null,   // 二期接护航 (push_og_rules 暂返 not-wired)
      strategies,           // push_strategy 覆盖模式保住本机 monitor_config(品种/魔术号不被源机覆盖)
      // 2026-08-08「远程 AI 会话」: remote_ai_send / remote_ai_messages 要碰本机 AI 会话。
      // 这是上面那句「不碰本机 AI 会话」的**唯一例外** —— 前提是操盘手持 trade 档 grant,
      // 且被控端 busy 时拒投递(不抢占客户自己正在跑的那一轮), 见 remote-control.handleRemoteAi。
      // chatMgr 在 1219 建、1286 init, 都早于这里; 传管理器本身(不是单个 session),
      // 这样 remote_ai_send 能按 session_key 定向到策略会话, 默认走 global。
      chatSessions: chatMgr,
      log: (m) => console.log('[remote-control]', m),
    });
  } catch (e) {
    console.warn('[remote-control] start failed:', e?.message || e);
  }

  // 0.5.x 加固: 启动检查 bundled python.exe 是否被安全软件删除。删了的话护航 / 账户 /
  // AI 工具全废, 但用户只看到「不可达」摸不着头脑 — 弹一次明确、可操作的提示。
  try {
    settings.getResolved();   // 触发 _bundledPythonPath 解析(缺失会设 global flag)
    if (global.__pythonRuntimeMissingPath) {
      const { dialog } = require('electron');
      dialog.showMessageBox({
        type: 'error',
        title: 'EasyDeal — Python 运行时缺失',
        message: 'EasyDeal 的 Python 运行时(python.exe)不见了，很可能被安全软件当成病毒删除 / 隔离了。',
        detail: '受影响：护航(OrderGuard)、账户数据、AI 工具 全部无法工作。\n\n'
          + '修复步骤：\n'
          + '1) 把 EasyDeal 安装目录加入安全软件白名单 / 信任区；\n'
          + '2) 重新安装 EasyDeal（或到安全软件「隔离区」还原 python.exe）；\n'
          + '3) 重启 EasyDeal。\n\n'
          + '缺失文件：' + global.__pythonRuntimeMissingPath,
        buttons: ['知道了'],
        noLink: true,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[python-runtime-check] failed:', e?.message || e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS apps stay alive when all windows close. On Windows/Linux the
// 'close' handler hides the window instead of destroying it, so this only
// fires when the user picks "彻底退出" from the tray (which sets isQuitting).
app.on('window-all-closed', () => {
  if (!isQuitting && process.platform !== 'darwin') return;
  if (process.platform !== 'darwin') app.quit();
});

// 0.3.52: Final cleanup hook — 必须同步 await 所有 sidecar / chat 的 stop()，
// 不然 Electron 在 promise resolve 前就 tear down 了，子进程（scheduler_mcp.py /
// wechat_mcp.py / 活跃的 claude turn）变孤儿留在任务管理器里。
// 老代码用 `client.stop().catch(...)` fire-and-forget + 立刻 `app.quit()`，
// 第一次 quit 触发时 stop 的 SIGTERM 还没发就被 Electron 自己干掉了。
// 用 preventDefault + 异步清理 + 再次 quit 的标准模式：第一次 before-quit
// 拦下 quit，并发跑所有 stop() 直到完成（或撞超时强杀），然后置 _cleanupDone
// 让第二次 before-quit 直接放行。
let _cleanupDone = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (_cleanupDone) return; // second pass — let Electron actually quit
  event.preventDefault();
  (async () => {
    if (schedulerTimer) {
      try { clearInterval(schedulerTimer); } catch {}
      schedulerTimer = null;
    }
    const cleanups = [];
    if (chat?.stop) {
      cleanups.push(
        Promise.race([
          chat.stop().catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ])
      );
    }
    if (schedulerClient) {
      cleanups.push(schedulerClient.stop({ timeoutMs: 2500 }).catch(() => {}));
    }
    if (wechatSidecar?.stop) {
      cleanups.push(
        Promise.race([
          wechatSidecar.stop().catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ])
      );
    }
    if (statsCollector?.stop) {
      try { statsCollector.stop(); } catch {}
    }
    if (orderguard) {
      cleanups.push(orderguard.stop().catch(() => {}));
    }
    // 0.3.194: 0.3.191 Phase 3 pool 多了, 保险起见再直接 stopAll 一次 (orderguard
    // proxy 已经走 pool.stopAll, 但万一 proxy 没初始化好 / orderguard 是 null 时
    // ogPool 仍可能有遗留子进程, 这里兜底).
    if (ogPool && !orderguard) {
      cleanups.push(ogPool.stopAll().catch(() => {}));
    }
    if (newsProvider?.stop) {
      try { newsProvider.stop(); } catch {}
    }
    // 关闭 Token 模式按需启动的本地 HTTP bridge（OpenAI 协议翻译 / Codex CLI）。
    if (tokenStore?.stopLocalBridges) {
      try { await tokenStore.stopLocalBridges(); } catch {}
    }
    try {
      await Promise.all(cleanups);
    } catch {}
    if (tray) { try { tray.destroy(); } catch {} tray = null; }
    _cleanupDone = true;
    app.quit();
  })();
});

// ---------------------------------------------------------------------------
// Helper: resolve a path under the app root that needs to be SPAWN-able
// (i.e. accessible to a child process, not just to Electron's patched fs).
//
// In packaged mode, files matched by the build's `asarUnpack` glob are
// physically extracted to <install>/resources/app.asar.unpacked/<...>,
// while the same logical path under app.asar/ is a virtual entry. fs reads
// transparently, but child processes can't open asar virtual paths — so
// we must hand them the .unpacked location explicitly.
//
// `parts` is path components RELATIVE to the app root (where package.json
// lives). For example: resolveBundledFile('python', 'scheduler_mcp.py').
//
// In dev mode, falls back to <repo>/<parts>.
// ---------------------------------------------------------------------------
function resolveBundledFile(...parts) {
  // Packaged: <install>/resources/app.asar.unpacked/<parts>
  if (process.resourcesPath) {
    const prod = path.join(process.resourcesPath, 'app.asar.unpacked', ...parts);
    if (fs.existsSync(prod)) return prod;
  }
  // Dev / fallback: <repo>/<parts>  (resolve from electron/ → up one)
  return path.resolve(__dirname, '..', ...parts);
}

// ---------------------------------------------------------------------------
// Scheduler sidecar — spawns scheduler_mcp.py and runs the cron-poll loop.
// ---------------------------------------------------------------------------

// 0.3.17: 上架时 ownership 校验 —— 用户本地 .mq5 重新编译一次产新 .ex5，
// marketplace 只上传这份重新编出来的 .ex5。这样如果用户只有偷来的 .ex5
// 但没源码 → compile 失败 / 产物不一致 → 上架被拒。
// 一次性 spawn easydeal MCP server，调 compile_strategy tool，拿结果，停掉。
/**
 * 0.3.25: 一次性 spawn easydeal MCP，调一个工具，拿结果，关进程。
 * 给「我的策略 → 部署按钮 → 自动挂载到图表」这种 UI-driven 操作用。
 * 通用版 — toolName + args 自由组合，比每个工具一个 IPC 封装清爽。
 */
async function callEasydealMcpOnce(toolName, toolArgs = {}, { timeoutMs = 60_000, envOverride = null } = {}) {
  const s = settings.getResolved();
  const script = s.easydealScript;
  if (!script || !fs.existsSync(script)) {
    return { ok: false, error: 'easydeal MCP script 未配置 — 设置 → 高级' };
  }
  const dataDir = path.join(app.getPath('userData'), 'data');
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  const pythonBin = s.pythonBin || 'python';
  const env = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    EASYDEAL_WORKSPACE_DIR: workspaceDir,
    // 0.3.271: 加 EASYDEAL_DATA_DIR — 之前一直没设, 导致 Python 端 launch-flag
    // (_mt5_launch_flag_path 拿不到 dataDir 返 None 静默 noop) 跟新加的
    // mounted-state.json (持久化用户上次挂的 EA) 都没法落盘. 这是 0.3.228 加
    // launch-flag 时漏的环节, 用户撞过双 MT5 spawn 但靠 JS 端单飞兜底没爆.
    EASYDEAL_DATA_DIR: dataDir,
    // Background/one-shot MCP processes are attach-only by default.  The
    // explicit auto-attach IPC grants a short-lived override for its target.
    EASYDEAL_MT5_ALLOW_LAUNCH: '0',
    // 0.3.306: PYTHONPYCACHEPREFIX 让 Python 把 .pyc 写到 userData 而不是 install dir.
    // install dir 保持 immutable → electron-updater 差分算法对 install dir files 算
    // chunk hash 时不会撞 Python 跑时写新 .pyc 的 byte 差异 → diff 真 work, sha 验证
    // 通过, 不再 fallback 全量. (模拟盘报反复「差分完 fallback 全量」根因诊断).
    PYTHONPYCACHEPREFIX: path.join(dataDir, 'python-cache'),
  };
  if (s.mt5?.installDir) env.EASYDEAL_MT5_INSTALL_DIR = s.mt5.installDir;
  if (s.mt5?.dataDir)    env.EASYDEAL_MT5_DATA_DIR    = s.mt5.dataDir;
  const activeMt5 = settings.getActiveMt5Instance?.();
  if (activeMt5?.id)         env.EASYDEAL_MT5_INSTANCE_ID = activeMt5.id;
  if (activeMt5?.launchMode) env.EASYDEAL_MT5_LAUNCH_MODE = activeMt5.launchMode;
  // 交易写权限闸 — 按用户「设置→高级」开关注入(之前漏注入 → 手机中继调 close/modify
  // 起的 MCP 子进程恒无此 env → _is_trading_write_enabled() 永远 false → app 改单/平仓
  // 即使开了权限也报「未开启」)。跟本机 AI / .mcp.json 同款语义。
  if (s.tradingWriteEnabled)      env.EASYDEAL_TRADING_WRITE = '1';
  if (s.tradingWriteOpenEnabled)  env.EASYDEAL_TRADING_WRITE_OPEN = '1';
  // settings.json 路径透传 — pick_chartable_symbol 之类工具会从这里读
  // monitor.symbols 兜底
  const settingsPath = path.join(dataDir, 'settings.json');
  if (fs.existsSync(settingsPath)) env.EASYDEAL_SETTINGS_PATH = settingsPath;
  // 0.5.x: OG 端口文件透传 — 远程控制(操盘手/资管)走 callEasydealMcpOnce 一次性派发
  // get_orderguard_status 等 OG 类工具时, 之前漏设这条 env → Python 拿不到 OG 端口文件
  // → 误报 orderguard_available=false / 「EASYDEAL_ORDERGUARD_PORT_FILE 未设置」, 让操盘手
  // 误以为实盘没开护航(其实开着)。本机长驻 MCP 的 .mcp.json 有设(main.js ~11151 +
  // knowledge-base.js ~197 都用默认 orderguard.port), 所以本机 AI 一直正确 — 这里对齐同一个文件。
  const ogPortFile = path.join(dataDir, 'orderguard.port');
  if (fs.existsSync(ogPortFile)) env.EASYDEAL_ORDERGUARD_PORT_FILE = ogPortFile;
  // 1.4.9: envOverride —— 按实例(账户)路由用. live-stats 遍历每个 MT5 实例时, 传该实例的
  // install_dir/data_dir 覆盖默认, 让 Python 连对账户拉对成交(战绩按账户分组的关键)。
  if (envOverride && typeof envOverride === 'object') {
    for (const [k, v] of Object.entries(envOverride)) {
      if (v != null) env[k] = String(v);
    }
  }
  const client = new StdioMcpClient({
    command: pythonBin,
    args: [script],
    env,
    cwd: workspaceDir,
    label: `easydeal-once-${toolName}`,
  });
  try {
    await client.start({ timeoutMs: 20_000 });
    // 0.3.52: 用 _send 直接拿原始 MCP 响应而不是 client.callTool —— callTool 会
    // 把 `{ok:true, data:...}` 自动 unwrap 成 env.data，但 easydeal 的 tool 都返
    // 扁平 envelope `{ok:true, stage:'...', other:...}`（不套 data 字段），unwrap
    // 后变 undefined → 下面 `res?.content?.[0]?.text` 也读不到 → UI 报「返空响应」。
    // 用户「自动挂载一直失败」根因之一就是这条。直接 _send 拿原始 content 块即可。
    const res = await client._send(
      'tools/call',
      { name: toolName, arguments: toolArgs },
      timeoutMs,
    );
    // 0.3.49: harden — MCP 偶尔返空 content（python 子进程 crash / 工具刚 spawn
    // 就死等）。老逻辑 `res?.content?.[0]?.text || '{}'` 默认成 '{}'，parse 成 {}
    // → 上层 UI 看不到 ok / error / stage 全 undefined，stage 'unknown' + 「没生成
    // ini」误导性提示。用户撞过。
    const txt = res?.content?.[0]?.text;
    if (txt == null || !String(txt).trim()) {
      return {
        ok: false,
        error: `MCP 工具 ${toolName} 返空响应 — python 子进程可能 crash，去 ` +
               `<userData>/logs/easydeal.log 或 stderr 看错因`,
      };
    }
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { return { ok: false, error: 'bad tool result json', raw: String(txt).slice(0, 500) }; }
    // 工具捕获异常后会返 {"error": "..."}（没 ok 字段）—— 没显式 ok 当失败处理，
    // 至少 UI 能看到 error 而不是「stage=unknown」一头雾水。
    if (parsed && typeof parsed === 'object' && !('ok' in parsed) && parsed.error) {
      return { ok: false, ...parsed };
    }
    return parsed;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await client.stop({ timeoutMs: 3000 }); } catch {}
  }
}


async function compileStrategyOnce(eaName, { timeoutMs = 90_000, envOverride = null } = {}) {
  const s = settings.getResolved();
  const script = s.easydealScript;
  if (!script || !fs.existsSync(script)) {
    return { ok: false, error: 'easydeal MCP script 未配置 — 设置 → 高级' };
  }
  const dataDir = path.join(app.getPath('userData'), 'data');
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  const pythonBin = s.pythonBin || 'python';
  const env = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    EASYDEAL_WORKSPACE_DIR: workspaceDir,
    EASYDEAL_DATA_DIR: dataDir,  // 0.3.271: launch-flag + mounted-state 都靠它
    EASYDEAL_MT5_ALLOW_LAUNCH: '0',
    // 0.3.306: 见上面 callEasydealMcpOnce env 同款 PYTHONPYCACHEPREFIX 注释 (修
    // electron-updater 差分 fallback 全量根因 — 让 install dir 保持 immutable)
    PYTHONPYCACHEPREFIX: path.join(dataDir, 'python-cache'),
  };
  if (s.mt5?.installDir) env.EASYDEAL_MT5_INSTALL_DIR = s.mt5.installDir;
  if (s.mt5?.dataDir)    env.EASYDEAL_MT5_DATA_DIR    = s.mt5.dataDir;
  const activeMt5 = settings.getActiveMt5Instance?.();
  if (activeMt5?.id)         env.EASYDEAL_MT5_INSTANCE_ID = activeMt5.id;
  if (activeMt5?.launchMode) env.EASYDEAL_MT5_LAUNCH_MODE = activeMt5.launchMode;
  // 按 EA 绑定的实例编译 (同 callEasydealMcpOnce envOverride) — 否则编在活动实例,
  // deploy-compiled 却拷到绑定实例, 两边 MQL5/Include 不一定一致。
  if (envOverride && typeof envOverride === 'object') {
    for (const [k, v] of Object.entries(envOverride)) {
      if (v != null) env[k] = String(v);
    }
  }
  const client = new StdioMcpClient({
    command: pythonBin,
    args: [script],
    env,
    cwd: workspaceDir,
    label: 'easydeal-compile-once',
  });
  try {
    await client.start({ timeoutMs: 20_000 });
    // 0.3.52: 同 callEasydealMcpOnce 的理由 —— 用 _send 拿原始响应，跳过
    // client.callTool 对 `{ok:true, data}` envelope 的过度 unwrap。easydeal
    // 的 compile_strategy 返扁平 `{ok:true, ex5_path:'...', ...}`，unwrap 后
    // 是 undefined，下面 `res?.content?.[0]?.text || '{}'` 永远 fallback 到
    // '{}' → parsed = {} → 客户端以为 compile 失败但没错误信息。
    const res = await client._send(
      'tools/call',
      { name: 'compile_strategy', arguments: { ea_name: eaName } },
      timeoutMs,
    );
    const txt = res?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = { ok: false, error: 'bad compile result json' }; }
    return parsed;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await client.stop({ timeoutMs: 3000 }); } catch {}
  }
}

async function startSchedulerSidecar(dataDir, workspaceDir) {
  const schedulerScript = resolveBundledFile('python', 'scheduler_mcp.py');
  if (!fs.existsSync(schedulerScript)) {
    console.error('[scheduler] script missing at', schedulerScript);
    return;
  }
  const dbPath = path.join(dataDir, 'scheduler.db');
  const pythonBin = settings.getResolved().pythonBin || 'python';

  schedulerClient = new StdioMcpClient({
    command: pythonBin,
    args: [schedulerScript],
    env: {
      EASYDEAL_SCHEDULER_DB: dbPath,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
    cwd: workspaceDir,
    label: 'scheduler-mcp',
  });

  let _startOk = false;
  try {
    await schedulerClient.start({ timeoutMs: 15_000 });
    const tools = await schedulerClient.listTools();
    console.log(`[scheduler] sidecar ready, ${tools.length} tools, db=${dbPath}`);
    _startOk = true;
  } catch (e) {
    console.error('[scheduler] sidecar failed to start:', e.message);
    schedulerClient = null;
    // 0.4.21 关键修复 — start() 失败不再直接 return 放弃。
    // 老逻辑 catch 里 `return` → 下面 130 行的 7 个后台 ticker 全部不注册 +
    // 永不重试 → scheduler sidecar 启动握手只要失败一次 (机器忙 / 升级后冷启动 /
    // scheduler.db 损坏过 / 15s 握手超时), 整个后台自动化 (回测 poll / 终态巡检 /
    // 诊断上报 / 护航告警 / 中断恢复 / 偏好学习 / 健康检查) 就静默死一整个 session,
    // 必须用户手动重启 EasyDeal 且重启还可能再撞 —— 这是「定时器有问题 / 回测跑完
    // 没后续」长期反复出现的结构性根因。现在: 排个 3s 重试 (直到 sidecar 起来),
    // 并继续往下注册 ticker (它们 self-guard 于 schedulerClient.ready, sidecar
    // 没起来时空转, 重试 ready 后自动开始干活)。
    if (!_schedulerStartRetryPending) {
      _schedulerStartRetryPending = true;
      setTimeout(() => {
        _schedulerStartRetryPending = false;
        startSchedulerSidecar(dataDir, workspaceDir).catch(() => {});
      }, 3000);
    }
  }

  // If the child crashes, restart it. (仅在 start 成功 = client 存活时挂 exit
  // 监听; start 失败时 schedulerClient 已是 null, 重试由上面的 catch 负责。)
  if (_startOk && schedulerClient) {
    schedulerClient.on('exit', () => {
      if (schedulerTimer) clearInterval(schedulerTimer);
      schedulerClient = null;
      setTimeout(() => startSchedulerSidecar(dataDir, workspaceDir), 3000);
    });
  }

  // 0.4.21: 后台 ticker 只注册一次, 跟 sidecar start 成败彻底解耦。
  // 它们都 self-guard 于 schedulerClient.ready (pollAndFire / runReconcilerWithRecord
  // / recordSystemRun 等在 client 没 ready 时直接 no-op 返回), 所以即使本次 start()
  // 失败、sidecar 还没起来, 也能安全注册 —— 等首次/重试把 sidecar 拉起来后它们
  // 自动开始工作。放在函数内是为了复用闭包里的 workspaceDir / dataDir; guard 确保
  // 多次进入 (初始 + start 失败重试 + exit 重启) 时只注册一次, 不重复堆 ticker。
  if (_backgroundTickersRegistered) return;
  _backgroundTickersRegistered = true;

  // 1.4.x 一次性迁移: 扫描全部已有定时任务, 名字/prompt 里含某策略 stem 的自动
  // 归属(update_task ea_name), 其余任务 enabled=0 暂停(用户指示: 升级后只保留
  // 策略绑定的监控任务自动运行, 剩下的由用户按需手动恢复)。flag 文件防重跑。
  // 延迟 30s 等 sidecar ready + strategies 初始化完。
  setTimeout(() => { _migrateTasksToStrategies(dataDir).catch((e) => console.warn('[scheduler] 任务归属迁移失败:', e?.message || e)); }, 30_000);

  // Cron-poll loop. Lives in Node (here) so firing reuses our existing
  // claude-runner; scheduler_mcp.py stays a stateless CRUD layer.
  // Heartbeat counters (`schedulerPollStats`) are surfaced by app:system-tasks
  // so the 系统任务 row shows real "last run" + run count instead of "—".
  // 0.3.152: scheduler poll 改走 timerRegistry — panic / 用户暂停时可联动停
  timerRegistry.register({
    id: 'scheduler-poll',
    description: '轮询用户自定义 cron 任务',
    intervalMs: SCHEDULER_TICK_MS,
    critical: false,
    fn: async () => {
      const t0 = Date.now();
      schedulerPollStats.runCount += 1;
      try {
        await pollAndFire(workspaceDir);
        schedulerPollStats.lastRunAt = Date.now();
        schedulerPollStats.lastStatus = 'ok';
        schedulerPollStats.lastError = null;
        schedulerPollStats.lastDurationMs = Date.now() - t0;
      } catch (e) {
        schedulerPollStats.lastRunAt = Date.now();
        schedulerPollStats.lastStatus = 'error';
        schedulerPollStats.lastError = e.message;
        schedulerPollStats.lastDurationMs = Date.now() - t0;
        console.error('[scheduler] tick error:', e.message);
        throw e;
      }
    },
  });

  // Reconcile interrupted workers and deliver newly completed backtests.
  timerRegistry.register({
    id: 'reconciler',
    description: '风洞任务恢复与完成通知',
    intervalMs: 60_000,
    critical: false,
    fn: runReconcilerWithRecord,
  });
  // 启动节奏（0.1.57 调整）：
  //   1. T+3s：seal 老旧未通知的终态记录（finished_at > 5min）—— 拦下重启
  //      时一锅端弹一堆「回测未完成」/「回测完成」给用户的 boot flood
  //   2. T+5s：reconciler 跑——只剩「极新（5min 内完成）」的还没 notify 的会被推
  //   3. T+8s：cleanup poll cron——把对应已终态的 cron 任务都 cancel 掉
  // T+3 在前是关键。否则 reconciler 在 T+5 看到一堆 notified_at=null 的旧
  // 终态记录就全部 push 过去，1.54 的 cleanup 在 T+8 才发挥也来不及。
  setTimeout(() => _sealStaleUnnotifiedTerminalAtBoot().catch((e) => {
    console.warn('[startup-seal] failed:', e?.message || e);
  }), 3_000);
  setTimeout(() => runReconcilerWithRecord().catch(() => {}), 5_000);
  setTimeout(() => _cleanupAllBacktestPollTasks().catch((e) => {
    console.warn('[startup-cleanup] failed:', e?.message || e);
  }), 8_000);

  // Preference learner — once-a-day cadence. The actual run gate is
  // PreferenceLearner.shouldRun() (≥ 10 new user messages AND ≥ 24h since
  // last run), so this ticker only checks the gate; most ticks are no-ops.
  // Polling once per hour is enough — when the gate opens, the next hourly
  // tick fires it.
  if (!preferenceLearner) {
    preferenceLearner = new PreferenceLearner({
      workspaceDir,
      chatHistoryPath: path.join(dataDir, 'chat.json'),
      // 0.3.285: 把微信对话也喂给偏好学习器. wechat-sidecar 持久化每个 chatId
      // 的 user/bot exchange 到 wechat-recent.json (per-chatId 数组带 ts + role).
      // 用户确认「微信也是自己一个人用」, 不会撞多人偏好混淆.
      wechatRecentPath: path.join(dataDir, 'wechat-recent.json'),
      dataDir,
      log: (m) => console.log('[pref-learn]', m),
    });
  }
  timerRegistry.register({
    id: 'preference-learner',
    description: '用户偏好学习 (≥10 新 user 消息 + ≥24h 触发)',
    intervalMs: 60 * 60 * 1000,
    critical: false,
    fn: maybeRunPreferenceLearner,
  });

  // 「正确使用检查」 每日北京时间 8:00 跑 (每分钟 tick 看条件)
  timerRegistry.register({
    id: 'health-check',
    description: '正确使用检查 (每分钟看是否 8:00 北京时间)',
    intervalMs: 60 * 1000,
    critical: false,
    fn: maybeRunHealthCheck,
  });

  // 诊断快照上报 — 每小时一次
  timerRegistry.register({
    id: 'diag-upload',
    description: 'hourly 客户端诊断快照上报 admin',
    intervalMs: 60 * 60 * 1000,
    critical: false,
    firstRunDelayMs: 90_000,   // 启动后 90s 首次
    fn: uploadDiagnosticSilent,
  });

  // OG 警报推送微信 — 60s 拉 pending → wechat
  timerRegistry.register({
    id: 'og-alert-push',
    description: 'OG 警报推送微信 (60s 拉 pending alerts)',
    intervalMs: 60_000,
    critical: false,
    firstRunDelayMs: 50_000,
    fn: pushOgAlertsToWechat,
  });

  // 中断恢复 ticker — 每 60s 检查最近 assistant turn 是否 interrupted
  timerRegistry.register({
    id: 'chat-resume',
    description: 'chat 中断自动恢复 (60s 检测最近 assistant turn)',
    intervalMs: 60_000,
    critical: false,
    firstRunDelayMs: 45_000,
    fn: maybeRunChatResumeWithRecord,
  });

  // Claude session warm-up — fire-and-forget 一次小 prompt 跑 claude --print，
  // 让 session JSONL load / MCP 子进程拉起 / Anthropic 通道凭据握手 等
  // 冷启动事项在用户消息到来前完成。
  // 用户场景：升完级或重启 EasyDeal 后第一条消息走微信，常被「session 还没暖」
  // 拖住 — 用户感觉「微信没反应，但客户端 AI 能回」，因为客户端打开 chat
  // tab 时会触发 refreshModelSwitcher 隐含暖了一次。这里主动暖一遍，无论
  // 哪条路径都不再吃冷启动。15s 后启动避免抢启动 CPU；不阻塞，吞错误。
  setTimeout(() => {
    if (!chat) return;
    chat.warmup({ timeoutMs: 60_000 })
      .then((r) => console.log('[chat-warmup] done', r))
      .catch((e) => console.warn('[chat-warmup] failed:', e?.message));
  }, 15_000);

  // 0.5.x: 开机种「每日经验总结」cron 任务(幂等, 种一次; 等 scheduler 起来)
  setTimeout(() => { _seedExperienceSummaryTask(); }, 25_000);
}

// 0.5.x: 开机幂等种「每日经验总结」cron 任务 —— 种一次写 marker, 用户删了不复活。
// 到期由现成 cron 轮询 spawn headless AI 跑 prompt → AI 用 read/record_experience
// 把各 EA 当日的护航决策 / 平仓 / 人工介入 / 对话总结进 <EA>.experience.md。
async function _seedExperienceSummaryTask() {
  try {
    const markerFp = path.join(app.getPath('userData'), 'data', '.experience-task-seeded');
    if (fs.existsSync(markerFp)) return;                 // 已种过(即使被删也不再种, 尊重用户)
    let sched = null;
    try { sched = requireScheduler(); } catch { return; }  // scheduler 还没起 → 下次开机再种
    if (!sched) return;
    let exists = false;
    try {
      const r = await sched.callTool('list_tasks', {});
      exists = (r?.tasks || []).some((t) => t && String(t.name || '').includes('每日经验总结'));
    } catch { return; }                                   // list 不通 → 别瞎种, 下次再说
    if (!exists) {
      const prompt =
        '【每日经验总结】对「我的策略」里每一只当前运行中的 EA, 逐只做: '
        + '① read_experience 看已有经验避免重复; '
        + '② get_orderguard_decisions(按 ea 过滤) + get_profit_history + list_all_mt5_status 看今天这只 EA 的护航决策(尤其拦截/调手数)、已平仓盈亏/回撤、有无人工介入(手动平/改单、暂停交易、改参数); '
        + '③ 扫今天跟这只 EA 相关对话里值得留的点; '
        + '④ record_experience(ea_name=该 EA, category=运作|人工介入|教训) 写 1-3 条具体可执行、带数字/条件的经验。'
        + '只记值得长期记住的, 别记流水账; 没有运行中的 EA 就跳过, 不要硬写。';
      await sched.callTool('schedule_task', {
        name: '每日经验总结(AI 自动)',
        schedule: '30 23 * * *',                          // 北京 23:30(scheduler 默认 Asia/Shanghai)
        prompt,
      });
      console.log('[experience] seeded daily summary cron task (北京 23:30)');
    }
    try { fs.mkdirSync(path.dirname(markerFp), { recursive: true }); fs.writeFileSync(markerFp, new Date().toISOString(), 'utf8'); } catch {}
  } catch (e) { console.warn('[experience] seed daily task failed:', e?.message || e); }
}

let preferenceLearner = null;
async function maybeRunPreferenceLearner() {
  if (!preferenceLearner) return;
  if (chat?.isBusy?.()) return;     // don't spawn while the user's chat is mid-turn
  const t0 = Date.now();
  const r = await preferenceLearner.run();
  const dur = Date.now() - t0;
  // Only record actual runs (not the cheap "guard not met" no-ops).
  if (r?.ok || (r && r.reason && r.reason !== 'guard not met' && r.reason !== 'in-flight' && r.reason !== 'too few turns')) {
    await recordSystemRun('sys_preference_learner', '用户偏好学习', {
      status: r?.ok ? 'ok' : 'error',
      summary: r?.ok
        ? (r.learned > 0
            ? `学到 ${r.learned} 条新偏好：${(r.prefs || []).join(' | ')}`
            : '本次没新偏好（已知偏好已经够用）')
        : `跑失败：${r?.reason || 'unknown'}`,
      durationMs: dur,
    });
  }
  if (r?.ok && r.learned > 0 && chat) {
    chat.appendSystemNote(
      `📝 学到 ${r.learned} 条新偏好（已写入 CLAUDE.md，下次新会话自动生效）：\n\n` +
      (r.prefs || []).map((p) => `- ${p}`).join('\n'),
      { kind: 'preference_learned', source: 'preference-learner' },
    );
  }
}

/**
 * 中断恢复 ticker —— 每分钟跑一次。如果最近 assistant turn 被中断且没被
 * 自动恢复过 → 帮用户接续上次任务。busy / 没 chat / 没中断 都静默跳过，
 * 只在真触发恢复时记录到系统任务历史。
 *
 * 0.3.134: panic.flag 有效期内**完全跳过 auto-resume** — 用户点了「全停」
 * 就是明确表达「别再跑了」，1 分钟后 auto-resumer 偷偷把 AI 续上会导致
 * 用户反馈「点了全停按钮 1 分钟后 ai 又自动恢复运作了」。检查 workspace
 * 下 .easy-deal/panic.flag 文件是否存在且未过期。
 */
function _isPanicFlagActive() {
  try {
    const workspace = path.join(app.getPath('userData'), 'workspace');
    const flagPath = path.join(workspace, '.easy-deal', 'panic.flag');
    if (!fs.existsSync(flagPath)) return false;
    const raw = fs.readFileSync(flagPath, 'utf8');
    const j = JSON.parse(raw);
    const ts = Number(j.ts || 0);
    const ttl = Number(j.ttl_ms || 60_000);
    const age = Date.now() - ts;
    if (age > ttl) {
      // 过期了，删掉
      try { fs.unlinkSync(flagPath); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function maybeRunChatResumeWithRecord() {
  if (!chat) return;
  // 0.3.134: 全停期间不要 auto-resume
  if (_isPanicFlagActive()) return;
  const t0 = Date.now();
  let r;
  try {
    r = await chat.tryAutoResume();
  } catch (e) {
    await recordSystemRun('sys_chat_resume', '中断恢复', {
      status: 'error',
      summary: `检查失败：${e?.message || String(e)}`,
      durationMs: Date.now() - t0,
    });
    return;
  }
  // 跳过原因（busy / 无中断 / 已恢复过 / 无 turn）都不记 — 避免每分钟刷
  // 系统任务历史。只在真触发了 auto-resume 时记一条。
  if (r?.skipped) return;
  await recordSystemRun('sys_chat_resume', '中断恢复', {
    status: r?.ok ? 'ok' : 'error',
    summary: r?.ok
      ? `自动恢复了上次被中断的对话（新增 ${(r.content || '').length} 字回复）`
      : `恢复失败：${r?.error || 'unknown'}`,
    durationMs: Date.now() - t0,
  });
}

/**
 * 「正确使用检查」每日健康检查 — 看用户的整套使用是否齐全：
 *   1. 工作区 strategies/ 里有 EA 吗
 *   2. 每只 EA 有 .md 策略说明吗（cron 监控任务读这份）
 *   3. 每只 EA 有对应的用户级 cron 任务吗（持续监控）
 *   4. 至少有一只 EA 挂在 MT5 上跑吗
 *
 * 缺啥的话推一条 chat 系统通知（kind:health_check_warn）+ 给系统任务面板
 * 留 last_summary 记录。任务完整时静默通过。
 *
 * 24 小时一次。每小时 tick 检查门槛，满 24h 才真跑。
 */
// 0.2.1：fixed-time daily 触发 — 北京时间每天 08:00 跑一次。
// _lastHealthCheckYmd 持久化到 settings.json (lastHealthCheckYmdBJ) 以避免
// 重启 EasyDeal 后当天 8:00 已跑的检查又跑一次。每分钟 tick 查 BJ 时间
// + last-run 日期，命中条件才真跑。
let _lastHealthCheckYmd = null;   // 'YYYY-MM-DD'（北京日期），lazy-loaded from settings
const HEALTH_CHECK_HOUR_BJ = 8;
const HEALTH_CHECK_MIN_BJ = 0;

function _bjNow() {
  // toLocaleString 拿 Asia/Shanghai 的字符串再 parse 回 Date — 比硬算 UTC+8
  // 偏移稳，跨 DST / 跨年都对（中国不调 DST 但保险起见）。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return {
    ymd:    `${m.year}-${m.month}-${m.day}`,
    hour:   parseInt(m.hour, 10),
    minute: parseInt(m.minute, 10),
  };
}

async function maybeRunHealthCheck() {
  if (!strategies) return;
  const bj = _bjNow();
  // Lazy-load lastHealthCheckYmd from settings on first call (recovers across restart)
  if (_lastHealthCheckYmd === null && settings?.data) {
    _lastHealthCheckYmd = settings.data.lastHealthCheckYmdBJ || '';
  }
  if (_lastHealthCheckYmd === bj.ymd) return;            // 今天已经跑过
  if (bj.hour < HEALTH_CHECK_HOUR_BJ) return;            // 8 点前
  if (bj.hour === HEALTH_CHECK_HOUR_BJ && bj.minute < HEALTH_CHECK_MIN_BJ) return;
  // 之后任何时间都允许补跑（错过 8:00 的 tick → 9:01 也跑得起来），但当天
  // 只跑一次。如果用户 8 点电脑没开机，10 点开了 → 10 点首个 tick 跑一次。
  _lastHealthCheckYmd = bj.ymd;
  try {
    if (settings?.set) {
      await settings.set({ lastHealthCheckYmdBJ: bj.ymd });
    }
  } catch {}
  await runHealthCheckWithRecord();
}

async function runHealthCheckWithRecord() {
  if (!strategies) return;
  const t0 = Date.now();
  let issues = [];
  let strategiesCount = 0;
  let mountedCount = 0;
  let summary = '';
  try {
    const list = await strategies.list({
      mt5DataDir:    settings?.getResolved?.()?.mt5?.dataDir,
      mt5InstallDir: settings?.getResolved?.()?.mt5?.installDir,
    });
    strategiesCount = list.length;
    mountedCount = list.filter((it) => it.is_mounted).length;

    // 拉用户级 cron 任务，过滤掉 sys_*（系统任务）和「回测进度 X bt_xxx」(自动 poll 任务)
    let userTasks = [];
    if (schedulerClient) {
      try {
        const r = await schedulerClient.callTool('list_tasks', {});
        const txt = r?.content?.[0]?.text || '{}';
        const parsed = JSON.parse(txt);
        userTasks = (parsed?.data?.tasks || parsed?.tasks || []).filter((t) => {
          if (!t?.id) return false;
          if (String(t.id).startsWith('sys_')) return false;
          if (String(t.name || '').startsWith('回测进度')) return false;
          return true;
        });
      } catch {}
    }

    if (strategiesCount === 0) {
      issues.push('🆕 还没添加任何 EA — 去「我的策略」tab 上方点「用 AI 创建新策略」或「添加文件」');
    } else {
      if (mountedCount === 0) {
        issues.push(`⚠ ${strategiesCount} 只 EA 都没挂到 MT5 跑 — 去 EA 行点「挂载」按钮（自动重启 MT5 或手动按指引）`);
      }
      // 缺策略说明的
      const noDoc = list.filter((it) => !it.doc_exists);
      if (noDoc.length > 0) {
        const names = noDoc.slice(0, 3).map((it) => it.name).join(', ');
        const more = noDoc.length > 3 ? ` …` : '';
        issues.push(`📝 ${noDoc.length}/${strategiesCount} 只 EA 缺策略说明 (.md)：${names}${more}。监控 / 回测托管都依赖这份文档 — 在 EA 行点「说明」让 Claude 生成`);
      }
      // 「EA 没建监控任务」这条 nag 已下线（0.1.52）：
      // - 老逻辑按 EA 文件名启发式找 cron prompt 子串，账户级任务（"每小时查浮亏"
      //   不含具体 EA 名）会误报
      // - 0.1.48 改成「有任意 cron 任务就跳过」减轻一半，但仍折磨「装完还没建任务」的新用户
      // - 0.1.48 又上了 onboarding wizard 8 步引导（0.3.52 起加了「监控品种」步），第 7 步就是建监控任务 ——
      //   这条 daily nag 重复且更打扰
      // 留着「未挂载 / 缺说明」两条，那两条对纠错有实际帮助。
    }

    summary = issues.length === 0
      ? `✓ ${strategiesCount} 只 EA 配置完整（${mountedCount} 只在跑）`
      : `⚠ 待补齐 ${issues.length} 项`;

    await recordSystemRun('sys_health_check', '正确使用检查', {
      status: issues.length === 0 ? 'ok' : 'warn',
      summary: issues.length === 0 ? summary : (summary + ' | ' + issues.join(' | ')),
      durationMs: Date.now() - t0,
    });

    // 缺东西的话给 chat 推一条系统通知 — 用户回去看「AI」tab 能立刻看到提醒
    if (issues.length > 0 && chat) {
      chat.appendSystemNote(
        '📋 **EasyDeal 正确使用检查**（每日自动跑）发现以下事项需要你补齐：\n\n' +
          issues.map((s) => `- ${s}`).join('\n') +
          '\n\n这些不补齐 EasyDeal 没法稳定监控你的策略。补齐后下次检查（24 小时）会自动反馈。',
        { kind: 'health_check_warn', source: 'sys_health_check' },
      );
    }
  } catch (e) {
    await recordSystemRun('sys_health_check', '正确使用检查', {
      status: 'error', summary: `检查失败: ${e?.message || String(e)}`,
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * 启动时静默封存老旧未通知的终态回测记录 —— 拦下「重启就一锅端弹一堆通知」
 * 的 boot flood。规则：
 *   - finished_at > 5 分钟前 + 终态 (ok / error / finished_no_report / config_error)
 *   - 且 notified_at 还是 null
 *   → 直接写 notified_at = now，不通知；用户认为「重启之前就跑完的失败/成功，
 *     如果当时没看到也算了」（多数用户不会专门去翻历史）
 *
 * 5 分钟内刚跑完的不抑制 —— 用户可能刚下 backtest 命令然后关掉 EasyDeal
 * 又开起来，希望立刻看到结果。
 */
async function _sealStaleUnnotifiedTerminalAtBoot() {
  const cutoff = Date.now() / 1000 - 300;
  const stale = (await backtests.all()).filter(r => !r.notified_at && isBacktestTerminal(r) &&
    (r.finished_at || r.started_at || 0) < cutoff);
  if (stale.length) await backtests.change('notified', stale.map(r => r.id));
}

// Remove polling tasks registered by previous client versions.
async function _cleanupAllBacktestPollTasks() {
  if (!schedulerClient?.ready) return 0;
  const { tasks } = await schedulerClient.callTool('list_tasks', {});
  let cancelled = 0;
  for (const task of tasks) {
    if (!/^回测进度 .+ bt_[a-z0-9]+$/i.test(task.name)) continue;
    await schedulerClient.callTool('cancel_task', {task_id: task.id, force: true});
    cancelled++;
  }
  return cancelled;
}

/**
 * 「新会话」时清掉超过 7 天的：
 *   1. workspace/.attachments/<draftId>/  — 用户对话里贴的截图 / 文件副本
 *   2. workspace/.claude/sessions/*.jsonl — Claude Code 自己的 session 历史
 *
 * 7 天 cutoff 是个保守值 —— 短期内可能还有「我昨天的对话」需要 --continue
 * 接的可能性。reset 本身已经把 history 清空 + continueNext=false 让下次
 * spawn 不带 --continue，所以理论上 sessions/*.jsonl 全删也行；但保险
 * 起见保留 7d 以内（万一以后有个「恢复刚清的会话」功能）。
 *
 * 不动 `data/backtests.json` / `scheduler.db` / `license.json` / `wechat-sessions.json` /
 * `strategies/` / `knowledge/` 等业务数据。
 */
async function _gcChatScratch() {
  const wsDir = kb?.workspaceDir || path.join(app.getPath('userData'), 'workspace');
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60_000;
  let removedDirs = 0;
  let removedFiles = 0;
  let bytesFreed = 0;

  // 0.2.4: 用户在「新会话」选「带摘要去新会话」时，AI 列出的「下阶段还要保留」
  // 的附件目录不能被 GC 干掉，否则下次 Claude 想 Read 那些路径就 ENOENT。
  const keptDrafts = new Set();
  try {
    const dataDir = path.join(app.getPath('userData'), 'data');
    const buf = await fs.promises.readFile(path.join(dataDir, 'chat-carryover.json'), 'utf8');
    const j = JSON.parse(buf);
    for (const d of (j.kept_drafts || [])) keptDrafts.add(d);
  } catch { /* no carryover, GC normally */ }

  // 1. .attachments/<draftId>/
  const attRoot = path.join(wsDir, '.attachments');
  try {
    const entries = await fs.promises.readdir(attRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (keptDrafts.has(e.name)) continue;  // carryover 名单豁免
      const sub = path.join(attRoot, e.name);
      try {
        const st = await fs.promises.stat(sub);
        if (st.mtimeMs > cutoffMs) continue;
        // size before remove
        try {
          for (const f of await fs.promises.readdir(sub)) {
            try { bytesFreed += (await fs.promises.stat(path.join(sub, f))).size; } catch {}
          }
        } catch {}
        await fs.promises.rm(sub, { recursive: true, force: true });
        removedDirs += 1;
      } catch {}
    }
  } catch {}

  // 2. .claude/sessions/*.jsonl
  const sessRoot = path.join(wsDir, '.claude', 'sessions');
  try {
    const entries = await fs.promises.readdir(sessRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fp = path.join(sessRoot, e.name);
      try {
        const st = await fs.promises.stat(fp);
        if (st.mtimeMs > cutoffMs) continue;
        bytesFreed += st.size;
        await fs.promises.unlink(fp);
        removedFiles += 1;
      } catch {}
    }
  } catch {}

  if (removedDirs || removedFiles) {
    console.log(`[reset-gc] removed ${removedDirs} attachment dirs + ${removedFiles} session files (~${(bytesFreed/1024/1024).toFixed(1)} MB)`);
  }
}

async function runReconcilerWithRecord() {
  const t0 = Date.now();
  let result;
  try {
    result = await reconcileBacktestNotifications();
  } catch (e) {
    await recordSystemRun('sys_backtest_reconciler', '回测通知巡检', {
      status: 'error', summary: `失败: ${e.message}`,
      durationMs: Date.now() - t0,
    });
    throw e;
  }
  // reconcileBacktestNotifications now returns { delivered: N }. Record only
  // when we actually delivered something — most ticks are no-ops, no point
  // recording each one.
  if (result?.delivered > 0) {
    await recordSystemRun('sys_backtest_reconciler', '回测通知巡检', {
      status: 'ok',
      summary: `补推 ${result.delivered} 条之前漏掉的回测完成通知`,
      durationMs: Date.now() - t0,
    });
  }
}

// 1.4.x 一次性迁移: 老任务自动归属策略 / 其余暂停。幂等: dataDir 下 flag 文件标记。
// 匹配规则: 任务 name 或 prompt 含某策略 stem(不区分大小写, 优先匹配最长 stem —
// 'GMarket_easydeal版' 优先于 'GMarket', 避免归错)。系统任务(id 非 t_ 前缀)不动。
async function _migrateTasksToStrategies(dataDir) {
  const flagPath = path.join(dataDir, '.task-strategy-migrated');
  if (fs.existsSync(flagPath)) return;
  if (!schedulerClient || !schedulerClient.ready || !strategies) return;   // 下次启动再试
  let stems = [];
  try {
    const list = await strategies.list(await _resolveStrategiesListArgs());
    stems = [...new Set((list || []).map((d) => String(d.name || '').replace(/\.(mq5|ex5|mqh|set)$/i, '')).filter(Boolean))]
      .sort((a, b) => b.length - a.length);   // 最长优先
  } catch { return; }
  let tasks = [];
  try { tasks = (await schedulerClient.callTool('list_tasks', {}))?.tasks || []; } catch { return; }
  let bound = 0, paused = 0, kept = 0;
  for (const t of tasks) {
    try {
      if (!String(t.id || '').startsWith('t_')) { kept++; continue; }   // 系统任务不动
      // 1.4.x: ea_name 现在是数组(list_tasks 经 _row_to_task 解出), 空数组 [] 在 JS
      // 里是真值 —— 不能直接 if(t.ea_name), 必须判 .length, 否则全部任务误判成"已归属"。
      if (Array.isArray(t.ea_name) ? t.ea_name.length : t.ea_name) { kept++; continue; }   // 已归属的不动
      const hay = `${t.name || ''}\n${t.prompt || ''}`.toLowerCase();
      const hit = stems.find((s) => hay.includes(s.toLowerCase()));
      if (hit) {
        await schedulerClient.callTool('update_task', { task_id: t.id, ea_name: hit });
        bound++;
      } else if (t.enabled) {
        await schedulerClient.callTool('pause_task', { task_id: t.id });
        paused++;
      } else { kept++; }
    } catch (e) { console.warn('[scheduler] 迁移任务', t.id, '失败:', e?.message || e); }
  }
  try { fs.writeFileSync(flagPath, JSON.stringify({ at: new Date().toISOString(), bound, paused, kept }), 'utf8'); } catch {}
  console.log(`[scheduler] 任务归属迁移完成: 归属${bound} 暂停${paused} 不动${kept}`);
  // 迁移有动作时在全局对话里留一条系统通知, 用户能看到发生了什么、去哪恢复
  if ((bound || paused) && chat) {
    try {
      chat.appendSystemNote(
        `🗂 定时任务已自动整理(升级一次性迁移): ${bound} 个监控任务已归属对应策略` +
        `(策略未运行时自动跳过, 启动后自动恢复); ${paused} 个未关联策略的任务已暂停` +
        `(可在「定时任务」页手动恢复需要的)。`,
      );
    } catch { /* 通知失败不影响迁移结果 */ }
  }
}

async function pollAndFire(workspaceDir) {
  if (!schedulerClient || !schedulerClient.ready) return;
  let due;
  try {
    due = await schedulerClient.callTool('list_due_tasks', {});
  } catch (e) {
    console.warn('[scheduler] list_due_tasks failed:', e.message);
    return;
  }
  for (const task of due?.tasks || []) {
    if (schedulerFiring.has(task.id)) continue;
    schedulerFiring.add(task.id);
    fireTask(task, workspaceDir)
      .catch((e) => console.error('[scheduler] fire error:', e.message))
      .finally(() => schedulerFiring.delete(task.id));
  }
}

// 1.4.x 任务↔策略关联(多对多): 一次 strategies.list() 查出一批 EA 各自是否「运行中」
// (is_mounted = 已部署 AND 所绑 MT5 实例在跑, 与策略列表 UI 同口径)。
// 返回 { running: string[] 明确在跑的那些 stem, allKnownNotRunning: bool 是否「查到了
// 全部 EA 且没有一个在跑」(= 可以放心跳过), anyUnknown: bool 是否有 EA 查不到/查询失败 }。
// 查询整体失败 / strategies 未初始化 → 全部当"不确定", 门控放行(别误伤)。
// 1.4.x: 「真正运行中」判据 —— 不能用 strategies.js 的 `is_mounted` 字段, 它 0.3.238 起
// 被重定义成「is_deployed && mt5_running」(ex5部署到位+MT5进程在跑), 不查日志, 比「我的
// 策略」UI 自己的绿色「运行中」徽章(is_deployed && mt5_running && is_mounted_in_log, 见
// strategies-view.js:788-823)宽松得多——「已部署·未确认运行」「已停止」这两种黄色态都会
//被 is_mounted 误判成 true。用户用「关联策略」复选框实测抓到(6个全显绿点, 实际只2个真在
// 跑)。统一改用跟 UI 徽章同款的严格三态判定, 门控/挂载提示/复选框三处共用。
function _isReallyRunning(d) {
  return !!(d && d.is_deployed && d.mt5_running !== false && d.is_mounted_in_log);
}

async function _runningEaNames(eaNames) {
  const names = (Array.isArray(eaNames) ? eaNames : (eaNames ? [eaNames] : []))
    .map((n) => String(n || '').replace(/\.(mq5|ex5)$/i, '')).filter(Boolean);
  if (!names.length) return { running: [], allKnownNotRunning: false, anyUnknown: false };
  try {
    if (!strategies) return { running: [], allKnownNotRunning: false, anyUnknown: true };
    const args = await _resolveStrategiesListArgs();
    const list = await strategies.list(args);
    const byStem = new Map((list || []).map((d) => [String(d.name || '').replace(/\.(mq5|ex5|mqh|set)$/i, ''), d]));
    const running = [];
    let anyUnknown = false;
    for (const n of names) {
      const hit = byStem.get(n);
      if (!hit) continue;             // 策略已不存在(被删) = 肯定没在运行, 不算 unknown
      if (_isReallyRunning(hit)) running.push(n);
    }
    return { running, allKnownNotRunning: running.length === 0, anyUnknown };
  } catch {
    return { running: [], allKnownNotRunning: false, anyUnknown: true };   // 查询失败 → 不确定, 放行
  }
}

async function fireTask(task, workspaceDir) {
  // 1.4.x: 关联了策略的任务(可关联多个) — 绑定的策略**全部**未运行时自动跳过(自愈式暂停:
  // 不改 enabled, 任一策略启动后自动恢复; 不白烧 token)。只要**至少一个**在运行就执行,
  // 并把「当前实际在跑的是哪几个」存到 task._runningEaNames, buildPromptForTask /
  // llm_inject 路由据此动态收窄到运行中的那些, 忽略停着的(用户 2026-07-15 拍板)。
  const eaList = Array.isArray(task.ea_name) ? task.ea_name : (task.ea_name ? [task.ea_name] : []);
  if (eaList.length) {
    const { running, allKnownNotRunning, anyUnknown } = await _runningEaNames(eaList);
    if (allKnownNotRunning && !anyUnknown) {
      try {
        const r0 = await schedulerClient.callTool('begin_run', { task_id: task.id });
        if (r0?.run?.id) {
          const label = eaList.length > 1
            ? `关联的 ${eaList.length} 个策略(${eaList.join('、')})均`
            : `关联策略「${eaList[0]}」`;
          await schedulerClient.callTool('finish_run', {
            run_id: r0.run.id, status: 'skipped',
            result_summary: `⏸ ${label}当前未运行, 本次自动跳过(任一策略启动后自动恢复)`,
          });
        }
      } catch { /* 记录失败不影响跳过语义 */ }
      return;
    }
    task._runningEaNames = running;   // 给 buildPromptForTask / llm_inject 路由用
  }
  // begin_run → spawn → finish_run
  let runId = null;
  try {
    const r = await schedulerClient.callTool('begin_run', { task_id: task.id });
    runId = r?.run?.id;
  } catch (e) {
    console.error('[scheduler] begin_run failed:', e.message);
    return;
  }

  let status = 'ok';
  let summary = '';
  try {
    if (task.mode === 'llm_headless') {
      // 0.3.169: scheduler cron 跑的 headless claude turn 经常要做组合操作
      // (查持仓 → 查行情 → 综合分析 → 调微信发消息), 5min default timeout
      // 不够用. 用户实测「每小时账户汇报」/「定时复盘」等任务多次撞过
      // `claude run timed out after 300000ms`, 微信收到错误消息. 把 cron
      // 任务的 timeout 拉到 15 分钟跟微信 batch 路径 (10min) 同档.
      // 任务还能在 scheduler db `timeout_ms` 字段 per-task 覆盖 (后续可加 UI).
      const taskTimeout = Number(task.timeout_ms) > 0
        ? Number(task.timeout_ms)
        : 15 * 60 * 1000;
      // 0.3.213: 加 token / channel-fail 类错误 retry. 用户 (用户) 反馈
      // 「每小时报告任务并不能按预期稳定执行」 — 通道偶发 429 / token-mode-X
      // 这种瞬时错挂掉, 等下一小时才重试体验差. 加 1 次 60s 后立刻 retry.
      const RETRYABLE = /token-mode-|quota|429|exit.*1|channel-err|connection|timeout|temporarily/i;
      let attempts = 0;
      let lastErr = null;
      while (attempts < 2) {
        attempts++;
        try {
          summary = await spawnHeadlessClaude({
            prompt: buildPromptForTask(task),
            cwd: workspaceDir,
            resume: false,
            timeoutMs: taskTimeout,
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const errMsg = String(e?.message || e);
          // 真 timeout 不 retry (一般是 prompt 重, 重跑也 timeout 浪费时间 + token)
          if (/run timed out after \d+ms/.test(errMsg)) {
            break;
          }
          if (attempts < 2 && RETRYABLE.test(errMsg)) {
            console.warn(`[scheduler] task "${task.name}" attempt ${attempts}/2 failed (${errMsg.slice(0, 80)}), 60s 后 retry`);
            await new Promise((r) => setTimeout(r, 60 * 1000));
            continue;
          }
          break;
        }
      }
      if (lastErr) throw lastErr;   // 还是失败 → 走外层 catch 转友好文案
    } else if (task.mode === 'llm_inject' && chat) {
      // 1.4.x: 关联了策略的 llm_inject 任务 → 路由到该策略的独立会话(享受策略
      // 种子上下文, 讨论归拢到策略名下, 不再骑全局主对话把上下文堆爆——用户案例)。
      // 会话查找: chatMgr 里已有该 EA 的 strat 会话(用户开过/预热过)就用它;
      // 没有则回落全局会话(行为同旧版, 不强行猜 login 建会话)。
      // 1.4.x: 关联多个策略时, 只有本次触发恰好只有 1 个在运行才路由到它的独立会话
      // (语义明确); 关联了 ≥2 个正在运行的策略时讨论跨策略, 回落全局会话更合适。
      let target = chat;
      {
        const eaList = Array.isArray(task.ea_name) ? task.ea_name : (task.ea_name ? [task.ea_name] : []);
        const runningList = Array.isArray(task._runningEaNames) ? task._runningEaNames : eaList;
        if (runningList.length === 1 && chatMgr) {
          try {
            const stem = String(runningList[0]).replace(/\.(mq5|ex5)$/i, '');
            const hit = (chatMgr.list() || []).find((s) => s.kind === 'strategy' && s.ea === stem);
            if (hit) target = await chatMgr.get(hit.key);
          } catch { /* 回落全局 */ }
        }
      }
      // Remote scheduled tasks used to depend on whichever machine happened
      // to be attached in the chat UI. That made a task for A silently skip
      // whenever the user had B selected. Explicit EZDL-* keys in the task
      // name/prompt are now injected for this turn only. Existing UI
      // attachments are retained for the turn, but never modified/persisted.
      const taskRemoteKeys = extractRemoteClientKeys(task.name, task.prompt);
      let taskSendOpts = {};
      if (taskRemoteKeys.length) {
        const baseAttachments = (typeof target.getRemoteAttachments === 'function')
          ? target.getRemoteAttachments() : [];
        const byKey = new Map(baseAttachments.map((a) => [a.clientKey, { ...a }]));
        let approvedByKey = new Map();
        try {
          const grantsResult = await marketplace.remoteListGrants();
          const grants = (grantsResult && (grantsResult.data ?? grantsResult)) || {};
          approvedByKey = new Map((grants.as_operator || [])
            .filter((g) => g?.status === 'approved' && g.client_key)
            .map((g) => [String(g.client_key).toUpperCase(), g]));
        } catch (e) {
          console.warn('[scheduler] remote grant lookup failed; server will validate access:', e?.message || e);
        }
        for (const clientKey of taskRemoteKeys) {
          const grant = approvedByKey.get(clientKey);
          byKey.set(clientKey, {
            clientKey,
            note: grant?.note || byKey.get(clientKey)?.note || '',
            scope: ['read', 'manage', 'trade'].includes(grant?.scope)
              ? grant.scope : (byKey.get(clientKey)?.scope || 'read'),
          });
        }
        const remoteAttachments = [...byKey.values()];
        taskSendOpts = { remoteAttachments, forceQualifiedRemoteNames: true };
        console.log(`[scheduler] task "${task.name}" turn-scoped remote targets: ${taskRemoteKeys.join(', ')}`);
      }
      const r = await target.send(
        `[scheduled-trigger:${task.name}]\n${task.prompt}`,
        [],
        taskSendOpts,
      );
      if (r.ok) {
        summary = r.content;
      } else {
        status = r.interrupted || /busy/i.test(String(r.error || '')) ? 'skipped' : 'error';
        const rawError = String(r.error || 'chat busy');
        summary = /(?:Codex CLI|AI engine).*(?:no final|without a text response|no final text)/i.test(rawError)
          ? `⚠ 「${task.name}」本轮没有产生有效回复，已按失败记录；下一次触发会重新执行。`
          : rawError;
      }
    } else {
      status = 'skipped';
      summary = `mode '${task.mode}' not yet wired in v0`;
    }
  } catch (e) {
    status = 'error';
    // 0.3.169: 友好化 cron 任务错误消息. 之前直接砸英文 stack 给微信用户
    // (用户看到「claude run timed out after 300000ms」就是这条路径).
    // timeout / token / api error 按类型转中文 + 给可操作建议.
    const errMsg = String(e?.message || e);
    const timeoutM = errMsg.match(/run timed out after (\d+)ms/);
    if (timeoutM) {
      const mins = Math.round(Number(timeoutM[1]) / 60000);
      summary = `⏰ 「${task.name}」执行超时 (跑了 ${mins} 分钟没完成).\n\n`
        + '可能原因:\n'
        + '• 任务 prompt 让 AI 做的事太多 (拆成几个小任务可能更稳)\n'
        + '• MCP 工具 (查持仓 / 查行情 / 回测) 当下卡住\n'
        + '• 网络 / 通道慢\n\n'
        + '下一次定时触发会自动重试. 如频繁超时, 把任务 prompt 改短或拆开.';
    } else if (/^\[token-mode-/.test(errMsg)) {
      const m = errMsg.match(/^\[token-mode-[^\]]+\]\s*([^—]+)—\s*(.+)$/);
      summary = m ? `⚠ ${m[1].trim()}：${m[2].trim()}` : `⚠ 通道异常: ${errMsg.slice(0, 300)}`;
    } else if (/quota|exhausted|额度|配额/i.test(errMsg)) {
      summary = `⚠ Token 配额不足, 「${task.name}」未执行. 请「Token 通道」页换通道或充值后再说.`;
    } else if (/exit.*code|exited 1|no stderr/i.test(errMsg)) {
      summary = `⚠ Claude 启动失败, 「${task.name}」未执行. 多半 token / 凭据问题, 看「Token 通道」页诊断.`;
    } else {
      summary = `⚠ 「${task.name}」执行出错: ${errMsg.slice(0, 500)}`;
    }
  }

  if (runId) {
    try {
      await schedulerClient.callTool('finish_run', {
        run_id: runId,
        status,
        summary: typeof summary === 'string' ? summary : JSON.stringify(summary),
      });
    } catch (e) {
      console.error('[scheduler] finish_run failed:', e.message);
    }
  }

  try {
    if (Array.isArray(task.notify) && task.notify.length && summary && summary.trim()) {
      // Trim long summaries; chat handles markdown, wechat needs plain.
      const trimmedSummary = summary.length > 4000 ? summary.slice(0, 4000) + '\n\n…(已截断)' : summary;
      const chatBody = `🕒 **${task.name}** 触发完成\n\n${trimmedSummary}`;
      const wechatBody = `🕒 ${task.name}\n\n${trimmedSummary}`;
      await deliverNote({
        channels: task.notify,
        chatNote: chatBody,
        wechatPlain: wechatBody,
        source: `task:${task.id}`,
        kind: 'task_result',
      });
    }
  } catch (e) {
    console.warn('[scheduler] post-fire delivery failed:', e.message);
  }
}

/**
 * Push a notification body to the requested channels. `channels` is an
 * array containing some subset of "chat" / "wechat". WeChat push is
 * additionally gated by the sidecar being logged in AND a recent (3h)
 * inbound from the user — beyond that we don't surprise them with an
 * unsolicited push.
 */
async function deliverNote({ channels, chatNote, wechatPlain, source, kind }) {
  if (channels.includes('chat') && chat && chatNote) {
    chat.appendSystemNote(chatNote, { kind, source });
  }
  if (channels.includes('wechat') && wechatPlain) {
    const wxLast = wechatSidecar?.status?.logged_in
      ? wechatSidecar.getLastInbound()
      : null;
    if (wxLast?.chat) {
      // 0.3.213: 加 3 次 retry — 用户反馈定时任务微信推送不稳 (用户 / 用户 撞过
      // 「网关返回 -2」). 5s / 15s / 30s backoff. 业务 code=-2 由 wechat_mcp 内部
      // 也 retry 一次, 加上这层共 ~3-6 次实际尝试. 网关抖动 1-2 分钟基本能恢复.
      const BACKOFFS = [0, 5000, 15000, 30000];
      const MAX_ATTEMPTS = 3;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          console.log(`[deliver] wechat push retry ${attempt}/${MAX_ATTEMPTS - 1} (last err: ${lastErr})`);
          await new Promise((r) => setTimeout(r, BACKOFFS[attempt]));
        }
        try {
          await wechatSidecar.sendMessage({
            to: wxLast.chat,
            text: wechatPlain,
            contextToken: wxLast.contextToken,
          });
          if (attempt > 0) console.log(`[deliver] wechat push succeeded on retry ${attempt}`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e?.message || String(e);
          // 检测「session 死了」类错误 → 不 retry (再试也是失败)
          if (/未登录|logged.?in.*false|kicked|session/i.test(lastErr)) {
            console.warn('[deliver] wechat session dead, abort retry:', lastErr);
            break;
          }
        }
      }
      if (lastErr) {
        console.warn(`[deliver] wechat push failed after ${MAX_ATTEMPTS} attempts:`, lastErr);
      }
    } else {
      console.log('[deliver] wechat channel requested but no recent inbound; skipped');
    }
  }
}

const _notifiedBacktests = new Set();
const isBacktestTerminal = r => ['ok', 'error', 'finished_no_report', 'config_error'].includes(r.status);

function backtestNote(r) {
  if (r.status !== 'ok') return `回测未完成 · ${r.ea}\n${r.error || r.status}`;
  const m = r.metrics || {};
  return [
    `回测完成 · ${r.ea} @ ${r.symbol} · ${r.from_date} 至 ${r.to_date}`,
    r.engine === 'wind-tunnel-skill'
      ? `风洞连续回放（模拟） · 权益收益 ${m.net_profit} · 期末权益 ${m.equity} · 最差浮盈亏 ${m.worst_float}`
      : `净利润 ${m.net_profit ?? '—'} · 交易数 ${m.trades ?? '—'}`,
    r.report_path,
  ].filter(Boolean).join('\n');
}

/**
 * Record a system-task tick into scheduler.db so the UI's 系统任务 row
 * can show history (last 50 runs) and Claude's get_task_history MCP
 * tool can query it. Best-effort, never throws.
 *
 * Use sparingly — DON'T call this for every 5s no-op tick of the
 * scheduler poll. Only call when something meaningful happened
 * (status change, error, actual work done, periodic heartbeat).
 */
async function recordSystemRun(taskId, name, { status = 'ok', summary = '', durationMs = 0 } = {}) {
  if (!schedulerClient || !schedulerClient.ready) return;
  try {
    await schedulerClient.callTool('record_system_run', {
      task_id: taskId, name, status, summary,
      duration_ms: Math.max(0, Math.round(durationMs)),
    });
  } catch (e) {
    console.warn('[sys-run-record] failed for', taskId, e.message);
  }
}

/**
 * Best-effort lookup of a system task row from scheduler.db. Used by
 * app:system-tasks IPC to enrich the read-only system task list with
 * actual runtime state (last_status, last_fire_at, last_summary). Returns
 * null if the task hasn't been recorded yet OR scheduler is down.
 */
/**
 * 收集客户端诊断快照 — 用户报「连不上 MT5 / 回测不通 / 统计黄」之类问题
 * 时，admin 远程靠这个看运行时状态。每小时跟 stats 一起上报 + 设置页有个
 * 「上传诊断快照」按钮即时触发。
 *
 * 字段尽量包含 admin 排查时最常想问的信息，但**不带敏感数据**：
 *   - settings 路径（安装目录 / 数据目录 / 副本目录），不包含序列号 / 账号密码
 *   - MT5 检测状态（来源、运行进程列表的路径 + pid）
 *   - EA 摘要（数量、挂载数、缺策略说明数、缺 magic 归属数）
 *   - token 通道模式（fay / custom / system）+ 是否有有效 token，不带 token 本身
 *   - 子进程状态（scheduler / wechat sidecar / stats collector last error）
 */
// 探测 EasyDeal 进程是否以管理员身份在跑。诊断「连不上 MT5 但 MT5 是
// 开着的」case 时关键 — 用户经常以管理员启动 MT5（杀软引导 / 旧 Windows
// 习惯），但 EasyDeal 是普通用户。Windows 安全策略下普通进程 Get-Process
// 看不到管理员进程的 terminal64.exe，导致 mt5_running 空 + 检测全失效。
async function _isElevatedProcess() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    const cp = require('node:child_process');
    // fltmc 是管理员独占命令，普通用户会得到 access denied (exit 1)
    cp.exec('fltmc', { windowsHide: true, timeout: 2000 }, (err) => {
      resolve(!err);
    });
  });
}

async function collectDiagnosticSnapshot() {
  const out = {
    schema: 1,
    ts: Date.now(),
    app_version: app.getVersion(),
    platform: process.platform,
    os_release: require('node:os').release(),
    arch: process.arch,
    is_admin: await _isElevatedProcess().catch(() => null),
    claude_trust_write: _claudeTrustWriteResult,
  };
  try {
    const s = settings.getResolved();
    out.settings = {
      mt5_install_dir:        s?.mt5?.installDir || null,
      mt5_data_dir:           s?.mt5?.dataDir || null,
      backtest_engine: 'wind-tunnel-skill',
      mt5_install_source:     s?._meta?.detected?.installDirSource || null,
      mt5_data_source:        s?._meta?.detected?.dataDirSource || null,
      monitor_symbols:        s?.monitor?.symbols || [],
      trading_write_enabled:  !!s?.tradingWriteEnabled,
    };
    out.mt5_running = (s?._meta?.detected?.runningMt5Processes || []).map((p) => ({
      pid: p.pid, dir: p.dir, source: p._source || 'powershell',
    }));
    // 文件系统佐证：用户配的安装目录里到底有没有 terminal64.exe — 用户用
    // 「常用路径」兜底走 C:\Program Files\MetaTrader 5 但那目录可能根本
    // 是空的（用户从来没装系统 MT5，只装了 portable 在别的盘）
    try {
      const settingsMod = require('./settings');
      if (s?.mt5?.installDir) {
        out.mt5_install_dir_has_terminal = settingsMod.hasTerminal(s.mt5.installDir);
      }
    } catch {}
    // 关键诊断：PowerShell vs tasklist 双路检测对比 — 让 admin 一眼看出
    // 「PS 拿不到但 tasklist 拿得到 → 杀软拦了 PS」
    try {
      const settingsMod = require('./settings');
      const detail = await settingsMod.detectAllRunningProcessesDetailed();
      out.mt5_detection_dual = {
        powershell_count: detail.powershell.length,
        tasklist_count:   detail.tasklist.length,
        // 不同就是问题信号（杀软 / 权限）— 一致就说明检测本身没毛病
        consistent: detail.powershell.length === detail.tasklist.length,
        tasklist_pids: detail.tasklist.slice(0, 20).map((p) => p.pid),
      };
    } catch (e) {
      out.mt5_detection_dual_err = String(e?.message || e);
    }
  } catch (e) { out.settings_err = String(e?.message || e); }

  // MT5 SDK 实测探针 — spawn 一次 mt5_probe.py，让 SDK 实际跑 init →
  // terminal_info → account_info → symbols_get，admin 看 SDK 究竟连上
  // 哪个 broker / 哪个账号 / 有哪些品种。多 MT5 SDK 路径绑定不可靠的
  // case 用这个秒诊断。
  try {
    const probeScript = resolveBundledFile('python', 'mt5_probe.py');
    if (fs.existsSync(probeScript)) {
      const s = settings.getResolved();
      const activeMt5 = settings.getActiveMt5Instance?.();
      const result = await new Promise((resolve) => {
        const cp = require('node:child_process');
        const child = cp.spawn(s.pythonBin || 'python', [probeScript], {
          env: {
            ...process.env,
            ...(s.mt5?.installDir ? { EASYDEAL_MT5_INSTALL_DIR: s.mt5.installDir } : {}),
            ...(s.mt5?.dataDir ? { EASYDEAL_MT5_DATA_DIR: s.mt5.dataDir } : {}),
            ...(activeMt5?.launchMode ? { EASYDEAL_MT5_LAUNCH_MODE: activeMt5.launchMode } : {}),
            ...(activeMt5?.id ? { EASYDEAL_MT5_INSTANCE_ID: activeMt5.id } : {}),
            EASYDEAL_MT5_ALLOW_LAUNCH: '0',
            EASYDEAL_DATA_DIR: path.join(app.getPath('userData'), 'data'),
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15_000);
        child.on('close', () => {
          clearTimeout(t);
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ ok: false, parse_err: 'invalid json', stdout: stdout.slice(0, 500) }); }
        });
        child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, spawn_err: e.message }); });
      });
      out.mt5_probe = result;
    }
  } catch (e) {
    out.mt5_probe_err = String(e?.message || e);
  }

  try {
    if (strategies) {
      const list = await strategies.list({
        mt5DataDir:    settings?.getResolved?.()?.mt5?.dataDir,
        mt5InstallDir: settings?.getResolved?.()?.mt5?.installDir,
      });
      out.strategies = {
        total:                list.length,
        mounted:              list.filter((it) => it.is_mounted).length,
        without_doc:          list.filter((it) => !it.doc_exists).length,
        stale:                list.filter((it) => it.is_stale).length,
        names:                list.map((it) => ({
          name: it.name,
          mounted: !!it.is_mounted,
          has_doc: !!it.doc_exists,
          trades: it.trades || 0,
          hours_run: it.hours_run || 0,
        })),
      };
    }
  } catch (e) { out.strategies_err = String(e?.message || e); }

  try {
    if (statsCollector) out.stats_collector = statsCollector.status?.() || null;
  } catch (e) { out.stats_collector_err = String(e?.message || e); }

  try {
    if (wechatSidecar) {
      out.wechat = {
        logged_in:     !!wechatSidecar.status?.logged_in,
        ready:         !!wechatSidecar.client?.ready,
        last_check_at: wechatSidecar.status?.last_check_at || null,
      };
    }
  } catch (e) { out.wechat_err = String(e?.message || e); }

  // Scheduler 任务清单 —— 用户反馈「升级后定时任务丢失」时 admin 一眼能
  // 看到 scheduler.db 里到底还剩什么。包含 id / name / schedule / enabled /
  // last_fire_at / last_status —— 不夹带 prompt（可能含敏感数据 + 长度）。
  try {
    if (schedulerClient && schedulerClient.ready) {
      const r = await schedulerClient.callTool('list_tasks', {});
      const txt = r?.content?.[0]?.text || '{}';
      const parsed = JSON.parse(txt);
      const tasks = parsed?.data?.tasks || parsed?.tasks || [];
      const userTasks = tasks.filter((t) => !String(t.id || '').startsWith('sys_'));
      const sysTasks = tasks.filter((t) =>  String(t.id || '').startsWith('sys_'));
      out.scheduler = {
        total: tasks.length,
        user_tasks_count: userTasks.length,
        sys_tasks_count: sysTasks.length,
        user_tasks: userTasks.slice(0, 30).map((t) => ({
          id: t.id,
          name: t.name,
          schedule: t.schedule,
          kind: t.kind,
          mode: t.mode,
          enabled: !!t.enabled,
          notify: t.notify,
          next_fire_at: t.next_fire_at,
          last_fire_at: t.last_fire_at,
          last_status: t.last_status,
          last_summary: typeof t.last_summary === 'string'
            ? t.last_summary.slice(0, 200) : null,
        })),
        sys_tasks: sysTasks.slice(0, 30).map((t) => ({
          id: t.id,
          name: t.name,
          last_fire_at: t.last_fire_at,
          last_status: t.last_status,
        })),
      };
    } else {
      out.scheduler = { unavailable: true, reason: schedulerClient ? 'sidecar_not_ready' : 'no_client' };
    }
  } catch (e) {
    out.scheduler_err = String(e?.message || e);
  }

  // 最近 N 条聊天（含 system note 即调度任务推送 + 用户消息 + Claude 回复）。
  // 用户报问题时几乎都在描述聊天框看到了什么，admin 一眼看到现场比反复要
  // 截图省事。content 截 600 字、attachments / segments 详情不带，控总体积。
  try {
    if (chat && typeof chat.getHistory === 'function') {
      const all = chat.getHistory() || [];
      const recent = all.slice(-12).map((t) => ({
        id: t.id,
        role: t.role,
        ts: t.ts,
        system_note: !!t.systemNote,
        note_kind: t.noteKind || null,
        content_preview: typeof t.content === 'string'
          ? t.content.slice(0, 600) + (t.content.length > 600 ? '…(截断)' : '')
          : null,
        has_segments: Array.isArray(t.segments) && t.segments.length > 0,
        attachment_count: Array.isArray(t.attachments) ? t.attachments.length : 0,
        error: t.error || null,
      }));
      out.chat = { total: all.length, recent };
    }
  } catch (e) { out.chat_err = String(e?.message || e); }

  // 最近 12 条回测（按 finished_at desc）。每条 status / metrics 关键字段 +
  // error / error_code，定位「为啥这只 EA 回测拿到 0」之类问题不用看 .htm。
  try {
    const all = await backtests.all();
    all.sort((a, b) => (b.finished_at || b.started_at || 0) - (a.finished_at || a.started_at || 0));
    out.backtests = { total: all.length, recent: all.slice(0, 12).map(
      ({id, ea, engine, symbol, from_date, to_date, status, started_at, finished_at, error, metrics}) =>
        ({id, ea, engine, symbol, from_date, to_date, status, started_at, finished_at, error, metrics})
    ) };
  } catch (e) { out.backtests_err = String(e?.message || e); }

  // 0.4.x: 护航摘要进 hourly diag — admin 远程能看每个 EA 的护航模式
  // (observe=监控只记录 / enforce=拦截真挡单) + 决策计数, 不用每次问用户截图。
  // 诊断「拦截不工作 / 拦截了没记录」类反馈: enabled_eas 看 mode + overview 看
  // 累计审批/拦截数。observe 模式 = 本来就不挡; enforce 但决策=0 = EA 的
  // WebRequest hook 没触发 (没注入 / MT5 白名单没放行)。
  try {
    if (orderguard) {
      const ogSafe = async (fn) => { try { return await fn(); } catch { return null; } };
      out.orderguard = {
        running: true,
        instances: (typeof ogPool?.size === 'function') ? ogPool.size() : undefined,
        enabled_eas: await ogSafe(() => orderguard.getEnabledEas()),
        overview: await ogSafe(() => orderguard.getOverviewStats()),
      };
    } else {
      out.orderguard = { running: false };
    }
  } catch (e) { out.orderguard_err = String(e?.message || e); }

  // 最近任务运行记录：每个 user task 抓最近 5 条 history，合并按时间排序取
  // 50 条。直接 scheduler MCP 调（Node 22 才有 node:sqlite，Electron 31 还
  // 是 Node 20 用不了；直接 sqlite3 三方包没装），不绕外部依赖。
  try {
    if (schedulerClient && schedulerClient.ready) {
      const r = await schedulerClient.callTool('list_tasks', {});
      const txt = r?.content?.[0]?.text || '{}';
      const parsed = JSON.parse(txt);
      const tasks = parsed?.data?.tasks || parsed?.tasks || [];
      const allRuns = [];
      for (const t of tasks) {
        try {
          const hr = await schedulerClient.callTool('get_task_history', {
            task_id: t.id, limit: 5,
          });
          const hp = JSON.parse(hr?.content?.[0]?.text || '{}');
          const runs = hp?.data?.runs || hp?.runs || [];
          for (const run of runs) {
            allRuns.push({
              run_id: run.id,
              task_id: t.id,
              task_name: t.name,
              started_at: run.started_at,
              finished_at: run.finished_at,
              status: run.status,
              result_summary: typeof run.result_summary === 'string'
                ? run.result_summary.slice(0, 240) : null,
            });
          }
        } catch {}
      }
      allRuns.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
      out.task_runs = { recent: allRuns.slice(0, 50) };
    }
  } catch (e) { out.task_runs_err = String(e?.message || e); }

  // MCP server log tail —— easydeal_mcp_server.py 把自己的 logger 写到
  // <workspaceDir>/logs/easydeal.log（rotating daily）。带 Traceback 的
  // Python 错误都在那里。诊断快照里捎上末 100 行 + 单独抽出最近 5 条
  // Traceback / ERROR / Exception 块（含上下文 6 行），admin 看到「'<' not
  // supported between instances of NoneType and float」之类的 stack 不用
  // 让用户截 log。
  try {
    const wsDir = kb?.workspaceDir || path.join(app.getPath('userData'), 'workspace');
    const logFile = path.join(wsDir, 'logs', 'easydeal.log');
    if (fs.existsSync(logFile)) {
      const buf = await fs.promises.readFile(logFile, 'utf8');
      const allLines = buf.split(/\r?\n/);
      const tail = allLines.slice(-100).join('\n').slice(-5000);
      // 抽 Traceback / ERROR / Exception 块（match 行 + 后 5 行上下文）
      const ERR_RE = /Traceback|ERROR|TypeError|ValueError|KeyError|AttributeError|Exception\b|FATAL|Critical/i;
      const errBlocks = [];
      for (let i = 0; i < allLines.length; i++) {
        if (ERR_RE.test(allLines[i])) {
          const block = allLines.slice(Math.max(0, i - 1), Math.min(allLines.length, i + 6))
            .join('\n');
          errBlocks.push(block);
        }
      }
      // 去重 + 取最近 5 条
      const seen = new Set();
      const recentErrs = [];
      for (let i = errBlocks.length - 1; i >= 0 && recentErrs.length < 5; i--) {
        if (seen.has(errBlocks[i])) continue;
        seen.add(errBlocks[i]);
        recentErrs.unshift(errBlocks[i]);
      }
      out.mcp_log = {
        log_file: logFile,
        total_lines: allLines.length,
        tail,
        recent_errors: recentErrs,
      };
    } else {
      out.mcp_log = { log_file: logFile, missing: true };
    }
  } catch (e) {
    out.mcp_log_err = String(e?.message || e);
  }

  try {
    if (tokenStore) {
      const cfg = tokenStore.getMasked?.() || {};
      // 2026-10-28: 补各模式实际生效的模型 + custom 端点域名 + 上下文窗口策略。
      // 排查时快照只有 mode=custom, 看不出配的是哪个模型(CLI 不认识的
      // claude-opus-5-5)。base_url 只留 host, 不带 path/query, api_key 不上报。
      let customHost = null;
      try { customHost = cfg.custom?.base_url ? new URL(cfg.custom.base_url).host : null; }
      catch { customHost = '(invalid url)'; }
      out.token = {
        mode: cfg.mode,
        fay_has_token: !!cfg.fay?.token_alive,
        fay_cached_model: cfg.fay?.cached_model || null,
        proxy_mode: cfg.proxy?.mode || null,
        custom_protocol: cfg.custom?.protocol || null,
        custom_host: customHost,
        custom_model: cfg.custom?.model || null,
        system_model: cfg.system?.model ?? null,
        codex_model: cfg.codex?.model || null,
        context_mode: cfg.context?.mode || null,
        context_window_tokens: cfg.context?.window_tokens || null,
      };
    }
  } catch (e) { out.token_err = String(e?.message || e); }

  // 内置 Claude Code CLI 版本 —— 判断「这个模型 ID 该版本认不认识」要用
  try {
    // 回退到 PATH 上的 'claude' 时不是绝对路径, 别去 cwd 读到别人的 package.json
    const bin = resolveClaudeBin();
    const pkg = path.isAbsolute(bin)
      ? path.join(path.dirname(path.dirname(bin)), 'package.json') : null;
    out.claude_cli_version = pkg && fs.existsSync(pkg)
      ? JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null
      : null;
  } catch (e) { out.claude_cli_version_err = String(e?.message || e); }

  return out;
}

// 0.3.151 step 3: 拉 OG 的 pending alerts 推到微信 (每 60s 跑一次)
// 失败保留 pending 下次重试.
const _ALERT_LABELS = {
  floating_loss_usd_alert:  '单笔浮亏过大 (USD)',
  floating_loss_pct_alert:  '单笔浮亏过大 (%)',
  holding_too_long_alert:   '持仓时间过长',
  account_loss_alert:       'EA 整体浮亏',
  locked_alert:             '锁仓数过多',
};

async function pushOgAlertsToWechat() {
  if (!orderguard || !orderguard.running) return;
  if (!wechatSidecar) return;
  // 拉 wechat status 看登录 + 拿用户 wxid
  const wxStatus = wechatSidecar.status || {};
  if (!wxStatus.logged_in || !wxStatus.user_id) return;  // 未登录 → 跳过
  const userWxid = wxStatus.user_id;

  let pending;
  try {
    const r = await orderguard.getAlertsPending(50);   // 0.3.238: 拉一批多点足够过滤 stale
    pending = r?.data?.items || [];
  } catch (e) {
    return;  // OG 不可达 → 静默, 下轮再试
  }
  if (pending.length === 0) return;

  // 0.3.238: 积压历史 alert 用户体验极差 — 用户登录微信后突然收到一波 10+ 条
  // 几小时前的过期警报骚扰. 修法:
  //   (1) 过期阈值 5 分钟 — 超过此时长的 alert 直接 markNotified 但不推微信
  //   (2) 实时 alert (< 5min) 单次最多推 3 条 — 多了也分批, 避免一波倒
  // 用户角度: 实时警报有价值, 过期警报没价值反而是骚扰.
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;  // 5 分钟
  const MAX_PUSH_PER_TICK = 3;
  const now = Date.now();
  const fresh = [];
  const stale = [];
  for (const it of pending) {
    const ts = new Date(it.ts).getTime();
    if (!Number.isFinite(ts) || (now - ts) > STALE_THRESHOLD_MS) {
      stale.push(it.decision_id);
    } else {
      fresh.push(it);
    }
  }
  // 过期的直接 mark notified 静默丢弃, 不推
  if (stale.length > 0) {
    try {
      await orderguard.markAlertsNotified(stale);
      console.log(`[og-alert-push] silently dropped ${stale.length} stale alerts (>5min old)`);
    } catch (e) {
      console.warn('[og-alert-push] markAlertsNotified (stale) failed:', e?.message);
    }
  }
  if (fresh.length === 0) return;
  // 单 tick 限量推 — 多了下一 tick 再推
  const toPush = fresh.slice(0, MAX_PUSH_PER_TICK);

  const notified = [];
  for (const it of toPush) {
    const intent = String(it.intent || '');
    const label = _ALERT_LABELS[intent] || intent;
    const tsLocal = new Date(it.ts).toLocaleString('zh-CN', { hour12: false });
    let ticketLine = '';
    try {
      const ctx = JSON.parse(it.context_json || '{}');
      if (ctx.ticket) ticketLine = `\n单号: #${ctx.ticket}`;
    } catch {}
    const text = `⚠ EasyDeal 护航告警

EA: ${it.ea_name || '?'}
类型: ${label}${ticketLine}
品种: ${it.symbol || '?'} ${String(it.side || '').toUpperCase()}
${it.reason || ''}

时间: ${tsLocal}`;

    try {
      // 0.3.260: 主动 push 也带最近一条入站 contextToken (3h 内) — iLink 把
      // 「带 contextToken 的 sendmessage」视为 reply, 真 push + 弹通知;
      // 不带就只接受存到聊天框, 用户主动打开才看到 (用户报「告警都要等我发消息才出现」).
      const lastIn = wechatSidecar.getLastInbound?.({ withinMs: 3 * 60 * 60 * 1000 });
      const ctxTok = (lastIn && lastIn.chat === userWxid) ? lastIn.contextToken : undefined;
      // 0.3.262: pendingOnFail=true — cold-session 下 ret=-2 拒推时入 pending queue,
      // 等用户 ping bot 激活 session 时一次性合并补发. label 用于补发摘要里区分类型.
      await wechatSidecar.sendMessage({
        to: userWxid, text, contextToken: ctxTok,
        pendingOnFail: true, pendingLabel: '⚠ 护航告警',
      });
      notified.push(it.decision_id);
    } catch (e) {
      console.warn('[og-alert-push] sendMessage failed for', it.decision_id, e?.message);
      // 单条失败不阻断其它 — 继续推下一条
    }
  }
  if (notified.length > 0) {
    try {
      await orderguard.markAlertsNotified(notified);
      console.log(`[og-alert-push] pushed ${notified.length}/${pending.length} alerts to ${userWxid}`);
    } catch (e) {
      // mark 失败 → 下轮会重发已推的, 加 cool-down 减轻 (TODO if 用户反馈)
      console.warn('[og-alert-push] markAlertsNotified failed:', e?.message);
    }
  }
}

async function uploadDiagnosticSilent() {
  try {
    const marketplace = require('./marketplace');
    const payload = await collectDiagnosticSnapshot();
    const r = await marketplace.uploadDiagnostic(payload);
    if (!r?.ok) {
      console.warn('[diag] upload failed:', r?.error || r);
    } else {
      console.log('[diag] uploaded snapshot');
    }
  } catch (e) {
    console.warn('[diag] failed:', e?.message || e);
  }
}

async function tryGetSystemTaskRow(taskId) {
  if (!schedulerClient || !schedulerClient.ready) return null;
  try {
    const r = await schedulerClient.callTool('get_task', { task_id: taskId });
    if (!r?.task) return null;
    const t = r.task;
    return {
      id: t.id,
      task_id: t.id,
      name: t.name,
      last_run_at: t.last_fire_at,    // unify field name with stats-collector status()
      last_status: t.last_status,
      last_summary: t.last_summary || null,
      last_error: null,
      last_duration_ms: null,
      run_count: null,
    };
  } catch {
    return null;
  }
}

// Dedup set for strategy-creation notifications (in-memory, per process).
const _notifiedStrategyFiles = new Map();   // path → notified-at-ms

/**
 * Detect a `Write` to `strategies/*.mq5|*.ex5|*.mqh` and push a "strategy
 * created" notification to chat + WeChat (3h inbound window). Debounced
 * per file: same path won't re-notify within 5 minutes (handles
 * iterative Edits / re-writes that follow the initial create).
 */
function handleStrategyCreationToolUse({ name, input } = {}) {
  if (name !== 'Write' || !input?.file_path) return;
  const fp = String(input.file_path);
  // Match strategies/<EAName>.<ext> at the end (Windows or POSIX separator).
  const m = fp.match(/[/\\]strategies[/\\]([^/\\]+)\.(mq5|ex5|mqh)$/i);
  if (!m) return;
  const eaName = m[1];
  const ext = m[2].toLowerCase();
  // Skip companion docs / set files explicitly (only .mq5 / .ex5 / .mqh
  // matter for "a strategy was created"). We already filter in the regex.
  const lastNotifiedAt = _notifiedStrategyFiles.get(fp) || 0;
  if (Date.now() - lastNotifiedAt < 5 * 60 * 1000) return;   // 5min debounce
  _notifiedStrategyFiles.set(fp, Date.now());

  const sizeStr = (() => {
    try {
      const st = fs.statSync(fp);
      return st.size < 1024 ? `${st.size} B` :
             st.size < 1024 * 1024 ? `${(st.size / 1024).toFixed(1)} KB` :
             `${(st.size / 1024 / 1024).toFixed(2)} MB`;
    } catch { return null; }
  })();

  const chatNote =
    `### 🧬 策略已创建/更新 — \`${eaName}.${ext}\`\n` +
    (sizeStr ? `_文件大小：${sizeStr}_\n` : '') +
    `\n路径：\`${fp}\`\n` +
    `\n_「我的策略」标签页应能看到它（5 秒内自动刷新）。下一步可以点 **回测** 或 **挂载** 试运行。_`;
  const wechatPlain =
    `🧬 策略已创建：${eaName}.${ext}` +
    (sizeStr ? ` (${sizeStr})` : '') +
    `\n路径：${fp}` +
    `\n下一步：在客户端「我的策略」点回测或挂载`;

  deliverNote({
    channels: ['chat', 'wechat'],
    chatNote,
    wechatPlain,
    source: `strategy:${eaName}`,
    kind: 'strategy_created',
  }).catch((e) => console.warn('[strategy-notify] deliver failed:', e.message));
}

/**
 * From a list of backtest records (BacktestsStore.listForEa shape), pick
 * the one with the highest net_profit that ALSO satisfies the listing
 * eligibility criteria:
 *   - status === 'ok' (i.e. produced a parseable report)
 *   - period span (to - from) >= 90 days
 *   - metrics.net_profit > 0
 * Returns null if none qualify.
 */
function _pickBestPassing3moBacktest(btList) {
  if (!Array.isArray(btList) || !btList.length) return null;
  let best = null;
  for (const r of btList) {
    if (r?.status !== 'ok') continue;
    if (!r.from_date || !r.to_date) continue;
    const f = new Date(r.from_date);
    const t = new Date(r.to_date);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) continue;
    const days = Math.floor((t - f) / 86_400_000);
    if (days < 90) continue;
    const np = r.metrics?.net_profit;
    if (np == null || np <= 0) continue;
    const cand = {
      id:         r.id,
      symbol:     r.symbol || null,
      period:     r.period || null,
      from:       r.from_date,
      to:         r.to_date,
      days,
      net_profit: np,
    };
    if (!best || cand.net_profit > best.net_profit) best = cand;
  }
  return best;
}

async function reconcileBacktestNotifications() {
  if (!chat && !wechatSidecar) return { delivered: 0 };
  let rows = await backtests.all();
  if (rows.some(r => r.status === 'running' || r.status === 'queued')) {
    await backtests.change('reconcile');
    rows = await backtests.all();
  }
  let delivered = 0;
  for (const row of rows) {
    if (!isBacktestTerminal(row) || row.notified_at || _notifiedBacktests.has(row.id)) continue;
    _notifiedBacktests.add(row.id);
    try {
      const note = backtestNote(row);
      await deliverNote({ channels: row.notify || ['chat'], chatNote: note, wechatPlain: note,
        source: row.id, kind: 'backtest_done' });
      await backtests.change('notified', [row.id]);
      delivered++;
      if (row.status === 'ok' && settings.getResolved().notifyAiAfterBacktest &&
          ['max', 'max_plus'].includes(license.getStatus()?.tier) && chat) {
        chat.send(`回测 ${row.ea}（${row.id}）已完成，请按 wind-tunnel-skill 读取报告，对照策略文档分析优化方向。如需迭代，在研究副本上更新策略和对应适配器，再用 run_backtest 做同区间比较。`)
          .catch(e => console.warn('[backtest] optimization:', e.message));
      }
    } catch (e) {
      _notifiedBacktests.delete(row.id);
      console.warn('[backtest] notification:', e.message);
    }
  }
  return { delivered };
}

function buildPromptForTask(task) {
  const now = new Date().toISOString();
  const lines = [
    `[scheduled-trigger:${task.name}]`,
    `Task id: ${task.id}`,
    `Fired by EasyDeal scheduler at ${now}.`,
    ``,
  ];
  // 1.4.x: 关联多个策略时, 动态收窄到本次触发时实际运行中的那些(fireTask 门控阶段
  // 已算好存进 task._runningEaNames), 让 AI 只处理在跑的, 忽略停着的, 不用为每个
  // 策略单独建同名任务。
  const eaList = Array.isArray(task.ea_name) ? task.ea_name : (task.ea_name ? [task.ea_name] : []);
  if (eaList.length > 1) {
    const running = Array.isArray(task._runningEaNames) ? task._runningEaNames : eaList;
    lines.push(
      `本任务关联了 ${eaList.length} 个策略: ${eaList.join('、')}。`,
      `当前实际运行中的是: ${running.length ? running.join('、') : '(未能确定, 按全部处理)'}。`,
      `请只针对当前运行中的这些策略执行下面的指令, 忽略未运行的, 不要提未运行的那些。`,
      ``,
    );
  }
  lines.push(
    `Original instruction:`,
    task.prompt,
    ``,
    `Please complete this task. Do NOT ask the user for confirmation —`,
    `this is an automated scheduled run. Reply concisely with what you`,
    `did and any anomalies worth surfacing.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(workspaceDir) {
  const requireScheduler = () => {
    if (!schedulerClient || !schedulerClient.ready) {
      throw new Error('scheduler MCP server is not running');
    }
    return schedulerClient;
  };

  // -- timers (all routed to the scheduler MCP server)
  ipcMain.handle('timers:list', async () => {
    const r = await requireScheduler().callTool('list_tasks', {});
    const all = r?.tasks || [];
    // 系统内部 ticker（stats-collector / 偏好学习 / 回测巡检 等）通过
    // record_system_run 写入了同一张 tasks 表（kind='system'）。它们已经
    // 在 app:system-tasks 面板里独立呈现，过滤掉避免在 「已有任务」 用户列表里重复。
    // Claude 通过原生 list_tasks MCP 工具仍能看到全量。
    return all.filter((t) => t && t.kind !== 'system');
  });
  ipcMain.handle('timers:create', async (_e, payload) => {
    const r = await requireScheduler().callTool('schedule_task', payload || {});
    return r?.task;
  });
  ipcMain.handle('timers:cancel', async (_e, id) => {
    // 用户在「定时任务」标签页主动点删除 → force 绕过 0.3.5 的 "running cron 不能 cancel" guard
    return await requireScheduler().callTool('cancel_task', { task_id: id, force: true });
  });
  ipcMain.handle('timers:toggle', async (_e, id, enabled) => {
    const tool = enabled ? 'resume_task' : 'pause_task';
    return await requireScheduler().callTool(tool, { task_id: id });
  });
  ipcMain.handle('timers:history', async (_e, id) => {
    const r = await requireScheduler().callTool('get_task_history', { task_id: id, limit: 50 });
    return r?.runs || [];
  });
  // 清空某个 task 的全部 task_runs — 用户在客户端历史面板点「清空历史」。
  // 删了之后 AI 调 get_task_history 也拿不到这批，UI 也不会再展示。
  ipcMain.handle('timers:clear-runs', async (_e, id) => {
    if (!id) return { ok: false, error: 'no_task_id' };
    try {
      const r = await requireScheduler().callTool('clear_task_runs', { task_id: id });
      return { ok: true, removed: r?.removed || 0 };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('timers:delete-run', async (_e, runId) => {
    if (!runId) return { ok: false, error: 'no_run_id' };
    try {
      const r = await requireScheduler().callTool('delete_task_run', { run_id: runId });
      return { ok: !!r?.removed };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // 0.3.120: 一键重置系统任务 — 清空 tasks/task_runs 表里 kind='system' 的所有行
  // 让客户端下次启动时由 stats-collector/scheduler-poll 自动用当前版本重新 seed。
  // 用户任务不受影响。修「多版本迭代后系统任务在不同机器上不一致」的问题。
  ipcMain.handle('timers:reset-system', async () => {
    try {
      const r = await requireScheduler().callTool('reset_system_tasks', { confirm: true });
      return r || { ok: false, error: 'no_response' };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('timers:run-now', async (_e, id) => {
    // "run now" = mark next_fire_at to now via update; the daemon will pick it up next tick.
    // Or simpler: call begin_run/finish_run cycle directly.
    if (schedulerFiring.has(id)) return { ok: false, error: 'already running' };
    const get = await requireScheduler().callTool('get_task', { task_id: id });
    if (!get?.task) return { ok: false, error: 'not found' };
    schedulerFiring.add(id);
    fireTask(get.task, workspaceDir)
      .catch((e) => console.error('[scheduler] runNow error:', e.message))
      .finally(() => schedulerFiring.delete(id));
    return { ok: true };
  });

  // -- knowledge base
  ipcMain.handle('kb:list',   () => kb.list());
  ipcMain.handle('kb:upload', async () => uploadDialog(['md','txt','pdf','json','csv','log','mq5','mqh','set'], (p) => kb.addFile(p)));
  ipcMain.handle('kb:delete', (_e, n) => kb.deleteFile(n));
  ipcMain.handle('kb:open-folder', () => kb.openFolder());
  // 0.3.43: 服务端共享知识库 — list 是「服务端有什么」（含本地是否已下），
  // sync 是「拉强制 + 更新元数据」，download 是用户点单条「下载」。
  ipcMain.handle('kb:server-list',     () => kb.listServerShared({ serverApi }));
  ipcMain.handle('kb:server-sync',     () => kb.syncServerKb({ serverApi }));
  ipcMain.handle('kb:server-download', (_e, id) => kb.downloadServerItem(id, { serverApi }));

  // -- strategies (local source)
  ipcMain.handle('strategies:list',          async () => {
    return strategies.list(await _resolveStrategiesListArgs());
  });
  ipcMain.handle('strategies:upload',        async () => uploadDialog(['mq5','mqh','ex5','set'], (p) => strategies.addFile(p)));
  ipcMain.handle('strategies:delete',        async (_e, n) => {
    const res = await strategies.deleteFile(n);
    // 0.4.41: 删 workspace 文件后跨 store 级联清理 (mounted-state / ea-monitor /
    // 各 MT5 实例 ex5+config / OG enabled). cascade 失败不阻断主 IPC 返回 — workspace
    // 文件已删是用户最在意的, cascade 漏清 B 防御层会兜底抹掉 stale mount 字段.
    try {
      const stem = String(n || '').replace(/\.(mq5|ex5|mqh|set)$/i, '').replace(/^.*[\\/]/, '');
      if (stem) await _cascadeDeleteEa(stem);
      // 1.3.x 多会话: 删策略连带删它的所有策略会话(各账户下的 strat:<login>:<stem>)。
      if (stem && chatMgr) {
        try { const d = await chatMgr.deleteByEa(stem); if (d.deleted) console.log(`[strategies:delete] 连带删策略会话 ${d.deleted} 条 (${stem})`); }
        catch (e) { console.warn('[strategies:delete] 删会话失败:', e?.message || e); }
      }
      // 1.4.x: 删策略 → 从所有定时任务的 ea_names 数组里摘掉这个 stem。任务只关联了
      // 这一个策略(摘完变空) → 直接删掉该任务(用户 2026-07-15 拍板: 策略删除,只归属
      // 它的监控规则也应该删除); 还关联着其他策略的任务只解绑这一个, 保留其余绑定
      // (不因为其中一个策略被删就连累整个多策略任务)。
      if (stem && schedulerClient && schedulerClient.ready) {
        try {
          const allTasks = (await schedulerClient.callTool('list_tasks', {}))?.tasks || [];
          let removed = 0, unbound = 0;
          for (const t of allTasks) {
            const eaList = Array.isArray(t.ea_name) ? t.ea_name : (t.ea_name ? [t.ea_name] : []);
            if (!eaList.includes(stem)) continue;
            const rest = eaList.filter((n) => n !== stem);
            if (rest.length === 0) {
              await schedulerClient.callTool('cancel_task', { task_id: t.id, force: true });
              removed++;
            } else {
              await schedulerClient.callTool('update_task', { task_id: t.id, ea_names: rest });
              unbound++;
            }
          }
          if ((removed || unbound) && chat) {
            try {
              chat.appendSystemNote(
                `🗑 策略「${stem}」已删除, 关联的定时任务已同步处理: ` +
                `${removed} 个已删除(只关联这一个策略)、${unbound} 个已解除对它的绑定(仍关联其他策略, 保留)。`,
              );
            } catch { /* 通知失败不影响级联结果 */ }
          }
        } catch (e) { console.warn('[strategies:delete] 定时任务级联清理失败:', e?.message || e); }
      }
    } catch (e) { console.warn('[strategies:delete] cascade err:', e?.message || e); }
    return res;
  });
  // 1.1.x: 卸载已挂载的 EA — 挂载逆操作但保留源码 (= _unmountEa, 不删 workspace).
  ipcMain.handle('strategies:unmount',       async (_e, n) => {
    const stem = String(n || '').replace(/\.(mq5|ex5|mqh|set)$/i, '').replace(/^.*[\\/]/, '');
    if (!stem) return { ok: false, error: 'no ea name' };
    try {
      const summary = await _unmountEa(stem);
      return { ok: true, ...summary };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('strategies:open-folder',   () => strategies.openFolder());

  // 0.3.308: 用户在 EasyDeal「我已设置好」按钮 → 写 mounted-state.json
  // first_mount_confirmed=true. 之后 launchMt5 mounted-state restore 用 omitExpert=true
  // 让 MT5 自己加载 chart data 保留 allow=true. 解决「每次重启 EasyDeal allow 又变 ☐」.
  ipcMain.handle('strategies:confirm-first-mount', async (_e, payload = {}) => {
    const eaName = String(payload?.ea_name || '').trim();
    if (!eaName) return { ok: false, error: 'ea_name 必填' };
    try {
      const fp = _mountedStatePath();
      if (!fp) return { ok: false, error: 'userData dir 不可用' };
      let state = {};
      try {
        if (fs.existsSync(fp)) state = JSON.parse(fs.readFileSync(fp, 'utf8')) || {};
      } catch {}
      // 找含该 ea_name 的所有 entries 设 first_mount_confirmed (用户可能多 MT5 同款 EA)
      let touched = 0;
      const now = new Date().toISOString();
      for (const k of Object.keys(state)) {
        if (state[k]?.ea_name === eaName) {
          state[k].first_mount_confirmed = true;
          state[k].first_mount_confirmed_at = now;
          touched += 1;
        }
      }
      if (touched === 0) {
        return { ok: false, error: `mounted-state.json 没找到 ${eaName} 的记录. 先用 EasyDeal「挂载」按钮挂一次 EA 才有记录.` };
      }
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, fp);
      _traceLog('first_mount_confirmed', `ea=${eaName} touched=${touched}`);
      console.log(`[strategies] first_mount_confirmed ✓ for ${eaName} (${touched} entries)`);
      return { ok: true, touched };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  // 0.3.17: 上架前 ownership 校验 — 用本地 .mq5 重编一次，返回 workspace 新 .ex5
  // 路径 + sha256。renderer 拿到后用这条路径作为上传文件，调 mkt.submit。
  // 流程：用户点「提交上架」 → 此 IPC 重编 → 校验 success + ex5_rebuilt
  // (or skipped_recompile - 源码 sha 没变) → 用 workspace/strategies/<EA>.ex5
  // 上传。重编失败（用户只有别人的 .ex5 没源码 → MetaEditor 找不到 .mq5 /
  // 编译报错）→ 返 ok:false 让 renderer 弹错。
  ipcMain.handle('strategies:compile-verify', async (_e, args = {}) => {
    const { eaName, auto_inject_auth: autoInject, validity_days: validityDays } = args || {};
    if (!eaName) return { ok: false, error: 'eaName required' };

    // 0.4.3: 上架前必须检查 .mq5 源码接入了 EasyDealAuth.mqh —— 这是软强制
    // 授权校验的前提（没 include + 调用 EasyDealCheckAuth()，EA 跑起来不会
    // 联系服务端验授权，等于卖家自己作弊）。grep 简单两条规则：
    //   1. 含 `#include <EasyDealAuth.mqh>`
    //   2. 至少一处 EasyDealCheckAuth( 调用
    // 永久授权（validity_days=0）跳过这条检查 —— 没过期概念就不需要 SDK。
    //
    // 0.3.49: auto_inject_auth 路径 — 不再原地改用户的 strategies/<EA>.mq5，
    // 改成在 strategies/_listing-builds/<EA>-<ts>/ 准备独立 build：
    //   ① 复制原 .mq5 → 注入授权 SDK
    //   ② 用 alt 名 `<EA>__lst<ts8>` 走 compile_strategy（避免覆盖 MT5/Experts
    //      正在跑的 <EA>.ex5）
    //   ③ 把 alt 编译产物 .ex5 复制回 _listing-builds/<EA>-<ts>/ 作为上传产物
    //   ④ CLEANUP：删 workspace/strategies/<EA>__lst<ts8>.mq5/.ex5 + MT5/Experts
    //      的同名残留，不污染主目录、不动用户运行中的 EA
    // 永久授权（validity=0）整段跳过 auth 检查，走老路径重编 workspace .mq5
    // 验证 ownership 直接用得到的 workspace/strategies/<EA>.ex5 上传。
    const workspaceMq5 = path.join(
      app.getPath('userData'), 'workspace', 'strategies', `${eaName}.mq5`,
    );
    if (!fs.existsSync(workspaceMq5)) {
      return { ok: false, error: `源码 ${eaName}.mq5 不在 workspace/strategies/，无法上架 — 商城要求必须有源码证明作者身份` };
    }
    let mq5Text;
    try { mq5Text = fs.readFileSync(workspaceMq5, 'utf8'); } catch (e) {
      try { mq5Text = fs.readFileSync(workspaceMq5).toString('utf8'); } catch (_) { mq5Text = ''; }
    }
    const hasInclude = /#include\s*<EasyDealAuth\.mqh>/.test(mq5Text);
    const hasCall    = /\bEasyDealCheckAuth\s*\(/.test(mq5Text);

    const needsAuth = Number(validityDays || 0) > 0;

    // ----- 永久授权或 EA 自带 auth 调用 ⇒ 走老路径，直接 workspace .mq5 → .ex5 -----
    if (!needsAuth || (hasInclude && hasCall)) {
      const r = await compileStrategyOnce(eaName);
      if (!r || r.error || r.ok === false) {
        return { ok: false, error: r?.error || r?.hint || '编译失败 — 无法验证 ownership', detail: r };
      }
      const compileOk = r.success === true || r.skipped_recompile === true || r.ex5_rebuilt === true;
      if (!compileOk) {
        return { ok: false, error: '编译没成功，无法上架', detail: r };
      }
      const ws = path.join(app.getPath('userData'), 'workspace', 'strategies', `${eaName}.ex5`);
      try {
        const buf = fs.readFileSync(ws);
        const crypto = require('node:crypto');
        return {
          ok: true,
          ex5_path: ws,
          ex5_sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          ex5_size: buf.length,
          compile: r,
          build_mode: 'inplace',
        };
      } catch (e) {
        return { ok: false, error: '编译完成但读不到 workspace .ex5: ' + (e?.message || e), detail: r };
      }
    }

    // ----- 限时授权 + 源码缺 auth -----
    if (!autoInject) {
      return {
        ok: false,
        error: '上架前必须接入授权校验，缺：' + [
          !hasInclude ? '#include <EasyDealAuth.mqh>' : null,
          !hasCall    ? 'EasyDealCheckAuth() 调用'      : null,
        ].filter(Boolean).join(' + '),
        detail: _authMissingDetail(workspaceMq5, !hasInclude, !hasCall),
      };
    }

    // ----- 自动注入 — 走独立 listing build 目录 -----
    const inj = _injectEasyDealAuth(mq5Text);
    if (!inj.ok) {
      return {
        ok: false,
        error: '自动注入失败：' + inj.error + ' — 你可以手动按下面提示加，或选「永久授权」跳过这一步',
        detail: _authMissingDetail(workspaceMq5, !hasInclude, !hasCall),
      };
    }

    const tsFull = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);  // YYYYMMDDTHHMMSS
    const tsShort = tsFull.replace(/[T-]/g, '').slice(0, 12);                   // YYYYMMDDHHMM
    const altName = `${eaName}__lst${tsShort}`;
    const buildDir = path.join(app.getPath('userData'), 'workspace', 'strategies',
                               '_listing-builds', `${eaName}-${tsFull}`);
    try { fs.mkdirSync(buildDir, { recursive: true }); }
    catch (e) { return { ok: false, error: '创建 listing build 目录失败: ' + (e?.message || e) }; }
    // 保留 origin 名字 + alt 名字两份 — origin 让用户直观能看「这次上架用了
    // 哪份源码注入了什么」，alt 是 compile_strategy 实际编译时拿来用的
    try {
      fs.writeFileSync(path.join(buildDir, `${eaName}.mq5`),    inj.text, 'utf8');   // 给用户审阅
      fs.writeFileSync(path.join(buildDir, '_original.mq5'),    mq5Text,  'utf8');   // 留底原文件
    } catch (e) { return { ok: false, error: '写入 listing build 源码失败: ' + (e?.message || e) }; }

    // alt 名字在 workspace/strategies/ 放一份让 compile_strategy 找得到（按 ea_name 查）。
    // 注意：放在 workspace 根目录（不放进 _listing-builds 子目录），因为 compile_strategy
    // 的 src_candidates 只查 workspace/strategies/<EA>.mq5 flat 路径 + MT5/Experts 递归。
    const altSrcMq5 = path.join(app.getPath('userData'), 'workspace', 'strategies', `${altName}.mq5`);
    try { fs.writeFileSync(altSrcMq5, inj.text, 'utf8'); }
    catch (e) { return { ok: false, error: '写入 alt 源码失败: ' + (e?.message || e) }; }

    // 收集要清的临时文件，finally 里统一删
    const cleanupPaths = [altSrcMq5];
    const altWsEx5 = path.join(app.getPath('userData'), 'workspace', 'strategies', `${altName}.ex5`);
    cleanupPaths.push(altWsEx5);
    try {
      const m = (await settings.ensureDetected()).mt5;
      if (m?.dataDir)    cleanupPaths.push(path.join(m.dataDir,    'MQL5', 'Experts', `${altName}.mq5`),
                                            path.join(m.dataDir,    'MQL5', 'Experts', `${altName}.ex5`));
      if (m?.installDir && m.installDir !== m.dataDir) {
        cleanupPaths.push(path.join(m.installDir, 'MQL5', 'Experts', `${altName}.mq5`),
                          path.join(m.installDir, 'MQL5', 'Experts', `${altName}.ex5`));
      }
    } catch {}

    let r;
    try {
      r = await compileStrategyOnce(altName);
    } catch (e) {
      _cleanupListingBuildTemp(cleanupPaths);
      return { ok: false, error: 'alt 编译失败: ' + (e?.message || e), detail: { build_dir: buildDir } };
    }
    if (!r || r.error || r.ok === false) {
      _cleanupListingBuildTemp(cleanupPaths);
      return { ok: false, error: r?.error || r?.hint || 'alt 编译失败 — 无法验证 ownership',
               detail: { ...r, build_dir: buildDir } };
    }
    const compileOk = r.success === true || r.skipped_recompile === true || r.ex5_rebuilt === true;
    if (!compileOk) {
      _cleanupListingBuildTemp(cleanupPaths);
      return { ok: false, error: 'alt 编译没成功', detail: { ...r, build_dir: buildDir } };
    }

    // 把 alt .ex5 拷到 buildDir，本地副本作为上传产物
    const buildEx5 = path.join(buildDir, `${eaName}.ex5`);
    let sha = null, size = null;
    try {
      let altEx5Buf = null;
      for (const p of [altWsEx5,
                       ...cleanupPaths.filter((x) => x.endsWith(`${altName}.ex5`) && x !== altWsEx5)]) {
        try { altEx5Buf = fs.readFileSync(p); break; } catch {}
      }
      if (!altEx5Buf) throw new Error('找不到 alt 编译产物 .ex5');
      fs.writeFileSync(buildEx5, altEx5Buf);
      const crypto = require('node:crypto');
      sha = crypto.createHash('sha256').update(altEx5Buf).digest('hex');
      size = altEx5Buf.length;
    } catch (e) {
      _cleanupListingBuildTemp(cleanupPaths);
      return { ok: false, error: '保存 listing build .ex5 失败: ' + (e?.message || e),
               detail: { ...r, build_dir: buildDir } };
    }

    // 清掉所有 alt 临时文件（workspace + MT5/Experts），不污染主目录、
    // 不动用户运行中的 <EA>.ex5
    _cleanupListingBuildTemp(cleanupPaths);

    console.log(`[compile-verify] listing build done for ${eaName}: ${buildEx5} (sha=${sha.slice(0,8)}…, ${size}B)`);

    return {
      ok: true,
      ex5_path:    buildEx5,
      ex5_sha256:  sha,
      ex5_size:    size,
      compile:     r,
      build_mode:  'isolated',     // UI 用得着的话能展示「本次上架用独立 build」
      build_dir:   buildDir,        // 用户审阅 / 反悔时能找到的目录
      injected:    inj.injected,
    };
  });
  ipcMain.handle('strategies:open-in-editor',(_e, name) => {
    const safe = path.basename(String(name));
    return strategies.openInEditor(path.join(strategies.dir, safe));
  });
  ipcMain.handle('strategies:read-doc', (_e, name) => strategies.readDoc(name));
  ipcMain.handle('strategies:write-doc', (_e, name, content) => strategies.writeDoc(name, content));
  // 1.2.38: 确定性重新编译(不走 AI 对话) — workspace/strategies/<EA>.mq5 → <EA>.ex5。
  // 给「源码改过(.ex5 stale)」的策略挂载用: 先 compile 再 deployCompiled + 自动挂载,
  // 避开 AI 重编路径(那条在重启挂载后会杀 MT5)。workspace .ex5 不被 MT5 锁(MT5 跑的是
  // MT5/Experts/ 里那份), 编译不用杀 MT5。
  ipcMain.handle('strategies:compile', async (_e, name) => {
    const eaName = String(name || '').split('/').pop().replace(/\.(mq5|ex5)$/i, '');
    if (!eaName) return { ok: false, error: 'no ea name' };
    try {
      // 跟后面 strategies:deploy-compiled 用同一个实例 (EA 绑定的, 没绑回活动实例)。
      const target = await resolveMt5ForEa(eaName);
      const r = await compileStrategyOnce(eaName, {
        envOverride: {
          EASYDEAL_MT5_INSTALL_DIR: target.installDir,
          EASYDEAL_MT5_DATA_DIR:    target.dataDir,
          EASYDEAL_MT5_INSTANCE_ID: target.instance_id,
          EASYDEAL_MT5_LAUNCH_MODE: target.launchMode,
        },
      });
      const ok = !!r && (r.success === true || r.skipped_recompile === true
                         || r.ex5_rebuilt === true || r.ok === true);
      return ok ? { ok: true, ...r } : { ok: false, error: (r && (r.error || r.message || r.errors?.[0])) || '编译失败', raw: r };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('strategies:deploy-compiled', async (_e, name) => {
    // 0.3.189 Phase 2: 按 EA 绑的 instance 走 dataDir, 没绑回 fallback 到活动实例
    // 0.3.202: 整体 try/catch — 防 resolveMt5ForEa / deployCompiled 任何步抛未捕获
    try {
      const stem = String(name || '').split('/').pop().replace(/\.(mq5|ex5)$/i, '');
      const r = await resolveMt5ForEa(stem);
      if (!r.dataDir) return { ok: false, error: 'MT5 数据目录未配置（请先在 MT5 tab 添加实例并设为活动）' };
      // 0.3.277: 用户实测 0.3.276 报「3 种不同体验」根因: 老 0.3.202 在 MT5 未运行
      // 时提前 return ok=false + mt5_not_running, renderer 走 confirm() 弹窗 + 一键
      // 启动 + 5s retry, 跟 MT5 在运行时直接 showDeployResultDialog 完全不同体验.
      // 现在改: **不再提前 return**, deploy 始终执行 (拷 .ex5 不依赖 MT5 进程在),
      // 把 mt5_not_running 标记带在 ok 响应里让 renderer 自己决定显示文案微调.
      // 用户拿到的永远是同一个 showDeployResultDialog → 「自动 / 手动」二选一,
      // 「自动」内部会 autoAttachEA 处理 MT5 启动 (kill 是 no-op 如果没跑) + ini 挂载.
      let mt5NotRunning = false;
      try {
        if (r.installDir) {
          const pids = await _findMt5PidsForInstall(r.installDir);
          mt5NotRunning = !pids.length;
        }
      } catch (e) {
        console.warn('[deploy-compiled] _findMt5PidsForInstall failed (treating as running):', e?.message || e);
      }
      // 0.3.245: 把其它 MT5 实例 dataDir 全传进去, 让 deployCompiled 顺手清掉
      // 它们 Experts/ 里同名 .ex5 残留 (用户 bug: 之前 EA 部署到默认 pibar,
      // 后来绑了 VP固定参数 后再挂载, pibar 里的老 .ex5 不清 → pibar 还在跑).
      const otherInstances = settings.listMt5Instances?.() || [];
      const out = await strategies.deployCompiled(name, r.dataDir, otherInstances, r.installDir);
      if (out?.ok) {
        out.mt5_instance_id = r.instance_id;
        out.mt5_instance_source = r.source;
        out.mt5_not_running = mt5NotRunning;
        out.mt5_install_dir = r.installDir;
      }
      return out;
    } catch (e) {
      console.error('[deploy-compiled] uncaught:', e?.stack || e);
      return { ok: false, error: '挂载流程出错: ' + (e?.message || String(e)) };
    }
  });
  // 0.3.189 Phase 2: 给 EA 绑 / 解绑 mt5_instance_id
  ipcMain.handle('strategies:get-mt5-instance', async (_e, eaName) => {
    if (!strategies) return { ok: false, error: 'strategies not ready' };
    const id = strategies.getMt5InstanceForEa(eaName);
    const all = settings.listMt5Instances?.() || [];
    const inst = id ? all.find((it) => it.id === id) : null;
    return { ok: true, instance_id: id, instance: inst || null };
  });
  ipcMain.handle('strategies:set-mt5-instance', async (_e, payload = {}) => {
    if (!strategies) return { ok: false, error: 'strategies not ready' };
    const eaName    = String(payload.eaName || '').trim();
    const instanceId = payload.instanceId ? String(payload.instanceId).trim() : null;
    if (!eaName) return { ok: false, error: 'eaName required' };
    if (instanceId) {
      const all = settings.listMt5Instances?.() || [];
      if (!all.find((it) => it.id === instanceId)) {
        return { ok: false, error: 'instance not found' };
      }
    }
    // 0.4.30: 记录改绑前的旧实例, 改绑成功后清旧实例 OG 里这只 EA 的孤儿启用记录
    // (否则护航「已护航 EA」会多出一条同名 EA — 残留在旧实例 OG)。
    let _ogFrom = null;
    try { _ogFrom = strategies.getMt5InstanceForEa?.(eaName) || null; } catch {}
    try {
      const result = await strategies.setMt5InstanceForEa(eaName, instanceId, payload.opts || {});
      if (result?.ok) {
        try { await orderguard?.cleanupReboundEa?.(eaName, _ogFrom, instanceId); } catch (_) {}
      }
      return result;
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 挂载 = 让 Python attach_eas_to_charts 往该 EA 绑定实例的图表配置里写 <expert>。
  // 不杀 MT5 进程: 没在跑 → 写完文件用 launchMt5 启动, MT5 启动时自然挂上;
  // 在跑 → MT5 重新加载一次图表配置 (几秒, 其它图表上的 EA 会重新初始化)。
  // opts: { symbol, period, inputs } — 不传 symbol 用 EA 自己的 monitor_config
  // (Python 侧按品种选图表: 已挂同名 EA 的 → 更新, 空图表 → 挂上, 否则新开)。
  ipcMain.handle('strategies:auto-attach-ea', async (_e, eaName, opts) => {
    const stem = String(eaName || '').replace(/\.(mq5|ex5)$/i, '');
    const assignment = { ea_name: stem };
    if (opts?.symbol) {
      assignment.symbol = opts.symbol;
    } else {
      try {
        const mc = strategies?.getMonitorConfig?.(stem);
        if (mc?.symbols?.length) assignment.symbol = mc.symbols[0];
      } catch (e) {
        console.warn('[auto-attach] getMonitorConfig failed:', e?.message || e);
      }
    }
    if (!assignment.symbol) return { ok: false, stage: 'no_symbol', error: '这只 EA 没配置交易品种，请先在「策略」表填「品种」' };
    if (opts?.period) assignment.period = opts.period;
    if (opts?.inputs && typeof opts.inputs === 'object') assignment.inputs = opts.inputs;

    let target = null;
    try {
      target = await resolveMt5ForEa(stem);
    } catch (e) {
      console.warn('[auto-attach] resolveMt5ForEa failed:', e?.message || e);
    }
    if (!target?.instance_id) return { ok: false, error: '无法确定挂载目标 MT5 实例' };
    const inst = settings.listMt5Instances().find((it) => it.id === target.instance_id);
    const checked = validateMt5Instance(inst, { siblings: settings.listMt5Instances() });
    if (!checked.ok) return { ok: false, error: checked.errors.join('；'), config_error: true };

    let running = false;
    try {
      const scan = await _findMt5PidsForInstallStrict(inst.installDir);
      running = !!(scan.scanOk && scan.pids.length);
    } catch (e) {
      console.warn('[auto-attach] pid scan failed (treating as running):', e?.message || e);
      running = true;
    }
    const result = await callEasydealMcpOnce('attach_eas_to_charts', {
      assignments: [assignment],
      instance_id: inst.id,
      confirm_reload: true,   // 挂载对话框已经把「图表重新加载」的影响告诉用户
    }, {
      timeoutMs: 120_000,
      envOverride: {
        EASYDEAL_MT5_INSTALL_DIR: inst.installDir,
        EASYDEAL_MT5_DATA_DIR: inst.dataDir,
        EASYDEAL_MT5_LAUNCH_MODE: inst.launchMode,
        EASYDEAL_MT5_INSTANCE_ID: inst.id,
        EASYDEAL_MT5_ALLOW_LAUNCH: '0',
      },
    });
    if (!result?.ok) return result || { ok: false, error: '挂载没有返回结果' };
    const first = result.results?.[0] || {};
    const out = {
      ...result,
      picked: first.chart?.symbol || assignment.symbol,
      period: first.chart?.period || assignment.period || 'H1',
      mt5_started: false,
    };
    if (!running) {
      try { global._clearKillFlag?.(inst.installDir); } catch {}
      _mt5LaunchAuthorization.set(inst.id, Date.now() + 180_000);
      const launch = await launchMt5(inst, { armEaName: stem });
      out.launch = launch;
      out.mt5_started = !!launch?.ok;
      if (launch?.ok) {
        try { await settings.updateMt5Instance(inst.id, { user_intent: 'running' }); } catch {}
      } else {
        out.ok = false;
        out.stage = 'launch_failed';
        out.error = `EA 已写进图表配置，但启动 MT5 失败：${launch?.error || '未知'}`;
      }
    }
    return out;
  });
  // 0.3.49: 实时拉每只 EA 的成绩单（替代老的 records-based UI 路径）。
  // Node 把 magic / symbols / load_at 解析好打包成 specs，调一次 Python
  // MCP get_ea_realtime_stats 一锅出所有 EA 的 trades / pnl / max_drawdown /
  // open_positions。UI 刷新时调一次拿真值，不再依赖每小时 ticker 写 records。
  ipcMain.handle('strategies:live-stats', async (_e, opts = {}) => {
    try {
      if (!strategies) return { ok: false, error: 'strategies module not ready' };
      // 1.4.9 按账户(实例)分组算战绩 —— 老逻辑只连默认那一个 MT5 实例, 把所有 EA 的成交
      // 都从一个账户里按 magic 过滤。多账户多实例场景(实盘机器: 4 账户各挂一个
      // GMarket 副本, magic 全 999)下: ①非默认实例的 EA is_mounted 判 false 被跳过 → 战绩=0;
      // ②即便算也会拿默认账户的成交按 magic 999 认领 → 张冠李戴。改成遍历每个 MT5 实例,
      // 每次调用 override 该实例的 install_dir/data_dir(env 路由), Python 连对账户拉对成交,
      // 每个账户就一个 EA, magic 冲突天然无害。持仓归属服务端早按 account 分对了, 这里对齐。
      const listArgs = await _resolveStrategiesListArgs();
      const list = await strategies.list(listArgs);
      const instances = listArgs.mt5InstancesList || [];
      const defInstall = listArgs.mt5InstallDir;
      const defData = listArgs.mt5DataDir;
      const nowSec = Math.floor(Date.now() / 1000);
      const LOOKBACK_DAYS = opts.lookback_days || 30;
      const lookbackFloor = nowSec - LOOKBACK_DAYS * 86400;

      // 每个 EA 按绑定实例分组; 未绑(mt5_instance_id 空)归默认实例。
      // 桶 key = installDir(小写); 值 = {installDir, dataDir, specs[]}。
      const buckets = new Map();
      const _keyOf = (dir) => String(dir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const _instById = new Map(instances.map((x) => [x.id, x]));
      // per-instance symbol/magic map 缓存(按 dataDir)
      const _symMapCache = new Map();
      const _magicMap = statsCollector ? await statsCollector._readMagicMap() : {};
      for (const it of list) {
        if (!it.is_mounted && !opts.include_unmounted) continue;
        const ea = it.name.replace(/\.(mq5|ex5)$/i, '');
        const inst = it.mt5_instance_id ? _instById.get(it.mt5_instance_id) : null;
        const installDir = inst?.installDir || defInstall;
        const dataDir = inst?.dataDir || defData;
        const magic = Object.entries(_magicMap).find(([_mg, name]) => name === ea)?.[0];
        let symMap = _symMapCache.get(_keyOf(dataDir));
        if (symMap === undefined) {
          try { symMap = dataDir ? await strategies.getMountedEaSymbols(dataDir) : {}; }
          catch { symMap = {}; }
          _symMapCache.set(_keyOf(dataDir), symMap);
        }
        const sym = symMap[ea];
        const loadAtSec = it.last_loaded_at_ms ? Math.floor(it.last_loaded_at_ms / 1000) : nowSec;
        const cumHoursSec = Math.floor((it.hours_run || 0) * 3600);
        const effectiveSinceSec = Math.max(lookbackFloor, loadAtSec - cumHoursSec);
        const spec = {
          ea_name: ea,
          ...(magic != null ? { magic: Number(magic) } : {}),
          ...(sym?.symbols?.length ? { symbols: sym.symbols } : {}),
          load_at_sec: loadAtSec,
          effective_since_sec: effectiveSinceSec,
        };
        const key = _keyOf(installDir);
        if (!buckets.has(key)) buckets.set(key, { installDir, dataDir, specs: [] });
        buckets.get(key).specs.push(spec);
      }
      if (!buckets.size) return { ok: true, items: [], note: '当前没有挂载中的 EA' };

      // 每个实例并行调一次 get_ea_realtime_stats(各连各的账户); 合并 items。
      // 单实例场景 = 只有一个桶, 行为等同旧版, 零回归。
      const results = await Promise.all([...buckets.values()].map(async (b) => {
        try {
          const r = await callEasydealMcpOnce(
            'get_ea_realtime_stats',
            { eas: b.specs, lookback_days: LOOKBACK_DAYS },
            { timeoutMs: 30_000, envOverride: { EASYDEAL_MT5_INSTALL_DIR: b.installDir, EASYDEAL_MT5_DATA_DIR: b.dataDir } },
          );
          return (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        } catch { return []; }
      }));
      return { ok: true, items: results.flat() };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('strategies:debug-mounts',    async () => {
    const m = (await settings.ensureDetected()).mt5;
    return strategies.debugMountDetect(m.dataDir, m.installDir);
  });

  // ---------- 0.3.53: 参数设置 IPC ----------
  // 全部通过 callEasydealMcpOnce 转发到 python MCP 的对应工具。命名沿用
  // strategies:params-* 前缀。
  ipcMain.handle('strategies:params-list-inputs', async (_e, eaName) => {
    return callEasydealMcpOnce('list_ea_inputs', { ea_name: eaName || '' },
      { timeoutMs: 15_000 });
  });
  ipcMain.handle('strategies:params-detect-hot-reload', async (_e, eaName) => {
    return callEasydealMcpOnce('detect_ea_hot_reload_support',
      { ea_name: eaName || '' }, { timeoutMs: 10_000 });
  });
  ipcMain.handle('strategies:params-read', async (_e, eaName) => {
    // 现有 get_strategy_params 已经能提供 runtime / config_set / source 合并视图。
    // 1.3.x 修复: 跟 params-write 一样解析并带上 instance_id, 否则写到绑定实例、
    // 读默认实例 → 多账户/多 EA 下"改了保存后重开又还原"。
    const args = { ea_name: eaName || '' };
    try {
      const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
      if (stem && typeof strategies.getMt5InstanceForEa === 'function') {
        const instId = strategies.getMt5InstanceForEa(stem);
        if (instId) args.instance_id = instId;
      }
    } catch {}
    return callEasydealMcpOnce('get_strategy_params', args, { timeoutMs: 10_000 });
  });
  ipcMain.handle('strategies:params-write', async (_e, payload) => {
    // payload: { ea_name, params: {k:v}, mode: 'hot' | 'preset' | 'both' }
    // 1.2.26 多账户根治: 把参数写到这只 EA **绑定的那台 MT5 实例**的 MQL5/Files + Presets,
    // 不再只写默认实例。否则绑在非默认实例的 EA(用户 4 个 exness)改参数全落到 exness_1,
    // 重挂时各账户找不到自己的预设 → 改了不生效。instance_id 没绑/默认 → null →
    // Python 内部 _resolve_data_path_for_instance(null) 回退默认实例(老行为, 零回归)。
    const args = { ...(payload || {}) };
    try {
      const stem = String(args.ea_name || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
      if (stem && typeof strategies.getMt5InstanceForEa === 'function') {
        const instId = strategies.getMt5InstanceForEa(stem);
        if (instId) args.instance_id = instId;
      }
    } catch {}
    return callEasydealMcpOnce('write_ea_parameters', args, { timeoutMs: 15_000 });
  });
  ipcMain.handle('strategies:params-delete-hot-file', async (_e, eaName) => {
    try {
      // 与读取、写入参数保持同一套 per-EA 实例解析，不能误删默认实例的同名文件。
      const target = await resolveMt5ForEa(eaName);
      const result = await deleteHotParamFiles({
        eaName,
        // portable 模式二者相同会自动去重；standard 模式兼顾真实 dataDir，
        // 以及历史版本可能误写到 installDir 的遗留文件。
        roots: [target?.dataDir, target?.installDir],
      });
      return {
        ...result,
        instance_id: target?.instance_id || null,
        instance_source: target?.source || null,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), removed: [] };
    }
  });
  // 0.3.53: 让用户从本地 .set 文件导入参数到「参数设置」对话框
  // 文件选 dialog 必须在 main 进程；读 .set 也在这里（绕开 renderer 沙箱）。
  // .set 文件 MT5 写的是 UTF-16 LE BOM，但有些手动导出的可能是 UTF-8 —— 两种都兼容。
  // 值可能形如 `Name=10||1||1||100||N`（MT5 Strategy Tester saved presets），
  // 只取第一段（实际值），其余 `||start||step||stop||flag` 元数据丢弃。
  ipcMain.handle('strategies:params-import-set-file', async () => {
    if (!win) return { ok: false, error: '窗口不可用' };
    const r = await dialog.showOpenDialog(win, {
      title: '选择 .set 参数文件',
      filters: [{ name: 'MT5 Set Files', extensions: ['set'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
    const setPath = r.filePaths[0];
    try {
      const raw = await fs.promises.readFile(setPath);
      let text;
      if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
        text = raw.slice(2).toString('utf16le');
      } else {
        text = raw.toString('utf8');
      }
      const params = {};
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim().replace(/^﻿/, '');
        if (!trimmed) continue;
        if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
        if (!trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (value.includes('||')) value = value.split('||')[0];
        if (key) params[key] = value;
      }
      return { ok: true, path: setPath, params, count: Object.keys(params).length };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Per-strategy "join leaderboard" toggle. Stores locally + syncs to server.
  // Server filters its public leaderboard to only opt-in (license, ea_hash) pairs.
  ipcMain.handle('strategies:set-lb-optin', async (_e, eaName, optIn) => {
    // Pass MT5 paths so setLbOptIn can fall back to <MT5>/Experts/<stem>.ex5
    // when workspace lacks a copy (Claude's compile_strategy MCP commonly
    // writes the .ex5 straight into MT5 without copying back to workspace).
    const m = (await settings.ensureDetected()).mt5;
    // Source-ownership gate (also enforced in UI, but guard the IPC too):
    // only EAs with a workspace .mq5 can opt INTO the leaderboard. Opt-OUT
    // is always allowed so the user can leave even if their source went
    // missing later. Bought-from-market binary-only strategies = no source
    // → can't claim someone else's binary on the public board.
    if (optIn) {
      try {
        const list = await strategies.list({
          mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
        });
        const stem = String(eaName).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
        const it = list.find((x) => {
          const s = String(x.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
          return s === stem;
        });
        if (it && !it.has_source) {
          return {
            ok: false,
            error: 'no_source — 只有持有源码 (.mq5) 的策略才能参与排行榜（购买的纯 .ex5 策略不可参榜）。',
          };
        }
      } catch (e) {
        console.warn('[lb-optin] source check failed:', e.message);
      }
    }
    const result = await strategies.setLbOptIn(eaName, !!optIn, {
      mt5DataDir:    m.dataDir,
      mt5InstallDir: m.installDir,
    });
    if (!result?.ok) return result || { ok: false, error: 'set failed' };
    // Sync to server (best-effort — UI doesn't block on it).
    // Server now requires a session token; license_key is sent as
    // belt-and-suspenders but server validates it matches the token's
    // bound license and rejects mismatches.
    const lic = license.getStatus();
    const tok = license._activeToken();
    if (tok && lic?.key && result.ea_hash) {
      try {
        const r = await serverApi.post('/v1/strategies/leaderboard-optin', {
          token:       tok,
          license_key: lic.key,
          machine_id:  lic.machine_id,
          ea_hash:     result.ea_hash,
          ea_name:     eaName.replace(/\.(mq5|ex5)$/i, ''),
          opt_in:      !!optIn,
        });
        result.synced = !!r.ok;
        if (!r.ok) result.sync_error = r.error || (r.offline ? 'server offline' : `status ${r.status}`);
      } catch (e) {
        result.synced = false;
        result.sync_error = e.message || String(e);
      }
    } else {
      result.synced = false;
      result.sync_error = !tok ? '未登录' : (!lic?.key ? '未登录' : '该策略无 ex5 hash（未编译）');
    }
    return result;
  });
  // Manual "push today's snapshot now" trigger — bypasses the once-per-day
  // rollover gate. Used to verify leaderboard plumbing without waiting until
  // tomorrow morning. Returns { ok, uploaded, items, error? }.
  ipcMain.handle('strategies:force-upload-stats', async () => {
    if (!statsCollector) return { ok: false, error: 'stats collector not running' };
    return await statsCollector.forceUploadNow();
  });
  ipcMain.handle('strategies:list-backtests',  (_e, name) => backtests.listForEa(name));
  // 0.3.119: per-EA 监控配置 (symbols/magic/comment 过滤器)。set 时会自动 dump JSON
  // 给 Python MCP 读 (workspace/.easydeal-ea-monitor.json)
  ipcMain.handle('strategies:get-monitor-config', (_e, eaName) => strategies.getMonitorConfig(eaName));
  ipcMain.handle('strategies:set-monitor-config', (_e, eaName, cfg) => strategies.setMonitorConfig(eaName, cfg || {}));
  // 0.3.151: 护航阈值 get/save (UI「监控配置」对话框 + 「🛡 护航」启用 flow 用)
  ipcMain.handle('strategies:get-orderguard-thresholds', (_e, eaName) => {
    const t = strategies.getOrderguardThresholds(eaName);
    return { ok: true, thresholds: t };
  });
  ipcMain.handle('strategies:save-orderguard-thresholds', (_e, eaName, thresholds) => {
    return strategies.saveOrderguardThresholds(eaName, thresholds || {});
  });
  // 0.3.130: 手动「重置基准余额」—— 给 ea_name 对应所有 record 标 needs_anchor_reseed
  // = true，下次 stats-collector tick 拿当前 MT5 balance + login 重新 anchor。
  ipcMain.handle('strategies:reset-anchor', async (_e, eaName, manualInitialBalance) => {
    // 0.3.142: reset 走「直接重置 record」路径 (不依赖 stats-collector tick 检测
    // flag)。用户反馈截图「按 10000 重置但没起作用」+ account_baseline 仍 10614.6。
    // 改为：
    //   1. main 先拉 MT5 当前 balance (snapshot)
    //   2. strategies.resetAnchorForEa(eaName, mib, balance) 直接重置 record，
    //      若 useManual → set pnl = balance - mib (账户级 since-anchor 视角)
    //   3. fire-and-forget 触发 tick 刷新最新 today_* 字段
    // 不与 OrderGuard sync — 用户明确「保持原来的两边不同步」。
    let currentBalance = null;
    try {
      if (statsCollector) {
        const snap = await statsCollector.snapshot();
        currentBalance = Number(snap?.account?.balance || 0) || null;
      }
    } catch (e) {
      console.warn('[reset-anchor] snapshot failed:', e?.message || e);
    }
    const r = await strategies.resetAnchorForEa(
      eaName,
      manualInitialBalance != null ? manualInitialBalance : null,
      currentBalance
    );
    if (r?.ok && statsCollector) {
      // 异步触发刷今天 hours/trades
      statsCollector.tick().catch((e) => console.warn('[reset-anchor] tick err:', e?.message || e));
    }
    return r;
  });
  ipcMain.handle('strategies:unread-backtests',()      => backtests.unreadCountByEa());
  ipcMain.handle('strategies:mark-backtests-read', (_e, name) => backtests.markEaRead(name));
  // 删一条 / 清空某 EA 的回测记录 — 用户在「我的策略」回测历史面板点
  // 「✕」/「清空全部」时调。删了之后 AI 调 list_backtests / get_backtest_status
  // 拿不到这批了，UI 也不会再展示。running / queued 的会保留（强制用户
  // 先「取消」再删除），避免悬空 spawn。
  ipcMain.handle('strategies:delete-backtest', (_e, btId) => backtests.deleteRecord(btId));
  ipcMain.handle('strategies:clear-backtests', (_e, name) => backtests.clearForEa(name));

  // 0.3.95: 回测记录加「回退代码」— 把 strategies/<EA>.mq5 还原到这次回测当时的源码版本
  // 流程：(1) 读 snapshot_path 内容 (2) 当前 .mq5 备份成 .mq5.before-restore-<时间戳>
  // (3) 写回 snapshot 内容
  ipcMain.handle('strategies:restore-mq5-from-backtest', async (_e, payload) => {
    const eaName = String(payload?.ea_name || '').trim();
    const snapRel = String(payload?.snapshot_path || '').trim();
    if (!eaName || !snapRel) return { ok: false, error: 'ea_name + snapshot_path 必填' };
    try {
      const workspaceDir = path.join(app.getPath('userData'), 'workspace');
      // snapshot_path 是相对 workspace（strategies/.versions/<EA>/...）的路径
      const snapAbs = path.isAbsolute(snapRel) ? snapRel : path.join(workspaceDir, snapRel);
      if (!fs.existsSync(snapAbs)) {
        return { ok: false, error: `快照文件不存在: ${snapRel}` };
      }
      const mq5Path = path.join(workspaceDir, 'strategies', `${eaName}.mq5`);
      if (!fs.existsSync(mq5Path)) {
        return { ok: false, error: `${eaName}.mq5 不存在 — 可能已被删除` };
      }
      // 备份当前 .mq5
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = `${mq5Path}.before-restore-${ts}`;
      await fs.promises.copyFile(mq5Path, backupPath);
      // 覆盖
      await fs.promises.copyFile(snapAbs, mq5Path);
      console.log(`[restore-mq5] ${eaName}.mq5 ← ${snapRel}, backup=${path.basename(backupPath)}`);
      return {
        ok: true,
        backup_path: backupPath,
        restored_from: snapAbs,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  // Per-EA "best 3-month-passing backtest" lookup. Used by the listing
  // eligibility check (上架门槛 = 24h 在线 + 一次回测覆盖 ≥ 90 天且 net_profit > 0).
  // Returns { eaName: { hours_run, best_3mo_backtest: {id, from, to, days, net_profit, symbol, period} | null } }.
  // Walking BacktestsStore for every EA is cheap (single JSON read), so we
  // bundle them in one call rather than per-row IPC roundtrips.
  ipcMain.handle('strategies:eligibility-bundle', async () => {
    if (!strategies || !backtests) return {};
    const m = (await settings.ensureDetected()).mt5;
    const list = await strategies.list({
      mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
    });
    const out = {};
    const history = await backtests.byEa();
    for (const it of list) {
      const eaName = String(it.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
      const btList = history[eaName] || [];
      out[eaName] = {
        hours_run:           it.hours_run ?? 0,
        best_3mo_backtest:   _pickBestPassing3moBacktest(btList),
      };
    }
    return out;
  });
  // 0.4.6: 读 sidecar <ea>.installed.json — buyer 升级 ribbon 用，比对本地装的
  // 版本 vs listing.current_version。文件不存在 = 没用过新安装路径（老安装记录
  // / 自己写的 EA），返 null 让 caller 当 v1 处理（向后兼容）。
  ipcMain.handle('strategies:get-installed-version', async (_e, eaName) => {
    if (!eaName) return null;
    const sidecarPath = path.join(workspaceDir, 'strategies', `${eaName}.installed.json`);
    try {
      const buf = await fs.promises.readFile(sidecarPath, 'utf8');
      return JSON.parse(buf);
    } catch {
      return null;
    }
  });
  // 0.3.55: EA 关联指标依赖管理（用户 屠龙战神 iCustom 撞 0 笔成交根因修复）
  // ----------------------------------------------------------------------
  // 关联指标随 EA 交易包发布。
  ipcMain.handle('strategies:indicators-list', async (_e, eaName) => {
    try { return await strategies.listIndicators(eaName); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('strategies:indicators-add', async (_e, eaName, srcPath) => {
    try { return await strategies.addIndicator(eaName, srcPath); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('strategies:indicators-remove', async (_e, eaName, indicatorName) => {
    try { return await strategies.removeIndicator(eaName, indicatorName); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('strategies:indicators-sniff', async (_e, eaName) => {
    try { return await strategies.sniffIndicatorDependencies(eaName); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  /** 用户点「自动从 MT5 导入」按钮 → 嗅探依赖名 → 从主 MT5 MQL5/Indicators/ 自动拷 */
  ipcMain.handle('strategies:indicators-auto-import', async (_e, eaName) => {
    try {
      const sniff = await strategies.sniffIndicatorDependencies(eaName);
      if (!sniff.ok || !sniff.names?.length) {
        return { ok: !!sniff.ok, error: sniff.error, imported: [], not_found: [], errors: [], sniffed: sniff.names || [] };
      }
      const s = await settings.ensureDetected();
      const m = s.mt5 || {};
      const res = await strategies.autoImportIndicatorsFromMt5(eaName, sniff.names, {
        mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
      });
      res.sniffed = sniff.names;
      return res;
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  /** Electron 端文件选择器 — 让用户选 .ex5/.ex4/.mqh/.mq5 文件加为指标依赖。
   *  返回选中的绝对路径列表（用户取消 → []）。 */
  ipcMain.handle('strategies:indicators-pick-files', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const res = await dialog.showOpenDialog(win, {
        title: '选择指标文件（.ex5 / .ex4 / .mqh / .mq5）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'MT5 编译产物', extensions: ['ex5', 'ex4'] },
          { name: 'MT5 源码 / Include', extensions: ['mqh', 'mq5'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      return { ok: !res.canceled, paths: res.filePaths || [] };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('strategies:request-doc-action', async (_e, action, name) => {
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = buildStrategyDocPrompt(action, name);
    if (!prompt) return { ok: false, error: 'unknown action: ' + action };
    chat.send(prompt).catch((e) => console.error('[strategy-doc] chat.send failed:', e));
    return { ok: true };
  });

  // -- chat
  // 1.3.x 多会话: chat:* 全部接受可选 sessionKey(缺省=全局会话)。_cs() 解析到对应
  // ChatSession(懒创建)。全局会话 = chat, 与旧行为完全一致。
  const _cs = async (sessionKey) => (sessionKey && chatMgr) ? await chatMgr.get(sessionKey) : chat;
  ipcMain.handle('chat:history', async (_e, sessionKey) => (await _cs(sessionKey)).getHistory());
  // 1.4.x: 历史往前翻分页 —— 当前 200 条(HISTORY_CAP)之外的更早消息, 从 ai-comm-log.jsonl
  // 回读(它保留 4000~6000 行, 远超 chat.json 硬截断)。beforeTs = 当前已加载最早一条的 ts。
  // 返回的老消息只有纯文本(record() 落盘时已 flatten), 无附件缩略图, 是可接受的降级。
  ipcMain.handle('chat:history-before', async (_e, sessionKey, beforeTs, limit) => {
    try {
      const s = await _cs(sessionKey);
      const _dd = path.join(app.getPath('userData'), 'data');
      const rows = require('./ai-comm-log').readBefore(_dd, s.channel, Number(beforeTs) || Date.now(), limit || 30);
      return rows.map((o) => ({
        id: o.id, role: o.role, content: o.content, ts: o.ts, systemNote: !!o.system_note,
      }));
    } catch (e) { return []; }
  });
  ipcMain.handle('chat:list-sessions', () => { try { return chatMgr ? chatMgr.list() : []; } catch { return []; } });
  ipcMain.handle('chat:recoverable-sessions', async (_e, sessionKey) => {
    try { return await (await _cs(sessionKey)).listRecoverableSessions(40); }
    catch { return []; }
  });
  ipcMain.handle('chat:restore-session', async (_e, sessionKey, sessionId) => {
    try { return await (await _cs(sessionKey)).restoreClaudeSession(sessionId); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 1.4.x「附加远程会话」: 输入栏 🖥 按钮 — 把一台已授权的被控机附加到当前会话(只读),
  // 之后每轮 spawn 带 --mcp-config(remote_proxy_mcp, 固定 read 档), 随时可换可拆。
  ipcMain.handle('chat:remote-candidates', async () => {
    try {
      const r = await marketplace.remoteListGrants();
      const g = (r && (r.data ?? r)) || {};
      // 1.4.x 拍板: 备注名优先级 ①本机在「通讯」栏给这个联系人设的本地备注名(im-meta.json
      // 的 alias, 只有自己看得到, 跟 im-view.js「命名会话」同款字段) ②对方自己设置的显示名
      // (IM 会话 peer_display_name) ③grant 自带 note(申请时留言, 常为空) ④空。
      // 跟 im-view.js:570 `_imMeta[c.id]?.alias || c.peer_display_name || ...` 同一优先级。
      const nameByKey = {};
      try {
        const im = await marketplace.imListConversations();
        let imMeta = {};
        try {
          const pathx = require('node:path'); const fsx = require('node:fs');
          const fp = pathx.join(app.getPath('userData'), 'data', 'im-meta.json');
          if (fsx.existsSync(fp)) imMeta = JSON.parse(fsx.readFileSync(fp, 'utf8') || '{}');
        } catch { /* 没设过本地备注就是空 {} */ }
        for (const c of (im?.items || [])) {
          if (!c?.peer_license_key) continue;
          const localAlias = (imMeta[String(c.id)] || {}).alias;
          const label = localAlias || c.peer_display_name;
          if (label) nameByKey[c.peer_license_key] = label;
        }
      } catch { /* IM 拉不到就只显示序列号 */ }
      return (g.as_operator || [])
        .filter((x) => x && x.status === 'approved')
        .map((x) => ({
          clientKey: x.client_key,
          scope: x.scope || 'read',
          note: nameByKey[x.client_key] || x.note || '',
        }));
    } catch { return []; }
  });
  // 1.5.5: 改成**追加**而不是替换 —— 一个会话可挂多台被控机。
  // 老行为(点一台就顶掉原来那台)是 UI 上"只能选一个"的根源。
  ipcMain.handle('chat:attach-remote', async (_e, sessionKey, clientKey, note, scope) => {
    try { return await (await _cs(sessionKey)).addRemoteAttachment({ clientKey, note, scope }); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // clientKey 传了 = 只拆那一台; 不传 = 全拆(保持老调用方的语义)。
  ipcMain.handle('chat:detach-remote', async (_e, sessionKey, clientKey) => {
    try {
      const s = await _cs(sessionKey);
      return clientKey ? await s.removeRemoteAttachment(clientKey)
                       : await s.setRemoteAttachment(null);
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 多台版: 返回数组 + 逐台对齐 scope。老的 chat:get-remote-attachment 保留(返第一台),
  // 免得别处调用方(如有)一起炸。
  ipcMain.handle('chat:get-remote-attachments', async (_e, sessionKey) => {
    try {
      const s = await _cs(sessionKey);
      const atts = s.getRemoteAttachments();
      if (!atts.length) return [];
      // scope 实时对齐通讯栏授权(理由见下面单台版的注释)。一次拉取, 全部比对。
      try {
        const r = await marketplace.remoteListGrants();
        const g = (r && (r.data ?? r)) || {};
        const approved = (g.as_operator || []).filter((x) => x && x.status === 'approved');
        let changed = false;
        const next = atts.map((a) => {
          const hit = approved.find((x) => x.client_key === a.clientKey);
          if (hit?.scope && hit.scope !== a.scope) { changed = true; return { ...a, scope: hit.scope }; }
          return a;
        });
        if (changed) { await s.setRemoteAttachment(next); return s.getRemoteAttachments(); }
      } catch { /* 网络不通 → 用存档 scope */ }
      return atts;
    } catch { return []; }
  });
  ipcMain.handle('chat:get-remote-attachment', async (_e, sessionKey) => {
    try {
      const s = await _cs(sessionKey);
      const att = s.getRemoteAttachment();
      // 1.5.2+: scope 实时对齐通讯栏授权 — 覆盖两种漂移: ①升级前存的旧附加没有
      // scope 字段(加载回退成 read, 用户实测 chip 永远显示只读) ②附加之后
      // 授权在通讯栏被升/降档。拉一次 grants 找到该被控机的现行 scope, 变了就
      // 持久化(spawn 的 remoteMcpProvider 读同一 attachment, 一并生效)。
      // 拉不到(离线/未登录)就保持存档值, 不阻塞 UI。
      if (att?.clientKey) {
        try {
          const r = await marketplace.remoteListGrants();
          const g = (r && (r.data ?? r)) || {};
          const hit = (g.as_operator || []).find(
            (x) => x && x.status === 'approved' && x.client_key === att.clientKey,
          );
          if (hit?.scope && hit.scope !== att.scope) {
            await s.setRemoteAttachment({ ...att, scope: hit.scope });
            return s.getRemoteAttachment();
          }
        } catch { /* 网络不通 → 用存档 scope */ }
      }
      return att;
    } catch { return null; }
  });
  // 策略会话候选: 从实时 MT5 各实例(login + 挂载 EA)派生 [{login, ea, label}], 让 UI 能
  // 「新建某策略的会话」。sessionKey = strat:<login>:<ea>, 与 app / 服务端一致。
  ipcMain.handle('chat:strategy-candidates', async () => {
    try {
      // 候选 = 全部策略(strategies.list, 不再只取每实例一个 mounted_ea_name → 修「只看到一个」)。
      // 未挂载 / 仅源码的策略也在内(不按 is_mounted 过滤)。
      const _m = settings?.getResolved?.()?.mt5 || {};
      let list = [];
      try { list = await strategies.list({ mt5DataDir: _m.dataDir, mt5InstallDir: _m.installDir }); } catch {}
      const _norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      // 每个策略的账户 login 三级兜底(去掉「MT5 必须当前在跑」门槛):
      //   1) 实时: list_all_mt5_status(MT5 正在跑时最准)
      //   2) 挂载记录: mounted-state.json(挂载那一刻就记了 login, 不需要 MT5 现在开着 —
      //      这是「策略挂载过、但今天没开 MT5」场景的关键, 直接读文件不用调 Python)
      //   3) 占位: 都拿不到(MT5 从没连过任何账户)时用固定占位号, 保证策略仍能开会话
      //      (功能上退化——实时持仓/账户过滤查不到数据, 但至少能开聊)
      let instLogin = {}; let defaultLogin = null;
      try {
        const r = await callEasydealMcpOnce('list_all_mt5_status', {}, { timeoutMs: 15_000 });
        for (const it of ((r && (r.instances || r.items)) || [])) {
          const login = it && ((it.account && it.account.login) || it.login);
          if (it && it.instance_id && login) instLogin[it.instance_id] = login;
          if (it && it.is_default && login) defaultLogin = login;
          if (login && defaultLogin == null) defaultLogin = login;
        }
      } catch {}
      let mountedLoginByDir = {}; let anyMountedLogin = null;
      try {
        const dd = path.join(app.getPath('userData'), 'data');
        const state = JSON.parse(fs.readFileSync(path.join(dd, 'mounted-state.json'), 'utf8')) || {};
        for (const rec of Object.values(state)) {
          if (rec && rec.login && rec.install_dir) {
            mountedLoginByDir[_norm(rec.install_dir)] = rec.login;
            if (anyMountedLogin == null) anyMountedLogin = rec.login;
          }
        }
      } catch { /* 文件不存在 = 从没挂载过任何东西, 走占位兜底 */ }
      const instDirById = {};
      try { for (const it of (settings.listMt5Instances?.() || [])) if (it.id && it.installDir) instDirById[it.id] = it.installDir; } catch {}
      const out = [];
      const seen = new Set();
      for (const s of (list || [])) {
        const stem = String(s.name || '').replace(/\.(mq5|ex5)$/i, '');
        if (!stem) continue;
        let login = s.mt5_instance_id && instLogin[s.mt5_instance_id];
        if (!login && s.mt5_instance_id && instDirById[s.mt5_instance_id]) {
          login = mountedLoginByDir[_norm(instDirById[s.mt5_instance_id])];
        }
        login = login || defaultLogin || anyMountedLogin || 'local';   // 占位: 永不因没账户跳过
        const key = `strat:${login}:${stem}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const flag = s.is_mounted ? '运行中' : (s.is_deployed ? '未挂载' : '仅源码');
        out.push({ key, login, ea: stem, label: `${stem}·${login}`, flag });
      }
      return out;
    } catch (e) { return []; }
  });
  ipcMain.handle('chat:delete-session', async (_e, sessionKey) => {
    try { return chatMgr ? await chatMgr.delete(sessionKey) : { ok: false, error: 'no_manager' }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('chat:send',    async (_e, msg, draftId, sessionKey) => {
    const list = draftId ? await attachments.listDraft(draftId) : [];
    return (await _cs(sessionKey)).send(msg, list);
  });
  ipcMain.handle('chat:reset',   async (_e, sessionKey) => {
    // 「新会话」= 彻底重置语义。0.2.1 起（升级自 0.1.56 的 cleanup）：
    //
    //   1. 取消「回测进度 X bt_xxx」cron **不管 bt_id 状态** —— queued /
    //      running / 终态都清。否则新会话开了之后旧回测的 poll 还会每
    //      分钟 headless Claude 来一句「[scheduled-trigger:回测进度...]」
    //      把刚清干净的对话又拍上去。
    //   2. GC 老的 .attachments / Claude session JSONL（>7 天） —— 长期
    //      跑对话累积几十 MB ~ GB，新会话顺手扫一下。
    //   3. chat.reset() 清 history + 关 --continue 让下次 spawn 起新 session。
    //
    // 0.2.4 起还要：清掉 chat-carryover.json 里没 consume 的旧摘要 —— 否则
    // 用户上次选过「带摘要」后又改主意点「清除」，旧摘要还会被下条新消息
    // 错误地 prepend 进去。
    try {
      const cp = path.join(app.getPath('userData'), 'data', 'chat-carryover.json');
      if (fs.existsSync(cp)) await fs.promises.unlink(cp);
    } catch {}
    _cleanupAllBacktestPollTasks().catch((e) =>
      console.warn('[chat:reset] backtest cleanup failed:', e?.message || e));
    _gcChatScratch().catch((e) =>
      console.warn('[chat:reset] gc failed:', e?.message || e));
    return (await _cs(sessionKey)).reset();
  });
  // 0.2.4：用户在「新会话」对话框选「带摘要去新会话」时调这个。
  // 跟 chat:reset 的区别：先让 AI 总结当前对话（产物入 chat-carryover.json
  // + 摘要里点名要保留的附件目录），再走清理 + reset。下条新消息发出去时，
  // chat-session 自动把摘要 prepend 进 prompt 给 Claude 做新会话上下文。
  ipcMain.handle('chat:reset-with-carryover', async (_e, sessionKey) => {
    const r = await (await _cs(sessionKey)).requestCarryoverAndReset();
    if (!r.ok) return r;
    // 跟普通 reset 一样跑后续清理（但 GC 已经被 carryover.kept_drafts 豁免）
    _cleanupAllBacktestPollTasks().catch((e) =>
      console.warn('[chat:reset-carryover] backtest cleanup failed:', e?.message || e));
    _gcChatScratch().catch((e) =>
      console.warn('[chat:reset-carryover] gc failed:', e?.message || e));
    return r;
  });
  ipcMain.handle('chat:stop',    async (_e, sessionKey) => (await _cs(sessionKey)).stop());
  ipcMain.handle('chat:busy',    async (_e, sessionKey) => (await _cs(sessionKey)).isBusy());
  // 序列号绑定授权: 通讯区卡片点「授权/拒绝」→ 经手机中继回写 server
  ipcMain.handle('chat:bind-approval-decide', async (_e, { reqId, approve } = {}) => {
    try {
      if (!mobileRelay || typeof mobileRelay.postBindApproval !== 'function')
        return { ok: false, error: 'relay_unavailable' };
      return (await mobileRelay.postBindApproval(reqId, approve)) || { ok: false, error: 'no_response' };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 1.4.x 顶部「app连接状态」: 列出/断开当前绑定本机 license 的 app 手机号
  ipcMain.handle('app-accounts:list', async () => {
    try {
      if (!mobileRelay || typeof mobileRelay.listBoundAccounts !== 'function')
        return { ok: false, error: 'relay_unavailable', items: [] };
      return (await mobileRelay.listBoundAccounts()) || { ok: false, error: 'no_response', items: [] };
    } catch (e) { return { ok: false, error: String(e?.message || e), items: [] }; }
  });
  ipcMain.handle('app-accounts:unbind', async (_e, accountId) => {
    try {
      if (!mobileRelay || typeof mobileRelay.unbindAccount !== 'function')
        return { ok: false, error: 'relay_unavailable' };
      return (await mobileRelay.unbindAccount(accountId)) || { ok: false, error: 'no_response' };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 0.3.3：「新会话」modal 用来显示当前 session 还有哪些 TodoWrite 项没完成
  ipcMain.handle('chat:get-pending-todos', async (_e, sessionKey) => {
    try { const s = await _cs(sessionKey); return s ? await s.getPendingTodos() : []; }
    catch (e) { console.warn('[chat] get-pending-todos failed:', e?.message || e); return []; }
  });
  // 1.5.1: 全量 todos(含 completed) — 给 AI 栏常驻任务进度面板用
  ipcMain.handle('chat:get-todos', async (_e, sessionKey) => {
    try { const s = await _cs(sessionKey); return s ? await s.getTodos() : []; }
    catch (e) { console.warn('[chat] get-todos failed:', e?.message || e); return []; }
  });
  // 1.5.3: 任务面板手动增删改 —— 直接写回 Claude Code 自己的任务存储文件(见
  // chat-session.js addTodo/updateTodoStatus/editTodoContent/deleteTodo 的注释),
  // 让 AI 下次读 TaskList 时能看到用户的手动修改。
  ipcMain.handle('chat:todo-add', async (_e, sessionKey, content) => {
    try { const s = await _cs(sessionKey); return s ? await s.addTodo(content) : { ok: false, error: 'no_session' }; }
    catch (e) { console.warn('[chat] todo-add failed:', e?.message || e); return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('chat:todo-set-status', async (_e, sessionKey, id, status) => {
    try { const s = await _cs(sessionKey); return s ? await s.updateTodoStatus(id, status) : { ok: false, error: 'no_session' }; }
    catch (e) { console.warn('[chat] todo-set-status failed:', e?.message || e); return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('chat:todo-edit', async (_e, sessionKey, id, content) => {
    try { const s = await _cs(sessionKey); return s ? await s.editTodoContent(id, content) : { ok: false, error: 'no_session' }; }
    catch (e) { console.warn('[chat] todo-edit failed:', e?.message || e); return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('chat:todo-delete', async (_e, sessionKey, id) => {
    try { const s = await _cs(sessionKey); return s ? await s.deleteTodo(id) : { ok: false, error: 'no_session' }; }
    catch (e) { console.warn('[chat] todo-delete failed:', e?.message || e); return { ok: false, error: String(e?.message || e) }; }
  });

  // -- chat attachments
  ipcMain.handle('chat:new-draft', () => attachments.newDraftId());
  ipcMain.handle('chat:list-attachments', (_e, draftId) =>
    draftId ? attachments.listDraft(draftId) : []);
  // 给附件 chip 的 hover 预览用 — 读 absPath 文件返回 data URL，渲染端直接
  // 塞 <img src=...>。只支持 image kind；非图片返回 null 让前端不展示预览。
  // 5 MB 上限避免巨幅图卡住主进程读 IO。
  ipcMain.handle('chat:get-attachment-data-url', async (_e, draftId, name) => {
    try {
      if (!draftId || !name) return null;
      const list = attachments.listDraft(draftId);
      const it = list.find((a) => a.name === name);
      if (!it || it.kind !== 'image') return null;
      if (it.size > 5 * 1024 * 1024) return null;
      const buf = await require('node:fs/promises').readFile(it.absPath);
      const ext = path.extname(name).toLowerCase().slice(1) || 'png';
      const mime = ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif',
                       webp: 'webp', bmp: 'bmp' })[ext] || 'png';
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle('chat:attach-buffer', async (_e, draftId, filename, b64) => {
    try {
      const buf = Buffer.from(String(b64 || ''), 'base64');
      return await attachments.saveBuffer(draftId, filename, buf);
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });
  ipcMain.handle('chat:attach-paths', async (_e, draftId, paths) => {
    const out = [];
    for (const p of (paths || [])) {
      try { out.push(await attachments.copyFromPath(draftId, p)); }
      catch (e) { out.push({ name: path.basename(String(p)), error: String(e.message || e) }); }
    }
    return out;
  });
  ipcMain.handle('chat:attach-pick', async (_e, draftId) => {
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, {
      title: '附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片',  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: '文档',  extensions: ['md', 'txt', 'pdf', 'json', 'csv', 'log'] },
        { name: '策略',  extensions: ['mq5', 'mqh', 'set', 'ex5'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return [];
    const out = [];
    for (const p of r.filePaths) {
      try { out.push(await attachments.copyFromPath(draftId, p)); }
      catch (e) { out.push({ name: path.basename(p), error: String(e.message || e) }); }
    }
    return out;
  });
  ipcMain.handle('chat:remove-attachment', (_e, draftId, name) =>
    attachments.removeFromDraft(draftId, name));
  ipcMain.handle('chat:clear-draft', (_e, draftId) =>
    attachments.clearDraft(draftId));

  // -- server-backed (leaderboard / tutorials / news / market) with mock fallback
  ipcMain.handle('server:leaderboard', async (_e, q) => {
    // Map view-side labels (which historically were Chinese strings like
    // "总收益率") to the dimension/period strings the server enum expects.
    const RAW_DIM = q?.dimension || 'pnl_pct';
    const dimension = ({
      '总收益率': 'pnl_pct', 'pnl_pct': 'pnl_pct',
      'sharpe': 'sharpe', 'Sharpe': 'sharpe',
      '胜率': 'win_rate', 'win_rate': 'win_rate',
      '最大回撤': 'drawdown', 'drawdown': 'drawdown',
      '交易数': 'trades', 'trades': 'trades',
    })[RAW_DIM] || 'pnl_pct';
    const RAW_PERIOD = q?.period || 'all';
    const period = ({
      // New 日/周/月/全部 buckets
      '日':    'today', 'today':     'today',
      '周':    '7d',
      '月':    '30d',
      '全部': 'all',   'all':       'all',
      // Back-compat with old labels (in case anything still passes them)
      '近 90 天': '90d', '90d': '90d',
      '近 30 天': '30d', '30d': '30d',
      '近 7 天':  '7d',  '7d':  '7d',
      'yesterday': 'yesterday',
    })[RAW_PERIOD] || 'all';
    // 0.4.6: 把 token 透传给 server，开启 is_me 标记。token 拿不到（trial 前 /
    // 离线）就不传，server 优雅地不算 is_me。
    let url = `/v1/strategies/leaderboard?dimension=${dimension}&period=${period}&limit=50`;
    try {
      const tok = license._activeToken && license._activeToken();
      if (tok) url += `&token=${encodeURIComponent(tok)}`;
    } catch {}
    const r = await serverApi.get(url);
    if (!r.ok) {
      // Connect failure → mock fallback so the tab still renders
      return { offline: true, items: mock.LEADERBOARD[dimension] || mock.LEADERBOARD.pnl_pct };
    }
    // Server returned 200, possibly with empty items[] — that's the truth,
    // not "offline". UI shows empty state instead of mock.
    return { offline: false, items: r.items || [] };
  });
  ipcMain.handle('server:tutorials', async (_e, q) => {
    const params = new URLSearchParams();
    if (q?.platform)   params.set('platform', q.platform);
    if (q?.difficulty) params.set('difficulty', q.difficulty);
    const r = await serverApi.get('/v1/tutorials' + (params.toString() ? '?' + params.toString() : ''));
    if (!r.ok) {
      let items = mock.TUTORIALS;
      if (q?.platform)   items = items.filter((x) => x.platform === q.platform);
      if (q?.difficulty) items = items.filter((x) => x.difficulty === q.difficulty);
      return { offline: true, items };
    }
    return { offline: false, items: r.items || [] };
  });
  ipcMain.handle('server:news', async () => {
    const r = await serverApi.get('/v1/news');
    if (!r.ok) return { offline: true, items: mock.NEWS };
    return { offline: false, items: r.items || [] };
  });
  // 散户情绪(myfxbook 社区多空占比 → 服务端每 30min 抓)。资讯页「散户情绪」子栏用。
  ipcMain.handle('server:sentiment', async () => {
    try { return await serverApi.get('/v1/sentiment'); }
    catch (e) { return { ok: false, error: String(e?.message || e), symbols: [] }; }
  });
  // 经济日历(MT5 内 EasyDealCalendar EA 直传 → 服务端)。资讯页 + AI(MCP get_economic_calendar)用。
  ipcMain.handle('calendar:get', async () => {
    try { return await serverApi.get('/v1/calendar'); }
    catch (e) { return { ok: false, error: String(e?.message || e), events: [] }; }
  });
  // 1.2.42: 单条经济日历事件 AI 分析(跟 app 对齐)。服务端 /v1/calendar/analyze 认 X-License-Key。
  ipcMain.handle('calendar:analyze', async (_e, event = {}) => {
    try {
      let key = null;
      try { const s = license.getStatus(); key = s?.key || null; } catch {}   // getStatus 字段是 key 不是 license_key
      const headers = key ? { 'X-License-Key': key } : {};
      const r = await serverApi.post('/v1/calendar/analyze', event || {}, { headers, timeoutMs: 30000 });
      return r;
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 1.2.47: 金融快讯单条 AI 分析(跟经济日历同款, dual-auth 走 X-License-Key)。
  ipcMain.handle('news:analyze', async (_e, item = {}) => {
    try {
      let key = null;
      try { const s = license.getStatus(); key = s?.key || null; } catch {}
      const headers = key ? { 'X-License-Key': key } : {};
      const r = await serverApi.post('/v1/news/analyze', item || {}, { headers, timeoutMs: 30000 });
      return r;
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 0.3.14: 金十快讯（实时）— 区别于 server:news（社区公告）
  ipcMain.handle('news:flash-recent', async (_e, opts = {}) => {
    if (!newsProvider) return { items: [], status: { running: false } };
    const items = newsProvider.recent({
      minutesBack: Number(opts?.minutesBack) || 60 * 6,   // 默认 6 小时
      keywords:    Array.isArray(opts?.keywords) ? opts.keywords : null,
      importantOnly: !!opts?.importantOnly,
    });
    return { items, status: newsProvider.status() };
  });
  ipcMain.handle('news:flash-status', () =>
    newsProvider ? newsProvider.status() : { running: false });
  // 0.3.15: 「重要未读」count + mark-read。资讯 tab 顶部的红点 + 数字读
  // 这两个 endpoint。用户点开资讯 tab 时 renderer 主动调 markRead 清零。
  ipcMain.handle('news:unread-count', () => ({
    count: _newsUnreadCount,
    last_important_ts: _newsLastImportantTs,
  }));
  ipcMain.handle('news:mark-read', () => {
    _newsUnreadCount = 0;
    _pushNewsUnreadCount();
    return { count: 0 };
  });
  ipcMain.handle('server:market', async (_e, q) => {
    const params = new URLSearchParams();
    if (q?.sort) params.set('sort', q.sort);
    const r = await serverApi.get('/v1/market' + (params.toString() ? '?' + params.toString() : ''));
    if (!r.ok) {
      const items = mockMarketItems();
      return { offline: true, items: sortMarket(items, q?.sort) };
    }
    return { offline: false, items: r.items || [] };
  });
  ipcMain.handle('server:install-strategy', async (_e, item) => {
    // v0: not actually downloading a real .ex5 — just informs the user where
    // the file would go once the server is online.
    return {
      ok: false,
      offline: true,
      message: '服务端尚未上线。上线后此操作会自动下载 .ex5 到 MT5/Experts 目录。',
    };
  });

  // -- app
  ipcMain.handle('app:open-workspace', () => shell.openPath(workspaceDir));
  // 0.3.22: 在文件浏览器里定位（select）一个 workspace 下的相对路径文件 —
  // 用于「我的策略」回测行点「源码版本」chip 时跳转到对应快照。relPath
  // 必须在 workspace 下（防止任意路径写漏洞），不能 escape。
  ipcMain.handle('app:reveal-in-workspace', async (_e, relPath) => {
    if (!relPath) return { ok: false, error: 'relPath required' };
    const safe = String(relPath).replace(/\\/g, '/');
    const abs = path.resolve(workspaceDir, safe);
    const root = path.resolve(workspaceDir) + path.sep;
    if (!abs.startsWith(root)) return { ok: false, error: '路径越界' };
    if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在: ' + abs };
    try {
      shell.showItemInFolder(abs);    // Windows: 打开 Explorer 并选中
      return { ok: true, path: abs };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('app:info', () => {
    const s = settings.getResolved();
    return {
      workspace: workspaceDir,
      schedulerStatus: schedulerClient?.ready ? 'running' : 'down',
      schedulerScript: resolveBundledFile('python', 'scheduler_mcp.py'),
      apiBase: serverApi.baseUrl(),
      claudeBin: resolveClaudeBin(),
      easydealScript: s.easydealScript,
      pythonBin: s.pythonBin,
      windowCaptureScript: s.windowCaptureScript,
      mt5InstallDir: s.mt5.installDir,
      mt5DataDir: s.mt5.dataDir,
      version: app.getVersion(),
    };
  });
  ipcMain.handle('app:license-status', () => license.getStatus());

  // 用户主动「退出当前序列号」 —— 设置页授权信息卡片新增按钮触发。
  // 服务端 /v1/session/end 让 token 失效（释放 current_session_token，
  // 别的设备可以接着用同一 key 登录），本地 cached state 清掉 → 立刻
  // app.relaunch 让 license-gate 重弹。
  ipcMain.handle('app:license-logout', async (_e, opts = {}) => {
    try {
      // 0.4.42: opts.unbindMachine=true 时 license.logout 给 server
      // /v1/session/end 带 unbind=true, server 端额外清 bound_machine_id ——
      // license 可在新机器激活（替代了原来的 resetMachineId「重置本机 ID」
      // 选项, 那个语义太技术且常被用户搞混, 实际换电脑场景要的是 server 解绑）。
      const r = await license.logout({
        unbindMachine: !!(opts && opts.unbindMachine),
      });
      if (r?.ok) {
        setTimeout(() => {
          try { app.relaunch(); } catch {}
          try { app.exit(0); } catch {}
        }, 1500);
      }
      return r;
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 验证「允许 AI 直接平仓 / 改单」开关到底有没有生效——直接读
  // <workspace>/.mcp.json，看 mcpServers.easydeal.env 里有没有
  // EASYDEAL_TRADING_WRITE=1。给设置页那个「验证生效状态」按钮用。
  ipcMain.handle('app:check-mcp-trading-write', async () => {
    try {
      const dataDir = path.join(app.getPath('userData'), 'data');
      const wsDir = path.join(app.getPath('userData'), 'workspace');
      const mcpJsonPath = path.join(wsDir, '.mcp.json');
      let raw;
      try {
        raw = await require('node:fs/promises').readFile(mcpJsonPath, 'utf8');
      } catch (e) {
        return { error: `.mcp.json 不存在或读不到：${e.message}` };
      }
      let cfg;
      try { cfg = JSON.parse(raw); }
      catch (e) { return { error: `.mcp.json 解析失败：${e.message}` }; }
      const easydealCfg = cfg?.mcpServers?.easydeal;
      if (!easydealCfg) {
        return { easydealConfigured: false, envSet: false };
      }
      const env = easydealCfg.env || {};
      const v = env.EASYDEAL_TRADING_WRITE;
      const envSet = v === '1' || v === 'true' || v === 'yes' || v === 'on';
      return {
        easydealConfigured: true,
        envSet,
        envValue: v ?? null,
        // Helper for the user — show where to look manually if needed
        mcpJsonPath,
      };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

  // ---- WeChat sidecar IPC (iLink HTTP) ----
  // WeChat sidecar is LAZY: only `wechat:status` is non-spawning (it just
  // reports current state, used by topbar pulse every 60s — must NEVER
  // trigger a Python spawn). All other handlers ensureWechatSidecar() first;
  // if Python startup fails we surface a friendly error instead of the raw
  // "wechat sidecar not running" throw from sidecar internals.
  ipcMain.handle('wechat:status', () =>
    wechatSidecar ? wechatSidecar.getStatus() : {
      logged_in: false, mcp_alive: false, lazy: true,
    });
  // 0.3.262: 查 pending queue + 上次 user inbound 时间, 给 dormant chip 用.
  // 不 spawn sidecar (lazy-safe), 没 sidecar 就返 0/null.
  ipcMain.handle('wechat:pending-info', () => ({
    pending_count: wechatSidecar?.getPendingCount?.() || 0,
    last_inbound_at: wechatSidecar?.getLastInboundAt?.() || 0,
    logged_in: wechatSidecar?.status?.logged_in || false,
  }));
  // Build a friendly error that exposes the underlying sidecar.start failure
  // (Python not found, missing dep, script path wrong, etc.) instead of just
  // saying "启动失败" which is unactionable.
  function _wechatStartError(sc) {
    const used = settings.getResolved().pythonBin;
    const real = sc?.status?.error || '(no detail)';
    return `微信子进程启动失败：${real}\n（pythonBin = ${used || '<unset>'} ）`;
  }
  ipcMain.handle('wechat:refresh', async () => {
    // 用户主动「刷新」= 想知道现在状态 → 必要时启动 sidecar 顺便登录恢复
    const sc = await ensureWechatSidecar();
    if (!sc?.client?.ready) {
      return {
        logged_in: false, mcp_alive: false,
        error: _wechatStartError(sc),
      };
    }
    await sc.refreshStatus();
    return sc.getStatus();
  });
  ipcMain.handle('wechat:login-qr', async () => {
    const sc = await ensureWechatSidecar();
    if (!sc?.client?.ready) return {
      ok: false,
      error: _wechatStartError(sc),
    };
    try { return { ok: true, ...(await sc.loginQr()) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('wechat:login-poll', async (_e, { qrcodeToken, verifyCode } = {}) => {
    // login-poll always follows a successful login-qr, so sidecar is
    // already ready by the time we get here. Don't lazy-spawn (would be
    // pointless — without the qrcode_token from login-qr, poll fails anyway).
    if (!wechatSidecar?.client?.ready) {
      return { ok: false, error: '微信子进程未就绪 — 请重新「获取扫码二维码」' };
    }
    try { return { ok: true, ...(await wechatSidecar.loginPoll(qrcodeToken, verifyCode)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('wechat:logout', async () => {
    // Logout from a never-started sidecar = nothing to do = success.
    if (!wechatSidecar) return { ok: true, no_op: true };
    try { await wechatSidecar.loginClear(); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('wechat:send', async (_e, { to, text, contextToken } = {}) => {
    const sc = await ensureWechatSidecar();
    if (!sc?.client?.ready) return {
      ok: false,
      error: _wechatStartError(sc),
    };
    try {
      const r = await sc.sendMessage({ to, text, contextToken });
      return { ok: true, ...(r || {}) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 0.3.54: 跨所有 chat 拉聊天历史，给 AI 面板的悬浮「微信记录」抽屉用
  ipcMain.handle('wechat:history', async (_e, opts = {}) => {
    if (!wechatSidecar) return { ok: false, error: 'wechat sidecar 未启动' };
    try {
      const items = wechatSidecar.getAllRecentExchanges?.(opts) || [];
      return { ok: true, items, logged_in: !!wechatSidecar.status?.logged_in };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Internal background tickers — surfaced read-only in the 定时任务 view so
  // the user can see they're alive (last run, last status, etc).
  ipcMain.handle('app:system-tasks', async () => {
    const tasks = [];
    if (statsCollector) tasks.push({
      ...statsCollector.status(),
      task_id: 'sys_stats_collector',     // for history lookup via timers:history
    });
    if (orderguard) tasks.push({
      id: 'sys-orderguard',
      task_id: 'sys_orderguard',
      name: '订单护航',
      description: 'EA 下单前风控审批 + 订单生命周期跟踪 (port ' + orderguard.port + ')',
      running: orderguard.running,
      last_status: orderguard.running ? 'ok' : 'down',
      last_error: orderguard.running ? null : 'not running',
    });
    if (schedulerClient) {
      tasks.push({
        id: 'scheduler-poll',
        task_id: 'sys_scheduler_poll',
        name: '定时任务调度器',
        description: '每 ' + Math.round(SCHEDULER_TICK_MS / 1000) + 's 轮询用户自定义的 cron 任务，到点就触发',
        tick_ms: SCHEDULER_TICK_MS,
        // Prefer in-memory heartbeat (real measurements). Fall back to
        // sidecar-readiness when the loop hasn't ticked yet (first 5s).
        last_run_at:  schedulerPollStats.lastRunAt,
        last_status:  schedulerPollStats.lastStatus
                      || (schedulerClient.ready ? 'ok' : 'down'),
        last_error:   schedulerPollStats.lastError
                      || (schedulerClient.ready ? null : 'sidecar not ready'),
        last_duration_ms: schedulerPollStats.lastDurationMs,
        run_count:    schedulerPollStats.runCount || null,
      });
      // Other tickers also surfaced — they record into scheduler.db so we
      // CAN enrich with last status from get_task. But we ALWAYS surface
      // them in the system list whether or not they have a DB row yet —
      // otherwise users get "wait, where's the reconciler?" until it
      // happens to fire with a non-empty result for the first time.
      // Conditional-on-DB-row was the old behaviour and confused users.
      const reconcilerTask = await tryGetSystemTaskRow('sys_backtest_reconciler');
      tasks.push({
        ...(reconcilerTask || {
          id: 'sys-backtest-reconciler',
          task_id: 'sys_backtest_reconciler',
          name: '回测通知巡检',
          last_status: null,
          last_run_at: null,
          last_summary: null,
          last_error: null,
          last_duration_ms: null,
          run_count: null,
        }),
        description: '每 60 秒扫 backtests.json，补推之前漏掉的回测完成通知',
        tick_ms: 60_000,
      });
      const learnerTask = await tryGetSystemTaskRow('sys_preference_learner');
      tasks.push({
        ...(learnerTask || {
          id: 'sys-preference-learner',
          task_id: 'sys_preference_learner',
          name: '用户偏好学习',
          last_status: null,
          last_run_at: null,
          last_summary: null,
          last_error: null,
          last_duration_ms: null,
          run_count: null,
        }),
        description: '每小时检查；满足条件时（≥10 条新对话 + 距上次 ≥ 24h）学习偏好写到 CLAUDE.md',
        tick_ms: 60 * 60_000,
      });
      const healthTask = await tryGetSystemTaskRow('sys_health_check');
      tasks.push({
        ...(healthTask || {
          id: 'sys-health-check',
          task_id: 'sys_health_check',
          name: '正确使用检查',
          last_status: null,
          last_run_at: null,
          last_summary: null,
          last_error: null,
          last_duration_ms: null,
          run_count: null,
        }),
        description: '每天 1 次：检查 EA 是否齐 / 策略说明是否有 / 监控任务是否建。缺啥推 chat 系统通知',
        tick_ms: 24 * 60 * 60_000,
      });
      const resumeTask = await tryGetSystemTaskRow('sys_chat_resume');
      tasks.push({
        ...(resumeTask || {
          id: 'sys-chat-resume',
          task_id: 'sys_chat_resume',
          name: '中断恢复',
          last_status: null,
          last_run_at: null,
          last_summary: null,
          last_error: null,
          last_duration_ms: null,
          run_count: null,
        }),
        description: '每 1 分钟检查最近 assistant turn 是否被中断未恢复，是的话自动接续上次任务。每条中断只恢复一次。',
        tick_ms: 60_000,
      });
    }
    return tasks;
  });

  // -- OrderGuard IPC
  ipcMain.handle('orderguard:status', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getStatus();
  });
  ipcMain.handle('orderguard:stats', async (_e, ea, intent) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getStats(ea, intent);
  });
  ipcMain.handle('orderguard:health', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.healthCheck();
  });
  // 0.3.64：P0a/P0b 护航专栏 + 我的策略按钮所需 IPC
  ipcMain.handle('orderguard:positions', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getPositions();
  });
  ipcMain.handle('orderguard:decisions', async (_e, opts) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getDecisions(opts || {});
  });
  ipcMain.handle('orderguard:enabled-eas', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getEnabledEas();
  });
  ipcMain.handle('orderguard:overview-stats', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getOverviewStats();
  });
  // 0.3.141: 强制 tracker 立即 poll —— UI「⟳ 刷新」按钮调，让用户点了真拿新数据
  ipcMain.handle('orderguard:force-poll', async () => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.forcePoll();
  });
  // 0.3.141: 已平仓订单明细 — UI「累计盈亏」组成展示
  ipcMain.handle('orderguard:closed-orders', async (_e, limit) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getClosedOrders(limit || 50);
  });
  // 0.3.141: 一键重置 EA anchor —— 清零统计（仅影响 OrderGuard 那边，不 sync
  // 到 stats-collector，用户明确「我就是要保持原来的两边不同步」）
  ipcMain.handle('orderguard:reset-anchor', async (_e, eaName) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    if (!eaName) return { ok: false, error: 'ea_name required' };
    return await orderguard.resetAnchor(eaName);
  });
  // 1.0.8: 护航视图「平仓拦截」/「拦 SL 外扩」per-EA 开关 — 直写 fast_rules 单条规则。
  ipcMain.handle('orderguard:set-guard-rule', async (_e, eaName, key, value) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    if (!eaName || !key) return { ok: false, error: 'ea_name / key required' };
    return await orderguard.setGuardRule(eaName, key, value);
  });
  // 启用 / 暂停某 EA 护航 — 我的策略「🛡 护航」按钮调
  ipcMain.handle('orderguard:enable-ea', async (_e, eaName, magic, mode, thresholds) => {
    // 0.3.238: 加详细错误链路 — 用户反馈「加护航没成功」无具体错误信息无法定位.
    // 每个 fail 点带 stage 标识 + diagnostic 字段, UI alert 显完整信息.
    try {
      if (!orderguard) return { ok: false, stage: 'preflight', error: 'OrderGuard pool not running (启动期未完成 / startAll 失败)' };
      if (!eaName) return { ok: false, stage: 'preflight', error: 'ea_name required' };
      if (magic == null) return { ok: false, stage: 'preflight', error: 'magic required (用 MT5 runtime.json / chart inputs / heuristic 找到该 EA 的 magic)' };
      // 解析 EA 绑哪个 instance — multi-MT5 后必须走对应 OG 子进程
      const resolution = await resolveMt5ForEa(eaName).catch((e) => null);
      const diag = {
        ea_name: eaName,
        magic,
        mode: mode || 'observe',
        bound_instance_id: resolution?.instance_id || null,
        bound_install_dir: resolution?.installDir || null,
        bound_source: resolution?.source || 'unknown',
        pool_size: ogPool?.size?.() || 0,
        pool_instances: ogPool?.listAll?.()?.map(({ instance_id, name, og }) => ({
          instance_id, name, running: og.running, port: og.port,
        })) || [],
      };
      // 0.3.151 step 2: 启用时若 records 里有 thresholds 就一起传给 OG (per-EA 警报阈值)
      let effThresholds = thresholds || null;
      if (!effThresholds && strategies) {
        const t = strategies.getOrderguardThresholds(eaName);
        if (t) effThresholds = t;
      }
      const r = await orderguard.enableEa(eaName, magic, mode || 'observe', effThresholds);
      if (!r?.ok) {
        return {
          ok: false,
          stage: 'og_http',
          error: r?.error || 'OG /enable returned !ok',
          diag,
          og_response: r,
        };
      }
      // 0.3.238: enable 成功 broadcast state-changed → strategies-view 立即刷出
      // 「🛡 监控中 / 🛡 拦截中」chip, 不等 5s pollTimer.
      if (win && !win.isDestroyed()) {
        win.webContents.send('orderguard:state-changed', {
          ea_name: eaName, enabled: true, mode: mode || 'observe', magic,
        });
      }
      return { ok: true, ...r, diag };
    } catch (e) {
      return {
        ok: false,
        stage: 'exception',
        error: String(e?.message || e),
        stack: String(e?.stack || '').slice(0, 800),
      };
    }
  });
  ipcMain.handle('orderguard:disable-ea', async (_e, eaName) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    if (!eaName) return { ok: false, error: 'ea_name required' };
    const r = await orderguard.disableEa(eaName);
    // 0.3.238: disable 成功 broadcast — 让 chip 立即从「🛡 监控中」变回「🛡 护航」
    if (r?.ok && win && !win.isDestroyed()) {
      win.webContents.send('orderguard:state-changed', {
        ea_name: eaName, enabled: false,
      });
    }
    return r;
  });

  // 0.3.86: 「🛡 护航」对话框启用时自动推断 EA magic（无 magic 时启发式从 deals 推），
  // 用户不用手输。三层优先级：(1) runtime.json (2) deals 启发式 (3) 已 enabled 状态。
  ipcMain.handle('orderguard:infer-magic', async (_e, eaName) => {
    if (!eaName) return { ok: false, error: 'ea_name required' };
    if (!statsCollector) return { ok: false, error: 'stats-collector not ready' };
    try {
      // 1) runtime.json magic map（_readMagicMap 解析 strategies/*_runtime.json）
      const magicMap = await statsCollector._readMagicMap();
      // 反查 magic by ea_name
      let magic = null;
      let source = null;
      for (const [m, ea] of Object.entries(magicMap)) {
        if (ea === eaName) {
          magic = Number(m);
          source = 'runtime.json';
          break;
        }
      }
      // 2) 启发式：拉最近 deals 推断（cover EA 没写 runtime.json 协议的 case）
      if (magic == null) {
        try {
          const snap = await statsCollector.snapshot();
          const augmented = { ...magicMap };
          await statsCollector._augmentMagicMapByHeuristic(augmented, snap?.deals || []);
          for (const [m, ea] of Object.entries(augmented)) {
            if (ea === eaName) {
              magic = Number(m);
              source = 'heuristic (recent deals)';
              break;
            }
          }
        } catch (e) {
          // snapshot 失败不阻塞 — 返回 null 让 UI 让用户手输
        }
      }
      // 3) 已 enabled 状态里有 — 复用之前用户输入过的
      if (magic == null && orderguard) {
        try {
          const r = await orderguard.getEnabledEas();
          const en = (r?.data?.eas || []).find((e) => e.ea_name === eaName);
          if (en?.magic) {
            magic = Number(en.magic);
            source = 'previously enabled';
          }
        } catch {}
      }
      return { ok: true, magic, source };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 0.3.66 P1-A: 拦截模式 deploy — 把 mqh + token + rules + port file 拷到 MT5 数据目录
  ipcMain.handle('orderguard:deploy-intercept', async (_e, eaName) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    if (!eaName) return { ok: false, error: 'ea_name required' };
    const s = settings.getResolved();
    const mt5DataDir = s.mt5?.dataDir || '';
    if (!mt5DataDir) return { ok: false, error: 'MT5 数据目录未配置 — 请先在「设置」里指定 MT5' };
    return await orderguard.deployIntercept(eaName, mt5DataDir);
  });

  // 0.3.151: 护航阈值 AI 分析 — 用户启用护航 / 打开监控配置时调一次,
  // 喂 EA 源码 (.mq5) 给 claude --print, AI 按策略类型给出 5 个阈值建议:
  //   single_loss_usd / single_loss_pct / max_holding_hours /
  //   max_account_loss_pct / max_locked_positions
  // 失败 fallback 全局默认值 (不阻塞流程), 用户可手动改.
  ipcMain.handle('orderguard:suggest-thresholds', async (_e, eaName) => {
    if (!eaName) return { ok: false, error: 'ea_name required' };
    if (!strategies) return { ok: false, error: 'strategies not ready' };

    const DEFAULT_THRESHOLDS = {
      single_loss_usd: -100,
      single_loss_pct: -5.0,
      max_holding_hours: 24,
      max_account_loss_pct: -8.0,
      max_locked_positions: 4,
      strategy_type: '未分析',
      reason: '(AI 分析失败 — 使用全局默认值, 请按 EA 实际风格手动调整)',
    };

    const clipNum = (v, min, max, defv) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return defv;
      return Math.max(min, Math.min(max, n));
    };

    // 1. 读 EA 源码 (.mq5)
    let sourceCode = '';
    try {
      // strategies.dir 是 workspace/strategies/ 工作区副本
      const srcPath = path.join(strategies.dir, `${eaName}.mq5`);
      if (fs.existsSync(srcPath)) {
        sourceCode = await fs.promises.readFile(srcPath, 'utf-8');
      }
    } catch (e) { /* ignore */ }
    if (!sourceCode) {
      return {
        ok: true,
        thresholds: DEFAULT_THRESHOLDS,
        source: 'default',
        fallback_reason: 'EA .mq5 源码未找到 (workspace/strategies/), 使用默认阈值',
      };
    }

    // 2. 构 prompt
    const prompt = [
      `分析以下 EA 源码 (MQL5), 按 JSON schema 返回护航阈值建议. 只返 JSON, 不要其他文字.`,
      ``,
      `EA 名称: ${eaName}`,
      `源码:`,
      `\`\`\`mq5`,
      sourceCode,
      `\`\`\``,
      ``,
      `返 JSON (用 \`\`\`json 包裹):`,
      `{`,
      `  "strategy_type": "网格马丁 / 单边趋势 / 区间震荡 / 套利 / 其他",`,
      `  "single_loss_usd": -150,           // 单笔订单浮亏 USD 阈值, 负数, 触发即报警`,
      `  "single_loss_pct": -3.0,           // 单笔订单浮亏 % (占账户余额), 负数`,
      `  "max_holding_hours": 24,           // 单笔订单最长持仓时长 (小时)`,
      `  "max_account_loss_pct": -8.0,      // 整体账户浮亏 % 阈值, 负数`,
      `  "max_locked_positions": 4,         // 锁仓 (多空对锁) 上限`,
      `  "reason": "策略类型 + 关键代码线索 + 阈值依据 (50-150 字)"`,
      `}`,
      ``,
      `规则:`,
      `- 网格马丁类策略容忍度高: single_loss_usd -200~-500, holding_hours 48+, max_account_loss -15~-25%`,
      `- 单边趋势 / 突破策略低容忍: single_loss_usd -50~-150, holding_hours 4-12h, max_account_loss -5~-10%`,
      `- 区间震荡介于两者之间`,
      `- 不确定时倾向保守值 (让用户后续手动放宽更安全)`,
    ].join('\n');

    // 3. spawn claude --print
    let stdout = '';
    try {
      stdout = await spawnHeadlessClaude({
        prompt,
        cwd: workspaceDir,
        timeoutMs: 90_000,  // AI 分析 EA 源码可能慢, 给 90s
      });
    } catch (e) {
      return {
        ok: true,
        thresholds: DEFAULT_THRESHOLDS,
        source: 'default',
        fallback_reason: `AI 调用失败: ${(e?.message || e).toString().slice(0, 150)}`,
      };
    }

    // 4. 解析 JSON (兼容 ```json ... ``` markdown 包裹)
    let json = null;
    try {
      const m = String(stdout).match(/```(?:json)?\s*([\s\S]+?)\s*```/);
      const jsonStr = m ? m[1] : String(stdout).trim();
      json = JSON.parse(jsonStr);
    } catch (parseErr) {
      return {
        ok: true,
        thresholds: DEFAULT_THRESHOLDS,
        source: 'default',
        fallback_reason: `AI 返回解析失败: ${parseErr.message.slice(0, 100)}`,
        raw: String(stdout).slice(0, 500),
      };
    }

    // 5. clip 到合理范围 + 字段验证
    const t = {
      single_loss_usd:      clipNum(json.single_loss_usd,      -2000, 0,   -100),
      single_loss_pct:      clipNum(json.single_loss_pct,      -50,   0,   -5),
      max_holding_hours:    clipNum(json.max_holding_hours,    1,     720, 24),
      max_account_loss_pct: clipNum(json.max_account_loss_pct, -50,   0,   -8),
      max_locked_positions: clipNum(json.max_locked_positions, 0,     100, 4),
      strategy_type: String(json.strategy_type || '其他').slice(0, 50),
      reason:        String(json.reason || '').slice(0, 500),
    };
    return { ok: true, thresholds: t, source: 'ai' };
  });

  // 0.3.74 P3 学习中心 IPC
  ipcMain.handle('orderguard:rule-suggestions', async (_e, opts) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.getRuleSuggestions(opts || {});
  });
  ipcMain.handle('orderguard:apply-rule-suggestion', async (_e, id) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.applyRuleSuggestion(id);
  });
  ipcMain.handle('orderguard:dismiss-rule-suggestion', async (_e, id) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.dismissRuleSuggestion(id);
  });
  ipcMain.handle('orderguard:rollback-rule-suggestion', async (_e, id) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.rollbackRuleSuggestion(id);
  });
  ipcMain.handle('orderguard:scan-rule-suggestions-now', async (_e, eaName) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.scanRuleSuggestionsNow(eaName);
  });
  ipcMain.handle('orderguard:ai-accuracy', async (_e, eaName) => {
    if (!orderguard) return { ok: false, error: 'OrderGuard not running' };
    return await orderguard.aiAccuracy(eaName);
  });

  // 「检查 MT5 连接」按钮 — 用户在 MT5 卡片点击触发。spawn 一次 mt5_probe.py
  // 跑实测，告诉用户 SDK 实际能不能绑到 user_set 那个 MT5，多 MT5 场景下
  // SDK 路径绑定的可靠性主动验证。
  ipcMain.handle('app:probe-mt5', async () => {
    try {
      const probeScript = resolveBundledFile('python', 'mt5_probe.py');
      if (!fs.existsSync(probeScript)) {
        return { ok: false, error: 'mt5_probe.py 不存在（请确认升到 0.1.36+）' };
      }
      const s = settings.getResolved();
      const activeMt5 = settings.getActiveMt5Instance?.();
      const result = await new Promise((resolve) => {
        const cp = require('node:child_process');
        const child = cp.spawn(s.pythonBin || 'python', [probeScript], {
          env: {
            ...process.env,
            ...(s.mt5?.installDir ? { EASYDEAL_MT5_INSTALL_DIR: s.mt5.installDir } : {}),
            ...(s.mt5?.dataDir ? { EASYDEAL_MT5_DATA_DIR: s.mt5.dataDir } : {}),
            ...(activeMt5?.launchMode ? { EASYDEAL_MT5_LAUNCH_MODE: activeMt5.launchMode } : {}),
            ...(activeMt5?.id ? { EASYDEAL_MT5_INSTANCE_ID: activeMt5.id } : {}),
            EASYDEAL_MT5_ALLOW_LAUNCH: '0',
            EASYDEAL_DATA_DIR: path.join(app.getPath('userData'), 'data'),
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000);
        child.on('close', () => {
          clearTimeout(t);
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ ok: false, parse_err: 'invalid json', stdout: stdout.slice(0, 500) }); }
        });
        child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, spawn_err: e.message }); });
      });
      // 把这次结果记到 settings，UI 下次进来还能看上次的结果
      try {
        await settings.set({
          mt5_last_probe: {
            at: Date.now(),
            ok: !!result.ok,
            requested_path: result.requested_path || null,
            actual_path: result.terminal?.path || null,
            broker: result.terminal?.company || null,
            account_login: result.account?.login || null,
            account_server: result.account?.server || null,
            symbols_total: result.symbols_total || 0,
            error: result.init_error || result.spawn_err || result.parse_err || null,
            bind_attempts: (result.bind_attempts || []).length,
          },
        });
      } catch {}
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 给「上传诊断快照」模态预检用 — 没开 MT5 就上报会捕捉错误时刻的快照，
  // 这里返回当前进程能看到的 MT5 状态 + 自身权限，让 UI 提示用户先把 MT5
  // 开起来 / 用相同权限重启 EasyDeal。
  ipcMain.handle('app:diag-preflight', async () => {
    try {
      // 强制刷新检测 — 用户「报错才点上传」的瞬间想要拿到最新 MT5 状态，
      // 不能用缓存。
      await settings.refreshDetection();
      const det = settings.detected || {};
      const running = det.runningMt5Processes || [];
      const isAdmin = await _isElevatedProcess().catch(() => null);
      // EA 挂载信号 —— 进程检测路径有时被杀软拦 / 权限拦 / 路径名古怪
      // 等情况会拿不到 MT5 进程句柄，但 EA 挂在图表上每秒都在写
      // <dataDir>/MQL5/Logs/<today>.log，mount 检测能从日志里看出
      // EA 在跑 → MT5 不可能没在跑。这条信号能盖过 process 检测的假阴。
      let mountedCount = 0;
      try {
        if (strategies) {
          const m = (await settings.ensureDetected()).mt5;
          const list = await strategies.list({
            mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
          });
          mountedCount = list.filter((it) => it.is_mounted).length;
        }
      } catch {}
      return {
        ok: true,
        mt5_running_count: running.length,
        mounted_ea_count: mountedCount,
        is_admin: isAdmin,
        platform: process.platform,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 「上传诊断快照」按钮 — 用户报问题时让他点一下，服务端 admin 立刻看到
  // 当前客户端运行时状态（MT5 检测路径、EA 列表、token 模式等）。
  // userReport 形如 { text, screenshots: [{name, mime, size, data_base64}] }
  ipcMain.handle('app:upload-diagnostic', async (_e, userReport) => {
    try {
      const marketplace = require('./marketplace');
      const payload = await collectDiagnosticSnapshot();
      if (userReport && typeof userReport === 'object') {
        // 防御：截图字段太大会撑爆 sqlite TEXT 字段，client 这边先做 size 上限
        // 单张图 ≤ 2 MB，总和 ≤ 8 MB（base64 体积 ≈ 原始 × 1.33）。
        const shots = Array.isArray(userReport.screenshots) ? userReport.screenshots : [];
        const filtered = [];
        let total = 0;
        for (const s of shots) {
          if (typeof s?.data_base64 !== 'string') continue;
          if (s.data_base64.length > 2 * 1024 * 1024 * 1.4) continue;
          if (total + s.data_base64.length > 8 * 1024 * 1024 * 1.4) break;
          total += s.data_base64.length;
          filtered.push({
            name: String(s.name || 'screenshot.png').slice(0, 64),
            mime: String(s.mime || 'image/png').slice(0, 32),
            size: Number(s.size) || 0,
            data_base64: s.data_base64,
          });
        }
        payload.user_report = {
          text: String(userReport.text || '').slice(0, 4000),
          screenshots: filtered,
        };
      }
      const r = await marketplace.uploadDiagnostic(payload);
      return { ok: !!r?.ok, error: r?.error || null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // Check for app updates against the easydeal-server release manifest.
  // Returns { ok, current, latest|null, has_update, mandatory, release_notes, download_url }.
  ipcMain.handle('app:check-update', async () => {
    const current = app.getVersion();
    try {
      const params = new URLSearchParams({ from: current, channel: 'alpha' });
      // 0.3.245 / server 0.5.9: 加 license_key 让服务端判断定向推送是否对该用户可见.
      // 服务端 release.targeted_licenses 非空 + 本机 license 不在列表 → 跳过该 release
      // 看下一条 (= 该用户看不到内测版). 老服务端不识别此参数, 直接忽略, 不破坏兼容.
      try {
        const lic = license?.getStatus?.();
        if (lic?.key) params.append('license_key', lic.key);
      } catch {}
      const r = await serverApi.get('/v1/release/latest?' + params.toString());
      // Server protocol: 404 with detail "no_update" means client is at or
      // ahead of latest published version → "已是最新"，NOT an error. 同理
      // 204 = "no release in channel at all". 之前这些被当 error 显示了
      // "Not Found"，对用户太吓人。
      if (!r.ok && (r.status === 404 || r.status === 204)) {
        return { ok: true, current, latest: null, has_update: false };
      }
      if (!r.ok) {
        return { ok: false, current, error: r.error || '获取失败', status: r.status };
      }
      const latest = r.version || r.latest_version || null;
      const has_update = !!latest && latest !== current;
      return {
        ok: true, current, latest,
        has_update,
        mandatory:     !!r.mandatory,
        release_notes: r.release_notes || '',
        download_url:  r.download_url || null,
        portable_url:  r.portable_url || null,
        sha256:        r.sha256 || null,
      };
    } catch (e) {
      return { ok: false, current, error: String(e?.message || e) };
    }
  });

  // 0.4.6: 拉某版本（默认当前安装版本）的 release_notes —— 设置页「升级日志」按钮调
  ipcMain.handle('app:get-release-notes', async (_e, version = null) => {
    const v = version || app.getVersion();
    try {
      const params = new URLSearchParams({ channel: 'alpha' });
      const r = await serverApi.get(`/v1/release/${encodeURIComponent(v)}?${params.toString()}`);
      if (!r.ok && r.status === 404) {
        return { ok: false, version: v, error: 'no_release_notes',
                 message: `服务器没注册过 v${v} 的发版信息（可能是测试 build 或已下架）` };
      }
      if (!r.ok) {
        return { ok: false, version: v, error: r.error || '获取失败', status: r.status };
      }
      return {
        ok: true, version: v,
        release_notes: r.release_notes || '',
        mandatory: !!r.mandatory,
        published_at: r.published_at || null,
      };
    } catch (e) {
      return { ok: false, version: v, error: String(e?.message || e) };
    }
  });

  // ---- Update download / install flow (port from hpjy) ----
  // Renderer calls these in sequence:
  //   1. app:check-update        → see what version is latest
  //   2. app:update-download     → stream OSS .exe to <userData>/updates/,
  //                                 verify sha256, emit progress events on
  //                                 channel 'app:update-progress'
  //   3. app:update-install      → spawn the local .exe and quit the app so
  //                                 NSIS can replace files
  ipcMain.handle('app:update-download', async (_e, latest) => {
    if (!latest || !latest.download_url) {
      return { ok: false, error: 'no_download_url' };
    }
    try {
      const localPath = await updater.downloadInstaller(latest, (p) => {
        // Stream progress to renderer; updater-ui.js listens on this channel.
        try { win?.webContents.send('app:update-progress', p); } catch {}
      });
      return { ok: true, localPath };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('app:update-install', async (_e, localPath) => {
    if (!localPath) return { ok: false, error: 'no_local_path' };
    try {
      // stopHook：把 sidecar / 长连接全部 await 关掉，再让 NSIS 跑
      // customInit + taskkill /F 兜底（双重保险）。无 stopHook 的话 quit
      // 太快，python sidecar 可能还在写 SQLite 就被强杀，留 -journal 文件。
      await updater.launchAndQuit(localPath, {
        stopHook: async () => {
          isQuitting = true;
          try { if (schedulerTimer) clearInterval(schedulerTimer); } catch {}
          // 0.3.250: 补上 orderguard / ogPool / chat — 之前漏的, 这些都 spawn python.exe
          // 子进程, 不显式 stop 会变孤儿锁 install dir 文件 (用户 case).
          await Promise.allSettled([
            schedulerClient ? schedulerClient.stop() : null,
            statsCollector ? statsCollector.stop() : null,
            wechatSidecar ? wechatSidecar.stop() : null,
            orderguard ? orderguard.stop() : null,
            (ogPool && !orderguard) ? ogPool.stopAll() : null,
            chat?.stop ? chat.stop() : null,
          ].filter(Boolean));
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  // 0.3.196: electron-updater 差分下载 IPCs.
  //   1. status      → renderer 查当前 autoUpdater 状态 + 是否可用 (本地有没 app-update.yml)
  //   2. check       → 拉 latest.yml 比版本号. 触发 'available' / 'not-available' 事件
  //   3. download    → 启 blockmap 差分下载. 进度通过 'progress' 事件推
  //   4. install     → quitAndInstall(silent, forceRunAfter): 静默装 + 自动重启新版
  ipcMain.handle('app:autoupdater-status', async () => {
    return {
      ok: true,
      available: autoUpdater.isAvailable(),
      state: autoUpdater.getState(),
      current: app.getVersion(),
    };
  });
  ipcMain.handle('app:autoupdater-check', async () => {
    if (!autoUpdater.isAvailable()) return { ok: false, error: 'autoUpdater 在 dev / 未配 publish 的 build 上不可用, 回退到完整下载路径' };
    try {
      const r = await autoUpdater.checkForUpdate();
      return { ok: true, info: r?.updateInfo || null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('app:autoupdater-download', async () => {
    if (!autoUpdater.isAvailable()) return { ok: false, error: 'autoUpdater 不可用' };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('app:autoupdater-install', async (_e, opts = {}) => {
    if (!autoUpdater.isAvailable()) return { ok: false, error: 'autoUpdater 不可用' };
    try {
      // 走 stopHook 把 sidecar / OG pool 优雅停掉 (NSIS customInit 兜底 taskkill)
      isQuitting = true;
      try { if (schedulerTimer) clearInterval(schedulerTimer); } catch {}
      await Promise.allSettled([
        chat?.stop?.(),
        schedulerClient?.stop?.(),
        statsCollector?.stop?.(),
        wechatSidecar?.stop?.(),
        orderguard?.stop?.(),
      ].filter(Boolean));

      // 0.3.303: 装完后用 detached cmd 启动新版 EasyDeal.exe (装完启动三层 fallback
      // 之一; 另两层是 NSIS .onInstSuccess Exec + electron-updater forceRunAfter).
      // 0.4.14: 改 fixed 12s sleep 为 **mtime polling** — wizard 模式装可能 1-3 分钟
      // (用户点「下一步」/「安装」/「完成」), fixed 12s 远不够, cmd 跑时新文件还
      // 没写下来 → 启动老版 .exe (要么文件还没改 → 启动老版无意义, 要么文件被
      // installer 半改 → 启动 crash). polling 等 EasyDeal.exe mtime 比 launcher
      // 启动时间新 (= installer 已经替换该文件), 才 start, 最长 5 分钟兜底.
      try {
        const cp = require('node:child_process');
        const targetExe = path.join(
          process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
          'Programs', 'EasyDeal', 'EasyDeal.exe'
        );
        const launchBat = path.join(
          app.getPath('temp'),
          `easydeal-relaunch-${Date.now()}.bat`
        );
        // PowerShell polling: 每 3s check 一次 EasyDeal.exe mtime, 超过 launcher
        // 启动 time → installer 已替换 → start it. 最长 300s (5 分钟) 兜底.
        // 用 PowerShell 写在 bat 里因为 cmd 自己拿 mtime 比 PowerShell 麻烦得多.
        const psLauncher = [
          `$target = '${targetExe.replace(/'/g, "''")}'`,
          `$startTime = Get-Date`,
          `for ($i = 0; $i -lt 100; $i++) {`,    // 100 × 3s = 300s
          `  Start-Sleep -Seconds 3`,
          `  if (Test-Path $target) {`,
          `    $mtime = (Get-Item $target).LastWriteTime`,
          `    if ($mtime -gt $startTime) {`,    // 文件被替换为新版
          `      Start-Process -FilePath $target`,
          `      exit 0`,
          `    }`,
          `  }`,
          `}`,
          // 5 分钟没等到 → 不管它是不是新版都启动 (兜底)
          `if (Test-Path $target) { Start-Process -FilePath $target }`,
        ].join('; ');
        const batContent = [
          '@echo off',
          // 留 8s 给 EasyDeal main 退干净 + installer 起 wizard
          'timeout /t 8 /nobreak >nul',
          // 然后 PowerShell polling
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psLauncher.replace(/"/g, '\\"')}"`,
          'exit',
          '',
        ].join('\r\n');
        require('node:fs').writeFileSync(launchBat, batContent, 'utf-8');
        cp.spawn('cmd.exe', ['/c', launchBat], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
        console.log(`[autoupdater-install] queued mtime-polling relaunch (max 5min) via ${launchBat} → ${targetExe}`);
      } catch (e) {
        console.warn('[autoupdater-install] queue relaunch failed:', e?.message || e);
      }

      // 0.3.286: BUG 修 — electron-updater API quitAndInstall(isSilent, isForceRunAfter)
      // 是 positional args. 改用 auto-updater 模块包的 quitAndInstall (positional).
      // 0.4.2: 默认改 silent=false (NSIS oneClick 也改 false) 跑 wizard 模式.
      // 0.4.14: 修 auto-updater.js wrapper API mismatch — 老 signature `(opts={})`
      // 跟这里 positional call 不匹配, false 当 object 收 → opts.silent=undefined
      // → opts.silent!==false=true → 一直 silent=true! 0.4.2 wizard 模式 9 个版本
      // 都没真生效, 用户 (用户) 看到「点重启升级 EasyDeal 退了但 NSIS 向导也没启动」
      // 就是 NSIS /S silent 跑了用户看不到, 装失败时也没对话框报错. 0.4.14 wrapper
      // 改 positional signature (silent, forceRunAfter), 跟 electron-updater 原 API
      // 一致, main.js 这条 call 不变 → 0.4.2 wizard 模式真生效.
      autoUpdater.quitAndInstall(
        !!opts.silent,                      // 默认 false (wizard), 显式传 true 才 silent
        opts.forceRunAfter !== false,
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // shell.openExternal — used by 「在浏览器下载」fallback button.
  ipcMain.handle('app:open-external', async (_e, url) => {
    if (!url || !/^https?:\/\//.test(String(url))) {
      return { ok: false, error: 'bad_url' };
    }
    try { await shell.openExternal(String(url)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // -- marketplace
  ipcMain.handle('mkt:list',         (_e, q) => marketplace.listListings(q || {}));
  ipcMain.handle('mkt:my-listings',  ()      => marketplace.listMyListings());
  // 0.3.118: 拉 server-side 算的 strategy stats（per-ea_name），让「我的策略」UI 用
  // 跟 leaderboard 同款口径（SUM(pnl)/MIN(balance), all-time）覆盖本地 records.pnl_pct。
  // 0.3.224 / server 0.5.49: build per-EA expected account_login map 传给 server, 让
  // server compute_metric 按 EA 当前 binding 走的 account 算 metric (而不是反推历史
  // deals 落地 account). 多 MT5 切 binding 后 UI 数字立即跟新 instance 一致.
  // 0.4.34: ea_name → account.login 映射 (跟 mkt:my-stats 内联逻辑同款). restore-stats
  // 复用 — 拉服务端权威 metric 时告诉 server 每只 EA 在哪个账户, 否则 server 反推可能错。
  function _buildEaAccountsMapForRestore() {
    const eaAccounts = {};
    try {
      const instances = settings.listMt5Instances?.() || [];
      const activeId = settings.getResolved()?.activeMt5InstanceId
        || settings.data?.activeMt5InstanceId || null;
      const instAccMap = new Map();
      for (const inst of instances) {
        const cached = _accountInfoCache?.get?.(inst.id);
        const live = cached?.data?.login || cached?.data?.account?.login;
        const login = Number(live || inst.cached_account_login || 0);
        if (login) instAccMap.set(inst.id, login);
      }
      const defaultLogin = activeId ? (instAccMap.get(activeId) || 0) : 0;
      for (const rec of Object.values(strategies?.records || {})) {
        if (!rec || !rec.ea_name) continue;
        if (rec.mt5_instance_id) eaAccounts[rec.ea_name] = instAccMap.get(rec.mt5_instance_id) || 0;
        else if (defaultLogin) eaAccounts[rec.ea_name] = defaultLogin;
      }
    } catch (e) {
      console.warn('[restore-stats] build ea_accounts failed:', e?.message || e);
    }
    return eaAccounts;
  }
  // 0.4.34: 从服务端权威 metric (跟排行榜同源) 恢复本地被误重置/清零的统计。
  ipcMain.handle('strategies:restore-stats', async (_e, eaName) => {
    if (!strategies) return { ok: false, error: 'strategies not ready' };
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'eaName required' };
    try {
      const eaAccounts = _buildEaAccountsMapForRestore();
      const stats = await marketplace.myStats({ eaAccounts }).catch(() => ({ items: [] }));
      const items = stats?.items || [];
      // 同名多 hash → 取 metric_pnl_usd 最大的 (跟 strategies-view serverStatsByEa 同口径)
      let best = null;
      for (const s of items) {
        const n = String(s.ea_name || '').replace(/\.(mq5|ex5)$/i, '').trim();
        if (n !== stem) continue;
        const v = Number(s.metric_pnl_usd ?? s.pnl_usd) || 0;
        if (!best || v > (Number(best.metric_pnl_usd ?? best.pnl_usd) || 0)) best = s;
      }
      if (!best) return { ok: false, error: '服务端没有这只 EA 的统计（可能还没上报 / 没参与排行榜）' };
      const m = {
        pnl_pct:          best.metric_pnl_pct ?? best.pnl_pct ?? null,
        pnl_usd:          best.metric_pnl_usd ?? best.pnl_usd ?? null,
        trades:           best.metric_trades_total ?? best.total_trades ?? null,
        max_drawdown:     best.metric_drawdown ?? best.max_dd ?? null,
        hours_run:        best.metric_broker_hours_run ?? best.total_hours ?? null,
        invested_capital: best.metric_invested_capital ?? best.initial_balance ?? null,
        anchor_ts:        best.metric_anchor_ts ?? null,
      };
      if (m.pnl_pct == null && m.pnl_usd == null) {
        return { ok: false, error: '服务端这只 EA 的 metric 也是空的，无法恢复' };
      }
      const r = await strategies.restoreStatsFromServer(stem, m);
      return { ...r, server_metric: m };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('mkt:my-stats',     async () => {
    try {
      // 拿每只绑了 instance 的 EA 的 account.login
      // 数据源: ① _accountInfoCache (最新, 实时); ② settings.mt5Instances[id].cached_account_login
      // (持久化, 0.3.225 起 account-info 成功时落地). cache miss 时仍传 sentinel
      // 让 server 清零, 不退到反推老历史 (用户期望切 binding 立即清零).
      const eaAccounts = {};
      const instances = settings.listMt5Instances?.() || [];
      const activeId = settings.getResolved()?.activeMt5InstanceId
        || settings.data?.activeMt5InstanceId
        || null;
      const instAccMap = new Map();
      for (const inst of instances) {
        const cached = _accountInfoCache?.get?.(inst.id);
        const live = cached?.data?.login || cached?.data?.account?.login;
        const persisted = inst.cached_account_login;
        const login = Number(live || persisted || 0);
        if (login) instAccMap.set(inst.id, login);
      }
      // 0.3.231: 撤掉「默认 instance 不 override 让 server 走老反推」的兜底.
      // 多账户场景下 server 反推 / license-level 聚合都会撞 — 用户挂第二个 MT5
      // 后 GMarket (绑默认) 的 invested_capital 从 $10000 变 $110000 (= 两个
      // 账户入金加起来), pnl_pct 从 +21% 变 -90% — 因为 server 拿不到 ea_accounts
      // override 就退到聚合所有账户.
      // 0.3.233: 给 default-binding EA 也传 expected login. 但如果 default instance
      // 没 cached_account_login (MT5 还没 init 过), 不传该 ea 让 server _resolve_current_account_login
      // 按 EA name 反推 (server 0.5.48 已按 ea_name 过滤最近一笔 trade deal, 拿到的
      // account_login 是该 EA 实际跑的, 不会跨账户污染). 比 sentinel 0 强 — 0 会让
      // server fallback 跨账户聚合.
      const defaultLogin = activeId ? (instAccMap.get(activeId) || 0) : 0;
      for (const rec of Object.values(strategies?.records || {})) {
        if (!rec || !rec.ea_name) continue;
        if (rec.mt5_instance_id) {
          // 绑了具体 instance — 拿对应 login (sentinel 0 = 实例从没 init 过 →
          // server 查不到 deals → 空 metric, 用户切 binding 立即清零, 不显历史).
          eaAccounts[rec.ea_name] = instAccMap.get(rec.mt5_instance_id) || 0;
        } else if (defaultLogin) {
          // 没绑 instance + default 已 init → 用默认 login 锁死.
          eaAccounts[rec.ea_name] = defaultLogin;
        }
        // 没绑 + default 没 cached login → 不传, 让 server 自己反推 (基于 ea_name).
      }
      return await marketplace.myStats({ eaAccounts });
    } catch (e) {
      console.warn('[mkt:my-stats] build ea_accounts failed:', e?.message || e);
      return await marketplace.myStats().catch(() => ({ items: [] }));
    }
  });
  // 0.5.0 P2: metric API (统计重构 — 跟 server raw / metric 派生层对接)
  ipcMain.handle('mkt:metric',          (_e, opts) => marketplace.getMetric(opts || {}).catch((e) => ({ ok: false, error: String(e?.message || e) })));
  ipcMain.handle('mkt:metric-explain',  (_e, opts) => marketplace.explainMetric(opts || {}).catch((e) => ({ ok: false, error: String(e?.message || e) })));
  ipcMain.handle('mkt:anchors-list',    ()         => marketplace.listAnchors().catch((e) => ({ ok: false, error: String(e?.message || e) })));
  ipcMain.handle('mkt:anchor-set',      (_e, opts) => marketplace.setAnchor(opts || {}).catch((e) => ({ ok: false, error: String(e?.message || e) })));
  ipcMain.handle('mkt:get',          (_e, id) => marketplace.getListing(id));
  ipcMain.handle('mkt:stats',    (_e, id) => marketplace.getListingStats(id));
  ipcMain.handle('mkt:submit',   async (_e, payload) => {
    // payload must include {eaName, descriptionMd, ex5Path, qrPath, ...}
    // 0.3.342 (server 0.5.59): 自动拿该 EA 当前 binding 的 broker 账户号塞进 payload.
    // server 存到 listings.account_login, leaderboard 算 metric 时按账户严格过滤.
    // 之前 server compute_metric 走 _resolve_current_account_login 反推, trades=0
    // 的 EA 反推失败退到 license-wide fallback, 多 demo 账户 BALANCE deals 全聚合
    // 污染 invested_capital (用户 case: 6 个 demo broker → $70000 虚高).
    try {
      if (payload && payload.eaName && !payload.accountLogin) {
        const rec = strategies?.records?.[payload.eaName];
        const instId = rec?.mt5_instance_id
          || settings.getResolved()?.activeMt5InstanceId
          || settings.data?.activeMt5InstanceId
          || null;
        if (instId) {
          const cached = _accountInfoCache?.get?.(instId);
          const live = cached?.data?.login || cached?.data?.account?.login;
          const inst = (settings.listMt5Instances?.() || []).find((it) => it.id === instId);
          const persisted = inst?.cached_account_login;
          const login = Number(live || persisted || 0);
          if (login > 0) payload.accountLogin = login;
        }
      }
    } catch (e) {
      console.warn('[mkt:submit] account_login lookup failed (non-fatal):', e?.message || e);
    }
    try { return { ok: true, ...(await marketplace.submitListing(payload)) }; }
    catch (e) { return { ok: false, error: String(e?.message || e), status: e.status }; }
  });
  ipcMain.handle('mkt:withdraw', async (_e, id) => {
    try { return { ok: true, ...(await marketplace.withdrawListing(id)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('mkt:set-price', async (_e, id, priceHint) => {
    try { return { ok: true, ...(await marketplace.setListingPrice(id, priceHint)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 0.4.6 marketplace v2: in-place 升级 + 买家使用情况 + 隐私
  ipcMain.handle('mkt:release', async (_e, payload) => {
    // payload: {listingId, eaPath, changelog, hoursRun, trades, backtestFrom/To/NetProfit, ...}
    try { return { ok: true, ...(await marketplace.releaseNewVersion(payload)) }; }
    catch (e) { return { ok: false, error: String(e?.message || e), status: e.status }; }
  });
  ipcMain.handle('mkt:versions', async (_e, id) => {
    try { return await marketplace.listingVersions(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('mkt:buyer-stats', async (_e, id) => {
    try { return await marketplace.listingBuyerStats(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('mkt:opt-out', async (_e, optOut) => {
    try { return await marketplace.setSellerStatsOptOut(optOut); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('mkt:opt-out-read', async () => {
    try { return await marketplace.getSellerStatsOptOut(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 0.4.6: 昵称读写
  ipcMain.handle('mkt:profile', async () => {
    try { return await marketplace.getProfile(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('mkt:set-display-name', async (_e, name) => {
    try { return await marketplace.setDisplayName(name); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  // 0.4.7 清除排行榜本机记录（不可逆）
  // 0.3.62: 服务端清完后顺手把客户端 records 里的 lb_optin 标记也擦掉，
  // 否则「我的策略」UI 还显「✓ 已参与排行榜」对应不到服务端任何状态。
  ipcMain.handle('mkt:clear-leaderboard-records', async () => {
    try {
      const r = await marketplace.clearLeaderboardRecords();
      let cleared_local = 0;
      try {
        if (strategies && typeof strategies.clearAllLbOptIn === 'function') {
          cleared_local = await strategies.clearAllLbOptIn();
        }
      } catch (e) {
        console.warn('[clear-leaderboard] local clearAllLbOptIn failed:', e?.message || e);
      }
      return { ...r, cleared_local };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('mkt:order-create', async (_e, p) => {
    try { return { ok: true, ...(await marketplace.createOrder(p)) }; }
    catch (e) { return { ok: false, error: String(e.message || e), status: e.status }; }
  });
  ipcMain.handle('mkt:my-orders',    () => marketplace.listMyOrders());
  ipcMain.handle('mkt:listing-orders', (_e, id) => marketplace.listOrdersForListing(id));
  ipcMain.handle('mkt:order-approve', async (_e, id) => {
    try { return { ok: true, ...(await marketplace.approveOrder(id)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('mkt:order-reject', async (_e, id, reason) => {
    try { return { ok: true, ...(await marketplace.rejectOrder(id, reason)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('mkt:install', async (_e, listingId, eaName) => {
    // 1. Download payload → 检测是 raw .ex5 还是 .ezpkg (store-only zip bundle，0.3.55 加)
    //
    // 0.3.55 marketplace bundle 协议：卖家 EA 有关联 .ex5/.ex4 指标依赖时上架，
    // marketplace.submitListing 把 主.ex5 + indicators/<...> 打成 store-only zip，
    // 服务端 raw 存。下载回来要嗅磁 ZIP 头：
    //   - PK\x03\x04 开头 → 解压 → 主 .ex5 + 子目录 indicators/<...> 分别落位
    //   - 否则当老路径 raw .ex5 处理
    // 这样兼容老 listing（payload_kind=ex5）+ 新 listing（payload_kind=bundle），
    // 服务端不用改 schema。
    const stagePath = path.join(workspaceDir, 'strategies', `.${eaName}.download.tmp`);
    const dst = path.join(workspaceDir, 'strategies', `${eaName}.ex5`);
    let installedIndicators = [];
    let mt5IndicatorsSynced = [];
    try {
      // 先下到 tmp 路径，下完检测格式再决定怎么落位
      const r = await marketplace.downloadEx5(listingId, stagePath);
      const buf = await fs.promises.readFile(stagePath);

      const { looksLikeZip, extractZip } = require('./zip-utils');
      if (looksLikeZip(buf)) {
        // Bundle 路径
        const entries = extractZip(buf);
        // 主 EA = 根目录下的 .ex5（不在 indicators/ 子目录里的）
        const mainEntry = entries.find((e) =>
          !e.name.includes('/') && /\.ex5$/i.test(e.name));
        if (!mainEntry) throw new Error('bundle 内未找到主 EA .ex5');
        await fs.promises.writeFile(dst, mainEntry.data);

        // 指标拆到 workspace/strategies/.indicators/<EA>/ + 同步 MT5
        const indDir = path.join(workspaceDir, 'strategies', '.indicators', eaName);
        await fs.promises.mkdir(indDir, { recursive: true });
        for (const entry of entries) {
          if (entry === mainEntry) continue;
          // 接受 indicators/<filename> + 顶层非主 .ex5 的扩展（防卖家打包变形）
          const base = path.basename(entry.name);
          const ext = path.extname(base).toLowerCase();
          if (!['.ex5', '.ex4', '.mqh', '.mq5'].includes(ext)) continue;
          const targetWs = path.join(indDir, base);
          await fs.promises.writeFile(targetWs, entry.data);
          installedIndicators.push(base);
        }
      } else {
        // 老协议 raw .ex5
        await fs.promises.rename(stagePath, dst);
      }
      // 删除 tmp（rename 成功时已不存在；其他路径下走完都该清掉）
      try { await fs.promises.unlink(stagePath); } catch {}

      // 0.4.6: 写 sidecar <ea>.installed.json 记当前装的版本号，下次「我的订单」
      // 列表能跟 listing.current_version 对比显示「📥 v2 可用」升级 ribbon。
      // 拉最新 listing.version 写进 sidecar；失败不致命（按 1 算保守兼容）。
      try {
        const lst = await marketplace.getListing(listingId);
        const v = lst?.listing?.version || 1;
        const sidecarPath = path.join(workspaceDir, 'strategies', `${eaName}.installed.json`);
        await fs.promises.writeFile(sidecarPath, JSON.stringify({
          version:     v,
          listing_id:  listingId,
          ea_name:     eaName,
          ea_hash:     lst?.listing?.ea_hash || null,
          installed_at: new Date().toISOString(),
          // 0.3.55 关联指标列表（卸载时方便清理）
          indicators:  installedIndicators,
        }, null, 2), 'utf8');
      } catch (e) {
        console.warn('[install] sidecar write failed:', e?.message || e);
      }

      // 0.3.55: 把关联指标同步到主 MT5 `MQL5/Indicators/`，这样买家挂载 EA 后
      // 实盘运行能立刻加载 iCustom 指标。
      if (installedIndicators.length > 0) {
        try {
          const s = await settings.ensureDetected();
          const mt5DataDir = s.mt5?.dataDir;
          if (mt5DataDir) {
            const mt5IndDir = path.join(mt5DataDir, 'MQL5', 'Indicators');
            await fs.promises.mkdir(mt5IndDir, { recursive: true });
            const srcDir = path.join(workspaceDir, 'strategies', '.indicators', eaName);
            for (const fname of installedIndicators) {
              try {
                await fs.promises.copyFile(
                  path.join(srcDir, fname),
                  path.join(mt5IndDir, fname),
                );
                mt5IndicatorsSynced.push(fname);
              } catch (ce) {
                console.warn(`[install] MT5 sync indicator ${fname} failed:`, ce?.message || ce);
              }
            }
          }
        } catch (e) {
          console.warn('[install] MT5 indicator sync failed:', e?.message || e);
        }
      }

      // 2. 0.4.3: 同时写 MT5/MQL5/Files/easydeal_auth.json，让买家 EA
      //    跑起来后能读到 license_key 调 /v1/listings/auth-check 验授权。
      //    格式：{ "license_key": "EZDL-...", "machine_id": "...",
      //            "listings": [{ "listing_id": N, "ea_name": "X", "installed_at": ISO }] }
      //    多个买的策略累加到 listings 数组，不覆盖之前的。
      let authResult = { ok: false, reason: 'not-attempted' };
      try {
        const s = await settings.ensureDetected();
        const dataDir = s.mt5?.dataDir;
        if (!dataDir) {
          authResult = { ok: false, reason: 'MT5 data dir 没设置 — auth.json 没写' };
        } else {
          const filesDir = path.join(dataDir, 'MQL5', 'Files');
          await fs.promises.mkdir(filesDir, { recursive: true });
          const authPath = path.join(filesDir, 'easydeal_auth.json');
          // 读现有 auth.json（如果有）merge
          let existing = { listings: [] };
          try {
            const buf = await fs.promises.readFile(authPath, 'utf8');
            existing = JSON.parse(buf);
            if (!Array.isArray(existing.listings)) existing.listings = [];
          } catch {}
          const licStatus = license.getStatus();
          const licenseKey = licStatus.logged_in ? licStatus.license_key : null;
          const machineId  = licStatus.machine_id || null;
          const installedAt = new Date().toISOString();
          // 同 listing_id 已经存在 → 更新 installed_at；否则 append
          const idx = existing.listings.findIndex((x) => x.listing_id === listingId);
          if (idx >= 0) {
            existing.listings[idx] = { listing_id: listingId, ea_name: eaName, installed_at: installedAt };
          } else {
            existing.listings.push({ listing_id: listingId, ea_name: eaName, installed_at: installedAt });
          }
          const payload = {
            license_key: licenseKey,
            machine_id:  machineId,
            updated_at:  installedAt,
            listings:    existing.listings,
          };
          await fs.promises.writeFile(authPath, JSON.stringify(payload, null, 2), 'utf8');
          authResult = { ok: true, path: authPath };
        }
      } catch (e) {
        authResult = { ok: false, reason: e?.message || String(e) };
      }
      // payload size = 实际落地的 .ex5（bundle 模式下不是下载的 zip size）
      let installedSize = 0;
      try { installedSize = (await fs.promises.stat(dst)).size; } catch {}
      return {
        ok: true,
        path: dst,
        size: installedSize,
        auth: authResult,
        indicators: installedIndicators,
        mt5_indicators_synced: mt5IndicatorsSynced,
        is_bundle: installedIndicators.length > 0,
      };
    } catch (e) {
      // 清理 tmp（防下载到一半失败留垃圾）
      try { await fs.promises.unlink(stagePath); } catch {}
      return { ok: false, error: String(e.message || e) };
    }
  });
  // 0.4.3: 卖家 inbox — pending + decided 订单
  ipcMain.handle('mkt:inbox', async () => {
    try {
      const r = await marketplace.sellerInbox();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  // 0.4.4: IM — 私信（买卖双方 + 用户↔客服）
  ipcMain.handle('im:open', async (_e, { peerLicenseKey, kind, contextListingId } = {}) => {
    try {
      const r = await marketplace.imOpenConversation({ peerLicenseKey, kind, contextListingId });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('im:open-support', async () => {
    try {
      const r = await marketplace.imOpenWithSupport();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('im:list', async () => {
    try {
      const r = await marketplace.imListConversations();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('im:messages', async (_e, { convId, since, limit } = {}) => {
    try {
      const r = await marketplace.imGetMessages(convId, { since, limit });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('im:send', async (_e, { convId, body } = {}) => {
    try {
      const r = await marketplace.imSendMessage(convId, body);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  // ── 通讯会话本地元数据 (命名/备注/删除-隐藏, 存 <dataDir>/im-meta.json) ──
  ipcMain.handle('im:get-meta', async () => {
    try {
      const pathx = require('node:path'); const fsx = require('node:fs');
      const dataDir = pathx.join(app.getPath('userData'), 'data');
      const fp = pathx.join(dataDir, 'im-meta.json');
      if (!fsx.existsSync(fp)) return { ok: true, meta: {} };
      return { ok: true, meta: JSON.parse(fsx.readFileSync(fp, 'utf8') || '{}') };
    } catch (e) { return { ok: false, error: String(e.message || e), meta: {} }; }
  });
  ipcMain.handle('im:set-meta', async (_e, { convId, alias, note, hidden } = {}) => {
    try {
      if (convId == null) return { ok: false, error: 'convId required' };
      const pathx = require('node:path'); const fsx = require('node:fs');
      const dataDir = pathx.join(app.getPath('userData'), 'data');
      const fp = pathx.join(dataDir, 'im-meta.json');
      let m = {}; try { m = JSON.parse(fsx.readFileSync(fp, 'utf8') || '{}'); } catch {}
      const key = String(convId);
      const cur = m[key] || {};
      if (alias !== undefined) cur.alias = String(alias || '').trim();
      if (note !== undefined) cur.note = String(note || '').trim();
      if (hidden !== undefined) cur.hidden = !!hidden;
      if (!cur.alias) delete cur.alias;
      if (!cur.note) delete cur.note;
      if (!cur.hidden) delete cur.hidden;
      if (Object.keys(cur).length === 0) delete m[key]; else m[key] = cur;
      try { fsx.mkdirSync(dataDir, { recursive: true }); } catch {}
      fsx.writeFileSync(fp, JSON.stringify(m), 'utf8');
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // ── 0.5.x: per-EA 经验笔记 读写(策略行「📒 经验」按钮)。文件 =
  //    <userData>/workspace/strategies/<stem>.experience.md, 跟 Python MCP
  //    record_experience/read_experience 同一份(按 EA 名去后缀)。──
  const _experienceFp = (ea) => {
    const pathx = require('node:path');
    let stem = String(ea || '').split(/[\\/]/).pop() || '';
    stem = stem.replace(/\.(experience\.md|mq5|ex5|mqh|set)$/i, '');
    if (!stem) return null;
    return pathx.join(app.getPath('userData'), 'workspace', 'strategies', stem + '.experience.md');
  };
  ipcMain.handle('experience:get', async (_e, ea) => {
    try {
      const fsx = require('node:fs');
      const fp = _experienceFp(ea);
      if (!fp) return { ok: false, error: 'ea 为空' };
      if (!fsx.existsSync(fp)) return { ok: true, content: '', file: fp, note: '暂无经验笔记' };
      return { ok: true, content: fsx.readFileSync(fp, 'utf8'), file: fp };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('experience:set', async (_e, { ea, content } = {}) => {
    try {
      const pathx = require('node:path'); const fsx = require('node:fs');
      const fp = _experienceFp(ea);
      if (!fp) return { ok: false, error: 'ea 为空' };
      fsx.mkdirSync(pathx.dirname(fp), { recursive: true });
      const tmp = fp + '.tmp';                              // durable: tmp + rename
      fsx.writeFileSync(tmp, String(content == null ? '' : content), 'utf8');
      fsx.renameSync(tmp, fp);
      return { ok: true, file: fp };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // ── 序列号远程控制 (operator REST → server, 一期) ──
  ipcMain.handle('remote:request-grant', async (_e, { clientKey, scope, note } = {}) => {
    try { return { ok: true, ...(await marketplace.remoteRequestGrant({ clientKey, scope, note })) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('remote:list-grants', async () => {
    try { return { ok: true, ...(await marketplace.remoteListGrants()) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('remote:decide', async (_e, { grantId, approve } = {}) => {
    try { return { ok: true, ...(await marketplace.remoteDecide(grantId, approve)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('remote:revoke', async (_e, { grantId } = {}) => {
    try { return { ok: true, ...(await marketplace.remoteRevoke(grantId)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('remote:call', async (_e, { clientKey, tool, args, instanceId, timeoutMs } = {}) => {
    try { return await marketplace.remoteCall(clientKey, tool, args, { instanceId, timeoutMs }); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 0.5.x: 远程 AI 对话窗消息持久化(每客户 key 一条历史, 关窗重开能续看)。
  // 存 <dataDir>/remote-ai-chats.json = { <clientKey>: [{who,text,ts}, ...] }, 每客户 cap 200 条。
  ipcMain.handle('remote:get-chat', async (_e, clientKey) => {
    try {
      const pathx = require('node:path'); const fsx = require('node:fs');
      if (!clientKey) return { ok: true, data: [] };
      const fp = pathx.join(app.getPath('userData'), 'data', 'remote-ai-chats.json');
      if (!fsx.existsSync(fp)) return { ok: true, data: [] };
      const all = JSON.parse(fsx.readFileSync(fp, 'utf8') || '{}');
      return { ok: true, data: Array.isArray(all[clientKey]) ? all[clientKey] : [] };
    } catch (e) { return { ok: false, error: String(e.message || e), data: [] }; }
  });
  ipcMain.handle('remote:append-chat', async (_e, { clientKey, who, text } = {}) => {
    try {
      if (!clientKey || !who) return { ok: false, error: 'clientKey+who required' };
      const pathx = require('node:path'); const fsx = require('node:fs');
      const dataDir = pathx.join(app.getPath('userData'), 'data');
      const fp = pathx.join(dataDir, 'remote-ai-chats.json');
      let all = {}; try { if (fsx.existsSync(fp)) all = JSON.parse(fsx.readFileSync(fp, 'utf8') || '{}'); } catch {}
      if (!Array.isArray(all[clientKey])) all[clientKey] = [];
      all[clientKey].push({ who: String(who), text: String(text || ''), ts: Date.now() });
      if (all[clientKey].length > 200) all[clientKey] = all[clientKey].slice(-200);
      try { fsx.mkdirSync(dataDir, { recursive: true }); } catch {}
      const tmp = fp + '.tmp';                       // durable: tmp + rename
      fsx.writeFileSync(tmp, JSON.stringify(all), 'utf8');
      fsx.renameSync(tmp, fp);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 操盘端「AI 对话」窗口一轮 — spawn 操盘手 AI(自己的 token), 挂 remote_proxy_mcp
  // (只暴露该客户 scope 内的远程工具, 每调一次经 server 闸转发到被控端确定性执行)。
  // 每客户独立 cwd(<dataDir>/remote-op/<key>) + .mcp.json + CLAUDE.md; --continue 续会话。
  ipcMain.handle('remote:ai-turn', async (_e, { clientKey, scope, message, fresh } = {}) => {
    try {
      if (!clientKey || !message) return { ok: false, error: 'clientKey + message required' };
      const fsx = require('node:fs'); const pathx = require('node:path');
      const token = (() => { try { return require('./license')._activeToken(); } catch { return null; } })();
      if (!token) return { ok: false, error: '未登录' };
      const s = (settings && settings.getResolved) ? settings.getResolved() : {};
      const base = require('./server-api').baseUrl();
      const pyBin = s.pythonBin || 'python';
      const easydealScript = s.easydealScript || '';
      const proxyScript = easydealScript
        ? pathx.join(pathx.dirname(easydealScript), 'remote_proxy_mcp.py')
        : pathx.join(__dirname, '..', 'python', 'remote_proxy_mcp.py');
      const safe = String(clientKey).replace(/[^A-Za-z0-9_-]/g, '_');
      const dataDir = pathx.join(app.getPath('userData'), 'data');
      const dir = pathx.join(dataDir, 'remote-op', safe);
      fsx.mkdirSync(dir, { recursive: true });
      fsx.writeFileSync(pathx.join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: { remote: { command: pyBin, args: [proxyScript], env: {
          EASYDEAL_REMOTE_TARGET: clientKey, EASYDEAL_REMOTE_TOKEN: token,
          EASYDEAL_REMOTE_BASE: base, EASYDEAL_REMOTE_SCOPE: scope || 'read',
        } } },
      }, null, 2), 'utf8');
      fsx.writeFileSync(pathx.join(dir, 'CLAUDE.md'),
        `你是操盘手的「远程助手」。你正在远程协助操盘客户序列号 ${clientKey}。\n`
        + `你挂载了一组「远程工具」(remote MCP) —— 它们经服务器授权直接作用于**客户的** EasyDeal/MT5, 不是你自己的账户。\n`
        + `授权范围: ${scope || 'read'}。先用只读工具看清客户状况再动手; 涉及交易/挂载要谨慎并跟操盘手确认意图。用中文回复操盘手。\n`, 'utf8');
      // 1.2.2: 180s → 30min。远程工具每步走 服务器→SSE→被控端→回传 一整圈,
      // AI 一轮查 8-10 个工具 + 思考, 3 分钟必超时(操盘手窗口连报 timed out 根因)。
      const r = await spawnHeadlessClaude({ prompt: message, cwd: dir, resume: !fresh, timeoutMs: 1_800_000 });
      const text = (typeof r === 'string') ? r : (r && (r.text || r.output)) || '';
      return { ok: true, text: String(text || '').trim() };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 操盘手直推策略给客户 — 读本地 workspace/strategies/<ea> 的 .ex5(+.mq5/.set), base64,
  // remoteCall('push_strategy') → server 闸 → 被控端落到客户 workspace/strategies。
  // 列被控机现有策略(给推送弹窗的「目标」下拉用)。权限不变: manage 档已含 read 的 list_strategies。
  ipcMain.handle('remote:list-client-strategies', async (_e, { clientKey } = {}) => {
    try {
      if (!clientKey) return { ok: false, error: 'clientKey required' };
      const r = await marketplace.remoteCall(clientKey, 'list_strategies', {}, { timeoutMs: 30000 });
      // 服务端 /call 返回 {ok, data, error}(remote.py) —— 之前误写成 r.result 读了个 undefined,
      // 导致目标下拉永远空/只有「新建」。data 才是客户端 dispatch() 里 out.result 透传过来的值。
      const raw = (r && (r.data ?? r)) || {};
      const arr = raw.strategies || raw.items || raw.names || (Array.isArray(raw) ? raw : []);
      const names = (Array.isArray(arr) ? arr : [])
        .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.ea_name || x.stem))) || '')
        .map((s) => String(s).replace(/\.(ex5|mq5|set)$/i, '').trim())
        .filter(Boolean);
      return { ok: !!(r && r.ok !== false), names: [...new Set(names)] };
    } catch (e) { return { ok: false, error: String(e.message || e), names: [] }; }
  });
  // remoteCall('push_strategy') → server 闸 → 被控端落到客户 workspace/strategies。
  // opts: { clientKey, eaName(本机源策略), targetName(被控机目标名), targetMode('overwrite'|'new'),
  //         syncDoc(同步说明.md), syncExperience(同步经验.experience.md) }
  ipcMain.handle('remote:push-strategy', async (_e, opts = {}) => {
    try {
      const { clientKey, eaName } = opts;
      if (!clientKey || !eaName) return { ok: false, error: 'clientKey + eaName required' };
      const fsx = require('node:fs'); const pathx = require('node:path');
      const dir = pathx.join(workspaceDir, 'strategies');
      const stem = String(eaName).replace(/\.(ex5|mq5|set|md)$/i, '');
      const ex5 = pathx.join(dir, stem + '.ex5');
      if (!fsx.existsSync(ex5)) return { ok: false, error: '本地没有 ' + stem + '.ex5(先把策略编译好)' };
      const b64 = (p) => { try { return fsx.existsSync(p) ? fsx.readFileSync(p).toString('base64') : null; } catch { return null; } };
      // 目标名: 传了 targetName 用它(覆盖客户现有策略); 缺省用源名。new 模式被控端会自动避重名。
      const targetMode = (opts.targetMode === 'new') ? 'new' : 'overwrite';
      const targetName = String(opts.targetName || stem).replace(/\.(ex5|mq5|set|md)$/i, '').trim() || stem;
      const payload = {
        ea_name: targetName, target_mode: targetMode, ex5_b64: b64(ex5),
        mq5_b64: b64(pathx.join(dir, stem + '.mq5')), set_b64: b64(pathx.join(dir, stem + '.set')),
      };
      if (opts.syncDoc) payload.md_b64 = b64(pathx.join(dir, stem + '.md'));   // 策略说明
      if (opts.syncExperience) {                                              // 策略经验(取本机整份)
        try { const exp = pathx.join(dir, stem + '.experience.md'); if (fsx.existsSync(exp)) payload.experience_content = fsx.readFileSync(exp, 'utf8'); } catch {}
      }
      return await marketplace.remoteCall(clientKey, 'push_strategy', payload, { timeoutMs: 90000 });
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 1.4.x「我的策略」复制 — 跟远程推送策略(push_strategy, remote-control.js)同一套语义,
  // 只是目标是本机而非被控机: overwrite 保留目标原有 monitor_config(品种/魔术号, 跟远程
  // 覆盖同款保护, 不被源策略的品种带偏)、经验非破坏 append(整份取本机源经验, 跟远程同款)、
  // 说明.md 直接覆盖/新建。new 模式目标名撞车自动加序号(GMarket → GMarket2…)。
  // opts: { sourceName(源策略), targetMode('overwrite'|'new'), targetName, syncDoc, syncExperience }
  ipcMain.handle('strategies:copy', async (_e, opts = {}) => {
    try {
      const { sourceName, syncDoc, syncExperience } = opts;
      if (!sourceName) return { ok: false, error: 'sourceName required' };
      const fsx = require('node:fs'); const pathx = require('node:path');
      const dir = pathx.join(workspaceDir, 'strategies');
      const srcStem = String(sourceName).replace(/\.(ex5|mq5|set|md)$/i, '').trim();
      const srcEx5 = pathx.join(dir, srcStem + '.ex5');
      if (!fsx.existsSync(srcEx5)) return { ok: false, error: '本地没有 ' + srcStem + '.ex5(先把策略编译好)' };
      const targetMode = (opts.targetMode === 'new') ? 'new' : 'overwrite';
      let tgt = String(opts.targetName || '').replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!tgt) return { ok: false, error: 'targetName required' };
      if (tgt === srcStem) return { ok: false, error: '新名字不能跟源策略相同' };
      if (targetMode === 'new') {
        const exists = (n) => fsx.existsSync(pathx.join(dir, n + '.ex5')) || fsx.existsSync(pathx.join(dir, n + '.mq5'));
        if (exists(tgt)) { let i = 2; while (exists(tgt + i) && i < 1000) i += 1; tgt = tgt + i; }
      }
      let mcSnapshot = null;
      if (targetMode !== 'new' && strategies && typeof strategies.getMonitorConfig === 'function') {
        try { mcSnapshot = strategies.getMonitorConfig(tgt); } catch { /* 目标没配置就算了 */ }
      }
      const wrote = [];
      const copyIfExists = (ext) => {
        const s = pathx.join(dir, srcStem + ext); const t = pathx.join(dir, tgt + ext);
        if (fsx.existsSync(s)) { fsx.copyFileSync(s, t); wrote.push(tgt + ext); }
      };
      copyIfExists('.ex5'); copyIfExists('.mq5'); copyIfExists('.set');
      if (syncDoc) copyIfExists('.md');
      if (mcSnapshot && ((mcSnapshot.symbols && mcSnapshot.symbols.length) || mcSnapshot.magic || (mcSnapshot.magic_numbers && mcSnapshot.magic_numbers.length))) {
        try { await strategies.setMonitorConfig(tgt, mcSnapshot); wrote.push('(monitor_config 已保留目标原品种/魔术号)'); } catch { /* 不影响复制主结果 */ }
      }
      if (syncExperience) {
        try {
          const srcExp = pathx.join(dir, srcStem + '.experience.md');
          if (fsx.existsSync(srcExp)) {
            const content = fsx.readFileSync(srcExp, 'utf8');
            const fp = pathx.join(dir, tgt + '.experience.md');
            let out = ''; try { out = fsx.readFileSync(fp, 'utf8'); } catch {}
            if (!out.trim()) out = '# ' + tgt + ' 经验笔记\n> EasyDeal 每日自动总结 + AI 主动记录 + 本地复制同步\n';
            const dt = new Date();
            const day = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
            const hm = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
            if (out.indexOf('## ' + day) < 0) out = out.replace(/\s+$/, '') + '\n\n## ' + day + '\n';
            out = out.replace(/\s+$/, '') + '\n- ' + hm + ' [本地复制自 ' + srcStem + '] ' + content.trim() + '\n';
            const tmp = fp + '.tmp'; fsx.writeFileSync(tmp, out, 'utf8'); fsx.renameSync(tmp, fp);
            wrote.push(tgt + '.experience.md');
          }
        } catch { /* 经验同步失败不影响复制主结果 */ }
      }
      return { ok: true, final_name: tgt, mode: targetMode, wrote };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('im:read', async (_e, convId) => {
    try {
      const r = await marketplace.imMarkRead(convId);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  // 0.4.10: 跟单 IPC handlers
  const copyTrade = require('./copy-trade');
  ipcMain.handle('ct:request',         async (_e, p) => {
    try { return { ok: true, ...(await copyTrade.requestFollow(p || {})) }; }
    catch (e) { return { ok: false, error: String(e?.message || e), status: e?.status }; }
  });
  ipcMain.handle('ct:my-subscriptions', async () => {
    try { return await copyTrade.listMySubscriptions(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:requests-for-me', async () => {
    try { return await copyTrade.listRequestsForMe(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:my-followers',    async () => {
    try { return await copyTrade.listMyFollowers(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:approve',         async (_e, id) => {
    try { return await copyTrade.approveRequest(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:reject',          async (_e, id, reason) => {
    try { return await copyTrade.rejectRequest(id, reason); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:pause-author',    async (_e, id) => {
    try { return await copyTrade.pauseAsAuthor(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:resume-author',   async (_e, id) => {
    try { return await copyTrade.resumeAsAuthor(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:pause-follower',  async (_e, id) => {
    try { return await copyTrade.pauseAsFollower(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:resume-follower', async (_e, id) => {
    try { return await copyTrade.resumeAsFollower(id); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:revoke',          async (_e, id, reason) => {
    try { return await copyTrade.revoke(id, reason); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('ct:stream-status',   async () => {
    try { return await copyTrade.streamStatus(); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  ipcMain.handle('mkt:browse-file', async (_e, opts) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: opts?.title || '选择文件',
      properties: ['openFile'],
      filters: opts?.filters,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('app:list-skills', async () => {
    const s = settings.getResolved();
    const [mcp, skills] = await Promise.all([
      enumerateMcpTools({
        scheduler: schedulerClient,
        schedulerScript: resolveBundledFile('python', 'scheduler_mcp.py'),
        easydealScript: s.easydealScript,
        pythonBin: s.pythonBin,
        windowCaptureScript: s.windowCaptureScript,
        // 这一项让 Skills 页能实时反映「允许 AI 平仓改单 / 开仓」开关 —
        // 探针会注同样的 env，list_tools 返回 close_position / modify_position
        // / open_position 跟 chat-spawn 看到的工具集保持一致。
        tradingWriteEnabled: !!s.tradingWriteEnabled,
        tradingWriteOpenEnabled: !!s.tradingWriteOpenEnabled,
      }),
      enumerateSkills(resolveBundledFile('skills', 'wind-tunnel-skill')),
    ]);
    return { mcp, skills };
  });

  ipcMain.handle('app:check-mt5', async () => {
    const r = await checkMt5Running(settings.getResolved().mt5.installDir);
    console.log('[ipc] check-mt5 →', JSON.stringify(r));
    return r;
  });
  ipcMain.handle('app:launch-mt5', async () => {
    const inst = settings.getActiveMt5Instance?.();
    console.log('[ipc] launch-mt5: instance =', inst?.id || null);
    if (!inst) return { ok: false, error: '没有默认 MT5 实例' };
    try { global._clearKillFlag?.(inst.installDir); } catch {}
    _mt5LaunchAuthorization.set(inst.id, Date.now() + 180_000);
    const r = await launchMt5(inst);
    try { await settings.updateMt5Instance(inst.id, { user_intent: r?.ok ? 'running' : 'stopped' }); } catch {}
    console.log('[ipc] launch-mt5 →', JSON.stringify(r));
    return r;
  });

  // -- token / credential routing
  ipcMain.handle('token:get-config', () => tokenStore?.getMasked() || null);
  ipcMain.handle('token:set-mode', async (_e, mode) => tokenStore.setMode(mode));
  ipcMain.handle('token:set-custom', async (_e, patch) => tokenStore.setCustom(patch || {}));
  ipcMain.handle('token:set-system', async (_e, patch) => tokenStore.setSystem(patch || {}));
  ipcMain.handle('token:set-codex',  async (_e, patch) => tokenStore.setCodex(patch || {}));
  ipcMain.handle('token:set-context', async (_e, patch) => tokenStore.setContext(patch || {}));
  ipcMain.handle('token:set-proxy',  async (_e, patch) => tokenStore.setProxy(patch || {}));
  ipcMain.handle('token:codex-status', async () => tokenStore.codexStatus());
  // 0.3.161: 测试自定义 endpoint 连通 — fetch POST /v1/messages 最小 prompt,
  // 看 200 / 401 / model error 等具体反馈. 不动 tokenStore 持久化.
  // 0.3.244: 加 protocol 字段 — 'anthropic' 走老逻辑, 'openai' 走 OpenAI 兼容协议
  // (走本地代理 preflightTest 验 OpenAI 端点).
  ipcMain.handle('token:test-custom', async (_e, cfg) => {
    const protocol = (cfg?.protocol === 'openai') ? 'openai' : 'anthropic';
    const baseRaw = (cfg?.base_url || '').trim();
    const apiKey = (cfg?.api_key || '').trim();
    if (!baseRaw) return { ok: false, error: 'BASE_URL 必填' };
    if (!apiKey)  return { ok: false, error: 'API_KEY 必填' };
    const startMs = Date.now();
    if (protocol === 'openai') {
      // OpenAI Chat Completions 协议测试 — 用 OpenAIProxyServer.preflightTest()
      const model = (cfg?.model || '').trim();
      if (!model) return { ok: false, error: 'OpenAI 模式下 model 必填 (如 deepseek-chat / qwen-max)' };
      try {
        const { OpenAIProxyServer } = require('./openai-proxy-server');
        const tmp = new OpenAIProxyServer({
          upstreamBaseUrl: baseRaw,
          upstreamApiKey: apiKey,
          upstreamModel: model,
          log: () => {},
        });
        const r = await tmp.preflightTest();
        const latency = Date.now() - startMs;
        if (r.ok) {
          return {
            ok: true,
            status: r.status,
            latency_ms: latency,
            model_used: model,
            sample: r.sample_text || '(no text)',
            protocol: 'openai',
          };
        }
        return {
          ok: false,
          status: r.status,
          latency_ms: latency,
          error: r.error || `HTTP ${r.status || '?'}`,
          raw: r.body ? { body: r.body } : undefined,
          protocol: 'openai',
        };
      } catch (e) {
        const latency = Date.now() - startMs;
        return { ok: false, latency_ms: latency, error: String(e?.message || e), protocol: 'openai' };
      }
    }
    // protocol === 'anthropic' (老路径)
    const model = (cfg?.model || '').trim() || 'claude-sonnet-4-5';
    // 规范化 URL: 去 trailing slash, 拼 /v1/messages
    const base = baseRaw.replace(/\/+$/, '');
    const url  = `${base}/v1/messages`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);   // 15s 超时
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping (one word reply please)' }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latency = Date.now() - startMs;
      const txt = await resp.text();
      let body;
      try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 300) }; }
      if (resp.ok) {
        // 拿响应里第一段文字看模型真返了内容
        const sample = (body?.content?.[0]?.text || '').slice(0, 80) || '(no text)';
        return {
          ok: true,
          status: resp.status,
          latency_ms: latency,
          model_used: body?.model || model,
          sample,
          protocol: 'anthropic',
        };
      }
      return {
        ok: false,
        status: resp.status,
        latency_ms: latency,
        error: body?.error?.message || body?.error?.type || body?.message || `HTTP ${resp.status}`,
        raw: typeof body === 'object' ? body : undefined,
        protocol: 'anthropic',
      };
    } catch (e) {
      const latency = Date.now() - startMs;
      const msg = e?.name === 'AbortError'
        ? `15s 超时 — 网络 / endpoint 不通`
        : (e?.message || String(e));
      return { ok: false, latency_ms: latency, error: msg, protocol: 'anthropic' };
    }
  });
  // ---- Fay-mode IPCs ----
  // All three pass `license_key` + `machine_id` so the server can:
  //   - Gate the model list per license (only return models this license
  //     is entitled to use)
  //   - Bind issued tokens to (license, machine_id) for usage tracking +
  //     per-machine quota enforcement
  //   - Aggregate usage stats per license
  // The license key is the user's serial number (entered in 设置 → 授权 OR
  // bound on first login). Server contract is documented inline below.
  // _fayContext 现在在模块顶层（见上面 _broadcastTokenChange 旁边）—— 0.3.50
  // 之前定义在 registerIpc() 内部，结果 app.whenReady 回调里的 _sharedReissuer
  // 引用它时撞 ReferenceError（不同 function scope）。0.3.49 把 channel-err
  // 正则修对后 retry 第一次真触发，用户撞「reissue 失败 → _fayContext is
  // not defined」就是这条。

  ipcMain.handle('token:list-fay-models', async () => {
    // Server contract:
    //   GET /v1/token/models?license_key=...&machine_id=...
    //   → { models: [{id, name, provider, channel_count, allowed: true,
    //                 max_input_tokens, hint?}],
    //       license_tier, note? }
    //
    // Server-side per-license gating: server reads the license's
    // entitlement profile and returns ONLY models that license can use.
    // E.g. trial license → just claude-haiku; pro license → all.
    const ctx = await _fayContext();
    if (!ctx.license_key) {
      return { ok: false, error: '未找到序列号 — 请先在「设置 → 授权信息」登录', models: [] };
    }
    const qs = new URLSearchParams(ctx).toString();
    const r = await serverApi.get(`/v1/token/models?${qs}`);
    if (r.ok) return { ok: true, models: r.models || [], license_tier: r.license_tier, note: r.note || null };
    if (r.offline) return {
      ok: false, offline: true,
      error: 'Fay 服务端未上线 — 暂时只能用「系统」或「自定义」模式',
      models: [],
    };
    return { ok: false, error: r.error || '获取失败', models: [] };
  });

  ipcMain.handle('token:fay-issue', async (_e, { model } = {}) => {
    // Server contract:
    //   POST /v1/token/issue {model, license_key, machine_id}
    //   → { token, base_url, model, expires_at, channel_id }
    //
    // Server validates the license has access to `model`, picks the
    // least-loaded compatible channel (load balancing across configured
    // upstream API keys), issues a short-lived bearer token bound to
    // (license, machine_id). Subsequent API calls from claude `--print`
    // hit `base_url` with `Authorization: Bearer <token>`; the server's
    // proxy logs usage against (license, machine_id).
    const ctx = await _fayContext();
    if (!ctx.license_key) {
      return { ok: false, error: '未找到序列号 — 请先在「设置 → 授权信息」登录' };
    }
    const r = await serverApi.post('/v1/token/issue', { model, ...ctx });
    if (r.ok && r.token) {
      await tokenStore.setFay({
        cached_token: r.token,
        cached_base_url: r.base_url || null,
        cached_model: r.model || model || null,    // server-returned concrete id
        cached_model_requested: model || null,      // what user asked for ('auto' or concrete)
        cached_until: r.expires_at || (Date.now() + 30 * 60 * 1000),
        context_window: r.context_window || null,   // 1.2.31: 真实窗口 → 主动压缩
      });
      _broadcastTokenChange();
      return { ok: true, model: r.model || model, expires_at: r.expires_at };
    }
    if (r.offline) return { ok: false, offline: true, error: 'Fay 服务端未上线' };
    return { ok: false, error: r.error || '签发失败' };
  });

  ipcMain.handle('token:fay-usage', async () => {
    // Server contract:
    //   GET /v1/token/usage?license_key=...&machine_id=...
    //   → { today: {tokens_in, tokens_out, requests, by_model},
    //       month: {...},
    //       quota: {monthly_tokens, used, remaining, reset_at,
    //               per_model: {model_id: {used, max}}} }
    const ctx = await _fayContext();
    if (!ctx.license_key) {
      return { ok: false, error: '未找到序列号' };
    }
    const qs = new URLSearchParams(ctx).toString();
    const r = await serverApi.get(`/v1/token/usage?${qs}`);
    if (r.ok) return { ok: true, ...r };
    if (r.offline) return { ok: false, offline: true, error: 'Fay 服务端未上线' };
    return { ok: false, error: r.error || '获取失败' };
  });

  // -- settings
  ipcMain.handle('settings:get', () => settings.getResolved());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const result = await settings.set(patch);
    // If the easydeal script path changed, rewrite the workspace's .mcp.json.
    await reapplyWorkspaceFromSettings();
    return result;
  });
  ipcMain.handle('settings:reset-field', async (_e, key) => {
    const result = await settings.resetField(key);
    await reapplyWorkspaceFromSettings();
    return result;
  });
  ipcMain.handle('settings:redetect', async () => {
    await settings.refreshDetection();
    await reapplyWorkspaceFromSettings();
    return settings.getResolved();
  });

  // settings 导出 / 导入 — settings.json 已经存在 %APPDATA%\EasyDeal\data\
  // 升级安装包不会动这里。但用户万一手动卸了又装、或者换电脑了，需要
  // 一份纯 JSON 备份。导出 = dialog 让用户存到一个他选的位置；导入 =
  // dialog 选个之前导出的 JSON 文件，merge 到当前 settings 里。
  ipcMain.handle('settings:export', async () => {
    if (!win) return { ok: false, error: '窗口不可用' };
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const r = await dialog.showSaveDialog(win, {
      title: '导出 EasyDeal 设置',
      defaultPath: `easydeal-settings-${ts}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      // settings.data 是用户实际写过的字段（不含 detected / userSet meta），
      // 导出这个最干净 — 导入时直接 deepMerge 进新机子的 data，detection
      // 重新跑一遍就行。
      const buf = JSON.stringify(settings.data, null, 2);
      await require('node:fs/promises').writeFile(r.filePath, buf, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('settings:import', async () => {
    if (!win) return { ok: false, error: '窗口不可用' };
    const r = await dialog.showOpenDialog(win, {
      title: '导入 EasyDeal 设置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      const buf = await require('node:fs/promises').readFile(r.filePaths[0], 'utf8');
      const incoming = JSON.parse(buf);
      if (!incoming || typeof incoming !== 'object') {
        return { ok: false, error: '文件不是合法的 settings JSON' };
      }
      // merge 模式 — 不直接替换，避免清掉新版增加的默认字段。用户带过来的
      // 字段覆盖现有同名项；新版独有的字段保留。
      await settings.set(incoming);
      await settings.refreshDetection();
      await reapplyWorkspaceFromSettings();
      return { ok: true, path: r.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // (settings:bootstrap-live-login IPC removed — the 实盘 MT5 登录 settings
  //  card was redundant with 「MT5 终端」card's 启动 MT5 终端 button. Live
  //  account login is MT5's own concern; we just detect & launch the install.)


  ipcMain.handle('settings:browse-dir', async (_e, opts = {}) => {
    if (!win) return null;
    // 0.3.210: 默认开 createDirectory + promptToCreate 让用户直接在浏览对话框里
    // 「新建文件夹」, 不用退出对话框先去资源管理器建. 一键下载 MT5 场景刚需 —
    // 用户要选「空目录」, 浏览到 D:\ 然后右键新建子文件夹是更自然的操作.
    const props = ['openDirectory'];
    if (opts.createDirectory !== false) props.push('createDirectory', 'promptToCreate');
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || '选择目录',
      defaultPath: opts.defaultPath,
      properties: props,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // 0.3.188: 多 MT5 实例管理 IPC
  // 0.3.195: running 检测改成「该 installDir 下的 terminal64.exe 实际在跑」(走 PowerShell
  //          Get-CimInstance 查 ExecutablePath), 之前是「有任何 terminal64.exe 在跑」 →
  //          多实例下所有 card 都会同时显「运行中」假阳性.
  // 0.3.197: 返回多一个 unbound_ea_count — active 实例 UI 显「+ N 个未绑定 EA」
  // 0.3.207: 返回 user_intent + externally_launched 标志, UI 用来:
  //   - intent=stopped → 卡片显「🔒 用户已关闭」锁定状态
  //   - intent=stopped 但 running=true → 用户在 EasyDeal 外面手动启动了, UI 弹
  //     「检测到 MT5 自启了, 切到运行状态？」让用户决定
  ipcMain.handle('mt5-instances:list', async () => {
    const items = settings.listMt5Instances();
    const activeId = settings.getResolved().activeMt5InstanceId
      || settings.data.activeMt5InstanceId
      || null;
    // 0.3.221: 一次性扫 workspace/strategies 顶层拿真实 EA stem 集合, 给下面 4
    // 个 count/list 当过滤白名单. 历史 records 里有但工作区已删 / backup 的不再
    // 显示在卡片"绑定 / 默认承接"列表里.
    let activeEaNames = null;
    try { activeEaNames = await strategies?.listActiveEaStems?.(); } catch {}
    const unboundCount = (() => { try { return strategies?.countUnboundEas?.(activeEaNames) || 0; } catch { return 0; } })();
    const unboundNames = (() => { try { return strategies?.listUnboundEaNames?.(activeEaNames) || []; } catch { return []; } })();
    // 0.3.221: 一次 WMI 扫描 (_scanAllMt5Procs 内 1s cache + 并发去重), 后面对每
    // 个 instance 的 _findMt5PidsForInstall 都查同一份内存 Map — 多实例不再
    // 撞 PowerShell concurrent limit / 偶发 timeout 返空导致误判已停止.
    const allProcs = await _scanAllMt5Procs();
    const out = [];
    let totalRunningMatched = 0;
    for (const it of items) {
      let running = false;
      try {
        if (_easydealLaunchedPidAlive(it.installDir)) {
          // EasyDeal 拉起的 MT5 → Node 原生瞬时查活, 不依赖慢 WMI/tasklist
          running = true;
          totalRunningMatched += 1;
        } else if (it.installDir) {
          const pids = await _findMt5PidsForInstall(it.installDir);
          running = pids.length > 0;
          if (running) totalRunningMatched += pids.length;
        }
      } catch {}
      // 0.3.189 Phase 2: 顺便统计绑了多少只 EA
      let eaCount = 0;
      let eaNames = [];
      try { eaCount = strategies?.countEasForInstance?.(it.id, activeEaNames) || 0; } catch {}
      try { eaNames = strategies?.listEaNamesForInstance?.(it.id, activeEaNames) || []; } catch {}
      const userIntent = it.user_intent || 'running';
      const externallyLaunched = userIntent === 'stopped' && running;
      // 0.4.41 防御: mounted_ea_name 对应的 EA 已被从 workspace 删除 → 视为 stale
      // mount 元数据 (cascade 漏清或外部直接删了 .mq5). 抹掉 mount_* 字段防止 stale
      // 账号信息 (mounted_login 等) 通过 IPC / MCP tool_result 泄漏给 AI. activeEaNames
      // = 上面 6750 已经为本次返回算好的 active EA 白名单, 直接复用.
      const safeOut = { ...it };
      if (safeOut.mounted_ea_name && activeEaNames && !activeEaNames.includes(safeOut.mounted_ea_name)) {
        for (const f of ['mounted_ea_name','mounted_symbol','mounted_period','mounted_at','mounted_login','mounted_server','mount_mode']) {
          if (f in safeOut) safeOut[f] = null;
        }
        safeOut._mounted_stale_cleared = true;
      }
      out.push({
        ...safeOut,
        user_intent: userIntent,
        is_active: it.id === activeId,
        running,
        ea_count: eaCount,
        ea_names: eaNames,    // 0.3.218: 具体名字
        externally_launched: externallyLaunched,
        lifecycle_state: _mt5Lifecycle.get(it.id)?.state || (running ? 'running' : 'stopped'),
        lifecycle_error: _mt5Lifecycle.get(it.id)?.lastError || null,
        actual_data_dir: _mt5Lifecycle.get(it.id)?.actualDataDir || null,
      });
    }
    // 0.3.286: elevation_mismatch detection — 用户 case (PID 7 个 MT5 在跑但
    // EasyDeal UI 显「6 已停止 + 正在启动」死循环). 根因: MT5 用管理员权限启动,
    // EasyDeal 普通权限 → Win32_Process.ExecutablePath 对管理员进程返 null →
    // PID 全进 __unknown__ bucket → _findMt5PidsForInstall(installDir) 全空 →
    // 每个 instance running=false. 配合 client is_admin=False 三条件确诊 elevation
    // mismatch, UI 弹 banner 提示用户操作 (要么 EasyDeal 升权要么 MT5 降权重启).
    let elevationMismatch = null;
    try {
      const unknownPids = allProcs.get('__unknown__') || [];
      const matchedNone = items.length > 0 && totalRunningMatched === 0;
      const hasUnknownProcs = unknownPids.length > 0;
      if (matchedNone && hasUnknownProcs) {
        const clientIsAdmin = await _isElevatedProcess().catch(() => null);
        if (clientIsAdmin === false) {
          elevationMismatch = {
            unknown_pid_count: unknownPids.length,
            unknown_pids: unknownPids.slice(0, 20),
            client_is_admin: false,
            advice: 'mt5_admin_easydeal_normal',
          };
        } else if (clientIsAdmin === null) {
          // 没法确定 client 权限 — 仍然给一个 "可能 elevation_mismatch" hint
          elevationMismatch = {
            unknown_pid_count: unknownPids.length,
            unknown_pids: unknownPids.slice(0, 20),
            client_is_admin: null,
            advice: 'powershell_path_unavailable_unknown_cause',
          };
        }
      }
    } catch (e) {
      console.warn('[mt5-instances:list] elevation_mismatch detect err:', e?.message || e);
    }
    // 0.3.289: 把 detected.mt5 也返给 UI — 用户 case: settings.mt5Instances 空 +
    // settings.mt5 也丢光, 但本机 MT5 装在 D:\mt5pinbar (注册表 / 默认路径 / tasklist
    // 都可能扫出来). UI 空状态显「📥 一键导入 detected 实例」按钮兜底, 用户不用
    // 知道「+ 添加实例」自己拼路径. 走 ensureDetected 强制刷一次注册表 + 默认路径
    // (15s 内有缓存就直接用, 没缓存 / 缓存过期才扫, 一般 <100ms).
    let detectedMt5 = null;
    try {
      if (out.length === 0) {
        // 只有空状态才花时间 ensureDetected — 已有实例的用户不需要这条 fallback.
        const r = await settings.ensureDetected({ maxAgeMs: 60_000 }).catch(() => null);
        const det = r?._meta?.detected || settings.detected || null;
        if (det && det.installDir) {
          detectedMt5 = {
            installDir: det.installDir,
            installDirSource: det.installDirSource || null,
            dataDir: det.dataDir || null,
            dataDirSource: det.dataDirSource || null,
          };
        }
      }
    } catch (e) {
      console.warn('[mt5-instances:list] detect mt5 for recovery err:', e?.message || e);
    }
    return { ok: true, items: out, active_id: activeId,
             unbound_ea_count: unboundCount,
             unbound_ea_names: unboundNames,   // 0.3.218
             elevation_mismatch: elevationMismatch,   // 0.3.286
             detected_mt5: detectedMt5 };   // 0.3.289
  });

  // 0.3.207: 用户在 EasyDeal 外面手动启动 MT5 后, 卡片上「检测到 MT5 自启了」对话框
  // 点「切到运行」时调这个, 把 user_intent 翻回 'running' + 清 flag
  ipcMain.handle('mt5-instances:adopt-external-launch', async (_e, payload = {}) => {
    const id = String(payload?.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    const inst = settings.listMt5Instances().find((it) => it.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    try {
      await settings.updateMt5Instance(id, { user_intent: 'running' });
      if (inst.installDir) _clearKillFlag(inst.installDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('mt5-instances:add', async (_e, payload = {}) => {
    try {
      const inst = await settings.addMt5Instance({
        name:       payload.name,
        installDir: payload.installDir,
        dataDir:    payload.dataDir,
        launchMode: payload.launchMode,
        notes:      payload.notes,
      });
      try { await reapplyWorkspaceFromSettings(); } catch (e) { console.warn('[mt5-instances] reapply failed:', e?.message || e); }
      // 0.3.191 Phase 3: 让 OG pool 同步起新实例的 OrderGuard 子进程
      try { await ogPool?.reconcile(); } catch (e) { console.warn('[mt5-instances] og reconcile failed:', e?.message || e); }
      return { ok: true, instance: inst };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('mt5-instances:remove', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    try {
      const r = await settings.removeMt5Instance(id);
      try { await reapplyWorkspaceFromSettings(); } catch (e) { console.warn('[mt5-instances] reapply failed:', e?.message || e); }
      // 0.3.191 Phase 3: 同步停掉该实例的 OG 子进程
      try { await ogPool?.reconcile(); } catch (e) { console.warn('[mt5-instances] og reconcile failed:', e?.message || e); }
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('mt5-instances:update', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    try {
      const inst = await settings.updateMt5Instance(id, payload.patch || {});
      try { await reapplyWorkspaceFromSettings(); } catch (e) { console.warn('[mt5-instances] reapply failed:', e?.message || e); }
      // 0.3.191 Phase 3: installDir 改了就让 OG pool 重启对应实例 (现在通过 reconcile 不会重启已存在的 inst,
      // 但 listMt5Instances() 返回新的 installDir 已经在 ogPool 配置里; 简单起见, installDir 改时手动重启)
      if (payload.patch?.installDir && ogPool) {
        const og = ogPool.getByInstanceId(id);
        if (og && og.mt5InstallDir !== payload.patch.installDir) {
          try {
            console.log(`[orderguard-pool] installDir changed for ${id}, restarting OG`);
            await og.stop();
            ogPool._pool.delete(id);
            await ogPool.reconcile();
          } catch (e) { console.warn('[orderguard-pool] installDir-change restart failed:', e?.message || e); }
        }
      }
      return { ok: true, instance: inst };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('mt5-instances:set-active', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    try {
      const inst = await settings.setActiveMt5Instance(id);
      try { await reapplyWorkspaceFromSettings(); } catch (e) { console.warn('[mt5-instances] reapply failed:', e?.message || e); }
      return { ok: true, instance: inst };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 启动指定 instance 的 MT5
  // 0.3.204: 用户反馈「点启动 MT5 直接闪退」, log handler 没接到 ❌ → 怀疑 native crash.
  // 加 verbose trace log + 每步独立 try/catch, 下次崩了能从 trace 看到崩在哪步.
  ipcMain.handle('mt5-instances:launch', async (_e, payload = {}) => {
    _traceLog('mt5-launch IPC ENTRY', `id=${payload?.id}`);
    try {
      const id = String(payload?.id || '').trim();
      if (!id) return { ok: false, error: 'id 必填' };
      const inst = settings.listMt5Instances().find((it) => it.id === id);
      if (!inst) return { ok: false, error: '实例不存在' };
      if (!inst.installDir) return { ok: false, error: '该实例没配 installDir' };
      const checked = validateMt5Instance(inst, { siblings: settings.listMt5Instances() });
      if (!checked.ok) {
        const error = checked.errors.join('；');
        _mt5Lifecycle.set(id, { ...(_mt5Lifecycle.get(id) || {}), state: 'error', lastError: error });
        return { ok: false, error };
      }
      _traceLog('mt5-launch resolved instance', `name=${inst.name} installDir=${inst.installDir} dataDir=${inst.dataDir} mode=${inst.launchMode}`);
      // 0.3.205: 清 kill-flag — 用户主动启动 → OG 可以重新 attach 了
      try { _clearKillFlag(inst.installDir); } catch {}
      // 0.3.209: 写 launch-flag — MT5 boot 期间所有 init 调用方一律跳过 30 秒
      // 防 SDK 在 boot 中间被叫去 init 时误判「terminal not running」再 launch 一个
      try { _writeLaunchFlag(inst.installDir); } catch {}
      _mt5LaunchAuthorization.set(id, Date.now() + 180_000);
      _mt5Lifecycle.set(id, { ...(_mt5Lifecycle.get(id) || {}), state: 'starting', lastError: null });
      const r = await launchMt5(inst);
      if (r?.ok) {
        try { await settings.updateMt5Instance(id, { user_intent: 'running' }); } catch (e) {
          console.warn('[mt5-launch] persist user_intent failed:', e?.message || e);
        }
      } else {
        _mt5LaunchAuthorization.delete(id);
        _mt5Lifecycle.set(id, { ...(_mt5Lifecycle.get(id) || {}), state: 'error', lastError: r?.error || '启动失败' });
        try { _clearLaunchFlag(inst.installDir); _writeKillFlag(inst.installDir); } catch {}
        try { await settings.updateMt5Instance(id, { user_intent: 'stopped' }); } catch {}
      }
      _traceLog('mt5-launch DONE', `ok=${r?.ok} pid=${r?.pid}`);
      return r;
    } catch (e) {
      _traceLog('mt5-launch UNCAUGHT', String(e?.stack || e?.message || e).slice(0, 500));
      return { ok: false, error: 'launch 异常: ' + (e?.message || String(e)) };
    }
  });

  // 0.3.205: kill-flag helpers — 文件落到 userData/data/, OG (Python) 读这个判断
  // 「用户主动关了 MT5 别 attach」. launch IPC 启动时清掉这个文件.
  // 0.3.209: launch-flag helpers — 同款机制反过来用:「MT5 刚 spawn, 还在 boot,
  //   所有 init 调用方都跳过 30 秒」. 修「点启动后 MT5 boot 期间被 account-info /
  //   OG poll 同时调 mt5.initialize, SDK 误判 'not running' 再 launch 一个」race.
  // 两组 helper 都挂 global 防 registerIpc 多次调用重复定义.
  if (!global._killFlagPath) {
    global._killFlagPath = function (installDir) {
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5').update(String(installDir || '').toLowerCase()).digest('hex').slice(0, 12);
      return path.join(app.getPath('userData'), 'data', `mt5-killed-${hash}.flag`);
    };
    global._writeKillFlag = function (installDir) {
      const fp = global._killFlagPath(installDir);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, String(Date.now()), 'utf8');
      console.log('[kill-flag] wrote', fp);
    };
    global._clearKillFlag = function (installDir) {
      const fp = global._killFlagPath(installDir);
      try { fs.unlinkSync(fp); console.log('[kill-flag] cleared', fp); } catch {}
    };
    // 0.3.209 launch-flag
    global._launchFlagPath = function (installDir) {
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5').update(String(installDir || '').toLowerCase()).digest('hex').slice(0, 12);
      return path.join(app.getPath('userData'), 'data', `mt5-launching-${hash}.flag`);
    };
    global._writeLaunchFlag = function (installDir) {
      const fp = global._launchFlagPath(installDir);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, String(Date.now()), 'utf8');
      console.log('[launch-flag] wrote', fp);
    };
    // Lifecycle v2: 300s is the crash fallback for an explicit restart flow.
    // 正常 attach 流程 Python 显式 write+clear flag, 不依赖时间过期; 但 attach
    // Python 子进程崩溃 / 卡死时 flag 残留, 这里 grace 大点避免一直卡住其它 service.
    // Normal completion clears the flag; age is only a stale-file fallback.
    global._isLaunchingRecent = function (installDir, graceMs = 300000) {
      try {
        const fp = global._launchFlagPath(installDir);
        const stat = fs.statSync(fp);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < graceMs) return true;
        // 过期 → 删掉防累积
        try { fs.unlinkSync(fp); } catch {}
        return false;
      } catch { return false; }
    };
    global._clearLaunchFlag = function (installDir) {
      const fp = global._launchFlagPath(installDir);
      try { fs.unlinkSync(fp); } catch {}
    };
  }
  const _killFlagPath = global._killFlagPath;
  const _writeKillFlag = global._writeKillFlag;
  const _clearKillFlag = global._clearKillFlag;
  const _writeLaunchFlag = global._writeLaunchFlag;
  const _isLaunchingRecent = global._isLaunchingRecent;
  const _clearLaunchFlag = global._clearLaunchFlag;

  // 0.3.195: 关闭指定 instance 的 MT5 — 找到 exe path 匹配该 installDir 的 terminal64.exe
  // 进程然后 taskkill /PID. 不是无脑杀所有 terminal64 (多实例时会误杀别人).
  // 0.3.205: 写 kill-flag — OG 看到这文件就跳过 mt5.initialize 不再尝试重连.
  //          根因: mt5.initialize(path=X) 即使有 psutil 前置守护, SDK 检测到
  //          process 正在 dying 时仍可能 launch 一个新的 terminal64.exe. 用文件
  //          handshake 让 OG 明确知道「用户主动关了, 暂时别 attach」.
  ipcMain.handle('mt5-instances:kill', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    const inst = settings.listMt5Instances().find((it) => it.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!inst.installDir) return { ok: false, error: '该实例没配 installDir' };

    // 0.3.205: 先写 kill-flag, 再 taskkill — 保证 OG 下一次 poll 能看到 flag
    // 0.3.209: kill 跟 launch 是互斥的, 清掉 launch-flag (mutex)
    try {
      _writeKillFlag(inst.installDir);
      _clearLaunchFlag(inst.installDir);
    } catch (e) {
      console.warn('[mt5-instances:kill] write kill-flag failed (continuing):', e?.message || e);
    }
    // 0.3.207: 持久化 user_intent=stopped — 跨 EasyDeal 重启保留. 装新版后这只
    // 实例仍是「用户希望它停」的状态, 自启动 hooks 会重写 kill-flag 让 OG 不 attach.
    try { await settings.updateMt5Instance(id, { user_intent: 'stopped' }); } catch (e) {
      console.warn('[mt5-instances:kill] persist user_intent failed:', e?.message || e);
    }
    _mt5LaunchAuthorization.delete(id);
    _mt5RestartAuthorization.delete(id);
    _mt5Lifecycle.set(id, { ...(_mt5Lifecycle.get(id) || {}), state: 'stopping', lastError: null });

    const pids = await _findMt5PidsForInstall(inst.installDir);
    if (!pids.length) {
      _setMt5Lifecycle(id, { state: 'stopped', pids: [], seenRunning: false, misses: 0 });
      return { ok: true, killed: 0, message: '该实例的 MT5 不在跑' };
    }
    const cp = require('node:child_process');
    // 1.2.3: 先优雅关(taskkill 不带 /F = 发 WM_CLOSE, MT5 正常退出时才会把
    // 「刚登录的账号凭据 / 图表 / profile」写盘), 最多等 8s, 没退的再 /F 强杀。
    // 之前直接 /F: 老 MT5 凭据早落盘无感, 但刚登录几分钟的(用户 4 副本实锤)
    // 凭据没写盘就被杀 → 重启全掉号逐个重登。跟 python _kill_mt5_processes
    // 的 gentle_first 行为对齐。
    for (const pid of pids) {
      try { cp.execSync(`taskkill /PID ${pid}`, { stdio: 'ignore' }); } catch {}
    }
    const _aliveOf = (list) => list.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const deadline = Date.now() + 8000;
    let remaining = _aliveOf(pids);
    while (remaining.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      remaining = _aliveOf(remaining);
    }
    let killed = pids.length - remaining.length;
    for (const pid of remaining) {
      try {
        cp.execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        killed++;
      } catch (e) {
        console.warn('[mt5-instances:kill] taskkill', pid, 'failed:', e.message);
      }
    }
    // bust account-info cache 这样卡片不显已缓存的过时数据
    _accountInfoCache?.delete?.(id);
    _allMt5ProcsCache = null;
    _setMt5Lifecycle(id, { state: 'stopped', pids: [], seenRunning: false, misses: 0 });
    return { ok: true, killed, pids };
  });

  // 0.3.220: 「显示窗口」— 把指定实例的 MT5 主窗口拉到前台.
  // 老版本 (0.3.195 ~ 0.3.219) 这里是「暂停交易」走 Ctrl+E 注入切 MT5 算法交易
  // 开关. 但 Win11 22H2+ 的 UIPI 经常拒 SetForegroundWindow, 加上「通过外部
  // Python API 禁用算法交易」选项一旦勾着切了也会被 EasyDeal 5s 拉账户信息
  // 自动反弹 → 用户体验很糟. 干脆退一步, 只把窗口拉前台, 让用户自己点工具
  // 栏的「▶ 算法交易」按钮手动切 — 简单可靠, 不再依赖键盘事件注入.
  // 0.3.245: 用户 Win11 22H2+ 撞 try1+try2 全拒. 加 ALT 按键 trick / 最小化恢复
  // / SwitchToThisWindow 三个新 fallback, 5 重 try (见 _bringWindowToFront).
  ipcMain.handle('mt5-instances:show-window', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id 必填' };
    const inst = settings.listMt5Instances().find((it) => it.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    const pids = await _findMt5PidsForInstall(inst.installDir);
    if (!pids.length) return { ok: false, error: '该实例的 MT5 未运行 — 先点「▶ 启动 MT5」' };
    const res = await _bringWindowToFront(pids[0]);
    if (!res.ok) {
      const stepHints = {
        'find_window': 'MT5 主窗口对系统不可见 (可能最小化到托盘 / 虚拟桌面)',
        'set_foreground_failed': 'Win11 UIPI 把 5 重 fallback 全拒了 — 请手动 Alt+Tab / 任务栏点 MT5 图标切过去',
        'powershell_error': 'PowerShell 子进程异常退出',
        'timeout': 'PowerShell 5s 内没完成',
      };
      return {
        ok: false,
        error: res.step || 'show_window_failed',
        hint: stepHints[res.step] || `拉前台失败 (${res.step})`,
        raw_error: res.detail || res.stderr || null,
      };
    }
    return { ok: true, target_pid: pids[0], via: res.via || 'unknown' };
  });

  // 0.3.190 Phase 2.5: 拉某实例的账户实时信息 (login / server / balance / equity / profit).
  // 走 python one-shot 子进程, mt5.initialize(path=<terminal64.exe>) 连到该实例,
  // 返回 account_info 然后 shutdown. 实例没运行 → init_failed → 卡片显「未连接」.
  // 30s timeout, 单进程顺序跑避免几个 MT5 同时被 MetaTrader5.dll 抢初始化.
  const _accountInfoCache = new Map();   // id → { ts, data }
  const _ACCOUNT_INFO_TTL = 5 * 1000;    // 5s — 不太频繁打扰 MT5, 也不会让用户看到太旧的数字
  let _accountInfoQueue = Promise.resolve();

  // 0.3.220: server-side metric cache 让卡片「累计盈利」跟排行榜口径一致.
  // 客户端 Python 自己算的 balance - net_funding 跟服务端 compute_metric()
  // (account_level_net = bal_end - invested_capital) 算法有差异 — 不同 broker
  // history_deals_get 范围 / DEAL_TYPE 分类 / anchor 起点 都不一样. 直接调
  // server /v1/metric/me?account=<login> 拿权威值, 60s TTL cache.
  // _metricCache: key = inst.id, value = { ts, pnl_usd: number|null }
  const _metricCache = new Map();
  const _METRIC_TTL = 60 * 1000;
  async function _refreshAccountMetricInBg(instId, accountLogin) {
    if (!accountLogin) return;
    const cached = _metricCache.get(instId);
    if (cached && (Date.now() - cached.ts) < _METRIC_TTL) return;   // 已 fresh
    const tok = license._activeToken();
    if (!tok) return;   // 没登录
    try {
      const qs = new URLSearchParams({
        token: tok, account: String(accountLogin),
      }).toString();
      const r = await serverApi.get(`/v1/metric/me?${qs}`);
      if (r && r.ok && r.data) {
        // server compute_metric() 返 {pnl: {usd, account_level_net, ea_level, ...}}
        // pnl.usd 是 leaderboard 显的那个数 (0.5.35 后 = account_level_net = bal_end - invested_capital)
        const pnl = r.data.pnl || {};
        const v = (typeof pnl.usd === 'number') ? pnl.usd
                : (typeof pnl.account_level_net === 'number') ? pnl.account_level_net
                : (typeof pnl.ea_level === 'number') ? pnl.ea_level
                : null;
        _metricCache.set(instId, { ts: Date.now(), pnl_usd: v });
      }
    } catch (e) {
      // silently fail — 客户端 fallback 算的值还在
    }
  }
  ipcMain.handle('mt5-instances:account-info', async (_e, payload = {}) => {
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'id required' };
    const inst = (settings.listMt5Instances?.() || []).find((it) => it.id === id);
    if (!inst) return { ok: false, error: 'instance not found' };

    // cache check
    const cached = _accountInfoCache.get(id);
    if (cached && Date.now() - cached.ts < _ACCOUNT_INFO_TTL) {
      return cached.data;
    }

    // serialized queue — MT5 python SDK has trouble with concurrent initialize() to different terminals
    _accountInfoQueue = _accountInfoQueue.then(async () => {
      const exe = path.join(inst.installDir || '', 'terminal64.exe');
      if (!fs.existsSync(exe)) {
        const data = { ok: false, error: 'terminal64.exe 不存在', login: null };
        _accountInfoCache.set(id, { ts: Date.now(), data });
        return data;
      }
      // 0.3.197 BUG FIX: 修「关闭 MT5 后又被自动启动」根因 — mt5.initialize(path=...)
      // 如果终端没在跑会自动启动它. 用户点「关闭 MT5」后下一次 3s 轮询触发
      // account-info → mt5.initialize 把 MT5 重新拉起来. 这里先确认进程真的
      // 在跑才调 SDK, 不在跑直接返 not_running 不要 launch.
      // 0.3.205: 也查 kill-flag — 用户主动关了 → 即使 psutil 还误判 process 在
      // (race 窗口), 仍跳过 init.
      try {
        if (fs.existsSync(_killFlagPath(inst.installDir))) {
          const data = { ok: false, err: 'killed_by_user', message: '用户主动关了 MT5, 等再次启动后才连' };
          _accountInfoCache.set(id, { ts: Date.now(), data });
          return data;
        }
      } catch {}
      // 0.3.212: 简化守护 — 「进程存在 → init, 不存在 → skip」.
      // SDK 只在我们调 mt5.initialize 时才有机会 launch, 不调它就不会启动新 MT5.
      // 不需要 60s age 硬编码. launch-flag 仅用于「刚 spawn psutil 还没扫到」短窗口.
      try {
        if (_isLaunchingRecent(inst.installDir, 5000)) {
          const data = { ok: false, err: 'init_failed', message: 'MT5 启动中' };
          _accountInfoCache.set(id, { ts: Date.now(), data });
          return data;
        }
      } catch {}
      try {
        const scan = await _findMt5PidsForInstallStrict(inst.installDir);
        if (!scan.scanOk || scan.unknownPids.length) {
          const data = { ok: false, err: 'process_identity_unavailable', message: '无法安全确认 MT5 进程路径' };
          _accountInfoCache.set(id, { ts: Date.now(), data });
          return data;
        }
        if (!scan.pids.length) {
          const data = { ok: false, err: 'not_running' };
          _accountInfoCache.set(id, { ts: Date.now(), data });
          return data;
        }
      } catch (e) {
        const data = { ok: false, err: 'process_scan_failed', message: String(e?.message || e) };
        _accountInfoCache.set(id, { ts: Date.now(), data });
        return data;
      }
      const pythonBin = settings.getResolved().pythonBin || 'python';
      const code = `
import sys, json, os
try:
    sys.path.insert(0, ${JSON.stringify(resolveBundledFile('python'))})
    import MetaTrader5 as mt5
    import mt5_lifecycle as _lc
    if not _lc.initialize_checked(mt5, path=${JSON.stringify(exe)}, retries=0):
        print(json.dumps({"ok": False, "err": "attach_blocked", "code": _lc.LAST_ERROR}))
        sys.exit(0)
    t = mt5.terminal_info() if hasattr(mt5, 'terminal_info') else None
    def _norm(p): return os.path.normcase(os.path.normpath(str(p or ''))).rstrip('\\\\/')
    expected_install = ${JSON.stringify(inst.installDir || '')}
    expected_data = ${JSON.stringify(inst.dataDir || '')}
    actual_install = getattr(t, 'path', '') if t is not None else ''
    actual_data = getattr(t, 'data_path', '') if t is not None else ''
    if _norm(actual_install) != _norm(expected_install) or _norm(actual_data) != _norm(expected_data):
        try: mt5.shutdown()
        except: pass
        print(json.dumps({"ok": False, "err": "instance_identity_mismatch", "expected_path": expected_install, "actual_path": actual_install, "expected_data_path": expected_data, "actual_data_path": actual_data}))
        sys.exit(0)
    a = mt5.account_info()
    # 0.3.195: 同时拉 terminal_info — trade_allowed = MT5「算法交易」工具栏按钮状态
    # 0.3.217: 加 tradeapi_disabled — 「通过外部 Python API 禁用算法交易」选项
    # 勾着时 = True, 这个选项=每次 Python (mt5.initialize) 连 MT5 会强制把
    # trade_allowed 关掉. EasyDeal 5s 拉一次账户信息会被它误伤 — 用户点
    # ⏸ 暂停/▶ 恢复 看似不生效就是这个根因.
    trade_allowed = bool(t.trade_allowed) if (t is not None and hasattr(t, 'trade_allowed')) else None
    tradeapi_disabled = bool(t.tradeapi_disabled) if (t is not None and hasattr(t, 'tradeapi_disabled')) else None

    # 0.3.218: 累计盈利 (realized) = balance - net_funding
    # net_funding = sum(history_deals.profit where type=DEAL_TYPE_BALANCE)
    # DEAL_TYPE_BALANCE=2 (入金正/出金负). 失败不阻塞主流程.
    # 0.3.220: 这是 fallback 值. main.js 会用 server /v1/metric/me?account=<login>
    # 返的 pnl.usd (= account_level_net, 跟排行榜同源) 覆盖. 服务端拿不到 (license
    # 未登录 / network 挂) 时仍显这个本地算的.
    # 0.3.250 (用户续报): 0.3.247 改的 "没 trade 时显 0" 只 cover 一半 — LZH
    # 账户有交易记录, 走 else 分支按 balance - net_funding 算, demo broker 多次
    # reset 累积 net_funding=20000 / balance=10000 → 仍显 -10000. 真正修法:
    # 改成直接 SUM(trade deals profit + swap + commission). 这是已实现交易盈利,
    # 跟 broker 怎么 reset 余额完全无关 — 跟 MT5「账户历史」-> "Profit" 标签同源,
    # 也跟 server raw_ea_pnl 同源. 真账户 / demo 账户都准.
    # 没 trade → SUM=0 (跟之前修法等价). type=0 BUY / type=1 SELL.
    cumulative_profit = None
    try:
        from datetime import datetime
        deals = mt5.history_deals_get(datetime(1970,1,1), datetime.now())
        if deals is not None:
            trade_deals = [d for d in deals if d.type in (0, 1)]
            cumulative_profit = sum(
                float(d.profit)
                + float(getattr(d, 'swap', 0) or 0)
                + float(getattr(d, 'commission', 0) or 0)
                for d in trade_deals
            )
        elif a is not None:
            # broker 不让查全期 history → 假设没出入金 (cumulative_profit ≈ 0 +
            # 当前浮动). 比显「—」让用户看着像 bug 强.
            cumulative_profit = float(a.profit)
    except Exception:
        pass

    # 0.3.218: 点差 = 当前持仓 symbol 的平均 spread (points). 没持仓 = None
    avg_spread = None
    try:
        positions = mt5.positions_get()
        if positions:
            spreads = []
            seen = set()
            for p in positions:
                if p.symbol in seen: continue
                seen.add(p.symbol)
                si = mt5.symbol_info(p.symbol)
                if si is not None and getattr(si, 'spread', 0) > 0:
                    spreads.append(int(si.spread))
            if spreads:
                avg_spread = round(sum(spreads) / len(spreads), 1)
    except Exception:
        pass

    if a is not None:
        out = {
            "ok": True,
            "login": a.login,
            "server": a.server,
            "balance": float(a.balance),
            "equity": float(a.equity),
            "profit": float(a.profit),
            "margin": float(a.margin) if hasattr(a, 'margin') else 0.0,
            "margin_level": float(a.margin_level) if hasattr(a, 'margin_level') else 0.0,
            "leverage": int(a.leverage) if hasattr(a, 'leverage') else 0,
            "currency": a.currency,
            "name": a.name if hasattr(a, 'name') else '',
            "trade_allowed": trade_allowed,
            "tradeapi_disabled": tradeapi_disabled,
            "cumulative_profit": cumulative_profit,   # 0.3.218: balance - net_funding
            "avg_spread": avg_spread,                  # 0.3.218: 持仓 symbol 平均点差
            "actual_data_path": actual_data,
        }
        print(json.dumps(out))
    else:
        print(json.dumps({"ok": False, "err": "no_account"}))
    try: mt5.shutdown()
    except: pass
except Exception as e:
    print(json.dumps({"ok": False, "err": str(e)}))
`;
      return await new Promise((resolve) => {
        const cp = require('node:child_process');
        const child = cp.spawn(pythonBin, ['-c', code], {
          windowsHide: true,
          timeout: 8000,
          env: {
            ...process.env,
            EASYDEAL_MT5_INSTALL_DIR: inst.installDir || '',
            EASYDEAL_MT5_DATA_DIR: inst.dataDir || '',
            EASYDEAL_MT5_LAUNCH_MODE: inst.launchMode || '',
            EASYDEAL_MT5_INSTANCE_ID: inst.id || '',
            EASYDEAL_MT5_ALLOW_LAUNCH: '0',
            EASYDEAL_DATA_DIR: path.join(app.getPath('userData'), 'data'),
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => stdout += d.toString());
        child.stderr?.on('data', (d) => stderr += d.toString());
        child.on('close', () => {
          let data;
          try {
            // 取最后一行 — mt5.initialize 可能往 stdout 印冷启动 log
            const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
            data = JSON.parse(lines[lines.length - 1] || '{}');
          } catch {
            data = { ok: false, error: 'parse failed', stdout, stderr };
          }
          // 0.3.220: server metric 覆盖 Python 算的 fallback 值 — 让卡片显示
          // 跟排行榜同源的 metric_pnl_usd. 后台异步刷新 (60s TTL), 当前请求
          // 用最近一次 cached metric 覆盖.
          if (data?.ok && data.login) {
            const metricCached = _metricCache.get(id);
            if (metricCached && typeof metricCached.pnl_usd === 'number') {
              data.cumulative_profit = metricCached.pnl_usd;
              data.cumulative_profit_source = 'server_metric';
            }
            // fire-and-forget 后台刷新, 不阻塞当前 response
            _refreshAccountMetricInBg(id, data.login).catch(() => {});
            // 0.3.225: 持久化 account.login 到 settings.mt5Instances[id].cached_account_login.
            // 之后 mkt:my-stats build ea_accounts map 时即使该 instance 没在跑也能拿到 login,
            // 传给 server compute_metric, 不再回落到反推老历史 deals 的 account.
            try {
              const currentInst = settings.listMt5Instances?.()?.find?.((it) => it.id === id);
              if (currentInst && currentInst.cached_account_login !== Number(data.login)) {
                settings.updateMt5Instance?.(id, {
                  cached_account_login: Number(data.login),
                  cached_account_server: String(data.server || ''),
                  cached_account_at: new Date().toISOString(),
                }).catch?.(() => {});
              }
            } catch {}
          }
          _accountInfoCache.set(id, { ts: Date.now(), data });
          resolve(data);
        });
        child.on('error', (e) => {
          const data = { ok: false, error: String(e.message || e) };
          _accountInfoCache.set(id, { ts: Date.now(), data });
          resolve(data);
        });
      });
    });
    return _accountInfoQueue;
  });

  // 已下载检测 — 一键安装时复用本地缓存
  // 检查 target_dir/MetaTrader 5/terminal64.exe (老 nested 布局) 或 target_dir/terminal64.exe
  // (0.3.193 新 flat 布局) 是否存在 → 直接复用, 不重新下载
  ipcMain.handle('mt5-instances:check-installed', async (_e, payload = {}) => {
    const targetDir = String(payload.target_dir || '').trim();
    if (!targetDir) return { ok: false, error: 'target_dir 必填' };
    // 1. flat 布局: target_dir/terminal64.exe
    const flatExe = path.join(targetDir, 'terminal64.exe');
    if (fs.existsSync(flatExe)) {
      return { ok: true, installed: true, layout: 'flat', mt5_install_dir: targetDir };
    }
    // 2. nested 布局 (老): target_dir/MetaTrader 5/terminal64.exe
    const nestedDir = path.join(targetDir, 'MetaTrader 5');
    const nestedExe = path.join(nestedDir, 'terminal64.exe');
    if (fs.existsSync(nestedExe)) {
      return { ok: true, installed: true, layout: 'nested', mt5_install_dir: nestedDir };
    }
    return { ok: true, installed: false, layout: null, mt5_install_dir: null };
  });

  // 0.3.193: 检查目标目录状态 — 给 mt5-view「一键下载安装」用.
  // 返回 { exists, is_empty, has_mt5, layout, mt5_install_dir }, 让 UI 决定:
  //   - has_mt5: 已装过 → 复用 (不下载)
  //   - !exists OR is_empty: 可装 (空目录欢迎下载安装)
  //   - exists & !is_empty & !has_mt5: 拒装 (目录非空但又不是 MT5)
  ipcMain.handle('mt5-instances:check-target-dir', async (_e, payload = {}) => {
    const targetDir = String(payload.target_dir || '').trim();
    if (!targetDir) return { ok: false, error: 'target_dir 必填' };
    const exists = fs.existsSync(targetDir);
    let is_empty = !exists;
    let has_mt5 = false;
    let layout = null;
    let mt5_install_dir = null;
    if (exists) {
      let entries = [];
      try { entries = fs.readdirSync(targetDir).filter((n) => n !== '.DS_Store' && n !== 'desktop.ini'); } catch {}
      is_empty = entries.length === 0;
      // flat?
      if (fs.existsSync(path.join(targetDir, 'terminal64.exe'))) {
        has_mt5 = true; layout = 'flat'; mt5_install_dir = targetDir;
      } else if (fs.existsSync(path.join(targetDir, 'MetaTrader 5', 'terminal64.exe'))) {
        has_mt5 = true; layout = 'nested'; mt5_install_dir = path.join(targetDir, 'MetaTrader 5');
      }
    }
    return { ok: true, exists, is_empty, has_mt5, layout, mt5_install_dir };
  });
  ipcMain.handle('settings:browse-file', async (_e, opts = {}) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || '选择文件',
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // -- first-login onboarding wizard ----------------------------------------
  // 新序列号首次登录后自动跑一次：让 Claude 用 7 步对话引导用户完成 MT5
  // 路径 + EA 部署 + 策略说明 + 监控配置。每个 license key 只跑一次（用户
  // 想重跑就手动点「教程」标签的「重新引导」按钮，IPC 见 reset-onboarding）。
  // 状态文件：<userData>/onboarding-state.json {keys: ["EZDL-XXXX-YYYY", ...]}
  function _onboardingStatePath() {
    return path.join(app.getPath('userData'), 'onboarding-state.json');
  }
  async function _loadOnboardingState() {
    try {
      const raw = await require('node:fs/promises').readFile(_onboardingStatePath(), 'utf8');
      const j = JSON.parse(raw);
      return Array.isArray(j?.keys) ? new Set(j.keys) : new Set();
    } catch { return new Set(); }
  }
  async function _saveOnboardingState(set) {
    try {
      await require('node:fs/promises').writeFile(
        _onboardingStatePath(),
        JSON.stringify({ keys: [...set] }, null, 2), 'utf8',
      );
    } catch (e) { console.warn('[onboarding] save state failed:', e?.message || e); }
  }
  // 是否需要触发首次引导。早期 0.1.x 没记 onboarding-state，0.1.48+ 才加上
  // 这个状态文件 —— 老用户升上来后 set 是空的，被错判成「新序列号」会再次
  // 弹引导。0.2.2 起：如果用户已经有 mt5.installDir 设置（明显用过），自动
  // 把当前 license key 计入 onboarding 已完成集合，跳过引导。
  ipcMain.handle('app:onboarding-status', async () => {
    const lic = license.getStatus();
    if (!lic?.key) return { needed: false, reason: 'no_license' };
    const set = await _loadOnboardingState();
    if (set.has(lic.key)) return { needed: false, key: lic.key };
    // Backfill: 老用户上调，已有 MT5 install 设置说明早就走过 EasyDeal 的
    // 配置流程了，没必要再让 Claude 把 7 步引导从头说一遍。
    try {
      const usedSignals = !!(settings?.getResolved()?.mt5?.installDir);
      if (usedSignals) {
        set.add(lic.key);
        await _saveOnboardingState(set);
        return { needed: false, key: lic.key, reason: 'backfilled_existing_user' };
      }
    } catch {}
    return { needed: true, key: lic.key };
  });
  ipcMain.handle('app:request-onboarding', async () => {
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const lic = license.getStatus();
    if (!lic?.key) return { ok: false, error: '未登录' };
    const prompt = buildOnboardingPrompt();
    chat.send(prompt).catch((e) => console.error('[onboarding] chat.send failed:', e));
    // 标记已启动，避免重复触发。即便用户中途退出，也不主动二次弹（让用户
    // 自己手动调起，避免烦扰）。
    const set = await _loadOnboardingState();
    set.add(lic.key);
    await _saveOnboardingState(set);
    return { ok: true };
  });
  ipcMain.handle('app:reset-onboarding', async () => {
    const lic = license.getStatus();
    if (!lic?.key) return { ok: false, error: '未登录' };
    const set = await _loadOnboardingState();
    set.delete(lic.key);
    await _saveOnboardingState(set);
    return { ok: true };
  });

  // -- ask agent for the install guide (called from settings tab when MT5 is missing)
  ipcMain.handle('app:request-mt5-install-guide', async () => {
    console.log('[ipc] request-mt5-install-guide called; chat.busy =', chat.isBusy());
    if (chat.isBusy()) {
      return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    }
    const prompt = buildMt5InstallGuidePrompt();
    chat.send(prompt).catch((e) => console.error('[install-guide] chat.send failed:', e));
    return { ok: true };
  });

  // 0.3.182: 「一键下载并安装 MT5」— 从 OSS 拉预打包 MT5 portable zip,
  // 解压到 target dir, 自动配 settings.mt5.installDir.
  // OSS URL: easydeal/MetaTrader5.zip (~477MB, 已装好的 portable copy 含 terminal64.exe 等)
  ipcMain.handle('app:download-and-install-mt5', async (_e, opts) => {
    if (COMMUNITY_EDITION) return { ok: false, error: '社区版不提供 MT5 下载，请在券商个人专区下载安装 MT5' };
    const targetDir = String(opts?.target_dir || '').trim();
    if (!targetDir) return { ok: false, error: 'target_dir 必填' };
    // 0.3.193: flat=true (mt5-view 新流程) — 文件直接落到 target_dir 下不再多一层
    // "MetaTrader 5/" 子目录. 也要求 target_dir 是空目录 (或不存在 — 会建).
    // flat=false (legacy, settings-view 一键安装) — 老 nested 布局, settings.mt5 也会被自动设.
    const flat = opts?.flat === true;

    // flat 模式下先校验目标目录: 不存在 OK (会建), 存在则必须空 (跳过隐藏小文件)
    if (flat) {
      if (fs.existsSync(targetDir)) {
        try {
          const entries = fs.readdirSync(targetDir).filter((n) => n !== '.DS_Store' && n !== 'desktop.ini');
          if (entries.length > 0) {
            return { ok: false, error: '目标目录非空, 请选一个空目录或新建一个' };
          }
        } catch (e) {
          return { ok: false, error: `读目标目录失败: ${e?.message || e}` };
        }
      }
    }

    const url = 'https://xszyou.oss-cn-beijing.aliyuncs.com/easydeal/MetaTrader5.zip';
    // 0.3.218: 改用持久 cache 目录, 不再每次解压完就删 zip. 下次添加新实例可
    // 直接复用本地缓存, 不浪费 456MB OSS 流量. 缓存校验用 HEAD Content-Length —
    // 等于本地大小 = 可信; 不等 = 服务端 zip 已更新, 重下.
    const cacheDir = path.join(app.getPath('userData'), 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const tempZip = path.join(cacheDir, 'MetaTrader5.zip');

    const _emit = (kind, payload) => {
      try { win?.webContents.send('mt5-install-progress', { kind, ...payload }); } catch {}
    };

    // 0.3.218: 1a. 先 check 本地缓存能否复用
    let useCache = false;
    if (fs.existsSync(tempZip)) {
      const localSize = (() => { try { return fs.statSync(tempZip).size; } catch { return 0; } })();
      if (localSize > 100 * 1024 * 1024) {   // 至少 100MB 算合理 (完整 zip ~456MB)
        _emit('phase', { phase: 'checking-cache', message: '检查本地缓存是否可复用...' });
        try {
          const https = require('node:https');
          const remoteSize = await new Promise((resolve) => {
            const req = https.request(url, { method: 'HEAD' }, (resp) => {
              resp.resume();
              if (resp.statusCode === 200) {
                const len = parseInt(resp.headers['content-length'] || '0', 10) || 0;
                resolve(len);
              } else {
                resolve(0);
              }
            });
            req.on('error', () => resolve(0));
            req.setTimeout(10_000, () => { req.destroy(); resolve(0); });
            req.end();
          });
          if (remoteSize > 0 && localSize === remoteSize) {
            useCache = true;
            console.log('[mt5-install] cache HIT — using', tempZip, 'size=', localSize);
            _emit('phase', { phase: 'cache-hit',
              message: `✓ 用本地缓存 (${(localSize/1024/1024).toFixed(0)} MB, 跳过下载)` });
          } else {
            console.log('[mt5-install] cache STALE: local=', localSize, 'remote=', remoteSize, '— re-downloading');
          }
        } catch (e) {
          console.warn('[mt5-install] cache HEAD check failed:', e?.message || e, '— re-downloading');
        }
      } else {
        console.log('[mt5-install] cache file too small (', localSize, 'bytes) — re-downloading');
      }
    }

    // 1b. 下载 (流式 + progress callback) — 仅 cache miss 时
    if (!useCache) {
      _emit('phase', { phase: 'downloading', message: '正在下载 MT5 安装包...' });
      try {
        const https = require('node:https');
        const { pipeline } = require('node:stream/promises');
        await new Promise((resolve, reject) => {
          const req = https.get(url, (resp) => {
            if (resp.statusCode !== 200) {
              reject(new Error(`HTTP ${resp.statusCode}: ${resp.statusMessage}`));
              resp.resume();
              return;
            }
            const total = parseInt(resp.headers['content-length'] || '0', 10) || 0;
            let downloaded = 0;
            let lastEmitMs = 0;
            const writer = fs.createWriteStream(tempZip);
            resp.on('data', (chunk) => {
              downloaded += chunk.length;
              const now = Date.now();
              if (now - lastEmitMs > 200 && total > 0) {
                lastEmitMs = now;
                _emit('progress', {
                  phase: 'downloading',
                  downloaded, total,
                  percent: Math.round(downloaded / total * 1000) / 10,
                });
              }
            });
            pipeline(resp, writer).then(resolve).catch(reject);
          });
          req.on('error', reject);
          req.setTimeout(600_000, () => req.destroy(new Error('download timeout (10min)')));
        });
        const sz = fs.statSync(tempZip).size;
        _emit('progress', { phase: 'downloading', downloaded: sz, total: sz, percent: 100 });
        console.log('[mt5-install] downloaded', sz, 'bytes to', tempZip);
      } catch (e) {
        // 下载失败保留旧 zip (如果有), 别误删用户能用的缓存
        return { ok: false, error: `下载失败: ${e?.message || e}` };
      }
    }

    // 2. 解压到 targetDir
    _emit('phase', { phase: 'extracting', message: '正在解压...' });
    try {
      const { extractZipToDir } = require('./zip-utils');
      let lastEmitMs = 0;
      const r = extractZipToDir(tempZip, targetDir, {
        // 0.3.193: flat 模式下剥掉 zip 的 "MetaTrader 5/" 一级目录前缀, 文件直接落 target_dir/
        stripFirstDir: flat,
        onEntry: ({ index, total }) => {
          const now = Date.now();
          if (now - lastEmitMs > 200) {
            lastEmitMs = now;
            _emit('progress', {
              phase: 'extracting',
              index, total,
              percent: Math.round(index / total * 1000) / 10,
            });
          }
        },
      });
      console.log('[mt5-install] extracted', r.entries_count, 'entries to', targetDir, 'flat=', flat);
    } catch (e) {
      return { ok: false, error: `解压失败: ${e?.message || e}` };
    }
    // 0.3.218: 不再删 zip — 缓存到 cache 目录, 下次添加实例直接复用

    // 3. 自动配 settings.mt5.installDir + dataDir — zip 是 portable copy, install/data 同一个目录
    // 0.3.193: flat 模式 → install dir = target_dir; nested (老) 模式 → target_dir/MetaTrader 5
    const mt5Dir = flat ? targetDir : path.join(targetDir, 'MetaTrader 5');
    const terminalExe = path.join(mt5Dir, 'terminal64.exe');
    if (!fs.existsSync(terminalExe)) {
      _emit('phase', { phase: 'error' });
      return { ok: false, error: `解压完成但找不到 ${terminalExe} — zip 内容可能不完整` };
    }
    // 0.3.193: flat 模式不自动设 settings.mt5 (mt5-view 调用方会自己 mt5Instances.add).
    // nested (老 settings-view 路径) 保留自动设 settings.mt5 行为不变.
    if (!flat) {
      try {
        const cur = settings.data || {};
        const mt5 = cur.mt5 || {};
        mt5.installDir = mt5Dir;
        // 0.3.184: portable copy 的 data 跟 install 同目录 (含 MQL5/ Config/ Profiles/),
        // /portable flag 启动 MT5 时它自然把 data 放这, dataDir=installDir 直接对.
        mt5.dataDir = mt5Dir;
        await settings.set({ mt5 });
        console.log('[mt5-install] settings.mt5.installDir / dataDir =', mt5Dir);
      } catch (e) {
        console.warn('[mt5-install] settings.set failed:', e?.message || e);
      }
    }

    // 1.2.36: flat 模式(mt5-view 下载安装) → 主进程直接注册实例并返回, 跟安装原子绑定。
    // 不再依赖渲染层那条「不检查返回值」的 add —— 中文目录实测漏注册(文件解压成功
    // 但实例没进 settings、没卡片; 见 D:\经济日历采集mt5)。name 优先用调用方传的,
    // 否则用目录名兜底。
    let instance = null;
    if (flat) {
      try {
        instance = await settings.addMt5Instance({
          name: String(opts?.name || '').trim() || path.basename(mt5Dir) || 'MT5 实例',
          installDir: mt5Dir,
          dataDir: mt5Dir,
          notes: '通过 EasyDeal 一键下载安装',
        });
        console.log('[mt5-install] auto-registered instance', instance?.id, 'name=', instance?.name);
        try { await reapplyWorkspaceFromSettings(); } catch (e) { console.warn('[mt5-install] reapply failed:', e?.message || e); }
        try { await ogPool?.reconcile(); } catch (e) { console.warn('[mt5-install] og reconcile failed:', e?.message || e); }
      } catch (e) {
        console.warn('[mt5-install] auto-add instance failed:', e?.message || e);
      }
    }

    _emit('phase', { phase: 'done', message: 'MT5 安装完成', mt5_install_dir: mt5Dir });
    return { ok: true, mt5_install_dir: mt5Dir, instance };
  });

  // -- ask agent to start an EA-creation interview
  ipcMain.handle('app:request-ea-create-guide', async () => {
    console.log('[ipc] request-ea-create-guide called; chat.busy =', chat.isBusy());
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = buildEaCreatePrompt();
    chat.send(prompt).catch((e) => console.error('[ea-create] chat.send failed:', e));
    return { ok: true };
  });

  // -- ask agent to retrofit hot-reload protocol into an EA source
  //
  // 「我的策略 → ⚙ 参数设置」弹窗里检测到 EA 不支持热更新时，banner 旁边
  // 显示「🔧 一键修改」按钮，用户 confirm 同意后调这里，自动发 prompt 到
  // chat（不弹 input 让用户审）。renderer 那边记下 _pendingParamsReopen，
  // 用户切回 我的策略 tab 时自动重弹同一只 EA 的参数对话框，re-detect 热更新。
  ipcMain.handle('app:request-hot-reload-retrofit', async (_e, payload) => {
    const eaName = String(payload?.ea_name || '').trim();
    if (!eaName) return { ok: false, error: 'ea_name 必填' };
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = (
      `请给 EA「${eaName}」加上 EasyDeal 的参数热更新协议（让客户端的「⚙ 参数设置」能写 config.set 后 3 秒内生效）。\n\n` +
      `步骤：\n` +
      `1. Read strategies/${eaName}.mq5 看现有结构（找到 OnInit / OnTimer / input 块）\n` +
      `2. 修改 .mq5 — 严格按 CLAUDE.md「Creating a new EA」节描述的协议加：\n` +
      `   - OnInit() 末尾加 EventSetTimer(3); （3 秒 timer）\n` +
      `   - OnDeinit() 加 EventKillTimer();\n` +
      `   - 写一个 OnTimer() 函数（如已有就增量改）：\n` +
      `     - poll \`MQL5/Files/\` 下的 config.set —— **文件名必须用 \`MQLInfoString(MQL_PROGRAM_NAME) + "_config.set"\` 动态拼, 绝不硬编码成 "${eaName}_config.set"**（理由见下方约束）\n` +
      `     - 用 last_mtime 守卫，没改不读盘\n` +
      `     - 按 \`key=value\` 行解析，把值赋给同名 input 变量（用 GlobalVariable 中转或 static 缓存）\n` +
      `     - 解析失败的行跳过 + Print 一行 warning\n` +
      `3. 调 mcp__easydeal__compile_strategy 编译，确认 .ex5 出来\n` +
      `4. **编译成功后**：更新 \`strategies/${eaName}.md\` 反映本次改动 —\n` +
      `   - 文件已存在 → Read 出来，在合适位置（通常是「核心思路」/「风控规则」之后）加一小段「**${new Date().toISOString().slice(0,10)} 改动**：已加入参数热更新协议，客户端「⚙ 参数设置」改完 3s 内生效，无需重挂 EA」。**不要**全文重写、不要改原有章节、不要改参数表（input 没动）\n` +
      `   - 文件不存在 → 跳过，提示用户可以稍后在「我的策略 → 说明」点「生成」一次性写完整版\n` +
      `5. **完成后**只说一句「✅ 已为 ${eaName} 加上热更新协议 + 同步更新策略说明，请回「我的策略」重新打开「⚙ 参数设置」查看效果」就停下，不要继续做其他事（参数测试、回测都不要主动加）\n\n` +
      `⚠ 重要约束：\n` +
      `- **只增加**热更新相关代码，**不要**改 OnTick / 订单管理 / 风控逻辑 / input 列表 / 默认值\n` +
      `- input 变量名、类型、注释都保留原样\n` +
      `- **所有 EasyDeal 协议文件名（config.set / runtime.json / reload.trigger 等）一律用 \`MQLInfoString(MQL_PROGRAM_NAME) + "_后缀"\` 动态拼，永不硬编码 EA 名** —— 客户端按 EA 的实际名字写这些文件；一旦硬编码，这只 EA 被复制改名后文件名就对不上 → 改参数永远不生效（GMarket 改名副本就栽在这个坑）\n` +
      `- 不需要跑回测验证（用户改完会自己测）`
    );
    chat.send(prompt).catch((e) =>
      console.error('[hot-reload-retrofit] chat.send failed:', e));
    return { ok: true };
  });

  // 0.3.67: 「我的策略 → 🛡 护航 → 拦截模式」启用后调这里，让 AI 把 OrderGuard 调用插入到 EA 源码里。
  // 用户不用手动改任何代码，AI 读 .mq5 → 找 OrderSend / trade.Buy / trade.Sell 点 → 插 OrderGuard_Check 兜
  // 检查 → 编译 → 报告。流程跟 hot-reload-retrofit 同款（chat.send fire-and-forget，结果显示在 chat tab）。
  ipcMain.handle('app:request-orderguard-retrofit', async (_e, payload) => {
    const eaName = String(payload?.ea_name || '').trim();
    const magic  = Number(payload?.magic) || 0;
    const thresholds = payload?.thresholds || null;
    if (!eaName) return { ok: false, error: 'ea_name 必填' };
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    // 0.3.163: 登记 pending — AI 改完 EA 输出「✅ 已为 <eaName>」标志后由 busy listener 自动 enableEa.
    // 点全停 / interrupted → busy listener 检测到 interrupted 丢弃 pending → EA 保持「未启用」.
    if (magic > 0) {
      _pendingEnforceRetrofit.set(eaName, { magic, thresholds, startedAt: Date.now() });
      console.log(`[orderguard-retrofit] pending registered: ea=${eaName} magic=${magic} thresholds=${JSON.stringify(thresholds || {})}`);
    } else {
      console.warn(`[orderguard-retrofit] magic invalid (${magic}), 不登记 pending → AI 改完不会 auto enable. eaName=${eaName}`);
    }
    const prompt = (
      `请给 EA「${eaName}」加上 OrderGuard 拦截调用 — 让它在下单前先调 OrderGuard 服务做风控审计。\n\n` +
      `**前置事实**（你不用再 detect，直接用）：\n` +
      `- OrderGuard 服务已启用拦截模式，端口从 \`<MT5>/MQL5/Files/OrderGuard/orderguard.port\` 读\n` +
      `- 库文件 \`OrderGuard.mqh\` 已部署到 \`<MT5>/MQL5/Include/\`\n` +
      `- 本地 rules JSON 在 \`<MT5>/MQL5/Files/OrderGuard/${eaName}.rules.json\`（回测 / 服务挂时 fallback 用）\n` +
      `- 这只 EA 的 magic = ${magic}\n` +
      `- **不需要鉴权 token**（服务 bind 127.0.0.1，外部访问不到）\n\n` +
      `**步骤**：\n` +
      `1. Read \`strategies/${eaName}.mq5\` 看现有结构\n` +
      `2. **先备份**：把 .mq5 复制一份成 \`${eaName}.mq5.orderguard-backup\`（回滚时用）\n` +
      `3. 修改 .mq5：\n` +
      `   - 顶部加 \`#include <OrderGuard.mqh>\`\n` +
      `   - 找所有下单点（\`OrderSend(\` / \`trade.Buy(\` / \`trade.Sell(\` / \`m_trade.Buy(\` 等），每个下单前插：\n` +
      `     \`\`\`mql5\n` +
      `     OrderGuardResult og = OrderGuard_Check("${eaName}", <risk_level>, <intent>, _Symbol, <side>, <volume>);\n` +
      `     if(og.status == OG_STATUS_BLOCKED) { Print("OrderGuard 拦截: ", og.reason); return; }\n` +
      `     if(og.status == OG_STATUS_SERVICE_DOWN && og.local_decision == OG_LOCAL_BLOCK) return;\n` +
      `     double og_volume = (og.status == OG_STATUS_ADJUSTED && og.adjusted_volume > 0) ? og.adjusted_volume : <原volume变量>;\n` +
      `     // ... 用 og_volume 替代原 volume 传给 OrderSend / trade.Buy(...) ...\n` +
      `     \`\`\`\n` +
      `   - \`<risk_level>\` 你按 EA 源码推断：纯首次开单=\"low\"，加仓/反向=\"medium\"，马丁/重仓=\"high\"\n` +
      `   - \`<intent>\` 同样推断：\"initial\" / \"add_position\" / \"hedge\" / \"martin\" / \"scalp\"\n` +
      `   - \`<side>\` 用 \`ORDER_TYPE_BUY\` / \`ORDER_TYPE_SELL\`（OrderGuard.mqh 接受 int 类型）\n` +
      `   - 下单成功后**可选**调一次 \`OrderGuard_Notify(og.decision_id, res.deal, res.price)\` 把开仓回传（监控 tracker 也会自动收，不调也行）\n` +
      `   - **平仓 hook**：找所有平仓点（\`OrderClose(\` / \`PositionClose(\` / \`trade.PositionClose(\` / 自定义平仓封装），每个平仓前插：\n` +
      `     \`\`\`mql5\n` +
      `     OrderGuardResult ogc = OrderGuard_CheckClose("${eaName}", <ticket>, <symbol>, <side>, <volume>, <open_price>, <cur_price>, <cur_sl>, <cur_tp>, <floating_pnl>, "close");\n` +
      `     if(ogc.status == OG_STATUS_BLOCKED) { Print("OrderGuard 平仓拦截: ", ogc.reason); return; }\n` +
      `     \`\`\`\n` +
      `   - **改单 hook**：找所有改 SL/TP 点（\`OrderModify(\` / \`PositionModify(\` / \`trade.PositionModify(\` / \`...SLTP(\` / 移动止损循环），改 SL/TP 前插：\n` +
      `     \`\`\`mql5\n` +
      `     OrderGuardResult ogm = OrderGuard_CheckModify("${eaName}", <ticket>, <symbol>, <side>, <cur_sl>, <cur_tp>, <new_sl>, <new_tp>, <当前买卖价做ref>);\n` +
      `     if(ogm.status == OG_STATUS_BLOCKED) { Print("OrderGuard 改单拦截: ", ogm.reason); return; }\n` +
      `     \`\`\`\n` +
      `   - ⚠ 平仓/改单 hook 都是「服务挂 / 回测 → 一律放行」；平仓更是服务端**默认关 + 永不拦止损**，改单**只拦「SL 往亏损方向外扩」**（收紧 SL / 改 TP 不拦）—— 所以正常情况几乎不影响 EA 原有平仓/改单逻辑，只在用户显式开了拦截 + 命中危险动作时才拦。**EA 源码里找不到平仓 / 改单点就跳过对应那条**，不要硬塞、不要为了加 hook 改原逻辑。\n` +
      `4. 调 \`mcp__easydeal__compile_strategy\` 编译，确认 .ex5 出来\n` +
      `5. **编译成功后**：更新 \`strategies/${eaName}.md\` 反映本次改动 —\n` +
      `   - 文件已存在 → Read 出来，在「风控规则」章节末尾追加一小段「**${new Date().toISOString().slice(0,10)} 改动**：已接入 OrderGuard 拦截 (enforce 模式)，每笔下单前调用 OrderGuard_Check 做 fast-rule + AI 风控审计；fast-rule block 立刻拦截，服务不可达时走 \`MQL5/Files/OrderGuard/${eaName}.rules.json\` 本地兜底。decision_id 通过 OrderGuard_Notify 回传给护航专栏归档。原 EA 策略逻辑未改动。」。**不要**全文重写、不要改原有章节、不要改参数表（input 没动）\n` +
      `   - 文件不存在 → 跳过，提示用户可以稍后在「我的策略 → 说明」点「生成」一次性写完整版\n` +
      `6. **完成后**只说一句「✅ 已为 ${eaName} 加上 OrderGuard 拦截调用 + 同步更新策略说明，原文件备份在 ${eaName}.mq5.orderguard-backup。要回滚就还原备份重编。请在 MT5 重新挂载 EA 让 .ex5 生效。」就停下\n\n` +
      `**特殊情况**：如果 Read 后发现 EA **已经集成过** OrderGuard（顶部已有 \`#include <OrderGuard.mqh>\` + 下单点已含 \`OrderGuard_Check\`），**不要重复改 / 备份 / 编译**，直接输出同款 ✅ 标记: 「✅ 已为 ${eaName} 加上 OrderGuard 拦截调用（代码已就绪，本次未改动）。请在 MT5 重新挂载 EA 让 .ex5 生效。」 — **必须带 ✅ 标记**，EasyDeal 客户端靠这条标记触发 enable 流程，不带的话护航开关永远不会打开。\n\n` +
      `⚠ **不可逆性 / 安全约束**：\n` +
      `- **只增加**风控调用，不要改 OnTick / OnInit / 订单管理 / 风控逻辑 / input 列表 / 默认值\n` +
      `- 不要改 magic number / SL / TP / OrderSend 的其他参数（volume 之外的）\n` +
      `- input 变量名、类型、注释保留原样\n` +
      `- 不要跑回测 / 不要 hot-reload\n` +
      `- 如果 EA 的下单逻辑用了你不认识的封装（自定义 SendOrder 函数等），**就在该函数内部第一行**插 OrderGuard_Check，不要去找它每个调用点\n` +
      `- 编译失败时**立刻还原备份**（cp backup → .mq5），并告诉用户哪步报错（**.md 不要改**，回滚后保持文档原状）`
    );
    chat.send(prompt).catch((e) =>
      console.error('[orderguard-retrofit] chat.send failed:', e));
    return { ok: true };
  });

  // 0.3.74 P2-B: AI 读 EA 源码自动生成定制 OrderGuard rules
  // 启用护航后用户可点「让 AI 看源码生成定制规则」触发，比通用默认 rules 更贴
  ipcMain.handle('app:request-orderguard-rule-generation', async (_e, payload) => {
    const eaName = String(payload?.ea_name || '').trim();
    if (!eaName) return { ok: false, error: 'ea_name 必填' };
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = (
      `请给 EA「${eaName}」**生成定制的 OrderGuard 风控规则** —— 比通用默认 rules 更贴这只 EA 的实际行为。\n\n` +
      `**前置事实**：\n` +
      `- OrderGuard 已启用护航（监控 / 拦截皆可）\n` +
      `- 你能通过 MCP \`orderguard_rules_set\` 把生成的规则写回服务\n\n` +
      `**步骤**：\n` +
      `1. \`Read strategies/${eaName}.mq5\` 看源码\n` +
      `2. 抽取以下信息（如果是 .ex5-only 没源码，改读 \`strategies/${eaName}.md\` + recent 30 天 closed orders 推断）：\n` +
      `   - 策略类型（trend / martin / hedge / scalp / grid / breakout）\n` +
      `   - 典型 lot size 范围（input 默认值 + 最大加仓倍数）\n` +
      `   - 最大并发持仓数（如 maxOrders / maxPositions input）\n` +
      `   - 马丁层数上限（如 maxMartinLevel input）\n` +
      `   - 时段过滤（如有交易时段 input 就提取）\n` +
      `3. 用以上信息构造 \`fast_rules\` JSON：\n` +
      `   - \`max_volume\`: 单笔最大手数（取 EA 默认 lot × 1.5 留 buffer）\n` +
      `   - \`max_positions\`: 最大并发（取 EA input × 1.2）\n` +
      `   - \`martin_max_level\`: 如是马丁取源码值，非马丁设 1\n` +
      `   - \`max_drawdown_pct\`: 默认 30（如源码有止损逻辑可适当放宽）\n` +
      `   - \`blocked_hours\`: 如有时段输入 → 反向（不允许交易的小时）\n` +
      `4. 构造 \`risk_policy\` — low/medium/high/critical 四档每档 \`{action, ai_check}\`，按策略类型给：\n` +
      `   - 非马丁稳健策略：low/medium pass+no_ai, high check+ai, critical block\n` +
      `   - 马丁/重仓策略：low pass+no_ai, medium check+ai, high check+ai, critical block\n` +
      `5. 调 \`mcp__orderguard__orderguard_rules_set\`（参数 \`ea_name\` + \`rules\` JSON 整块）写回 OrderGuard\n` +
      `6. **完成后**只说一句「✅ 已为 ${eaName} 生成定制规则：fast_rules=X 条，risk_policy=4 档；回「🛡 护航」专栏看新规则会怎么作用到下一笔订单」就停\n\n` +
      `⚠ 约束：\n` +
      `- 不要改 EA 源码，只读\n` +
      `- 生成的 rules 偏保守（宁可拦多放少）— 用户后续可用「📈 学习中心」的建议根据实战微调\n` +
      `- 如果信息不全（如纯 .ex5 + 无 .md + 无历史），给一份保守通用 rules + 在 reason 里说明\n` +
      `- 不要跑回测 / 不要 hot-reload`
    );
    chat.send(prompt).catch((e) =>
      console.error('[orderguard-rule-gen] chat.send failed:', e));
    return { ok: true };
  });

  // 0.3.90: 「🛡 护航 → 在跑订单 → 🤖 AI 分析这笔订单」按钮 → 跳到 chat tab，
  // 让 AI 结合 EA 源码 + decision 上下文分析这笔订单生命周期（入场逻辑 / 风险/收益 /
  // 可能的 close 触发）。复用 chat.send fire-and-forget 模式。
  ipcMain.handle('app:request-analyze-position', async (_e, payload) => {
    const eaName  = String(payload?.ea_name || '').trim();
    const ticket  = payload?.ticket;
    if (!eaName || ticket == null) return { ok: false, error: 'ea_name + ticket 必填' };
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const dec = payload?.decision || null;
    const decBlock = dec
      ? `**OrderGuard decision 上下文**：\n` +
        `- decision_id: \`${dec.decision_id || '?'}\`\n` +
        `- intent: \`${dec.intent || '?'}\`，risk: \`${dec.risk_level || '?'}\`\n` +
        `- decision: ${dec.approved ? '放行' : '拦截'}（reason: ${dec.reason || '—'}）\n` +
        `- requested_volume: ${dec.requested_volume ?? '?'}` +
        (dec.ai_checked ? `\n- AI 评估: ${dec.ai_confidence ?? '?'} confidence` : '')
      : `**注**：这笔单在 OrderGuard 启动前就开了，没 decision 记录。基于 MT5 position + EA 源码分析就够。`;
    const prompt = (
      `请分析 EA「${eaName}」当前在跑的这笔订单的<strong>生命周期</strong>。\n\n` +
      `**订单实时状态**：\n` +
      `- ticket: \`#${ticket}\`，magic: ${payload.magic ?? '?'}\n` +
      `- ${payload.symbol} ${String(payload.side || '').toUpperCase()} ${payload.volume} lots\n` +
      `- 开仓价: ${payload.open_price}，开仓时间: ${payload.open_time}\n` +
      `- SL/TP: ${payload.sl ?? '—'} / ${payload.tp ?? '—'}\n` +
      `- 当前浮动 PnL: ${payload.current_pnl ?? '?'} USD\n\n` +
      `${decBlock}\n\n` +
      `**步骤**（**并行调**，别串行）：\n` +
      `1. \`Read strategies/${eaName}.mq5\`（如果没源码就读 \`strategies/${eaName}.md\` 凑合）\n` +
      `2. \`mcp__easydeal__get_market_info\` 看 ${payload.symbol} 当前 bid/ask / spread / ATR / 日内振幅\n` +
      `3. \`mcp__easydeal__get_positions\` 拿该 ticket 完整状态（已 sl/tp 在 payload 里有了，但 swap / commission / 浮亏轨迹 fresh 看一眼）\n\n` +
      `**分析重点**（按重要性排，不必全写）：\n` +
      `- **入场逻辑回溯**：EA 源码里啥条件触发了这笔（buy/sell 方向是否合理，是首笔 / 加仓 / 马丁第几层）\n` +
      `- **风险/收益设计**：SL 距离开仓价多少 pip，TP 多少 pip，R:R 比例；当前价距 SL/TP 各多远\n` +
      `- **可能的 close 触发**：自动 TP/SL hit？源码里有时间退出？反向信号反转？跟同 EA 其他仓位平仓联动？\n` +
      `- **风险提示**：当前持仓时长 vs 该 EA 平均，浮亏是否接近历史回撤上限，加仓 / 马丁逻辑后续会怎么走\n` +
      `- **是否需要人工干预**：基于上述判断，给具体建议（继续持 / 手动 close / 改 SL / 等 N 分钟看反应）\n\n` +
      `⚠ 约束：\n` +
      `- 输出**精炼**，3-5 段足够，不要把 EA 源码全文贴回来\n` +
      `- **不要主动改任何东西**（不调 write_ea_parameters / panic_stop 等），只给分析 + 建议，让用户决定\n` +
      `- 用户视角是「我现在该怎么办」，所以最后一句给个 actionable 结论`
    );
    chat.send(prompt).catch((e) =>
      console.error('[analyze-position] chat.send failed:', e));
    return { ok: true };
  });

  // -- ask agent to backtest a strategy
  ipcMain.handle('app:request-backtest', async (_e, payload) => {
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = buildBacktestPrompt(payload || {});
    chat.send(prompt).catch((e) => console.error('[backtest] chat.send failed:', e));
    return { ok: true };
  });

  ipcMain.handle('app:cancel-backtest', (_e, id) => backtests.userAction('cancel', id));

  // 0.3.55: 全停按钮 / 全停 IPC。
  //
  // 跟「app:cancel-backtest」的关系：cancel-backtest 是单点取消一个 bt；
  // panic-stop-all 是大杀一切：
  //   1. chat.stop() — **关键**，杀掉正在跑的 Claude turn（MCP 工具杀不掉自己所在 turn，
  //      只有 main 进程能；用户从 UI 按 🛑 时这步**必须**第一个做）
  //   2. 遍历 backtests.json — 把所有 running/queued 状态的 bt 都 cancel：taskkill spawn pid
  //      + 标记 status=cancelled
  //   3. scheduler MCP 删所有 t_* 用户调度任务（轮询 cron / AI 自己排的提醒等）
  //   4. 写 panic.flag 30s — 文件级冷却信号，下次 AI 调 run_backtest
  //      会在 Python 端 preflight 拒绝（防止用户喊停后 AI 立刻又自己启）
  //
  // 用户场景：用户 5/14 截图里 AI 在 11:55 接到「取消全部优化进程」之后取消了
  // 一轮，**12:35 又自顾自启动 R7-A backtest** 完全无视用户原意 — 那种 runaway
  // AI 不会因为再喊一次「停」就听。必须有非 AI 入口直接强制中断。
  ipcMain.handle('app:panic-stop-all', async () => {
    const result = {
      chat_stopped: false,
      backtests_cancelled: 0,
      crons_deleted: 0,
      procs_killed: 0,
      panic_flag_ttl_ms: 60_000,
      errors: [],
    };

    // 1. chat.stop({ panic: true }) — 杀正在跑的 AI turn（必须第一步，不然 AI 还能继续 spawn 新工作）
    // 0.3.167: 传 panic=true 让 catch 块不再 push「已经被中断, 等待 1 分钟恢复」segment.
    //   用户反馈「点全停时无需中断提醒，更不需 1 分钟恢复」. 之前事后用 dismissInterruptedTurn
    //   替换文案有时序竞态 (catch 还没 push 时 dismiss 已经跑了 → 永远改不到).
    //   现在 panic flag 让 catch 在 push 之前就决策，无竞态.
    // 1.3.x 多会话: 全停要停「所有会话」(全局 + 每策略), 不止全局那条。
    try {
      await Promise.race([
        (chatMgr ? chatMgr.stopAll({ panic: true }) : (chat?.stop ? chat.stop({ panic: true }) : Promise.resolve())).catch(() => {}),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      result.chat_stopped = true;
    } catch (e) {
      result.errors.push('chat.stop: ' + String(e?.message || e));
    }

    try {
      const stopped = await backtests.change('cancel-all');
      result.backtests_cancelled = stopped.backtests_cancelled;
    } catch (e) {
      result.errors.push('backtests: ' + e.message);
    }

    try {
      result.crons_deleted = await _cleanupAllBacktestPollTasks();
    } catch (e) {
      result.errors.push('scheduler: ' + e.message);
    }

    // 5. 标记 chat 最后一条 interrupted assistant turn 为 dismissed —
    // 用户主动放弃这条 turn, chat-resume ticker 不再自动续上.
    try {
      if (chat && typeof chat.dismissInterruptedTurn === 'function') {
        const r = await chat.dismissInterruptedTurn('panic_stop_all');
        result.chat_dismissed = r;
      }
    } catch (e) {
      result.errors.push('dismiss interrupted: ' + String(e?.message || e));
    }

    // 0.3.152: 「全停」改成一次性 action — 不写 panic.flag, 不调 pauseAll.
    // 用户反馈: 「点全停后不需要冷却时间，也不需要点恢复按钮」.
    // 现在 panic = 一次性清理 (cancel in-flight + 删 auto-poll cron + dismiss chat 中断 turn),
    // 然后系统继续正常跑 — 用户主动建的 cron 跑, ticker 继续 tick, AI 主动调用不再被 flag 拦.
    // 因为已经 dismiss 了 chat 最后一条 interrupted turn, chat-resume tick 也不会续它.

    console.log('[panic-stop-all]', result);
    return { ok: true, ...result };
  });

  // 0.3.134: 用户改主意 / 手动解除全停态。删 panic.flag → AI 可以重新被调，
  // chat auto-resume ticker 下次 60s tick 时就会续上之前被中断的 turn。
  ipcMain.handle('app:clear-panic-flag', async () => {
    // 0.3.152: panic 改一次性后这条 IPC 几乎没用了 — 保留兼容老调用方.
    // 仍然兜底删 panic.flag (如果有遗留) + resumeAll (如果用户手动 pauseAll 过).
    try {
      const flagPath = path.join(
        app.getPath('userData'), 'workspace', '.easy-deal', 'panic.flag');
      let cleared = false;
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
        cleared = true;
      }
      const rr = await timerRegistry.resumeAll();
      return { ok: true, cleared, timer_registry: rr };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // 0.3.152: 「监控」tab + 调试用 IPC — list / pause / resume 单 ticker
  ipcMain.handle('app:list-timers', async () => {
    return { ok: true, data: timerRegistry.list() };
  });
  ipcMain.handle('app:pause-timer', async (_e, id, reason) => {
    return await timerRegistry.pause(id, reason || 'manual');
  });
  ipcMain.handle('app:resume-timer', async (_e, id) => {
    return await timerRegistry.resume(id);
  });
  ipcMain.handle('app:pause-all-timers', async (_e, reason, durationMs) => {
    return await timerRegistry.pauseAll(reason || 'manual', durationMs || null);
  });
  ipcMain.handle('app:resume-all-timers', async () => {
    return await timerRegistry.resumeAll();
  });

  // -- ask agent to deploy + compile a strategy into MT5/Experts
  ipcMain.handle('app:request-deploy', async (_e, payload) => {
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = buildDeployPrompt(payload || {});
    chat.send(prompt).catch((e) => console.error('[deploy] chat.send failed:', e));
    return { ok: true };
  });

// 0.3.10: 「我的策略」行里 ⚠ 不一致 tag 点击 → 触发完整 redeploy +
  // verify 流程。比 deploy 更狠：强制 AI 看 compile_strategy 返回的
  // workspace_ex5_synced + ex5_rebuilt 字段，落到位再告诉用户。
  ipcMain.handle('app:request-redeploy', async (_e, payload) => {
    if (chat.isBusy()) return { ok: false, error: '当前对话还在跑，请等它结束再点' };
    const prompt = buildRedeployPrompt(payload || {});
    chat.send(prompt).catch((e) => console.error('[redeploy] chat.send failed:', e));
    return { ok: true };
  });

  async function uploadDialog(extensions, addFn) {
    if (!win) return { added: [] };
    const r = await dialog.showOpenDialog(win, {
      title: '上传文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: extensions.join('/').toUpperCase(), extensions }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { added: [] };
    const added = [];
    for (const p of r.filePaths) {
      try { added.push(await addFn(p)); }
      catch (e) { added.push({ name: path.basename(p), error: String(e.message || e) }); }
    }
    return { added };
  }
}

// ---------------------------------------------------------------------------
// Mock market data (shape compatible with future server response)
// ---------------------------------------------------------------------------

function mockMarketItems() {
  const day = (n) => Date.now() - n * 86_400_000;
  return [
    {
      id: 'm1', name: 'GoldGrid v3.2', author: '挂图先生',
      pnl_pct: 287.4, sharpe: 1.94, win_rate: 0.62, max_drawdown: 0.21,
      trades: 412, hours_run: 1840, downloads: 2104,
      summary: '黄金双向网格 + 趋势过滤，适合 H1。',
      published_at: day(8),
    },
    {
      id: 'm2', name: 'BollBreak', author: 'Quant_Yuan',
      pnl_pct: 168.7, sharpe: 2.81, win_rate: 0.71, max_drawdown: 0.115,
      trades: 188, hours_run: 980, downloads: 1422,
      summary: '布林带突破 + ATR 止损，欧美对效果最好。',
      published_at: day(14),
    },
    {
      id: 'm3', name: 'TrendFollow', author: 'Aria',
      pnl_pct: 98.2, sharpe: 2.15, win_rate: 0.66, max_drawdown: 0.082,
      trades: 152, hours_run: 720, downloads: 866,
      summary: 'EMA 多周期合流，回撤控制特别好。',
      published_at: day(22),
    },
    {
      id: 'm4', name: 'EUR-Hedge', author: '小张做多',
      pnl_pct: 192.1, sharpe: 1.42, win_rate: 0.58, max_drawdown: 0.176,
      trades: 277, hours_run: 1320, downloads: 1655,
      summary: 'EUR/USD 锁仓加马丁，参数较激进。',
      published_at: day(33),
    },
    {
      id: 'm5', name: 'GMarket Custom', author: '震荡王',
      pnl_pct: 122.0, sharpe: 1.18, win_rate: 0.55, max_drawdown: 0.235,
      trades: 643, hours_run: 2410, downloads: 3120,
      summary: '基于官方 GMarket 改的高频版本。',
      published_at: day(60),
    },
  ];
}
function sortMarket(items, sort) {
  const key = sort || 'pnl_pct';
  const asc = key === 'max_drawdown';
  return items.slice().sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
}

// ---------------------------------------------------------------------------
// Resolve the easydeal Python MCP script path.
//   1. EASYDEAL_MCP_SCRIPT env var (absolute path)
//   2. Sibling of this client repo:   ../easy-deal/easydeal_mcp_server.py
//   3. ~/easy-deal/easydeal_mcp_server.py
// Returns absolute path or null when not found.
// ---------------------------------------------------------------------------

// Tri-state MT5 check: not_installed / installed_not_running / running.
//   - "installed" = terminal64.exe (or terminal.exe) exists at the configured
//     install dir (or anywhere we can detect)
//   - "running"   = a process by that name is alive
/**
 * 0.3.225: 启动期自动 launch 所有 user_intent='running' (或 undefined, 默认认为
 * 上次是运行态) 但当前进程没在跑的 MT5 实例. 跟 _reconcileKillFlagsFromUserIntent
 * 配对: stopped 的不动, running 的拉起.
 *
 * 老逻辑只默认实例 (settings.mt5.installDir) 有自启行为 (其它 IPC tick init 时
 * 不小心拉起). 现在显式 + 所有 instance 都按 user_intent 走, 跨重启行为对齐.
 *
 * 行为细节:
 * - 已在跑 (terminal64.exe 在 install_dir 下) → 跳过, 不重复 launch
 * - install_dir 空 / 无效 → 跳过 (没法 launch)
 * - user_intent === 'stopped' → 跳过 (上面 reconcile 会写 kill-flag)
 * - 否则 (running / undefined) → 调 launchMt5(installDir)
 *
 * 并发: 多 instance 同时 launch 可能撞 MT5 SDK / Python 抢资源, 用 sequential
 * launch + 1.5s 间隔, 避免一波 spawn 击垮 boot CPU.
 */
async function _autoLaunchRunningInstances() {
  if (!settings || !settings.listMt5Instances) return;
  const instances = settings.listMt5Instances();
  if (!instances.length) return;
  // 先扫一次所有 terminal64.exe 进程, 知道哪些 install_dir 已经在跑
  let running = new Map();
  try { running = await _scanAllMt5Procs(); } catch {}

  let launched = 0;
  for (const inst of instances) {
    if (!inst?.installDir) continue;
    // 0.4.24: 只自启「用户**显式**经 EasyDeal 启动过」的实例 (user_intent === 'running')。
    // 老逻辑 `inst.user_intent || 'running'` 把 undefined 当成 running → 旧版升级上来
    // (老版本没写这字段) / 从没经 EasyDeal 启动过的默认实例, 一打开 EasyDeal 就被自动
    // 拉起 MT5。用户反馈: 打开 EasyDeal (尤其旧版升级后) 不该默认启动默认 MT5。
    // 现在: 只有用户点过「启动」并持久化成 'running' 的实例才跨重启自启; undefined =
    // 用户没表达过要它跑 = 不自启, 等用户主动点。stopped 当然也不启。
    if (inst.user_intent !== 'running') continue;
    const norm = String(inst.installDir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (running.has(norm) && (running.get(norm) || []).length > 0) {
      console.log(`[autolaunch] ${inst.name} already running, skip`);
      continue;
    }
    try {
      console.log(`[autolaunch] launching ${inst.name} (${inst.installDir}) ...`);
      // 写 launch-flag, 让 account-info / OG 知道刚 spawn 别撞 boot race. 用跟
      // registerIpc 内部 global._writeLaunchFlag 同款 path 算法 (md5 hash).
      try {
        const crypto = require('node:crypto');
        const hash = crypto.createHash('md5').update(String(inst.installDir || '').toLowerCase()).digest('hex').slice(0, 12);
        const fp = path.join(app.getPath('userData'), 'data', `mt5-launching-${hash}.flag`);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, String(Date.now()), 'utf8');
      } catch {}
      _mt5LaunchAuthorization.set(inst.id, Date.now() + 180_000);
      const r = await launchMt5(inst);
      if (r?.ok) {
        launched += 1;
      } else {
        console.warn(`[autolaunch] ${inst.name} failed: ${r?.error || '?'}`);
      }
    } catch (e) {
      console.warn(`[autolaunch] ${inst.name} threw: ${e?.message || e}`);
    }
    // 错开下一次, 别一波 spawn 撞 SDK 资源
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (launched) {
    console.log(`[autolaunch] launched ${launched}/${instances.length} MT5 instances on boot`);
  }
}

/**
 * 0.3.207: 启动期把 settings.mt5Instances[].user_intent 同步到 kill-flag.
 * - intent=stopped → 写 flag (OG / account-info 启动后立刻见 flag 不去 attach)
 * - intent=running → 清 flag (允许正常 attach)
 *
 * 这条 hook 保证「跨 EasyDeal 重启用户的 stopped 状态不丢」:
 * 老 EasyDeal 装新版后, 旧 instance 的 user_intent=stopped 仍生效, 不会一启动
 * 就被各种 init 调用拉起 MT5.
 */
async function _reconcileKillFlagsFromUserIntent() {
  if (!settings || !settings.listMt5Instances) return;
  const list = settings.listMt5Instances();
  for (const inst of list) {
    if (!inst.installDir) continue;
    const intent = inst.user_intent || 'running';
    try {
      if (intent === 'stopped') {
        // 写 flag — 即使老版本没写过 flag, 这次启动后状态保持 stopped
        _writeKillFlagDirect(inst.installDir);
        console.log(`[startup-reconcile] intent=stopped → flag written for ${inst.name}`);
      } else {
        // 清 flag — running 状态不该有 flag 残留
        _clearKillFlagDirect(inst.installDir);
      }
    } catch (e) {
      console.warn(`[startup-reconcile] inst=${inst.id} failed:`, e?.message || e);
    }
  }
}

/** Standalone helpers (registerIpc 跑之前用) — 跟 registerIpc 里 global._killFlagPath
 * 等价行为, 但不依赖 registerIpc 已经跑过. */
function _killFlagPathDirect(installDir) {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('md5').update(String(installDir || '').toLowerCase()).digest('hex').slice(0, 12);
  return path.join(app.getPath('userData'), 'data', `mt5-killed-${hash}.flag`);
}
function _writeKillFlagDirect(installDir) {
  const fp = _killFlagPathDirect(installDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, String(Date.now()), 'utf8');
}
function _clearKillFlagDirect(installDir) {
  const fp = _killFlagPathDirect(installDir);
  try { fs.unlinkSync(fp); } catch {}
}

/**
 * 0.3.211: 拿 install_dir 下 terminal64.exe 进程的最大「跑了多久 (秒)」.
 * 不在跑返 -1. account-info IPC 用它判断「MT5 boot 完了没」— 进程跑 < 60s 时
 * SDK IPC 通常没就绪, 这时 init SDK 会误判「not running」launch 一个新的.
 */
async function _findMt5AgeForInstall(installDir) {
  // 0.4.12: 回到 0.4.2 简洁形式 (单 PS 调用 + UTF8 encoding fix).
  // 0.4.3-0.4.11 那一堆 delegate + self-contained tasklist 兜底全删 — 都是基于
  // 「PowerShell 拿不到路径」错误假设, 0.4.10 找到真根因 (PS 5.x $OutputEncoding
  // 默认 ASCIIEncoding 把中文路径变 ???) 之后 兜底全成 noise + 副作用.
  if (!installDir) return -1;
  if (process.platform !== 'win32') return -1;
  const cp = require('node:child_process');
  const normInstall = String(installDir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return new Promise((resolve) => {
    // 1.0.8: CIM 拿不到匹配进程时的 tasklist 兜底 —— 实盘机 (EZDL-AAAA-1111) 实测:
    // MT5 以**管理员权限**跑, 非提权的 EasyDeal 跑 Get-CimInstance 枚举不到提权进程
    // (powershell_count=0 / ExecutablePath 返 null), 但 tasklist 跨提权可见 (PID 在)
    // 且 mt5.initialize connected:true (MT5 IPC 跨提权可连)。结果: 「EA 成绩单采集」
    // precheck 把它当「没在跑」一直 skip → trades 永远 0, 排行榜/商城数据失真。
    // 0.4.12 当初删 tasklist 兜底是基于「PS 返空 ⟺ MT5 没跑 (encoding 修完后)」, 这个
    // 假设对**提权 MT5** 不成立 → 这里补回来。tasklist 给不出 path 没法归属到具体
    // installDir, 但能确认「有没有 terminal64.exe 在跑」→ 有就返哨兵 age 放行 precheck;
    // mt5.initialize 自己按 path 绑到在跑的那个, 不会重复 launch (mt5_probe matched:true
    // 已证实)。代价: 极少数「多 MT5 + 仅另一个在跑 + 目标确实没跑 + CIM 又全盲」corner
    // 下可能误放行 (= 多 launch 一个), 可接受 (远好过永不采集)。
    const tasklistFallback = () => {
      // Lifecycle v2 is fail-closed: tasklist cannot reveal ExecutablePath,
      // therefore it cannot prove that a process belongs to this instance.
      resolve(-1);
    };
    // 0.4.10: 必须 set $OutputEncoding 而不只是 chcp — chcp 改 console codepage
    // 但不影响 PowerShell 自己的 $OutputEncoding (Win PS 5.x 默认 ASCIIEncoding).
    // 用户 case (installDir 含中文「倚天剑」): PowerShell Get-CimInstance 拿到的
    // ExecutablePath 通过 stdout pipe 给 Node 时中文被 PS 自己变 "???",
    // Node Map key 跟 settings.json 里正常 UTF-8 installDir 对不上 → running=false.
    // 显式 set [Console]::OutputEncoding + $OutputEncoding 让两版 PS 行为一致.
    const ps = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); chcp 65001 > $null; Get-CimInstance Win32_Process -Filter "Name = 'terminal64.exe'" | Select-Object ProcessId, ExecutablePath, CreationDate | ConvertTo-Json -Compress`;
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { windowsHide: true, timeout: 5000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return tasklistFallback();
        let arr = [];
        try {
          const j = JSON.parse((stdout || '').trim() || '[]');
          arr = Array.isArray(j) ? j : [j];
        } catch { return tasklistFallback(); }
        let maxAge = -1;
        for (const it of arr) {
          if (!it) continue;
          const p = String(it.ExecutablePath || '').replace(/\//g, '\\').toLowerCase();
          if (!p) continue;
          if (!p.startsWith(normInstall + '\\') && p !== normInstall + '\\terminal64.exe') continue;
          let ct = 0;
          const cd = it.CreationDate;
          if (cd && typeof cd === 'string') {
            const m = cd.match(/\/Date\((\d+)/);
            if (m) ct = Number(m[1]);
            else { const d = Date.parse(cd); if (!isNaN(d)) ct = d; }
          } else if (cd && typeof cd === 'number') ct = cd;
          if (ct > 0) {
            const age = (Date.now() - ct) / 1000;
            if (age > maxAge) maxAge = age;
          }
        }
        // CIM 有匹配 → 用真实 age; 没匹配 (返 0 entries / 全 null path = 提权 MT5
        // 看不到) → tasklist 兜底确认是否真在跑, 别再误判「没跑」永远 skip。
        if (maxAge >= 0) return resolve(maxAge);
        return tasklistFallback();
      });
  });
}

/**
 * 0.3.195: 列出 exe path 在指定 installDir 下的 terminal64.exe 进程 PIDs.
 * 走 PowerShell Get-CimInstance Win32_Process 查 Path 字段.
 * 多实例时核心: 多 MT5 同时跑 → 用 exe 路径区分谁是谁.
 */
// 0.3.221: 一次性查所有 terminal64.exe + 按 install_dir 分桶, 1 秒 TTL cache.
// 老路径: 每个实例单独跑一次 PowerShell WMI 查询 → N 个实例时撞 PowerShell
// concurrent limit / OS 资源紧张, 偶发 timeout 返空 → 卡片误显「已停止」.
// 新路径: paintCards 每 3s poll 一次 → 1s 窗口内多个 caller (list IPC + account-info
// guard + show-window etc) 共享同一份扫描结果, 不再压垮系统.
let _allMt5ProcsCache = null;     // Map<normalizedLowercaseInstallDir, number[]> | null
let _allMt5ProcsCacheTs = 0;
let _allMt5ProcsInflight = null;   // Promise | null — 并发去重

async function _scanAllMt5Procs() {
  // 已有结果且未过期 → 直接返
  if (_allMt5ProcsCache && Date.now() - _allMt5ProcsCacheTs < 10000) {   // 0.5.x: 1s→10s, 慢机减少 13s 级重复扫描
    return _allMt5ProcsCache;
  }
  // 已有 inflight → 复用同一次扫描, 多 caller 不会并发起多个 PowerShell
  if (_allMt5ProcsInflight) return _allMt5ProcsInflight;
  _allMt5ProcsInflight = (async () => {
    const cp = require('node:child_process');
    const result = new Map();   // norm_dir → [pid, ...]
    if (process.platform !== 'win32') {
      Object.defineProperty(result, '_scanOk', { value: false });
      return result;
    }
    // 0.3.269: 对齐 Python _list_mt5_pids 实现 (用户 0.3.250 截图: 6 个 MT5
    // 全在线但 EasyDeal UI 卡「正在启动并连接」, MCP 工具能 detect 而 Node 不能).
    // 改 3 点: (1) filter 加 OR terminal.exe (32-bit 老 MT5); (2) PowerShell 失败
    // 走 tasklist 兜底 (拿不到 path 但至少知道有进程); (3) ExecutablePath 是 null
    // 时不 silent drop (admin 进程读不到 path) — 把它放到 unknownDir bucket.
    // 0.4.10: 同 _findMt5AgeForInstall — set $OutputEncoding UTF-8 让中文 path 不变 ???
    const ps = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); chcp 65001 > $null; Get-CimInstance Win32_Process -Filter "Name = 'terminal64.exe' OR Name = 'terminal.exe'" | Select-Object ProcessId, ExecutablePath, Name | ConvertTo-Json -Compress`;
    let psOk = false;
    let fallbackOk = false;
    let pidPaths = [];   // [[pid, path|null, exeName], ...]
    await new Promise((resolve) => {
      cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
        { windowsHide: true, timeout: 20000, encoding: 'utf8' },   // 0.5.x: 5s→20s, 实测慢机 CIM 12.8s
        (err, stdout) => {
          if (err) { console.warn('[mt5-scan] PowerShell err:', err?.message); return resolve(); }
          let arr = [];
          try {
            const j = JSON.parse((stdout || '').trim() || '[]');
            arr = Array.isArray(j) ? j : [j];
          } catch (e) {
            console.warn('[mt5-scan] PowerShell JSON parse failed:', e?.message);
            return resolve();
          }
          psOk = true;
          for (const it of arr) {
            if (!it) continue;
            const pid = Number(it.ProcessId);
            if (!pid) continue;
            const exeName = String(it.Name || '').toLowerCase();
            const rawPath = String(it.ExecutablePath || '').replace(/\//g, '\\');
            pidPaths.push([pid, rawPath || null, exeName]);
          }
          resolve();
        });
    });
    // 0.3.269: PowerShell 完全没拿到结果 → tasklist 兜底拿 pid (无 path)
    // 0.4.12: 还原触发条件 = 0.3.269 原版 `!psOk` (PowerShell 真的失败才兜底).
    // 0.4.6 加的 `pidPaths.length === 0` 是为了解决 用户 case, 但当时 用户 的问题
    // 其实是 0.4.10 PowerShell encoding bug → PS 返了 entries 只是 path 字段被
    // ASCIIEncoding 摧毁. 修了 encoding 后 PS 能正常返回中文路径, pidPaths=0 只
    // 在系统真没 MT5 在跑时发生, 此时 tasklist 兜底也找不到, 没必要浪费 4s.
    if (!psOk) {
      console.warn('[mt5-scan] PowerShell failed, fallback to tasklist');
      for (const exe of ['terminal64.exe', 'terminal.exe']) {
        await new Promise((resolve) => {
          cp.exec(`tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH`,
            { windowsHide: true, timeout: 20000, encoding: 'utf8' },   // 0.5.x: 4s→20s, 实测慢机 tasklist 14.4s
            (err, stdout) => {
              if (err) return resolve();
              fallbackOk = true;
              for (const line of String(stdout || '').split(/\r?\n/)) {
                const m = line.match(/^"([^"]+)","(\d+)"/);
                if (m && m[1].toLowerCase() === exe) {
                  pidPaths.push([Number(m[2]), null, exe]);
                }
              }
              resolve();
            });
        });
      }
    }
    // 归一化路径 → 跟 Python `os.path.normcase + os.path.normpath` 同款 (toLowerCase
    // + 折叠多重反斜杠 + 去尾部反斜杠)
    const normalizeDir = (p) => p ? String(p).replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase() : '';
    for (const [pid, path, exeName] of pidPaths) {
      if (path) {
        const normP = normalizeDir(path);
        const suffix = '\\' + exeName;
        if (!normP.endsWith(suffix)) continue;
        const dir = normP.slice(0, normP.length - suffix.length);
        if (!result.has(dir)) result.set(dir, []);
        result.get(dir).push(pid);
      } else {
        // path null (admin 进程 / tasklist 兜底) → 放 unknown bucket
        // 调用方 _findMt5PidsForInstall 找不到 install dir 时会试 unknown bucket
        // 作 last-resort (假定有未知 dir 进程"可能"就是要找的那个).
        const KEY = '__unknown__';
        if (!result.has(KEY)) result.set(KEY, []);
        result.get(KEY).push(pid);
      }
    }
    Object.defineProperty(result, '_scanOk', { value: psOk || fallbackOk });
    _allMt5ProcsCache = result;
    _allMt5ProcsCacheTs = Date.now();
    return result;
  })().finally(() => { _allMt5ProcsInflight = null; });
  return _allMt5ProcsInflight;
}

// 0.4.7: 抽出 Map → PIDs 查找逻辑, 供两个 caller 共用:
//   1) _findMt5PidsForInstall (async, 自己 await _scanAllMt5Procs)
//   2) strategies:list IPC (3487/3499) 已经预先拿到 Map, 不能再 await
// 之前 strategies:list 直接 `allMt5Procs.get(norm)` 不带 __unknown__ fallback →
// 用户 case (PowerShell 拿不到 path, 全 PID 进 __unknown__) UI 显「MT5 已停止」
// 但实际 EA 在跑 (mt5_probe 连得上 / 风险巡查 work). 这是用户报「可以开启 mt5
// 就是连接不上」的真根因 — 不是连接失败, 是 UI 状态判断 bug.
// 1.3.x: 抽出模块级共享助手 —— 给 strategies.list() 组齐「全部实例 + 各自 running 状态」
// 的参数。⚠ 之前 UI 的 strategies:list IPC 自己拼这套(传 mt5InstancesList, 按 EA 绑定的
// 实例算挂载/运行状态), 但注入给 mobile-relay 的 getRunningEas 只传了默认实例路径 ——
// 导致**绑在非默认实例上的 EA**(如实盘的 GMarket_easydeal版 绑 EXNESS2, 默认是 EXNESS)
// 永远按默认实例的日志/.chr 判定, 查不到自己 → 服务端/app 显「已部署·未确认」, 但桌面 UI
// (走对了实例)显示「运行中」——两边不一致(用户实测)。抽成模块级, 两处调用同一份逻辑。
async function _resolveStrategiesListArgs() {
  // ensureDetected() re-runs MT5 detection if installDir/dataDir are still
  // null (e.g. user started MT5 AFTER EasyDeal launched, or the portable
  // install isn't in the registry). Throttled to 15s, so calling on every
  // 5s mount-pulse refresh is cheap once paths are known.
  const m = (await settings.ensureDetected()).mt5;
  // 0.3.220: 传 mt5InstancesList 让 list() 按 EA 绑的 mt5_instance_id 算
  // 挂载状态 / verify_against_mt5, 而不是全部按默认实例算. 让用户切完
  // dropdown 后, EA 行的"已挂载"/"运行中"/"新版已编译"等 tag 真按新实例 reflect.
  // 0.3.230: 一次扫所有 terminal64.exe 进程, 给每个 instance 算 running 字段,
  // strategies.list() 据此过滤「日志有挂载痕迹但 MT5 关了」的误报「运行中」.
  const instancesBare = settings.listMt5Instances?.() || [];
  let allMt5Procs = new Map();
  try { allMt5Procs = await _scanAllMt5Procs(); } catch {}
  // 0.4.7: 用 _pidsForInstallFromMap 替代直接 `.get(norm)` — 后者漏 __unknown__
  // bucket fallback, 用户 case (PowerShell admin / 杀软 拿不到进程 path) 全部
  // PID 进 __unknown__ → UI 每个 instance 显「已停止」即使 EA 在跑 + Python SDK
  // 连得上. _findMt5PidsForInstall 早在 0.3.346 修了, 但这条 IPC 走的不是它,
  // 直接拿原始 Map 自己查, 漏。helper 抽出来统一.
  const instances = instancesBare.map((it) => {
    const pids = _pidsForInstallFromMap(allMt5Procs, it.installDir);
    return {
      id: it.id,
      dataDir: it.dataDir,
      installDir: it.installDir,
      running: pids.length > 0,
    };
  });
  // 0.3.234: 默认 instance 的 running 状态 — EA 没显式绑 instance 时 fallback 用它.
  // 不传的话 strategies.js 默认 true 会让 GMarket 这种走默认绑定的 EA 永远显「运行中」
  // 即使默认 MT5 已停止.
  // 1.0.3: 默认路径 + defaultRunning 一律以 registry 的 active instance 为准 (跟 MT5
  // tab 的 mt5-instances:list 同源), 不再信 legacy settings.mt5 (= ensureDetected().mt5).
  // 根因 (用户报「实盘策略栏状态不对」): ensureDetected().mt5 的路径可能是早期 auto-detect
  // 落到泛化 C:\Program Files\MetaTrader 5, 而用户真正注册 + 在跑的 active instance 是
  // C:\Program Files\MetaTrader 5 EXNESS — 二者一旦不一致:
  //   (a) defaultRunning 用 m.installDir 查不到进程 → 走默认绑定的 EA (GMarket) 在策略页
  //       误显「⚠ MT5 未运行」, 但 MT5 tab 那个实例明明「运行中」(它查的是 registry 路径).
  //   (b) strategies.list 用 m.dataDir 读错 MT5 的 deals → 本地统计 (交易数/盈利/时长) 也错.
  // 用 active instance 的 dataDir/installDir + 已算好的 running 同时修这两条; active
  // instance 不存在 (边缘) 时回退 legacy m.* 保持老行为.
  const activeId = settings.getResolved?.()?.activeMt5InstanceId
    || settings.data?.activeMt5InstanceId
    || null;
  const activeRow = activeId ? instances.find((x) => x.id === activeId) : null;
  const defInstallDir = activeRow?.installDir || m.installDir;
  const defDataDir    = activeRow?.dataDir    || m.dataDir;
  const defaultRunning = activeRow
    ? activeRow.running
    : _pidsForInstallFromMap(allMt5Procs, defInstallDir).length > 0;
  return {
    mt5DataDir: defDataDir, mt5InstallDir: defInstallDir,
    mt5InstancesList: instances,
    defaultRunning,
    activeMt5InstanceId: activeRow ? activeId : null,
  };
}

// 数据大屏 K 线的品种来源: 各在跑 MT5 实例现在挂着 EA 的图表品种, 默认实例在前(同品种优先从它取)。
// 没登记实例(老单 MT5 用户)→ 只有默认实例, instance_id=null(Python 端不 rebind)。
async function _boardKlineSources() {
  const args = await _resolveStrategiesListArgs();
  const list = args.mt5InstancesList.length
    ? [...args.mt5InstancesList].sort((a, b) =>
      Number(b.id === args.activeMt5InstanceId) - Number(a.id === args.activeMt5InstanceId))
    : [{ id: null, dataDir: args.mt5DataDir, installDir: args.mt5InstallDir, running: args.defaultRunning }];
  const out = [];
  for (const inst of list) {
    if (!inst.running) continue;
    const symbols = await strategies.runningChartSymbols({ mt5DataDir: inst.dataDir, mt5InstallDir: inst.installDir });
    if (symbols.length) out.push({ instance_id: inst.id || null, symbols });
  }
  return out;
}

function _pidsForInstallFromMap(allMap, installDir) {
  if (!installDir || !allMap) return [];
  const norm = String(installDir).replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase();
  const direct = allMap.get(norm);
  if (direct?.length) return direct;
  for (const [dir, pids] of allMap) {
    if (dir === '__unknown__') continue;
    if (dir.startsWith(norm + '\\')) return pids;
  }
  const unknown = allMap.get('__unknown__');
  if (unknown?.length) {
    try {
      const fs = require('node:fs');
      const pathMod = require('node:path');
      const exe64 = pathMod.join(installDir, 'terminal64.exe');
      const exe32 = pathMod.join(installDir, 'terminal.exe');
      if (fs.existsSync(exe64) || fs.existsSync(exe32)) {
        return unknown;
      }
    } catch {}
  }
  return [];
}

async function _findMt5PidsForInstall(installDir) {
  // 0.4.12: 回到 0.4.2 简洁形式 — 复用 _pidsForInstallFromMap helper (= 0.4.7
  // 抽出来的 normalize + prefix match + __unknown__ bucket fallback 三段逻辑,
  // 跟 0.4.2 inline 实现等价). 0.4.9 self-contained tasklist 兜底删掉 — 它在
  // 多 MT5 场景下误判 (用户 3 install kill 1 留 2 → 误返「在跑」).
  // 真根因 = PowerShell ASCIIEncoding 摧毁中文路径, 0.4.10 已在 _scanAllMt5Procs
  // PS 命令里修, 这里不需要再加 fallback.
  if (!installDir) return [];
  const all = await _scanAllMt5Procs();
  return _pidsForInstallFromMap(all, installDir);
}

// Safety-critical lifecycle decisions must never claim an unknown-path
// terminal process belongs to a configured instance.  The legacy helper uses
// the shared __unknown__ bucket for UI availability; launch/attach paths fail
// closed and tell the user to align process privileges instead.
async function _findMt5PidsForInstallStrict(installDir) {
  if (!installDir) return { pids: [], unknownPids: [], scanOk: false };
  try {
    const all = await _scanAllMt5Procs();
    const scanOk = all?._scanOk === true;
    return {
      pids: [...(all.get(normalizeMt5Path(installDir)) || [])],
      unknownPids: [...(all.get('__unknown__') || [])],
      scanOk,
      ...(scanOk ? {} : { error: 'PowerShell 和 tasklist 都无法枚举 MT5 进程' }),
    };
  } catch (e) {
    return { pids: [], unknownPids: [], scanOk: false, error: String(e?.message || e) };
  }
}

function _setMt5Lifecycle(id, patch) {
  const next = { ...(_mt5Lifecycle.get(id) || {}), ...patch, updatedAt: Date.now() };
  _mt5Lifecycle.set(id, next);
  try {
    if (win && !win.isDestroyed()) win.webContents.send('mt5:lifecycle-changed', { id, ...next });
  } catch {}
  return next;
}

async function _stopInstanceAfterIdentityFailure(inst, reason, { terminate = true } = {}) {
  _mt5LaunchAuthorization.delete(inst.id);
  _mt5RestartAuthorization.delete(inst.id);
  try { global._clearLaunchFlag?.(inst.installDir); } catch {}
  try { global._writeKillFlag?.(inst.installDir); } catch {}
  try { await settings.updateMt5Instance(inst.id, { user_intent: 'stopped' }); } catch {}
  const scan = await _findMt5PidsForInstallStrict(inst.installDir);
  if (terminate && scan.scanOk) {
    const cp = require('node:child_process');
    for (const pid of scan.pids) {
      try { cp.execSync(`taskkill /PID ${Number(pid)} /F`, { stdio: 'ignore' }); } catch {}
    }
  }
  _allMt5ProcsCache = null;
  _setMt5Lifecycle(inst.id, {
    state: terminate ? 'error' : 'external',
    pids: terminate ? [] : (scan.scanOk ? scan.pids : []),
    lastError: reason,
    misses: 0,
  });
}

async function _probeMt5InstanceIdentity(inst) {
  const probeScript = resolveBundledFile('python', 'mt5_probe.py');
  if (!fs.existsSync(probeScript)) return { ok: false, error: 'mt5_probe.py missing' };
  const pythonBin = settings.getResolved().pythonBin || 'python';
  return await new Promise((resolve) => {
    const cp = require('node:child_process');
    const child = cp.spawn(pythonBin, [probeScript], {
      env: {
        ...process.env,
        EASYDEAL_MT5_INSTALL_DIR: inst.installDir,
        EASYDEAL_MT5_DATA_DIR: inst.dataDir,
        EASYDEAL_MT5_LAUNCH_MODE: inst.launchMode,
        EASYDEAL_MT5_INSTANCE_ID: inst.id,
        EASYDEAL_MT5_ALLOW_LAUNCH: '0',
        EASYDEAL_MT5_SUPERVISOR_VERIFY: '1',
        EASYDEAL_DATA_DIR: path.join(app.getPath('userData'), 'data'),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e) }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ ok: false, error: `probe parse failed: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}` }); }
    });
  });
}

function _scheduleMt5Verification(inst, pid, {
  delayMs = 60_000,
  attempt = 0,
  bootWaits = 0,
  owned = false,
  onVerified = null,
  token = null,
} = {}) {
  // Each launch starts a new chain and supersedes the previous one.  A chain
  // left over from an earlier launch would otherwise spend its last retry on
  // the freshly started process and kill it.
  const chainToken = token ?? ++_mt5VerificationSeq;
  if (token == null) _mt5VerificationChain.set(inst.id, { token: chainToken, pid });
  const isLive = () => _mt5VerificationChain.get(inst.id)?.token === chainToken;
  setTimeout(async () => {
    if (!isLive()) return;
    const current = settings?.listMt5Instances?.().find((it) => it.id === inst.id);
    if (!current || current.user_intent !== 'running') {
      _mt5VerificationChain.delete(inst.id);
      return;
    }
    const result = await _probeMt5InstanceIdentity(current);
    if (!isLive()) return;
    const actualDataDir = result?.terminal?.data_path || null;
    if (result?.ok && actualDataDir && sameMt5Path(actualDataDir, current.dataDir)) {
      _mt5VerificationChain.delete(inst.id);
      try { global._clearLaunchFlag?.(current.installDir); } catch {}
      _mt5LaunchAuthorization.delete(current.id);
      _setMt5Lifecycle(current.id, {
        state: 'running', pids: pid ? [pid] : [], seenRunning: true, misses: 0,
        actualDataDir, lastError: null, verifiedAt: Date.now(),
      });
      if (typeof onVerified === 'function') {
        Promise.resolve().then(() => onVerified(current)).catch((e) => {
          console.warn('[mt5-supervisor] post-verify action failed:', e?.message || e);
        });
      }
      return;
    }
    const reason = result?.init_error || result?.error || '无法验证 MT5 实例身份';
    const next = planMt5VerificationRetry({ reason, attempt, bootWaits });
    if (next.action === 'retry') {
      _scheduleMt5Verification(current, pid, {
        delayMs: next.delayMs,
        attempt: next.attempt,
        bootWaits: next.bootWaits,
        owned,
        onVerified,
        token: chainToken,
      });
      return;
    }
    _mt5VerificationChain.delete(inst.id);
    const prefix = owned
      ? '启动后身份校验失败，已停止本次由 EasyDeal 启动的进程'
      : '现有 MT5 身份校验失败，已隔离但未终止外部进程';
    await _stopInstanceAfterIdentityFailure(current, `${prefix}：${reason}`, { terminate: owned });
  }, Math.max(0, delayMs)).unref?.();
}

async function _pollMt5Lifecycle() {
  if (!settings?.listMt5Instances) return;
  for (const inst of settings.listMt5Instances()) {
    if (!inst.id || !inst.installDir) continue;
    const scan = await _findMt5PidsForInstallStrict(inst.installDir);
    const prev = _mt5Lifecycle.get(inst.id) || {
      state: 'unknown', pids: [], seenRunning: false, misses: 0, lastError: null,
    };
    if (!scan.scanOk || (scan.unknownPids.length && !scan.pids.length)) {
      _setMt5Lifecycle(inst.id, {
        state: 'error',
        lastError: '无法读取 MT5 进程路径；已禁止后台连接和自动启动，请统一 EasyDeal/MT5 权限',
      });
      continue;
    }
    const pids = scan.pids;
    if (pids.length) {
      const replaced = prev.pids?.length && !prev.pids.some((pid) => pids.includes(pid));
      const authorized = (_mt5LaunchAuthorization.get(inst.id) || 0) > Date.now();
      if (replaced && !authorized) {
        try { global._writeKillFlag?.(inst.installDir); } catch {}
        try { await settings.updateMt5Instance(inst.id, { user_intent: 'stopped' }); } catch {}
        _setMt5Lifecycle(inst.id, {
          state: 'external', pids, seenRunning: true, misses: 0,
          lastError: '检测到未经授权的 MT5 进程替换；已切为停止状态，后台不会再连接或重启它',
        });
      } else {
        _setMt5Lifecycle(inst.id, {
          state: inst.user_intent === 'stopped' ? 'external' : (prev.state === 'starting' ? 'starting' : 'running'),
          pids, seenRunning: true, misses: 0,
        });
      }
      continue;
    }
    const missing = reconcileMissingMt5Process({
      userIntent: inst.user_intent,
      seenRunning: prev.seenRunning,
      misses: prev.misses || 0,
      authorized: (_mt5LaunchAuthorization.get(inst.id) || 0) > Date.now(),
      restarting: (_mt5RestartAuthorization.get(inst.id) || 0) > Date.now(),
    });
    if (missing.action === 'persist_stop') {
        try { global._writeKillFlag?.(inst.installDir); global._clearLaunchFlag?.(inst.installDir); } catch {}
        try { await settings.updateMt5Instance(inst.id, { user_intent: 'stopped' }); } catch {}
        _mt5LaunchAuthorization.delete(inst.id);
        _mt5RestartAuthorization.delete(inst.id);
        _setMt5Lifecycle(inst.id, {
          state: 'stopped', pids: [], seenRunning: false, misses: 0,
          lastError: null, stoppedReason: 'process_exited',
        });
    } else {
      _setMt5Lifecycle(inst.id, {
        state: missing.state,
        pids: [],
        misses: missing.misses,
        ...(missing.state === 'starting' ? { lastError: null } : {}),
      });
    }
  }
}

function startMt5LifecycleSupervisor() {
  if (_mt5LifecycleTimer) return;
  _pollMt5Lifecycle().catch((e) => console.warn('[mt5-supervisor] initial poll failed:', e?.message || e));
  _mt5LifecycleTimer = setInterval(() => {
    _pollMt5Lifecycle().catch((e) => console.warn('[mt5-supervisor] poll failed:', e?.message || e));
  }, 3_000);
  _mt5LifecycleTimer.unref?.();
  console.log('[mt5-supervisor] started (attach-only background policy, 3s observer)');
}

/**
 * 0.3.220: 把指定 PID 的 MT5 主窗口拉到前台. 不送键盘事件 (0.3.219 之前
 * 的 _sendKeyCtrlEToPid 注入 Ctrl+E 切「算法交易」开关在 Win11 上不稳, 干掉).
 *
 * 返:
 *   { ok: true } 或
 *   { ok: false, step, detail, stderr? }
 *   step ∈ 'find_window' / 'set_foreground_failed' / 'powershell_error' / 'timeout' / 'both_paths_failed'
 *
 * 双路径 fallback:
 *   1) Win32 P/Invoke (FindMainByPid → AttachThreadInput → SetForegroundWindow)
 *   2) WScript.Shell COM (AppActivate by PID) — Win11 UIPI 严时备胎
 */
async function _bringWindowToFront(targetPid) {
  if (!targetPid) return { ok: false, step: 'no_pid', detail: 'targetPid is empty' };
  const cp = require('node:child_process');
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, step: 'not_win32', detail: process.platform });
    // 0.3.245: 用户用户 Win11 22H2+ 撞 try1 (Win32 SetForegroundWindow) + try2
    // (WScript.Shell AppActivate) 都被 UIPI 拒. 加 3 个新 fallback:
    //   try3: ALT 按键 trick — keybd_event 模拟 Alt down/up 让 Windows 给前进程
    //         临时前台权(系统认为有用户输入活动), 紧接着 SetForegroundWindow.
    //         经典 Win11 绕 UIPI 套路, 大多数情况下能 work.
    //   try4: 最小化+恢复 — ShowWindow(SW_MINIMIZE) → ShowWindow(SW_RESTORE).
    //         不算前台请求 (UIPI 不拦), 但 Restore 时窗口自然获得前台.
    //   try5: SwitchToThisWindow(hwnd, true) — 老 API, 有时绕过 UIPI 限制.
    const psScript = `
$ErrorActionPreference = 'Continue'
$pidT = ${targetPid}

# ============= Win32 helpers =============
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool fUnknown);
  public const int SW_RESTORE = 9;
  public const int SW_MINIMIZE = 6;
  public const byte VK_MENU = 0x12;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static IntPtr FindMainByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // 返回: "ok" / "no_window" / "fg_failed:HWND=0x...:LastErr=N"
  public static string BringToFrontVerbose(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    uint targetPidDummy;
    uint targetTid = GetWindowThreadProcessId(hwnd, out targetPidDummy);
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    if (targetTid != myTid) attached = AttachThreadInput(myTid, targetTid, true);
    bool fgOk = SetForegroundWindow(hwnd);
    int lastErr = Marshal.GetLastWin32Error();
    if (attached) AttachThreadInput(myTid, targetTid, false);
    if (!fgOk) return "fg_failed:HWND=0x" + hwnd.ToInt64().ToString("X") + ":LastErr=" + lastErr;
    return "ok";
  }
  // 0.3.245: ALT 按键 trick — Windows 认为当前进程有用户输入活动 → 给临时前台权 →
  // 紧接着 SetForegroundWindow 就能通过 UIPI. 这是 Win11 22H2+ 绕 UIPI 的经典方案.
  public static string AltTrickBringToFront(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    // 模拟 Alt 按下 + 释放 (空脉冲, 没人会注意到, 但能让 OS 觉得我们有用户输入)
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);                  // ALT down
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);    // ALT up
    bool fgOk = SetForegroundWindow(hwnd);
    int lastErr = Marshal.GetLastWin32Error();
    if (!fgOk) return "alt_trick_failed:HWND=0x" + hwnd.ToInt64().ToString("X") + ":LastErr=" + lastErr;
    return "ok";
  }
  // 0.3.245: 最小化 + 恢复 — ShowWindow 不算前台请求, UIPI 不拦; Restore 时窗口
  // 自然获得前台 (Windows 行为). 缺点是 MT5 会闪一下最小化再弹出, 视觉略突兀,
  // 但能 work 是关键.
  public static string MinimizeRestore(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    ShowWindow(hwnd, SW_MINIMIZE);
    System.Threading.Thread.Sleep(50);
    ShowWindow(hwnd, SW_RESTORE);
    System.Threading.Thread.Sleep(50);
    IntPtr fg = GetForegroundWindow();
    if (fg != hwnd) return "minrestore_fg_mismatch:fg=0x" + fg.ToInt64().ToString("X") + ":want=0x" + hwnd.ToInt64().ToString("X");
    return "ok";
  }
  // 0.3.245: SwitchToThisWindow — 老 API (Win9x 时代), Windows 偶尔放行 UIPI 限制.
  // 第 2 参数 fUnknown=true 据说能 force 切换.
  public static string SwitchTo(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    SwitchToThisWindow(hwnd, true);
    System.Threading.Thread.Sleep(50);
    IntPtr fg = GetForegroundWindow();
    if (fg != hwnd) return "switchto_fg_mismatch:fg=0x" + fg.ToInt64().ToString("X") + ":want=0x" + hwnd.ToInt64().ToString("X");
    return "ok";
  }
}
"@

# ============= Attempt 1: Win32 SetForegroundWindow + AttachThreadInput =============
$try1 = [Win]::BringToFrontVerbose([uint32]$pidT)
if ($try1 -eq "ok") { Write-Output "ok:win32"; exit 0 }
if ($try1 -eq "no_window") { Write-Output "fail:no_window"; exit 1 }

# ============= Attempt 2: ALT 按键 trick (Win11 UIPI 绕过最经典方案) =============
$try2 = [Win]::AltTrickBringToFront([uint32]$pidT)
if ($try2 -eq "ok") { Write-Output "ok:alt_trick"; exit 0 }

# ============= Attempt 3: 最小化 + 恢复 (不算前台请求, UIPI 不拦) =============
$try3 = [Win]::MinimizeRestore([uint32]$pidT)
if ($try3 -eq "ok") { Write-Output "ok:minrestore"; exit 0 }

# ============= Attempt 4: SwitchToThisWindow (老 API 备胎) =============
$try4 = [Win]::SwitchTo([uint32]$pidT)
if ($try4 -eq "ok") { Write-Output "ok:switchto"; exit 0 }

# ============= Attempt 5: WScript.Shell AppActivate (最弱 fallback) =============
try {
  $wsh = New-Object -ComObject WScript.Shell
  $activated = $wsh.AppActivate([int]$pidT)
  if ($activated) {
    Write-Output "ok:wscript"
    exit 0
  } else {
    Write-Output "fail:try1=$try1:try2=$try2:try3=$try3:try4=$try4:try5=appactivate_false"
    exit 1
  }
} catch {
  Write-Output "fail:try1=$try1:try2=$try2:try3=$try3:try4=$try4:try5_exc=$($_.Exception.Message)"
  exit 1
}
`;
    // 0.3.223: 改 cp.execFile + -EncodedCommand 不走 stdin pipe — 旧版 cp.exec
    // + .stdin.end(psScript) 在 Windows 上 stdin 关闭时序不稳, PowerShell 偶发
    // 读不全脚本就异常退出, 用户看到「PowerShell 子进程异常退出」. EncodedCommand
    // 直接走 cmd-line arg (base64 utf16le), 不依赖 stdin 读取, 完全稳定.
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    cp.execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout || '').trim();
        const stderrText = String(stderr || '').trim().slice(0, 500);
        // 解析 stdout 最后一行
        const lastLine = text.split(/\r?\n/).filter(Boolean).pop() || '';
        if (lastLine.startsWith('ok:')) {
          return resolve({ ok: true, via: lastLine.slice(3) });   // 'win32' or 'wscript'
        }
        if (err && err.killed) {
          return resolve({ ok: false, step: 'timeout',
            detail: 'PowerShell 超时 (>5s) — system 卡',
            stderr: stderrText });
        }
        if (lastLine.startsWith('fail:')) {
          // fail:try1=fg_failed:HWND=...:LastErr=N:try2=appactivate_returned_false
          // 含 no_window → step=find_window; 否则归 set_foreground_failed
          const step = lastLine.includes('no_window') ? 'find_window' : 'set_foreground_failed';
          return resolve({ ok: false, step,
            detail: lastLine.slice(5),
            stderr: stderrText });
        }
        // 没拿到识别的输出 / PowerShell exit code 非 0 — 完整透出 stdout + stderr 帮诊断
        const exitCode = err ? `exit=${err.code}` : 'no-err';
        return resolve({ ok: false, step: 'powershell_error',
          detail: `${exitCode} | stdout=${text || '(empty)'} | stderr=${stderrText || '(empty)'}`,
          stderr: stderrText });
      });
  });
}

function checkMt5Running(installDir) {
  return new Promise((resolve) => {
    const installed = installDir ? hasTerminalAt(installDir) : false;
    const cp = require('node:child_process');
    if (process.platform === 'win32') {
      cp.exec('tasklist /FI "IMAGENAME eq terminal64.exe" /FO CSV /NH', (err, stdout) => {
        const running64 = !err && /terminal64\.exe/i.test(stdout || '');
        if (running64) {
          const m = (stdout || '').match(/"terminal64\.exe","(\d+)"/i);
          return resolve({ status: 'running', running: true, installed: true,
            pid: m ? Number(m[1]) : null, platform: 'win32' });
        }
        cp.exec('tasklist /FI "IMAGENAME eq terminal.exe" /FO CSV /NH', (err2, stdout2) => {
          const running = !err2 && /terminal\.exe/i.test(stdout2 || '');
          if (running) return resolve({ status: 'running', running: true, installed: true, platform: 'win32' });
          if (installed) return resolve({ status: 'installed_not_running', running: false, installed: true, platform: 'win32' });
          return resolve({ status: 'not_installed', running: false, installed: false, platform: 'win32' });
        });
      });
      return;
    }
    cp.exec('pgrep -fil terminal64 || pgrep -fil "MetaTrader 5"', (err, stdout) => {
      const running = !err && (stdout || '').trim().length > 0;
      const status = running ? 'running' : (installed ? 'installed_not_running' : 'not_installed');
      resolve({ status, running, installed, platform: process.platform });
    });
  });
}

function hasTerminalAt(dir) {
  if (!dir) return false;
  const fs = require('node:fs');
  try {
    return fs.existsSync(path.join(dir, 'terminal64.exe'))
        || fs.existsSync(path.join(dir, 'terminal.exe'));
  } catch { return false; }
}

// 0.3.189 Phase 2: 按 EA 解析挂载目标实例。
//   - 如果 EA 在 records 里绑了 mt5_instance_id 且该实例还存在 → 用该实例
//   - 否则 → fallback 到活动实例 (settings.mt5 同款 dataDir/installDir)
// 返回 { instance_id, installDir, dataDir, source: 'per-ea' | 'active' | 'none' }.
async function resolveMt5ForEa(eaName) {
  const detected = await settings.ensureDetected();
  const activeInst = settings.getActiveMt5Instance?.();
  const fallback = {
    instance_id: settings.data?.activeMt5InstanceId || null,
    installDir:  detected?.mt5?.installDir || null,
    dataDir:     detected?.mt5?.dataDir || null,
    launchMode:  activeInst?.launchMode || null,
    source:      'active',
  };
  if (!strategies || !eaName) return fallback;
  let boundId = null;
  try { boundId = strategies.getMt5InstanceForEa(eaName); } catch {}
  if (!boundId) return fallback;
  const all = settings.listMt5Instances?.() || [];
  const inst = all.find((it) => it.id === boundId);
  if (!inst) {
    console.warn(`[mt5-resolve] EA ${eaName} bound to instance ${boundId} but it no longer exists; falling back to active`);
    return { ...fallback, source: 'active' };  // 旧绑定指向已删除实例 → 回 fallback
  }
  return {
    instance_id: inst.id,
    installDir:  inst.installDir || fallback.installDir,
    dataDir:     inst.dataDir    || inst.installDir || fallback.dataDir,
    launchMode:  inst.launchMode || fallback.launchMode,
    source:      'per-ea',
  };
}

// 0.3.271: per-installDir single-flight guard for launchMt5.
// 之前用户实测: launch-flag 在 2ms 内同款 flag 写 2 次 → 2 个 MT5 process 被
// spawn (一个变僵尸). 根因: 幂等 check (_findMt5PidsForInstall) 跟 cp.spawn
// 之间有 await window, 2 个并发 caller 同时通过 check → 同时 spawn. 加 promise
// share guard 让并发 caller 共享同一次 spawn, 跟 startWechatSidecar 0.3.268 同款.
const _launchMt5InFlight = new Map();   // normalizedInstallDir → Promise

// 0.5.x: EasyDeal 自己拉起的 MT5 → 记 installDir→pid。实例 list 用 process.kill(pid,0)
// **瞬时**查活(不枚举进程),根治「机器枚举进程慢到 WMI/tasklist 双双超时 → 永远误判
// 已停止」(实测某实盘机 Get-CimInstance 12.8s / tasklist 14.4s,远超 5s/4s 超时,
// 安全软件 hook 进程查询所致)。外部启动的 MT5 仍走慢扫描(已放宽超时兜底)。
const _easydealLaunchedMt5Pids = new Map();   // normInstallDir → pid
function _normInstallKey(d) {
  return d ? String(d).replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase() : '';
}
function _easydealLaunchedPidAlive(installDir) {
  const key = _normInstallKey(installDir);
  const pid = _easydealLaunchedMt5Pids.get(key);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }            // 进程在 → running
  catch (e) {
    if (e && e.code === 'EPERM') return true;            // 存在但无权限 signal = 仍在跑
    _easydealLaunchedMt5Pids.delete(key); return false;  // ESRCH = 已退出
  }
}

// 0.3.271: mounted-state.json — Python attach 成功后写, Node launchMt5 读 +
// 自动恢复 startup.ini. 用户痛点修复: 关 MT5 后再用 EasyDeal 启动 → EA + 图表
// 都消失 (因 MT5 默认启动不读 startup.ini, 而 ini 是一次性的).
function _mountedStatePath() {
  try { return path.join(app.getPath('userData'), 'data', 'mounted-state.json'); }
  catch { return null; }
}

function _normInstallKey(installDir) {
  return String(installDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function _loadMountedState(installDir) {
  try {
    const fp = _mountedStatePath();
    if (!fp || !fs.existsSync(fp)) return null;
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8')) || {};
    return state[_normInstallKey(installDir)] || null;
  } catch (e) {
    _traceLog('loadMountedState err', String(e?.message || e));
    return null;
  }
}

// 0.4.41: 删 EA 时跨 store 级联清理 — 之前 strategies:delete 只删 workspace/strategies/<EA>.{mq5,ex5,md,installed.json}
// (strategies.deleteFile), 漏清 mounted-state / ea-monitor / 各 MT5 实例 ex5+config / OG enabled 状态 →
// list_mt5_instances / get_trading_status tool_result 里残留 stale 账号信息 (mounted_login 等), AI 被
// 动喂到这些数据用户合理误以为「AI 读了不该读的账号」. 主路径 = 此 cascade; B 防御层 = mt5-instances:list
// 返回前对 mounted_ea_name 做 cross-check 抹掉 stale.
function _clearMountedStateForEa(eaName) {
  try {
    const fp = _mountedStatePath();
    if (!fp || !fs.existsSync(fp)) return { cleared: 0 };
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8')) || {};
    let cleared = 0;
    for (const k of Object.keys(state)) {
      if ((state[k]?.ea_name || '') === eaName) { delete state[k]; cleared++; }
    }
    if (cleared > 0) fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf-8');
    return { cleared };
  } catch (e) { return { cleared: 0, error: String(e?.message || e) }; }
}

function _clearEaMonitorEntry(eaName) {
  try {
    const fp = path.join(app.getPath('userData'), 'workspace', '.easydeal-ea-monitor.json');
    if (!fs.existsSync(fp)) return { cleared: 0 };
    const m = JSON.parse(fs.readFileSync(fp, 'utf-8')) || {};
    if (m[eaName] === undefined) return { cleared: 0 };
    delete m[eaName];
    fs.writeFileSync(fp, JSON.stringify(m, null, 2), 'utf-8');
    return { cleared: 1 };
  } catch (e) { return { cleared: 0, error: String(e?.message || e) }; }
}

function _deleteEaArtifactsInInstances(eaName) {
  const result = { instances_touched: 0, files: [] };
  try {
    const insts = settings?.listMt5Instances?.() || [];
    for (const inst of insts) {
      // 1.2.x: 非 portable 实例的 MQL5 树在 dataDir (AppData hash 目录), 不在
      // installDir — 只删 installDir 会漏掉真正部署的 ex5, 卸载后 is_deployed
      // 仍 true → 行卡「运行中」不灭 (用户 exness 实例实测)。两个根都删。
      const roots = new Set([inst.installDir, inst.dataDir].filter(Boolean));
      let touched = false;
      for (const dir of roots) {
        const targets = [
          path.join(dir, 'MQL5', 'Experts', `${eaName}.ex5`),
          path.join(dir, 'MQL5', 'Experts', `${eaName}.ex5.compiled_from`),
          path.join(dir, 'MQL5', 'Files', `${eaName}_config.set`),
          path.join(dir, 'MQL5', 'Files', `${eaName}_runtime.json`),
        ];
        for (const t of targets) {
          try {
            if (fs.existsSync(t)) { fs.unlinkSync(t); result.files.push(t); touched = true; }
          } catch { /* per-file ignore — 文件被 MT5 锁住等情况, 下次再删 */ }
        }
      }
      if (touched) result.instances_touched++;
    }
  } catch (e) { result.error = String(e?.message || e); }
  return result;
}

async function _cascadeDeleteEa(eaName) {
  const summary = { ea: eaName };
  summary.mounted   = _clearMountedStateForEa(eaName);
  summary.monitor   = _clearEaMonitorEntry(eaName);
  summary.artifacts = _deleteEaArtifactsInInstances(eaName);
  try {
    if (typeof orderguard?.disableEa === 'function') {
      summary.og = await orderguard.disableEa(eaName);
    }
  } catch (e) { summary.og = { error: String(e?.message || e) }; }
  _traceLog('cascade-delete-ea', JSON.stringify(summary));
  return summary;
}

// 1.1.x: 卸载 (unmount) — 跟 _cascadeDeleteEa 完全相同的 4 步逆操作 (清 mounted-state →
// 不再自动挂载 / 删各 MT5 实例 .ex5+config+runtime → 从 MT5 卸下 / 清 ea-monitor / OG disable →
// 删护航), **但调用方不删 workspace 源码**, 所以策略仍在「我的策略」里(未挂载态)可重新挂载。
// 正在运行的那只: 文件删 + mounted-state 清 → 下次 MT5 启动不再加载; 当前内存里跑的需重启
// MT5 或图表手动移除 (跟 delete 同语义, 不做脆弱的 live-detach UI 自动化)。独立 trace 标签便于诊断。
async function _unmountEa(eaName) {
  const summary = { ea: eaName };
  summary.mounted   = _clearMountedStateForEa(eaName);
  summary.monitor   = _clearEaMonitorEntry(eaName);
  summary.artifacts = _deleteEaArtifactsInInstances(eaName);
  try {
    if (typeof orderguard?.disableEa === 'function') {
      summary.og = await orderguard.disableEa(eaName);
    }
  } catch (e) { summary.og = { error: String(e?.message || e) }; }
  _traceLog('unmount-ea', JSON.stringify(summary));
  return summary;
}

// 跟 Python `_build_startup_ini` 完全等价的 JS 复刻 — 复刻而不是 spawn Python
// 因为 launchMt5 是 hot path, 不能等 Python child 启动 (慢 500ms-1s).
//
// 0.3.295: 修「chart 开了但 EA 没挂上」根因.
// [Experts] section ExpertsEnable/ExpertsTrades 是 0.3.250 实测有效的 (不改).
// 真正问题在 [StartUp] Expert= 字段格式: 老 `Expert=SimpleBTC` (光名字) MT5
// silent ignore. 改成 `Expert=Experts\\<EA>.ex5` (相对 MQL5 root + 带扩展).
function _buildStartupIniBody({ symbol, period, eaName, login, server, omitExpert = false, presetFile = '' }) {
  const lines = ['[Common]'];
  if (login)  lines.push(`Login=${parseInt(login, 10)}`);
  if (server) lines.push(`Server=${server}`);
  lines.push('');
  lines.push('[Experts]');
  lines.push('ExpertsEnable=true');
  lines.push('ExpertsDllImport=false');
  lines.push('ExpertsExpImport=true');
  lines.push('ExpertsTrades=true');
  // 0.3.310: AllowLiveTrading=1 — MT5 官方 startup config 标准字段
  // (metatrader5.com 文档明示, 但 0.3.311 实测对 EA 实例 checkbox 没生效).
  // 留着无害, 万一某些 MT5 build 认; checkbox 持久化靠下面 omitExpert 路径.
  lines.push('AllowLiveTrading=1');
  lines.push('');
  lines.push('[StartUp]');
  lines.push(`Symbol=${symbol}`);
  lines.push(`Period=${period}`);
  // 0.3.318: 回到 Expert= manual-attach 路径 + F7 hotkey 强制弹对话框.
  // 0.3.317 不写 Expert= 让 Default.tpl 接管 → EA 完全没挂上 (MT5 创建 chart
  // 时只 apply Default.tpl 的视觉属性, 不 attach template 里的 EA).
  // 改回 Expert=, EA 挂上 chart 后 Python 主动 F7 弹属性框 + auto-confirm 勾 ☑.
  if (eaName) {
    lines.push(`Expert=${eaName}.ex5`);
    // 1.2.24: ExpertParameters 指向 MQL5/Presets/<EA>.set —— 用户在「参数设置」改的值
    // (Python write_ea_parameters 已写到 Presets/<EA>.set, 本意就是「重挂/启动时拿到新值」)
    // 在 MT5 启动加载 EA 时被读入。之前这里**恒空** → 改了参数永远用编译默认值
    // (用户报的「InpMaxLoss 怎么改都是默认 3000」根因)。只有预设文件确实存在才写,
    // 否则留空 = 原行为, 零回归。
    lines.push(`ExpertParameters=${presetFile || ''}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

// 0.3.314: Node 端复刻 Python `_build_easydeal_template_tpl` — 用于
// launchMt5 mounted-state restore 路径. 跟 Python 同款逻辑: UTF-16 LE + BOM
// 编码, \r\n 行分隔, <expert> block 含 expertmode=1.
function _writeEasydealTemplateTpl(installDir, eaName, symbol, period) {
  const periodMap = {
    M1: [0, 1], M5: [0, 5], M15: [0, 15], M30: [0, 30],
    H1: [1, 1], H4: [1, 4],
    D1: [2, 1], W1: [3, 1], MN1: [4, 1],
  };
  const periodUpper = String(period || 'H1').toUpperCase();
  const [periodType, periodSize] = periodMap[periodUpper] || [1, 1];
  const chartId = Date.now() * 1_000_000;   // 纳秒级 (跟 reference 对齐)
  const description = `${symbol} chart`;
  const eaPath = `Experts\\${eaName}.ex5`;

  const body =
    `<chart>\n` +
    `id=${chartId}\n` +
    `symbol=${symbol}\n` +
    `description=${description}\n` +
    `period_type=${periodType}\n` +
    `period_size=${periodSize}\n` +
    `digits=2\ntick_size=0.010000\nposition_time=0\nscale_fix=0\n` +
    `scale_fixed_min=0.000000\nscale_fixed_max=0.000000\nscale_fix11=0\n` +
    `scale_bar=0\nscale_bar_val=1.000000\nscale=16\nmode=1\nfore=0\ngrid=1\n` +
    `volume=1\nscroll=1\nshift=0\nshift_size=19.279279\nfixed_pos=0.000000\n` +
    `ticker=1\nohlc=0\none_click=0\none_click_btn=1\nbidline=1\naskline=0\n` +
    `lastline=0\ndays=0\ndescriptions=0\ntradelines=1\ntradehistory=1\n` +
    `window_left=0\nwindow_top=0\nwindow_right=0\nwindow_bottom=0\n` +
    `window_type=1\nfloating=0\nfloating_left=0\nfloating_top=0\n` +
    `floating_right=0\nfloating_bottom=0\nfloating_type=1\n` +
    `floating_toolbar=1\nfloating_tbstate=\nbackground_color=0\n` +
    `foreground_color=16777215\nbarup_color=65280\nbardown_color=65280\n` +
    `bullcandle_color=0\nbearcandle_color=16777215\nchartline_color=65280\n` +
    `volumes_color=3329330\ngrid_color=10061943\nbidline_color=10061943\n` +
    `askline_color=255\nlastline_color=49152\nstops_color=255\n` +
    `windows_total=1\n\n` +
    `<expert>\nname=${eaName}\npath=${eaPath}\nexpertmode=1\n` +
    `<inputs>\n</inputs>\n</expert>\n\n` +
    `<window>\nheight=100.000000\nobjects=0\n\n` +
    `<indicator>\nname=Main\npath=\napply=1\nshow_data=1\n` +
    `scale_inherit=0\nscale_line=0\nscale_line_percent=50\n` +
    `scale_line_value=0.000000\nscale_fix_min=0\nscale_fix_min_val=0.000000\n` +
    `scale_fix_max=0\nscale_fix_max_val=0.000000\nexpertmode=0\n` +
    `fixed_height=-1\n</indicator>\n</window>\n</chart>\n`;

  // 0.3.317: 写 Default.tpl 接管 + EA 同名 .tpl 备份. 最大覆盖率 4 份:
  //   MQL5/Profiles/Templates/Default.tpl + <EA>.tpl
  //   profiles/Templates/Default.tpl + <EA>.tpl
  // MT5 创建新 chart → 自动 apply Default.tpl → EA via template + expertmode=1.
  const bodyCrlf = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const utf16Buf = Buffer.from(bodyCrlf, 'utf16le');
  const bom = Buffer.from([0xff, 0xfe]);
  const payload = Buffer.concat([bom, utf16Buf]);

  const written = [];
  for (const tplDir of [
    path.join(installDir, 'MQL5', 'Profiles', 'Templates'),
    path.join(installDir, 'profiles', 'Templates'),
  ]) {
    fs.mkdirSync(tplDir, { recursive: true });
    for (const fname of [`${eaName}.tpl`, 'Default.tpl']) {
      const fp = path.join(tplDir, fname);
      fs.writeFileSync(fp, payload);
      written.push(fp);
    }
  }

  _traceLog('tpl write', `${written.length} files written for ea=${eaName} symbol=${symbol} period=${period}`);
  return written[0];
}

function _writeRestoreStartupIni(installDir, state) {
  const workspaceDir = path.join(app.getPath('userData'), 'workspace');
  const cfgDir = path.join(workspaceDir, 'mt5-startup-ini');
  fs.mkdirSync(cfgDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const safeSym = String(state.symbol || 'X').replace(/[\/\\]/g, '_');
  const fname = `easydeal_restore_${safeSym}_${state.period}-${state.ea_name}_${ts}.ini`;
  const iniPath = path.join(cfgDir, fname);
  // 0.3.314: 用 .tpl 模板路径. 先确保 .tpl 文件存在 — 首次挂载是 Python 端
  // 写的, 但 Node 端 launchMt5 mounted-state restore 时如果用户中间 reinstall
  // MT5 / 删 templates 目录, .tpl 没了, 这里 idempotent 重写一遍.
  try {
    _writeEasydealTemplateTpl(installDir, state.ea_name, state.symbol, state.period);
  } catch (e) {
    _traceLog('tpl write err (continuing)', String(e?.message || e));
  }
  // 1.2.24: 若该 EA 有「参数设置」写下的预设(MQL5/Presets/<EA>.set), 让 startup.ini 的
  // ExpertParameters 指向它 → MT5 重启加载 EA 时套用用户改的参数。只在文件确实存在时引用
  // (零回归: 没改过参数的 EA, startup.ini 跟以前一模一样)。portable MT5 下 dataDir=installDir。
  let presetFile = '';
  try {
    const pName = `${state.ea_name}.set`;
    if (fs.existsSync(path.join(installDir, 'MQL5', 'Presets', pName))) presetFile = pName;
  } catch {}
  const body = _buildStartupIniBody({
    symbol: state.symbol, period: state.period, eaName: state.ea_name,
    login:  state.login,  server: state.server, presetFile,
  });
  fs.writeFileSync(iniPath, body, 'utf-8');
  return iniPath;
}

async function launchMt5(instance, opts = {}) {
  if (!instance || typeof instance !== 'object') {
    return { ok: false, error: '必须按 instanceId 启动 MT5，禁止只按程序目录启动' };
  }
  const checked = validateMt5Instance(instance, { siblings: settings?.listMt5Instances?.() || [] });
  if (!checked.ok) return { ok: false, error: checked.errors.join('；'), config_error: true };
  const inst = checked.instance;
  const installDir = inst.installDir;
  const normKey = String(inst.id);
  const existing = _launchMt5InFlight.get(normKey);
  if (existing) {
    _traceLog('launchMt5 SINGLE-FLIGHT share', `installDir=${installDir}`);
    return existing;
  }
  const p = _launchMt5Inner(inst, opts)
    .finally(() => { _launchMt5InFlight.delete(normKey); });
  _launchMt5InFlight.set(normKey, p);
  // 记下 EasyDeal 拉起的 terminal64.exe pid, 供实例 list 瞬时查活 (不走慢 WMI)
  p.then((r) => {
    if (r && r.ok && r.pid) {
      _easydealLaunchedMt5Pids.set(_normInstallKey(installDir), r.pid);
      const prev = _mt5Lifecycle.get(inst.id) || {};
      _mt5Lifecycle.set(inst.id, {
        ...prev,
        state: r.already_running ? 'running' : 'starting',
        pids: [r.pid],
        seenRunning: true,
        misses: 0,
        lastError: null,
      });
    }
  }).catch(() => {});
  return p;
}

async function _launchMt5Inner(inst, opts = {}) {
  const { installDir, dataDir, launchMode } = inst;
  // 0.3.230: 强幂等检查 — launchMt5 是所有 MT5 spawn 入口的最后一道闸. UI 状态
  // 滞后 / launch-flag race / autoLaunchRunningInstances 跟用户点击叠加 — 都可能
  // 让多个 caller 同时调到这里. 不依赖 caller 自己 check 进程, 这里查一次 WMI
  // 缓存 (1s TTL), 已有进程就直接返成功不 spawn 第二个.
  try {
    const scan = await _findMt5PidsForInstallStrict(installDir);
    if (!scan.scanOk) {
      return { ok: false, error: `无法安全枚举 MT5 进程，已拒绝启动：${scan.error || 'process scan failed'}` };
    }
    if (scan.pids.length > 0) {
      const existing = scan.pids;
      _traceLog('launchMt5 IDEMPOTENT skip', `installDir=${installDir} existing_pids=${existing.join(',')}`);
      console.log(`[mt5-launch] ${installDir} 已在跑 (pid=${existing.join(',')}), 跳过 spawn 防双进程`);
      // 这个进程若已有在途校验链 (刚由 EasyDeal 启动), 保留它 — 否则会把 owned 链
      // 连同 onVerified (post_launch_arm_ea) 一起顶掉.
      if (_mt5VerificationChain.get(inst.id)?.pid !== existing[0]) {
        _scheduleMt5Verification(inst, existing[0], { delayMs: 1_000, owned: false });
      }
      return { ok: true, pid: existing[0], already_running: true };
    }
    if (scan.unknownPids.length > 0) {
      return {
        ok: false,
        error: `检测到 ${scan.unknownPids.length} 个无法读取路径的 MT5 进程。为避免启动错实例，请让 EasyDeal 与 MT5 使用相同权限后重试。`,
        elevation_mismatch: true,
      };
    }
  } catch (e) {
    // Fail closed: path identity unavailable means spawning may create a second
    // terminal or bind the SDK to an unrelated instance.
    _traceLog('launchMt5 idempotency check failed (blocked)', String(e?.message || e));
    return { ok: false, error: `无法安全确认现有 MT5 进程，已拒绝启动：${String(e?.message || e)}` };
  }
  return new Promise((resolve) => {
    try {
      _traceLog('launchMt5 ENTRY', `installDir=${installDir}`);
      const exe = path.join(installDir,
        fs.existsSync(path.join(installDir, 'terminal64.exe')) ? 'terminal64.exe' : 'terminal.exe');
      if (!fs.existsSync(exe)) return resolve({ ok: false, error: `terminal64.exe 不在 ${installDir}` });
      // 0.3.228: 统一在 launchMt5 这里写 launch-flag — 所有调用方 (mt5-instances:launch IPC
      // / _autoLaunchRunningInstances boot / app:launch-mt5 legacy / Python attach 等)
      // 都自动有 lifecycle 防双进程, 不再依赖 caller 自己记得写. 老 caller 仍可显式
      // 调 _writeLaunchFlag (无害, 同款 file 重复写). Python 端通过 _write_mt5_launch_flag
      // 写同款 md5 path, 跨进程协调.
      try {
        if (global._writeLaunchFlag) global._writeLaunchFlag(installDir);
        else {
          // 启动期 (registerIpc 还没跑) fallback — 直接写文件
          const crypto = require('node:crypto');
          const hash = crypto.createHash('md5').update(String(installDir).toLowerCase()).digest('hex').slice(0, 12);
          const fp = path.join(app.getPath('userData'), 'data', `mt5-launching-${hash}.flag`);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, String(Date.now()), 'utf8');
        }
      } catch (e) {
        _traceLog('launchMt5 write launch-flag failed', String(e?.message || e));
      }
      // launchMode is explicit configuration.  Directory sniffing is banned:
      // deployment itself may create MQL5/Config/Profiles in a standard install.
      const isPortable = launchMode === 'portable';
      // 0.3.271: 查 mounted-state.json — 如果该 instance 上次成功挂过 EA → 自动
      // 重写 startup.ini + /config: 启动, 让 EA + 图表自动恢复. 解决「关 MT5
      // 后再用 EasyDeal 启动 → EA / 图表消失」用户痛点. 安全网:
      //   · 只在 .ex5 文件仍存在时才用 (EA 可能被用户删了 / 切到别的 binding)
      //   · 失败任何一步都 fallback 走老逻辑 (无 ini 启动), 不阻塞用户启动 MT5
      const extraArgs = [];
      let restoredEaName = null;   // 0.3.272: 记下来用于 post-launch arm
      try {
        const state = _loadMountedState(installDir);
        if (state && state.ea_name && state.symbol && state.period) {
          // 验 EA .ex5 还在 MQL5/Experts/ 下 — 不在就跳过 (避免 MT5 弹「找不到 EA」错)
          const ex5Path = path.join(dataDir, 'MQL5', 'Experts', `${state.ea_name}.ex5`);
          if (fs.existsSync(ex5Path)) {
            // 0.4.25 req3: 只恢复「EasyDeal 自动挂载 + 仍绑本实例(或未绑)」的 EA。
            // 用户自己在 MT5 里手挂的 EA 不会进 mounted-state.json (自然不被强制恢复);
            // 但若用户在 UI 下拉把这只 EA 改绑到「别的」MT5 实例 → 主动改了归属, 不该
            // 再用本实例的旧记录强制恢复 + 把绑定抢回本实例 (下面 0.3.304 auto-bind)。
            let _req3Skip = false, _req3Reason = '';
            if (state.mount_mode && state.mount_mode !== 'auto') {
              // mounted-state.json 只由 auto-attach 写 (mount_mode='auto'); 老数据无该字段=auto。
              _req3Skip = true; _req3Reason = `mount_mode=${state.mount_mode}`;
            } else {
              try {
                const _insts = settings.listMt5Instances?.() || [];
                const _normP = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
                const _thisInst = _insts.find((it) => _normP(it.installDir) === _normP(installDir));
                const _boundId = strategies.getMt5InstanceForEa?.(state.ea_name);
                if (_boundId && _thisInst && _boundId !== _thisInst.id) {
                  _req3Skip = true; _req3Reason = `EA 已绑到别的实例 (${_boundId} != ${_thisInst.id})`;
                }
              } catch (e) {
                _traceLog('launchMt5 req3 guard err', String(e?.message || e));
              }
            }
            // 0.3.327: detect MT5 default profile 是否已含目标 EA. 是 → 不写 ini Expert=
            // (让 MT5 自然 restore default profile, EA + allow=true 都自动恢复, 不需要
            // 后续 F7 + auto-confirm). 是用户「自行挂载 EA」场景的修复。
            // 1.3.21: 该实例当前挂了 ≥2 个 EA → 绝不写强制单 EA ini(它只开一个图表, 会把
            // 其它在跑策略的图表覆盖丢掉, 斯宇实测: 4账户各一副本, 重新部署后另一套没恢复)。
            // 让 MT5 恢复自己的完整 profile(所有图表+EA); 重新部署的 .ex5 已在盘上, MT5 重启
            // 自动 reload。dataDir 从实例配置取(非便携时 .chr 在 AppData 那份)。
            let _hasTargetChart = false, _multiEa = false;
            try {
              const _mountPlan = _planMt5Mount(installDir, state.ea_name, dataDir);
              _hasTargetChart = _mountPlan.action === 'reloaded_existing_chart';
              _multiEa = _mountPlan.action === 'restored_multi_ea_profile';
            } catch {}
            if (_hasTargetChart) {
              _traceLog('launchMt5 existing chart restore',
                `.chr 已含 EA ${state.ea_name}, 原图 restore-only (不写 ini、不新开图)`);
              console.log(`[mt5-launch] ${state.ea_name} 已在活动 profile → 原图重载，不创建新图表`);
              restoredEaName = null;
            } else if (_multiEa) {
              _traceLog('launchMt5 skip restore (multi-EA)', `实例挂了≥2个EA, 让 MT5 恢复完整 profile 保住其它策略`);
              console.log('[mt5-launch] 实例挂了多个 EA → 跳过强制单 EA ini, 让 MT5 恢复完整 profile（保住其它在跑策略）');
              restoredEaName = null;
            } else if (_req3Skip) {
              _traceLog('launchMt5 skip restore (req3)', `ea=${state.ea_name} reason=${_req3Reason}`);
              console.log(`[mt5-launch] skip auto-restore EA ${state.ea_name} — ${_req3Reason}（让 MT5 走自己的 profile）`);
              restoredEaName = null;
            } else {
              const iniPath = _writeRestoreStartupIni(installDir, state);
              extraArgs.push(`/config:${iniPath}`);
              restoredEaName = state.ea_name;
              _traceLog('launchMt5 auto-restore EA',
                `ea=${state.ea_name} symbol=${state.symbol} period=${state.period} ini=${iniPath}`);
              console.log(`[mt5-launch] auto-restore EA ${state.ea_name} on ${state.symbol}/${state.period}`);
            }
            // 0.3.304: 主动绑 EA → instance_id, 防 UI 下次点挂载误弹「选 MT5」.
            // 模拟盘 case: mounted-state.json 有 SimpleBTC + install_dir, 但 records.mt5_instance_id=null
            // → strategies-view 多 MT5 + 未绑 → 点挂载弹「选 MT5」, 用户感觉「明明已挂为啥还要选」.
            // mounted-state restore 时既然能确认 EA 跟 install_dir 对应, 主动 setMt5InstanceForEa.
            try {
              const matched = inst;
              // 0.4.25 req3: _req3Skip (EA 已绑到别的实例 / 非 auto) 时不抢绑回本实例
              if (!_req3Skip && matched && strategies?.setMt5InstanceForEa) {
                const currentBound = strategies.getMt5InstanceForEa?.(state.ea_name);
                if (currentBound !== matched.id) {
                  // fire-and-forget — 不 await, 不阻塞 launchMt5
                  strategies.setMt5InstanceForEa(state.ea_name, matched.id)
                    .then(() => {
                      _traceLog('launchMt5 auto-bind EA→instance',
                        `ea=${state.ea_name} id=${matched.id} name=${matched.name}`);
                      console.log(`[mt5-launch] auto-bind EA ${state.ea_name} → instance ${matched.name} (was ${currentBound || 'null'})`);
                      // 0.4.30: 自动改绑也清旧实例 OG 孤儿启用记录 (fire-and-forget)
                      try { orderguard?.cleanupReboundEa?.(state.ea_name, currentBound, matched.id); } catch (_) {}
                    })
                    .catch((e) => _traceLog('launchMt5 auto-bind err', String(e?.message || e)));
                }
              }
            } catch (e) {
              _traceLog('launchMt5 auto-bind sync err', String(e?.message || e));
            }
          } else {
            _traceLog('launchMt5 skip restore (no ex5)',
              `ea=${state.ea_name} expected_ex5=${ex5Path}`);
          }
        }
      } catch (restoreErr) {
        _traceLog('launchMt5 restore-state err', String(restoreErr?.message || restoreErr));
      }
      // 1.2.3: portable 副本目录里放一个「手动启动」bat(幂等) — 用户直接双击
      // terminal64.exe(不带 /portable)会进 AppData 空白数据世界, 账号/图表/EA
      // 看起来全"消失"。给个一键正确入口, 手动启动跟 EasyDeal 启动同世界。
      if (isPortable) {
        try {
          const fsb = require('node:fs');
          const batPath = require('node:path').join(installDir, '手动启动MT5(点这个).bat');
          if (!fsb.existsSync(batPath)) {
            fsb.writeFileSync(batPath, '@echo off\r\ncd /d "%~dp0"\r\nstart "" terminal64.exe /portable\r\n', 'utf8');
          }
        } catch {}
      }
      const args = isPortable ? ['/portable', ...extraArgs] : extraArgs;
      _traceLog('launchMt5 spawn', `exe=${exe} args=${JSON.stringify(args)} portable=${isPortable}`);
      const cp = require('node:child_process');
      // 0.3.204: cp.spawn 可能 sync throw (e.g. exe 路径含 NUL byte / windows
      // CreateProcess 失败). 包在 try/catch 里, 别让它把整个 main 进程 SIGSEGV.
      let child;
      try {
        child = cp.spawn(exe, args, {
          detached: true,
          stdio: 'ignore',
          cwd: installDir,
          windowsHide: false,
          shell: false,
        });
      } catch (spawnErr) {
        _traceLog('launchMt5 spawn SYNC THROW', String(spawnErr?.message || spawnErr));
        return resolve({ ok: false, error: 'spawn 同步异常: ' + String(spawnErr?.message || spawnErr) });
      }
      if (child.on) {
        child.on('error', (e) => {
          _traceLog('launchMt5 child error', String(e?.message || e));
        });
      }
      try { child.unref(); } catch {}
      _traceLog('launchMt5 spawned OK', `pid=${child.pid}`);
      _allMt5ProcsCache = null;
      console.log(`[mt5-launch] spawned ${exe} ${args.join(' ')} (portable=${isPortable})`);
      // 0.3.272: 走了 mounted-state restore 路径 → fire-and-forget 调 Python
      // post_launch_arm_ea, 把算法交易开关 + EA 对话框 auto-confirm 这两步补上.
      // 用户实测 0.3.272 「能挂上 EA 但算法交易没开」: 因老的挂载流程
      // 才会调 _ensure_algotrading_on, launchMt5 单独 spawn 不调. 这里补上对齐.
      // detached + 不 await, 不阻塞 launchMt5 返回. 失败仅记 trace log.
      // opts.armEaName: 挂载流程刚把 EA 写进图表配置并启动 MT5, 同样要开算法交易开关。
      const armEaName = restoredEaName || opts.armEaName || null;
      let onVerified = null;
      if (armEaName) {
        onVerified = () => callEasydealMcpOnce('post_launch_arm_ea', {
            install_dir:    installDir,
            ea_name:        armEaName,
            boot_wait_sec:  5.0,
          }, { timeoutMs: 120_000, envOverride: {
            EASYDEAL_MT5_INSTALL_DIR: installDir,
            EASYDEAL_MT5_DATA_DIR: dataDir,
            EASYDEAL_MT5_LAUNCH_MODE: launchMode,
            EASYDEAL_MT5_INSTANCE_ID: inst.id,
            EASYDEAL_MT5_ALLOW_LAUNCH: '0',
          } })
            .then((r) => {
              _traceLog('post_launch_arm_ea result',
                `ok=${r?.ok} algo=${r?.algotrading?.status} dlg=${r?.ea_dialog?.status}`);
              console.log(`[mt5-launch] post_launch_arm_ea: algotrading=${r?.algotrading?.status} ea_dialog=${r?.ea_dialog?.status}`);
            })
            .catch((e) => {
              _traceLog('post_launch_arm_ea err', String(e?.message || e));
            });
      }
      _scheduleMt5Verification(inst, child.pid, { owned: true, onVerified });
      resolve({ ok: true, pid: child.pid, portable: isPortable, restored_ea: restoredEaName });
    } catch (e) {
      _traceLog('launchMt5 outer throw', String(e?.stack || e?.message || e).slice(0, 500));
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

// Cached at app startup by registerIpc / bootstrap so ensureWechatSidecar
// can spawn the sidecar without needing the workspace path threaded
// through every IPC handler.
let _wechatWorkspaceDir = null;
// Single-flight guard — multiple concurrent IPCs (e.g. status pulse +
// loginQr fired at the same moment the user opens settings) shouldn't
// start two Python children. The first caller's promise is shared.
let _wechatStartPromise = null;

/**
 * Idempotent on-demand WeChat sidecar starter. Returns the (possibly
 * still-warming-up) sidecar instance, or null if Python script is missing
 * / startup actually failed. Safe to call from any wechat IPC handler.
 *
 * Behaviour:
 *   - sidecar already exists & ready → return immediately
 *   - sidecar already exists, still booting → await the in-flight start
 *   - sidecar absent → spawn Python child + MCP handshake, then return
 */
async function ensureWechatSidecar() {
  if (wechatSidecar?.client?.ready) return wechatSidecar;
  if (_wechatStartPromise) return _wechatStartPromise;
  _wechatStartPromise = (async () => {
    if (!wechatSidecar) {
      await startWechatSidecar(_wechatWorkspaceDir);
    } else if (!wechatSidecar.client?.ready) {
      // Object exists from a prior failed start — try start() again.
      try { await wechatSidecar.start(); } catch {}
    }
    return wechatSidecar;
  })().finally(() => { _wechatStartPromise = null; });
  return _wechatStartPromise;
}

// 0.3.268: single-flight guard for startWechatSidecar itself — health-died
// handler / fallback rebuild path 直接调它绕开 ensureWechatSidecar guard.
// 实测用户撞 6 个 Python child 同一秒 spawn → orphan child 抢 iLink cursor →
// inbound 错乱. 加这层 guard + 先 stop 老 sidecar 防 child orphan.
let _startWechatSidecarInFlight = null;

async function startWechatSidecar(workspaceDir) {
  if (_startWechatSidecarInFlight) {
    console.log('[wechat] startWechatSidecar already in flight, awaiting');
    return _startWechatSidecarInFlight;
  }
  _startWechatSidecarInFlight = _startWechatSidecarInner(workspaceDir)
    .finally(() => { _startWechatSidecarInFlight = null; });
  return _startWechatSidecarInFlight;
}

async function _startWechatSidecarInner(workspaceDir) {
  // 0.3.268: 先 stop 老 sidecar — startWechatSidecar 被并发调用时, 老 wechatSidecar
  // (含活跃 Python child) 会被新 new 覆盖, child 没人 stop → orphan. 这里显式 stop.
  if (wechatSidecar) {
    console.log('[wechat] startWechatSidecar: stopping existing sidecar before respawn');
    try { await wechatSidecar.stop(); } catch (e) {
      console.warn('[wechat] stop old sidecar failed:', e?.message || e);
    }
    wechatSidecar = null;
  }
  const scriptPath = resolveBundledFile('python', 'wechat_mcp.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[wechat] script missing at', scriptPath);
    return;
  }
  const dataDir = path.join(app.getPath('userData'), 'data');
  // 0.3.255: dev 模式 (process.defaultApp = electron 主进程 launched via electron CLI
  // 而不是 packaged exe) 或 test 模式 (EASYDEAL_TEST_PORT env) 时, 把 wechat
  // session state dir 隔离到 tmp, 不跟用户生产 EasyDeal 共享 token 文件 —
  // 否则两个进程会用同一个 token long-poll iLink, 互相抢入站消息 cursor.
  // 2026-05-24 模拟盘 case: 我跑 dev 验证 .tpl removal 时启的 dev sidecar 跟
  // prod sidecar 共享 STATE_DIR, 抢用户「你好」消息 → 用户报「单向收消息」.
  let stateDir = path.join(dataDir, 'wechat-session');
  if (process.defaultApp || process.env.EASYDEAL_TEST_PORT) {
    const os = require('node:os');
    const isolated = path.join(os.tmpdir(),
      `easydeal-dev-wechat-${process.env.EASYDEAL_TEST_PORT || 'devmode'}`);
    try { require('node:fs').mkdirSync(isolated, { recursive: true }); } catch {}
    stateDir = isolated;
    console.log('[wechat] dev/test mode detected — using isolated state dir:', stateDir);
  }
  const s = settings.getResolved();
  // Per-WeChat-user Claude session 持久化（0.1.62+）—— 让每个 wechat 联系人
  // / 群有独立 session JSONL，跟电脑端 chat tab 互不干扰，跨重启也保留。
  if (!wechatSessions) {
    wechatSessions = new WechatSessionStore(path.join(dataDir, 'wechat-sessions.json'));
    await wechatSessions.load();
    // 三个月没用的就 prune 掉（chatId 短期不会复用，但极少数情况下用户
    // 删了好友又重加可能复用 wxid，这里给个上限避免脏 mapping）
    try { wechatSessions.pruneOlderThan(90); } catch {}
  }
  wechatSidecar = new WechatSidecar({
    pythonBin: s.pythonBin || 'python',
    scriptPath,
    stateDir,
    workspaceDir,    // for inbound media download path
    log: (m) => console.log('[wechat]', m),
    onCommand: (payload) => {
      // Pass the whole payload through — sidecar's pollInbound includes
      // body / text / raw which earlier versions of this wrapper dropped
      // by destructuring only a partial set of fields.
      handleWechatInboundCommand(payload)
        .catch((e) => console.error('[wechat] inbound handler error:', e));
    },
  });
  wechatSidecar.on('status', (st) => {
    try { win?.webContents.send('wechat:status', st); } catch {}
    // Re-emit CLAUDE.md when wechat login state flips so Claude either
    // gains the wechat handling instructions (on login) or loses the
    // "推到微信吧" suggestion habit (on logout / not yet logged in).
    try { kb?.setWechatLoggedIn?.(!!st?.logged_in); } catch {}
  });
  // 0.3.262: pending queue 变化时通知 renderer 更新 dormant chip
  wechatSidecar.on('pending-changed', (payload) => {
    try { win?.webContents.send('wechat:pending-changed', payload); } catch {}
  });
  // 0.3.252+ Phase 3: 主动推送 ACK 检测 — sendMessage 后 60s 没收到 iLink
  // 推回来的 bot echo 视为 timeout, retry 2 次仍失败 → emit 这个 event.
  // 让 renderer 知道关键推送丢了 + log 出明细帮 admin 调查 (告警 / 升级提示
  // / chat reply 等丢失会让用户错过重要信息, 必须明确告知).
  wechatSidecar.on('send-permanently-failed', (payload) => {
    console.warn('[wechat] send-permanently-failed:', payload);
    try { win?.webContents.send('wechat:send-failed', payload); } catch {}
  });
  // 0.3.252+: sidecar 探活 (15min 周期 send→filehelper) 连续 3 次失败 → 这
  // 个 event 触发. 重 spawn 整只 Python MCP 进程 — 比单 refreshStatus 重连
  // 更彻底, 覆盖 sub-process 内部状态损坏 / token cache 错位等场景.
  wechatSidecar.on('health-died', async (payload) => {
    console.warn('[wechat] health-died event:', payload, '— restarting sidecar process');
    try { win?.webContents.send('wechat:health-died', payload); } catch {}
    try {
      // stop 老 sidecar (会清 statusTimer + inboundLoop + Python child)
      await wechatSidecar.stop();
    } catch (e) {
      console.warn('[wechat] stop during health-died failed:', e?.message || e);
    }
    // 让 main 重启
    try {
      await wechatSidecar.start();
      console.log('[wechat] sidecar respawned after health-died');
    } catch (e) {
      console.error('[wechat] respawn after health-died failed:', e?.message || e);
      // 二次尝试: 完全重建对象 (token / state 全 reset)
      try {
        wechatSidecar = null;
        await startWechatSidecar(_wechatWorkspaceDir);
        console.log('[wechat] sidecar full-rebuilt after health-died');
      } catch (e2) {
        console.error('[wechat] full-rebuild also failed:', e2?.message || e2);
      }
    }
  });
  // 0.4.6: 持久化 recentByChat 到磁盘 — 重启后聊天记录抽屉能看到历史会话
  // + 跟 AI 后续推的回测结果通知。位置跟其它 data 同目录方便 admin 排查 / 用
  // 户备份。
  try {
    const recentPath = path.join(app.getPath('userData'), 'data', 'wechat-recent.json');
    await wechatSidecar.enablePersistence(recentPath);
  } catch (e) {
    console.warn('[wechat] enablePersistence failed:', e?.message || e);
  }
  // 0.4.6: 实时事件 — recordExchange 后给 renderer 抽屉推一条，让它即时刷新
  // （之前要点 🔄 刷新按钮才能看到新消息，新加的回测通知就会被错过）
  wechatSidecar.on('exchange', (payload) => {
    try { win?.webContents.send('wechat:exchange', payload); } catch {}
  });
  await wechatSidecar.start();
  // 0.3.152: 注册到 timer-registry, critical=true (panic 时也跑, 不停)
  // 让用户「监控」tab 能看到 wechat 状态; 用户也能单独 disable (但 critical 灰按钮防误点).
  try {
    timerRegistry.registerService({
      id: 'wechat-sidecar',
      description: '微信收发 sidecar (60s 状态 + 35s 长轮询入站消息)',
      critical: true,   // 收发能力 panic 时也保留
      pause:  async () => { /* critical: noop */ },
      resume: async () => { /* critical: noop */ },
      status: () => ({
        logged_in: wechatSidecar?.status?.logged_in || false,
        account_id: wechatSidecar?.status?.account_id || null,
        last_check_at: wechatSidecar?.status?.last_check_at || null,
      }),
    });
  } catch {}
}

/**
 * Inbound WeChat dispatcher.
 *
 * Slash commands (immediate, no Claude):
 *   /status, /s     → list mounted EAs + pnl, reply directly
 *   /halt <ea>      → ask Claude to stop an EA (slash retained for clarity)
 *   /help, /?       → reply with command list
 *
 * Anything else: treat as a plain question for Claude.
 *   - Don't send an "已转给 Claude" ack
 *   - Show "正在输入..." (sendTyping keepalive) while Claude works
 *   - When Claude finishes, send the actual reply (which auto-cancels typing)
 *
 * Claude's chat session prompt is shaped so the answer comes back via
 * mcp__wechat__send_message to the same chat — but we ALSO push it from
 * here as a fallback if Claude returns text without using the tool.
 */

// ============================================================
// WeChat inbound message buffering — debounce + batch
// ============================================================
// 当用户在 EasyDeal chat tab 里连发多条 → ChatSession.send 会 kill 当前
// claude + 重新开 → 最终用户得到一个回复。WeChat 这边没有「重发就接着」
// 的语义，所以改用 buffer：
//   1. 收到消息 push 到 _wechatChatBuffers.get(chatId).pending
//   2. setTimeout 4 秒；新消息到达 → reset 计时器
//   3. 计时器 fire → 把 pending 全部合成一个 prompt，spawn Claude 一次
//   4. claude 在跑时新消息进入下一个 buffer，跑完后自动 schedule 下一轮
const WECHAT_DEBOUNCE_MS = 4000;
const _wechatChatBuffers = new Map();    // chatId → { pending, timer, processing, typingHandle }
// 0.3.259: 兜底回复发送时记最后一条 reply 的头 60 char, 防止 Claude 自己已经
// 发过 mcp__wechat__send_message 后再被 fallback 发一次 = 双发.
const _lastWechatFallbackByChat = new Map();  // chatId → last reply head-60 sig

function _getWechatBuf(chatId) {
  let b = _wechatChatBuffers.get(chatId);
  if (!b) {
    b = { pending: [], timer: null, processing: false, typingHandle: null };
    _wechatChatBuffers.set(chatId, b);
  }
  return b;
}

function _enqueueWechatMessage(msg) {
  const buf = _getWechatBuf(msg.chatId);
  buf.pending.push(msg);
  if (!buf.firstEnqueuedAt) buf.firstEnqueuedAt = Date.now();  // wc-trace: 批次首条到达时间
  if (buf.timer) clearTimeout(buf.timer);
  // 启动 typing 指示符（如果还没起的话）让用户知道 bot 在听。
  // typing 在多次重置 / 实际 fire 时会保持运行，发完消息时统一 stop。
  if (!buf.typingHandle && wechatSidecar?.startTyping) {
    try { buf.typingHandle = wechatSidecar.startTyping({ to: msg.chatId }); } catch {}
  }
  buf.timer = setTimeout(() => _fireWechatBatch(msg.chatId)
    .catch((e) => console.error('[wechat-batch] fire failed:', e)),
    WECHAT_DEBOUNCE_MS);
  console.log('[wechat-batch] queued msg for', msg.chatId,
              'pending=', buf.pending.length);
}

async function _fireWechatBatch(chatId) {
  const buf = _wechatChatBuffers.get(chatId);
  if (!buf || !buf.pending.length) return;
  // 同一个 chatId 里上一批还在跑，等它完。注意：不再判 chat.isBusy()
  // —— 0.1.62 起 wechat 走独立 per-chatId session，跟电脑端 chat tab
  // 的 ChatSession 完全分离，互不阻塞、互不污染上下文。
  if (buf.processing) {
    buf.timer = setTimeout(() => _fireWechatBatch(chatId).catch(() => {}), 1500);
    return;
  }

  buf.processing = true;
  buf.timer = null;
  const items = buf.pending;
  buf.pending = [];
  // wc-trace: debounce 实际等待 (首条到达 → 本次 fire) + 处理计时起点
  const _batchWaitMs = Date.now() - (buf.firstEnqueuedAt || Date.now());
  buf.firstEnqueuedAt = null;
  const _spawnT0 = Date.now();

  // 0.3.9: 微信 headless 超时从 5 min 拉到 10 min。5 min 实测会被「带几次
  // MT5 工具调用 + thinking」的请求踩中（用户 case）。
  // 0.3.244: 用户反馈 10 min 仍经常撞超时，拉到 30 min。复杂查询多 MCP 工具
  // 调用 + 多步 thinking + 大文件 Read 累加很容易 > 10min, 30 min 给足余量,
  // 跟 wechat skill daemon.py 的 timeout 对齐.
  const WECHAT_HEADLESS_TIMEOUT_MS = 30 * 60 * 1000;
  // 0.3.9: 60s 没结束就先发个「还在处理…」中间提示，免得用户对着空白
  // 等 5-10 min 以为系统挂了。整个批次只发一次。
  const WECHAT_PROGRESS_HINT_MS = 60 * 1000;
  let _progressHintTimer = null;
  let _progressHintFired = false;
  const _armProgressHint = () => {
    if (_progressHintTimer || _progressHintFired) return;
    _progressHintTimer = setTimeout(async () => {
      _progressHintTimer = null;
      _progressHintFired = true;
      try {
        await wechatSidecar.sendMessage({
          to: chatId,
          text: '🤔 这条请求需要多走几步工具调用，还在跑（最多等几分钟）—— 不用重发，结果会自己来。',
        });
      } catch (e) {
        console.warn('[wechat-batch] progress hint send failed:', e?.message);
      }
    }, WECHAT_PROGRESS_HINT_MS);
  };
  const _cancelProgressHint = () => {
    if (_progressHintTimer) { clearTimeout(_progressHintTimer); _progressHintTimer = null; }
  };

  try {
    const prompt = _buildBatchedWechatPrompt(chatId, items);
    console.log('[wechat-batch] firing', items.length, 'msg(s) for', chatId,
                'prompt len', prompt.length);
    console.log(`[wechat-batch] wc-trace fire chatId=${chatId} batchWaitMs=${_batchWaitMs} items=${items.length} promptLen=${prompt.length}`);
    // Per-chat session：拿 chatId 之前用的 session_id（首次是 null，
    // Claude Code 会新建一条 session JSONL）。spawnHeadlessClaudeWithSession
    // 解析 --output-format json 拿到 session_id，下次同 chatId 来消息时
    // --resume 这条 session JSONL 接着聊。
    // 0.3.4: endpoint fingerprint 校验。chatId 上次 session 的 endpoint
    // 跟当前不一致（用户切了通道 / 改了 model）→ 不能 --resume，否则旧
    // thinking block sig 在新 endpoint 验不过 → API 返 400 `Invalid
    // signature in thinking block`。endpoint 变了就抛掉 prevSessionId 起新。
    const _wechatCurEndpoint = tokenStore?.endpointFingerprint?.() || 'unknown';
    const _prevSidRaw = wechatSessions ? wechatSessions.getSessionId(chatId) : null;
    const _prevEndpoint = wechatSessions ? wechatSessions.getEndpoint(chatId) : null;
    const prevSessionId = (_prevSidRaw && _prevEndpoint && _prevEndpoint === _wechatCurEndpoint)
      ? _prevSidRaw
      : null;   // endpoint 不一致或没记 endpoint → 起新
    const wsDir = kb?.workspaceDir || path.join(app.getPath('userData'), 'workspace');
    let r;
    // 0.3.5: 来源标记 —— 让 MCP 知道这次 spawn 是为微信对话服务的，
    // _auto_schedule_backtest_poll 据此把 cron 的 notify_json 设成
    // ["wechat"]，回测进度不会乱推到 AI 对话框。
    const _spawnEnv = { EASYDEAL_NOTIFY_DEFAULT: 'wechat' };
    _armProgressHint();
    try {
      r = await spawnHeadlessClaudeWithSession({
        prompt,
        cwd: wsDir,
        sessionId: prevSessionId,
        env: _spawnEnv,
        timeoutMs: WECHAT_HEADLESS_TIMEOUT_MS,
      });
    } catch (firstErr) {
      // 0.3.4: thinking sig 不匹配 → 清掉 chatId 的 session 记录 + retry 一次（无 sessionId）
      const errMsg = String(firstErr?.message || '');
      if (/Invalid.*signature.*thinking|thinking.*Invalid.*signature/i.test(errMsg) && prevSessionId) {
        console.warn('[wechat-batch] thinking signature mismatch for', chatId, '— resetting session and retrying once');
        if (wechatSessions) wechatSessions.clear(chatId);
        r = await spawnHeadlessClaudeWithSession({
          prompt,
          cwd: wsDir,
          sessionId: null,
          env: _spawnEnv,
          timeoutMs: WECHAT_HEADLESS_TIMEOUT_MS,
        });
      } else {
        throw firstErr;
      }
    }
    if (r.session_id && wechatSessions) {
      wechatSessions.setSessionId(chatId, r.session_id, _wechatCurEndpoint);
    }
    console.log('[wechat-batch] done for', chatId,
      'session=', r.session_id?.slice(0, 8),
      'cost_usd=', r.total_cost_usd,
      'result_len=', (r.result || '').length,
      'num_turns=', r.num_turns,
      'is_error=', r.is_error,
      'subtype=', r.subtype);
    console.log(`[wechat-batch] wc-trace done chatId=${chatId} procMs=${Date.now() - _spawnT0} resultLen=${(r.result || '').length} calledSend=${r.called_send_message} isError=${r.is_error} cost=${r.total_cost_usd}`);
    // 0.3.259: log Claude 真实返回内容 (头 400 char) — 帮诊断 cost_usd=0 但没回复
    // 的根因. 之前实测: Claude SDK spawn 起来了, session_id 拿到了, 但 cost=0
    // 说明完全没调 LLM. 看 r.result 才知道 SDK 为啥不调 (token 不对? endpoint 错?
    // model 不支持? 还是其它 wechat sidecar config issue).
    if (r.result) {
      console.log('[wechat-batch] result preview:', String(r.result).slice(0, 400));
    }
    // 0.3.259: 启用兜底 — Claude 100% 不主动调 mcp__wechat__send_message (实测).
    // 之前 design 决策 "永远不兜底" 已经被实测推翻. 现在如果 r.result 有内容
    // 就兜底发给用户, 至少看到 Claude 的回复 (或者 SDK 的 error message).
    //
    // 0.3.283: 精准 fallback dedup — claude-runner 改 stream-json 后, r 含
    // called_send_message=true 字段 (Claude 本 turn 真调过 mcp__wechat__send_message).
    // 调了 → fallback 完全静默 (B 通道关闭, 解决「好」 / 客套话 / mcp ack 全部噪音).
    // 没调 → 仍走 fallback 兜底 (防 Claude 忘记调工具用户收不到回复).
    // 老 0.3.269 的 chat.on('tool-use') listener 路径已经废 — headless Claude
    // 不走那个 emit, _lastClaudeSendByChat 永远空. 现在直接看 r.called_send_message.
    if (r.called_send_message) {
      console.log('[wechat-batch] fallback skipped — Claude 本 turn 调过 send_message (',
        r.send_message_invocations?.length || 0, '次) for', chatId);
      return;   // B 通道关闭
    }
    // Claude 没调工具 → fallback 兜底, 走老 noise filter 逻辑
    if (r.result && r.result.trim()) {
      let replyText = String(r.result).trim();
      // 0.3.269: 老 chat.on('tool-use') 路径残留 — 留着不影响 (headless 永远不会触发).
      // 主入口已 0.3.283 改成看 r.called_send_message.
      const lastClaudeSend = globalThis._lastClaudeSendByChat?.get(chatId) || 0;
      if (Date.now() - lastClaudeSend < 2 * 60 * 1000) {
        console.log('[wechat-batch] fallback skipped — legacy chat.on(tool-use) dedup hit (rare path) for', chatId);
        _lastWechatFallbackByChat.set(chatId, replyText.slice(0, 60));
        return;
      }
      // 0.3.269: blacklist mcp ack / 短 emoji 噪音文本 — 这些是 mcp tool 返
      // 的内部 ack 模板被 Claude SDK 当 text 流出来, 不该作为 user reply 发.
      // 0.3.281: 扩 ack 正则覆盖中文短回应 — 用户截图 wechat-batch 把 Claude
      // 的 turn-end ack 「好」/「好的」/「嗯」 都 fallback 发了 (headless
      // Claude spawn 不走 chat.on('tool-use') listener → _lastClaudeSendByChat
      // 永远空 → 那条 2min dedup 防线没用上). 加中文短 ack 词全部 skip.
      // 注意: 保守扩, 只加 stand-alone 完整匹配 (^...$), 不加宽到长度判定避免
      // 误杀「在的, 您说?」这种真实短回复.
      const shortAckRe = /^(消息已发送|message sent|sent|已发送|好|好的|好嘞|好呢|嗯|嗯嗯|嗯哼|收到|明白|明白了|知道了|没问题|可以|行|对|是|是的|是呢|不客气|done|sure|yep|yes|got it|received|noted|确认|👌|🆗|✅|👍)[\s.,。!！~～]*$/i;
      const isMcpAckNoise = shortAckRe.test(replyText)
        || (replyText.length < 8 && /^[a-zA-Z]*$/.test(replyText.replace(/[\s.,。!！]/g, '')));
      if (isMcpAckNoise) {
        console.log('[wechat-batch] fallback skipped — mcp ack noise text:', replyText.slice(0, 40));
        return;
      }
      // 0.3.261: 检测 raw <tool_call> XML 文本 — 这是 OpenAI-compat 通道下
      // 模型不支持 Anthropic native tool_use 协议时的失败模式: 模型把工具
      // 调用模板当文字 stream 出来. 实测用户在微信看到 raw `<tool_call>...
      // <function=mcp__easydeal__get_account>` 这种乱码 (源自 0.3.259 启用
      // fallback). 现在检测到这种模式, 不发 raw, 改发 friendly 错误提示让
      // 用户知道是 model/channel 不匹配 (建议换 model 或换支持 tool calling
      // 的通道).
      const hasToolCallTag = /<tool_call>|<function=mcp__/.test(replyText);
      if (hasToolCallTag) {
        console.warn('[wechat-batch] result contains raw <tool_call> tags — model likely',
          'does not support tool calling. result head:', replyText.slice(0, 200));
        replyText = '⚠ AI 这条回复没正常生成 — 当前 token 通道用的模型可能不支持工具调用 ' +
          '(模型把工具模板当文字输出了). 建议:\n' +
          '1. 「设置 → Token」里换一个支持 tool calling 的 model (如 deepseek-chat / qwen-max / glm-4-plus)\n' +
          '2. 或者切回「Fay」通道 (Anthropic 协议, 一定支持工具)\n' +
          '3. 切了之后再重发您的问题';
      }
      const sig = replyText.slice(0, 60);
      const lastSig = _lastWechatFallbackByChat.get(chatId);
      if (lastSig === sig) {
        console.log('[wechat-batch] fallback skipped (same head-60 as last) for', chatId);
      } else {
        try {
          await wechatSidecar.sendMessage({ to: chatId, text: replyText });
          _lastWechatFallbackByChat.set(chatId, sig);
          console.log('[wechat-batch] fallback reply sent for', chatId, 'len=', replyText.length,
            hasToolCallTag ? '(tool-call sanitized)' : '');
        } catch (fbErr) {
          console.warn('[wechat-batch] fallback reply send failed:', fbErr?.message);
        }
      }
    } else {
      console.warn('[wechat-batch] r.result is empty — Claude SDK returned no text. cost=' +
        r.total_cost_usd + ' is_error=' + r.is_error + ' subtype=' + r.subtype);
    }
  } catch (e) {
    console.error('[wechat-batch] spawn failed:', e);
    // 0.3.9: 错误分类 —— 之前直接把英文 stack 砸给微信用户（用户看到的
    // 「claude run timed out after 300000ms」就是这个）。现在按错误类型
    // 给中文友好文案。timeout / token 不可用 / API 错单独走。
    const errMsg = String(e?.message || e);
    let userText;
    if (/run timed out after/i.test(errMsg)) {
      userText = '⏰ 这条请求处理时间过长（' + Math.round(WECHAT_HEADLESS_TIMEOUT_MS / 60000)
        + ' 分钟），可能是任务太复杂或网络慢。可以把大任务拆成几个小问题再发，或者稍后再试。';
    } else if (/^\[token-mode-/i.test(errMsg)) {
      // classifyTokenSpawnIssue 抛出的 "[token-mode-XXX] 标题 — 内容"
      const m = errMsg.match(/^\[token-mode-[^\]]+\]\s*([^—]+)—\s*(.+)$/);
      userText = m ? `⚠ ${m[1].trim()}：${m[2].trim()}` : ('⚠ 通道异常：' + errMsg.slice(0, 200));
    } else if (/rate.?limit|429/i.test(errMsg)) {
      userText = '⚠ 当前通道暂时被限流，稍等 1-2 分钟再发就行（系统会自动切到可用通道）。';
    } else {
      userText = '⚠ 处理出错：' + errMsg.slice(0, 200) + '\n\n你可以重发这条消息再试一次。';
    }
    try {
      await wechatSidecar.sendMessage({ to: chatId, text: userText });
    } catch {}
  } finally {
    _cancelProgressHint();
    if (buf.typingHandle) {
      try { await buf.typingHandle.stop(); } catch {}
      buf.typingHandle = null;
    }
    buf.processing = false;
    if (buf.pending.length) {
      buf.timer = setTimeout(() => _fireWechatBatch(chatId).catch(() => {}),
                             WECHAT_DEBOUNCE_MS);
    }
  }
}

/**
 * 把多条同 chat 内的消息合成单个 prompt 给 Claude。多条文本用换行分隔；
 * 附件全部展开列出；contextToken 取最新一条的。
 */
/**
 * 0.3.5: 给 wechat batch 看的「电脑端 AI 对话最近活动」block。
 * 数据源：chat.json 的 history 最后 5~8 turns，过滤系统块（live-state /
 * carryover summary）后留 user 提问 + AI 回话头几句，让微信端 AI 能延续
 * 电脑端的工作（admin 用户在 chat 写了 EA、回测，出门用微信问"那个怎样
 * 了"，AI 知道上下文）。
 *
 * 没 chat history / 读取失败 → 返 ''。
 */
function _recentChatTabActivityBlockForWechat() {
  if (!chat) return '';
  try {
    const hist = chat.getHistory() || [];
    if (!hist.length) return '';
    // 取最后 8 turns，过滤掉系统注入的块（resumeHint / carryover prefix）
    const recent = hist.slice(-8);
    const lines = ['<chat-tab-recent-context>'];
    lines.push('admin 用户最近在 EasyDeal **电脑端 AI 对话框**做的事（按时间正序）—— 当微信用户问"那个 EA 写完没 / 回测怎样了 / 之前说的那个改了吗"等延续性问题时，从下面这块找答案，不要让用户重复说背景：');
    let used = 0;
    for (const t of recent) {
      const role = t.role === 'user' ? 'admin' : 'AI';
      let text = String(t.content || '').replace(/\s+/g, ' ').trim();
      // 跳过系统块开头的 turns
      if (text.startsWith('<live-workspace-state>') || text.startsWith('【上一会话摘要') || text.startsWith('【系统提示】')) continue;
      // 截短：每条 120 字
      if (text.length > 120) text = text.slice(0, 117) + '…';
      const tsStr = t.ts
        ? new Date(t.ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        : '?';
      lines.push(`  [${tsStr}] ${role}: ${text}`);
      used += 1;
      if (used >= 6) break;
    }
    if (!used) return '';
    lines.push('</chat-tab-recent-context>');
    lines.push('');
    return lines.join('\n');
  } catch { return ''; }
}

function _buildBatchedWechatPrompt(chatId, items) {
  const allAttachments = [];
  const userTexts = [];
  let contextToken = '';
  for (const it of items) {
    if (it.userInput) userTexts.push(it.userInput);
    if (Array.isArray(it.attachments)) allAttachments.push(...it.attachments);
    if (it.contextToken) contextToken = it.contextToken;
  }
  const synthInput = userTexts.length > 1
    ? userTexts.map((t, i) => `[第 ${i + 1} 条] ${t}`).join('\n')
    : (userTexts[0] || (
        allAttachments.length
          ? `（用户从微信发来 ${allAttachments.length} 个附件）`
          : '(空消息)'
      ));

  // attachments 展开 + Claude 怎么读
  const attachmentsBlock = (() => {
    if (!allAttachments.length) return '';
    const lines = ['\n\n用户附带了以下文件：'];
    let hasReadable = false, hasEncrypted = false;
    for (let i = 0; i < allAttachments.length; i += 1) {
      const a = allAttachments[i];
      const sizeStr = a.size < 1024 ? `${a.size} B`
        : a.size < 1024 * 1024 ? `${(a.size / 1024).toFixed(1)} KB`
        : `${(a.size / 1024 / 1024).toFixed(2)} MB`;
      const fmtTag = a.format ? ` [${a.format}]` : '';
      const decodedTag = a.decoded === false ? ' ⚠ 未解密' : '';
      lines.push(`  ${i + 1}. ${a.kind}${fmtTag}${decodedTag} (${sizeStr})  →  ${a.path}`);
      if (a.kind === 'image' && a.decoded !== false) hasReadable = true;
      if (a.kind === 'encrypted_blob' || a.decoded === false) hasEncrypted = true;
    }
    lines.push('');
    if (hasReadable) lines.push('图片用 Read 工具直接读路径（multimodal 能看到）。');
    if (hasEncrypted) {
      lines.push('⚠ 标了「未解密 / encrypted_blob」的：iLink 把图片用 AES 加密传过来了，');
      lines.push('  本地解密器还没实现 — **不要 Read 它**（API 会报「Could not process image」）。');
      lines.push('  告诉用户：「微信图片走的是加密通道，目前 EasyDeal 还没接解码。请换种方式：');
      lines.push('  ① 在微信里长按图片『发送给』→『文件传输助手』再下载；② 或者直接在 EasyDeal');
      lines.push('  客户端的对话框里粘贴图片（multimodal 完全能看）。」');
    }
    return lines.join('\n');
  })();

  const wechatCtxBlock = (() => {
    const recent = wechatSidecar?.getRecentExchanges?.(chatId, {
      limit: 12,
      excludeAfterTs: Date.now(),
    }) || [];
    if (!recent.length) return '';
    const lines = ['<wechat-recent-context>'];
    lines.push('以下是这位微信用户最近跟你的往来对话（按时间正序，最早→最新）：');
    for (const e of recent) {
      const who = e.role === 'user' ? '微信用户' : '你(bot)';
      lines.push(`  [${who}] ${e.text}`);
    }
    lines.push('</wechat-recent-context>');
    lines.push('');
    lines.push('（以上是 EasyDeal 端 wechat-sidecar 缓存的最近对话备注；这条 chatId 自己的 Claude session JSONL 通过 --resume 已经接上，完整记忆从那拿，wechat-recent-context 块只是 cheap 备份。）');
    lines.push('');
    return lines.join('\n');
  })();

  // 0.3.5: 跨 channel 感知 —— 把 admin 用户在电脑端 EasyDeal AI 对话框
  // 最近做的事注入进来，让微信用户问"那个 EA 写完没 / 那个回测怎样了"
  // 时 AI 能从这块上下文延续工作，不需要 admin 用户重述背景。
  const chatTabCtxBlock = _recentChatTabActivityBlockForWechat();

  const batchHint = items.length > 1
    ? `（用户在很短的时间内连续发了 ${items.length} 条消息，已合并到一起；请综合考虑后一次回复。）\n`
    : '';

  return [
    chatTabCtxBlock,    // 0.3.5: 电脑端最近做的事（跨 channel 感知）
    wechatCtxBlock,
    batchHint + `用户从微信给你发了消息：${synthInput}`,
    attachmentsBlock,
    '',
    `请直接回答。回答内容**必须**通过 mcp__wechat__send_message 发出去：`,
    `  to_user_id="${chatId}"`,
    `  context_token="${contextToken}"`,
    `  text=<你的完整回答>`,
    '',
    '严格规则（违反会导致用户在微信里收到重复 / 噪音消息）：',
    '1. send_message tool 调完 → **立刻 STOP, 不输出任何字符**.',
    '2. 不要说"好"/"好的"/"嗯"/"收到"/"明白"/"已发送"/"ok"/"done" 这类确认词.',
    '3. 不要说"还有什么需要"/"请问还有什么"这类客套.',
    '4. 不要 emoji ack (👌 / ✅ / 👍 等).',
    '5. 不要解释你做了什么 ("我通过 send_message 发送了回复" 这种).',
    '',
    '正确流程: 想清楚答案 → 调 send_message(text=答案) → 立刻结束 turn, 不再说话.',
    '',
    '为什么严格: 你在对话标签输出的任何文字会被 fallback 兜底当回复发, 用户会在微信看到双发 / 残留的 ack 噪音, 严重影响体验.',
  ].join('\n');
}


async function handleWechatInboundCommand({ command, args, body, text, attachments, chat: chatId, sender, contextToken }) {
  attachments = Array.isArray(attachments) ? attachments : [];
  console.log('[wechat→handler]', JSON.stringify({
    command, args, body_len: (body || '').length, text_len: (text || '').length,
    body_preview: (body || '').slice(0, 60),
    text_preview: (text || '').slice(0, 60),
    chatId, attach_count: attachments.length,
    attach_kinds: attachments.map((a) => a.kind),
  }));
  // 0.3.242: handler 入口也立即 fire typing — 跟 wechat-sidecar inbound loop 那次
  // 是双保险, 防止某条 path fire 失败. 用户报「一直不显示输入中」, 加双发 + log
  // 让我们能从 console 看是哪条 fire 成功/失败.
  if (chatId && wechatSidecar?.sendTyping) {
    wechatSidecar.sendTyping({ to: chatId, status: 1 })
      .then(() => console.log('[wechat→handler] typing immediate-fire ok for', chatId))
      .catch((e) => console.warn('[wechat→handler] typing immediate-fire failed:', String(e?.message || e).slice(0, 120)));
  }
  if (!wechatSidecar?.status?.logged_in) return;
  // 0.4.x: 收到 inbound = 用户刚激活 push session → 立即让 renderer 重算「微信通道
  // dormant」告警条, 让它秒消失 (之前纯 dormant 无 pending 时要等 5min 轮询才清).
  // 复用 pending-changed 通道, renderer onPendingChanged → 重取 pendingInfo (含新鲜
  // last_inbound_at) → dormantHours<12 → 隐藏告警条。
  try { win?.webContents.send('wechat:pending-changed', { reason: 'inbound', ts: Date.now() }); } catch {}
  const reply = (msg) => wechatSidecar.sendMessage({ to: chatId, text: msg, contextToken }).catch(() => {});

  // ---- Slash commands ----
  if (command === '/status' || command === '/s') {
    if (!strategies) { await reply('客户端正在初始化…'); return; }
    const m = (await settings.ensureDetected()).mt5;
    const list = await strategies.list({
      mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
    });
    const mounted = list.filter((it) => it.is_mounted);
    if (!mounted.length) { await reply('当前没有挂载中的 EA'); return; }
    const lines = ['运行中：'];
    for (const it of mounted) {
      const ea = it.name.replace(/\.(mq5|ex5)$/i, '');
      const rec = strategies.records[strategies._recordKeyFor(it.hash, ea)] || {};  // 1.1.22: 多副本消歧
      const pnl = rec.pnl_pct != null ? `${(rec.pnl_pct * 100).toFixed(1)}%` : '—';
      lines.push(`  ${ea} · ${rec.hours_run || 0}h · ${rec.trades || 0} 笔 · ${pnl}`);
    }
    await reply(lines.join('\n'));
    return;
  }
  if (command === '/help' || command === '/?') {
    await reply([
      '可用指令：',
      '  /status        当前挂载与盈亏',
      '  /halt <EA名>   停某个 EA',
      '其它消息直接发问就行，会转给 Claude 回答。',
    ].join('\n'));
    return;
  }

  // ---- Plain text or /halt → route to Claude (with debounce buffering) ----
  // Mirror EasyDeal chat tab UX: 用户连续发几条消息时，不要每条立刻
  // 触发 Claude，而是 buffer 起来等几秒；如果窗口内没新消息，把所有
  // 累积的消息合成一个 prompt 一次性回复。chat session 在跑时新到达
  // 的消息也加入下一批，等当前回复完才处理。
  if (!chatId) return;
  if (!chat) {
    await reply('客户端 chat 模块未就绪，请稍后再试。');
    return;
  }

  const userInput = (body && body.trim()) || (text && text.trim()) || '';
  if (!userInput && !attachments.length) {
    console.warn('[wechat→handler] BUG: handler called with empty body+text+attachments, raw:',
                 JSON.stringify({ body, text, command, args }));
    return;
  }

  // /halt 是关键操作，不参与 buffering，立即处理（防止用户「停 EA」被
  // 拖延几秒还在跑）。
  if (command !== '/halt') {
    _enqueueWechatMessage({
      chatId, command, args, userInput, attachments, contextToken,
    });
    return;
  }
  // If only attachments came (image/voice with no caption), use a synthetic
  // text describing them so Claude has something to reason about.
  const synthInput = userInput || (
    attachments.length === 1
      ? `（用户从微信发来一个 ${attachments[0].kind} 附件）`
      : `（用户从微信发来 ${attachments.length} 个附件：${attachments.map((a) => a.kind).join(', ')}）`
  );

  // Show "正在输入..." for the duration. The keepalive timer re-sends every
  // 4.5s; sending the actual reply later auto-cancels it. We also stop()
  // explicitly in the finally so a Claude-side error doesn't leave it stuck.
  const typing = wechatSidecar.startTyping({ to: chatId });

  // Attachments block — Claude reads these via Read tool. Images get
  // analysed multimodally; voice / video / encrypted blobs just get described.
  const attachmentsBlock = (() => {
    if (!attachments.length) return '';
    const lines = ['\n\n用户附带了以下文件：'];
    let hasReadable = false, hasEncrypted = false;
    for (let i = 0; i < attachments.length; i += 1) {
      const a = attachments[i];
      const sizeStr = a.size < 1024 ? `${a.size} B`
        : a.size < 1024 * 1024 ? `${(a.size / 1024).toFixed(1)} KB`
        : `${(a.size / 1024 / 1024).toFixed(2)} MB`;
      const fmtTag = a.format ? ` [${a.format}]` : '';
      const decodedTag = a.decoded === false ? ' ⚠ 未解密' : '';
      lines.push(`  ${i + 1}. ${a.kind}${fmtTag}${decodedTag} (${sizeStr})  →  ${a.path}`);
      if (a.kind === 'image' && a.decoded !== false) hasReadable = true;
      if (a.kind === 'encrypted_blob' || a.decoded === false) hasEncrypted = true;
    }
    lines.push('');
    if (hasReadable) {
      lines.push('图片用 Read 工具直接读路径（multimodal 能看到）。');
    }
    if (hasEncrypted) {
      lines.push('⚠ 标了「未解密 / encrypted_blob」的：iLink 把图片用 AES 加密传过来了，');
      lines.push('  本地解密器还没实现 — **不要 Read 它**（API 会报「Could not process image」）。');
      lines.push('  告诉用户：「微信图片走的是加密通道，目前 EasyDeal 还没接解码。请换种方式：');
      lines.push('  ① 在微信里长按图片『发送给』→『文件传输助手』再下载；② 或者直接在 EasyDeal');
      lines.push('  客户端的对话框里粘贴图片（multimodal 完全能看）。」');
    }
    return lines.join('\n') + (
      attachments.some((a) => a.kind === 'voice')
        ? '\n语音目前没接 STT，告诉用户暂不能识别，让他改发文字。' : ''
    );
  })();

  // Per-chat WeChat conversation context. Desktop chat history is already
  // shared via `claude --continue`; this block fills the gap for the
  // WeChat-side back-and-forth that the desktop session has no record of.
  // We pass excludeAfterTs=now so the just-arrived inbound (which sidecar
  // recorded a few ms ago) is omitted from "prior context" — it's already
  // restated explicitly in the prompt below.
  const wechatCtxBlock = (() => {
    const recent = wechatSidecar.getRecentExchanges(chatId, {
      limit: 12,
      excludeAfterTs: Date.now(),
    });
    if (!recent.length) return '';
    const lines = ['<wechat-recent-context>'];
    lines.push('以下是这位微信用户最近跟你的往来对话（按时间正序，最早→最新）：');
    for (const e of recent) {
      const who = e.role === 'user' ? '微信用户' : '你(bot)';
      lines.push(`  [${who}] ${e.text}`);
    }
    lines.push('</wechat-recent-context>');
    lines.push('');
    lines.push('（以上是 EasyDeal 端 wechat-sidecar 缓存的最近对话备注；这条 chatId 自己的 Claude session JSONL 通过 --resume 已经接上，完整记忆从那拿，wechat-recent-context 块只是 cheap 备份。）');
    lines.push('');
    return lines.join('\n');
  })();

  // Claude prompt — instructs it to use mcp__wechat__send_message so the
  // reply lands in the user's WeChat with the right context_token.
  const prompt = command === '/halt'
    ? [
        wechatCtxBlock,
        `用户从微信发来停止指令：halt ${args.join(' ')}`,
        '请评估并照办（一般是把指定 EA 从图表上移除 / 暂停 AutoTrading）。',
        attachmentsBlock,
        '',
        `执行完后**必须**调 mcp__wechat__send_message 把简短结果发回去：`,
        `  to_user_id="${chatId}"`,
        `  context_token="${contextToken || ''}"`,
        '',
        '注意：你在对话标签里输出的任何文字都不会发到用户微信。'
        + '只有通过 mcp__wechat__send_message 发的内容才能到。',
      ].join('\n')
    : [
        wechatCtxBlock,
        `用户从微信给你发了消息：${synthInput}`,
        attachmentsBlock,
        '',
        `请直接回答。回答内容**必须**通过 mcp__wechat__send_message 发出去：`,
        `  to_user_id="${chatId}"`,
        `  context_token="${contextToken || ''}"`,
        `  text=<你的完整回答>`,
        '',
        '注意：',
        '- 你在对话标签输出的文字**不会**发到用户微信，只有 mcp__wechat__send_message 能。',
        '- 不要在 send_message 之后再说"已发送"之类的话——空回复就行。',
        '- 不要客套；直接答问题。',
      ].join('\n');

  try {
    await chat.send(prompt);
  } catch (e) {
    console.error('[wechat→chat] send failed:', e);
    await reply('Claude 处理出错：' + (e?.message || String(e)));
  } finally {
    await typing.stop();
  }
}

function startStatsCollector() {
  const scriptPath = resolveBundledFile('python', 'stats_collector.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[stats] script missing at', scriptPath, '— stats collection disabled');
    return;
  }
  const s = settings.getResolved();
  statsCollector = new StatsCollector({
    pythonBin: s.pythonBin || 'python',
    scriptPath,
    mt5InstallDir: s.mt5.installDir,
    mt5DataDir: s.mt5.dataDir,
    strategies,
    marketplace,
    settingsRef: settings,
    log: (m) => console.log('[stats]', m),
    recordRun: (taskId, name, opts) => recordSystemRun(taskId, name, opts),
    // 0.3.197: 让 stats-collector 在调 mt5.initialize 之前 precheck 该 installDir
    // 的 terminal64.exe 在不在跑. 不在跑 → 跳过这次 snapshot (不要让 SDK 自动拉起
    // 用户刚关掉的 MT5).
    findMt5PidsForInstall: (installDir) => _findMt5PidsForInstall(installDir),
    // 0.3.215: age 检查 — 进程跑 < 60s 时 SDK IPC 没就绪, init 会 launch 第二个
    findMt5AgeForInstall: (installDir) => _findMt5AgeForInstall(installDir),
  });
  statsCollector.start();
  // 0.3.152: 注册到 timer-registry 让 panic 联动
  timerRegistry.registerService({
    id: 'stats-collector',
    description: 'EA 业绩采集 + raw deals/balance 上传 (60min tick + 90s cmd pump)',
    pause:  () => statsCollector.pause(),
    resume: () => statsCollector.resume(),
    status: () => statsCollector.status?.() || {},
  });
}

// ---------------------------------------------------------------------------
// OrderGuard — order guard HTTP + MCP server
// ---------------------------------------------------------------------------
// 0.3.191 Phase 3: 现在 spawn OrderGuardPool — 一个 MT5 实例 = 一个 OG 进程.
// `orderguard` 全局保留成 compat proxy, 老代码 `orderguard.X(...)` 调用自动
// 路由到 active 实例的 OG (或 ea-bound 实例, 走 resolveMt5ForEa). 多实例时
// 对原 IPC handler 体透明.
function startOrderGuard() {
  const scriptPath = resolveBundledFile('python', 'orderguard_server.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[orderguard] script missing at', scriptPath, '— OrderGuard disabled');
    return;
  }
  const s = settings.getResolved();
  ogPool = new OrderGuardPool({
    pythonBin: s.pythonBin || 'python',
    scriptPath,
    userDataDir: app.getPath('userData'),
    mqhSourcePath: resolveBundledFile('mql5', 'OrderGuard.mqh'),
    sessionTokenProvider: () => {
      try { return license._activeToken?.() || ''; } catch { return ''; }
    },
    serverBaseUrl: (require('./server-api-license').getBaseUrl?.()) || '',
    log: (m) => console.log('[orderguard-pool]', m),
    listMt5Instances: () => settings.listMt5Instances?.() || [],
    resolveMt5ForEa: (eaName) => resolveMt5ForEa(eaName),
    getActiveInstanceId: () => settings.data?.activeMt5InstanceId || null,
  });

  // Compat proxy — 老代码 `orderguard.X(...)` 透明路由
  orderguard = _buildOrderGuardCompatProxy(ogPool);

  ogPool.startAll().then(() => {
    console.log(`[orderguard-pool] started ${ogPool.size()} OG instances`);
  }).catch((e) => {
    console.warn('[orderguard-pool] start failed:', e.message);
  });

  // 0.3.152 + 0.3.191: 注册到 timer-registry — 整个 pool 当一个 service, status 列出每个实例
  timerRegistry.registerService({
    id: 'orderguard',
    description: 'OrderGuard pool — 每 MT5 实例一个独立 OG 子进程 (各自 tracker_loop 5s poll MT5)',
    pause:  async () => { for (const { og } of ogPool.listAll()) { try { await og.pause(); } catch {} } },
    resume: async () => { for (const { og } of ogPool.listAll()) { try { await og.resume(); } catch {} } },
    status: () => {
      const all = ogPool.listAll();
      return {
        pool_size: all.length,
        instances: all.map(({ instance_id, name, og }) => ({
          instance_id, name,
          running: og.running, port: og.port, pid: og.child?.pid || null,
        })),
      };
    },
  });
  timerRegistry.registerService({
    id: 'orderguard-health',
    description: 'OG pool 健康检测 watchdog (per-instance, 30s, critical) — 3 次失败 = 90s 自动 restart 对应子进程',
    critical: true,
    pause:  async () => { /* critical */ },
    resume: async () => { /* critical */ },
    status: () => {
      const all = ogPool.listAll();
      return {
        pool_size: all.length,
        instances: all.map(({ instance_id, name, og }) => ({
          instance_id, name,
          enabled: !!og._healthTimer,
          consecutive_fails: og._consecutiveFails || 0,
          restarting: og._restarting || false,
          last_health_ok: og._lastHealth?.ok ?? null,
          last_tracker_stale_sec: og._lastHealth?.data?.tracker_stale_sec ?? null,
        })),
      };
    },
  });
}

/**
 * 0.3.191 Phase 3: compat proxy 让 `orderguard.X()` 在 main.js 老代码里继续工作.
 * - 顶层属性 (.running / .port / .child) — 走 primary (active 实例)
 * - getStatus / healthCheck / forcePoll — 走 primary 或 fan-out
 * - getPositions / getDecisions(无 ea) / getEnabledEas / getOverviewStats / getClosedOrders / getAlertsPending —
 *   多实例时聚合 across pool (合并 arrays + 加 _instance_id 标签)
 * - getStats(ea) / enableEa(ea) / disableEa(ea) / resetAnchor(ea) / deployIntercept(ea)
 *   / getLocalRules(ea) — 走 resolveMt5ForEa(ea) → 对应 OG
 * - rule-suggestions 按 ea 路由, id-based call (apply/dismiss/rollback) fan-out 找第一个 ok
 */
function _buildOrderGuardCompatProxy(pool) {
  return {
    // ---- 顶层属性 ----
    get running() { return pool.listAll().some(({ og }) => og.running); },
    get port()    { return pool.primary()?.port || 0; },
    get child()   { return pool.primary()?.child || null; },
    get _healthTimer()      { return pool.primary()?._healthTimer || null; },
    get _consecutiveFails() { return pool.primary()?._consecutiveFails || 0; },
    get _restarting()       { return pool.primary()?._restarting || false; },
    get _lastHealth()       { return pool.primary()?._lastHealth || null; },

    // ---- 控制 ----
    async stop()   { await pool.stopAll(); },
    async pause()  { for (const { og } of pool.listAll()) { try { await og.pause(); } catch {} } },
    async resume() { for (const { og } of pool.listAll()) { try { await og.resume(); } catch {} } },

    // ---- 全局 status / health ----
    async getStatus()    { const og = pool.primary(); return og ? await og.getStatus()    : { ok: false, error: 'no OG in pool' }; },
    async healthCheck()  { const og = pool.primary(); return og ? await og.healthCheck()  : { ok: false, error: 'no OG in pool' }; },
    async forcePoll()    {
      const results = await pool.fanOut((og) => og.forcePoll());
      return { ok: results.every((r) => r.result?.ok !== false), results };
    },

    // ---- 聚合 list endpoint ----
    async getPositions()         { return _mergeListEndpoint(await pool.fanOut((og) => og.getPositions()),         'positions'); },
    // 0.3.238: getEnabledEas 单独处理 — OG 返 `{ok, data:{eas:[...]}}` 嵌套结构,
    // 不能直接用 _mergeListEndpoint (它只扫顶层 array, data 是 object 找不到).
    // 之前 bug: enable 实际成功 (instmpffo0uc OG /enabled-eas 真返 GMarket), 但 fan-out
    // 后 merged 里没 `eas` 字段, UI strategies-view 读 `r.data.eas` 为空 → chip
    // 永远显「🛡 护航」未启用. UI 看不到「监控中/拦截中」实质是这里 merge 把 data 丢了.
    async getEnabledEas() {
      const results = await pool.fanOut((og) => og.getEnabledEas());
      const merged_eas = [];
      for (const { instance_id, name, result } of results) {
        const eas = result?.data?.eas;
        if (!Array.isArray(eas)) continue;
        for (const ea of eas) merged_eas.push({ ...ea, _instance_id: instance_id, _instance_name: name });
      }
      return {
        ok: true,
        data: { eas: merged_eas, count: merged_eas.length },
        _per_instance: results.map(({ instance_id, name, result, error }) => ({ instance_id, name, ok: !error, error })),
      };
    },
    async getClosedOrders(limit) { return _mergeListEndpoint(await pool.fanOut((og) => og.getClosedOrders(limit)), 'orders'); },
    async getAlertsPending(limit){ return _mergeListEndpoint(await pool.fanOut((og) => og.getAlertsPending(limit)),'alerts'); },
    async getDecisions(opts) {
      if (opts?.ea) {
        const og = await pool.getForEa(opts.ea);
        return og ? await og.getDecisions(opts) : { ok: false, error: 'no OG for EA' };
      }
      return _mergeListEndpoint(await pool.fanOut((og) => og.getDecisions(opts || {})), 'decisions');
    },
    async getOverviewStats() { return _mergeOverviewStats(await pool.fanOut((og) => og.getOverviewStats())); },
    async markAlertsNotified(ids) {
      const results = await pool.fanOut((og) => og.markAlertsNotified(ids));
      return { ok: true, results };
    },

    // ---- EA-aware: 路由到 ea 绑定的 OG ----
    async getStats(ea, intent)  { const og = ea ? await pool.getForEa(ea) : pool.primary(); return og ? await og.getStats(ea, intent) : { ok: false, error: 'no OG' }; },
    async enableEa(ea, m, mo, t){ const og = await pool.getForEa(ea); return og ? await og.enableEa(ea, m, mo, t) : { ok: false, error: 'no OG for EA' }; },
    async disableEa(ea)         { const og = await pool.getForEa(ea); return og ? await og.disableEa(ea)         : { ok: false, error: 'no OG for EA' }; },
    // 0.4.30 根治: EA 改绑实例后, 旧实例 OG 里这只 EA 的启用记录变孤儿 (getEnabledEas fan-out
    // 会把它当第二条同名 EA 显示)。改绑时调这个 disable 掉旧实例的记录。fromInstanceId /
    // toInstanceId 都可能是 null(=默认/活跃实例), 统一解析成有效 id 再比; 只在「旧实例确实是
    // 另一个、且还在 pool 里」时 disable (best-effort, 不碰新实例的护航)。
    async cleanupReboundEa(eaName, fromInstanceId, toInstanceId) {
      try {
        const activeId = pool.primary()?.instanceId || null;
        const effFrom = fromInstanceId || activeId;
        const effTo   = toInstanceId   || activeId;
        if (!effFrom || effFrom === effTo) return { ok: true, skipped: 'no-change' };
        const og = pool.getByInstanceId(effFrom);
        if (!og) return { ok: true, skipped: 'old-instance-not-pooled' };
        const r = await og.disableEa(eaName);
        return { ok: true, disabled_on: effFrom, result: r };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    async resetAnchor(ea)       { const og = await pool.getForEa(ea); return og ? await og.resetAnchor(ea)       : { ok: false, error: 'no OG for EA' }; },
    async getLocalRules(ea)     { const og = await pool.getForEa(ea); return og ? await og.getLocalRules(ea)     : { ok: false, error: 'no OG for EA' }; },
    async setGuardRule(ea, key, value) { const og = await pool.getForEa(ea); return og ? await og.setGuardRule(ea, key, value) : { ok: false, error: 'no OG for EA' }; },
    async deployIntercept(ea, dataDir) { const og = await pool.getForEa(ea); return og ? await og.deployIntercept(ea, dataDir) : { ok: false, error: 'no OG for EA' }; },
    async deployCopyTradeHook(dataDir, mqh) { const og = pool.primary(); return og ? await og.deployCopyTradeHook(dataDir, mqh) : { ok: false, error: 'no OG' }; },

    // ---- AI / rule suggestions ----
    async getRuleSuggestions(opts) {
      if (opts?.ea) {
        const og = await pool.getForEa(opts.ea);
        if (og) return await og.getRuleSuggestions(opts);
      }
      return _mergeListEndpoint(await pool.fanOut((og) => og.getRuleSuggestions(opts || {})), 'suggestions');
    },
    async applyRuleSuggestion(id)    { return await _routeByIdToOneOG(pool, (og) => og.applyRuleSuggestion(id)); },
    async dismissRuleSuggestion(id)  { return await _routeByIdToOneOG(pool, (og) => og.dismissRuleSuggestion(id)); },
    async rollbackRuleSuggestion(id) { return await _routeByIdToOneOG(pool, (og) => og.rollbackRuleSuggestion(id)); },
    async scanRuleSuggestionsNow(ea) {
      if (ea) { const og = await pool.getForEa(ea); if (og) return await og.scanRuleSuggestionsNow(ea); }
      return { ok: true, results: await pool.fanOut((og) => og.scanRuleSuggestionsNow(ea)) };
    },
    async aiAccuracy(ea) {
      const og = ea ? await pool.getForEa(ea) : pool.primary();
      return og ? await og.aiAccuracy(ea) : { ok: false, error: 'no OG' };
    },
  };
}

/** 聚合 list-type endpoint: 把每个 OG 的 items[] / positions[] / decisions[] / etc 合并 + 加 _instance_id 标签.
 *  0.3.238: OG endpoint 实际返 `{ok, data: {<field>: [...]}}` 嵌套结构, 这个函数之前只扫顶层
 *  array 不进 `data` → merged 总是空. 修法: 先把每个 result 的 .data unwrap 出来当顶层算 array fields.
 *  同时保留嵌套 `data.<field>` 结构 (UI 之前读 `r.data.eas` / `r.data.orders` 等), 让 UI 无改动也受益. */
function _mergeListEndpoint(results, primaryKey) {
  const merged = { ok: true, data: {} };
  const listFields = new Set();
  // unwrap data: 每个 OG 返回的实际 payload 在 .data 下
  const unwrapped = results.map(({ instance_id, name, result, error }) => ({
    instance_id, name, error,
    payload: (result && typeof result === 'object' && result.data && typeof result.data === 'object')
      ? result.data
      : result,
  }));
  for (const { payload } of unwrapped) {
    if (!payload || typeof payload !== 'object') continue;
    for (const [k, v] of Object.entries(payload)) if (Array.isArray(v)) listFields.add(k);
  }
  for (const field of listFields) {
    merged[field] = [];
    merged.data[field] = [];
    for (const { instance_id, name, payload } of unwrapped) {
      if (!payload || !Array.isArray(payload[field])) continue;
      for (const item of payload[field]) {
        const tagged = { ...item, _instance_id: instance_id, _instance_name: name };
        merged[field].push(tagged);
        merged.data[field].push(tagged);
      }
    }
  }
  merged._per_instance = unwrapped.map(({ instance_id, name, error }) => ({ instance_id, name, ok: !error, error }));
  return merged;
}

/** Original loop body for legacy callers that still rely on old `for (const field of listFields) ... results[].result[field]` semantics. Unused after 0.3.238 unwrap fix but kept for diff clarity. */
function _mergeListEndpointLegacyTail(results, listFields, merged) {
  for (const field of listFields) {
    merged[field] = [];
    for (const { instance_id, name, result } of results) {
      if (!result || !Array.isArray(result[field])) continue;
      for (const item of result[field]) merged[field].push({ ...item, _instance_id: instance_id, _instance_name: name });
    }
  }
  merged._per_instance = results.map(({ instance_id, name, result, error }) => ({ instance_id, name, ok: !error, error }));
  return merged;
}

/** 聚合 overview-stats: 数值字段相加, 数组字段 concat.
 *  0.3.238: OG 返 `{ok, data: {<stats>}}` 嵌套, 跟 _mergeListEndpoint 同款 unwrap. */
function _mergeOverviewStats(results) {
  const sums = {}, lists = {};
  for (const { result } of results) {
    if (!result || typeof result !== 'object' || result.ok === false) continue;
    // 优先看 result.data (嵌套), 否则用 result 顶层 (老兼容)
    const payload = (result.data && typeof result.data === 'object') ? result.data : result;
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'number') sums[k] = (sums[k] || 0) + v;
      else if (Array.isArray(v)) lists[k] = (lists[k] || []).concat(v);
    }
  }
  return { ok: true, data: { ...sums, ...lists }, ...sums, ...lists,
    _per_instance: results.map(({ instance_id, name, result, error }) => ({ instance_id, name, ok: !error, error })) };
}

/** 规则建议 id 是 per-instance, client 不知道哪个 OG 拥有 — fan-out 找第一个 ok. */
async function _routeByIdToOneOG(pool, fn) {
  const results = await pool.fanOut(fn);
  const winner = results.find((r) => r.result?.ok && !r.error);
  if (winner) return winner.result;
  return { ok: false, error: 'rule suggestion id not found in any OG', results };
}

// 0.3.14 起：高优先级关键词词表，命中的快讯算「重要未读」。
// 0.3.15 调整：不再推送 system_note 到 chat 标签页（用户嫌打扰，AI 该
// 关注时调 list_recent_news MCP tool 自己查就够）。改成累计 unread
// count，发 IPC 给资讯 tab 按钮右上显示红点。用户点开资讯 tab 自动
// markRead 清零。
const _NEWS_HIGH_PRIORITY_KEYWORDS = [
  // 美联储 / 利率决议
  '美联储', 'FOMC', 'Fed', '鲍威尔', '加息', '降息', '基点',
  // 通胀 / 就业 / GDP 三大宏观
  'CPI', 'PCE', 'PPI', '非农', 'NFP', 'GDP', '失业率',
  // 央行 / 重大讲话
  '欧央行', 'ECB', '日银', '日本央行', '英央行',
  // 黑天鹅 / 紧急
  '突发', '紧急', '熔断', '战争', '袭击', '制裁',
  // 黄金 / 原油 标志性消息（EasyDeal 用户主力品种）
  'OPEC', '减产', '增产',
];
let _newsUnreadCount = 0;
let _newsLastImportantTs = 0;

function _matchNewsKeywords(item) {
  const hay = `${item.title}\n${item.content}`;
  for (const kw of _NEWS_HIGH_PRIORITY_KEYWORDS) {
    if (hay.includes(kw)) return true;
  }
  return false;
}

function _pushNewsUnreadCount() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w && !w.isDestroyed() && w.webContents) {
        w.webContents.send('news:unread-count', {
          count: _newsUnreadCount,
          last_important_ts: _newsLastImportantTs,
        });
      }
    }
  } catch {}
}

function startNewsProvider(dataDir) {
  const bufferPath = path.join(dataDir, 'news-buffer.json');
  newsProvider = new NewsProvider({ bufferPath });
  newsProvider.on('new-items', (fresh) => {
    if (!Array.isArray(fresh) || !fresh.length) return;
    // 推送给所有 renderer（资讯 tab 实时刷新）
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w && !w.isDestroyed() && w.webContents) {
          w.webContents.send('news:new-items', fresh);
        }
      }
    } catch {}
    // 累计「重要未读」count（important=1 OR 命中关键词）—— 用户看到资讯
    // tab 右上角红点会去看；不再 push 到 chat 打扰。
    // dedup 已经在 newsProvider 用 id 做掉了，这里不会重复累加。
    let bumped = false;
    for (const item of fresh) {
      const isImportant = item.important || _matchNewsKeywords(item);
      if (!isImportant) continue;
      _newsUnreadCount += 1;
      if (item.ts && item.ts > _newsLastImportantTs) _newsLastImportantTs = item.ts;
      bumped = true;
    }
    if (bumped) _pushNewsUnreadCount();
  });
  newsProvider.start().catch((e) =>
    console.warn('[news] start failed:', e?.message || e));
  // 0.3.152: 注册到 timer-registry
  timerRegistry.registerService({
    id: 'news-provider',
    description: '金十快讯轮询',
    pause:  () => newsProvider.pause(),
    resume: () => newsProvider.resume(),
    status: () => newsProvider.status?.() || {},
  });
}

// 0.3.34-0.3.36: 金十经济日历曾接进资讯版块，但 cdn-rili.jin10.com 域名
// 实际已下线（Google DNS / 114 DNS 都查不到），新的数据 endpoint 需要登录
// 才能拉。0.3.37 移除 calendar-provider 全部代码 + UI，等以后有方案再加。

/**
 * Per-turn live context dropped into the system part of every chat prompt.
 * Tells Claude which EAs are mounted on MT5 right now, which have hash
 * mismatch vs. their workspace .ex5, etc. Cheap to recompute on each turn.
 */
function _bjNowStr() {
  // 服务端 / Claude Code 默认时区不一定是 Asia/Shanghai —— EasyDeal 全局
  // 对外展示统一北京时区，AI 写「今天浮亏」/ 「今晚收盘」时也按北京时间。
  try {
    return new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
  } catch { return new Date().toISOString(); }
}

async function _recentTaskRunsBlock() {
  // 抓最近 24h 用户级 cron / 系统任务的执行历史，注入到 AI 上下文。
  // 让 AI 在用户问「今天监控发现什么 / 早上的检查跑过吗」时不用瞎猜，
  // 直接看已经发生过的 run summary。无头模式（llm_headless）+ 静默任务
  // 之前完全不进 chat history，AI 看不到 → 这条注入就是补这个洞。
  if (!schedulerClient) return '';
  try {
    const r = await schedulerClient.callTool('list_tasks', {});
    const txt = r?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(txt);
    const tasks = parsed?.data?.tasks || parsed?.tasks || [];
    if (!tasks.length) return '';
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const recents = [];
    for (const t of tasks) {
      try {
        const hr = await schedulerClient.callTool('get_task_history', {
          task_id: t.id, limit: 3,
        });
        const hp = JSON.parse(hr?.content?.[0]?.text || '{}');
        const runs = hp?.data?.runs || hp?.runs || [];
        for (const run of runs) {
          const startedAt = run.started_at ? Number(run.started_at) : 0;
          if (!startedAt || startedAt < cutoff) continue;
          if (!run.result_summary && run.status !== 'error') continue;
          recents.push({
            task_name: t.name,
            task_id: t.id,
            started_at: startedAt,
            status: run.status,
            summary: run.result_summary || `(${run.status})`,
          });
        }
      } catch {}
    }
    if (!recents.length) return '';
    recents.sort((a, b) => b.started_at - a.started_at);
    const lines = ['最近 24 小时定时任务执行记录（无头模式跑的也算，AI 用这些上下文回答 「今天监控到什么」之类的问题）:'];
    for (const r of recents.slice(0, 12)) {
      const t = new Date(r.started_at).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const summary = String(r.summary).replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`  · ${t} 「${r.task_name}」[${r.status}] ${summary}`);
    }
    if (recents.length > 12) lines.push(`  …还有 ${recents.length - 12} 条历史，需要时调 mcp__easydeal-scheduler__get_task_history 查具体 task_id`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

// 0.3.49: 智能读文本文件 — 自动识别 BOM 选编码，避免 Windows 记事本 /
// PowerShell `>` 默认写出的 UTF-16 LE 被当 UTF-8 读成「汉字 + 中间一个 \0」
// 乱码。识别 4 种 BOM：UTF-8 (EF BB BF) / UTF-16 LE (FF FE) / UTF-16 BE (FE FF) /
// UTF-32（极少见，按需要再扩）。没 BOM 但内容里 nullByte 占比 > 10% 的兜底
// 当 UTF-16 LE 处理（典型 UTF-16 内容里 ASCII 字符之间都是 0x00）。无副作用
// — 正确编码的 UTF-8 文件按原路读，BOM 自动剥离。
function _readTextWithBom(filePath) {
  const buf = require('node:fs').readFileSync(filePath);
  if (buf.length === 0) return '';
  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  // UTF-16 BE BOM — Node 没原生支持，手工 byte-swap 后按 LE 读
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.slice(2);
    const swapped = Buffer.alloc(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i]     = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return swapped.toString('utf16le');
  }
  // 没 BOM — 探测 null byte 占比，> 10% 兜底当 UTF-16 LE 处理
  let nullCount = 0;
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0x00) nullCount += 1;
  }
  if (nullCount > sampleLen * 0.1) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

// 0.3.22: 提取 markdown 第一个二级 section（## ...）作为 EA 策略说明摘要
// 注入到 live context。算法：跳过 # 一级标题；从第 1 个 `## ` 开始累加；
// 遇到第 2 个 `## ` 或超过 maxLines 截断。
function _extractFirstSection(md, maxLines = 40) {
  if (!md) return '';
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let h2Seen = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      h2Seen += 1;
      if (h2Seen > 1) break;
    }
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out.join('\n').trim();
}

async function buildLiveWorkspaceContext(workspaceDir) {
  if (!strategies) return '';
  try {
    const m = (await settings.ensureDetected()).mt5;
    const list = await strategies.list({
      mt5DataDir: m.dataDir, mt5InstallDir: m.installDir,
    });
    const lines = [
      'EasyDeal 客户端实时状态：',
      `- 当前时间：${_bjNowStr()} (Asia/Shanghai)`,
    ];
    const mounted = list.filter((it) => it.is_mounted);
    if (mounted.length) {
      lines.push('- 当前 MT5 上挂载的 EA：' +
        mounted.map((m) => m.name.replace(/\.(mq5|ex5)$/i, '')).join('、'));
    } else {
      lines.push('- 当前 MT5 上没有检测到挂载中的 EA（也可能用户没开 MT5，或刚挂载还没来得及写日志）。');
    }
    const mismatch = list.filter((it) => it.hash_match === false);
    if (mismatch.length) {
      lines.push('- ⚠ 发现工作区 .ex5 与 MT5/Experts/ 内 .ex5 哈希不一致的 EA：' +
        mismatch.map((m) => m.name.replace(/\.(mq5|ex5)$/i, '')).join('、') +
        '（用户大概率忘记重新挂载 / 或两边版本不同步——必要时提醒用户）');
    }
    // 0.3.22: 给挂载中的 EA 注入 .md 第一节（"核心思路"），让 AI 不用每次
    // 用 Read 工具拉 strategies/<EA>.md。其他不挂载的 EA 还是只标文件名
    // 让 AI 按需 Read，省 token。
    // 第一节切法：第 1 个 `# Heading 1` 后跨过去；累加内容直到遇到第 2 个
    // `^## Heading 2`（即第二节开头）或者超过 40 行截断 — 实测一般够 cover
    // 核心思路 + 一点交易流程开头。
    if (mounted.length) {
      const mountedDocs = [];
      for (const m of mounted) {
        if (!m.doc_path || !m.doc_exists) continue;
        try {
          // 0.3.49: 不直接 utf-8 — 用户的 .md 可能是 Windows 记事本 / PowerShell
          // 默认存的 UTF-16 LE（带 BOM），utf-8 读出来每个汉字之间一个 \0
          // 还 + 乱码。先 readBuf 看 BOM 选编码；都没 BOM 但内容看起来像 UTF-16
          // （奇数 null 出现频率 > 10%）也走 utf-16-le。亮 用户撞过「趋势.md」
          // 引发的 args[5] null bytes case 就是这条。
          const content = _readTextWithBom(m.doc_path);
          const firstSection = _extractFirstSection(content, 40);
          if (firstSection) {
            mountedDocs.push({
              stem: m.name.replace(/\.(mq5|ex5)$/i, ''),
              content: firstSection,
            });
          }
        } catch {}
      }
      if (mountedDocs.length) {
        lines.push('');
        lines.push('挂载中的 EA 策略说明（第一节，让你直接懂思路；如需细节继续 Read strategies/<EA>.md）：');
        for (const d of mountedDocs) {
          lines.push('');
          lines.push(`<strategy-doc ea="${d.stem}">`);
          lines.push(d.content);
          lines.push('</strategy-doc>');
        }
      }
    }
    // 「我的策略」逐条详情 —— 用户问回测 / 写说明 / 挂载 / 改策略时直接看这块，
    // 不要再调 mcp 查列表。每条带：name / 状态标志 / 近况指标。多于 12 个截断。
    if (list.length) {
      lines.push('');
      lines.push(`「我的策略」标签当前 ${list.length} 个 EA（用户提到「策略」/「回测」/「说明」/「挂载」时直接引用以下信息，不要再调 list 工具）：`);
      const top = list.slice(0, 12);
      for (const it of top) {
        const stem = it.name.replace(/\.(mq5|ex5)$/i, '');
        const flags = [];
        if (it.is_mounted) flags.push('运行中');
        else flags.push('未挂载');
        if (it.is_stale) flags.push('需重新挂载(.ex5 比内存版本新)');
        if (it.kind === 'compiled') flags.push('仅二进制');
        if (it.has_source && it.has_compiled) flags.push('源码+ex5');
        if (it.hash_match === false) flags.push('hash 不一致');
        if (!it.doc_exists) flags.push('缺策略说明.md');
        const stats = [];
        if (it.hours_run) stats.push(`运行 ${(+it.hours_run).toFixed(1)}h`);
        if (typeof it.trades === 'number') stats.push(`${it.trades} 笔`);
        if (it.pnl_pct != null) stats.push(`${it.pnl_pct > 0 ? '+' : ''}${(it.pnl_pct * 100).toFixed(1)}%`);
        if (it.max_drawdown != null) stats.push(`回撤 ${(it.max_drawdown * 100).toFixed(1)}%`);
        const flagStr = flags.length ? ` [${flags.join(' / ')}]` : '';
        const statStr = stats.length ? ` · ${stats.join(' · ')}` : '';
        lines.push(`  · ${stem}${flagStr}${statStr}`);
      }
      if (list.length > 12) lines.push(`  …还有 ${list.length - 12} 个，需要可调 mcp__easydeal__list_strategies 拿完整列表`);
    }
    const taskBlock = await _recentTaskRunsBlock();
    if (taskBlock) {
      lines.push('');
      lines.push(taskBlock);
    }
    // 0.3.5: 跨 channel 感知 —— 把最近 24h 内有活动的微信对话摘要也注入到
    // chat 的 live state，admin 用户在 chat 里能看到「最近哪些微信用户问
    // 了什么 / 我作为 AI 回了什么」。源数据：wechat-sessions store +
    // 各 chatId session JSONL 的最近 turn。
    const wechatBlock = _recentWechatActivityBlock();
    if (wechatBlock) {
      lines.push('');
      lines.push(wechatBlock);
    }
    // 0.4.x 跨会话操作回流: 注入 .easydeal-activity.jsonl 最近几条 —— 平/改单不管
    // 是客户端 chat / 微信 / 定时任务哪个会话做的都 append 在那, 让当前会话也看得到
    // 「最近平了什么仓」。配合 MCP 侧的写入 (close/modify_position) + CLAUDE.md 引导。
    try {
      const _fs = require('node:fs');
      const _actPath = path.join(app.getPath('userData'), 'workspace', '.easydeal-activity.jsonl');
      if (_fs.existsSync(_actPath)) {
        const _recent = _fs.readFileSync(_actPath, 'utf8').trim().split(/\r?\n/).slice(-10)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (_recent.length) {
          const _al = ['最近的跨会话操作记录（平仓 / 改单等，不管是客户端 / 微信 / 定时任务哪个渠道做的）:'];
          for (const e of _recent) {
            _al.push(`  · ${e.ts || ''} [${e.source || 'ai'}] ${e.action} ${JSON.stringify(e.args || {})} → ${e.ok ? 'OK' : '失败'} ${String(e.summary || '').slice(0, 80)}`);
          }
          lines.push(''); lines.push(_al.join('\n'));
        }
      }
    } catch {}
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 1.3.x 多会话「策略会话」上下文种子。
 * ⚠ 只在**新会话首轮**(opts.firstTurn, = 未 resume)注入完整种子(说明/参数/战绩); 之后每轮
 * 只注入一行精简提醒。原因: contextProvider 每轮都跑, 若每轮重注入大种子, 随 --resume 累积
 * 几轮就把上下文顶到软上限触发压缩(用户实测「没几条就会话满了」)。也**不再追加完整全局
 * workspace 上下文**(那是最大一坨冗余) —— 策略会话聚焦本策略, 实时持仓/行情让 AI 按需用
 * MCP 工具拉(工具就在, 跟全局会话同一 workspace)。
 */
async function buildStrategyContext(workspaceDir, login, ea, opts = {}) {
  const stem = String(ea || '').replace(/\.(mq5|ex5)$/i, '');
  // 非首轮: 只回一行提醒, 不再塞种子(说明/参数已在首轮进了会话历史, resume 时都在)。
  if (!opts.firstTurn) {
    return `【策略专属会话:${stem}(账户 ${login})】用户说「这个策略/它」默认指「${stem}」。`
      + `需要实时持仓/盈亏/行情/EA日志就调 MCP 工具查(按账户 ${login} 过滤), 别只凭记忆答。`;
  }
  const lines = [
    '【当前会话 = 策略专属会话】',
    `你正在这条会话里**专门讨论策略「${stem}」**（所属账户 ${login}）。用户在本会话里说「这个策略/它/当前策略」默认都指「${stem}」，回答、分析、改动都围绕它，不要跳到别的策略。`,
    `⚠ 涉及**实时**持仓 / 盈亏 / 行情 / EA 运行日志时**必须调 MCP 工具查真实数据**（按账户 ${login} 过滤），别只凭下面的静态种子或记忆作答。`,
  ];
  try {
    if (strategies) {
      const m = (await settings.ensureDetected()).mt5;
      const list = await strategies.list({ mt5DataDir: m.dataDir, mt5InstallDir: m.installDir });
      const it = list.find((x) => String(x.name).replace(/\.(mq5|ex5)$/i, '') === stem);
      if (it) {
        const flags = [];
        flags.push(it.is_mounted ? '运行中' : '未挂载');
        if (it.is_stale) flags.push('需重新挂载(.ex5 比内存版本新)');
        if (it.hash_match === false) flags.push('hash 不一致');
        const stats = [];
        if (it.hours_run) stats.push(`运行 ${(+it.hours_run).toFixed(1)}h`);
        if (typeof it.trades === 'number') stats.push(`${it.trades} 笔`);
        if (it.pnl_pct != null) stats.push(`${it.pnl_pct > 0 ? '+' : ''}${(it.pnl_pct * 100).toFixed(1)}%`);
        if (it.max_drawdown != null) stats.push(`回撤 ${(it.max_drawdown * 100).toFixed(1)}%`);
        lines.push(`- 状态：${flags.join(' / ')}${stats.length ? ' · ' + stats.join(' · ') : ''}`);
        // 策略说明(首节)
        if (it.doc_path && it.doc_exists) {
          try {
            const sec = _extractFirstSection(_readTextWithBom(it.doc_path), 40);
            if (sec) { lines.push(''); lines.push(`<strategy-doc ea="${stem}">`); lines.push(sec); lines.push('</strategy-doc>'); }
          } catch {}
        }
      }
      // 参数 .set(挂载时用的热参) — 从 workspace/strategies/<ea>.set 读
      try {
        const _fs = require('node:fs');
        const setPath = path.join(workspaceDir, 'strategies', `${stem}.set`);
        if (_fs.existsSync(setPath)) {
          const setTxt = _readTextWithBom(setPath).trim().split(/\r?\n/).filter((l) => l && !l.startsWith(';')).slice(0, 60).join('\n');
          if (setTxt) { lines.push(''); lines.push(`该策略当前参数(.set)：`); lines.push('```'); lines.push(setTxt); lines.push('```'); }
        }
      } catch {}
      // 策略经验(<ea>.experience.md) — AI 每日总结/主动记录/操盘手远程同步积累的历史经验,
      // 只截最近一部分(避免文件大了把首轮上下文顶爆); 跟说明文档同款用标签包起来, 让 AI
      // 分清这是「历史经验」不是「当前状态」。
      try {
        const _fs = require('node:fs');
        const expPath = path.join(workspaceDir, 'strategies', `${stem}.experience.md`);
        if (_fs.existsSync(expPath)) {
          const expTxt = _readTextWithBom(expPath).trim();
          const tail = expTxt.length > 4000 ? expTxt.slice(-4000) : expTxt;
          if (tail) {
            lines.push('');
            lines.push(`<strategy-experience ea="${stem}" note="历史经验笔记, 只截最近部分">`);
            lines.push(tail);
            lines.push('</strategy-experience>');
          }
        }
      } catch {}
    }
  } catch { /* 种子失败不阻塞对话 */ }
  lines.push('');
  lines.push(`当前时间：${_bjNowStr()} (Asia/Shanghai)。以上是本策略的静态种子；实时数据一律用 MCP 工具查。`);
  return lines.join('\n');
}

/**
 * 0.3.5: 给 chat-session 看的「最近微信对话概况」block。
 * 数据源：wechat-sessions store 拿 chatId 列表 + last_used 排序，最近
 * 24h 内有活动的取前 5 个；每个 chatId 从其 session JSONL 里读最后一条
 * user msg 和 last assistant turn（截 100 字）。
 *
 * 不存在 wechat 通道 / 没活动 → 返 ''（不注入空块）。
 */
function _recentWechatActivityBlock() {
  if (!wechatSessions) return '';
  try {
    const sum = wechatSessions.summary();
    if (!sum.total) return '';
    const cutoff = Date.now() - 24 * 3600_000;
    const recent = (sum.chats || []).filter((c) => (c.last_used || 0) > cutoff).slice(0, 5);
    if (!recent.length) return '';
    const out = [
      '<wechat-recent-activity>',
      `最近 24h 微信端有 ${recent.length} 个对话流活跃（admin 用户可在 chat 引用 / 回顾，但不要主动跨 channel 回话）：`,
    ];
    for (const c of recent) {
      const ts = new Date(c.last_used).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const tail = _peekSessionTail(c.session_id);
      out.push(`  · [${c.chatId.slice(0, 12)}…] ${ts}  ${c.msg_count} 轮  ${tail || '(无内容)'}`);
    }
    out.push('</wechat-recent-activity>');
    return out.join('\n');
  } catch { return ''; }
}

/**
 * 0.3.5: 从 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 抠出最后一条 user
 * msg + last assistant turn 的文字摘要，给 cross-channel context 注入用。
 * 截短到 100 字避免炸 prompt size。
 */
function _peekSessionTail(sessionId) {
  if (!sessionId) return '';
  try {
    const projectsDir = path.join(require('node:os').homedir(), '.claude', 'projects');
    const wsDir = kb?.workspaceDir || path.join(app.getPath('userData'), 'workspace');
    // Claude Code's encoded cwd format: replace : / \ with -
    const encoded = wsDir.replace(/[:/\\]/g, '-');
    const jsonl = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonl)) return '';
    const text = fs.readFileSync(jsonl, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    let lastUser = '', lastAi = '';
    // walk from tail
    for (let i = lines.length - 1; i >= 0 && (!lastUser || !lastAi); i -= 1) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === 'user' && !lastUser) {
          const c = d.message?.content;
          if (typeof c === 'string' && !c.startsWith('[scheduled-trigger') && !c.startsWith('<')) {
            lastUser = c.replace(/\s+/g, ' ').slice(0, 80);
          }
        } else if (d.type === 'assistant' && !lastAi) {
          for (const blk of d.message?.content || []) {
            if (blk.type === 'text' && blk.text) {
              lastAi = blk.text.replace(/\s+/g, ' ').slice(0, 80);
              break;
            }
          }
        }
      } catch {}
    }
    const parts = [];
    if (lastUser) parts.push(`U:${lastUser}`);
    if (lastAi)   parts.push(`AI:${lastAi}`);
    return parts.join(' / ');
  } catch { return ''; }
}

async function reapplyWorkspaceFromSettings() {
  const s = settings.getResolved();
  const activeMt5 = settings.getActiveMt5Instance?.();
  const dataDir = path.join(app.getPath('userData'), 'data');
  const wechatScript = resolveBundledFile('python', 'wechat_mcp.py');
  // settings.json 路径来自 SettingsStore；easydeal-settings MCP 写它，主 MCP 读它。
  const settingsJsonPath = settings.path;
  const settingsMcpScript = resolveBundledFile('python', 'easydeal_settings_mcp_server.py');
  await kb.ensureWorkspace({
    easydealScript: s.easydealScript,
    settingsMcpScript: fs.existsSync(settingsMcpScript) ? settingsMcpScript : null,
    settingsJsonPath,
    schedulerScript: resolveBundledFile('python', 'scheduler_mcp.py'),
    schedulerDb: path.join(dataDir, 'scheduler.db'),
    pythonBin: s.pythonBin,
    mt5InstallDir: s.mt5.installDir,
    mt5DataDir: s.mt5.dataDir,
    mt5LaunchMode: activeMt5?.launchMode || null,
    mt5InstanceId: activeMt5?.id || null,
    windTunnelDir: fs.existsSync(resolveBundledFile('skills', 'wind-tunnel-skill'))
      ? resolveBundledFile('skills', 'wind-tunnel-skill') : null,
    windowCaptureScript: s.windowCaptureScript,
    backtestsFile: path.join(dataDir, 'backtests.json'),
    wechatScript: fs.existsSync(wechatScript) ? wechatScript : null,
    tradingWriteEnabled: !!s.tradingWriteEnabled,
    // 0.3.99: 开仓权限独立 toggle（默认关）+ OrderGuard port file 路径让
    // Python 端 _trading_open_position 成功后自动把订单注册进 OrderGuard 监控。
    tradingWriteOpenEnabled: !!s.tradingWriteOpenEnabled,
    orderguardPortFile: path.join(dataDir, 'orderguard.port'),
    monitor: s.monitor,
    // 0.3.14: 金十快讯 buffer 文件路径 — main.js 的 newsProvider 每 30s
    // 把最近 200 条写到这里；MCP child 通过 EASYDEAL_NEWS_BUFFER_FILE
    // env 读它（在 list_recent_news tool 里）。
    newsBufferFile: path.join(dataDir, 'news-buffer.json'),
    mqhSourceDir: path.dirname(resolveBundledFile('mql5', 'OrderGuard.mqh')),
  });
}

function buildStrategyDocPrompt(action, name) {
  const fileName = String(name || '').trim();
  if (!fileName) return null;
  // 0.3.55: ex5-only EA 进来时 name 是 "xxx.ex5"，正则要把 .mq5/.ex5 都剥掉
  const ea = fileName.replace(/\.(mq5|ex5)$/i, '');
  const mq5Rel = `strategies/${fileName}`;
  const mdRel  = `strategies/${ea}.md`;

  if (action === 'generate') {
    return [
      `请帮我为 EA **${ea}** 生成一份策略说明文档。`,
      ``,
      `**步骤：**`,
      `1. 用 Read 工具读 \`${mq5Rel}\` 的完整源码`,
      `2. 提炼出策略要点：核心思路 / 入场条件 / 出场条件 / 风控 / 关键参数及含义`,
      `3. 用 Write 工具写到 \`${mdRel}\`，章节结构如下（参考 \`.easy-deal/strategy_doc_latest.md\`，但**必须包含最后两节**）：`,
      `   - 核心思路`,
      `   - 交易流程（入场 / 出场 / 加仓 / 平仓）`,
      `   - 风控规则`,
      `   - 参数列表（参数名 + 类型 + 默认值 + 含义）`,
      `   - **Agent 监控建议** ← 必填，见下方要求`,
      `   - **风险检查清单** ← 必填，见下方要求`,
      ``,
      `**「Agent 监控建议」章节怎么写：**`,
      `读完源码后，根据这只 EA 的具体机制给出**可由 Claude / 定时任务自动执行的监控建议**，建议要具体到：`,
      `- **频率**：每小时 / 每 4 小时 / 每天收盘后 / 每次加仓后 等（按策略特性定，不要笼统说"定时检查"）`,
      `- **检查内容**：哪些 metric / 状态 / 日志关键字需要看`,
      `- **触发条件 → 行动**：达到什么阈值就该提醒用户 / 暂停 EA / 平仓`,
      ``,
      `举例（仅作格式参考，不要照抄；要根据${ea}**自己的源码**来定）：`,
      `> **GMarket（马丁 + 双向网格）的监控建议**`,
      `> - 每小时调 \`get_strategy_status\` + \`get_trading_status\`，重点看：`,
      `>   - **马丁层数**：当前 buy/sell 方向各开了几张？≥ 5 层时提醒，≥ 7 层时建议手动止损`,
      `>   - **对冲缺脚**：buy 和 sell 的持仓数应该接近；差 ≥ 3 张说明一边被止损了，单边裸奔风险高`,
      `>   - **当前回撤**：浮亏 / 账户净值，超过 15% 提醒`,
      `> - 每 4 小时把 \`MQL5/Logs/\` 最近一段日志拉出来 grep \`error\`/\`failed\`/\`requote\`，超阈值汇报`,
      `> - 每天 23:00 前结算一次：今日开仓数 / 平仓数 / 净盈亏，超出参数预期就报告`,
      ``,
      `**「风险检查清单」章节怎么写：**`,
      `针对这只 EA 的**特有失效模式**列 5-8 条用户/agent 应该警惕的红旗，每条一行，比如：`,
      `- 单边趋势行情中马丁层数飞涨 → 对冲彻底失效`,
      `- 周末 / 公告前忘记关 EA → 跳空时仓位锁死`,
      `- 服务器延迟导致补单失败 → buy/sell 不对称`,
      `- ……`,
      ``,
      `4. 写完跟我确认你写了哪几个章节，并把"Agent 监控建议"原样贴出来让我审一遍。`,
      ``,
      `客户端"我的策略"标签页会自动看到这份文档，5 秒内就刷新出来。`,
    ].join('\n');
  }

  if (action === 'verify') {
    return [
      `帮我**校对** EA **${ea}** 的策略说明跟源码是否一致。`,
      ``,
      `**步骤：**`,
      `1. 用 Read 工具读源码 \`${mq5Rel}\` 和文档 \`${mdRel}\``,
      `2. 逐项对比，特别检查：`,
      `   - 文档里描述的入场/出场条件，源码里有没有对应实现`,
      `   - 文档里列的参数名跟 input 声明是不是一致`,
      `   - 文档里的默认值跟源码里的 input 默认值是不是一致`,
      `   - 文档里写了的功能（比如止损/止盈/马丁），源码里有没有实现`,
      `   - 源码里有的逻辑，文档有没有遗漏`,
      `   - **「Agent 监控建议」章节是否存在且与源码机制对得上**（如源码里有马丁逻辑但建议里没提层数监控，算缺漏）`,
      `   - **「风险检查清单」章节是否存在且具体到这只 EA**（不能是泛泛的"小心爆仓"）`,
      `3. 把发现的问题列成清单（最多 10 条），每条标【文档过时】/【文档错误】/【文档遗漏】/【源码遗漏】/【监控建议缺失】`,
      `4. **不要直接改文件**——只给报告，让我看完决定怎么处理。`,
      ``,
      `如果完全一致，简短说"对齐了"即可。`,
    ].join('\n');
  }

  // 0.3.55: 「AI 推测（基于日志）」—— 用户买/手动放进来的 .ex5 EA 没有 .mq5
  // 源码，AI 读不了源码就没法走 generate 路径（之前直接 Read 二进制 → 生成乱码）。
  // 兜底方案：让 AI 看 MQL5/Logs/ 最近交易日志 + 实盘交易历史，逆向推测策略行为。
  // 客户端 renderDocPanel 只在 has_source=false AND hours_run ≥ 72h 时显示这个
  // 按钮，确保日志样本足够。生成的文档强制带「⚠ 本说明基于日志推测，不一定准确」
  // 免责声明，避免用户当真。
  if (action === 'predict-from-logs') {
    return [
      `帮我**基于日志推测** EA **${ea}** 的策略行为，并写一份"尽力而为"的说明文档。`,
      ``,
      `**背景**：这只 EA 只有 \`.ex5\`（编译产物），没有 \`.mq5\` 源码 — 你**读不了源码**，`,
      `只能从它在 MT5 上跑的痕迹里逆向猜。这只 EA 已经挂载运行 ≥ 72 小时，日志样本应该够看。`,
      ``,
      `**步骤：**`,
      `1. 用 \`list_strategies\` 找到 \`${ea}\` 这只 EA 的 \`is_mounted\` / \`hours_run\` / \`magic\` 信息`,
      `2. 用 \`get_mt5_logs\`（如果 tool 不存在改用 \`Read\` 工具读 \`MQL5/Logs/\` 目录下最近的日志文件）抓最近 7 天日志，重点找 \`${ea}\` 的痕迹：`,
      `   - 开仓 / 平仓 OP_BUY / OP_SELL / position open / position close`,
      `   - 它声明自己的 magic number 是什么`,
      `   - 它打印的自定义日志（很多 EA 会 Print 自己的状态机 / 信号判断）`,
      `3. 用 \`get_strategy_status\` + \`get_recent_trades\` 看这只 EA 实盘的交易模式：`,
      `   - 开的是 BUY 还是 SELL 居多？方向偏好怎样？`,
      `   - 单笔大小 / lot 怎么定的？看着像马丁加倍？固定手数？`,
      `   - 持仓时长平均多久？秒级 / 分钟级 / 小时级 / 跨日？说明它是什么风格`,
      `   - 同时间是否多张持仓？说明它是不是网格 / 对冲 / 加仓`,
      `   - 止损 / 止盈用没用 SL/TP 字段？还是软止损（自己代码里平）？`,
      `4. 综合上面信息，用 \`Write\` 工具写到 \`${mdRel}\`，**文档顶部必须带这段免责声明**（一字不差）：`,
      ``,
      `\`\`\`markdown`,
      `> ⚠ **本说明基于日志推测，不一定准确**`,
      `>`,
      `> 这只 EA 只有 .ex5 没有源码，本文档是 AI 看 MQL5/Logs/ 最近日志 + 实盘交易历史**逆向猜出来的**，可能跟原作者意图有偏差。请把它当"行为快照"看，不要当"策略说明书"。如果你跟原作者要到了 .mq5 源码，请用「AI 重写」覆盖此文档。`,
      `\`\`\``,
      ``,
      `5. 接着写以下章节（按你推测出的信息填，**没数据的章节明确写"未知 — 日志无明显信号"**，不要瞎编）：`,
      `   - **观察到的行为**（开仓方向 / 频次 / 持仓时长 / 单笔大小特征）`,
      `   - **疑似策略类型**（趋势 / 网格 / 马丁 / 套利 / 高频 …… 给依据）`,
      `   - **疑似入场条件**（看日志里的 Print / 持仓时机猜，不要硬编）`,
      `   - **疑似风控**（有没有 SL/TP / 单笔最大手数 / 浮亏阈值 等）`,
      `   - **Agent 监控建议**（按观察到的行为给监控阈值，比如"同时持仓 >5 张提醒"）`,
      `   - **风险检查清单**（基于观察到的行为列特有失效模式 5-8 条）`,
      ``,
      `6. 写完跟我汇报：哪些章节有把握 / 哪些是猜的 / 日志样本量（多少条交易 + 多少 KB 日志），方便用户判断这份文档可信度。`,
      ``,
      `**核心原则**：宁可写"未知"也不要凭印象编造。这份文档之后会被 cron 监控任务读，写错了会误导自动监控。`,
    ].join('\n');
  }

  if (action === 'fix') {
    return [
      `帮我**修正** EA **${ea}** 的策略说明（让文档跟源码对上）。`,
      ``,
      `**步骤：**`,
      `1. 先按"校对"流程对比 \`${mq5Rel}\` 和 \`${mdRel}\`，找出所有不一致点`,
      `2. 默认 **以源码为准**改文档（除非问题明显是源码 bug——那种情况下先停下来问我）`,
      `3. 用 Edit 工具改 \`${mdRel}\`：参数列表、入场出场条件、默认值都要对齐`,
      `4. **如果文档没有「Agent 监控建议」或「风险检查清单」章节，补上**——`,
      `   按"生成"流程的写法：监控建议要具体到频率 + 检查内容 + 触发条件 → 行动；`,
      `   风险清单要针对这只 EA 的特有失效模式（马丁层数飞涨、对冲缺脚、跳空锁仓等）。`,
      `5. 改完跟我汇报：`,
      `   - 具体改了文档的哪几处`,
      `   - 监控建议章节有没有补/改，关键几条贴出来`,
      `   - 有没有发现像源码 bug 但没动的疑点`,
      ``,
      `不要假设。每一处不确定的，先 Read 源码确认，不要凭印象写。`,
    ].join('\n');
  }

  return null;
}

function buildBacktestPrompt({ strategyName, fileName } = {}) {
  const ea = strategyName || fileName || '工作区中的策略';
  return `请使用 wind-tunnel-skill 回测 ${ea}。先阅读工作区 Skill 和该版本 MQ5 源码及依赖，准备对应版本的 Python 适配器。用 run_backtest 提交连续真实 Tick 回放，默认使用最近一个行情周。告诉我实际区间、任务 ID 和结果在哪里查看。`;
}

// 0.3.49: 上架对话框勾「自动注入授权代码」时，把 EasyDealAuth.mqh 的
// #include + OnInit/OnTick 守卫调用直接插进用户的 .mq5 源码。Idempotent —
// 已经有的不重复插。找不到 OnInit/OnTick → 返 ok:false 让 UI 退到老的
// 「请手动加」错误路径，不瞎改用户源码。
function _injectEasyDealAuth(source) {
  if (!source || typeof source !== 'string') {
    return { ok: false, error: '源码为空 / 读取失败' };
  }
  const hasInclude = /#include\s*<EasyDealAuth\.mqh>/.test(source);
  const hasCall    = /\bEasyDealCheckAuth\s*\(/.test(source);
  if (hasInclude && hasCall) {
    return { ok: true, text: source, injected: { include: false, oninit: false, ontick: false } };
  }
  let text = source;
  const injected = { include: false, oninit: false, ontick: false };

  if (!hasInclude) {
    // 优先插在文件顶部连续的 #property / #include 块之后（MQL5 惯例文件头）。
    // 找不到这类块就直接插到文件最前面。
    const headMatch = text.match(/^((?:[^\S\n]*(?:#property|#include)[^\n]*(?:\r?\n)+)+)/);
    const line = '#include <EasyDealAuth.mqh>\n';
    if (headMatch) {
      text = headMatch[0] + line + text.slice(headMatch[0].length);
    } else {
      text = line + text;
    }
    injected.include = true;
  }

  if (!hasCall) {
    const onInitRe = /(int\s+OnInit\s*\(\s*(?:void\s*)?\)\s*\{)/;
    text = text.replace(onInitRe, (m) => {
      injected.oninit = true;
      return m + '\n   if (!EasyDealCheckAuth()) return INIT_FAILED;';
    });
    const onTickRe = /(void\s+OnTick\s*\(\s*(?:void\s*)?\)\s*\{)/;
    text = text.replace(onTickRe, (m) => {
      injected.ontick = true;
      return m + '\n   if (!EasyDealCheckAuth()) return;';
    });
    if (!injected.oninit && !injected.ontick) {
      return {
        ok: false,
        error: '找不到 OnInit / OnTick 函数体（可能是 script 或者函数签名 unusual）— 自动注入需要这两个标准入口',
      };
    }
  }
  return { ok: true, text, injected };
}

// 0.3.49: 上架 isolated build 完事后清掉 alt 名字的临时 .mq5/.ex5。包括
// workspace/strategies/<alt>.mq5/.ex5 + MT5/Experts/<alt>.mq5/.ex5（data dir +
// install dir 两份兜底）。被锁住 / 找不到的文件 swallow，best-effort 清理。
function _cleanupListingBuildTemp(paths) {
  for (const p of (paths || [])) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); }
    catch (e) { console.warn('[compile-verify] cleanup', p, 'failed:', e?.message || e); }
  }
}

function _authMissingDetail(filePath, missingInclude, missingCall) {
  const missing = [];
  if (missingInclude) missing.push('#include <EasyDealAuth.mqh>');
  if (missingCall)    missing.push('EasyDealCheckAuth() 调用');
  return {
    missing,
    file: filePath,
    required_snippets: [
      '// 文件顶部：',
      '#include <EasyDealAuth.mqh>',
      '',
      '// 然后在 OnInit 和 OnTick 里各加一行：',
      'int OnInit() {',
      '   if (!EasyDealCheckAuth()) return INIT_FAILED;',
      '   // ... 你的原代码 ...',
      '}',
      '',
      'void OnTick() {',
      '   if (!EasyDealCheckAuth()) return;',
      '   // ... 你的原代码 ...',
      '}',
    ].join('\n'),
    hint: 'EasyDealAuth.mqh 已经自动放到 MT5\\MQL5\\Include\\ 下。' +
          '上架对话框里勾「自动注入授权代码」让客户端帮你改 — 原文件会备份到 strategies/_backups/。',
  };
}

// 0.3.10: workspace .ex5 跟 MT5/Experts/.ex5 hash 不一致 → AI 走完整重新
// 编译 + 同步流程。根因通常是 (a) 用户/AI 之前手动改过 MT5/Experts 那边、
// 或 (b) compile 时 EA 被锁部分写失败。让 AI 先判清状态再处理。
function buildRedeployPrompt({ strategyName, fileName } = {}) {
  const ea = strategyName || (fileName || '').replace(/\.(mq5|ex5)$/i, '');
  return [
    `EA **${ea}** 现在 \`workspace/strategies/${ea}.ex5\` 跟 MT5 那边 \`MQL5/Experts/${ea}.ex5\` 的 sha256 不一致 — 客户端「我的策略」一直显示「⚠ 不一致」。`,
    `请帮我用一次完整的重新编译 + 同步把它拉齐。`,
    ``,
    `**步骤：**`,
    ``,
    `1. **确认源码** — Read \`strategies/${ea}.mq5\` 头 30 行，确认源码存在且没明显问题。`,
    ``,
    `2. **调 \`mcp__easydeal__compile_strategy(ea_name="${ea}")\`** — 这一步会：`,
    `   - 把 \`strategies/${ea}.mq5\` 拷到 MT5/MQL5/Experts/${ea}.mq5`,
    `   - 用 MetaEditor 编译产 \`${ea}.ex5\``,
    `   - **0.3.10 新增**：把新 .ex5 自动同步回 workspace/strategies/${ea}.ex5（这是修这条「不一致」的关键）`,
    `   - 写 reload.trigger 让在跑 EA 重 init`,
    ``,
    `3. **必看返回字段**：`,
    `   - \`success: true\` + \`summary_errors: 0\` —— 编译本身成功`,
    `   - \`ex5_rebuilt: true\` —— 真重编了`,
    `     - 如果是 \`false\` 且带 \`skipped_recompile: true\` → 说明源码 sha256 没变，hash 不一致是因为 workspace .ex5 stale。这条分支需要你直接用 Bash \`copy /Y "<MT5_ex5>" "<workspace_ex5>"\` 把 MT5 那份覆盖回 workspace（路径从返回里 \`ea_source_path\` 推：替换扩展名 + 找到对应 workspace strategies 目录）`,
    `   - \`workspace_ex5_synced\` 应该是个路径字符串（不是 null 也不是 \`sync_failed: ...\`）。失败的话同样手动 copy 一次。`,
    `   - 任何一项不对就**停下来**把 JSON 关键字段贴给用户，特别是：`,
    `     - \`preexisting_metaeditor_instances\` —— >0 说明有 MetaEditor 窗口卡着，告诉用户全关了再试`,
    `     - \`hint\` 字段 —— compile_strategy 自己写好的诊断`,
    ``,
    `4. **告诉用户：**`,
    `   - compile 成功 / 失败的简短结论`,
    `   - workspace .ex5 是否已经同步（看 \`workspace_ex5_synced\` 字段）`,
    `   - 如果 EA 当时正在跑：新版本会通过 reload.trigger 自动 reinit；想最保险就回「策略」栏点这只 EA 的「挂载」按钮重挂一次（一键自动，不用手动去 MT5 拖图表）`,
    `   - 几秒后让用户回「我的策略」刷新，「⚠ 不一致」应该消失`,
    ``,
    `不要在第一次 compile 失败后默默重试 — 把 JSON 字段贴出来让用户也知道发生了什么。`,
  ].join('\n');
}

function buildDeployPrompt({ strategyName, fileName } = {}) {
  const ea = strategyName || (fileName || '').replace(/\.(mq5|ex5)$/i, '');
  return [
    `请帮我把 EA **${ea}** 编译并挂载到 MT5。`,
    ``,
    `**步骤：**`,
    `1. 用 Read 工具确认 \`strategies/${ea}.mq5\` 存在（读前 30 行确认是这个 EA）`,
    `2. 调 \`mcp__easydeal__compile_strategy\`，**必须传 \`ea_name="${ea}"\`**`,
    `   （此工具会自动把 .mq5 复制到 \`<MT5_DATA_DIR>\\MQL5\\Experts\\${ea}.mq5\`，再用 MetaEditor64 编译出 \`${ea}.ex5\`）`,
    `3. 检查返回的 stderr/stdout，确认编译成功（exit_code=0、产出 .ex5）`,
    `   - 若有 error/warning，把原文告诉我并停下来——大概率源码有问题`,
    `   - 若编译成功，告诉我 .ex5 的完整路径 + 大小`,
    ``,
    `4. **编译成功后一键挂载**：调 \`mcp__easydeal__attach_eas_to_charts(assignments=[{ea_name:"${ea}", symbol:"<品种>", period:"<周期>"}])\``,
    `   —— 不重启 MT5。MT5 在跑时第一次返回 needs_user_confirm，把影响告诉我、我同意后带 confirm_reload=true 再调。多 MT5 时按该 EA 绑定的实例自动选，或传 \`instance_id\`。`,
    `   **不要再让我手动去 Navigator 拖图表 / 双击 terminal64 —— 现在是一键挂载。**`,
    ``,
    `5. 🛑 **看 attach_eas_to_charts 返回的 \`ok\` 字段**：`,
    `   - \`ok:true\` 才能说挂载成功；几秒后让我回「我的策略」刷新，会显绿色「运行中」`,
    `   - \`ok:false\` = 没挂上，**绝对禁止**回「已挂载/已生效」。如实报 \`stage\`+\`error\`，并引导：`,
    `     **「回 EasyDeal『策略』tab，点这只 EA 那行的『挂载』按钮重试（一键自动）；若还失败，先手动把占用的 MT5 关掉再点」** —— 不要让我去 Navigator 手动拖图表。`,
  ].join('\n');
}

function buildEaCreatePrompt() {
  return [
    '我想创建一个新的 EA（交易策略），请帮我从零做起。流程：',
    '',
    '**第一步：访谈**',
    '先问我以下问题（每问一道，等我答完再问下一道，不要一次性全甩给我）：',
    '1. 交易品种：黄金 / EURUSD / GBPUSD / 其他外汇对？',
    '2. 周期：M1 / M5 / M15 / M30 / H1 / H4 / D1？',
    '3. 策略思路一句话：趋势跟踪 / 震荡均值回归 / 网格 / 马丁 / 突破 / 自定义？',
    '4. 风控偏好：保守（小手数、严格止损） / 平衡 / 激进（重手、马丁补仓）？',
    '5. 策略名字（PascalCase，如 GoldTrendV1）？',
    '',
    '**第二步：写代码**',
    '基于以上回答，写一份 MQL5 的 EA 源码，要求：',
    '- 用 Write 工具保存到 `strategies/<策略名>.mq5`（在我的 workspace 里）',
    '- 包含 `OnInit`、`OnTick`、`OnDeinit`',
    '- 顶部用 `input` 声明所有可调参数（手数、止损点、止盈点等），并写中文注释',
    '- 在 `OnInit` 里把参数 dump 成 JSON 写到 `MQL5/Files/<EA名>_runtime.json`（参考 .easy-deal/README.md 里的协议约定，方便客户端 MCP 读真实参数）',
    '- 在 `OnTimer` 里轮询 `MQL5/Files/<EA名>_config.set` 实现热更新（同样参考 README 的协议）',
    '- 给一个简单但能跑通的策略骨架，不要遗漏 magic number',
    '',
    '**第三步：跟我确认**',
    '写完后告诉我：① 文件路径 ② 关键参数及默认值 ③ 进入 MT5 编译挂载的下一步操作',
    '',
    '客户端的"我的策略"标签页会自动看到这个文件，不要担心同步问题。',
  ].join('\n');
}

function buildOnboardingPrompt() {
  // 新序列号首次登录后自动跑这条 —— 让 Claude 充当配置向导，把 7 步流程
  // 一个个走完。每步等用户回答，调对应的 MCP 工具落实到 settings.json。
  // 全程对话式，不一次性把 7 步全甩给用户。
  return [
    '我是 EasyDeal 的新用户，刚激活序列号。请你充当**配置向导**，按下面 7 步一个一个引导我完成首次配置——',
    '',
    '**关键规则**：',
    '- 每一步只问一个问题或下一个动作，**等我回答完再进入下一步**，不要一次性把 7 步全列出来',
    '- 步骤之间用一两句过渡话承接，让我知道当前进度（例如「✅ 第 1 步搞定，下面进行第 2 步」）',
    '- 涉及改 EasyDeal 设置的用 `mcp__easydeal-settings__*` 工具；涉及 MT5 查询的用 `mcp__easydeal__*` 工具；定时任务用 `mcp__easydeal-scheduler__schedule_task`',
    '- 我的回答可能口语化（「我装在 D:\\xxx」、「就这个文件」等），你要自己提取信息再调工具',
    '',
    '**🔴 流程闭环铁律（最重要）**：',
    '- **必须从第 1 步走到第 8 步全程闭环**，每步开头打「**第 X 步 / 8 — <标题>**」让我能看到进度。',
    '- 每步处理完，**强制进入下一步**——不论我的回答多简短（「对」「嗯」「好」「OK」），都视为该步通过的确认，立刻打过渡 + 进入下一步开头。绝对不要在中间步骤上说「需要我做什么就说」「有问题再问我」之类的收尾话——那些只能在第 8 步说。',
    '- 如果某一步在用户机器上**已经天然满足**（如 EA 已编译挂载、cron 已建、settings 已填、监控品种已正确配置），先调工具确认状态，然后打「**✅ 第 X 步已经满足（已检测到 …）**」一句，**立刻进入下一步**。不要因为「没活可干」就提前结束。',
    '- **必须以「✅ 8/8 配置完成」+ 第 8 步那 3-4 个下一步选项收尾**。没看到这两个东西就说明流程没走完，继续。',
    '',
    '**8 步流程**（按顺序）：',
    '',
    '**1. MT5 安装目录**',
    '先调 `mcp__easydeal-settings__list_mt5_instances()` 看是否已有 MT5 实例:',
    '- 已有 1+ 个实例 → 打「**✅ 第 1 步已经满足 (检测到 N 个 MT5 实例: <name list>)**」直接进第 2 步',
    '- 没有任何实例 → 问我「请告诉我 MT5 的安装目录在哪里？（含 terminal64.exe 的那个文件夹绝对路径）。如果还没装, 可以告诉我「帮我下载」, 我引导你去 MT5 tab 一键下载安装」',
    '我答完路径后调 `mcp__easydeal-settings__connect_mt5(install_dir=...)` — 0.3.223 起这个工具会自动同步到 mt5Instances[] (建一个 "默认实例" entry), MT5 tab 立刻能看见. 如果是便携式（install_dir 下有 MQL5 子目录）顺带把 dataDir 也设好; 不是的话客户端启动自检会用注册表 + APPDATA origin.txt 自动补上 dataDir.',
    '如果用户说要下载: 不要尝试帮他下载 — 让他「去 EasyDeal 顶部「MT5」tab → 点「+ 添加实例」→ 切「一键下载并安装」标签页」, 等他装完回来你再走第 2 步.',
    '',
    '**2. MT5 数据目录（确认 / 修正）**',
    '调 `mcp__easydeal-settings__get_settings(section="mt5")` 看 dataDir 现在是什么。',
    '- 如果已经填好（便携式 / 自动检测命中）→ 跟我确认「数据目录已自动定位为 X，对吗？」',
    '- 如果还空着 → 教我打开数据目录：「在 MT5 终端里点【文件】→【打开数据文件夹】，把弹出来的文件夹完整路径复制给我」。我答完调 `mcp__easydeal-settings__set_mt5_data_dir(data_dir=...)` 写入。',
    '',
    '**3. 监控品种**（**关键步骤，新手最容易撞坑**）',
    '默认监控品种列表 `[GOLD, GOLD#, XAUUSD, XAUUSDm, XAUUSDc]` 只覆盖 Exness 等少数 broker，**Doo Technology / VT Markets / FXTM / IC Markets 等其他 broker 的黄金品种名各不一样**（可能是 `XAUUSDg` / `XAUUSD.b` / `GOLD.h` / `XAUUSD#` 等），用默认值会撞「MT5 中不存在币对 GOLD」错误。',
    '',
    '步骤：',
    '- 先调 `mcp__easydeal__get_account` 或 `mcp__easydeal__get_strategy_status` 拿到当前账户的 broker 公司名（terminal.company / account.server 字段），让我知道你识别出来了什么 broker',
    '- 然后告诉我：「我看到你接的是 <broker 名>。请打开 MT5 → 右键【市场报价】窗口空白处 → 选【全部显示】，然后找到黄金品种（名字里含 XAU 或 GOLD），把那一行的完整名字（包括所有后缀，比如 `XAUUSDm` / `XAUUSD.b` / `GOLD#` 等）告诉我。如果你日常还交易其他品种（EURUSD / BTCUSD / NAS100 之类），也一起告诉我。」',
    '- 我答完调 `mcp__easydeal-settings__set_monitor_symbols(symbols=[...])` 写入。**至少含一个黄金类品种**——这是默认 AI 决策 / 回测的主品种',
    '- 验证：调 `mcp__easydeal__get_market_info`，如果能拿到买卖价就说明配对了。撞 symbol_not_found → 让我再核对一次 MT5 里的名字',
    '',
    '**4. 询问有无 EA**',
    '问我：「请问你有自己的 EA 源码吗？还是想让我帮你从零写一个？」',
    '- 有 → 让我把 .mq5 源码文件路径告诉你（或直接粘贴源码）。用 Write 工具把源码保存到 `strategies/<EA名>.mq5`',
    '- 没有 → 按 EA 创建访谈走（参考 `app:request-ea-create-guide` 的访谈结构：问交易品种 / 周期 / 思路 / 风控 / 名字，再 Write 出一份骨架 .mq5 到 `strategies/`）',
    '',
    '**5. 挂载 EA 到 MT5**（一键，不用手动拖图表）',
    '生成 / 收到 .mq5 之后引导挂载：',
    '- 调 `mcp__easydeal__compile_strategy(name=...)` 让 MetaEditor 编译产物 → `<dataDir>/MQL5/Experts/<EA>.ex5`',
    '- 编译成功后**一键挂载**：调 `mcp__easydeal__attach_eas_to_charts(assignments=[{ea_name:"<EA>", symbol:"<品种>", period:"<周期>", inputs:{...可选}}])` —— 不重启 MT5，把 EA 写进指定图表；MT5 在跑时先返回 needs_user_confirm，我同意后带 confirm_reload=true 再调。**不要让我手动去 Navigator 拖图表 / 双击 terminal64**。',
    '- 看返回 `ok` 字段：ok:true 才算成功；ok:false 如实报 stage+error，引导我「回『策略』栏点这只 EA 的『挂载』按钮重试」。也可以直接告诉我「去『策略』栏点这只 EA 那行的『挂载』按钮」自己点（效果一样，多 MT5 还能选实例）。',
    '- 挂好后调 `mcp__easydeal__get_strategy_status` 验证（is_mounted=true）',
    '',
    '**6. 为 EA 生成策略说明**',
    '挂载确认后说：「现在我帮你生成 EA 的策略说明文档，定时监控 / 回测都依赖这份。开始读源码⋯」',
    '直接执行（不用等我同意）：用 Read 读 `strategies/<EA>.mq5` 源码 → 提炼核心思路 / 入场 / 出场 / 风控 / 参数 / **「Agent 监控建议」**（具体到频率 + 检查内容 + 触发条件→行动）+ **「风险检查清单」** → 用 Write 写到 `strategies/<EA>.md`。',
    '写完后跟我确认「Agent 监控建议」章节让我审一眼。',
    '',
    '**7. 为 EA 添加监控（cron 任务）**',
    '基于 .md 里「Agent 监控建议」章节给我建一个对应的 cron 任务。调 `mcp__easydeal-scheduler__schedule_task(name="<EA> 监控", schedule="<cron 表达式>", prompt="<具体监控指令，引用 .md 里的阈值和动作>", mode="llm_headless")`。',
    '建完跟我说「定时任务已建好，每 X 跑一次。如果发现 Y 阈值会主动通知你」。',
    '',
    '**8. 收尾询问**',
    '最后问我：「✅ 首次配置完成！接下来你想我为你做些什么？」',
    '给我 3-4 个最常见的下一步选项作为提示，比如：',
    '- 「跑一次回测看看历史表现」',
    '- 「检查当前账户和持仓」',
    '- 「把账户级风控也加个监控（账户浮亏、保证金率等）」',
    '- 「我自己探索一下，有问题再问你」',
    '',
    '**注意事项**：',
    '- MT5 切换 / 数据目录改动会自动让左上角 EA 挂载徽章 + 设置页输入框热刷新——不用我手动刷',
    '- 任何一步失败（如路径不存在、品种不在 broker 列表、编译失败），先告诉我具体错误再问要不要 retry / 跳过',
    '- 你可以预测我的口语化输入并自己解析（例如我说「装目录在 D:\\Projects\\MetaTrader 5」就直接当 install_dir 用）',
    '',
    '现在开始第 1 步。',
  ].join('\n');
}

function buildMt5InstallGuidePrompt() {
  return [
    '我是 EasyDeal 客户端的新用户，还没安装 MT5 终端。',
    '我的环境：Windows，目标是接 Exness 的模拟账户跑量化策略。',
    '',
    '**第一步：用 Read 工具读 `.easy-deal/README.md`** —— 那是 EasyDeal 项目作者写的官方安装指引。',
    '特别注意里面"一、交易账号注册与MT5安装"章节中：',
    '- 项目作者的 Exness 合作伙伴链接（形如 `https://one.exnessonelink.com/a/...`）',
    '- MT5 平台的下载入口',
    '- 服务器选择 / 登录步骤的关键截图说明',
    '',
    '**绝对不要使用通用的 `https://www.exness.com` URL**——必须用 README 里项目作者的合作伙伴链接。',
    '',
    '读完 README 之后，按下面顺序给我一份精简的安装指引（每步只列必要操作）：',
    '1. 为什么用 Exness 版（跟普通 MT5 的区别 + 给我的合作伙伴链接）',
    '2. 注册 Exness 模拟账户：用合作伙伴链接，VPN 注意事项',
    '3. 下载并安装 MT5 平台',
    '4. 登录交易账户：账号 / 密码 / 服务器名',
    '5. 装好后回到 EasyDeal 客户端「设置」标签页填入 terminal64.exe 所在目录',
    '',
    '所有链接、服务器名、路径都必须跟 README 完全一致。最后总结成 5 步检查清单方便我对照执行。',
  ].join('\n');
}

// (resolveEasydealScript was moved into electron/settings.js as detectEasydealScript)
