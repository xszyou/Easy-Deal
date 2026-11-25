// Knowledge Base — files dropped into <workspace>/knowledge/ become
// reference material that Claude Code can Read directly via its standard
// Read/Glob/Grep tools (since we spawn it with cwd = workspace).
//
// We additionally maintain CLAUDE.md at the workspace root so the agent has
// an at-a-glance index on startup, and a .mcp.json telling Claude Code which
// MCP servers to auto-connect.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { shell } = require('electron');

// 0.3.43: 服务端共享知识库 metadata file. Lives at <kbDir>/.kb_meta.json,
// keyed by server file id, tracks which local file corresponds to which
// server entry + force_download / sha256 so we can detect updates.
const META_FILENAME = '.kb_meta.json';

class KnowledgeBase {
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
    this.kbDir = path.join(workspaceDir, 'knowledge');
    this.claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
    // 0.3.243: 自学习偏好搬到独立文件 preferences.md (CLAUDE.md 是系统 template
    // 会被 refreshClaudeMd 全量重写, 偏好放里头会被覆盖). CLAUDE.md 用 @import
    // 引用 preferences.md. preference-learner 写到 preferencesMdPath.
    this.preferencesMdPath = path.join(workspaceDir, 'preferences.md');
    // Cached external state — set by main.js from wechat sidecar status
    // events. CLAUDE.md template gates wechat sections on this so a
    // user that hasn't logged in to wechat doesn't see Claude proactively
    // suggest "要不要推到微信".
    this._wechatLoggedIn = false;
  }

  /**
   * 0.3.243: 老用户 CLAUDE.md 里已有的「用户偏好（自动学习）」bullets — 检测
   * 到就一次性迁到 preferences.md, 后续 refreshClaudeMd 把 CLAUDE.md 那段
   * 替换成 @preferences.md import. 只在 preferences.md 不存在时跑 (避免覆盖).
   */
  async _migrateLegacyPreferencesIfNeeded() {
    try {
      // 已有 preferences.md → 不动 (preference-learner 自己维护)
      await fs.access(this.preferencesMdPath);
      return;
    } catch { /* 不存在, 继续 */ }
    const HEADER = '## 用户偏好（自动学习）';
    const FOOTER = '<!-- 自动学习边界 — 删除某条偏好不影响下次学习 -->';
    let oldMd;
    try { oldMd = await fs.readFile(this.claudeMdPath, 'utf8'); }
    catch { return; }  // CLAUDE.md 不存在 — 第一次启动, 没什么可迁
    const start = oldMd.indexOf(HEADER);
    if (start < 0) return;
    const end = oldMd.indexOf(FOOTER, start);
    if (end <= start) return;
    const sectionText = oldMd.slice(start + HEADER.length, end);
    const bullets = sectionText.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || l.startsWith('*'))
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (!bullets.length) {
      // 老 CLAUDE.md 里只是占位符 _（暂无）_, 没真偏好, 写个空 preferences.md placeholder
      const empty = `_由 EasyDeal preference-learner 自动写入. 用户多次表达稳定偏好 (说"以后" / "记住" / 多次纠正) 后, bullets 会出现在这里. 下次新会话 Claude 自动加载.\n首次创建时间: ${new Date().toLocaleString('zh-CN')}_\n\n_(暂无)_\n`;
      await fs.writeFile(this.preferencesMdPath, empty, 'utf8');
      console.log('[knowledge-base] migrated CLAUDE.md → preferences.md (0 prefs found, wrote placeholder)');
      return;
    }
    const tsMatch = sectionText.match(/最近更新：([^_\n]+?)_/);
    const ts = tsMatch ? tsMatch[1].trim() : new Date().toLocaleString('zh-CN');
    const body = `_由 EasyDeal preference-learner 自动写入. 用户多次表达稳定偏好后会更新这里. 最近更新: ${ts}._\n\n${bullets.map((p) => `- ${p}`).join('\n')}\n`;
    await fs.writeFile(this.preferencesMdPath, body, 'utf8');
    console.log(`[knowledge-base] migrated CLAUDE.md → preferences.md (${bullets.length} prefs)`);
  }

  /** Update wechat-login-state cache + re-emit CLAUDE.md if it changed. */
  async setWechatLoggedIn(loggedIn) {
    const v = !!loggedIn;
    if (this._wechatLoggedIn === v) return;
    this._wechatLoggedIn = v;
    try { await this.refreshClaudeMd(); } catch {}
  }

  async ensureWorkspace({ easydealScript = null, settingsMcpScript = null, settingsJsonPath = null, schedulerScript = null, schedulerDb = null, pythonBin = 'python', mt5InstallDir = null, mt5DataDir = null, mt5LaunchMode = null, mt5InstanceId = null, windTunnelDir = null, windowCaptureScript = null, backtestsFile = null, wechatScript = null, tradingWriteEnabled = false, tradingWriteOpenEnabled = false, orderguardPortFile = null, monitor = null, newsBufferFile = null, mqhSourceDir = null } = {}) {
    this.mqhSourceDir = mqhSourceDir;
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(this.kbDir, { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'strategies'), { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'analysis'), { recursive: true });
    if (windTunnelDir) {
      const entry = path.join(windTunnelDir, 'SKILL.md');
      const instructions = [
        '---', 'name: wind-tunnel-skill', 'description: EasyDeal 策略风洞、真实 Tick 回放与 Tester 对账。', '---',
        `阅读 ${entry} 和 ${path.join(windTunnelDir, 'references', 'strategy-validation.md')}。`,
        `使用解释器 ${pythonBin} 和入口 ${path.join(windTunnelDir, 'scripts', 'wind_tunnel.py')}。`,
        '读取 strategies/<EA>.mq5 及其依赖，用 inspect-ea 确认版本和 SHA256。',
        '将该版独立适配器保存为 analysis/adapters/<EA>/<MQ5的完整SHA256>/strategy.py。同步核对 include、指标与参数，缺源码时说明缺失项。',
        '用 mcp__easydeal__run_backtest 提交回测，客户端记录历史并通知完成。报告为连续持仓模拟；对账按 Skill 的 verify 流程执行。',
      ].join('\n');
      for (const root of ['.claude', '.agents']) {
        const dir = path.join(this.workspaceDir, root, 'skills', 'wind-tunnel-skill');
        await fs.mkdir(dir, {recursive: true});
        await fs.writeFile(path.join(dir, 'SKILL.md'), instructions, 'utf8');
      }
    }


    // .mcp.json — always rewritten on startup. All MCP servers are stdio:
    //   easydeal-scheduler : python — task management (local sidecar)
    //   easydeal           : python — MT5 / EA monitoring (added only when
    //                        easydeal_mcp_server.py is found)
    // Each Claude Code session spawns its OWN python child for these. The
    // scheduler one shares its SQLite with the long-lived sidecar that the
    // Electron main process also spawns; SQLite WAL handles concurrent
    // access between the two processes.
    const mcpJsonPath = path.join(this.workspaceDir, '.mcp.json');
    const mcpConfig = { mcpServers: {} };

    if (schedulerScript) {
      mcpConfig.mcpServers['easydeal-scheduler'] = {
        type: 'stdio',
        command: pythonBin,
        args: [schedulerScript],
        env: {
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          ...(schedulerDb ? { EASYDEAL_SCHEDULER_DB: schedulerDb } : {}),
        },
      };
    }

    if (easydealScript) {
      const easydealEnv = {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        // Tells the easydeal MCP where the user authors strategies, so
        // it can auto-deploy workspace .mq5 files into MT5/Experts/
        // before compile/backtest.
        EASYDEAL_WORKSPACE_DIR: this.workspaceDir,
        EASYDEAL_MT5_ALLOW_LAUNCH: '0',
      };
      // Pass MT5 paths from settings so the Python MCP knows where the
      // terminal lives without requiring MT5 to already be running.
      if (mt5InstallDir) easydealEnv.EASYDEAL_MT5_INSTALL_DIR = mt5InstallDir;
      if (mt5DataDir)    easydealEnv.EASYDEAL_MT5_DATA_DIR    = mt5DataDir;
      if (mt5LaunchMode) easydealEnv.EASYDEAL_MT5_LAUNCH_MODE = mt5LaunchMode;
      if (mt5InstanceId) easydealEnv.EASYDEAL_MT5_INSTANCE_ID = mt5InstanceId;
      // Persistent backtest history file — Python writes here, Electron reads.
      if (backtestsFile) easydealEnv.EASYDEAL_BACKTESTS_FILE  = backtestsFile;
      // 0.3.228: 暴露 userData/data/ 目录给 Python MCP, 用于跟 Node 端共享
      // launch-flag / kill-flag file (md5 hash 命名), 防止 MT5 启动
      // kill+spawn 期间 stats-collector/OG/account-info 误判 MT5 不在跑又自启
      // 一个 → 两个 MT5 重复进程.
      if (backtestsFile) easydealEnv.EASYDEAL_DATA_DIR = path.dirname(backtestsFile);
      // 0.3.14: 金十快讯 buffer 文件 — Electron 主进程 newsProvider 每 30s
      // 写入；MCP child 在 list_recent_news 工具里读取。
      if (newsBufferFile) easydealEnv.EASYDEAL_NEWS_BUFFER_FILE = newsBufferFile;
      // 0.3.219: 资讯 daily log 目录 (持久存档, 不再被 200 条 ring buffer 卡上限)
      // MCP `list_recent_news` minutes_back > 60 时扫这里跨日合并, 让 AI 能拉到
      // 几天 / 几周前的资讯做长期分析.
      if (newsBufferFile) {
        easydealEnv.EASYDEAL_NEWS_DAILY_DIR = path.join(
          path.dirname(newsBufferFile), 'news',
        );
      }
      if (schedulerDb) easydealEnv.EASYDEAL_SCHEDULER_DB = schedulerDb;
      // Settings hot-reload —— easydeal-settings MCP 改了 settings.json
      // 后，主 MCP 在下次工具调用时自动 mt5.shutdown() + 重绑 + 同步
      // monitor 配置。无此 env 则禁用热重载（保持 0.1.40 行为）。
      if (settingsJsonPath) easydealEnv.EASYDEAL_SETTINGS_PATH = settingsJsonPath;
      // Trading-write opt-in. Only when the user explicitly checks
      // 「设置 → 高级 → 允许 AI 直接平仓 / 改单」do we expose the
      // close_position / modify_position tools to Claude. Default OFF
      // so a malicious / hallucinating LLM can't move real money without
      // user consent.
      if (tradingWriteEnabled) easydealEnv.EASYDEAL_TRADING_WRITE = '1';
      // 0.3.99: 开仓权限独立 env，关时 open_position 工具完全不暴露给 AI。
      if (tradingWriteOpenEnabled) easydealEnv.EASYDEAL_TRADING_WRITE_OPEN = '1';
      // 0.3.99: AI 开仓成功后 Python 端调 OrderGuard /enable 把订单注册到
      // `__ai_manual__` pseudo-EA 自动监控。Python 读这个 file 拿 port。
      // OrderGuard 没启动 / 文件不存在 → Python 端 best-effort，silent skip。
      if (orderguardPortFile) easydealEnv.EASYDEAL_ORDERGUARD_PORT_FILE = orderguardPortFile;
      if (this.mqhSourceDir) easydealEnv.EASYDEAL_MQL5_BUNDLED_DIR = this.mqhSourceDir;
      // 0.3.337: 删掉全局监控配置 env 注入 (EA_SYMBOLS / EA_MAGIC_NUMBERS /
      // EA_COMMENT_CONTAINS / EA_COMMENT_EXCLUDES). 多 broker 场景下会让用户撞错
      // symbol (XAUUSDc 跟 broker 实际 XAUUSDm 不一致 → AI 撞「品种不存在」).
      // 改用 per-EA + per-instance: mounted-state.json (Python `_load_mounted_state`)
      // 推 install_dir 上挂的 EA 的 symbol, 不再依赖全局 env.
      mcpConfig.mcpServers.easydeal = {
        type: 'stdio',
        command: pythonBin,
        args: [easydealScript],
        env: easydealEnv,
      };
    }

    // easydeal-settings MCP —— 让 Claude 改 EasyDeal 客户端设置（改 MT5 安装
    // 目录 / 监控品种等）。跟主 easydeal MCP 分开是为了：(1) 改设置时主 MCP
    // 不需要重启，工具列表不会因 trading_write 等开关变化而漂移；(2) 新工具
    // 只读写 settings.json，不依赖 MetaTrader5 SDK，秒启动。改完之后主 MCP
    // 通过 EASYDEAL_SETTINGS_PATH 的 mtime 变化在下次 tool call 自动 reload。
    if (settingsMcpScript && settingsJsonPath) {
      const settingsEnv = {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        EASYDEAL_SETTINGS_PATH: settingsJsonPath,
      };
      // 0.3.339: 暴露 dataDir 让 list_mt5_instances 能读 mounted-state.json,
      // 告诉 AI 每个 instance 实际挂的是哪个 EA — 不然 AI 拿不到这个信息
      // 会把全局 EA 列表喂给每个 instance (用户 MT5 3 上只有 SimpleBTC, AI
      // 会带着 GMarket 一起查 → 报错).
      if (backtestsFile) settingsEnv.EASYDEAL_DATA_DIR = path.dirname(backtestsFile);
      mcpConfig.mcpServers['easydeal-settings'] = {
        type: 'stdio',
        command: pythonBin,
        args: [settingsMcpScript],
        env: settingsEnv,
      };
    }

    // WeChat MCP — bundled wxauto-based stdio server. Each Claude turn
    // spawns its own copy (since Claude Code's stdio transport is
    // per-process), but PC WeChat itself owns the login session, so all
    // copies see the same logged-in user. The Electron-side sidecar
    // (electron/wechat-sidecar.js) keeps a separate long-lived instance
    // for status polling and inbound messaging — it doesn't share state
    // with the per-turn copies, but it doesn't need to.
    if (wechatScript) {
      mcpConfig.mcpServers.wechat = {
        type: 'stdio',
        command: pythonBin,
        args: [wechatScript],
        env: {
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
      };
    }

    // Optional: window_capture MCP server (list_windows / capture_window)
    // — useful for letting Claude grab a screenshot of MT5 / chart windows
    // and reason over them visually. The bundled copy lives at
    // <client>/python/window_capture/server.py; we also accept a Fay copy.
    if (windowCaptureScript) {
      // Save screenshots to the user's data dir, NOT inside the install dir
      // (so a future read-only install location keeps working).
      const captureSaveDir = path.join(this.workspaceDir, 'screenshots');
      mcpConfig.mcpServers['window-capture'] = {
        type: 'stdio',
        command: pythonBin,
        args: [windowCaptureScript],
        env: {
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          WINDOW_CAPTURE_SAVE_DIR: captureSaveDir,
        },
      };
      try { await fs.mkdir(captureSaveDir, { recursive: true }); } catch {}
    }
    this.lastWindowCaptureScript = windowCaptureScript;
    // 0.2.9: trace .mcp.json 写盘 —— 跟 chat-session._save 一样的 zombie
    // 症状（mtime 几天不变），写到 startup-trace.log 直接看哪步卡住。
    const _fsSync = require('node:fs');
    const _userData = path.dirname(this.workspaceDir);  // workspaceDir = <userData>/workspace
    const _tracePath = path.join(_userData, 'startup-trace.log');
    const _trace = (msg) => {
      try { _fsSync.appendFileSync(_tracePath, `[${new Date().toISOString()}] kb.ensureWorkspace :: ${msg}\n`, 'utf8'); }
      catch {}
    };
    const _mcpPayload = JSON.stringify(mcpConfig, null, 2);
    // 0.3.3: 字节数比对（fix UTF-16 chars vs UTF-8 bytes 的单位不匹配 bug）。
    // .mcp.json 几乎全 ASCII chars==bytes，所以之前没暴露问题；chat-session
    // 那边大量中文炸了。这里改对齐 chat-session 用 Buffer.byteLength。
    const _mcpExpectedBytes = Buffer.byteLength(_mcpPayload, 'utf8');
    _trace(`writeFile mcp.json START path=${mcpJsonPath} bytes=${_mcpExpectedBytes} servers=${Object.keys(mcpConfig.mcpServers).join(',')}`);
    const _mcpBeforeMtime = (() => { try { return _fsSync.statSync(mcpJsonPath).mtimeMs; } catch { return 0; } })();
    await fs.writeFile(mcpJsonPath, _mcpPayload, 'utf8');
    _trace('writeFile mcp.json returned');
    let _mcpAfterMtime = 0, _mcpAfterSize = 0;
    try {
      const st = _fsSync.statSync(mcpJsonPath);
      _mcpAfterMtime = st.mtimeMs; _mcpAfterSize = st.size;
    } catch {}
    const _mcpFaked = !(_mcpAfterMtime > _mcpBeforeMtime) || _mcpAfterSize !== _mcpExpectedBytes;
    if (_mcpFaked) {
      _trace(`!! WRITE FAKED async: mtime ${_mcpBeforeMtime}→${_mcpAfterMtime} size→${_mcpAfterSize} expected_bytes=${_mcpExpectedBytes}; falling back to writeFileSync`);
      try {
        _fsSync.writeFileSync(mcpJsonPath, _mcpPayload, 'utf8');
        const st2 = _fsSync.statSync(mcpJsonPath);
        const _stillFaked = !(st2.mtimeMs > _mcpBeforeMtime) || st2.size !== _mcpExpectedBytes;
        _trace(`writeFileSync mcp.json ${_stillFaked ? '!! ALSO FAKED' : 'DONE'} mtime=${st2.mtimeMs} size=${st2.size}`);
      } catch (e3) {
        _trace(`writeFileSync mcp.json ERROR ${e3.message}`);
      }
    } else {
      _trace(`writeFile mcp.json DONE (verified) mtime=${_mcpAfterMtime} size=${_mcpAfterSize}`);
    }
    this.lastMcpConfig = mcpConfig;
    this.lastEasydealScript = easydealScript;
    this.lastSchedulerScript = schedulerScript;

    // .claude/settings.json — load existing, ensure required keys are set.
    // We MERGE rather than overwrite so users keep their custom permissions;
    // we just guarantee the entries that make EasyDeal's MCP tools usable.
    //
    //   enableAllProjectMcpServers: true
    //     → auto-loads .mcp.json's servers (easydeal-client + easydeal)
    //       without an interactive approval dialog.
    //
    //   permissions.allow includes mcp__easydeal__* and mcp__easydeal-client__*
    //     → auto-approves all tools those servers expose. Without these,
    //       the agent prints "需要授权" every time it calls get_positions /
    //       schedule_task / etc.
    const settingsPath = path.join(this.workspaceDir, '.claude', 'settings.json');
    let settings = {};
    try {
      const buf = await fs.readFile(settingsPath, 'utf8');
      settings = JSON.parse(buf) || {};
    } catch { /* first run — create */ }

    const REQUIRED_ALLOW = [
      // Built-in tools
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebFetch', 'WebSearch',
      'Bash(git:*)', 'Bash(npm:*)', 'Bash(node:*)',
      // Auto-approve our own MCP tools so the agent can act without
      // manual confirmation each turn.
      'mcp__easydeal__*',
      'mcp__easydeal-scheduler__*',
      'mcp__easydeal-settings__*',
      'mcp__window-capture__*',
    ];
    if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
    for (const p of REQUIRED_ALLOW) {
      if (!settings.permissions.allow.includes(p)) settings.permissions.allow.push(p);
    }
    settings.enableAllProjectMcpServers = true;
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    await this.refreshClaudeMd();
  }

  async list() {
    let entries;
    try { entries = await fs.readdir(this.kbDir); }
    catch { return []; }
    const meta = await this._readMeta();
    // Index meta by local filename so list() can annotate each entry with
    // its origin ('local' / 'server-forced' / 'server-optional').
    const byLocalName = {};
    for (const k of Object.keys(meta.items || {})) {
      const m = meta.items[k];
      if (m && m.local_filename) byLocalName[m.local_filename] = { id: Number(k), ...m };
    }
    const out = [];
    for (const name of entries) {
      // Skip dotfiles (the meta file lives here) and the client-help subdir
      // (a directory anyway — isFile filters but checking name keeps the
      // intent explicit).
      if (name.startsWith('.')) continue;
      try {
        const st = await fs.stat(path.join(this.kbDir, name));
        if (st.isFile()) {
          const m = byLocalName[name];
          out.push({
            name,
            size: st.size,
            mtime: st.mtimeMs,
            origin:      m ? (m.force_download ? 'server-forced' : 'server-optional') : 'local',
            server_id:   m ? m.id : null,
            description: m ? (m.description || '') : null,
          });
        }
      } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async addFile(srcPath) {
    const base = path.basename(srcPath);
    const dst = await this._uniquePath(base);
    await fs.copyFile(srcPath, dst);
    await this.refreshClaudeMd();
    const st = await fs.stat(dst);
    return { name: path.basename(dst), size: st.size, mtime: st.mtimeMs };
  }

  async deleteFile(name) {
    const safeName = path.basename(String(name || ''));
    if (!safeName) throw new Error('invalid name');
    const target = path.join(this.kbDir, safeName);
    // Prevent path traversal
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(this.kbDir) + path.sep)) {
      throw new Error('path escapes knowledge dir');
    }
    // Refuse to delete server-forced files; the next sync would just pull
    // them back, and removing them undermines the admin's intent. Optional
    // server files CAN be deleted — the user opted in, they can opt out.
    const meta = await this._readMeta();
    let serverId = null;
    for (const k of Object.keys(meta.items || {})) {
      const m = meta.items[k];
      if (m && m.local_filename === safeName) {
        if (m.force_download) {
          throw new Error('强制下载的服务共享知识库不能在本地删除（请联系管理员将其改为可选 / 停用）');
        }
        serverId = k;
        break;
      }
    }
    await fs.unlink(target);
    if (serverId && meta.items) {
      delete meta.items[serverId];
      await this._writeMeta(meta);
    }
    await this.refreshClaudeMd();
    return { ok: true };
  }

  // ---- Server-shared KB (0.3.43+) ----

  async _readMeta() {
    try {
      const buf = await fs.readFile(path.join(this.kbDir, META_FILENAME), 'utf8');
      const obj = JSON.parse(buf);
      if (obj && typeof obj === 'object') {
        if (!obj.items || typeof obj.items !== 'object') obj.items = {};
        return obj;
      }
    } catch {}
    return { items: {} };
  }

  async _writeMeta(meta) {
    await fs.mkdir(this.kbDir, { recursive: true });
    await fs.writeFile(path.join(this.kbDir, META_FILENAME),
                       JSON.stringify(meta, null, 2), 'utf8');
  }

  /**
   * Compute the sha256 of a local file. Returns hex digest, or null on
   * any read error (caller treats null as "can't verify").
   *
   * Used by syncServerKb's force-download branch to detect cases where:
   *   - 老 meta cached.sha256 跟现存的本地文件已经不一致（用户手改 / 装在
   *     另一台机器的 meta 拷过来 / .kb_meta.json 损坏）
   *   - 那种情况下还需要按服务端 sha256 重拉，不能只信 meta
   * 文件不大（KB 级），同步 createReadStream 流式算就行。
   */
  async _fileSha256(localPath) {
    return new Promise((resolve) => {
      try {
        const h = crypto.createHash('sha256');
        const stream = fsSync.createReadStream(localPath);
        stream.on('data', (d) => h.update(d));
        stream.on('end', () => resolve(h.digest('hex')));
        stream.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  async _uniqueName(base) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let n = 0;
    while (true) {
      const candidate = n === 0 ? base : `${stem} (${n})${ext}`;
      try { await fs.access(path.join(this.kbDir, candidate)); n++; }
      catch { return candidate; }
    }
  }

  /**
   * Stream-download a URL to a local path. Follows up to 3 redirects (OSS
   * pre-signed URLs love to redirect, FastAPI's RedirectResponse uses 302
   * for external KB items).
   */
  async _downloadTo(url, destPath, { signal, redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryFetch = (u) => {
        attempt++;
        let parsed;
        try { parsed = new URL(u); }
        catch (e) { return reject(new Error('bad url: ' + u)); }
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(parsed, { signal }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (attempt > redirects) return reject(new Error('too many redirects'));
            const next = new URL(res.headers.location, parsed).toString();
            res.resume();
            return tryFetch(next);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const partial = destPath + '.partial';
          fs.mkdir(path.dirname(destPath), { recursive: true })
            .then(() => {
              const out = fsSync.createWriteStream(partial);
              res.pipe(out);
              out.on('finish', () => {
                out.close(() => {
                  fsSync.renameSync(partial, destPath);
                  resolve();
                });
              });
              out.on('error', (e) => {
                try { fsSync.unlinkSync(partial); } catch {}
                reject(e);
              });
              res.on('error', (e) => {
                try { fsSync.unlinkSync(partial); } catch {}
                reject(e);
              });
            }).catch(reject);
        });
        req.on('error', reject);
        req.setTimeout(60_000, () => { try { req.destroy(new Error('timeout')); } catch {} });
      };
      tryFetch(url);
    });
  }

  /**
   * Fetch the server's shared KB list, auto-download every force_download
   * item that's missing or has a stale sha256, and update .kb_meta.json.
   * Optional items are NOT auto-fetched — the user chooses via the UI.
   *
   * Called from main.js on startup (after license verified) and from the
   * "刷新" button in the client's knowledge view.
   */
  async syncServerKb({ serverApi }) {
    if (!serverApi || typeof serverApi.get !== 'function') {
      return { ok: false, items: [], downloaded: [], errors: ['no server api'] };
    }
    const r = await serverApi.get('/v1/knowledge/list', { timeoutMs: 12000 });
    if (!r.ok) {
      return { ok: false, items: [], downloaded: [], errors: [r.error || 'list_failed'] };
    }
    const items = Array.isArray(r.items) ? r.items : [];
    const meta = await this._readMeta();
    if (!meta.items) meta.items = {};
    const downloaded = [];
    const errors = [];

    for (const it of items) {
      const key = String(it.id);
      const cached = meta.items[key];
      let localName = cached?.local_filename;
      let need = false;

      if (it.force_download) {
        // 0.3.49: 强制下载 startup 算法
        //   ① 还没拉过 → 留唯一文件名，标记 need
        //   ② 文件不在 → 标记 need（被用户删 / 安装时被杀软挪走）
        //   ③ **实测本地文件 sha256** ≠ 服务端 sha256 → 标记 need
        //      (老逻辑只比 meta.cached.sha256 vs server.sha256，但 meta 跟实际
        //      磁盘的文件可能因为 .kb_meta.json 损坏 / 用户手改 / 跨机器拷 meta
        //      失同步，靠 meta 不够鲁棒。每次 startup 重算实际文件 sha 自校正)
        //   ④ 服务端没给 sha256（外挂 URL admin 没填）→ 只要文件在就不重拉
        if (!localName) {
          localName = await this._uniqueName(it.filename || `kb_${it.id}.bin`);
          need = true;
        } else {
          const localPath = path.join(this.kbDir, localName);
          let fileExists = true;
          try { await fs.access(localPath); }
          catch { fileExists = false; need = true; }

          if (!need && fileExists && it.sha256) {
            const actual = await this._fileSha256(localPath);
            if (actual && actual !== it.sha256) {
              console.log(`[kb] force-download sha mismatch ${it.filename}: ` +
                          `local=${actual.slice(0, 8)}… server=${it.sha256.slice(0, 8)}… → re-download`);
              need = true;
            } else if (actual == null) {
              // 读不出来（权限 / IO 错），下次启动再试，不强制重拉避免无限循环
            }
          }
        }
      } else {
        // Optional: only re-download if the user previously chose it AND
        // the server sha256 changed (keep their copy in sync silently).
        if (cached?.downloaded_at && cached.sha256 && it.sha256 &&
            cached.sha256 !== it.sha256) {
          need = true;
        }
      }

      if (need && it.download_url) {
        if (!localName) localName = await this._uniqueName(it.filename || `kb_${it.id}.bin`);
        try {
          await this._downloadTo(it.download_url,
                                 path.join(this.kbDir, localName));
          downloaded.push(localName);
        } catch (e) {
          errors.push(`${it.filename}: ${e.message || e}`);
          continue;
        }
      }

      meta.items[key] = {
        id:              it.id,
        filename:        it.filename,
        local_filename:  localName || null,
        description:     it.description || '',
        force_download:  !!it.force_download,
        size:            it.size,
        sha256:          it.sha256,
        mime:            it.mime,
        download_url:    it.download_url,
        uploaded_at:     it.uploaded_at,
        updated_at:      it.updated_at,
        downloaded_at:   localName && (need || cached?.downloaded_at)
                            ? (need ? new Date().toISOString() : cached.downloaded_at)
                            : (cached?.downloaded_at || null),
      };
    }

    // Reap meta entries for items the server no longer publishes. We only
    // delete the local file if it was force_download (the user never
    // explicitly chose it — admin pushed it, admin retracted it). For
    // optional files we leave the bytes; the user can delete them in the UI.
    const liveIds = new Set(items.map((x) => String(x.id)));
    for (const k of Object.keys(meta.items)) {
      if (!liveIds.has(k)) {
        const m = meta.items[k];
        if (m?.force_download && m.local_filename) {
          try { await fs.unlink(path.join(this.kbDir, m.local_filename)); } catch {}
        }
        delete meta.items[k];
      }
    }

    await this._writeMeta(meta);
    if (downloaded.length) {
      try { await this.refreshClaudeMd(); } catch {}
    }
    return { ok: true, items, downloaded, errors };
  }

  /**
   * Returns the server's published list joined with local-download state.
   * Used by the client's knowledge view to render the "可选" section.
   */
  async listServerShared({ serverApi }) {
    if (!serverApi || typeof serverApi.get !== 'function') {
      return { ok: false, items: [], error: 'no server api' };
    }
    const r = await serverApi.get('/v1/knowledge/list', { timeoutMs: 8000 });
    if (!r.ok) return { ok: false, items: [], error: r.error || 'list_failed' };
    const meta = await this._readMeta();
    const items = (Array.isArray(r.items) ? r.items : []).map((it) => {
      const cached = meta.items?.[String(it.id)];
      return {
        ...it,
        downloaded:     !!cached?.downloaded_at,
        local_filename: cached?.local_filename || null,
        downloaded_at:  cached?.downloaded_at || null,
        stale:          !!(cached?.downloaded_at && cached.sha256 && it.sha256
                           && cached.sha256 !== it.sha256),
      };
    });
    return { ok: true, items };
  }

  /**
   * Download one optional item (user clicked the 下载 button on the KB tab).
   * Force-download items are already pulled by syncServerKb on startup; this
   * still works for them but is normally redundant.
   */
  async downloadServerItem(id, { serverApi }) {
    if (!serverApi || typeof serverApi.get !== 'function') {
      throw new Error('no server api');
    }
    const r = await serverApi.get('/v1/knowledge/list', { timeoutMs: 12000 });
    if (!r.ok) throw new Error(r.error || 'list_failed');
    const it = (r.items || []).find((x) => Number(x.id) === Number(id));
    if (!it) throw new Error('not_found');
    // 0.3.117: 不用 it.download_url 直拉 — 那个 URL 在 server kb_cdn_base_url 设了时
    // 指向 OSS CDN（如 https://easydeal-kb.oss-cn-shanghai.aliyuncs.com/kb/<file>），
    // 但 admin 上传到 server 本地后没同步到 OSS → 404。改走 server 自己的 download endpoint
    // `/v1/knowledge/download/{id}` —— server 决定 stream local file（直接落地的）OR
    // 302 redirect to source_url（外挂 OSS 真的同步过的）。也避免 client 受 OSS 同步状态影响。
    const baseUrl = (serverApi.getBaseUrl && serverApi.getBaseUrl()) || '';
    const dlUrl = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/v1/knowledge/download/${it.id}`
      : it.download_url;   // baseUrl 拿不到时退回老逻辑（理论上不会，serverApi 一定 export 了）
    const meta = await this._readMeta();
    if (!meta.items) meta.items = {};
    const cached = meta.items[String(id)];
    let localName = cached?.local_filename || await this._uniqueName(it.filename);
    await this._downloadTo(dlUrl, path.join(this.kbDir, localName));
    meta.items[String(id)] = {
      id:              it.id,
      filename:        it.filename,
      local_filename:  localName,
      description:     it.description || '',
      force_download:  !!it.force_download,
      size:            it.size,
      sha256:          it.sha256,
      mime:            it.mime,
      download_url:    it.download_url,
      uploaded_at:     it.uploaded_at,
      updated_at:      it.updated_at,
      downloaded_at:   new Date().toISOString(),
    };
    await this._writeMeta(meta);
    await this.refreshClaudeMd();
    return { ok: true, local_filename: localName };
  }

  /**
   * Rebuilds CLAUDE.md. Gating off `_wechatLoggedIn` (set externally via
   * setWechatLoggedIn): when wechat isn't logged in, the wechat-attachment
   * handling section is dropped and the notify guidance becomes "don't
   * proactively suggest wechat" — avoids "要不要我推到微信" noise on
   * machines that never set up the integration.
   */
  async refreshClaudeMd() {
    const wechatLoggedIn = this._wechatLoggedIn;
    const items = await this.list();
    const indexLines = items.length
      ? items.map((it) => `- \`knowledge/${it.name}\`  _(${formatSize(it.size)})_`).join('\n')
      : '_(no files yet — upload via the EasyDeal client UI)_';

    // 0.3.243: 把「用户偏好（自动学习）」搬出 CLAUDE.md 到独立文件 preferences.md.
    // CLAUDE.md 还是系统 template (含升级内容 / wechat 段动态变化), 每次 refresh
    // 全量重写 — 这是 desired 行为. 但**用户偏好 bullets 不能跟着丢**, 所以拆到
    // workspace/preferences.md, CLAUDE.md 里用 Claude Code 的 @import 语法引用,
    // refreshClaudeMd 重写 CLAUDE.md 时**不动** preferences.md.
    // preference-learner 也跟着改成写 preferences.md (见对应文件 0.3.243 修法).
    // 老用户 CLAUDE.md 里已有的偏好 bullets — 检测到就迁到 preferences.md (一次性).
    await this._migrateLegacyPreferencesIfNeeded();

    const body = `# EasyDeal Client Workspace

This is your shared workspace with the user, hosted by the EasyDeal desktop client. Treat it as your home directory: strategies, analyses, scratch files all live here.

## Reference docs (auto-synced from easy-deal repo)

These are the project's official documents — read them when the user asks
about installation, configuration, or default strategy logic. Image paths
inside the README resolve relative to this directory.

- \`.easy-deal/strategy_doc_latest.md\` — GMarket EA strategy reference

## Client help docs (优先读这里回答「怎么用」类问题)

这是 EasyDeal **社区版**（免费开源的单机版）。客户端自带的用户手册在
\`knowledge/用户手册.md\`，每次启动自动更新。**当用户问「这个软件怎么用」
「为什么 X 不工作」「Y 怎么配」之类的问题时，先 Read 这份手册**，比凭模型
记忆回答准确得多。手册里有：5 分钟上手、工作区、各页面说明、做策略、订单
护航、定时任务、设置、常见问题和已知问题。

社区版没有序列号、策略商城、排行榜、跟单、微信、远程控制、手机 App 和回测，
不要向用户推荐这些功能。

客户端还自带一份 **《ML4T 中文导读》**（Stefan Jansen《Machine Learning for
Trading》第 3 版的通俗导读，不是原书译本）：入口是 \`knowledge/ML4T中文导读.md\`，
里面有全书地图、阅读路线和章节目录，各章正文在 \`knowledge/ML4T中文导读/\`
下（一章一个文件）。当用户问量化研究方法，比如回测偏差、过拟合、样本外
验证、交易成本、风险管理、实盘上线和监控时，先读入口找到对应章节再读正文，
引用时说明出自导读的哪一章。

## User-uploaded knowledge

Files dropped via the EasyDeal client's Knowledge tab live under \`knowledge/\` — read with the standard Read tool. Treat them as read-only.

${indexLines}

## Working layout

- \`strategies/\`  — EA / strategy source you create or modify (.mq5, .mqh, .set)
- \`analysis/\`    — backtest notes, post-mortems, charts
- \`knowledge/\`   — user-uploaded reference (read-only)
- \`CLAUDE.md\`    — this file (auto-maintained by the client)

## Creating a new EA (MUST follow these rules)

When the user asks you to write a new EA, the source file must go to
\`strategies/<PascalCaseName>.mq5\` (use the Write tool). The client's "我的
策略" tab scans that directory and auto-shows new files within 5 seconds.

Each EA you author should:

1. Declare all tunable parameters as \`input\` at the top, with Chinese
   comments after \`//\` explaining each one. Always include
   \`input int InpMagicNumber = ...;\` so the EA's orders are identifiable.
   客户端 0.3.49+ 用 MT5 deal 历史 + .chr 配置自动归属成交，**EA 不需要再写
   \`<EA>_runtime.json\` 协议文件**，但带 magic input 还是建议保留 —— 客户端
   优先用它做 deal 过滤，多 EA 跑同 symbol 时唯一能区分。
   **品种声明（1.0.10 起，务必加）**：在 EA 源码顶部加一行结构化注释
   \`//@easydeal symbol=<用户账户上真实存在的品种全名> magic=<同上 magic>\`
   （例：\`//@easydeal symbol=XAUUSDm magic=999\`）。客户端会解析它**自动填好「策略」页的「品种」格**。
   ⚠ 尤其当 EA 用 \`_Symbol\`（跟随挂载图表的品种）、源码里**没有硬编码的品种 input** 时，
   这个注释是唯一能让品种自动配上的途径（否则「策略」页品种会显红色「未配」、要用户手动点格子填，
   而你建 EA 时本来就知道该用哪个品种）。symbol 必须用**用户账户上真实存在的全名**
   （Exness 是 \`XAUUSDm\` 不是 \`XAUUSD\`；拿不准先用 \`get_market_info\` 确认）。它是注释，不影响编译/交易逻辑。
2. Always honour \`InpIsPaused\` (bool) — when true, do not open new orders.
3. **默认必带参数热更新协议**（0.3.80 起约定）—— OnInit 末尾 \`EventSetTimer(3);\`，OnDeinit 加 \`EventKillTimer();\`，写 \`OnTimer()\` 函数 poll \`MQL5/Files/<EAName>_config.set\` 文件，用 last_mtime 守卫避免重复读盘，按 \`key=value\` 行解析把值赋给同名 input（用 GlobalVariable 中转或 static 缓存）。
   这是 \`update_strategy_param\` MCP 工具的下行通道。
   **为什么默认带**：
   - 用户在「策略 → ⚙ 参数设置」改参数能 3s 内生效，不用重编 + 重挂
   - AI 后续用 \`mcp__easydeal__update_strategy_param\` 调参（如调参后应用结果）能无缝写入
   - 「📈 学习中心」自动调 fast_rules 也走同一条下行通道
   - 不带的话用户每改一次参数都要走「改源码 → 重编 → 重挂」3 步，体验割裂
   **唯一例外**：用户**明确说**「不要参数热更新」/「保持 EA 最简」时才不加。
   解析失败的行跳过 + Print 一行 warning 别 crash。
4. After writing the file, tell the user: ① the file path you wrote, ② key
   inputs and their defaults, ③ the manual MT5 step to compile and attach
   to a chart (the client cannot do that for the user yet).

## Strategy companion docs

Each \`strategies/<EA>.mq5\` should have a sibling \`strategies/<EA>.md\` —
a Chinese strategy reference that explains the EA's logic in human terms.
Layout (loose, follow what fits):

- 核心思路 / 一句话总结
- 交易流程（入场 / 出场条件，配上参数名）
- 加仓 / 风控规则
- 关键参数（参数名 → 含义 → 默认值 → 调整建议）
- 注意事项 / 已知坑

The client's "策略" tab shows this doc inline and lets the user trigger
Claude actions:

- **生成 / 重写** — Read \`<EA>.mq5\`, infer logic, Write \`<EA>.md\`
- **校对** — diff doc vs source, report inconsistencies (do NOT edit anything)
- **修正** — reconcile both: default to "source is truth", edit \`<EA>.md\` to match

For \`.easy-deal/strategy_doc_latest.md\` — that's GMarket's reference doc,
synced from the upstream repo. Use it as a structural template when you
write docs for the user's own EAs.

## Available MCP servers

The client wires these in via \`.mcp.json\` (all stdio):

- **easydeal** — MT5 / EA monitoring tools (\`get_account\`, \`get_positions\`, \`update_strategy_param\`, \`compile_strategy\`, \`run_backtest\`, \`get_backtest_status\`, etc.). Spawned by Claude Code from the project's \`easydeal_mcp_server.py\`. Source: https://gitee.com/xszyou/easy-deal

  回测使用工作区 wind-tunnel-skill。先读其 SKILL.md，按当前 MQ5 版本准备适配器，再调用 run_backtest。
- **easydeal-scheduler** — task scheduler tools (\`schedule_task\`, \`list_tasks\`, \`cancel_task\`, \`pause_task\`, \`resume_task\`, \`update_task\`, \`get_task_history\`, \`list_due_tasks\`). The Electron main process runs a long-lived sidecar that fires due tasks; this MCP exposes the same SQLite store to you for CRUD.

## 核心规则: 多 MT5 实例 (0.3.188+ 用户)

EasyDeal 客户端从 0.3.188 起支持**多个 MT5 实例并行**。不同实例可以:
- 连不同 broker (Exness / XM / IC Markets / FXTM 等)
- 装在不同目录 (\`D:\\IC-mt5\`, \`D:\\XM-mt5\`)
- 跑不同 EA 集合
- 用「我的策略」表的 MT5 实例下拉给每个 EA 指定走哪个

**你 AI 工具调用时的注意**:

1. **先用 \`mcp__easydeal-settings__list_mt5_instances\` 看用户有几个 MT5**, 别假设只有一个. 返回每个实例的 \`{id, name, installDir, dataDir, user_intent('running'/'stopped'), is_default, notes, mounted_ea_name, mounted_symbol, mounted_period}\`.

   ⚠ **重要**: 0.3.339+ 加了 \`mounted_ea_name\` / \`mounted_symbol\` 字段 —— 该 instance 实际挂了哪个 EA + 该 broker 上的 symbol. **调 \`get_ea_realtime_stats\` / \`get_profit_history\` / \`get_klines\` / \`get_market_info\` 时, 用这个 instance 自己的 \`mounted_ea_name\` 当 \`ea_name\`, \`mounted_symbol\` 当 \`symbol\`**. 不要把全局策略列表 (strategies.json 里的所有 EA) 都喂给同一个 instance — 别的 instance 上没挂的 EA 在该 broker 上没 trade 记录, 查了只能拿到 0. 也不要用 \`strategy.symbol\` (如 XAUUSDm) 去查另一个 broker (如 XAUUSD) — 改用每个 instance 的 \`mounted_symbol\`.

2. **easydeal MCP 工具 (get_account / positions) 只能看到 EASYDEAL_MT5_INSTALL_DIR env 那一个**, 默认指向「默认实例」(is_default=true 那个). 用户问「另一个 MT5 上的账户」这类问题时, 你看不到 — 让用户先在 MT5 tab 把默认切到目标实例.

3. **操作单实例 (启动/关闭/显示窗口/绑 EA / 设为默认)** 你**没暴露 IPC** — 一律告诉用户「去 EasyDeal MT5 tab 卡片上的按钮操作」, 别尝试用 PowerShell / cmd 手动启动 terminal64.exe (Phase 3 后 client 自己管 MT5 生命周期, AI 手动启动会绕过 client 的进程跟踪 / 守护机制, 还可能撞 SDK boot race 启动多个 terminal64.exe). 注: 0.3.220 之前那个"暂停交易"按钮已下线 — Win11 UIPI 上 Ctrl+E 注入不稳, 改成只显示窗口让用户自己点工具栏 ▶/⏸ 算法交易开关.

4. **用户反馈「MT5 没在跑」时**, 先调 list_mt5_instances 看哪些实例 user_intent='running' 但 process 不在 → 让用户去 MT5 tab 点「▶ 启动 MT5」. 不要替用户跑 Bash terminal64.exe 命令.

5. 风洞离线读取指定品种的 Tick 行情库。

## 核心规则: 回测指标的单位约定（千万别搞错）

历史 Tester 回测和 realtime stats 工具返回的 metrics 里，**回撤百分比有两个字段**，单位完全不同：

- ✅ **\`max_drawdown_percent\`** —— 直接是百分比数值。\`29.7\` 表示 29.7% 回撤，\`0.5\` 表示 0.5%。**AI 一律读这个**做比较 / 报告 / 决策。
- ⚠ \`max_drawdown_pct\` —— decimal fraction，\`0.297\` 表示 29.7% 回撤，\`0.005\` 表示 0.5%。仅给客户端 UI 渲染用（× 100 + "%" 拼字符串）。
- 💰 \`max_drawdown_abs\` / \`max_drawdown_dollar\` —— 绝对金额（美元），跟百分比没关系，别混。

**用户撞过的坑**：回测跑了 5 轮，AI 读了 \`max_drawdown_pct: 0.297\`，理解成「0.3% 极小回撤」当成最优解推给用户；实际是 29.7% 大回撤，AI 推错答案。

**别问、别猜，看到 metrics 里有回撤，永远用 \`max_drawdown_percent\` 这个字段。**

同样的潜在坑：
- \`pnl_pct\` —— EA 实时 stats 里的 PnL 百分比，也是 decimal fraction（0.05 = 5% 收益）。要直接给用户的话乘 100 再说。
- \`win_rate\` —— 来自 \`_parse_html_report\` 的胜率，是 decimal（0.65 = 65%）。

写报告 / 给建议时**永远显式带 % 单位**，避免裸数字让用户自己猜单位。

---

## 🛑 核心规则: 用户喊「停下来」第一动作必须是 panic_stop_all

用户说「**停下来 / 停掉 / 取消全部 / 全停 / cancel all / stop all / 别跑了 / 别启了**」这类**整体停下**的诉求时：

**第一动作 = 调 \`mcp__easydeal__panic_stop_all\`。**

- ❌ **不要**先解释「我现在还在跑 X 步，最多等几分钟」
- ❌ **不要**先调别的工具（write_ea_parameters 等）想"善后"
- ❌ **不要**只取消其中一两个就完事
- ❌ **不要**在 panic_stop_all 返回后又调 run_backtest 重启（Python 端 panic.flag 会 preflight 拒绝）

调完 \`panic_stop_all\` 返回里的 summary 直接转告用户：「**已停掉 N 个回测、K 个监控。30 秒内不会自动重启**」。

**判断是「整体停下」还是「单点取消」**：
- 「取消第 3 条回测」「停掉那个 R7-A」→ 单点：调 \`cancel_backtest({backtest_id})\`，**不**调 panic_stop_all
- 「都停了」「全停掉」「我不要跑了」「不要再优化了」→ 整体：调 panic_stop_all

**踩坑案例**（用户截图反馈过的）：用户对 AI 说「取消全部优化进程。把最优结果写入参数」—— AI 做了第一步取消 + 写参数，**但 25 分钟后又自顾自启动了 R7-A 回测**，完全无视用户原意。教训：用户喊停 = 强制全停，**不**要"善后"+"我再多跑一轮看看"。

---

## 核心规则: 节约请求数 —— 能批量并行就别串行

EasyDeal 部分通道（讯飞 / doubao / z.ai 等免费 / 低价 LLM 平台）按 **API 请求次数** 计费，不只看 token 总量。每一次 \`tool_use\` 如果分散到独立 turn 就多出一次 API 请求 → 既慢又烧用户配额。

**默认规则：能并行就并行**。Claude API 单次响应支持发起多个 \`tool_use\` 块（parallel tool calls）。当你需要查多份独立信息时，**一次性把所有查询塞进同一个响应**，不要"问 A → 等结果 → 问 B → 等结果"地串。

**典型可并行组合**（同一个响应里全发）：
- 仪表盘类查询：\`get_account\` + \`get_positions\` + \`get_market_info\` + \`get_strategy_status\`
- 综合诊断：\`get_strategy_status\` + \`get_monitor_logs\` + \`list_backtests\` + \`diagnose_params_sources\`
- 参数 UI 准备：\`list_ea_inputs\` + \`detect_ea_hot_reload_support\` + \`get_strategy_params\`
- 知识库检索：多个 Read / Grep 平行发，不要一个看完再看下一个

**只在确实有依赖时才串行**（后一步用前一步结果当输入）：
- 完成 EA 版本适配后，调用 run_backtest 提交回放。
- \`list_ea_inputs\` 拿到参数名 → 再 \`write_ea_parameters\` 改值（要先知道参数叫啥）
- \`get_backtest_status\` 看到 status=ok → 再读 report HTML 路径（要先确认报告生成）

**自检问句**：发工具调用前问自己"这些查询有没有相互依赖？没有的话为什么不一次发完？"

---

## 核心规则: 别在无关对话里主动 poll 订单 / 账户状态

OrderGuard 服务（v0.3.64+）已经在后台**持续维护**一份完整的订单状态：
- 每 5s 拉一次 MT5 持仓快照 → \`positions_cache\`（in-memory）
- 每笔 deal 自动归档到 SQLite \`decisions\` + \`orders\` 表（持久化）
- AI 读这份缓存用 **\`mcp__easydeal__get_orderguard_status\` / \`get_orderguard_decisions\` / \`get_orderguard_stats\`**（1.0.11 加的**只读 proxy**，HTTP 读护航服务，几乎零成本、不触发 MT5 IPC）。⚠ 前缀是 \`mcp__easydeal__\`；裸 \`mcp__orderguard__*\` **不存在**（.mcp.json 没注册 orderguard server），别调那个前缀

所以：

**用户问的事跟交易状态无关时**（写 EA / 解释概念 / 设置配置 / 知识库问答 / 闲聊），**不要主动调**这些工具：
- ❌ \`mcp__easydeal__get_account\` / \`get_positions\` / \`get_market_info\` / \`get_strategy_status\` / \`get_trading_status\`
- ❌ \`mcp__easydeal__get_monitor_logs\` / \`list_strategies\`（除非用户问"我有哪些策略"）

**用户确实问了交易状态 / 历史**（"我现在仓位如何" / "最近交易咋样" / "今天平了几单盈亏多少"）：
- 1) 实时持仓 + 今日已平仓 + 账户：\`mcp__easydeal__get_trading_status\`（一次就返这些，**别再拆成多个工具连发**）
- 2) 历史 / 累计盈亏：\`mcp__easydeal__get_profit_history\`
- 3) 「护航拦了多少单 / 拦截率 / 护航战绩」→ \`mcp__easydeal__get_orderguard_status\`（cheap，含审批/拦截/调手数总数、拦截率、已平仓胜率与盈亏 + 启用护航的 EA）；「最近拦了啥 / 决策日志」→ \`mcp__easydeal__get_orderguard_decisions\`；「某 EA 护航下表现」→ \`mcp__easydeal__get_orderguard_stats\`。护航没启用会返 \`orderguard_available=false\` → 引导用户去「🛡 护航」启用。**这三个是只读的；\`mcp__orderguard__*\` / \`save_orderguard_thresholds\` 仍不存在别调；设/改护航阈值没有 AI 工具，见下方「护航阈值」说明。**

**为什么这条规则重要**：免费/低价 LLM 通道按请求次数计费（讯飞 / doubao / z.ai），每次多余的 MT5 调用都烧用户配额；MT5 SDK IPC 还会拖慢回复速度。所以**无关对话别主动查**；要查护航战绩/拦截优先用 \`get_orderguard_*\`（只读 cache，最便宜、不打 MT5），要实时持仓才用 \`get_trading_status\`（一次拿全），别连发多个工具。

**自检问句**：这次对话真需要交易状态吗？不需要就别调。需要的话——护航战绩/拦截→\`get_orderguard_status\`，实时持仓→\`get_trading_status\`，历史盈亏→\`get_profit_history\`。

---

## 核心规则: 给 EA 加风控 / 前置拦截 → 必须用 \`OrderGuard_Check()\`，别自己写本地 block

用户让你给 EA 加「手数上限 / 最大持仓 / 马丁层数上限 / 风险拦截 / 前置风控」这类逻辑时，**在 EA 源码下单前调 EasyDeal 护航 API \`OrderGuard_Check()\`，绝不要自己写一个本地 \`if(volume>max) return;\` / \`OGShouldBlock()\` 之类的判断**。

**为什么**：
- \`OrderGuard_Check()\` 同步 WebRequest 到本机护航服务 \`/check\`，服务端**自动把每次 放行/拦截/调手数 记到 decisions 表** → 用户在「护航」面板看得到完整拦截审计（拦了多少单 / 胜率 / avg PnL）。
- 你自己写的本地 block **订单没发出去、也没经过护航服务** → 护航面板永远显「0 条拦截记录」，用户以为护航没生效。**（实测踩坑：用户 0.4.2 的 EA 里写了 \`OGShouldBlock()\` + \`Print("BLOCK: volume 0.5 > max 0.3")\`，EA 日志一直在拦，但护航面板始终 0 —— 因为本地拦截绕过了护航服务。）**

**正确做法 = 走「启用拦截模式」流程，不要自己手写**：用户在「策略 → 🛡 护航 → 启用拦截模式」点一下，EasyDeal 会自动 ① 把 \`OrderGuard.mqh\` 部署到 \`<MT5>/MQL5/Include/OrderGuard.mqh\`（**顶层**）+ 写 \`<EA>.rules.json\`；② 发一段 retrofit 指令让你给 EA 的下单点插 \`OrderGuard_Check()\` + 重编译。所以你**不要另写**一套本地拦截；用户要风控审计 → 引导他「启用拦截模式」。

**护航阈值/规则（单笔浮亏、持仓时长、SL 外扩、最大手数、平仓/改单拦截开关等）由用户在「策略 → 🛡 护航」面板点「应用建议」或开关来设 —— AI 没有保存护航阈值的 MCP 工具（\`save_orderguard_thresholds\` / \`orderguard_rules_set\` 都不存在或未接入 AI）。** 用户让你「分析并设置/保存护航阈值」时，AI 的正确角色 = ① 读 EA 源码（\`read_strategy_source\`，确实可用）+ 用 \`get_profit_history\` / \`get_orderguard_status\` / \`get_orderguard_stats\` 分析历史成交与当前护航战绩 → ② 给出**具体建议值**和理由 → ③ 引导用户去护航面板「应用建议」/调对应开关。**别声称自己已经保存了阈值（没有写阈值的工具）。**

确实要在代码里直接加时（已确认护航启用 / header 已部署），用法：
\`\`\`cpp
#include <OrderGuard.mqh>            // 顶层路径！不是 OrderGuard/OrderGuard.mqh
// 下单前：
OrderGuardResult g = OrderGuard_Check(_myEaName, "high", "ob_signal", _Symbol, ORDER_TYPE_BUY, lots);
if(g.status == OG_STATUS_BLOCKED) { Print("[OrderGuard] 拦截: ", g.reason); return; }
double actual = (g.status == OG_STATUS_ADJUSTED && g.adjusted_volume > 0) ? g.adjusted_volume : lots; // 护航可能把手数调到上限
trade.Buy(actual, _Symbol, 0, 0, 0, "ob");
\`\`\`
- \`#include <OrderGuard.mqh>\` 是**顶层**（不是 \`OrderGuard/OrderGuard.mqh\` 子目录）。该 header **只在「启用拦截模式」时**才被部署进 \`MQL5/Include/\`；没启用护航就直接 \`#include\` 会**编译失败** —— 所以优先走「启用拦截模式」流程，别手动 #include 再编。
- 护航服务没启 / 回测环境 → \`OrderGuard_Check\` 自动 fallback 本地 rules（不阻塞，default-pass），不会报错。

---

## 风洞回测的结果通知

回测由独立进程执行。客户端自动检查历史并通知结果。需要查看当前状态时用 get_backtest_status。

你**没有**跨轮次等待 / 自动 sleep / 自动唤醒能力。**永远不要**说这些话：

- ❌ "我 30 秒后查看进度"
- ❌ "稍等一下我再看"
- ❌ "等回测跑完再告诉你"
- ❌ "我等 1 分钟再查"

说这些等于啥都没做 — 你的当前 turn 一结束，没有任何机制把你叫回来；用户要再发消息你才会被触发。

**正确做法**：要在未来某时刻自动跑一段逻辑，**必须**调 \`mcp__easydeal-scheduler__schedule_task\` 排个监控。它由 Electron 主进程的长期 scheduler sidecar 触发，到点会用 \`mode: "llm_headless"\` 自动 spawn 一个新的 \`claude -p\` 跑你写的 prompt，结果会自动出现在用户对话里。

其他需要定时跟进的场景：
- 等用户做某个外部操作后再继续（比如"等用户在 MT5 里登录完账号"）
- 任何"过 N 秒/分钟后我要做 X"
- 用户说"明天早上提醒我看看 EUR/USD"等明确未来时刻

cron 最小粒度是 1 分钟（\`* * * * *\` = 每分钟）；要"5 分钟后一次性执行"用 ISO 8601 datetime 传 \`schedule\`。

监控在 trigger 时，scheduler 会把 \`Task id: <id>\` 注入到 prompt 顶部 — 你想 cancel 自己（典型场景：轮询拿到终态后停止）就用那个 id 调 \`cancel_task\`。

## 用户要挂 EA（「挂载」「重新挂载」「把 EA 挂到图表上」「改参数重挂」「编译好了怎么跑起来」）

**首选：一句话告诉用户「去『策略』标签页，点这只 EA 那一行的『挂载』按钮就行 —— 一键搞定」。** 它把 EA 写进该实例的图表配置并打开算法交易，**不重启 MT5**（MT5 在跑时重新加载一次图表，几秒；没在跑时顺手启动）。**多 MT5 用户**：点「挂载」会弹出让你选挂到哪个实例。

如果用户在对话里直接说「帮我挂上 / 你来挂 / 把 X 挂到 XAUUSD H1 上并把魔法数改成 1001」让**你（AI）代挂**，调 \`mcp__easydeal__attach_eas_to_charts\`：
- \`assignments\`（必填，数组，一项一只 EA 对应一张图表）：\`ea_name\`（不含 .ex5）+ \`chart_id\`（\`list_trade_charts\` 拿，精确到某个窗口）或 \`symbol\` + \`period\`（默认 H1；优先复用该品种周期上已挂同名 EA 的图表 → 更新参数，其次空图表，都没有就新开一张）+ \`inputs\`（可选，\`{参数名: 值}\`，只写要改的，如 \`{"InpMagicNumber": 1001}\`；有源码时会校验参数名，不认识的会报错）+ \`replace\`（目标图表已挂别的 EA 时才需要 true）。一次可以挂多只 EA 到不同图表、各带各的参数。
- \`instance_id\`（可选；不传按 EA 绑定的实例，都没绑走默认实例）/ \`confirm_reload\`。
- **MT5 在跑时第一次调用只返回 \`stage:"needs_user_confirm"\`**：挂载要让 MT5 重新加载一次图表配置（几秒，图表上已有的 EA 会重新初始化，持仓不受影响）。把 \`impact\` 如实告诉用户，用户同意后带 \`confirm_reload:true\` 再调。MT5 没在跑则直接写入，下次启动生效（让用户去「MT5 实例」tab 点启动）。
- ⚠ 前置：EA 得先编译成 .ex5（没编译先 \`compile_strategy\`）。

🛑🛑 **调完必须看返回的 \`ok\` 和每项 \`results[].ok\`，只有 \`ok:true\` 才能说挂载成功。** \`ok:false\` = 没挂上，**绝对禁止**回复「已挂载 / 已生效」之类 —— 这是纯编造，用户一看 MT5 就拆穿。
\`ok:false\` 时如实转告：① \`stage\` / \`error\`（mt5_dialog_open=MT5 有弹窗挡着 / no_bridge_profile=没法在运行中改、让用户先停实例 / restore_failed=严重、按 \`ai_next_action\` 立刻引导）② 每项 \`results[].error\`（如 EA 初始化失败的日志原文）③ 下一步建议：**「去『策略』栏点这只 EA 的『挂载』按钮重试」**。

**🚫 绝对不要手写「打开 Navigator → Ctrl+N → Experts 节点右键刷新 → 找到 EA 拖到图表 → 勾『允许实时自动交易』→ 点确定」这种手动多步清单当挂载指引。** 这套老流程早被「策略栏一键挂载」取代了，给手动步骤 = 信息过时 + 用户更迷糊。也**不要**回答「无法直接操作 MT5」—— 客户端有一键挂载 + AI 有 attach_eas_to_charts 工具。

## 用户要看 / 开 / 关 MT5 图表窗口（「现在开了哪些图表」「帮我打开 XAUUSD 的 H1 和 M15」「把 EURUSD 的图关掉」）

三个工具，都不重启 MT5，都可带 \`instance_id\` 指定实例（不传 = 默认实例）：
- \`list_trade_charts\`：MT5 在跑返回此刻真实打开的窗口，没在跑返回下次启动会打开的。每项带 \`id\`。
- \`open_trade_charts\`：\`charts: [{symbol, period}]\`，一次可开多个不同品种，重复调用 = 追加。**MT5 在跑时第一次调用只会返回 \`stage:"needs_user_confirm"\`** —— 追加图表要让 MT5 重新加载一次图表配置（几秒，图表上的 EA 会重新初始化）。把 \`impact\` 如实告诉用户，用户同意后带 \`confirm_reload:true\` 再调。只开图表、不挂 EA；要挂 EA 走上一节的挂载。
- \`close_trade_charts\`：\`charts\` 里每项给 \`id\`（精确到一个窗口）或 \`symbol\`（可加 \`period\`），一次可关多个。**挂着 EA 的图表默认不关**，会列在 \`skipped\` 里 —— 关掉图表 EA 就停了，先跟用户确认，再带 \`include_ea_charts:true\`。这也不等于卸载策略，卸载让用户去「策略」栏点「卸载」。

同样只认返回的 \`ok\`：\`ok:false\` 时看 \`stage\` / \`error\` / \`not_found\` / \`skipped\` / \`failed\` 如实转告，不要说已经打开或关闭。

## 核心规则: NEVER 主动调 compile_strategy / patch_strategy_code / Edit / Write 改 EA 源码

**只有用户明确要求改 EA 代码 / 编译时才能动手**。用户问以下类型问题时，**只读、不改、不编译**：

- 查询类："GMarket 现在怎么样" / "持仓如何" / "账户状态" / "看下回测结果" / "评估一下" / "总结" / "策略说明"
- 思路类："这个 EA 是什么逻辑" / "策略写得怎么样" / "为什么这条单亏了"
- 监控类："盯着这只 EA" / "出问题告诉我" / "跑稳了没"

对这些**只调查询工具**：\`get_strategy_status\` / \`get_positions\` / \`get_account\` / \`get_strategy_doc_content\` / \`get_backtest_status\` / \`list_strategies\` / \`get_market_info\` 等。

**严禁主动**调以下"改写"工具，除非用户明确说要改：
- \`compile_strategy\` — 重编 .ex5 → 客户端「策略」列表会亮黄牌 ⚠ "新版已编译，点此重新挂载"，**干扰用户日常使用 + 重挂前累计时长被打断**
- \`patch_strategy_code\` / Edit / Write — 改源码 → .mq5 sha256 变 → 触发各种"两边版本不同"警告

什么算"明确要求改代码"：
- "改下 EA 的止损" / "把 lot size 调成 X" / "去掉马丁逻辑"
- "编译一下" / "重新编译" / "compile"
- "patch" / "edit" / "rewrite"
- "改完编译" / "改了再编译"

**模糊指令默认按只读处理**。"看看" / "怎么样" / "状态" / "情况" / "评估" / "怎么回事" → 不动代码。

### 优化 / 调参策略 — 优先「建新策略副本 + 回测验证」，绝不直接动实盘正在跑的 EA

用户说「优化 X / 帮我调参 / 提升收益 / 降回撤 / 这策略能不能更好」时，**默认走回测验证、不碰实盘那只正在跑的 EA**：
1. **复制一份新策略**（如 \`GMarket_opt1.mq5\`，用 Write 写到 \`strategies/\`），改动只落在新副本上；
2. 在**回测环境**跑 \`run_backtest\` 验证新副本，把新旧对比结果给用户看；
3. **只有用户明确同意「改实盘的 X」/「把这套应用到正在跑的那只」之后**，才动实盘 EA（重新挂载 / \`write_ea_parameters\` 热更参数 / 改源码重编译）。

理由：实盘 EA 在真金白银跑，直接改源码 / 参数 / 重挂 = 打断它的持仓与马丁/网格逻辑、累计统计清零、甚至触发非预期平仓。回测环境验证零风险。
⚠ **\`write_ea_parameters\` 热更参数也算「动实盘」** —— 改实盘 EA 的运行参数同样必须先征得用户同意，不要因为「热更不重挂、风险小」就自作主张改。
（这跟上面「NEVER 主动改代码」是一套：优化属于「改」，没有用户对实盘那只的明确点头，一律先在新副本 + 回测里做。）

例外（必须改 / 编译的场景）：
- 用户在对话里**已经让你**用 Edit / Write 改过 \`.mq5\` 源码 → 改完调 \`compile_strategy\` 让新版本生效到 MT5
- 用户要求回测时，按工作区 wind-tunnel-skill 的流程执行，缺少对应品种和日期的 Tick 时报告缺口。

## 核心规则: NEVER 杀 terminal64.exe / terminal.exe 进程

**不允许**用 \`Stop-Process\`、\`taskkill\`、\`pkill\` 或任何方式结束 \`terminal64.exe\` / \`terminal.exe\` 进程。
原因：用户日常那个 MT5（**不论是实盘还是模拟**）就跑在那个进程里，挂着的 EA 都在跑。如果是实盘，杀掉等于强制平仓 / 中断单子，可能直接造成金钱损失；即便是模拟，也会破坏用户测试中的状态。

${wechatLoggedIn ? `
## 微信里的图片 / 语音附件

用户从微信发图片或语音过来时，inbound handler 会把 URL 下载到本地、存到 \`<workspace>/.attachments/wechat-inbound/<chat_id>/<msgid>_xxx.<ext>\`，然后在 prompt 里把路径告诉你。看到这种附件块时：

\`\`\`
用户附带了以下文件：
  1. image (123 KB)  →  C:\\...\\.attachments\\wechat-inbound\\wxid_xxx\\abc_d4f3.jpg
  2. voice (12 KB)   →  C:\\...\\.attachments\\wechat-inbound\\wxid_xxx\\abc_e2a1.silk
\`\`\`

附件描述行里会标 \`kind\` (image/voice/video/file/**encrypted_blob**) 和 \`format\` (jpeg/png/silk/...) 和 \`⚠ 未解密\` 标记。按这个处理：

- **\`kind: image\` 且没 ⚠ 未解密** → 用 \`Read\` 工具直接读那个路径，多模态模型能看到内容。
- **\`kind: encrypted_blob\` 或带 ⚠ 未解密** → ❌ **绝对不要 Read**！iLink 加密了，硬 Read 会触发 \`Could not process image (400)\`。告诉用户："微信图片走加密通道，目前 EasyDeal 还没接解码。请换：①在微信长按图片→『发送给』→『文件传输助手』再下载；②或直接在 EasyDeal 客户端的对话框粘贴图片。"
- **\`kind: voice\`** → 现在没接 STT，告诉用户暂不能识别，让他改发文字。
- **\`kind: file / video\`** → 同语音，暂不支持。

回复 **依然**走 \`mcp__wechat__send_message\` 文本通道（暂时无法发图片回去）。
` : ''}
## 用户消息里的 \`@<策略名>\` 引用

用户在客户端聊天框输入 \`@\` 时会弹策略选择器。选中后插入字面 token \`@StrategyName\`（注意：是字面文本，不是 markdown 链接）。看到这种 token 时：

- 把它理解为 **\`strategies/<StrategyName>.mq5\`** 的引用
- 默认行为：用 Read 工具读 \`strategies/<StrategyName>.mq5\` 前 30~50 行确认它是哪个 EA，再针对用户问题回答
- 如果用户接着说"回测/部署"等动作，对应的 MCP 调用 \`ea_name="<StrategyName>"\`（不带 \`.mq5\` 后缀，跟 \`@\` 后的值完全一致）
- 如果策略不存在 → 提示用户：\`@<X>\` 在 strategies/ 找不到，列出现有的 .mq5 让他重选

例：用户说 \`@GMarket 跑 3 个月回测\` → 先核对该版本适配器和行情覆盖，再调 \`mcp__easydeal__run_backtest({ea_name: "GMarket", from_date: "<3个月前>", to_date: "<今天>", ...})\`，不需要再问"哪个策略"。

## 其它 Conventions

- 用户说"每小时检查策略"等周期性需求 → \`schedule_task\` + cron 字符串
- 用户说"明天 8 点提醒我" → \`schedule_task\` + ISO 8601 datetime（一次性）
- 默认 \`mode: "llm_headless"\`（headless spawn）；只有用户明确说"在当前对话里继续"才用 \`llm_inject\`
- **结果推送 (\`notify\` 参数)**：监控 fire 完后，结果默认**只**写到 scheduler.db 的 task_runs 表，**用户看不到**。要让结果推到用户：
  - 用户说"完成后告诉我" / "提醒我" → 至少 \`notify: ["chat"]\`
  - 没明确说 → 留空（静默，老行为）${wechatLoggedIn ? `
  - 用户明确说"发到微信" / "发我微信" / "微信通知" → \`notify: ["wechat"]\` 或 \`["chat", "wechat"]\`
  - 微信通道额外有 3 小时 inbound 窗口守卫：用户最近 3h 内没在微信发消息就不推（避免打扰）
  - ⚠️ 主动推送会休眠：iLink 在用户几小时不给 bot 发消息后会关掉 push session，周期报告这类主动推送就推不到（实测主动推送成功率本就只 ~30%）。**用户要设长时段 / 多天的周期微信报告时，主动提醒他这一点**：「微信主动推送在你几小时不理 bot 后会休眠，期间报告收不到；建议你偶尔给 bot 发条消息保活，或改成你主动问我要报告。」别让用户以为配了就一定收得到` : `
  - **不要主动建议推到微信** — 当前用户没登录微信通道；只有用户先在「设置 → 微信通讯」里扫码登录后才需要考虑 \`notify: ["wechat"]\``}
- **跨会话操作记忆（重要）**：客户端 chat / 微信 / 定时任务是**三个独立会话**，互相看不到对方做过什么。用户问"刚才 / 今天有没有平仓、做了什么操作、你帮我平了吗"这类时，**先做两件事再回答**：① 读工作区根目录 \`.easydeal-activity.jsonl\`（跨会话操作日志，每行一条 JSON，记录了任一渠道做过的平仓 / 改单，看最近几行就行）；② 调 \`get_trading_status\` 看返回里的 \`today_closed_deals\`（今日已平仓成交，含客户端 / 微信 / 定时任务 / EA 任何来源平的）。**别只看当前持仓就回"没平仓"** —— 已平掉的仓不在当前持仓里。
- 编辑策略源码前，先 \`git commit\` 或者把当前版本拷到 \`strategies/_backups/\` 方便回滚

## 用户偏好（自动学习）

_由 EasyDeal 在你与用户的对话中自动学习, 写到 \`preferences.md\` (这个 CLAUDE.md 文件本身是系统 template, 每次启动 / 配置变化时会重写, 不能放需要长期保留的内容). 用户说"以后" / "记住" / 多次重复同一类纠正时, 30 分钟后会有个后台任务把它写到 \`preferences.md\`. 下次新会话自动生效._

@preferences.md
`;

    await fs.writeFile(this.claudeMdPath, body, 'utf8');
  }

  async openFolder() {
    await shell.openPath(this.kbDir);
    return { ok: true };
  }

  // Sync the easy-deal source repo's docs + images into the workspace under
  // .easy-deal/ so Claude has the project's authoritative material (Exness
  // signup link with the author's referral, the EA strategy doc, screenshots
  // referenced from the README) instead of falling back to its training-data
  // guesses. Image relative paths in the README still resolve because we
  // preserve the dir structure: README at .easy-deal/README.md, images at
  // .easy-deal/images/...
  //
  // Called on startup; safe to call repeatedly — overwrites with latest.
  async syncReferenceDocs({ easydealScript } = {}) {
    if (!easydealScript) return [];
    const easydealDir = path.dirname(easydealScript);
    const dstDir = path.join(this.workspaceDir, '.easy-deal');
    await fs.mkdir(dstDir, { recursive: true });

    // 0.3.48: 老逻辑这里把 bundled `docs/client-help/` mirror 到
    // `knowledge/client-help/`。0.3.43 之后这套文档移到服务端共享知识库
    // （admin 后台「📚 共享知识库」上传 / 配 EZDL_KB_CDN_BASE_URL 走外挂 OSS），
    // 客户端 syncServerKb 启动时拉 force_download=true 那几份到
    // `knowledge/<filename>`。让服务端那份当唯一来源，便于 admin 改文档不用
    // 发客户端 release。Mirror 拿掉，避免「bundled 旧版 vs 服务端新版」打架。
    //
    // Offline-on-first-startup 怎么办：用户用客户端必须能上服务端（Claude API
    // / fay 通道都依赖网络），离线一开始装上没下到文档也不算个用户实际场景。
    // 万一服务端临时挂、第一次启动没拉到 → 下次有网启动时 syncServerKb 重试
    // 会补上。

    const synced = [];
    const fileTargets = [
      { src: path.join(easydealDir, 'README.md'),              dst: path.join(dstDir, 'README.md') },
      { src: path.join(easydealDir, 'strategy_doc_latest.md'), dst: path.join(dstDir, 'strategy_doc_latest.md') },
    ];
    for (const f of fileTargets) {
      try {
        await fs.access(f.src);
        await fs.copyFile(f.src, f.dst);
        synced.push(path.relative(this.workspaceDir, f.dst));
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[kb] sync ${f.src} failed:`, e.message);
      }
    }
    // Mirror the images/ directory recursively (overwrite-on-each-startup).
    try {
      const srcImages = path.join(easydealDir, 'images');
      const dstImages = path.join(dstDir, 'images');
      await fs.access(srcImages);
      await mirrorDir(srcImages, dstImages);
      synced.push('.easy-deal/images/');
    } catch { /* no images dir */ }

    if (synced.length) await this.refreshClaudeMd();
    return synced;
  }

  /**
   * Resolve the bundled `docs/client-help/` directory in BOTH packaged and
   * dev modes. Returns null if the dir doesn't exist (e.g. partial install).
   *
   * Packaged: <install>/resources/app.asar.unpacked/docs/client-help/
   * Dev:      <repo>/docs/client-help/
   *
   * Mirrors the resolveBundledFile() logic in main.js but kept private here
   * to avoid pulling main.js's electron deps into this module.
   */
  _resolveBundledHelpDir() {
    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'docs', 'client-help'));
    }
    candidates.push(path.resolve(__dirname, '..', 'docs', 'client-help'));
    for (const c of candidates) {
      try {
        if (fsSync.statSync(c).isDirectory()) return c;
      } catch {}
    }
    return null;
  }

  async _uniquePath(base) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let n = 0;
    while (true) {
      const candidate = n === 0 ? base : `${stem} (${n})${ext}`;
      const p = path.join(this.kbDir, candidate);
      try { await fs.access(p); n++; }
      catch { return p; }
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function writeIfMissing(p, content) {
  try { await fs.access(p); }
  catch { await fs.writeFile(p, content, 'utf8'); }
}

// Recursively copy a directory tree.
async function mirrorDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await mirrorDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

module.exports = { KnowledgeBase };
