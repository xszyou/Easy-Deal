// Renderer entry — mounts each tab view, wires nav switching.

import { renderChat        } from './views/chat-view.js';
import { renderMt5         } from './views/mt5-view.js';
import { renderStrategies  } from './views/strategies-view.js';
import { renderOrderguard  } from './views/orderguard-view.js';
import { renderTimers      } from './views/timers-view.js';
import { renderSkills      } from './views/skills-view.js';
// 0.3.164: knowledge tab 整段并入 Skills, renderKnowledge 现在被 skills-view 内部
// import 直接调用渲染 KB 卡片. 这里不再注册成独立 tab.
import { renderTutorials   } from './views/tutorials-view.js';
import { renderNews        } from './views/news-view.js';
import { renderToken       } from './views/token-view.js';
import { renderSettings    } from './views/settings-view.js';

const tabs = document.querySelectorAll('#tabs .tab-btn');
const panes = {
  chat:        document.getElementById('tab-chat'),
  mt5:         document.getElementById('tab-mt5'),
  strategies:  document.getElementById('tab-strategies'),
  orderguard:  document.getElementById('tab-orderguard'),
  timers:      document.getElementById('tab-timers'),
  skills:      document.getElementById('tab-skills'),
  tutorials:   document.getElementById('tab-tutorials'),
  news:        document.getElementById('tab-news'),
  token:       document.getElementById('tab-token'),
  settings:    document.getElementById('tab-settings'),
};

const mounters = {
  chat:        renderChat,
  mt5:         renderMt5,
  strategies:  renderStrategies,
  orderguard:  renderOrderguard,
  timers:      renderTimers,
  skills:      renderSkills,
  tutorials:   renderTutorials,
  news:        renderNews,
  token:       renderToken,
  settings:    renderSettings,
};

const mounted = new Set();
// Per-tab refresh callbacks. Mounters MAY return a fn that refetches /
// re-renders when the tab is re-activated (e.g. leaderboard, market — pages
// that show server-side data the user might have just changed elsewhere).
// If a mounter returns nothing, that tab simply caches its first render.
const refreshers = {};
let _currentTab = null;
function showTab(name) {
  _currentTab = name;
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  if (!mounted.has(name) && mounters[name]) {
    const maybeRefresh = mounters[name](panes[name]);
    if (typeof maybeRefresh === 'function') refreshers[name] = maybeRefresh;
    mounted.add(name);
  } else if (refreshers[name]) {
    // Tab already mounted — call its refresh hook so server-backed views
    // (leaderboard, market, news) pick up changes made on other tabs.
    try { refreshers[name](); } catch (e) { console.warn('[showTab] refresher', name, 'threw', e); }
  }
  // 0.3.15: 切到资讯 tab 自动清「重要未读」红点
  if (name === 'news' && window.easydeal?.news?.markRead) {
    window.easydeal.news.markRead().catch(() => {});
    _setTabBadge('news', 0);
  }
  // 0.3.16: 切到 chat tab 清 AI 未读红点（本地 counter，不走 IPC）
  if (name === 'chat') {
    _chatUnread = 0;
    _setTabBadge('chat', 0);
  }
  // 0.3.16: 切到「我的策略」tab — 不主动 markRead（per-row badge 由
  // 列表自己管，用户点开某行回测面板时会调 markEaRead）；下一轮 poll
  // 会读到真实剩余 count 自动更新 tab 红点。
}

tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ====== 通用 tab badge helper（0.3.15 起；0.3.16 提成 3 个 tab 共用） ======
const _tabBtnCache = {};
function _getTabBtn(name) {
  if (_tabBtnCache[name] === undefined) {
    _tabBtnCache[name] = document.querySelector(`[data-tab="${name}"]`) || null;
  }
  return _tabBtnCache[name];
}
function _setTabBadge(name, count) {
  const btn = _getTabBtn(name);
  if (!btn) return;
  let badge = btn.querySelector('.tab-unread-badge');
  if (!count || count <= 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'tab-unread-badge';
    badge.style.cssText = [
      'position:absolute',
      'top:-2px', 'right:-4px',
      'min-width:16px', 'height:16px',
      'padding:0 4px',
      'border-radius:8px',
      'background:#ef4444',
      'color:#fff',
      'font-size:10px',
      'font-weight:600',
      'line-height:16px',
      'text-align:center',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.4)',
      'pointer-events:none',
    ].join(';');
    if (getComputedStyle(btn).position === 'static') {
      btn.style.position = 'relative';
    }
    btn.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : String(count);
}

// ====== 资讯 tab 红点 ======
// 0.3.20: 用户反馈停留在资讯 tab 时滚动浏览也不会消红点 — 之前只在
// showTab('news') 那一刻 markRead，后续 push 来的新 unread 会再点亮。
// 修：处理来自主进程的 unread-count push 时，如果用户当前就在 news tab
// 上，直接 markRead 视为已看到（main 会再推一个 0 回来形成自洽）。
function _applyNewsBadge(count) {
  if (count > 0 && _currentTab === 'news' && window.easydeal?.news?.markRead) {
    window.easydeal.news.markRead().catch(() => {});
    _setTabBadge('news', 0);
    return;
  }
  _setTabBadge('news', count);
}
if (window.easydeal?.news?.unreadCount) {
  window.easydeal.news.unreadCount()
    .then((r) => _applyNewsBadge(r?.count || 0))
    .catch(() => {});
}
if (window.easydeal?.news?.onUnreadCount) {
  window.easydeal.news.onUnreadCount((payload) => {
    _applyNewsBadge(payload?.count || 0);
  });
}

// ====== 0.3.16: AI tab 未读红点 ======
// 监听 chat:append；AI 发来的 assistant turn（含 background 系统通知）+
// 当前 tab 不是 chat → 本地 counter +1，showTab('chat') 时清零。
let _chatUnread = 0;
if (window.easydeal?.chat?.on) {
  window.easydeal.chat.on('append', (turn) => {
    if (!turn || _currentTab === 'chat') return;
    // 用户自己发的 turn 不算未读
    if (turn.role !== 'assistant') return;
    _chatUnread += 1;
    _setTabBadge('chat', _chatUnread);
  });
}

// ====== 0.3.16: 我的策略 tab 未读回测结果红点 ======
// 调 strategies.unreadBacktests() 拿 {ea:count}，sum 后画 badge。
// 10s poll 一次保持新鲜（轻量 — 读 backtests.json，文件级 read 而已）。
async function _refreshStrategiesUnread() {
  try {
    const r = await window.easydeal.strategies.unreadBacktests();
    let total = 0;
    if (r && typeof r === 'object') {
      for (const v of Object.values(r)) total += Number(v) || 0;
    }
    _setTabBadge('strategies', total);
  } catch {}
}
_refreshStrategiesUnread();
setInterval(_refreshStrategiesUnread, 10_000);


// Expose so other views can navigate (e.g. "send install guide" → switch to chat).
window.showTab = showTab;
// 0.4.4: 让 im-view 能调通用 tab badge helper
window._setTabBadge = _setTabBadge;

// Bootstrap app metadata so views (especially market-view's QR image URL
// builder) can resolve server-relative paths against the right base.
window.easydeal.app.info().then((info) => {
  window._apiBase = info?.apiBase || 'http://127.0.0.1:8088';
  window._appInfo = info || {};
  // Topbar 版本号从 app.getVersion() 拉过来 — 之前 index.html 里硬编
  // 「v0.1.0」字符串，每次 bump 都得手动改 + 容易忘。现在直接绑 package.json。
  const verEl = document.getElementById('brand-version');
  if (verEl && info?.version) verEl.textContent = `v${info.version} · 社区版`;
}).catch(() => { window._apiBase = 'http://127.0.0.1:8088'; });

// Account info now lives in the 设置 tab's 授权信息 card.

// Global MT5 mount-status pulse — visible from any tab. Polls every 5s.
// Three colour states:
//   - green (`live`)  : everything healthy
//   - amber (`warn`)  : at least one mounted EA needs attention
//                      (stale binary in memory OR runtime.json protocol missing)
//   - grey (default)  : nothing mounted
// Clicking jumps to 我的策略 tab so the user can act on the warning.
const mountPulse     = document.getElementById('mount-pulse');
const mountPulseText = document.getElementById('mount-pulse-text');

function eaStem(it) { return it.name.replace(/\.(mq5|ex5)$/i, ''); }

// 0.3.19: 缓存上一次 mount-pulse 渲染的状态。每 5s 轮询时如果计算出来
// 跟上次一模一样就跳过 DOM 写操作，省掉 className 重写 / textContent 重设
// 导致的可见闪烁。AI 跑 compile/backtest 期间 mtime 会变，is_stale 偶尔
// 翻转 — 配合 CSS transition 0.4s 也能让真的状态变化时是平滑过渡而不是
// 瞬切。
let _lastMountPulseState = null;
async function refreshMountPulse() {
  if (!mountPulse) return;
  try {
    const list = await window.easydeal.strategies.list();
    const mounted = (list || []).filter((x) => x.is_mounted);

    // Per-EA issue flags (used for warn-state determination + tooltip)。
    // 0.3.49+ 去掉了「需补统计代码」flag —— MCP 实时算 magic 三级 fallback
    // 后 .ex5-only / 无 magic / 无 runtime.json 的 EA 都能自动归属，不再
    // 推用户改源码。
    const flagsFor = (m) => {
      const f = [];
      if (m.is_stale) f.push('需重新挂载');
      return f;
    };

    // Compute desired state.
    let kind, label, title;
    if (!mounted.length) {
      kind = 'down';
      label = '无';
      title = 'MT5 上没有检测到挂载中的 EA';
    } else {
      const names = mounted.map(eaStem);
      label = names.length <= 2 ? names.join(' · ') : `${names[0]} +${names.length - 1}`;
      const withIssues = mounted.filter((m) => flagsFor(m).length);
      if (withIssues.length) {
        kind = 'warn';
        const lines = ['挂载中：'];
        for (const m of mounted) {
          const fs = flagsFor(m);
          lines.push('  ' + eaStem(m) + (fs.length ? '  ⚠ ' + fs.join(' / ') : ''));
        }
        lines.push('');
        lines.push('点这里跳到「我的策略」处理');
        title = lines.join('\n');
      } else {
        kind = 'live';
        title = '挂载中：\n  ' + names.join('\n  ');
      }
    }

    const key = `${kind}|${label}|${title}`;
    if (_lastMountPulseState === key) return;  // 没变 → 不写 DOM 不触发动画
    _lastMountPulseState = key;

    mountPulse.style.display = 'inline-flex';
    mountPulse.classList.remove('live', 'warn', 'down');
    mountPulse.classList.add(kind);
    mountPulseText.textContent = label;
    mountPulse.title = title;
  } catch {}
}

if (mountPulse) {
  // 0.3.50: warn 状态（is_stale → 需重挂）下点击直接跳「我的策略」tab + 让
  // 那一行自动滚到可视区 + 触发对应 EA 的「挂载」对话框。之前只跳 tab，
  // 用户还得在长列表里找到那行、看清黄牌、点黄牌 — 黄牌位置可能在屏幕外。
  // 用户撞过：AI 在 wechat 改完 EA 编译完，桌面 pill 变黄但用户实际不知道
  // 该再点哪。
  mountPulse.addEventListener('click', async () => {
    if (typeof window.showTab !== 'function') return;
    window.showTab('strategies');
    // 不是 warn 就只跳 tab —— 没要重挂的 EA 直接打开对话框反而打扰
    if (!mountPulse.classList.contains('warn')) return;
    try {
      const list = await window.easydeal.strategies.list();
      const stale = (list || []).filter((it) => it.is_mounted && it.is_stale);
      if (!stale.length) return;
      // 一条 stale 就直接弹挂载对话框；多条就只滚到第一条让用户看清楚 —
      // 同时弹多个对话框反而乱。
      const target = stale[0];
      // 等一帧让 tab 切换完成再触发
      setTimeout(() => {
        try {
          // 复用「我的策略」行内黄牌的同一段 data-action="deploy" 逻辑：
          // 找到对应 row 模拟点击 deploy 按钮
          const row = document.querySelector(
            `tr[data-name="${cssEscape(target.name)}"]`,
          );
          if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const deployBtn = row.querySelector('[data-action="deploy"]');
            if (deployBtn) deployBtn.click();
          }
        } catch {}
      }, 250);
    } catch {}
  });
  mountPulse.style.cursor = 'pointer';
}
function cssEscape(s) {
  // CSS.escape 在 Electron renderer 应该有；fallback 用基础转义
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}
// 0.3.200: 顶栏 EA 挂载 pulse 下线 — 用户反馈「未来可能很多策略在并行」, 顶栏单一指示
// 没意义且会跟 MT5 tab 卡片的关联文案冲突. 各 EA 状态去「策略」tab 或「MT5」tab 看.
// refreshMountPulse 函数 + 5s 轮询不再起用 (函数定义保留, 防其它地方还引用; 但 #mount-pulse
// 元素已经在 index.html 加 hidden 不显示).

// ----- WeChat status chip -----
const wxPulse     = document.getElementById('wx-pulse');
const wxPulseText = document.getElementById('wx-pulse-text');
function paintWxPulse(s) {
  if (!wxPulse || !s) return;
  wxPulse.style.display = 'inline-flex';
  // Always shows "微信" — the COLOR carries the status:
  //   green (live) = logged in, ready to send
  //   yellow (warn) = sidecar reachable but error (e.g. token expired)
  //   red (down)   = not logged in OR sidecar not started (lazy mode)
  wxPulseText.textContent = '微信';
  if (s.logged_in) {
    wxPulse.classList.add('live');
    wxPulse.classList.remove('warn', 'down');
    wxPulse.title = '微信通道在线' + (s.user_id ? '\n  user_id: ' + s.user_id : '') + '\n点击：去设置页';
  } else if (s.error) {
    wxPulse.classList.add('warn');
    wxPulse.classList.remove('live', 'down');
    wxPulse.title = '微信异常：' + s.error + '\n点击：去设置页';
  } else if (s.lazy) {
    // Sidecar never started — this is the default state on a fresh boot.
    // Not an error; just nobody asked for wechat yet.
    wxPulse.classList.add('down');
    wxPulse.classList.remove('live', 'warn');
    wxPulse.title = '微信子进程未启动（懒加载）\n点击：去设置页扫码登录';
  } else {
    wxPulse.classList.add('down');
    wxPulse.classList.remove('live', 'warn');
    wxPulse.title = '微信未登录\n点击：去设置页扫码';
  }
}
async function refreshWxPulse() {
  try { paintWxPulse(await window.easydeal.wechat.status()); } catch {}
}
if (wxPulse) {
  wxPulse.style.cursor = 'pointer';
  // 0.3.54: 点击 → 切到 AI tab + 打开微信聊天记录抽屉。
  // 之前点击是去设置页，但用户日常更想看「最近的微信聊天记录」而不是改配置；
  // 改成切 AI + 弹抽屉，配置改去用「设置」tab 主入口。
  // openWechatHistoryDrawer 在 chat-view 渲染时挂到 window 上。
  wxPulse.addEventListener('click', () => {
    if (typeof window.showTab === 'function') window.showTab('chat');
    // 等 chat-view mount 完成（首次访问时 mounter 是同步的，但抽屉的全局 hook
    // 在 renderChat 末尾才挂）。下一个 microtask 调即可。
    setTimeout(() => {
      if (typeof window.openWechatHistoryDrawer === 'function') {
        window.openWechatHistoryDrawer();
      }
    }, 50);
  });
  refreshWxPulse();
  setInterval(refreshWxPulse, 10_000);
  // Push updates from sidecar arrive on this channel
  window.easydeal.wechat.onStatus(paintWxPulse);
}

// ----- 1.4.x: App(手机)连接状态 chip -----
// 显示当前有几个手机号绑了本机 license; 点开列表可逐个断开授权; 没人连着时给下载地址。
const appPulse     = document.getElementById('app-pulse');
const appPulseText = document.getElementById('app-pulse-text');
let _appAccountsCache = [];
function paintAppPulse(items) {
  if (!appPulse) return;
  const n = Array.isArray(items) ? items.length : 0;
  appPulseText.textContent = `App ${n}`;
  appPulse.classList.remove('live', 'warn', 'down');
  if (n > 0) {
    appPulse.classList.add('live');
    appPulse.title = `已有 ${n} 个手机号连接本机 · 点击查看/断开`;
  } else {
    appPulse.classList.add('down');
    appPulse.title = '暂无手机 App 连接 · 点击获取下载地址';
  }
}
async function refreshAppPulse() {
  try {
    const r = await window.easydeal.appAccounts.list();
    _appAccountsCache = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
  } catch { _appAccountsCache = []; }
  paintAppPulse(_appAccountsCache);
}
function openAppAccountsPanel() {
  const items = _appAccountsCache;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.className = 'card';
  box.style.cssText = 'width:400px;max-width:92vw;padding:18px;max-height:80vh;overflow:auto;';
  const close = () => { try { document.body.removeChild(ov); } catch {} };
  const DOWNLOAD_URL = 'https://easydeal.fay-agent.com/app/download';
  if (!items.length) {
    box.innerHTML = `<h3 style="margin:0 0 10px;">📱 App 连接状态</h3>
      <p style="font-size:13px;color:var(--text-2,#9aa);margin:0 0 14px;">暂无手机 App 绑定本机序列号。可以把下载地址发到手机上安装。</p>
      <div style="display:flex;gap:8px;">
        <button class="btn ghost small" data-x="copy" style="flex:1;">复制下载地址</button>
        <button class="btn primary small" data-x="open" style="flex:1;">打开下载页</button>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button class="btn ghost small" data-x="c">关闭</button></div>`;
  } else {
    const rows = items.map((it) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-soft,#2a2a2a);">
        <div>
          <div style="font-weight:600;">${it.phone}${it.is_active ? ' <span style="color:var(--success,#5fc992);font-size:11px;">● 生效中</span>' : ''}</div>
          <div style="font-size:11px;color:var(--text-3,#778);">绑定于 ${it.bound_at ? String(it.bound_at).slice(0, 16).replace('T', ' ') : '?'}</div>
        </div>
        <button class="btn danger small" data-x="revoke" data-id="${it.account_id}">断开</button>
      </div>`).join('');
    box.innerHTML = `<h3 style="margin:0 0 10px;">📱 App 连接状态(${items.length})</h3>${rows}
      <div style="display:flex;justify-content:flex-end;margin-top:14px;"><button class="btn ghost small" data-x="c">关闭</button></div>`;
  }
  ov.appendChild(box);
  document.body.appendChild(ov);
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-x]');
    if (!btn) return;
    const act = btn.dataset.x;
    if (act === 'c') { close(); return; }
    if (act === 'open') {
      try { await window.easydeal.app.openExternal(DOWNLOAD_URL); } catch {}
      return;
    }
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(DOWNLOAD_URL);
        if (typeof window.showToast === 'function') window.showToast('已复制下载地址', 'ok');
      } catch {
        if (typeof window.showToast === 'function') window.showToast(DOWNLOAD_URL, 'ok');
      }
      return;
    }
    if (act === 'revoke') {
      const id = btn.dataset.id;
      if (!confirm('确定断开这个手机号对本机序列号的授权吗？断开后该手机需重新扫码/申请绑定。')) return;
      btn.disabled = true;
      btn.textContent = '断开中…';
      try {
        const r = await window.easydeal.appAccounts.unbind(Number(id));
        if (r && r.ok) {
          if (typeof window.showToast === 'function') window.showToast('已断开', 'ok');
          await refreshAppPulse();
          close();
          openAppAccountsPanel();
        } else {
          if (typeof window.showToast === 'function') window.showToast('断开失败：' + ((r && r.error) || '未知'), 'err');
          btn.disabled = false;
          btn.textContent = '断开';
        }
      } catch (e2) {
        if (typeof window.showToast === 'function') window.showToast('断开失败：' + (e2?.message || e2), 'err');
        btn.disabled = false;
        btn.textContent = '断开';
      }
    }
  });
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
}
if (appPulse) {
  appPulse.style.cursor = 'pointer';
  appPulse.addEventListener('click', openAppAccountsPanel);
  refreshAppPulse();
  setInterval(refreshAppPulse, 30_000);
}

// 0.3.252+: 微信探活机制 (sidecar 每 15min ping filehelper) 连续 3 次失败 →
// main 重 spawn sidecar 同时推 health-died event. UI 显红 banner 提示用户
// 「微信断了, 已自动重启, 仍失败请重扫码」. banner 用 fixed 顶部 +
// 任何 tab 都能看到. 重启成功 (下次 status logged_in=true) 自动消失.
let _wechatDeadBannerEl = null;
let _wechatDeadCount = 0;
function _showWechatDeadBanner(payload) {
  _wechatDeadCount += 1;
  if (!_wechatDeadBannerEl) {
    _wechatDeadBannerEl = document.createElement('div');
    _wechatDeadBannerEl.id = 'wechat-dead-banner';
    _wechatDeadBannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;'
      + 'background:linear-gradient(90deg,#7c1d1d,#a02525);color:#fff;font-size:13px;'
      + 'padding:10px 18px;display:flex;align-items:center;gap:12px;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,0.3);cursor:pointer;'
      + 'border-bottom:1px solid rgba(255,255,255,0.15);';
    _wechatDeadBannerEl.addEventListener('click', () => {
      // 跳到设置页微信卡引导用户重扫码
      if (typeof window.showTab === 'function') window.showTab('settings');
      setTimeout(() => {
        const el = document.querySelector('[data-section="wechat"]')
          || document.querySelector('.wechat-card');
        try { el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
      }, 200);
    });
    document.body.appendChild(_wechatDeadBannerEl);
  }
  _wechatDeadBannerEl.innerHTML = `
    <span style="font-size:18px;">⚠</span>
    <span style="flex:1;">
      <strong>微信通道断了</strong> · 已自动重启 ${_wechatDeadCount} 次 ·
      <span style="opacity:0.85;">点这里去设置页重新扫码 (常发生在网络波动 / iLink 服务端 push 通道挂死时)</span>
    </span>
    <button id="wechat-dead-banner-close" class="btn ghost small"
            style="background:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.25);color:#fff;pointer-events:auto;">×</button>
  `;
  _wechatDeadBannerEl.style.display = 'flex';
  // 0.3.272: 同 dormant chip 同款修 — index.html CSP 不带 'unsafe-inline'
  // → inline onclick="..." silently blocked. 改 addEventListener + capture phase
  // 截在 parent div 的 click handler 之前.
  const closeBtn = document.getElementById('wechat-dead-banner-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      _wechatDeadBannerEl.style.display = 'none';
    }, true);
  }
}
function _hideWechatDeadBanner() {
  if (_wechatDeadBannerEl) _wechatDeadBannerEl.style.display = 'none';
  _wechatDeadCount = 0;
}
// 监听 sidecar 重启事件
if (window.easydeal?.wechat?.onHealthDied) {
  window.easydeal.wechat.onHealthDied((payload) => {
    console.warn('[wechat] health-died:', payload);
    _showWechatDeadBanner(payload);
  });
}
// status 变 logged_in=true 时自动隐藏 banner — 说明 sidecar 重启已恢复
window.easydeal?.wechat?.onStatus?.((s) => {
  if (s && s.logged_in) _hideWechatDeadBanner();
});

// ----- 0.3.262: 微信通道 dormant chip + pending queue 显示 -----
// iLink ClawBot 的 cold-session 限制: bot 不能主动给冷 user 推消息 (ret=-2).
// 必须 user 先 ping bot 激活 session, 之后几小时内才能推. EasyDeal 重启后
// bot id 会换新, session 重置 → 所有主动推 (护航告警 / scheduler 通知) 都
// 入 pending queue 等 user 激活. 这个 chip 提示用户去 ping bot.
let _wxDormantChipEl = null;
function _ensureWxDormantChipEl() {
  if (_wxDormantChipEl) return _wxDormantChipEl;
  _wxDormantChipEl = document.createElement('div');
  _wxDormantChipEl.id = 'wechat-dormant-chip';
  _wxDormantChipEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99997;'
    + 'background:linear-gradient(90deg,#7a5b1a,#a07a25);color:#fff;font-size:13px;'
    + 'padding:10px 18px;display:none;align-items:center;gap:12px;'
    + 'box-shadow:0 4px 12px rgba(0,0,0,0.25);cursor:pointer;'
    + 'border-bottom:1px solid rgba(255,255,255,0.15);';
  _wxDormantChipEl.addEventListener('click', () => {
    if (typeof window.showTab === 'function') window.showTab('settings');
    setTimeout(() => {
      const el = document.querySelector('[data-section="wechat"]')
        || document.querySelector('.wechat-card');
      try { el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
    }, 200);
  });
  document.body.appendChild(_wxDormantChipEl);
  return _wxDormantChipEl;
}
function _renderWxDormantChip(info) {
  const el = _ensureWxDormantChipEl();
  const count = info?.pending_count || 0;
  const lastIn = info?.last_inbound_at || 0;
  const loggedIn = !!info?.logged_in;
  // 显示条件: 登录 + (pending > 0 OR 12h+ 没 user inbound)
  // pending > 0 永远显示; 单纯 dormant 12h+ 也显示提示 (避免护航触发时才发现已经丢)
  const dormantHours = lastIn > 0 ? (Date.now() - lastIn) / 3600000 : Infinity;
  if (!loggedIn) { el.style.display = 'none'; return; }
  if (count === 0 && dormantHours < 12) { el.style.display = 'none'; return; }
  let body;
  if (count > 0) {
    body = `<strong>微信通道未激活</strong> · 有 ${count} 条 EasyDeal 通知没送达 ·
      <span style="opacity:0.85;">去微信「微信 ClawBot」发任意消息 (如「在」) 激活通道, EasyDeal 会一次性补发</span>`;
  } else {
    const h = isFinite(dormantHours) ? Math.round(dormantHours) : '?';
    body = `<strong>微信通道 dormant</strong> · ${h}h 没收到您消息, iLink 可能已关 push session ·
      <span style="opacity:0.85;">护航告警这时推不出去, 去微信发条「在」激活</span>`;
  }
  el.innerHTML = `
    <span style="font-size:18px;">📬</span>
    <span style="flex:1;">${body}</span>
    <button id="wechat-dormant-chip-close" class="btn ghost small"
            style="background:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.25);color:#fff;pointer-events:auto;">×</button>
  `;
  el.style.display = 'flex';
  // 0.3.272: 改用 addEventListener 而不是 inline onclick.
  // 用户 0.3.270 测过加 inline onclick 仍然「点不掉」, 0.3.271 又测一次依然
  // 不行. 根因猜: (a) Electron renderer 默认 CSP 'unsafe-inline' 可能被压制
  // (b) parent div 有 cursor:pointer + click listener 抢 hit-test 区域 (即使
  // event.stopPropagation 也救不了 dispatch 之前的 hit). addEventListener +
  // 加 pointer-events:auto 强提优先级.
  const closeBtn = document.getElementById('wechat-dormant-chip-close');
  if (closeBtn) {
    // capture phase 截 — 在 bubble 到 parent div 的 click handler 之前先处理
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      el.style.display = 'none';
    }, true);  // useCapture=true
  }
}
async function _refreshWxDormantChip() {
  try {
    const info = await window.easydeal?.wechat?.pendingInfo?.();
    if (info) _renderWxDormantChip(info);
  } catch {}
}
// 实时事件 + 5min 轮询保险
window.easydeal?.wechat?.onPendingChanged?.((payload) => {
  _refreshWxDormantChip();
});
window.easydeal?.wechat?.onStatus?.(() => _refreshWxDormantChip());
setInterval(_refreshWxDormantChip, 5 * 60 * 1000);
// boot 时 8s 后查一次 (等 sidecar init 完)
setTimeout(_refreshWxDormantChip, 8000);

// 0.3.166: 写交易权限指示 chip 从顶栏移至 Skills → MCP 工具 section，
// 减少顶栏噪音。refreshTradeWritePulse / 8s 轮询 / settings.onChanged hook 都删。
// 现在由 skills-view.js renderInventory() tradingChip 负责实时显示。

// 0.3.238: 拦截模式 AI 改造完后 enableEa 失败 → main.js 通过此事件通知 UI 弹 alert.
// 之前失败被 console.error 默默吞掉, 用户看到 AI 说「已护航」实质 OG 没 enable.
if (window.easydeal?.orderguard?.onAutoEnableFailed) {
  window.easydeal.orderguard.onAutoEnableFailed((payload) => {
    const ea = payload?.ea_name || '?';
    const stage = payload?.stage || '?';
    const err = payload?.error || '?';
    let detail = '';
    if (payload?.og_response) {
      detail = '\n\n服务端返回：\n' + JSON.stringify(payload.og_response, null, 2).slice(0, 500);
    } else if (payload?.stack) {
      detail = '\n\n异常堆栈：\n' + String(payload.stack).slice(0, 400);
    }
    const msg = `⚠ EA 「${ea}」拦截护航 自动启用失败！\n\n` +
                `AI 已完成代码改造 + 编译，但向 OrderGuard 注册 enable 时出错。\n` +
                `**EA 实质未启用拦截**，下单不会经过 OrderGuard 风控。\n\n` +
                `失败阶段：${stage}\n失败原因：${err}` + detail +
                `\n\n建议：去「我的策略 → 🛡 护航」对话框重新点启用，或截此弹窗反馈给开发。`;
    try { alert(msg); } catch {}
  });
}

// Mount the default tab now (chat) and pre-mount the rest lazily on first click.
showTab('chat');

// 0.3.55: 首屏挂载完了 → fade out splash。chat-view 首次 render 同步完成，requestAnimationFrame
// 一帧后保证 DOM 已绘制再淡出，避免「splash 还在但 chat 已经画好」的闪烁。
requestAnimationFrame(() => {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 400);
});

// Kick off the auto-update check loop. silentCheck()'s first run is delayed
// 5s so it doesn't pile onto first-paint network fan-out (license / news /
// stats / tab refresh). Subsequent re-checks fire every 30 min.

// --- Toast helper exposed globally for view modules ---
const toastEl = document.getElementById('toast');
let toastTimer = null;
window.showToast = (msg, kind = 'ok') => {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
};

// 0.3.55: 全停按钮 wiring。点击 → confirm → app:panic-stop-all IPC → toast 汇报。
// 0.3.102: 按钮挪到 AI tab 的 chat-head-actions 里，不再固定在 topbar。
// 用事件委托（body.click）接，这样按钮无论何时被 mount 都能 work，避免
// renderer.js 启动时 chat-view 还没渲染拿不到 dom 引用的时序 bug。
document.body.addEventListener('click', async (ev) => {
  const panicBtn = ev.target.closest('#panic-stop-btn');
  if (!panicBtn) return;
  if (panicBtn.disabled) return;   // 防止「停止中…」二次点击
  const ok = window.confirm(
    '🛑 紧急停止？\n\n' +
    '会做这些事：\n' +
    '  1. 杀掉正在跑的 AI 对话（如果有）\n' +
    '  2. 取消所有 running/queued 回测\n' +
    '  3. 删掉回测的自动轮询任务（用户自己建的定时任务保留）\n' +
    '  4. 把当前被中断的 AI 消息标记为已放弃（不会再自动续上）\n\n' +
    '执行后系统继续正常运行 — 没有冷却时间，也不需要点恢复按钮。\n\n' +
    '点确定继续；点取消放弃。'
  );
  if (!ok) return;
  panicBtn.disabled = true;
  panicBtn.textContent = '🛑 停止中…';
  let r;
  try {
    r = await window.easydeal.app.panicStopAll();
  } catch (e) {
    window.showToast(`全停 IPC 调用失败：${e?.message || e}`, 'err');
    panicBtn.disabled = false;
    panicBtn.textContent = '🛑 全停';
    return;
  }
  const parts = [];
  if (r.chat_stopped) parts.push('停了 AI 对话');
  if (r.backtests_cancelled) parts.push(`取消 ${r.backtests_cancelled} 个回测`);
  if (r.crons_deleted) parts.push(`删 ${r.crons_deleted} 个自动轮询任务`);
  if (r.procs_killed) parts.push(`杀 ${r.procs_killed} 个进程`);
  if (r.chat_dismissed?.dismissed_turn_uuid) parts.push('放弃了 1 条中断 AI 消息');
  if (!parts.length) parts.push('没有需要停的任务');
  window.showToast('🛑 ' + parts.join('，') + '。',
                   r.errors?.length ? 'warn' : 'ok');
  panicBtn.disabled = false;
  panicBtn.textContent = '🛑 全停';
});
