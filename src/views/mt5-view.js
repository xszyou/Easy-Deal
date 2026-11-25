// MT5 view (0.3.188) — multi-instance MT5 management.
//
// 设计目标：用户可以维护多个 MT5 程序目录，每个目录单独一张卡片：
//   - 显示 name / installDir / dataDir / running / active 状态
//   - 启动 (走 launchMt5 自动判 portable)
//   - 配置（重命名 / 改路径 / 设为默认 / 备注）
//   - 删除（带 confirm，仅删 EasyDeal 这条记录，不动磁盘）
//
// "+ 添加实例" 弹层两条路径：
//   (a) 手动指定 installDir + dataDir
//   (b) 一键下载并安装 (复用 settings 已有的 OSS pipeline + 缓存检测)
//
// 主题：所有颜色走 var(--*) — light/dark 都自动适配。
//
// Phase 2（未做）：strategies 里给 EA 选 mt5_instance_id + stats-collector
// 按 instance 路由。本 view 留好 `is_active` 概念但还没接到上层。

const REFRESH_MS = 3000;

// 0.3.192: 模块级账户信息缓存. paintCards() 每 3s 重建 DOM, 没缓存的话每次都
// 闪一下「⌛ 拉账户信息中…」很丑. 缓存让 re-render 第一帧就显上次拿到的数字,
// 后台静默 fetch, 拿到新数据再无感更新该卡片. 走 instance_id key.
const _accountInfoCache = new Map();  // instance_id → { ok, data..., fetchedAt }

// 0.3.197: 模块级当前 refresh 引用 — buildCard 里按钮 click handler 用它立刻
// 触发一次重绘 (关闭/启动/设为默认 之后, 不用等 3s 心跳).
let _currentRefresh = null;
// 0.3.197: 服务端报「该实例已不在跑」的 instance_id (kill 后 N 秒内不让 fetchAndPaintAccount
// 走 mt5.initialize, 否则 SDK 会自动把 MT5 拉回来. server-side 也做了 _findMt5PidsForInstall
// 的二次校验, renderer 这层是额外保险跳过 IPC 来回).
const _justKilled = new Map();   // instance_id → timestamp (ms)
const _JUST_KILLED_GRACE_MS = 8000;

// 0.3.200: 「正在启动」状态 — 用户点「▶ 启动 MT5」后, MT5 进程要 ~3-5s 才出现,
// SDK init 还要 ~5-15s 才能成功 attach + account_info. 期间卡片显「⏳ 正在启动 MT5...」
// pulse 让用户知道在工作. _launching map 跟踪每实例的启动时间戳, fetchAndPaintAccount
// 拿到 ok=true 后清掉. 30s 后自动过期 (防永远卡住).
const _launching = new Map();   // instance_id → timestamp (ms)
const _LAUNCHING_GRACE_MS = 30 * 1000;

export function renderMt5(root) {
  root.innerHTML = '';

  // ---------- 顶栏：标题 + stats counters + 添加按钮 ----------
  const header = el('div', 'card');
  header.innerHTML = `
    <div class="section-head">
      <h2>MT5 实例</h2>
      <span class="sub">在这里管理你的多个 MT5 程序目录</span>
      <span class="spacer"></span>
      <!-- 0.3.216: 批量控制按钮 — 一键启动 / 一键停止所有非锁定状态的实例 -->
      <button class="btn ghost small" id="mt5-start-all" title="启动所有 user_intent='running' 但当前未运行的实例">▶ 全部启动</button>
      <button class="btn ghost small" id="mt5-stop-all" title="关闭所有当前运行中的实例" style="color: var(--danger);">■ 全部停止</button>
      <button class="btn ghost small" id="mt5-refresh-all">刷新</button>
      <button class="btn primary small" id="mt5-add-instance">+ 添加实例</button>
    </div>
    <p class="hint">
      EasyDeal 支持挂载多个 MT5：每个实例可以连不同 broker / 不同账户 / 跑不同的 EA 集合。
      在「我的策略」里给每个 EA 指定使用哪个实例（下一版本上线）。
    </p>
    <div class="mt5-stats-grid" id="mt5-stats-grid">
      <div class="mt5-stat">
        <div class="mt5-stat-num" id="stat-total">0</div>
        <div class="mt5-stat-label">总实例数</div>
      </div>
      <div class="mt5-stat">
        <div class="mt5-stat-num" id="stat-running" style="color: var(--success);">0</div>
        <div class="mt5-stat-label">运行中</div>
      </div>
      <div class="mt5-stat">
        <div class="mt5-stat-num" id="stat-stopped" style="color: var(--text-3);">0</div>
        <div class="mt5-stat-label">已停止</div>
      </div>
      <div class="mt5-stat">
        <div class="mt5-stat-num" id="stat-active" style="color: var(--accent, #4a9eff);">—</div>
        <div class="mt5-stat-label">当前默认</div>
      </div>
    </div>
  `;
  root.appendChild(header);

  // 0.3.286: elevation_mismatch 警告横条 — 用户 case (EasyDeal 普通权限 +
  // MT5 管理员权限 → PowerShell Win32_Process 拿不到 path → UI 显「全已停止
  // + 正在启动」 死循环). 默认 hidden, refresh() 拿到 resp.elevation_mismatch
  // 后填内容 + display=block.
  const elevBanner = el('div', 'mt5-elev-banner');
  elevBanner.id = 'mt5-elev-banner';
  elevBanner.style.cssText = 'display:none;margin:12px 0;padding:12px 16px;'
    + 'background:rgba(245,158,11,0.1);border-left:3px solid #f59e0b;'
    + 'border-radius:4px;font-size:13px;line-height:1.7;color:var(--text);';
  root.appendChild(elevBanner);

  // ---------- 卡片网格 ----------
  const grid = el('div', 'mt5-card-grid');
  grid.id = 'mt5-card-grid';
  root.appendChild(grid);

  // ---------- 注入本 view 专属样式（首次挂载时执行一次） ----------
  injectStylesOnce();

  // 0.3.203: 首次渲染立刻显加载骨架 — 列表 IPC 走 PowerShell Win32_Process 查
  // 实际进程, 5s timeout * N 实例可能要 5-10s, 期间整片空白用户感觉「页面没响应」.
  // skeleton 占位卡 + pulse 动画给个明确的「在加载」信号.
  grid.innerHTML = `
    <div class="mt5-card mt5-card-skeleton">
      <div class="mt5-card-head"><span class="mt5-card-name" style="color: var(--text-3);">⏳ 正在加载 MT5 实例…</span></div>
      <div class="mt5-card-body" style="opacity: 0.6;">
        <div class="mt5-row"><span class="mt5-row-label">程序目录</span><span class="mt5-row-val">—</span></div>
        <div class="mt5-row"><span class="mt5-row-label">数据目录</span><span class="mt5-row-val">—</span></div>
        <div class="mt5-row"><span class="mt5-row-label">已关联</span><span class="mt5-row-val">—</span></div>
      </div>
    </div>
    <div class="mt5-card mt5-card-skeleton">
      <div class="mt5-card-head"><span class="mt5-card-name" style="color: var(--text-3);">&nbsp;</span></div>
      <div class="mt5-card-body" style="opacity: 0.4;">
        <div class="mt5-row"><span class="mt5-row-label">&nbsp;</span><span class="mt5-row-val">&nbsp;</span></div>
        <div class="mt5-row"><span class="mt5-row-label">&nbsp;</span><span class="mt5-row-val">&nbsp;</span></div>
      </div>
    </div>
  `;

  // ---------- 初次拉数据 + 启动轮询 ----------
  let stopped = false;
  let _lastUnboundCount = 0;
  let _lastUnboundNames = [];   // 0.3.218
  let _lastDetectedMt5 = null;   // 0.3.289
  async function refresh() {
    if (stopped) return;
    let items = [];
    let elevMismatch = null;
    let detectedMt5 = null;
    try {
      const resp = await window.easydeal.mt5Instances.list();
      if (resp && Array.isArray(resp.items)) items = resp.items;
      else if (Array.isArray(resp)) items = resp;
      _lastUnboundCount = resp?.unbound_ea_count || 0;
      _lastUnboundNames = resp?.unbound_ea_names || [];   // 0.3.218
      elevMismatch = resp?.elevation_mismatch || null;     // 0.3.286
      detectedMt5 = resp?.detected_mt5 || null;             // 0.3.289
    } catch (e) {
      console.error('[mt5-view] list failed', e);
      grid.innerHTML = `<div class="empty">加载失败: ${escape(e?.message || e)}</div>`;
      return;
    }
    _lastDetectedMt5 = detectedMt5;
    paintStats(items);
    paintElevationBanner(elevMismatch);   // 0.3.286
    paintCards(items, _lastUnboundCount, _lastUnboundNames, detectedMt5);   // 0.3.289
  }

  // 0.3.286: render elevation_mismatch banner. null → hide. 否则填提示内容 + 显.
  function paintElevationBanner(em) {
    if (!em || !em.unknown_pid_count) {
      elevBanner.style.display = 'none';
      return;
    }
    const n = em.unknown_pid_count;
    const adminAdvice = em.advice === 'mt5_admin_easydeal_normal';
    elevBanner.innerHTML = `
      <div style="font-weight: 600; color: #b45309; margin-bottom: 6px;">
        ⚠ 检测到 ${n} 个 MT5 进程在跑, 但 EasyDeal 看不到它们的路径
      </div>
      <div style="color: var(--text-2); margin-bottom: 8px;">
        ${adminAdvice
          ? '原因 99%: <strong>MT5 用管理员权限启动, EasyDeal 用普通权限</strong>. Windows 安全策略禁止普通进程 query 高权限进程的路径 → EasyDeal 误判「全部已停止」, 实际它们都在跑.'
          : '原因待诊断 (Win32_Process 拿不到 path, 可能是权限 / 杀软拦截 / 其它).'}
      </div>
      <div style="color: var(--text-2); margin-bottom: 4px;"><strong>2 种解法 (任选):</strong></div>
      <div style="margin-left: 12px; color: var(--text-2);">
        <div style="margin-bottom: 4px;">
          <strong>A. 推荐:</strong> 关掉 EasyDeal, 右键桌面快捷方式 → 「以管理员身份运行」.
          之后两边权限对等, 卡片就能正常显示 MT5 状态了.
        </div>
        <div>
          <strong>B. 或者:</strong> 任务管理器杀掉这 ${n} 个 terminal64.exe,
          然后从 EasyDeal「MT5 tab → 启动 MT5」 按钮重新拉起来 (用普通权限).
        </div>
      </div>
      <div style="margin-top: 8px; color: var(--text-3); font-size: 11px;">
        PID: ${em.unknown_pids?.slice(0, 10).join(', ') || '?'}${em.unknown_pids?.length > 10 ? ' …' : ''}
      </div>
    `;
    elevBanner.style.display = 'block';
  }
  _currentRefresh = refresh;   // 暴露给 buildCard 按钮 handler
  await_async(refresh);

  const timer = setInterval(refresh, REFRESH_MS);
  // 卸载时（pane 切换不卸载，但保险起见挂个 cleanup）
  root._mt5Cleanup = () => { stopped = true; clearInterval(timer); };

  // ---------- 顶栏按钮 wiring ----------
  header.querySelector('#mt5-refresh-all').addEventListener('click', refresh);
  header.querySelector('#mt5-add-instance').addEventListener('click', () => openAddDialog(refresh));
  // 0.3.216: 批量控制
  header.querySelector('#mt5-start-all').addEventListener('click', async () => {
    let items = [];
    try {
      const resp = await window.easydeal.mt5Instances.list();
      items = resp?.items || [];
    } catch {}
    const toStart = items.filter((i) => !i.running && i.installDir);
    if (!toStart.length) {
      showToast('没有可启动的实例 (全部已在跑 / 无 installDir)', 'ok');
      return;
    }
    if (!confirm(`将启动 ${toStart.length} 个 MT5 实例:\n\n${toStart.map((i) => '• ' + i.name).join('\n')}\n\n继续？`)) return;
    showToast(`启动 ${toStart.length} 个 MT5…`, 'ok');
    let ok = 0, fail = 0;
    for (const inst of toStart) {
      try {
        const r = await window.easydeal.mt5Instances.launch(inst.id);
        if (r?.ok) {
          ok++;
          _launching.set(inst.id, Date.now());
          _justKilled.delete(inst.id);
        } else fail++;
      } catch { fail++; }
    }
    showToast(`✓ ${ok} 启动 · ${fail} 失败`, fail ? 'error' : 'ok');
    setTimeout(() => { try { _currentRefresh?.(); } catch {} }, 2000);
  });
  header.querySelector('#mt5-stop-all').addEventListener('click', async () => {
    let items = [];
    try {
      const resp = await window.easydeal.mt5Instances.list();
      items = resp?.items || [];
    } catch {}
    const toKill = items.filter((i) => i.running);
    if (!toKill.length) {
      showToast('没有运行中的实例', 'ok');
      return;
    }
    if (!confirm(`将关闭 ${toKill.length} 个 MT5 实例:\n\n${toKill.map((i) => '• ' + i.name).join('\n')}\n\n会强行终止 terminal64.exe，未保存的更改可能丢失。继续？`)) return;
    showToast(`关闭 ${toKill.length} 个 MT5…`, 'ok');
    let ok = 0, fail = 0;
    for (const inst of toKill) {
      try {
        const r = await window.easydeal.mt5Instances.kill(inst.id);
        if (r?.ok) {
          ok++;
          _accountInfoCache.delete(inst.id);
          _accountInfoCache.delete(inst.id + ':ever-ok');
          _justKilled.set(inst.id, Date.now());
        } else fail++;
      } catch { fail++; }
    }
    showToast(`✓ ${ok} 已关闭 · ${fail} 失败`, fail ? 'error' : 'ok');
    try { _currentRefresh?.(); } catch {}
  });

  // 返回 refresher，给 renderer 的 showTab() 在切回本 tab 时再触发一次
  return refresh;
}

// =================================================================
// stats 顶栏数字
// =================================================================
function paintStats(items) {
  const total = items.length;
  const running = items.filter((i) => i.running).length;
  const stopped = total - running;
  const active = items.find((i) => i.is_active);
  document.getElementById('stat-total').textContent = String(total);
  document.getElementById('stat-running').textContent = String(running);
  document.getElementById('stat-stopped').textContent = String(stopped);
  document.getElementById('stat-active').textContent = active ? (active.name || '—') : '—';
}

// =================================================================
// 卡片网格
// =================================================================
function paintCards(items, unboundCount = 0, unboundNames = [], detectedMt5 = null) {
  const grid = document.getElementById('mt5-card-grid');
  if (!items.length) {
    // 0.3.289: 用户 case — settings.mt5Instances 空 + settings.mt5 也丢光, 但本机
    // MT5 装在 D:\xxx (注册表 / 默认装路径 / tasklist 扫得到). 老版本只显「📭 没实例
    // 点 + 添加」, 用户根本不知道路径要怎么填. 现在 main.js 把 detected.mt5 也返过来,
    // 检测到本机有 MT5 → 显「📥 一键导入」按钮, 一点就 add 默认实例.
    let recoveryHtml = '';
    if (detectedMt5 && detectedMt5.installDir && detectedMt5.dataDir) {
      const srcHint = detectedMt5.installDirSource ? `(${escape(detectedMt5.installDirSource)})` : '';
      recoveryHtml = `
        <div class="mt5-recovery-card" style="margin: 16px auto 0; max-width: 520px; padding: 14px 18px; background: rgba(74, 158, 255, 0.08); border-left: 3px solid var(--accent, #4a9eff); border-radius: 6px; text-align: left;">
          <div style="font-size: 13px; color: var(--text-2); margin-bottom: 6px;">
            💡 EasyDeal 在本机检测到 MT5 安装位置 ${srcHint}:
          </div>
          <div style="font-family: monospace; font-size: 12px; color: var(--text); margin-bottom: 4px; word-break: break-all;">
            程序目录: ${escape(detectedMt5.installDir)}
          </div>
          ${detectedMt5.dataDir ? `<div style="font-family: monospace; font-size: 12px; color: var(--text-3); margin-bottom: 10px; word-break: break-all;">数据目录: ${escape(detectedMt5.dataDir)}</div>` : ''}
          <button class="btn primary small" id="mt5-recover-import" style="margin-top: 4px;">
            📥 一键导入为默认实例
          </button>
        </div>
      `;
    }
    grid.innerHTML = `
      <div class="empty mt5-empty">
        <div style="font-size: 38px; margin-bottom: 8px;">📭</div>
        <div>还没有任何 MT5 实例</div>
        <div style="font-size: var(--fs-sm); color: var(--text-4); margin-top: 4px;">
          点右上角「+ 添加实例」开始${detectedMt5?.installDir && detectedMt5?.dataDir ? '，或 ↓ 一键导入' : ''}
        </div>
        ${recoveryHtml}
      </div>`;
    // 0.3.289: 绑「一键导入」按钮 — 直接拿 detected 路径调 mt5Instances.add
    const importBtn = grid.querySelector('#mt5-recover-import');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        importBtn.disabled = true;
        importBtn.textContent = '导入中…';
        try {
          const r = await window.easydeal.mt5Instances.add({
            name: '默认实例',
            installDir: detectedMt5.installDir,
            dataDir: detectedMt5.dataDir,
            notes: '从 detected MT5 一键导入 (0.3.289 兜底)',
          });
          if (!r?.ok) throw new Error(r?.error || '添加失败');
          showToast('✓ 已导入默认实例 — 现在可以点「▶ 启动 MT5」了', 'ok');
          try { _currentRefresh?.(); } catch {}
        } catch (e) {
          showToast('导入失败: ' + (e?.message || e), 'error');
          importBtn.disabled = false;
          importBtn.textContent = '📥 一键导入为默认实例';
        }
      });
    }
    return;
  }
  grid.innerHTML = '';
  for (const inst of items) {
    grid.appendChild(buildCard(inst, unboundCount, unboundNames));
  }
}

function buildCard(inst, unboundCount = 0, unboundNames = []) {
  const card = el('div', 'mt5-card');
  if (inst.is_active) card.classList.add('is-active');
  // 0.3.207: 状态显示规则
  //   user_intent=stopped + 没在跑           → 🔒 用户已关闭 (灰)
  //   user_intent=stopped + 在跑 (外部启动)  → ⚠ 检测到外部启动 (黄色, 提示)
  //   user_intent=running + 在跑             → ● 运行中 (绿)
  //   user_intent=running + 没在跑           → ○ 已停止 (灰)
  const isStoppedByUser = (inst.user_intent === 'stopped');
  const externallyLaunched = !!inst.externally_launched;
  let statusChip;
  if (inst.lifecycle_state === 'error') {
    statusChip = '<span class="tag" style="color: var(--danger); border-color: rgba(255, 90, 90, 0.35);">✕ 实例错误</span>';
  } else if (externallyLaunched) {
    statusChip = '<span class="tag" style="color: var(--warn); border-color: rgba(255, 188, 51, 0.3);">⚠ 外部启动</span>';
  } else if (isStoppedByUser) {
    statusChip = '<span class="tag" style="color: var(--text-4); border-color: var(--border-soft);">🔒 已关闭 (用户)</span>';
  } else if (inst.running) {
    statusChip = '<span class="tag ok">● 运行中</span>';
  } else {
    statusChip = '<span class="tag" style="color: var(--text-4); border-color: var(--border-soft);">○ 已停止</span>';
  }
  const activeChip = inst.is_active
    ? '<span class="tag" style="color: var(--accent, #4a9eff); border-color: rgba(74, 158, 255, 0.3); margin-left: 6px;" title="默认实例 — 承接所有「↻ 默认」未绑定的 EA">★ 默认</span>'
    : '';

  card.innerHTML = `
    <div class="mt5-card-head">
      <div class="mt5-card-title">
        <span class="mt5-card-name">${escape(inst.name || '未命名实例')}</span>
        ${statusChip}${activeChip}
      </div>
      <div class="mt5-card-id" title="instance id">${escape(inst.id || '')}</div>
    </div>
    <div class="mt5-card-body">
      <div class="mt5-row">
        <span class="mt5-row-label">程序目录</span>
        <span class="mt5-row-val" title="${escape(inst.installDir || '')}">${escape(short(inst.installDir))}</span>
      </div>
      <div class="mt5-row">
        <span class="mt5-row-label">数据目录</span>
        <span class="mt5-row-val" title="${escape(inst.dataDir || '')}">${escape(short(inst.dataDir))}</span>
      </div>
      <div class="mt5-row">
        <span class="mt5-row-label">启动方式</span>
        <span class="mt5-row-val">${inst.launchMode === 'portable' ? '便携模式 /portable' : inst.launchMode === 'standard' ? '标准模式' : '未验证'}</span>
      </div>
      ${inst.lifecycle_error ? `<div style="margin:8px 0;padding:8px 10px;border-radius:5px;background:rgba(255,90,90,.08);color:var(--danger);font-size:12px;line-height:1.5;word-break:break-all;">${escape(inst.lifecycle_error)}</div>` : ''}
      ${inst.notes ? `<div class="mt5-row"><span class="mt5-row-label">备注</span><span class="mt5-row-val">${escape(inst.notes)}</span></div>` : ''}
      <div class="mt5-row">
        <span class="mt5-row-label">已关联</span>
        <span class="mt5-row-val" style="color: ${(inst.ea_count > 0 || (inst.is_active && unboundCount > 0)) ? 'var(--accent, #4a9eff)' : 'var(--text-4)'};">${_renderEaAssocText(inst, unboundCount, unboundNames)}</span>
      </div>
    </div>
    <!-- 0.3.190: 账户实时信息卡 — 0.3.192: 静默刷新, 缓存优先, 没数据时只显未运行/隐占位, 不显「拉账户信息中…」 -->
    <div class="mt5-account-card" data-account-host>
      ${_renderAccountAreaInitial(inst)}
    </div>
    <div class="mt5-card-actions">
      <!-- 0.3.207 → 0.3.216: 按 user_intent 主导按钮文案 + 暂停交易按钮永远显示
           (MT5 没在跑时 disabled, 提示用户先启动). 启动/关闭 toggle 跟以前一样
           state-aware. -->
      ${externallyLaunched
        ? `<button class="btn ghost small" data-act="adopt-external" style="color: var(--warn);">⚠ 检测到外部启动 · 切到运行</button>
           <button class="btn ghost small" data-act="kill" style="color: var(--danger);">■ 关闭它</button>`
        : isStoppedByUser
          ? `<button class="btn ghost small" data-act="launch">▶ 启动 MT5</button>`
          : inst.running
            ? `<button class="btn ghost small" data-act="kill" style="color: var(--danger);">■ 关闭 MT5</button>`
            : `<button class="btn ghost small" data-act="launch">▶ 启动 MT5</button>`}
      <!-- 0.3.220: 显示窗口 — 把 MT5 拉前台. 老版本是「暂停交易」(Ctrl+E 注入)
           在 Win11 UIPI 上不稳, 简化成只拉窗口让用户自己点工具栏开关. -->
      <button class="btn ghost small" data-act="show-window"
              ${inst.running ? '' : 'disabled title="需先启动 MT5 才能显示窗口"'}
              style="${inst.running ? '' : 'opacity:0.45;cursor:not-allowed;'}">🔍 显示窗口</button>
      <button class="btn ghost small" data-act="set-active" ${inst.is_active ? 'disabled title="已是默认实例"' : 'title="设为默认 — 所有未绑定的 EA 都走这个实例"'}>★ 设为默认</button>
      <button class="btn ghost small" data-act="open-dir">📂 打开</button>
      <button class="btn ghost small" data-act="edit">⚙ 配置</button>
      <button class="btn ghost small" data-act="remove" style="color: var(--danger);">🗑 删除</button>
    </div>
  `;

  // 0.3.195: launch/kill 二选一根据 inst.running 渲染
  const launchBtn = card.querySelector('[data-act="launch"]');
  if (launchBtn) {
    launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true;
      launchBtn.textContent = '启动中…';
      showToast(`启动 ${inst.name}…`);
      // 0.3.200: 进入「正在启动」状态 — 卡片立刻显 loading pulse, 不等 MT5 真起来
      _launching.set(inst.id, Date.now());
      _justKilled.delete(inst.id);
      try { _currentRefresh?.(); } catch {}
      try {
        const r = await window.easydeal.mt5Instances.launch(inst.id);
        if (r?.ok) {
          // 0.3.230: launchMt5 幂等检查 — already_running=true 时表示该实例本来就
          // 在跑, 没 spawn 新进程. UI 提示让用户清楚没出双进程.
          if (r.already_running) {
            showToast(`${inst.name} 本来就在运行 (pid=${r.pid})`, 'ok');
          } else {
            showToast(`✓ ${inst.name} 已启动`, 'ok');
          }
          // MT5 启动到 SDK 可响应一般要 3–8s, 给 2s 缓冲再 refresh 才能看到 ✓ 运行中
          setTimeout(() => { try { _currentRefresh?.(); } catch {} }, 2000);
        } else {
          _launching.delete(inst.id);
          showToast(`启动失败: ${r?.error || '?'}`, 'error');
          launchBtn.disabled = false;
          launchBtn.textContent = '▶ 启动 MT5';
        }
      } catch (e) {
        _launching.delete(inst.id);
        showToast(`启动失败: ${e.message}`, 'error');
        launchBtn.disabled = false;
        launchBtn.textContent = '▶ 启动 MT5';
      }
    });
  }
  const killBtn = card.querySelector('[data-act="kill"]');
  if (killBtn) {
    killBtn.addEventListener('click', async () => {
      if (!confirm(`关闭 ${inst.name} 的 MT5？\n\n会强行终止 terminal64.exe — 未保存的更改可能丢失。`)) return;
      killBtn.disabled = true;
      killBtn.textContent = '关闭中…';
      try {
        const r = await window.easydeal.mt5Instances.kill(inst.id);
        if (r?.ok) {
          showToast(r.killed > 0 ? `✓ 已关闭 ${inst.name} (${r.killed} 个进程)` : `${inst.name} 本来就没在跑`, 'ok');
          // 0.3.197: 立刻清掉这条实例的账户信息缓存 + 标记 just-killed grace, 然后强制重绘
          // 一次 (不等 3s 心跳). 让按钮从「关闭 MT5 / 恢复交易」秒切到「启动 MT5」.
          _accountInfoCache.delete(inst.id);
          _accountInfoCache.delete(inst.id + ':ever-ok');
          _justKilled.set(inst.id, Date.now());
          try { _currentRefresh?.(); } catch {}
        } else {
          showToast(`关闭失败: ${r?.error || '?'}`, 'error');
          killBtn.disabled = false;
          killBtn.textContent = '■ 关闭 MT5';
        }
      } catch (e) {
        showToast(`关闭失败: ${e.message}`, 'error');
        killBtn.disabled = false;
        killBtn.textContent = '■ 关闭 MT5';
      }
    });
  }
  // 0.3.207: 外部启动 adopt 按钮 — user_intent=stopped 但 process 在跑时显示,
  // 用户点确认 → 把 intent 翻回 running + 清 kill-flag → 让 OG / stats / account-info
  // 正常 attach
  const adoptBtn = card.querySelector('[data-act="adopt-external"]');
  if (adoptBtn) {
    adoptBtn.addEventListener('click', async () => {
      adoptBtn.disabled = true;
      adoptBtn.textContent = '切换中…';
      try {
        const r = await window.easydeal.mt5Instances.adoptExternalLaunch(inst.id);
        if (r?.ok) {
          showToast(`✓ ${inst.name} 已切回运行状态`, 'ok');
          _justKilled.delete(inst.id);
          _accountInfoCache.delete(inst.id);
          _accountInfoCache.delete(inst.id + ':ever-ok');
          try { _currentRefresh?.(); } catch {}
        } else {
          showToast(`切换失败: ${r?.error || '?'}`, 'error');
          adoptBtn.disabled = false;
        }
      } catch (e) {
        showToast(`切换失败: ${e.message}`, 'error');
        adoptBtn.disabled = false;
      }
    });
  }

  // 0.3.220: 「🔍 显示窗口」— 把 MT5 拉前台. 老版本 0.3.195~0.3.219 是「暂停
  // 交易」(注入 Ctrl+E 切算法交易开关), Win11 UIPI 上不稳定 + tradeapi_disabled
  // 反弹问题, 干掉了改成简单的窗口拉前台.
  const showWinBtn = card.querySelector('[data-act="show-window"]');
  if (showWinBtn) {
    showWinBtn.addEventListener('click', async () => {
      showWinBtn.disabled = true;
      const origText = showWinBtn.textContent;
      showWinBtn.textContent = '切换中…';
      try {
        const r = await window.easydeal.mt5Instances.showWindow(inst.id);
        if (r?.ok) {
          showToast(`✓ ${inst.name} 已显示`, 'ok');
        } else {
          // 0.3.223: 失败时弹 alert 显完整 raw_error 让用户能截图反馈, toast 太短看不清
          const hint = r?.hint || r?.error || '?';
          if (r?.raw_error) {
            alert(`「${inst.name}」显示失败\n\n原因: ${hint}\n\n—— 详细错误 (诊断用) ——\n${r.raw_error}`);
            console.warn(`[show-window ${inst.name}] raw:`, r.raw_error);
          } else {
            showToast(`显示失败: ${hint}`, 'error');
          }
        }
      } catch (e) {
        showToast(`显示失败: ${e.message}`, 'error');
      } finally {
        showWinBtn.disabled = false;
        showWinBtn.textContent = origText;
      }
    });
  }

  card.querySelector('[data-act="set-active"]').addEventListener('click', async () => {
    try {
      await window.easydeal.mt5Instances.setActive(inst.id);
      showToast(`已切到「${inst.name}」`, 'ok');
      window.dispatchEvent(new CustomEvent('mt5-instance-changed', { detail: { id: inst.id } }));
    } catch (e) {
      showToast(`切换失败: ${e.message}`, 'error');
    }
  });

  card.querySelector('[data-act="open-dir"]').addEventListener('click', async () => {
    try {
      // 复用 settings 暴露的 shell.openPath；这里没有直接 IPC，简化为复制到剪贴板
      await navigator.clipboard.writeText(inst.installDir || '');
      showToast('已复制路径到剪贴板，去资源管理器粘贴即可', 'ok');
    } catch (e) {
      showToast(`复制失败: ${e.message}`, 'error');
    }
  });

  card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditDialog(inst));
  card.querySelector('[data-act="remove"]').addEventListener('click', async () => {
    if (!confirm(`删除 MT5 实例「${inst.name}」？\n\n只会删 EasyDeal 这边的记录，不会动磁盘上的 MT5 目录。`)) return;
    try {
      await window.easydeal.mt5Instances.remove(inst.id);
      showToast('已删除', 'ok');
    } catch (e) {
      showToast(`删除失败: ${e.message}`, 'error');
    }
  });

  // 0.3.190 → 0.3.192: 静默拉账户信息 (运行中实例才拉).
  // 0.3.207: 用户主动 intent=stopped 时也不拉 (即使 process 在外部跑) — 等用户
  // 点「⚠ 切到运行」adopt 后再拉. 否则会把外部 MT5 的账户信息当作「自己的」展示,
  // 跟用户「我把它关了」的预期不符.
  if (inst.running && inst.user_intent !== 'stopped') {
    // 0.3.220: 按钮换成「🔍 显示窗口」, 不再依赖 trade_allowed 切按钮文案
    fetchAndPaintAccount(card, inst);
  }

  return card;
}

/** 0.3.197: 已关联 EA 文案 — 之前死写「+ 默认承接未绑定 EA」让用户不知道实际有几只.
 *  0.3.218: 显具体 EA 名字, 不再只显数字. 名字过多时折叠成「A, B 等共 N 个」+ title 全列.
 *  口径:
 *    - 该实例有绑定 EA → 「绑定: ea1, ea2」(全名 hover 看)
 *    - active 实例 → 加「· 默认承接: ea3, ea4」(M=0 时省掉这截)
 *    - 啥都没 → 「未绑定任何 EA」 */
function _renderEaAssocText(inst, unboundCount, unboundNames = []) {
  const boundNames = Array.isArray(inst.ea_names) ? inst.ea_names : [];
  const bound = inst.ea_count || boundNames.length || 0;
  const parts = [];
  if (bound > 0) {
    parts.push(`绑定: ${_formatEaNames(boundNames, bound)}`);
  }
  if (inst.is_active && unboundCount > 0) {
    parts.push(`默认承接: ${_formatEaNames(unboundNames, unboundCount)}`);
  }
  if (!parts.length) {
    if (inst.is_active) return '0 个 EA (默认实例自动承接未绑定 EA)';
    return '0 个绑定 EA';
  }
  return parts.join(' · ');
}

/** 0.3.218: 把 EA 名字数组渲染成短文案; 超过 3 个折叠成「a, b 等共 N 个」 (hover 显完整) */
function _formatEaNames(names, total) {
  if (!Array.isArray(names) || !names.length) {
    return `${total || 0} 个`;
  }
  const esc = (s) => String(s || '').replace(/</g, '&lt;');
  if (names.length <= 3) {
    return names.map(esc).join(', ');
  }
  const head = names.slice(0, 2).map(esc).join(', ');
  const fullList = names.map(esc).join(', ');
  return `<span title="${fullList}">${head} 等共 ${names.length} 个</span>`;
}

/** 0.3.192 → 0.3.198: 卡片账户区 HTML — 不再区分「未运行」/「没缓存」/「有数据」三种
 *  不同 UI 状态, 统一走 _renderAccountAreaFromData(): 始终渲染完整账户卡片结构 (login /
 *  server / 余额 / 净值 / 浮动盈亏 / 杠杆), 没数据时显「—」占位 + 顶部小字标「○ 未连接」.
 *  好处:
 *    - 运行 / 停止状态卡片高度一致, 不抖
 *    - 启动 MT5 后实时数据直接灌进同一个 grid, 用户不会感觉到 layout shift, 是「静默更新」
 *    - 出错时也保留结构 (顶部状态行写原因), 不消失成「○ XX 错误」一行字 */
function _renderAccountAreaInitial(inst) {
  const cached = _accountInfoCache.get(inst.id);
  // 1. 有成功缓存 → 直接显数据 (用户切 tab 回来不闪占位)
  if (cached?.ok) {
    // 拿到 ok 数据 → 清掉「正在启动」flag
    _launching.delete(inst.id);
    return _renderAccountAreaFromData(cached);
  }
  // 2. 0.3.200: 用户刚点过启动 (30s grace) — 显 loading 状态 (即使 inst.running 还没翻成 true)
  const launchTs = _launching.get(inst.id);
  if (launchTs && Date.now() - launchTs < _LAUNCHING_GRACE_MS) {
    return _renderAccountAreaFromData(null, { status: '⏳ 正在启动并连接 MT5…', loading: true });
  }
  if (launchTs) _launching.delete(inst.id);   // 30s 后自动过期
  // 3. 0.3.218: 实例没在跑 → 优先显**最后已知账户数据** (灰色) 而不是空 — 用户反馈
  //   下载/删除/暂停期间数据消失太突兀, 改成显「(已停止) 上次 余额 $X」让用户
  //   还能看到关掉前的状态. 拿不到快照才退回老占位.
  if (!inst.running) {
    const snap = _accountInfoCache.get(inst.id + ':lastOk');
    if (snap?.ok) {
      const ageMin = Math.round((Date.now() - (snap.snapshotAt || 0)) / 60000);
      const ageTxt = ageMin < 1 ? '刚刚' : ageMin < 60 ? `${ageMin} 分钟前` : `${Math.round(ageMin/60)} 小时前`;
      return _renderAccountAreaFromData(snap, {
        status: `○ 已停止 · 显示 ${ageTxt} 的快照`,
        snapshot: true,
      });
    }
    return _renderAccountAreaFromData(null, { status: '○ 未运行' });
  }
  // 4. 在跑但缓存失败过 → 占位卡片 + 错误状态行
  if (cached && !cached.ok) {
    const reason = cached.err === 'init_failed'
      ? '⏳ MT5 SDK 初始化中…'
      : `○ ${cached.err || cached.error || '账户信息暂不可用'}`;
    return _renderAccountAreaFromData(null, { status: reason, loading: cached.err === 'init_failed' });
  }
  // 5. 在跑 + 完全没缓存 (首帧) → 占位卡片 + loading「正在连接…」
  return _renderAccountAreaFromData(null, { status: '⏳ 正在连接 MT5…', loading: true });
}

/** 0.3.192: 拿账户信息 (走 5s TTL 缓存) + 静默更新 DOM. */
async function fetchAndPaintAccount(card, inst) {
  const host = card.querySelector('[data-account-host]');
  if (!host) return;
  // 0.3.197: 刚 kill 过 (8s grace 内) 完全跳过 — 防 server-side 万一漏判跑 mt5.initialize 把 MT5 拉回来
  const killedTs = _justKilled.get(inst.id);
  if (killedTs && Date.now() - killedTs < _JUST_KILLED_GRACE_MS) {
    return;
  }
  let r = null;
  try {
    r = await window.easydeal.mt5Instances.accountInfo(inst.id);
  } catch (e) {
    r = { ok: false, error: String(e?.message || e) };
  }
  // 缓存这次结果 (含失败) → 下次 paintCards 重建时第一帧用缓存渲染, 不闪
  _accountInfoCache.set(inst.id, { ...(r || {}), fetchedAt: Date.now() });
  // 拉失败时, 如果之前有成功的缓存就保持显示老数据 (不闪 error 文案 — broker
  // 网络抖一下 / SDK 临时忙都算正常); 完全没成功过才显占位.
  if (!r?.ok) {
    const everOk = _accountInfoCache.get(inst.id + ':ever-ok');
    if (everOk) return;   // 保持现有 UI 不动
    // 0.3.198: 失败也保留同款 grid 结构, 顶部状态行写原因, 不再换成单行 mt5-account-empty
    const reason = r?.err === 'init_failed'
      ? '○ MT5 SDK 初始化中…'
      : `○ ${r?.err || r?.error || '账户信息暂不可用'}`;
    host.innerHTML = _renderAccountAreaFromData(null, { status: reason });
    return;
  }
  _accountInfoCache.set(inst.id + ':ever-ok', true);
  // 0.3.218: 持久化「最后一次成功的账户快照」给 stopped 状态显示用 — 单独 key
  // 避免被失败结果覆盖. 加 snapshotAt 算"几分钟前快照"的展示用.
  _accountInfoCache.set(inst.id + ':lastOk', { ...r, snapshotAt: Date.now() });
  // 0.3.200: 拿到首次成功 ok 数据 → 清「正在启动」 grace, 卡片自然切到真实数据视图
  _launching.delete(inst.id);
  host.innerHTML = _renderAccountAreaFromData(r);
  // 0.3.220: 按钮换成「🔍 显示窗口」后不再需要根据 trade_allowed 动态切按钮文案
}

// 0.3.220: _updateAutoTradeButton 已删除 — 按钮换成「🔍 显示窗口」, 不再需要
// 按 trade_allowed / tradeapi_disabled 动态切按钮文案. Python script 返这两
// 个字段还在 (无害), 后续可能用于卡片 chip 提示, 但不再绑按钮行为.

/** 0.3.192 → 0.3.198: 复用账户信息渲染 HTML — initial paint 跟 fetch 后 update 用同一份模板.
 *  r=null → 占位模式 (login/server/数字全显「—」, 顶部显 status 行如「○ 未运行」)
 *  r 有数据 → 显真实账户号 + 余额 + 净值 + 浮动盈亏 + 杠杆 */
function _renderAccountAreaFromData(r, opts = {}) {
  const placeholder = !r;
  const isLoading = placeholder && opts.loading === true;
  const fmt = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const balance = placeholder ? '—' : fmt(Number(r.balance) || 0);
  const equity  = placeholder ? '—' : fmt(Number(r.equity)  || 0);
  const profit  = placeholder ? null : (Number(r.profit) || 0);
  const profitColor = profit === null ? 'var(--text-3)'
    : (profit > 0 ? 'var(--success)' : (profit < 0 ? 'var(--danger)' : 'var(--text-3)'));
  const profitText = profit === null ? '—' : `${profit > 0 ? '+' : ''}${fmt(profit)}`;
  const login = placeholder ? '—' : String(r.login);
  const server = placeholder ? (opts.status || '') : (r.server || '');
  const currency = placeholder ? '' : (r.currency || '');
  const leverage = placeholder ? '—' : String(r.leverage || '—');
  // 0.3.218: 累计盈利 (balance - net_funding) + 点差 (持仓 symbol 平均)
  const cumProfit = placeholder ? null : (typeof r.cumulative_profit === 'number' ? r.cumulative_profit : null);
  const cumProfitColor = cumProfit === null ? 'var(--text-3)'
    : (cumProfit > 0 ? 'var(--success)' : (cumProfit < 0 ? 'var(--danger)' : 'var(--text-3)'));
  const cumProfitText = cumProfit === null ? '—' : `${cumProfit > 0 ? '+' : ''}${fmt(cumProfit)}`;
  const spread = placeholder ? null : (typeof r.avg_spread === 'number' ? r.avg_spread : null);
  const spreadText = spread === null ? '—' : (Number.isInteger(spread) ? String(spread) : spread.toFixed(1));
  // 顶部 status (placeholder 时显, 比如「○ 未运行」/「⏳ 正在启动…」). 有数据时省掉.
  // 0.3.200: isLoading 时加 is-loading class 触发 pulse 动画
  // 0.3.218: snapshot 模式 — 数据是真的 (r 有值) 但 MT5 已停, 显灰色 + 顶部加 status banner
  const isSnapshot = !placeholder && opts.snapshot === true;
  return `
    <div class="mt5-account-grid ${placeholder ? 'is-placeholder' : ''} ${isLoading ? 'is-loading' : ''}"
         ${isSnapshot ? 'style="opacity:0.6;"' : ''}>
      ${isSnapshot ? `<div style="grid-column: 1 / -1; font-size: var(--fs-sm); color: var(--text-3); padding-bottom: 4px;">${escape(opts.status || '')}</div>` : ''}
      <div class="mt5-account-head">
        <span class="mt5-account-login">${placeholder ? '' : '#'}${escape(login)}</span>
        <span class="mt5-account-server" title="${escape(server)}">${escape(server)}</span>
      </div>
      <div class="mt5-account-stats">
        <div class="mt5-account-stat">
          <div class="mt5-account-label">余额</div>
          <div class="mt5-account-val">${escape(balance)} <span class="mt5-account-ccy">${escape(currency)}</span></div>
        </div>
        <div class="mt5-account-stat">
          <div class="mt5-account-label">净值</div>
          <div class="mt5-account-val">${escape(equity)}</div>
        </div>
        <div class="mt5-account-stat" title="累计已实现盈利 = 当前余额 - 净入金 (含所有出/入金)">
          <div class="mt5-account-label">累计盈利</div>
          <div class="mt5-account-val" style="color: ${cumProfitColor};">${escape(cumProfitText)}</div>
        </div>
        <div class="mt5-account-stat">
          <div class="mt5-account-label">浮动盈亏</div>
          <div class="mt5-account-val" style="color: ${profitColor};">${escape(profitText)}</div>
        </div>
        <div class="mt5-account-stat">
          <div class="mt5-account-label">杠杆</div>
          <div class="mt5-account-val">1:${escape(leverage)}</div>
        </div>
        <div class="mt5-account-stat" title="当前持仓 symbol 平均点差 (points). 没持仓显 —">
          <div class="mt5-account-label">点差</div>
          <div class="mt5-account-val">${escape(spreadText)}</div>
        </div>
      </div>
    </div>
  `;
}

// =================================================================
// 添加实例：modal
// =================================================================
const BROKER_SIGNUP_URL = 'https://one.exnessonelink.com/a/r6fx3vgje1';

function openAddDialog(onDone) {
  const overlay = el('div', 'mt5-modal-overlay');
  overlay.innerHTML = `
    <div class="mt5-modal">
      <div class="mt5-modal-head">
        <h3 style="margin:0;">添加 MT5 实例</h3>
        <button class="btn ghost small" data-close>✕</button>
      </div>
      <div class="mt5-modal-body">
        <div class="mt5-tabs">
          <button class="mt5-tab active" data-tab="manual">📁 指定本地路径</button>
          <button class="mt5-tab" data-tab="signup">🆕 还没有交易账户？</button>
        </div>

        <!-- TAB 1: 手动 -->
        <div class="mt5-tab-pane active" data-pane="manual">
          <label class="mt5-field">
            <span class="mt5-field-label">实例名 <span style="color:var(--text-4);">（自己取，比如「主账户」「IC Markets 02」）</span></span>
            <input type="text" id="add-name" placeholder="例如：IC Markets 主账户" />
          </label>
          <label class="mt5-field">
            <span class="mt5-field-label">MT5 程序目录</span>
            <div class="mt5-field-row">
              <input type="text" id="add-install-dir" placeholder="C:\\Program Files\\MetaTrader 5" readonly />
              <button class="btn ghost small" id="add-install-browse">浏览…</button>
            </div>
          </label>
          <label class="mt5-field">
            <span class="mt5-field-label">数据目录 <span style="color:var(--text-4);">（必选；便携模式选程序目录本身，标准模式选 AppData 的 32 位目录）</span></span>
            <div class="mt5-field-row">
              <input type="text" id="add-data-dir" placeholder="必须选择，客户端会校验归属" readonly />
              <button class="btn ghost small" id="add-data-browse">浏览…</button>
            </div>
          </label>
          <label class="mt5-field">
            <span class="mt5-field-label">备注 <span style="color:var(--text-4);">（可选）</span></span>
            <input type="text" id="add-notes" placeholder="例如：跑黄金 EA 的实例" />
          </label>
        </div>

        <!-- TAB 2: 开户与安装 MT5 -->
        <div class="mt5-tab-pane" data-pane="signup" style="display:none;">
          <p style="color: var(--text-3); font-size: var(--fs-md); line-height: 1.6;">
            EasyDeal 需要一个 MT5 交易账户和本机安装的 MT5 终端。建议先开<strong>模拟账户</strong>熟悉策略，确认风险后再考虑实盘。
          </p>
          <ol style="color: var(--text-3); font-size: var(--fs-md); line-height: 1.8; padding-left: 20px;">
            <li>注册券商账户：<a href="#" data-ext="broker">打开 Exness 开户页</a>，在个人专区开立 MT5 模拟账户，记下账号、密码和服务器。</li>
            <li>在券商个人专区下载并安装 MT5 终端。</li>
            <li>安装完成后回到「📁 指定本地路径」，选择 MT5 的程序目录和数据目录。</li>
          </ol>
          <p style="color: var(--text-4); font-size: var(--fs-sm); line-height: 1.6;">
            开户链接带有开发者的推荐码。外汇和贵金属保证金交易风险很高，请确认所在地区允许参与，并只投入能承受损失的资金。
          </p>
        </div>
      </div>
      <div class="mt5-modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="add-submit">添加</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });

  // Tab 切换
  const tabs = overlay.querySelectorAll('.mt5-tab');
  const panes = overlay.querySelectorAll('.mt5-tab-pane');
  let currentTab = 'manual';
  tabs.forEach((t) => t.addEventListener('click', () => {
    currentTab = t.dataset.tab;
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    panes.forEach((p) => {
      const on = p.dataset.pane === currentTab;
      p.classList.toggle('active', on);
      p.style.display = on ? '' : 'none';
    });
    const sb = overlay.querySelector('#add-submit');
    sb.style.display = currentTab === 'signup' ? 'none' : '';
  }));

  // ---- 手动 tab: 浏览按钮 ----
  overlay.querySelector('#add-install-browse').addEventListener('click', async () => {
    const dir = await window.easydeal.settings.browseDir({ title: '选择 MT5 程序目录 (含 terminal64.exe)' });
    if (dir) overlay.querySelector('#add-install-dir').value = dir;
  });
  overlay.querySelector('#add-data-browse').addEventListener('click', async () => {
    const dir = await window.easydeal.settings.browseDir({ title: '选择 MT5 数据目录 (含 MQL5/Config/Profiles)' });
    if (dir) overlay.querySelector('#add-data-dir').value = dir;
  });

  // ---- 开户 tab: 外部链接 ----
  overlay.querySelector('[data-ext="broker"]')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    window.easydeal.app.openExternal(BROKER_SIGNUP_URL);
  });

  // ---- 提交 ----
  overlay.querySelector('#add-submit').addEventListener('click', async () => {
    if (currentTab === 'manual') {
      const name = overlay.querySelector('#add-name').value.trim();
      const installDir = overlay.querySelector('#add-install-dir').value.trim();
      const dataDir = overlay.querySelector('#add-data-dir').value.trim();
      const notes = overlay.querySelector('#add-notes').value.trim();
      if (!name) { showToast('请填写实例名', 'error'); return; }
      if (!installDir) { showToast('请选择 MT5 程序目录', 'error'); return; }
      if (!dataDir) { showToast('请选择 MT5 数据目录；不能再用程序目录自动代替', 'error'); return; }
      try {
        const r = await window.easydeal.mt5Instances.add({ name, installDir, dataDir, notes });
        if (r?.ok === false) throw new Error(r.error || '添加失败');
        showToast('✓ 已添加', 'ok');
        close();
        onDone?.();
      } catch (e) {
        showToast(`添加失败: ${e.message}`, 'error');
      }
      return;
    }

  });

  // 自动 focus 第一个输入
  setTimeout(() => overlay.querySelector('#add-name')?.focus(), 50);
}

// =================================================================
// 配置实例：modal
// =================================================================
function openEditDialog(inst) {
  const overlay = el('div', 'mt5-modal-overlay');
  overlay.innerHTML = `
    <div class="mt5-modal">
      <div class="mt5-modal-head">
        <h3 style="margin:0;">配置实例</h3>
        <button class="btn ghost small" data-close>✕</button>
      </div>
      <div class="mt5-modal-body">
        <label class="mt5-field">
          <span class="mt5-field-label">实例名</span>
          <input type="text" id="ed-name" value="${escape(inst.name || '')}" />
        </label>
        <label class="mt5-field">
          <span class="mt5-field-label">MT5 程序目录</span>
          <div class="mt5-field-row">
            <input type="text" id="ed-install" value="${escape(inst.installDir || '')}" readonly />
            <button class="btn ghost small" id="ed-install-browse">浏览…</button>
          </div>
        </label>
        <label class="mt5-field">
          <span class="mt5-field-label">数据目录</span>
          <div class="mt5-field-row">
            <input type="text" id="ed-data" value="${escape(inst.dataDir || '')}" readonly />
            <button class="btn ghost small" id="ed-data-browse">浏览…</button>
          </div>
        </label>
        <label class="mt5-field">
          <span class="mt5-field-label">备注</span>
          <input type="text" id="ed-notes" value="${escape(inst.notes || '')}" />
        </label>
      </div>
      <div class="mt5-modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="ed-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  overlay.querySelector('#ed-install-browse').addEventListener('click', async () => {
    const dir = await window.easydeal.settings.browseDir({ title: '选择 MT5 程序目录' });
    if (dir) overlay.querySelector('#ed-install').value = dir;
  });
  overlay.querySelector('#ed-data-browse').addEventListener('click', async () => {
    const dir = await window.easydeal.settings.browseDir({ title: '选择 MT5 数据目录' });
    if (dir) overlay.querySelector('#ed-data').value = dir;
  });

  overlay.querySelector('#ed-save').addEventListener('click', async () => {
    const patch = {
      name:       overlay.querySelector('#ed-name').value.trim() || inst.name,
      installDir: overlay.querySelector('#ed-install').value.trim(),
      dataDir:    overlay.querySelector('#ed-data').value.trim(),
      notes:      overlay.querySelector('#ed-notes').value.trim(),
    };
    try {
      await window.easydeal.mt5Instances.update(inst.id, patch);
      showToast('✓ 已保存', 'ok');
      close();
    } catch (e) {
      showToast(`保存失败: ${e.message}`, 'error');
    }
  });
}

// =================================================================
// CSS（首次挂载时注入 <style>）
// =================================================================
function injectStylesOnce() {
  if (document.getElementById('mt5-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'mt5-view-styles';
  style.textContent = `
    /* ---- stats counters ---- */
    .mt5-stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .mt5-stat {
      background: var(--overlay-1);
      border: 1px solid var(--border-soft);
      border-radius: var(--radius);
      padding: 12px 16px;
      text-align: center;
    }
    .mt5-stat-num {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--text);
      line-height: 1.2;
    }
    .mt5-stat-label {
      font-size: var(--fs-sm);
      color: var(--text-3);
      margin-top: 4px;
    }

    /* ---- card grid ---- */
    .mt5-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 14px;
    }
    .mt5-card {
      background: var(--surface-100, var(--overlay-1));
      border: 1px solid var(--border-soft);
      border-radius: var(--radius-lg);
      padding: 16px 18px;
      box-shadow: var(--ring);
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: border-color 0.15s, transform 0.15s;
    }
    .mt5-card:hover { border-color: var(--border-softer); }
    .mt5-card.is-active {
      border-color: rgba(74, 158, 255, 0.4);
      box-shadow: 0 0 0 1px rgba(74, 158, 255, 0.15), var(--ring);
    }
    .mt5-card-head {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mt5-card-title {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .mt5-card-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }
    .mt5-card-id {
      font-size: 10px;
      color: var(--text-4);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    .mt5-card-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      background: var(--overlay-1);
      border-radius: var(--radius);
    }
    .mt5-row {
      display: flex;
      gap: 10px;
      font-size: var(--fs-sm);
      align-items: baseline;
    }
    .mt5-row-label {
      color: var(--text-4);
      flex: 0 0 64px;
    }
    .mt5-row-val {
      color: var(--text-2);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
      flex: 1;
    }
    .mt5-card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .mt5-card-actions .btn { flex: 1 1 auto; min-width: 0; }

    .mt5-empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 60px 20px;
      color: var(--text-3);
    }

    /* 0.3.203: skeleton 加载占位卡 — 首次 list IPC 还没返时显, pulse 动画提示「在加载」 */
    .mt5-card-skeleton {
      animation: mt5-skeleton-pulse 1.4s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes mt5-skeleton-pulse {
      0%, 100% { opacity: 0.85; }
      50%      { opacity: 0.55; }
    }

    /* 0.3.190: 实例卡片 — 账户实时信息 sub-card.
       0.3.192: 静默刷新 — placeholder 用透明背景留位, 拿到数据后无感切到正式样式, 不闪「拉账户信息中…」
       0.3.198: 始终渲染完整 grid 结构, 占位模式只是把数字换 — + 顶部状态行写「○ 未运行」, 不再
                单独整 mt5-account-empty 把卡片缩成一行 — 用户切运行/停止状态不抖. */
    .mt5-account-card {
      margin-top: 6px;
      padding: 10px 12px;
      border: 1px solid var(--border-soft);
      border-radius: var(--radius);
      background: var(--overlay-2);
    }
    /* 占位模式 (mt5.initialize 没起来 / 实例未运行) — 数字 dim 到 text-4, 不抢眼 */
    .mt5-account-grid.is-placeholder .mt5-account-login,
    .mt5-account-grid.is-placeholder .mt5-account-val {
      color: var(--text-4);
    }
    .mt5-account-grid.is-placeholder .mt5-account-server {
      color: var(--text-3);
      font-style: italic;
    }
    /* 0.3.200: 「正在启动 / 正在连接」状态 — 整张卡片轻微 pulse, status 字体加粗 + accent 色 */
    .mt5-account-grid.is-loading .mt5-account-server {
      color: var(--accent, #4a9eff);
      font-style: normal;
      font-weight: 500;
      animation: mt5-pulse 1.4s ease-in-out infinite;
    }
    @keyframes mt5-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }
    /* legacy classes — 0.3.198 起没人用了 (但保留 CSS 防回退到老 HTML 时炸) */
    .mt5-account-loading, .mt5-account-empty {
      font-size: var(--fs-sm);
      color: var(--text-4);
      text-align: center;
      padding: 4px 0;
    }
    .mt5-account-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-soft);
    }
    .mt5-account-login {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }
    .mt5-account-server {
      font-size: 11px;
      color: var(--text-3);
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mt5-account-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);   /* 0.3.218: 4→6 个 stat, 改 3 列 */
      gap: 4px 8px;                             /* 行间 4 列间 8, 排紧一点 */
    }
    .mt5-account-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;                             /* 防止内容撑爆 grid 列 */
    }
    .mt5-account-label {
      font-size: 10.5px;
      color: var(--text-4);
      letter-spacing: 0.3px;
    }
    .mt5-account-val {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 12.5px;                        /* 0.3.218: 缩 0.5px 让 3 列不挤 */
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mt5-account-ccy {
      font-size: 10px;
      color: var(--text-4);
      font-weight: 400;
    }

    /* ---- modal ---- */
    .mt5-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 9000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .mt5-modal {
      background: var(--surface-100);
      border: 1px solid var(--border-soft);
      border-radius: var(--radius-lg);
      width: min(560px, 100%);
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
      overflow: hidden;
    }
    .mt5-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-soft);
    }
    .mt5-modal-body {
      padding: 16px 18px;
      overflow-y: auto;
      flex: 1;
    }
    .mt5-modal-foot {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 18px;
      border-top: 1px solid var(--border-soft);
    }
    .mt5-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border-soft);
    }
    .mt5-tab {
      background: transparent;
      border: none;
      color: var(--text-3);
      padding: 8px 14px;
      cursor: pointer;
      font-family: inherit;
      font-size: var(--fs-md);
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
    }
    .mt5-tab:hover { color: var(--text-2); }
    .mt5-tab.active {
      color: var(--text);
      border-bottom-color: var(--accent, #4a9eff);
    }
    .mt5-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .mt5-field-label {
      font-size: var(--fs-sm);
      color: var(--text-3);
    }
    .mt5-field input[type="text"] {
      background: var(--overlay-1);
      border: 1px solid var(--border-soft);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 7px 10px;
      font-family: inherit;
      font-size: var(--fs-md);
      width: 100%;
      box-sizing: border-box;
    }
    .mt5-field input[type="text"]:focus {
      outline: none;
      border-color: var(--accent, #4a9eff);
    }
    .mt5-field-row {
      display: flex;
      gap: 8px;
    }
    .mt5-field-row input[type="text"] { flex: 1; }
    .mt5-progressbar {
      height: 8px;
      background: var(--overlay-2);
      border-radius: 4px;
      overflow: hidden;
    }
    .mt5-progressbar > div {
      height: 100%;
      width: 0%;
      background: var(--accent, #4a9eff);
      transition: width 0.2s, background 0.2s;
    }
  `;
  document.head.appendChild(style);
}

// =================================================================
// 工具函数
// =================================================================
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
function short(p) {
  if (!p) return '—';
  if (p.length <= 48) return p;
  // C:\foo\bar\..\baz\quux  →  C:\foo\…\baz\quux
  return p.slice(0, 18) + '…' + p.slice(-26);
}
function showToast(msg, kind = 'ok') {
  if (typeof window.showToast === 'function') window.showToast(msg, kind);
  else console.log('[mt5 toast]', kind, msg);
}
// renderMt5 是 sync export 但内部要 await — 用这个小 wrapper 在 fire-and-forget
// 模式下跑一次首屏拉数据（再由 setInterval 接管）。
function await_async(fn) {
  Promise.resolve().then(fn).catch((e) => console.error('[mt5-view] initial refresh failed', e));
}
