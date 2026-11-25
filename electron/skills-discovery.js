// Skills + MCP-tool inventory.
//
// Pulls together everything the Claude Code session in our workspace can
// actually invoke, so the Skills tab can list it for the user:
//
//   1. MCP tools — live-queried by spawning each MCP server briefly,
//      reading its tools/list response. We use the same StdioMcpClient
//      we already have for the persistent scheduler sidecar.
//
//   2. Skills — scanned from disk:
//      - ~/.claude/skills/<name>/SKILL.md           (user-installed)
//      - ~/.claude/plugins/marketplaces/<m>/{plugins,external_plugins}/<p>/skills/<name>/SKILL.md
//        (skills shipped via plugin marketplaces; we list them all so the
//         user knows what's available in their environment)
//
// Each SKILL.md begins with YAML frontmatter:
//   ---
//   name: foo
//   description: ...
//   ---

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StdioMcpClient } = require('./python-mcp-client');

// Friendly Chinese labels for common tools / skills. Falls back to the raw
// name when missing.
const ZH_LABELS = {
  // easydeal-scheduler
  schedule_task:        '创建定时任务',
  list_tasks:           '列出定时任务',
  cancel_task:          '删除任务',
  pause_task:           '暂停任务',
  resume_task:          '恢复任务',
  update_task:          '修改任务',
  get_task:             '查询单个任务',
  get_task_history:     '任务执行历史',
  list_due_tasks:       '到点任务（内部）',
  begin_run:            '开始执行（内部）',
  finish_run:           '结束执行（内部）',
  // easydeal MT5
  run_backtest: '启动风洞回测',
  get_backtest_status: '查询回测状态',
  list_backtests: '回测历史',
  cancel_backtest: '取消回测',
  'wind-tunnel-skill': '策略风洞',
  get_account:               '查看账户',
  get_positions:             '查看持仓',
  get_orders:                '查看挂单',
  get_market_info:           '查看行情',
  get_klines:                '获取 K 线',
  get_strategy_status:       '策略状态',
  get_strategy_params:       '策略参数',
  update_strategy_param:     '热更新参数',
  compile_strategy:          '编译 EA',
  read_strategy_source:      '读取 EA 源码',
  patch_strategy_code:       '修改 EA 代码',
  get_strategy_backups:      '历史备份',
  diagnose_params_sources:   '诊断参数来源',
  get_monitor_logs:          '监控日志',
  get_strategy_documentation:'策略文档',
  close_position:            '平仓',
  modify_sl_tp:              '修改止损止盈',
  get_trading_status:        '交易状态',
  // window_capture (Fay)
  list_windows:    '列出窗口',
  capture_window:  '截屏窗口',
  // built-in / user skills
  'design-md':            '应用设计语言（DESIGN.md）',
  'karpathy-guidelines':  'Karpathy 编码守则',
  'update-config':        'Claude Code 配置助手',
  'keybindings-help':     '键位绑定助手',
  'simplify':             '代码简化建议',
  'fewer-permission-prompts': '减少权限弹窗',
  'loop':                 '循环任务调度',
  'schedule':             '定时任务调度',
  'claude-api':           'Claude API 帮助',
  'init':                 '初始化 CLAUDE.md',
  'review':               'PR 评审',
  'security-review':      '安全审查',
  'consolidate-memory':   '记忆整合',
  'pdf':                  'PDF 处理',
  'xlsx':                 '电子表格处理',
  'pptx':                 '幻灯片处理',
  'docx':                 'Word 文档处理',
  'skill-creator':        'Skill 创建器',
  'setup-cowork':         'Cowork 协作配置',
};

function zhLabel(id) {
  return ZH_LABELS[id] || null;
}

// Brief one-line description from a longer text. Picks first sentence
// up to ~80 chars.
function brief(s) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const cut = text.match(/^[^。.;；]{4,80}[。.;；]?/);
  return (cut ? cut[0] : text.slice(0, 80)).trim();
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

/**
 * Enumerate tools for a single MCP server (stdio). For our long-lived
 * scheduler sidecar we just reuse its already-open client. For the
 * easydeal Python MT5 server we spawn a short-lived client, list tools,
 * then close it.
 */
// Order matters here — the UI renders groups in array order. We surface the
// EasyDeal MT5 / EA monitoring tools FIRST because that's the product's core
// (trading), with the scheduler as a supporting service after it.
const SERVER_PRIORITY = ['easydeal', 'easydeal-scheduler', 'window-capture'];

async function enumerateMcpTools({ scheduler, schedulerScript, easydealScript, pythonBin, windowCaptureScript, tradingWriteEnabled = false, tradingWriteOpenEnabled = false }) {
  const groups = [];

  // EasyDeal MT5 (priority 0) — only if a script path is configured.
  if (easydealScript) {
    // 把 EASYDEAL_TRADING_WRITE / EASYDEAL_TRADING_WRITE_OPEN 同步注进
    // 探针 env，使 list_tools 返回的工具集 = 用户实际跑 chat 时看到的。
    // 否则 Skills 页永远不显示 close_position / modify_position / open_position
    //（即使用户开了开关），跟实际生效状态对不上。
    // 0.3.236: 加 EASYDEAL_PROBE_ONLY=1 让 Python list_tools 跳过 start_all_services.
    // 否则每 5s Skills 自动 refresh 一次都 spawn 新 ephemeral, 各自调 mt5.initialize()
    // 不带 path → SDK 自动 launch 默认 MT5, race condition 下双进程.
    const probeEnv = {
      PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
      EASYDEAL_PROBE_ONLY: '1',
      EASYDEAL_MT5_ALLOW_LAUNCH: '0',
    };
    if (tradingWriteEnabled) probeEnv.EASYDEAL_TRADING_WRITE = '1';
    if (tradingWriteOpenEnabled) probeEnv.EASYDEAL_TRADING_WRITE_OPEN = '1';
    const tools = await ephemeralEnumerate({
      command: pythonBin || 'python',
      args: [easydealScript],
      env: probeEnv,
      label: 'easydeal-probe',
    });
    groups.push({
      server: 'easydeal',
      label: 'EasyDeal MT5 / EA 监控',
      kind: tools ? 'on-demand' : 'error',
      script: easydealScript,
      tools: tools || [],
      error: tools ? null : 'failed to enumerate (start MT5 / install Python deps?)',
      // 给 UI 标志，方便在 Skills 页显示「⚠ 允许平仓改单」「⚠⚠ 允许开仓」chip
      trading_write_enabled: !!tradingWriteEnabled,
      trading_write_open_enabled: !!tradingWriteOpenEnabled,
    });
  }

  // Scheduler (priority 1)
  if (scheduler && scheduler.ready) {
    try {
      const tools = await scheduler.listTools();
      groups.push({
        server: 'easydeal-scheduler',
        label: '定时任务调度',
        kind: 'live',
        script: schedulerScript || null,
        tools: tools.map((t) => normalizeTool(t)),
      });
    } catch (e) {
      groups.push({ server: 'easydeal-scheduler', label: '定时任务调度', kind: 'error', error: e.message, tools: [] });
    }
  }

  // Window capture (priority 2) — Fay's screenshot MCP, only if configured.
  if (windowCaptureScript) {
    const tools = await ephemeralEnumerate({
      command: pythonBin || 'python',
      args: [windowCaptureScript],
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      label: 'window-capture-probe',
    });
    groups.push({
      server: 'window-capture',
      label: '窗口截图（来自 Fay）',
      kind: tools ? 'on-demand' : 'error',
      script: windowCaptureScript,
      tools: tools || [],
      error: tools ? null : 'failed to enumerate (Pillow installed?)',
    });
  }

  // Stable sort by priority so adding more servers later is straightforward.
  groups.sort((a, b) => {
    const ia = SERVER_PRIORITY.indexOf(a.server);
    const ib = SERVER_PRIORITY.indexOf(b.server);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return groups;
}

async function ephemeralEnumerate(spawnOpts) {
  const client = new StdioMcpClient(spawnOpts);
  try {
    await client.start({ timeoutMs: 12_000 });
    const tools = await client.listTools();
    return tools.map((t) => normalizeTool(t));
  } catch (e) {
    console.warn(`[skills] enumerate ${spawnOpts.label} failed:`, e.message);
    return null;
  } finally {
    try { await client.stop(); } catch {}
  }
}

function normalizeTool(t) {
  return {
    name: t.name,
    label: zhLabel(t.name),
    description: brief(t.description),
  };
}

// ---------------------------------------------------------------------------
// Claude Code skills
// ---------------------------------------------------------------------------

/**
 * Scan the user's Claude Code install for SKILL.md files. Returns groups by
 * source (user / plugin name).
 */
async function enumerateSkills(windTunnelDir) {
  const homedir = os.homedir();
  const groups = [];

  if (windTunnelDir) {
    const skill = await parseSkillFile(path.join(windTunnelDir, 'SKILL.md'));
    if (skill) groups.push({source: 'bundled', label: '客户端内置', path: windTunnelDir, skills: [skill]});
  }

  // 1. User-installed skills directly under ~/.claude/skills/
  const userDir = path.join(homedir, '.claude', 'skills');
  const userSkills = await scanSkillsDir(userDir, 5);
  if (userSkills.length) {
    groups.push({
      source: 'user',
      label: '用户自装',
      path: userDir,
      skills: userSkills,
    });
  }

  // 2. Plugin marketplace skills
  const mpRoot = path.join(homedir, '.claude', 'plugins', 'marketplaces');
  let mps = [];
  try { mps = await fs.readdir(mpRoot, { withFileTypes: true }); } catch {}
  for (const mp of mps) {
    if (!mp.isDirectory()) continue;
    // Look in plugins/<*>/skills/  AND  external_plugins/<*>/skills/
    for (const sub of ['plugins', 'external_plugins']) {
      const subRoot = path.join(mpRoot, mp.name, sub);
      let plugins = [];
      try { plugins = await fs.readdir(subRoot, { withFileTypes: true }); } catch { continue; }
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        const pluginSkillsDir = path.join(subRoot, plugin.name, 'skills');
        const skills = await scanSkillsDir(pluginSkillsDir, 3);
        if (skills.length) {
          groups.push({
            source: `plugin:${mp.name}/${plugin.name}`,
            label: `${plugin.name}（来自 ${mp.name}）`,
            path: pluginSkillsDir,
            skills,
          });
        }
      }
    }
  }

  return groups;
}

async function scanSkillsDir(rootDir, maxDepth = 4) {
  const skills = [];
  await walk(rootDir, maxDepth, skills);
  // Deduplicate by absolute path; sort by friendly label.
  const seen = new Set();
  return skills
    .filter((s) => {
      if (seen.has(s.path)) return false;
      seen.add(s.path); return true;
    })
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, 'zh'));
}

async function walk(dir, depth, out) {
  if (depth <= 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === 'SKILL.md') {
      const parsed = await parseSkillFile(full);
      if (parsed) out.push(parsed);
    } else if (e.isDirectory()) {
      await walk(full, depth - 1, out);
    }
  }
}

async function parseSkillFile(p) {
  let content;
  try { content = await fs.readFile(p, 'utf8'); }
  catch { return null; }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  const name = meta.name || path.basename(path.dirname(p));
  return {
    name,
    label: zhLabel(name),
    description: brief(meta.description || ''),
    path: p,
    user_invocable: meta['user-invocable'] !== 'false',
  };
}

module.exports = { enumerateMcpTools, enumerateSkills };
