import { PRESETS, WEEKDAYS, humanizeSchedule } from '../cron-helpers.js';
// Timers view — list, create form, expandable run history per task.

const fmt = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('zh-CN', { hour12: false });
};
const fmtDuration = (ms) => {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
};

export function renderTimers(root) {
  root.innerHTML = '';

  // Track which task rows have their 历史 panel expanded across re-renders.
  // The list/sys auto-refresh tickers tear down + rebuild the table every
  // 10s; without this set the user's expanded history pane silently
  // collapses moments after they open it. Keys are task ids (works for
  // both system task_id and user-created task id since they don't collide).
  const expandedIds = new Set();

  // --- system tasks card (read-only built-in tickers) ---
  const sysCard = el('div', 'card');
  sysCard.innerHTML = `
    <div class="section-head">
      <h2>系统任务</h2>
      <span class="sub">built-in tickers · read-only</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="sys-reset" title="清空所有系统任务定义+历史，重启后由当前版本自动重新 seed。不影响用户任务。">↻ 重置</button>
      <button class="btn ghost small" id="sys-refresh">刷新</button>
    </div>
    <p class="hint">客户端在后台自动跑的内置定时任务，不能编辑或删除。下方"已有任务"才是你创建的 cron。<br>多版本迭代后系统任务在不同机器上不一致 → 点「↻ 重置」清空 + 重启 EasyDeal 即可恢复成最新版本的标准列表。</p>
    <div id="sys-list"><div class="empty">加载中…</div></div>
  `;
  // sysCard is appended LATER (after formCard) so the create form sits at the
  // top of the page where the user is most likely to focus when they come
  // here to create a new task.

  async function refreshSysTasks() {
    let items = [];
    try { items = await window.easydeal.app.systemTasks(); } catch {}
    const host = sysCard.querySelector('#sys-list');
    if (!items.length) {
      host.innerHTML = '<div class="empty">没有运行中的系统任务</div>';
      return;
    }
    host.innerHTML = '';
    const tbl = el('table', 'list');
    tbl.innerHTML = `
      <thead><tr>
        <th>任务</th>
        <th style="width: 130px;">间隔</th>
        <th style="width: 180px;">上次运行</th>
        <th style="width: 100px;">状态</th>
        <th style="width: 90px;">耗时</th>
        <th style="width: 80px; text-align: right;">运行次数</th>
        <th style="width: 80px;">操作</th>
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    for (const t of items) {
      const intervalHuman = t.tick_ms
        ? (t.tick_ms >= 3600_000 ? `${Math.round(t.tick_ms / 3600_000)} 小时`
           : t.tick_ms >= 60_000 ? `${Math.round(t.tick_ms / 60_000)} 分钟`
           : `${Math.round(t.tick_ms / 1000)} 秒`)
        : '—';
      const tag = t.last_status === 'ok'
        ? '<span class="tag ok">正常</span>'
        : t.last_status === 'mt5_unreachable'
        ? '<span class="tag" style="color: var(--warn); border-color: rgba(255, 188, 51, 0.3);">MT5 未连</span>'
        : t.last_status === 'down'
        ? '<span class="tag error">未启动</span>'
        : t.last_status === 'error'
        ? '<span class="tag error">出错</span>'
        : '<span class="tag" style="color: var(--text-4);">未跑过</span>';
      const lastSum = (t.last_summary || '').trim();
      const lastSumPeek = lastSum
        ? `<div class="last-sum-peek" title="${escape(lastSum.slice(0, 400))}">${escape(lastSum.slice(0, 80))}${lastSum.length > 80 ? '…' : ''}</div>`
        : '';
      const tr = el('tr');
      tr.dataset.id = t.task_id || t.id;
      tr.innerHTML = `
        <td>
          <div style="font-weight: 500; color: var(--text);">${escape(t.name)}</div>
          <div style="font-size: 11px; color: var(--text-4); margin-top: 2px;">${escape(t.description || '')}</div>
          ${lastSumPeek}
        </td>
        <td style="font-family: var(--font-mono); font-size: 12px;">${escape(intervalHuman)}</td>
        <td style="font-family: var(--font-mono); font-size: 12px; color: var(--text-3);">${fmt(t.last_run_at)}</td>
        <td>${tag}${t.last_error ? `<div style="font-size: 11px; color: var(--danger); margin-top: 2px;" title="${escape(t.last_error)}">${escape((t.last_error || '').slice(0, 40))}</div>` : ''}</td>
        <td style="font-family: var(--font-mono); font-size: 12px;">${fmtDuration(t.last_duration_ms)}</td>
        <td style="text-align: right; font-family: var(--font-mono); font-size: 12px;">${t.run_count ?? '—'}</td>
        <td>
          ${t.task_id ? `<button class="btn ghost small" data-sys-history="${t.task_id}">历史</button>` : ''}
        </td>
      `;
      tb.appendChild(tr);
    }
    host.appendChild(tbl);

    // History expansion for system tasks (same toggle pattern as user tasks).
    tbl.addEventListener('click', async (e) => {
      const sysId = e.target?.dataset?.sysHistory;
      if (!sysId) return;
      await toggleHistory(host, sysId, 7, expandedIds);   // colSpan = 7 here (extra 操作 col)
    });

    // Re-expand any sys-task history pane the user had open before this
    // 10s refresh nuked it. Each id is best-effort — if its row vanished
    // from the latest list, expandHistory just no-ops.
    for (const id of expandedIds) {
      try { await expandHistory(host, id, 7); } catch {}
    }
    if (items[0]?.last_upload_at) {
      const u = el('div', 'hint');
      u.style.marginTop = '8px';
      u.textContent = `上次跨日上报：${fmt(items[0].last_upload_at)}（${items[0].last_upload_rows || 0} 条）`;
      host.appendChild(u);
    }
  }
  sysCard.querySelector('#sys-refresh').addEventListener('click', refreshSysTasks);
  // 0.3.120: 一键重置系统任务
  sysCard.querySelector('#sys-reset').addEventListener('click', async () => {
    const ok = confirm(
      '即将清空所有系统任务定义 + 它们的运行历史。\n' +
      '\n' +
      '• 用户任务（已有任务面板里）不受影响\n' +
      '• 重启 EasyDeal 后客户端会自动按当前版本重新 seed 系统任务\n' +
      '\n' +
      '继续？',
    );
    if (!ok) return;
    try {
      const r = await window.easydeal.timers.resetSystem();
      if (r && r.tasks_deleted !== undefined) {
        alert(
          `已清空 ${r.tasks_deleted} 个系统任务 + ${r.runs_deleted || 0} 条运行历史。\n` +
          '\n' +
          '请退出 EasyDeal（任务栏右键 → 退出）然后重开 —— 系统任务会被自动重新初始化到当前版本的标准状态。',
        );
        refreshSysTasks();
      } else {
        alert('重置失败：' + (r?.error || '未知'));
      }
    } catch (e) {
      alert('重置异常：' + (e?.message || e));
    }
  });
  refreshSysTasks();
  // Auto-refresh every 10s while this view is mounted
  const sysTimer = setInterval(refreshSysTasks, 10_000);
  const sysObs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      clearInterval(sysTimer);
      sysObs.disconnect();
    }
  });
  sysObs.observe(document.body, { childList: true, subtree: true });

  // --- create form card ---
  const formCard = el('div', 'card');
  formCard.innerHTML = `
    <div class="section-head">
      <h2>新建定时任务</h2>
      <span class="sub">scheduler.create_task</span>
    </div>
    <p class="hint">
      到点客户端会自动让 AI 执行你写的指令，结果写进历史记录。默认无头跑（不进对话流，只看结果）。
    </p>
    <div class="row wrap">
      <div class="field" style="flex:1; min-width: 240px;">
        <label>任务名</label>
        <input id="t-name" placeholder="每小时策略巡检" style="width: 100%;">
      </div>
      <div class="field" style="width: 180px;">
        <label>模式</label>
        <select id="t-mode" style="width: 100%;">
          <option value="llm_headless">无头跑（推荐）</option>
          <option value="tool_only">仅调工具 · v1</option>
          <option value="llm_inject">注入对话 · v1</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>触发频率</label>
      <div class="row wrap" style="gap: 8px;">
        <select id="t-preset" style="flex: 1; min-width: 200px;">${PRESETS.map((p) =>
          `<option value="${p.key}">${escape(p.label)}</option>`).join('')}</select>
        <input type="time"           id="t-time"     style="display: none;" value="09:00">
        <select                      id="t-weekday"  style="display: none; width: 110px;">${WEEKDAYS.map((w) =>
          `<option value="${w.v}">${escape(w.label)}</option>`).join('')}</select>
        <input type="datetime-local" id="t-datetime" style="display: none;">
        <input type="text"           id="t-cron"     style="display: none; min-width: 200px; font-family: var(--font-mono);" placeholder="0 * * * *">
      </div>
      <div class="hint" id="t-preview" style="margin-top: 6px; font-size: 12px;"></div>
    </div>
    <div class="field">
      <label>关联策略 <span class="muted">(可选 — 绑定后: 全部未运行时本次自动跳过, 任一运行就执行且只处理运行中的那些; 一个任务可关联多个策略, 不用为相似策略各建一个)</span></label>
      <div id="t-strats" class="row wrap" style="gap: 6px 14px; margin-top: 4px;"><span class="hint">加载中…</span></div>
      <div id="t-strats-hint" class="hint" style="margin-top: 4px; display: none; color: var(--accent, #4a9eff);"></div>
    </div>
    <div class="field">
      <label>触发时执行的指令 (prompt)</label>
      <span class="hint" style="margin: 0 0 8px; display: block;">
        客户端会自动维护 CLAUDE.md 与 .mcp.json，agent 启动即看到所有工具。
      </span>
      <div class="chat-input-box">
        <textarea id="t-prompt" placeholder="调用 get_strategy_status 与 get_positions，浮亏 > 30% 或马丁层级 ≥ 5 时简短告警；无异常时回复『一切正常』。"></textarea>
        <button class="btn primary chat-send-inside" id="t-create" title="创建任务">创建任务</button>
      </div>
    </div>
  `;
  // 0.3.152: 后台 ticker 监控 card — 显 timer-registry 所有注册的 timer/service +
  // 「全停」按钮联动 panic + 单 ticker pause/resume 按钮
  const regCard = el('div', 'card');
  regCard.innerHTML = `
    <div class="section-head">
      <h2>🛰 后台 Ticker 监控</h2>
      <span class="sub">timer-registry · panic 联动</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="reg-pause-all">⏸ 全停</button>
      <button class="btn ghost small" id="reg-resume-all">▶ 解除全停</button>
      <button class="btn ghost small" id="reg-refresh">刷新</button>
    </div>
    <p class="hint">客户端所有后台定时任务统一注册到这里。「⏸ 全停」是 admin 调试用 — 停掉 non-critical 的 7 个 ticker + 4 个 service（OG / stats / 微信告警 / 调度 等），等点「▶ 解除全停」恢复。critical（license 心跳 / 微信收发）始终运行。<br><span class="muted">注: AI 的「全停」(panic_stop_all) 跟这里独立 — 那是一次性清理 (cancel 回测/优化 + 删 auto-poll cron + dismiss chat 中断 turn), 不进入 paused 态.</span></p>
    <div id="reg-status" class="muted small" style="margin-bottom: 10px;"></div>
    <div id="reg-list"><div class="empty">加载中…</div></div>
  `;
  async function refreshRegistry() {
    let r;
    try { r = await window.easydeal.app.listTimers(); }
    catch (e) { regCard.querySelector('#reg-list').innerHTML = `<div class="empty">err: ${e?.message || e}</div>`; return; }
    if (!r?.ok) return;
    const d = r.data || {};
    const statusEl = regCard.querySelector('#reg-status');
    if (d.paused) {
      const since = d.pausedAt ? new Date(d.pausedAt).toLocaleString('zh-CN', { hour12: false }) : '?';
      statusEl.innerHTML = `<span style="color: var(--warn); font-weight: 600;">⏸ 已全停</span>（原因: <code>${escape(d.pausedReason || '?')}</code>, 自 ${since}）`;
    } else {
      statusEl.innerHTML = `<span style="color: var(--success);">▶ 运行中</span>`;
    }
    const host = regCard.querySelector('#reg-list');
    const allItems = [...(d.timers || []), ...(d.services || [])];
    if (!allItems.length) {
      host.innerHTML = '<div class="empty">没有注册任何 ticker</div>';
      return;
    }
    const tbl = el('table', 'list');
    tbl.innerHTML = `
      <thead><tr>
        <th>id</th>
        <th>类型</th>
        <th>说明</th>
        <th style="width: 90px;">间隔</th>
        <th style="width: 180px;">上次运行</th>
        <th style="width: 100px;">状态</th>
        <th style="width: 130px;">操作</th>
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    const fmtTs = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
    const fmtInt = (ms) => !ms ? '—'
      : ms >= 3600_000 ? `${Math.round(ms / 3600_000)}h`
      : ms >= 60_000 ? `${Math.round(ms / 60_000)}min`
      : `${Math.round(ms / 1000)}s`;
    for (const it of allItems) {
      const tr = el('tr');
      const stat = it.paused
        ? `<span class="tag" style="color: var(--warn);">⏸ ${escape(it.pausedReason || '暂停')}</span>`
        : (it.lastError ? `<span class="tag error">出错</span>` : (it.consecutiveFails > 0 ? `<span class="tag" style="color: var(--warn);">${it.consecutiveFails} 次失败</span>` : `<span class="tag ok">运行</span>`));
      const critTag = it.critical ? '<span class="tag" style="color: var(--text-4);" title="critical: 全停时也跑">critical</span>' : '';
      tr.innerHTML = `
        <td><code style="font-family: var(--font-mono); font-size: 12px;">${escape(it.id)}</code> ${critTag}</td>
        <td><span class="muted small">${escape(it.kind || '?')}</span></td>
        <td><div style="font-size: 12px;">${escape(it.description || '')}</div>${it.lastError ? `<div style="font-size: 11px; color: var(--danger); margin-top: 2px;" title="${escape(it.lastError)}">${escape(it.lastError.slice(0, 60))}</div>` : ''}</td>
        <td style="font-family: var(--font-mono); font-size: 12px;">${escape(fmtInt(it.intervalMs))}</td>
        <td style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3);">${escape(fmtTs(it.lastRunAt))}${it.lastDurationMs ? `<div style="font-size:10.5px; color:var(--text-4);">耗时 ${it.lastDurationMs}ms · 运行 ${it.runCount} 次</div>` : ''}</td>
        <td>${stat}</td>
        <td>
          ${it.paused
            ? `<button class="btn ghost small" data-reg-action="resume" data-id="${escape(it.id)}">▶ 恢复</button>`
            : `<button class="btn ghost small" data-reg-action="pause" data-id="${escape(it.id)}" ${it.critical ? 'disabled title="critical 不能单独停"' : ''}>⏸ 停</button>`}
        </td>
      `;
      tb.appendChild(tr);
    }
    host.innerHTML = '';
    host.appendChild(tbl);
  }
  regCard.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-reg-action]');
    if (btn) {
      const id = btn.dataset.id;
      const action = btn.dataset.regAction;
      btn.disabled = true;
      try {
        if (action === 'pause') await window.easydeal.app.pauseTimer(id, 'manual');
        else if (action === 'resume') await window.easydeal.app.resumeTimer(id);
        await refreshRegistry();
      } catch (e) { console.warn('reg action err', e); }
      finally { btn.disabled = false; }
    }
  });
  regCard.querySelector('#reg-refresh').addEventListener('click', refreshRegistry);
  regCard.querySelector('#reg-pause-all').addEventListener('click', async () => {
    if (!confirm('⏸ 「全停」会暂停所有 non-critical 后台 ticker（OG / stats / 调度 / 微信告警等）。critical 服务（license 心跳 / 微信收发）继续运行。\n\n确认全停?')) return;
    try {
      await window.easydeal.app.pauseAllTimers('user', null);
      await refreshRegistry();
    } catch (e) { alert('全停失败: ' + (e?.message || e)); }
  });
  regCard.querySelector('#reg-resume-all').addEventListener('click', async () => {
    try {
      await window.easydeal.app.resumeAllTimers();
      await refreshRegistry();
    } catch (e) { alert('恢复失败: ' + (e?.message || e)); }
  });

  // Order: 新建表单 → 系统任务 → 后台 ticker 监控 → 已有任务
  root.appendChild(formCard);
  root.appendChild(sysCard);
  root.appendChild(regCard);
  // 启动时拉一次, 之后每 10s 自动刷一次
  refreshRegistry().catch(() => {});
  const regAutoRefresh = setInterval(() => refreshRegistry().catch(() => {}), 10_000);
  // 卸载时清 interval (DOM 移除时这个 closure 不会 GC, 加 MutationObserver 兜底)
  const mo = new MutationObserver(() => {
    if (!document.body.contains(regCard)) { clearInterval(regAutoRefresh); mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // --- list card ---
  const listCard = el('div', 'card');
  listCard.innerHTML = `
    <div class="section-head">
      <h2>已有任务</h2>
      <span class="sub">scheduler.list</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="t-refresh">刷新</button>
    </div>
    <div id="t-list"></div>
  `;
  root.appendChild(listCard);

  // --- behaviors ---
  const $ = (s) => formCard.querySelector(s);

  // Preset → toggle helper inputs + recompute schedule + preview
  function syncPresetUi() {
    const key = $('#t-preset').value;
    const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
    $('#t-time').style.display     = ['time', 'weekday-time'].includes(preset.needs) ? '' : 'none';
    $('#t-weekday').style.display  = preset.needs === 'weekday-time' ? '' : 'none';
    $('#t-datetime').style.display = preset.needs === 'datetime' ? '' : 'none';
    $('#t-cron').style.display     = preset.needs === 'cron' ? '' : 'none';
    updatePreview();
  }
  function currentSchedule() {
    const key = $('#t-preset').value;
    const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
    try {
      return preset.build({
        time: $('#t-time').value,
        weekday: $('#t-weekday').value,
        datetime: $('#t-datetime').value,
        cron: $('#t-cron').value,
      });
    } catch { return ''; }
  }
  function updatePreview() {
    const s = currentSchedule();
    $('#t-preview').innerHTML = s
      ? `将按"<strong>${escape(humanizeSchedule(s))}</strong>"触发  <span style="color: var(--text-4);">(${escape(s)})</span>`
      : '<span style="color: var(--warn);">先填写时间</span>';
  }
  for (const id of ['#t-preset', '#t-time', '#t-weekday', '#t-datetime', '#t-cron']) {
    formCard.querySelector(id).addEventListener('input', updatePreview);
    formCard.querySelector(id).addEventListener('change', updatePreview);
  }
  $('#t-preset').addEventListener('change', syncPresetUi);
  // Default datetime = tomorrow 09:00 (so the picker isn't empty)
  const tmr = new Date(Date.now() + 86400_000);
  tmr.setHours(9, 0, 0, 0);
  $('#t-datetime').value = toLocalIso(tmr);
  syncPresetUi();

  // 1.4.x: 新建任务时可关联策略(多选) — 绑定后策略未运行自动跳过, 触发时动态收窄到
  // 运行中的那些。列表来自当前策略清单, 运行中的排前面、带●标; 用户勾一个后, 若还有
  // 相似(同前缀, 跟 main.js _reattribute_ea 同款判定)且运行中的策略未勾, 主动帮勾上
  // + 提示一句(可再取消) —— 落地"添加规则时主动问是否加到相似运行中策略"的要求。
  let _allStrategyStems = [];
  async function loadStrategyChecklist() {
    const host = formCard.querySelector('#t-strats');
    try {
      const list = (await window.easydeal.strategies.list()) || [];
      // 1.4.x: 不能用 d.is_mounted —— 0.3.238 起它被重定义成「is_deployed && mt5_running」
      // (ex5部署到位+MT5进程在跑), 不查日志, 比「我的策略」页自己的绿色「运行中」徽章宽松
      // (那边额外要求 is_mounted_in_log —— MT5 日志确认当前真挂在图表上, 见 strategies-view.js
      // :788-823 的三态判定)。用同款严格判据, 否则「已部署·未确认运行」「已停止」会被误显绿点
      // (用户实测抓到: 6只策略全显绿, 实际只2只真在跑)。
      const items = list.map((d) => ({
        stem: String(d.name || '').replace(/\.(mq5|ex5|mqh|set)$/i, ''),
        running: !!(d.is_deployed && d.mt5_running !== false && d.is_mounted_in_log),
      })).filter((it) => it.stem);
      _allStrategyStems = items.map((it) => it.stem);
      if (!items.length) {
        host.innerHTML = '<span class="hint">还没有策略(挂载后会出现在这)</span>';
        return;
      }
      items.sort((a, b) => (b.running - a.running) || a.stem.localeCompare(b.stem));
      host.innerHTML = items.map((it) => `
        <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; font-size:12.5px;">
          <input type="checkbox" class="t-strat-cb" value="${escape(it.stem)}" style="width:14px;height:14px;">
          ${it.running ? '<span style="color:var(--success,#5fc992);">●</span>' : '<span style="color:var(--text-4);">○</span>'}
          ${escape(it.stem)}
        </label>
      `).join('');
    } catch (e) {
      host.innerHTML = `<span class="hint">策略列表加载失败: ${escape(e?.message || e)}</span>`;
    }
  }
  loadStrategyChecklist();
  formCard.querySelector('#t-strats').addEventListener('change', async (ev) => {
    const cb = ev.target.closest('.t-strat-cb');
    if (!cb || !cb.checked) return;
    const stem = cb.value;
    // 相似判定沿用 main.js _reattribute_ea 同款前缀互相包含逻辑(如 GMarket / GMarket_v2)。
    const similar = _allStrategyStems.filter((s) => s !== stem && (s.startsWith(stem) || stem.startsWith(s)));
    if (!similar.length) return;
    let addedAny = false;
    const added = [];
    for (const s of similar) {
      const other = formCard.querySelector(`.t-strat-cb[value="${CSS.escape(s)}"]`);
      if (other && !other.checked) {
        // 只自动勾"当前运行中"的相似策略 — 停着的不主动加, 免得任务门控被无意义扩大。
        const isRunning = other.parentElement?.textContent?.includes('●');
        if (isRunning) { other.checked = true; added.push(s); addedAny = true; }
      }
    }
    const hintEl = formCard.querySelector('#t-strats-hint');
    if (addedAny) {
      hintEl.style.display = '';
      hintEl.textContent = `已顺便勾选相似的运行中策略: ${added.join('、')}（不需要可取消勾选）`;
    }
  });

  $('#t-create').addEventListener('click', async () => {
    const name = $('#t-name').value.trim();
    const schedule = currentSchedule();
    const prompt = $('#t-prompt').value.trim();
    const mode = $('#t-mode').value;
    if (!name || !schedule || !prompt) {
      showToast('请填写 任务名、触发频率、指令', 'error');
      return;
    }
    const ea_names = Array.from(formCard.querySelectorAll('.t-strat-cb:checked')).map((cb) => cb.value);
    try {
      await window.easydeal.timers.create({ name, schedule, prompt, mode, ea_names });
      $('#t-name').value = '';
      $('#t-prompt').value = '';
      formCard.querySelectorAll('.t-strat-cb:checked').forEach((cb) => { cb.checked = false; });
      formCard.querySelector('#t-strats-hint').style.display = 'none';
      showToast(ea_names.length ? `任务已创建(关联 ${ea_names.length} 个策略)` : '任务已创建', 'ok');
      await refreshList();
    } catch (e) {
      showToast('创建失败：' + (e.message || e), 'error');
    }
  });
  listCard.querySelector('#t-refresh').addEventListener('click', refreshList);

  refreshList();
  setInterval(refreshList, 10_000);

  async function refreshList() {
    const list = await window.easydeal.timers.list();
    const host = listCard.querySelector('#t-list');
    renderList(host, list, expandedIds);
    // Re-expand any history pane the user had open before this auto-refresh
    // re-rendered the table. Each id is best-effort — if the task got
    // deleted server-side, expandHistory just no-ops on missing row.
    for (const id of expandedIds) {
      try { await expandHistory(host, id, 7); } catch {}
    }
  }
}

function renderList(host, list, expandedIds = null) {
  host.innerHTML = '';
  if (!list.length) {
    const empty = el('div', 'empty');
    empty.textContent = '还没有定时任务。可以让 AI 帮你建（"每小时检查策略"），也可以用上方表单手动建。';
    host.appendChild(empty);
    return;
  }

  const table = el('table', 'list');
  table.innerHTML = `
    <thead>
      <tr>
        <th>名称</th>
        <th style="width: 130px;">模式</th>
        <th>触发频率</th>
        <th>下次触发</th>
        <th>上次状态</th>
        <th style="width: 60px; text-align: center;">开关</th>
        <th style="width: 200px;">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');

  for (const t of list) {
    const tr = el('tr');
    tr.dataset.id = t.id;
    const modeLabel = ({
      llm_headless: '无头跑',
      llm_inject:   '注入对话',
      tool_only:    '仅调工具',
    })[t.mode] || t.mode;
    // Notify channel chips — show where this task delivers results.
    const notifyChannels = Array.isArray(t.notify) ? t.notify : [];
    const notifyChips = notifyChannels.length
      ? notifyChannels.map((c) => `<span class="notify-chip notify-${c}" title="结果会推送到 ${c}">${c === 'wechat' ? '📱 微信' : '💬 对话'}</span>`).join(' ')
      : '<span class="notify-chip notify-silent" title="结果只写 task_runs 表，不推送">🔕 静默</span>';

    // Last summary peek — if the task has fired before, show first ~80 chars
    // of the most recent result summary inline (under the name) so user
    // doesn't need to click 历史 to see what happened. Click expands full.
    const lastSum = (t.last_summary || '').trim();
    const lastSumPreview = lastSum
      ? `<div class="last-sum-peek" title="${escape(lastSum.slice(0, 400))}">${escape(lastSum.slice(0, 80))}${lastSum.length > 80 ? '…' : ''}</div>`
      : '';

    // 1.4.x 任务↔策略关联(多对多): ea_name 现在是数组; 归属了策略的任务显示策略 chip
    // (多个用「、」连接); 上次因绑定的策略全未运行被跳过(summary 带 ⏸ 前缀)在 chip 上
    // 标出来, 用户一眼知道"为什么没跑"。
    const eaNames = Array.isArray(t.ea_name) ? t.ea_name : (t.ea_name ? [t.ea_name] : []);
    const eaChip = eaNames.length
      ? `<span class="tag" style="margin-left: 4px; background: rgba(90,130,240,0.15);" title="已关联策略 — 全部未运行时自动跳过, 任一启动后自动恢复">📈 ${escape(eaNames.join('、'))}${lastSum.startsWith('⏸') ? ' · 未运行' : ''}</span>`
      : '';
    tr.innerHTML = `
      <td>
        <div style="font-weight: 500; color: var(--text);">${escape(t.name)}</div>
        <div style="color: var(--text-4); font-size: 11px; font-family: var(--font-mono); margin-top: 2px;">${t.id}</div>
        ${lastSumPreview}
      </td>
      <td>
        <span class="tag ${t.kind}">${t.kind === 'cron' ? '重复' : '一次'}</span>
        <span class="tag" style="margin-left: 4px;">${escape(modeLabel)}</span>
        ${eaChip}
        <div style="margin-top: 4px;">${notifyChips}</div>
      </td>
      <td>
        <div style="color: var(--text);">${escape(humanizeSchedule(t.schedule))}</div>
        <div style="color: var(--text-4); font-size: 11px; font-family: var(--font-mono); margin-top: 2px;">${escape(t.schedule)}</div>
      </td>
      <td>${t.enabled ? fmt(t.next_fire_at) : '<span class="tag disabled">已停用</span>'}</td>
      <td>
        ${statusTag(t.last_status)}
        <span style="color: var(--text-4); font-size: 11px; margin-left: 4px;">${fmt(t.last_fire_at)}</span>
      </td>
      <td style="text-align: center;">
        <div class="toggle ${t.enabled ? 'on' : ''}" data-toggle="${t.id}"></div>
      </td>
      <td>
        <button class="btn ghost small" data-action="run" data-id="${t.id}">立即跑</button>
        <button class="btn ghost small" data-action="history" data-id="${t.id}">历史</button>
        <button class="btn danger small" data-action="del" data-id="${t.id}">删除</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  host.appendChild(table);

  table.addEventListener('click', async (e) => {
    if (e.target.classList?.contains('toggle')) {
      const tid = e.target.dataset.toggle;
      const wasOn = e.target.classList.contains('on');
      try {
        await window.easydeal.timers.toggle(tid, !wasOn);
        e.target.classList.toggle('on');
        showToast(wasOn ? '已暂停' : '已启用', 'ok');
      } catch (err) {
        showToast('切换失败：' + err.message, 'error');
      }
      return;
    }
    const action = e.target.dataset?.action;
    const id = e.target.dataset?.id;
    if (!action || !id) return;
    if (action === 'del') {
      if (!confirm('确定删除这个定时任务？历史记录会保留。')) return;
      await window.easydeal.timers.cancel(id);
      expandedIds?.delete(id);   // stop trying to re-expand a row that no longer exists
      showToast('已删除', 'ok');
      const fresh = await window.easydeal.timers.list();
      renderList(host, fresh, expandedIds);
      return;
    }
    if (action === 'run') {
      await window.easydeal.timers.runNow(id);
      showToast('已触发，2-3 秒后查看历史', 'ok');
      return;
    }
    if (action === 'history') {
      await toggleHistory(host, id, 7, expandedIds);
      return;
    }
  });
}

async function toggleHistory(host, id, colSpan = 7, expandedIds = null) {
  const taskRow = host.querySelector(`tr[data-id="${id}"]`);
  if (!taskRow) return;
  const next = taskRow.nextElementSibling;
  if (next && next.classList.contains('history-row')) {
    next.remove();
    taskRow.classList.remove('expanded');
    expandedIds?.delete(id);
    return;
  }
  await expandHistory(host, id, colSpan);
  expandedIds?.add(id);
}

/**
 * Open the history pane (no-op if already open). Used both by user clicks
 * (via toggleHistory) and by the post-refresh restoration loop that
 * re-creates panes the auto-refresh just blew away.
 */
async function expandHistory(host, id, colSpan = 7) {
  const taskRow = host.querySelector(`tr[data-id="${id}"]`);
  if (!taskRow) return;
  const next = taskRow.nextElementSibling;
  if (next && next.classList.contains('history-row')) return;  // already open
  const history = await window.easydeal.timers.history(id);
  const tr = el('tr', 'history-row');
  const td = el('td');
  td.colSpan = colSpan;
  td.appendChild(renderHistory(history, id, host));
  tr.appendChild(td);
  taskRow.parentNode.insertBefore(tr, taskRow.nextSibling);
  taskRow.classList.add('expanded');
}

function renderHistory(runs, taskId, host) {
  const wrap = el('div');
  if (!runs.length) {
    const empty = el('div', 'empty');
    empty.textContent = '还没有触发记录';
    wrap.appendChild(empty);
    return wrap;
  }
  // 顶部「清空全部」按钮
  if (taskId) {
    const head = el('div');
    head.className = 'row between';
    head.style.cssText = 'margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border-soft);';
    head.innerHTML = `
      <span style="color: var(--text-3); font-size: 12px;">${runs.length} 条触发记录</span>
      <button class="btn ghost small" data-clear-runs title="清空这个任务的所有触发记录。清空后 AI 调 get_task_history 拿不到，UI 也不再展示。">清空全部</button>
    `;
    head.querySelector('[data-clear-runs]').addEventListener('click', async () => {
      if (!confirm('清空这个任务的所有触发记录？\n\n• AI 之后调 get_task_history 拿不到\n• UI 也不再展示\n\n任务本身保留（继续按 cron 触发）。这个操作不可撤销。')) return;
      const r = await window.easydeal.timers.clearRuns(taskId);
      if (r?.ok) {
        showToast(`已清空 ${r.removed} 条`, 'ok');
        // 重新加载这一行的历史 panel
        if (host) {
          // 关再开 — toggleHistory 没暴露 + 直接重渲也不容易，干脆关掉
          const tr = host.querySelector(`tr[data-id="${taskId}"]`);
          const next = tr?.nextElementSibling;
          if (next?.classList.contains('history-row')) next.remove();
          tr?.classList.remove('expanded');
        }
      } else {
        showToast('清空失败：' + (r?.error || '未知'), 'error');
      }
    });
    wrap.appendChild(head);
  }

  for (const r of runs) {
    const item = el('div');
    item.style.padding = '10px 0';
    item.style.borderBottom = '1px dashed var(--border-soft)';
    item.innerHTML = `
      <div class="row" style="margin-bottom: 8px; gap: 10px; align-items: center;">
        ${statusTag(r.status)}
        <span style="color: var(--text-4); font-family: var(--font-mono); font-size: 11px;">started</span>
        <span style="color: var(--text-2); font-size: 12px;">${fmt(r.started_at)}</span>
        <span style="color: var(--text-4); font-family: var(--font-mono); font-size: 11px;">耗时</span>
        <span style="color: var(--text-2); font-size: 12px;">${fmtDuration(r.finished_at && r.started_at ? r.finished_at - r.started_at : 0)}</span>
        ${r.id ? `<button class="btn ghost small" data-del-run="${escape(String(r.id))}" title="删除这一条触发记录（AI 之后看不到，UI 也不再显示）" style="margin-left: auto; color: var(--text-4);">✕</button>` : ''}
      </div>
      <pre class="summary">${escape(r.result_summary || '(no output)')}</pre>
    `;
    const delBtn = item.querySelector('[data-del-run]');
    if (delBtn) {
      delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('删除这条触发记录？\n\nAI 之后调 get_task_history 拿不到，UI 也不再显示。')) return;
        const r2 = await window.easydeal.timers.deleteRun(r.id);
        if (r2?.ok) {
          item.remove();
          showToast('已删除', 'ok');
        } else {
          showToast('删除失败：' + (r2?.error || '未知'), 'error');
        }
      });
    }
    wrap.appendChild(item);
  }
  return wrap;
}

function statusTag(status) {
  if (!status) return '<span class="tag">未跑</span>';
  return `<span class="tag ${status}">${status}</span>`;
}

// Format a Date as a value usable in <input type="datetime-local">, which
// expects YYYY-MM-DDTHH:MM (no timezone, local time).
function toLocalIso(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
