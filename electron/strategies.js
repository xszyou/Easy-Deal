// Local strategies — manages the user's own EA source files under
// <workspace>/strategies/. Each strategy is one .mq5 (or folder containing
// one .mq5 + helpers). We track simple local-only "track record" stats in
// strategies.json so the share-gate UI can show progress before the server
// goes live; once the server is up, telemetry verification will replace this.

const fs = require('node:fs/promises');
const fssync = require('node:fs');   // 1.1.22: sync API (existsSync 等) — fs/promises 上没有这些方法
const path = require('node:path');
const crypto = require('node:crypto');
const { shell } = require('electron');

// (SHARE_REQUIREMENTS / can_share were the OLD listing eligibility
// gate — ≥168h running, ≥50 trades, ≤30% drawdown. The new bar is
// ≥24h online + a passing 3-month backtest, enforced server-side in
// routers/listings.py and computed client-side via strategies:eligibility-bundle.
// Keeping the old export around just confused readers; removed.)

class Strategies {
  constructor(workspaceDir, dataDir) {
    this.workspaceDir = workspaceDir;
    this.dir = path.join(workspaceDir, 'strategies');
    this.dataPath = path.join(dataDir, 'strategies.json');
    this.records = {}; // hash -> {hours_run, trades, pnl_pct, max_drawdown, ...}
    // 0.3.17: 按 EA 名累计的运行时长（hash 改变也不清零）。
    // 替换原 `hours_run = now - last_loaded_at` 算法 — 那个一 recompile 就归零，
    // 用户改完 EA 看到 0.0h 很挫败感。新算法每次 list() poll 都增量累加。
    this.cumulativeHoursByEa = {}; // { ea_name: hours_number }
    this._eaLastSeenAt = new Map(); // in-memory only; ea_name → ms tick
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    let raw = null;
    try {
      raw = await fs.readFile(this.dataPath, 'utf8');
    } catch {
      this.records = {};
      this.cumulativeHoursByEa = {};
      return;
    }
    // 0.3.292: 启动备份 — strategies.json 损坏 / fmt 混写丢字段时可 rollback.
    // 跟 settings.js 0.3.288 同款机制. 仅当 file 存在 + 解析前备份, 防 init() 抛
    // 之前没拿到内容. rotate 保 3 份.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const bakPath = `${this.dataPath}.bak-${ts}`;
      await fs.writeFile(bakPath, raw, 'utf8');
      const dir = path.dirname(this.dataPath);
      const baseBak = path.basename(this.dataPath) + '.bak-';
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith(baseBak)).sort();
      while (files.length > 3) {
        const old = files.shift();
        try { await fs.unlink(path.join(dir, old)); } catch {}
      }
    } catch (e) { console.warn('[strategies] startup backup failed:', e?.message || e); }

    try {
      const j = JSON.parse(raw) || {};
      // 0.3.17: 新格式 { records, cumulative_hours_by_ea }；老版本 strategies.json
      // 是 records 平铺 hash:record，向后兼容判断一下。
      // 0.3.292: fallback 分支跑完后**主动 _persistRecords 一次**自愈 — 把平铺格式
      // 回写成正确 {records,cumulative_hours_by_ea} 结构. 防 record* / setMt5*
      // 已修 (0.3.292) 但 strategies.json 自打老版本起就一直被错的格式写入污染,
      // init 不自愈下次又走 fallback. **fallback 不清空 records 字段**, 只是 cumu
      // 那部分历史丢了 (已无法恢复, 自然累加).
      let wasFallback = false;
      if (j && typeof j === 'object' && (j.records !== undefined || j.cumulative_hours_by_ea !== undefined)) {
        this.records = j.records || {};
        this.cumulativeHoursByEa = j.cumulative_hours_by_ea || {};
      } else {
        this.records = j || {};
        this.cumulativeHoursByEa = {};
        wasFallback = true;
      }
      if (wasFallback) {
        try { await this._persistRecords(); } catch (e) {
          console.warn('[strategies] init self-heal persist failed:', e?.message || e);
        }
      }
    } catch {
      this.records = {};
      this.cumulativeHoursByEa = {};
    }
  }

  async _persistRecords() {
    try {
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      const payload = {
        records: this.records,
        cumulative_hours_by_ea: this.cumulativeHoursByEa,
      };
      // 0.4.18: durableWriteSync (fsync+readback+atomic) 替代裸 writeFile —
      // EA 成绩单 records 是 stats-collector 每 tick 写的热点, 裸 writeFile dirty
      // page 没刷盘时进程被杀 → EA 统计 (hours/trades/pnl) 丢.
      require('./durable-write').durableWriteSync(this.dataPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.warn('[strategies] persist failed:', e?.message || e);
    }
  }

  /**
   * 增量累加 EA 的运行时长。每次 list() 对每个 EA 调一次。
   *   - mounted=true，且 _eaLastSeenAt 有上一次时间戳 → 把 delta 加到累计；上限
   *     1 小时（防系统休眠 / debugger 暂停产生几小时的伪增量）
   *   - mounted=true，无上一次时间戳（重启后第一轮） → 只记录时间戳，下轮再加
   *   - mounted=false → 清掉 _eaLastSeenAt，停止累加；用户重挂时自然从零增量开始
   *
   * @returns true if cumulativeHoursByEa[stem] was changed
   */
  _accumulateRuntime(stem, mounted, nowMs) {
    if (!mounted) {
      this._eaLastSeenAt.delete(stem);
      return false;
    }
    const prev = this._eaLastSeenAt.get(stem);
    this._eaLastSeenAt.set(stem, nowMs);
    if (prev === undefined) return false;     // 第一轮 only sample，no accumulation
    const deltaH = (nowMs - prev) / 3_600_000;
    if (deltaH <= 0 || deltaH > 1) return false;   // 拒收异常 delta
    this.cumulativeHoursByEa[stem] = (this.cumulativeHoursByEa[stem] || 0) + deltaH;
    return true;
  }

  /**
   * Detect currently-mounted EAs via two complementary signals:
   *
   *   (a) **runtime.json freshness** — EasyDeal-protocol EAs write
   *       <root>/MQL5/Files/<EA>_runtime.json on every OnTick. mtime
   *       within `freshSec` (default 90s) → mounted.
   *
   *   (b) **MT5 Experts log scan** — every EA (protocol or not) gets these
   *       lines in <root>/Logs/YYYYMMDD.log (terminal log; also mirrored
   *       under <root>/MQL5/Logs/ in some builds):
   *           HH:MM:SS.mmm  Experts  expert <EA> (<symbol>,<period>) loaded successfully
   *           HH:MM:SS.mmm  Experts  expert <EA> (<symbol>,<period>) removed
   *       We scan today + yesterday, keep `loaded - removed` as still-active.
   *       Catches third-party / purchased EAs without runtime.json.
   *
   * "<root>" can be either:
   *   - <MT5_DATA_DIR>           — non-portable install (AppData hash dir)
   *   - <MT5_INSTALL_DIR>        — portable install (when MT5 is started
   *                                with /portable, OR a parallel portable
   *                                copy alongside a regular AppData install)
   * We scan BOTH so detection works regardless of which mode the user runs.
   */
  async _activeMounts({ mt5DataDir, mt5InstallDir, freshSec = 90 } = {}) {
    const info = await this._activeMountInfo({ mt5DataDir, mt5InstallDir, freshSec });
    return info.mounted;
  }

  /**
   * Same scan as `_activeMounts`, but returns extra signals the UI uses to
   * detect "stale running instance":
   *   - `mounted`:        Set<eaName>  — dangling-loaded across all roots
   *   - `lastLoadedAt`:   Map<eaName, unix_ms> — newest "loaded" event,
   *                       used to compare against the deployed .ex5 mtime
   */
  // freshSec evolution:
  //   90s    — too tight, missed mid-session quiet periods → false 未挂载
  //   7d     — too loose, days-old runtime.json files leak as "运行中"
  //            even when MT5 is restarted with no EA attached
  //   6h     — too tight in practice; EAs that don't tick runtime.json
  //            every 6 hours (or are quiet about Print() output) got
  //            wrongly flagged "not running" while clearly trading. User
  //            screenshot showed GMarket detecting 2 open positions while
  //            the strategies tab insisted it wasn't mounted.
  //   24h    — current sweet spot. An EA that's actually alive will tick
  //            runtime.json or emit Print() at least once per day, but a
  //            "MT5 started fresh today with no EA attached" scenario has
  //            zero events in last 24h → correctly未挂载. FX weekends
  //            (48h closed) still fall outside; accepted.
  async _activeMountInfo({ mt5DataDir, mt5InstallDir, freshSec = 24 * 3600 } = {}) {
    const out = {
      mounted: new Set(),
      lastLoadedAt:   new Map(),
      lastUnloadedAt: new Map(),
    };
    const roots = this._candidateRoots(mt5DataDir, mt5InstallDir);
    if (!roots.length) return out;
    const cutoff = Date.now() - freshSec * 1000;

    for (const root of roots) {
      try {
        const fdir = path.join(root, 'MQL5', 'Files');
        const entries = await fs.readdir(fdir);
        for (const fn of entries) {
          const m = fn.match(/^(.+)_runtime\.json$/i);
          if (!m) continue;
          try {
            const st = await fs.stat(path.join(fdir, fn));
            if (st.mtimeMs >= cutoff) out.mounted.add(m[1]);
          } catch {}
        }
      } catch {}

      try {
        const r = await this._scanExpertLogsCached(root);
        for (const n of r.mounted) out.mounted.add(n);
        for (const [ea, ts] of r.lastLoadedAt) {
          const prev = out.lastLoadedAt.get(ea) || 0;
          if (ts > prev) out.lastLoadedAt.set(ea, ts);
        }
        for (const [ea, ts] of r.lastUnloadedAt) {
          const prev = out.lastUnloadedAt.get(ea) || 0;
          if (ts > prev) out.lastUnloadedAt.set(ea, ts);
        }
      } catch {}
    }
    return out;
  }

  /**
   * Build a deduped list of "MT5 root" dirs to scan. A root is any
   * directory that contains an `MQL5/` subtree — could be the AppData
   * hash dir (regular install) or the install dir itself (portable).
   */
  _candidateRoots(mt5DataDir, mt5InstallDir) {
    const out = [];
    const seen = new Set();
    const add = (p) => {
      if (!p) return;
      const norm = path.resolve(p);
      if (seen.has(norm)) return;
      seen.add(norm);
      out.push(norm);
    };
    add(mt5DataDir);
    add(mt5InstallDir);
    // 数据目录错配修 (portable vs 非portable): 同一安装目录, EasyDeal /portable 启动 →
    // 数据进安装目录; 用户手动双击 terminal64.exe → 不带 /portable → 数据进 AppData 的
    // Terminal\<hash> (非portable). 老逻辑只扫 [dataDir, installDir], 漏掉手动启动那次写到
    // AppData 的数据 → EA 明明在跑却判「已停止」. 这里把「origin.txt 指向本安装目录的
    // AppData hash 目录」也加进来扫. 只增加覆盖面, scan 本身有 24h 新鲜度闸 (旧目录的旧
    // mtime / 非今明日志不会命中), 不引入假阳性.
    for (const d of this._appDataTerminalRootsForInstall(mt5InstallDir)) add(d);
    return out;
  }

  /**
   * 给定安装目录, 找出 AppData\Roaming\MetaQuotes\Terminal\<hash> 里 origin.txt 指向
   * 该安装目录的数据目录 (= 这个 MT5 以**非 portable** 方式启动时数据的真实落点).
   * origin.txt 内容是安装路径, 多为 UTF-16 LE BOM. 全程 try/catch, 失败返 []. 30s 缓存.
   */
  _appDataTerminalRootsForInstall(installDir) {
    if (!installDir || process.platform !== 'win32') return [];
    let normInstall;
    try { normInstall = path.resolve(installDir).replace(/\\+$/, '').toLowerCase(); } catch { return []; }
    const now = Date.now();
    if (!this.__adOriginCache || (now - this.__adOriginCache.ts) > 30000) {
      this.__adOriginCache = { ts: now, map: this._scanAppDataOrigins() };
    }
    return this.__adOriginCache.map.get(normInstall) || [];
  }

  /** 扫一遍所有 AppData Terminal\<hash>\origin.txt → Map<normInstall(lower), [dataDir,...]> */
  _scanAppDataOrigins() {
    const fsSync = require('node:fs');
    const map = new Map();
    try {
      const appData = process.env.APPDATA;
      if (!appData) return map;
      const base = path.join(appData, 'MetaQuotes', 'Terminal');
      let ents;
      try { ents = fsSync.readdirSync(base, { withFileTypes: true }); } catch { return map; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name === 'Common' || ent.name === 'Community') continue;
        const dir = path.join(base, ent.name);
        let buf;
        try { buf = fsSync.readFileSync(path.join(dir, 'origin.txt')); } catch { continue; }
        let origin;
        if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) origin = buf.toString('utf16le', 2);
        else if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) origin = buf.toString('utf8', 3);
        else origin = buf.toString('utf8');
        origin = origin.replace(new RegExp(String.fromCharCode(0), 'g'), '').trim();
        if (!origin) continue;
        let normOrigin;
        try { normOrigin = path.resolve(origin).replace(/\\+$/, '').toLowerCase(); } catch { continue; }
        if (!map.has(normOrigin)) map.set(normOrigin, []);
        map.get(normOrigin).push(dir);
      }
    } catch {}
    return map;
  }

  /**
   * Scan today/yesterday MT5 log files for `expert X loaded` vs
   * `expert X removed` and return the set of EA names with a dangling
   * load (no subsequent remove).
   *
   * Where MT5 writes the relevant logs — empirically two locations both
   * carry "Experts" events, so we scan both:
   *   1. <dataDir>/Logs/<YYYYMMDD>.log         — top-level terminal log
   *      (lines like `XX\t0\tHH:MM:SS.mmm\tExperts\texpert <name> (...) loaded successfully`)
   *   2. <dataDir>/MQL5/Logs/<YYYYMMDD>.log    — MQL5-side log
   * UTF-16 LE with BOM in both cases.
   *
   * The `(symbol,period)` part is the EA's instance key — same EA on two
   * charts counts as two instances; we collapse them by EA name.
   */
  async _mountsFromExpertLogs(mt5DataDir) {
    const r = await this._scanExpertLogsCached(mt5DataDir);
    return r.mounted;
  }

  /**
   * Scan MT5 Expert logs and return both:
   *   - `mounted`: Set of EA names with a dangling load (loaded - removed)
   *   - `lastLoadedAt`: Map<eaName, unix_ms> of the latest "loaded successfully"
   *                     event, regardless of whether it was later removed.
   *                     Used to compare against the .ex5 file's mtime so
   *                     we can flag "you recompiled but didn't re-mount".
   *
   * MT5 line format (tab-separated):
   *   XX\tN\tHH:MM:SS.mmm\tExperts\texpert <name> (<sym>,<per>) loaded successfully
   * Date comes from the log file name (YYYYMMDD.log).
   */
  /**
   * 10 秒缓存包装 — _scanExpertLogs 每 tick 会被调多次（list + 启发式 magic
   * 推断；UI 5 秒轮询也跑），扫 14 个 log 文件每次 ~5-50ms，加这层缓存让一个
   * tick 内只扫一次。10 秒 TTL 对 UI「运行中」状态新鲜度影响极小（最多
   * 滞后 5s，logs 本身只在 EA 真有事件时才更新），但 hourly stats tick
   * 的双扫问题彻底解决。
   */
  async _scanExpertLogsCached(mt5DataDir) {
    const key = String(mt5DataDir || '');
    if (!this._scanCacheKey) { this._scanCacheKey = ''; this._scanCacheAt = 0; this._scanCacheVal = null; }
    const now = Date.now();
    if (this._scanCacheKey === key && now - this._scanCacheAt < 10_000 && this._scanCacheVal) {
      return this._scanCacheVal;
    }
    const v = await this._scanExpertLogs(mt5DataDir);
    this._scanCacheKey = key;
    this._scanCacheAt = now;
    this._scanCacheVal = v;
    return v;
  }

  /**
   * 读 MT5「当前活跃 profile」的图表配置(.chr), 返回真正挂在图表上的 EA 名集合。
   * 这是判「运行中」最权威的信号 —— 日志只记 load/remove, 而 MT5 撤 EA 经常不写
   * removed, 导致几天前挂过又撤的 EA 在 72h 窗口内被误判「运行中」(用户实测:
   * GoldGridScalper 早撤了仍显运行中)。.chr 反映 MT5 实际图表状态, 撤掉的不会再出现。
   *   • 活跃 profile = Profiles/Charts/ 下 mtime 最新的子目录(MT5 运行时持续保存活跃的)。
   *   • 每个 <expert>…</expert> 块 expertmode=1 + name 非空 = 挂着的 EA。
   *   • 没 Charts / 解析失败 → 返 null, 调用方回退日志检测(绝不因解析失败误杀真 EA)。
   *   • 活跃 profile 有图表但都没挂 EA → 返空集(确定「没挂」, 不是 null)。
   */
  async _attachedExpertsFromCharts(mt5DataDir) {
    try {
      const chartsDir = path.join(mt5DataDir, 'MQL5', 'Profiles', 'Charts');
      let profs;
      try { profs = await fs.readdir(chartsDir, { withFileTypes: true }); }
      catch { return null; }
      const subdirs = profs.filter((e) => e.isDirectory());
      if (!subdirs.length) return null;
      let active = null, activeMtime = -1;
      for (const d of subdirs) {
        try {
          const st = await fs.stat(path.join(chartsDir, d.name));
          if (st.mtimeMs > activeMtime) { activeMtime = st.mtimeMs; active = d.name; }
        } catch {}
      }
      if (!active) return null;
      const profDir = path.join(chartsDir, active);
      let files;
      try { files = await fs.readdir(profDir); } catch { return null; }
      const chrs = files.filter((f) => /\.chr$/i.test(f));
      // savedAt = .chr 快照落盘时刻(取最新那个)。MT5 常只在退出/切 profile 时写 .chr —
      // 运行中的盘面变化不落盘, 所以 .chr 只能证明「保存那一刻」的状态, 调用方据此判
      // 「EA 是在快照之后才挂上的」→ 不适用否决。
      let savedAt = 0;
      for (const fn of chrs) {
        try { const st = await fs.stat(path.join(profDir, fn)); savedAt = Math.max(savedAt, st.mtimeMs); } catch {}
      }
      if (!chrs.length) return { attached: new Set(), savedAt, symbols: new Map() };
      const attached = new Set();
      const symbols = new Map();   // EA → Set<图表品种>(数据大屏 K 线: 日志里找不到在跑图表时兜底)
      for (const fn of chrs) {
        let text;
        try { text = await this._readMaybeUtf16(path.join(profDir, fn)); } catch { continue; }
        // 图表级 symbol= 在文件开头(<expert>/<window> 之前), 第一处就是图表品种
        const chartSym = (/(?:^|\n)\s*symbol\s*=\s*([^\r\n]+)/i.exec(text) || [])[1]?.trim() || null;
        const re = /<expert>([\s\S]*?)<\/expert>/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const block = m[1];
          const mode = /(?:^|\n)\s*expertmode\s*=\s*(\d+)/i.exec(block);
          if (!mode || mode[1] !== '1') continue;     // expertmode=0 → 该图表没挂 EA
          const nm = /(?:^|\n)\s*name\s*=\s*([^\r\n]+)/i.exec(block);
          if (!nm) continue;
          const stem = String(nm[1]).trim().replace(/\.(ex5|mq5)$/i, '');
          if (!stem) continue;
          attached.add(stem);
          if (chartSym) {
            if (!symbols.has(stem)) symbols.set(stem, new Set());
            symbols.get(stem).add(chartSym);
          }
        }
      }
      return { attached, savedAt, symbols };
    } catch { return null; }
  }

  async _scanExpertLogs(mt5DataDir) {
    // Scan the last 7 days of log files. We used to look only at today +
    // yesterday, but MT5 doesn't write a log on idle days — if the user
    // attached an EA last week and the market was closed, today's log is
    // empty and we'd wrongly conclude "no EAs mounted". 7-day window
    // catches the last load event even after a long quiet period.
    const today = new Date();
    const fmtDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const dateFiles = [];
    for (let back = 7; back >= 0; back -= 1) {
      const d = new Date(today.getTime() - back * 86400_000);
      dateFiles.push({ date: fmtDate(d), d });
    }
    const dirs = [
      path.join(mt5DataDir, 'Logs'),
      path.join(mt5DataDir, 'MQL5', 'Logs'),
    ];

    // Per-instance dangling tracker: key="EA(sym,per)" → { ea, state }
    const instances = new Map();
    const lastLoadedAt   = new Map();   // eaName → unix ms (most recent load)
    const lastUnloadedAt = new Map();   // eaName → unix ms (most recent unload)
    const lastActivityAt = new Map();   // eaName → unix ms (any log line — load OR runtime print OR error)
    // eaName → Set of symbols this EA was seen on（来自 load 事件 + activity 行）
    // 用来做 magic 反推：MT5 日志没直接写 magic，但能告诉我们 EA 挂在哪个
    // symbol 上；配合 deals 列表（每条带 magic）就能算出「这个 symbol 上
    // 挂载之后开的单 magic 出现频次最高的那个 = 这只 EA 的 magic」。
    const eaSymbols = new Map();
    // 数据大屏 K 线: 按图表(EA + 品种 + 周期)记各自最近的 load / remove / 活动时刻,
    // 推出「现在挂着 EA 的图表是哪些品种」—— eaSymbols 是 7 天里出现过的全部品种, 撤掉的也在里面。
    const charts = new Map();   // "EA(sym,per)" → { ea, symbol, loadedAt, removedAt, activityAt }

    // EA 名字可能包含括号（Windows 复制粘贴时自动加的 (1) 后缀）和中文，
    // 之前的 [^\s()]+ 把含括号的名字直接挡掉，[A-Za-z]\w* 把中文名字挡掉。
    // 改用 lazy 匹配 + 用稳定的 (sym,period) 锚点反推：
    //   - expRe: `expert VP策略(1) (XAUUSDm,H1) loaded successfully` 也能识别
    //   - activityRe: `\tVP策略(1) (XAUUSDm,H1)\t...` 也能识别
    const expRe = /\bexpert\s+(.+?)\s+\(([^,)]+,[^)]+)\)\s+(loaded successfully|removed|加载成功|已移除|moved to)/i;
    // Generic "EA activity" line: MT5 logs each EA's print() / error like
    //   `KX\t0\t10:33:47.816\tGMarket (XAUUSDm,H1)\t重载：...`
    // i.e. <CODE>\t<SEV>\t<TIME>\t<NAME> (<SYMBOL>,<PERIOD>)\t<MSG>.
    // This catches EAs that were attached BEFORE the 7-day log window
    // (so the original "loaded successfully" line is gone) but are still
    // actively running and writing log lines.
    const activityRe = /\t([^\s\t]+?)\s*\(([^,)]+,[^)]+)\)\t/;
    const timeRe = /\b(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

    for (const dir of dirs) {
      for (const { date, d } of dateFiles) {
        const fp = path.join(dir, date + '.log');
        let text;
        try { text = await this._readMaybeUtf16(fp); } catch { continue; }
        if (!text) continue;

        for (const line of text.split(/\r?\n/)) {
          // Try the explicit load/remove regex first.
          const em = expRe.exec(line);
          let eaName, isLoad = false, isUnload = false;
          let parsedSymbol = null;
          let chartKey = null;
          if (em) {
            eaName = em[1];
            const inst = `${eaName}(${em[2]})`;
            chartKey = inst;
            const verb = em[3].toLowerCase();
            isLoad   = /loaded|加载成功/.test(verb);
            isUnload = /removed|已移除|moved to/.test(verb);
            if (isLoad)   instances.set(inst, { ea: eaName, state: 'loaded' });
            if (isUnload) instances.set(inst, { ea: eaName, state: 'removed' });
            // em[2] 形如 "EURUSD,H1"; symbol 是 "," 之前的部分
            const symMatch = String(em[2]).split(',')[0]?.trim();
            if (symMatch) parsedSymbol = symMatch;
          } else {
            // Fall back to generic activity line — gives us evidence of an
            // EA that's running but whose load event has aged out of window.
            const am = activityRe.exec(line);
            if (am) {
              eaName = am[1];
              chartKey = `${eaName}(${am[2]})`;
              const symMatch = String(am[2]).split(',')[0]?.trim();
              if (symMatch) parsedSymbol = symMatch;
            }
          }
          if (!eaName) continue;
          if (parsedSymbol) {
            let s = eaSymbols.get(eaName);
            if (!s) { s = new Set(); eaSymbols.set(eaName, s); }
            s.add(parsedSymbol);
          }

          // Capture timestamp
          const tm = timeRe.exec(line);
          if (!tm) continue;
          const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                              parseInt(tm[1], 10), parseInt(tm[2], 10),
                              parseInt(tm[3], 10),
                              tm[4] ? parseInt(tm[4].padEnd(3, '0'), 10) : 0).getTime();
          // Always update activity time
          const prevAct = lastActivityAt.get(eaName) || 0;
          if (ts > prevAct) lastActivityAt.set(eaName, ts);
          if (isLoad) {
            const prev = lastLoadedAt.get(eaName) || 0;
            if (ts > prev) lastLoadedAt.set(eaName, ts);
          }
          if (isUnload) {
            const prev = lastUnloadedAt.get(eaName) || 0;
            if (ts > prev) lastUnloadedAt.set(eaName, ts);
          }
          if (chartKey && parsedSymbol) {
            let ch = charts.get(chartKey);
            if (!ch) {
              ch = { ea: eaName, symbol: parsedSymbol, loadedAt: 0, removedAt: 0, activityAt: 0 };
              charts.set(chartKey, ch);
            }
            const field = isLoad ? 'loadedAt' : (isUnload ? 'removedAt' : 'activityAt');
            if (ts > ch[field]) ch[field] = ts;
          }
        }
      }
    }

    // 72h recency cutoff — applied to BOTH signals.
    //   • MT5 doesn't emit "removed" when it shuts down. So a "loaded"
    //     event from 4+ days ago would still mark the EA mounted via
    //     Signal A even after MT5 was restarted with no EA today.
    //   • Old activity lines (Signal B) likewise leak. User reported:
    //     "started MT5 today without loading any EA, GMarket still
    //     shows 运行中" — that's stale 4-day-old logs being trusted.
    //   • 6h → 24h → 72h 历史：
    //     - 6h：真在跑的 EA 经常 6h 内不 print/不写 runtime.json，被误
    //       判成"未运行"。太严。
    //     - 24h：周末停盘（FX 周六凌晨 ~ 周一凌晨约 60h 没 tick）EA 合
    //       法 idle，被误判成"未运行"。0.3.2 用户实际反馈："周日打开
    //       EA 显示「无」，就是停盘日志没更新"。
    //     - 72h：覆盖整个周末 + 大多数节假日。原来"4 天前 stale 日志"
    //       误判仍然能挡（>72h）。trade-off 更合适。
    const RECENT_MS = 72 * 3600 * 1000;
    const recentCutoff = Date.now() - RECENT_MS;

    // 在跑 EA(最终的 mounted 集合)各自挂着的图表品种: 图表最近一次 load / 活动晚于 remove 且在 72h 内;
    // 日志里找不到在跑图表的(挂得早、最近又没打日志)用 .chr 里该 EA 所在图表的品种兜底。
    const chartSymbolsOf = (mountedSet, chrSymbols) => {
      const out = new Map();   // EA → Set<品种>
      const add = (ea, sym) => {
        if (!out.has(ea)) out.set(ea, new Set());
        out.get(ea).add(sym);
      };
      for (const ch of charts.values()) {
        if (!mountedSet.has(ch.ea)) continue;
        const last = Math.max(ch.loadedAt, ch.activityAt);
        if (last > ch.removedAt && last >= recentCutoff) add(ch.ea, ch.symbol);
      }
      for (const ea of mountedSet) {
        if (out.has(ea)) continue;
        for (const sym of (chrSymbols && chrSymbols.get(ea)) || []) add(ea, sym);
      }
      return out;
    };

    const mounted = new Set();
    // Signal A: explicit `loaded successfully` not followed by `removed`,
    // AND the load event itself is recent (last 24h).
    for (const v of instances.values()) {
      if (v.state !== 'loaded') continue;
      const loadTs = lastLoadedAt.get(v.ea) || 0;
      if (loadTs < recentCutoff) continue;     // load too stale
      mounted.add(v.ea);
    }
    // Signal B: activity-line based detection — catches EAs whose
    // original load event has aged out of the 7-day scan window.
    // Same recency requirement.
    for (const [ea, actTs] of lastActivityAt) {
      if (mounted.has(ea)) continue;
      const unloadTs = lastUnloadedAt.get(ea) || 0;
      if (actTs <= unloadTs) continue;
      if (actTs < recentCutoff) continue;
      mounted.add(ea);
    }
    // .chr 当前图表交叉验证 —— 修「撤了 EA 但 MT5 没记 removed → 72h 窗口内误判运行中」。
    // .chr 是 MT5 实际图表状态(权威): 真挂着的才算运行中。grace 给刚挂上还没存进 .chr 的
    // (最近 load/activity 兜)。.chr 解析不出(null)→ 保持纯日志检测, 绝不回归。
    try {
      const chrRes = await this._attachedExpertsFromCharts(mt5DataDir);
      if (chrRes) {
        const { attached, savedAt } = chrRes;
        const GRACE = 30 * 60 * 1000;
        const now = Date.now();
        const result = new Set(attached);
        for (const ea of mounted) {
          const loadedAt = lastLoadedAt.get(ea) || 0;
          const ts = Math.max(loadedAt, lastActivityAt.get(ea) || 0);
          if (now - ts <= GRACE) result.add(ea);   // 刚挂上(.chr 还没保存)的宽限
          // 1.3.14: .chr 是「保存那一刻」的快照(MT5 常只在退出/切 profile 时落盘, 运行中
          // 不更新)。EA 在快照**之后**才 load 的, .chr 不可能知道它 → 不适用否决。
          // 修实测 bug: 昨天的陈旧 .chr(无 expert 块) + 今天 21:12 挂上后安静不打日志的
          // GoldTrendHedge(日志 loaded 无 removed), 30min 宽限一过被误判「已停止」。
          // 原防误报目标不回归: 撤了没记 removed 的旧 EA, 其 load 早于 .chr 快照 → 仍被否。
          if (loadedAt > savedAt) result.add(ea);
        }
        return { mounted: result, lastLoadedAt, lastUnloadedAt, lastActivityAt, eaSymbols,
          chartSymbols: chartSymbolsOf(result, chrRes.symbols) };
      }
    } catch {}
    return { mounted, lastLoadedAt, lastUnloadedAt, lastActivityAt, eaSymbols,
      chartSymbols: chartSymbolsOf(mounted, null) };
  }

  /**
   * 给 stats-collector 用：拿当前所有从日志能推出的「EA → symbol（s）」
   * 映射 + 「EA → 最近一次 load 的 ts」。stats-collector 拿这个去 deals
   * 列表里反推 magic（symbol 上 mount_time 之后开的单 magic 出现频次最
   * 高的就是这只 EA 的 magic）。
   */
  async getMountedEaSymbols(mt5DataDir) {
    const r = await this._scanExpertLogsCached(mt5DataDir);
    const out = {};
    for (const [ea, syms] of r.eaSymbols.entries()) {
      out[ea] = {
        symbols: [...syms],
        last_loaded_at: r.lastLoadedAt.get(ea) || 0,
        last_activity_at: r.lastActivityAt.get(ea) || 0,
      };
    }
    return out;
  }

  /**
   * 数据大屏 K 线: 该 MT5 实例现在挂着 EA 的图表品种(去重)。扫法同「运行中」判定
   * (日志 load/remove/活动 + .chr 当前图表), 覆盖该实例的全部数据目录(见 _candidateRoots)。
   */
  async runningChartSymbols({ mt5DataDir, mt5InstallDir } = {}) {
    const out = new Set();
    for (const root of this._candidateRoots(mt5DataDir, mt5InstallDir)) {
      try {
        const r = await this._scanExpertLogsCached(root);
        for (const syms of r.chartSymbols.values()) for (const sym of syms) out.add(sym);
      } catch {}
    }
    return [...out];
  }

  /**
   * Debug helper — returns where we looked and what we found, so the user
   * can see mid-pipeline state when "运行中" doesn't show up as expected.
   */
  async debugMountDetect(mt5DataDir, mt5InstallDir) {
    const out = {
      mt5_data_dir:    mt5DataDir    || null,
      mt5_install_dir: mt5InstallDir || null,
      roots:           [],
      candidates:      [],
      runtime_json_hits: [],
      live_set:          [],
    };
    const roots = this._candidateRoots(mt5DataDir, mt5InstallDir);
    out.roots = roots;
    if (!roots.length) return out;

    const cutoff = Date.now() - 90_000;
    const today = new Date();
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.log`;
    const fnames = [];
    for (let back = 7; back >= 0; back -= 1) {
      fnames.push(fmt(new Date(today.getTime() - back * 86400_000)));
    }

    for (const root of roots) {
      try {
        const fdir = path.join(root, 'MQL5', 'Files');
        const entries = await fs.readdir(fdir);
        for (const fn of entries) {
          const m = fn.match(/^(.+)_runtime\.json$/i);
          if (!m) continue;
          try {
            const st = await fs.stat(path.join(fdir, fn));
            out.runtime_json_hits.push({
              root,
              ea: m[1],
              mtime: new Date(st.mtimeMs).toISOString(),
              fresh: st.mtimeMs >= cutoff,
            });
          } catch {}
        }
      } catch {}

      for (const subdir of ['Logs', path.join('MQL5', 'Logs')]) {
        for (const fn of fnames) {
          const fp = path.join(root, subdir, fn);
          const entry = { path: fp, exists: false };
          try {
            const st = await fs.stat(fp);
            entry.exists = true;
            entry.size = st.size;
            entry.mtime = new Date(st.mtimeMs).toISOString();
            const text = await this._readMaybeUtf16(fp);
            const re = /\bexpert\s+([^\s()]+)\s*\(([^)]+)\)\s+(loaded successfully|removed|加载成功|已移除|moved to)/gi;
            let m;
            const events = [];
            while ((m = re.exec(text)) !== null) {
              events.push({ ea: m[1], inst: m[2], verb: m[3] });
            }
            entry.events = events;
          } catch (e) {
            entry.error = String(e?.message || e);
          }
          out.candidates.push(entry);
        }
      }
    }

    const live = await this._activeMounts({ mt5DataDir, mt5InstallDir });
    out.live_set = [...live];
    return out;
  }

  /**
   * Read a text file that may be UTF-16 LE (MT5 logs) or UTF-8.
   * Detect BOM; otherwise heuristic on null-byte ratio.
   */
  async _readMaybeUtf16(fp) {
    const buf = await fs.readFile(fp);
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      return buf.slice(2).toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return buf.slice(3).toString('utf8');
    }
    // Heuristic: if every other byte is 0 in the head, treat as UTF-16LE.
    const sample = buf.slice(0, Math.min(buf.length, 256));
    let zeros = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
    if (zeros > sample.length / 4) return buf.toString('utf16le');
    return buf.toString('utf8');
  }

  // 0.3.220: list() 多接受 mt5InstancesList = [{id, dataDir, installDir}, ...]
  // 让每只 EA 按它 mt5_instance_id 绑定的实例算 mount 状态 + verify_against_mt5,
  // 不再全部按 default instance 算. 没传 list / EA 没绑 / 绑了但 list 里没找到 →
  // fallback 到 (mt5DataDir, mt5InstallDir) 默认实例 (老 caller 完全兼容).
  // 0.3.234: 多接受 defaultRunning (bool) — 默认 instance MT5 进程是否在跑.
  // EA 没显式绑 instance (走默认) 时用此 flag 算 mt5_running. 不传 → 默认 true (老行为).
  async list({ mt5DataDir, mt5InstallDir, mt5InstancesList = [], defaultRunning = true } = {}) {
    let entries;
    try { entries = await fs.readdir(this.dir, { withFileTypes: true }); }
    catch { return []; }

    // Group files by stem so .mq5 and .ex5 of the same EA collapse into one row.
    const byStem = new Map();
    const collect = (absPath, displayName, fname) => {
      const m = fname.match(/^(.+?)\.(mq5|mqh|ex5|set)$/i);
      if (!m) return;
      const stem = m[1];
      const ext = m[2].toLowerCase();
      if (!byStem.has(stem)) byStem.set(stem, { stem, files: {}, displayBase: displayName.replace(/\.(mq5|mqh|ex5|set)$/i, '') });
      byStem.get(stem).files[ext] = { absPath, displayName };
    };

    for (const ent of entries) {
      if (ent.isFile()) {
        collect(path.join(this.dir, ent.name), ent.name, ent.name);
      } else if (ent.isDirectory()) {
        // 0.3.31: 跳过 internal scaffolding 子目录 ——
        //   _backups/   AI 改 EA 前自动存的旧版本（<EA>_<ts>_pre_<reason>.mq5）
        //   .versions/  0.3.22 起每次回测前的源码快照
        //   .anything   隐藏 dir 通用约定（cache / git 等）
        // 不显示在主列表里避免迭代多了一脸 backup 文件。要恢复用文件浏览器
        // 直接进 workspace/strategies/_backups/ 找。
        if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
        try {
          const inner = await fs.readdir(path.join(this.dir, ent.name));
          for (const fn of inner) {
            collect(path.join(this.dir, ent.name, fn),
                    `${ent.name}/${fn}`, fn);
          }
        } catch {}
      }
    }

    const defaultMountInfo = await this._activeMountInfo({ mt5DataDir, mt5InstallDir });
    // 0.3.220: per-EA-instance mountInfo map. 每个 instance 单独跑一次扫描
    // (并发 await). 没 list / list 为空时 fallback 用 defaultMountInfo, 老行为.
    // 0.3.230: 同时记 inst.running (caller 传进来的 MT5 进程状态), 用于 gate
    // is_mounted — MT5 关了不算运行中.
    const mountInfoById = new Map();   // instId → { mi, dataDir, installDir, running }
    if (Array.isArray(mt5InstancesList) && mt5InstancesList.length) {
      await Promise.all(mt5InstancesList.map(async (inst) => {
        if (!inst?.id) return;
        // 跳过默认实例 (跟 default 同 dataDir 就别重复扫)
        if (inst.dataDir === mt5DataDir && inst.installDir === mt5InstallDir) {
          mountInfoById.set(inst.id, {
            mi: defaultMountInfo, dataDir: mt5DataDir, installDir: mt5InstallDir,
            running: inst.running !== false,   // undefined → 老 caller, 兼容默认 true
          });
          return;
        }
        try {
          const mi = await this._activeMountInfo({
            mt5DataDir: inst.dataDir, mt5InstallDir: inst.installDir,
          });
          mountInfoById.set(inst.id, {
            mi, dataDir: inst.dataDir, installDir: inst.installDir,
            running: inst.running !== false,
          });
        } catch {}
      }));
    }
    const nowMs = Date.now();
    let persistNeeded = false;   // 0.3.17: 累计时长有变就回写 strategies.json

    const out = [];
    for (const grp of byStem.values()) {
      // Prefer source for description; fall back to compiled.
      const primary =
        grp.files.mq5 || grp.files.ex5 || grp.files.mqh || grp.files.set;
      if (!primary) continue;
      const desc = await this._describe(primary.absPath, primary.displayName);
      // Annotate which artefacts exist
      desc.has_source   = !!grp.files.mq5;
      // 1.2.37: .ex5 存在但源码(.mq5)被改得更新(外部编辑 / AI 改源码) → 算「需重编」,
      // has_compiled=false 让挂载走重新编译路径。否则 EasyDeal 一直复用旧 .ex5,
      // 改了源码点挂载也不生效(用户实测: 外部改托管策略代码后挂载没重编)。
      // 纯 .ex5(买来的策略, 无 .mq5 源)保持 true。
      let _ex5Fresh = !!grp.files.ex5;
      if (grp.files.ex5 && grp.files.mq5) {
        try {
          const _fs = require('node:fs');
          const _exM = _fs.statSync(grp.files.ex5.absPath).mtimeMs;
          const _mqM = _fs.statSync(grp.files.mq5.absPath).mtimeMs;
          if (_mqM > _exM + 1000) _ex5Fresh = false;   // 源码比 .ex5 新 >1s → 过期
        } catch {}
      }
      desc.has_compiled = _ex5Fresh;
      desc.ex5_stale    = !!grp.files.ex5 && !_ex5Fresh;   // UI 可提示「源码已改, 挂载会重编」
      desc.kind = grp.files.mq5
        ? 'source'
        : (grp.files.ex5 ? 'compiled' : 'partial');

      // 0.3.344: 如果该 EA 的 monitor_config 完全没设过 (AI 新建策略 / 用户拖
      // .mq5 进 workspace 还没编辑过), parse .mq5 源码拿 magic + symbol 自动填
      // 进去, 让 UI 不再显红色「未配 ✎」. 用户编辑时会看到预填值, 可覆盖.
      // 只在 monitor_config null + 有 .mq5 + parse 出非空字段时持久化, 避免
      // 把空 config 强写覆盖未来 record.
      // 1.2.8: 条件从「严格 null」放宽到「没有可用 magic」— 实测大量老 record
      // monitor_config 存在但 magic_numbers 空, parse 永远不触发 → relay 持仓
      // 归属的 magic→EA 映射常年空表(订单错归第一个同 magic EA 的根因之一)。
      // merge 写入: 已有字段(用户手填的 symbols 等)保留, 只补缺。
      const _mcHasMagic = (mc) => !!(mc && ((Array.isArray(mc.magic_numbers) && mc.magic_numbers.length) || mc.magic));
      if (!_mcHasMagic(desc.monitor_config) && grp.files.mq5 && desc.hash) {
        try {
          const parsed = await this._parseMq5InputDefaults(grp.stem);
          if (parsed.magic || parsed.symbol) {
            const prev = desc.monitor_config || {};
            const initCfg = {
              symbols:          (Array.isArray(prev.symbols) && prev.symbols.length) ? prev.symbols : (parsed.symbol ? [parsed.symbol] : []),
              magic:            prev.magic || parsed.magic || 0,
              magic_numbers:    (Array.isArray(prev.magic_numbers) && prev.magic_numbers.length) ? prev.magic_numbers : (parsed.magic ? [parsed.magic] : []),
              commentContains:  prev.commentContains || [],
              commentExcludes:  prev.commentExcludes || [],
              updated_at:       Date.now(),
            };
            // 直接写到该 hash 的 record (不走 setMonitorConfig 因为它要求
            // 已经有 records[hash], 而 AI 新建策略可能 stats-collector 还没 tick
            // 出该 hash). 1.1.22: 用 _recordKeyFor 消歧 — 之前多份相同副本在这里
            // 轮流把同一条 record 的 ea_name 改成自己(每次 list 都互抢), 是串号主因。
            const rkey = this._recordKeyFor(desc.hash, grp.stem);
            this.records[rkey] = {
              ...(this.records[rkey] || {}),
              ea_name: grp.stem,
              monitor_config: initCfg,
              updated_at: Date.now(),
              _monitor_config_auto: true,  // 标记是 parse 来的, debug 用
            };
            desc.monitor_config = initCfg;
            persistNeeded = true;
            // dump JSON 给 Python 端读 (异步, 不阻塞 list 主流程; 失败也无所谓
            // 下次 list 还会重试)
            this._dumpMonitorConfigJson().catch(() => {});
          }
        } catch (e) {
          console.warn('[strategies] auto-parse monitor_config failed for', grp.stem, e?.message || e);
        }
      }

      // 0.3.220: 按 EA 绑定的 mt5_instance_id 选 mountInfo + dataDir/installDir.
      // 没绑 / 绑了但没传 list / list 里没找到 → fallback 到默认实例.
      const boundInstId = this.getMt5InstanceForEa(grp.stem);
      const bound = boundInstId ? mountInfoById.get(boundInstId) : null;
      const useMountInfo  = bound ? bound.mi          : defaultMountInfo;
      const useDataDir    = bound ? bound.dataDir     : mt5DataDir;
      const useInstallDir = bound ? bound.installDir  : mt5InstallDir;
      const live           = useMountInfo.mounted;
      const lastLoadedAt   = useMountInfo.lastLoadedAt;
      const lastUnloadedAt = useMountInfo.lastUnloadedAt;
      // 透出 resolved path 让 UI debug + 让 caller 能复用 (e.g. 挂载/打开按钮按 EA 走对应实例)
      desc.resolved_mt5_data_dir    = useDataDir || null;
      desc.resolved_mt5_install_dir = useInstallDir || null;

      // 0.3.230: 绑定实例 MT5 是否在跑. 用户反馈「GMarket EA MT5 都没开还显示运行中」
      // 根因 — 之前只看日志推断挂载状态, 不看 MT5 进程死活. 现在 UI 可拿这个字段
      // 区分「运行中」vs「MT5 未启动」.
      // 0.3.234: bound=null (EA 没绑显式 instance, 走默认) 时用 defaultRunning 兜底,
      // 而不是硬编码 true — 否则默认 MT5 已停止时这种 EA 仍误显「运行中」.
      desc.mt5_running = bound ? !!bound.running : !!defaultRunning;
      desc.is_mounted_in_log = live.has(grp.stem);
      // 「真正运行中」= 日志说挂载着 AND MT5 进程在跑. 老 UI 仍用 is_mounted 字段,
      // 这里把它从「日志推断」改成「日志推断 AND 进程在跑」, UI 无改动也能受益.
      desc.is_mounted = desc.is_mounted_in_log && desc.mt5_running;

      // 0.3.17: 累计运行时长按 EA 名走（不按 hash），改完源码 recompile
      // 不再清零。算法在 _accumulateRuntime 里 —— 每次 list() poll 增量加；
      // mounted=false 时停止加，重挂时自然恢复。
      // 兼容数据迁移：第一次见到这只 EA 但累计是 0，且日志有 loaded 事件 ──
      // 用 (now - last_loaded_at) seed 一次，避免老用户升级到 0.3.17 看到
      // hours_run 直接归零的回归。
      const loadedTs   = lastLoadedAt.get(grp.stem)   || 0;
      const unloadedTs = lastUnloadedAt.get(grp.stem) || 0;
      desc.last_loaded_at_ms   = loadedTs   || null;
      desc.last_unloaded_at_ms = unloadedTs || null;
      const accChanged = this._accumulateRuntime(grp.stem, desc.is_mounted, nowMs);
      if (accChanged) persistNeeded = true;
      if ((this.cumulativeHoursByEa[grp.stem] || 0) === 0 && loadedTs) {
        // 迁移兜底：从日志推一个初始值
        const endTs = desc.is_mounted ? nowMs : (unloadedTs > loadedTs ? unloadedTs : nowMs);
        const seedH = Math.max(0, (endTs - loadedTs) / 3_600_000);
        if (seedH > 0) {
          this.cumulativeHoursByEa[grp.stem] = seedH;
          persistNeeded = true;
        }
      }
      desc.hours_run = this.cumulativeHoursByEa[grp.stem] || 0;

      // Anti-swap: also compute the .ex5's full sha256 (when it exists) so
      // the listing dialog can compare it against MT5/Experts. The primary's
      // hash above is whatever the user opens "first" (.mq5 if present),
      // which isn't the upload binary.
      if (grp.files.ex5) {
        try {
          const buf = await fs.readFile(grp.files.ex5.absPath);
          desc.ex5_sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          desc.ex5_path = grp.files.ex5.absPath;
        } catch {}
      }
      // Cross-check against the binary actually deployed in MT5/Experts.
      // We do this for EVERY row (not just ones with workspace .ex5),
      // because Claude's compile_strategy MCP writes .ex5 ONLY into MT5,
      // not back to workspace — and we still need the mtime to detect a
      // stale running instance.
      // 0.3.220: 用 useDataDir/useInstallDir (按 EA 绑定 resolve), 没绑回 default
      if (useDataDir || useInstallDir) {
        const v = await this._verifyAgainstMt5(grp.stem, useDataDir, desc.ex5_sha256, useInstallDir);
        desc.mt5_ex5_sha256 = v.mt5_ex5_sha256;
        desc.mt5_ex5_path   = v.mt5_ex5_path;
        desc.mt5_ex5_mtime  = v.mt5_ex5_mtime;
        desc.hash_match     = v.match;       // null = MT5 file missing; true/false = compared
      }
      // 0.3.238: is_deployed — 数据目录 MQL5/Experts/<EA>.ex5 文件存在.
      // 比 is_mounted_in_log (扫日志) 更稳定: MT5 关了之后 ex5 文件仍在 → 反映「上次部署到位」,
      // 不会因 MT5 暂停而误判「未部署」. 状态 chip 用这个 + mt5_running 组合判断.
      // 完整三态: is_deployed && mt5_running → 运行中绿色 / is_deployed && !mt5_running → ○ MT5 未启动灰
      // / !is_deployed → 无 chip (未部署, EA 还没挂到 MT5).
      desc.is_deployed = !!desc.mt5_ex5_sha256;
      // 0.3.238: is_mounted 字段重定义 — 从「日志推断 AND MT5 在跑」改成
      // 「ex5 部署到位 AND MT5 在跑」. 用户反馈日志推断在 MT5 关之后还是误判 true.
      // 数据目录文件存在 + 进程在跑 = 真正运行中, 这条更精确.
      desc.is_mounted = desc.is_deployed && desc.mt5_running;
      // Stale-running detection:
      //   `is_mounted` (from log scan) tells us SOMETHING for this EA was
      //   loaded onto a chart and not yet removed. But that "something"
      //   could be the OLD binary that was loaded before we recompiled.
      //   If the deployed .ex5's mtime is NEWER than the most recent
      //   "loaded successfully" log entry, the running instance is stale
      //   and the user needs to manually re-mount in MT5.
      desc.last_loaded_at = lastLoadedAt.get(grp.stem) || null;
      if (desc.is_mounted && desc.mt5_ex5_mtime && desc.last_loaded_at) {
        // 5s slop — file mtime can be slightly off from log timestamps.
        desc.is_stale = desc.mt5_ex5_mtime > (desc.last_loaded_at + 5_000);
      } else {
        desc.is_stale = false;
      }

      // 0.3.49: 不再算 has_stats_attribution + 弹「⚠ 统计缺失，点此修复」chip。
      // 老逻辑要求 EA 写 `<EA>_runtime.json` 含 magic（EasyDeal 协议），统计才
      // 跑得起来 — 第三方 EA 永远 fail，AI 每次都要被叫去改源码加协议。
      // 新版 strategies:live-stats（MCP 实时算）已经有三级 magic fallback：
      //   ① runtime.json 协议 ② .chr 图表配置 ③ symbol-only 兜底
      // 即使三路全不命中，UI 也会显示 0 而不是误告「需修复」。所以这条 chip
      // 整条拿掉，配套删 _checkStatsAttribution + has_stats_attribution 字段
      // 跟「修复协议」AI prompt。
      // Leaderboard opt-in flag — keyed by ex5 sha (so different versions of
      // same EA name compete separately on the public daily leaderboard).
      // Prefer the MT5/Experts copy (what's actually running) so this matches
      // both setLbOptIn and the daily-stats upload's hash priority — all
      // three must agree or the server JOIN returns nothing.
      desc.lb_optin = this._isLbOptIn(desc.mt5_ex5_sha256 || desc.ex5_sha256);
      out.push(desc);
    }
    // 0.3.17: 累计时长有变就回写 strategies.json（best-effort，不 await）
    if (persistNeeded) this._persistRecords().catch(() => {});
    // 0.3.131: 按文件创建时间升序固定排（作者反馈「ea 按创建时间固定排序」）
    // —— 之前按 is_mounted + mtime 排：EA 一改源码 / 重编 mtime 变 → 列表顺序跳，
    // 用户每次找同一只 EA 位置都不一样。改成按 birthtime 排稳定不变（先创建的在上）。
    // birthtime 在 Windows / macOS NTFS/APFS 都可靠；Linux ext4 较新内核也支持。
    // 0 / undefined fallback 用 mtime（极少数文件系统不支持 birthtime）。
    return out.sort((a, b) => {
      const ka = a.birthtime || a.mtime || 0;
      const kb = b.birthtime || b.mtime || 0;
      return ka - kb;
    });
  }

  async _describe(absPath, displayName) {
    const st = await fs.stat(absPath);
    let hash = '';
    let fullHash = '';
    try {
      const buf = await fs.readFile(absPath);
      fullHash = crypto.createHash('sha256').update(buf).digest('hex');
      hash = fullHash.slice(0, 16);
    } catch {}
    // 1.1.22: 按 (hash, stem) 消歧 — 多副本时各自显示自己的统计, 不读裸槽主人的
    const record = this.records[this._recordKeyFor(
      hash,
      String(displayName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '')
    )] || {};
    // Companion doc: <EA>.md next to <EA>.mq5。
    // 0.3.49: 必须先确认 absPath 真以 .mq5 结尾，否则 replace 不生效会让
    // docPath 跟 absPath 同名（典型 case：.ex5-only 策略 → docPath = .ex5
    // 文件 → fs.stat 还是过 → doc_exists 误报 true → 上层 readFileSync('utf8')
    // 读二进制 → prompt 里塞满 \0 → spawn args[5] reject「null bytes」。
    // 用户 撞过 `0.01ea1.ex5` 这条根因。
    // 0.3.55: .ex5-only EA 也能有 .md（用户手动写 / AI 基于日志推测时写的）。
    // 老版只允许 .mq5 → .md（防 .ex5 被当 .md 读出二进制）。现在 .ex5 同 stem
    // 也指向同一份 .md：strategies/Foo.ex5 → strategies/Foo.md。安全的关键
    // 是 docPath 永远是 .md 文件名（regex 把 .ex5 / .mq5 都剥成 .md），
    // 不会再让 .ex5 自身被 readFile('utf8') 当文档读。
    const hasKnownExt = /\.(mq5|ex5)$/i.test(absPath);
    const docPath = hasKnownExt ? absPath.replace(/\.(mq5|ex5)$/i, '.md') : null;
    let docSize = null, docMtime = null;
    if (docPath) {
      try {
        const dst = await fs.stat(docPath);
        docSize = dst.size;
        docMtime = dst.mtimeMs;
      } catch { /* no doc yet */ }
    }
    return {
      name: displayName,
      path: absPath,
      doc_path: docPath,
      doc_exists: docSize !== null,
      doc_size: docSize,
      doc_mtime: docMtime,
      size: st.size,
      mtime: st.mtimeMs,
      // 0.3.131: 按文件创建时间固定排序用 — Windows NTFS / macOS APFS 都可靠返
      // birthtimeMs；Linux ext4 较新内核也支持。不可用时 fs.stat 返 0 → caller
      // sort fallback 到 mtime。
      birthtime: st.birthtimeMs || 0,
      hash,
      hours_run: record.hours_run ?? 0,
      trades: record.trades ?? 0,
      pnl_pct: record.pnl_pct ?? null,
      max_drawdown: record.max_drawdown ?? null,
      // 0.3.109: 透出 initial_balance 给 UI 算「收益」列的 USD 金额
      // (pnl_usd = pnl_pct × initial_balance)
      initial_balance: record.initial_balance ?? null,
      // can_share / requirements removed — the new listing bar lives in
      // strategies:eligibility-bundle (24h online + 3-month passing backtest).
      // 0.3.124: 透出 monitor_config 给 UI 表格的 「魔术号 / 品种」两列 inline 显示+编辑用。
      // 用 getMonitorConfig 找 ea_name 对应最新更新的 record（同 ea 不同 hash 时取新）。
      // displayName 形如 "GMarket.mq5" — getMonitorConfig 内部已剥后缀。
      monitor_config: this.getMonitorConfig(
        String(displayName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '')
      ) || null,
      // 0.3.189 Phase 2: per-EA MT5 instance 绑定 (null = 未绑, 走 fallback 到活动实例)
      mt5_instance_id: this.getMt5InstanceForEa(
        String(displayName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '')
      ) || null,
    };
  }

  // Companion doc helpers — each .mq5 gets a same-name .md alongside.

  async readDoc(name) {
    const docPath = this._docPathForStrategyName(name);
    try {
      const content = await fs.readFile(docPath, 'utf8');
      const st = await fs.stat(docPath);
      return { ok: true, name, doc_path: docPath, content, mtime: st.mtimeMs, size: st.size };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, name, doc_path: docPath, content: '', mtime: null, size: 0 };
      return { ok: false, error: String(e.message || e) };
    }
  }

  async writeDoc(name, content) {
    const docPath = this._docPathForStrategyName(name);
    await fs.mkdir(path.dirname(docPath), { recursive: true });
    await fs.writeFile(docPath, String(content || ''), 'utf8');
    const st = await fs.stat(docPath);
    return { ok: true, name, doc_path: docPath, size: st.size, mtime: st.mtimeMs };
  }

  // ============================================================
  // 0.3.55: EA 关联指标依赖管理（用户 屠龙战神 iCustom 撞 0 笔成交根因修复）
  // ============================================================
  // 约定目录：<workspace>/strategies/.indicators/<EA-stem>/
  // 一只 EA 一个子目录，存它依赖的所有 .ex5 / .ex4 / .mqh / .mq5 自定义指标。
  // 已绑定的指标随 EA 打包。

  _indicatorsDirForEa(eaName) {
    // Accept "Foo.mq5" / "Foo.ex5" / "Foo" — 一律剥扩展名 + 用 basename 防越权
    const stem = String(eaName || '')
      .replace(/\\/g, '/').split('/').pop()
      .replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) throw new Error('empty ea name');
    const abs = path.join(this.dir, '.indicators', stem);
    const resolved = path.resolve(abs);
    const base = path.resolve(path.join(this.dir, '.indicators'));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error('path escapes .indicators dir');
    }
    return resolved;
  }

  /** 列出一只 EA 已绑定的指标文件。返回 [{name, ext, size, mtime, path}, ...] */
  async listIndicators(eaName) {
    const dir = this._indicatorsDirForEa(eaName);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, items: [], dir };
      return { ok: false, error: String(e.message || e), dir };
    }
    const items = [];
    for (const fname of entries) {
      const ext = path.extname(fname).toLowerCase();
      if (!['.ex5', '.ex4', '.mqh', '.mq5'].includes(ext)) continue;
      const fp = path.join(dir, fname);
      try {
        const st = await fs.stat(fp);
        if (!st.isFile()) continue;
        items.push({ name: fname, ext, size: st.size, mtime: st.mtimeMs, path: fp });
      } catch {}
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, items, dir };
  }

  /** 加一个指标 — 把 srcPath 拷到 .indicators/<EA>/<basename(srcPath)>
   *  srcPath 可以是用户从 Electron dialog 选的任意 .ex5/.ex4/.mqh/.mq5 */
  async addIndicator(eaName, srcPath) {
    if (!srcPath) return { ok: false, error: 'srcPath empty' };
    const ext = path.extname(srcPath).toLowerCase();
    if (!['.ex5', '.ex4', '.mqh', '.mq5'].includes(ext)) {
      return { ok: false, error: `不支持的文件类型: ${ext}（只接受 .ex5 / .ex4 / .mqh / .mq5）` };
    }
    try {
      const srcSt = await fs.stat(srcPath);
      if (!srcSt.isFile()) return { ok: false, error: 'srcPath 不是文件' };
    } catch (e) {
      return { ok: false, error: `源文件不存在: ${srcPath}` };
    }
    const dir = this._indicatorsDirForEa(eaName);
    await fs.mkdir(dir, { recursive: true });
    const fname = path.basename(srcPath);
    const dst = path.join(dir, fname);
    await fs.copyFile(srcPath, dst);
    const st = await fs.stat(dst);
    return { ok: true, name: fname, ext, size: st.size, mtime: st.mtimeMs, path: dst };
  }

  /** 删一个指标 — name 是文件名，不允许带路径分隔符 */
  async removeIndicator(eaName, indicatorName) {
    const fname = path.basename(String(indicatorName || ''));
    if (!fname || fname.includes('..')) return { ok: false, error: 'invalid name' };
    const dir = this._indicatorsDirForEa(eaName);
    const fp = path.join(dir, fname);
    try {
      await fs.unlink(fp);
      return { ok: true };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, missing: true };
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 0.3.344: parse .mq5 源码里的 magic + symbol input 默认值, 返 {magic, symbol}.
   *  AI 创建策略 / 用户拖 .mq5 进 workspace 时, monitor_config 永远 null —
   *  UI「魔术号 / 品种」两列显红色「未配」让用户必须手动填. 但 95% EA 源码
   *  里 input long magic = 12345 是写死的, input string Symbol = "XAUUSD" 也常见.
   *  自动 parse 出来当 default 持久化进 monitor_config, 用户编辑会看到预填值.
   *
   *  匹配模式 (兼容 MT5 各种风格):
   *    input long  Magic_Number = 12345;
   *    input int   Magic        = 9876;
   *    input ulong magic        = 99;
   *    static input long magic  = 1;
   *    input string TradingSymbol = "XAUUSD";
   *    input string Symbol_Name   = "XAUUSDm";
   *
   *  返 null fields 表 parse 不到 (e.g. symbol 用 _Symbol 不写硬编码), 调用方自行 fallback. */
  async _parseMq5InputDefaults(stem) {
    const safe = String(stem || '').replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!safe) return { magic: null, symbol: null };
    const mq5 = path.join(this.dir, `${safe}.mq5`);
    let src = null;
    try {
      src = await fs.readFile(mq5, 'utf8');
    } catch {
      try {
        const buf = await fs.readFile(mq5);
        src = buf.toString('utf16le');
      } catch {
        return { magic: null, symbol: null };
      }
    }
    // 去注释 (// 单行 + /* 多行) 防误匹配
    const cleaned = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    let magic = null;
    const mMag = cleaned.match(/\b(?:static\s+)?input\s+(?:long|int|ulong|short|uint)\s+\w*[Mm]agic\w*\s*=\s*(\d+)/);
    if (mMag) {
      const n = Number(mMag[1]);
      if (Number.isFinite(n) && n > 0) magic = n;
    }
    let symbol = null;
    const mSym = cleaned.match(/\b(?:static\s+)?input\s+string\s+\w*[Ss]ymbol\w*\s*=\s*["']([^"']+?)["']/);
    if (mSym && mSym[1].trim()) symbol = mSym[1].trim();
    // 1.0.10: `_Symbol` 型 EA (跟着图表品种走) 源码里没硬编码品种 → 上面 input 解析拿不到。
    // 认 AI 建 EA 时写的结构化标记 `//@easydeal symbol=XAUUSDm magic=999` 当意图声明。
    // ⚠ 必须从 **raw src** 读 (不是 cleaned) —— 标记是 `//` 注释, cleaned 已被剥掉。
    // 它是注释, 不影响编译 / 交易逻辑; input string 优先 (那是 EA 真参数), 标记是兜底。
    if (!symbol) {
      const mMarkSym = src.match(/@easydeal\b[^\r\n]*?\bsymbol\s*=\s*["']?([A-Za-z0-9._#\/-]{2,40})/i);
      if (mMarkSym && mMarkSym[1].trim()) symbol = mMarkSym[1].trim();
    }
    if (!magic) {
      const mMarkMag = src.match(/@easydeal\b[^\r\n]*?\bmagic\s*=\s*(\d+)/i);
      if (mMarkMag) { const n = Number(mMarkMag[1]); if (Number.isFinite(n) && n > 0) magic = n; }
    }
    return { magic, symbol };
  }

  /** 嗅探 EA 源码里的 iCustom 调用，返回声明的依赖指标名（不带扩展名）。
   *  只在有 .mq5 源码时能工作；ex5-only 用户走「手动选文件」路径。
   *  匹配模式：
   *    iCustom(symbol, period, "IndicatorName", ...)
   *    iCustom("path\\\\IndicatorName", ...)
   *  还顺便扫 #resource "\\Indicators\\xxx.ex5" 给 build-in resource EA。 */
  async sniffIndicatorDependencies(eaName) {
    const stem = String(eaName || '').replace(/\.(mq5|ex5|mqh)$/i, '');
    const mq5 = path.join(this.dir, `${stem}.mq5`);
    let src;
    try {
      src = await fs.readFile(mq5, 'utf8');
    } catch (e) {
      // 一些 EA 源码是 utf-16 LE（MetaEditor 默认）。试试。
      try {
        const buf = await fs.readFile(mq5);
        src = buf.toString('utf16le');
      } catch {
        return { ok: false, error: 'no .mq5 source (binary-only EA — please add indicators manually)' };
      }
    }
    const names = new Set();
    // iCustom("name", ...) 或 iCustom(_Symbol, _Period, "name", ...)
    // 第三个 string 字面量算第一个依赖名（兼顾两种调用形态）
    const reIc = /iCustom\s*\(\s*[^)]*?["']([^"'\\\/]+?)(?:\.ex[45])?["']/gi;
    let m;
    while ((m = reIc.exec(src))) {
      const n = m[1].trim();
      if (n && !n.match(/^(NULL|0)$/i)) names.add(n);
    }
    // #resource "\\Indicators\\xxx.ex5"
    const reRes = /#resource\s+["']\\\\?Indicators\\\\([^"']+?)(?:\.ex[45])?["']/gi;
    while ((m = reRes.exec(src))) {
      const n = m[1].trim();
      if (n) names.add(n);
    }
    return { ok: true, names: Array.from(names).sort() };
  }

  /** 给定声明的依赖名（无扩展名），在用户主 MT5 `MQL5/Indicators/` 找对应
   *  .ex5 / .ex4 文件并自动加到 EA 的 .indicators/ 目录。返回每个名字的结果。 */
  async autoImportIndicatorsFromMt5(eaName, names, opts = {}) {
    const { mt5DataDir, mt5InstallDir } = opts || {};
    const roots = this._candidateRoots(mt5DataDir, mt5InstallDir);
    const out = { ok: true, imported: [], not_found: [], errors: [] };
    for (const rawName of (names || [])) {
      const name = String(rawName).trim();
      if (!name) continue;
      // 在每个 root 的 MQL5/Indicators/ 下找 <name>.ex5 优先，再 .ex4
      let hit = null;
      for (const root of roots) {
        for (const ext of ['.ex5', '.ex4']) {
          const cand = path.join(root, 'MQL5', 'Indicators', `${name}${ext}`);
          try { await fs.stat(cand); hit = cand; break; } catch {}
        }
        if (hit) break;
      }
      if (!hit) {
        // recursive walk 兜底（MT5 Navigator 允许指标进子目录）
        for (const root of roots) {
          const base = path.join(root, 'MQL5', 'Indicators');
          try {
            hit = await this._findIndicatorRecursive(base, name);
            if (hit) break;
          } catch {}
        }
      }
      if (!hit) { out.not_found.push(name); continue; }
      try {
        const res = await this.addIndicator(eaName, hit);
        if (res.ok) out.imported.push({ name, src: hit, dst: res.path });
        else out.errors.push({ name, error: res.error });
      } catch (e) {
        out.errors.push({ name, error: String(e.message || e) });
      }
    }
    if (out.errors.length) out.ok = false;
    return out;
  }

  async _findIndicatorRecursive(baseDir, name) {
    const MAX_DEPTH = 6;
    const targets = [`${name.toLowerCase()}.ex5`, `${name.toLowerCase()}.ex4`];
    const stack = [{ dir: baseDir, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > MAX_DEPTH) continue;
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isFile() && targets.includes(e.name.toLowerCase())) return fp;
        if (e.isDirectory()) stack.push({ dir: fp, depth: depth + 1 });
      }
    }
    return null;
  }

  _docPathForStrategyName(name) {
    // Accept "Foo.mq5", "Foo", or "subdir/Foo.mq5"
    const safe = String(name || '').replace(/\\/g, '/');
    const parts = safe.split('/').map((p) => path.basename(p));
    const cleaned = parts.join(path.sep);
    const abs = path.join(this.dir, cleaned);
    const resolved = path.resolve(abs);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('path escapes strategies dir');
    }
    // 0.3.55: ex5-only EA（购买的 / 手动放进来的）name 是 "Foo.ex5"，
    // 老 regex 只剥 .mq5 → 会把 "Foo.ex5" 当文档路径读 → 读出二进制乱码。
    // 同 stem 共享一份 .md（.mq5 和 .ex5 共用），所以两个扩展名都要剥。
    return resolved.replace(/\.(mq5|ex5)$/i, '.md');
  }

  // _canShare(record) — removed; listing eligibility now goes through
  // strategies:eligibility-bundle (24h online + 3-month passing backtest).

  // _checkStatsAttribution / _chartHasMagicForEa — removed in 0.3.49.
  // 老逻辑用来给「⚠ 统计缺失，点此修复」chip 做 gate，要求 EA 写 runtime.json
  // 协议 / MT5 .chr 含 magic。新版改成 MCP 实时算（strategies:live-stats），
  // magic 三级 fallback 在 Python `get_ea_realtime_stats` 工具里做：
  //   ① Node 侧 .chr / runtime.json / log activity 解析 → 传 magic
  //   ② Python 内 symbol+频次 heuristic 兜底
  //   ③ symbol-only（无 magic 也能统计单 symbol EA）
  // EA 作者不需要改源码加协议，第三方 .ex5 也能自动归属。

  /**
   * Hash the binary MT5 currently has under <MT5_DATA_DIR>/MQL5/Experts/<EA>.ex5
   * and compare against the workspace .ex5's sha256. Used to spot the
   * "swap binary after collecting stats" attack at listing time.
   *
   * Returns:
   *   { mt5_ex5_path, mt5_ex5_sha256, match }
   *     - match=true   → identical to workspaceSha
   *     - match=false  → different (refuse to list)
   *     - match=null   → MT5 file missing (probably never deployed; warn)
   */
  async _verifyAgainstMt5(stem, mt5DataDir, workspaceSha, mt5InstallDir) {
    // Look at MT5/Experts/<stem>.ex5 across all candidate roots — portable
    // installs put it in installDir, regular installs in dataDir. Pick the
    // newest one (that's the actual deploy target).
    //
    // 0.3.12 (simon case): MT5 Navigator 原生支持把 EA 组织进子目录
    // (MQL5\Experts\MyStrategies\<EA>.ex5)。用户手动这么做 + AI 编译后
    // .ex5 也落在子目录，之前只看 flat path → 一直报 "MT5 file missing"
    // (hash_match: null) → UI 永远显「⚠ 不一致」错位。
    // 现在：flat 优先（绝大多数场景），找不到就 recursive walk 到子目录
    // 兜底。深度限到 6 层防极端用户嵌太深爆栈 / 卡读盘。
    const roots = this._candidateRoots(mt5DataDir, mt5InstallDir);
    if (!roots.length) return { match: null };
    let best = null;
    const MAX_DEPTH = 6;
    const target = `${stem.toLowerCase()}.ex5`;
    for (const root of roots) {
      const flat = path.join(root, 'MQL5', 'Experts', `${stem}.ex5`);
      try {
        const st = await fs.stat(flat);
        if (!best || st.mtimeMs > best.mtime) {
          best = { path: flat, mtime: st.mtimeMs };
        }
        continue;   // flat hit → skip recursion for this root
      } catch {}
      // Recursive fallback
      const stack = [{ dir: path.join(root, 'MQL5', 'Experts'), depth: 0 }];
      while (stack.length) {
        const { dir, depth } = stack.pop();
        if (depth > MAX_DEPTH) continue;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            stack.push({ dir: full, depth: depth + 1 });
          } else if (e.isFile() && e.name.toLowerCase() === target) {
            try {
              const st = await fs.stat(full);
              if (!best || st.mtimeMs > best.mtime) {
                best = { path: full, mtime: st.mtimeMs };
              }
            } catch {}
          }
        }
      }
    }
    if (!best) return { match: null };
    try {
      const buf = await fs.readFile(best.path);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      return {
        mt5_ex5_path: best.path,
        mt5_ex5_sha256: sha,
        mt5_ex5_mtime: best.mtime,
        match: workspaceSha ? (sha === workspaceSha) : null,
      };
    } catch {
      return { mt5_ex5_path: best.path, mt5_ex5_mtime: best.mtime, match: null };
    }
  }

  /**
   * Copy an already-compiled .ex5 from workspace/strategies/ into
   * <MT5_DATA_DIR>/MQL5/Experts/. Source-only deployments still go through
   * the Claude → compile_strategy MCP path (Node can't compile MQL5).
   */
  /**
   * @param {string} name — EA 文件名 (含扩展名 / 不含都行)
   * @param {string} mt5DataDir — 目标 MT5 实例的 dataDir (放新 .ex5 的地方)
   * @param {Array<{id, dataDir}>} [otherInstances] — 0.3.245: 其它 MT5 实例 list,
   *   deployCompiled 会清掉它们 Experts/ 里同名 .ex5 残留 (用户 case: 之前 EA 没绑定
   *   走默认部署到 pibar, 后来绑了 VP固定参数 → 新挂载只 deploy 到 VP固定参数, pibar
   *   里的 VP.ex5 残留 → pibar MT5 仍然在跑 EA → 用户看到「全部 EA 都挂到第一个 MT5」).
   *   不传 / 空数组 → 不清, 老行为.
   */
  async deployCompiled(name, mt5DataDir, otherInstances = [], mt5InstallDir = null) {
    if (!mt5DataDir) {
      return { ok: false, error: 'MT5 数据目录未配置（去「MT5」tab 添加 / 启动一个实例，或给这只 EA 绑定实例）' };
    }
    const safe = path.basename(String(name || ''));
    const stem = safe.replace(/\.(mq5|ex5|mqh|set)$/i, '');
    const ex5Src = path.join(this.dir, `${stem}.ex5`);
    try { await fs.access(ex5Src); }
    catch { return { ok: false, error: `本地缺 ${stem}.ex5 — 没有编译产物可部署` }; }

    const _norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    try {
      // 拷到该安装的**所有** Experts 落点: portable(安装目录) + 非portable(AppData\Terminal\<hash>)。
      // 之前只拷单个 mt5DataDir → 用户 MT5 以另一种方式启动时, .ex5 落在没在跑的那个目录 → 手动
      // 挂载提示「已拷贝」但 MT5 导航器里找不到(本次 bug)。多拷一份无害: 未使用的那份 MT5 不读。
      const roots = this._candidateRoots(mt5DataDir, mt5InstallDir);
      const rootNorms = new Set(roots.map((r) => _norm(r)));
      const targetNorm = _norm(mt5DataDir);
      const copiedDirs = [];
      let primaryDst = null, primarySize = 0, lastErr = null;
      for (const root of roots) {
        const expertsDir = path.join(root, 'MQL5', 'Experts');
        const dst = path.join(expertsDir, `${stem}.ex5`);
        try {
          await fs.mkdir(expertsDir, { recursive: true });
          await fs.copyFile(ex5Src, dst);
          const st = await fs.stat(dst);
          copiedDirs.push(expertsDir);
          // 首选 dst 用 mt5DataDir 那份(UI 显示), 否则第一个成功的
          if (!primaryDst || _norm(root) === targetNorm) { primaryDst = dst; primarySize = st.size; }
        } catch (e) { lastErr = e; }
      }
      if (!copiedDirs.length) {
        return { ok: false, error: `拷贝失败: ${String(lastErr?.message || lastErr || '所有 MT5 数据目录都写不进')}` };
      }

      // 0.3.245: 清掉**其它安装**实例 Experts/ 里同名 .ex5 残留 —— 但跳过本安装的所有落点
      // (rootNorms, 上面刚拷的正确副本), 否则会把刚拷进去的那份当残留删掉。
      const cleaned = [];
      for (const inst of (otherInstances || [])) {
        if (!inst?.dataDir) continue;
        if (rootNorms.has(_norm(inst.dataDir))) continue;   // 本安装落点, 别清
        const stalePath = path.join(inst.dataDir, 'MQL5', 'Experts', `${stem}.ex5`);
        try {
          await fs.access(stalePath);
          // 备份后再删 — 防万一用户后悔, .bak 文件在原位置
          try {
            await fs.rename(stalePath, stalePath + `.bak-${Date.now()}`);
            cleaned.push({ instance_id: inst.id || null, path: stalePath, action: 'backed_up' });
          } catch (renameErr) {
            try {
              await fs.unlink(stalePath);
              cleaned.push({ instance_id: inst.id || null, path: stalePath, action: 'deleted' });
            } catch (unlinkErr) {
              cleaned.push({ instance_id: inst.id || null, path: stalePath, action: 'failed', error: String(unlinkErr?.message || unlinkErr) });
            }
          }
        } catch {
          // stalePath 不存在 — skip
        }
      }
      return {
        ok: true,
        kind: 'ex5_copied',
        src: ex5Src,
        dst: primaryDst,
        size: primarySize,
        copied_dirs: copiedDirs,       // 实际拷进的所有 Experts 目录(portable + 非portable)
        cleaned_stale: cleaned,
        next_steps: [
          '1. 进 MT5，按 Ctrl+N 打开 Navigator',
          '2. Experts 节点上右键 → 刷新',
          `3. 找到 ${stem}，拖到要交易的图表上`,
          '4. 弹出参数面板：勾「允许实时自动交易」→ 确定',
          '5. 顶部「自动交易」按钮要呈绿色',
        ],
      };
    } catch (e) {
      return { ok: false, error: '拷贝失败：' + (e.message || String(e)) };
    }
  }

  async openInEditor(absPath) {
    // Resolve safely under the strategies dir
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('path escapes strategies dir');
    }
    await shell.openPath(resolved);
    return { ok: true };
  }

  async openFolder() { await shell.openPath(this.dir); return { ok: true }; }

  async addFile(srcPath) {
    const base = path.basename(srcPath);
    // Accept source (.mq5/.mqh) AND compiled (.ex5/.set) — the latter is
    // for marketplace-purchased strategies that don't ship source.
    if (!/\.(mq[5h]|ex5|set)$/i.test(base)) {
      throw new Error('only .mq5 / .mqh / .ex5 / .set accepted');
    }
    const dst = path.join(this.dir, base);
    await fs.copyFile(srcPath, dst);
    return { ok: true, name: base };
  }

  async deleteFile(name) {
    const safe = path.basename(String(name || ''));
    const target = path.join(this.dir, safe);
    if (!path.resolve(target).startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('path escapes strategies dir');
    }

    // 0.4.6: 删整组 sibling 文件 — 之前只删传入的那个 (.mq5)，留下的 .ex5
    // 会作为新一行重新出现，用户要点 2 次才能彻底删。把同 stem 的常见 sibling
    // 一起清掉：.mq5 / .ex5 / .md（策略说明）/ .installed.json（marketplace
    // 0.4.6 安装记录）。`.versions/<EA>/` 历史快照故意**不动** —— 留作审计 +
    // 万一误删能找回。
    const stem = safe.replace(/\.(mq5|ex5|mqh|set)$/i, '');
    const siblings = [
      `${stem}.mq5`,
      `${stem}.ex5`,
      `${stem}.md`,
      `${stem}.installed.json`,
    ];
    const removed = [];
    const errors = [];
    for (const fname of siblings) {
      const p = path.join(this.dir, fname);
      // 路径越权防御（同 deleteFile 主目标的检查）
      if (!path.resolve(p).startsWith(path.resolve(this.dir) + path.sep)) continue;
      try {
        await fs.unlink(p);
        removed.push(fname);
      } catch (e) {
        // ENOENT = 这个 sibling 本来就不存在，正常；其它错误记下来不抛
        if (e?.code !== 'ENOENT') {
          errors.push(`${fname}: ${e?.message || e}`);
        }
      }
    }
    // 至少要删到 target 本身才算成功（否则 caller 看到 ok 但啥也没动会困惑）
    if (!removed.length) {
      throw new Error(`没找到 ${stem} 的任何文件（可能已被外部删了）`);
    }
    return { ok: true, removed, errors: errors.length ? errors : undefined };
  }

  /** 1.1.22: records 的 key 消歧 — 修「同一策略复制 N 份(字节相同) → 同 hash 共用
   *  一条 record → ea_name 最后写者赢 → 品种/魔术号/绑定互相覆盖」(用户 4 份
   *  GMarket_fix 串号根因)。规则:
   *    - 裸 hash 槽空着 / 没 ea_name / 本来就属于这个 stem → 用裸 hash(全部存量
   *      单副本用户路径零变化);
   *    - 裸槽已属于别的 stem(同内容多副本) → 该 stem 用 `hash:stem` 复合 key,
   *      从此每个文件名一条独立 record, 永不互抢。key 非 16hex 安全 — 0.3.220 的
   *      'binding:'+stem 占位 key 早已证明任意字符串 key 可持久化/迭代。*/
  _recordKeyFor(hash, eaName) {
    if (!hash) return hash;
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return hash;
    const composite = hash + ':' + stem;
    if (this.records[composite]) return composite;   // 已分家 → 一直用自己的
    const r = this.records[hash];
    if (!r || !r.ea_name || r.ea_name === stem) return hash;
    return composite;
  }

  // In a real deployment the EasyDeal MCP / EA telemetry pipeline would call
  // this to update local stats so the share-gate has something to show.
  async recordTelemetry(hash, patch) {
    if (!hash) return { ok: false, error: 'hash required' };
    // 1.1.22: patch 带 ea_name 时按 (hash, stem) 消歧 — 多副本各写各的 record
    const key = (patch && patch.ea_name) ? this._recordKeyFor(hash, patch.ea_name) : hash;
    this.records[key] = { ...(this.records[key] || {}), ...patch, updated_at: Date.now() };
    // 0.3.292: 之前直接 JSON.stringify(this.records, ...) 写平铺老格式 → init() 走
    // fallback 分支 cumulative_hours_by_ea 被清空 + 跟 _persistRecords 的新格式
    // {records, cumulative_hours_by_ea} 交错写入导致字段丢失 (用户 6 个 EA mt5_instance_id
    // 全部丢的根因). 统一走 _persistRecords 保格式一致.
    await this._persistRecords();
    return { ok: true, record: this.records[key] };
  }

  // ============================================================
  // 0.3.119: Per-EA 监控配置 — 用户希望每个 EA 自己有 magic / 品种 / comment
  // 过滤器，AI 调 MCP 工具时按 EA 取 per-EA filter 而不是用全局监控配置。
  //
  // 存哪：放在 records[hash].monitor_config（跟 hours_run / trades / pnl_pct
  // 同表，复用 strategies.json 持久化）。一只 EA 重编译 (hash 变了) 时配置
  // 不丢 —— records 用 hash 当 key，但找配置用 ea_name 模糊匹配（看下面
  // getMonitorConfig 的 lookup 顺序）。
  //
  // Python 读法：每次 setMonitorConfig 后 dump 全量到 `<workspace>/
  // .easydeal-ea-monitor.json` 文件，Python MCP tools 读这个 JSON 按 ea_name
  // 取 per-EA filter；缺则 fallback 全局 env (EA_SYMBOLS / EA_MAGIC_NUMBERS)。
  // ============================================================

  /**
   * 拿一只 EA 的监控配置。优先级：
   *  1) 任一 hash 的 record.monitor_config 跟 ea_name 匹配（取最新更新的）
   *  2) null —— 让 Python 那边 fallback 到全局 env
   */
  getMonitorConfig(eaName) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return null;
    let best = null;
    let bestUpdated = 0;
    for (const r of Object.values(this.records || {})) {
      if (!r || !r.monitor_config) continue;
      const recEa = r.ea_name || '';
      if (recEa !== stem) continue;
      const upd = r.monitor_config.updated_at || 0;
      if (!best || upd > bestUpdated) { best = r.monitor_config; bestUpdated = upd; }
    }
    return best;
  }

  // ============================================================
  // 0.3.189 Phase 2: Per-EA MT5 instance binding
  //
  // 一台机器可以有多个 MT5 程序目录（0.3.188 加的 mt5Instances[]），
  // 每只 EA 可以绑到任意一个实例。绑了之后：
  //   - 「挂载」 (.ex5 拷贝) 走该实例的 dataDir
  //   - launch / manual-attach / auto-attach 走该实例的 installDir
  //   - 没绑 → fallback 到活动实例（保持单实例用户零配置）
  // ============================================================

  /** 读 EA 绑的 mt5_instance_id（找最新更新的 record）。没绑返 null。 */
  getMt5InstanceForEa(eaName) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return null;
    let best = null;
    let bestUpdated = 0;
    for (const r of Object.values(this.records || {})) {
      if (!r) continue;
      if ((r.ea_name || '') !== stem) continue;
      if (!r.mt5_instance_id) continue;
      const upd = r.mt5_instance_bound_at || r.updated_at || 0;
      if (!best || upd > bestUpdated) {
        best = r.mt5_instance_id;
        bestUpdated = upd;
      }
    }
    return best;
  }

  /** 给 EA 绑一个 mt5_instance_id。instanceId 传 null/空串 = 清除绑定（回 fallback）。
   *  写到所有匹配 ea_name 的 record 里（跨重编版本同步）。
   *  0.3.220: 没匹配 record (新 EA 还没挂载过 / stats-collector 没 tick 过) → 创个
   *  synthetic placeholder record (key='binding:'+stem) 保证 set 总是成功 — 用户在
   *  策略列表对新 EA 切 dropdown 不再 silent fail. 后续 stats-collector tick 创真
   *  record 时不冲突 (synthetic key 不是 sha256 hash, 不会撞).
   *  0.3.223: opts.resetStats=true → 同时清零 hours_run/trades/pnl/max_drawdown 等
   *  统计字段 + 移走该 EA 的 cumulativeHoursByEa, 因为切实例 = 在新挂载点重新开始,
   *  老实例的运行历史不该跟着 EA 走到新挂载点上.
   */
  async setMt5InstanceForEa(eaName, instanceId, opts = {}) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'eaName required' };
    const id = instanceId ? String(instanceId).trim() : null;
    const resetStats = !!opts.resetStats;
    const now = Date.now();
    let touched = 0;
    for (const [h, r] of Object.entries(this.records || {})) {
      if (!r) continue;
      if ((r.ea_name || '') !== stem) continue;
      const base = {
        ...r,
        mt5_instance_id: id,
        mt5_instance_bound_at: now,
        updated_at: now,
      };
      if (resetStats) {
        // 0.3.223: 切实例 = 在新挂载点从 0 开始. archive 老数据到 series 备份再清零.
        const archived = {
          archived_at: now,
          reason: 'mt5_instance_switch',
          mt5_instance_id_before: r.mt5_instance_id || null,
          hours_run: r.hours_run || 0,
          trades: r.trades || 0,
          pnl: r.pnl || 0,
          pnl_pct: r.pnl_pct || 0,
          max_drawdown: r.max_drawdown || 0,
          initial_balance: r.initial_balance || 0,
          daily_history: Array.isArray(r.history) ? r.history.slice() : [],
        };
        const newSeries = Array.isArray(r.series) ? r.series.slice() : [];
        newSeries.unshift(archived);
        while (newSeries.length > 20) newSeries.pop();
        Object.assign(base, {
          hours_run: 0,
          trades: 0,
          pnl: 0,
          pnl_pct: 0,
          pnl_cumulative: 0,
          max_drawdown: 0,
          equity_peak: 0,
          today_pnl: 0,
          today_trades: 0,
          today_hours: 0,
          history: [],
          series: newSeries,
          tracked_since: Math.floor(now / 1000),
          tracked_since_ms: now,
        });
      }
      this.records[h] = base;
      touched += 1;
    }
    // 0.3.220: 没匹配 → 创 synthetic placeholder, 别 reject. dropdown 一定 work.
    if (!touched) {
      const syntheticKey = 'binding:' + stem;
      this.records[syntheticKey] = {
        ...(this.records[syntheticKey] || {}),
        ea_name: stem,
        mt5_instance_id: id,
        mt5_instance_bound_at: now,
        updated_at: now,
        _placeholder: true,   // 标记: 仅 binding 占位, 真 record 来时 stats-collector 会建另一条 (用 sha256 hash key)
      };
      touched += 1;
    }
    // 0.3.223: resetStats=true 时也清 cumulativeHoursByEa (累计运行时长按 stem 单独存)
    if (resetStats && this.cumulativeHoursByEa) {
      delete this.cumulativeHoursByEa[stem];
      this._eaLastSeenAt?.delete?.(stem);
    }
    // 0.3.292: 走 _persistRecords 保格式一致 (见 recordTelemetry 同款 fix)
    await this._persistRecords();
    return { ok: true, ea_name: stem, mt5_instance_id: id, touched, reset_stats: resetStats };
  }

  /** 0.4.34: 从服务端权威 metric 恢复本地统计 — 用于本地统计被误重置/清零后
   *  (典型: 选实例触发的 binding-switch reset 把 pnl/trades 清成 0)。
   *  把服务端 metric (跟排行榜同源, 从 raw deals 派生) 写回本地 record, 并把本地
   *  anchor (tracked_since_ms) 对齐到服务端 metric_anchor_ts —— 让后续 stats-collector
   *  tick 从同一起算点重算, 不会再被本地 0 清回去。
   *  m = {pnl_pct, pnl_usd, trades, max_drawdown, hours_run, invested_capital, anchor_ts}。*/
  async restoreStatsFromServer(eaName, m = {}) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'eaName required' };
    const now = Date.now();
    // 服务端 anchor → ms (兼容 秒 / 毫秒 / ISO 字符串)
    let anchorMs = null;
    const a = m.anchor_ts;
    if (a != null) {
      if (typeof a === 'number') anchorMs = a > 1e12 ? a : a * 1000;
      else { const t = Date.parse(String(a)); if (!Number.isNaN(t)) anchorMs = t; }
    }
    let touched = 0;
    for (const [h, r] of Object.entries(this.records || {})) {
      if (!r || (r.ea_name || '') !== stem) continue;
      // 先把当前 (被重置的) 状态归档进 series, 可回溯
      const archived = {
        archived_at: now, reason: 'pre_restore_from_server',
        trades: r.trades || 0, pnl: r.pnl || 0, pnl_pct: r.pnl_pct || 0,
        max_drawdown: r.max_drawdown || 0, hours_run: r.hours_run || 0,
        initial_balance: r.initial_balance || 0,
      };
      const newSeries = Array.isArray(r.series) ? r.series.slice() : [];
      newSeries.unshift(archived);
      while (newSeries.length > 20) newSeries.pop();
      const upd = { ...r, series: newSeries, restored_from_server_at: now, updated_at: now };
      if (m.pnl_pct != null) upd.pnl_pct = m.pnl_pct;
      if (m.pnl_usd != null) { upd.pnl = m.pnl_usd; upd.equity_peak = Math.max(0, Number(m.pnl_usd) || 0); }
      if (m.trades != null) upd.trades = m.trades;
      if (m.max_drawdown != null) upd.max_drawdown = m.max_drawdown;
      if (m.hours_run != null) upd.hours_run = m.hours_run;
      if (m.invested_capital != null) upd.initial_balance = m.invested_capital;
      if (anchorMs) { upd.tracked_since_ms = anchorMs; upd.tracked_since = Math.floor(anchorMs / 1000); }
      this.records[h] = upd;
      touched += 1;
    }
    if (!touched) return { ok: false, error: 'no_record_for_ea (本地没有这只 EA 的记录)' };
    await this._persistRecords();
    return { ok: true, ea_name: stem, touched, anchor_ms: anchorMs };
  }

  /** 按 instance_id 统计绑了多少只 EA — 给 MT5 卡片显「已关联 N 个 EA」用.
   *  0.3.221: 接 activeEaNames (Set) 过滤掉已删除 / backup 文件 ea_name. */
  countEasForInstance(instanceId, activeEaNames = null) {
    if (!instanceId) return 0;
    const seen = new Set();
    for (const r of Object.values(this.records || {})) {
      if (!r || r.mt5_instance_id !== instanceId) continue;
      if (!r.ea_name) continue;
      if (activeEaNames && !activeEaNames.has(r.ea_name)) continue;
      seen.add(r.ea_name);
    }
    return seen.size;
  }

  /** 0.3.218: 返回某实例绑定的 EA 名字 (去重 + 排序), 给 MT5 卡片显具体名字用.
   *  0.3.221: 同上加 activeEaNames 过滤. */
  listEaNamesForInstance(instanceId, activeEaNames = null) {
    if (!instanceId) return [];
    const seen = new Set();
    for (const r of Object.values(this.records || {})) {
      if (!r || r.mt5_instance_id !== instanceId) continue;
      if (!r.ea_name) continue;
      if (activeEaNames && !activeEaNames.has(r.ea_name)) continue;
      seen.add(r.ea_name);
    }
    return Array.from(seen).sort();
  }

  /** 0.3.197: 统计未绑定到任何实例的 EA 数量 (这些由 active 实例承接).
   *  用 ea_name 去重 (跨重编版本不重复算).
   *  0.3.221: 接 activeEaNames 过滤. */
  countUnboundEas(activeEaNames = null) {
    const seen = new Set();
    for (const r of Object.values(this.records || {})) {
      if (!r) continue;
      if (r.mt5_instance_id) continue;   // 已绑定 → 跳过
      if (!r.ea_name) continue;
      if (activeEaNames && !activeEaNames.has(r.ea_name)) continue;
      seen.add(r.ea_name);
    }
    return seen.size;
  }

  /** 0.3.218: 返回未绑定 EA 名字列表 (给 active 实例卡片显具体名字用).
   *  0.3.221: 接 activeEaNames 过滤. */
  listUnboundEaNames(activeEaNames = null) {
    const seen = new Set();
    for (const r of Object.values(this.records || {})) {
      if (!r) continue;
      if (r.mt5_instance_id) continue;
      if (!r.ea_name) continue;
      if (activeEaNames && !activeEaNames.has(r.ea_name)) continue;
      seen.add(r.ea_name);
    }
    return Array.from(seen).sort();
  }

  /** 0.3.221: 扫 workspace/strategies 顶层目录, 返当前真实存在的 EA stem 集合.
   *  跳 _backups/ 跟 . 开头的目录 (跟 list() 同款规则). 用作 MT5 卡片 ea_names
   *  过滤白名单 — 历史 records 里有但工作区已删 / 已 backup 的 EA 不再显示. */
  async listActiveEaStems() {
    const set = new Set();
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const m = ent.name.match(/^(.+?)\.(mq5|mqh|ex5|set)$/i);
        if (m) set.add(m[1]);
      }
    } catch {}
    return set;
  }

  /** 写入 + dump JSON 给 Python 读 */
  async setMonitorConfig(eaName, config) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'eaName required' };
    // 找该 ea_name 对应的最新 record (任一 hash)
    let targetHash = null;
    let bestTickAt = 0;
    for (const [h, r] of Object.entries(this.records || {})) {
      if (r?.ea_name === stem) {
        const t = r.last_tick_at || r.updated_at || 0;
        if (!targetHash || t > bestTickAt) { targetHash = h; bestTickAt = t; }
      }
    }
    if (!targetHash) {
      // 1.1.22: 多副本场景 — 本 stem 还没有自己的 record(裸 hash 槽被同内容的另一份
      // 副本占用, 或 stats-collector 还没 tick)。按当前 .mq5 内容 hash 给本 stem 开
      // 专属 record, 不再报 no_record、也绝不抢别的副本的槽。
      try {
        const mq5 = path.join(this.dir, stem + '.mq5');
        if (fssync.existsSync(mq5)) {
          const buf = await fs.readFile(mq5);
          const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
          targetHash = this._recordKeyFor(h, stem);
        }
      } catch {}
    }
    if (!targetHash) {
      return { ok: false, error: 'no_record_for_ea (该 EA 还没生成 record；先挂载一次让 stats-collector 收一条)' };
    }
    // 0.3.123: magic 支持多值 — config.magic_numbers 是数组。优先用数组，
    // 没传则把 magic 单值包一下保兼容（老配置 / 上游只传 magic 的场景）。
    let magicNums = [];
    if (Array.isArray(config?.magic_numbers)) {
      magicNums = config.magic_numbers
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n >= 0);
    }
    if (!magicNums.length && config?.magic != null) {
      const m = Number(config.magic);
      if (Number.isFinite(m) && m > 0) magicNums = [m];
    }
    const normalized = {
      symbols:          Array.isArray(config?.symbols) ? config.symbols.filter(Boolean).map(String) : [],
      magic:            magicNums[0] || 0,           // 单值 — 兼容 0.3.119 Python helper
      magic_numbers:    magicNums,                    // 0.3.123 新加：完整数组
      commentContains:  Array.isArray(config?.commentContains) ? config.commentContains.filter(Boolean).map(String) : [],
      commentExcludes:  Array.isArray(config?.commentExcludes) ? config.commentExcludes.filter(Boolean).map(String) : [],
      updated_at:       Date.now(),
    };
    this.records[targetHash] = {
      ...(this.records[targetHash] || {}),
      ea_name: stem,
      monitor_config: normalized,
      updated_at: Date.now(),
    };
    // 0.3.292: 走 _persistRecords 保格式一致 (见 recordTelemetry 同款 fix)
    await this._persistRecords();
    await this._dumpMonitorConfigJson();
    // 0.5.x: 把品种/魔术号同步写进 workspace .mq5 的 `//@easydeal` 标记 → 源码自描述。
    // 之后任何情况(.mq5 hash 变 / records 重置 / 重装 / 安全软件清 userData)都能靠
    // auto-parse(line ~692)从标记认回来 —— 品种永不丢。GMarket 这类无标记老 EA 手填一次即自愈。
    try { await this._writeEasydealMarkerToMq5(stem, normalized.symbols[0], normalized.magic_numbers[0]); } catch {}
    return { ok: true, ea_name: stem, monitor_config: normalized };
  }

  /** 0.5.x: 把品种/魔术号写进 workspace .mq5 顶部的 `//@easydeal symbol=.. magic=..` 标记。
   *  幂等: 已有标记则更新, 内容没变就不写; 无 .mq5(纯 .ex5)直接跳过。
   *
   *  1.5.22: 这是 EasyDeal 自己的归属元数据注释，不是 EA 业务代码。写入后必须恢复
   *  原 mtime，否则 list() 会把 `.mq5 mtime > .ex5 mtime` 当成源码变更，用户只改
   *  魔术号就被迫重编；重编后的 .ex5 又比 MT5 load 日志新，继而误报“代码已重新
   *  编译，请重新挂载”。同时归一化为顶部唯一一条，清掉旧版本遗留的重复标记。*/
  async _writeEasydealMarkerToMq5(stem, symbol, magic) {
    try {
      const mq5 = path.join(this.dir, stem + '.mq5');
      // 1.1.22: fs 是 fs/promises — 没有 existsSync/readFileSync 等 sync 方法!
      // 1.1.10 起这里一直 TypeError 被 catch 吞掉 → 标记从来没真正写进过文件
      // (多副本永不分叉的帮凶)。全部换 fssync。
      if (!fssync.existsSync(mq5)) return;          // .ex5-only EA, 无源码可写
      const sym = symbol ? String(symbol).trim() : '';
      const mag = (magic != null && Number(magic) > 0) ? Number(magic) : '';
      if (!sym && !mag) return;
      const parts = [];
      if (sym) parts.push('symbol=' + sym);
      if (mag) parts.push('magic=' + mag);
      const marker = '//@easydeal ' + parts.join(' ');
      const beforeStat = fssync.statSync(mq5);
      const src = fssync.readFileSync(mq5, 'utf8');
      const bom = src.startsWith('\uFEFF') ? '\uFEFF' : '';
      const body = bom ? src.slice(1) : src;
      const eol = body.includes('\r\n') ? '\r\n' : '\n';
      // `// @easydeal`、BOM/零宽空格前缀和历史重复标记都兼容；最终只保留顶部一条。
      const markerLine = /^[\uFEFF\u200B \t]*\/\/\s*@easydeal\b[^\r\n]*(?:\r?\n|$)/gmi;
      const withoutMarkers = body.replace(markerLine, '').replace(/^(?:\r?\n)+/, '');
      const next = bom + marker + eol + withoutMarkers;
      if (next === src) return;                 // 没变化 → 不写, 避免 hash 抖动
      // 原地 durable 写，保留 NTFS birthtime（策略列表排序不跳）；临时备份只在写入窗口
      // 存在，异常时恢复。最后恢复 atime/mtime，让元数据注释不冒充“源码已改”。
      const backup = mq5 + '.easydeal-marker.bak';
      let fd = null;
      try {
        fssync.copyFileSync(mq5, backup);
        const payload = Buffer.from(next, 'utf8');
        fd = fssync.openSync(mq5, 'r+');
        fssync.writeSync(fd, payload, 0, payload.length, 0);
        fssync.ftruncateSync(fd, payload.length);
        fssync.fsyncSync(fd);
        fssync.closeSync(fd);
        fd = null;
        fssync.utimesSync(mq5, beforeStat.atime, beforeStat.mtime);
      } catch (writeErr) {
        try { if (fd != null) fssync.closeSync(fd); } catch {}
        fd = null;
        try { if (fssync.existsSync(backup)) fssync.copyFileSync(backup, mq5); } catch {}
        throw writeErr;
      } finally {
        try { if (fd != null) fssync.closeSync(fd); } catch {}
        try { fssync.unlinkSync(backup); } catch {}
      }
      console.log('[strategies] wrote //@easydeal marker to', stem + '.mq5:', marker);
    } catch (e) {
      console.warn('[strategies] write @easydeal marker failed for', stem, e?.message || e);
    }
  }

  /** 0.3.151: 保存护航阈值 (AI 分析建议 + 用户改).
   *  写到所有匹配 ea_name 的 record (跨重编版本同步).
   *  schema: orderguard_thresholds = {
   *    single_loss_usd, single_loss_pct, max_holding_hours,
   *    max_account_loss_pct, max_locked_positions,
   *    strategy_type, ai_reason, source: 'ai' | 'default' | 'user',
   *    updated_at
   *  }
   */
  async saveOrderguardThresholds(eaName, thresholds) {
    const stem = String(eaName || '').replace(/\.(mq5|ex5|mqh|set)$/i, '').trim();
    if (!stem) return { ok: false, error: 'ea_name required' };
    if (!thresholds || typeof thresholds !== 'object') {
      return { ok: false, error: 'thresholds payload required' };
    }
    const t = {
      single_loss_usd:      Number(thresholds.single_loss_usd)      || -100,
      single_loss_pct:      Number(thresholds.single_loss_pct)      || -5.0,
      max_holding_hours:    Number(thresholds.max_holding_hours)    || 24,
      max_account_loss_pct: Number(thresholds.max_account_loss_pct) || -8.0,
      max_locked_positions: Number(thresholds.max_locked_positions) || 4,
      strategy_type:        String(thresholds.strategy_type || '').slice(0, 50),
      ai_reason:            String(thresholds.ai_reason || thresholds.reason || '').slice(0, 500),
      source:               String(thresholds.source || 'user'),
      updated_at:           Date.now(),
    };
    let written = 0;
    for (const [hash, rec] of Object.entries(this.records)) {
      if (!rec || rec.ea_name !== stem) continue;
      this.records[hash] = { ...rec, orderguard_thresholds: t };
      written++;
    }
    // 0.3.292: 走 _persistRecords 保格式一致 (见 recordTelemetry 同款 fix)
    await this._persistRecords();
    return { ok: true, ea_name: stem, thresholds: t, written };
  }

  /** 0.3.151: 读护航阈值. 找匹配 ea_name 任一 record 返回 (跨版本同步, 应该都一样). */
  getOrderguardThresholds(eaName) {
    const stem = String(eaName || '').replace(/\.(mq5|ex5|mqh|set)$/i, '').trim();
    if (!stem) return null;
    for (const rec of Object.values(this.records)) {
      if (rec?.ea_name === stem && rec.orderguard_thresholds) {
        return rec.orderguard_thresholds;
      }
    }
    return null;
  }

  /** 0.3.130: 手动重置该 EA 的「基准余额」—— UI 「📡 监控配置」对话框底部的
   *  「⚠ 重置基准余额到当前」按钮调。
   *
   *  用例：
   *    - 用户换了 MT5 模拟盘账号（升级前的版本没记 login → accountSwitched
   *      自动检测漏掉了该 EA）
   *    - 用户充提了大额，希望从当前余额重新算 pnl_pct
   *
   *  动作：给该 ea_name 对应所有 record 标 `needs_anchor_reseed: true`。
   *  下一次 stats-collector tick (≤5min) 看到这个 flag 会跟 binaryChanged 走
   *  同款 archive+reset 流程（旧累计归档到 series[]，用当前 balance 作新 anchor）。
   *
   *  注意：这里只设 flag，**实际 reset 在 stats-collector tick 里执行** —— 因为
   *  reset 需要拿当前 MT5 balance + login，stats-collector tick 自然有这些数据，
   *  避免在 main 进程里再 spawn 一次 snapshot。
   */
  async resetAnchorForEa(eaName, manualInitialBalance = null, currentBalance = null) {
    const stem = String(eaName || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'eaName required' };
    // 0.3.142: reset 直接重置 record (不再依赖 stats-collector tick 检测 flag)
    // + 用账户级 pnl 视角：useManual + currentBalance 都有 → pnl = balance - mib，
    // 让 UI 显示「从输入的本金到现在赚了多少」(符合用户「我账号 10000 USD 入金，
    // 现在 10614.6，应该显 +6.14%」的 mental model)。
    // 用户反馈：「按 10000 重置但没起作用」截图 account_baseline=10614.6 + UI 0%。
    const mib = manualInitialBalance != null ? Number(manualInitialBalance) : null;
    const useManual = mib != null && Number.isFinite(mib) && mib > 0;
    const bal = currentBalance != null ? Number(currentBalance) : null;
    const haveBalance = bal != null && Number.isFinite(bal) && bal > 0;
    // 用户视角 pnl: balance - mib (账户级 since-anchor 盈亏，正/负都可能)
    const accountLevelPnl = (useManual && haveBalance) ? (bal - mib) : 0;
    const accountLevelPnlPct = (useManual && haveBalance && mib > 0) ? ((bal - mib) / mib) : 0;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    let touched = 0;
    for (const [h, r] of Object.entries(this.records || {})) {
      if (r?.ea_name !== stem) continue;

      // 归档当前 anchor 之前的成绩到 series[] (不删，仍可查)
      const archived = {
        ex5_sha256_short: r.tracked_ex5_sha256 ? r.tracked_ex5_sha256.slice(0, 12) : null,
        account_login_was: r.tracked_account_login || null,
        reason: useManual ? 'manual_reset_with_balance' : 'manual_reset',
        started_at: r.tracked_since || null,
        ended_at: nowSec,
        hours_run: r.hours_run || 0,
        trades: r.trades || 0,
        pnl: r.pnl ?? null,
        pnl_pct: r.pnl_pct ?? null,
        max_drawdown: r.max_drawdown ?? null,
        initial_balance: r.initial_balance ?? null,
        equity_peak: r.equity_peak ?? null,
        daily_history: Array.isArray(r.history) ? r.history.slice() : [],
      };
      const newSeries = Array.isArray(r.series) ? r.series.slice() : [];
      newSeries.unshift(archived);
      while (newSeries.length > 20) newSeries.pop();

      this.records[h] = {
        ...r,
        initial_balance: useManual ? mib : (r.initial_balance || 0),
        pnl: accountLevelPnl,
        pnl_pct: accountLevelPnlPct,
        // 0.3.142: anchor_pnl_offset — stats-collector tick 重算 pnl 时加上这个
        // 偏移量 (= balance_reset - mib)。这样即便 tick 把 pnl 重算成 sum(deals
        // after anchor)，加上 offset 后 pnl 仍反映「账户级 since-anchor 盈亏」。
        // 不破坏 deals-based pnl 的语义（offset=0 时退化为老行为）。
        anchor_pnl_offset: accountLevelPnl,
        trades: 0,
        hours_run: 0,
        max_drawdown: 0,
        equity_peak: Math.max(0, accountLevelPnl),
        today_pnl: 0,
        today_trades: 0,
        today_hours: 0,
        history: [],
        series: newSeries,
        tracked_since: nowSec,
        tracked_since_ms: nowMs,
        needs_anchor_reseed: !useManual,
        needs_anchor_reseed_at: nowMs,
        ...(useManual ? { manual_initial_balance: null } : {}),
        updated_at: nowMs,
      };
      touched++;
    }
    if (!touched) {
      return { ok: false, error: 'no_record_for_ea (该 EA 还没生成 record；先让 stats-collector 收一条)' };
    }
    require('./durable-write').durableWriteSync(this.dataPath, JSON.stringify(this.records, null, 2));  // 0.4.18: fsync+readback+atomic
    return {
      ok: true,
      ea_name: stem,
      touched_records: touched,
      manual_initial_balance: useManual ? mib : null,
      current_balance: haveBalance ? bal : null,
      account_pnl: accountLevelPnl,
      account_pnl_pct: accountLevelPnlPct,
    };
  }

  /** 把所有 EA 的 monitor_config dump 成 JSON 给 Python MCP 工具读。
   *  Format: { "<ea_name>": { symbols, magic, commentContains, commentExcludes }, ... } */
  async _dumpMonitorConfigJson() {
    const out = {};
    for (const r of Object.values(this.records || {})) {
      const ea = r?.ea_name;
      const mc = r?.monitor_config;
      if (!ea || !mc) continue;
      // 同 ea_name 多 hash 时取 updated_at 更新的
      const cur = out[ea];
      if (!cur || (mc.updated_at || 0) > (cur.updated_at || 0)) out[ea] = mc;
    }
    const dumpPath = path.join(this.workspaceDir, '.easydeal-ea-monitor.json');
    try {
      await fs.writeFile(dumpPath, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
      // 不阻塞主流程
    }
    return dumpPath;
  }

  /**
   * Toggle a strategy's "join leaderboard" flag. Persistence by ea_hash
   * (the .ex5 sha256), so different versions of the same EA name compete
   * separately on the public leaderboard.
   *
   * Returns { ok, ea_name, ea_hash, lb_optin }. Server sync is the caller's
   * responsibility (main.js IPC handles posting to /v1/strategies/leaderboard-optin
   * after this completes).
   */
  async setLbOptIn(name, optIn, opts = {}) {
    const stem = String(name || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    if (!stem) return { ok: false, error: 'name required' };
    // Locate the ea_hash for this stem. Priority:
    //   1. <MT5_DATA_DIR>/MQL5/Experts/<stem>.ex5  ← what's ACTUALLY running
    //   2. workspace/strategies/<stem>.ex5         ← local copy
    // MT5/Experts wins because the daily stats collector keys uploads by
    // the running binary too — both sides must agree or the leaderboard's
    // INNER JOIN returns nothing. We DO NOT fall back to .mq5 source hash
    // (different identity than the running binary).
    let ea_hash = null;
    if (opts.mt5DataDir || opts.mt5InstallDir) {
      try {
        const v = await this._verifyAgainstMt5(stem, opts.mt5DataDir, null, opts.mt5InstallDir);
        if (v?.mt5_ex5_sha256) ea_hash = v.mt5_ex5_sha256;
      } catch {}
    }
    if (!ea_hash) {
      const ex5Path = path.join(this.dir, `${stem}.ex5`);
      try {
        const buf = await fs.readFile(ex5Path);
        ea_hash = crypto.createHash('sha256').update(buf).digest('hex');
      } catch {}
    }
    if (!ea_hash) {
      return {
        ok: false,
        error: 'no_ex5_available — workspace/strategies/ 和 MT5/Experts/ 都没找到 ' + stem + '.ex5。'
             + '请先编译（行内点「部署」让 Claude compile）再来。',
      };
    }

    // Persist under the hash, so opt-in survives renaming the file.
    const rec = this.records[ea_hash] || {};
    rec.ea_name = stem;
    rec.ea_hash = ea_hash;
    rec.lb_optin = !!optIn;
    rec.lb_optin_at = optIn ? Date.now() : null;
    this.records[ea_hash] = rec;
    require('./durable-write').durableWriteSync(this.dataPath, JSON.stringify(this.records, null, 2));  // 0.4.18: fsync+readback+atomic

    return { ok: true, ea_name: stem, ea_hash, lb_optin: !!optIn };
  }

  /** Read-only lookup used by list() to surface lb_optin per row. */
  _isLbOptIn(eaHashFull) {
    if (!eaHashFull) return false;
    return !!this.records[eaHashFull]?.lb_optin;
  }

  /** 0.3.62: 清除本地所有 EA 的 lb_optin 标记。配合排行榜「🗑 清除记录」按钮 ——
   *  服务端那边删 strategy_daily_stats + leaderboard_optin，本地这里同步把 records
   *  里的 lb_optin / lb_optin_at 也擦掉，避免「服务端没参榜但本地 UI 还显示 ✓ 已参与」
   *  的不一致。返回清掉的 EA 数。 */
  async clearAllLbOptIn() {
    let cleared = 0;
    for (const hash of Object.keys(this.records || {})) {
      const rec = this.records[hash];
      if (!rec || typeof rec !== 'object') continue;
      if (rec.lb_optin) {
        rec.lb_optin = false;
        rec.lb_optin_at = null;
        cleared++;
      }
    }
    if (cleared > 0) {
      await this._persistRecords().catch(() => {});
    }
    return cleared;
  }
}

module.exports = { Strategies };
