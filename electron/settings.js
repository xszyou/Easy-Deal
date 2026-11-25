// User settings — persisted to <userData>/data/settings.json. Schema:
//   {
//     mt5: { installDir, dataDir },
//     easydealScript,
//     pythonBin,
//   }
//
// Resolution rule: explicit user value > environment variable > auto-detected
// path. When nothing is found, the field stays null and the UI prompts the
// user to set it / install MT5.
//
// Auto-detection order (Windows; Mac/Linux falls through to common paths):
//   1. env vars (MT5_INSTALL_DIR / MT5_PATH / MT5_DATA_DIR)
//   2. running terminal64.exe process — read its ExecutablePath
//   3. registry HKCU\Software\MetaQuotes\Terminal\<id>\Path / DataPath
//   4. registry HKLM\Software\MetaQuotes\Terminal\<id>\Path / DataPath
//   5. common install paths under Program Files
// For data dir, after registry, fall back to scanning %APPDATA%\MetaQuotes\Terminal\

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const {
  inferLaunchMode,
  normalizeMt5Instance,
  validateMt5Instance,
} = require('./mt5-instance');

/**
 * Locate the bundled embeddable Python that ships with the app.
 *
 * Lookup order (first hit wins):
 *   1. <install>/resources/app.asar.unpacked/python-runtime/python.exe
 *      (packaged mode — `process.resourcesPath` always points at the
 *      install's resources dir, so this is the canonical location for
 *      asarUnpack'd files; we don't have to fight asar path rewriting)
 *   2. <repo>/python-runtime/python.exe   (dev mode running from source)
 *   3. null  → caller falls back to system `python` on PATH
 *
 * Result is logged once at first call so we can diagnose path issues
 * post-mortem from the user log without having to add extra prints.
 */
let _bundledPythonCached = undefined;
function _bundledPythonPath() {
  if (_bundledPythonCached !== undefined) return _bundledPythonCached;
  const exe = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
  const tried = [];
  // (1) Packaged: process.resourcesPath = <install>/resources
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-runtime', exe);
    tried.push(prodPath);
    if (fs.existsSync(prodPath)) {
      console.log('[settings] using bundled python (packaged):', prodPath);
      return (_bundledPythonCached = prodPath);
    }
    // 0.5.x 加固: packaged 模式下 prodPath 不存在 = bundled python.exe 被删
    // (实测被安全软件当病毒隔离/删除)。**绝不** fall-through 到下面的 __dirname/..
    // devPath —— packaged 下它解析进 app.asar, electron 让 existsSync 返 true 但
    // spawn 必 ENOENT (asar 内不是真实文件), 导致护航/账户/AI 全废且日志 ENOENT 刷屏、
    // 用户只看到「不可达」摸不着头脑。这里标记缺失路径(main.js 启动弹明确提示)+ 返 null,
    // 让上层退回 PATH('python') 或明确报错, 不再返回不可 spawn 的 asar 路径。
    //
    // 必须用 app.isPackaged 判定: dev 模式(`electron .`)下 process.resourcesPath 同样
    // 有值(node_modules/electron/dist/resources), 只看它会把 dev 误判成 packaged ——
    // 弹「Python 运行时缺失」+ 永远走不到下面的 devPath, sidecar 全落到 PATH 上的 python。
    let isPackaged = false;
    try { isPackaged = !!require('electron').app?.isPackaged; } catch {}
    if (isPackaged) {
      try { global.__pythonRuntimeMissingPath = prodPath; } catch {}
      console.error('[settings] PYTHON RUNTIME MISSING (packaged) — 可能被安全软件删除: ' + prodPath);
      return (_bundledPythonCached = null);
    }
  }
  // (2) Dev mode: <repo>/python-runtime/python.exe
  const devPath = path.resolve(__dirname, '..', 'python-runtime', exe);
  tried.push(devPath);
  if (fs.existsSync(devPath)) {
    console.log('[settings] using bundled python (dev):', devPath);
    return (_bundledPythonCached = devPath);
  }
  console.warn('[settings] bundled python NOT found, falling back to PATH. Tried:\n  ' + tried.join('\n  '));
  return (_bundledPythonCached = null);
}

const COMMON_MT5_INSTALL_PATHS = [
  // Standard windows install locations (matches both vanilla MT5 and
  // broker-rebranded distributions like Exness).
  'C:\\Program Files\\MetaTrader 5',
  'C:\\Program Files\\MetaTrader 5 EXNESS',
  'C:\\Program Files\\Exness MetaTrader 5',
  'C:\\Program Files (x86)\\MetaTrader 5',
  'C:\\Program Files (x86)\\MetaTrader 5 EXNESS',
];

class SettingsStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = path.join(dataDir, 'settings.json');
    this.data = {
      mt5: { installDir: null, dataDir: null },
      // 0.3.188: 多 MT5 实例支持. 老 settings.mt5 字段保留作 active instance
      // 的同步副本 (兼容大量读 settings.mt5.installDir 的老代码); 新 UI 走
      // mt5Instances 数组. 启动时 init() 会做一次性 migration: 如果 mt5Instances
      // 为空但 mt5.installDir 有值 → 把它建成 instance #1 + activeMt5InstanceId
      // 指向它.
      mt5Instances: [],          // [{ id, name, installDir, dataDir, createdAt, notes }]
      activeMt5InstanceId: null, // string id, 选哪个 instance 作为 active (老代码读 settings.mt5 时映射)
      easydealScript: null,
      pythonBin: null,
      windowCaptureScript: null,
      notifyAiAfterBacktest: false,
      licenseEnabled: false,  // off until the EasyDeal account server is live
      // ⚠ 危险开关：允许 AI 直接平仓 / 改单（修改止盈止损）。默认关 —
      // 关时 easydeal MCP 进程根本看不到 close_position / modify_position
      // 工具，Claude 无法发起这些动作。开启后才会注入
      // EASYDEAL_TRADING_WRITE=1 给 MCP，工具列表里会出现这两个工具。
      // 用户须知：开了之后 Claude 就能不经二次确认直接动你的实盘。
      tradingWriteEnabled: false,
      // 0.3.99: 开仓权限独立 toggle —— 开仓比平仓激进得多（凭空建仓的风险
      // 敞口比平仓大），用户经常想给 AI 平/改权限但不给开仓权限。EASYDEAL_TRADING_WRITE
      // 只控 close + modify；EASYDEAL_TRADING_WRITE_OPEN 控 open_position。
      // 默认关。AI 开仓成功后 Python 端会自动调 OrderGuard /enable 把这单
      // 注册到 `__ai_manual__` pseudo-EA，跟用户 EA 完全隔离地独立监控。
      tradingWriteOpenEnabled: false,
    };
    this.detected = {
      installDir: null, installDirSource: null,
      dataDir: null, dataDirSource: null,
      easydealScript: null,
      windowCaptureScript: null,
    };
    // Re-detection throttle. Detection runs once at startup; if MT5 wasn't
    // running yet (or it's a portable install in a non-standard path), the
    // result is null. Callers that NEED the path (strategy mount detection,
    // chart operations, etc.) call ensureDetected() which re-runs detection
    // when (a) any field is still null and (b) the last attempt is older
    // than RETRY_TTL_MS. Bounded so we don't hammer PowerShell every poll.
    this._lastDetectionAt = 0;
    this._inFlightDetection = null;
    // 自己写文件的时刻；watcher 在 500ms 内的 mtime 变化视作回声跳过。
    this._lastSelfWriteAt = 0;
    // 外部进程（easydeal-settings MCP）改 settings.json 时回调。main.js
    // 通过 setOnExternalChange 注一个广播器，把 settings:changed 推到所有
    // renderer，让设置页 UI 看到 Claude 改的东西（比如换了 MT5 路径）。
    this._onExternalChange = null;
  }

  async init() {
    // 0.3.286: 启动时备份 settings.json (rotate, 保留最近 3 份). 防 dataloss 类
    // 升级 bug 撞上时, 用户能从 .bak 一键恢复. 用户升级 2 次都撞 dataDir 错配,
    // 之前没备份只能手改 settings.json — 有备份后回滚一行命令.
    try {
      const orig = this.path;
      if (fs.existsSync(orig)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bakPath = `${orig}.bak-${ts}`;
        await fsp.copyFile(orig, bakPath);
        // rotate: 保留最近 3 份, 删更老的
        try {
          const dir = path.dirname(orig);
          const baseBak = path.basename(orig) + '.bak-';
          const files = (await fsp.readdir(dir))
            .filter((f) => f.startsWith(baseBak))
            .sort();
          while (files.length > 3) {
            const old = files.shift();
            try { await fsp.unlink(path.join(dir, old)); } catch {}
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[settings] startup backup failed (continuing):', e?.message || e);
    }
    // 0.3.265: 真根因 - 之前 catch{ } silent fallback 导致 dataloss 链:
    //   1) _save 非 atomic write → 半写损坏
    //   2) 下次启动 JSON.parse 抛 → 这里 silent catch → mt5Instances=[] (默认)
    //   3) 下面 migration 看到 [] + mt5.installDir 有值 → 生成 1 个默认实例
    //   4) 第一次 _save 把 1 个实例覆盖原 5 个 → 永久丢失
    // 用户 2026-05-24 15:10 撞过, 5 个 MT5 实例全丢只剩 1 个.
    //
    // 修法分 3 层:
    //   (a) ENOENT (file 真不存在 = 首装) → 走 default, 允许 migration
    //   (b) parse 失败 (文件损坏) → 把损坏文件 rename .corrupt-<ts> 留证, 加
    //       FATAL log, 设 _suspectDataloss=true → 让 migration 拒绝跑 +
    //       让 main.js 启动后弹 error dialog 让用户知道
    //   (c) parse OK → 正常
    let _firstInstall = false;
    this._suspectDataloss = false;
    try {
      const raw = await fsp.readFile(this.path, 'utf8');
      try {
        const j = JSON.parse(raw);
        this.data = deepMerge(this.data, j);
      } catch (parseErr) {
        // 文件存在但 JSON 损坏 = dataloss 危险信号. 不 silent fallback.
        this._suspectDataloss = true;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const corruptPath = `${this.path}.corrupt-${ts}`;
        try { await fsp.rename(this.path, corruptPath); } catch {}
        const msg = `[settings] FATAL: settings.json 损坏 (JSON parse 失败), `
          + `原文件已 rename → ${corruptPath}. parse error: ${parseErr?.message}. `
          + `**绝不**自动 migrate 防止 dataloss (5+ MT5 实例覆盖成 1 个).`;
        console.error(msg);
        // 写到 startup-trace 保 persist (console.log 在 packaged 模式下丢)
        try {
          const traceFile = path.join(this.dataDir, '..', 'startup-trace.log');
          fs.appendFileSync(traceFile, `[${new Date().toISOString()}] SETTINGS-CORRUPT :: ${msg}\n`);
        } catch {}
      }
    } catch (e) {
      if (e?.code === 'ENOENT') {
        _firstInstall = true;
      } else {
        // 其它 read error (权限 / 网络盘等) — 当损坏处理, 不冲数据
        this._suspectDataloss = true;
        console.error('[settings] FATAL: 读 settings.json 失败 (不是 ENOENT):', e?.message);
      }
    }
    if (!this._suspectDataloss && (this.data.backtestAccount || this.data.mt5?.backtestInstallDir)) {
      this.data.notifyAiAfterBacktest ||= !!this.data.backtestAccount?.notify_ai_for_optimization;
      delete this.data.backtestAccount;
      if (this.data.mt5) delete this.data.mt5.backtestInstallDir;
      try { await this._save(); }
      catch (e) { console.warn('[settings] wind tunnel migration:', e.message); }
    }
    this._firstInstall = _firstInstall;
    await this.refreshDetection();
    // Lifecycle v2 migration: make launch mode and stop intent explicit.
    // Never infer portable mode from MQL5/Config/Profiles: EasyDeal itself can
    // create those folders in a standard install and the old heuristic then
    // silently redirected MT5 to a different data world.
    try {
      const before = JSON.stringify(this.data.mt5Instances || []);
      this.data.mt5Instances = (this.data.mt5Instances || []).map(normalizeMt5Instance);
      if (JSON.stringify(this.data.mt5Instances) !== before) {
        console.log('[settings] migrated MT5 instances to lifecycle v2');
        await this._save();
      }
    } catch (e) {
      console.warn('[settings] MT5 lifecycle v2 migration failed:', e?.message || e);
    }
    // 0.3.337: 清掉老 settings.json 的 monitor 字段 (UI + env 注入都删了, 残留无用).
    // 安全做法: 只在 parse OK + 字段存在时 delete + 重新 save. 不影响其他字段.
    if (!this._suspectDataloss && this.data && Object.prototype.hasOwnProperty.call(this.data, 'monitor')) {
      try {
        delete this.data.monitor;
        await this._save();
        console.log('[settings] migration: 清掉老 monitor 字段 (0.3.337+ 不再用)');
      } catch (e) {
        console.warn('[settings] monitor 字段清理失败 (不阻塞):', e?.message || e);
      }
    }

    // 0.3.188: 多 MT5 实例 migration — 第一次升级把 mt5.installDir 迁到 mt5Instances[0]
    // 0.3.265: **CRITICAL** 只在首次安装 (file 真不存在) 才 migrate. parse 失败
    // 的 fallback 路径里**绝不**跑这条 — 否则 5+ 实例会被覆盖成 1 个 (dataloss).
    if (this._suspectDataloss) {
      console.warn('[settings] migration SKIPPED — _suspectDataloss=true (settings 损坏, 防 dataloss)');
    } else if (!this._firstInstall) {
      // file 存在 + parse OK + 没 mt5Instances → 用户真的没多实例, OK 不 migrate
      // (实际上 deepMerge 会从 default {} 继承空 mt5Instances=[], 不需要主动建)
    } else {
      try {
        if ((!this.data.mt5Instances || this.data.mt5Instances.length === 0)
            && this.data?.mt5?.installDir) {
          const inst = {
            id:         _genInstanceId(),
            name:       '默认实例',
            installDir: this.data.mt5.installDir,
            dataDir:    this.data.mt5.dataDir || null,
            launchMode: inferLaunchMode(this.data.mt5.installDir, this.data.mt5.dataDir),
            createdAt:  new Date().toISOString(),
            notes:      '从老 settings.mt5 自动迁移 (首装 migration)',
            user_intent: 'stopped',
            user_intent_at: new Date().toISOString(),
            lifecycle_version: 2,
          };
          this.data.mt5Instances = [inst];
          this.data.activeMt5InstanceId = inst.id;
          console.log(`[settings] migrated single mt5 to mt5Instances[0] id=${inst.id} (firstInstall=true)`);
          await this._save();
        }
      } catch (e) {
        console.warn('[settings] mt5Instances migration failed:', e?.message || e);
      }
    }
    this._startFileWatch();
  }

  // ---------------- 0.3.188: multi MT5 instance helpers ----------------

  /** 返回所有 instance (snapshot copy, 不要外部修改). */
  listMt5Instances() {
    return (this.data.mt5Instances || []).map((it) => normalizeMt5Instance(it));
  }

  /** 当前 active instance, 没有时返 null. */
  getActiveMt5Instance() {
    const id = this.data.activeMt5InstanceId;
    if (!id) return null;
    const found = (this.data.mt5Instances || []).find((it) => it.id === id);
    return found ? normalizeMt5Instance(found) : null;
  }

  /** 加新 instance, 自动生成 id. 返新 instance. 如果 active 还没设, 顺便设它为 active. */
  async addMt5Instance({ name, installDir, dataDir, notes, launchMode }) {
    const cleanInstallDir = String(installDir || '').trim() || null;
    const cleanDataDir = String(dataDir || '').trim() || null;
    const inst = {
      id:         _genInstanceId(),
      name:       String(name || '未命名实例').trim() || '未命名实例',
      installDir: cleanInstallDir,
      dataDir:    cleanDataDir,
      launchMode: inferLaunchMode(cleanInstallDir, cleanDataDir, launchMode),
      createdAt:  new Date().toISOString(),
      notes:      String(notes || '').trim() || '',
      // 0.3.207: user_intent 持久化 — 'running' / 'stopped'. 跨 EasyDeal 重启保留.
      // 「关闭 MT5」按钮设 stopped, 「启动 MT5」按钮设 running. 所有 mt5.initialize
      // 调用方先看 intent, intent=stopped 一律跳过. 新加的实例默认 running (用户
      // 新实例必须由用户显式点击启动；仅仅添加配置不能产生进程副作用。
      user_intent: 'stopped',
      user_intent_at: new Date().toISOString(),
      lifecycle_version: 2,
    };
    const checked = validateMt5Instance(inst, { siblings: this.data.mt5Instances || [] });
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    this.data.mt5Instances = [...(this.data.mt5Instances || []), inst];
    if (!this.data.activeMt5InstanceId) {
      this.data.activeMt5InstanceId = inst.id;
      // 同步老 mt5 字段 (兼容现有代码读 settings.mt5).
      this.data.mt5 = {
        ...(this.data.mt5 || {}),
        installDir: inst.installDir,
        dataDir: inst.dataDir,
      };
    }
    await this._save();
    return { ...inst };
  }

  /** 删除一个 instance. 如果是 active, 自动切到列表里第一个 (或者 null). */
  async removeMt5Instance(id) {
    const before = this.data.mt5Instances || [];
    this.data.mt5Instances = before.filter((it) => it.id !== id);
    if (this.data.activeMt5InstanceId === id) {
      this.data.activeMt5InstanceId = this.data.mt5Instances[0]?.id || null;
      const active = this.data.mt5Instances[0];
      this.data.mt5 = {
        ...(this.data.mt5 || {}),
        installDir: active ? active.installDir : null,
        dataDir:    active ? active.dataDir    : null,
      };
    }
    await this._save();
    return { removed: before.length - this.data.mt5Instances.length };
  }

  /** 改一个 instance 的字段. 路径变化时同步重算 launchMode. */
  async updateMt5Instance(id, patch) {
    const list = this.data.mt5Instances || [];
    const idx = list.findIndex((it) => it.id === id);
    if (idx < 0) throw new Error(`instance not found: ${id}`);
    if (patch.installDir !== undefined || patch.dataDir !== undefined || patch.launchMode !== undefined) {
      const merged = { ...list[idx], ...patch };
      // The current mode belongs to the current path pair.  When either path
      // changes and the caller did not explicitly choose a mode, derive it
      // from the new pair instead of validating against the stale old mode.
      if (patch.launchMode === undefined
          && (patch.installDir !== undefined || patch.dataDir !== undefined)) {
        merged.launchMode = null;
      }
      const candidate = normalizeMt5Instance(merged);
      const checked = validateMt5Instance(candidate, { siblings: list });
      if (!checked.ok) throw new Error(checked.errors.join('；'));
    }
    const allowed = ['name', 'installDir', 'dataDir', 'launchMode', 'notes', 'user_intent',
      'cached_account_login', 'cached_account_server', 'cached_account_at'];
    for (const k of allowed) {
      if (patch[k] !== undefined) list[idx][k] = patch[k];
    }
    if (patch.installDir !== undefined || patch.dataDir !== undefined || patch.launchMode !== undefined) {
      list[idx].installDir = String(list[idx].installDir || '').trim() || null;
      list[idx].dataDir = String(list[idx].dataDir || '').trim() || null;
      list[idx].launchMode = inferLaunchMode(list[idx].installDir, list[idx].dataDir, patch.launchMode);
      list[idx].lifecycle_version = 2;
    }
    // 0.3.207: intent 改了顺便更新 _at 时间戳
    if (patch.user_intent !== undefined) {
      list[idx].user_intent_at = new Date().toISOString();
    }
    // active 实例改了路径要同步 settings.mt5 兼容字段
    if (this.data.activeMt5InstanceId === id) {
      this.data.mt5 = {
        ...(this.data.mt5 || {}),
        installDir: list[idx].installDir,
        dataDir:    list[idx].dataDir,
      };
    }
    await this._save();
    return { ...list[idx] };
  }

  /** 切 active. 同步 settings.mt5 兼容字段. */
  async setActiveMt5Instance(id) {
    const inst = (this.data.mt5Instances || []).find((it) => it.id === id);
    if (!inst) throw new Error(`instance not found: ${id}`);
    this.data.activeMt5InstanceId = id;
    this.data.mt5 = {
      ...(this.data.mt5 || {}),
      installDir: inst.installDir,
      dataDir:    inst.dataDir,
    };
    await this._save();
    return { ...inst };
  }

  // 0.2.2 起：不再在 init() 里去主动改 user-set dataDir（那是「强制行给我修
  // 改了」的源头 —— 用户感知很差且没有 UI 通知）。改成 getResolved() 里
  // **静默判定** user-set 是不是 stale，stale 就把 detected.dataDir 顶上来；
  // settings.json 字段保留原值不动，下次用户在设置 UI 里手动改才落盘。
  //
  // stale 判据：dataDir/origin.txt 存在且内容 != installDir → 高置信度 stale。
  // origin.txt 不存在或不可读 → 不判 stale（可能是老版 MT5 / 权限问题）。
  // 不再用「installDir 下有 MQL5 文件夹」当 portable 信号 —— MQL5 子目录
  // 是 MT5 安装时自带的骨架，不论是否以 /portable 启动都存在，0.1.45 那条
  // 判据会误把"非 portable + MQL5 placeholder"的 install 判成 portable，把
  // 用户的合法 AppData hash dataDir 视为 stale 错清。
  _isUserSetDataDirStale() {
    const installDir = this.data?.mt5?.installDir;
    const dataDir = this.data?.mt5?.dataDir;
    if (!installDir || !dataDir) return false;
    const norm = (p) => String(p || '').replace(/[/\\]+$/, '').toLowerCase();
    try {
      const originPath = path.join(dataDir, 'origin.txt');
      if (!fs.existsSync(originPath)) return false;
      const buf = fs.readFileSync(originPath);
      const text = buf.toString('utf16le').replace(/^﻿/, '').trim();
      if (!text) return false;
      return norm(text) !== norm(installDir);
    } catch {
      return false;
    }
  }

  setOnExternalChange(cb) {
    this._onExternalChange = (typeof cb === 'function') ? cb : null;
  }

  _startFileWatch() {
    // 用 fs.watchFile 轮询而不是 fs.watch —— Windows 下 fs.watch 对 atomic
    // rename（os.replace）经常错过事件。轮询 2s 间隔够用，cheap。
    try {
      fs.watchFile(this.path, { interval: 2000, persistent: false }, async (curr, prev) => {
        if (!curr || curr.mtimeMs === 0) return;            // 文件不存在
        if (curr.mtimeMs <= (prev?.mtimeMs || 0)) return;   // 没变 / 倒退
        // 自己刚写过 → 跳过回声
        if (Date.now() - this._lastSelfWriteAt < 500) return;
        try {
          const raw = await fsp.readFile(this.path, 'utf8');
          const j = JSON.parse(raw);
          // 整体替换而不是 merge —— 外部进程（MCP）写的就是权威态，
          // 当前 in-memory 可能漏掉它新设的字段；merge 会保留旧值。
          const prevInstall = this.data?.mt5?.installDir;
          this.data = deepMerge({}, j);
          const newInstall = this.data?.mt5?.installDir;
          const newDataDir = this.data?.mt5?.dataDir;
          // Claude 改了 installDir 但没显式给 dataDir（例如 connect_mt5 命中
          // 非便携式安装时 _detect_data_dir 返回 None）—— 这里跑一次完整检测，
          // 用注册表 / appdata origin.txt 匹配补上 dataDir。下游 EA 徽章 /
          // 日志查询 / 回测才不会一片红。
          if (newInstall && newInstall !== prevInstall && !newDataDir) {
            try { await this.refreshDetection(); } catch {}
          }
          if (this._onExternalChange) {
            try { this._onExternalChange(this.getResolved()); } catch {}
          }
        } catch (e) {
          // 文件正在被外部进程半截写入 — 下个轮询周期再试。
        }
      });
    } catch (e) {
      console.warn('[settings] watchFile failed:', e?.message || e);
    }
  }

  async refreshDetection() {
    // 把已存的用户值传给 detectMt5InstallDir — 多开 MT5 场景下，多个 terminal64
    // 同时跑时优先选跟用户设值一致的那个；否则随机命中一个会跟 UI input 矛盾。
    const userSetPath = this.data?.mt5?.installDir || '';
    const installDirRes = await detectMt5InstallDir({ userSetPath });
    const installDir = installDirRes ? installDirRes.path : null;
    // Data directory detection must be authoritative.  Folder sniffing is
    // forbidden here: deploying an EA can create MQL5/Config/Profiles in a
    // standard installation and used to make us silently switch to /portable.
    let dataDirRes = null;
    // Prefer registry's DataPath because it is authoritative; otherwise match
    // AppData origin.txt.  Portable installs are registered explicitly when
    // downloaded or when the user selects installDir as dataDir.
    // 把 user 选的 install dir 传下去 — 多 MT5 场景下让注册表 / appdata 的
    // dataDir 匹配跟着这个 install 走，避免拿到隔壁实例的 dataDir。
    const dataDirHint = userSetPath || installDir || '';
    dataDirRes = await detectMt5DataDirFromRegistry({ installDir: dataDirHint });
    if (!dataDirRes) {
      const scanned = detectMt5DataDirFromAppData({ installDir: dataDirHint });
      if (scanned) dataDirRes = { path: scanned, source: 'appdata-scan' };
    }
    this.detected = {
      installDir,
      installDirSource: installDirRes?.source || null,
      dataDir: dataDirRes?.path || null,
      dataDirSource: dataDirRes?.source || null,
      easydealScript: detectEasydealScript(),
      windowCaptureScript: detectWindowCaptureScript(),
      // 多开场景：所有正在跑的 terminal 进程列表（pid + 完整路径）
      // UI 拿来对比用户设值跟当前运行的是否一致 + 警告
      runningMt5Processes: installDirRes?.runningProcesses || [],
    };
    this._lastDetectionAt = Date.now();
    return this.detected;
  }

  /**
   * On-demand detection refresh. Cheap to call repeatedly: returns the
   * already-detected values unless paths are still missing AND the last
   * attempt is stale. Used by IPCs (strategies:list, debug-mounts, etc.)
   * so a user starting MT5 after EasyDeal launch is picked up quickly
   * without manually configuring settings.
   *
   * @param {{maxAgeMs?: number}} opts maxAgeMs default 15s
   * @returns {Promise<object>} resolved settings (same shape as getResolved)
   */
  async ensureDetected({ maxAgeMs = 15_000 } = {}) {
    const r = this.getResolved();
    const haveAll = !!r.mt5.installDir && !!r.mt5.dataDir;
    const stale = Date.now() - this._lastDetectionAt > maxAgeMs;
    if (haveAll || !stale) return r;
    // Coalesce concurrent callers onto a single in-flight detection.
    if (!this._inFlightDetection) {
      this._inFlightDetection = this.refreshDetection()
        .finally(() => { this._inFlightDetection = null; });
    }
    try { await this._inFlightDetection; } catch {}
    return this.getResolved();
  }

  // Best-known values for each field (user-set > env > detected > null).
  // 例外：如果 user-set dataDir 是 stale 的（origin.txt 指向另一个 install），
  // 跳过它直接用 env / detected —— 不动 settings.json 字段，UI 上下游统一拿
  // effective 值。这样 EA mount 检测 / 回测 spawn 都能命中正确 dataDir。
  getResolved() {
    const userSetDataDirStale = this._isUserSetDataDirStale();
    return {
      mt5: {
        installDir: this.data.mt5.installDir
          || process.env.MT5_INSTALL_DIR
          || this.detected.installDir
          || null,
        dataDir: (userSetDataDirStale ? null : this.data.mt5.dataDir)
          || process.env.MT5_DATA_DIR
          || this.detected.dataDir
          || (userSetDataDirStale ? this.data.mt5.dataDir : null),  // 真没 detected → 兜底回 user-set，至少有个值
          // 注：user-set 视为 stale 时，effectiveDataDirOverridden = true（见下面 _meta），
          // UI 显示 effective 值的同时给个小提示「正在用自动检测的目录」。
      },
      easydealScript:
        this.data.easydealScript
        || process.env.EASYDEAL_MCP_SCRIPT
        || this.detected.easydealScript
        || null,
      pythonBin:
        this.data.pythonBin                 // explicit user setting wins
        || process.env.EASYDEAL_PYTHON      // env override (CI, dev)
        || _bundledPythonPath()             // shipped runtime — works on any machine, no system install needed
        || (process.platform === 'win32' ? 'python' : 'python3'),  // last resort: PATH lookup
      windowCaptureScript:
        this.data.windowCaptureScript
        || process.env.EASYDEAL_WINDOW_CAPTURE
        || this.detected.windowCaptureScript
        || null,
      licenseEnabled: this.data.licenseEnabled === true,
      notifyAiAfterBacktest: !!this.data.notifyAiAfterBacktest,
      // ⚠ 危险开关：是否允许 AI 直接平仓 / 改单。当 true 时
      // ensureWorkspace 会注 EASYDEAL_TRADING_WRITE=1 到 .mcp.json，
      // 让 easydeal MCP 暴露 close_position / modify_position。
      // 之前这字段漏在 getResolved 返回里，导致下游永远拿到 undefined
      // → 开关永远「实际关闭」。
      tradingWriteEnabled: !!this.data.tradingWriteEnabled,
      // 0.3.99: open_position 独立权限。注 EASYDEAL_TRADING_WRITE_OPEN=1，
      // 默认关。让用户可以「给 AI 平改权但不给开仓权」 — 平仓 / 改 SL 风险
      // 有限（最多损失既有持仓），开仓凭空建仓敞口完全不可控。
      tradingWriteOpenEnabled: !!this.data.tradingWriteOpenEnabled,
      // 0.3.337: 删掉「监控配置」UI + env 注入. 字段保留 (老 settings.json 兼容,
      // 不 throw), 但返空对象 — caller 不应再读. per-EA symbol/magic 走「我的策略」
      // 表 inline 编辑 + mounted-state.json 持久化, 全局 monitor 配置死路.
      monitor: {},
      // 0.3.99: aiRiskControl 字段保留兼容老 settings.json（不读不报错），
      // 但 UI 卡片已下线 —— OrderGuard 拦截模式 LLM 评估直接复用主 AI 通道
      // 的 spawn env（token-store.spawnEnvOverrides()）。这里返回空块给老 UI
      // 一个稳定形状，但 source 永远 'unified'，新版 UI 也不再读它。
      aiRiskControl: {
        anthropicApiKey: '',
        source: 'unified',
      },
      _meta: {
        detected: this.detected,
        userSet: { ...this.data },
      },
    };
  }

  async set(patch) {
    this.data = deepMerge(this.data, patch || {});
    await this._save();
    return this.getResolved();
  }

  async resetField(dottedKey) {
    const parts = dottedKey.split('.');
    let obj = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) return this.getResolved();
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = null;
    await this._save();
    return this.getResolved();
  }

  async _save() {
    // 0.3.265: dataloss fix — atomic write + backup current.
    // 之前直接 writeFile(this.path, ...) 一次性覆盖, 中断/断电 → 半写损坏 →
    // 下次启动 init parse 失败. 现在: 1) 备份 last-known-good 2) 写 .tmp +
    // fsync 3) rename atomic. 任一步失败保留 .bak-prev / .tmp 供诊断.
    await fsp.mkdir(this.dataDir, { recursive: true });
    const tmpPath = this.path + '.tmp';
    const bakPath = this.path + '.bak-prev';
    const body = JSON.stringify(this.data, null, 2);
    try {
      // backup current 作 last-known-good (file 不存在跳过, 不致命)
      try {
        if (fs.existsSync(this.path)) {
          await fsp.copyFile(this.path, bakPath);
        }
      } catch (bakErr) {
        console.warn('[settings] _save backup failed (non-fatal):', bakErr?.message);
      }
      // 写 tmp + fsync — Node fsp.open + fd.sync 保内容真落盘
      const fd = await fsp.open(tmpPath, 'w');
      try {
        await fd.writeFile(body, 'utf8');
        try { await fd.sync(); } catch { /* fsync 网盘 / 容器里偶尔不支持, 不致命 */ }
      } finally {
        await fd.close();
      }
      // atomic rename — Windows 同盘 rename atomic
      await fsp.rename(tmpPath, this.path);
    } catch (e) {
      console.error('[settings] _save FATAL:', e?.message,
        '— tmp 残留:', tmpPath, ', bak-prev:', bakPath);
      throw e;
    }
    // 标记是自己写的，watcher 跳过这次回声 —— 不然每次 settings:set 都会
    // 多触发一次 settings:changed 广播 + 全量 UI 重绘。
    this._lastSelfWriteAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// MT5 install dir detection
// ---------------------------------------------------------------------------

async function detectMt5InstallDir(opts = {}) {
  // userSetPath: 之前用户在设置里手动指定的安装目录 — 多开 MT5 场景下用于
  // 优先匹配（已经在跑的那批进程里有跟用户设值一致的就选它，避免跟用户
  // 期待相反）。
  const userSetPath = (opts.userSetPath || '').trim();
  let runningProcesses = [];
  // 1. env vars
  const env = process.env.MT5_INSTALL_DIR || process.env.MT5_PATH;
  if (env) {
    const dir = env.toLowerCase().endsWith('.exe') ? path.dirname(env) : env;
    if (hasTerminal(dir)) {
      // 提前拿一下 procs 让 UI 能展示运行实例
      try { runningProcesses = await detectAllRunningProcesses(); } catch {}
      return { path: dir, source: 'env', runningProcesses };
    }
  }
  // 2. running process (catches portable installs the registry won't know about)
  // 多开时拿全部 running terminal 路径（不只是 -First 1），优先选跟 userSetPath
  // 匹配的那个；都不匹配就取第一个但同时把 candidates 都附上让 UI 警告。
  if (process.platform === 'win32') {
    const procs = await detectAllRunningProcesses();
    runningProcesses = procs;
    // **关键**：tasklist 兜底返回的 procs `dir` 全是空字符串，不能拿来当
    // path 用 — 不然返回 path:'' 会让下游判定「没检测到」、dataDir
    // portable-mode fallback 也失效。先过滤一遍，只在有 dir 的（PowerShell
    // 源）procs 上选 pick；都没 dir 就让逻辑掉到 registry / common 路径。
    const realProcs = procs.filter((p) => p.dir);
    if (realProcs.length > 0) {
      let pick = realProcs[0];
      if (userSetPath) {
        const matched = realProcs.find((p) => _samePath(p.dir, userSetPath));
        if (matched) pick = matched;
      }
      return {
        path: pick.dir,
        source: 'process',
        runningProcesses: procs,  // 全部 running 实例 — 给 UI 用来对比 / 警告
      };
    }
  }
  // 3+4. registry
  if (process.platform === 'win32') {
    const fromReg = await detectFromRegistry();
    if (fromReg) {
      return {
        path: fromReg.installDir,
        source: `registry:${fromReg.hive}`,
        runningProcesses,
      };
    }
  }
  // 5. common install paths
  for (const candidate of COMMON_MT5_INSTALL_PATHS) {
    if (hasTerminal(candidate)) {
      return { path: candidate, source: 'common', runningProcesses };
    }
  }
  // 0.3.289: 5.5 APPDATA origin.txt 反推 — 用户 case (portable MT5 在 D:\mt5pinbar,
  // 不进注册表, 不在 Program Files, MT5 全关后 tasklist 也没). 但 APPDATA\MetaQuotes\
  // Terminal\<32hex>\origin.txt 仍持久存着 installDir 路径 (MT5 boot 时写). 扫所有
  // 32hex 目录 + 读 origin.txt + hasTerminal 检查 → 即便 MT5 全关也能找回 installDir.
  if (process.platform === 'win32') {
    const fromOrigin = detectMt5InstallDirFromAppDataOrigins();
    if (fromOrigin) {
      return { path: fromOrigin, source: 'appdata-origin', runningProcesses };
    }
  }
  // 6. 最后兜底 — 啥路径都拿不到但 tasklist 看到 MT5 在跑：返回 null path
  //    + 把 runningProcesses 透出去，UI 用「你设的路径」展示，redetect
  //    toast 也能区分「真没装」 vs「PS 被杀软拦但 MT5 确实在跑」。
  if (runningProcesses.length > 0) {
    return {
      path: null,
      source: 'tasklist_only',
      runningProcesses,
    };
  }
  return null;
}

// 0.3.188: 生成 MT5 instance id — `inst_` + 时间戳 + 4 字节随机 hex, 全 license 内唯一够用
function _genInstanceId() {
  const crypto = require('node:crypto');
  return `inst_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function _samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
  } catch { return false; }
}

function hasTerminal(dir) {
  try {
    return fs.existsSync(path.join(dir, 'terminal64.exe'))
        || fs.existsSync(path.join(dir, 'terminal.exe'));
  } catch { return false; }
}

// 拿所有正在跑的 MT5 进程列表。两条路：
//   1. PowerShell Get-Process — 拿得到 .Path（exe 完整路径），但**杀软**
//      经常拦（腾讯电脑管家 / 360 / 火绒对 PS 远程命令默认警惕高），
//      返回空 → 客户端误以为「MT5 没在跑」全套检测失效
//   2. CMD tasklist — 全用户态 fallback，杀软放行率高，但拿不到完整
//      exe 路径（只有 image name）
// 实际跑：PS 优先，PS 空就回退 tasklist。tasklist 路径下 exePath/dir
// 字段是空字符串 — 调用方仍能知道「至少有 N 个 MT5 在跑」，多 MT5 路径
// 匹配那条只能跳过。
async function detectAllRunningProcesses() {
  if (process.platform !== 'win32') return [];
  const ps = await _detectViaPowerShell().catch(() => []);
  if (ps.length > 0) return ps;
  const tl = await _detectViaTasklist().catch(() => []);
  return tl.map((p) => ({
    pid: p.pid,
    exePath: '',
    dir: '',
    _source: 'tasklist',
    _name: p.name,
  }));
}

function _detectViaPowerShell() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    cp.exec(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process terminal64,terminal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + \\"|\\" + $_.Path }"',
      { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const lines = (stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const procs = [];
        for (const line of lines) {
          const idx = line.indexOf('|');
          if (idx < 0) continue;
          const pid = parseInt(line.slice(0, idx), 10);
          const exePath = line.slice(idx + 1).trim();
          if (!exePath.toLowerCase().endsWith('.exe')) continue;
          try {
            procs.push({ pid, exePath, dir: path.dirname(exePath) });
          } catch {}
        }
        resolve(procs);
      },
    );
  });
}

// CMD tasklist fallback — 拿不到完整 exe 路径，但能看到「至少 N 个 MT5
// 进程在跑」。诊断专用，让 admin 区分「PowerShell 不工作」vs「MT5 真
// 没跑」。
function _detectViaTasklist() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    cp.exec(
      'tasklist /FO CSV /NH /FI "IMAGENAME eq terminal64.exe"',
      { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const procs = [];
        // CSV 行例：「"terminal64.exe","12345","Console","1","123,456 K"」
        for (const line of (stdout || '').split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)","([^"]*)","\d+","[^"]*"$/);
          if (!m) continue;
          const name = m[1];
          if (!/^terminal(64)?\.exe$/i.test(name)) continue;
          procs.push({
            name, pid: parseInt(m[2], 10), session: m[3],
          });
        }
        // 也试一下老 32 位名 terminal.exe
        cp.exec(
          'tasklist /FO CSV /NH /FI "IMAGENAME eq terminal.exe"',
          { timeout: 4000, windowsHide: true },
          (err2, stdout2) => {
            if (!err2) {
              for (const line of (stdout2 || '').split(/\r?\n/)) {
                const m = line.match(/^"([^"]+)","(\d+)","([^"]*)","\d+","[^"]*"$/);
                if (!m) continue;
                if (!/^terminal\.exe$/i.test(m[1])) continue;
                procs.push({
                  name: m[1], pid: parseInt(m[2], 10), session: m[3],
                });
              }
            }
            resolve(procs);
          },
        );
      },
    );
  });
}

/**
 * 给诊断快照用：同时跑 PowerShell + tasklist，返回两路结果对比。让 admin
 * 看到「PowerShell 看到 N 个 / tasklist 看到 M 个」 — 不一致就明显是
 * PowerShell 路径有问题（杀软 / ExecutionPolicy / 等）。
 */
async function detectAllRunningProcessesDetailed() {
  if (process.platform !== 'win32') {
    return { powershell: [], tasklist: [] };
  }
  const [ps, tl] = await Promise.all([
    _detectViaPowerShell().catch(() => []),
    _detectViaTasklist().catch(() => []),
  ]);
  return { powershell: ps, tasklist: tl };
}

// Walk HKCU then HKLM under Software\MetaQuotes\Terminal\<32hex>\Path.
// Returns { installDir, dataDir, hive } for the matching record.
//
// opts.installDir: 多 MT5 场景下用户已经选了哪个 install dir —— 注册表里有
// 多个 32hex 项时优先返回 Path 跟它一致的那条；找不到匹配的就回退到第一条
// 「随便一个能用的」。
function detectFromRegistry(opts = {}) {
  const wantInstall = (opts.installDir || '').replace(/[/\\]+$/, '').toLowerCase();
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const tryHive = (hive) => new Promise((r) => {
      cp.exec(
        `reg query "${hive}\\Software\\MetaQuotes\\Terminal" /s`,
        { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return r(null);
          const blocks = ('\n' + (stdout || '')).split(/\r?\n(?=HKEY_)/);
          let firstAny = null;
          for (const block of blocks) {
            if (!/Terminal\\[0-9A-F]{32}/i.test(block)) continue;
            const pathMatch = block.match(/^\s*Path\s+REG_SZ\s+(.+?)\s*$/m);
            const dataMatch = block.match(/^\s*DataPath\s+REG_SZ\s+(.+?)\s*$/m);
            const installDir = pathMatch ? pathMatch[1].trim() : null;
            const dataDir = dataMatch ? dataMatch[1].trim() : null;
            if (!installDir || !hasTerminal(installDir)) continue;
            const rec = { installDir, dataDir, hive };
            if (wantInstall &&
                installDir.replace(/[/\\]+$/, '').toLowerCase() === wantInstall) {
              return r(rec);   // exact match — ship it
            }
            if (!firstAny) firstAny = rec;
          }
          // No exact match: only use firstAny if caller didn't pin an install dir.
          // 用户指定了 install dir 但注册表里没匹配的项 —— 不要瞎给个别的 MT5
          // 的 dataDir，会导致左上角 EA 徽章 / 日志 / 回测全错。
          r(wantInstall ? null : firstAny);
        },
      );
    });
    Promise.resolve()
      .then(() => tryHive('HKCU'))
      .then((v) => v || tryHive('HKLM'))
      .then((v) => resolve(v));
  });
}

// ---------------------------------------------------------------------------
// MT5 data dir detection
// ---------------------------------------------------------------------------

async function detectMt5DataDirFromRegistry(opts = {}) {
  const fromReg = await detectFromRegistry({ installDir: opts.installDir });
  if (fromReg && fromReg.dataDir) {
    try {
      if (fs.existsSync(path.join(fromReg.dataDir, 'MQL5'))) {
        return { path: fromReg.dataDir, source: `registry:${fromReg.hive}` };
      }
    } catch {}
  }
  return null;
}

// Fallback: scan %APPDATA%\MetaQuotes\Terminal\<32-hex>.
//
// MT5 在每个 instance 目录下放一个 ``origin.txt``（utf-16-le BOM + 安装目录
// 的绝对路径）。如果 caller 给了 installDir，我们优先匹配 origin.txt 内容
// 一致的那条；否则回退到 mtime-most-recent。
//
// 多开 MT5 时这条匹配很关键 —— 用户切到 EXNESS 副本后，原版 MT5 的
// dataDir 仍然可能是 mtime-most-recent，错配会让 EA 徽章 / 日志查询全跪。
function detectMt5DataDirFromAppData(opts = {}) {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const base = path.join(appdata, 'MetaQuotes', 'Terminal');
  const wantInstall = (opts.installDir || '').replace(/[/\\]+$/, '').toLowerCase();
  try {
    const entries = fs.readdirSync(base);
    const candidates = entries
      .filter((e) => /^[0-9A-F]{32}$/i.test(e))
      .map((e) => {
        const p = path.join(base, e);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch {}
        return { path: p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (wantInstall) {
      // 找 origin.txt 跟用户 install dir 一致的那条
      for (const c of candidates) {
        try {
          const originPath = path.join(c.path, 'origin.txt');
          if (!fs.existsSync(originPath)) continue;
          const buf = fs.readFileSync(originPath);
          // origin.txt 是 utf-16-le 带 BOM；node 没有原生 'utf16le-bom' 解码 ——
          // 直接 utf16le 解码后剥 ﻿ 就行。
          const text = buf.toString('utf16le').replace(/^﻿/, '').trim();
          if (text.replace(/[/\\]+$/, '').toLowerCase() === wantInstall) {
            return c.path;
          }
        } catch {}
      }
      // 用户指定了 installDir 但没匹配到 origin.txt —— 不要瞎给一个别的，
      // 错的 dataDir 比 null 更糟（左上角徽章 / 日志查询 / 回测会拿错的 broker）
      return null;
    }
    if (candidates.length) return candidates[0].path;
  } catch { /* base dir missing */ }
  return null;
}

// 0.3.289: 反推 — 扫 %APPDATA%\MetaQuotes\Terminal\<32hex>\origin.txt 提取 installDir,
// 挑第一个 hasTerminal 的. 用于 detectMt5InstallDir 最后兜底:
//   - 用户 portable 装 MT5 在 D:\xxx (不进注册表 / 不在 Program Files / MT5 已关掉
//     tasklist 也扫不到), 但 origin.txt 持久存着 installDir 路径
//   - 多 MT5 用户: 拿 mtime 最新的那个 (用户最近用过的副本)
//
// 返 string | null. 全文件 IO 同步, 一般 <50ms (10 个 32hex 目录 × 1 个小文件读).
function detectMt5InstallDirFromAppDataOrigins() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const base = path.join(appdata, 'MetaQuotes', 'Terminal');
  try {
    const entries = fs.readdirSync(base);
    const candidates = entries
      .filter((e) => /^[0-9A-F]{32}$/i.test(e))
      .map((e) => {
        const p = path.join(base, e);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch {}
        return { dataDir: p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      try {
        const originPath = path.join(c.dataDir, 'origin.txt');
        if (!fs.existsSync(originPath)) continue;
        const buf = fs.readFileSync(originPath);
        // utf16le BOM (origin.txt 是 MT5 写的, 用 utf-16-le)
        const installDir = buf.toString('utf16le').replace(/^﻿/, '').trim().replace(/[/\\]+$/, '');
        if (installDir && hasTerminal(installDir)) {
          return installDir;
        }
      } catch {}
    }
  } catch { /* base dir missing */ }
  return null;
}

// ---------------------------------------------------------------------------
// EasyDeal MCP script detection (unchanged from before)
// ---------------------------------------------------------------------------

function detectEasydealScript() {
  // Lookup order:
  //   1. Bundled with this client (python/easydeal_mcp_server.py) — preferred,
  //      ships with the app so users never need to clone the easy-deal repo.
  //      Uses process.resourcesPath in packaged mode (asar.unpacked) — same
  //      pattern as detectWindowCaptureScript() / _bundledPythonPath().
  //   2. Sibling easy-deal/ source repo (dev mode only — for contributors
  //      developing the script).
  //   3. ~/easy-deal/easydeal_mcp_server.py (legacy install location).
  const subPath = ['python', 'easydeal_mcp_server.py'];
  if (process.resourcesPath) {
    const prod = path.join(process.resourcesPath, 'app.asar.unpacked', ...subPath);
    if (_safeExists(prod)) return prod;
  }
  const devBundled = path.resolve(__dirname, '..', ...subPath);
  if (_safeExists(devBundled)) return devBundled;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'easy-deal', 'easydeal_mcp_server.py'),
    path.join(require('os').homedir(), 'easy-deal', 'easydeal_mcp_server.py'),
  ];
  for (const c of candidates) {
    if (_safeExists(c)) return c;
  }
  return null;
}

function _safeExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// Locate the window_capture MCP server. Order:
//   1. Bundled with this client (python/window_capture/server.py) — preferred,
//      ships with the app so users don't need Fay installed.
//   2. Fay's distributed copy under common install roots — fallback for
//      users who already use Fay.
function detectWindowCaptureScript() {
  // 1. Bundled — must use process.resourcesPath in packaged mode so
  // child processes can actually open the file (asar virtual paths
  // aren't readable by spawn'd subprocesses).
  const bundledParts = ['python', 'window_capture', 'server.py'];
  if (process.resourcesPath) {
    const prod = path.join(process.resourcesPath, 'app.asar.unpacked', ...bundledParts);
    try { if (fs.existsSync(prod)) return prod; } catch {}
  }
  const bundled = path.resolve(__dirname, '..', ...bundledParts);
  try { if (fs.existsSync(bundled)) return bundled; } catch {}

  // 2. Fay fallback
  const subPath = path.join('dist', 'fay', 'mcp_servers', 'window_capture', 'server.py');
  const candidates = [
    'D:\\GitHub\\Fay',
    'D:\\Projects\\Fay',
    'C:\\Fay',
    path.join(require('os').homedir(), 'Fay'),
    path.join(require('os').homedir(), 'GitHub', 'Fay'),
  ];
  for (const root of candidates) {
    const full = path.join(root, subPath);
    try { if (fs.existsSync(full)) return full; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = Array.isArray(target) ? target.slice() : { ...(target || {}) };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      out[k] = deepMerge(out[k] || {}, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

module.exports = { SettingsStore, detectAllRunningProcessesDetailed, hasTerminal };
