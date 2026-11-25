// OrderGuard 护航专栏 — P0a/P0b 监控模式 UI。
//
// 4 个面板：
//   1. 整体战绩 — 累计审批 / 拦截 / 手数调整 / 24h 决策 / 累计盈亏
//      (0.4.30 去掉「已平仓 / 胜率」: 多实例 fan-out 聚合不准 — closed_orders 跨实例
//       相加, win_rate 是各实例分数直接相加会 >100% — 误导)
//   2. 已护航 EA — 列表 + 当前模式 + 暂停按钮
//   3. 在跑订单 — 实时 MT5 持仓，可展开看 guard 决策详情
//   4. 24h 决策日志 — 事件流
//
// 每 5 秒自动刷新；切到别的 tab 时停定时器。

const fmtPnl  = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${(v).toFixed(2)}`;
const fmtPct  = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const fmtTs   = (s) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
  catch { return s; }
};
const escape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

let _pollTimer = null;
// 0.3.91: 跨 5s 自动刷新保留「在跑订单展开」状态 —— 不然每次 refresh 都被收回去
const _expandedPosTickets = new Set();
// 0.3.176: 同款 — 「决策日志」展开状态也跨 refresh 保留 (用户反馈「展开后自动刷新被收回」)
const _expandedDecisionIds = new Set();

// 0.3.159: 改 sync — 让 showTab 同步拿到 refresher 函数 (mounters 不 await Promise).
// refreshAll 仍然 async, 放 fire-and-forget. 不影响 UI 体验 (loading 状态本来就异步).
export function renderOrderguard(root) {
  // 清掉前一次的 timer（重新挂载视图时）
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }

  root.innerHTML = `
    <div class="hero">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <h1>🛡 护航</h1>
          <p class="lede">实时审计 + 事后告警 + 学习能力 + 风险拦截，AI 协助风控你所有 EA 的订单。</p>
        </div>
        <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span id="og-status" class="muted" style="font-size: var(--fs-sm); color: var(--text-4);">连接中…</span>
            <button class="btn ghost small" id="og-refresh" title="强制 tracker 立即 poll MT5，拿 0s 新数据">⟳ 刷新</button>
          </div>
          <!-- 0.3.141: freshness 时间放到刷新按钮下方 -->
          <span id="og-freshness" class="muted" style="font-size: var(--fs-sm); color: var(--text-4);"></span>
        </div>
      </div>
    </div>

    <div class="card" id="og-overview"><div class="empty">加载中…</div></div>
    <div class="card" id="og-learning"><div class="empty">加载中…</div></div>
    <div class="card" id="og-enabled-eas"><div class="empty">加载中…</div></div>
    <div class="card" id="og-positions"><div class="empty">加载中…</div></div>
    <div class="card" id="og-closed-orders"><div class="empty">加载中…</div></div>
    <div class="card" id="og-decisions"><div class="empty">加载中…</div></div>
  `;

  // 0.3.141: 「⟳ 刷新」按钮先强制 tracker poll 一次再拉数据 — 用户感受到「时间归零 + 新鲜数据」
  // 用户反馈：「刷新的作用应该是马上更新，而不是刷新时间显示」
  root.querySelector('#og-refresh')?.addEventListener('click', async () => {
    const btn = root.querySelector('#og-refresh');
    const fresh = root.querySelector('#og-freshness');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ 拉新中…'; }
    if (fresh) fresh.textContent = '强制 tracker poll 中…';
    try { await window.easydeal.orderguard.forcePoll?.(); } catch {}
    await refreshAll(root).catch(() => {});
    if (btn) { btn.disabled = false; btn.textContent = '⟳ 刷新'; }
  });

  // 0.3.141: freshness chip 每秒刷新文字 (Xs 前 实时计数) — 独立 timer 不依赖 5s poll
  setInterval(() => {
    const fresh = root.querySelector('#og-freshness');
    if (!fresh || !root.isConnected) return;
    const ts = Number(root.dataset.lastPollTs || 0);
    if (!ts) { fresh.textContent = ''; return; }
    const age = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (age > 30) {
      fresh.textContent = `⚠ ${age}s 未更新`;
      fresh.style.color = 'var(--warn)';
    } else {
      fresh.textContent = `更新于 ${age}s 前`;
      fresh.style.color = 'var(--text-4)';
    }
  }, 1000);

  // 折叠点击委托
  root.addEventListener('click', (e) => {
    const head = e.target.closest('[data-og-pos-toggle]');
    if (head) {
      const ticket = head.dataset.ogPosToggle;
      const body = root.querySelector(`[data-og-pos-body="${ticket}"]`);
      if (body) {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        const caret = head.querySelector('.og-caret');
        if (caret) caret.textContent = open ? '▶' : '▼';
        // 0.3.91: 同步到 module-level set，下次 5s 自动 refresh 时能还原
        if (open) _expandedPosTickets.delete(ticket);
        else      _expandedPosTickets.add(ticket);
      }
      return;
    }
    const btn = e.target.closest('button[data-og-action]');
    if (btn) handleAction(root, btn);
  });

  refreshAll(root).catch(() => {});  // 0.3.159 fire-and-forget (sync renderOrderguard)
  // 5s 自动刷新
  function startPollLoop() {
    if (_pollTimer) return;   // 已经在跑
    _pollTimer = setInterval(() => {
      // 切走 tab 就暂停 — refresh 是幂等的，重新挂载会重启 timer
      if (!root.isConnected || root.closest('.hidden')) {
        clearInterval(_pollTimer);
        _pollTimer = null;
        return;
      }
      refreshAll(root).catch(() => {});
    }, 5000);
  }
  startPollLoop();
  // 0.3.159: 返 refresher — showTab 再次激活 OG tab 时调 (修「切到护航 tab 回来,
  // freshness 卡 124s 不刷新」). 之前 renderOrderguard 不返值, showTab 第二次
  // 激活时 mounters 不重跑 + refreshers[name] 没设 → _pollTimer 自杀后没人重启.
  return async () => {
    startPollLoop();         // 重启 poll timer (如果已 clearInterval)
    refreshAll(root).catch(() => {});  // 立即 refresh 一次更新 lastPollTs, freshness chip 立即归零
  };
}

async function refreshAll(root) {
  const statusEl = root.querySelector('#og-status');
  try {
    const [statusR, overview, enabled, positions, decisions, pendingSugg, appliedSugg, aiAcc, closedOrders] = await Promise.all([
      window.easydeal.orderguard.status(),
      window.easydeal.orderguard.overviewStats(),
      window.easydeal.orderguard.enabledEas(),
      window.easydeal.orderguard.positions(),
      window.easydeal.orderguard.decisions({ limit: 50 }),
      window.easydeal.orderguard.ruleSuggestions({ status: 'pending', limit: 50 }),
      window.easydeal.orderguard.ruleSuggestions({ status: 'applied', limit: 20 }),
      window.easydeal.orderguard.aiAccuracy(),
      window.easydeal.orderguard.closedOrders?.(50) || Promise.resolve({ ok: false }),
    ]);
    if (statusEl) {
      if (statusR?.ok) {
        const d = statusR.data || {};
        const tt = (d.tracker_running !== undefined)
          ? (d.tracker_running ? ' · 监控运行中' : ' · ⚠ 监控未启')
          : '';
        statusEl.textContent = `OrderGuard ${d.port ? `:${d.port}` : ''}${tt}`;
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = `⚠ OrderGuard 不可达：${statusR?.error || '未知错误'}`;
        statusEl.style.color = 'var(--danger)';
      }
    }
    // 0.3.141: positions endpoint 返 last_poll_ts，存到 root.dataset 让顶部 freshness timer 每秒读
    const lpt = (positions && positions.data && positions.data.last_poll_ts) || 0;
    root.dataset.lastPollTs = String(lpt || 0);

    // 0.4.25 (用户反馈「不在策略列表里的策略也不应该在护航里，相关的订单也是」):
    // 护航面板只显「策略」列表里有的 EA + 它们的 订单 / 决策。不在策略列表里的 EA
    // (用户在 MT5 里手跑的别的 EA / 已删策略的残留) 及其订单不该出现在护航。
    // 按 ea_name 或 magic 匹配 (magic 是订单归属 ground truth, 避开 EA 自报名 vs
    // 文件名不一致)。strategies.list() 拿不到时 fail-open (不过滤), 避免出错清空面板。
    // 0.4.30: 顺便建 ea_name(lower) → 绑定 mt5_instance_id 映射, 给下方同名 EA 去重当首选信号。
    const nameToInstance = new Map();
    try {
      const sl = await window.easydeal.strategies.list();
      const sItems = (sl && (sl.items || sl.strategies)) || (Array.isArray(sl) ? sl : null);
      if (Array.isArray(sItems)) {
        const names = new Set();
        const magics = new Set();
        for (const it of sItems) {
          const nm = String(it.name || it.ea_name || '').split('/').pop()
            .replace(/\.(mq5|ex5)$/i, '').trim().toLowerCase();
          if (nm) names.add(nm);
          if (nm && it.mt5_instance_id) nameToInstance.set(nm, String(it.mt5_instance_id));
          const mc = it.monitor_config || {};
          const mags = (Array.isArray(mc.magic_numbers) && mc.magic_numbers.length)
            ? mc.magic_numbers : (mc.magic ? [mc.magic] : []);
          for (const m of mags) { const mm = Number(m); if (mm) magics.add(mm); }
        }
        const inList = (eaName, magic) => {
          const nm = String(eaName || '').trim().toLowerCase();
          if (nm && names.has(nm)) return true;
          const mm = Number(magic);
          if (mm && magics.has(mm)) return true;
          return false;
        };
        if (enabled?.data?.eas) {
          enabled.data.eas = enabled.data.eas.filter((e) => inList(e.ea_name, e.magic));
        }
        if (positions?.data?.positions) {
          positions.data.positions = positions.data.positions.filter((p) => inList(p.ea_name, p.magic));
        }
        if (closedOrders?.data?.orders) {
          closedOrders.data.orders = closedOrders.data.orders.filter((o) => inList(o.ea_name, o.magic));
        }
        if (decisions?.data?.decisions) {
          decisions.data.decisions = decisions.data.decisions.filter((d) => inList(d.ea_name, d.magic));
        }
        // 学习中心的规则建议也按策略列表过滤 (针对不在列表里的 EA 的建议无意义)
        if (pendingSugg?.data?.suggestions) {
          pendingSugg.data.suggestions = pendingSugg.data.suggestions.filter((s) => inList(s.ea_name, s.magic));
        }
        if (appliedSugg?.data?.suggestions) {
          appliedSugg.data.suggestions = appliedSugg.data.suggestions.filter((s) => inList(s.ea_name, s.magic));
        }
      }
    } catch (e) {
      // fail-open: 策略列表拿不到就不过滤护航面板
    }

    // 0.4.30: 同名 EA 在多个 MT5 实例的 OG 各被启用一次 (getEnabledEas fan-out 不去重)
    // → 「已护航 EA」列表出现重复。用户实测: GMarket 一条 拦截/magic=999 (真), 一条
    // 监控/无 magic (残留在另一个实例 OG 的孤儿启用记录)。按 ea_name 去重, 保留最该显示
    // 的那条: ① _instance_id 匹配策略当前绑定实例 ② 拦截(enforce) > 监控(observe)
    // ③ 有 magic > 无 magic。(同一 .ex5 hash 在策略表只一条记录、只绑一个实例, 所以
    // 同名出现在别的实例 OG 必是孤儿, 去重安全。)
    if (enabled?.data?.eas && enabled.data.eas.length > 1) {
      const scoreEa = (e) => {
        let s = 0;
        const nm = String(e.ea_name || '').trim().toLowerCase();
        const bound = nameToInstance.get(nm);
        if (bound && e._instance_id && String(e._instance_id) === bound) s += 100;
        if (e.mode === 'enforce') s += 10;
        if (Number(e.magic) > 0) s += 1;
        return s;
      };
      const seen = new Map();   // nameLower → out 数组下标
      const out = [];
      for (const e of enabled.data.eas) {
        const nm = String(e.ea_name || '').trim().toLowerCase();
        if (!nm) { out.push(e); continue; }  // 无名条目原样保留 (理论上不会有)
        const idx = seen.get(nm);
        if (idx === undefined) { seen.set(nm, out.length); out.push(e); }
        else if (scoreEa(e) > scoreEa(out[idx])) { out[idx] = e; }
      }
      enabled.data.eas = out;
      if (enabled.data.count != null) enabled.data.count = out.length;
    }

    renderOverview(root.querySelector('#og-overview'), overview);
    renderEnabledEas(root.querySelector('#og-enabled-eas'), enabled);
    renderLearning(root.querySelector('#og-learning'), pendingSugg, appliedSugg, aiAcc);
    renderPositions(root.querySelector('#og-positions'), positions);
    renderClosedOrders(root.querySelector('#og-closed-orders'), closedOrders);
    renderDecisions(root.querySelector('#og-decisions'), decisions);
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = `刷新失败：${e?.message || e}`;
      statusEl.style.color = 'var(--danger)';
    }
  }
}

// 0.3.74 P3: 学习中心面板 — 显示 pending 建议 + applied 历史 + 0.3.75 AI 校准。
function renderLearning(host, pendingR, appliedR, aiAccR) {
  const pending = (pendingR?.data?.suggestions) || [];
  const applied = (appliedR?.data?.suggestions) || [];
  const ok = pendingR?.ok !== false;
  host.innerHTML = `
    <div class="section-head">
      <h2>📈 学习中心 · ${pending.length} 条建议${applied.length ? ` · ${applied.length} 已应用` : ''}</h2>
      <span class="sub">rule learning</span>
      <button class="btn ghost small" data-og-action="scan-now" style="margin-left:auto;">🔍 立即扫描</button>
    </div>
  `;

  // 0.3.75 AI 校准 mini-panel — 总样本 ≥10 才显示，避免空表
  const aiAcc = aiAccR?.data;
  if (aiAcc && aiAcc.total_ai_decisions_closed >= 10) {
    const accDiv = el('div');
    accDiv.style.cssText = 'padding:10px 14px;background:rgba(74,158,255,0.05);border-bottom:1px solid var(--overlay-3);';
    const buckets = aiAcc.by_confidence_bucket || {};
    const cells = Object.entries(buckets).map(([name, b]) => {
      if (!b.sample_n) return `<div><span class="muted small">${escape(name)}</span>: <span class="muted">无</span></div>`;
      const wrPct = b.win_rate != null ? `${(b.win_rate*100).toFixed(1)}%` : '—';
      const pnlColor = (b.avg_pnl || 0) >= 0 ? 'var(--success)' : 'var(--danger)';
      return `<div style="font-size:var(--fs-sm);">
        <span class="muted">${escape(name)}</span>
        <span style="margin-left:4px;">n=${b.sample_n} · win=${wrPct} · avg=<span style="color:${pnlColor};">${fmtPnl(b.avg_pnl)}</span></span>
      </div>`;
    }).join('');
    accDiv.innerHTML = `
      <div style="font-weight:500;color:var(--text);margin-bottom:6px;">🤖 AI 校准（按 confidence 桶 vs 实际 win rate）— ${aiAcc.total_ai_decisions_closed} 个 AI 决策已闭环</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 14px;">${cells}</div>
      <div class="muted small" style="margin-top:6px;">${escape(aiAcc.hint || '')}</div>
    `;
    host.appendChild(accDiv);
  }
  if (!ok) {
    host.appendChild(el('div', 'empty')).textContent = '加载失败';
    return;
  }
  if (!pending.length && !applied.length) {
    const tip = el('div', 'empty');
    tip.style.textAlign = 'left';
    tip.style.padding = '14px';
    tip.innerHTML = `
      <strong>护航会从你的实战数据里学习</strong><br>
      <span class="muted">每 24 小时扫一遍所有已护航 EA 的近 30 天 closed orders + decisions，找出
      胜率明显偏低 / 偏高的规则区间，给出调整建议（≥30 单样本才考虑、每条 rule 7 天冷却、
      所有变更可一键回滚）。当前没有任何 EA 累积出足够样本，先让护航跑一阵子。</span>
    `;
    host.appendChild(tip);
    return;
  }

  // Pending 列表
  if (pending.length) {
    const head = el('div');
    head.style.cssText = 'padding:8px 12px;font-weight:500;color:var(--text);background:rgba(74,158,255,0.05);border-bottom:1px solid var(--overlay-3);';
    head.textContent = `🆕 待审建议 (${pending.length})`;
    host.appendChild(head);
    for (const s of pending) {
      host.appendChild(renderSuggestionRow(s, /*isPending*/ true));
    }
  }

  // Applied 历史
  if (applied.length) {
    const head2 = el('div');
    head2.style.cssText = 'padding:8px 12px;margin-top:6px;font-weight:500;color:var(--text);background:rgba(34,197,94,0.06);border-bottom:1px solid var(--overlay-3);';
    head2.textContent = `✓ 已应用历史 (${applied.length})`;
    host.appendChild(head2);
    for (const s of applied) {
      host.appendChild(renderSuggestionRow(s, /*isPending*/ false));
    }
  }
}

function renderSuggestionRow(s, isPending) {
  const row = el('div');
  row.style.cssText = 'padding:12px 14px;border-bottom:1px solid var(--overlay-2);';
  const oldStr = typeof s.old_value === 'object' ? JSON.stringify(s.old_value) : String(s.old_value);
  const newStr = typeof s.new_value === 'object' ? JSON.stringify(s.new_value) : String(s.new_value);
  const wr = s.win_rate != null ? `${(s.win_rate * 100).toFixed(1)}%` : '—';
  const actions = isPending
    ? `<button class="btn primary small" data-og-action="apply-sugg" data-id="${s.id}">应用</button>
       <button class="btn ghost small" data-og-action="dismiss-sugg" data-id="${s.id}">忽略</button>`
    : `<button class="btn ghost small" data-og-action="rollback-sugg" data-id="${s.id}" title="还原 ${escape(oldStr)}">回滚</button>
       <span class="muted small" style="margin-left:8px;">${fmtTs(s.applied_at)}</span>`;
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
          <strong>${escape(s.ea_name)}</strong>
          <code style="background:var(--overlay-2);padding:2px 6px;border-radius:3px;font-size:var(--fs-sm);">${escape(s.rule_key)}</code>
          <span class="muted small">${escape(oldStr)} <span style="color:var(--accent);">→</span> ${escape(newStr)}</span>
          <span class="muted small" style="margin-left:auto;">sample=${s.sample_n} · win=${wr}</span>
        </div>
        <div style="color:var(--text-2);font-size:var(--fs-sm);line-height:1.5;">${escape(s.reason)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">${actions}</div>
    </div>
  `;
  return row;
}

function renderOverview(host, r) {
  if (!r?.ok) {
    host.innerHTML = `<div class="empty">无法加载战绩（${escape(r?.error || '未知')}）</div>`;
    return;
  }
  const d = r.data || {};
  host.innerHTML = `
    <div class="section-head">
      <h2>整体战绩</h2>
      <span class="sub">accumulated</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">
      <div class="og-stat">
        <div class="og-stat-v">${d.total_decisions || 0}</div>
        <div class="og-stat-k">累计审批</div>
      </div>
      <div class="og-stat">
        <div class="og-stat-v" style="color: var(--warn);">${d.blocked || 0}</div>
        <div class="og-stat-k">拦截</div>
      </div>
      <div class="og-stat">
        <div class="og-stat-v">${d.adjusted || 0}</div>
        <div class="og-stat-k">手数调整</div>
      </div>
      <div class="og-stat">
        <div class="og-stat-v">${d.decisions_24h || 0}</div>
        <div class="og-stat-k">24h 决策</div>
      </div>
      <div class="og-stat">
        <div class="og-stat-v" style="color: ${(d.cumulative_pnl || 0) >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmtPnl(d.cumulative_pnl)}</div>
        <div class="og-stat-k">累计盈亏 USD</div>
      </div>
    </div>
  `;
}

function renderEnabledEas(host, r) {
  if (!r?.ok) {
    host.innerHTML = `<div class="empty">无法加载已护航列表</div>`;
    return;
  }
  const eas = (r.data && r.data.eas) || [];
  host.innerHTML = `
    <div class="section-head">
      <h2>已护航的 EA · ${eas.length}</h2>
      <span class="sub">enabled EAs</span>
    </div>
  `;
  if (!eas.length) {
    const tip = el('div', 'empty');
    tip.style.textAlign = 'left';
    tip.style.padding = '14px';
    tip.innerHTML = `
      还没有任何 EA 启用护航。<br>
      <span class="muted">去「我的策略」找一只运行中的 EA，点旁边的「🛡 护航」按钮启用监控模式。零侵入，立刻可用。</span>
    `;
    host.appendChild(tip);
    return;
  }
  const table = el('table', 'list');
  table.innerHTML = `
    <thead>
      <tr>
        <th>EA</th>
        <th style="width:72px;">模式</th>
        <th style="width:68px;">Magic</th>
        <th style="width:190px;">拦截规则</th>
        <th style="width:64px;">状态</th>
        <th style="width:170px;">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  for (const ea of eas) {
    const tr = el('tr');
    const isEnforce = ea.mode === 'enforce';
    // 0.4.x → 1.0.8: 模式徽章加 tooltip 明确区分「护航中(可拦截)」vs「仅监控(事后)」
    const modeBadge = isEnforce
      ? `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);" title="护航中 · 真正拦截违规开仓/改单/平仓 — 下方「拦截规则」开关生效">拦截</span>`
      : `<span class="tag" title="仅监控 · 事后记录+告警, 不拦截 — 下方「拦截规则」只记录 would-block 预览, 切到拦截模式后才真拦">监控</span>`;
    // 1.0.8: per-EA 拦截开关 (服务端 fast_rules.close_guard.enabled / modify_guard.block_sl_widen)。
    // 改单拦 SL 外扩 = 安全方向默认开(绿); 平仓拦截 = 危险默认关(红, 开启需二次确认)。
    // 监控模式下整组淡化 + tooltip 注明只预览不真拦。
    const eaAttr = escape(ea.ea_name);
    const swOn = ea.block_sl_widen !== false;          // 默认 true
    const cgOn = !!ea.close_guard_enabled;             // 默认 false
    const swHint = isEnforce ? '' : '（当前监控模式: 只记录 would-block, 不真拦）';
    const cgHint = isEnforce ? '' : '（当前监控模式: 只记录, 不真拦）';
    const swBtn = `<button class="btn ghost small" data-og-action="toggle-sl-widen" data-ea="${eaAttr}" data-cur="${swOn ? '1' : '0'}"
        style="${swOn ? 'color:var(--success);border-color:rgba(16,185,129,0.45);background:rgba(16,185,129,0.10);' : 'opacity:0.7;'}"
        title="拦截『把止损往亏损方向外扩 / 删掉止损』——爆仓经典动作。安全方向, 默认开。收紧止损 / 改止盈永远放行。${swHint}">${swOn ? '🛡 拦SL外扩' : 'SL外扩·放行'}</button>`;
    const cgBtn = `<button class="btn ghost small" data-og-action="toggle-close-guard" data-ea="${eaAttr}" data-cur="${cgOn ? '1' : '0'}"
        style="${cgOn ? 'color:var(--danger);border-color:rgba(239,68,68,0.5);background:rgba(239,68,68,0.12);' : 'opacity:0.7;'}"
        title="平仓拦截（⚠ 危险, 默认关）: 开启后当 EA 想平掉『盈利单』而离止盈还很远时拦下 (让利润跑完)。永不拦止损 — 浮亏单一律放行。${cgHint}">${cgOn ? '🔴 平仓拦截·开' : '平仓拦截·关'}</button>`;
    const ngHtml = renderNewsGuardControl(ea, eaAttr);
    // 0.3.141: 加「↻ 重置统计」按钮 — 用户反馈「这个 ea 是刚上护航功能的，
    // 为什么历史的单都跑进来了」：点这个让 anchor=now，之前历史不再显示在
    // 顶部累计 / 决策日志 / 已平仓订单。SQL 行不删，仅过滤。
    tr.innerHTML = `
      <td><strong>${eaAttr}</strong></td>
      <td>${modeBadge}</td>
      <td><code style="font-family:var(--font-mono);">${escape(ea.magic)}</code></td>
      <td>
        <div style="display:flex;flex-direction:column;gap:5px;${isEnforce ? '' : 'opacity:0.6;'}">
          ${swBtn}
          ${cgBtn}
        </div>
        ${ngHtml}
      </td>
      <td>${ea.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">暂停</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn ghost small" data-og-action="reset-anchor" data-ea="${eaAttr}" title="把该 EA 的统计 anchor 重置到现在 — 之前历史 decision / 已平仓订单从面板隐藏 (SQL 数据不删，仅 query 过滤)。用于「我现在才开始用护航，不想看到历史数据」场景">↻ 重置统计</button>
        <button class="btn ghost small" data-og-action="disable" data-ea="${eaAttr}">暂停</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  host.appendChild(table);
}

// 消息面护航: EA 开马丁单前由 AI 结合资讯 + 经济日历判断是否放行。默认关, 独立于监控/拦截模式。
// 只有带心跳的新版 EA (如 GMarket_wl_NewsGuard) 才能开启 —— 旧版 / 其他 EA 不会调用, 开了也不生效。
const NEWS_GUARD_HEARTBEAT_MS = 10 * 60_000;
const NEWS_GUARD_MODES = [
  ['off', '关', '关闭（默认）：EA 按原逻辑开马丁'],
  ['shadow', '仅记录', '仅记录：EA 照常开马丁，AI 的判断只写进决策日志，用来先观察准不准'],
  ['enforce', '拦截', '拦截：AI 判断消息面风险高时，暂缓开这一层马丁'],
];

function renderNewsGuardControl(ea, eaAttr) {
  const mode = ea.news_guard_mode || 'off';
  const seenTs = ea.news_gate_last_seen ? Date.parse(ea.news_gate_last_seen) : 0;
  const supported = seenTs > 0;
  const online = supported && Date.now() - seenTs < NEWS_GUARD_HEARTBEAT_MS;
  // 不支持的 EA 只允许保持/切回「关」, 避免开了却以为在护航
  const btns = NEWS_GUARD_MODES.map(([val, label, tip]) => {
    const active = mode === val;
    const disabled = !supported && val !== 'off' && !active;
    const color = val === 'enforce' ? 'var(--warn)' : val === 'shadow' ? 'var(--accent,#4a9eff)' : 'var(--text-3)';
    return `<button class="btn ghost small" data-og-action="news-guard-mode" data-ea="${eaAttr}" data-mode="${val}"
        ${disabled ? 'disabled' : ''} title="${escape(tip)}"
        style="padding:2px 7px;${active ? `color:${color};border-color:${color};font-weight:600;` : 'opacity:0.65;'}">${label}</button>`;
  }).join('');
  let status;
  if (!supported) {
    status = `<span class="muted" title="EA 需支持消息面护航（如 GMarket_wl_NewsGuard），并把护航服务地址加进 MT5 的 WebRequest 白名单；EA 运行后 2 分钟内会出现心跳">未检测到 EA 支持</span>`;
  } else if (mode === 'off') {
    status = `<span class="muted">EA 已支持${ea.news_gate_ea_version ? ` · v${escape(ea.news_gate_ea_version)}` : ''}</span>`;
  } else if (online) {
    status = `<span style="color:var(--success);">EA 在线${ea.news_gate_ea_version ? ` · v${escape(ea.news_gate_ea_version)}` : ''}</span>`;
  } else {
    status = `<span style="color:var(--warn);" title="EA 超过 10 分钟没有心跳：EA 没运行、或连不上护航服务。此时 EA 一律按原逻辑开马丁">⚠ EA 无心跳，按原逻辑放行</span>`;
  }
  return `
    <div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--border-soft,#333);">
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
        <span style="font-size:11px;color:var(--text-3);margin-right:2px;" title="开马丁单前，由 AI 结合「资讯」快讯和经济日历判断是否放行。AI 不可用 / 超时时一律放行。">📰 消息面</span>
        ${btns}
      </div>
      <div style="font-size:10.5px;margin-top:3px;">${status}</div>
    </div>`;
}

function renderPositions(host, r) {
  if (!r?.ok) {
    host.innerHTML = `<div class="empty">无法加载在跑订单</div>`;
    return;
  }
  const pos = (r.data && r.data.positions) || [];
  // 0.3.141: freshness chip 已经移到顶部 #og-freshness（刷新按钮下方），这里不再重复显示
  host.innerHTML = `
    <div class="section-head">
      <h2>在跑订单 · ${pos.length}</h2>
      <span class="sub">live positions</span>
    </div>
  `;
  if (!pos.length) {
    const tip = el('div', 'empty');
    tip.innerHTML = `当前 MT5 没有在跑订单。<br><span class="muted">护航的 EA 一开仓就会出现在这里，含每笔的 guard 决策详情。</span>`;
    host.appendChild(tip);
    return;
  }
  // 0.3.75: 在跑订单列表加「护航」表头 + per-row 是/否
  const headerRow = el('div');
  headerRow.style.cssText = `display:grid;grid-template-columns:24px 110px 1fr 60px 80px 80px 90px 100px;gap:10px;
    padding:8px 12px;border-bottom:1px solid var(--overlay-3);font-size:var(--fs-sm);color:var(--text-3);font-weight:500;`;
  headerRow.innerHTML = `
    <span></span>
    <span>ticket</span>
    <span>EA</span>
    <span title="是否在护航 — 「是」表示该 magic 已注册到 OrderGuard，每笔下单都会经审计；「否」表示 magic 未登记，订单在跑但不护航">护航</span>
    <span>side</span>
    <span>vol</span>
    <span>symbol</span>
    <span style="text-align:right;">PnL</span>
  `;
  const wrap = el('div');
  wrap.appendChild(headerRow);
  for (const p of pos) {
    const pnl = p.current_pnl || 0;
    const sideColor = p.side === 'buy' ? 'var(--success)' : 'var(--danger)';
    const guarded = !!p.guarded;
    const guardedTag = guarded
      ? `<span class="tag ok" style="font-size:var(--fs-sm);" title="该 EA 的 magic ${p.magic} 已注册护航">是</span>`
      : `<span class="tag" style="color:var(--warn);border-color:rgba(245,158,11,0.3);font-size:var(--fs-sm);cursor:help;" title="magic=${p.magic} 没注册到任何护航 EA — 点开看登记方法">否</span>`;
    // 0.3.91: 跨 5s 自动 refresh 保留展开状态
    const isOpen = _expandedPosTickets.has(String(p.ticket));
    const head = el('div', 'og-pos-head');
    head.dataset.ogPosToggle = String(p.ticket);
    head.style.cssText = `display:grid;grid-template-columns:24px 110px 1fr 60px 80px 80px 90px 100px;gap:10px;
      padding:10px 12px;border-bottom:1px solid var(--overlay-3);cursor:pointer;align-items:center;`;
    // 0.3.151 step 2: 最近 30min 警报标记 — 浮亏过大 / 持仓过久等触发的 alert
    const alerts = Array.isArray(p.alerts) ? p.alerts : [];
    const alertChip = alerts.length > 0
      ? `<span class="tag" title="${escape(alerts.map(a => a.reason).join(' / '))}" style="color:var(--danger);border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.08);font-size:var(--fs-sm);margin-left:4px;cursor:help;">⚠ ${alerts.length}</span>`
      : '';
    head.innerHTML = `
      <span class="og-caret">${isOpen ? '▼' : '▶'}</span>
      <code style="font-family:var(--font-mono);font-size:var(--fs-sm);">#${escape(p.ticket)}</code>
      <strong style="${guarded ? '' : 'color:var(--text-3);'}">${escape(p.ea_name)}${alertChip}</strong>
      <span>${guardedTag}</span>
      <span style="color:${sideColor};">${escape(p.side?.toUpperCase() || '?')}</span>
      <span style="font-family:var(--font-mono);">${escape(p.volume)}</span>
      <span style="color:var(--text-3);">${escape(p.symbol)}</span>
      <span style="font-family:var(--font-mono);color:${pnl >= 0 ? 'var(--success)' : 'var(--danger)'};text-align:right;">${fmtPnl(pnl)}</span>
    `;
    wrap.appendChild(head);

    const body = el('div');
    body.dataset.ogPosBody = String(p.ticket);
    // 0.3.91: 用 _expandedPosTickets 决定初始 display — 不然 5s refresh 一次就收回去
    body.style.cssText = `padding:12px 16px 14px 60px;background:var(--overlay-1);border-bottom:1px solid var(--overlay-3);display:${isOpen ? 'block' : 'none'};font-size:var(--fs-md);`;
    const dec = p.decision;
    // 0.3.75: 展开行始终显示 raw magic — 用户能跟 MT5 持仓属性里的 magic 对比
    const guardedHint = !p.guarded ? `
      <div style="margin-top:8px;padding:8px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:4px;color:var(--warn);line-height:1.6;font-size:var(--fs-sm);">
        ⚠ <strong>未护航</strong> — 这笔单的 magic <code>${escape(p.magic)}</code> 没注册到任何 EA。
        要让它进护航：在 MT5 里这笔单上<strong>右键 → 修改</strong>看 Magic Number 值，
        然后回「我的策略 → 对应 EA → 🛡 护航」对话框把 magic 填成 <code>${escape(p.magic)}</code> 再启用。
        启用时填错的 magic 会被新的覆盖，过去 1 小时的历史决策也会自动 backfill 到正确 EA 名下。
      </div>` : '';
    // 0.3.90: AI 分析按钮 — 跳到 AI tab 让它结合 EA 源码 + decision 上下文分析这笔订单生命周期
    // 数据 JSON-encoded 进 data 属性，handler 反解析 — 避免 onclick inline 的字符串拼接 / 转义噩梦
    const positionPayload = JSON.stringify({
      ticket:     p.ticket,
      ea_name:    p.ea_name,
      magic:      p.magic,
      symbol:     p.symbol,
      side:       p.side,
      volume:     p.volume,
      open_price: p.open_price,
      open_time:  p.open_time,
      sl:         p.sl,
      tp:         p.tp,
      current_pnl: p.current_pnl,
      decision:   dec || null,
    });
    const analyzeBtn = `
      <button class="btn ghost small" data-og-action="analyze-position"
        data-payload='${escape(positionPayload)}'
        style="margin-top:10px;"
        title="跳到 AI 聊天 tab，让 AI 结合 EA 源码 + decision 上下文分析这笔订单生命周期（入场逻辑 / 风险/收益 / 可能的 close 触发）">
        🤖 AI 分析这笔订单
      </button>`;
    // 0.3.151 step 2: 警报详情 panel (展开行顶部, 比 decision 还显眼)
    const alertsHtml = alerts.length > 0 ? `
      <div style="margin-bottom:10px;padding:8px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:4px;">
        <div style="color:var(--danger);font-weight:600;margin-bottom:4px;font-size:var(--fs-sm);">⚠ 最近 30min 警报 (${alerts.length})</div>
        ${alerts.map(a => `<div style="color:var(--text-2);font-size:var(--fs-sm);line-height:1.6;">· <code style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);">${escape(a.intent)}</code> ${escape(a.reason)} <span class="muted small">${escape(a.ts)}</span></div>`).join('')}
      </div>
    ` : '';
    if (dec) {
      const reasonColor = dec.approved ? 'var(--text-2)' : 'var(--warn)';
      body.innerHTML = `${alertsHtml}`;
      body.innerHTML += `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px;margin-bottom:8px;">
          <div><span class="muted">intent</span> <code>${escape(dec.intent)}</code></div>
          <div><span class="muted">risk</span> <code>${escape(dec.risk_level)}</code></div>
          <div><span class="muted">magic</span> <code style="font-family:var(--font-mono);">${escape(p.magic)}</code></div>
          <div><span class="muted">开仓价</span> ${escape(p.open_price)}</div>
          <div><span class="muted">开仓时间</span> ${fmtTs(p.open_time)}</div>
          <div><span class="muted">SL/TP</span> ${escape(p.sl || '—')} / ${escape(p.tp || '—')}</div>
          <div><span class="muted">decision</span> ${dec.approved ? '<span class="tag ok">放行</span>' : '<span class="tag" style="color:var(--warn);">拦截</span>'}</div>
        </div>
        <div style="color:${reasonColor};">${escape(dec.reason || '—')}</div>
        <div class="muted" style="margin-top:6px;font-size:var(--fs-sm);">decision_id: <code>${escape(dec.decision_id)}</code></div>
        ${guardedHint}
        ${analyzeBtn}
      `;
    } else {
      body.innerHTML = `${alertsHtml}
        <div class="muted">这只单在 OrderGuard 启动前就开了，没有 decision 记录。</div>
        <div class="muted" style="margin-top:6px;">magic: <code style="font-family:var(--font-mono);">${escape(p.magic)}</code></div>
        ${guardedHint}
        ${analyzeBtn}
      `;
    }
    wrap.appendChild(body);
  }
  host.appendChild(wrap);
}

// 0.3.141: 已平仓订单明细 — 让用户看清「累计盈亏 -40.20 USD」是哪几笔合计出来的
function renderClosedOrders(host, r) {
  if (!r?.ok) {
    host.innerHTML = `<div class="empty">无法加载已平仓订单</div>`;
    return;
  }
  const orders = (r.data && r.data.orders) || [];
  const totalPnl = orders.reduce((s, o) => s + (Number(o.pnl) || 0), 0);
  const wins = orders.filter(o => (Number(o.pnl) || 0) > 0).length;
  const losses = orders.filter(o => (Number(o.pnl) || 0) < 0).length;
  const pnlColor = totalPnl >= 0 ? 'var(--success)' : 'var(--danger)';

  host.innerHTML = `
    <div class="section-head">
      <h2>📊 已平仓订单 · ${orders.length}</h2>
      <span class="sub">closed orders</span>
      <span class="spacer"></span>
      <span class="muted" style="font-size:var(--fs-sm);">
        合计 <strong style="color:${pnlColor};">${fmtPnl(totalPnl)}</strong>
        · 盈 ${wins} 笔 / 亏 ${losses} 笔
      </span>
    </div>
  `;
  if (!orders.length) {
    host.appendChild(el('div', 'empty')).textContent = '还没有已平仓订单。EA 平仓后这里会列出每笔 PnL 明细。';
    return;
  }
  const table = el('table', 'list');
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:110px;">平仓时间</th>
        <th>EA</th>
        <th>symbol/side</th>
        <th style="text-align:right;">vol</th>
        <th style="text-align:right;">开仓 / 平仓价</th>
        <th style="text-align:right;width:100px;">PnL (USD)</th>
        <th>原因</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  for (const o of orders) {
    const pnl = Number(o.pnl) || 0;
    const tr = el('tr');
    tr.innerHTML = `
      <td><span class="muted" style="font-size:var(--fs-sm);">${escape(fmtTs(o.close_time))}</span></td>
      <td><strong>${escape(o.ea_name || '__unknown__')}</strong> <span class="muted small">#${escape(String(o.ticket || ''))}</span></td>
      <td>${escape(o.symbol || '?')} / <span style="color:${o.side === 'buy' ? 'var(--success)' : 'var(--danger)'};">${escape(o.side || '?')}</span></td>
      <td style="text-align:right;font-family:var(--font-mono);">${escape(String(o.approved_volume ?? o.requested_volume ?? '?'))}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--text-3);">${escape(String(o.open_price ?? '?'))} → ${escape(String(o.close_price ?? '?'))}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-weight:600;color:${pnl >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmtPnl(pnl)}</td>
      <td style="color:var(--text-3);font-size:var(--fs-sm);">${escape(o.close_reason || '—')}</td>
    `;
    tb.appendChild(tr);
  }
  host.appendChild(table);
}

function renderDecisions(host, r) {
  if (!r?.ok) {
    host.innerHTML = `<div class="empty">无法加载决策日志</div>`;
    return;
  }
  const ds = (r.data && r.data.decisions) || [];
  host.innerHTML = `
    <div class="section-head">
      <h2>最近 50 条决策</h2>
      <span class="sub">decision log</span>
    </div>
  `;
  if (!ds.length) {
    host.appendChild(el('div', 'empty')).textContent = '还没有任何决策记录。EA 启用护航后开始累积。';
    return;
  }
  const table = el('table', 'list');
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:140px;">时间</th>
        <th>EA</th>
        <th>intent</th>
        <th>risk</th>
        <th>symbol/side</th>
        <th style="text-align:right;">vol</th>
        <th style="width:80px;">决策</th>
        <th>reason</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  // 0.3.176: 渲染前清掉已经不在当前列表里的 expanded id (decisions 列表是 ring buffer
  // 50 条, 老 row 滑出后展开状态没意义了, set 留着也无害但清掉更干净)
  const visibleIds = new Set(ds.map((d) => d.decision_id).filter(Boolean));
  for (const id of [..._expandedDecisionIds]) {
    if (!visibleIds.has(id)) _expandedDecisionIds.delete(id);
  }
  for (const d of ds) {
    const tr = el('tr');
    const decBadge = d.approved
      ? '<span class="tag ok">放行</span>'
      : '<span class="tag" style="color:var(--warn);">拦截</span>';
    // 1.0.7: op 徽章 — 平仓/改单决策标出来 (开仓是默认, 不标保持干净)
    const _opMeta = { close: ['平', 'var(--accent,#4a9eff)'], modify: ['改', 'var(--warn)'], news_gate: ['消息面', 'var(--success)'] }[d.op];
    const opBadge = _opMeta
      ? `<span class="tag" style="font-size:10px;color:${_opMeta[1]};border-color:${_opMeta[1]};margin-right:4px;">${_opMeta[0]}</span>`
      : '';
    // 0.3.141: 行可点击展开 — caret + 完整 reason / context_json / decision_id
    // 0.3.176: 跨 refresh 保留展开状态 (从 _expandedDecisionIds 读)
    const isOpen = _expandedDecisionIds.has(d.decision_id);
    tr.style.cursor = 'pointer';
    tr.dataset.ogDecisionToggle = d.decision_id || '';
    tr.innerHTML = `
      <td><span class="og-caret" style="display:inline-block;width:1em;">${isOpen ? '▼' : '▶'}</span> <span class="muted" style="font-size:var(--fs-sm);">${escape(fmtTs(d.ts))}</span></td>
      <td><strong>${escape(d.ea_name)}</strong></td>
      <td>${opBadge}<code style="font-size:var(--fs-sm);">${escape(d.intent)}</code></td>
      <td><code>${escape(d.risk_level)}</code></td>
      <td>${escape(d.symbol)} / <span style="color:${d.side === 'buy' ? 'var(--success)' : 'var(--danger)'};">${escape(d.side)}</span></td>
      <td style="text-align:right;font-family:var(--font-mono);">${escape(d.requested_volume)}</td>
      <td>${decBadge}</td>
      <td style="color:var(--text-3);font-size:var(--fs-sm);">${escape((d.reason || '').slice(0, 80))}</td>
    `;
    tb.appendChild(tr);
    // detail row — 0.3.176: 按 _expandedDecisionIds 决定初始展开/收起
    const detail = el('tr');
    detail.dataset.ogDecisionDetail = d.decision_id || '';
    detail.style.display = isOpen ? 'table-row' : 'none';
    let ctx = d.context_json;
    if (typeof ctx === 'string') {
      try { ctx = JSON.parse(ctx); } catch {}
    }
    const ctxPretty = ctx ? JSON.stringify(ctx, null, 2) : '(无 context)';
    detail.innerHTML = `
      <td colspan="8" style="background:var(--overlay-1);padding:12px;">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:var(--fs-sm);">
          <div class="muted">decision_id</div>
          <div style="font-family:var(--font-mono);">${escape(d.decision_id || '?')}</div>
          <div class="muted">approved_volume</div>
          <div style="font-family:var(--font-mono);">${escape(String(d.approved_volume ?? '—'))}</div>
          <div class="muted">latency_ms</div>
          <div style="font-family:var(--font-mono);">${escape(String(d.latency_ms ?? 0))}</div>
          <div class="muted">AI 检查</div>
          <div>${d.ai_checked ? `✓ 已调 AI (置信度 ${(d.ai_confidence ?? 0)})` : '✗ 未调 AI（fast rules 已过）'}</div>
          <div class="muted">完整 reason</div>
          <div>${escape(d.reason || '—')}</div>
          <div class="muted">context_json</div>
          <pre style="margin:0;padding:8px;background:var(--surface-200);border:1px solid var(--border-soft);border-radius:4px;font-size:var(--fs-sm);overflow:auto;max-height:200px;">${escape(ctxPretty)}</pre>
        </div>
      </td>
    `;
    tb.appendChild(detail);
  }
  host.appendChild(table);

  // 行 click 切换 detail 显示
  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-og-decision-toggle]');
    if (!tr) return;
    const id = tr.dataset.ogDecisionToggle;
    const detail = table.querySelector(`tr[data-og-decision-detail="${CSS.escape(id)}"]`);
    if (!detail) return;
    const open = detail.style.display !== 'none';
    detail.style.display = open ? 'none' : 'table-row';
    const caret = tr.querySelector('.og-caret');
    if (caret) caret.textContent = open ? '▶' : '▼';
    // 0.3.176: 同步 _expandedDecisionIds set, 让 5s 自动 refresh 后状态保留
    if (id) {
      if (open) _expandedDecisionIds.delete(id);
      else _expandedDecisionIds.add(id);
    }
  });
}

async function handleAction(root, btn) {
  const action = btn.dataset.ogAction;
  if (action === 'disable') {
    const ea = btn.dataset.ea;
    if (!confirm(`暂停 ${ea} 的护航？历史数据保留，只停记录新订单。`)) return;
    btn.disabled = true;
    try {
      const r = await window.easydeal.orderguard.disableEa(ea);
      if (!r?.ok) {
        alert(`暂停失败：${r?.error || '未知'}`);
      } else {
        await refreshAll(root);
      }
    } catch (e) {
      alert(`暂停失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // 0.3.141: 重置 anchor 到 now — 清零顶部统计 + 决策日志 + 已平仓订单
  if (action === 'reset-anchor') {
    const ea = btn.dataset.ea;
    if (!confirm(`将「${ea}」的统计 anchor 重置到现在？\n\n• 之前的历史 decision / 已平仓订单将不再显示在顶部累计、决策日志、已平仓订单面板里。SQL 数据保留（不删），仅 query 过滤。\n• 仅影响「护航 tab」统计；「我的策略」+ 排行榜的 stats-collector 数据独立，不会被改\n\n用于「我现在才开始用护航，不想看到历史数据」场景。`)) return;
    btn.disabled = true;
    try {
      const r = await window.easydeal.orderguard.resetAnchor?.(ea);
      if (!r?.ok) {
        alert(`重置失败：${r?.error || '未知'}`);
      } else {
        await refreshAll(root);
      }
    } catch (e) {
      alert(`重置失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // 1.0.8: per-EA 拦截开关 — 平仓拦截 (close_guard.enabled) / 拦 SL 外扩 (modify_guard.block_sl_widen)
  if (action === 'toggle-close-guard' || action === 'toggle-sl-widen') {
    const ea = btn.dataset.ea;
    const cur = btn.dataset.cur === '1';
    const next = !cur;
    const key = action === 'toggle-close-guard'
      ? 'fast_rules.close_guard.enabled'
      : 'fast_rules.modify_guard.block_sl_widen';
    // 开启平仓拦截 = 危险 (= 让护航替你扛单不平), 二次确认 + 讲清楚边界。
    if (action === 'toggle-close-guard' && next) {
      if (!confirm(`⚠ 确定开启「${ea}」的平仓拦截吗？\n\n开启后：当 EA 想平掉一笔【盈利】单、而该单离止盈目标还很远时，护航会拦下这次平仓（让利润继续跑）。\n\n• 永不拦止损：浮亏 / 保本单平仓一律放行，绝不会把你套在亏损单里。\n• 仅「拦截模式」下真正生效；监控模式只记录不拦。\n• 相当于把「要不要现在平」的部分决定权交给护航，属于激进风控——确认你的策略适合再开。`)) {
        return;
      }
    }
    btn.disabled = true;
    try {
      const r = await window.easydeal.orderguard.setGuardRule?.(ea, key, next);
      if (!r?.ok) {
        alert(`设置失败：${r?.error || '未知'}`);
      } else {
        await refreshAll(root);   // 重渲染表格, 开关状态从 /enabled-eas 新数据回显
      }
    } catch (e) {
      alert(`设置失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // 消息面护航三档: off / shadow(仅记录) / enforce(拦截)
  if (action === 'news-guard-mode') {
    const ea = btn.dataset.ea;
    const next = btn.dataset.mode;
    if (next === 'enforce' && !confirm(
      `开启「${ea}」的消息面护航（拦截）？\n\n` +
      `开启后：EA 每次准备开马丁单前，AI 会结合「资讯」快讯和经济日历判断消息面风险；风险高时暂缓开这一层，过一段时间再评估。\n\n` +
      `• AI 不可用、评估超时（EA 默认等 30 秒）、或护航服务连不上时，一律按原逻辑放行。\n` +
      `• 同一方向连续拦截超过 2 小时会自动放行，避免错过整段行情后在更远的价位才开仓。\n` +
      `• 每次马丁评估约消耗一次 AI 调用。\n` +
      `• 不确定 AI 判断准不准？可以先选「仅记录」观察一段时间。`)) {
      return;
    }
    btn.disabled = true;
    try {
      const r = await window.easydeal.orderguard.setGuardRule?.(ea, 'fast_rules.news_guard.mode', next);
      if (!r?.ok) alert(`设置失败：${r?.error || '未知'}`);
      else await refreshAll(root);
    } catch (e) {
      alert(`设置失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // 0.3.74 P3: 学习中心按钮
  if (action === 'scan-now') {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '扫描中…';
    try {
      const r = await window.easydeal.orderguard.scanRuleSuggestionsNow();
      if (r?.ok) {
        const n = r.data?.new_suggestions || 0;
        const eas = r.data?.eas_scanned || 0;
        // 没用 toast — orderguard-view 没引 — 直接 status bar 提示
        const statusEl = root.querySelector('#og-status');
        if (statusEl) {
          statusEl.textContent = `✓ 扫描完成：${eas} 个 EA / 新增 ${n} 条建议`;
          statusEl.style.color = 'var(--success)';
        }
        await refreshAll(root);
      } else {
        alert(`扫描失败：${r?.error || '未知'}`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }
  // 0.3.90: AI 分析在跑订单 — 跳到 AI tab 让它分析订单生命周期
  if (action === 'analyze-position') {
    try {
      const payload = JSON.parse(btn.dataset.payload || '{}');
      btn.disabled = true;
      btn.textContent = '🤖 发起中…';
      const r = await window.easydeal.app.requestAnalyzePosition(payload);
      if (r?.ok) {
        if (typeof window.showTab === 'function') window.showTab('chat');
      } else {
        alert('AI 分析请求失败：' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('AI 分析请求失败：' + (e?.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '🤖 AI 分析这笔订单';
    }
    return;
  }
  if (action === 'apply-sugg' || action === 'dismiss-sugg' || action === 'rollback-sugg') {
    const id = btn.dataset.id;
    if (!id) return;
    if (action === 'rollback-sugg' && !confirm('回滚这条建议？规则会还原成原值，但历史上的影响已经发生。')) return;
    btn.disabled = true;
    try {
      let r;
      if (action === 'apply-sugg')         r = await window.easydeal.orderguard.applyRuleSuggestion(id);
      else if (action === 'dismiss-sugg')  r = await window.easydeal.orderguard.dismissRuleSuggestion(id);
      else                                  r = await window.easydeal.orderguard.rollbackRuleSuggestion(id);
      if (!r?.ok) {
        alert(`操作失败：${r?.error || '未知'}`);
      } else {
        await refreshAll(root);
      }
    } catch (e) {
      alert(`操作失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }
}
