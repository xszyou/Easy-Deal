// Periodic EA stats collector.
//
// Hourly: spawn python/stats_collector.py (one-shot, exits) → parse the
// MT5 snapshot → update <userData>/data/strategies.json with per-EA
// running totals (hours_run, trades, pnl_pct, max_drawdown). The renderer
// already polls strategies.list() every 5s, so the UI reflects fresh
// numbers without any extra wiring.
//
// On day roll-over: post yesterday's per-EA daily slice to the server's
// /v1/strategy-stats/upload, then reset the "today" buckets. The server
// uses these rows for the marketplace's listing-eligibility gate (≥10
// days running, etc.).
//
// EA attribution: we read <MT5_DATA_DIR>/MQL5/Files/<EA>_runtime.json for
// the EA-declared `magic` integer; deals/positions with that magic get
// counted against that EA. Non-EasyDeal-protocol EAs that don't ship a
// runtime.json with `magic` won't have per-EA stats — they'll still show
// "运行中" via the log-scan detector, just no numbers.

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const TICK_MS_DEV  = 60_000;        // 1 min during dev (override via env)
const TICK_MS_PROD = 60 * 60_000;   // 1 hour in prod

class StatsCollector {
  constructor({ pythonBin, scriptPath, mt5InstallDir, mt5DataDir,
                strategies, marketplace, settingsRef, log, recordRun,
                findMt5PidsForInstall }) {
    this.pythonBin = pythonBin || 'python';
    this.scriptPath = scriptPath;
    this.mt5InstallDir = mt5InstallDir;
    this.mt5DataDir = mt5DataDir;
    this.strategies = strategies;       // electron/strategies.js instance
    this.marketplace = marketplace;     // electron/marketplace.js module
    this.settingsRef = settingsRef;     // SettingsStore (for refreshed paths)
    this.log = log || ((m) => console.log('[stats]', m));
    // Optional callback — main.js wires this to recordSystemRun so each
    // tick lands in scheduler.db's task_runs (UI history + Claude query).
    this.recordRun = recordRun || (() => {});
    // 0.3.197: 调 snapshot 前 precheck terminal64.exe 在不在跑 — 不在跑跳过本次
    // snapshot, 防 mt5.initialize 自动拉起用户刚关掉的 MT5.
    this.findMt5PidsForInstall = findMt5PidsForInstall || null;
    // 0.3.215: 同款 + age 检查 — 跑 < 60s 也跳过
    this.findMt5AgeForInstall = arguments[0]?.findMt5AgeForInstall || null;
    this._timer = null;
    this._lastDailyDate = null;         // YYYY-MM-DD of last upload
    this._tickInProgress = false;
    // Surfaced in the 定时任务 / 系统任务 list so the user can see this is alive.
    this.tickMs = null;
    this.lastRunAt = null;       // unix ms of most recent tick start
    this.lastStatus = null;      // 'ok' | 'mt5_unreachable' | 'error'
    this.lastError = null;
    this.lastDuration = null;    // ms
    this.runCount = 0;
    this.lastUploadAt = null;    // ms when daily upload last fired
    this.lastUploadCount = 0;    // rows uploaded last roll
  }

  start() {
    const tickMs = process.env.EASYDEAL_STATS_TICK_MS
      ? parseInt(process.env.EASYDEAL_STATS_TICK_MS, 10)
      : (process.env.NODE_ENV === 'development' ? TICK_MS_DEV : TICK_MS_PROD);
    this.tickMs = tickMs;

    this.log(`stats collector starting, tick=${tickMs}ms, script=${this.scriptPath}`);
    // First tick after 30s so the app boot isn't blocked.
    setTimeout(() => this.tick().catch((e) => this.log('tick err: ' + e.message)),
               30_000);
    this._timer = setInterval(
      () => this.tick().catch((e) => this.log('tick err: ' + e.message)),
      tickMs,
    );
    // 0.5.0 P3a: command pump — 每 90s 拉 pending 远程命令 (rebuild_raw_data /
    // set_anchor_balance / clear_local_cache 等), 让 admin 能远程修复用户数据.
    setTimeout(() => this._pumpCommands().catch((e) => this.log('cmd pump err: ' + e.message)),
               60_000);
    this._cmdTimer = setInterval(
      () => this._pumpCommands().catch((e) => this.log('cmd pump err: ' + e.message)),
      90_000,
    );
  }

  /** Snapshot of internal state for the 系统任务 view. */
  status() {
    return {
      id: 'stats-collector',
      name: 'EA 成绩单采集',
      description: '每 tick 拍一次 MT5 快照，更新 strategies.json 里每个 EA 的 hours_run / trades / pnl / drawdown',
      tick_ms: this.tickMs,
      last_run_at: this.lastRunAt,
      last_status: this.lastStatus,
      last_error: this.lastError,
      last_duration_ms: this.lastDuration,
      run_count: this.runCount,
      last_upload_at: this.lastUploadAt,
      last_upload_rows: this.lastUploadCount,
    };
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._cmdTimer) { clearInterval(this._cmdTimer); this._cmdTimer = null; }
  }

  // 0.3.152: timer-registry 联动 — 「全停」时停 tick + cmd pump, 「解除全停」恢复
  async pause() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._cmdTimer) { clearInterval(this._cmdTimer); this._cmdTimer = null; }
    this.log('paused by timer-registry');
  }

  async resume() {
    if (!this.tickMs) return;  // 没 start 过 — skip
    if (!this._timer) {
      this._timer = setInterval(
        () => this.tick().catch((e) => this.log('tick err: ' + e.message)),
        this.tickMs,
      );
    }
    if (!this._cmdTimer) {
      this._cmdTimer = setInterval(
        () => this._pumpCommands().catch((e) => this.log('cmd pump err: ' + e.message)),
        90_000,
      );
    }
    this.log('resumed by timer-registry');
  }

  // ============================================================
  // 0.5.0 P3a: Server 远程命令 pump (rebuild_raw_data / set_anchor_balance /
  // clear_local_cache / upload_full_dump 等)
  // ============================================================
  async _pumpCommands() {
    if (!this.marketplace) return;
    let pending;
    try {
      pending = await this.marketplace.getPendingCommands();
    } catch (e) {
      return;  // 未登录 / 网络问题 — 静默
    }
    if (!pending?.ok || !pending?.data?.commands?.length) return;
    for (const cmd of pending.data.commands) {
      this.log(`[cmd] received: id=${cmd.id} command=${cmd.command}`);
      let result = null, error = null, status = 'done';
      try {
        result = await this._dispatchCommand(cmd);
      } catch (e) {
        error = String(e?.message || e);
        status = 'failed';
        this.log(`[cmd] ${cmd.command} failed: ${error}`);
      }
      // 回报
      try {
        await this.marketplace.reportCommandResult(cmd.id, { status, result, error });
        this.log(`[cmd] reported id=${cmd.id} status=${status}`);
      } catch (e) {
        this.log(`[cmd] report failed for id=${cmd.id}: ${e?.message || e}`);
      }
    }
  }

  async _dispatchCommand(cmd) {
    const c = cmd.command;
    const args = cmd.args || {};
    if (c === 'rebuild_raw_data') {
      // 拉 MT5 全历史 (默认 365 天, args.lookback_days 可覆盖) → 上传到 raw 表
      const lookbackDays = Number(args.lookback_days) || 365;
      return await this._rebuildRawData(lookbackDays);
    }
    if (c === 'clear_local_cache') {
      // 慎用 — 强制 mark all records.json needs_anchor_reseed
      if (this.strategies?.resetAnchorForEa) {
        // 拉 list 找全部 ea_name
        const list = await this.strategies.list({
          mt5DataDir: this.mt5DataDir, mt5InstallDir: this.mt5InstallDir,
        });
        const uniq = new Set();
        for (const it of list) uniq.add(it.name.replace(/\.(mq5|ex5)$/i, ''));
        for (const ea of uniq) {
          try { await this.strategies.resetAnchorForEa(ea, null, null); } catch {}
        }
        return { ok: true, eas_reset: Array.from(uniq) };
      }
      return { ok: false, error: 'strategies module unavailable' };
    }
    if (c === 'upload_full_dump') {
      // 把 strategies.records 全 dump 上传一份诊断快照
      const records = this.strategies?.records || {};
      return { ok: true, records_count: Object.keys(records).length, records };
    }
    if (c === 'set_anchor_balance') {
      // {ea_name, account_login, anchor_ts, anchor_balance}
      // 调 server /v1/anchors/set 直接
      if (!this.marketplace?.setAnchor) {
        return { ok: false, error: 'setAnchor wrapper missing' };
      }
      return await this.marketplace.setAnchor({
        eaName: args.ea_name,
        accountLogin: args.account_login,
        anchorTs: args.anchor_ts,
        anchorBalance: args.anchor_balance,
        anchorSource: args.anchor_source || 'admin',
      });
    }
    return { ok: false, error: `unknown command: ${c}` };
  }

  /** 1.2.x「从挂上那一刻算起」(用户拍板): EA 首次被跟踪 / 换号 / 换二进制重锚时,
   *  把挂载锚(时刻 + 当时账户余额)推到 server ea_anchors_v2 →
   *  /v1/strategy-stats/me 用它当 compute_metric 显式 anchor: 投入资金 = 挂载时
   *  余额、运行时长 = 挂载至今、成交归因窗口 = 挂载之后(同 magic 历史不串账)。
   *  排行榜/商城不读这个锚(0.5.20 反作弊), 只影响自己看自己。fire-and-forget,
   *  失败无害(下次转变再推 / server 端兜 bal_anchor)。*/
  _pushMountAnchor(eaName, accountLogin, balance) {
    try {
      if (!eaName || !accountLogin || typeof this.marketplace?.setAnchor !== 'function') return;
      Promise.resolve(this.marketplace.setAnchor({
        eaName,
        accountLogin,
        anchorTs: new Date().toISOString(),
        anchorBalance: (Number(balance) > 0) ? Number(balance) : null,
        anchorSource: 'mount',
      })).then((r) => {
        this.log(`[mount-anchor] ${eaName}@${accountLogin} balance=${balance} → ${r && r.ok ? 'ok' : JSON.stringify(r)}`);
      }).catch((e) => {
        this.log(`[mount-anchor] ${eaName}@${accountLogin} push failed: ${e && e.message || e}`);
      });
    } catch {}
  }

  /** Rebuild raw — 拉 N 天 MT5 history → upload balance + deals. */
  async _rebuildRawData(lookbackDays) {
    this.log(`[rebuild_raw_data] lookback=${lookbackDays}d, spawning long snapshot...`);
    // 用 env 临时把 lookback 拉长, snapshot() spawn 一次
    const oldEnv = process.env.EASYDEAL_STATS_LOOKBACK_DAYS;
    process.env.EASYDEAL_STATS_LOOKBACK_DAYS = String(lookbackDays);
    let snap;
    try {
      snap = await this.snapshot();
    } finally {
      if (oldEnv === undefined) delete process.env.EASYDEAL_STATS_LOOKBACK_DAYS;
      else process.env.EASYDEAL_STATS_LOOKBACK_DAYS = oldEnv;
    }
    if (!snap?.account?.login) return { ok: false, error: 'no account info from snapshot' };
    // 复用现有 _uploadRawSnapshot 流程
    const magicMap = await this._readMagicMap().catch(() => ({}));
    await this._uploadRawSnapshot(snap, magicMap);
    return {
      ok: true,
      lookback_days: lookbackDays,
      account_login: snap.account.login,
      balance: snap.account.balance,
      deals_count: (snap.deals || []).length,
    };
  }

  /** Run python/stats_collector.py and parse stdout JSON. 30s hard timeout. */
  async snapshot() {
    if (!fsSync.existsSync(this.scriptPath)) {
      throw new Error('stats_collector.py missing at ' + this.scriptPath);
    }
    const s = this.settingsRef ? this.settingsRef.getResolved() : null;
    // 0.3.191 Phase 3: this.mt5InstallDir 优先 — tick() 多实例迭代时按 per-iter
    // 覆盖该字段, 拿到对应实例的 dir; 单实例时跟 s.mt5.installDir 一致.
    const installDir = this.mt5InstallDir || (s && s.mt5 && s.mt5.installDir) || '';
    const dataDir = this.mt5DataDir || (s && s.mt5 && s.mt5.dataDir) || '';
    const instance = (this.settingsRef?.listMt5Instances?.() || []).find((it) =>
      String(it.installDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
        === String(installDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase());
    const launchMode = instance?.launchMode
      || ((installDir && dataDir && String(installDir).toLowerCase() === String(dataDir).toLowerCase()) ? 'portable' : 'standard');

    // 0.3.197: precheck — 如果该 installDir 的 terminal64.exe 没在跑就直接抛
    // (跟 SDK 失败一样让 tick 走 mt5_unreachable 分支), 不调 mt5.initialize 把它拉回来.
    // 0.3.215: 加 age 检查 (跟 OG / account-info 一致) — 进程才跑 < 60s 时 SDK IPC
    // 没就绪, 调 init SDK 会误判「not running」launch 第二个. 这就是用户实测
    // 「点启动一下子启动了 2 个 MT5」的漏网 (之前 stats-collector 只 check 存在,
    // 没 check age). 等 60s 后再 snapshot 安全.
    if (this.findMt5AgeForInstall && installDir) {
      try {
        const age = await this.findMt5AgeForInstall(installDir);
        if (age < 0) {
          throw new Error('MT5 not running for ' + installDir + ' — skip snapshot to avoid auto-launch');
        }
        if (age < 60) {
          throw new Error(`MT5 booting (age=${age.toFixed(0)}s < 60s) — skip snapshot to avoid SDK launching duplicate`);
        }
      } catch (e) {
        if (String(e?.message || '').includes('skip snapshot')) throw e;
        throw new Error('[precheck] 无法安全确认 MT5 进程: ' + (e?.message || e));
      }
    } else if (this.findMt5PidsForInstall && installDir) {
      // legacy fallback — 没注入 findMt5AgeForInstall 时退到老 PID-only 检查
      try {
        const pids = await this.findMt5PidsForInstall(installDir);
        if (!pids.length) {
          throw new Error('MT5 not running for ' + installDir + ' — skip snapshot to avoid auto-launch');
        }
      } catch (e) {
        if (String(e?.message || '').includes('skip snapshot')) throw e;
        throw new Error('[precheck] 无法安全确认 MT5 进程: ' + (e?.message || e));
      }
    }

    return await new Promise((resolve, reject) => {
      const proc = spawn(this.pythonBin, [this.scriptPath], {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          EASYDEAL_MT5_INSTALL_DIR: installDir,
          EASYDEAL_MT5_DATA_DIR: dataDir,
          EASYDEAL_MT5_LAUNCH_MODE: launchMode,
          EASYDEAL_MT5_INSTANCE_ID: instance?.id || '',
          EASYDEAL_MT5_ALLOW_LAUNCH: '0',
        },
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => stdout += d.toString('utf8'));
      proc.stderr.on('data', (d) => stderr += d.toString('utf8'));
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error('snapshot timeout (30s)'));
      }, 30_000);
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        // 埋点: stats_collector.py 每次运行往 stderr 打一行 connected/account/positions/deals/
        // last_error。这里无条件 log 出来, 方便排查「MT5 断连后数据不准」(用户 + 本机实盘)。
        // 断连时 py 返 ok:false → 下面 reject → tick 跳过上传, 保留 server 上次好统计。
        const _se = (stderr || '').trim();
        if (_se) this.log('[snapshot py] ' + _se.slice(0, 400));
        if (code !== 0 && !stdout) {
          return reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(stdout);
          if (!j.ok) return reject(new Error(j.error || 'collector !ok'));
          resolve(j);
        } catch (e) {
          reject(new Error('parse stdout failed: ' + stdout.slice(0, 200) +
                           ' / stderr=' + stderr.slice(0, 200)));
        }
      });
    });
  }

  /**
   * Build magic→EA mapping using two complementary sources:
   *   1. EasyDeal-protocol runtime.json (requires user/Claude to edit EA source — fragile)
   *   2. MT5 chart profile (.chr) files (auto-saved by MT5 itself, NO source edit needed)
   *
   * .chr 是 MT5 自己保存的图表配置（每次关图表 / 关 MT5 时刷新），里面有
   * <expert> 块标识当前挂的 EA + <inputs> 块带所有 input 参数（含 InpMagicNumber
   * 之类）。这条路不要求 EA 作者实现 EasyDeal 协议 — 任何 EA 装上图表自动就有。
   * runtime.json 保留作为「实时性更高」的来源（比 .chr 更频繁更新）。
   */
  /** 0.3.63: 从 deal 频次启发式推断 EA → magic 映射，补 runtime.json + .chr 没拿到的 case。
   *  原本只有 tickAll 主路径调用，现在抽出共享给 forceUploadNow（用户点参与排行榜时也会用 backfill），
   *  避免「用户手写的 VP 策略没 runtime.json → forceUploadNow backfill 找不到 magic → 跳过 → 服务端
   *  rows 全用错版本 fallback bug 留下的脏数据」这种顽固不一致。
   *  mutates magicMap in place. */
  async _augmentMagicMapByHeuristic(magicMap, allDeals) {
    try {
      const s = this.settingsRef ? this.settingsRef.getResolved() : null;
      // 0.3.191 Phase 3: this.mt5DataDir 优先 (per-iter 多实例覆盖会改它)
      const dataDir = this.mt5DataDir || (s?.mt5?.dataDir);
      if (!dataDir) return;
      const eaSymbolMap = await this.strategies.getMountedEaSymbols(dataDir);
      const knownEAs = new Set(Object.values(magicMap));
      for (const [ea, info] of Object.entries(eaSymbolMap)) {
        if (knownEAs.has(ea)) continue;
        const syms = new Set((info.symbols || []).map((s) => String(s).toLowerCase()));
        const mountSec = info.last_loaded_at ? Math.floor(info.last_loaded_at / 1000) : 0;
        if (!syms.size) continue;
        const counts = new Map();
        for (const d of allDeals || []) {
          if (!d || d.magic == null || d.magic === 0) continue;
          if (mountSec && d.time && d.time < mountSec) continue;
          if (!d.symbol || !syms.has(String(d.symbol).toLowerCase())) continue;
          counts.set(String(d.magic), (counts.get(String(d.magic)) || 0) + 1);
        }
        let bestMagic = null, bestCount = 0;
        for (const [mg, c] of counts) {
          if (c > bestCount) { bestMagic = mg; bestCount = c; }
        }
        if (bestMagic && !magicMap[bestMagic]) {
          magicMap[bestMagic] = ea;
          this.log(`[magic-infer] ${ea} → magic=${bestMagic} (from ${bestCount} deals on ${[...syms].join(',')})`);
        }
      }
    } catch (e) {
      this.log('[magic-infer] failed: ' + (e?.message || String(e)));
    }
  }

  async _readMagicMap() {
    const map = {};   // magic (string) → eaName
    const s = this.settingsRef ? this.settingsRef.getResolved() : null;
    // 0.3.191 Phase 3: this.mt5* 优先 — 多实例迭代覆盖
    const dataDir = this.mt5DataDir || (s && s.mt5 && s.mt5.dataDir);
    const installDir = this.mt5InstallDir || (s && s.mt5 && s.mt5.installDir);
    const roots = [];
    if (dataDir)    roots.push(dataDir);
    if (installDir && installDir !== dataDir) roots.push(installDir);

    // 1. runtime.json 路线（EasyDeal 协议）
    for (const root of roots) {
      const fdir = path.join(root, 'MQL5', 'Files');
      let entries;
      try { entries = await fs.readdir(fdir); } catch { continue; }
      for (const fn of entries) {
        const m = fn.match(/^(.+)_runtime\.json$/i);
        if (!m) continue;
        const eaName = m[1];
        try {
          const buf = await fs.readFile(path.join(fdir, fn), 'utf8');
          const j = JSON.parse(buf);
          let magic = j.magic ?? j.MagicNumber ?? null;
          if (magic == null && j.params) {
            magic = j.params.MagicNumber ?? j.params.magic ?? null;
          }
          if (magic != null) map[String(magic)] = eaName;
        } catch {}
      }
    }

    // 2. .chr 路线（兜底 — 不要求 EA 改源码）
    for (const root of roots) {
      const charts = await this._scanChartFilesForMagic(root);
      for (const c of charts) {
        // runtime.json 已经覆盖的 magic 不重复（runtime.json 实时性更高）
        if (!map[String(c.magic)]) map[String(c.magic)] = c.eaName;
      }
    }
    return map;
  }

  /**
   * 扫 <root>/MQL5/Profiles/Charts/**\/*.chr 找 EA + magic 配对。
   * .chr 是 utf-16-le 编码的 INI-like 文件，相关结构：
   *   <chart>
   *     <expert>
   *       name=GMarket.ex5
   *       <inputs>
   *         InpMagicNumber=999
   *         InpFirstLots=0.01
   *         ...
   *       </inputs>
   *     </expert>
   *   </chart>
   * 返回 [{eaName, magic, mtime}]，按 mtime 降序（新的优先）。
   */
  async _scanChartFilesForMagic(root) {
    const out = [];
    const chartsDir = path.join(root, 'MQL5', 'Profiles', 'Charts');
    let dirs;
    try { dirs = await fs.readdir(chartsDir, { withFileTypes: true }); } catch { return out; }
    // Walk one level deep (Default / 用户自定义 profile 文件夹)
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(chartsDir, d.name);
      let files;
      try { files = await fs.readdir(sub); } catch { continue; }
      for (const fn of files) {
        if (!fn.toLowerCase().endsWith('.chr')) continue;
        const fp = path.join(sub, fn);
        try {
          const buf = await fs.readFile(fp);
          // utf-16-le 是 MT5 默认编码；utf-8 兜底
          let content;
          try { content = buf.toString('utf16le'); }
          catch { content = buf.toString('utf8'); }
          const expertMatch = content.match(/<expert>\s*\r?\n([\s\S]*?)\r?\n\s*<\/expert>/i);
          if (!expertMatch) continue;
          const expertBlock = expertMatch[1];
          const nameMatch = expertBlock.match(/^name=(.+\.ex5)\s*$/im);
          if (!nameMatch) continue;
          const eaName = nameMatch[1].trim().replace(/\.ex5$/i, '');
          const inputsMatch = expertBlock.match(/<inputs>\s*\r?\n([\s\S]*?)\r?\n\s*<\/inputs>/i);
          if (!inputsMatch) continue;
          // 找 magic — 常见命名：InpMagicNumber / MagicNumber / Magic / magic
          let magic = null;
          for (const line of inputsMatch[1].split(/\r?\n/)) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
            if (!m) continue;
            const key = m[1];
            if (/^(InpMagic(Number)?|Magic(Number)?|magic)$/i.test(key)) {
              const val = parseInt(m[2].trim(), 10);
              if (Number.isFinite(val) && val > 0) { magic = val; break; }
            }
          }
          if (magic == null) continue;
          let mtime = 0;
          try { mtime = (await fs.stat(fp)).mtimeMs; } catch {}
          out.push({ eaName, magic, mtime, path: fp });
        } catch {}
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /**
   * One periodic tick:
   *  1. snapshot MT5 state
   *  2. update each EA's running totals in strategies.json
   *  3. on day roll-over, upload yesterday's daily slice to server
   */
  async tick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    const t0 = Date.now();
    this.lastRunAt = t0;
    this.runCount += 1;
    this.lastError = null;
    try {
      // 0.3.191 Phase 3: 多 MT5 实例 — 顺序为每个有 installDir 的实例跑一次 tick.
      // 实例间用 mt5InstallDir/mt5DataDir 临时切换 (this 上下文), 跑完恢复.
      // 单实例用户行为不变: 老 settings.mt5 字段仍是活动实例的镜像, 第一次 iter
      // 跟当前一样.
      let instances = [];
      try {
        const fn = this.settingsRef?.listMt5Instances || (this.settingsRef?.data?.mt5Instances && (() => this.settingsRef.data.mt5Instances));
        if (typeof fn === 'function') instances = fn.call(this.settingsRef) || [];
      } catch {}
      // 没有多实例配置 → 走老逻辑跑一次 (mt5InstallDir/mt5DataDir 已经在 constructor 里)
      if (!instances.length) {
        return await this._tickOnce(t0);
      }
      // 多实例: 顺序跑每个 installDir/dataDir 不为空的
      // 0.3.201: 关键过滤 — 跳过「没绑 EA 且不是 active」的实例.
      // 用户反馈: 加了第二个 MT5 demo 账户 ($10000 balance), GMarket 的「投入
      // 资金」从 $10000 变成 $20000 (服务端 license-level 聚合所有 account 入金,
      // 不按 EA 实际所在账户过滤). 客户端这里跳过空实例就不会上传它的 balance,
      // server 看不到那个 $10000 入金, GMarket 的投入资金恢复 $10000.
      // 跳过条件: 该实例没绑任何 EA AND 不是 active. (active 要保留, 因为它承接
      // 未绑定的 EA — 用户可能 EAs 没显式绑定就让 active 处理.)
      const activeId = (() => {
        try { return this.settingsRef?.data?.activeMt5InstanceId || null; } catch { return null; }
      })();
      const valid = instances.filter((i) => {
        if (!i || !i.installDir) return false;
        const isActive = i.id === activeId;
        if (isActive) return true;   // active 永远参与
        let boundCount = 0;
        try { boundCount = this.strategies?.countEasForInstance?.(i.id) || 0; } catch {}
        if (boundCount > 0) return true;   // 有绑定 EA 的也参与
        this.log(`[multi-inst] skip empty instance "${i.name || i.id}" — 没绑 EA + 非 active, 不污染 license-level 统计`);
        return false;
      });
      if (!valid.length) {
        return await this._tickOnce(t0);
      }
      const savedInstall = this.mt5InstallDir;
      const savedData = this.mt5DataDir;
      try {
        for (const inst of valid) {
          this.mt5InstallDir = inst.installDir;
          this.mt5DataDir = inst.dataDir || inst.installDir;
          this.log(`[multi-inst] tick for instance "${inst.name || inst.id}" (installDir=${inst.installDir})`);
          try {
            await this._tickOnce(t0, { instance_id: inst.id, instance_name: inst.name });
          } catch (e) {
            this.log(`[multi-inst] tick failed for ${inst.name}: ${e?.message || e}`);
          }
        }
      } finally {
        this.mt5InstallDir = savedInstall;
        this.mt5DataDir = savedData;
      }
      this.lastDuration = Date.now() - t0;
      return;
    } finally {
      this._tickInProgress = false;
    }
  }

  /** 0.3.191 Phase 3: 实际单次 tick 逻辑 — tick() 包装外面做实例迭代. */
  async _tickOnce(t0, instanceCtx = {}) {
    try {
      // ensureDetected() picks up MT5 if it was started AFTER EasyDeal
      // launch (registry-less portable installs etc.). Throttled internally.
      const s = this.settingsRef
        ? (this.settingsRef.ensureDetected
            ? await this.settingsRef.ensureDetected()
            : this.settingsRef.getResolved())
        : null;
      // 0.3.191 Phase 3: this.mt5* 优先 (多实例 per-iter 覆盖)
      // 1.4.9: 传 mt5InstancesList 把 is_mounted **限定到当前迭代的这个实例** —— 否则多账户
      // 场景(实盘 4 账户各挂一个 GMarket 副本, magic 全 999)下, list() 无实例上下文会按
      // 单默认实例算 is_mounted, 把别的实例的 EA 也算进 mounted 集 → 拿当前账户的成交按
      // magic 999 张冠李戴归给它。限定到本实例后, 每个 _tickOnce 只记它自己账户挂的那个 EA,
      // 战绩天然按账户分组(跟服务端持仓归属对齐)。单实例场景等价旧行为, 零回归。
      const _curInstId = instanceCtx.instance_id || null;
      const _curInstall = this.mt5InstallDir || (s && s.mt5 && s.mt5.installDir);
      const _curData = this.mt5DataDir || (s && s.mt5 && s.mt5.dataDir);
      const list = await this.strategies.list({
        mt5DataDir:    _curData,
        mt5InstallDir: _curInstall,
        ...(_curInstId ? {
          mt5InstancesList: [{ id: _curInstId, installDir: _curInstall, dataDir: _curData, running: true }],
          defaultRunning: true,
        } : {}),
      });
      // is_mounted 已限定到本实例; 再叠一层"该 EA 确实绑到当前实例(或未绑=归 active)"的过滤,
      // 双保险避免跨实例串: 绑了别的实例的 EA 不进本 tick 的 mounted 集。
      const mounted = new Set(
        list.filter((x) => {
          if (!x.is_mounted) return false;
          if (_curInstId && x.mt5_instance_id && x.mt5_instance_id !== _curInstId) return false;
          return true;
        }).map((x) => x.name.replace(/\.(mq5|ex5)$/i, ''))
      );

      let snap;
      try { snap = await this.snapshot(); }
      catch (e) {
        this.log('snapshot failed (probably MT5 not running): ' + e.message);
        this.lastStatus = 'mt5_unreachable';
        this.lastError = e.message;
        // Hours_run is now derived from log timestamps in strategies.list(),
        // so we don't need to bump it here. Just leave records alone.
        this.lastDuration = Date.now() - t0;
        return;
      }

      const magicMap = await this._readMagicMap();
      const today = new Date().toISOString().slice(0, 10);
      const allDeals = snap.deals || snap.deals_today || [];   // back-compat

      // 仓位/deals 启发式 magic 推断 — 补 runtime.json + .chr 都没拿到的 case
      await this._augmentMagicMapByHeuristic(magicMap, allDeals);

      const equity  = (snap.account && (snap.account.equity ?? snap.account.balance)) || 0;
      const balance = (snap.account && snap.account.balance) || 0;
      // 2026-07-16: 该实例自己的账户号, 从本次实时 snapshot() 读(跟 _uploadRawSnapshot L1235
      // 同一来源, 不是跨实例共享缓存)—— 带进日常 daily-stats 上传, 让服务端能按账户拆开
      // "多账户跑同名/同 hash 策略"这种此前会被合并成一条 leaderboard 行的数据。
      const accountLogin = Number(snap.account && snap.account.login) || null;
      // Cache last balance so forceUploadNow has something to record even
      // when called between snapshots.
      if (balance > 0) this._lastBalance = balance;

      // For each EA in workspace, compute pnl/trades from MT5 deals filtered by
      // (deal.time >= last_loaded_at) AND (magic matches this EA). This makes
      // the displayed numbers ALWAYS the live "since current load" totals,
      // not stale tick-accumulated counts.
      for (const it of list) {
        if (!it.hash) continue;
        const ea = it.name.replace(/\.(mq5|ex5)$/i, '');
        // 1.1.22: (hash, stem) 消歧 — 同内容多副本各读各的 record (见 strategies._recordKeyFor)
        const prev = this.strategies.records[this.strategies._recordKeyFor(it.hash, ea)] || {};

        // 0.3.191 Phase 3: 多实例时, 只让此 EA 的「归属实例」给它写 records,
        // 避免实例 B 的 tick 用 0 deals 把实例 A 算好的数据覆盖.
        // - 绑定到具体实例: 只有该实例的 tick 处理
        // - 未绑定 (走默认): 只有 active 实例的 tick 处理
        // - 单实例用户 (没传 instanceCtx 或 instances 列表空): 不过滤
        if (instanceCtx?.instance_id && this.strategies?.getMt5InstanceForEa) {
          const eaBoundId = this.strategies.getMt5InstanceForEa(ea);
          if (eaBoundId) {
            // EA 已绑 → 只让绑定实例 tick 处理
            if (eaBoundId !== instanceCtx.instance_id) continue;
          } else {
            // EA 未绑 → 只让 active 实例 tick 处理
            const activeId = this.settingsRef?.data?.activeMt5InstanceId || null;
            if (activeId && activeId !== instanceCtx.instance_id) continue;
          }
        }

        // Resolve EA's magic from the runtime.json convention. Without a
        // magic, we can't attribute deals — pnl/trades stay 0 (UI shows
        // ⚠ 统计缺失 chip already).
        const eaMagic = Object.entries(magicMap)
          .find(([_, name]) => name === ea)?.[0] ?? null;

        // Anchor: when did this BINARY start running? Prefer tracked_since_ms
        // —— 那是「第一次看到这个 ex5 sha 在跑」的时间戳，跨多次 reload 锁
        // 死，只在二进制真换了（recompile / hash 变了）时才在 binaryChanged
        // 分支里重置。last_loaded_at_ms 只当 fallback —— 那是 MT5 log 里
        // 最近一次「loaded successfully」时间戳，MT5 每次重挂 EA / profile
        // reload / 终端重启都会写一条，错误地把 anchor 往前推 → 把昨天的
        // 成交都过滤掉。用户撞过：「昨天有 trades 今天 0」的根因就是
        // 这条精度反了 —— 之前 `it.last_loaded_at_ms || prev.tracked_since_ms`
        // 让 last_loaded_at 优先，每天 MT5 重挂一次就清零。
        //
        // 0.3.110: anchor 同时拿「30 天 lookback」做兜底——取 binary 锚 跟
        // 30 天前 **更早** 的那个。这样：
        //   - 新 EA 跑了 5d → anchor = 5d 前 (=tracked_since_ms，跟现状一样)
        //   - 老 EA 跑了 60d → anchor = 30d 前（不局限当前 binary 版本）
        //   - EA 中间重编过 → anchor = 30d 前，跨多个 binary 版本的 deals 都纳入
        // 跟 leaderboard 30-day window 也对齐 (用户对账更直观)。作者
        // 反馈：「策略统计的交易笔数不对，盈利也不对」根因就是 binary
        // 重编后老成交被归档到 series[] 不再显示在「当前」列。
        // 0.3.141: 修 0.3.110 引入的 Math.min typo bug — 注释说「新 EA 跑了 5d
        // → anchor = 5d 前」但代码 Math.min(5d前, 30d前) = 30d前 跟注释完全反向。
        // 作者反馈：「GMarket 运行时长 7.1d 但盈利金额像把历史的都读进去了」
        // 截图 +21.1% / +$2227.10 / 41 笔 — 实际是 anchor 被错推到 30d 前导致
        // 拉了 30 天 magic=999 deals 跟 7.1d hours_run 不对齐。改 Math.max
        // 取「更晚」的 anchor：
        //   - 新 EA (7d 装) → max(7d前, 30d前) = 7d前 ✓ 跟 hours_run 一致
        //   - 老 EA (60d 装) → max(60d前, 30d前) = 30d前 ✓ 仍 cap 在 30d
        const lookback30dMs = Date.now() - 30 * 24 * 3600 * 1000;
        const trackedAnchorMs = prev.tracked_since_ms || it.last_loaded_at_ms || null;
        const loadAnchorMs = trackedAnchorMs
          ? Math.max(trackedAnchorMs, lookback30dMs)
          : lookback30dMs;
        const loadAnchorSec = Math.floor(loadAnchorMs / 1000);

        // Filter deals: same magic AND happened on/after this load.
        // Compute per-EA values from a CUMULATIVE pnl curve over time:
        //   - trades:        count of "out" (closing) deals
        //   - pnl:           net realized P/L since last load
        //   - max_drawdown:  largest (peak - trough) on the cumulative
        //                    curve, expressed as % of EA's initial balance
        // This isolates each EA's metrics — different EAs on the same
        // account show different numbers (which is what the user expects).
        const todayStartSec = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000);
        const myDeals = [];
        if (eaMagic !== null) {
          for (const d of allDeals) {
            if (String(d.magic) !== String(eaMagic)) continue;
            if (loadAnchorSec && d.time < loadAnchorSec) continue;
            myDeals.push(d);
          }
          myDeals.sort((a, b) => (a.time || 0) - (b.time || 0));
        }
        let trades = 0;
        // 0.3.142: anchor_pnl_offset — 用户手输本金 reset 后，stats-collector 算
        // pnl 默认是 sum(deals after anchor)，没把 reset 时刻已有的「balance - mib」
        // 段算进来。offset 把这段补上 — 跟用户「我账户从 10000 到现在赚 X」语义对齐。
        // 没用过手输本金 reset → offset=0，退化为老行为。
        const anchorPnlOffset = Number(prev.anchor_pnl_offset || 0) || 0;
        let pnl = anchorPnlOffset;
        let todayTrades = 0;
        let todayPnl = 0;
        let runningPnl = anchorPnlOffset;
        let peakPnl    = anchorPnlOffset;
        let maxDDdollars = 0;          // EA-specific drawdown (in account currency)
        for (const d of myDeals) {
          const realized = (d.profit || 0) + (d.swap || 0) + (d.commission || 0);
          // 0.3.141: trades 计数 entry ∈ {1, 2, 3} (OUT/INOUT/OUT_BY) — 之前
          // 只算 entry=1 漏掉 INOUT 反手 + OUT_BY (close-by) 两种平仓 deal。
          // 用户反馈截图：trades=0 但 pnl≠0 — 说明 GMarket 出过非 entry=1
          // 平仓但其 profit 被累加进 pnl，trades 没 +1，UI 显示矛盾。
          if (d.entry === 1 || d.entry === 2 || d.entry === 3) trades += 1;
          pnl += realized;
          runningPnl += realized;
          if (runningPnl > peakPnl) peakPnl = runningPnl;
          const dd = peakPnl - runningPnl;
          if (dd > maxDDdollars) maxDDdollars = dd;
          if (d.time >= todayStartSec) {
            if (d.entry === 1 || d.entry === 2 || d.entry === 3) todayTrades += 1;
            todayPnl += realized;
          }
        }

        // ---- Binary-change detection: when MT5 has loaded a NEW .ex5,
        // archive the previous series and reset all counters.
        let runningSha = null;
        if (it.mt5_ex5_sha256 && it.last_loaded_at_ms && it.mt5_ex5_mtime) {
          if (it.last_loaded_at_ms >= (it.mt5_ex5_mtime - 5000)) {
            runningSha = it.mt5_ex5_sha256;
          }
        }
        const trackedSha = prev.tracked_ex5_sha256 || null;
        const binaryChanged = !!(trackedSha && runningSha && trackedSha !== runningSha);

        // ---- 0.3.129: 账号切换检测 — 用户换 MT5 模拟盘账号（如用户从 100k → 10k）
        // 时，EA 的 binary 没变但 initial_balance 应该重置成新账号的余额，否则
        // pnl_pct 永远按旧账号余额算 → 排行榜显示完全错的百分比（500 USD 利润在
        // 10k 账号 = 5%，但分母用旧的 100k → 显示 0.5% 甚至 0.3%）。
        // 跟 binary 变化走同款 archive+reset 流程（archive 旧账号成绩到 series[]，
        // 用当前账号的 balance 作新 anchor）。
        const accountLogin = Number((snap.account && snap.account.login) || 0) || 0;
        const trackedLogin = Number(prev.tracked_account_login || 0) || 0;
        const accountSwitched =
          trackedLogin && accountLogin && trackedLogin !== accountLogin;

        // 0.3.130: 用户在 UI 点「重置基准余额」时，strategies.resetAnchorForEa 会
        // 给该 EA record 写 `needs_anchor_reseed: true`。下一个 tick 看到这个 flag
        // 就跟 binaryChanged / accountSwitched 走同款 archive+reset，但 reason 标
        // 'manual_reset'。比自动 heuristic 安全 — 用户主动充提余额不会被误 reset。
        const manualReseedRequested = !!prev.needs_anchor_reseed;

        let updates = {
          ea_name: ea,
          ea_hash: it.hash,
          last_tick_at: snap.ts,
        };

        if (binaryChanged || accountSwitched || manualReseedRequested) {
          const archived = {
            ex5_sha256: trackedSha,
            ex5_sha256_short: trackedSha ? trackedSha.slice(0, 12) : null,
            account_login_was: trackedLogin || null,    // 0.3.129: 归档时记下旧账号
            reason: binaryChanged ? 'binary_change'
                  : accountSwitched ? 'account_switch'
                  : 'manual_reset',
            started_at: prev.tracked_since || prev.last_tick_at || null,
            ended_at: snap.ts,
            // Snapshot what we had BEFORE the reset (using fields we cached
            // on the previous tick, not freshly-derived hours).
            hours_run:    prev.hours_run    || 0,
            trades:       prev.trades       || 0,
            pnl:          prev.pnl          ?? null,
            pnl_pct:      prev.pnl_pct      ?? null,
            max_drawdown: prev.max_drawdown ?? null,
            initial_balance: prev.initial_balance ?? null,
            equity_peak:     prev.equity_peak     ?? null,
            daily_history: Array.isArray(prev.history) ? prev.history.slice() : [],
          };
          const newSeries = Array.isArray(prev.series) ? prev.series.slice() : [];
          newSeries.unshift(archived);
          while (newSeries.length > 20) newSeries.pop();
          // 0.3.141: 手动重置时 anchor 三层优先级：
          //   (1) 用户手输的 manual_initial_balance (本金) — 最直观，跟用户语义一致
          //       (作者反馈：「这个账户我是在大约 10000 时启动的」但 stats-collector
          //       自己算出来 anchor=10350，差 350 USD 跟用户 mental model 不符)
          //   (2) balance - prev.pnl (扣掉该 EA 已实现累计收益的隐式本金)
          //   (3) 当前 balance fallback
          // binary/account 切换分支不动 — prev.pnl 来自旧 anchor 不可信
          let anchorForReset = balance > 0 ? balance : (prev.initial_balance || 0);
          if (manualReseedRequested) {
            const manualIB = Number(prev.manual_initial_balance || 0);
            if (manualIB > 0) {
              anchorForReset = manualIB;
            } else {
              const prevPnl = Number(prev.pnl || 0) || 0;
              const computed = balance - prevPnl;
              if (computed > 0) anchorForReset = computed;
            }
          }

          if (binaryChanged) {
            this.log(`[reset] ${ea}: binary changed (${trackedSha.slice(0, 8)}… → ${runningSha.slice(0, 8)}…), archived ${archived.hours_run}h / ${archived.trades} trades`);
          } else if (accountSwitched) {
            this.log(`[reset] ${ea}: account switched (${trackedLogin} → ${accountLogin}, balance ${prev.initial_balance || '?'} → ${balance}), archived ${archived.hours_run}h / ${archived.trades} trades`);
          } else {
            // manualReseedRequested
            this.log(`[reset] ${ea}: manual reset (anchor ${prev.initial_balance || '?'} → ${anchorForReset}, balance=${balance} prev.pnl=${prev.pnl ?? 0}), archived ${archived.hours_run}h / ${archived.trades} trades`);
          }

          // 0.3.292: binary_change / account_switch 时, 老 hash record 的 mt5_instance_id
          // 在新 hash record 上漏继承 → list() 用 stem 查 getMt5InstanceForEa 时有时还能
          // 兜到老 record, 有时撞 race / 老 record 也丢就拿不到 → UI 显「↻ 默认」, 用户
          // 抱怨「升级后绑定丢了」. 这里主动从 ea_name 查老 binding 继承一份, 让新 hash
          // record 自带 mt5_instance_id. 防御性: 即使 prev.mt5_instance_id 有, 也覆盖一次
          // (取 getMt5InstanceForEa 找到的最新一条, 跨多个老 hash record 取 most-recent).
          const inheritedBinding = (typeof this.strategies?.getMt5InstanceForEa === 'function')
            ? this.strategies.getMt5InstanceForEa(ea)
            : (prev.mt5_instance_id || null);
          updates = {
            ea_name: ea,
            ea_hash: it.hash,
            last_tick_at: snap.ts,
            tracked_ex5_sha256: runningSha || trackedSha,    // account switch 时 runningSha 仍是同一个；binary changed 时取新 sha
            tracked_account_login: accountLogin || null,      // 0.3.129: 记下当前账号 login
            needs_anchor_reseed:   false,                     // 0.3.130: 清掉 flag (避免下次又触发)
            manual_initial_balance: null,                     // 0.3.141: 清掉手输本金一次性使用
            // 0.3.292: 继承老 mt5_instance_id (见上面注释)
            ...(inheritedBinding ? {
              mt5_instance_id: inheritedBinding,
              mt5_instance_bound_at: prev.mt5_instance_bound_at || Date.now(),
            } : {}),
            // tracked_since records WHEN we first observed this binary running.
            // For pnl_pct denominator, balance at this moment becomes the new baseline.
            tracked_since:    snap.ts,
            tracked_since_ms: Date.now(),
            initial_balance:  anchorForReset,                 // 0.3.141: 手动 reset 时已扣 prev.pnl
            equity_peak:      equity > 0 ? equity : 0,
            max_drawdown:     0,
            today_date:       today,
            today_trades:     todayTrades,
            today_pnl:        todayPnl,
            history:          [],
            series:           newSeries,
          };
          // Recompute trades/pnl/pnl_pct using the post-anchor view.
          // pnl_pct here uses the EA's OWN realized pnl (not account equity)
          // so each EA on the same account shows distinct numbers.
          updates.trades    = trades;
          updates.pnl       = pnl;
          updates.hours_run = it.hours_run || 0;
          const initialAfterReset = updates.initial_balance || 0;
          updates.pnl_pct = initialAfterReset > 0 ? pnl / initialAfterReset : 0;
          // Drawdown reset to 0 too — fresh series, fresh max.
          updates.max_drawdown = 0;
          updates.equity_peak  = peakPnl;
          await this.strategies.recordTelemetry(it.hash, updates);
          // 1.2.x「从挂上那一刻算起」: 换号/换二进制重锚 = 新一段统计的起点,
          // 把锚(此刻+当前余额)推到 server ea_anchors_v2, 让策略页 server metric
          // (投入资金/运行时长/成交窗口)与本地 tracked_since 同口径。
          this._pushMountAnchor(ea, accountLogin, balance);
          continue;
        } else if (runningSha && !trackedSha) {
          // First-ever sighting of this binary — pin it. Anchor balance now.
          updates.tracked_ex5_sha256 = runningSha;
          updates.tracked_since      = prev.tracked_since      || snap.ts;
          updates.tracked_since_ms   = prev.tracked_since_ms   || Date.now();
          if (!prev.initial_balance && balance > 0) {
            updates.initial_balance = balance;
          }
          // 0.3.129: 记下当前账号 login，作为下次切换检测的 baseline
          if (!prev.tracked_account_login && accountLogin) {
            updates.tracked_account_login = accountLogin;
          }
          // 1.2.x: EA 首次被跟踪 = 挂载时刻 → 推挂载锚(同上)
          this._pushMountAnchor(ea, accountLogin, balance);
        } else if (!prev.tracked_account_login && accountLogin) {
          // 0.3.129: tracked_sha 已记，但 tracked_account_login 还没记
          // (老用户从 0.3.128 前升上来的 record) — 补一下当前 login，
          // 下次账号切换才能 detect 到。本次 tick 不 reset（防误删历史）。
          updates.tracked_account_login = accountLogin;
        }

        // ---- Live numbers (per-EA, derived fresh from this tick's deals) ----
        // hours_run: derived in strategies.list() from log timestamps. Just mirror it.
        updates.hours_run = it.hours_run || 0;
        updates.trades    = trades;
        updates.pnl       = pnl;

        // pnl_pct: per-EA realized P/L over its anchor balance. Anchor =
        // account balance the moment we first saw THIS binary load. If we
        // don't have a baseline yet (fresh sighting this tick), use current
        // balance — the resulting pnl_pct is then 0 or close to it, which
        // is the right starting point.
        //
        // 0.3.141: 撤销 0.3.110 的 earliestSeriesIB fallback —— 它是配 Math.min
        // 跨 binary 版本场景设计的，现在 Math.max 限定 anchor 在当前 binary 内，
        // earliestSeriesIB 反而会让分母锚到老 binary 的初始余额、跟 pnl 时间窗
        // 不对齐。直接用 current binary 的 initial_balance（reset 时刚锚的）。
        const initial =
          updates.initial_balance
          || prev.initial_balance
          || balance
          || 0;
        if (initial > 0) {
          updates.pnl_pct = pnl / initial;
        } else {
          updates.pnl_pct = 0;
        }

        // max_drawdown: largest peak-to-trough on the EA's own cumulative
        // pnl curve, normalized by its initial balance. Stored as fraction
        // (e.g., 0.05 = 5%) — same shape as pnl_pct.
        const ddFrac = initial > 0 ? maxDDdollars / initial : 0;
        // Persist the running max across ticks (drawdown should be sticky;
        // a recovery shouldn't wipe out the historical peak-trough).
        updates.max_drawdown = Math.max(prev.max_drawdown || 0, ddFrac);
        updates.equity_peak  = peakPnl;       // EA's peak cumulative pnl, $

        // Account-level equity also tracked for diagnostic / display in
        // the stats panel — separate field, not used for per-row pnl_pct.
        if (equity > 0) {
          updates.account_equity = equity;
        }

        // Today's slice — used by daily upload only. We bump today_hours
        // by (tick_ms / 3600s) when this EA is mounted at tick time, so a
        // 1-min tick adds ~0.0167h and a 1-hour tick adds 1.0h. Resets at
        // day rollover.
        updates.today_date   = today;
        updates.today_trades = todayTrades;
        updates.today_pnl    = todayPnl;
        const lastTickToday = (prev.today_date === today);
        const prevHoursToday = lastTickToday ? (prev.today_hours || 0) : 0;
        const hourIncrement = mounted.has(ea) ? ((this.tickMs || 60_000) / 3_600_000) : 0;
        updates.today_hours = prevHoursToday + hourIncrement;

        await this.strategies.recordTelemetry(it.hash, updates);
      }

      // Day roll-over: push yesterday's finalised slice when the date changes.
      await this._maybeUploadDaily(list, today, balance, accountLogin);
      // Live leaderboard refresh: also upload TODAY's running totals every
      // tick (server upserts on (license, ea_hash, date), so this just
      // overwrites the current row). Without this the public leaderboard
      // wouldn't move until tomorrow's rollover, which makes the "live
      // ranking" claim a lie. _maybeUploadDaily handles yesterday's final
      // snapshot; this handles today's evolving one.
      const liveItems = await this._uploadTodaysSnapshot(list, today, balance, accountLogin);
      // 0.3.58: 历史日数据回填 — 每小时一次。让排行榜数据跟「我的策略」对齐。
      // 见 _buildBackfillItems 注释。
      const BACKFILL_INTERVAL_MS = 60 * 60 * 1000;
      if (!this._lastBackfillAt || (Date.now() - this._lastBackfillAt) >= BACKFILL_INTERVAL_MS) {
        try {
          const backfill = await this._buildBackfillItems(list, snap, magicMap, accountLogin);
          if (backfill.length && this.marketplace) {
            await this.marketplace.uploadStats(backfill);
            this.log(`[backfill] uploaded ${backfill.length} historical daily rows (${[...new Set(backfill.map((b) => b.ea_name))].join(',')})`);
          }
          this._lastBackfillAt = Date.now();
        } catch (e) {
          this.log('[backfill] failed: ' + (e?.message || e));
        }
      }
      // 0.5.0 P1: 双写 raw 到 server (跟老 uploadStats 并行，独立失败容错)
      // - balance snapshot: 每次 tick 都写一条 row
      // - deals: snap.deals 全部上传 (server INSERT OR IGNORE by deal_id)
      // 不阻塞主流程 — fire-and-forget
      this._uploadRawSnapshot(snap, magicMap, _curInstId).catch((e) => {
        this.log('[raw upload] failed (non-fatal): ' + (e?.message || e));
      });

      // Stash for the recordRun summary in finally — gives users a real
      // data record per tick instead of "tick #N 完成".
      this._lastTickSnapshot = {
        ts:           t0,
        date:         today,
        balance,
        equity,
        ea_count:     list.length,
        mounted_count: mounted.size,
        items:        liveItems || [],
      };
      this.lastStatus = 'ok';
    } catch (e) {
      this.lastStatus = 'error';
      this.lastError = String(e?.message || e);
      throw e;
    } finally {
      this.lastDuration = Date.now() - t0;
      // 0.3.191 Phase 3: _tickInProgress 由外层 tick() 负责释放, 内层 _tickOnce
      // 不能擅自清掉 — 否则多实例迭代时第一个 instance 一跑完就放锁, 后续 instance 抢不到.
      // Record this tick into scheduler.db's task_runs. Now that the summary
      // contains real per-EA data records (not just "tick #N 完成"), every
      // tick is worth keeping — users want to audit what was uploaded each
      // run. task_runs retention caps at 50/task so we won't grow unbounded.
      try {
        if (this.recordRun) {
          let summary;
          if (this.lastStatus === 'ok') {
            summary = this._formatTickSummary(this._lastTickSnapshot);
          } else if (this.lastStatus === 'mt5_unreachable') {
            summary = `MT5 不可达（${this.lastError || ''}）`;
          } else if (this.lastStatus === 'error') {
            summary = `出错：${this.lastError || ''}`;
          } else {
            summary = String(this.lastStatus);
          }
          this._lastRecordedStatus = this.lastStatus;
          await this.recordRun('sys_stats_collector', 'EA 成绩单采集', {
            status: this.lastStatus,
            summary,
            durationMs: this.lastDuration,
          });
        }
      } catch {}
    }
  }

  /**
   * Format the per-tick summary text the user sees in the 历史 panel.
   * Multi-line so each EA's actual data record is on its own line and
   * readable without horizontal scroll. The header line gives totals;
   * the body lines give per-EA detail for everything that was uploaded.
   */
  _formatTickSummary(snap) {
    if (!snap) return `tick #${this.runCount} 完成`;
    const fmtNum = (n, dp = 2) => (n == null ? '—' : Number(n).toFixed(dp));
    const head = [
      `tick #${this.runCount}  ·  ${snap.date}`,
      `账户余额 ${fmtNum(snap.balance)}  ·  净值 ${fmtNum(snap.equity)}  ·  策略 ${snap.ea_count}  ·  挂载中 ${snap.mounted_count}`,
    ];
    if (!snap.items.length) {
      head.push('（本地有策略但无 opt-in 项需上传到排行榜）');
      return head.join('\n');
    }
    head.push(`已上传到服务端的 ${snap.items.length} 个 opt-in 策略：`);
    for (const it of snap.items) {
      head.push(
        `  · ${it.ea_name.padEnd(24)} `
        + `今日 ${String(it.trades).padStart(3)} 笔 / `
        + `pnl ${fmtNum(it.pnl).padStart(8)} / `
        + `时长 ${fmtNum(it.hours_run, 2).padStart(6)}h / `
        + `回撤 ${fmtNum(it.drawdown_max).padStart(7)}  `
        + `[hash ${(it.ea_hash || '').slice(0, 12)}]`,
      );
    }
    return head.join('\n');
  }

  /**
   * Build today's snapshot rows from current `records` state — used by both
   * the per-tick live upload (_uploadTodaysSnapshot) and the manual
   * "verify leaderboard now" trigger (forceUploadNow). Filters to opt-in
   * EAs only when called from the per-tick path (skipUnoptedIn=true) so
   * we don't waste server bandwidth on entries the user hasn't put on
   * the public board.
   */
  _buildTodaysItems(list, today, balance, { skipUnoptedIn = false, eaSymbolMap = {}, accountLogin = null } = {}) {
    const items = [];
    for (const it of list) {
      if (!it.hash) continue;
      // Source-ownership gate also enforced here (matches the leaderboard
      // opt-in rule): only EAs the user authored / owns the .mq5 for
      // contribute to public stats. Bought-from-market binary-only rows
      // never make it onto the public board even if the user manually
      // POSTed an opt-in.
      if (skipUnoptedIn && !it.lb_optin) continue;
      const rec = this.strategies.records[
        this.strategies._recordKeyFor(it.hash, it.name)
      ] || {};   // 1.1.22: 多副本消歧
      const ea_hash = rec.tracked_ex5_sha256
        || it.mt5_ex5_sha256
        || it.ex5_sha256
        || it.hash;
      const eaName = rec.ea_name || it.name.replace(/\.(mq5|ex5)$/i, '');
      // 0.4.8: 主交易 symbol — getMountedEaSymbols 拿到 eaSymbolMap[ea].symbols 第一个
      // 日志只扫近 7 天: 挂得早又不打日志的 EA 扫不到 → 退到「策略」页配的品种, 否则上传
      // NULL, app「我的策略」品种空 → 匹配不到散户情绪。
      const symbol = eaSymbolMap?.[eaName]?.symbols?.[0]
        || rec.monitor_config?.symbols?.[0]
        || null;
      items.push({
        ea_hash,
        ea_name: eaName,
        symbol,
        // 2026-07-16: 该实例自己的账户号(见 _tickOnce 里的 accountLogin) —— server
        // 用它拆分多账户跑同名/同 hash 策略的数据(此前会被 UNIQUE(license,ea_hash,date,hour)
        // 强行合并覆盖)。老服务端/老 server 忽略这个字段, 零风险。
        account_login: accountLogin,
        date:    today,
        // 0.3.60: 严格用 today_* 不 fallback 累计 —— 老代码 `today_trades || trades`
        // 在今天 0 笔时把累计 trades 当今天的填进去，server SQL `SUM(s.trades)` 跨日
        // 累加→ N 天 × 累计 trades = 巨大乱数。pnl 同样的 bug 让 leaderboard 显出
        // -304.98 USD 单日（实际是 since-anchor 累计亏损被多次相加成奇怪值）。
        // 作者 5/15 反馈「我的策略 +1.6% / 排行榜 -1.3% 反号」根因就是这条。
        trades:           rec.today_trades || 0,
        // hours_run 这里保留累计语义 —— leaderboard SQL 不 SUM hours_run（仅展示），
        // 客户端 admin 列 ea 在线时长用累计更直观。
        hours_run:        it.hours_run     || rec.hours_run || 0,
        pnl:              rec.today_pnl    || 0,
        // pnl_cumulative 是 since-tracked 累计，独立字段，server 不 SUM 它。
        pnl_cumulative:   rec.pnl ?? 0,
        drawdown_max:     rec.max_drawdown || 0,
        account_balance:  balance || 0,
        // 0.3.137: 上传客户端自己算的 pnl_pct + initial_balance —— server 0.4.20
        // 起排行榜 + /v1/strategy-stats/me 都直接用这两个字段（不再 SUM/MIN 聚合），
        // 跟客户端「我的策略」UI 显示的数字完全一致。作者反馈：「排行榜改成基于用户
        // 上传的实时数据就行了，不做单纯统计了」。
        pnl_pct:          rec.pnl_pct ?? null,
        initial_balance:  rec.initial_balance ?? null,
        // 0.3.137: 当日 hour (0-23) — 配 server 新 UNIQUE(license, ea_hash, date, hour)
        // 每小时一条独立 row（同小时多 tick 覆盖，新小时新 row，24 行/天/EA 上限）。
        // 用 local hour (用户视角) — 跟 today 的本地日期同时区，避免日/小时跨时区错位。
        hour:             new Date().getHours(),
        ts:               Math.floor(Date.now() / 1000),
      });
    }
    return items;
  }

  /**
   * Per-tick "live leaderboard" upload. Pushes today's CURRENT running
   * totals for ALL active EAs, every tick. Server upserts on (license,
   * ea_hash, date) so this just refreshes today's row in place.
   *
   * 注：之前是 skipUnoptedIn:true 只上报参与排行榜的 EA — 但 admin 后台
   * 的「当前策略」列查的是 strategy_daily_stats（不依赖 opt-in），少了
   * 这批数据看到的就是「—」，看不到客户实际跑啥。改成上报全部，公开
   * 榜单本身仍由 leaderboard.py 的 INNER JOIN leaderboard_optin 过滤，
   * 不会泄漏未 opt-in 的策略到公开榜。
   *
   * Skipped silently on missing license / unreachable server.
   */
  // ── per-EA floating PnL 时序 ──────────────────────────────────────────
  // 本地长存 + 上传 server 双轨:
  //  • 本地 `<dataDir>/ea_floating_series.json` 滚动留 ~90 天, 给 MCP 工具
  //    `get_floating_drawdown` 离线查 (AI 评估「gmarket 每组马丁的最大浮亏」)。
  //  • server `ea_floating_timeseries` 表给 metric/排行榜算「净值回撤」(多 EA
  //    账号 fallback 到 account-combined 之外, 单 EA 直接读 balance_timeseries.equity)。
  //  • 跟 deals 上传走同一节流: tick 触发一次, 失败静默不影响主流程。
  _eaFloatingPath() {
    if (!this.strategies || !this.strategies.dataPath) return null;
    return path.join(path.dirname(this.strategies.dataPath), 'ea_floating_series.json');
  }

  async _readEaFloatingSeries() {
    const fp = this._eaFloatingPath();
    if (!fp) return { version: 1, by_ea: {} };
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const j = JSON.parse(raw);
      return (j && typeof j === 'object' && j.by_ea && typeof j.by_ea === 'object')
        ? j : { version: 1, by_ea: {} };
    } catch {
      return { version: 1, by_ea: {} };
    }
  }

  async _writeEaFloatingSeries(data) {
    const fp = this._eaFloatingPath();
    if (!fp) return;
    try {
      const { durableWriteFile } = require('./durable-write');
      await durableWriteFile(fp, JSON.stringify(data), { encoding: 'utf8' });
    } catch (e) {
      this.log('[ea-floating] persist err: ' + (e?.message || e));
    }
  }

  /** magic → EA 名, 查 records.monitor_config (用户在「策略」页填的魔术号)。
   *  instanceId = 这份快照取自哪个 MT5 实例: 先只在绑到它的 EA 里找 —— 多个实例复用同一组
   *  magic (实例 A/B 都是 100~104) 时, 全局第一个同 magic 的 EA 是别的实例的, 实例 B 的
   *  成交 / 浮盈会记到实例 A 的 EA 名下。未绑实例的 EA 归 active 实例 (同策略页)。
   *  本实例找不到 / 没有实例上下文 (单实例、rebuild_raw_data) → 全局第一个, 即原行为。 */
  _eaNameForMagic(magic, instanceId = null) {
    if (!magic) return null;
    const st = this.strategies;
    const boundTo = (rec) => (typeof st.getMt5InstanceForEa === 'function'
      ? st.getMt5InstanceForEa(rec.ea_name) : rec.mt5_instance_id) || null;
    let unbound = null;
    let first = null;
    for (const rec of Object.values((st && st.records) || {})) {
      const mc = rec && rec.monitor_config;
      if (!mc || !rec.ea_name) continue;
      const hit = (Array.isArray(mc.magic_numbers) && mc.magic_numbers.includes(magic))
        || Number(mc.magic) === magic;
      if (!hit) continue;
      if (!instanceId) return rec.ea_name;
      const bound = boundTo(rec);
      if (bound === instanceId) return rec.ea_name;
      if (!bound && !unbound) unbound = rec.ea_name;
      if (!first) first = rec.ea_name;
    }
    let activeId = null;
    try { activeId = this.settingsRef?.data?.activeMt5InstanceId || null; } catch {}
    return (instanceId === activeId && unbound) || first;
  }

  /** Aggregate snap.positions by ea_name → {fp, n}.
   *  跟 _uploadRawSnapshot deals 上传同款 magic→ea 解析:
   *  records.monitor_config 优先 (用户在 UI 绑的 magic), 磁盘 magicMap fallback. */
  _computePerEaFloating(snap, magicMap, instanceId = null) {
    const resolveEaName = (magic) => this._eaNameForMagic(magic, instanceId);
    const positions = (snap && snap.positions) || [];
    const agg = new Map();   // ea_name → {fp, n}
    for (const p of positions) {
      const magic = Number(p.magic || 0);
      const ea = resolveEaName(magic) || (magic && magicMap && magicMap[String(magic)]);
      if (!ea) continue;       // 无 magic 归不了属, 同 deals 上传一样跳过
      const pnl = (Number(p.profit) || 0) + (Number(p.swap) || 0);
      const cur = agg.get(ea) || { fp: 0, n: 0 };
      cur.fp += pnl;
      cur.n += 1;
      agg.set(ea, cur);
    }
    return agg;
  }

  /**
   * 0.5.0 P1: Raw 数据上传 (跟 _uploadTodaysSnapshot 并行).
   *
   * 每 tick 上传两种 raw:
   *   1. balance snapshot — 1 row per tick per account
   *   2. deals — snap.deals 全量 (server INSERT OR IGNORE by deal_id, 重复不会写)
   *   3. per-EA floating snapshot — 按 magic 聚合 positions, 本地 + server 双写
   *
   * 调用方应 fire-and-forget — 不要 await，不影响主 tick. 失败静默 log.
   */
  async _uploadRawSnapshot(snap, magicMap, instanceId = null) {
    if (!this.marketplace) return;
    if (!snap || !snap.account || !snap.account.login) return;

    const accountLogin = Number(snap.account.login) || 0;
    if (!accountLogin) return;

    const snapTs = Math.floor((snap.ts || (Date.now() / 1000)));
    const snapTsIso = new Date(snapTs * 1000).toISOString();

    // ---- balance snapshot ----
    try {
      const bal = Number(snap.account.balance) || 0;
      const eq  = Number(snap.account.equity)  || 0;
      if (bal > 0) {
        await this.marketplace.uploadRawBalance([{
          account_login: accountLogin,
          ts: snapTsIso,
          balance: bal,
          equity: eq,
          margin: null,
          free_margin: null,
        }]);
      }
    } catch (e) {
      this.log('[raw balance] upload err: ' + (e?.message || e));
    }

    // ---- per-EA floating PnL snapshot ----
    // 按 magic 聚合 snap.positions, 本地滚动存 90 天 + 上传 server 给排行榜
    // 净值回撤 / AI MCP 工具用。无持仓 EA 跳过 (没必要写 0 行污染时序)。
    try {
      const eaFp = this._computePerEaFloating(snap, magicMap, instanceId);
      if (eaFp.size > 0) {
        // 本地长存 — 给 MCP 工具 get_floating_drawdown 离线查
        const store = await this._readEaFloatingSeries();
        const CAP = 2400;                        // ~100 天 hourly, 留余量
        const cutoff = snapTs - 90 * 86400;
        for (const [ea, agg] of eaFp.entries()) {
          const entry = store.by_ea[ea] || { account_login: accountLogin, points: [] };
          entry.account_login = accountLogin;
          if (!Array.isArray(entry.points)) entry.points = [];
          entry.points.push({
            ts: snapTs,
            fp: Math.round(agg.fp * 100) / 100,
            n: agg.n,
          });
          // trim: 先时间窗, 再硬上限
          entry.points = entry.points.filter((p) => (p.ts || 0) >= cutoff).slice(-CAP);
          store.by_ea[ea] = entry;
        }
        await this._writeEaFloatingSeries(store);
        // server upload (server `INSERT OR IGNORE` by (license,login,ea,ts) 去重)
        if (typeof this.marketplace.uploadRawEaFloating === 'function') {
          const items = [];
          for (const [ea, agg] of eaFp.entries()) {
            items.push({
              account_login: accountLogin,
              ea_name: ea,
              ts: snapTsIso,
              floating_pnl: Math.round(agg.fp * 100) / 100,
              positions_count: agg.n,
            });
          }
          if (items.length > 0) {
            try { await this.marketplace.uploadRawEaFloating(items); }
            catch (e2) { this.log('[ea-floating] upload err: ' + (e2?.message || e2)); }
          }
        }
      }
    } catch (e) {
      this.log('[ea-floating] tick err: ' + (e?.message || e));
    }

    // ---- deals ----
    try {
      const deals = snap.deals || [];
      if (deals.length === 0) return;
      // 0.3.148: 反推 ea_name 优先用 strategies.records (跟 stats-collector 老路径 +
      // 客户端「我的策略」UI 同源)；磁盘 magicMap (runtime.json / .chr) 只做 fallback。
      // 之前 raw 上传只看 magicMap，导致 records.ea_name="VP" 但 magicMap.eaName="VP策略"
      // (EA 自报名跟文件名不一致) 时，server admin EA 详情那行 join 不上 raw 表
      // 显 raw_trades=0/raw_ea_pnl=0，但 license-level 聚合对的。
      const resolveEaName = (magic) => this._eaNameForMagic(magic, instanceId);
      const items = deals.map((d) => {
        const magic = Number(d.magic || 0);
        const eaName = resolveEaName(magic)
          || (magic && magicMap && magicMap[String(magic)])
          || null;
        const dealTs = d.time ? new Date(Number(d.time) * 1000).toISOString() : snapTsIso;
        return {
          account_login: accountLogin,
          deal_id: Number(d.ticket),
          position_id: null,   // snap 暂没字段 (P3 时 python 端补)
          ea_name: eaName,
          magic,
          symbol: d.symbol || null,
          side: d.type === 0 ? 'buy' : (d.type === 1 ? 'sell' : null),
          volume: Number(d.volume) || 0,
          price: null,
          profit: Number(d.profit) || 0,
          swap: Number(d.swap) || 0,
          commission: Number(d.commission) || 0,
          entry: Number(d.entry) || 0,
          ts: dealTs,
        };
      });
      // 分批上传（server 限 max_length=2000，单次 tick 一般几十到几百，没问题）
      const chunk = 1000;
      let totalInserted = 0;
      let totalDup = 0;
      for (let i = 0; i < items.length; i += chunk) {
        const batch = items.slice(i, i + chunk);
        const r = await this.marketplace.uploadRawDeals(batch);
        if (r && r.ok) {
          totalInserted += (r.inserted || 0);
          totalDup += (r.duplicates || 0);
        }
      }
      if (totalInserted > 0) {
        this.log(`[raw deals] uploaded ${totalInserted} new / ${totalDup} dup (out of ${items.length})`);
      }
    } catch (e) {
      this.log('[raw deals] upload err: ' + (e?.message || e));
    }

    // 0.3.148: sync records.tracked_since_ms → server ea_anchors_v2.
    // 用户视角：「EA 几号纳入 EasyDeal 管理 → 排行榜从那天起算业绩」。
    // server _resolve_anchor_ts (0.5.11) 优先读 ea_anchors_v2, 配合此处自动 sync
    // 让 metric() 跨 license-level / leaderboard / admin 全部按 tracked_since 截窗.
    // 失败静默 log — anchor 没同步只是退化到 first_seen_deal, 仍可用.
    try {
      const records = (this.strategies && this.strategies.records) || {};
      const eaToAnchor = new Map();  // ea_name → earliest tracked_since_ms (跨 hash 同名 EA 取最早)
      for (const rec of Object.values(records)) {
        const ea = rec?.ea_name;
        const ms = typeof rec?.tracked_since_ms === 'number' ? rec.tracked_since_ms : null;
        if (!ea || !ms || ms <= 0) continue;
        const prev = eaToAnchor.get(ea);
        if (!prev || ms < prev) eaToAnchor.set(ea, ms);
      }
      for (const [eaName, ms] of eaToAnchor.entries()) {
        const anchorTsIso = new Date(ms).toISOString();
        // 本地去重 — 跟上次同步过的 anchor 一样就跳, 减少 server 写
        if (!this._lastSyncedAnchor) this._lastSyncedAnchor = {};
        const key = `${accountLogin}:${eaName}`;
        if (this._lastSyncedAnchor[key] === anchorTsIso) continue;
        try {
          await this.marketplace.setAnchor({
            eaName,
            accountLogin,
            anchorTs: anchorTsIso,
            anchorBalance: null,         // 不强加 anchor_balance, 让 metric 自己用 balance_timeseries 解析
            anchorSource: 'tracked_since',
          });
          this._lastSyncedAnchor[key] = anchorTsIso;
        } catch (e) {
          // 单 EA 失败不阻断其它 — 静默
        }
      }
    } catch (e) {
      this.log('[anchor sync] err: ' + (e?.message || e));
    }
  }

  async _uploadTodaysSnapshot(list, today, balance, accountLogin = null) {
    if (!this.marketplace) return [];
    // 0.4.8: 拉 eaSymbolMap → _buildTodaysItems 顺带写 symbol 给排行榜显示
    let eaSymbolMap = {};
    try {
      if (this.mt5DataDir && this.strategies?.getMountedEaSymbols) {
        eaSymbolMap = await this.strategies.getMountedEaSymbols(this.mt5DataDir);
      }
    } catch {}
    const items = this._buildTodaysItems(list, today, balance, { skipUnoptedIn: false, eaSymbolMap, accountLogin });
    if (!items.length) return [];
    try {
      await this.marketplace.uploadStats(items);
      // Quiet log — once-per-tick, would flood otherwise.
      this._lastSnapshotErr = null;
      this._lastSnapshotErrAt = 0;
    } catch (e) {
      // Suppress repeated identical errors (e.g. license_required, offline)
      // for up to 10 min — after that re-emit so a still-failing condition
      // is visible in the log instead of being silently swallowed forever.
      const msg = String(e?.message || e);
      const now = Date.now();
      const repeatTtlMs = 10 * 60_000;
      const isRepeat = (msg === this._lastSnapshotErr)
        && ((now - (this._lastSnapshotErrAt || 0)) < repeatTtlMs);
      if (!isRepeat) {
        this.log(`live snapshot upload failed: ${msg}`);
        this._lastSnapshotErr = msg;
        this._lastSnapshotErrAt = now;
      }
    }
    return items;
  }

  /**
   * Manually push CURRENT running totals as a daily snapshot for today's
   * date — same as the per-tick path but unfiltered (uploads every EA
   * with a hash, opt-in or not) and returns a summary. Used for one-off
   * verification ("did my data make it?") and called right after a fresh
   * opt-in click so the leaderboard reflects the change immediately
   * instead of waiting for the next tick.
   */
  async forceUploadNow() {
    if (!this.strategies || !this.marketplace) {
      return { ok: false, error: 'collector not fully initialized' };
    }
    const list = await this.strategies.list({
      mt5DataDir:    this.mt5DataDir,
      mt5InstallDir: this.mt5InstallDir,
    });
    const today = new Date().toISOString().slice(0, 10);
    const balance = this._lastBalance || 0;
    // 0.4.8: 同 _uploadTodaysSnapshot —— 把 eaSymbolMap 喂给 build 函数加 symbol
    let eaSymbolMap = {};
    try {
      if (this.mt5DataDir && this.strategies?.getMountedEaSymbols) {
        eaSymbolMap = await this.strategies.getMountedEaSymbols(this.mt5DataDir);
      }
    } catch {}
    // 2026-07-16: 提前拿一次 snapshot 只为读 account.login（跟 backfill 用的 snap 是
    // 同一份，下面不用重复拉）—— 带给 _buildTodaysItems 让 server 按账户拆分同名策略。
    let accountLoginForForce = null;
    let preSnap = null;
    try {
      preSnap = await this.snapshot();
      accountLoginForForce = Number(preSnap.account && preSnap.account.login) || null;
    } catch {}
    const items = this._buildTodaysItems(list, today, balance, { skipUnoptedIn: false, eaSymbolMap, accountLogin: accountLoginForForce });
    // 0.3.58: 用户点「参与排行榜」立刻触发 forceUploadNow，连带 30 天历史回填，
    // 避免「点完只看到今天 1 天数据，要等几天才填满」体验。
    let backfillCount = 0;
    try {
      const snap = preSnap || await this.snapshot();
      const magicMap = await this._readMagicMap();
      // 0.3.63: 跟 tickAll 同款 — 启发式从 deals 推断 magic，cover「EA 没写 runtime.json 协议」case
      await this._augmentMagicMapByHeuristic(magicMap, snap.deals || []);
      const backfill = await this._buildBackfillItems(list, snap, magicMap, accountLoginForForce);
      if (backfill.length) {
        await this.marketplace.uploadStats(backfill);
        backfillCount = backfill.length;
        this.log(`[force backfill] uploaded ${backfillCount} historical daily rows`);
        this._lastBackfillAt = Date.now();
      }
    } catch (e) {
      this.log('[force backfill] failed: ' + (e?.message || e));
    }
    if (!items.length && !backfillCount) return { ok: true, uploaded: 0, items: [] };
    try {
      if (items.length) await this.marketplace.uploadStats(items);
      this.log(`[force] uploaded ${items.length} live rows + ${backfillCount} backfill rows`);
      return { ok: true, uploaded: items.length + backfillCount,
               live: items.length, backfill: backfillCount, items };
    } catch (e) {
      this.log('[force] upload failed: ' + e.message);
      return { ok: false, error: String(e.message || e), items };
    }
  }

  /**
   * 0.3.58: 历史 daily-stats 回填上传 — 解决「排行榜数据跟我的策略对不上」的根因。
   * 问题：stats-collector 老逻辑每天只上传「今天那一行」 → 服务端 strategy_daily_stats
   * 表里只有「opt-in 那天以后」的 row。leaderboard SQL `SUM(s.trades)` 跨日相加，
   * 自然只能算到这几天的总和。客户端「我的策略」实时查 MT5 history 能看到 30 天
   * 全量，数字大很多 → 用户视感「两边对不上」。
   *
   * 修法：每次有 deals snapshot 时，按日 bucket MT5 deals，per-EA / per-date 重算
   * trades/pnl/dd，UPSERT 到服务端。30 天窗口全开。
   *
   * 性能：每个 EA 最多 30 个日期 row，服务端是 upsert（O(1) per row），通过现有
   * `/v1/strategy-stats/upload` 端点。每次回填 ≈ 30-150 行，bandwidth 极小。
   * 调用：forceUploadNow（用户点参与排行榜后立刻补）+ 每小时 tick 一次（防漂移）。
   */
  async _buildBackfillItems(list, snap, magicMap, accountLogin = null) {
    if (!snap?.deals?.length) return [];
    // Inverse: ea_name → magic
    const eaToMagic = {};
    for (const [m, ea] of Object.entries(magicMap || {})) {
      eaToMagic[ea] = Number(m);
    }
    // 0.4.8: 拉 eaSymbolMap 给 backfill 每条 row 加 symbol
    let eaSymbolMap = {};
    try {
      if (this.mt5DataDir && this.strategies?.getMountedEaSymbols) {
        eaSymbolMap = await this.strategies.getMountedEaSymbols(this.mt5DataDir);
      }
    } catch {}

    const nowSec = Math.floor(Date.now() / 1000);
    const LOOKBACK_DAYS = 30;
    const lookbackFloor = nowSec - LOOKBACK_DAYS * 86400;
    // Helper: epoch sec → 'YYYY-MM-DD' UTC
    const toDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
    // Helper: 'YYYY-MM-DD' → epoch sec (start of UTC day)
    const fromDate = (s) => Math.floor(new Date(s + 'T00:00:00Z').getTime() / 1000);
    // Enumerate every date in [now-30d, now] UTC
    const allDates = [];
    for (let t = lookbackFloor; t <= nowSec; t += 86400) {
      allDates.push(toDate(t));
    }
    // Dedupe (toDate(...) edge case)
    const allDatesUniq = [...new Set(allDates)];

    const items = [];
    const ts = nowSec;
    for (const it of list) {
      if (!it.hash) continue;
      const ea_name = it.name.replace(/\.(mq5|ex5|mqh|set)$/i, '');
      const magic = eaToMagic[ea_name];
      if (magic == null) continue;       // 没 magic → 不能精确归属

      const rec = this.strategies.records[it.hash] || {};
      const initialBalance = rec.initial_balance || 10000;
      const uploadEaHash = rec.tracked_ex5_sha256
        || it.mt5_ex5_sha256
        || it.ex5_sha256
        || it.hash;
      // 0.3.60: backfill 的每条 real row 都填**当前累计 hours_run**（cumulative_hours_by_ea）。
      // 服务端 leaderboard 用 MAX(hours_run) 当「运行时长」列。如果 backfill 写
      // hours_run=24 占位，旧 EA cumulative=120h 但 backfill 没盖到今天那行时，
      // MAX 会变成 24（错），所以全填当前累计最稳。
      const cumHoursRun = it.hours_run || 0;

      // 0.3.59: effective_since 跟 main.js IPC 的 live-stats 路径同款逻辑：
      //   max(now - 30d, load_at - cumulative_hours)
      // 「估算的首次挂载点」，跨升级 / 重挂能保留（cumulative 跨挂载累加）。
      // 客户端「我的策略」的 trades 数就用这个窗口，所以 backfill 也按它收口
      // → 服务端 leaderboard SQL SUM(trades) 跟 live 视图自动一致。
      const cumHoursSec = Math.floor((it.hours_run || 0) * 3600);
      const loadAtSec = it.last_loaded_at_ms
        ? Math.floor(it.last_loaded_at_ms / 1000) : nowSec;
      const firstMountEstimate = loadAtSec - cumHoursSec;
      const effectiveSinceSec = Math.max(lookbackFloor, firstMountEstimate);
      const effectiveSinceDate = toDate(effectiveSinceSec);

      // Group this EA's deals by UTC date
      const byDate = new Map();
      for (const d of snap.deals) {
        if (d.magic !== magic) continue;
        const dateKey = toDate(d.time || 0);
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(d);
      }

      // 遍历整个 30 天窗口，每天都生成一条 row：
      //   - date >= effective_since 且当天有 deals → 真实 rollup
      //   - date < effective_since → 零 row（用来 UPSERT 覆盖老 backfill 留下的过时数据）
      //   - date >= effective_since 但无 deals → 跳过（服务端要么没数据、要么本就是 0）
      let runningPnl = 0;
      let peakPnl = 0;
      let anyRealRow = false;
      for (const date of allDatesUniq) {
        const dayDeals = byDate.get(date);
        const inWindow = date >= effectiveSinceDate;
        if (inWindow && dayDeals) {
          // Real rollup
          let dayPnl = 0;
          let trades = 0;
          for (const d of dayDeals) {
            const realized = (d.profit || 0) + (d.swap || 0) + (d.commission || 0);
            dayPnl += realized;
            if (d.entry === 1) trades += 1;
          }
          runningPnl += dayPnl;
          if (runningPnl > peakPnl) peakPnl = runningPnl;
          const ddDollars = peakPnl - runningPnl;
          const ddFrac = initialBalance > 0 ? ddDollars / initialBalance : 0;
          items.push({
            ea_name,
            ea_hash:         uploadEaHash,
            symbol:          eaSymbolMap?.[ea_name]?.symbols?.[0]    // 0.4.8
              || dayDeals.find((d) => d.symbol)?.symbol || null,   // 日志扫不到 → 当天成交品种
            account_login:   accountLogin,   // 2026-07-16: 见 _buildTodaysItems 同款注释
            date,
            trades,
            hours_run:       cumHoursRun,
            pnl:             Math.round(dayPnl * 100) / 100,
            pnl_cumulative:  Math.round(runningPnl * 100) / 100,
            drawdown_max:    Math.round(ddFrac * 1e6) / 1e6,
            account_balance: Math.round((initialBalance + runningPnl) * 100) / 100,
            ts,
          });
          anyRealRow = true;
        } else if (!inWindow) {
          // 0 row 覆盖老数据（仅在该 EA 至少有一行 real 时才推 zero，避免给从没参榜的 EA 推一堆 0）
          // Defer: 先收集 zero candidates，等遍历完确认 anyRealRow 后再追加
          items.push({
            ea_name,
            ea_hash:         uploadEaHash,
            account_login:   accountLogin,
            date,
            trades:          0,
            hours_run:       0,
            pnl:             0,
            pnl_cumulative:  0,
            drawdown_max:    0,
            account_balance: initialBalance,
            ts,
            _zeroFiller:     true,
          });
        }
      }
      // 如果该 EA 没有任何 real row，移除所有 _zeroFiller（避免 spam zero）
      if (!anyRealRow) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].ea_name === ea_name && items[i]._zeroFiller) items.splice(i, 1);
        }
      }
    }
    // 清掉 _zeroFiller 内部标记（不发到服务端）
    for (const it of items) delete it._zeroFiller;
    return items;
  }

  async _maybeUploadDaily(list, today, balance, accountLogin = null) {
    if (this._lastDailyDate === today) return;
    // Find any EA whose recorded today_date is yesterday — that's the EOD slice.
    const items = [];
    for (const it of list) {
      if (!it.hash) continue;
      const rec = this.strategies.records[
        this.strategies._recordKeyFor(it.hash, it.name)
      ] || {};   // 1.1.22: 多副本消歧
      if (!rec.today_date || rec.today_date >= today) continue;
      const dailyRow = {
        date: rec.today_date,
        trades: rec.today_trades || 0,
        hours_run: rec.today_hours || 0,
        pnl: rec.today_pnl || 0,
        pnl_cumulative: rec.pnl_pct != null && rec.initial_balance
          ? rec.pnl_pct * rec.initial_balance : 0,
        drawdown_max: rec.max_drawdown || 0,
        account_balance: balance,
        ts: Math.floor(Date.now() / 1000),
      };
      // Server's leaderboard JOINs strategy_daily_stats.ea_hash with
      // leaderboard_optin.ea_hash. setLbOptIn uses the .ex5 binary sha
      // (mt5_ex5_sha256 || workspace ex5_sha256). Mirror that priority
      // here so the JOIN actually finds rows. `it.hash` (often the .mq5
      // source hash) was the historical bug — different identity than
      // what optin stored, JOIN always empty.
      const uploadEaHash = rec.tracked_ex5_sha256
        || it.mt5_ex5_sha256
        || it.ex5_sha256
        || it.hash;            // last-resort fallback (legacy rows)
      items.push({
        ea_hash: uploadEaHash,
        ea_name: rec.ea_name || it.name.replace(/\.(mq5|ex5)$/i, ''),
        account_login: accountLogin,   // 2026-07-16: 见 _buildTodaysItems 同款注释
        ...dailyRow,
      });
      // Append to local history (newest first, capped at 365 entries)
      const history = Array.isArray(rec.history) ? rec.history.slice() : [];
      // Drop any existing row with the same date (re-rolling shouldn't dup)
      const filtered = history.filter((h) => h.date !== dailyRow.date);
      filtered.unshift(dailyRow);
      while (filtered.length > 365) filtered.pop();
      // Reset today's slice + persist history
      await this.strategies.recordTelemetry(it.hash, {
        // 1.1.22: 带 ea_name 让 recordTelemetry 路由到本 stem 自己的 record (多副本消歧)
        ea_name: it.name.replace(/\.(mq5|ex5)$/i, ''),
        today_date: today,
        today_trades: 0,
        today_pnl: 0,
        today_hours: 0,
        history: filtered,
      });
    }
    if (items.length && this.marketplace) {
      try {
        await this.marketplace.uploadStats(items);
        this.log(`uploaded ${items.length} daily stats rows for ${items[0].date}`);
        this.lastUploadAt = Date.now();
        this.lastUploadCount = items.length;
      } catch (e) {
        this.log('daily upload failed: ' + e.message);
      }
    }
    this._lastDailyDate = today;
  }
}

module.exports = { StatsCollector };
