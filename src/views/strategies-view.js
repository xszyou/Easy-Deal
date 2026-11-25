import { renderMarkdown } from '../markdown.js';

const GMARKET_RISK_ACK_KEY = 'easydeal.gmarketRiskAcknowledged';
const GMARKET_RISK_NOTICE = [
  '挂载 GMarket 前请确认：',
  '',
  'GMarket 包含对冲和马丁加仓逻辑，可能在剧烈波动、点差扩大、流动性不足或连续单边行情中产生快速且显著的亏损。',
  '',
  '· 请先在模拟账户和策略测试器中验证；',
  '· 自行设置手数、最大亏损、周盈亏限制，只投入能承受损失的资金；',
  '· 本策略不构成投资建议，也不保证收益。',
  '',
  '点「确定」表示你已了解以上风险。',
].join('\n');
// Strategies view — list user's local EAs under workspace/strategies/.
// Each row: name, hash, runtime stats, action buttons. The "上架" button
// is gated by the same track-record requirements the server will enforce:
//   - hours_run >= 24h (1 day live)
//   - has at least one passing backtest covering ≥ 90 days with net_profit > 0

const fmtSize = (b) => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};
const fmtPct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

// pnl_pct comes through as a fraction (0.05 = 5%), so *100 like fmtPct.
const fmtPnl = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

// 0.3.109: 「收益」列同时显示百分比 + USD 金额（跟 admin 后台「累计盈亏 USD」+
// leaderboard「盈利金额」对齐，方便横向对照）。
// 0.3.118: 优先用 server 直接返的 pnl_usd（precise，跟 leaderboard 用同款 SUM(pnl)
// 来源）；没 server 数据才 fallback 本地 pnl_pct × initial_balance（约等于）。
const fmtPnlCell = (pnlPct, initialBalance, serverPnlUsd = null) => {
  if (pnlPct == null && serverPnlUsd == null) return '—';
  const pctNum = pnlPct != null ? pnlPct : 0;
  const sign = pctNum > 0 ? '+' : '';
  const pctStr = pnlPct != null ? `${sign}${(pnlPct * 100).toFixed(1)}%` : '—';
  const color = pctNum > 0 ? 'var(--success)'
              : pctNum < 0 ? 'var(--danger)'
              : 'var(--text-3)';
  // USD 金额计算 — 优先 server precise，fallback 本地 pct × balance
  let pnlUsd = null;
  if (serverPnlUsd != null && Number.isFinite(Number(serverPnlUsd))) {
    pnlUsd = Number(serverPnlUsd);
  } else {
    const ib = Number(initialBalance) || 0;
    if (ib > 0 && pnlPct != null) pnlUsd = pnlPct * ib;
  }
  if (pnlUsd == null) {
    return `<span style="color:${color};">${pctStr}</span>`;
  }
  const usdSign = pnlUsd > 0 ? '+' : '';
  const usdStr = `${usdSign}${pnlUsd.toFixed(2)} $`;
  return `<div style="line-height:1.3;"><span style="color:${color};">${pctStr}</span><div style="color:${color};font-size:11px;opacity:0.85;">${usdStr}</div></div>`;
};

// 0.3.153: 13 列对齐排行榜后, 「总收益率」拆成独立列, 「盈利金额」也独立列。
// fmtPctCell: 纯百分比 + 正负色 (跟排行榜「总收益率」同款渲染)
const fmtPctCell = (pnlPct) => {
  if (pnlPct == null) return '<span style="color: var(--text-3);">—</span>';
  const sign = pnlPct > 0 ? '+' : '';
  const color = pnlPct > 0 ? 'var(--success)' : pnlPct < 0 ? 'var(--danger)' : 'var(--text-3)';
  return `<span style="color:${color};">${sign}${(pnlPct * 100).toFixed(1)}%</span>`;
};
// fmtUsdCell: 纯 USD 金额 + 正负色 (优先 server precise, fallback pct × ib)
const fmtUsdCell = (serverPnlUsd, pnlPct, initialBalance) => {
  let pnlUsd = null;
  if (serverPnlUsd != null && Number.isFinite(Number(serverPnlUsd))) {
    pnlUsd = Number(serverPnlUsd);
  } else {
    const ib = Number(initialBalance) || 0;
    if (ib > 0 && pnlPct != null) pnlUsd = pnlPct * ib;
  }
  if (pnlUsd == null) return '<span style="color: var(--text-3);">—</span>';
  const sign = pnlUsd > 0 ? '+' : '';
  const color = pnlUsd > 0 ? 'var(--success)' : pnlUsd < 0 ? 'var(--danger)' : 'var(--text-3)';
  return `<span style="color:${color};">${sign}${pnlUsd.toFixed(2)} $</span>`;
};

// Cache of user's own marketplace listings, keyed by ea_name. Refreshed on
// each refresh() so the table can show "已上架" badges and disable submit.
let myListingsByEa = {};

// 0.3.55: 缓存每只 EA 的关键元数据（has_source / has_compiled / hours_run /
// is_mounted），key = item.name（带扩展名，跟 tr[data-name="..."] 一致）。
// renderDocPanel 用这份信息决策 .ex5-only 时 AI 生成路径是否可用：
//   - 有 .mq5 源码 → 走老路径（AI Read 源码写文档）
//   - 没源码 + hours_run >= 72 → 提供「AI 推测（基于日志）」按钮
//   - 没源码 + hours_run < 72 → 强制手动写
// 每次 refresh() 重建。
let _strategyMetaByName = {};
// 0.3.87: 当前护航启用 EA 状态缓存 { ea_name: {mode, magic, enabled} }，每次 refresh
// 列表时一并拉，用于在行内「🛡 护航」按钮上标启用状态（监控中 / 拦截中 / 未启用）
let _orderguardEnabledByEa = {};
// 0.3.189 Phase 2: MT5 实例列表 + 默认实例 id 缓存（refresh 时填，每行 picker 共享）
let _mt5InstancesCache = [];
let _mt5ActiveId = null;

// 0.3.55: 「一键修改」热更新协议跨 tab 续场 —— 用户在「参数设置」弹窗里看到
// 「⚠ 该 EA 不支持热更新」时，点「一键修改」按钮 → 跳 chat 让 AI 改源码 →
// 用户改完回到「我的策略」tab → renderStrategies() 检测到 _pendingParamsReopen
// 有值 → 自动重新打开同一只 EA 的参数设置对话框（hot-reload 检测会重跑，
// 改完了通常会变成 ✓）。一次性，复用完清空。
let _pendingParamsReopen = null;

// ---------------------------------------------------------------------------
// Metric explanations — click the ⓘ next to any metric label to see this.
// Keep wording 1-2 sentences, plain Chinese, end with rough "好坏区间"
// where it makes sense so the user has a benchmark.
// ---------------------------------------------------------------------------
const METRIC_HELP = {
  net_profit: {
    name: '净利润 (Net Profit)',
    body: '回测期内的总盈亏（毛利 - 毛损），单位 USD。正数赚钱，负数亏钱。\n\n看这一项要配合「初始资金」和「最大回撤」一起看 —— 净利润 +5000 但最大回撤 -8000，意味着账户中途差点爆仓，靠运气拉回来的，不算稳。',
  },
  sharpe: {
    name: '夏普比率 (Sharpe Ratio)',
    body: '收益与波动的比值 = 年化收益 / 年化波动率。同样赚 10%，波动小的夏普高、波动大的夏普低。\n\n参考区间：\n  < 0.5  差（收益跟瞎买没区别）\n  0.5~1  普通\n  1~2    较好\n  2~3    优秀\n  > 3    要警惕过拟合 / 数据穿越',
  },
  recovery_factor: {
    name: '采收率 / 恢复因子 (Recovery Factor)',
    body: '净利润 ÷ 最大回撤。衡量"跑出来的钱能扛几倍最大回撤"，越高越能挺住坏行情。\n\n参考区间：\n  < 1   赚的还没回撤大，风险大于回报\n  1~2   普通\n  2~5   较好\n  > 5   优秀（也要警惕样本太短 / 过拟合）',
  },
  max_drawdown: {
    name: '最大回撤 (Max Drawdown)',
    body: '账户净值从历史最高点跌到最低点的最大幅度，按百分比算。\n\n这是判断策略"最坏多坏"的关键指标 —— 实盘心理承受要按这个准备。\n  < 10%  保守稳健\n  10~20% 普通\n  20~30% 激进，但还能上架（上架阈值 ≤ 30%）\n  > 30%  激进过头，多半带马丁/网格，慎用',
  },
  trades: {
    name: '交易笔数 (Total Trades)',
    body: '回测期内的总成交次数（开仓 + 平仓 各算一次的话看 MT5 字段；这里指完整交易对数）。\n\n样本太少 ( < 30 笔) 的统计意义弱 —— 可能是运气好赶上几次大行情。建议交易笔数 ≥ 50 再看其它指标，上架要求也是 ≥ 50。',
  },
  win_rate: {
    name: '胜率 (Win Rate)',
    body: '盈利交易数 ÷ 总交易数。\n\n胜率高 ≠ 赚钱多 —— 高胜率配小盈亏比（每次赚 1 输 5）依然亏钱。要跟「盈亏比」一起看：\n  胜率 70% + 盈亏比 0.3 = 大概率亏\n  胜率 40% + 盈亏比 3.0 = 大概率赚\n看「期望值」最直接。',
  },
  profit_factor: {
    name: '盈亏比 (Profit Factor)',
    body: '毛利 ÷ |毛损|。同样的钱进去，赢的总额是输的几倍。\n\n参考区间：\n  < 1   亏\n  1~1.3 勉强糊口\n  1.3~2 普通\n  > 2   较好\n  > 3   优秀（也要警惕极端值拉高）',
  },
  expected_payoff: {
    name: '期望值 (Expected Payoff)',
    body: '每笔交易的平均盈亏 = 净利润 ÷ 交易笔数。\n\n这是策略"每开一单平均能挣多少"的最直观指标 —— 正期望就是赚钱机器，负期望就是亏钱机器，跟胜率没关系。\n  > 0   能赚\n  < 0   能亏\n大小要看你的资金体量和手数 —— $50/单 在 0.1 手 vs 1 手意义完全不同。',
  },
  // 持仓中的统计
  pnl_today: {
    name: '今日盈亏',
    body: '从今天 00:00 到现在的累计盈亏（USD）。每个 EA 单独算，按 magic number 归类的成交。',
  },
  account_baseline: {
    name: '账户基准',
    body: '该 EA 第一次被监测到时的账户余额。后续 pnl_pct 用 (当前盈亏 / 基准) 计算，所以这个数定下来后不变。',
  },
  equity_peak: {
    name: '权益高点',
    body: '从开始监测到现在，账户净值（余额 + 浮盈）的历史最高点。最大回撤 = (峰值 - 当前) / 峰值。',
  },
};

function helpIcon(key) {
  if (!key || !METRIC_HELP[key]) return '';
  return `<span class="bt-help" data-help-key="${key}" title="点击查看说明">ⓘ</span>`;
}

// One-time delegated click handler for help icons. Mounts a single popup,
// reuses it for every click. Clicking the backdrop or × closes.
let _helpModalEl = null;
function ensureHelpModalListener() {
  if (window._metricHelpListenerInstalled) return;
  window._metricHelpListenerInstalled = true;
  document.addEventListener('click', (e) => {
    const icon = e.target.closest?.('.bt-help[data-help-key]');
    if (icon) {
      e.preventDefault();
      e.stopPropagation();
      const key = icon.getAttribute('data-help-key');
      const help = METRIC_HELP[key];
      if (!help) return;
      showMetricHelp(help);
      return;
    }
    if (_helpModalEl && (e.target === _helpModalEl
        || e.target.closest?.('[data-help-close]'))) {
      _helpModalEl.remove();
      _helpModalEl = null;
    }
  });
}
function showMetricHelp({ name, body }) {
  if (_helpModalEl) { _helpModalEl.remove(); _helpModalEl = null; }
  const overlay = document.createElement('div');
  overlay.className = 'mkt-modal';
  overlay.innerHTML = `
    <div class="mkt-modal-body" style="max-width: 460px;">
      <div class="row between" style="margin-bottom: 8px;">
        <h2 style="margin: 0; font-size: 16px;">${escape(name)}</h2>
        <button class="btn ghost small" data-help-close>✕</button>
      </div>
      <div style="white-space: pre-wrap; line-height: 1.7; color: var(--text-2); font-size: var(--fs-md);">${escape(body)}</div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        <button class="btn primary small" data-help-close>知道了</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _helpModalEl = overlay;
}

export function renderStrategies(root) {
  root.innerHTML = '';
  ensureHelpModalListener();   // metric ⓘ icons → click → explanation popup

  // 0.3.55: 跨 tab 续场 —— 如果用户刚才在「参数设置」点了「一键修改」跳到
  // chat 让 AI 改了源码，回到「我的策略」时自动把同一只 EA 的对话框重新弹
  // 出来。新一次 openParamsSettingsDialog 会重跑 detect_ea_hot_reload_support，
  // 用户能立刻看到是否变 ✓。
  if (_pendingParamsReopen) {
    const eaFile = _pendingParamsReopen;
    _pendingParamsReopen = null;
    // setTimeout 让本轮 render() 先完成 DOM 渲染（弹窗依赖某些样式 / 不阻塞首屏）
    setTimeout(() => { try { openParamsSettingsDialog(eaFile); } catch {} }, 120);
  }

  const hero = el('section', 'hero-tight');
  hero.innerHTML = `
    <h1>策略</h1>
    <p class="lede">本地源码 + 运行成绩单。</p>
    <p class="lede" style="margin-top: 4px; font-size: var(--fs-md);">
      <span style="color: var(--text-4);">💡 策略代码在 <strong>独立的工作区</strong>，对话修改 / 挂载都不会动你添加时的原文件。</span>
      <a href="#" id="st-paths-help" style="margin-left: 6px; color: var(--accent, #4a9eff); text-decoration: none;">查看 3 个位置 ↓</a>
    </p>
    <div id="st-paths-card" class="card" style="display: none; margin-top: 8px; padding: 12px 16px; font-size: var(--fs-md);">
      <div style="font-weight: 500; color: var(--text); margin-bottom: 8px;">代码副本一共 3 处，互不联动</div>
      <table style="width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: var(--fs-sm);">
        <tr><td style="padding: 4px 8px 4px 0; color: var(--text-3); white-space: nowrap; vertical-align: top;">① 你添加时的原文件</td><td style="padding: 4px 0; color: var(--text-4);">永不被动 — 添加时只是 copy 一份给客户端</td></tr>
        <tr><td style="padding: 4px 8px 4px 0; color: var(--text-3); white-space: nowrap; vertical-align: top;">② 工作区</td><td style="padding: 4px 0;"><code id="st-workspace-path" style="color: var(--text-2);">…</code><br><span style="color: var(--text-4); font-family: var(--font-sans, sans-serif);">EasyDeal 自己 + 对话里的 AI 都改这里</span></td></tr>
        <tr><td style="padding: 4px 8px 4px 0; color: var(--text-3); white-space: nowrap; vertical-align: top;">③ MT5 挂载位置</td><td style="padding: 4px 0;"><code id="st-mt5-path" style="color: var(--text-2);">…</code><br><span style="color: var(--text-4); font-family: var(--font-sans, sans-serif);">点「挂载」会把 .ex5（不含 .mq5）拷到这里 — MT5 实际加载的就是这个</span></td></tr>
      </table>
    </div>
  `;
  root.appendChild(hero);

  // 0.3.232: 顶部「账户总览」banner 已移除 — 多 MT5 时它只能显默认实例的账户,
  // 跟下面的 EA 行 (按 binding 走各自实例账户) 数字对不上, 反而困惑. EA 行的
  // 「投入资金 / pnl / hours_run」已含每个 EA 自己 broker 账户的具体值, 不需要
  // 再总览一行. MT5 卡片自身也显当前余额, 想看汇总到 MT5 tab.

  // Wire the "查看 3 个位置" disclosure under the lede. Populates real
  // paths from app.info() — workspace + MT5/Experts target — so the user
  // can verify where their code actually lives.
  hero.querySelector('#st-paths-help')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const card = hero.querySelector('#st-paths-card');
    if (!card) return;
    const open = card.style.display !== 'none';
    if (open) { card.style.display = 'none'; return; }
    try {
      const info = await window.easydeal.app.info();
      const ws = (info.workspace || '?') + '\\strategies\\';
      const mt = info.mt5DataDir
        ? info.mt5DataDir + '\\MQL5\\Experts\\'
        : '（MT5 未配置）';
      hero.querySelector('#st-workspace-path').textContent = ws;
      hero.querySelector('#st-mt5-path').textContent = mt;
    } catch {}
    card.style.display = '';
  });

  const top = el('div', 'card');
  top.innerHTML = `
    <div class="section-head">
      <h2>策略源码</h2>
      <span class="sub">workspace/strategies/</span>
      <span class="spacer"></span>
      <span id="st-mount-heartbeat" class="tag" style="color: var(--text-3); font-family: var(--font-mono); margin-right: 4px;" title="挂载状态轮询 / 5s 一次">— MT5 心跳</span>
      <button class="btn primary" id="st-ai">用 AI 创建新策略 ✨</button>
      <button class="btn ghost"   id="st-add">添加文件</button>
      <button class="btn ghost"   id="st-folder">打开文件夹</button>
      <button class="btn ghost"   id="st-refresh">刷新</button>
    </div>
    <div class="hint-grid">
      <div class="hint-block">
        <div class="hint-title">📝 新建策略</div>
        <ul>
          <li><strong>AI 写</strong>：点上方「用 AI 创建新策略」，AI 问完品种/周期/思路后写代码</li>
          <li><strong>上传文件</strong>：现成的 <code>.mq5</code> 源码或 <code>.ex5</code> 编译产物（买的纯 .ex5 也行）</li>
          <li><strong>手动放</strong>：直接丢到 <code>workspace/strategies/</code></li>
          <li style="color: var(--text-4); font-size: var(--fs-sm); margin-top: 4px; list-style: none; padding-left: 0;">⚠ 添加 = <strong>复制一份</strong>到工作区，原文件不会被动；之后改的都是工作区副本</li>
        </ul>
      </div>
      <div class="hint-block">
        <div class="hint-title">🚀 挂载到 MT5</div>
        <ul>
          <li>点行内 <strong>挂载</strong>：有源码就让 AI 编译；只有 .ex5 就直接拷到 <code>MQL5/Experts/</code>，然后选自动重启 MT5 或手动挂到图表</li>
          <li>到 MT5 Navigator 把 EA 拖到图表，行内显示 <span class="tag mounted" style="font-size: var(--fs-xs);">运行中</span></li>
          <li>检测信号：<code>MQL5/Logs/</code> 的 load/remove 记录 + <code>MQL5/Files/&lt;EA&gt;_runtime.json</code> mtime（取并集，第三方 EA 也识别）</li>
          <li style="color: var(--text-4); font-size: var(--fs-sm); margin-top: 4px; list-style: none; padding-left: 0;">⚠ 挂载只拷 <code>.ex5</code>（不拷 <code>.mq5</code>）— MT5 加载二进制即可，源码留在工作区给你 / AI 改</li>
        </ul>
      </div>
    </div>
    <div id="st-list">
      <!-- 0.3.55: refresh() 拉数据期间显示加载骨架 — 之前是空白，
           用户切到这个 tab 会以为客户端卡死了。Promise.all 里 list / liveStats
           / eligibility 通常 1-3 秒，首次启动可能 5-10 秒。 -->
      <div style="padding:30px 16px;text-align:center;color:var(--text-3);">
        <div style="display:inline-flex;align-items:center;gap:10px;font-size:14px;">
          <span style="display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;"></span>
          <span>加载策略列表…</span>
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--text-4);">扫 workspace/strategies/ + MT5 挂载状态 + 本地成绩</div>
      </div>
    </div>
  `;
  root.appendChild(top);

  // 0.4.22: 稳健的「用户正在交互」标记 — 不依赖 document.activeElement。
  // 背景: 原生 <select> 弹层打开时, Windows/Chromium 上 document.activeElement
  // 偶发不是该 select (而是 body), 导致 _hasOpenInteractiveUI 漏判 → 5s 刷新照样
  // renderList 把正在选的 MT5 实例 dropdown 关掉 (用户反馈「这个下拉也一样会被刷掉」)。
  // focusin/focusout 会可靠地框住「表单元素得焦 → 失焦」整段 (select 原生弹层打开
  // 期间 select 一直持有焦点, focusout 不会提前触发), 完全不看 activeElement。
  // 委托挂在 top 上: renderList 只换 #st-list 子树, top 本身稳定; 每次
  // renderStrategies 重建 top (root.innerHTML 被 render() 重置) 所以监听不会累积。
  let _stInteractFlag = false;
  let _stInteractClearTimer = null;
  top.addEventListener('focusin', (e) => {
    if (e.target?.matches?.('input, select, textarea')) {
      _stInteractFlag = true;
      if (_stInteractClearTimer) { clearTimeout(_stInteractClearTimer); _stInteractClearTimer = null; }
    }
  });
  top.addEventListener('focusout', (e) => {
    if (!e.target?.matches?.('input, select, textarea')) return;
    if (_stInteractClearTimer) clearTimeout(_stInteractClearTimer);
    // 失焦后 150ms 再清 — 给「焦点在表单元素间跳转 / select change 收尾」留缓冲;
    // 若焦点还落在表内某表单元素上则不清 (用户在编辑别的格子)。切实例 change
    // 处理器会先 confirm()/select.disabled=true 让 select 失焦, 之后才 await IPC +
    // refresh, 那时本 flag 已清, 不会挡住「选完后该有的重渲染」。
    _stInteractClearTimer = setTimeout(() => {
      _stInteractClearTimer = null;
      const ae = document.activeElement;
      if (ae && ae.matches?.('input, select, textarea') && top.contains(ae)) return;
      _stInteractFlag = false;
    }, 150);
  });

  top.querySelector('#st-ai').addEventListener('click', async () => {
    const r = await window.easydeal.app.requestEaCreateGuide();
    if (r.ok) {
      showToast('已发起请求，切到对话标签页跟 AI 沟通', 'ok');
      if (typeof window.showTab === 'function') window.showTab('chat');
    } else {
      showToast(r.error || '发起失败', 'error');
    }
  });
  top.querySelector('#st-add').addEventListener('click', async () => {
    const r = await window.easydeal.strategies.upload();
    if (!r.added?.length) return;
    // Stress that it's a COPY into workspace, not a link to the original.
    // Users get confused later when chat-edits don't appear in their
    // original folder; calling it out here saves a support ticket.
    showToast(
      `已复制 ${r.added.length} 个文件到工作区（原文件不会被动）`,
      'ok',
    );
    await refresh();
  });
  top.querySelector('#st-folder').addEventListener('click', () => window.easydeal.strategies.openFolder());
  top.querySelector('#st-refresh').addEventListener('click', refresh);

  refresh();

  // Auto-refresh every 5s so .mq5 files Claude writes via chat appear
  // without the user clicking 刷新, AND so the 运行中 / 心跳 stays current.
  // When a doc/history panel is open we still want to refresh the heartbeat
  // tag, just not blow away the open panel. So we skip the LIST render
  // there but keep polling the mount state.
  // 0.3.252: 用户反馈"MT5 实例 dropdown 选择时被 5s 刷新关掉" — 之前 guard
  // 只 check `.mc-cell input` (魔术号/品种), 没 cover `.mt5-inst-select` (MT5
  // 绑定下拉) 跟 `.ed-inst-pick` (多 MT5 挂载选实例对话框). 统一一个 helper
  // 检测**任何**用户正在交互的 UI 元素, 4 处 guard 都用.
  const _hasOpenInteractiveUI = () => {
    // 0.4.22: 最可靠的一条 — focusin/focusout 维护的交互标记 (见 top 上的监听),
    // 不依赖 activeElement, 原生 select 弹层打开期间也稳。放最前面短路。
    if (_stInteractFlag) return true;
    if (root.querySelector('.mc-cell input')) return true;
    // 浏览器原生 <select> dropdown 打开时 activeElement = 该 select
    const ae = document.activeElement;
    if (ae && ae.classList?.contains('mt5-inst-select')) return true;
    if (ae && ae.tagName === 'INPUT' && root.contains(ae)) return true;   // 表内任何 input focus
    if (ae && ae.tagName === 'SELECT' && root.contains(ae)) return true;  // 表内任何 select focus
    // 模态对话框 (pickMt5InstanceForDeploy / orderguard / 等)
    if (document.querySelector('.mkt-modal')) return true;
    // 1.2.23: 「⋯ 更多」浮层展开时不重建表格 —— 否则 30s poll 刷新把菜单刷没了(用户反馈
    // 「这个更多展开的菜单会被刷新刷掉」)。菜单关掉后下一轮 poll 自然恢复刷新。
    if (document.querySelector('.sa-menu:not([hidden])')) return true;
    return false;
  };
  const pollTimer = setInterval(async () => {
    // 0.3.131: inline 编辑「魔术号 / 品种」单元格期间不能 rerender，否则 input
    // 被吃掉用户白打。作者反馈：「这个修改过程中就会被刷新关掉」。
    // 0.3.252: 扩展到所有用户交互中的 UI (select dropdown / modal).
    if (_hasOpenInteractiveUI()) {
      // 类似 panelOpen 路径，只更新心跳 tag，不重建表格
      try {
        const list = await window.easydeal.strategies.list();
        const hb = top.querySelector('#st-mount-heartbeat');
        if (hb) {
          // 0.4.29: 跟 #8 绿「运行中」chip 同款 gate (is_deployed && mt5 在跑 &&
          // 日志确认加载中) — 否则 header「N 个挂载」会跟可见绿 chip 数对不上。
          const mounted = list.filter((x) => x.is_deployed && x.mt5_running !== false && x.is_mounted_in_log).length;
          const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          hb.textContent = `MT5 心跳 ${t} · ${mounted} 个挂载`;
          hb.style.color = mounted > 0 ? 'var(--success)' : 'var(--text-3)';
        }
      } catch {}
      return;
    }
    const panelOpen = root.querySelector('.history-row') || root.querySelector('.strategy-doc-editor');
    if (panelOpen) {
      // Still update the heartbeat tag without re-rendering rows.
      try {
        const list = await window.easydeal.strategies.list();
        const hb = top.querySelector('#st-mount-heartbeat');
        if (hb) {
          // 0.4.29: 跟 #8 绿「运行中」chip 同款 gate (is_deployed && mt5 在跑 &&
          // 日志确认加载中) — 否则 header「N 个挂载」会跟可见绿 chip 数对不上。
          const mounted = list.filter((x) => x.is_deployed && x.mt5_running !== false && x.is_mounted_in_log).length;
          const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          hb.textContent = `MT5 心跳 ${t} · ${mounted} 个挂载`;
          hb.style.color = mounted > 0 ? 'var(--success)' : 'var(--text-3)';
        }
      } catch {}
      return;
    }
    refresh();
  }, 5000);
  // settings.json 变了（典型场景：Claude 切了 MT5 install / dataDir，启动自检
  // 自动归正了 dataDir）→ 立刻 refresh 列表，不用等 5s 轮询。EA 挂载状态完全
  // 看 dataDir，dataDir 一变这里必须马上重读。
  const offSettingsChanged = window.easydeal?.settings?.onChanged?.(() => {
    // 0.3.131 + 0.3.252: inline 编辑 / select dropdown / modal 期间跳过
    if (_hasOpenInteractiveUI()) return;
    refresh().catch(() => {});
  });
  // 0.3.238: 护航 enable / disable 后 main.js broadcast orderguard:state-changed,
  // 立刻 refresh 表行让「🛡 护航」chip 变成「🛡 监控中 / 🛡 拦截中」, 不等 5s pollTimer.
  // 之前 UI 没监听这事件 → AI 改完代码用户切回「我的策略」tab 一看 chip 还是「🛡 护航」
  // 以为没成功; 实际是 cache 没刷.
  const offOgStateChanged = window.easydeal?.orderguard?.onStateChanged?.((payload) => {
    if (_hasOpenInteractiveUI()) return;
    console.log('[strategies-view] orderguard state-changed', payload);
    refresh().catch(() => {});
  });
  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      clearInterval(pollTimer);
      try { offOgStateChanged?.(); } catch {}
      try { offSettingsChanged?.(); } catch {}
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // 用户切到对话让 Claude 写 .md / .mq5，回来时 showTab 调这个 refresher
  // 强刷一次列表 —— 必要时（doc 面板还开着）也越过 panelOpen 的暂停逻辑，
  // 因为 panel 自身有自轮询会同步刷新自己，列表这边的徽章也得跟着清掉。
  return () => {
    // 0.3.131 + 0.3.252: inline 编辑 / select dropdown / modal 期间跳过
    if (_hasOpenInteractiveUI()) return;
    refresh().catch(() => {});
  };

  async function refresh() {
    // 0.3.54: 防止 refresh 跟用户点「回测 / 说明」展开面板撞车。pollTimer 已经
    // 在调用前查过 .history-row，但用户在 5s 轮询的 await IPC 中途点击时，refresh
    // 已经在跑、回来时把 history-row 一起 innerHTML 清掉了 —— 用户感受就是「回测
    // 按钮点了又弹回去」。这里二次校验：IPC 回来后落 DOM 前再看一眼面板状态。
    const panelOpenPre = root.querySelector('.history-row') || root.querySelector('.strategy-doc-editor');
    if (panelOpenPre) return;

    // 0.3.49: liveStats 跟 list / unread / mine / elig 并行拉。Python MCP 实时
    // 算每只 mounted EA 的 trades / pnl / max_drawdown / open_*。失败回退到
    // list 自带的 records 字段（老路径，至少不空白），但成功时 live 优先。
    const [list, unread, mine, elig, live, ogEnabled, serverStats, mt5InstancesResp] = await Promise.all([
      window.easydeal.strategies.list(),
      window.easydeal.strategies.unreadBacktests(),
      // Best-effort — server may be down.
      window.easydeal.mkt.myListings().catch(() => ({ items: [] })),
      // Per-EA eligibility (hours_run + best 3-mo passing backtest); used to
      // gate the 上架 button. Cheap (single backtests.json read main-side).
      window.easydeal.strategies.eligibilityBundle().catch(() => ({})),
      // Live stats from MT5 via MCP — only for currently mounted EAs.
      window.easydeal.strategies.liveStats?.().catch(() => ({ ok: false })),
      // 0.3.87: 当前护航启用 EA 列表 — 给行内「🛡 护航」按钮标状态
      window.easydeal.orderguard?.enabledEas?.().catch(() => ({ ok: false })),
      // 0.3.118: server-side strategy_daily_stats 聚合（leaderboard 同款 SUM(pnl)/MIN(balance)）
      // 拉过来 merge 进每行的 pnl_pct / pnl_usd，让「我的策略」跟「排行榜」数字一致。
      // server 不可达 / 404 → fallback 用本地 records 算的（不破坏老体验）。
      window.easydeal.mkt.myStats?.().catch(() => ({ items: [] })),
      // 0.3.189 Phase 2: MT5 实例列表（给每行的「🖥 实例」picker 用）
      window.easydeal.mt5Instances?.list?.().catch(() => ({ items: [] })),
    ]);
    // 缓存 MT5 实例列表给 renderList 用
    _mt5InstancesCache = Array.isArray(mt5InstancesResp?.items) ? mt5InstancesResp.items : [];
    _mt5ActiveId = mt5InstancesResp?.active_id || null;
    // 0.3.118: server stats lookup by ea_name（带 .mq5/.ex5 后缀都剥掉）
    const serverStatsByEa = new Map();
    for (const s of (serverStats?.items || [])) {
      const name = String(s.ea_name || '').replace(/\.(mq5|ex5)$/i, '').trim();
      if (!name) continue;
      // 同名多 hash 时取 pnl_sum 更大的（重编后最新累计，跟 leaderboard 按 ea_name 聚合一致）
      const prev = serverStatsByEa.get(name);
      if (!prev || (Number(s.pnl_usd) || 0) > (Number(prev.pnl_usd) || 0)) {
        serverStatsByEa.set(name, s);
      }
    }
    // 0.3.87: 用护航 enabled 列表填充 _orderguardEnabledByEa 缓存
    _orderguardEnabledByEa = {};
    for (const ea of (ogEnabled?.data?.eas || [])) {
      if (ea?.ea_name) _orderguardEnabledByEa[ea.ea_name] = ea;
    }
    myListingsByEa = {};
    // 只把「在架(listed)」算作已上架。/me 返回任何状态(含 withdrawn)——之前不分状态
    // 直接塞进 map → 下架后该 EA 仍显「已上架」+「下架」钮, 看着像下架没生效 (用户 报的 bug)。
    for (const it of (mine?.items || [])) {
      if (it.status && it.status !== 'listed') continue;
      myListingsByEa[it.ea_name] = it;
    }
    // 重建 strategy meta 缓存 — renderDocPanel 用它判断 .ex5-only / 挂载时长
    _strategyMetaByName = {};
    for (const it of list) {
      _strategyMetaByName[it.name] = {
        has_source:     !!it.has_source,
        has_compiled:   !!it.has_compiled,
        hours_run:      +it.hours_run || 0,
        is_mounted:     !!it.is_mounted,
        // 0.3.72: 是否需要重挂（.ex5 比 MT5 内存里加载的版本新 — AI 改完代码 + 编译之后）
        is_stale:       !!it.is_stale,
        mt5_ex5_mtime:  it.mt5_ex5_mtime || null,
        last_loaded_at: it.last_loaded_at || null,
      };
    }
    // Merge per-EA best 3-mo backtest into the row data so renderList can
    // gate the 上架 button without an extra IPC roundtrip.
    for (const it of list) {
      const eaName = String(it.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
      it._best_3mo_backtest = elig?.[eaName]?.best_3mo_backtest || null;
    }
    // Merge live stats per EA name. Live items only exist for mounted EAs;
    // unmounted ones keep their records-derived values (mostly stale but
    // shouldn't change while unmounted anyway).
    if (live?.ok && Array.isArray(live.items)) {
      const byEa = {};
      for (const s of live.items) byEa[s.ea_name] = s;
      for (const it of list) {
        const eaName = String(it.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
        const s = byEa[eaName];
        if (!s) continue;
        it.trades = s.trades;
        it.pnl_pct = s.pnl_pct;
        it.max_drawdown = s.max_drawdown_pct;
        it._live = s;     // 给 renderList 显示 today_* / open_* / magic_resolved_by 用
      }
    }
    // 0.3.118: server stats 覆盖 pnl_pct + 加 pnl_usd（leaderboard 同款口径），
    // 让「我的策略」UI 跟「排行榜」数字一致。merge 时机放在 live 之后是因为：
    //   - live stats: 实时 MT5 deal stream 抓的，是本机当前真实值（已挂载的 EA 才有）
    //   - server stats: 所有上报过 daily snapshot 的 EA 都有，是「跟 leaderboard 对得上」的口径
    //   优先级：server stats > live stats > local records
    // initial_balance 也透出来让 fmtPnlCell 算 USD 时用 server 端的而不是本地 record.
    for (const it of list) {
      const eaName = String(it.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
      const s = serverStatsByEa.get(eaName);
      if (!s) continue;
      // 0.3.149: 优先用 server `metric_*` 字段 (compute_metric 派生, 跟排行榜 + admin 同源,
      // 含 license_hardcoded anchor / invested_capital 分母 / 浮亏含 drawdown 等).
      // metric_* 拿不到 (老 client raw 空) 时退到 0.3.118 老路径 (pnl_pct / pnl_usd / total_*).
      if (s.metric_pnl_pct != null) it.pnl_pct = s.metric_pnl_pct;
      else if (s.pnl_pct != null) it.pnl_pct = s.pnl_pct;

      if (s.metric_invested_capital != null) it.initial_balance = s.metric_invested_capital;
      else if (s.initial_balance) it.initial_balance = s.initial_balance;

      if (s.metric_pnl_usd != null) it._server_pnl_usd = s.metric_pnl_usd;
      else if (s.pnl_usd != null) it._server_pnl_usd = s.pnl_usd;

      // 0.3.156: metric_* 字段优先级最高, 覆盖 live (live 是本地 client 老路径算的,
      // metric 是 server raw 派生跟排行榜同源). 之前 !it._live 条件让 live 永远赢,
      // 用户截图反馈「策略表行 8.2d/6 笔 vs 排行榜 18d/30 笔」不一致根因.
      if (s.metric_trades_total != null) it.trades = s.metric_trades_total;
      else if (s.total_trades != null && !it._live) it.trades = s.total_trades;

      // hours_run 优先 metric_broker_hours_run (server 0.5.31+ 返, = now - metric_anchor_ts).
      // 老 server 没此字段 → fallback s.total_hours (client 上传值, 跟排行榜不同口径但至少不空).
      if (s.metric_broker_hours_run != null) it.hours_run = s.metric_broker_hours_run;
      else if (s.total_hours != null && !it._live) it.hours_run = s.total_hours;

      if (s.metric_drawdown != null) it.max_drawdown = s.metric_drawdown;
      else if (s.max_dd != null && (it.max_drawdown == null || it.max_drawdown === 0)) {
        it.max_drawdown = s.max_dd;
      }
      // 透出 metric 同源的 symbol / floating 给「成绩单」面板 / 表行 hover 用
      if (s.metric_dominant_symbol) it._metric_symbol = s.metric_dominant_symbol;
      if (s.metric_current_floating_usd != null) it._metric_floating_usd = s.metric_current_floating_usd;
      if (s.metric_anchor_ts) it._metric_anchor_ts = s.metric_anchor_ts;
      // 0.3.153: 13 列对齐排行榜需要的 server-derived 字段, 全部 metric_* 同源:
      //   broker_hours_run — broker 第一笔 deal 起算 (跟排行榜运行时长同口径)
      //   sharpe / profit_factor / win_rate — leaderboard 同款风险指标
      //   invested_capital — 「投入资金」列 (anchor 余额 + 充值 - 提现)
      if (s.metric_broker_hours_run != null) it._metric_broker_hours_run = s.metric_broker_hours_run;  // 已用作 it.hours_run, 这里保留 _ 前缀字段给 hover detail
      if (s.metric_sharpe != null) it._metric_sharpe = s.metric_sharpe;
      if (s.metric_profit_factor != null) it._metric_profit_factor = s.metric_profit_factor;
      if (s.metric_win_rate != null) it._metric_win_rate = s.metric_win_rate;
      if (s.metric_invested_capital != null) it._metric_invested_capital = s.metric_invested_capital;
    }
    // 0.3.54: IPC 回来后再校验一次面板状态 —— 用户可能在 await Promise.all 期间
    // 点了「回测 / 说明」展开面板，这时 renderList 会 innerHTML='' 把刚开的面板
    // 一起干掉，UI 表现为「点了又弹回去」。看到 panel 存在就跳过 renderList。
    const panelOpenPost = root.querySelector('.history-row') || root.querySelector('.strategy-doc-editor');
    // 0.4.21 关键修复 — IPC await 期间用户可能刚点开 inline 编辑(魔术号/品种)或下拉/弹窗。
    // pollTimer 开头的 _hasOpenInteractiveUI 守卫只拦"还没开始的 refresh", 拦不住
    // "refresh 已在飞 → await window.easydeal.strategies.list() 那 100-500ms 中途用户
    // 点开编辑 → await 回来 renderList 把 #st-list innerHTML='' 连 input 带用户输入一起
    // 干掉"这个异步竞态。openInlineMonitorEdit 的 focusout re-focus 也救不回(input 已被
    // 移出 DOM, document.body.contains(input)=false)。这正是用户「这两个编辑框总是不稳定,
    // 经常在编辑过程中刷新」的根因。renderList 前再查一次, 正在交互就跳过这轮行重建
    // (心跳 tag 照常更新), 编辑保存/取消后会自然触发 refresh 把最新数据补上。
    if (!panelOpenPost && !_hasOpenInteractiveUI()) {
      renderList(top.querySelector('#st-list'), list, unread || {}, refresh);
    }
    // Heartbeat tag — shows last poll time + count of EAs detected as 运行中
    const hb = top.querySelector('#st-mount-heartbeat');
    if (hb) {
      const mounted = list.filter((x) => x.is_mounted).length;
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      hb.textContent = `MT5 心跳 ${t} · ${mounted} 个挂载`;
      if (mounted > 0) {
        hb.style.color = 'var(--success)';
        hb.style.borderColor = 'rgba(95,201,146,0.28)';
      } else {
        hb.style.color = 'var(--text-3)';
        hb.style.borderColor = 'var(--border-soft)';
      }
    }
  }
}

function renderList(host, items, unread, refresh) {
  unread = unread || {};
  host.innerHTML = '';
  if (!items.length) {
    const empty = el('div', 'empty');
    empty.textContent = '还没有本地策略。点上方"添加 .mq5"放进来一份吧。';
    host.appendChild(empty);
    return;
  }

  const table = el('table', 'list st-grid');   // st-grid: 启用「操作」列 sticky 钉右 (见 styles.css)
  // 0.3.153: 表头跟「排行榜」对齐 — 显同款 server metric_* 派生字段, 让用户能在
  // 「我的策略」直接看跟排行榜一致的真实业绩 (之前 hash / 魔术号 等配置类字段移到
  // 操作按钮里, 不再占主表行)。运行时长用 server metric_broker_hours_run (broker
  // first_deal 起算) 跟排行榜同源, 不再用 client cumulativeHoursByEa.
  table.innerHTML = `
    <thead>
      <tr>
        <th>文件</th>
        <th style="width: 70px;">说明</th>
        <th style="width: 95px;" title="该 EA 监控的品种 (点击改). 必填 — 没配的 EA 行变黄.">🪙 品种</th>
        <th style="width: 95px;" title="该 EA 的魔术号 magic (点击改). 必填 — 没配的 EA 行变黄.">🎯 魔术号</th>
        <th style="text-align: right; width: 75px;" title="运行时长 — broker 第一笔 deal 起算到现在 (跟排行榜同口径)">运行时长</th>
        <th style="text-align: right; width: 60px;" title="平仓交易数 (anchor 截窗后)">交易数</th>
        <th style="text-align: right; width: 75px;" title="总收益率 = EA 业绩 / 投入资金">总收益率</th>
        <th style="text-align: right; width: 80px;" title="累计 EA 业绩 USD">盈利金额</th>
        <th style="text-align: right; width: 65px;" title="采收率 = 总收益率 / 最大回撤">采收率</th>
        <th style="text-align: right; width: 65px;" title="夏普比率 (年化)">夏普</th>
        <th style="text-align: right; width: 65px;" title="收益因子 = 盈利总和 / 亏损总和">收益因子</th>
        <th style="text-align: right; width: 65px;" title="胜率 (盈利日 / 有交易日)">盈利日%</th>
        <th style="text-align: right; width: 75px;" title="含未平浮亏的最大回撤">最大回撤</th>
        <th style="text-align: right; width: 85px;" title="投入资金 = anchor 余额 + 充值 - 提现">投入资金</th>
        <th style="width: 280px;">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  for (const it of items) {
    const tr = el('tr');
    // 0.3.105: 上架门槛二选一 ——
    //   Path A: 24h 在线 + 实盘 30 天 pnl > 0 + 跨度 ≥ 3 月的回测净利润 > 0
    //   Path B: 7 天 (168h) 在线 + 实盘 30 天 pnl > 0
    // pnl_pct 是 live stats 30-day 窗口净收益率（fraction），> 0 即正盈利。
    const reqs = { min_hours_run_a: 24, min_hours_run_b: 24 * 7, min_backtest_days: 90, ...(it.requirements || {}) };
    const hoursCum = it.hours_run ?? 0;
    const HOURS_DISPLAY_CAP = 30 * 24;
    const hours = Math.min(hoursCum, HOURS_DISPLAY_CAP);
    const hoursCapped = hoursCum > HOURS_DISPLAY_CAP;
    const trades = it.trades ?? 0;
    const dd = it.max_drawdown ?? null;
    const livePnlPct = it.pnl_pct ?? null;
    const passLivePnl = livePnlPct != null && livePnlPct > 0;
    // Path A 用的 3 月回测（best 3-month-passing backtest from main.js → strategies:eligibility-bundle）
    const bestBt = it._best_3mo_backtest || null;
    const passBacktest3m = !!bestBt && (bestBt.days || 0) >= reqs.min_backtest_days && (bestBt.net_profit || 0) > 0;
    const passHoursA = hoursCum >= reqs.min_hours_run_a;
    const passHoursB = hoursCum >= reqs.min_hours_run_b;
    const passPathA = passHoursA && passLivePnl && passBacktest3m;
    const passPathB = passHoursB && passLivePnl;
    // 兼容下面引用的 passHours（用 path B 判定是否「时长够上架」颜色提示）
    const passHours = passHoursB;
    const eaName = String(it.name).split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
    const listing = myListingsByEa[eaName];
    // Listing requires both source (.mq5) and compiled (.ex5):
    //   .mq5 — proves authorship; we don't upload it but it's the gate
    //   .ex5 — what gets uploaded for buyers
    // Strategies that only have .ex5 (e.g. ones bought from market) are
    // NOT relistable. Hash mismatch (workspace .ex5 vs MT5/Experts/.ex5)
    // also blocks — that's the swap-prevention guard.
    const canList = (passPathA || passPathB)
                 && it.has_source && it.has_compiled
                 && it.hash_match !== false
                 && !listing;
    tr.dataset.name = it.name;
    // 0.3.239: MT5 未启动状态视觉强化 — 用户反馈灰色 chip 不显眼一眼看不出. 修法:
    // (a) 行级轻度灰化 opacity=0.78 (比之前 0.55 收敛, 历史数据仍可读 — 「我的策略」
    //     核心功能是看成绩单, 不能压太死) + 背景轻黄底色 让一行整体看着「需注意」
    // (b) 文件名旁的 chip 从灰「○ MT5 未启动」改成黄「⚠ MT5 未运行」 (下面 cell 渲染)
    // (c) hover tooltip 说明数据是历史快照
    if (it.is_deployed && it.mt5_running === false) {
      tr.dataset.mt5Stopped = 'true';
      tr.style.opacity = '0.78';
      tr.style.background = 'rgba(245,158,11,0.05)';
      tr.title = `⚠ EA 已部署但绑定的 MT5 实例当前没在跑\n表行数字是 MT5 上次运行时的历史快照\n去「MT5 实例」tab 点启动按钮拿实时数据`;
    } else if (!it.is_deployed) {
      tr.dataset.mt5Stopped = 'undeployed';
      tr.title = `EA 还没部署到 MT5/Experts/ — 点「挂载」按钮部署`;
    }
    tr.innerHTML = `
      <td>
        <div style="font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span>${escape(it.name)}</span>
          ${(() => {
            // 0.3.238: 改用「ex5 部署到位 AND MT5 进程在跑」三态判断 — 不再靠日志推断
            // (日志在 MT5 关了之后还会保留, 老的 is_mounted_in_log 会误判). 现在三态:
            //   - is_deployed && mt5_running → 「运行中」绿色 (或缺配置黄色)
            //   - is_deployed && !mt5_running → 「⚠ MT5 未运行」黄色显眼
            //   - !is_deployed → 不显 chip (未部署 / EA 还没挂到 MT5)
            // 0.3.239: chip 从灰「○」改成黄「⚠ MT5 未运行」 — 用户反馈灰色一眼看不出.
            if (!it.is_deployed) return '';
            if (it.mt5_running === false) {
              return `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.45);background:rgba(245,158,11,0.12);font-weight:500;" title="EA 已部署到 MT5/Experts/ (sha256 跟 workspace .ex5 ${it.hash_match === true ? '匹配' : it.hash_match === false ? '不匹配' : '?'}), 但绑定的 MT5 实例当前没在跑. 去「MT5 实例」tab 点启动按钮.">⚠ MT5 未运行</span>`;
            }
            // 0.4.25 #8: 绿色「运行中」只在 is_mounted_in_log=true 时显 —— 即 MT5
            // 日志里这只 EA「loaded successfully 之后没被 removed」且事件在 72h 内
            // (strategies.js 的 live 集, Signal A/B). 之前的 gate 只在「从没 load 过」
            // (!last_loaded_at) 时降级, loaded-then-removed 的 EA (last_loaded_at 有值
            // 但 is_mounted_in_log=false) 漏网 → 仍假绿「运行中」。用户实测: 在已挂载的
            // MT5 里把图表上的 EA 删掉, 策略栏仍显运行中。现在统一用 is_mounted_in_log
            // 当「当前是否真在图表上跑」的判据。
            if (!it.is_mounted_in_log) {
              if (!it.last_loaded_at) {
                // 从没成功加载过 —— 多半挂载没成功 (0.4.23 原文案)。
                // 常见: 多 MT5 时 .ex5 拷到了绑定实例目录, 但 startup ini 实际启动的是
                // 另一个 data dir 的终端 → MT5 日志报 'expert not found from start config'。
                return `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.45);background:rgba(245,158,11,0.12);font-weight:500;" title="${escape(eaName)}.ex5 已拷到绑定 MT5 实例的 Experts 目录、该 MT5 进程也在跑，但 MT5 日志里从没出现这只 EA 真正加载的痕迹 —— 多半是挂载没成功。常见原因：.ex5 拷到的实例跟实际启动的终端数据目录对不上 (MT5 日志会报 'expert not found from start config')。用右侧「挂载」按钮重挂一次；多 MT5 用户确认挂到的是正在跑的那台。">⚠ 已部署 · 未确认运行</span>`;
              }
              // 曾成功加载过 (last_loaded_at 有值), 但日志显示已被移除 / 72h 内不再活跃
              // → EA 已经不在图表上跑了 (用户从图表删掉 / 停掉)。不能再显绿色「运行中」。
              const loadedTip = it.last_loaded_at
                ? new Date(it.last_loaded_at).toLocaleString('zh-CN', { hour12: false })
                : '?';
              return `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.45);background:rgba(245,158,11,0.12);font-weight:500;" title="这只 EA 之前在 MT5 上加载过 (最近一次 ${escape(loadedTip)})，但 MT5 日志显示它已经从图表上移除 / 不再活跃 —— 多半是被从图表删掉或停掉了。\n如果你确实把它从图表删了，这是正常的；如果它应该在跑，去 MT5 看图表右上角有没有它的笑脸，或用右侧「挂载」按钮重挂。\n(若当前是长假休市 EA 长时间没产生日志，也可能误报，开盘后会自动恢复。)">⚠ 已停止</span>`;
            }
            // ↓ is_mounted_in_log === true：确实在图表上跑着
            // 0.3.160: 运行中但 symbol/magic 没配 → 改成黄色「⚠ 运行中 (缺配置)」提醒
            const mcCfg2 = it.monitor_config || {};
            const symsCfg2 = Array.isArray(mcCfg2.symbols) ? mcCfg2.symbols.filter(Boolean) : [];
            const magsCfg2 = (Array.isArray(mcCfg2.magic_numbers) && mcCfg2.magic_numbers.length)
              ? mcCfg2.magic_numbers : (mcCfg2.magic ? [mcCfg2.magic] : []);
            const cfgMissing = symsCfg2.length === 0 || magsCfg2.length === 0;
            if (cfgMissing) {
              return `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.08);" title="EA 正在 MT5 上运行, 但「品种」或「魔术号」还没配 — 监控 / 护航 / 跟单 都失效. 点击表行的红色 cell 设置.">⚠ 运行中 · 缺配置</span>`;
            }
            return `<span class="tag mounted" title="此 EA 已部署到 MT5/Experts/ (sha256 匹配) + MT5 进程在跑 + 日志确认当前加载着 (未移除) = 运行中">运行中</span>`;
          })()}
          ${it.is_stale ? (() => {
            const fileT = it.mt5_ex5_mtime ? new Date(it.mt5_ex5_mtime).toLocaleString('zh-CN', { hour12: false }) : '?';
            const loadT = it.last_loaded_at ? new Date(it.last_loaded_at).toLocaleString('zh-CN', { hour12: false }) : '?';
            // 0.3.17: 黄色提示, 0.3.27 曾改成可点击, 0.3.244 改回纯文本提示 —
            // 用户反馈点击功能没必要 (有「挂载」按钮 + AI 对话两条路, chip 只需
            // 文字提醒). 去掉 data-action / cursor:pointer.
            return `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);" title="新版 .ex5 编译于 ${escape(fileT)}，但 MT5 内存里跑的是 ${escape(loadT)} 加载的旧版本。\n用右侧「挂载」按钮重挂, 或跟 AI 说「帮我重新挂载」让它自动跑.\n不重挂也没事, 旧版会继续跑.\n累计运行时长不会因重挂归零.">代码已重新编译，请重新挂载</span>`;
          })() : ''}
          ${it.kind === 'compiled' ? `<span class="tag" title="只有 .ex5（购买的策略）">仅二进制</span>` : ''}
          ${it.has_source && it.has_compiled ? `<span class="tag ok" title="同时拥有源码 + 编译产物">源码+ex5</span>` : ''}
          ${it.has_source && it.ex5_stale ? `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);" title="源码 .mq5 比已编译的 .ex5 新 —— 你(或 AI)改了源码还没重新编译。点「挂载」会用新源码重新编译再部署。">⚠ 源码已改·挂载将重编</span>` : ''}
          ${it.hash_match === false ? `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);" title="工作区 .ex5 (${(it.ex5_sha256||'').slice(0,12)}…) 与 MT5/Experts (${(it.mt5_ex5_sha256||'').slice(0,12)}…) 不一致 — 通常是 AI 改完源码 + 编译完但还没同步到 MT5/Experts/，运行中的 EA 还是旧版本.\n用右侧「挂载」按钮重新部署, 或跟 AI 说让它跑「同步 → 重启 MT5 → 重挂 EA」流程.">代码已重新编译，请重新挂载</span>` : ''}
" data-name="${escape(it.name)}" title="已上架到策略商城（id=${listing.id}, ${escape(listing.status)}）—— 点击查看订单 / 下架">已上架（点击管理）</span>` : ''}
          ${(() => {
            // 0.3.189 Phase 2 chip → 0.3.208 native <select> 下拉.
            // 用户反馈「做个下拉选择绑定实例」比 popup picker 更直觉.
            if (!_mt5InstancesCache.length) return '';
            const boundId = it.mt5_instance_id || '';
            const active = _mt5ActiveId ? _mt5InstancesCache.find((x) => x.id === _mt5ActiveId) : null;
            const defaultLabel = active ? `↻ 默认 (走默认实例「${active.name}」)` : '↻ 默认 (没有默认实例)';
            const options = ['<option value="">' + escape(defaultLabel) + '</option>'].concat(
              _mt5InstancesCache.map((inst) => {
                const tag = (inst.id === _mt5ActiveId ? ' ★' : '') + (inst.running ? ' ●' : '');
                const selected = (inst.id === boundId) ? ' selected' : '';
                return `<option value="${escape(inst.id)}"${selected}>🖥 ${escape(inst.name)}${tag}</option>`;
              })
            ).join('');
            const isBound = !!boundId && _mt5InstancesCache.some((x) => x.id === boundId);
            const color = isBound ? 'var(--accent, #4a9eff)' : 'var(--text-4)';
            const tip = isBound
              ? `已绑到 MT5 实例 — 挂载 / 启动 走该实例. 改下拉重新绑或解绑.`
              : `未绑定 — 走默认实例. 下拉选实例可锁定.`;
            return `<select class="mt5-inst-select" data-action="select-mt5-instance" data-ea="${escape(eaName)}" style="font-size:11px;padding:1px 6px;border:1px solid ${isBound ? 'rgba(74,158,255,0.3)' : 'var(--border-soft)'};border-radius:var(--radius-sm);background:transparent;color:${color};max-width:180px;cursor:pointer;" title="${escape(tip)}">${options}</select>`;
          })()}
        </div>
        <div style="color: var(--text-4); font-size: var(--fs-sm); font-family: var(--font-mono); margin-top: 2px;">${fmtSize(it.size)}</div>
      </td>
      <td>
        ${it.doc_exists
          ? `<span class="tag ok" style="font-size: 10.5px; padding: 1px 6px; letter-spacing: 0.2px;">有 · ${fmtSize(it.doc_size)}</span>`
          : `<span class="tag" style="color: var(--danger, #e89876); border-color: rgba(232, 152, 118, 0.3); cursor: help; font-size: 10.5px; padding: 1px 6px;" title="没有 strategies/${escape(it.name.replace(/\.mq5$/i, ''))}.md 策略说明文档。\n这份 .md 是「定时任务」做监控的依据 — 里面「Agent 监控建议」章节会被 cron 任务读，没有它 AI 没法稳定监控这只 EA、跑回测时也没法对照预期评估表现。\n\n点右边「说明」按钮让 AI 基于源码生成一份。">⚠ 缺</span>`}
      </td>
      ${(() => {
        // 0.3.160: symbol + magic 都做 inline editable cell. 必填 — 没配的标红 + 整行变黄.
        const mcCfg = it.monitor_config || {};
        const symbolsCfg = Array.isArray(mcCfg.symbols) ? mcCfg.symbols.filter(Boolean) : [];
        const magicsCfg = (Array.isArray(mcCfg.magic_numbers) && mcCfg.magic_numbers.length)
          ? mcCfg.magic_numbers
          : (mcCfg.magic ? [mcCfg.magic] : []);
        const symbolMissing = symbolsCfg.length === 0;
        const magicMissing = magicsCfg.length === 0;
        const cellBaseStyle = 'cursor: pointer;';
        const missingStyle = 'background: rgba(232,152,118,0.12); border-left: 2px solid var(--danger, #e89876);';
        const symbolCellStyle = symbolMissing ? cellBaseStyle + missingStyle : cellBaseStyle;
        const magicCellStyle  = magicMissing  ? cellBaseStyle + missingStyle : cellBaseStyle;
        return `
      <td class="mc-cell" data-field="symbol" data-name="${escape(it.name)}" data-ea="${escape(eaName)}" title="${symbolMissing ? '⚠ 必填: EA 监控的品种 — 没配监控功能失效. 点击设置.' : '点击修改交易品种'}" style="${symbolCellStyle}">
        ${renderMonitorChip(it.monitor_config, 'symbol')}
      </td>
      <td class="mc-cell" data-field="magic" data-name="${escape(it.name)}" data-ea="${escape(eaName)}" title="${magicMissing ? '⚠ 必填: EA 的魔术号 magic — 没配 OrderGuard 没法把成交归到这只 EA. 点击设置.' : '点击修改魔术号'}" style="${magicCellStyle}">
        ${renderMonitorChip(it.monitor_config, 'magic')}
      </td>`;
      })()}
      ${(() => {
        // 0.3.153: 13 列指标对齐排行榜, 全部从 server metric_* 派生 (跟排行榜同源)
        const brokerHours = it._metric_broker_hours_run ?? null;
        const hoursDisplay = brokerHours != null ? formatHours(brokerHours) : formatHours(hours);
        const recovery = (it.pnl_pct != null && dd != null && dd > 0) ? (it.pnl_pct / dd) : null;
        return `
        <td style="text-align: right; font-family: var(--font-mono); ${passHours ? 'color: var(--success);' : 'color: var(--text-3);'}" title="broker 第一笔 deal 起算 (跟排行榜同口径)">${hoursDisplay} ${passHours ? '✓' : ''}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${trades}</td>
        <td style="text-align: right; font-family: var(--font-mono);">${fmtPctCell(it.pnl_pct)}</td>
        <td style="text-align: right; font-family: var(--font-mono);">${fmtUsdCell(it._server_pnl_usd, it.pnl_pct, it.initial_balance)}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${recovery != null ? recovery.toFixed(2) : '—'}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${it._metric_sharpe != null ? Number(it._metric_sharpe).toFixed(2) : '—'}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${it._metric_profit_factor != null ? Number(it._metric_profit_factor).toFixed(2) : '—'}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${it._metric_win_rate != null ? (Number(it._metric_win_rate) * 100).toFixed(1) + '%' : '—'}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${fmtPct(dd)}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: var(--text-3);">${it._metric_invested_capital != null ? '$' + Number(it._metric_invested_capital).toFixed(0) : '—'}</td>`;
      })()}
      <td>
        <div class="strategy-actions">
        ${(() => {
          const showDeploy = it.has_source || it.has_compiled;
          if (!showDeploy) return '';
          const tip = it.is_mounted
            ? '已在 MT5 上运行 — 点击可重新挂载（自动重启 MT5 或手动操作）'
            : it.has_compiled && !it.has_source
              ? '把 .ex5 装到 MT5 / MQL5/Experts/ + 挂到图表上跑（购买的策略走这条路）'
              : it.has_compiled
                ? '已有编译产物，直接装 .ex5（不重新编译）+ 挂到图表上'
                : '让 AI 调 compile_strategy 编译并装到 MT5';
          return `<button class="btn ${it.is_mounted ? 'ghost' : 'primary'} small" data-action="deploy" data-name="${escape(it.name)}" title="${tip}">${it.is_mounted ? '重新挂载' : '挂载'}</button>`;
        })()}
        ${it.has_source ? `<button class="btn ghost small" data-action="edit"     data-name="${escape(it.name)}">编辑器</button>` : ''}
        ${(() => {
          // 0.3.87: 显示护航启用状态：未启用 / 监控中 / 拦截中
          const ogState = _orderguardEnabledByEa[eaName];
          if (!ogState) {
            return `<button class="btn ghost small" data-action="orderguard" data-name="${escape(it.name)}" title="护航：把这只 EA 的订单纳入 OrderGuard — 自动审计每笔 / 拦截高风险 / 记录战绩。点开选模式（监控 / 拦截）。">🛡 护航</button>`;
          }
          const isEnforce = ogState.mode === 'enforce';
          const label = isEnforce ? '🛡 拦截中' : '🛡 监控中';
          const tip = isEnforce
            ? '已启用拦截模式（pre-trade 真拦截）。点开看详情 / 重新部署 / 暂停。'
            : '已启用监控模式（事后审计）。点开看详情 / 切到拦截 / 暂停。';
          const cls = isEnforce
            ? 'btn small'   // 拦截 = 显眼一些
            : 'btn ok small';
          const inlineStyle = isEnforce
            ? 'style="background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.5);color:var(--warn);"'
            : '';
          return `<button class="${cls}" ${inlineStyle} data-action="orderguard" data-name="${escape(it.name)}" title="${tip}">${label}</button>`;
        })()}
        <button class="btn ghost small bt-btn" data-action="doc" data-name="${escape(it.name)}" title="${it.doc_exists ? '查看 / 编辑策略说明' : '⚠ 缺策略说明 — cron 监控任务读不到「Agent 监控建议」章节'}">说明${!it.doc_exists ? '<span class="bt-badge bt-badge-danger" title="缺策略说明">!</span>' : ''}</button>
        <button class="btn ghost small" data-action="params-settings" data-name="${escape(it.name)}" title="查看 / 修改 EA 参数（写到 config.set + Presets/.set；可从 .set 文件导入）">⚙ 参数设置</button>
        <button class="btn ghost small" data-action="indicators" data-name="${escape(it.name)}" title="管理这只 EA 依赖的自定义指标（iCustom 调用的 .ex5）。上架时会跟主 EA 一起打包给买家。">📎 关联指标</button>
        <button class="btn ghost small" data-action="experience" data-name="${escape(it.name)}" title="这只 EA 的经验笔记 —— AI 每日自动总结 + 主动记录的「人工介入 / 运作规律 / 教训」。挂载、护航分析、远程协助时 AI 会读它来延续经验。点开看 / 编。">📒 经验</button>
        ${it.is_mounted ? `<button class="btn ghost small" data-action="unmount" data-name="${escape(it.name)}" title="从 MT5 卸下：删除 MT5 里的 EA 文件 + 关闭护航 + 不再随 MT5 启动自动挂载。策略源码保留，可重新挂载。">🛑 卸载</button>` : ''}
        ${it.has_source || it.has_compiled ? `<button class="btn ghost small" data-action="copy"    data-name="${escape(it.name)}" title="复制这只策略的代码(.ex5/.mq5/.set) — 可另存新名字, 也可覆盖本机已有的另一只策略(覆盖会保留目标原有的品种/魔术号配置)。">📋 复制</button>` : ''}
        <button class="btn danger small" data-action="del"     data-name="${escape(it.name)}" style="margin-left:6px;" title="删除策略">删除</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
  host.appendChild(table);

  // 0.3.208: MT5 实例 <select> 下拉样式注入 (一次性, host 重 mount 也安全 — id 防重复)
  if (!document.getElementById('mt5-inst-select-styles')) {
    const s = document.createElement('style');
    s.id = 'mt5-inst-select-styles';
    s.textContent = `
      .mt5-inst-select {
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s, background 0.15s;
      }
      .mt5-inst-select:hover { background: var(--overlay-2) !important; }
      .mt5-inst-select:focus { border-color: var(--accent, #4a9eff) !important; }
      .mt5-inst-select option { color: var(--text); background: var(--surface-100, #1a1c1f); }
    `;
    document.head.appendChild(s);
  }

  // 0.3.208: MT5 实例 <select> 下拉变化 → 直接绑 / 解绑 (老 popup picker 退役)
  // 0.3.220: 已挂载 / 已上架 时切换需二次确认 — 防误操作 + 已上架自动撤销
  // (因为上架 listing 绑了某账户的统计, 换实例后这些数据不再属于新挂载点)
  table.addEventListener('change', async (e) => {
    if (e.target?.dataset?.action !== 'select-mt5-instance') return;
    const ea = e.target.dataset.ea;
    const newInstanceId = e.target.value || null;   // 空 = 解绑回默认
    const select = e.target;

    // 找当前 row 数据 — 判断 is_mounted + listing
    const tr = select.closest('tr');
    const itName = tr?.dataset?.name || '';
    const meta = _strategyMetaByName[itName] || {};
    const isMounted = !!meta.is_mounted;
    const listing = myListingsByEa[ea] || null;
    const newInst = newInstanceId ? _mt5InstancesCache.find((x) => x.id === newInstanceId) : null;
    const newInstLabel = newInst ? `「${newInst.name}」` : '默认实例';

    // 二次确认 — 列出影响后果
    if (isMounted || listing) {
      const warnings = [];
      if (isMounted) {
        warnings.push(`• 该 EA 当前正在运行 — 切换后新实例上需要重新挂载, 老实例上 EA 不会自动停止 (你要去老 MT5 手动移除)`);
      }
      // 0.3.223: 统计 reset 提示
      warnings.push(`• 该 EA 的统计 (累计运行时长 / 交易数 / 收益率 / 最大回撤 等) 会被归零 — 切到新实例 = 在新挂载点重新开始. 老数据会 archive 到 record.series 备份, 但 UI 上不再显示`);
      // OrderGuard 监控行为 — 多 MT5 时一个常见的边角, 在这里 hold 用户期望
      warnings.push(`• OrderGuard 监控: 老实例的 OG 会继续监控该 EA 在老 MT5 的运行 (跟"EA 不自动停止"对应). 新实例的 OG 上目前没该 EA — 切到新实例后重新挂载, 然后到「我的策略」启用监控 (anchor / rules 等设置不会自动迁移, 因为是不同账户)`);
      if (listing) {
        warnings.push(`• 该 EA 已上架到策略商城 (listing id=${listing.id}, 状态=${listing.status}) — 切换实例会自动下架, 因为上架时绑定的运行统计已经不属于新挂载点了. 想重新上架要在新实例攒满 24h 数据再 submit.`);
      }
      const msg =
        `把「${ea}」切到 ${newInstLabel}?\n\n` +
        warnings.join('\n') + `\n\n` +
        `确定继续?`;
      if (!confirm(msg)) {
        // 用户取消 → dropdown 还原原值 + 不调 IPC
        // 拿原绑定 id (没绑就是空字符串)
        const prevId = (() => {
          for (const opt of select.options) {
            if (opt.defaultSelected) return opt.value;
          }
          return '';
        })();
        select.value = prevId;
        return;
      }
    }

    select.disabled = true;
    try {
      // 0.3.223: 走 confirm 分支 (isMounted 或 listing) 时, 同时 reset 统计 — 切实例
      // 等于在新挂载点重新开始, 不该带老数据. 静默切换不 reset (新 EA 无积累).
      const needsConfirm = isMounted || listing;
      const r = await window.easydeal.strategies.setMt5Instance(
        ea, newInstanceId, needsConfirm ? { resetStats: true } : {}
      );
      if (r?.ok === false) throw new Error(r.error || 'unknown');
      // 如果之前有 listing, 自动下架 (要么换实例要么留旧绑定, 不能两全)
      if (listing) {
        try {
          const w = await window.easydeal.mkt.withdraw(listing.id);
          if (w?.ok) {
            window.showToast?.(`✓ 已切到 ${newInstLabel} + 自动下架原 listing`, 'ok');
          } else {
            window.showToast?.(
              `已切到 ${newInstLabel}, 但下架 listing 失败: ${w?.error || '?'} — 请到「下架」按钮手动处理`,
              'warn'
            );
          }
        } catch (we) {
          window.showToast?.(
            `已切到 ${newInstLabel}, 但下架 listing 异常: ${we.message || we}`,
            'warn'
          );
        }
      } else {
        window.showToast?.(
          newInstanceId
            ? `「${ea}」已绑到 ${newInstLabel}`
            : `「${ea}」已解绑 (走默认实例)`,
          'ok'
        );
      }
      refresh();
    } catch (err) {
      window.showToast?.('绑定失败: ' + (err.message || err), 'error');
      select.disabled = false;
    }
  });

  // ⋯ 更多 菜单全局关闭: 点浮层外 / 滚动 / Esc / 改窗口大小 → 收起 (浮层 fixed, 不关会飘)
  const closeSaMenus = () => document.querySelectorAll('.sa-menu:not([hidden])').forEach((m) => { m.hidden = true; });
  if (!window.__saMenuGlobalInit) {
    window.__saMenuGlobalInit = true;
    document.addEventListener('click', (e) => { if (!e.target.closest('.sa-more-wrap')) closeSaMenus(); });
    document.addEventListener('scroll', closeSaMenus, true);
    window.addEventListener('resize', closeSaMenus);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaMenus(); });
  }

  table.addEventListener('click', async (e) => {
    // 0.3.124: 「魔术号 / 品种」单元格 inline 编辑（在 action 路由前拦截）
    const mcCell = e.target.closest('.mc-cell');
    if (mcCell && !e.target.closest('input')) {
      e.stopPropagation();
      await openInlineMonitorEdit(mcCell, refresh);
      return;
    }
    // ⋯ 更多: 开/关浮层(closest 兼容点到角标红点); fixed 定位脱离表格滚动容器, 高 DPI 缩放不被裁切
    const moreBtn = e.target.closest('.sa-more-btn');
    if (moreBtn) {
      e.stopPropagation();
      const menu = moreBtn.parentElement.querySelector('.sa-menu');
      const wasOpen = menu && !menu.hidden;
      closeSaMenus();
      if (menu && !wasOpen) {
        menu.style.visibility = 'hidden'; menu.hidden = false;   // 先显隐测量尺寸再定位, 防闪
        const r = moreBtn.getBoundingClientRect();
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
        menu.style.top = ((r.bottom + mh + 8 > window.innerHeight) ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
        menu.style.visibility = '';
      }
      return;
    }
    const action = e.target.dataset?.action;
    const name = e.target.dataset?.name;
    if (!action || !name) return;
    if (e.target.closest('.sa-menu')) closeSaMenus();   // 选了菜单项 → 收浮层(动作照常往下走)
    if (action === 'edit') {
      await window.easydeal.strategies.openInEditor(name);
      return;
    }
    if (action === 'doc') {
      await toggleDocPanel(host, name);
      return;
    }
    if (action === 'backtest') {
      await toggleBacktestPanel(host, name);
      return;
    }
    if (action === 'params-settings') {
      await openParamsSettingsDialog(name);
      return;
    }
    if (action === 'monitor-config') {
      // 0.3.119: per-EA 监控配置（品种 / magic / comment 过滤器），AI 调 MCP
      // 工具时按 EA 取这里的配置过滤 deal / position
      await showMonitorConfigDialog(name);
      return;
    }
    if (action === 'indicators') {
      await openIndicatorsDialog(name);
      return;
    }
    if (action === 'experience') {
      await openExperienceDialog(name);
      return;
    }
    if (action === 'orderguard') {
      await openOrderGuardDialog(name);
      return;
    }
    if (action === 'lb-optin') {
      const wasOn = e.target.dataset.on === '1';
      const r = await window.easydeal.strategies.setLbOptin(name, !wasOn);
      if (r.ok) {
        // On opt-IN, also push today's running-totals snapshot immediately
        // so the leaderboard JOIN has a row to match against — without this
        // the EA wouldn't appear until tomorrow morning's rollover upload.
        let pushNote = '';
        if (!wasOn && r.synced) {
          try {
            const u = await window.easydeal.strategies.forceUploadStats();
            if (u?.ok && u.uploaded > 0) pushNote = `；已推送今日快照（${u.uploaded} 行）`;
            else if (u && !u.ok)         pushNote = `；推送今日快照失败：${u.error || '?'}`;
          } catch (e) { pushNote = `；推送今日快照异常：${e.message || e}`; }
        }
        const msg = !wasOn
          ? (r.synced ? `已加入排行榜（已同步到服务端${pushNote}）` : `已加入（本地保存；服务端同步失败：${r.sync_error || '?'}）`)
          : (r.synced ? '已退出排行榜' : `已退出（本地保存；服务端同步失败：${r.sync_error || '?'}）`);
        showToast(msg, r.synced ? 'ok' : 'error');
        await refresh();
      } else {
        showToast(r.error || '切换失败', 'error');
      }
      return;
    }
    if (action === 'restore-stats') {
      if (!confirm(`从服务端恢复「${name}」的统计？\n\n会用服务端权威数据（跟排行榜同源，从真实成交派生）覆盖本地被重置 / 清零的统计，并把起算点对齐到服务端。当前本地值会先归档进 series 备份（可回溯）。`)) return;
      const r = await window.easydeal.strategies.restoreStats(name);
      if (r?.ok) {
        const m = r.server_metric || {};
        const pct = m.pnl_pct != null ? (m.pnl_pct * 100).toFixed(2) + '%' : '—';
        showToast(`已从服务端恢复：收益率 ${pct} · ${m.trades ?? '—'} 笔`, 'ok');
        await refresh();
      } else {
        showToast(r?.error || '恢复失败', 'error');
      }
      return;
    }
    if (action === 'redeploy') {
      // 0.3.10: hash_match === false → 触发 AI 走完整重新编译 + 同步 +
      // 验证流程。比手点「挂载」更狠一点 —— prompt 强制 AI 检查
      // workspace_ex5_synced + ex5_rebuilt 字段，确认这次确实落到位。
      const eaName = String(name).split('/').pop().replace(/\.(mq5|ex5)$/i, '');
      const r = await window.easydeal.app.requestRedeploy({ strategyName: eaName, fileName: name });
      if (r.ok) {
        showToast('已发起重新挂载请求，切到对话标签页跟 AI 沟通', 'ok');
        if (typeof window.showTab === 'function') window.showTab('chat');
      } else {
        showToast(r.error || '发起失败', 'error');
      }
      return;
    }
    // 0.3.208: pick-mt5-instance chip 路径下线 — 改用 inline <select> 下拉,
    // 老的 popup picker (openMt5InstancePicker) 保留函数定义防其它地方还引用,
    // 但表格行不再走 click → popup 这条路了.
    if (action === 'deploy') {
      const item = items.find((x) => x.name === name);
      const eaName = String(name).split('/').pop().replace(/\.(mq5|ex5)$/i, '');
      if (/^GMarket$/i.test(eaName) && !localStorage.getItem(GMARKET_RISK_ACK_KEY)) {
        const ok = window.confirm(GMARKET_RISK_NOTICE);
        if (!ok) return;
        localStorage.setItem(GMARKET_RISK_ACK_KEY, new Date().toISOString());
      }
      // 0.3.245: 多 MT5 + EA 未绑定时弹对话框让用户选挂到哪个实例 — 用户
      // 报 bug「全部 EA 都挂到第一个 MT5」根因: 用户没意识到要先绑定 instance,
      // 所有未绑定 EA 都走 active (默认) 实例. 加引导让多 MT5 用户每次挂载都
      // 显式确认 (或者快速点选), 并把选择持久化到 records.mt5_instance_id, 下次
      // 再挂载就不弹了. 单 MT5 用户行为不变 (跳过对话框).
      // 1.2.36: 挂载前实时拉一次实例列表 — 不依赖可能过期的 _mt5InstancesCache。
      //   跨 tab 刚加了新实例(尤其一键下载/中文目录)还没 refresh 时, 缓存仍是旧的
      //   → insts.length 仍=1 → 漏弹「选实例」对话框 → AI 默认挂到 active 实例。
      let insts = _mt5InstancesCache || [];
      try {
        const fresh = await window.easydeal.mt5Instances?.list?.();
        if (fresh && Array.isArray(fresh.items)) {
          insts = fresh.items;
          _mt5InstancesCache = insts;
          if (fresh.active_id) _mt5ActiveId = fresh.active_id;
        }
      } catch {}
      const isBound = !!item?.mt5_instance_id && insts.some((x) => x.id === item.mt5_instance_id);
      if (insts.length > 1 && !isBound) {
        const picked = await pickMt5InstanceForDeploy(eaName, insts, _mt5ActiveId);
        if (!picked) return;   // 用户取消
        if (picked.bindFirst) {
          // 持久化绑定 (然后继续 deploy 流程, deployCompiled 会按新绑定的 dataDir 拷)
          try {
            const r = await window.easydeal.strategies.setMt5Instance(eaName, picked.instance_id);
            if (!r?.ok) {
              showToast('绑定 MT5 实例失败: ' + (r?.error || '?'), 'error');
              return;
            }
            // 立即 refresh 让下拉显示新绑定状态
            await refresh();
          } catch (e) {
            showToast('绑定 MT5 实例失败: ' + (e?.message || e), 'error');
            return;
          }
        } else {
          // 用户选了不持久化 — 但 deployCompiled 现在没有 instance_id override 参数,
          // 暂时只能走"持久化"路径 (老的 set 再 unset 太丑). 简单起见, 强制持久化.
          // 若用户后来想换实例, 直接改 dropdown 即可.
          try {
            const r = await window.easydeal.strategies.setMt5Instance(eaName, picked.instance_id);
            if (r?.ok) await refresh();
          } catch (e) {
            console.warn('[deploy] silent bind failed:', e?.message || e);
          }
        }
      }
      // 1.2.38: 源码改过(.ex5 比 .mq5 旧) → 先确定性重新编译(不走 AI 对话),
      // 再走下面 deployCompiled 的干净路径(= 自动挂载)。绕开 AI 重编路径
      // —— 那条在「重启+挂载成功后会杀 MT5」(用户实测)。workspace .ex5 不被 MT5
      // 锁(MT5 跑的是 MT5/Experts/ 那份), 编译不用杀 MT5。
      // 有源码但没有「可用的最新 .ex5」(没编过 / 源码改过) → 先确定性编译, 成功走
      // 下面 deployCompiled 干净路径; 编译失败(语法错等需 AI 修)再退 AI 路径。
      let _compiledOk = false;
      if (item?.has_source && !item?.has_compiled) {
        showToast(item?.ex5_stale ? '源码已改, 正在重新编译…' : '正在编译…', 'ok');
        let cr;
        try { cr = await window.easydeal.strategies.compile(eaName); }
        catch (e) { cr = { ok: false, error: e?.message || String(e) }; }
        if (cr?.ok) { _compiledOk = true; showToast('✓ 编译完成', 'ok'); }
        else { showToast('编译有问题, 转 AI 协助: ' + (cr?.error || '?'), 'important'); }
      }
      // Prefer the direct .ex5 copy when we already have a compiled build
      // (avoids re-spinning Claude / MetaEditor and works for purchased
      // strategies that don't ship source). 刚确定性编译成功的也走这条。
      if (item?.has_compiled || _compiledOk) {
        const r = await window.easydeal.strategies.deployCompiled(name);
        if (r.ok) {
          // 0.3.277: deploy 始终走到这里 (MT5 跑着 / 没跑都同款体验) — 老逻辑
          // 在 MT5 没跑时走 confirm() 一键 launch + 5s retry, 用户感觉到「3 种不同
          // 行为」很混乱. 现在统一到 showDeployResultDialog 一键挂载.
          // r.mt5_not_running=true 时 modal 显示一条额外提示让用户知道 MT5 没跑.
          const cleanedCount = Array.isArray(r.cleaned_stale)
            ? r.cleaned_stale.filter((c) => c.action !== 'failed').length
            : 0;
          if (cleanedCount > 0) {
            showToast(`.ex5 已装到 ${r.dst} · 已清理 ${cleanedCount} 个其它 MT5 残留`, 'ok');
          } else {
            showToast(`.ex5 已装到 ${r.dst}`, 'ok');
          }
          // Lightweight inline modal so the user can see the next-step
          // checklist without going to chat.
          showDeployResultDialog(eaName, r);
          await refresh();
        } else {
          showToast(r.error || '挂载失败', 'error');
        }
        return;
      }
      // Source-only path: defer to Claude → compile_strategy.
      const r = await window.easydeal.app.requestDeploy({ strategyName: eaName, fileName: name });
      if (r.ok) {
        showToast('已发起挂载请求，切到对话标签页跟 AI 沟通', 'ok');
        if (typeof window.showTab === 'function') window.showTab('chat');
      } else {
        showToast(r.error || '发起失败', 'error');
      }
      return;
    }
    if (action === 'unmount') {
      if (!confirm(
        `卸载 EA「${name}」？\n\n会执行：\n` +
        `• 从 MT5 删除该 EA 文件（.ex5 / 配置）\n` +
        `• 关闭这只 EA 的护航\n` +
        `• 不再随 MT5 启动自动挂载\n\n` +
        `策略和源码会保留，之后可以重新「挂载」。\n\n` +
        `⚠ 若该 EA 此刻正在 MT5 图表上运行：重启 MT5 后即移除；想立刻停，请在 MT5 图表上右键 → EA交易 → 删除。`
      )) return;
      try {
        await window.easydeal.strategies.unmount(name);
        showToast('已卸载：护航已关、不再自动挂载', 'ok');
        await refresh();
      } catch (err) {
        showToast('卸载失败：' + err.message, 'error');
      }
      return;
    }
    if (action === 'copy') {
      _copyStrategyDialog(name, items, refresh);
      return;
    }
    if (action === 'del') {
      if (!confirm(`确定删除策略源码 ${name}？此操作不可撤销。`)) return;
      try {
        await window.easydeal.strategies.delete(name);
        showToast('已删除', 'ok');
        await refresh();
      } catch (err) {
        showToast('删除失败：' + err.message, 'error');
      }
    }
  });
}

// 1.4.x「我的策略」复制 —— 弹窗/语义跟远程控制的「推策略给客户」(im-view.js
// _rcPushStrategyDialog / push_strategy)一致: 目标 = 新建(填新名字, 撞名自动加序号)
// 或本机已有的另一只策略(覆盖它的代码, 保留其原有品种/魔术号配置); 可选同步说明/经验。
// 区别: 源策略是从这一行发起的, 不用像 IM 那边额外选源。
async function _copyStrategyDialog(sourceName, items, refresh) {
  const srcStem = String(sourceName || '').replace(/\.(ex5|mq5|set)$/i, '').trim();
  const others = (items || [])
    .map((s) => String(s.name || '').replace(/\.(ex5|mq5)$/i, '').trim())
    .filter((n, i, arr) => n && n !== srcStem && arr.indexOf(n) === i);

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'width:440px;max-width:92vw;padding:18px;';
  const close = () => { try { document.body.removeChild(ov); } catch {} };
  const selCss = 'width:100%;padding:7px;margin:4px 0 8px;background:var(--surface-200);color:var(--text);border:1px solid var(--border-soft,#2a2a2a);border-radius:6px;';
  const tgtOpts = `<option value="__new__">＋ 新建策略（填新名字，撞名自动加序号）</option>`
    + others.map((n) => `<option value="${escape(n)}">${escape(n)}（覆盖此策略代码）</option>`).join('');
  box.innerHTML = `<h3 style="margin:0 0 10px;">📋 复制策略「${escape(srcStem)}」</h3>
    <label style="font-size:12px;color:var(--text-2,#9aa);">目标</label>
    <select id="cp-tgt" style="${selCss}">${tgtOpts}</select>
    <input id="cp-new-name" style="${selCss}" placeholder="新策略名(不含扩展名)" value="${escape(srcStem + '_copy')}">
    <p class="hint" style="font-size:11px;margin:2px 0 10px;">选已有策略 = 覆盖它的代码（会保留它原来配置的品种/魔术号）；选「新建」= 复制成一只新策略（撞名自动加序号）。</p>
    <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:6px;cursor:pointer;"><input type="checkbox" id="cp-doc">同步策略说明（.md）</label>
    <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:12px;cursor:pointer;"><input type="checkbox" id="cp-exp">同步策略经验（.experience.md）</label>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn ghost small" data-x="c">取消</button><button class="btn primary small" data-x="ok">复制</button></div>`;
  ov.appendChild(box); document.body.appendChild(ov);

  const tgtSel = box.querySelector('#cp-tgt');
  const nameInput = box.querySelector('#cp-new-name');
  const syncNameVisibility = () => { nameInput.style.display = tgtSel.value === '__new__' ? '' : 'none'; };
  tgtSel.addEventListener('change', syncNameVisibility);
  syncNameVisibility();

  const go = async () => {
    const isNew = tgtSel.value === '__new__';
    const targetMode = isNew ? 'new' : 'overwrite';
    const targetName = isNew ? nameInput.value.trim() : tgtSel.value;
    if (isNew && !targetName) { showToast('请填新策略名', 'error'); return; }
    const syncDoc = box.querySelector('#cp-doc').checked;
    const syncExperience = box.querySelector('#cp-exp').checked;
    showToast('复制中…', 'warn');
    try {
      const r = await window.easydeal.strategies.copy({ sourceName: srcStem, targetMode, targetName, syncDoc, syncExperience });
      if (r && r.ok) {
        showToast(`已复制 → 「${r.final_name}」${targetMode === 'new' ? '（新建）' : '（覆盖）'}`, 'ok');
        await refresh();
      } else {
        showToast('失败: ' + ((r && r.error) || ''), 'error');
      }
    } catch (e) {
      showToast('失败: ' + (e && e.message || e), 'error');
    }
    close();
  };
  box.querySelector('[data-x="ok"]').addEventListener('click', go);
  box.querySelector('[data-x="c"]').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
}

// ---- backtest panel: list past runs + start a new one ----

async function toggleBacktestPanel(host, name) {
  const taskRow = host.querySelector(`tr[data-name="${cssEscape(name)}"]`);
  if (!taskRow) return;
  const next = taskRow.nextElementSibling;
  if (next && next.classList.contains('history-row')) {
    next.remove();
    taskRow.classList.remove('expanded');
    return;
  }
  const tr = el('tr', 'history-row');
  const td = el('td');
  td.colSpan = 8;
  const panel = el('div');
  td.appendChild(panel);
  tr.appendChild(td);
  taskRow.parentNode.insertBefore(tr, taskRow.nextSibling);
  taskRow.classList.add('expanded');
  await renderBacktestPanel(panel, name);
  // Clear unread badge: user has now seen the records.
  try {
    await window.easydeal.strategies.markBacktestsRead(name);
  } catch {}
  // Visually clear the badge on the row's button without waiting for refresh
  const badge = taskRow.querySelector('.bt-btn .bt-badge');
  if (badge) badge.remove();
}

async function renderBacktestPanel(host, name) {
  clearTimeout(host.backtestRefresh);
  host.innerHTML = '<div class="empty">加载历史…</div>';
  const list = await window.easydeal.strategies.listBacktests(name);

  const eaName = String(name).split('/').pop().replace(/\.mq5$/i, '');
  host.innerHTML = `
    <div class="row between" style="margin-bottom: 12px; align-items: center;">
      <div style="color: var(--text-2); font-size: var(--fs-md);">
        ${escape(eaName)} 的回测历史 · <span style="color: var(--text-4);">${list.length} 次</span>
      </div>
      <div class="row" style="gap: 8px;">
        ${list.length ? '<button class="btn ghost small" data-bt-clear-all title="清空所有非运行中的回测记录。运行中 / 排队中的会保留 — 想删先「取消」。清空后 AI 调 list_backtests 也拿不到这批了。">清空全部</button>' : ''}
        <button class="btn primary small" data-bt-new>跑新回测 ✨</button>
      </div>
    </div>
    <div class="bt-list"></div>
  `;
  const listEl = host.querySelector('.bt-list');
  if (!list.length) {
    listEl.innerHTML = '<div class="empty">还没跑过回测。点右上"跑新回测"开始。</div>';
  } else {
    for (const r of list) listEl.appendChild(renderBacktestItem(r, eaName, host));
  }

  // 清空全部按钮
  const clearBtn = host.querySelector('[data-bt-clear-all]');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm(`清空 ${eaName} 的所有非运行中回测记录？\n\n清空后：\n• AI 调 list_backtests 拿不到这批\n• UI 历史面板也不会再展示\n• 运行中 / 排队中的会保留（请先「取消」）\n\n这个操作不可撤销。`)) return;
      const r = await window.easydeal.strategies.clearBacktests(name);
      if (r?.ok) {
        showToast(`已清空 ${r.removed} 条${r.kept_running ? `（运行中保留 ${r.kept_running} 条）` : ''}`, 'ok');
        renderBacktestPanel(host, name);
      } else {
        showToast('清空失败：' + (r?.error || '未知'), 'error');
      }
    });
  }

  if (list.some(row => row.status === 'queued' || row.status === 'running')) {
    host.backtestRefresh = setTimeout(async () => {
      if (host.isConnected) {
        try { await renderBacktestPanel(host, name); }
        catch (e) { showToast('刷新回测历史失败：' + e.message, 'error'); }
      }
    }, 5000);
  }

  host.querySelector('[data-bt-new]').addEventListener('click', async () => {
    const r = await window.easydeal.app.requestBacktest({ strategyName: eaName, fileName: name });
    if (r.ok) {
      showToast('已发起回测请求，切到对话标签页跟 AI 沟通', 'ok');
      if (typeof window.showTab === 'function') window.showTab('chat');
    } else {
      showToast(r.error || '发起失败', 'error');
    }
  });
}

// 0.3.270: 自动挂载成功后弹的强制确认 modal — 强制用户读完两条关键提示:
//   (1) MT5 弹「专家」对话框时勾「允许算法交易」+ 确定
//   (2) 重启 MT5 必须走 EasyDeal「MT5 tab → 启动 MT5」按钮 (不要直接双击 MT5
//       图标), 不然 startup.ini 不重 apply, 图表 + EA 都会消失.
// 用 toast 不行 — 用户读不完就消失. 用 modal 强制点「我已知晓」才关.
function showAutoAttachConfirmModal({ eaName, picked, period, mt5Started,
                                       algotradingStatus, algotradingVia, algotradingHint }) {
  const overlay = document.createElement('div');
  overlay.className = 'mkt-modal';
  // EA 是写进图表配置挂上的 (expertmode=1 = 该图表允许算法交易), 不弹 MT5 对话框。
  const dialogLine = `<div style="padding: 10px 12px; background: rgba(34,197,94,0.1); border-left: 3px solid #22c55e; margin-bottom: 12px; font-size: 13px;">
       ✅ <strong>EA 已写进图表配置并允许算法交易</strong>${mt5Started ? '，MT5 正在启动，启动完成即挂上' : '，图表已重新加载'}。<br>
       <span style="opacity: 0.75;">chart 右上角 EA 名旁是 😊 绿脸 = 在跑；☹ 哭脸 = 工具栏「算法交易」没开，按 Ctrl+E。</span>
     </div>`;

  // 0.3.271: 全局算法交易开关 (MT5 工具栏红/绿按钮) 自动开启的结果, 之前藏起来了
  // 用户看不到 → 以为自动挂载 OK 实际算法没开. 现在显式 chip 让结果可见.
  let algoLine = '';
  if (algotradingStatus === 'already_on') {
    algoLine = `<div style="padding: 8px 12px; background: rgba(34,197,94,0.1); border-left: 3px solid #22c55e; margin-bottom: 12px; font-size: 13px;">
         ✅ <strong>MT5 工具栏「算法交易」开关:之前就已开启</strong> (无需操作)
       </div>`;
  } else if (algotradingStatus === 'switched_on') {
    algoLine = `<div style="padding: 8px 12px; background: rgba(34,197,94,0.1); border-left: 3px solid #22c55e; margin-bottom: 12px; font-size: 13px;">
         ✅ <strong>MT5 工具栏「算法交易」开关:已自动开启</strong> (${escape(String(algotradingVia || 'Ctrl+E'))})
       </div>`;
  } else if (algotradingStatus && !mt5Started) {
    // switch_failed / no_pid / sdk_query_failed → 黄色 warning + 手动操作引导
    const statusLabel = algotradingStatus === 'switch_failed' ? 'Ctrl+E 注入失败'
                      : algotradingStatus === 'no_pid' ? '找不到 MT5 进程'
                      : algotradingStatus === 'sdk_query_failed' ? 'MT5 SDK 查询失败'
                      : algotradingStatus;
    algoLine = `<div style="padding: 10px 12px; background: rgba(245,158,11,0.15); border-left: 3px solid #f59e0b; margin-bottom: 12px; font-size: 13px;">
         ⚠ <strong>MT5 工具栏「算法交易」自动开启失败</strong> (${escape(String(statusLabel))})<br>
         → 请手动操作:<strong>在 MT5 主窗口按 Ctrl+E</strong> 或点工具栏「▶ 算法交易」按钮 (按钮变绿).<br>
         ${algotradingHint ? `<span style="opacity: 0.75; font-size: 12px;">${escape(algotradingHint)}</span>` : ''}
       </div>`;
  }
  // algotradingStatus undefined → 老 Python 没返此字段, 不显示 chip

  overlay.innerHTML = `
    <div class="mkt-modal-body" style="max-width: 580px;">
      <div class="row between" style="margin-bottom: 10px;">
        <h2 style="margin: 0; font-size: 16px;">✅ ${escape(eaName)} 已挂到 MT5</h2>
      </div>
      <div style="color: var(--text-2); font-size: 13px; margin-bottom: 12px;">
        品种 <strong>${escape(picked)}</strong> · 周期 <strong>${escape(period)}</strong>
      </div>
      ${algoLine}
      ${dialogLine}
      <div style="padding: 10px 12px; background: rgba(74,158,255,0.08); border-left: 3px solid var(--accent, #4a9eff); margin-bottom: 16px; font-size: 13px; line-height: 1.6;">
        💡 EA 随 MT5 的图表配置保存，以后重启 MT5 会自动恢复；想撤掉就在「策略」栏点「卸载」。
      </div>
      <div class="row right" style="gap: 8px;">
        <button class="btn primary" data-act="skip">了解</button>
      </div>
    </div>
  `;
  const close = () => { overlay.remove(); };
  overlay.querySelector('[data-act="skip"]').addEventListener('click', close);
  document.body.appendChild(overlay);
}


function renderBacktestItem(r, eaName, panelHost) {
  const node = el('div', 'bt-item');
  const status = r.status || 'unknown';
  const m = r.metrics || {};
  const elapsed = (r.finished_at && r.started_at) ? `${Math.round(r.finished_at - r.started_at)}s` : '—';
  const startStr = r.started_at ? new Date(r.started_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';

  let body;
  const wind = r.engine === 'wind-tunnel-skill';
  if (status === 'ok' && wind) {
    body = `<div class="bt-metrics">
      ${metricCell('权益收益', fmtMoney(m.net_profit))}
      ${metricCell('期末权益', fmtMoney(m.equity))}
      ${metricCell('期末余额', fmtMoney(m.balance))}
      ${metricCell('最差浮盈亏', fmtMoney(m.worst_float))}
      ${metricCell('期末持仓数', fmtNum(m.carried, 0))}
      ${metricCell('回放 Tick 数', fmtNum(m.ticks, 0))}
    </div><button class="btn ghost small bt-report">定位权益曲线报告</button>`;
  } else if (status === 'ok' && Object.keys(m).length) {
    body = `
      <div class="bt-metrics">
        ${metricCell('净利润',  fmtMoney(m.net_profit), m.net_profit >= 0 ? 'pos' : 'neg', 'net_profit')}
        ${metricCell('夏普',    fmtNum(m.sharpe), null, 'sharpe')}
        ${metricCell('采收率',  fmtNum(m.recovery_factor), null, 'recovery_factor')}
        ${metricCell('最大回撤', fmtPctDown(m.max_drawdown_pct), null, 'max_drawdown')}
        ${metricCell('交易数',  m.trades ?? '—', null, 'trades')}
        ${metricCell('胜率',    m.win_rate != null ? `${(m.win_rate * 100).toFixed(1)}%` : '—', null, 'win_rate')}
        ${metricCell('盈亏比',  fmtNum(m.profit_factor), null, 'profit_factor')}
        ${metricCell('期望值',  fmtMoney(m.expected_payoff), null, 'expected_payoff')}
      </div>
    `;
  } else if (status === 'running' || status === 'queued') {
    const elapsed = Math.max(0, Math.round(Date.now() / 1000 - (r.started_at || Date.now() / 1000)));
    body = `<div class="empty">${status === 'queued' ? '排队中' : '正在回放'} · ${elapsed}s
      <button class="btn ghost small bt-cancel" data-bt-id="${escape(r.id)}">取消</button></div>`;
  } else if (status === 'config_error') {
    body = `<div class="bt-error">
      ⚠ 配置问题：${escape(r.error || r.error_code || '未知')}
      <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <button class="btn primary small bt-ask-claude"
          data-error-code="${escape(r.error_code || '')}"
          data-error-msg="${escape(r.error || '')}"
          data-ea="${escape(r.ea || '')}"
          data-symbol="${escape(r.symbol || '')}"
          data-period="${escape(r.period || '')}"
          data-bt-id="${escape(r.id || '')}"
        >🤖 让 AI 引导我修</button>
        <span style="color: var(--text-3); font-size: 11.5px;">点了切到 AI 对话页 + 自动填好诊断 prompt，确认无误回车发即可。修完重新发回测请求即可。</span>
      </div>
    </div>`;
  } else if (status === 'cancelled') {
    body = `<div class="empty" style="padding: 12px; color: var(--text-3);">已取消 ${r.error ? `· ${escape(r.error)}` : ''}</div>`;
  } else {
    body = `<div class="bt-error">${escape(r.error || '未生成报告 / 未读取报告')}</div>`;
  }

  // Params row — show the inputs this run actually used: deposit + leverage
  // always; account login/server if we know it; input_overrides as a chip
  // list (each "key=value"). Empty overrides → "源码默认".
  const overrides = r.input_overrides && Object.keys(r.input_overrides).length
    ? Object.entries(r.input_overrides)
        .map(([k, v]) => `<span class="bt-param-chip" title="${escape(k)} = ${escape(String(v))}">${escape(k)}=<code>${escape(String(v))}</code></span>`)
        .join(' ')
    : '<span class="bt-param-chip" style="color: var(--text-4);">用源码默认参数</span>';
  const acct = r.account?.login
    ? `账号 <code>${escape(String(r.account.login))}@${escape(r.account.server || '?')}</code>`
    : '';
  const sourceVerChip = r.source_sha256
    ? `<span class="bt-head-chip bt-head-chip-source" data-action="bt-show-source" data-bt-id="${escape(r.id || '')}" data-path="${escape(r.source_snapshot_path || '')}" data-sha="${escape(String(r.source_sha256 || ''))}" title="EA 源码版本 sha256 = ${escape(String(r.source_sha256))}\n快照路径：${escape(r.source_snapshot_path || '(未保存)')}\n点击在文件浏览器中定位这份源码快照">📄 <code>${escape(String(r.source_sha256).slice(0,8))}</code></span>`
    : `<span class="bt-head-chip" style="opacity:0.45;cursor:default;" title="此回测在 0.3.22 之前跑的，没存源码快照">📄 <code>—</code></span>`;
  const restoreBtn = (r.source_snapshot_path && r.source_sha256)
    ? `<button class="bt-head-chip bt-restore-source" data-bt-id="${escape(r.id || '')}" data-ea="${escape(r.ea || '')}" data-snapshot="${escape(r.source_snapshot_path)}" data-sha8="${escape(String(r.source_sha256).slice(0,8))}" style="background:rgba(245,158,11,0.10);border-color:rgba(245,158,11,0.35);color:var(--warn);" title="把 strategies/${escape(r.ea || '')}.mq5 还原到这次回测时的源码版本（sha8=${escape(String(r.source_sha256).slice(0,8))}）。当前内容会先备份成 .mq5.before-restore。改完需要重新编译 + 重挂 EA。">⏪ 还原</button>`
    : '';
  const paramsRow = `
    <div class="bt-params" style="font-size: 11.5px; color: var(--text-3); padding: 6px 0 0 0; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline;">
      <span>初始资金 <code>$${r.deposit ?? '—'}</code></span>
      ${wind ? '<span>风洞连续回放 · 模拟结果</span>' : `<span>MT5 Tester · 杠杆 1:${escape(String(r.leverage ?? '—'))}</span>`}
      ${acct ? `<span>${acct}</span>` : ''}
      ${overrides}
    </div>
  `;

  // 行末的删除按钮 — 非运行中状态才有（running / queued 用「取消」）
  const canDelete = r.id && status !== 'running' && status !== 'queued';
  const deleteBtnHtml = canDelete
    ? `<button class="btn ghost small bt-item-delete" data-bt-id="${escape(r.id)}" title="删除这条记录（AI 之后看不到，UI 也不再显示）" style="color: var(--text-4); padding: 2px 8px;">✕</button>`
    : '';
  node.innerHTML = `
    <div class="bt-item-head">
      ${statusTag(status)}
      <span class="bt-item-symbol"><code>${escape(r.symbol || '?')} ${escape(r.period || '?')}</code></span>
      <span class="bt-item-range">${escape(r.from_date || '')} → ${escape(r.to_date || '')}</span>
      <span class="bt-item-time">${escape(startStr)}</span>
      <span class="bt-item-elapsed">耗时 ${elapsed}</span>
      ${sourceVerChip}
      ${restoreBtn}
      ${deleteBtnHtml}
    </div>
    ${paramsRow}
    ${body}
  `;

  node.querySelector('.bt-report')?.addEventListener('click', async () => {
    const result = await window.easydeal.app.revealInWorkspace(r.report_path);
    if (!result?.ok) showToast(result?.error || '报告文件不可用', 'error');
  });

  // per-row 删除按钮 — 直接调 IPC + 移除当前 DOM 节点（不重渲染整个 panel
  // 避免闪烁；下次重新打开 panel 时从 backtests.json 拉到的就是真实状态）
  const delBtn = node.querySelector('.bt-item-delete');
  if (delBtn) {
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除这条回测记录？\n\nAI 之后调 list_backtests / get_backtest_status 拿不到，UI 也不再显示。\n这个操作不可撤销。')) return;
      const r2 = await window.easydeal.strategies.deleteBacktest(r.id);
      if (r2?.ok) {
        node.remove();
        showToast('已删除', 'ok');
      } else {
        showToast('删除失败：' + (r2?.error || '未知'), 'error');
      }
    });
  }

  // 0.3.22: 源码版本 chip 点击 → Explorer 定位快照文件，方便用户对比两次
  // 回测对应的源码差异（用 Beyond Compare / VS Code diff 等）
  // 0.3.115: 改名 sourceVerChipEl 避免跟 line 982 的 sourceVerChip (HTML 字符串) 重复声明 — 是 0.3.113 把 sourceVer → sourceVerChip 重命名时漏掉这里的 bug，splash 阶段 strategies-view.js parse 就报 SyntaxError 整个客户端卡死。
  const sourceVerChipEl = node.querySelector('[data-action="bt-show-source"]');
  if (sourceVerChipEl) {
    sourceVerChipEl.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const p = sourceVerChipEl.dataset.path || '';
      if (!p) {
        showToast('这条回测没记源码快照（可能是 0.3.22 之前的老记录）', 'info');
        return;
      }
      const r2 = await window.easydeal.app.revealInWorkspace(p);
      if (!r2?.ok) showToast('打开失败：' + (r2?.error || '未知'), 'error');
    });
  }

  // 0.3.95: 回退代码按钮 — 把当前 .mq5 还原到这次回测的源码版本
  const restoreBtnEl = node.querySelector('.bt-restore-source');
  if (restoreBtnEl) {
    restoreBtnEl.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ea = restoreBtnEl.dataset.ea || '';
      const snap = restoreBtnEl.dataset.snapshot || '';
      const sha8 = restoreBtnEl.dataset.sha8 || '';
      if (!ea || !snap) {
        showToast('快照路径缺失，无法回退', 'error');
        return;
      }
      if (!confirm(
        `把 strategies/${ea}.mq5 回退到这次回测时的版本（sha8=${sha8}）？\n\n` +
        `· 当前的 .mq5 内容会先备份成 ${ea}.mq5.before-restore-<时间戳>（防误操作）\n` +
        `· 回退后需要**重新编译**才能生效（点行内「挂载」AI 会自动编）\n` +
        `· EA 已在跑的话需要**重新挂载**（黄牌「新版已编译」会出现）\n\n` +
        `继续？`,
      )) return;
      restoreBtnEl.disabled = true;
      const original = restoreBtnEl.textContent;
      restoreBtnEl.textContent = '⏪ 回退中…';
      try {
        const r2 = await window.easydeal.strategies.restoreMq5FromBacktest({
          ea_name: ea, snapshot_path: snap,
        });
        if (r2?.ok) {
          showToast(`✓ 已回退 ${ea}.mq5 到 sha8=${sha8}（备份：${r2.backup_path?.split(/[\\/]/).pop() || '—'}）`, 'ok');
        } else {
          showToast(`回退失败：${r2?.error || '未知'}`, 'error');
        }
      } catch (e) {
        showToast(`回退失败：${e?.message || e}`, 'error');
      } finally {
        restoreBtnEl.disabled = false;
        restoreBtnEl.textContent = original;
      }
    });
  }

  const cancelBtn = node.querySelector('.bt-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const btId = cancelBtn.dataset.btId;
      if (!btId) return;
      if (!confirm('取消这条回测？')) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '取消中…';
      try {
        const r = await window.easydeal.app.cancelBacktest(btId);
        if (!r?.ok) throw new Error(r?.error || '取消失败');
        showToast(r.already_terminal ? '回测已结束' : '已取消', 'ok');
        await renderBacktestPanel(panelHost, eaName);
      } catch (e) {
        showToast('取消异常：' + (e.message || String(e)), 'error');
        cancelBtn.disabled = false;
        cancelBtn.textContent = '取消';
      }
    });
  }

  const askBtn = node.querySelector('.bt-ask-claude');
  if (askBtn) {
    askBtn.addEventListener('click', () => {
      const ec = askBtn.dataset.errorCode || '';
      const em = askBtn.dataset.errorMsg || '';
      const ea = askBtn.dataset.ea || '';
      const symbol = askBtn.dataset.symbol || '';
      const period = askBtn.dataset.period || '';
      const btId = askBtn.dataset.btId || '';
      const prompt = [
        '回测刚失败了，需要你引导我修：',
        '',
        `- EA: ${ea || '(unknown)'}`,
        `- 品种 / 周期: ${symbol || '?'} / ${period || '?'}`,
        `- 错误码: ${ec || '(无)'}`,
        `- 错误信息: ${em || '(无)'}`,
        `- 回测 id: ${btId || '(无)'}`,
        '',
        '请按这条回测的引擎和错误原文诊断。风洞任务请查 wind-tunnel-skill、对应源码版本的适配器和所选日期的行情文件。',
      ].join('\n');
      if (typeof window.showTab === 'function') window.showTab('chat');
      if (typeof window.populateChatInput === 'function') {
        window.populateChatInput(prompt, { focus: true });
      }
    });
  }

  return node;
}

// metricCell(label, value, kindClass?, helpKey?)
//   helpKey → look up METRIC_HELP, render a clickable ⓘ next to the label.
//   Kept positional + optional so existing 3-arg callers keep working.
function metricCell(k, v, kind, helpKey) {
  const cls = kind ? `bt-v-${kind}` : '';
  return `<div class="bt-cell"><div class="k">${k}${helpIcon(helpKey)}</div><div class="v ${cls}">${v}</div></div>`;
}

function fmtMoney(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(+v).toFixed(1)}`;
}
function fmtNum(v, digits = 1) {
  if (v == null) return '—';
  return (+v).toFixed(digits);
}
function fmtPctDown(v) {
  if (v == null) return '—';
  return `-${(v * 100).toFixed(1)}%`;
}
function statusTag(s) {
  if (s === 'ok')                 return '<span class="tag ok">完成</span>';
  if (s === 'running')            return '<span class="tag running">运行中</span>';
  if (s === 'queued')             return '<span class="tag" style="color: var(--info); border-color: rgba(85,179,255,0.3);">排队中</span>';
  if (s === 'error')              return '<span class="tag error">出错</span>';
  if (s === 'finished_no_report') return '<span class="tag error">无报告</span>';
  if (s === 'config_error')       return '<span class="tag" style="color: var(--warn); border-color: rgba(255,188,51,0.3);">配置问题</span>';
  if (s === 'cancelled')          return '<span class="tag" style="color: var(--text-3);">已取消</span>';
  return `<span class="tag">${s}</span>`;
}


// ---- doc panel: show / edit / AI generate-verify-fix ----

async function toggleDocPanel(host, name) {
  const taskRow = host.querySelector(`tr[data-name="${cssEscape(name)}"]`);
  if (!taskRow) return;
  const next = taskRow.nextElementSibling;
  if (next && next.classList.contains('history-row')) {
    next.remove();
    taskRow.classList.remove('expanded');
    return;
  }
  const tr = el('tr', 'history-row');
  const td = el('td');
  td.colSpan = 8;
  const panel = el('div');
  td.appendChild(panel);
  tr.appendChild(td);
  taskRow.parentNode.insertBefore(tr, taskRow.nextSibling);
  taskRow.classList.add('expanded');
  await renderDocPanel(panel, name);
}

async function renderDocPanel(host, name) {
  // 清掉前一次面板可能挂的自轮询定时器（每次重渲染都重新决策要不要轮询）
  try {
    if (host._docPollTimer) { clearInterval(host._docPollTimer); host._docPollTimer = null; }
    if (host._docPollObs)   { host._docPollObs.disconnect(); host._docPollObs = null; }
  } catch {}

  host.innerHTML = '<div class="empty">加载中…</div>';
  let r;
  try { r = await window.easydeal.strategies.readDoc(name); }
  catch (e) { host.innerHTML = `<div class="empty">读取失败：${escape(e.message)}</div>`; return; }
  if (!r.ok) { host.innerHTML = `<div class="empty">读取失败：${escape(r.error)}</div>`; return; }

  const doc = r.content || '';
  const has = doc.length > 0;

  // 0.3.55: .ex5-only EA（购买的策略 / 用户手动放进来的二进制）没有 .mq5 源码，
  // AI 走老路径 Read 源码会读到二进制 → 给用户「乱码」般的垃圾说明文档。
  // 决策树：
  //   1. has_source         → AI 可读源码（老路径，全功能）
  //   2. !has_source, ≥72h  → 已挂载 3 天，可让 AI 看 MQL5/Logs/ + 交易历史
  //                           回归出大致行为；带「不一定准确」免责声明
  //   3. !has_source, <72h  → 数据太少，强制手动写
  const meta = _strategyMetaByName[name] || {};
  const hasSource = !!meta.has_source;
  const hoursRun = +meta.hours_run || 0;
  const PREDICT_MIN_HOURS = 72;
  const canPredictFromLogs = !hasSource && hoursRun >= PREDICT_MIN_HOURS;

  // 按钮组：根据「有没有源码」/「挂多久」决定显示哪些
  let actionButtons;
  if (hasSource) {
    // 老路径，全功能
    actionButtons = `
      <button class="btn ghost small" data-doc-action="generate">${has ? 'AI 重写' : 'AI 生成'}</button>
      <button class="btn ghost small" data-doc-action="verify"   ${has ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>校对</button>
      <button class="btn ghost small" data-doc-action="fix"      ${has ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>修正</button>
      <button class="btn primary small" data-doc-action="edit">${has ? '编辑' : '手动写'}</button>
    `;
  } else if (canPredictFromLogs) {
    // .ex5-only 但跑够 72h，让 AI 基于日志 + 交易历史推测（带免责声明）
    actionButtons = `
      <button class="btn ghost small" data-doc-action="predict-from-logs" title="基于 MQL5/Logs/ 最近日志 + 实盘交易历史让 AI 猜这只 EA 的策略行为。注意：是「猜」不是「读源码」，结果不一定准确，文档顶部会自动写上免责声明。">AI 推测（基于日志）</button>
      <button class="btn primary small" data-doc-action="edit">${has ? '编辑' : '手动写'}</button>
    `;
  } else {
    // .ex5-only 且时长不够，只能手动写
    actionButtons = `
      <button class="btn primary small" data-doc-action="edit">${has ? '编辑' : '手动写'}</button>
    `;
  }

  // 空状态的引导文案：根据三个分支给不同建议
  let emptyHint;
  if (hasSource) {
    emptyHint = `最快做法：点上方 <strong>「AI 生成」</strong> — agent 读 <code>${escape(name)}</code> 源码后自动写一份完整的（含上面那 3 个必要章节）。或者点 <strong>「手动写」</strong> 自己来，参考章节结构在编辑器顶部。`;
  } else if (canPredictFromLogs) {
    emptyHint = `这只 EA 只有 <code>.ex5</code>（没源码），但已挂载 <strong>${hoursRun.toFixed(1)} 小时</strong> ≥ ${PREDICT_MIN_HOURS}h。可以点 <strong>「AI 推测」</strong> 让 AI 看 <code>MQL5/Logs/</code> 最近日志 + 实盘交易历史猜行为 —— ⚠ 这是「猜」不是「读源码」，<u>不一定准确</u>，文档顶部会自动写上免责声明。或者点 <strong>「手动写」</strong> 自己来（你最了解它）。`;
  } else {
    const remainH = (PREDICT_MIN_HOURS - hoursRun).toFixed(1);
    emptyHint = `这只 EA 只有 <code>.ex5</code>（没源码），<strong>无法 AI 自动生成</strong> —— AI 读不了二进制。<br>已挂载 ${hoursRun.toFixed(1)} 小时，再跑 <strong>${remainH} 小时</strong>（共 ${PREDICT_MIN_HOURS}h）后，可以让 AI 基于日志 + 交易历史推测策略行为（带「不一定准确」声明）。<br>现在只能点 <strong>「手动写」</strong> 把你知道的关键信息（核心思路 / 风控 / Agent 监控建议）填进去。`;
  }

  host.innerHTML = `
    <div class="row between" style="margin-bottom: 10px; align-items: center;">
      <div>
        <span style="color: var(--text-2); font-size: var(--fs-md);">${escape(r.doc_path)}</span>
        ${has ? `<span class="tag" style="margin-left: 8px;">${(doc.length).toLocaleString()} 字符</span>` : ''}
        ${!hasSource ? `<span class="tag" style="margin-left: 6px; color: var(--warn); border-color: rgba(245,158,11,0.3);" title="这只 EA 只有 .ex5 编译产物，没有 .mq5 源码 — AI 无法读源码自动生成说明文档">仅 .ex5 · 无源码</span>` : ''}
      </div>
      <div class="row" style="gap: 6px;">
        ${actionButtons}
      </div>
    </div>
    ${has
      ? `<div class="strategy-doc-preview">${renderMarkdown(doc)}</div>`
      : `<div class="empty" style="text-align: left; padding: 16px;">
          <div style="color: var(--danger, #e89876); font-weight: 500; margin-bottom: 8px;">⚠ 这只 EA 还没策略说明文档</div>
          <div style="color: var(--text-2); line-height: 1.7; margin-bottom: 8px;">
            <strong>这份 <code>.md</code> 是 EasyDeal 整套监控 / 回测分析的<u>依据</u>，不是可有可无的注释：</strong>
          </div>
          <ul style="margin: 0 0 12px 18px; line-height: 1.8; color: var(--text-2);">
            <li><strong>cron 监控任务</strong>读 <code>「Agent 监控建议」</code> 章节判断检查频率 / 阈值 / 触发动作 — 没这份文档 AI 没法稳定监控这只 EA</li>
            <li><strong>回测托管</strong>跑完时 AI 读 <code>「风控规则」</code> + <code>「关键参数」</code> 章节对照实际 metrics 给评估和 verdict — 没这份文档只能甩干巴巴数字</li>
            <li><strong>「分析决策」</strong>用户问「现状怎么样」时 AI 读这份文档拿策略意图，作为判断异常的基线</li>
          </ul>
          <div style="color: var(--text-3); font-size: var(--fs-md); line-height: 1.7;">
            ${emptyHint}
          </div>
        </div>`}
  `;

  host.addEventListener('click', async (e) => {
    const action = e.target.dataset?.docAction;
    if (!action) return;

    if (action === 'edit') {
      enterEditMode(host, name, doc);
      return;
    }

    // AI actions: generate / verify / fix / predict-from-logs
    const labels = {
      generate:           '生成',
      verify:             '校对',
      fix:                '修正',
      'predict-from-logs': '基于日志推测',
    };
    const label = labels[action] || action;
    const r2 = await window.easydeal.strategies.requestDocAction(action, name);
    if (r2.ok) {
      showToast(`已发起"${label}"请求，切到对话标签页跟 AI 沟通`, 'ok');
      if (typeof window.showTab === 'function') window.showTab('chat');
    } else {
      showToast(`${label}失败：${r2.error}`, 'error');
    }
  });

  // 空状态时（用户点了「Claude 生成」/手动等待 AI 写 .md）自轮询 readDoc。
  // strategies-view 主列表的 5s pollTimer 看到 .history-row 存在就跳过 refresh，
  // 不主动接 AI 写文件的事件 —— 所以面板自己轮询，文件来了立刻：
  //   1. 重渲染面板成「已存在」预览状态（保持 .history-row 不动）
  //   2. inline 改主行「说明」按钮：去掉 ! 红角标 + 改 title 文案
  //   3. 触发一次轻量 stats refresh（拿 hours_run / 收益 等顺带刷一下）
  if (!has) {
    host._docPollTimer = setInterval(async () => {
      try {
        const probe = await window.easydeal.strategies.readDoc(name);
        if (probe?.ok && (probe.content || '').length > 0) {
          clearInterval(host._docPollTimer);
          host._docPollTimer = null;
          // 1+2: 主行徽章 inline 更新（找 tr[data-name="..."] 下的「说明」按钮）
          try {
            const tr = host.closest('tbody')?.querySelector(`tr[data-name="${cssEscape(name)}"]`);
            const btn = tr?.querySelector('button[data-action="doc"]');
            if (btn) {
              btn.title = '查看 / 编辑策略说明';
              const badge = btn.querySelector('.bt-badge-danger');
              if (badge) badge.remove();
            }
          } catch {}
          // 3: 重渲染面板（自轮询会被开头的清理逻辑清掉，不会双跑）
          await renderDocPanel(host, name);
        }
      } catch {}
    }, 3000);
    // 面板被移除时（用户折叠它 / 切换到别的 EA）清干净
    host._docPollObs = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        try { clearInterval(host._docPollTimer); } catch {}
        host._docPollTimer = null;
        host._docPollObs?.disconnect();
        host._docPollObs = null;
      }
    });
    host._docPollObs.observe(document.body, { childList: true, subtree: true });
  }
}

function enterEditMode(host, name, initialContent) {
  host.innerHTML = `
    <div class="row between" style="margin-bottom: 8px;">
      <span style="color: var(--text-3); font-size: var(--fs-md);">编辑 strategies/${escape(name.replace(/\.mq5$/i, '.md'))}</span>
      <div class="row" style="gap: 6px;">
        <button class="btn ghost small" data-doc-edit="cancel">取消</button>
        <button class="btn primary small" data-doc-edit="save">保存</button>
      </div>
    </div>
    <textarea class="strategy-doc-editor" placeholder="在这里写策略说明（支持 Markdown）。建议章节：核心思路 / 交易流程 / 风控规则 / 关键参数 / 注意事项">${escape(initialContent)}</textarea>
  `;
  const ta = host.querySelector('.strategy-doc-editor');
  ta.focus();

  host.addEventListener('click', async (e) => {
    const action = e.target.dataset?.docEdit;
    if (action === 'cancel') {
      await renderDocPanel(host, name);
    } else if (action === 'save') {
      const content = ta.value;
      try {
        await window.easydeal.strategies.writeDoc(name, content);
        showToast('已保存', 'ok');
        await renderDocPanel(host, name);
      } catch (err) {
        showToast('保存失败：' + err.message, 'error');
      }
    }
  });
}

function cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

// 0.3.245: 多 MT5 + EA 未绑定时, 让用户挂载前先选目标 MT5 实例.
// 用户 case: 3 个 MT5 实例, 但 EA 全没绑定 → 全挂到默认 (pibar) → 看着像
// 「全挂到第一个 MT5」bug. 加这个对话框解决 UX 引导问题.
// 返回 { instance_id, bindFirst } / null (取消).
// bindFirst=true: 用户希望把绑定持久化, 下次再挂载就不弹了; false: 仅本次走该实例.
function pickMt5InstanceForDeploy(eaName, mt5Instances, activeId) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'mkt-modal';
    const items = (mt5Instances || []).filter(Boolean);
    const activeInst = activeId ? items.find((x) => x.id === activeId) : null;
    overlay.innerHTML = `
      <div class="mkt-modal-body" style="max-width: 520px;">
        <div class="row between" style="margin-bottom: 6px;">
          <h2 style="margin: 0;">${escape(eaName)} 挂到哪个 MT5?</h2>
          <button class="btn ghost small" data-close>✕</button>
        </div>
        <p class="hint" style="margin: 0 0 12px; line-height: 1.5;">
          你有 <strong>${items.length}</strong> 个 MT5 实例, 但 ${escape(eaName)} 没绑定具体实例.
          ${activeInst ? `不选的话默认会挂到「${escape(activeInst.name)}」(当前默认).` : ''}
          <br>选完后默认会自动**持久化绑定** — 下次再点挂载就不弹了, 也能让卡片显示该 EA 关联的实例.
        </p>
        <!-- 0.3.310: 跨实例并发警告 — 防止「两个 MT5 同时跑同款 EA」 -->
        <div style="margin: 0 0 12px; padding: 10px 12px; background: rgba(245, 158, 11, 0.08); border-left: 3px solid var(--warn, #f59e0b); border-radius: 4px; font-size: var(--fs-sm); line-height: 1.6;">
          <strong style="color: var(--warn, #f59e0b);">⚠ 提示：如果 ${escape(eaName)} 之前在其它 MT5 上跑过</strong><br>
          <span style="color: var(--text-3);">切到新实例只会**让新 MT5 启动 + 挂 EA**，<b>不会自动关旧 MT5</b>。如果旧 MT5 也跑着同款 EA，建议先去旧 MT5 任务栏右键 → 退出，避免双账户同时下单。</span>
        </div>
        <div class="bt-acct-instructions" style="margin-bottom: 12px;">
          ${items.map((inst) => {
            const isActive = inst.id === activeId;
            const isRunning = inst.running;
            const accountInfo = inst.cached_account_login
              ? `账户 #${escape(inst.cached_account_login)}`
              : '账户信息暂不可用';
            return `
              <label class="ed-inst-pick" style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); margin-bottom: 8px; cursor: pointer;">
                <input type="radio" name="ed-pick-inst" value="${escape(inst.id)}" ${isActive ? 'checked' : ''} style="margin: 0;">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 500; color: var(--text);">
                    🖥 ${escape(inst.name)}
                    ${isActive ? '<span class="tag" style="margin-left: 6px; font-size: 10px;">★ 默认</span>' : ''}
                    ${isRunning ? '<span class="tag ok" style="margin-left: 4px; font-size: 10px;">● 运行中</span>' : '<span class="tag" style="margin-left: 4px; font-size: 10px; color: var(--warn);">○ 未启动</span>'}
                  </div>
                  <div style="color: var(--text-4); font-size: 11px; margin-top: 2px; font-family: var(--font-mono);">${escape(inst.installDir || '')}</div>
                  <div style="color: var(--text-3); font-size: 11px; margin-top: 1px;">${accountInfo}</div>
                </div>
              </label>
            `;
          }).join('')}
        </div>
        <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; color: var(--text-3);">
          <input type="checkbox" data-bind-first checked style="margin: 0;">
          <span>持久化绑定 — 下次再挂载该 EA 直接走选中的实例 (推荐)</span>
        </label>
        <div class="row" style="gap: 8px; justify-content: flex-end;">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="confirm">确定 + 挂载</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      try { overlay.remove(); } catch {}
      resolve(result);
    };

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) return cleanup(null);   // 点遮罩 = 取消
      const closeBtn = ev.target.closest('[data-close]');
      if (closeBtn) return cleanup(null);
      const act = ev.target.closest('[data-act]')?.dataset?.act;
      if (act === 'cancel') return cleanup(null);
      if (act === 'confirm') {
        const picked = overlay.querySelector('input[name="ed-pick-inst"]:checked');
        if (!picked) {
          showToast('请选一个 MT5 实例', 'warn');
          return;
        }
        const bindFirst = !!overlay.querySelector('[data-bind-first]')?.checked;
        return cleanup({ instance_id: picked.value, bindFirst });
      }
    });
    // ESC 关
    const onKey = (ev) => {
      if (ev.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(null); }
    };
    document.addEventListener('keydown', onKey);
  });
}

// ---- deploy-result dialog (after .ex5 copy) ----
//
// 拷贝完 .ex5 → 一键挂载。走 attach_eas_to_charts: 把 EA 写进该实例的图表配置, 不重启 MT5
// (MT5 没在跑 → 写完顺手启动; 在跑 → MT5 重新加载一次图表配置, 几秒)。失败时显示
// stage + error, 折叠里留一份手动步骤兜底。
function showDeployResultDialog(eaName, r) {
  const overlay = document.createElement('div');
  overlay.className = 'mkt-modal';
  const impact = r.mt5_not_running
    ? `<div style="margin-bottom: 14px; padding: 10px 12px; background: rgba(74,158,255,0.08); border-left: 3px solid var(--accent, #4a9eff); border-radius: 4px; font-size: var(--fs-sm); line-height: 1.6;">
         <strong style="color: var(--accent, #4a9eff);">ℹ MT5 当前未运行</strong><br>
         点「挂载」会先把 EA 写进图表配置，再启动 MT5（跟「MT5 tab → 启动」按钮等价），启动时自动挂上。
       </div>`
    : `<div style="margin-bottom: 14px; padding: 10px 12px; background: rgba(245, 158, 11, 0.08); border-left: 3px solid var(--warn, #f59e0b); border-radius: 4px; font-size: var(--fs-sm); line-height: 1.6;">
         <strong style="color: var(--warn, #f59e0b);">⚠ MT5 正在运行</strong><br>
         挂载会让 MT5 重新加载一次图表配置（不重启进程，约几秒）：所有图表关闭再打开，图表上已有的 EA 会重新初始化；broker 端持仓不受影响。
       </div>`;
  overlay.innerHTML = `
    <div class="mkt-modal-body" style="max-width: 560px;">
      <div class="row between" style="margin-bottom: 6px;">
        <h2 style="margin: 0;">${escape(eaName)} 已装到 MT5</h2>
        <button class="btn ghost small" data-close>✕</button>
      </div>
      <p class="hint" style="margin: 0 0 14px;">已拷贝到 <code>${escape(r.dst)}</code>（${(r.size / 1024).toFixed(1)} KB）。</p>
      ${impact}

      <div class="bt-acct-instructions" style="margin-bottom: 14px;">
        <div style="font-weight: 500; color: var(--text); margin-bottom: 8px;">下一步：把 ${escape(eaName)} 挂到图表上自动跑</div>
        <div class="hint" style="line-height: 1.6;">
          按这只 EA 配置的品种选图表：已挂同名 EA 的图表 → 更新；没挂 EA 的图表 → 挂上；都没有 → 新开一张。挂完会自动打开 MT5 的「算法交易」开关。
        </div>
      </div>

      <div class="row" style="gap: 8px; margin-bottom: 12px;">
        <button class="btn primary" data-act="auto">挂载</button>
      </div>

      <details style="margin-top: 4px;">
        <summary class="hint" style="cursor: pointer; font-weight: 500; color: var(--text);">手动操作步骤（挂载失败时兜底）</summary>
        <ol style="margin: 8px 0 0; padding-left: 18px; line-height: 1.7;" class="hint">
          ${(r.next_steps || []).map((s) => `<li>${escape(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}
        </ol>
      </details>

      <div class="row" style="margin-top: 14px; justify-content: flex-end;">
        <button class="btn ghost small" data-close>关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });

  // 持久状态行 — 显示挂载过程 + 完成状态，不用 toast（几秒就消，用户看不到结果和失败原因）
  const autoBtn = overlay.querySelector('[data-act="auto"]');
  const actionsRow = autoBtn?.parentElement;
  const statusBar = document.createElement('div');
  statusBar.id = 'auto-mount-status';
  statusBar.style.cssText = 'margin: 12px 0 6px; padding: 8px 12px; border-radius: 4px; font-size: var(--fs-md); display: none; white-space: pre-wrap; line-height: 1.6;';
  if (actionsRow && actionsRow.parentNode) {
    actionsRow.parentNode.insertBefore(statusBar, actionsRow);
  }

  function setStatus(kind, text) {
    statusBar.style.display = 'block';
    if (kind === 'ok') {
      statusBar.style.background = 'rgba(34, 197, 94, 0.08)';
      statusBar.style.color = 'var(--success, #4ade80)';
      statusBar.style.border = '1px solid rgba(34, 197, 94, 0.25)';
    } else if (kind === 'err') {
      statusBar.style.background = 'rgba(239, 68, 68, 0.08)';
      statusBar.style.color = 'var(--danger, #f87171)';
      statusBar.style.border = '1px solid rgba(239, 68, 68, 0.25)';
    } else {
      statusBar.style.background = 'rgba(74, 158, 255, 0.08)';
      statusBar.style.color = 'var(--accent, #4a9eff)';
      statusBar.style.border = '1px solid rgba(74, 158, 255, 0.25)';
    }
    statusBar.textContent = text;
  }

  autoBtn?.addEventListener('click', async () => {
    autoBtn.disabled = true;
    autoBtn.textContent = '正在挂载…';
    setStatus('info', r.mt5_not_running
      ? '📝 正在写入图表配置并启动 MT5…'
      : '🔄 正在写入图表配置并让 MT5 重新加载图表… 通常几秒。');
    let res;
    try {
      res = await window.easydeal.strategies.autoAttachEA(eaName);
    } catch (e) {
      res = { ok: false, error: e?.message || String(e) };
    }
    if (res?.ok) {
      autoBtn.textContent = '✅ 已挂载';
      autoBtn.classList.remove('primary');
      autoBtn.classList.add('ok');
      showAutoAttachConfirmModal({
        eaName, picked: res.picked, period: res.period,
        mt5Started: !!res.mt5_started,
        algotradingStatus: res?.algotrading?.status,
        algotradingVia: res?.algotrading?.via,
        algotradingHint: res?.algotrading?.hint,
      });
      showToast(`${eaName} 已挂到 ${res.picked} ${res.period}`, 'ok');
      setTimeout(() => { if (overlay.parentNode) close(); }, 500);
      return;
    }
    autoBtn.disabled = false;
    autoBtn.textContent = '重试挂载';
    const stage = res?.stage || 'unknown';
    const lines = [`❌ 挂载失败（stage=${stage}）`];
    if (res?.error) lines.push(`· ${res.error}`);
    for (const item of (Array.isArray(res?.results) ? res.results : [])) {
      if (item && item.ok === false && item.error) lines.push(`· ${item.ea_name}: ${item.error}`);
    }
    if (res?.hint) lines.push(`· ${res.hint}`);
    if (res?.ai_next_action) lines.push(`· ${res.ai_next_action}`);
    if (stage === 'no_symbol') {
      lines.push(``, `🔍 回「策略」表点这只 EA 那行的「品种」格子填上交易品种，再「重试挂载」。`);
    } else if (stage === 'launch_failed') {
      lines.push(``, `EA 已经写进图表配置了，去「MT5 实例」tab 点该实例的「▶ 启动 MT5」即可挂上。`);
    } else if (stage === 'mt5_dialog_open') {
      lines.push(``, `切到 MT5 窗口把弹出的对话框关掉，再「重试挂载」。`);
    } else if (stage === 'no_bridge_profile' || stage === 'profile_unknown') {
      lines.push(``, `去「MT5 实例」tab 停止该实例后再点「重试挂载」（停止状态下直接写入，启动时挂上）。`);
    } else if (stage === 'unknown' && !res?.error) {
      lines.push(``, `子进程没回响应。看 <userData>\\logs\\ 下的 easydeal.log，或者去「设置 → 高级」确认 MT5 install dir 配的对。`);
    }
    setStatus('err', lines.join('\n'));
  });
}

// ---- manage listing dialog (卖家审核订单 + 下架) ----
//
// 0.4.3：卖家管理界面入口。点「我的策略 → 已上架 badge」打开。
//
// 内容：
//   - 当前 listing 概览（id / 状态 / 授权时长 / 上架时间）
//   - 待审订单列表（payment_ref / buyer_note / 通过 / 拒绝 按钮）
//   - 已审订单历史
//   - 下架按钮
//
// 数据来源：window.easydeal.mkt.listingOrders(listingId) → orders/listing/<id>

function renderMonitorChip(cfg, field) {
  // 兼容老配置（magic 单值）+ 新配置（magic_numbers 数组）
  const magics = Array.isArray(cfg?.magic_numbers) && cfg.magic_numbers.length
    ? cfg.magic_numbers
    : (cfg?.magic ? [cfg.magic] : []);
  const symbols = Array.isArray(cfg?.symbols) ? cfg.symbols : [];

  if (field === 'magic') {
    if (!magics.length) {
      return `<span class="muted small" style="font-style: italic;">未配 ✎</span>`;
    }
    const text = magics.join(', ');
    return `<code style="font-size: var(--fs-sm); color: var(--text);">${escape(text)}</code> <span class="muted small" style="font-size: 10px;">✎</span>`;
  }
  // field === 'symbol'
  if (!symbols.length) {
    return `<span class="muted small" style="font-style: italic;">未配 ✎</span>`;
  }
  const text = symbols.join(', ');
  return `<code style="font-size: var(--fs-sm); color: var(--text);">${escape(text)}</code> <span class="muted small" style="font-size: 10px;">✎</span>`;
}

// 0.3.344: 保存 monitor_config 后同步更新 cell 的 style + title + innerHTML.
// 之前只更新 innerHTML, cell 上的 inline missingStyle (红色 + 左边框) 不消失,
// 用户填完字段还显红色, 得强制刷新整表才变. 这个 helper 重算 missing 状态后
// 一次性应用 cssText/title/innerHTML, 让填完立刻视觉反馈.
function _applyMonitorCellStyle(cell, cfg, field) {
  const symbolsCfg = Array.isArray(cfg?.symbols) ? cfg.symbols.filter(Boolean) : [];
  const magicsCfg = (Array.isArray(cfg?.magic_numbers) && cfg.magic_numbers.length)
    ? cfg.magic_numbers
    : (cfg?.magic ? [cfg.magic] : []);
  const missing = field === 'symbol' ? symbolsCfg.length === 0 : magicsCfg.length === 0;
  const cellBaseStyle = 'cursor: pointer;';
  const missingStyle = 'background: rgba(232,152,118,0.12); border-left: 2px solid var(--danger, #e89876);';
  cell.style.cssText = missing ? cellBaseStyle + missingStyle : cellBaseStyle;
  if (field === 'symbol') {
    cell.title = missing
      ? '⚠ 必填: EA 监控的品种 — 没配监控功能失效. 点击设置.'
      : '点击修改交易品种';
  } else {
    cell.title = missing
      ? '⚠ 必填: EA 的魔术号 magic — 没配 OrderGuard 没法把成交归到这只 EA. 点击设置.'
      : '点击修改魔术号';
  }
  cell.innerHTML = renderMonitorChip(cfg, field);
}

// 0.3.189 Phase 2: 浮层 picker — 给 EA 选 MT5 实例 (或解绑回 fallback)
function openMt5InstancePicker(anchorEl, eaName, refreshList) {
  // 关掉旧 popover (如果有的话)
  document.querySelectorAll('.mt5-inst-popover').forEach((el) => el.remove());

  const pop = document.createElement('div');
  pop.className = 'mt5-inst-popover';
  pop.style.cssText = [
    'position: absolute',
    'background: var(--surface-100, #1a1a1a)',
    'border: 1px solid var(--border-soft)',
    'border-radius: var(--radius-sm)',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.4)',
    'padding: 6px',
    'z-index: 2000',
    'min-width: 220px',
    'font-size: var(--fs-md)',
  ].join(';');

  const items = _mt5InstancesCache || [];
  const activeInst = _mt5ActiveId ? items.find((x) => x.id === _mt5ActiveId) : null;

  // Header
  const hd = document.createElement('div');
  hd.style.cssText = 'padding: 6px 10px; color: var(--text-3); font-size: var(--fs-sm); border-bottom: 1px solid var(--border-soft); margin-bottom: 4px;';
  hd.textContent = `绑「${eaName}」到 MT5 实例:`;
  pop.appendChild(hd);

  // 「默认 (走默认实例)」 选项
  const defOpt = document.createElement('div');
  defOpt.className = 'mt5-inst-popover-item';
  defOpt.style.cssText = 'padding: 7px 10px; cursor: pointer; border-radius: var(--radius-sm); color: var(--text-3);';
  defOpt.innerHTML = `<div>↻ 默认（走默认实例）</div><div style="font-size: 11px; color: var(--text-4); margin-top: 2px;">${activeInst ? '当前: ' + escape(activeInst.name) : '当前没有默认实例'}</div>`;
  defOpt.addEventListener('mouseenter', () => defOpt.style.background = 'var(--overlay-3)');
  defOpt.addEventListener('mouseleave', () => defOpt.style.background = 'transparent');
  defOpt.addEventListener('click', async () => {
    pop.remove();
    try {
      const r = await window.easydeal.strategies.setMt5Instance(eaName, null);
      if (r?.ok === false) throw new Error(r.error || 'unknown');
      window.showToast?.(`「${eaName}」已解绑（回 fallback）`, 'ok');
      refreshList?.();
    } catch (e) { window.showToast?.('解绑失败: ' + (e.message || e), 'error'); }
  });
  pop.appendChild(defOpt);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 10px; color: var(--text-4); font-size: var(--fs-sm); text-align: center;';
    empty.textContent = '还没添加 MT5 实例。去 MT5 tab 添加。';
    pop.appendChild(empty);
  } else {
    // 分隔
    const sep = document.createElement('div');
    sep.style.cssText = 'height: 1px; background: var(--border-soft); margin: 4px 0;';
    pop.appendChild(sep);
    for (const inst of items) {
      const opt = document.createElement('div');
      opt.className = 'mt5-inst-popover-item';
      opt.style.cssText = 'padding: 7px 10px; cursor: pointer; border-radius: var(--radius-sm); color: var(--text);';
      const activeChip = inst.is_active ? ' <span style="color: var(--accent, #4a9eff); font-size: 10px;">★ 默认</span>' : '';
      const runChip = inst.running ? ' <span style="color: var(--success); font-size: 10px;">● 运行中</span>' : '';
      opt.innerHTML = `<div>🖥 ${escape(inst.name)}${activeChip}${runChip}</div><div style="font-size: 10px; color: var(--text-4); margin-top: 2px; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escape(inst.installDir || '')}</div>`;
      opt.addEventListener('mouseenter', () => opt.style.background = 'var(--overlay-3)');
      opt.addEventListener('mouseleave', () => opt.style.background = 'transparent');
      opt.addEventListener('click', async () => {
        pop.remove();
        try {
          const r = await window.easydeal.strategies.setMt5Instance(eaName, inst.id);
          if (r?.ok === false) throw new Error(r.error || 'unknown');
          window.showToast?.(`「${eaName}」已绑到「${inst.name}」`, 'ok');
          refreshList?.();
        } catch (e) { window.showToast?.('绑定失败: ' + (e.message || e), 'error'); }
      });
      pop.appendChild(opt);
    }
  }

  // 定位到 chip 下方
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left + window.scrollX;
  if (left + popRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - popRect.width - 8);
  }
  pop.style.left = left + 'px';
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';

  // 点外面关闭
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 0);
}

async function openInlineMonitorEdit(cell, refreshList) {
  const field   = cell.dataset.field;       // 'magic' | 'symbol'
  const eaName  = cell.dataset.ea;
  if (!field || !eaName) return;

  // 拿当前 cfg（避免覆盖另一字段）
  let cfg = null;
  try { cfg = await window.easydeal.strategies.getMonitorConfig(eaName); } catch {}
  const currMagics = Array.isArray(cfg?.magic_numbers) && cfg.magic_numbers.length
    ? cfg.magic_numbers
    : (cfg?.magic ? [cfg.magic] : []);
  const currSymbols = Array.isArray(cfg?.symbols) ? cfg.symbols : [];
  const curr = field === 'magic' ? currMagics.join(', ') : currSymbols.join(', ');

  // 已经在编辑中（防双击重复触发）
  if (cell.querySelector('input')) return;

  const originalHtml = cell.innerHTML;
  const placeholder = field === 'magic' ? '如 999 或 999, 1001' : '如 XAUUSDm';
  cell.innerHTML = `
    <input type="text" value="${escape(curr)}" placeholder="${placeholder}"
           style="width: 100%; font-family: var(--font-mono); font-size: var(--fs-sm);
                  padding: 2px 6px; border: 1px solid var(--accent); border-radius: 3px;
                  background: var(--bg); color: var(--text);" />`;
  const input = cell.querySelector('input');
  // 0.3.247: 用 setTimeout(0) 让 focus + select 在 microtask 结束后跑, 避免被
  // 同一 tick 内某些 DOM 事件 (如 click 冒泡 / 5s pollTimer 异步回调) 干扰失焦.
  setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);

  let done = false;
  // 0.3.247: 焦点自动恢复 — 用户反馈「魔术号删完后无法再输入, 键盘无效, 光标不闪烁」
  // 根因可能是某个外部事件 (MT5 窗口 active / panel 渲染 / Win11 alt-tab race) 偷
  // 走 input 焦点 → 用户继续按键无效. 失焦后 50ms 再 re-focus 一次, 用户能继续输入.
  // 注意: 用 isDoneOrCancelled flag 避免死循环 — 用户主动按 Esc/Enter/clickOutside
  // 后不再 re-focus.
  input.addEventListener('focusout', () => {
    if (done) return;
    setTimeout(() => {
      if (done) return;
      // input 还在 DOM 里 → re-focus
      if (document.body.contains(input)) {
        try { input.focus(); } catch {}
      }
    }, 50);
  });
  async function save() {
    if (done) return;
    done = true;
    const raw = input.value.trim();
    let payload;
    if (field === 'magic') {
      const magics = raw.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n >= 0);
      payload = {
        symbols:          currSymbols,
        magic:            magics[0] || 0,
        magic_numbers:    magics,
        commentContains:  Array.isArray(cfg?.commentContains) ? cfg.commentContains : [],
        commentExcludes:  Array.isArray(cfg?.commentExcludes) ? cfg.commentExcludes : [],
      };
    } else {
      const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
      payload = {
        symbols,
        magic:            currMagics[0] || 0,
        magic_numbers:    currMagics,
        commentContains:  Array.isArray(cfg?.commentContains) ? cfg.commentContains : [],
        commentExcludes:  Array.isArray(cfg?.commentExcludes) ? cfg.commentExcludes : [],
      };
    }
    try {
      const r = await window.easydeal.strategies.setMonitorConfig(eaName, payload);
      if (!r?.ok) {
        cell.innerHTML = originalHtml;
        showToast(`保存失败：${r?.error || '未知'}`, 'error');
        return;
      }
      showToast(`✓ ${eaName} 的 ${field === 'magic' ? '魔术号' : '品种'} 已更新`, 'ok');
      // 0.3.136: 不调 refreshList()——之前 save 后整表 rerender 会跟用户接连点开
      // 第二个 cell 撞 race（第二个 input 被刚到达的 refresh DOM 干掉，用户看到
      // 「点开马上关闭」）。改成只更新本 cell + 同 EA 的另一 cell（如改 magic
      // 时 symbol cell 实际数据没变但也是同份 monitor_config，渲染逻辑安全）。
      // 0.3.344: 之前只更新 innerHTML 没更新 cell.style/title — cell 上的 inline
      // 红色 missingStyle 不消失, 用户填完字段还显红色, 得强制刷新整表才变. 把
      // style + title 也同步重算.
      const newCfg = r.monitor_config || payload;
      _applyMonitorCellStyle(cell, newCfg, field);
      const otherField = field === 'magic' ? 'symbol' : 'magic';
      const otherCell = document.querySelector(
        `.mc-cell[data-ea="${CSS.escape(eaName)}"][data-field="${otherField}"]`
      );
      if (otherCell) _applyMonitorCellStyle(otherCell, newCfg, otherField);
    } catch (e) {
      cell.innerHTML = originalHtml;
      showToast(`保存异常：${e?.message || e}`, 'error');
    }
  }
  function cancel() {
    if (done) return;
    done = true;
    cell.innerHTML = originalHtml;
    document.removeEventListener('mousedown', _outsideClickHandler, true);
  }
  // 0.3.247: 用 mousedown outside cell 触发 save 替代 blur — 因为 blur 会被
  // 任意焦点丢失 (MT5 窗口抢焦点 / Win11 task switch / 后台事件) trigger 出
  // 来, 跟 focusout re-focus 自动恢复机制冲突. mousedown outside 是用户明确
  // 「点开了别的地方」的信号, 才是该结束编辑的时候.
  const _outsideClickHandler = (ev) => {
    if (done) return;
    if (cell.contains(ev.target)) return;   // 点 cell 内部不算外部
    save();   // save 里会清 listener (在 try/finally 之后)
    document.removeEventListener('mousedown', _outsideClickHandler, true);
  };
  document.addEventListener('mousedown', _outsideClickHandler, true);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      save();
      document.removeEventListener('mousedown', _outsideClickHandler, true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
}

async function showMonitorConfigDialog(name) {
  const eaName = String(name || '').split('/').pop().replace(/\.(mq5|ex5|mqh|set)$/i, '');
  if (!eaName) { showToast('EA name 解析失败', 'error'); return; }

  let current = null;
  try { current = await window.easydeal.strategies.getMonitorConfig(eaName); }
  catch {}

  // 0.3.123: magic 改成支持多值（数组）—— 一只 EA 可能用多个 magic（如 base + martingale 加仓单
  // 用不同 magic）。老配置 magic=0 / magic=单整数 也能读出来。
  const cfg = current || { symbols: [], magic: 0, magic_numbers: [], commentContains: [], commentExcludes: [] };
  const magicsRaw = Array.isArray(cfg.magic_numbers) && cfg.magic_numbers.length
    ? cfg.magic_numbers
    : (cfg.magic ? [cfg.magic] : []);

  // 0.3.157: 「护航阈值」section 已搬到 openOrderGuardDialog (护航按钮下), 此处不再拉.

  const overlay = document.createElement('div');
  overlay.className = 'mkt-modal';
  overlay.innerHTML = `
    <div class="mkt-modal-body" style="max-width: 640px;">
      <div class="row between" style="margin-bottom: 8px;">
        <h2 style="margin: 0;">📡 ${escape(eaName)} 监控配置</h2>
        <button class="btn ghost small" data-close>✕</button>
      </div>
      <p class="hint" style="margin: 0 0 14px; line-height: 1.7;">
        给 AI 标明<strong>「这只 EA 在 MT5 端用哪些 magic / 在哪些 symbol 上跑」</strong>。
        AI 调
        <code>get_trading_status</code> / <code>get_positions</code> /
        <code>get_profit_history({ea_name:"${escape(eaName)}"})</code>
        时按这里配的过滤器精准匹配 deal & position，不再凭 comment 关键词猜。
      </p>

      <div class="field" style="margin-bottom: 12px;">
        <label>🪙 <strong>交易品种</strong>（symbol） <span class="muted small">— 你 broker 上这只 EA 真实交易的品种全名，多个用英文逗号分隔</span></label>
        <input type="text" id="mc-symbols" placeholder="如 XAUUSDm 或 XAUUSDm, XAUUSD.c"
               style="width: 100%; font-family: var(--font-mono);" value="${escape((cfg.symbols || []).join(', '))}">
        <div class="muted small" style="margin-top: 4px;">
          ⚠ 必须跟 MT5 行情窗口里看到的<strong>完全一致</strong>（区分大小写 + 后缀）。
          不同 broker 同一品种叫法不同：Exness 叫 XAUUSDm，IC Markets 叫 XAUUSD.c，OANDA 叫 XAU_USD。
        </div>
      </div>

      <div class="field" style="margin-bottom: 12px;">
        <label>🎯 <strong>魔术号</strong>（magic number） <span class="muted small">— 整数，多个用逗号分隔</span></label>
        <input type="text" id="mc-magic" placeholder="如 999 或 999, 1001, 1002"
               style="width: 100%; font-family: var(--font-mono);" value="${escape(magicsRaw.join(', '))}">
        <div class="muted small" style="margin-top: 4px;">
          源码里 <code>trade.SetExpertMagicNumber(999)</code> 设的那个数字。
          如果 EA 同时用多组 magic（如基础单 999、加仓单 1001），全部列上。
          <strong>留空 = 不按 magic 过滤</strong>，仅靠 symbol + comment 匹配（精度低，不推荐）。
        </div>
      </div>

      <details style="margin-bottom: 12px;" ${(cfg.commentContains?.length || cfg.commentExcludes?.length) ? 'open' : ''}>
        <summary class="muted small" style="cursor: pointer;">📝 comment 关键词过滤（可选，magic+symbol 不够分辨时用）</summary>
        <div class="field" style="margin-top: 10px;">
          <label>comment 必须包含 <span class="muted small">(任一命中即可)</span></label>
          <input type="text" id="mc-cc" placeholder="如 martin, breakout"
                 style="width: 100%; font-family: var(--font-mono);"
                 value="${escape((cfg.commentContains || []).join(', '))}">
        </div>
        <div class="field" style="margin-top: 8px;">
          <label>comment 必须不包含 <span class="muted small">(任一命中就跳过)</span></label>
          <input type="text" id="mc-ce" placeholder="如 manual, test"
                 style="width: 100%; font-family: var(--font-mono);"
                 value="${escape((cfg.commentExcludes || []).join(', '))}">
        </div>
      </details>

      <div id="mc-preview" style="background: var(--surface-200); border: 1px solid var(--border-soft); border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; color: var(--text-2);">
        <div style="color: var(--text-3); font-family: var(--font-sans, sans-serif); font-size: 11px; margin-bottom: 6px;">↓ AI 调用 MCP 工具时实际生效的 filter</div>
        <div id="mc-preview-body">—</div>
      </div>

      <div class="banner banner-info" style="font-size: var(--fs-md); margin-bottom: 14px;">
        <span class="banner-dot"></span>
        <span>保存即时生效（MCP lazy 读 <code>workspace/.easydeal-ea-monitor.json</code>），<strong>下一条对话开始 AI 看到的就是新配置</strong>，不用重启。</span>
      </div>

      <!-- 0.3.150: 「重置该 EA 的基准余额」整个 section 下掉 (含「↻ 重置基准余额到当前」+
           「↻ 按此值重置」两个按钮 + 手输本金输入框). anchor 严格由 server 按 raw 数据
           派生 (broker first_seen_deal 或 admin _HARDCODED_LICENSE_OVERRIDE), 用户不可干预. -->

      <!-- 0.3.157: 「护航阈值」section 已搬到「🛡 护航」按钮下的对话框 (openOrderGuardDialog),
           跟 magic/symbol filter 解耦. 此处只保留监控 filter, 阈值在那边设. -->

      <div class="row" style="gap: 8px; justify-content: flex-end;">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="mc-save">保存</button>
      </div>
      <div id="mc-msg" class="muted small" style="margin-top: 8px;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });

  // 0.3.123: 实时预览 — 用户每改一个 input，下方 panel 立刻显示 AI 调 MCP 工具时实际生效的 filter
  // 这样用户保存前就能确定「AI 真的会按这个 filter 跑」
  const previewBody = overlay.querySelector('#mc-preview-body');
  function parseMagics(raw) {
    return String(raw || '').split(',')
      .map((s) => s.trim()).filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }
  function refreshPreview() {
    const symbols = overlay.querySelector('#mc-symbols').value
      .split(',').map((s) => s.trim()).filter(Boolean);
    const magics = parseMagics(overlay.querySelector('#mc-magic').value);
    const cc = overlay.querySelector('#mc-cc').value.split(',').map((s) => s.trim()).filter(Boolean);
    const ce = overlay.querySelector('#mc-ce').value.split(',').map((s) => s.trim()).filter(Boolean);
    const allEmpty = !symbols.length && !magics.length && !cc.length && !ce.length;
    if (allEmpty) {
      previewBody.innerHTML = `<span style="color: var(--warn);">⚠ 全空 — AI 会 fallback 到全局监控配置（设置 tab 里那个）。强烈建议至少填 magic + symbol。</span>`;
      return;
    }
    const parts = [];
    if (magics.length)  parts.push(`<span style="color: var(--accent);">magic</span> ∈ [${magics.join(', ')}]`);
    if (symbols.length) parts.push(`<span style="color: var(--accent);">symbol</span> ∈ [${symbols.map((s) => `"${escape(s)}"`).join(', ')}]`);
    if (cc.length)      parts.push(`<span style="color: var(--accent);">comment</span> 包含 [${cc.map((s) => `"${escape(s)}"`).join(', ')}]`);
    if (ce.length)      parts.push(`<span style="color: var(--accent);">comment</span> 不含 [${ce.map((s) => `"${escape(s)}"`).join(', ')}]`);
    previewBody.innerHTML = parts.join('<br>AND ');
  }
  refreshPreview();
  ['#mc-symbols', '#mc-magic', '#mc-cc', '#mc-ce'].forEach((sel) => {
    overlay.querySelector(sel).addEventListener('input', refreshPreview);
  });

  // 0.3.150 删 reset; 0.3.157 把「护航阈值」section 整段搬到 openOrderGuardDialog (护航按钮下).
  // 此处只剩 monitor-config 保存逻辑.

  overlay.querySelector('#mc-save').addEventListener('click', async () => {
    const symbols = overlay.querySelector('#mc-symbols').value
      .split(',').map((s) => s.trim()).filter(Boolean);
    const magics = parseMagics(overlay.querySelector('#mc-magic').value);
    const commentContains = overlay.querySelector('#mc-cc').value
      .split(',').map((s) => s.trim()).filter(Boolean);
    const commentExcludes = overlay.querySelector('#mc-ce').value
      .split(',').map((s) => s.trim()).filter(Boolean);
    const msgEl = overlay.querySelector('#mc-msg');
    msgEl.textContent = '保存中…';
    msgEl.style.color = 'var(--text-3)';
    try {
      // 0.3.157: 只存监控 filter (thresholds 由 OG 对话框负责)
      const rMonitor = await window.easydeal.strategies.setMonitorConfig(eaName, {
        symbols,
        magic: magics[0] || 0,
        magic_numbers: magics,
        commentContains, commentExcludes,
      });
      if (rMonitor?.ok) {
        msgEl.textContent = '✓ 已保存监控配置。下一条对话起 AI 看到的就是新 filter。';
        msgEl.style.color = 'var(--success)';
        setTimeout(close, 1600);
      } else {
        msgEl.textContent = `失败：${rMonitor?.error || '未知'}`;
        msgEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      msgEl.textContent = `失败：${e?.message || e}`;
      msgEl.style.color = 'var(--danger)';
    }
  });
}



function formatHours(h) {
  if (h == null) return '—';
  if (h < 24) return `${(+h).toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============== 0.3.53: 参数设置 dialog ==============
//
// 跟用户约定的设计：
//   - 「参数设置」按钮 → 编辑 EA 参数 / 从 .set 文件导入；写 config.set + Presets/.set
//     非热更新 EA → 弹「请重新挂载 EA」确认
//
// 共用 modal-overlay 框架（项目已有 createListingDialog 等示例）。

function _openModal(title, bodyEl, { width = 720 } = {}) {
  const overlay = el('div', 'modal-overlay');
  overlay.style.cssText = (
    'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;'
    + 'display:flex;align-items:center;justify-content:center;padding:24px;'
  );
  const dialog = el('div', 'modal-dialog');
  dialog.style.cssText = (
    `background:var(--bg);color:var(--text);`
    + `width:min(${width}px,calc(100vw - 48px));max-height:calc(100vh - 48px);`
    + `border-radius:10px;display:flex;flex-direction:column;`
    + `box-shadow:0 20px 50px rgba(0,0,0,0.5);overflow:hidden;`
  );
  const header = el('div');
  header.style.cssText = 'padding:14px 18px;border-bottom:1px solid var(--overlay-4);display:flex;justify-content:space-between;align-items:center;';
  const h2 = el('h3');
  h2.style.cssText = 'margin:0;font-size:15px;font-weight:600';
  h2.textContent = title;
  const closeBtn = el('button', 'btn ghost small');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'min-width:30px';
  header.appendChild(h2);
  header.appendChild(closeBtn);
  const body = el('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px 18px;';
  body.appendChild(bodyEl);
  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { close, body, header, dialog };
}

// ============================================================
// 0.3.64: 「🛡 护航」对话框 — OrderGuard P0a 监控模式启用 / 暂停
// ============================================================
// 用户在「我的策略」EA 行点「🛡 护航」按钮触发。
// 决策树：
//   - 未启用 → 选模式（监控 / 拦截 (P1+，先 disabled)) → 自动取该 EA magic → /enable
//   - 已启用 → 显当前状态 + 提供「切换模式 / 暂停 / 跳护航专栏」
// 关键依赖：必须能拿到 EA 的 magic（runtime.json / chart inputs heuristic）
async function openOrderGuardDialog(eaFile) {
  const eaName = String(eaFile || '').replace(/\.(mq5|ex5)$/i, '');
  const body = el('div');
  body.innerHTML = '<div class="muted small">读取护航状态…</div>';
  const modal = _openModal(`🛡 ${eaName} 护航`, body, { width: 640 });

  // 拉当前 enabled 状态 + 该 EA magic
  let enabled = null;
  let inferredMagic = null;
  let inferredSource = null;
  try {
    const r = await window.easydeal.orderguard.enabledEas();
    enabled = (r?.data?.eas || []).find((e) => e.ea_name === eaName) || null;
  } catch {}
  // 0.3.166: 优先从监控配置拿 magic（用户已在策略表的「🎯 魔术号」列填过）。
  // 监控配置是用户确认过的，比 inferMagic 的启发式推断更可靠。
  try {
    const mc = await window.easydeal.strategies.getMonitorConfig(eaName);
    const mcMagics = Array.isArray(mc?.magic_numbers) && mc.magic_numbers.length
      ? mc.magic_numbers
      : (mc?.magic ? [mc.magic] : []);
    if (mcMagics.length && mcMagics[0] > 0) {
      inferredMagic = mcMagics[0];
      inferredSource = '监控配置';
    }
  } catch {}
  // fallback: 0.3.86 自动识别 magic — runtime.json + 启发式从 deals 推断
  if (inferredMagic == null) {
    try {
      const r = await window.easydeal.orderguard.inferMagic(eaName);
      if (r?.ok && r.magic) {
        inferredMagic = r.magic;
        inferredSource = r.source || 'auto';
      }
    } catch {}
  }

  // 0.3.158: render 改 async — 0.3.157 加 thresholds section 时引入了
  // `await getOrderguardThresholds()`, render 不是 async → SyntaxError "Unexpected
  // reserved word", 整个 strategies-view.js ES module 加载失败 → renderer splash 卡死.
  async function render() {
    if (enabled) {
      const isEnforce = enabled.mode === 'enforce';
      // 0.3.72: 拦截模式启用 + .ex5 比 MT5 内存里加载的版本新 → 用户需要重挂才生效
      const meta = _strategyMetaByName[eaFile]
                || _strategyMetaByName[`${eaName}.mq5`]
                || _strategyMetaByName[`${eaName}.ex5`]
                || {};
      const needRemount = isEnforce && meta.is_stale;
      const remountBanner = needRemount ? `
        <div class="hint" style="margin: 0 0 12px;padding:10px 12px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;color:var(--warn);line-height:1.65;">
          ⚠ <strong>新版 .ex5 已编译，但 MT5 还跑着旧版</strong> —— 拦截调用是在新 .ex5 里，必须重挂才会生效。
          <div style="margin-top:6px;">
            <button class="btn small" id="og-goto-remount" style="background:var(--warn);color:#000;border:none;">🔄 立刻去重挂</button>
            <span class="muted small" style="margin-left:8px;">（关闭此对话框，去「我的策略」点黄色「点此重新挂载」标签）</span>
          </div>
        </div>` : '';
      // 0.3.157: 拉护航阈值 — section 从 monitor-config 对话框搬过来,
      // 因为「护航阈值」语义跟「护航」更相关.
      let ogThresholds = null;
      try {
        const tr = await window.easydeal.strategies.getOrderguardThresholds(eaName);
        if (tr?.ok && tr.thresholds) ogThresholds = tr.thresholds;
      } catch {}
      body.innerHTML = `
        ${remountBanner}
        <div class="hint" style="line-height:1.7;margin-bottom:12px;">
          ✓ 当前 <strong>${escape(eaName)}</strong> 已启用护航。
          <br>模式：${isEnforce ? '<strong>拦截</strong> (pre-trade 真拦截)' : '<strong>监控</strong> (零侵入事后审计)'}
          <br>Magic：<code>${escape(enabled.magic)}</code>
        </div>
        <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap;">
          <button class="btn primary small" id="og-goto-tab">📊 看「🛡 护航」专栏</button>
          <button class="btn ghost small" id="og-gen-rules" title="让 AI 看 .mq5 源码生成定制 fast_rules + risk_policy，比通用默认规则更贴这只 EA 的行为">🤖 AI 生成定制规则</button>
          ${isEnforce ? '<button class="btn ghost small" id="og-redeploy">🔄 重新部署 + AI 改 EA</button>' : ''}
          <button class="btn ghost small" id="og-pause">⏸ 暂停护航</button>
        </div>

        <!-- 0.3.157: 护航阈值 section (从 monitor-config 对话框搬过来) -->
        <div style="margin: 18px 0 14px; border-top: 1px dashed var(--border-soft); padding-top: 12px;">
          <div class="row between" style="margin-bottom: 8px;">
            <div style="font-weight: 600;">🛡 <span style="color: var(--accent);">护航阈值</span> <span class="muted small">— 触发警报 + 微信推送</span></div>
            <button class="btn ghost small" id="og-ai-analyze" type="button" title="AI 重新分析 EA 源码给阈值建议（90s 超时）">↻ AI 重新分析</button>
          </div>
          <div id="og-ai-status" class="muted small" style="margin-bottom: 8px; font-style: italic;">${ogThresholds ? `✓ 已有配置（${escape(ogThresholds.source === 'ai' ? 'AI 分析' : ogThresholds.source === 'default' ? '默认值' : '用户配置')}, 更新于 ${new Date(ogThresholds.updated_at || 0).toLocaleString('zh-CN', { hour12: false })}）` : '⚠ 还没分析过，点「↻ AI 重新分析」让 AI 看 EA 源码给建议'}</div>
          <div id="og-ai-reason" style="background: var(--surface-200); border-left: 3px solid var(--accent); padding: 8px 12px; margin-bottom: 12px; font-size: 12px; line-height: 1.6; color: var(--text-2); display: ${ogThresholds?.ai_reason ? 'block' : 'none'};">
            <div style="font-size: 10.5px; color: var(--text-3); margin-bottom: 4px;">AI 分析（策略类型：<strong id="og-strategy-type">${escape(ogThresholds?.strategy_type || '—')}</strong>）</div>
            <div id="og-reason-text">${escape(ogThresholds?.ai_reason || '')}</div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px;">
            <div class="field">
              <label>📉 单笔订单浮亏 USD <span class="muted small">（负数）</span></label>
              <input type="number" id="og-single-loss-usd" step="1" value="${ogThresholds?.single_loss_usd ?? -100}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>📉 单笔订单浮亏 % <span class="muted small">（占账户余额, 负数）</span></label>
              <input type="number" id="og-single-loss-pct" step="0.1" value="${ogThresholds?.single_loss_pct ?? -5}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>⏰ 单笔最长持仓小时</label>
              <input type="number" id="og-max-holding-hours" min="1" step="1" value="${ogThresholds?.max_holding_hours ?? 24}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>📉 整体账户浮亏 % <span class="muted small">（负数）</span></label>
              <input type="number" id="og-max-account-loss-pct" step="0.1" value="${ogThresholds?.max_account_loss_pct ?? -8}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field" style="grid-column: 1 / -1;">
              <label>🔒 锁仓上限 <span class="muted small">（多空对锁数）</span></label>
              <input type="number" id="og-max-locked" min="0" step="1" value="${ogThresholds?.max_locked_positions ?? 4}" style="width: 100%; font-family: var(--font-mono); max-width: 200px;">
            </div>
          </div>
          <div class="muted small" style="margin-top: 8px;">触发任一条件 → 护航推送微信告警 + 客户端 UI ⚠ 标记。冷却 30 分钟同笔不重发。</div>
          <div class="row" style="gap: 8px; margin-top: 10px; justify-content: flex-end;">
            <button class="btn primary small" id="og-save-thresholds">💾 保存阈值</button>
          </div>
          <div id="og-threshold-msg" class="muted small" style="margin-top: 6px; min-height: 16px;"></div>
        </div>
      `;
      body.querySelector('#og-goto-tab')?.addEventListener('click', () => {
        modal.close();
        if (typeof window.showTab === 'function') window.showTab('orderguard');
      });
      body.querySelector('#og-pause')?.addEventListener('click', async () => {
        if (!confirm(`暂停 ${eaName} 的护航？历史数据保留。`)) return;
        const r = await window.easydeal.orderguard.disableEa(eaName);
        if (r?.ok) { showToast('已暂停护航', 'ok'); modal.close(); }
        else showToast(`暂停失败：${r?.error || '?'}`, 'error');
      });
      body.querySelector('#og-gen-rules')?.addEventListener('click', async () => {
        const r = await window.easydeal.app.requestOrderguardRuleGeneration(eaName);
        if (r?.ok) {
          showToast(`✓ AI 正在为 ${eaName} 生成定制规则（看「💬 聊天」tab）`, 'ok');
          modal.close();
          setTimeout(() => { if (typeof window.showTab === 'function') window.showTab('chat'); }, 250);
        } else {
          showToast(`生成请求失败：${r?.error || '?'}`, 'error');
        }
      });
      body.querySelector('#og-redeploy')?.addEventListener('click', async () => {
        const dep = await window.easydeal.orderguard.deployIntercept(eaName);
        if (!dep?.ok || !(dep.deployed || []).length) {
          showToast(`部署失败：${(dep?.errors || [dep?.error || '?']).join('; ')}`, 'error');
          return;
        }
        const r = await window.easydeal.app.requestOrderguardRetrofit(eaName, enabled.magic);
        if (r?.ok) {
          showToast(`✓ 部署 ${dep.deployed.length} 个文件，AI 改造中（看聊天 tab）`, 'ok');
          modal.close();
          setTimeout(() => { if (typeof window.showTab === 'function') window.showTab('chat'); }, 250);
        } else {
          showToast(`部署成功但 AI 改造没启动：${r?.error || '?'}`, 'warn');
        }
      });
      // 0.3.72: 「立刻去重挂」— 调跟「我的策略」黄牌同款 deployCompiled + showDeployResultDialog
      body.querySelector('#og-goto-remount')?.addEventListener('click', async () => {
        modal.close();
        const lookupName = eaFile.endsWith('.mq5') || eaFile.endsWith('.ex5') ? eaFile : `${eaName}.mq5`;
        try {
          const r = await window.easydeal.strategies.deployCompiled(lookupName);
          if (r?.ok) {
            showToast(`.ex5 已装到 ${r.dst}`, 'ok');
            showDeployResultDialog(eaName, r);
          } else {
            showToast(r?.error || '挂载失败', 'error');
          }
        } catch (e) {
          showToast(String(e?.message || e), 'error');
        }
      });

      // 0.3.157: 「护航阈值」section handler (从 monitor-config 对话框迁过来)
      const ogAiBtn = body.querySelector('#og-ai-analyze');
      const ogAiStatus = body.querySelector('#og-ai-status');
      // 0.3.159: 改成跳 chat tab 跑 AI 分析 (之前 inline spawn claude.exe 撞
      // ENAMETOOLONG 失败). 弹窗保留, 用户回来重新打开看新值.
      // 0.3.174: 修「点按钮不跳 AI tab」— 之前 `await chat.send()` 阻塞到 AI
      // 跑完 (几十秒到几分钟) 才切 tab, 用户感觉点了没反应. 改成先切 tab 让
      // 用户立刻看见 AI 开跑, 再 fire-and-forget 调 chat.send.
      function ogRunAiAnalysis() {
        ogAiBtn.disabled = true;
        ogAiBtn.textContent = '⌛ 已发到 AI 聊天…';
        ogAiStatus.textContent = '已切到 AI 聊天 tab, 用 mcp tool 跑分析中. 跑完后关闭此弹窗重新打开看新值.';
        ogAiStatus.style.color = 'var(--text-3)';
        const prompt = `请帮 EA「${eaName}」分析护航阈值. 步骤:\n` +
          `1. 用 \`read_strategy_source(name="${eaName}")\` 读 .mq5 源码\n` +
          `2. 分析策略类型 (网格 / 马丁 / 趋势 / 反转 / 等), 估算合理的:\n` +
          `   - 单笔订单浮亏 USD (负数)\n   - 单笔订单浮亏 % (负数)\n` +
          `   - 单笔最长持仓小时\n   - 整体账户浮亏 % (负数)\n   - 锁仓上限 (多空对锁数)\n` +
          `3. 用 \`save_orderguard_thresholds(ea_name="${eaName}", thresholds={...})\` mcp tool 保存\n` +
          `4. 简短告诉我策略类型 + 5 个数值就行\n\n` +
          `保存完用户回「策略 → 🛡 护航」对话框就能看到新值.`;
        // 先切 tab — 用户立刻看见 AI tab 开跑
        if (typeof window.showTab === 'function') {
          window.showTab('chat');
        }
        // fire-and-forget 调 chat.send. chat-view 自己渲染消息流, 不需要 await.
        // 失败时通过 catch 把按钮恢复 + 显错误 (用户切回护航 tab 能看到反馈).
        try {
          window.easydeal.chat.send(prompt).catch((e) => {
            ogAiStatus.textContent = `✖ 发送失败: ${e?.message || e}`;
            ogAiStatus.style.color = 'var(--danger)';
            ogAiBtn.disabled = false;
            ogAiBtn.textContent = '↻ AI 重新分析';
          });
        } catch (e) {
          ogAiStatus.textContent = `✖ 发送失败: ${e?.message || e}`;
          ogAiStatus.style.color = 'var(--danger)';
          ogAiBtn.disabled = false;
          ogAiBtn.textContent = '↻ AI 重新分析';
        }
      }
      if (ogAiBtn) ogAiBtn.addEventListener('click', ogRunAiAnalysis);
      // 0.3.159: 不再自动跑 AI 分析 — 用户主动点才跑 (避免每次打开都打扰 chat tab).
      // 已有 ogThresholds 时显「已有配置」, 用户想重新跑就点按钮.

      body.querySelector('#og-save-thresholds')?.addEventListener('click', async () => {
        const msgEl = body.querySelector('#og-threshold-msg');
        msgEl.textContent = '保存中…';
        msgEl.style.color = 'var(--text-3)';
        try {
          const thresholds = {
            single_loss_usd:      Number(body.querySelector('#og-single-loss-usd').value)      || -100,
            single_loss_pct:      Number(body.querySelector('#og-single-loss-pct').value)      || -5,
            max_holding_hours:    Number(body.querySelector('#og-max-holding-hours').value)    || 24,
            max_account_loss_pct: Number(body.querySelector('#og-max-account-loss-pct').value) || -8,
            max_locked_positions: Number(body.querySelector('#og-max-locked').value)           || 4,
            strategy_type: body.querySelector('#og-strategy-type')?.textContent || '',
            ai_reason: body.querySelector('#og-reason-text')?.textContent || '',
            source: ogThresholds?.source === 'ai' ? 'user' : (ogThresholds?.source || 'user'),
          };
          const r = await window.easydeal.strategies.saveOrderguardThresholds(eaName, thresholds);
          if (r?.ok) {
            // 立即把新阈值推给 OG 让生效 (避免用户重启 / 重新启用)
            try {
              await window.easydeal.orderguard.enableEa(eaName, enabled.magic, enabled.mode || 'observe', thresholds);
            } catch {}
            msgEl.textContent = '✓ 已保存 + 已推给护航生效';
            msgEl.style.color = 'var(--success)';
          } else {
            msgEl.textContent = `失败：${r?.error || '?'}`;
            msgEl.style.color = 'var(--danger)';
          }
        } catch (e) {
          msgEl.textContent = `异常：${e?.message || e}`;
          msgEl.style.color = 'var(--danger)';
        }
      });
    } else {
      // 0.3.163: 未启用分支也拉一次阈值 — 用户反馈「这个表单应该在开启护航时就应该出现」.
      // 之前阈值 section 只在 enabled 分支显示, 第一次启用时填不到, 必须启用→关→再开才能填.
      let ogInitThresholds = null;
      try {
        const tr = await window.easydeal.strategies.getOrderguardThresholds(eaName);
        if (tr?.ok && tr.thresholds) ogInitThresholds = tr.thresholds;
      } catch {}
      body.innerHTML = `
        <div class="hint" style="line-height:1.7;margin-bottom:14px;">
          护航：审计每笔单 + 累计盈亏 + 告警 / 拦截高风险，看「<strong>🛡 护航</strong>」专栏.
        </div>

        <div style="margin-bottom:14px;">
          <label style="display:block;font-weight:500;margin-bottom:6px;color:var(--text);">护航模式</label>
          <label class="og-mode-radio" style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--overlay-3);border-radius:6px;cursor:pointer;margin-bottom:8px;">
            <input type="radio" name="og-mode" value="observe" checked style="margin-top:4px;">
            <span>
              <strong>监控模式</strong> <span class="tag ok" style="margin-left:6px;">推荐</span>
              <div class="muted" style="font-size:var(--fs-sm);margin-top:4px;line-height:1.6;">
                不改 EA 代码, 仅事后审计 + 告警, 不阻止下单. 适用所有 EA (含买来的 .ex5).
              </div>
            </span>
          </label>
          <label class="og-mode-radio" style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--overlay-3);border-radius:6px;cursor:pointer;">
            <input type="radio" name="og-mode" value="enforce">
            <span>
              <strong>拦截模式</strong> <span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);margin-left:6px;">AI 自动改 EA 代码</span>
              <div class="muted" style="font-size:var(--fs-sm);margin-top:4px;line-height:1.6;">
                AI 自动读 .mq5 源码, 每个下单点前插入 <code>OrderGuard_Check()</code> 并重新编译.
                pre-trade 真拦截 (fast rules 同步阻断, AI 评估异步 + cache 不阻塞 EA).
                原文件自动备份 <code>.orderguard-backup</code>, 可还原.
                <br><span style="color:var(--warn);font-weight:500;">⚠ 需要在 MT5 加 WebRequest 白名单</span> — 工具 → 选项 → 智能交易系统 → 「允许 WebRequest URL」加 <code>http://127.0.0.1</code>; 不加则 EA 调 OrderGuard 服务会被 MT5 阻止.
                <br><span class="muted">需要 .mq5 源码 (买来的 .ex5 没源码不能用), 改造过程在 AI 聊天 tab 显进度.</span>
              </div>
            </span>
          </label>
        </div>

        <div style="margin-bottom:14px;">
          <label style="display:block;font-weight:500;margin-bottom:6px;color:var(--text);">
            EA 的 Magic Number
            ${inferredMagic != null
              ? `<span class="tag ok" style="margin-left:8px;font-size:var(--fs-sm);">✓ 已自动识别（${escape(inferredSource || 'auto')}）</span>`
              : `<span class="tag" style="margin-left:8px;font-size:var(--fs-sm);color:var(--warn);border-color:rgba(245,158,11,0.3);">未识别 — 请手输</span>`}
          </label>
          <input id="og-magic-input" type="text" value="${inferredMagic ?? ''}" placeholder="如 999 — OrderGuard 用 magic 把 MT5 成交单归到这只 EA"
            style="width:100%;padding:8px;background:var(--overlay-2);border:1px solid var(--overlay-5);color:var(--text);border-radius:4px;font-family:var(--font-mono);">
          <div class="muted" style="font-size:var(--fs-sm);margin-top:4px;">
            ${inferredMagic != null
              ? '已自动从 ' + escape(inferredSource || '') + ' 识别。如不对，手动覆盖即可。'
              : '没自动推断到 —— 看你 EA 的 InputParameters 里的 MagicNumber / 或 MQL5 终端日志里 EA 开仓时的 magic 字段。'}
            <br>⚠ Magic 错了 → 把别人单子归到这只 EA 头上 / 漏归你自己的。
          </div>
        </div>

        <!-- 0.3.163: 启用前就让用户填阈值 — 用户反馈「这个表单应该在开启护航时就应该出现」 -->
        <div style="margin: 14px 0; border-top: 1px dashed var(--border-soft); padding-top: 12px;">
          <div style="font-weight: 600; margin-bottom: 8px;">🛡 <span style="color: var(--accent);">护航阈值</span> <span class="muted small">— 触发警报 + 微信推送（启用时一起生效）</span></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px;">
            <div class="field">
              <label>📉 单笔订单浮亏 USD <span class="muted small">（负数）</span></label>
              <input type="number" id="og-init-single-loss-usd" step="1" value="${ogInitThresholds?.single_loss_usd ?? -100}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>📉 单笔订单浮亏 % <span class="muted small">（占账户余额, 负数）</span></label>
              <input type="number" id="og-init-single-loss-pct" step="0.1" value="${ogInitThresholds?.single_loss_pct ?? -5}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>⏰ 单笔最长持仓小时</label>
              <input type="number" id="og-init-max-holding-hours" min="1" step="1" value="${ogInitThresholds?.max_holding_hours ?? 24}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field">
              <label>📉 整体账户浮亏 % <span class="muted small">（负数）</span></label>
              <input type="number" id="og-init-max-account-loss-pct" step="0.1" value="${ogInitThresholds?.max_account_loss_pct ?? -8}" style="width: 100%; font-family: var(--font-mono);">
            </div>
            <div class="field" style="grid-column: 1 / -1;">
              <label>🔒 锁仓上限 <span class="muted small">（多空对锁数）</span></label>
              <input type="number" id="og-init-max-locked" min="0" step="1" value="${ogInitThresholds?.max_locked_positions ?? 4}" style="width: 100%; font-family: var(--font-mono); max-width: 200px;">
            </div>
          </div>
          <div class="muted small" style="margin-top: 6px;">触发任一条件 → 护航推送微信告警 + 客户端 UI ⚠ 标记。冷却 30 分钟同笔不重发。启用后还能改。</div>
        </div>

        <div id="og-msg" style="margin:8px 0;font-size:var(--fs-sm);min-height:18px;"></div>
        <div class="row" style="gap:8px;">
          <button class="btn primary" id="og-enable">启用护航</button>
          <button class="btn ghost" id="og-cancel">取消</button>
        </div>
      `;
      body.querySelector('#og-cancel')?.addEventListener('click', () => modal.close());
      body.querySelector('#og-enable')?.addEventListener('click', async () => {
        const mode = body.querySelector('input[name="og-mode"]:checked')?.value || 'observe';
        const magicStr = body.querySelector('#og-magic-input')?.value.trim() || '';
        const magic = Number.parseInt(magicStr, 10);
        const msg = body.querySelector('#og-msg');
        if (!magicStr || !Number.isFinite(magic) || magic <= 0) {
          msg.textContent = '⚠ 请输入有效的 magic number（正整数）';
          msg.style.color = 'var(--danger)';
          return;
        }
        // 0.3.163: 收集启用时填的阈值, 持久化 + 启用时带过去
        const initThresholds = {
          single_loss_usd:      Number(body.querySelector('#og-init-single-loss-usd').value)      || -100,
          single_loss_pct:      Number(body.querySelector('#og-init-single-loss-pct').value)      || -5,
          max_holding_hours:    Number(body.querySelector('#og-init-max-holding-hours').value)    || 24,
          max_account_loss_pct: Number(body.querySelector('#og-init-max-account-loss-pct').value) || -8,
          max_locked_positions: Number(body.querySelector('#og-init-max-locked').value)           || 4,
          strategy_type: ogInitThresholds?.strategy_type || '',
          ai_reason:     ogInitThresholds?.ai_reason || '',
          source:        ogInitThresholds?.source || 'user',
        };
        // 先持久化阈值, 不管启用走哪条分支都先存一份
        try { await window.easydeal.strategies.saveOrderguardThresholds(eaName, initThresholds); } catch {}

        msg.textContent = '启用中…';
        msg.style.color = 'var(--text-3)';
        try {
          // 0.3.163: 拦截模式不立即 enableEa — 用户反馈「让 AI 修改完，再由 AI 去改变状态」.
          // 拦截模式: 只 deployIntercept + 触发 retrofit, 由 main.js chat busy listener
          // 在 AI 输出「✅ 已为 <eaName> 加上 OrderGuard」标志后自动 enableEa(enforce, magic, thresholds).
          // 用户点全停 / AI 失败 → last turn interrupted → 不 enableEa → EA 保持「未启用」.
          if (mode === 'enforce') {
            msg.textContent = '部署 OrderGuard.mqh + rules 到 MT5 中…';
            msg.style.color = 'var(--text-3)';
            const dep = await window.easydeal.orderguard.deployIntercept(eaName);
            if (!dep?.ok || !(dep.deployed || []).length) {
              msg.innerHTML = `部署失败：<br>${(dep?.errors || [dep?.error || '?']).map(escape).join('<br>')}`;
              msg.style.color = 'var(--danger)';
              return;
            }

            // 部署完毕 → 让 AI 改 EA 代码 + 把 magic / thresholds 一起带给 main.js 登记 pending state.
            msg.textContent = '部署完成，正在让 AI 改造 EA 源码…';
            const retrofit = await window.easydeal.app.requestOrderguardRetrofit(eaName, magic, initThresholds);
            if (retrofit?.ok) {
              showToast(`✓ ${eaName} 部署完成, AI 改造中. 改完编译成功后自动启用拦截护航 (看「💬 聊天」tab 进度).`, 'ok');
              modal.close();
              setTimeout(() => {
                if (typeof window.showTab === 'function') window.showTab('chat');
              }, 250);
            } else {
              msg.innerHTML = `部署完成，但 AI 改造没启动：${escape(retrofit?.error || '?')}<br>` +
                              `<span class="muted small">EA 未真正启用拦截护航. 稍后到 🛡 护航对话框重试.</span>`;
              msg.style.color = 'var(--warn)';
            }
          } else {
            // 监控模式: 不改 EA 代码, 立即 enableEa 一起把阈值推给 OG
            const r = await window.easydeal.orderguard.enableEa(eaName, magic, 'observe', initThresholds);
            if (!r?.ok) {
              // 0.3.238: 详细错误信息 — 给用户能截图反馈的诊断信息
              const stage = r?.stage || '?';
              const baseErr = r?.error || '?';
              let extra = '';
              if (r?.diag) {
                const d = r.diag;
                extra = `\n\n诊断信息（截图给开发）：\n` +
                  `· stage: ${stage}\n` +
                  `· EA: ${d.ea_name} / magic=${d.magic} / mode=${d.mode}\n` +
                  `· 绑定实例: ${d.bound_instance_id || '(默认)'} (${d.bound_source})\n` +
                  `· OG pool: ${d.pool_size} 实例\n` +
                  `· pool 状态: ${(d.pool_instances || []).map((i) => `${i.name}(running=${i.running}, port=${i.port})`).join(' | ') || '空'}`;
                if (r.og_response) {
                  extra += `\n· OG 返回: ${JSON.stringify(r.og_response).slice(0, 200)}`;
                }
              } else if (r?.stack) {
                extra = `\n\n异常堆栈（截图给开发）：\n${r.stack.slice(0, 400)}`;
              }
              msg.innerHTML = `启用失败 [${escape(stage)}]：${escape(baseErr)}<pre style="font-size:11px;white-space:pre-wrap;color:var(--text-3);margin-top:6px;">${escape(extra)}</pre>`;
              msg.style.color = 'var(--danger)';
              return;
            }
            showToast(`✓ ${eaName} 已启用监控护航 (magic=${magic})`, 'ok');
            modal.close();
            if (typeof window.showTab === 'function') {
              setTimeout(() => window.showTab('orderguard'), 250);
            }
          }
        } catch (e) {
          msg.textContent = `启用失败：${e?.message || e}`;
          msg.style.color = 'var(--danger)';
        }
      });
    }
  }
  render();
}

// 0.3.67: 拦截模式改为 AI 自动改造，不再展示「手动加 3 行代码」教程对话框。
// 用户点启用后：deploy mqh + rules → AI 改 .mq5 + 编译 → 切到 chat tab 看进度。

// 0.5.x: per-EA 经验笔记 查看/编辑弹窗(读写 workspace/strategies/<EA>.experience.md)。
// AI 每日总结 + record_experience 主动记 + 远程 push_experience 都写这个文件; 这里给人看/手改。
async function openExperienceDialog(eaName) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.className = 'card';
  box.style.cssText = 'width:640px;max-width:94vw;height:74vh;display:flex;flex-direction:column;padding:0;';
  const close = () => { try { document.body.removeChild(ov); } catch {} };
  box.innerHTML = `
    <div class="row between" style="padding:12px 14px;border-bottom:1px solid var(--border-soft,#2a2a2a);">
      <strong>📒 经验笔记 · <span data-x-name></span></strong>
      <button class="btn ghost small" data-x-close>关闭</button>
    </div>
    <div style="padding:8px 14px;font-size:11px;opacity:0.7;border-bottom:1px solid var(--border-soft,#2a2a2a);">
      AI 每日自动总结 + 主动记录的「人工介入 / 运作规律 / 教训」都写在这。挂载 / 护航分析 / 远程协助时 AI 会读它延续经验。你也可手动补充 / 修改。
    </div>
    <textarea data-x-ta spellcheck="false" style="flex:1;margin:0;border:0;border-radius:0;resize:none;padding:14px;background:var(--surface-100,#161616);color:var(--text);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5;overflow:auto;"></textarea>
    <div class="row between" style="padding:10px 14px;border-top:1px solid var(--border-soft,#2a2a2a);">
      <span data-x-status style="font-size:11px;opacity:0.6;">加载中…</span>
      <span><button class="btn ghost small" data-x-cancel>取消</button> <button class="btn primary small" data-x-save>保存</button></span>
    </div>`;
  box.querySelector('[data-x-name]').textContent = String(eaName || '');
  ov.appendChild(box); document.body.appendChild(ov);
  const ta = box.querySelector('[data-x-ta]');
  const status = box.querySelector('[data-x-status]');
  ta.disabled = true;
  try {
    const r = await window.easydeal.experience.get(eaName);
    if (r && r.ok) {
      ta.value = r.content || '';
      status.textContent = r.content ? (r.file || '') : '暂无经验笔记 — 可手写第一条, 或等 AI 自动记';
    } else { status.textContent = '读取失败: ' + ((r && r.error) || '未知'); }
  } catch (e) { status.textContent = '读取失败: ' + (e && e.message || e); }
  ta.disabled = false; ta.focus();
  const save = async () => {
    const btn = box.querySelector('[data-x-save]'); btn.disabled = true; status.textContent = '保存中…';
    try {
      const r = await window.easydeal.experience.set(eaName, ta.value);
      if (r && r.ok) { status.textContent = '已保存 ' + new Date().toLocaleTimeString(); try { window.showToast && window.showToast('经验笔记已保存', 'ok'); } catch {} }
      else { status.textContent = '保存失败: ' + ((r && r.error) || '未知'); }
    } catch (e) { status.textContent = '保存失败: ' + (e && e.message || e); }
    btn.disabled = false;
  };
  box.querySelector('[data-x-save]').addEventListener('click', save);
  box.querySelector('[data-x-close]').addEventListener('click', close);
  box.querySelector('[data-x-cancel]').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
}

async function openIndicatorsDialog(eaFile) {
  const eaName = String(eaFile || '').replace(/\.(mq5|ex5)$/i, '');
  const body = el('div');
  body.innerHTML = '<div class="muted small">载入中…</div>';
  const modal = _openModal(`📎 ${eaName} 关联指标`, body, { width: 720 });

  // 先查这只 EA 有没有 .mq5 源码 — 决定「嗅探源码」按钮显不显示
  let hasSource = false;
  try {
    const meta = _strategyMetaByName[eaFile] || _strategyMetaByName[`${eaName}.mq5`] || _strategyMetaByName[`${eaName}.ex5`];
    hasSource = !!meta?.has_source;
  } catch {}

  const renderList = async () => {
    body.innerHTML = '<div class="muted small">读取已绑定的指标…</div>';
    const r = await window.easydeal.strategies.indicatorsList(eaName);
    if (!r.ok) {
      body.innerHTML = `<div class="empty">读取失败：${escape(r.error || '?')}</div>`;
      return;
    }
    const items = r.items || [];

    body.innerHTML = `
      <div class="hint" style="line-height: 1.7; margin-bottom: 12px;">
        管理这只 EA 依赖的自定义指标（<code>iCustom()</code> 调用的 .ex5）。
        <br>• <b>风洞回测</b>：适配器需要实现策略依赖的指标逻辑。
        <br>• <b>上架商城</b>：跟主 EA .ex5 一起打 <code>${escape(eaName)}.ezpkg</code> 包给买家
        <br>• <b>本地存放</b>：<code>workspace/strategies/.indicators/${escape(eaName)}/</code>
      </div>
      <div class="row" style="gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
        <button class="btn primary small" data-act="pick">📂 选文件添加…</button>
        ${hasSource ? `<button class="btn ghost small" data-act="auto">🪄 自动从 MT5 导入（嗅探 iCustom）</button>` : ''}
        <button class="btn ghost small" data-act="sniff" title="只解析依赖名清单不拷文件">🔍 ${hasSource ? '只看依赖列表' : '尝试嗅探（无 .mq5 源码可能失败）'}</button>
      </div>
      ${items.length === 0
        ? `<div class="empty" style="text-align:left;padding:14px;">
            还没绑定任何指标。<br>
            ${hasSource
              ? '推荐先点 <b>「🪄 自动从 MT5 导入」</b> — 解析源码里所有 iCustom() 调用并从主 MT5 自动拷。'
              : '这只 EA 没 .mq5 源码 → 无法自动嗅探，请用 <b>「📂 选文件添加」</b> 手动选你 MT5 里 <code>MQL5/Indicators/</code> 下用到的 .ex5 文件。'}
          </div>`
        : `<table class="list" style="margin-top:8px;">
            <thead><tr><th>文件</th><th style="text-align:right;width:90px;">大小</th><th style="width:90px;">操作</th></tr></thead>
            <tbody>
              ${items.map((it) => `
                <tr>
                  <td><code>${escape(it.name)}</code></td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--text-3);">${fmtSize(it.size)}</td>
                  <td><button class="btn ghost small" data-act="remove" data-name="${escape(it.name)}">删除</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>`}
    `;
  };

  body.addEventListener('click', async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'pick') {
      const pick = await window.easydeal.strategies.indicatorsPickFiles();
      if (!pick.ok || !pick.paths?.length) return;
      const ok = []; const bad = [];
      for (const p of pick.paths) {
        const r = await window.easydeal.strategies.indicatorsAdd(eaName, p);
        if (r.ok) ok.push(r.name); else bad.push(`${p}: ${r.error}`);
      }
      if (ok.length) showToast(`已添加 ${ok.length} 个指标`, 'ok');
      if (bad.length) showToast(`部分失败：${bad[0]}${bad.length > 1 ? `（共 ${bad.length} 个）` : ''}`, 'error');
      await renderList();
      return;
    }
    if (act === 'remove') {
      const name = e.target.dataset.name;
      if (!name) return;
      if (!confirm(`确定删除指标「${name}」？\n（只删 workspace 里这只 EA 的绑定，不影响主 MT5 MQL5/Indicators/ 下的原文件。）`)) return;
      const r = await window.easydeal.strategies.indicatorsRemove(eaName, name);
      if (!r.ok) { showToast(`删除失败：${r.error}`, 'error'); return; }
      showToast('已删除', 'ok');
      await renderList();
      return;
    }
    if (act === 'auto') {
      e.target.disabled = true;
      e.target.textContent = '🪄 嗅探 + 拷文件中…';
      const r = await window.easydeal.strategies.indicatorsAutoImport(eaName);
      e.target.disabled = false;
      e.target.textContent = '🪄 自动从 MT5 导入（嗅探 iCustom）';
      if (!r.ok && (!r.imported || !r.imported.length)) {
        showToast(`自动导入失败：${r.error || '没找到任何依赖'}`, 'error');
      } else {
        const parts = [];
        if (r.imported?.length) parts.push(`导入 ${r.imported.length} 个`);
        if (r.not_found?.length) parts.push(`未找到 ${r.not_found.length}：${r.not_found.slice(0, 3).join(', ')}${r.not_found.length > 3 ? '…' : ''}`);
        if (r.errors?.length) parts.push(`错误 ${r.errors.length}`);
        showToast(parts.join(' · ') || '没有需要导入的指标', r.imported?.length ? 'ok' : 'info');
        if (r.not_found?.length) {
          alert([
            `嗅探到这只 EA 调用了这些指标，但主 MT5 MQL5/Indicators/ 里没找到对应 .ex5：`,
            '',
            r.not_found.map((n) => `  - ${n}`).join('\n'),
            '',
            '请确认：',
            '  1. 这些指标是 MT5 内置的吗？（内置指标不用绑定）',
            '  2. 是不是装在子目录里？（自动嗅探会 recursive 找 6 层）',
            '  3. 没有的话请联系指标作者拿 .ex5 文件，再用「📂 选文件添加」手动加。',
          ].join('\n'));
        }
      }
      await renderList();
      return;
    }
    if (act === 'sniff') {
      const r = await window.easydeal.strategies.indicatorsSniff(eaName);
      if (!r.ok) { alert(`嗅探失败：${r.error}\n（多半是这只 EA 没 .mq5 源码 — 用「📂 选文件添加」手动绑）`); return; }
      if (!r.names?.length) { alert('源码里没扫到 iCustom() / #resource Indicators 调用 — 这只 EA 可能不依赖自定义指标。'); return; }
      alert(`扫到 ${r.names.length} 个依赖指标名：\n\n${r.names.map((n) => `  - ${n}`).join('\n')}\n\n点「🪄 自动从 MT5 导入」可以一键全拷过来。`);
      return;
    }
  });

  await renderList();
}

async function openParamsSettingsDialog(eaFile) {
  const eaName = String(eaFile || '').replace(/\.(mq5|ex5)$/i, '');
  const body = el('div');
  body.innerHTML = '<div class="muted small">载入中…</div>';
  const modal = _openModal(`⚙ ${eaName} 参数设置`, body, { width: 820 });

  // 顶部危险操作：同时删除运行时 config.set 与下次重挂用的 Presets/<EA>.set。
  // 放在标题栏而非表格操作区，避免被误解成“清空当前输入框”。
  const headerTitle = modal.header.querySelector('h3');
  if (headerTitle) headerTitle.style.flex = '1';
  const headerClose = modal.header.querySelector('button');
  const deleteHotBtn = el('button', 'btn ghost small');
  deleteHotBtn.id = 'param-delete-hot-file-btn';
  deleteHotBtn.textContent = '删除热参文件';
  deleteHotBtn.title = '删除当前绑定 MT5 实例中的 config.set 和 Presets/<EA>.set';
  deleteHotBtn.style.cssText = 'flex-shrink:0;white-space:nowrap;color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent);margin-right:8px;';
  modal.header.insertBefore(deleteHotBtn, headerClose || null);

  deleteHotBtn.addEventListener('click', async () => {
    const confirmed = window.confirm(
      `确定删除「${eaName}」的热参文件吗？\n\n`
      + `将删除当前绑定 MT5 实例中的：\n`
      + `  • MQL5/Files/${eaName}_config.set\n`
      + `  • MQL5/Presets/${eaName}.set\n\n`
      + `不会删除 EA、源码或当前运行值。正在运行的 EA 需要重新挂载或重启 MT5，才会恢复源码默认参数。`
    );
    if (!confirmed) return;

    const oldText = deleteHotBtn.textContent;
    deleteHotBtn.disabled = true;
    deleteHotBtn.textContent = '删除中…';
    try {
      const r = await window.easydeal.strategies.paramsDeleteHotFile(eaName);
      if (!r?.ok) {
        const detail = r?.error || r?.errors?.map((it) => it.error).filter(Boolean).join('；') || '未知错误';
        window.alert(`删除失败：${detail}`);
        return;
      }
      const count = Array.isArray(r.removed) ? r.removed.length : 0;
      if (count === 0) {
        showToast('没有找到可删除的热参文件', 'info');
      } else {
        showToast(`已删除 ${count} 个热参文件；重新挂载后恢复源码默认参数`, 'ok');
      }
    } catch (e) {
      window.alert(`删除失败：${e?.message || e}`);
    } finally {
      deleteHotBtn.disabled = false;
      deleteHotBtn.textContent = oldText;
    }
  });

  let inputsResp, paramsResp, hrResp;
  try {
    [inputsResp, paramsResp, hrResp] = await Promise.all([
      window.easydeal.strategies.paramsListInputs(eaName),
      window.easydeal.strategies.paramsRead(eaName),
      window.easydeal.strategies.paramsDetectHotReload(eaName),
    ]);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--warn)">载入失败：${escape(e?.message || e)}</div>`;
    return;
  }

  const inputs = inputsResp?.ok ? (inputsResp.inputs || []) : [];
  const ex5Only = !!inputsResp?.ex5_only;
  // 1.3.20 修「改了热参再打开参数设置没变化」: get_strategy_params 实际返回
  // {params:[{name, effective_value, effective_from, ...}]}(数组), 之前找的
  // data.effective_values / parameters.effective_value 都不存在 → effective 恒空 →
  // 表格永远回落源码默认值。写入/EA 应用其实都成功(config.set+runtime.json 都对),
  // 纯回显读错字段。老形状留作兜底。
  const effective = {};
  const _plist = Array.isArray(paramsResp?.params) ? paramsResp.params
               : (Array.isArray(paramsResp?.data?.params) ? paramsResp.data.params : null);
  if (_plist) {
    for (const p of _plist) {
      if (p && p.name != null && p.effective_value != null) effective[p.name] = p.effective_value;
    }
  } else {
    Object.assign(effective,
      paramsResp?.data?.effective_values
      || paramsResp?.effective_values
      || paramsResp?.parameters?.effective_value
      || {});
  }
  const supportsHotReload = !!hrResp?.supported;
  const hrAdvice = hrResp?.advice || '';

  if (ex5Only && inputs.length === 0) {
    body.innerHTML = `
      <p class="muted small">${escape(eaName)} 是 .ex5-only 策略（没源码），无法自动列出 input 参数。</p>
      <p class="muted small">如果你知道参数名，可以让 AI 用 <code>update_strategy_param</code> 工具一个一个改 — 也可以摘 EA 用 MT5「Properties」→「Load」直接挂一份 .set。</p>
    `;
    return;
  }

  // 渲染表格
  const tbody = el('tbody');
  for (const inp of inputs) {
    const tr = el('tr');
    const curVal = effective[inp.name] != null ? String(effective[inp.name]) : inp.default;
    tr.innerHTML = `
      <td style="padding:6px 8px;font-family:monospace;font-size: var(--fs-md);">${escape(inp.name)}</td>
      <td style="padding:6px 8px;color:var(--text-3);font-size: var(--fs-sm);">${escape(inp.type)}</td>
      <td style="padding:6px 8px;color:var(--text-3);font-size: var(--fs-sm);">${escape(inp.default)}</td>
      <td style="padding:6px 8px;"><input class="param-input" data-name="${escape(inp.name)}" value="${escape(curVal)}" style="width:140px;padding:3px 6px;background:var(--overlay-2);border:1px solid var(--overlay-5);color:var(--text-1);border-radius:4px;font-family:monospace;font-size: var(--fs-md);"></td>
      <td style="padding:6px 8px;color:var(--text-3);font-size: var(--fs-sm);">${escape(inp.comment || '')}</td>
    `;
    tbody.appendChild(tr);
  }

  body.innerHTML = '';
  // 热更新状态
  const hrBanner = el('div');
  hrBanner.style.cssText = `padding:8px 12px;border-radius:6px;font-size: var(--fs-md);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;${supportsHotReload ? 'background:rgba(46,160,67,0.12);color:#7bd88f;' : 'background:rgba(245,158,11,0.12);color:#f3b557;'}`;
  const hrText = el('div');
  hrText.style.cssText = 'flex:1;min-width:0;';
  hrText.innerHTML = `<strong>${supportsHotReload ? '✓ 该 EA 支持热更新' : '⚠ 该 EA 不支持热更新'}</strong> — ${escape(hrAdvice)}`;
  hrBanner.appendChild(hrText);
  // 不支持热更新 → 在 banner 右侧加「一键修改」按钮，点了让 AI 在 chat
  // 改 .mq5 加 OnTimer config.set poll 协议。改完回来弹窗自动重开 + 重新检测。
  if (!supportsHotReload) {
    const fixBtn = el('button', 'btn primary small');
    fixBtn.textContent = '🔧 一键修改';
    fixBtn.style.cssText = 'flex-shrink:0;white-space:nowrap;';
    fixBtn.title = '让 AI 给这只 EA 源码加上热更新协议（OnTimer 轮询 config.set，3 秒内生效）';
    fixBtn.addEventListener('click', async () => {
      const ok = window.confirm(
        `🔧 一键修改：让 AI 给「${eaName}」加热更新协议\n\n` +
        `AI 会做这些事：\n` +
        `  1. Read strategies/${eaName}.mq5 看现有结构\n` +
        `  2. 修改源码 — 加 OnInit 里 EventSetTimer(3) + OnTimer 里轮询 MQL5/Files/${eaName}_config.set\n` +
        `  3. 调 compile_strategy 编译\n` +
        `  4. 完成后告诉你回这里看效果\n\n` +
        `⚠ 改源码只增加热更新代码，不动其他逻辑（OnTick / 订单管理 / input 列表都保留原样）。\n` +
        `⚠ 改完需要重新挂载 EA（旧的 .ex5 还在跑老逻辑）。\n\n` +
        `点确定后会自动发给 AI 开始执行（不再二次确认）。要继续吗？`
      );
      if (!ok) return;
      // 直接走 main 进程的 chat.send IPC，不再让用户在 chat input 里审 prompt。
      // prompt 由 main.js 那边的 IPC handler 拼装好（跟 [ea-create] [backtest] 同款架构）。
      let r;
      try {
        r = await window.easydeal.app.requestHotReloadRetrofit(eaName);
      } catch (e) {
        window.alert(`发送失败：${e?.message || e}`);
        return;
      }
      if (!r?.ok) {
        window.alert(r?.error || '发送失败（请确认当前没有别的 AI 对话在跑）');
        return;
      }
      // 记下要重开的 EA — 用户从 chat tab 切回 我的策略 时会自动重弹同款对话框
      _pendingParamsReopen = eaFile;
      // 关弹窗 + 跳 chat tab（AI 已经在工作了）
      try { modal.close(); } catch {}
      if (typeof window.showTab === 'function') window.showTab('chat');
    });
    hrBanner.appendChild(fixBtn);
  }
  body.appendChild(hrBanner);

  // 从 .set 文件导入
  const importRow = el('div');
  importRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;';
  importRow.innerHTML = `
    <button class="btn ghost small" id="set-import-btn">📂 从 .set 文件导入…</button>
    <span class="muted small" id="opt-import-hint">挑一个 .set 文件应用到表格（不会立刻保存）</span>
  `;
  body.appendChild(importRow);

  // 参数表格
  const table = el('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size: var(--fs-md);';
  table.innerHTML = `
    <thead>
      <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--overlay-4);">
        <th style="padding:6px 8px;">参数名</th>
        <th style="padding:6px 8px;">类型</th>
        <th style="padding:6px 8px;">默认</th>
        <th style="padding:6px 8px;">当前值</th>
        <th style="padding:6px 8px;">说明</th>
      </tr>
    </thead>
  `;
  table.appendChild(tbody);
  body.appendChild(table);

  // Save bar
  const saveBar = el('div');
  saveBar.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--overlay-4);';
  saveBar.innerHTML = `
    <button class="btn primary" id="param-save-btn">保存修改</button>
    <button class="btn ghost" id="param-cancel-btn">取消</button>
    <span class="muted small" id="param-save-msg" style="margin-left:10px;"></span>
  `;
  body.appendChild(saveBar);

  // Wire events
  body.querySelector('#param-cancel-btn').addEventListener('click', modal.close);

  body.querySelector('#set-import-btn').addEventListener('click', async () => {
    const hint = body.querySelector('#opt-import-hint');
    hint.textContent = '弹文件选择…';
    let r;
    try {
      r = await window.easydeal.strategies.paramsImportSetFile();
    } catch (e) {
      hint.textContent = '失败：' + (e?.message || e);
      return;
    }
    if (r?.canceled) {
      hint.textContent = '已取消';
      return;
    }
    if (!r?.ok) {
      hint.textContent = '失败：' + (r?.error || '未知错误');
      return;
    }
    // Apply matched keys to table, count mismatches
    const importedParams = r.params || {};
    let applied = 0;
    let unknown = 0;
    const inputNames = new Set(Array.from(tbody.querySelectorAll('.param-input'))
      .map((el) => el.dataset.name));
    tbody.querySelectorAll('.param-input').forEach((inp) => {
      const nm = inp.dataset.name;
      if (importedParams[nm] != null) {
        inp.value = importedParams[nm];
        applied += 1;
      }
    });
    for (const k of Object.keys(importedParams)) {
      if (!inputNames.has(k)) unknown += 1;
    }
    const fileName = (r.path || '').split(/[\\\/]/).pop();
    hint.textContent = `✓ 从 ${fileName} 导入：应用 ${applied} 个参数` +
      (unknown ? `，忽略 ${unknown} 个不属于当前 EA 的键` : '') +
      ` — 点「保存修改」生效`;
  });

  body.querySelector('#param-save-btn').addEventListener('click', async () => {
    const msg = body.querySelector('#param-save-msg');
    const params = {};
    tbody.querySelectorAll('.param-input').forEach((inp) => {
      params[inp.dataset.name] = inp.value;
    });
    if (!Object.keys(params).length) {
      msg.textContent = '没参数可保存';
      return;
    }
    // 非热更 EA → 二次确认重新挂载
    if (!supportsHotReload) {
      const okConfirm = window.confirm(
        `⚠ 该 EA (${eaName}) 不支持热更新协议。\n\n`
        + '保存后参数会写到 MT5 Presets/<EA>.set，但运行中的 EA 不会自动应用 — \n'
        + '需要你去 MT5 把这个 EA 摘了再重新挂上（或重启 MT5）。\n\n'
        + '确定保存？'
      );
      if (!okConfirm) return;
    }
    msg.textContent = '保存中…';
    try {
      const r = await window.easydeal.strategies.paramsWrite({
        ea_name: eaName, params, mode: 'both',
      });
      if (r?.ok) {
        const hint = supportsHotReload
          ? '✓ 已保存（config.set + Presets/.set），3 秒内 EA 会自动 reload'
          : '✓ 已保存（Presets/.set），请去 MT5 把 EA 摘了重新挂';
        msg.textContent = hint;
        setTimeout(modal.close, 2000);
      } else {
        msg.textContent = '失败：' + (r?.error || r?.errors?.join('；') || '未知');
      }
    } catch (e) {
      msg.textContent = '失败：' + (e?.message || e);
    }
  });
}
