// News view — 金融快讯（金十数据，实时） + 社区公告（Fay 服务端）。
//
// 上面那块「金融快讯」是 0.3.14 加的：EasyDeal 主进程后台 30s 拉一次
// jin10.com 最新一批，命中高优先级关键词（FOMC / CPI / 鲍威尔 等）会
// 主动推系统消息到 AI 对话框。这里只是展示用，AI 那边也能通过 MCP 工具
// `list_recent_news` 拉这份缓存。
//
// 下面那块「社区公告」是原 0.3.x 之前就有的：服务端 /v1/news 拉版本
// 更新 / 活动 / 提醒。

const KIND_META = {
  news:    { label: '公告', cls: 'nk-news' },
  update:  { label: '更新', cls: 'nk-update' },
  event:   { label: '活动', cls: 'nk-event' },
  warning: { label: '提醒', cls: 'nk-warn' },
};

let _flashRefreshTimer = null;
let _flashUnsubscribe = null;
// 金融快讯 AI 分析结果缓存(key→分析文本), 防 15s 自动刷新把已分析内容刷没
const _flashAnCache = {};
const _flashKey = (it) => String((it && (it.id || it.ts || it.title)) || '');
// 分析请求进行中 — 暂停那次自动刷新重建列表, 否则在途的卡片被拆, 结果写到已弃节点 → 不显示
let _flashAnalyzing = false;

// 经济日历: 从交易品种解析相关货币码(XAUUSDm→USD; EURUSD→EUR+USD)
const _CAL_CCY = ['USD','EUR','JPY','GBP','AUD','NZD','CAD','CHF','CNY','HKD','SGD','SEK','NOK','MXN','ZAR','KRW','INR','BRL','TRY','PLN'];
function _symbolCurrencies(sym) {
  const s = String(sym || '').toUpperCase();
  const out = new Set();
  for (const c of _CAL_CCY) if (s.includes(c)) out.add(c);
  if (/XAU|XAG|GOLD|SILVER/.test(s)) out.add('USD');
  return out;
}
function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderNews(root) {
  root.innerHTML = '';

  // 卸载老的订阅，避免切 tab 来回 leak
  if (_flashRefreshTimer) { clearInterval(_flashRefreshTimer); _flashRefreshTimer = null; }
  if (_flashUnsubscribe) { try { _flashUnsubscribe(); } catch {} _flashUnsubscribe = null; }

  const hero = el('section', 'hero-tight');
  hero.innerHTML = `
    <h1>资讯</h1>
  `;
  root.appendChild(hero);

  // ---------- tab 切换: 资讯 / 经济日历 / 关注 ----------
  const tabBar = el('div');
  tabBar.style.cssText = 'display:flex;gap:6px;margin:2px 0 18px;border-bottom:1px solid var(--border-soft,#2a2a2a);';
  const panelNews = el('div');    // 金融快讯 + 公告
  const panelCal = el('div');     // 经济日历
  const panelSentiment = el('div'); // 散户情绪
  const panelWatch = el('div');   // 我的关注
  root.appendChild(tabBar);
  root.appendChild(panelNews);
  root.appendChild(panelCal);
  root.appendChild(panelSentiment);
  root.appendChild(panelWatch);
  const _tabs = [
    { key: 'news', label: '资讯', panel: panelNews },
    { key: 'cal', label: '经济日历', panel: panelCal },
    { key: 'sentiment', label: '散户情绪', panel: panelSentiment },
  ];
  let _activeTab = 'news';
  function _syncTabs() {
    tabBar.innerHTML = '';
    for (const t of _tabs) {
      t.panel.style.display = (_activeTab === t.key) ? 'block' : 'none';
      const b = el('button');
      const active = _activeTab === t.key;
      b.textContent = t.label;
      b.style.cssText = `border:none;background:none;color:${active ? 'var(--accent)' : 'var(--text-2)'};font-size:15px;font-weight:${active ? '700' : '500'};padding:8px 16px;cursor:pointer;border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};margin-bottom:-1px;`;
      b.addEventListener('click', () => { _activeTab = t.key; _syncTabs(); });
      tabBar.appendChild(b);
    }
  }
  _syncTabs();

  // ---------- 散户情绪 section (myfxbook 社区多空占比 → 服务端 /v1/sentiment, 每 30min) ----------
  panelSentiment.innerHTML = `
    <section style="margin-bottom:24px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 10px;">
        <h2 style="margin:0;font-size:16px;">📊 散户情绪</h2>
        <span id="senti-status" style="font-size:11.5px;color:var(--text-3);">加载中…</span>
      </div>
      <input id="senti-search" placeholder="搜索币种，如 XAU / EURUSD / BTC" autocomplete="off"
        style="width:100%;box-sizing:border-box;padding:8px 12px;margin-bottom:12px;background:var(--bg-2,#1a1a1a);border:1px solid var(--border-soft,#2a2a2a);border-radius:8px;color:var(--text);font-size:13px;">
      <div id="senti-list"></div>
    </section>
  `;
  const sentiSearch = panelSentiment.querySelector('#senti-search');
  const sentiList = panelSentiment.querySelector('#senti-list');
  const sentiStatus = panelSentiment.querySelector('#senti-status');
  let _sentiData = null;
  // 置顶币种(本地持久化, 排列表最前)
  const SENTI_PIN_KEY = 'easydeal_senti_pinned';
  let _sentiPinned = [];
  try { _sentiPinned = JSON.parse(localStorage.getItem(SENTI_PIN_KEY) || '[]') || []; } catch (_) { _sentiPinned = []; }
  function savePins() { try { localStorage.setItem(SENTI_PIN_KEY, JSON.stringify(_sentiPinned)); } catch (_) {} }
  function togglePin(name) {
    const u = String(name || '').toUpperCase();
    if (!u) return;
    _sentiPinned = _sentiPinned.includes(u) ? _sentiPinned.filter((x) => x !== u) : [u, ..._sentiPinned].slice(0, 50);
    savePins();
    renderSenti();
  }
  function renderSenti() {
    const all = (_sentiData && _sentiData.symbols) || [];
    const kw = (sentiSearch.value || '').trim().toUpperCase();
    const filtered = kw ? all.filter((s) => String(s.name || '').toUpperCase().includes(kw)) : all;
    if (!filtered.length) {
      sentiList.innerHTML = `<div style="color:var(--text-3);padding:14px;text-align:center;">${all.length ? '没有匹配的币种' : '情绪数据加载中（服务端每 30 分钟抓一次）'}</div>`;
      return;
    }
    // 置顶的排最前(按置顶顺序), 其余保持原序
    const pset = new Set(_sentiPinned);
    const top = filtered.filter((s) => pset.has(String(s.name || '').toUpperCase()))
      .sort((a, b) => _sentiPinned.indexOf(String(a.name || '').toUpperCase()) - _sentiPinned.indexOf(String(b.name || '').toUpperCase()));
    const rest = filtered.filter((s) => !pset.has(String(s.name || '').toUpperCase()));
    const syms = top.concat(rest);
    sentiList.innerHTML = syms.map((s) => {
      const long = Math.max(0, Number(s.long || 0));
      const short = Math.max(0, Number(s.short || 0));
      const pinned = pset.has(String(s.name || '').toUpperCase());
      const pinBtn = `<button data-pin="${escape(s.name)}" title="${pinned ? '取消置顶' : '置顶到最前'}" style="cursor:pointer;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:6px;border:1px solid ${pinned ? 'var(--accent,#3b82f6)' : 'var(--border-soft,#333)'};background:${pinned ? 'var(--accent-soft,rgba(59,130,246,.15))' : 'transparent'};color:${pinned ? 'var(--accent,#3b82f6)' : 'var(--text-3)'};">${pinned ? '📌 已置顶' : '置顶'}</button>`;
      const lots = (s.longLots != null || s.shortLots != null)
        ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:3px;">多 ${s.longLots ?? '—'} 手 · 空 ${s.shortLots ?? '—'} 手${s.total != null ? ` · 持仓 ${s.total}` : ''}</div>` : '';
      return `<div style="padding:9px 0;border-bottom:1px solid var(--border-soft,#222);${pinned ? 'background:var(--accent-soft,rgba(59,130,246,.06));' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <span style="display:flex;align-items:center;gap:8px;min-width:0;"><span style="font-weight:700;font-size:14px;">${escape(s.name)}</span>${pinBtn}</span>
          <span style="font-size:12px;white-space:nowrap;"><span style="color:#2ec27e;font-weight:700;">多 ${long}%</span>　<span style="color:#e5534b;font-weight:700;">空 ${short}%</span></span>
        </div>
        <div style="display:flex;height:7px;border-radius:4px;overflow:hidden;margin-top:6px;background:var(--border-soft,#2a2a2a);">
          <div style="flex:${long};background:#2ec27e;"></div><div style="flex:${short};background:#e5534b;"></div>
        </div>${lots}
      </div>`;
    }).join('');
  }
  sentiList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pin]');
    if (btn) togglePin(btn.getAttribute('data-pin'));
  });
  async function refreshSenti() {
    try {
      const r = await window.easydeal.server.sentiment();
      _sentiData = r || {};
      const n = (r && r.symbols && r.symbols.length) || 0;
      sentiStatus.textContent = n
        ? `共 ${n} 个币种${r.updated_at ? ` · 更新于 ${String(r.updated_at).slice(0, 16).replace('T', ' ')}` : ''}`
        : ((r && r.note) || '暂无数据');
      renderSenti();
    } catch (e) {
      sentiStatus.textContent = '加载失败: ' + (e.message || e);
    }
  }
  sentiSearch.addEventListener('input', renderSenti);
  refreshSenti();

  // ---------- 金融快讯 section ----------
  // 0.3.22: 默认过滤掉英文原文条目 — 金十数据对每条全球新闻同时打中英双
  // 份（路透/WSJ/彭博 headline + 中文翻译），交易员要英文做关键词监控，
  // 普通用户看就是噪音。给个勾选框「显示英文原文」让真要的人开。
  const flashSection = el('section');
  flashSection.style.marginBottom = '24px';
  flashSection.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 10px;">
      <h2 style="margin:0;font-size:16px;">📡 金融快讯</h2>
      <div style="display:flex;align-items:center;gap:14px;font-size:11.5px;color:var(--text-3);">
        <span id="flash-status">加载中…</span>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="只显示 important=1 的高优先级快讯">
          <input id="flash-important-only" type="checkbox" style="vertical-align:middle;">
          <span>只看重要</span>
        </label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="金十会同时打中英两份相同新闻，英文给交易员关键词监控用；默认隐藏减少视觉噪音">
          <input id="flash-show-english" type="checkbox" style="vertical-align:middle;">
          <span>显示英文原文</span>
        </label>
      </div>
    </div>
    <div id="flash-list"></div>
  `;
  panelNews.appendChild(flashSection);

  const flashList = flashSection.querySelector('#flash-list');
  const flashStatus = flashSection.querySelector('#flash-status');
  const importantOnlyChk = flashSection.querySelector('#flash-important-only');
  const showEnglishChk = flashSection.querySelector('#flash-show-english');

  async function refreshFlash() {
    try {
      const r = await window.easydeal.news.flashRecent({
        minutesBack: 360,    // 6 小时
        importantOnly: importantOnlyChk.checked,
      });
      let items = r.items || [];
      // 0.3.22 客户端过滤：去掉以英文为主的条目（金十中英双推中的英文那
      // 一份）。important=1 的条目永远不过滤（哪怕是英文也是真重要新闻）
      if (!showEnglishChk.checked) {
        items = items.filter((it) => it.important || !_looksEnglish(it.title, it.content));
      }
      if (!_flashAnalyzing) renderFlashList(flashList, items);   // 分析在途时别拆列表
      const st = r.status || {};
      const totalShown = items.length;
      const totalRaw = (r.items || []).length;
      const hidden = totalRaw - totalShown;
      flashStatus.textContent = st.running
        ? `显示 ${totalShown} / 共 ${st.items_count || 0} 条${hidden > 0 ? `（隐藏 ${hidden} 条英文）` : ''} · 上次刷新 ${st.last_fetch_at ? fmtRelative(st.last_fetch_at) : '从未'}`
        : '后台未启动';
    } catch (e) {
      flashStatus.textContent = '加载失败: ' + (e.message || e);
    }
  }

  importantOnlyChk.addEventListener('change', refreshFlash);
  showEnglishChk.addEventListener('change', refreshFlash);
  refreshFlash();
  // 自动 polling — 主进程已经 30s 拉一次，UI 这边 15s 重渲染一次保持新鲜
  _flashRefreshTimer = setInterval(refreshFlash, 15_000);
  // 也订阅主进程的 push（更及时）
  if (window.easydeal.news?.onNewItems) {
    _flashUnsubscribe = window.easydeal.news.onNewItems(() => refreshFlash());
  }

  // ---------- 经济日历 section (MT5 内 EA 直传 → 服务端) ----------
  const calSection = el('section');
  calSection.style.marginBottom = '24px';
  calSection.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 10px;">
      <h2 style="margin:0;font-size:16px;">📅 经济日历 <span style="font-size:11px;font-weight:400;color:var(--text-3);">北京时间</span></h2>
      <span id="cal-status" style="font-size:11.5px;color:var(--text-3);">加载中…</span>
    </div>
    <div id="cal-filters" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;"></div>
    <div id="cal-list"></div>
  `;
  panelCal.appendChild(calSection);   // 「经济日历」tab
  const calList = calSection.querySelector('#cal-list');
  const calStatus = calSection.querySelector('#cal-status');
  const calFilters = calSection.querySelector('#cal-filters');
  let _calEvents = [];
  let _calPick = null;          // null=全部; 'MINE'=我的品种; 否则=货币码
  let _myCcy = new Set();

  // ---- AI 分析 + 我的关注(localStorage 本地持久化, 跟 app 对齐) ----
  const WATCH_KEY = 'ezd_cal_watch';
  const WATCH_CAP = 20;
  let _calSeq = 0;
  const _calById = {};          // 数字 id → 事件对象, 供分析按钮回查(不把标题塞进 DOM 属性)
  const _num = (v) => (v == null ? '—' : v);
  const _loadWatch = () => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]') || []; } catch { return []; } };
  const _saveWatch = (xs) => { try { localStorage.setItem(WATCH_KEY, JSON.stringify(xs)); } catch {} };
  const _calWatchKey = (e) => `cal-${e.ts || e.time || ''}-${e.title || ''}`;
  const _calSlim = (e) => ({ ts: e.ts, time: e.time, country: e.country, currency: e.currency, title: e.title, importance: e.importance, actual: e.actual, forecast: e.forecast, previous: e.previous });
  function _addWatch(e) {
    const key = _calWatchKey(e);
    let xs = _loadWatch();
    if (xs.some((w) => w.key === key)) return false;   // 已收藏 → 不重复, 返 false 让调用方别重建 DOM
    xs = [{ key, item: _calSlim(e), addedTs: Date.now() }, ...xs].slice(0, WATCH_CAP);
    _saveWatch(xs);
    return true;
  }
  function _removeWatch(key) { _saveWatch(_loadWatch().filter((w) => w.key !== key)); renderWatch(); }

  function _calCardHtml(e, withUnwatch) {
    const id = ++_calSeq;
    _calById[id] = e;
    const imp = e.importance === 'high' ? '<span style="color:var(--danger,#ef4444);font-weight:700;">● 高</span>'
      : e.importance === 'moderate' ? '<span style="color:var(--warn,#f59e0b);font-weight:700;">● 中</span>' : '';
    return `<div class="card" style="padding:10px 12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-3);">
        <span>${_esc((e.time || '').slice(5))}</span>
        <span><b style="color:var(--text-2);">${_esc(e.currency)}</b> ${imp}</span>
      </div>
      <div style="font-size:13.5px;margin-top:5px;">${e.country ? `[${_esc(e.country)}] ` : ''}${_esc(e.title)}</div>
      <div style="display:flex;gap:18px;margin-top:7px;font-size:12px;">
        <span style="color:var(--text-3);">前值 <b style="color:var(--text);">${_esc(_num(e.previous))}</b></span>
        <span style="color:var(--text-3);">预测 <b style="color:var(--text);">${_esc(_num(e.forecast))}</b></span>
        <span style="color:var(--text-3);">实际 <b style="color:${e.actual != null ? 'var(--accent)' : 'var(--text)'};">${_esc(_num(e.actual))}</b></span>
      </div>
      <div style="display:flex;gap:8px;margin-top:9px;align-items:center;">
        ${withUnwatch ? `<button class="cal-unwatch" data-key="${_esc(_calWatchKey(e))}" style="border:1px solid var(--border-soft,#2a2a2a);background:transparent;color:var(--text-3);border-radius:999px;padding:3px 11px;font-size:12px;cursor:pointer;">取消关注</button>` : ''}
      </div>
      <div class="cal-an-out" style="display:none;margin-top:9px;padding:9px 11px;background:var(--bg-2,rgba(255,255,255,.04));border-radius:8px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;"></div>
    </div>`;
  }
  function _wireCards(container) {
    container.onclick = async (ev) => {
      const un = ev.target.closest('.cal-unwatch');
      if (un) { _removeWatch(un.dataset.key); return; }
      const btn = ev.target.closest('.cal-an-btn');
      if (!btn) return;
      const e = _calById[Number(btn.dataset.an)];
      if (!e) return;
      const out = btn.closest('.card').querySelector('.cal-an-out');
      // 已分析过 → 再点只切换显/隐, 不重复请求
      if (out && out.dataset.loaded === '1') {
        const showing = out.style.display !== 'none';
        out.style.display = showing ? 'none' : 'block';
        btn.textContent = showing ? '🤖 展开分析' : '🤖 收起';
        return;
      }
      if (_addWatch(e)) renderWatch();   // 仅「新增」时重建关注列表; 已收藏(如在关注里点展开)不重建, 否则会毁掉当前卡 DOM 致分析展不开
      btn.disabled = true; btn.textContent = '🤖 分析中…';
      if (out) { out.style.display = 'block'; out.textContent = '分析中…'; }
      try {
        const r = await window.easydeal.calendar.analyze(_calSlim(e));
        const txt = (r && r.analysis) ? r.analysis : ((r && r.error) ? ('分析失败: ' + r.error) : 'AI 暂不可用');
        if (out) { out.textContent = txt; if (r && r.analysis) out.dataset.loaded = '1'; }
        btn.textContent = (r && r.analysis) ? '🤖 收起' : '🤖 AI 分析';
      } catch (err) {
        if (out) out.textContent = '分析失败: ' + (err.message || err);
        btn.textContent = '🤖 AI 分析';
      } finally { btn.disabled = false; }
    };
  }
  // 「关注」tab —— 点过 AI 分析的经济日历事件自动收藏(localStorage)
  const watchSection = el('section');
  watchSection.style.marginBottom = '24px';
  panelWatch.appendChild(watchSection);
  function renderWatch() {
    const xs = _loadWatch();
    if (!xs.length) {
      watchSection.innerHTML = `<div class="empty" style="padding:36px 0;text-align:center;color:var(--text-3);line-height:1.8;">还没有关注。<br>点「经济日历」里的「🤖 AI 分析」会自动收藏到这里。</div>`;
      return;
    }
    watchSection.innerHTML =
      `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 10px;">
         <h2 style="margin:0;font-size:16px;">⭐ 我的关注</h2>
         <span style="font-size:11.5px;color:var(--text-3);">${xs.length} 条 · 点过 AI 分析自动收藏</span>
       </div>` +
      xs.map((w) => _calCardHtml(w.item, true)).join('');
    _wireCards(watchSection);
  }
  renderWatch();

  function _calChip(label, active, onClick) {
    const b = el('button');
    b.textContent = label;
    b.style.cssText = `border:1px solid ${active ? 'var(--accent)' : 'var(--border-soft,#2a2a2a)'};background:${active ? 'var(--accent)' : 'transparent'};color:${active ? '#fff' : 'var(--text-2)'};border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;`;
    b.addEventListener('click', onClick);
    return b;
  }
  function renderCalFilters() {
    const counts = {};
    for (const e of _calEvents) { const c = e.currency || '?'; counts[c] = (counts[c] || 0) + 1; }
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    calFilters.innerHTML = '';
    calFilters.appendChild(_calChip('全部', _calPick === null, () => { _calPick = null; renderCalFilters(); renderCalList(); }));
    if (_myCcy.size) calFilters.appendChild(_calChip(`我的品种 (${[..._myCcy].join('/')})`, _calPick === 'MINE', () => { _calPick = 'MINE'; renderCalFilters(); renderCalList(); }));
    for (const c of list) calFilters.appendChild(_calChip(c, _calPick === c, () => { _calPick = c; renderCalFilters(); renderCalList(); }));
  }
  function renderCalList() {
    let xs = _calEvents;
    if (_calPick === 'MINE') xs = xs.filter((e) => _myCcy.has(String(e.currency || '').toUpperCase()));
    else if (_calPick) xs = xs.filter((e) => (e.currency || '') === _calPick);
    if (!xs.length) { calList.innerHTML = `<div class="empty">该筛选下暂无经济数据</div>`; return; }
    calList.innerHTML = xs.map((e) => _calCardHtml(e, false)).join('');
    _wireCards(calList);
  }
  async function refreshCalendar() {
    try {
      const r = await window.easydeal.calendar.get();
      _calEvents = (r && r.events) || [];   // 正序: 服务端已按时间升序返回, 不再反转
      // 我的交易品种 → 货币集合(本地策略 symbol)
      try {
        const sr = await window.easydeal.strategies.list();
        const items = (sr && sr.items) || sr || [];
        _myCcy = new Set();
        for (const s of items) {
          const sym = s && (s.symbol || s.name);
          if (sym) for (const c of _symbolCurrencies(sym)) _myCcy.add(c);
        }
      } catch {}
      renderCalFilters();
      renderCalList();
      calStatus.textContent = (r && r.updated_at)
        ? `共 ${_calEvents.length} 条 · 更新于 ${String(r.updated_at).slice(0, 16).replace('T', ' ')}`
        : ((r && r.ok === false) ? '加载失败' : '暂无数据(MT5 内挂上 EasyDealCalendar EA 后采集)');
    } catch (e) {
      calStatus.textContent = '加载失败: ' + (e.message || e);
    }
  }
  refreshCalendar();

  // ---------- 社区公告 section ----------
  const announceSection = el('section');
  announceSection.innerHTML = `
    <h2 style="margin:0 0 10px;font-size:16px;">📋 EasyDeal 官方公告</h2>
  `;
  panelNews.appendChild(announceSection);

  const offline = el('div', 'banner banner-info');
  offline.innerHTML = `
    <span class="banner-dot"></span>
    <span>当前未连接服务端，展示<strong>预览公告</strong>。</span>
  `;
  offline.style.display = 'none';
  announceSection.appendChild(offline);

  const list = el('div');
  list.id = 'news-list';
  announceSection.appendChild(list);

  refreshAnnouncements();

  async function refreshAnnouncements() {
    list.innerHTML = `<div class="empty">加载中…</div>`;
    const r = await window.easydeal.server.news({});
    offline.style.display = r.offline ? 'flex' : 'none';
    renderAnnouncementList(list, r.items || []);
  }
}

function renderFlashList(host, items) {
  if (!items || !items.length) {
    host.innerHTML = `<div class="empty" style="padding:20px;text-align:center;color:var(--text-3);">暂无快讯（金十数据正在抓取中…）</div>`;
    return;
  }
  // 已经是 newest first
  host.innerHTML = '';
  items.forEach((it, idx) => {
    const card = el('article', 'news-card');
    if (it.important) card.style.borderLeft = '3px solid var(--warn, #f59e0b)';
    const timeStr = it.time || (it.ts ? new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : '');
    const tagsHtml = (it.tags && it.tags.length)
      ? `<span style="margin-left:8px;color:var(--text-4);font-size:11px;">${it.tags.map((t) => escape(t)).join(' · ')}</span>`
      : '';
    const symbolsHtml = (it.remark && it.remark.length)
      ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text-3);">相关：${
          it.remark.filter((r) => r.symbol).map((r) =>
            `<code style="margin-right:6px;">${escape(r.symbol)}</code>`).join('')
        }</div>`
      : '';
    const cached = _flashAnCache[_flashKey(it)];   // 上次分析过的 → 恢复(默认收起)
    card.innerHTML = `
      <header class="news-head" style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        ${it.important ? '<span class="news-pin" style="background:rgba(245,158,11,0.18);color:#f59e0b;">重要</span>' : ''}
        <span class="news-date" style="color:var(--text-4);font-size:11.5px;">${escape(timeStr)}</span>
        ${tagsHtml}
      </header>
      ${it.title ? `<h3 style="margin:4px 0 6px;font-size:13.5px;">${escape(it.title)}</h3>` : ''}
      <div class="news-body" style="font-size:13px;line-height:1.55;">${renderFlashContent(it.content || '')}</div>
      ${symbolsHtml}
      <div class="flash-an-out" data-loaded="${cached ? '1' : ''}" style="display:${cached ? 'block' : 'none'};margin-top:9px;padding:9px 11px;background:var(--bg-2,rgba(255,255,255,.04));border-radius:8px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;">${cached ? escape(cached) : ''}</div>
    `;
    host.appendChild(card);
  });
  // 委托点击: AI 分析(toggle, 已分析过只切显隐不重复请求)
  host.onclick = async (ev) => {
    const btn = ev.target.closest('.flash-an-btn');
    if (!btn) return;
    const it = items[Number(btn.dataset.idx)];
    if (!it) return;
    const out = btn.closest('.news-card').querySelector('.flash-an-out');
    if (out && out.dataset.loaded === '1') {
      const showing = out.style.display !== 'none';
      out.style.display = showing ? 'none' : 'block';
      btn.textContent = showing ? '🤖 展开分析' : '🤖 收起';
      return;
    }
    _flashAnalyzing = true;   // 暂停自动刷新重建, 否则在途卡片被拆
    btn.disabled = true; btn.textContent = '🤖 分析中…';
    if (out) { out.style.display = 'block'; out.textContent = '分析中…'; }
    try {
      const r = await window.easydeal.news.analyze({ title: it.title || '', content: it.content || '' });
      const txt = (r && r.analysis) ? r.analysis : ((r && r.error) ? ('分析失败: ' + r.error) : 'AI 暂不可用');
      if (out) { out.textContent = txt; if (r && r.analysis) { out.dataset.loaded = '1'; _flashAnCache[_flashKey(it)] = txt; } }
      btn.textContent = (r && r.analysis) ? '🤖 收起' : '🤖 AI 分析';
    } catch (err) {
      if (out) out.textContent = '分析失败: ' + (err.message || err);
      btn.textContent = '🤖 AI 分析';
    } finally { btn.disabled = false; _flashAnalyzing = false; }
  };
}

function renderFlashContent(raw) {
  // 金十内容常常带「【XXX：YYY】」开头作为标题，剩下是正文。简单加粗一下。
  let s = String(raw || '');
  s = s.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  s = s.replace(/^【([^】]+)】/, '<strong>【$1】</strong>');
  return s;
}

function renderAnnouncementList(host, items) {
  if (!items.length) {
    host.innerHTML = `<div class="empty">暂无公告</div>`;
    return;
  }
  items = items.slice().sort((a, b) => {
    if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return (b.published_at || 0) - (a.published_at || 0);
  });
  host.innerHTML = '';
  for (const it of items) {
    const meta = KIND_META[it.kind] || KIND_META.news;
    const art = el('article', 'news-card');
    if (it.pinned) art.classList.add('news-pinned');
    art.innerHTML = `
      <header class="news-head">
        ${it.pinned ? '<span class="news-pin">置顶</span>' : ''}
        <span class="news-kind ${meta.cls}">${meta.label}</span>
        <h3>${escape(it.title)}</h3>
        <span class="news-date">${fmtDate(it.published_at)}</span>
      </header>
      <div class="news-body">${renderMd(it.body_md)}</div>
      ${it.author ? `<footer class="news-foot">— ${escape(it.author)}</footer>` : ''}
    `;
    host.appendChild(art);
  }
}

function renderMd(raw) {
  let s = String(raw || '').replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\n\n+/g, '</p><p>');
  s = s.replace(/\n/g, '<br>');
  return `<p>${s}</p>`;
}

function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
  catch { return ''; }
}

function fmtRelative(ts) {
  if (!ts) return '';
  const dt = Date.now() - Number(ts);
  if (dt < 0) return fmtDate(ts);
  if (dt < 60_000) return Math.floor(dt / 1000) + ' 秒前';
  if (dt < 3_600_000) return Math.floor(dt / 60_000) + ' 分钟前';
  if (dt < 86_400_000) return Math.floor(dt / 3_600_000) + ' 小时前';
  return fmtDate(ts);
}

// 0.3.22: 判断条目是否以英文为主 — 金十数据对每条全球新闻同时打中英双
// 份，英文那份典型特征：title 一长串大写英文、content 短或者跟 title 高度
// 重复。判定方式：把 title + content 拼起来，数中文字符占比，< 15% 且总
// 字符 >= 10 就算英文条目。中文标点 / 数字 / 空格不算 — 只看 CJK 字符。
function _looksEnglish(title, content) {
  const s = `${title || ''} ${content || ''}`.trim();
  if (s.length < 10) return false;
  let cjk = 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) continue;  // 空白不算
    total += 1;
    // CJK 统一表意 + 扩展 A + 中文标点
    if ((ch >= 0x4E00 && ch <= 0x9FFF)
        || (ch >= 0x3400 && ch <= 0x4DBF)
        || (ch >= 0x3000 && ch <= 0x303F)
        || (ch >= 0xFF00 && ch <= 0xFFEF)) {
      cjk += 1;
    }
  }
  if (total < 10) return false;
  return cjk / total < 0.15;
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
