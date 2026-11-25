// Skills tab — read-only list of:
//   - MCP tools currently wired up (live-queried each time the tab opens)
//   - 知识库 (0.3.164: 从原独立 tab 并入此处, 在 MCP 工具 ↔ AI Skills 之间)
//   - Claude Code skills installed on the user's machine
//
// Each row shows the friendly Chinese name + the original tool/skill id +
// a one-line description. Clicking a row toggles a more detailed expansion
// (full description, file path for skills, server for tools).

import { renderKnowledge } from './knowledge-view.js';

export async function renderSkills(root) {
  root.innerHTML = '';

  const hero = el('section', 'hero-tight skills-hero');
  hero.innerHTML = `
    <div>
      <h1>Skills</h1>
      <p class="lede">AI 当前可用的 MCP 工具 + 已安装的本地 Skills。<span class="lede-dim">告诉 AI "用 XX 工具" 或 "/skill-name" 即可调用。</span></p>
    </div>
    <div class="skills-hero-hint">
      <span class="skills-hero-hint-icon">💬</span>
      <div>
        <div class="skills-hero-hint-title">需要安装更多 Skills？</div>
        <div class="skills-hero-hint-body">在<a href="#" data-jump-tab="chat">对话</a>里直接告诉 AI，例如<br>"帮我装一个分析 K 线的 skill"</div>
      </div>
    </div>
  `;
  root.appendChild(hero);

  // Click "对话" link in the hint to jump to the chat tab.
  hero.addEventListener('click', (e) => {
    const tab = e.target?.closest?.('[data-jump-tab]')?.dataset.jumpTab;
    if (!tab) return;
    e.preventDefault();
    if (typeof window.showTab === 'function') window.showTab(tab);
  });

  const status = el('div', 'banner banner-info');
  status.innerHTML = `<span class="banner-dot"></span><span>正在收集……</span>`;
  root.appendChild(status);

  // 0.3.164: 三段独立 host —
  //   mcpHost  : MCP 工具卡 (每 5s 重画)
  //   kbHost   : 知识库 (一次 mount, 不被 loadOnce 重画 — 否则用户上传 / 下载状态会被刷掉)
  //   skillsHost: AI Skills 卡 (每 5s 重画)
  // 用户说「知识库放到 AI Skills 部分之前」, 顺序: MCP → 知识库 → AI Skills.
  const mcpHost    = el('div');
  const kbHost     = el('div');
  const skillsHost = el('div');
  root.appendChild(mcpHost);
  root.appendChild(kbHost);
  root.appendChild(skillsHost);

  // KB section 一次 mount (renderKnowledge 自己挂 button handlers + 自己 refresh)
  try { renderKnowledge(kbHost); }
  catch (e) { console.warn('[skills-view] renderKnowledge mount failed', e); }

  let _pollTimer = null;
  let _lastSig = '';
  async function loadOnce() {
    try {
      const data = await window.easydeal.app.listSkills();
      status.remove();
      // 计算一个轻量签名（每个 group 的 server + 工具数 + trading-write /
      // trading-write-open 标志），变化时才整块重画，避免抖动。
      const sig = (data.mcp || [])
        .map((g) => `${g.server}:${(g.tools || []).length}:${g.trading_write_enabled ? 'tw1' : 'tw0'}:${g.trading_write_open_enabled ? 'to1' : 'to0'}`)
        .join('|');
      if (sig !== _lastSig) {
        _lastSig = sig;
        mcpHost.innerHTML    = '';
        skillsHost.innerHTML = '';
        renderInventory(mcpHost, skillsHost, data);
      }
    } catch (e) {
      status.className = 'banner banner-warn';
      status.innerHTML = `<span class="banner-dot"></span><span>加载失败：${escape(e.message || String(e))}</span>`;
    }
  }
  await loadOnce();

  // 每 5 秒轻量重查 list-skills。这样用户在「设置 → 高级」勾「允许 AI
  // 平仓改单」之后切回 Skills 页能立刻看到 close_position / modify_position
  // 工具出现 / 消失，无需手动刷新。
  _pollTimer = setInterval(loadOnce, 5000);
  // 节点从 DOM 摘掉时停止轮询，避免内存泄漏 / 后台浪费 token。
  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      clearInterval(_pollTimer);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// 0.3.164: 拆成两个 host (mcpHost, skillsHost) — kbHost 不参与重画.
function renderInventory(mcpHost, skillsHost, { mcp = [], skills = [] }) {
  // ---- MCP tools ----
  const mcpCard = el('div', 'card');
  const mcpHead = el('div', 'section-head');
  mcpHead.innerHTML = `
    <h2>MCP 工具</h2>
    <span class="sub">workspace/.mcp.json</span>
    <span class="spacer"></span>
    <span class="tag" style="background: rgba(85, 179, 255, 0.12); color: var(--info); border-color: rgba(85, 179, 255, 0.30);">${mcp.reduce((s, g) => s + (g.tools?.length || 0), 0)} 个</span>
  `;
  mcpCard.appendChild(mcpHead);

  if (!mcp.length) {
    const e = el('div', 'empty');
    e.textContent = '没有连接到任何 MCP 服务。';
    mcpCard.appendChild(e);
  } else {
    for (const group of mcp) {
      const g = el('div', 'skills-group');
      const tools = group.tools || [];
      // 0.3.166: EasyDeal MT5 group — 显示「允许平仓改单」+「允许开仓」两个
      // 独立 chip，替代之前顶栏 trade-close-pulse / trade-open-pulse。
      // 用户在 Skills 页就能确认设置→高级里两个开关有没有真正生效。
      const isEasydeal = group.server === 'easydeal';
      let tradingChip = '';
      if (isEasydeal) {
        // 平仓改单 chip
        tradingChip += group.trading_write_enabled
          ? '<span class="tag" style="background:rgba(245,158,11,0.15);color:#f59e0b;border-color:rgba(245,158,11,0.4);margin-left:6px" title="设置→高级 已勾「允许 AI 平仓改单」，close_position / modify_position 会出现在下面工具列表里">⚠ 允许平仓改单</span>'
          : '<span class="tag" style="margin-left:6px;color:var(--text-3)" title="设置→高级 未勾「允许 AI 平仓改单」，close_position / modify_position 不会暴露给 AI">🔒 平仓改单关闭</span>';
        // 开仓 chip（独立 toggle）
        tradingChip += group.trading_write_open_enabled
          ? '<span class="tag" style="background:rgba(232,152,118,0.15);color:#e89876;border-color:rgba(232,152,118,0.4);margin-left:4px" title="设置→高级 已勾「允许 AI 直接开仓」，open_position 会出现在下面工具列表里">⚠⚠ 允许开仓</span>'
          : '<span class="tag" style="margin-left:4px;color:var(--text-3)" title="设置→高级 未勾「允许 AI 直接开仓」，open_position 不会暴露给 AI">🔒 开仓关闭</span>';
      }
      g.innerHTML = `
        <div class="skills-group-head">
          <span class="skills-group-name">${escape(group.label || group.server)}</span>${tradingChip}
          <span class="skills-group-meta">${escape(group.server)} · ${tools.length} 个工具${
            group.kind === 'on-demand' ? ' · 按需启动' :
            group.kind === 'live'      ? ' · 持久连接' : ''}</span>
        </div>
        ${group.error ? `<div class="skills-error">${escape(group.error)}</div>` : ''}
        <div class="skills-list"></div>
      `;
      const list = g.querySelector('.skills-list');
      for (const t of tools) list.appendChild(toolItem(t, group.server));
      mcpCard.appendChild(g);
    }
  }
  mcpHost.appendChild(mcpCard);

  // ---- Claude Code skills ----
  const skillsCard = el('div', 'card');
  const skillsHead = el('div', 'section-head');
  skillsHead.innerHTML = `
    <h2>AI Skills</h2>
    <span class="sub">~/.claude/skills + plugins</span>
    <span class="spacer"></span>
    <span class="tag" style="background: rgba(95, 201, 146, 0.12); color: var(--success); border-color: rgba(95, 201, 146, 0.30);">${skills.reduce((s, g) => s + (g.skills?.length || 0), 0)} 个</span>
  `;
  skillsCard.appendChild(skillsHead);

  if (!skills.length) {
    const e = el('div', 'empty');
    e.textContent = '没有检测到 SKILL.md 文件。可以用 /plugin install 装插件。';
    skillsCard.appendChild(e);
  } else {
    for (const group of skills) {
      const g = el('div', 'skills-group');
      const shortPath = shortenPath(group.path);
      g.innerHTML = `
        <div class="skills-group-head">
          <span class="skills-group-name">${escape(group.label || group.source)}</span>
          <span class="skills-group-meta" title="${escape(group.path)}">${escape(shortPath)} · ${group.skills.length} 个</span>
        </div>
        <div class="skills-list"></div>
      `;
      const list = g.querySelector('.skills-list');
      for (const s of group.skills) list.appendChild(skillItem(s));
      skillsCard.appendChild(g);
    }
  }
  skillsHost.appendChild(skillsCard);
}

function toolItem(t, server) {
  const node = el('div', 'skills-item');
  const friendly = t.label || t.name;
  node.innerHTML = `
    <div class="skills-item-row">
      <span class="skills-item-name">${escape(friendly)}</span>
      <code class="skills-item-id">${escape(t.name)}</code>
    </div>
    ${t.description ? `<div class="skills-item-desc">${escape(t.description)}</div>` : ''}
    <div class="skills-item-call">${escape(`mcp__${server}__${t.name}`)}</div>
  `;
  return node;
}

function skillItem(s) {
  const node = el('div', 'skills-item');
  const friendly = s.label || s.name;
  node.innerHTML = `
    <div class="skills-item-row">
      <span class="skills-item-name">${escape(friendly)}</span>
      <code class="skills-item-id">${escape(s.name)}</code>
      ${s.user_invocable === false ? '<span class="tag" title="不能由用户直接 /name 调用">仅自动触发</span>' : ''}
    </div>
    ${s.description ? `<div class="skills-item-desc">${escape(s.description)}</div>` : ''}
  `;
  return node;
}

// Display-friendly path: replace the home dir prefix with ~ and collapse
// long marketplace nesting to keep group headers single-line.
function shortenPath(p) {
  if (!p) return '';
  let s = String(p);
  // Replace C:\Users\<user>  /  /home/<user>  /  /Users/<user>  with ~
  s = s.replace(/^[A-Z]:[\\/]Users[\\/][^\\/]+/i, '~');
  s = s.replace(/^\/(home|Users)\/[^/]+/, '~');
  // Posix-ify
  s = s.replace(/\\/g, '/');
  // If still over 60 chars, collapse middle
  if (s.length > 60) {
    const head = s.slice(0, 24);
    const tail = s.slice(-30);
    s = `${head}…${tail}`;
  }
  return s;
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
