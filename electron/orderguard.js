// OrderGuard — Electron-side lifecycle manager.
//
// Spawns python/orderguard_server.py as a long-lived child process,
// monitors health, and exposes IPC handlers for the renderer.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// 0.3.65: 9527 在中文 Windows 上常被 WUDFHost.exe（系统驱动 host）占住，硬绑
// 会让 Flask 启动看似成功但 client 拿到非 HTTP 响应 → "Parse Error: Expected HTTP/"。
// Python 端启动时遍历候选端口选第一个能 bind 的，写到 PORT_FILE，Node 读它。
//
// 0.3.191 Phase 3: 多实例 OrderGuard pool 用 — 每个 MT5 实例 spawn 一个独立
// OrderGuard 进程, 各自候选端口段错开, 避免抢端口. 主实例用基础段, N>0 的实例
// 用 base + N*100 偏移 (10 个候选端口够任何环境).
const PORT_CANDIDATES = [19527, 28737, 35279, 47139, 51827];
const DEFAULT_PORT = PORT_CANDIDATES[0];

function computePortCandidatesForInstance(offset) {
  // offset=0 → 默认段, offset=N → 每个候选端口 + N*100
  // 同时打散到不同范围, 避免「都加 100」撞同款占用
  if (!offset || offset <= 0) return PORT_CANDIDATES;
  return PORT_CANDIDATES.map((p) => p + offset * 100);
}

class OrderGuard {
  /**
   * @param {object} opts
   * @param {string} opts.pythonBin     Path to python executable (用 bundled python-runtime；有 MetaTrader5 模块)
   * @param {string} opts.scriptPath    Path to orderguard_server.py
   * @param {string} opts.userDataDir   Path to Electron userData dir
   * @param {string} [opts.mt5InstallDir] MT5 install dir，OrderGuard 监控模式用它 mt5.initialize() attach
   * @param {string} [opts.mqhSourcePath] OrderGuard.mqh 源文件路径（app 包内 mql5/OrderGuard.mqh），拦截模式 deploy 用
   * @param {Function} [opts.log]       Logger function
   * @param {string} [opts.instanceId]    0.3.191 Phase 3: MT5 实例 ID. null = 单实例 legacy 模式
   * @param {string} [opts.instanceName]  实例名 (展示用)
   * @param {number} [opts.poolIndex]     实例在 pool 里的 0-based 序号 (端口偏移用)
   * @param {string} [opts.dbFileName]    overload 默认 'orderguard.db' (多实例用 'orderguard-<id>.db')
   * @param {string} [opts.portFileName]  overload 默认 'orderguard.port'
   * @param {number[]} [opts.portCandidates] overload 默认端口段 (多实例用偏移段)
   */
  constructor({ pythonBin, scriptPath, userDataDir, mt5InstallDir, mt5DataDir, mt5LaunchMode, mqhSourcePath,
                 sessionTokenProvider, serverBaseUrl, log,
                 instanceId, instanceName, poolIndex,
                 dbFileName, portFileName, portCandidates }) {
    this.pythonBin = pythonBin || 'python';
    this.scriptPath = scriptPath;
    this.userDataDir = userDataDir;
    this.mt5InstallDir = mt5InstallDir || '';
    // 1.5.1 多实例修复: OG 也要知道本实例的 dataDir —— 光有 installDir 时无法区分
    // 共享同一安装目录的多个账户实例, 且 portable 判定只嗅目录结构会误判(实盘非便携
    // 装被 EasyDeal 部署 .ex5 后凑齐三目录→误判便携→SDK 落错数据目录/连带拉起)。
    this.mt5DataDir = mt5DataDir || '';
    this.mt5LaunchMode = mt5LaunchMode || '';
    this.mqhSourcePath = mqhSourcePath || '';
    this.sessionTokenProvider = sessionTokenProvider || (() => '');
    this.serverBaseUrl = (serverBaseUrl || 'https://easydeal.fay-agent.com').replace(/\/$/, '');

    // 0.3.191 Phase 3: 多实例支持
    this.instanceId = instanceId || null;
    this.instanceName = instanceName || (instanceId ? `inst-${String(instanceId).slice(0, 8)}` : 'default');
    this.poolIndex = Number.isFinite(poolIndex) ? poolIndex : 0;
    this.dbFileName = dbFileName || (instanceId ? `orderguard-${this._sanitizeIdForFile(instanceId)}.db` : 'orderguard.db');
    this.portFileName = portFileName || (instanceId ? `orderguard-${this._sanitizeIdForFile(instanceId)}.port` : 'orderguard.port');
    this.portCandidates = portCandidates || computePortCandidatesForInstance(this.poolIndex);

    const logPrefix = instanceId ? `[orderguard:${this.instanceName}]` : '[orderguard]';
    const userLog = log || ((m) => console.log(logPrefix, m));
    this.log = (m) => userLog(m);

    this.child = null;
    this.port = this.portCandidates[0];
    this.running = false;
    this._healthTimer = null;
    this._lastHealth = null;
    this._portFile  = null;          // set in start()
  }

  /** 把 instance_id (含下划线/字母数字) 缩短到 8 字符当文件名后缀, 避免 path 太长. */
  _sanitizeIdForFile(id) {
    return String(id || 'x').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'x';
  }

  /** Start the OrderGuard server process. */
  async start() {
    if (this.child) {
      this.log('already running, skip start');
      return;
    }

    const dbPath = path.join(this.userDataDir, 'data', this.dbFileName);
    this._portFile  = path.join(this.userDataDir, 'data', this.portFileName);
    // 启动前清掉旧 port file，避免读到上次的脏数据
    try { fs.unlinkSync(this._portFile); } catch {}

    const env = {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      EASYDEAL_ORDERGUARD_DB: dbPath,
      // 0.3.191 Phase 3: 多实例 — Python 端读这俩做端口选择 + log 前缀
      EASYDEAL_ORDERGUARD_PORT_FILE: this._portFile,
      EASYDEAL_ORDERGUARD_PORT_CANDIDATES: this.portCandidates.join(','),
      EASYDEAL_ORDERGUARD_INSTANCE_ID: this.instanceId || '',
      EASYDEAL_ORDERGUARD_INSTANCE_NAME: this.instanceName || '',
      // 不再传死 PORT — Python 自己挑可用的然后写 port file
      // 0.4.10: copy-trade follower 用 — Python SSE consumer 读这俩拼 server URL
      EASYDEAL_API_URL: this.serverBaseUrl,
      EASYDEAL_USER_DATA_DIR: this.userDataDir,
      EASYDEAL_MT5_ALLOW_LAUNCH: '0',
      // 0.3.141: 让 OrderGuard 读 <workspace>/.easydeal-ea-monitor.json 反推 EA 名
      // (用户填了 magic 但没显式点「启用护航」按钮场景下「在跑订单」也能显对 EA)
      EASYDEAL_WORKSPACE_DIR: path.join(this.userDataDir, 'workspace'),
      // 消息面护航: 主进程 news-provider 每 30s 写的金十快讯缓存 (/news-gate 喂给 LLM)
      EASYDEAL_NEWS_BUFFER_FILE: path.join(this.userDataDir, 'data', 'news-buffer.json'),
    };
    // 0.3.64: 监控模式需要 mt5.initialize() attach 到指定 MT5 实例
    if (this.mt5InstallDir) {
      env.EASYDEAL_MT5_INSTALL_DIR = this.mt5InstallDir;
    }
    // 1.5.1: 把本实例 dataDir 也透进去 — OG 据此 (a) 做 dataDir 感知的 portable 判定
    // (跟 Node launchMt5 一致), (b) 多实例共享 installDir 时按 dataDir 精确认领"自己的"
    // terminal, 不再连带把别的实例 init 拉起。
    if (this.mt5DataDir) {
      env.EASYDEAL_MT5_DATA_DIR = this.mt5DataDir;
    }
    if (this.mt5LaunchMode) {
      env.EASYDEAL_MT5_LAUNCH_MODE = this.mt5LaunchMode;
    }
    // 0.4.10: 把当前 session token 透进去（启动时的 snapshot，token 轮换后
    // 仍 OK —— Python 端 _get_session_token 会优先读 EASYDEAL_USER_DATA_DIR/session.json
    // fallback）。注意：登录态变化时 OrderGuard 进程不会自动重启读新 token；
    // 这是一个已知 limitation，用户登出/换号 → 重启客户端才能让 follower SSE 连到新身份。
    try {
      const tok = this.sessionTokenProvider() || '';
      if (tok) env.EASYDEAL_SESSION_TOKEN = tok;
    } catch (e) {
      this.log(`[token] sessionTokenProvider raised: ${e.message}`);
    }
    // 0.3.99: 拦截模式 LLM 评估走主 AI 通道 —— 从 token-store 拿 spawn env
    // overrides（Fay 模式拿 cached_token / Fay 代理 URL / Fay 模型；custom 模式
    // 拿用户填的 ANTHROPIC_*；system 模式空 env）。Python 端 _call_anthropic_llm
    // 读这些 env，跟 chat / scheduler spawn 路径用同款凭据。custom/codex/fay 模式
    // 同时剥掉 process.env 里 OS 配的 ANTHROPIC_*，避免被 OS 旧 key hijack。
    let tokenEnv = {};
    let stripKeys = [];
    try {
      const ts = require('./_token-accessor').get();
      if (ts) {
        const o = ts.spawnEnvOverrides() || {};
        tokenEnv = o.env || {};
        stripKeys = ts.envKeysToStripBeforeSpawn() || [];
        // 0.3.244: custom protocol='openai' — placeholder 替换成真实本地代理 URL
        if (String(tokenEnv.ANTHROPIC_BASE_URL || '').startsWith('__EASYDEAL_')) {
          try {
            await ts.ensureLocalBridgeAndReplace(tokenEnv);
            this.log(`[token] 本地 AI 桥接已启动 → ${tokenEnv.ANTHROPIC_BASE_URL}`);
          } catch (e) {
            this.log(`[token] 本地 AI 桥接启动失败 (${e.message}) — AI 评估走 stub`);
            tokenEnv = {};
          }
        }
        if (o.warning) {
          this.log(`[token] ${o.warning} — AI 评估走 stub`);
        } else if (Object.keys(tokenEnv).length) {
          this.log(`[token] mode=${o.mode} — 注入 ${Object.keys(tokenEnv).filter(k => k.startsWith('ANTHROPIC_')).join(', ')}`);
        } else {
          this.log('[token] mode=system — 无 override，Python 端读 OS ANTHROPIC_API_KEY 或回退 stub');
        }
      }
    } catch (e) {
      this.log(`[token] accessor 不可用 (${e.message}) — AI 评估走 stub`);
    }

    this.log(`spawning: ${this.pythonBin} ${this.scriptPath}`);
    this.log(`  DB: ${dbPath}, PORT: ${this.port}`);

    const baseEnv = { ...process.env };
    for (const k of stripKeys) delete baseEnv[k];

    this.child = spawn(this.pythonBin, [this.scriptPath], {
      cwd: path.dirname(this.scriptPath),
      env: { ...baseEnv, ...tokenEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      // MCP stdio traffic on stdout — don't log by default (noisy)
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) this.log(`[py:stderr] ${line}`);
      }
    });

    this.child.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this.child = null;
      this.running = false;
    });

    this.child.on('exit', (code, signal) => {
      this.log(`exited code=${code} signal=${signal}`);
      this.child = null;
      this.running = false;
      this._stopHealthCheck();
    });

    // Wait for HTTP server to be ready (poll /health)
    const started = await this._waitForHealth(10_000);
    if (started) {
      this.running = true;
      this.log(`HTTP server ready on port ${this.port}`);
      this._syncPortFileToMt5();
      this._startHealthCheck();
    } else {
      this.log('HTTP server did not become ready in time');
    }
  }

  /** Stop the OrderGuard server process. */
  async stop({ timeoutMs = 3000 } = {}) {
    this._stopHealthCheck();
    if (!this.child) return;

    this.log('stopping...');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log('force killing (timeout)');
        try { this.child.kill('SIGKILL'); } catch {}
        this.child = null;
        this.running = false;
        resolve();
      }, timeoutMs);

      this.child.on('exit', () => {
        clearTimeout(timer);
        this.child = null;
        this.running = false;
        this.log('stopped');
        resolve();
      });

      try { this.child.kill('SIGTERM'); } catch {}
    });
  }

  /** Check if the HTTP server is healthy. */
  async healthCheck() {
    return this._httpGet('/health');
  }

  /** Get OrderGuard status via HTTP. */
  async getStatus() {
    return this._httpGet('/status');
  }

  /** Get stats via HTTP. */
  async getStats(ea, intent) {
    let qs = '';
    const params = [];
    if (ea) params.push(`ea=${encodeURIComponent(ea)}`);
    if (intent) params.push(`intent=${encodeURIComponent(intent)}`);
    if (params.length) qs = '?' + params.join('&');
    return this._httpGet(`/stats${qs}`);
  }

  /** 0.3.64: 在跑订单 + 每个 position 的 guard decision 详情。
   *  护航专栏「在跑订单」面板用。 */
  async getPositions() {
    return this._httpGet('/positions');
  }

  /** 0.3.64: 最近 N 条决策记录。
   *  护航专栏「24h 决策日志」面板用。 */
  async getDecisions({ ea, limit = 100, since } = {}) {
    let qs = '';
    const params = [];
    if (ea)    params.push(`ea=${encodeURIComponent(ea)}`);
    if (limit) params.push(`limit=${limit}`);
    if (since) params.push(`since=${encodeURIComponent(since)}`);
    if (params.length) qs = '?' + params.join('&');
    return this._httpGet(`/decisions${qs}`);
  }

  /** 0.3.64: 已启用护航的 EA 清单。 */
  async getEnabledEas() {
    return this._httpGet('/enabled-eas');
  }

  /** 0.3.64: 全局战绩聚合，护航专栏顶部面板用。 */
  async getOverviewStats() {
    return this._httpGet('/overview-stats');
  }

  /** 0.3.141: 让「⟳ 刷新」按钮强制 tracker 立即 poll —— 拿 0s 新数据，
   *  不是用 5s old cache。 */
  async forcePoll() {
    return this._httpPost('/force-poll', {});
  }

  /** 0.3.141: 显示「累计盈亏」组成 — 已平仓订单明细 */
  async getClosedOrders(limit = 50) {
    return this._httpGet(`/closed-orders?limit=${limit}`);
  }

  /** 0.3.141: 一键重置某 EA 的 anchor 到 now，清零统计 / 决策日志显示 */
  async resetAnchor(eaName) {
    return this._httpPost('/reset-anchor', { ea_name: eaName });
  }

  /** 0.3.64: 启用某 EA 的护航。
   *  @param {string} eaName
   *  @param {number} magic — 必传，让 monitor 模式能用 magic 把 deal 归属到该 EA
   *  @param {string} mode  - 'observe'（默认，监控模式）/ 'enforce'（拦截模式）
   */
  // 0.3.151 step 3: 拉还没推送微信的告警
  async getAlertsPending(limit = 20) {
    return this._httpGet(`/alerts/pending?limit=${limit}`);
  }

  // 0.3.151 step 3: 标记 alerts 已推过微信
  async markAlertsNotified(decisionIds) {
    return this._httpPost('/alerts/mark-notified', { decision_ids: decisionIds || [] });
  }

  async enableEa(eaName, magic, mode = 'observe', thresholds = null) {
    // 0.3.151 step 2: thresholds (单笔浮亏/持仓时长/整体浮亏/锁仓) per-EA 同步到 OG
    const body = { ea_name: eaName, magic, mode };
    if (thresholds) body.thresholds = thresholds;
    return this._httpPost('/enable', body);
  }

  async disableEa(eaName) {
    return this._httpPost('/disable', { ea_name: eaName });
  }

  /** 0.3.66 P1-A: 拉一份 fast rules JSON（用于离线 fallback / deploy 到 MT5/MQL5/Files/）。 */
  async getLocalRules(eaName) {
    return this._httpGet(`/local-rules?ea=${encodeURIComponent(eaName)}`);
  }

  /** 1.0.8: UI 直接开关 per-EA 拦截规则（平仓拦截 / 改单拦 SL 外扩）。
   *  key 形如 'fast_rules.close_guard.enabled' / 'fast_rules.modify_guard.block_sl_widen'。 */
  async setGuardRule(eaName, key, value) {
    return this._httpPost('/set-guard-rule', { ea_name: eaName, key, value });
  }

  // 0.3.74 P3 学习中心 ---
  /** 列出规则建议。status: pending(默认) / applied / dismissed / rolled_back / all */
  async getRuleSuggestions({ ea, status = 'pending', limit = 100 } = {}) {
    const params = [];
    if (ea)     params.push(`ea=${encodeURIComponent(ea)}`);
    if (status) params.push(`status=${encodeURIComponent(status)}`);
    if (limit)  params.push(`limit=${limit}`);
    const qs = params.length ? '?' + params.join('&') : '';
    return this._httpGet(`/rule-suggestions${qs}`);
  }
  async applyRuleSuggestion(id) {
    return this._httpPost(`/rule-suggestions/${encodeURIComponent(id)}/apply`, {});
  }
  async dismissRuleSuggestion(id) {
    return this._httpPost(`/rule-suggestions/${encodeURIComponent(id)}/dismiss`, {});
  }
  async rollbackRuleSuggestion(id) {
    return this._httpPost(`/rule-suggestions/${encodeURIComponent(id)}/rollback`, {});
  }
  async scanRuleSuggestionsNow(eaName) {
    return this._httpPost('/rule-suggestions/scan-now', eaName ? { ea_name: eaName } : {});
  }
  /** 0.3.75: AI 校准统计 — confidence vs 实际 win_rate 分桶 */
  async aiAccuracy(eaName) {
    const qs = eaName ? `?ea=${encodeURIComponent(eaName)}` : '';
    return this._httpGet(`/ai-accuracy${qs}`);
  }

  /** 0.3.67 (was P1-A): 启用拦截模式时同步部署。
   *  - copy <appMql5>/OrderGuard.mqh → <mt5DataDir>/MQL5/Include/OrderGuard.mqh
   *  - copy <userData>/data/orderguard.port  → <mt5DataDir>/MQL5/Files/OrderGuard/orderguard.port
   *  - fetch /local-rules?ea=<X>             → <mt5DataDir>/MQL5/Files/OrderGuard/<ea>.rules.json
   *
   *  0.3.67 改动：去掉 token 部署 — 服务 bind 127.0.0.1 外部进程无法访问，token 是多余的复杂度。
   *  返回 { ok, deployed: [...], errors: [...] }
   */
  async deployIntercept(eaName, mt5DataDir) {
    if (!eaName) return { ok: false, error: 'eaName required' };
    if (!mt5DataDir) return { ok: false, error: 'mt5DataDir required — 请先在「设置」里配 MT5 数据目录' };

    const result = { ok: true, deployed: [], errors: [] };
    const includeDir = path.join(mt5DataDir, 'MQL5', 'Include');
    const ogFilesDir = path.join(mt5DataDir, 'MQL5', 'Files', 'OrderGuard');

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(ogFilesDir, { recursive: true });
    } catch (e) {
      return { ok: false, error: `mkdir failed: ${e.message}` };
    }

    // 1) mqh
    if (this.mqhSourcePath && fs.existsSync(this.mqhSourcePath)) {
      const dst = path.join(includeDir, 'OrderGuard.mqh');
      try {
        fs.copyFileSync(this.mqhSourcePath, dst);
        result.deployed.push({ kind: 'mqh', path: dst });
      } catch (e) {
        result.errors.push(`copy mqh failed: ${e.message}`);
      }
    } else {
      result.errors.push(`mqh source not found at ${this.mqhSourcePath}`);
    }

    // 2) port file
    try {
      if (this._portFile && fs.existsSync(this._portFile)) {
        const dst = path.join(ogFilesDir, 'orderguard.port');
        fs.copyFileSync(this._portFile, dst);
        result.deployed.push({ kind: 'port', path: dst });
      }
    } catch (e) {
      result.errors.push(`copy port file failed: ${e.message}`);
    }

    // 3) local rules JSON
    try {
      const rules = await this.getLocalRules(eaName);
      if (rules?.ok) {
        const dst = path.join(ogFilesDir, `${eaName}.rules.json`);
        fs.writeFileSync(dst, JSON.stringify(rules.data || {}, null, 2), 'utf-8');
        result.deployed.push({ kind: 'rules', path: dst });
      } else {
        result.errors.push(`fetch local-rules failed: ${rules?.error || 'unknown'}`);
      }
    } catch (e) {
      result.errors.push(`write rules failed: ${e.message}`);
    }

    // 0.4.10: 顺手也部署跟单 hook（共享同款 MQL5/Include 目录 + 跟 OrderGuard 同款 .port 文件）。
    // 启用拦截模式的 EA 多半也愿意被跟单 — 不愿意的话用户不会上架到商城，也就没人能跟。
    // 失败不阻塞主流程，只追加到 result.errors。
    try {
      const mqhCt = path.join(path.dirname(this.mqhSourcePath || ''), 'EasyDealCopyTrade.mqh');
      if (fs.existsSync(mqhCt)) {
        const r2 = await this.deployCopyTradeHook(mt5DataDir, mqhCt);
        for (const d of (r2.deployed || [])) result.deployed.push({ ...d, kind: `copy-trade-${d.kind}` });
        for (const e of (r2.errors || [])) result.errors.push(`[copy-trade] ${e}`);
      }
    } catch (e) {
      result.errors.push(`[copy-trade] deploy raised: ${e.message}`);
    }

    if (result.errors.length && !result.deployed.length) {
      result.ok = false;
      result.error = result.errors.join('; ');
    }
    this.log(`deployIntercept(${eaName}) → ${result.deployed.length} files, ${result.errors.length} errors`);
    return result;
  }

  /** 0.4.10 跟单 hook deploy:
   *   - copy <appMql5>/EasyDealCopyTrade.mqh → <mt5DataDir>/MQL5/Include/
   *   - copy orderguard.port → <mt5DataDir>/MQL5/Files/CopyTrade/copy-trade.port
   *     (orderguard 跟 copy-trade 共用 orderguard_server 进程，所以同一个 port)
   *
   *  注：EA 源码 inject（#include + OnInit + OnTradeTransaction 三处）由
   *  electron/main.js 的 _injectEasyDealCopyTrade helper 负责，不在这。
   */
  async deployCopyTradeHook(mt5DataDir, mqhCopyTradeSourcePath) {
    if (!mt5DataDir) return { ok: false, error: 'mt5DataDir required' };
    if (!mqhCopyTradeSourcePath || !fs.existsSync(mqhCopyTradeSourcePath)) {
      return { ok: false, error: `mqh source not found: ${mqhCopyTradeSourcePath}` };
    }

    const result = { ok: true, deployed: [], errors: [] };
    const includeDir = path.join(mt5DataDir, 'MQL5', 'Include');
    const ctFilesDir = path.join(mt5DataDir, 'MQL5', 'Files', 'CopyTrade');

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(ctFilesDir, { recursive: true });
    } catch (e) {
      return { ok: false, error: `mkdir failed: ${e.message}` };
    }

    // 1) mqh
    try {
      const dst = path.join(includeDir, 'EasyDealCopyTrade.mqh');
      fs.copyFileSync(mqhCopyTradeSourcePath, dst);
      result.deployed.push({ kind: 'mqh', path: dst });
    } catch (e) {
      result.errors.push(`copy mqh failed: ${e.message}`);
    }

    // 2) port file — 共用 orderguard 的端口（同一个 Python 进程）
    try {
      if (this._portFile && fs.existsSync(this._portFile)) {
        const dst = path.join(ctFilesDir, 'copy-trade.port');
        fs.copyFileSync(this._portFile, dst);
        result.deployed.push({ kind: 'port', path: dst });
      } else {
        result.errors.push('orderguard.port not ready (服务还没起来？)');
      }
    } catch (e) {
      result.errors.push(`copy port file failed: ${e.message}`);
    }

    if (result.errors.length && !result.deployed.length) {
      result.ok = false;
      result.error = result.errors.join('; ');
    }
    this.log(`deployCopyTradeHook → ${result.deployed.length} files, ${result.errors.length} errors`);
    return result;
  }

  // ---- private ----

  /** EA (拦截模式 / 消息面护航) 从 <MT5>/MQL5/Files/OrderGuard/orderguard.port 读端口。
   *  之前只在 deployIntercept 时拷一次 —— 护航进程重启换了端口 (候选端口被占) 后 EA 一直连旧端口,
   *  静默按「服务不可达」放行。改成每次就绪都把实际端口同步到本实例 MT5 (目录存在才写)。 */
  _syncPortFileToMt5() {
    if (!this.mt5DataDir) return;
    const mql5Dir = path.join(this.mt5DataDir, 'MQL5');
    if (!fs.existsSync(mql5Dir)) return;
    try {
      const dir = path.join(mql5Dir, 'Files', 'OrderGuard');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'orderguard.port');
      let cur = '';
      try { cur = fs.readFileSync(dst, 'utf-8').trim(); } catch {}
      if (cur !== String(this.port)) {
        fs.writeFileSync(dst, String(this.port), 'utf-8');
        this.log(`port file synced → ${dst} (${cur || 'none'} → ${this.port})`);
      }
    } catch (e) {
      this.log(`port file sync failed: ${e.message}`);
    }
  }

  _httpGet(path) {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: this.port,
        path: path,
        timeout: 3000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ ok: false, error: 'invalid JSON', raw: body.slice(0, 500) });
          }
        });
      });
      req.on('error', (e) => {
        resolve({ ok: false, error: e.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
    });
  }

  /** 0.3.64: POST helper for /enable, /disable etc. */
  _httpPost(path, payload) {
    return new Promise((resolve) => {
      const body = JSON.stringify(payload || {});
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 3000,
      }, (res) => {
        let resp = '';
        res.on('data', (chunk) => { resp += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(resp)); }
          catch { resolve({ ok: false, error: 'invalid JSON', raw: resp.slice(0, 500) }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(body);
      req.end();
    });
  }

  async _waitForHealth(timeoutMs) {
    const start = Date.now();
    // 第一步：等 Python 写出 orderguard.port 文件，知道实际端口
    while (Date.now() - start < timeoutMs) {
      try {
        const txt = fs.readFileSync(this._portFile, 'utf-8').trim();
        const p = parseInt(txt, 10);
        if (Number.isFinite(p) && p > 0) {
          this.port = p;
          this.log(`Python 选了端口 ${p}`);
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this.port === this.portCandidates[0] && !fs.existsSync(this._portFile)) {
      this.log('未读到 ' + this.portFileName + '，用 fallback 端口直接探 health');
    }
    // 第二步：用确认的端口探 /health
    while (Date.now() - start < timeoutMs) {
      const result = await this._httpGet('/health');
      if (result.ok) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  _startHealthCheck() {
    // 0.3.150: Electron 端外部 watchdog —— 之前 health check 失败只 log 不重启,
    // 用户反馈「OG 跟踪经常停」根因: Python 端 watchdog 防得了 tracker 死锁,
    // 防不了 Python 进程整体死掉 (segfault / OOM / 端口被占 / HTTP server crash).
    // 这条 timer 改成「连续 3 次失败 (=90s 不可达) → 自动 stop + spawn 新进程」.
    // restart safe: SQLite 保留 decisions / orders / rules / ea_anchors,
    //               _ea_enabled / _ea_magic_map 从 rules._meta 行重启时还原.
    this._consecutiveFails = 0;
    this._restarting = false;
    this._healthTimer = setInterval(async () => {
      // 正在 restart 中 — 跳过这轮 (新 spawn 出来还没 ready)
      if (this._restarting) return;
      const result = await this._httpGet('/health');
      this._lastHealth = result;
      if (!result.ok) {
        this._consecutiveFails++;
        this.log(`[watchdog] health check failed (${this._consecutiveFails}/3): ${result.error}`);
        if (this._consecutiveFails >= 3) {
          this.log('[watchdog] OG unresponsive 90s+ — auto-restart');
          this._consecutiveFails = 0;
          this._restarting = true;
          this._autoRestart()
            .catch((e) => this.log(`[watchdog] auto-restart err: ${e?.message || e}`))
            .finally(() => { this._restarting = false; });
        }
      } else {
        if (this._consecutiveFails > 0) {
          this.log(`[watchdog] health recovered after ${this._consecutiveFails} consecutive fails`);
        }
        this._consecutiveFails = 0;
      }
    }, 30_000);
  }

  _stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    this._consecutiveFails = 0;
    this._restarting = false;
  }

  // 0.3.152: timer-registry 联动 — 「全停」彻底停 OG (子进程 + healthTimer),
  // 「解除全停」重新 spawn. tracker_loop 也彻底停, 期间不发 alert.
  async pause() {
    this._pausedByRegistry = true;
    this._stopHealthCheck();
    if (this.child) {
      try { await this.stop({ timeoutMs: 5000 }); } catch (e) { this.log('[pause] stop err:', e?.message || e); }
    }
    this.log('paused by timer-registry');
  }

  async resume() {
    if (!this._pausedByRegistry) return;
    this._pausedByRegistry = false;
    try {
      await this.start();
      this.log('resumed by timer-registry');
    } catch (e) {
      this.log('[resume] start err:', e?.message || e);
    }
  }

  /** Auto-restart OG child process (0.3.150 外部 watchdog 触发用). */
  async _autoRestart() {
    this.log('[watchdog] stopping existing OG child...');
    try {
      if (this.child) {
        await this.stop({ timeoutMs: 5000 });
      }
    } catch (e) {
      this.log(`[watchdog] stop err (ignored): ${e?.message || e}`);
    }
    // 让端口释放, 给 SQLite WAL fsync 时间
    await new Promise((r) => setTimeout(r, 2000));
    this.log('[watchdog] spawning fresh OG child...');
    await this.start();
    this.log('[watchdog] auto-restart complete');
  }
}

module.exports = { OrderGuard };
