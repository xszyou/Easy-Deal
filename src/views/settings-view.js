// Settings view — MT5 paths, EasyDeal MCP script, Python interpreter,
// MT5 process status, install guide trigger.

const POLL_MS = 30_000;

export async function renderSettings(root) {
  root.innerHTML = '';
  let info = await window.easydeal.app.info();
  let settings = await window.easydeal.settings.get();

  // ---------- top: status banner ----------
  const banner = el('div', 'banner');
  banner.style.display = 'none';
  root.appendChild(banner);

  // ---------- card: 授权信息 (license + version + update check) ----------
  const licenseCard = el('div', 'card');
  licenseCard.innerHTML = `
    <div class="section-head">
      <h2>关于</h2>
      <span class="sub">EasyDeal 社区版</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="onboarding-rerun" title="跳到对话页让 AI 用 7 步引导帮你重走一遍配置流程（MT5 路径 / 数据目录 / EA 部署 / 策略说明 / 监控任务）">🤖 AI 指引配置</button>
    </div>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>社区版</label>
      </div>
      <div class="settings-input-row" style="font-size: var(--fs-md); color: var(--text-3); line-height: 1.7; display: block;">
        免费开源的单机版：本机的 AI 值守、策略管理、护航、定时巡检、资讯和教程。不需要序列号，不上传交易数据。
        <div style="margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn ghost small" id="about-repo">开源仓库</button>
        </div>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>客户端版本</label>
        <span class="settings-source" id="lic-update-tag"></span>
      </div>
      <div class="settings-input-row" style="font-family: var(--font-mono); font-size: var(--fs-md); color: var(--text-3);">
        <span id="lic-version-line">v${escape(info.version || '0.1.0')}</span>
      </div>
    </div>

    <div id="lic-update-detail" class="bt-acct-instructions" style="display: none;"></div>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>设置备份</label>
        <span class="settings-source" title="settings 持久化在 %APPDATA%\\EasyDeal\\data\\settings.json，覆盖安装新版不会丢；下面这俩是给手动卸载-重装、换电脑等场景的保险">在这台电脑上 = 安全</span>
      </div>
      <div class="settings-input-row" style="gap: 8px;">
        <button class="btn ghost small" id="settings-export">导出到文件…</button>
        <button class="btn ghost small" id="settings-import">从文件导入…</button>
      </div>
    </div>

    </div>
  `;
  root.appendChild(licenseCard);
  licenseCard.querySelector('#about-repo').addEventListener('click', () => {
    window.easydeal.app.openExternal('https://github.com/xszyou/Easy-Deal');
  });

  // ---------- card: all-model context window ----------
  let tokenCfg = await window.easydeal.token.get();
  const contextCard = el('div', 'card');
  contextCard.innerHTML = `
    <div class="section-head">
      <h2>AI 上下文窗口</h2>
      <span class="sub">所有模型统一设置</span>
    </div>
    <div class="settings-row">
      <div class="settings-row-head">
        <label>窗口模式 <span class="settings-hint">达到约 85% 时自动摘要并新建底层会话</span></label>
        <span class="settings-source auto" id="ctx-source">自动</span>
      </div>
      <div class="settings-input-row" style="gap:8px;align-items:center;">
        <select id="ctx-mode" style="width:180px;">
          <option value="auto">自动（推荐）</option>
          <option value="manual">手动</option>
        </select>
        <input id="ctx-window-tokens" type="number" min="16000" max="1000000" step="10000"
          style="width:180px;font-family:var(--font-mono);" aria-label="上下文窗口 Token 数">
        <span class="muted">Token</span>
        <button class="btn primary small" id="ctx-save">保存</button>
      </div>
      <div class="settings-hint" style="margin-top:8px;line-height:1.65;">
        对系统 Claude、Fay、自定义接口和 Codex CLI 全部生效。该值控制 EasyDeal 的自动压缩边界，
        不会提高模型自身的硬上限；Codex CLI 会同步调整本地 Bridge 的字符保护线。
      </div>
    </div>
  `;
  root.appendChild(contextCard);

  const paintContext = () => {
    const ctx = tokenCfg?.context || { mode: 'auto', window_tokens: 200000 };
    const mode = ctx.mode === 'manual' ? 'manual' : 'auto';
    contextCard.querySelector('#ctx-mode').value = mode;
    const input = contextCard.querySelector('#ctx-window-tokens');
    input.dataset.manualValue = String(ctx.window_tokens || 200000);
    paintContextInput(mode);
    const source = contextCard.querySelector('#ctx-source');
    const serverWindow = Number(ctx.server_window_tokens) || 0;
    source.textContent = mode === 'manual'
      ? `手动 · ${Number(ctx.window_tokens).toLocaleString()} Token`
      : (serverWindow > 0
        ? `自动 · 服务器返回 ${serverWindow.toLocaleString()} Token`
        : '自动 · 服务器未返回');
    source.className = `settings-source ${mode === 'manual' ? 'set' : 'auto'}`;
  };
  const paintContextInput = (mode) => {
    const input = contextCard.querySelector('#ctx-window-tokens');
    if (mode === 'manual') {
      input.disabled = false;
      input.value = input.dataset.manualValue || '200000';
      input.placeholder = '';
      return;
    }
    const serverWindow = Number(tokenCfg?.context?.server_window_tokens) || 0;
    input.disabled = true;
    input.value = serverWindow > 0 ? String(serverWindow) : '';
    input.placeholder = serverWindow > 0 ? '' : '服务器未返回';
  };
  contextCard.querySelector('#ctx-mode').addEventListener('change', (event) => {
    paintContextInput(event.target.value);
  });
  contextCard.querySelector('#ctx-save').addEventListener('click', async () => {
    const mode = contextCard.querySelector('#ctx-mode').value;
    const windowTokens = Number(contextCard.querySelector('#ctx-window-tokens').value);
    if (mode === 'manual' && (!Number.isInteger(windowTokens) || windowTokens < 16000 || windowTokens > 1000000)) {
      showToast('手动上下文窗口必须是 16,000–1,000,000 Token', 'error');
      return;
    }
    try {
      const patch = mode === 'manual' ? { mode, window_tokens: windowTokens } : { mode };
      tokenCfg = await window.easydeal.token.setContext(patch);
      paintContext();
      showToast(mode === 'manual' ? '全局上下文窗口已保存' : '已恢复自动上下文窗口', 'ok');
    } catch (error) {
      showToast('保存失败：' + (error?.message || String(error)), 'error');
    }
  });
  paintContext();

  // -------- 诊断快照上传 — 弹模态收集问题描述 + 截图 ----------
  licenseCard.querySelector('#settings-diag-upload')?.addEventListener('click', () => {
    showDiagnosticReportModal(licenseCard.querySelector('#settings-diag-msg'));
  });

  // -------- 设置 导出 / 导入 ----------
  licenseCard.querySelector('#settings-export').addEventListener('click', async () => {
    const r = await window.easydeal.settings.exportFile();
    if (r.canceled) return;
    if (r.ok) showToast('已导出：' + r.path, 'ok');
    else showToast('导出失败：' + (r.error || '未知'), 'error');
  });
  licenseCard.querySelector('#settings-import').addEventListener('click', async () => {
    if (!confirm('从文件导入设置？\n\n会跟当前设置 merge（不清空，文件里的字段覆盖同名项）。\n如果想完全用文件里的值，请先在该文件外手动清空 %APPDATA%\\EasyDeal\\data\\settings.json。')) return;
    const r = await window.easydeal.settings.importFile();
    if (r.canceled) return;
    if (r.ok) {
      showToast('已导入：' + r.path + '；正在重新检测路径…', 'ok');
      // 更新本视图的 settings 引用 — 让监控配置 / MT5 卡片立刻看到新值
      settings = await window.easydeal.settings.get();
      info = await window.easydeal.app.info();
      paintInputs();
    } else {
      showToast('导入失败：' + (r.error || '未知'), 'error');
    }
  });

  licenseCard.querySelector('#lic-copy')?.addEventListener('click', async () => {
    const k = licenseCard.querySelector('#lic-key').value;
    if (!k) return;
    try {
      await navigator.clipboard.writeText(k);
      showToast('序列号已复制', 'ok');
    } catch (e) {
      showToast('复制失败：' + e.message, 'error');
    }
  });
  licenseCard.querySelector('#lic-logout')?.addEventListener('click', async () => {
    // 0.4.42: 高级选项从「重置本机 machine_id」改成「解除本机绑定」。
    // 解除绑定 = 调 server 清掉 license 的 bound_machine_id, 这只序列号可以
    // 在新机器激活。典型场景：换电脑 / 把序列号让给别人。原「重置 machine_id」
    // 选项功能下沉到撞号场景, 普通用户用不到, 暴露在主入口反而误导。
    const sure = window.confirm(
      '确定退出当前序列号吗？\n\n'
      + '【确定】= 退出 — 接下来会问你是否要「解除本机绑定」\n'
      + '【取消】= 放弃'
    );
    if (!sure) return;
    const unbind = window.confirm(
      '是否同时解除本机绑定？\n\n'
      + '【确定】= 解除 — 用于换电脑 / 把序列号让给别人；解除后这只序列号可以\n'
      + '   在新机器激活（本机也能再激活回来，但要重新登录绑定）\n\n'
      + '【取消】= 不解除 — 只退出登录，序列号仍绑定本机（推荐：你还要在本机用）'
    );
    const btn = licenseCard.querySelector('#lic-logout');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '退出中…';
    try {
      const r = await window.easydeal.app.licenseLogout({ unbindMachine: !!unbind });
      if (r?.ok) {
        showToast(
          unbind
            ? '已退出 + 解除本机绑定，1-2 秒后自动重启…'
            : '已退出序列号，1-2 秒后自动重启…',
          'ok',
        );
      } else {
        showToast('退出失败：' + (r?.error || '未知'), 'error');
        btn.disabled = false;
        btn.textContent = orig;
      }
    } catch (e) {
      showToast('退出失败：' + (e?.message || String(e)), 'error');
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  licenseCard.querySelector('#onboarding-rerun').addEventListener('click', async () => {
    // 跟首次激活序列号自动跑的 7 步引导用同一条 IPC（app:request-onboarding）。
    // 不管这条 license 之前有没有跑过，按下来都立刻 fire 一遍 prompt + 切到对话页。
    // 注：会触发对话历史新增一条用户 turn（onboarding prompt 本身），如果你
    // 在意这条干扰，先点对话页右上角「新会话」清干净再点这里。
    const btn = licenseCard.querySelector('#onboarding-rerun');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '正在发起…';
    try {
      const r = await window.easydeal.app.requestOnboarding();
      if (r?.ok) {
        showToast('已发起首次配置引导，切到「AI」标签页跟 AI 一步步走', 'ok');
        if (typeof window.showTab === 'function') window.showTab('chat');
      } else {
        showToast(r?.error || '发起失败', 'error');
      }
    } catch (e) {
      showToast('发起失败：' + (e?.message || String(e)), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // 0.4.6: 升级日志按钮 —— 弹 modal 显示当前安装版本的 release_notes
  licenseCard.querySelector('#lic-changelog')?.addEventListener('click', async () => {
    const btn = licenseCard.querySelector('#lic-changelog');
    btn.disabled = true; btn.textContent = '加载中…';
    let r;
    try {
      r = await window.easydeal.app.getReleaseNotes();
    } catch (e) {
      r = { ok: false, error: String(e?.message || e) };
    }
    btn.disabled = false; btn.textContent = '📜 升级日志';

    const overlay = document.createElement('div');
    overlay.className = 'mkt-modal';
    if (!r?.ok) {
      const errMsg = r?.message || r?.error || '未知错误';
      overlay.innerHTML = `
        <div class="mkt-modal-body" style="max-width: 560px;">
          <div class="row between" style="margin-bottom: 12px;">
            <h2 style="margin: 0;">📜 升级日志 · v${escape(r?.version || '?')}</h2>
            <button class="btn ghost small" data-close>✕</button>
          </div>
          <div class="banner banner-warn"><span class="banner-dot"></span>
            <span>${escape(errMsg)}</span>
          </div>
          <div class="hint" style="margin-top: 10px; font-size: var(--fs-sm);">
            可能原因：你装的是测试 build / 内部 build，没在服务器注册过；或者这版被 admin 下架了。
          </div>
        </div>
      `;
    } else {
      const notes = r.release_notes || '（该版本没填升级日志）';
      const pub = r.published_at ? new Date(r.published_at).toLocaleString('zh-CN', { hour12: false }) : '—';
      overlay.innerHTML = `
        <div class="mkt-modal-body" style="max-width: 680px; max-height: 78vh; overflow-y: auto;">
          <div class="row between" style="margin-bottom: 6px;">
            <h2 style="margin: 0;">📜 升级日志 · v${escape(r.version)} ${r.mandatory ? '<span class="tag" style="color: var(--danger); border-color: rgba(239,68,68,0.3); margin-left: 6px; font-size: 11px;">强制更新</span>' : ''}</h2>
            <button class="btn ghost small" data-close>✕</button>
          </div>
          <div class="hint" style="margin: 0 0 10px; font-size: var(--fs-sm); color: var(--text-3);">发版时间：${escape(pub)}</div>
          <pre style="white-space: pre-wrap; margin: 0; font-size: var(--fs-md); color: var(--text); line-height: 1.7; font-family: inherit;">${escape(notes)}</pre>
        </div>
      `;
    }
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
    });
  });

  licenseCard.querySelector('#lic-check-update')?.addEventListener('click', async () => {
    const btn = licenseCard.querySelector('#lic-check-update');
    btn.disabled = true; btn.textContent = '检查中…';
    try {
      const r = await window.easydeal.app.checkUpdate();
      const tag = licenseCard.querySelector('#lic-update-tag');
      const detail = licenseCard.querySelector('#lic-update-detail');
      if (!r.ok) {
        tag.innerHTML = `<span class="tag error">检查失败</span>`;
        detail.style.display = 'block';
        detail.textContent = r.error || '检查更新失败';
        return;
      }
      if (r.has_update) {
        tag.innerHTML = `<span class="tag" style="color: var(--warn); border-color: rgba(255,188,51,0.3);">有新版本 ${escape(r.latest)}</span>`;
        detail.style.display = 'block';
        detail.innerHTML = `
          <div style="font-weight: 500; color: var(--text); margin-bottom: 6px;">v${escape(r.latest)} ${r.mandatory ? '<span class="tag" style="color: var(--danger); border-color: rgba(239,68,68,0.3);">强制更新</span>' : ''}</div>
          <pre style="white-space: pre-wrap; margin: 0 0 8px; font-size: var(--fs-md); color: var(--text-2);">${escape(r.release_notes || '（暂无更新说明）')}</pre>
          ${r.download_url ? `<button class="btn primary small" id="lic-update-go">下载并安装</button>` : ''}
        `;
        // Wire the new modal-based download flow. The button-with-onclick
        // route from before opened a fresh Electron window via window.open
        // and silently no-op'd in the packaged app.
        const goBtn = detail.querySelector('#lic-update-go');
        if (goBtn) {
          goBtn.addEventListener('click', async () => {
            const ui = await import('../updater-ui.js');
            ui.showUpdateModal({
              current: r.current,
              latest: {
                version:       r.latest,
                channel:       r.channel || 'alpha',
                download_url:  r.download_url,
                portable_url:  r.portable_url,
                sha256:        r.sha256,
                size:          r.size_bytes || r.size,
                release_notes: r.release_notes,
                mandatory:     r.mandatory,
              },
              mandatory: !!r.mandatory,
            });
          });
        }
      } else {
        tag.innerHTML = `<span class="tag ok">已是最新</span>`;
        detail.style.display = 'block';
        detail.textContent = `当前版本 v${r.current} 是最新的。`;
      }
    } finally {
      btn.disabled = false; btn.textContent = '检查更新';
    }
  });


  // ---------- card: MT5 ----------
  // 0.3.223: 已被「MT5」tab (多实例管理) 完全替代, 这张卡隐藏掉. 不删 HTML
  // 是因为后面一堆 JS handler / paint 路径仍 query #mt5-* 元素 — 隐藏比删
  // 工程量小 + 风险低. 老用户 settings.mt5.installDir/dataDir 字段保留, 作为
  // MT5 tab 的默认 fallback 实例 (mt5Instances[0]).
  const mt5Card = el('div', 'card');
  mt5Card.style.display = 'none';
  mt5Card.innerHTML = `
    <div class="section-head">
      <h2>MT5 终端</h2>
      <span class="sub">trading terminal</span>
      <span class="spacer"></span>
      <span id="mt5-status-tag"><span class="tag">检测中…</span></span>
      <button class="btn ghost small" id="mt5-redetect" title="重新跑自动检测（注册表 / 进程 / 常用路径）">重新检测</button>
      <button class="btn ghost small" id="mt5-refresh">刷新状态</button>
    </div>
    <p class="hint">EasyDeal 通过这里指定的 MT5 接收行情、读持仓、下单 / 改单 / 平仓（按你授权）。客户端会自动检测安装位置；找不到时手动指定即可。</p>
    <p class="hint" style="color: var(--brand, #ff6363); margin-top: -4px;">⚠ 这里指的是「你日常交易用的那个 MT5」 —— 接的是<strong>实盘账号还是模拟盘账号取决于你登录哪个</strong>。如果你接的是实盘，AI 的所有持仓 / 订单操作都会作用在<strong>真实资金</strong>上，请慎重。策略风洞回测使用离线 Tick 行情。</p>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>安装目录 <span class="settings-hint">含 terminal64.exe 的目录</span></label>
        <span class="settings-source" id="mt5-install-source"></span>
      </div>
      <div class="settings-input-row">
        <input type="text" id="mt5-install-input" style="flex: 1;">
        <button class="btn ghost small" id="mt5-install-browse">浏览…</button>
        <button class="btn ghost small" id="mt5-install-reset" title="清除自定义值，恢复自动检测">⟲</button>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>数据目录 <span class="settings-hint">MQL5/Experts 所在的 user data 目录，可空</span></label>
        <span class="settings-source" id="mt5-data-source"></span>
      </div>
      <div class="settings-input-row">
        <input type="text" id="mt5-data-input" style="flex: 1;">
        <button class="btn ghost small" id="mt5-data-browse">浏览…</button>
        <button class="btn ghost small" id="mt5-data-reset" title="清除自定义值，恢复自动检测">⟲</button>
      </div>
    </div>

    <div class="row" style="gap: 10px; margin-top: 12px; flex-wrap: wrap;">
      <button class="btn primary" id="mt5-launch">启动 MT5 终端</button>
      <button class="btn ghost"   id="mt5-guide">让 AI 给我安装指引</button>
      <button class="btn ghost"   id="mt5-probe" title="多 MT5 同时跑时 Python SDK 不一定能绑到上面设的那个，点这个跑一次实测：SDK 真实连到的是哪个 broker / 账号 / 品种">🔌 检查 SDK 连接</button>
      <button class="btn ghost"   id="mt5-save">保存修改</button>
    </div>
    <div id="mt5-install-progress" style="display: none; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--overlay-5); border-radius: 6px; background: var(--overlay-1); font-size: var(--fs-md); line-height: 1.7;">
      <div id="mt5-install-phase" style="font-weight: 600; margin-bottom: 6px;"></div>
      <div style="height: 8px; background: var(--overlay-3); border-radius: 4px; overflow: hidden;">
        <div id="mt5-install-bar" style="height: 100%; background: var(--accent, #4a9eff); width: 0%; transition: width 0.2s;"></div>
      </div>
      <div id="mt5-install-detail" class="muted small" style="margin-top: 6px; font-family: var(--font-mono);"></div>
    </div>
    <div id="mt5-probe-result" style="display: none; margin-top: 10px; padding: 10px 12px; border-radius: 4px; font-size: var(--fs-md); line-height: 1.7;"></div>
  `;
  root.appendChild(mt5Card);

  // 0.3.336: 删掉「监控配置」card. per-EA 的 symbol/magic 已经在「我的策略」
  // 表 inline 编辑 (0.3.124) + mounted-state.json 持久化 (0.3.271).
  // 全局监控配置 (XAUUSD 系列默认) 在多 broker 场景下会让用户填错 (XAUUSDc 跟
  // broker 实际 XAUUSDm 不一致 → AI 撞「品种不存在」). 砍掉.
  const monitorCard = null;
  if (false) {
  const _legacyMonitorCard = el('div', 'card');
  _legacyMonitorCard.innerHTML = `
    <div class="section-head">
      <h2>监控配置</h2>
      <span class="sub">实盘 跟踪哪些品种 / magic / 阈值</span>
    </div>
    <p class="hint">
      给 EasyDeal MCP 喂的过滤器 — AI 调 <code>get_trading_status</code> / <code>get_positions</code>
      时只统计这些品种 + magic 的仓位。默认值是黄金（XAUUSD 系列）；做其他品种**必须**改这里，否则报「品种不存在」。
      风控阈值不在这里 — 在「定时任务」里建 cron 任务做（见知识库 <code>knowledge/client-help/03-定时任务.md</code>）。
    </p>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>品种 <span class="settings-hint">逗号分隔，从前到后试，第一个 broker 上存在的就用。常见后缀：Exness 加 m/c，IC Markets 加 .m</span></label>
      </div>
      <div class="settings-input-row">
        <input type="text" id="monitor-symbols-input" placeholder="GOLD,GOLD#,XAUUSD,XAUUSDm,XAUUSDc" style="flex: 1; font-family: var(--font-mono);">
        <button class="btn ghost small" id="monitor-symbols-reset" title="恢复默认（黄金系列）">⟲</button>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-head">
        <label>魔术号（magic）<span class="settings-hint">EA 在 OnInit 里用 trade.SetExpertMagicNumber() 设的那个数字</span></label>
      </div>
      <div class="settings-input-row">
        <input type="text" id="monitor-magic-input" placeholder="999" style="flex: 1; font-family: var(--font-mono);">
        <button class="btn ghost small" id="monitor-magic-reset" title="恢复默认 999">⟲</button>
      </div>
    </div>

    <details style="margin-top: 10px; font-size: var(--fs-md);">
      <summary class="muted" style="cursor: pointer;">高级：注释包含 / 排除（按 position.comment 过滤）</summary>
      <div class="hint" style="margin: 6px 0 8px;">逗号分隔。EA 多个共享一个 magic 时用 comment 区分。</div>
      <div class="settings-row">
        <div class="settings-row-head"><label>包含（任一命中就追踪）</label></div>
        <input type="text" id="monitor-comment-contains-input" placeholder="留空 = 不按 comment 过滤" style="width: 100%; font-family: var(--font-mono);">
      </div>
      <div class="settings-row" style="margin-top: 8px;">
        <div class="settings-row-head"><label>排除（任一命中就忽略）</label></div>
        <input type="text" id="monitor-comment-excludes-input" placeholder="留空 = 不排除任何" style="width: 100%; font-family: var(--font-mono);">
      </div>
    </details>

    <div class="row" style="gap: 10px; margin-top: 12px;">
      <button class="btn ghost" id="monitor-save">保存修改</button>
      <span class="muted" style="font-size: var(--fs-md); align-self: center;">保存后 AI 下一条对话起生效（MCP env 重写）</span>
    </div>
  `;
  // root.appendChild(_legacyMonitorCard);   // 0.3.336: 不再 append
  }   // end if (false)

  // ---------- card: EasyDeal MCP + Claude Code ----------
  // (Removed user-facing inputs — three paths are auto-resolved at runtime
  // from the bundled installation:
  //   • EasyDeal MCP script   → resources/app.asar.unpacked/python/easydeal_mcp_server.py
  //   • Python 解释器         → resources/app.asar.unpacked/python-runtime/python.exe
  //   • 窗口截图 MCP          → resources/app.asar.unpacked/python/window_capture/server.py
  // Detection logic in electron/settings.js still allows env-var / settings.json
  // overrides for power users; just no UI for it now. Users with a fresh
  // install have nothing to configure.)

  // (实盘 MT5 登录 卡片移除：跟「MT5 终端」卡的「启动 MT5 终端」按钮重复，
  //  并且 LOGIN/SERVER 字段只是本地存储，不会被注入到 MT5 自己的登录对话框。
  //  实盘账号管理由 MT5 自己负责 — 我们只检测它在不在跑。)

  const btEnvCard = el('div', 'card');
  btEnvCard.innerHTML = `
    <div class="section-head"><h2>策略风洞回测</h2></div>
    <p class="hint">在「策略 → 回测」按周回放真实 Tick。内置 Exness XAUUSDm 行情；
      自定义品种从工作区 <code>analysis/ticks/品种名/</code> 读取。</p>
      <div style="margin-top: 14px; padding: 10px 12px; border: 1px solid var(--border-soft, #2a2a2a); border-radius: 6px; background: var(--overlay-1);">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;" id="bt-notify-ai-label">
          <input id="bt-notify-ai" type="checkbox" style="vertical-align: middle;">
          <span style="font-weight: 500;">回测完通知 AI：跑完后 AI 自动看结果继续优化</span>
          <span id="bt-notify-ai-badge" style="font-size: var(--fs-xs); padding: 1px 6px; border-radius: 8px; background: rgba(255,188,51,0.15); color: var(--warn); display: none;">条件未满足</span>
        </label>
        <div class="hint" style="font-size: var(--fs-sm); margin-top: 4px; margin-left: 22px;" id="bt-notify-ai-hint">
          max 用户才能使用。
        </div>
      </div>
  `;

  // 0.3.99: AI 风控独立 ANTHROPIC_API_KEY 卡片移除 —— OrderGuard 拦截模式的
  // LLM 评估现在直接复用主 AI 通道（「Token」tab 配的 Fay / custom / system），
  // 用户不需要再单独申请 / 维护一个 Anthropic key。Python 端 _call_anthropic_llm
  // 读 spawn env 注入的 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL + ANTHROPIC_MODEL
  // （token-store.spawnEnvOverrides() 同款），跟 chat / scheduler spawn 路径一致。

  // ---------- card: 微信通知 (iLink HTTP) ----------
  const wxCard = el('div', 'card');
  wxCard.innerHTML = `
    <div class="section-head">
      <h2>微信通知</h2>
      <span class="sub">iLink Bot · QR 登录</span>
      <span class="spacer"></span>
      <span id="wx-status-tag"><span class="tag">检测中…</span></span>
      <button class="btn ghost small" id="wx-refresh">刷新</button>
    </div>
    <p class="hint">
      用微信扫码绑一个 iLink Bot 账号（腾讯官方 AI 网关，<strong>不需要本地 PC 微信跑</strong>）。
      绑定后 AI / 调度器可以推消息给你；微信侧的对话也独立成一条 session（0.1.62+，跨重启不丢上下文）。
      <br>凭据保存在 <code>%APPDATA%\\easydeal-client\\data\\wechat-session\\</code>，重启免登录。
    </p>

    <!-- LOGGED OUT: QR login area -->
    <div id="wx-login-area" style="display: none; margin-top: 12px;">
      <div class="row wrap" style="gap: 16px; align-items: flex-start;">
        <div id="wx-qr-frame" style="width: 200px; height: 200px; background: white; border: 1px solid var(--border-soft); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #6a6b6c; font-size: var(--fs-md); padding: 8px; text-align: center;">
          点 →「刷新」获取扫码二维码
        </div>
        <div style="flex: 1; min-width: 240px;">
          <div class="row" style="gap: 6px;">
            <button class="btn primary" id="wx-qr-fetch">刷新</button>
            <button class="btn ghost small" id="wx-qr-reset" title="清掉本地登录缓存（卡在 binded_redirect 等异常时用）">重置本地状态</button>
          </div>
          <div id="wx-qr-status" class="hint" style="margin-top: 8px;">未开始</div>
          <details id="wx-qr-debug-wrap" style="margin-top: 6px; font-size: var(--fs-sm); display: none;">
            <summary class="muted" style="cursor: pointer;">诊断信息（卡住或登录失败时给开发者看）</summary>
            <pre id="wx-qr-debug" style="white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; background: var(--surface-100); padding: 6px; border-radius: 4px; margin-top: 4px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-3);"></pre>
          </details>
          <div id="wx-verify-area" style="display: none; margin-top: 8px;">
            <label style="display: block;">微信弹窗里的验证码</label>
            <div class="row" style="gap: 6px;">
              <input id="wx-verify-code" placeholder="0000" maxlength="6" style="width: 110px; font-family: var(--font-mono); font-size: 16px; letter-spacing: 4px;">
              <button class="btn ghost small" id="wx-verify-submit">提交</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- LOGGED IN: send test area -->
    <!-- 0.3.21: 简化 UI — 99% 用例是发给自己，wxid 字段挪进折叠的高级
         section，主 UI 只留内容 + 发送测试 + 注销 -->
    <div id="wx-send-area" style="display: none; margin-top: 12px;">
      <!-- 0.3.41: 激活会话提示 — iLink 网关设计：bot 不能主动发消息给用户，
           必须用户**先在微信里给 bot 发一条消息**激活会话通道。否则后续
           send 会返 code=-2「未知错误」。新登录用户必须做这步，用户撞过。 -->
      <div id="wx-activate-hint" style="margin-bottom: 12px; padding: 10px 12px; border-left: 3px solid var(--accent, #4a9eff); background: rgba(74,158,255,0.08); border-radius: 0 6px 6px 0; font-size: var(--fs-md); line-height: 1.6;">
        <b style="color: var(--accent, #4a9eff);">⚡ 第一次登录必须先做这步：</b>
        在你手机微信里找到刚扫码绑定的 <b>ClawBot</b> 账号，**发任意一条消息**（比如「在」），激活会话通道。<br>
        <span class="muted">背景：iLink 网关不允许 bot 主动给"陌生"用户发消息，必须用户先开口。不做这步的话下面「发送测试」会失败（code=-2 未知错误）。</span>
      </div>

      <div class="field">
        <label>测试发送（发给你自己）</label>
        <textarea id="wx-msg" rows="2" style="width: 100%;">EasyDeal 测试消息（来自客户端设置页）</textarea>
      </div>
      <div class="row" style="gap: 8px;">
        <button class="btn primary" id="wx-send">发送测试</button>
        <span class="spacer" style="flex:1;"></span>
        <button class="btn ghost"   id="wx-logout">注销登录</button>
      </div>
      <div id="wx-send-result" style="color: var(--text-3); font-size: var(--fs-md); margin-top: 8px;"></div>
      <details style="margin-top: 10px; font-size: var(--fs-sm);">
        <summary class="muted" style="cursor: pointer;">高级：发给其他 wxid（调试 cron / AI 推送给别人时填）</summary>
        <div class="field" style="margin-top: 6px;">
          <label>收件人 wxid <span class="muted">(留空 = 发给绑定本机的账号 = 你自己)</span></label>
          <input id="wx-to" placeholder="例如 wxid_xxxxx 或 o9c...@im.wechat — 普通用户留空就行" style="width: 100%; font-family: var(--font-mono);">
        </div>
      </details>
    </div>

    <div id="wx-status-detail" style="margin-top: 10px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-4);"></div>
  `;

  function paintWxStatus(s) {
    const tag = wxCard.querySelector('#wx-status-tag');
    const det = wxCard.querySelector('#wx-status-detail');
    const loginArea = wxCard.querySelector('#wx-login-area');
    const sendArea  = wxCard.querySelector('#wx-send-area');
    if (!s) {
      tag.innerHTML = '<span class="tag error">未启动</span>';
      det.textContent = 'sidecar 未启动';
      loginArea.style.display = 'none';
      sendArea.style.display = 'none';
      return;
    }
    if (s.logged_in) {
      tag.innerHTML = '<span class="tag ok">已登录</span>';
      const lines = [];
      if (s.user_id)    lines.push('user_id: ' + s.user_id);
      if (s.account_id) lines.push('bot_id:  ' + s.account_id);
      if (s.base_url)   lines.push('gateway: ' + s.base_url);
      det.innerHTML = lines.join('<br>');
      loginArea.style.display = 'none';
      sendArea.style.display = 'block';
    } else {
      if (s.error) {
        tag.innerHTML = '<span class="tag error">异常</span>';
        det.textContent = s.error;
      } else {
        tag.innerHTML = '<span class="tag" style="color: var(--warn); border-color: rgba(255,188,51,0.3);">未登录</span>';
        det.textContent = '点下面「刷新」获取扫码二维码开始绑定';
      }
      loginArea.style.display = 'block';
      sendArea.style.display = 'none';
    }
  }

  async function refreshWxStatus(force = false) {
    paintWxStatus(await (force ? window.easydeal.wechat.refresh()
                                : window.easydeal.wechat.status()));
  }
  refreshWxStatus();
  wxCard.querySelector('#wx-refresh').addEventListener('click', () => refreshWxStatus(true));
  window.easydeal.wechat.onStatus(paintWxStatus);

  // ---- QR login flow ----
  let _qrPollAbort = false;

  // 0.3.41: rewritten for 李军 case — 微信登录卡住时报错不清楚 +
  // 没自动跟 binded_redirect / scaned_but_redirect。新行为：
  //  1. QR 失败 / 轮询失败时把原始 response 塞进诊断区（用户截图给我看）
  //  2. binded_redirect / scaned_but_redirect 自动清缓存并重新拉 QR
  //     （最多 3 次，避免死循环）
  //  3. expired 自动重拉新 QR 而不是要用户再点「刷新」
  //  4. 新增「重置本地状态」按钮，遇到其它疑难杂症时手动用
  function _writeDebug(obj) {
    const wrap = wxCard.querySelector('#wx-qr-debug-wrap');
    const pre  = wxCard.querySelector('#wx-qr-debug');
    if (!wrap || !pre) return;
    wrap.style.display = 'block';
    const ts = new Date().toLocaleTimeString();
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    pre.textContent = `[${ts}]\n${text}\n\n` + pre.textContent;
  }
  function _clearDebug() {
    const wrap = wxCard.querySelector('#wx-qr-debug-wrap');
    const pre  = wxCard.querySelector('#wx-qr-debug');
    if (wrap) wrap.style.display = 'none';
    if (pre)  pre.textContent = '';
  }

  async function startQrLogin(_attempt = 0) {
    _qrPollAbort = false;
    const frame = wxCard.querySelector('#wx-qr-frame');
    const statusEl = wxCard.querySelector('#wx-qr-status');
    const verifyArea = wxCard.querySelector('#wx-verify-area');
    verifyArea.style.display = 'none';
    if (_attempt === 0) _clearDebug();

    statusEl.textContent = _attempt > 0
      ? `获取二维码中…（重试 ${_attempt}）`
      : '获取二维码中…';
    frame.innerHTML = '<span style="color: #6a6b6c;">加载中…</span>';

    const r = await window.easydeal.wechat.loginQr();
    if (!r?.ok || !r.qrcode_token) {
      statusEl.innerHTML = '<span style="color: #ef4444;">获取二维码失败：' +
        (r?.error || '未知') + '</span><br>' +
        '<span class="muted">如果一直失败，点「重置本地状态」后再试；网络不通的话检查防火墙是否拦截 ilinkai.weixin.qq.com</span>';
      frame.innerHTML = '<span style="color: #ef4444;">失败</span>';
      _writeDebug({ stage: 'login-qr', resp: r });
      return;
    }
    const src = r.qrcode_png || r.qrcode_url;
    frame.innerHTML = `<img src="${src}" style="max-width: 100%; max-height: 100%; image-rendering: pixelated;">`;
    statusEl.innerHTML = '请用微信扫描左侧二维码 …';

    const token = r.qrcode_token;
    let verifyCode = '';
    while (!_qrPollAbort) {
      const p = await window.easydeal.wechat.loginPoll(token, verifyCode);
      verifyCode = '';
      if (!p?.ok) {
        statusEl.innerHTML = '<span style="color: #ef4444;">轮询出错：' +
          (p?.error || '未知') + '</span>';
        _writeDebug({ stage: 'login-poll', resp: p });
        return;
      }
      const st = p.status;
      if (st === 'confirmed') {
        // 0.3.238: 绑定完二维码就清掉, 提示用户向 ClawBot 发测试消息验证.
        // 之前 QR 图一直显着, 用户不知道下一步该做啥.
        frame.innerHTML =
          '<div style="font-size: 56px; line-height: 1; color: #22c55e;">✓</div>' +
          '<div style="margin-top: 8px; color: #22c55e; font-size: 13px; font-weight: 500;">已绑定</div>';
        statusEl.innerHTML =
          '<div style="color: var(--success); font-size: 14px; font-weight: 500; margin-bottom: 8px;">✓ 微信已绑定 (user_id=' + (p.user_id || '?') + ')</div>' +
          '<div style="line-height: 1.7;">下一步：打开微信，找到联系人「<strong>微信ClawBot</strong>」，' +
          '<strong>发一条任意测试消息</strong>（比如「你好」）验证收发链路。' +
          'EasyDeal 会自动转给 AI 处理后回你 — 看到回复就说明全套打通了。</div>' +
          '<div class="muted small" style="margin-top: 6px;">没看到「微信ClawBot」？需先在微信里关注公众号 / 加好友，过程跟普通微信好友一样。</div>';
        refreshWxStatus(true);
        return;
      }
      if (st === 'wait') {
        statusEl.textContent = '等待你扫码…';
      } else if (st === 'scaned') {
        statusEl.textContent = '已扫码，请在手机上点确认…';
      } else if (st === 'expired') {
        if (_attempt >= 3) {
          statusEl.innerHTML = '<span style="color: var(--warn);">二维码反复过期，请稍后再试或点「重置本地状态」</span>';
          _writeDebug({ stage: 'poll', status: 'expired', attempts: _attempt });
          return;
        }
        statusEl.innerHTML = '<span class="muted">二维码过期，自动刷新中…</span>';
        return startQrLogin(_attempt + 1);
      } else if (st === 'need_verifycode') {
        statusEl.innerHTML = '<span style="color: var(--warn);">需要 4 位验证码 — 见手机微信弹窗</span>';
        verifyArea.style.display = 'block';
        verifyCode = await new Promise((resolve) => {
          const btn = wxCard.querySelector('#wx-verify-submit');
          const handler = () => {
            const v = wxCard.querySelector('#wx-verify-code').value.trim();
            if (v) { btn.removeEventListener('click', handler); resolve(v); }
          };
          btn.addEventListener('click', handler);
        });
        verifyArea.style.display = 'none';
        statusEl.textContent = '提交验证码中…';
      } else if (st === 'scaned_but_redirect' || st === 'binded_redirect') {
        // 0.3.41: 服务端说要换网关。老逻辑直接放弃让用户手动点刷新，
        // 实际效果是死循环（同一个 wechat 账号还是会被重定向到同一个
        // host）。新逻辑：清掉本地 token + 重新拉 QR，让 sidecar 重置一遍。
        _writeDebug({ stage: 'poll', status: st, raw: p, attempts: _attempt });
        if (_attempt >= 3) {
          statusEl.innerHTML = '<span style="color: var(--warn);">服务端反复要求重定向（' + st + '）。如果你之前在另一台机器扫过码绑定过 ClawBot，请先在那台机器登出，或点「重置本地状态」后稍等几分钟再试。</span>';
          return;
        }
        statusEl.innerHTML = '<span class="muted">服务端要求重定向（' + st + '），自动重置并重试中…</span>';
        try { await window.easydeal.wechat.logout(); } catch (_) { /* swallow */ }
        await new Promise((r) => setTimeout(r, 800));
        return startQrLogin(_attempt + 1);
      } else {
        statusEl.textContent = '状态：' + st;
        _writeDebug({ stage: 'poll', status: st, raw: p });
      }
    }
  }
  wxCard.querySelector('#wx-qr-fetch').addEventListener('click', () => startQrLogin(0));
  wxCard.querySelector('#wx-qr-reset').addEventListener('click', async () => {
    if (!confirm('清掉本地登录缓存？\n\n用于：扫码后一直卡住、显示「服务端要求重定向」、或者换过 ClawBot 账号。\n清掉后需要重新扫码。')) return;
    _qrPollAbort = true;
    try { await window.easydeal.wechat.logout(); } catch (_) {}
    _clearDebug();
    const statusEl = wxCard.querySelector('#wx-qr-status');
    statusEl.innerHTML = '<span class="muted">本地状态已清，正在重新拉二维码…</span>';
    setTimeout(() => startQrLogin(0), 400);
  });

  wxCard.querySelector('#wx-logout').addEventListener('click', async () => {
    if (!confirm('注销登录？本机会清掉 bot_token，下次需要重新扫码。')) return;
    _qrPollAbort = true;
    await window.easydeal.wechat.logout();
    refreshWxStatus(true);
  });

  wxCard.querySelector('#wx-send').addEventListener('click', async () => {
    const to  = wxCard.querySelector('#wx-to').value.trim();
    const msg = wxCard.querySelector('#wx-msg').value;
    const out = wxCard.querySelector('#wx-send-result');
    if (!msg) { out.textContent = '请填内容'; out.style.color = 'var(--danger)'; return; }
    out.style.color = 'var(--text-3)';
    out.textContent = '发送中…（HTTP 调用，~1s）';
    const t0 = Date.now();
    const r = await window.easydeal.wechat.send(to || null, msg);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (r?.ok) {
      out.style.color = 'var(--success)';
      out.textContent = `已发送给 ${r.to || '(自己)'}（用时 ${dt}s）`;
      showToast('已发送', 'ok');
    } else {
      out.style.color = 'var(--danger)';
      out.textContent = `失败（${dt}s）：` + (r?.error || '未知');
    }
  });

  // ---------- card: misc ----------
  // ---------- card: 高级 (危险开关) ----------
  // 0.3.99: 平/改 vs 开仓拆成两个独立 checkbox —— 开仓凭空建仓的风险敞口
  // 比平仓大得多，用户经常想给 AI 平/改权限但不给开仓权限。两个 toggle 互
  // 不影响，单独读 EASYDEAL_TRADING_WRITE / EASYDEAL_TRADING_WRITE_OPEN env。
  // 开仓的子选项还多一条文案：AI 开的单会自动注册到 OrderGuard 独立监控。
  const advCard = el('div', 'card');
  advCard.innerHTML = `
    <div class="section-head">
      <h2>高级</h2>
      <span class="sub">danger zone — 谨慎打开</span>
    </div>
    <div style="padding: 12px; background: rgba(220, 80, 80, 0.06); border: 1px solid rgba(220, 80, 80, 0.25); border-radius: 6px;">
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
        <input id="setting-trading-write" type="checkbox"
          ${settings.tradingWriteEnabled ? 'checked' : ''}
          style="width:18px;height:18px;margin-top:3px">
        <div style="flex:1">
          <div style="font-weight:600;color:var(--text-1)">⚠ 允许 AI 直接平仓 / 改单</div>
          <div style="margin-top:6px;color:var(--text-3);font-size: var(--fs-md);line-height:1.5">
            勾上后 EasyDeal MCP 会向 AI 暴露 <code>close_position</code>（平掉所有 / 某一单）
            和 <code>modify_position</code>（修改止盈止损）两个工具。AI 在对话里
            **不会再二次确认**就直接动你的实盘。<br><br>
            • <strong>默认关闭</strong>：AI 看不到这两个工具，最多能查盘面、跑回测、写代码<br>
            • <strong>开启场景</strong>：你已经充分测试过 EA 的逻辑、信任 AI 的判断、愿意让它在你不在电脑前时也能执行平仓 / 改 SL<br>
            • <strong>关掉就立刻生效</strong>（下次新对话，工具列表里看不到）<br><br>
            <span style="color:var(--text-3)">风险范围：最多损失既有持仓（平仓不会带来新敞口；改 SL 最坏情况是把止损推远）。</span>
          </div>
        </div>
      </label>
      <div id="setting-trading-write-msg" class="muted small" style="margin-top:8px;padding-left:30px"></div>
      <div style="margin-top:8px;padding-left:30px;display:flex;align-items:center;gap:8px">
        <button id="setting-trading-write-verify" class="btn small">验证生效状态</button>
        <span id="setting-trading-write-state" class="muted small"></span>
      </div>
    </div>

    <!-- 0.3.99: 开仓权限独立 toggle —— 比平/改激进得多，单独开关 + 单独二次确认 -->
    <div style="margin-top: 14px; padding: 12px; background: rgba(220, 80, 80, 0.06); border: 1px solid rgba(220, 80, 80, 0.4); border-radius: 6px;">
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
        <input id="setting-trading-write-open" type="checkbox"
          ${settings.tradingWriteOpenEnabled ? 'checked' : ''}
          style="width:18px;height:18px;margin-top:3px">
        <div style="flex:1">
          <div style="font-weight:600;color:var(--danger)">⚠⚠ 允许 AI 直接<strong>开仓</strong>（凭空建仓，最高风险）</div>
          <div style="margin-top:6px;color:var(--text-3);font-size: var(--fs-md);line-height:1.5">
            勾上后额外暴露 <code>open_position</code>（市价开新仓）工具。AI 可以凭对话上下文
            **不经二次确认**直接给你建新仓位 —— 风险敞口完全不可控。<br><br>
            • <strong>默认关闭</strong>：即使上面那个平/改权限开了，AI 也不能凭空开新仓<br>
            • <strong>开启场景</strong>：信号检测、跟单、AI 主动建仓策略 —— 必须在模拟盘验证过 AI 的开仓节奏<br>
            • <strong>开仓自动加入 OrderGuard 监控</strong>：AI 每开一单都会自动注册到「<code>__ai_manual__</code>」pseudo-EA
              （独立于你的 EA 规则之外）。在「策略 → 已护航」面板里能看到这只虚拟 EA 的所有 AI 开仓单的盈亏 / 决策记录<br>
            • <strong>关掉就立刻生效</strong>（下次新对话，AI 视野里 <code>open_position</code> 消失）<br><br>
            <span style="color:#e89876">建议：先在模拟账户跑几天 AI 的开仓决策、看它会不会乱开。开了之后定期看
              「OrderGuard → __ai_manual__」面板的成交记录，发现乱开立刻关。</span>
          </div>
        </div>
      </label>
      <div id="setting-trading-write-open-msg" class="muted small" style="margin-top:8px;padding-left:30px"></div>
    </div>
  `;
  root.appendChild(advCard);

  // Wire the checkbox
  const twChk = advCard.querySelector('#setting-trading-write');
  const twMsg = advCard.querySelector('#setting-trading-write-msg');
  const twVerify = advCard.querySelector('#setting-trading-write-verify');
  const twState = advCard.querySelector('#setting-trading-write-state');

  // 读取 .mcp.json 看真实生效状态。绕开任何猜测 / 缓存。
  async function refreshTradingWriteState() {
    try {
      const r = await window.easydeal.app.checkMcpTradingWrite();
      if (!r) { twState.textContent = ''; return; }
      if (r.error) {
        twState.innerHTML = `<span style="color:#e89876">⚠ 检测失败：${escape(r.error)}</span>`;
        return;
      }
      if (!r.easydealConfigured) {
        twState.innerHTML = `<span style="color:#e89876">⚠ easydeal MCP 未配置（设置→Python MCP 路径），开关无效</span>`;
        return;
      }
      if (r.envSet) {
        twState.innerHTML = `<span style="color:#7bd88f">✓ .mcp.json 已注入 EASYDEAL_TRADING_WRITE=1，下次新会话生效</span>`;
      } else {
        twState.innerHTML = `<span style="color:var(--text-3)">.mcp.json 当前无 EASYDEAL_TRADING_WRITE（开关关闭，符合预期）</span>`;
      }
    } catch (e) {
      twState.innerHTML = `<span style="color:#e89876">⚠ ${escape(e.message || String(e))}</span>`;
    }
  }
  twVerify.addEventListener('click', refreshTradingWriteState);
  // 也在打开页面时自动跑一次
  refreshTradingWriteState();
  twChk.addEventListener('change', async () => {
    const enable = twChk.checked;
    if (enable) {
      const ok = window.confirm(
        '确认开启「允许 AI 直接平仓 / 改单」？\n\n'
        + '开启后 AI 在对话中可以直接平掉你的实盘持仓 / 修改止盈止损，\n'
        + '不再需要你在 MT5 里手动确认。\n\n'
        + '风险范围：最多损失既有持仓（不会带来新敞口）。\n'
        + '建议先在模拟账户跑过再开实盘的这个开关。'
      );
      if (!ok) {
        twChk.checked = false;
        return;
      }
    }
    try {
      await window.easydeal.settings.set({ tradingWriteEnabled: enable });
      settings = await window.easydeal.settings.get();
      twMsg.textContent = enable
        ? '✓ 已开启 — 重启对话后 AI 会拿到 close_position / modify_position 工具'
        : '✓ 已关闭 — 重启对话后这两个工具会从 AI 视野消失';
      // 立刻去 disk 上验证 .mcp.json 真的写进去了
      await refreshTradingWriteState();
      setTimeout(() => { twMsg.textContent = ''; }, 5000);
    } catch (e) {
      twMsg.textContent = '保存失败：' + (e.message || String(e));
      twChk.checked = !enable;
    }
  });

  // 0.3.99: 开仓权限独立 checkbox
  const twOpenChk = advCard.querySelector('#setting-trading-write-open');
  const twOpenMsg = advCard.querySelector('#setting-trading-write-open-msg');
  twOpenChk?.addEventListener('change', async () => {
    const enable = twOpenChk.checked;
    if (enable) {
      const ok = window.confirm(
        '确认开启「允许 AI 直接开仓」？\n\n'
        + '⚠⚠ 这比「平仓 / 改单」激进得多 ——\n'
        + 'AI 可以凭对话上下文直接给你建新仓位，风险敞口完全不可控。\n\n'
        + '每笔 AI 开的单会自动注册到 OrderGuard 的 __ai_manual__ pseudo-EA 监控，\n'
        + '你可以在「策略 → 已护航」面板里看 AI 开仓的成交记录。\n\n'
        + '强烈建议先在模拟账户跑几天 AI 的开仓决策，看节奏再开实盘。'
      );
      if (!ok) {
        twOpenChk.checked = false;
        return;
      }
    }
    try {
      await window.easydeal.settings.set({ tradingWriteOpenEnabled: enable });
      settings = await window.easydeal.settings.get();
      twOpenMsg.textContent = enable
        ? '✓ 已开启 — 重启对话后 AI 会拿到 open_position 工具；AI 开的单自动进 OrderGuard 监控'
        : '✓ 已关闭 — 重启对话后 open_position 工具从 AI 视野消失（已经开的单仍按原 SL/TP 走）';
      setTimeout(() => { twOpenMsg.textContent = ''; }, 5000);
    } catch (e) {
      twOpenMsg.textContent = '保存失败：' + (e.message || String(e));
      twOpenChk.checked = !enable;
    }
  });

  // 0.3.54: 外观偏好（主题 / 字号），localStorage 存，立刻应用
  const appearCard = el('div', 'card');
  const _curTheme    = localStorage.getItem('ezdl.theme')    || 'dark';
  const _curFontSize = localStorage.getItem('ezdl.fontSize') || 'md';
  appearCard.innerHTML = `
    <div class="section-head">
      <h2>外观</h2>
      <span class="sub">主题 + 字号偏好（仅本机生效，不同步到服务端）</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <div style="font-weight:500;margin-bottom:6px;">主题</div>
        <div style="display:flex;gap:8px;">
          <label style="flex:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--overlay-1);">
            <input type="radio" name="appear-theme" value="dark" ${_curTheme === 'dark' ? 'checked' : ''} style="margin-right:6px;">
            🌙 深色（默认）
          </label>
          <label style="flex:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--overlay-1);">
            <input type="radio" name="appear-theme" value="light" ${_curTheme === 'light' ? 'checked' : ''} style="margin-right:6px;">
            ☀ 浅色
          </label>
        </div>
      </div>
      <div>
        <div style="font-weight:500;margin-bottom:6px;">字号</div>
        <div style="display:flex;gap:8px;">
          <label style="flex:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--overlay-1);font-size: var(--fs-md);">
            <input type="radio" name="appear-font" value="sm" ${_curFontSize === 'sm' ? 'checked' : ''} style="margin-right:6px;">
            小 (12px)
          </label>
          <label style="flex:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--overlay-1);font-size: var(--fs-lg);">
            <input type="radio" name="appear-font" value="md" ${_curFontSize === 'md' ? 'checked' : ''} style="margin-right:6px;">
            中 (14px · 默认)
          </label>
          <label style="flex:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--overlay-1);font-size:16px;">
            <input type="radio" name="appear-font" value="lg" ${_curFontSize === 'lg' ? 'checked' : ''} style="margin-right:6px;">
            大 (16px)
          </label>
        </div>
      </div>
      <p class="hint" style="margin:0;font-size: var(--fs-md);">改完立刻生效（不用重启）。设置存在浏览器 localStorage，重装客户端需要重新选。</p>
    </div>
  `;
  root.appendChild(appearCard);
  appearCard.querySelectorAll('input[name="appear-theme"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem('ezdl.theme', r.value);
        window.applyAppearance?.();
      }
    });
  });
  appearCard.querySelectorAll('input[name="appear-font"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem('ezdl.fontSize', r.value);
        window.applyAppearance?.();
      }
    });
  });

  // 0.4.6: 隐私 card — 买家可以关掉「让卖家看我用 EA 的统计」。默认开（买都买了，
  // 让卖家看用得好不好是合理的）；勾上 opt-out 后 server /listings/{id}/buyer-stats
  // 排除这个 license_key 的所有数据。
  const privacyCard = el('div', 'card');
  privacyCard.innerHTML = `
    <div class="section-head">
      <h2>隐私</h2>
      <span class="sub">marketplace 数据共享开关</span>
    </div>
    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:6px 0;">
      <input type="checkbox" id="opt-out-seller-stats" style="margin-top:3px;">
      <div style="flex:1;line-height:1.6;">
        <div style="font-weight:500;">不让卖家看我用 EA 的统计</div>
        <div class="hint" style="margin-top:4px;font-size:var(--fs-sm);">
          你买的 marketplace EA，卖家默认能看到匿名聚合统计（活跃天数 / 交易数 / 收益百分比 / 当前版本 / 回撤）—— 用来判断他的 EA 在用户手里跑得怎么样、决定下一版怎么改。<strong>不会看到</strong>你的账户余额、license key、机器身份。<br>
          勾上此项 → 你的统计**完全不出现**在卖家面板里（连匿名行都不会有）。代价：万一卖家要主动联系你协助调参 / 通知 bug，他们看不到你的运行状态。
        </div>
        <div class="hint" style="margin-top:4px;font-size:var(--fs-sm);color:var(--text-4);">
          📊 想知道服务端给卖家展示的细节？看代码：<code>/v1/listings/{id}/buyer-stats</code>。
        </div>
      </div>
    </label>
    <div id="opt-out-msg" class="hint" style="margin-top:6px;font-size:var(--fs-sm);"></div>
  `;
  root.appendChild(privacyCard);

  // Load current value（从服务端拉，不缓存到 localStorage 避免漂移）
  (async () => {
    try {
      const r = await window.easydeal.mkt.getOptOut();
      if (r?.ok) {
        privacyCard.querySelector('#opt-out-seller-stats').checked = !!r.opt_out;
      }
    } catch {}
  })();

  privacyCard.querySelector('#opt-out-seller-stats').addEventListener('change', async (e) => {
    const checked = e.target.checked;
    const msgEl = privacyCard.querySelector('#opt-out-msg');
    msgEl.textContent = '保存中…';
    let r;
    try {
      r = await window.easydeal.mkt.setOptOut(checked);
    } catch (err) {
      msgEl.textContent = `保存失败：${err?.message || err}`;
      e.target.checked = !checked;   // revert
      return;
    }
    if (r?.ok) {
      msgEl.textContent = checked
        ? '✓ 已开启 — 卖家面板看不到你的数据'
        : '✓ 已关闭 — 卖家可以看到你的匿名聚合统计';
      setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } else {
      msgEl.textContent = '保存失败：' + (r?.error || '未知');
      e.target.checked = !checked;
    }
  });

  const miscCard = el('div', 'card');
  miscCard.innerHTML = `
    <div class="section-head">
      <h2>其他信息</h2>
      <span class="sub">read-only</span>
    </div>
    <div class="kv">
      <div class="k">客户端版本</div>            <div class="v">${escape(info.version)}</div>
      <div class="k">工作目录</div>              <div class="v">${escape(info.workspace)}</div>
      <div class="k">调度器 MCP (stdio)</div>    <div class="v"><span class="tag ${info.schedulerStatus === 'running' ? 'ok' : 'error'}">${escape(info.schedulerStatus || '?')}</span> <span style="color:var(--text-4);">${escape(info.schedulerScript || '')}</span></div>
      <div class="k">Claude Code</div>           <div class="v">${escape(info.claudeBin)}</div>
    </div>
    <div style="margin-top: 14px;">
      <button class="btn ghost" id="open-ws">打开工作目录</button>
    </div>
  `;
  root.appendChild(miscCard);

  miscCard.querySelector('#open-ws').addEventListener('click',
    () => window.easydeal.app.openWorkspace());

  // (实盘账号 wiring 一并移除 — 见上方卡片移除注释)


  // 0.3.39: 「回测完通知 AI」checkbox gate。
  // 0.3.41: 去掉 token mode 限制，只 gate License Tier = max（fay / system / custom 都行）。
  async function paintNotifyAiGate() {
    const chk = btEnvCard.querySelector('#bt-notify-ai');
    const lbl = btEnvCard.querySelector('#bt-notify-ai-label');
    const hint = btEnvCard.querySelector('#bt-notify-ai-hint');
    const badge = btEnvCard.querySelector('#bt-notify-ai-badge');
    if (!chk || !lbl) return;
    let licTier = null;
    try { const s = await window.easydeal.app.licenseStatus(); licTier = s?.tier || null; } catch {}
    const enabled = (licTier === 'max' || licTier === 'max_plus');
    chk.disabled = !enabled;
    lbl.style.opacity = enabled ? '1' : '0.65';
    lbl.style.cursor = enabled ? 'pointer' : 'not-allowed';
    if (badge) badge.style.display = enabled ? 'none' : 'inline-block';
    lbl.title = enabled ? '' : `当前不可勾选：License Tier = ${licTier || '未知'}（需 max / max+）`;
    hint.innerHTML = 'max 用户才能使用。';
    // sync 当前 settings 值到 checkbox
    chk.checked = !!(settings.notifyAiAfterBacktest);
    if (!enabled) chk.checked = false;   // 不可用时强制 false（避免历史保留值误启用）
  }
  paintNotifyAiGate();
  // license tier 改了 → 重画（admin 升级用户为 max 之后 60s heartbeat 推过来）
  window.easydeal.app.onLicenseStatusChanged?.(() => paintNotifyAiGate());

  btEnvCard.querySelector('#bt-notify-ai')?.addEventListener('change', async (e) => {
    if (e.target.disabled) {
      e.target.checked = false;
      return;
    }
    const newVal = !!e.target.checked;
    try {
      settings = await window.easydeal.settings.set({ notifyAiAfterBacktest: newVal });
      showToast(newVal
        ? '✓ 已开启「回测完通知 AI」— 重启对话后下次回测完会自动 ping AI'
        : '✓ 已关闭', 'ok');
    } catch (err) {
      showToast('保存失败：' + (err?.message || err), 'error');
      // 出错时回滚 UI
      e.target.checked = !newVal;
    }
  });


  // -------- helpers --------
  const $$ = (sel) => root.querySelector(sel);

  // 0.3.99: paintAiRc() 移除 —— AI 风控卡片下线，OrderGuard LLM 走主 AI 通道
  // （Token tab 配的 Fay / custom / system）。

  function paintInputs() {
    $$('#mt5-install-input').value = info.mt5InstallDir || '';
    $$('#mt5-data-input').value    = info.mt5DataDir || '';
    // (ed-script / py / wc inputs were removed — those three paths are
    // bundled and resolved automatically; user has nothing to configure.)

    const det = settings._meta?.detected || {};
    paintSource('mt5-install-source', settings._meta?.userSet?.mt5?.installDir, det.installDir, det.installDirSource);
    paintSource('mt5-data-source',    settings._meta?.userSet?.mt5?.dataDir,    det.dataDir,    det.dataDirSource);

    // 0.3.336: 监控配置 UI 删了 — paintInputs 不再读 monitor-* 输入框 (会 null).
  }

  function paintSource(id, userVal, detected, detectedSource) {
    const node = $$('#' + id);
    if (!node) return;
    if (userVal) {
      node.textContent = '已自定义';
      node.title = '用户在设置里手动填的';
      node.className = 'settings-source set';
    } else if (detected) {
      node.textContent = sourceLabel(detectedSource);
      node.title = `自动检测：${detectedSource || '默认'}`;
      node.className = 'settings-source auto';
    } else {
      node.textContent = '未检测到';
      node.title = '';
      node.className = 'settings-source missing';
    }
  }

  function sourceLabel(src) {
    if (!src) return '自动检测';
    if (src === 'env') return '环境变量';
    if (src === 'process') return '进程信息';
    if (src.startsWith('registry:')) return '注册表';
    if (src === 'common') return '常用路径';
    if (src === 'appdata-scan') return '扫描 APPDATA';
    return src;
  }

  paintInputs();
  // 0.3.99: AI 风控 key handlers 移除（卡片下线，统一走主 AI 通道）

  // -------- save handlers --------
  async function saveMt5() {
    const installDir = $$('#mt5-install-input').value.trim() || null;
    const dataDir    = $$('#mt5-data-input').value.trim() || null;
    settings = await window.easydeal.settings.set({ mt5: { installDir, dataDir } });
    info = await window.easydeal.app.info();
    paintInputs();
    showToast('MT5 路径已保存', 'ok');
    refresh();
  }
  // (saveEd / ed-script / py / wc handlers removed — three paths are bundled
  // and auto-resolved; no UI to wire up. Power users can still set
  // easydealScript / pythonBin / windowCaptureScript in settings.json
  // directly OR via env vars EASYDEAL_PYTHON / EASYDEAL_MCP_SCRIPT —
  // resolution chain in electron/settings.js still honours those.)
  $$('#mt5-save').addEventListener('click', saveMt5);

  // 自动保存 — 用户粘贴路径后失焦 / 按回车 立刻落盘，不用再去找「保存修改」按钮。
  // 只在内容真的变了时存（避免每次切焦点都打日志）。
  let _lastInstallVal = $$('#mt5-install-input').value;
  let _lastDataVal    = $$('#mt5-data-input').value;
  function _autoSaveIfChanged() {
    const cur1 = $$('#mt5-install-input').value;
    const cur2 = $$('#mt5-data-input').value;
    if (cur1 !== _lastInstallVal || cur2 !== _lastDataVal) {
      _lastInstallVal = cur1;
      _lastDataVal = cur2;
      saveMt5();
    }
  }
  for (const id of ['#mt5-install-input', '#mt5-data-input']) {
    const inp = $$(id);
    inp.addEventListener('blur', _autoSaveIfChanged);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  }

  $$('#mt5-install-browse').addEventListener('click', async () => {
    const p = await window.easydeal.settings.browseDir({ title: '选择 MT5 安装目录', defaultPath: $$('#mt5-install-input').value });
    if (p) { $$('#mt5-install-input').value = p; saveMt5(); _lastInstallVal = p; }
  });
  $$('#mt5-data-browse').addEventListener('click', async () => {
    const p = await window.easydeal.settings.browseDir({ title: '选择 MT5 数据目录', defaultPath: $$('#mt5-data-input').value });
    if (p) { $$('#mt5-data-input').value = p; saveMt5(); _lastDataVal = p; }
  });

  $$('#mt5-install-reset').addEventListener('click', async () => {
    settings = await window.easydeal.settings.resetField('mt5.installDir');
    info = await window.easydeal.app.info();
    paintInputs(); refresh();
  });
  $$('#mt5-data-reset').addEventListener('click', async () => {
    settings = await window.easydeal.settings.resetField('mt5.dataDir');
    info = await window.easydeal.app.info();
    paintInputs(); refresh();
  });

  // 0.3.336: 删掉「监控配置」UI 后, event listener 全部砍掉. settings.monitor.*
  // 字段仍然在 settings.json 里 (老用户数据不丢, 但已经没 UI 改). MCP env 注入
  // 路径仍然读 settings.monitor 但默认值能 work (XAUUSD 系列 + magic 999), 不影响
  // 老 case 也不影响新多 MT5 (走 mounted-state.symbol 不走全局 monitor).

  // -------- 检查 SDK 连接 — 实测 Python MT5 SDK 能不能绑到 user_set --------
  $$('#mt5-probe').addEventListener('click', async () => {
    const btn = $$('#mt5-probe');
    const out = $$('#mt5-probe-result');
    const wasText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…（可能要 10-20 秒）';
    out.style.display = 'block';
    out.style.color = 'var(--text-3)';
    out.style.background = 'rgba(0,0,0,0.16)';
    out.style.border = '1px solid var(--border-soft)';
    out.innerHTML = '正在 spawn Python 子进程跑 mt5.initialize → terminal_info → symbols_get…';
    try {
      const r = await window.easydeal.app.probeMt5();
      if (!r?.ok) {
        out.style.background = 'rgba(232,152,118,0.08)';
        out.style.border = '1px solid var(--danger)';
        out.style.color = 'var(--danger)';
        out.innerHTML = `检查失败：${escape(r?.error || '未知')}`;
        return;
      }
      const probe = r.result || {};
      if (probe.init_error) {
        out.style.background = 'rgba(232,152,118,0.08)';
        out.style.border = '1px solid var(--danger)';
        out.style.color = 'var(--text-2)';
        out.innerHTML = `<strong style="color: var(--danger);">SDK 初始化失败</strong><br><code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${escape(probe.init_error)}</code><br><span style="color: var(--text-3); font-size: var(--fs-sm);">先确认 MT5 在跑（任务管理器看 terminal64.exe），再点检查。</span>`;
        return;
      }
      const ti = probe.terminal || {};
      const ai = probe.account || {};
      const norm = (p) => String(p || '').toLowerCase().replace(/[\\/]+/g, '\\');
      const matched = probe.requested_path && ti.path && norm(probe.requested_path) === norm(ti.path);
      if (matched) {
        out.style.background = 'rgba(95,201,146,0.08)';
        out.style.border = '1px solid var(--success)';
        out.style.color = 'var(--text-2)';
        const attempts = (probe.bind_attempts || []).length;
        out.innerHTML = `
          <strong style="color: var(--success);">✓ SDK 已正确绑定</strong>${attempts > 1 ? ` <span class="muted">（重试 ${attempts - 1} 次后命中）</span>` : ''}<br>
          <div style="margin-top: 4px;">
            实际连接：<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${escape(ti.path || '?')}</code><br>
            Broker：${escape(ti.company || '?')}（build ${escape(String(ti.build || '?'))}）${ti.connected ? ' · <span style="color: var(--success);">✓ 已连</span>' : ' · <span style="color: var(--warn);">⚠ 未连</span>'}<br>
            ${ai.login ? `账号：<code>${ai.login}</code> @ ${escape(ai.server || '?')} · 余额 ${escape(String(ai.balance ?? '?'))} ${escape(ai.currency || '')}<br>` : '<span style="color: var(--warn);">⚠ MT5 没登录账号</span><br>'}
            品种总数：${probe.symbols_total || 0}${probe.symbols_keyword_hits?.length ? ` · 黄金/外汇关键字：<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${probe.symbols_keyword_hits.slice(0, 8).map(escape).join('，')}</code>` : ''}
          </div>
        `;
      } else {
        out.style.background = 'rgba(255,188,51,0.08)';
        out.style.border = '1px solid var(--warn)';
        out.style.color = 'var(--text-2)';
        out.innerHTML = `
          <strong style="color: var(--warn);">⚠ SDK 绑到了别的 MT5</strong>（重试 ${(probe.bind_attempts || []).length} 次都没命中你设的那个）<br>
          <div style="margin-top: 4px;">
            你设的：<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${escape(probe.requested_path || '(未设)')}</code><br>
            SDK 实际绑到：<code style="font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--warn);">${escape(ti.path || '(未知)')}</code><br>
            Broker：${escape(ti.company || '?')} · ${ai.login ? `账号 ${ai.login} @ ${escape(ai.server || '?')}` : '未登录'}<br>
            <span style="color: var(--text-3); font-size: var(--fs-sm);">多 MT5 同时跑时 SDK 路径绑定不可靠。两个办法二选一：① 关掉其他 MT5 实例，只留 <code>${escape(probe.requested_path || '')}</code> 这一个 ② 把上面「安装目录」改成 SDK 实际绑到的那个路径。</span>
          </div>
        `;
      }
    } catch (e) {
      out.style.background = 'rgba(232,152,118,0.08)';
      out.style.border = '1px solid var(--danger)';
      out.style.color = 'var(--danger)';
      out.innerHTML = `异常：${escape(e.message || String(e))}`;
    } finally {
      btn.disabled = false;
      btn.textContent = wasText;
    }
  });

  // -------- launch / guide --------
  $$('#mt5-launch').addEventListener('click', async () => {
    console.log('[settings] launch MT5 clicked');
    try {
      const r = await window.easydeal.app.launchMt5();
      console.log('[settings] launchMt5 →', r);
      if (r.ok) {
        showToast('已尝试启动 MT5（pid ' + r.pid + '），等几秒检查状态', 'ok');
        setTimeout(refresh, 4000);
      } else {
        showToast('启动失败：' + (r.error || '未知错误'), 'error');
      }
    } catch (e) {
      console.error('[settings] launch error:', e);
      showToast('启动失败：' + e.message, 'error');
    }
  });

  $$('#mt5-guide').addEventListener('click', async () => {
    console.log('[settings] guide clicked');
    try {
      const r = await window.easydeal.app.requestMt5InstallGuide();
      console.log('[settings] guide →', r);
      if (r.ok) {
        showToast('已发起请求，切到对话标签页看 AI 的指引', 'ok');
        if (typeof window.showTab === 'function') window.showTab('chat');
      } else {
        showToast('无法发送：' + (r.error || '未知错误'), 'error');
      }
    } catch (e) {
      console.error('[settings] guide error:', e);
      showToast('发送失败：' + e.message, 'error');
    }
  });

  // 0.3.182: 「📥 一键下载并安装 MT5」 — 从 OSS 拉打包好的 portable MT5 (~456MB),
  // 解压到用户选的 target dir, 自动配 mt5.installDir.
  $$('#mt5-download-install')?.addEventListener('click', async () => {
    const btn = $$('#mt5-download-install');
    const progBox = $$('#mt5-install-progress');
    const phaseEl = $$('#mt5-install-phase');
    const barEl = $$('#mt5-install-bar');
    const detailEl = $$('#mt5-install-detail');

    // 1. 让用户选目标目录 (默认 D:\, 大文件不放系统盘)
    const targetParent = await window.easydeal.settings.browseDir({
      title: '选择 MT5 安装位置 (将解压到该目录下的 MetaTrader 5/ 子目录)',
    });
    if (!targetParent) return;   // 用户取消

    const confirmed = confirm(
      `将下载 EasyDeal 打包好的 MT5 portable 版本（约 456 MB）并解压到:\n\n` +
      `  ${targetParent}\\MetaTrader 5\\\n\n` +
      `下载约 1-5 分钟（看网速），解压约 1-2 分钟。完成后会自动配置 MT5 路径。\n\n` +
      `继续？`
    );
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = '⌛ 下载安装中…';
    progBox.style.display = 'block';
    phaseEl.textContent = '准备中...';
    barEl.style.width = '0%';
    detailEl.textContent = '';

    // 2. 订阅进度事件
    const unsubscribe = window.easydeal.app.onMt5InstallProgress((payload) => {
      const { kind, phase, message, downloaded, total, percent, index, message: msg } = payload;
      if (kind === 'phase') {
        phaseEl.textContent = message || phase;
        if (phase === 'downloading') barEl.style.background = 'var(--accent, #4a9eff)';
        else if (phase === 'extracting') barEl.style.background = 'var(--success, #5fc992)';
        else if (phase === 'done') barEl.style.background = 'var(--success, #5fc992)';
        else if (phase === 'error') barEl.style.background = 'var(--danger, #ef4444)';
        if (phase === 'done') {
          barEl.style.width = '100%';
          detailEl.textContent = `✓ MT5 已安装到: ${payload.mt5_install_dir}`;
        }
      } else if (kind === 'progress') {
        const pct = typeof percent === 'number' ? percent : 0;
        barEl.style.width = `${pct}%`;
        if (phase === 'downloading' && total) {
          detailEl.textContent = `下载: ${(downloaded/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB (${pct.toFixed(1)}%)`;
        } else if (phase === 'extracting') {
          detailEl.textContent = `解压: ${index} / ${payload.total} 个文件 (${pct.toFixed(1)}%)`;
        }
      }
    });

    // 3. 调 IPC 执行下载 + 解压
    try {
      const r = await window.easydeal.app.downloadAndInstallMt5(targetParent);
      if (r?.ok) {
        showToast('✓ MT5 已安装并自动配置路径', 'ok');
        // 重新拉 settings 刷 UI
        settings = await window.easydeal.settings.redetect();
        info = await window.easydeal.app.info();
        paintInputs();
        refresh();
      } else {
        phaseEl.textContent = '❌ 安装失败';
        detailEl.textContent = r?.error || '未知错误';
        showToast('安装失败: ' + (r?.error || '?'), 'error');
      }
    } catch (e) {
      phaseEl.textContent = '❌ 安装失败';
      detailEl.textContent = e?.message || String(e);
      showToast('安装失败: ' + (e?.message || e), 'error');
    } finally {
      try { unsubscribe?.(); } catch {}
      btn.disabled = false;
      btn.textContent = '📥 一键下载并安装 MT5';
    }
  });

  $$('#mt5-refresh').addEventListener('click', refresh);
  $$('#mt5-redetect').addEventListener('click', async () => {
    showToast('重新检测中…');
    settings = await window.easydeal.settings.redetect();
    info = await window.easydeal.app.info();
    paintInputs();
    refresh();
    const det = settings._meta?.detected || {};
    const procs = det.runningMt5Processes || [];
    const userSet = settings._meta?.userSet?.mt5?.installDir;
    if (det.installDir) {
      let msg = '检测到 MT5：' + det.installDir + ' (来源 ' + sourceLabel(det.installDirSource) + ')';
      if (procs.length > 1) {
        msg += `；同时还有 ${procs.length - 1} 个其他 MT5 在跑（卡片上方横幅可见详情）`;
      }
      showToast(msg, 'ok');
    } else if (procs.length > 0 && userSet) {
      // tasklist 兜底拿不到 path，但用户已经手动设了路径 — 不算「没检测到」
      showToast(`检测到 ${procs.length} 个 MT5 在跑（用 tasklist 兜底，路径拿不到）。EasyDeal 会用你设的 ${userSet}`, 'ok');
    } else if (procs.length > 0) {
      // 看到 MT5 在跑但拿不到路径 + 用户也没设路径 — 让用户手动浏览
      showToast(`检测到 ${procs.length} 个 MT5 在跑但拿不到路径（杀软拦了 PowerShell）。请用"浏览…"手动指向 terminal64.exe 所在目录`, 'warn');
    } else {
      showToast('未检测到 MT5。请用"浏览…"手动指向 terminal64.exe 所在目录', 'error');
    }
  });

  // -------- MT5 status check --------
  async function refresh() {
    const r = await window.easydeal.app.checkMt5();
    const tag = $$('#mt5-status-tag');
    banner.style.display = 'none';
    banner.className = 'banner';
    // Always keep buttons clickable so the user can see actual error
    // messages instead of staring at a disabled button.
    $$('#mt5-launch').disabled = false;
    if (r.status === 'running') {
      tag.innerHTML = `<span class="tag ok">运行中</span>${r.pid ? ' <span style="color: var(--text-4); font-size: var(--fs-sm); font-family: var(--font-mono);">pid ' + r.pid + '</span>' : ''}`;
      // 多开 MT5 检测 — 用户设了 installDir 但没匹配上当前任何 running terminal，
      // 客户的痛点是「我改了路径但 EasyDeal 还在用别的 MT5」。这里清楚显示
      // 当前运行的所有 terminal + 用户设的那个有没有在跑。
      const userSet = settings._meta?.userSet?.mt5?.installDir;
      const running = settings._meta?.detected?.runningMt5Processes || [];
      // tasklist fallback 命中时所有 entry dir 都是空 — 此时无法做路径匹配。
      // 不能像 PowerShell 路径下那样断言「都不一致」误导用户，要单独提示。
      const allTasklist = running.length > 0 && running.every((p) => !p.dir);
      if (userSet && running.length > 0) {
        if (allTasklist) {
          // tasklist 兜底拿不到 path — 没法做实例匹配。「重新检测」按钮的
          // toast 已说明这种情况，banner 不重复展示。
        } else {
          const userSetNorm = userSet.replace(/[/\\]+$/, '').toLowerCase();
          const matched = running.find((p) =>
            (p.dir || '').replace(/[/\\]+$/, '').toLowerCase() === userSetNorm
          );
          if (!matched) {
            banner.className = 'banner banner-warn';
            banner.style.display = 'flex';
            const list = running.map((p) => `<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${p.dir} <span style="color: var(--text-4);">(pid ${p.pid})</span></code>`).join('<br>');
            banner.innerHTML = `<span class="banner-dot"></span><span>
              <strong>多 MT5 警告：你设的安装目录跟当前运行的实例都不一样。</strong><br>
              你设的：<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${userSet}</code><br>
              当前运行：<br>${list}<br>
              <span style="font-size: 11.5px; color: var(--text-3);">EasyDeal 会用你设的那个 — 但它没在跑。要么 ⟲ 恢复检测值（自动用当前运行的），要么手动把 <code>${userSet}\\terminal64.exe</code> 启动起来。</span>
            </span>`;
          } else if (running.length > 1) {
            // 用户设值匹配上了一个 running terminal，但有多开 — info 级提示
            banner.className = 'banner banner-info';
            banner.style.display = 'flex';
            const others = running.filter((p) => p !== matched);
            const otherList = others.map((p) => `<code style="font-family: var(--font-mono); font-size: var(--fs-sm);">${p.dir} <span style="color: var(--text-4);">(pid ${p.pid})</span></code>`).join(', ');
            banner.innerHTML = `<span class="banner-dot"></span><span>
              <strong>当前有 ${running.length} 个 MT5 在跑。</strong>EasyDeal 锁定的是你设的那个 (pid ${matched.pid})。其他还在跑：${otherList}
            </span>`;
          }
        }
      }
    } else if (r.status === 'installed_not_running') {
      tag.innerHTML = `<span class="tag" style="color: var(--warn); border-color: rgba(255, 188, 51, 0.4);">已安装 · 未启动</span>`;
      banner.className = 'banner banner-info';
      banner.style.display = 'flex';
      banner.innerHTML = `<span class="banner-dot"></span><span><strong>MT5 已安装但没在运行。</strong>点上方"启动 MT5 终端"按钮起一下。</span>`;
    } else {
      // 「未安装」分支 — checkMt5 返回 not_installed。但要分两种：
      //   ① 真没装 / settings 没值 → 让用户「浏览…」选一下
      //   ② 用户已经设了路径 + tasklist 看到 MT5 在跑 → 杀软拦 PS 路径，
      //      其实是有装的，只是 checkMt5 这条链路没拿到信号。状态降级
      //      为黄色 info 别吓用户。
      const userSet = settings._meta?.userSet?.mt5?.installDir;
      const procs = settings._meta?.detected?.runningMt5Processes || [];
      if (userSet && procs.length > 0) {
        tag.innerHTML = `<span class="tag" style="color: var(--info, #55b3ff); border-color: rgba(85,179,255,0.3);">用户已配置 · ${procs.length} 个 MT5 在跑</span>`;
        banner.style.display = 'none';   // 「重新检测」toast 已说明 tasklist 兜底，banner 不重复
      } else {
        tag.innerHTML = `<span class="tag error">未安装</span>`;
        banner.className = 'banner banner-warn';
        banner.style.display = 'flex';
        banner.innerHTML = `<span class="banner-dot"></span><span><strong>未检测到 MT5 终端。</strong>如果已经装在别的位置，下方"安装目录"手动选一下；没装的话点"让 AI 给我安装指引"。</span>`;
      }
    }
  }
  await refresh();

  const pollTimer = setInterval(refresh, POLL_MS);
  // Claude 通过 easydeal-settings MCP 改了 settings.json → main 推 settings:changed
  // → 这里立刻把 form input 重绘 + 跑一次 MT5 状态 refresh，不用等下次 30s 轮询。
  // 注意：refresh() 只更新 MT5 状态 banner，input 框是 paintInputs() 画的，所以
  // 必须先把 settings / info 闭包变量重新拉一遍再 paintInputs。
  const offChanged = window.easydeal?.settings?.onChanged?.(async (payload) => {
    try {
      settings = payload || await window.easydeal.settings.get();
      info = await window.easydeal.app.info();
      paintInputs();
      await refresh();
    } catch (e) {
      console.warn('[settings] onChanged repaint failed:', e?.message || e);
    }
  });
  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      clearInterval(pollTimer);
      try { offChanged?.(); } catch {}
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
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

// ============================================================
// 诊断快照上传模态：让用户写问题描述 + 贴截图（粘贴 / 拖拽 / 选文件）
// 提交后调 IPC 把诊断 + report + screenshots 一起推到服务端，admin 在
// license-detail 页直接看到。
// ============================================================
function showDiagnosticReportModal(toastEl) {
  // 状态：本地保存截图列表
  const screenshots = [];   // [{name, mime, size, data_base64, preview_url}]
  const MAX_FILES = 5;
  const MAX_PER_FILE = 2 * 1024 * 1024;   // 2 MB

  const overlay = document.createElement('div');
  overlay.className = 'mkt-modal';
  overlay.innerHTML = `
    <div class="mkt-modal-body" style="max-width: 560px;">
      <div class="row between" style="margin-bottom: 8px; align-items: flex-start;">
        <h2 style="margin: 0; font-size: 16px;">上传诊断快照</h2>
        <button class="btn ghost small" data-diag-close>✕</button>
      </div>
      <div class="hint" style="margin: 0 0 12px;">
        把当前客户端运行时状态推到服务端，发卡方能远程看 MT5 检测 / EA 列表 / 子进程状态等。
      </div>

      <div id="diag-preflight-warn" style="display: none; padding: 10px 12px; margin-bottom: 12px; background: rgba(255, 188, 51, 0.1); border-left: 3px solid var(--warn); border-radius: 0 4px 4px 0; font-size: var(--fs-md); color: var(--text-2); line-height: 1.7;"></div>

      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; font-size: var(--fs-md); color: var(--text-2);">遇到了什么问题？<span style="color: var(--danger);">*</span></label>
        <textarea id="diag-text" rows="4" placeholder="比如：连不上 MT5 / GMarket 显示统计缺失反复修复都不行 / 回测一直卡「回测中」…" style="width: 100%; resize: vertical; font-family: inherit;"></textarea>
      </div>

      <div style="margin-bottom: 8px;">
        <label style="display: block; margin-bottom: 4px; font-size: var(--fs-md); color: var(--text-2);">截图（可选，最多 ${MAX_FILES} 张，每张 ≤ 2 MB）</label>
        <div id="diag-shots" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 32px; padding: 6px; border: 1px dashed var(--border-soft); border-radius: 4px;"></div>
        <div class="muted" style="font-size: var(--fs-sm); margin-top: 4px;">支持 Ctrl+V 粘贴 / 拖拽到这里 / 点下面按钮选文件</div>
        <div style="margin-top: 6px;">
          <button class="btn ghost small" data-diag-add>+ 选择文件</button>
          <input type="file" id="diag-file-input" accept="image/*" multiple style="display: none;">
        </div>
      </div>

      <div class="row" style="gap: 8px; margin-top: 14px; justify-content: flex-end;">
        <button class="btn ghost small" data-diag-close>取消</button>
        <button class="btn primary small" data-diag-submit>上传</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-diag-close]').forEach((b) => b.addEventListener('click', close));

  const shotsEl = overlay.querySelector('#diag-shots');
  const fileInput = overlay.querySelector('#diag-file-input');
  const txtEl = overlay.querySelector('#diag-text');

  function renderShots() {
    if (!screenshots.length) {
      shotsEl.innerHTML = '<span class="muted" style="font-size: var(--fs-sm); padding: 4px;">还没截图</span>';
      return;
    }
    shotsEl.innerHTML = '';
    for (let i = 0; i < screenshots.length; i++) {
      const s = screenshots[i];
      const item = document.createElement('div');
      item.style.cssText = 'position:relative;width:64px;height:64px;border-radius:4px;overflow:hidden;border:1px solid var(--border-soft);';
      item.innerHTML = `
        <img src="${s.preview_url}" alt="${escape(s.name)}" style="width:100%;height:100%;object-fit:cover;" title="${escape(s.name)} (${(s.size/1024).toFixed(0)} KB)">
        <button data-rm="${i}" title="移除" style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;border:none;background:rgba(0,0,0,0.6);color:#fff;font-size: var(--fs-xs);line-height:14px;cursor:pointer;padding:0;">×</button>
      `;
      shotsEl.appendChild(item);
    }
    shotsEl.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(b.dataset.rm);
      screenshots.splice(idx, 1);
      // 改用 data: URL 之后不需要 revokeObjectURL —— 没有 blob 资源占用。
      renderShots();
    }));
  }
  renderShots();

  async function addFile(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    if (screenshots.length >= MAX_FILES) {
      showToast(`最多 ${MAX_FILES} 张截图`, 'error');
      return;
    }
    if (file.size > MAX_PER_FILE) {
      showToast(`${file.name} 太大（${(file.size/1024/1024).toFixed(1)} MB），上限 2 MB — 截窗口而不是整屏；或用图片工具压一下`, 'error');
      return;
    }
    const buf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    // 预览之前用 URL.createObjectURL(file) 拿 blob URL —— 但 Electron 某些
    // 渲染配置 / CSP 下 <img src="blob:..."> 会显示成破图（用户反馈）。
    // 改用 data: URL 直接 inline base64：跨任何 CSP / sandbox / 渲染管道
    // 都能渲染。代价是 base64 字符串多缓一份，截图限 2MB 影响可忽略。
    const mime = file.type || 'image/png';
    screenshots.push({
      name: file.name || 'screenshot.png',
      mime,
      size: file.size,
      data_base64: b64,
      preview_url: `data:${mime};base64,${b64}`,
    });
    renderShots();
  }

  // 「+ 选择文件」按钮
  overlay.querySelector('[data-diag-add]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) await addFile(f);
    fileInput.value = '';
  });

  // 拖拽
  shotsEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  shotsEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) await addFile(f);
  });

  // Ctrl+V 粘贴 — 在 textarea / shotsEl / 模态内任意位置都能用
  overlay.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type?.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) await addFile(f);
      }
    }
  });

  // 提交
  overlay.querySelector('[data-diag-submit]').addEventListener('click', async () => {
    const text = txtEl.value.trim();
    if (!text) {
      showToast('请先描述遇到的问题', 'error');
      txtEl.focus();
      return;
    }
    const submitBtn = overlay.querySelector('[data-diag-submit]');
    submitBtn.disabled = true;
    submitBtn.textContent = '上传中…';
    try {
      const r = await window.easydeal.app.uploadDiagnostic({
        text,
        screenshots: screenshots.map((s) => ({
          name: s.name, mime: s.mime, size: s.size, data_base64: s.data_base64,
        })),
      });
      if (r?.ok) {
        showToast('已上传，请把序列号告诉发卡方排查 ✓', 'ok');
        if (toastEl) {
          toastEl.style.color = 'var(--success)';
          toastEl.textContent = '✓ 已上传 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
          setTimeout(() => { toastEl.textContent = ''; toastEl.style.color = ''; }, 10_000);
        }
        // 清掉本地 preview URLs
        for (const s of screenshots) try { URL.revokeObjectURL(s.preview_url); } catch {}
        close();
      } else {
        showToast('上传失败：' + (r?.error || '未知'), 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '上传';
      }
    } catch (e) {
      showToast('异常：' + (e.message || String(e)), 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = '上传';
    }
  });

  // 自动 focus 到 textarea
  setTimeout(() => txtEl.focus(), 100);

  // ===== preflight：检测 MT5 是否真在跑 + 当前进程权限 =====
  // 用户报「连不上 MT5」时常见的两种状态：
  //   ① MT5 没开就上传 → 诊断捕捉的是没问题瞬间的 idle 状态
  //   ② MT5 以管理员身份跑、EasyDeal 普通用户 → Get-Process 看不到
  // 上传前提示一下，比上传完 admin 看着空数据猜半天好。
  const warnEl = overlay.querySelector('#diag-preflight-warn');
  (async () => {
    try {
      const pre = await window.easydeal.app.diagPreflight();
      if (!pre?.ok) return;
      const lines = [];
      // 进程检测拿到 0 个 MT5 + EA 挂载日志有信号 = 进程检测假阴（杀软拦
      // PowerShell + tasklist / 权限差异 / exe 名被 broker 改过 等），不是
      // 真的没开。这条不该弹「警告」吓用户，反而提一句让 admin 知道。
      if (pre.mt5_running_count === 0 && (pre.mounted_ea_count || 0) > 0) {
        lines.push(`进程检测拿不到 MT5 句柄，但 EA 挂载日志显示 <strong>${pre.mounted_ea_count} 个 EA 在跑</strong>，说明 MT5 确实在跑（只是检测路径被杀软 / 权限拦了）`);
        lines.push('<span style="color: var(--text-3);">不影响诊断快照上传 — 发卡方从快照里能看到 EA 名 / 运行时长 / 数据目录路径</span>');
      } else if (pre.mt5_running_count === 0) {
        lines.push('⚠ <strong>当前没检测到任何 MT5 进程在跑</strong>');
        if (pre.platform === 'win32' && pre.is_admin === false) {
          lines.push('· 你的 EasyDeal 是<strong>普通用户身份</strong>启动的 — 如果 MT5 是「以管理员身份运行」开的，普通进程看不到管理员进程，<strong>会误以为 MT5 没开</strong>');
          lines.push('· 解决：右键 EasyDeal 图标 →「以管理员身份运行」重启，再来上传');
        }
        lines.push('· 或：先开 MT5（确认能看到行情）再来点这个按钮');
        lines.push('<span style="color: var(--text-3);">仍然可以继续上传 — 比如你想报告的就是「MT5 完全连不上」本身，那这个空状态正是要给发卡方看的</span>');
      } else if (pre.mt5_running_count > 1) {
        lines.push(`检测到 <strong>${pre.mt5_running_count} 个 MT5</strong> 在跑（多开）— EasyDeal 锁定了一个，其余的状态发卡方会从快照里看到`);
      }
      if (lines.length) {
        warnEl.innerHTML = lines.join('<br>');
        warnEl.style.display = 'block';
      }
    } catch {}
  })();
}

function arrayBufferToBase64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
