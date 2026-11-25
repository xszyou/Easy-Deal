// Token view — pick which Claude Code credential channel to use:
//   1. system  — bundled claude-code login (no override)
//   2. custom  — user-supplied URL / model / API key
//   3. codex   — local bridge backed by an officially logged-in Codex CLI
//   4. fay     — official Fay relay; server picks a channel + tracks usage
//
// All four modes write to <userData>/data/token.json via IPC. The chat-
// session reads spawnEnvOverrides() at every spawn so changes here take
// effect on the NEXT user message — no restart needed.

const TOKEN_PURCHASE_GUIDE_URL = 'https://tcn83aar80mf.feishu.cn/wiki/WRAWw0V1giFwQbkdgvzcw5JunSe?from=from_copylink';

export function renderToken(root) {
  root.innerHTML = '';

  // --- header ---
  const hero = el('section', 'hero-tight');
  hero.innerHTML = `
    <h1>Token / AI 通道</h1>
    <p class="lede">选 AI 用哪个通道。<span class="lede-dim">影响所有对话 + 定时任务 + headless spawn。</span></p>
  `;
  root.appendChild(hero);

  // --- Token purchase guide (community edition) ---
  const buyCard = el('div', 'card');
  buyCard.innerHTML = `
    <div class="section-head">
      <h2>购买 Token</h2>
      <span class="sub">还没有模型 API？</span>
    </div>
    <p class="hint">
      按指引注册火山引擎并开通模型服务，拿到 API Key 后，在下面选「自定义端点」，填入地址、模型和 Key 即可使用。
    </p>
    <div class="row" style="gap: 8px; margin-top: 10px; align-items: center;">
      <button class="btn primary" id="tk-buy-guide">查看火山引擎注册指引</button>
    </div>
    <p class="hint" style="margin-top: 8px; font-size: 11px; color: var(--text-4);">
      指引中的注册链接带有开发者的推荐码，通过它注册购买，开发者会获得推荐奖励，你的价格不受影响。
    </p>
  `;
  root.appendChild(buyCard);
  buyCard.querySelector('#tk-buy-guide').addEventListener('click', () => {
    window.easydeal.app.openExternal(TOKEN_PURCHASE_GUIDE_URL);
  });

  // --- Proxy 配置卡片（横跨 system/custom/codex/fay 四种模式都生效）---
  // 国内用户访问 api.anthropic.com 多半要走代理。EasyDeal 桌面快捷方式
  // 启动时不继承 shell 的 HTTPS_PROXY，所以直连 api.anthropic.com 会被
  // 拦截或走默认 DNS 出 403。这里让用户显式填一份。
  const proxyCard = el('div', 'card');
  proxyCard.innerHTML = `
    <div class="section-head">
      <h2>HTTP 代理</h2>
      <span class="sub">所有模式共用</span>
      <span class="spacer"></span>
      <span id="tk-proxy-status" class="tag" style="color: var(--text-4);">读取中…</span>
    </div>
    <p class="hint">
      国内访问 api.anthropic.com 多数情况要走 Clash / V2Ray / SSR 等本地代理。
      <strong>桌面图标启动 EasyDeal 时不继承 shell 的 HTTPS_PROXY 环境变量</strong>，
      子进程的 claude.exe 会直连 → 经常出现 <code>API Error: 403 Request not allowed</code>。
      这里设了之后会注入到所有 spawn 的 claude 进程里。
    </p>
    <div class="row wrap" style="gap: 12px; margin-top: 10px;">
      <div class="field" style="min-width: 200px;">
        <label>模式</label>
        <select id="tk-proxy-mode" style="width: 100%;">
          <option value="auto">自动 — 用 EasyDeal 启动时的环境变量（如果有）</option>
          <option value="manual">手动 — 用下面填的 URL（推荐国内用户）</option>
          <option value="off">禁用 — 强制直连，无视环境变量</option>
        </select>
      </div>
      <div class="field" style="flex: 1; min-width: 300px;">
        <label>代理 URL <span class="settings-hint">仅 manual 模式生效</span></label>
        <input id="tk-proxy-url" placeholder="http://127.0.0.1:7890" style="width: 100%; font-family: var(--font-mono);">
      </div>
    </div>
    <div class="row" style="gap: 8px; margin-top: 10px; align-items: center;">
      <button class="btn primary" id="tk-proxy-save">保存代理配置</button>
      <span id="tk-proxy-detected" style="font-size: 11px; color: var(--text-4);"></span>
    </div>
  `;
  root.appendChild(proxyCard);

  // --- mode picker card ---
  const modeCard = el('div', 'card');
  modeCard.innerHTML = `
    <div class="section-head">
      <h2>使用模式</h2>
      <span class="sub">三选一</span>
      <span class="spacer"></span>
      <span id="tk-current-mode" class="tag">读取中…</span>
    </div>

    <div class="tk-modes">
      <label class="tk-mode-card" data-mode="system">
        <input type="radio" name="tk-mode" value="system">
        <div>
          <div class="tk-mode-title">🖥️ 系统 Claude Code 账号</div>
          <div class="tk-mode-desc">用电脑上 <code>claude</code> CLI 自带的登录（默认）。无需任何配置。适合已经按 Claude 官方流程登录过的用户。</div>
        </div>
      </label>

      <label class="tk-mode-card" data-mode="custom">
        <input type="radio" name="tk-mode" value="custom">
        <div>
          <div class="tk-mode-title">⚙️ 自定义端点</div>
          <div class="tk-mode-desc">指定自己的 API 服务，两种协议都支持：<b>Anthropic 兼容</b>（DeepSeek、月之暗面、SiliconFlow 等 <code>/v1/messages</code> 服务）或 <b>OpenAI 兼容</b>（通义、智谱、OpenRouter、vLLM 等 <code>/chat/completions</code> 服务，本地自动翻译协议）。下面选协议后填 URL / 模型 / Key。</div>
        </div>
      </label>

      <label class="tk-mode-card" data-mode="codex">
        <input type="radio" name="tk-mode" value="codex">
        <div>
          <div class="tk-mode-title">⌨️ codex cli</div>
          <div class="tk-mode-desc">使用本机已登录的 Codex CLI（ChatGPT 账号），通过仅监听 <code>127.0.0.1</code> 的安全桥接接入 EasyDeal。无需填写 API Key。</div>
        </div>
      </label>
    </div>
  `;
  root.appendChild(modeCard);

  // --- system mode panel (1.3.16: 系统模式模型 — 系统默认 / 人工填写 两种方式) ---
  const systemCard = el('div', 'card tk-pane');
  systemCard.dataset.modePane = 'system';
  systemCard.innerHTML = `
    <div class="section-head">
      <h2>系统模式模型</h2>
      <span class="sub">人工指定时由 EasyDeal 显式传给 Claude CLI</span>
    </div>
    <div class="field">
      <div class="row" style="gap: 16px; align-items: center; margin-bottom: 8px;">
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
          <input type="radio" name="tk-system-model-mode" value="default"> 系统默认（跟随 CC Switch / Claude CLI）
        </label>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
          <input type="radio" name="tk-system-model-mode" value="manual"> EasyDeal 指定（优先）
        </label>
      </div>
      <div class="row" id="tk-system-model-row" style="gap: 10px; align-items: center;">
        <input id="tk-system-model" placeholder="如 gpt-6-astra / opus[1m] / sonnet / haiku"
          style="flex: 1; max-width: 520px; font-family: var(--font-mono);">
        <button class="btn" id="tk-system-model-save">保存</button>
        <span id="tk-system-model-msg" class="sub"></span>
      </div>
      <div class="sub" style="margin-top: 6px;">
        “EasyDeal 指定”会通过 <code>--model</code> 将所填模型传给 Claude CLI。若系统端点使用 CC Switch，转发时仍可能改写模型。
        如需直连指定服务，请选择“自定义端点”。保存后<b>下一次请求</b>生效，无需新建会话。
      </div>
    </div>
  `;
  root.appendChild(systemCard);

  // --- custom mode panel ---
  const customCard = el('div', 'card tk-pane');
  customCard.dataset.modePane = 'custom';
  customCard.innerHTML = `
    <div class="section-head">
      <h2>自定义端点配置</h2>
      <span class="sub" id="tk-custom-proto-sub">Anthropic 兼容</span>
    </div>
    <div id="tk-custom-warn" class="banner banner-warn" style="display:none; margin-bottom: 10px;">
      <span class="banner-dot"></span>
      <span>当前是「自定义」模式但 <strong>未填 API_KEY</strong> — 实际仍走系统 Claude Code 凭据。填好 KEY 并保存才生效。还没有 Key？<a href="#" id="tk-custom-buy-link">查看购买指引</a></span>
    </div>

    <!-- 0.3.244: 协议选择 — Anthropic 协议 (默认, 直连) / OpenAI 兼容 (走本地翻译代理) -->
    <div class="field" style="margin-bottom: 10px;">
      <label>协议</label>
      <div class="row" style="gap: 12px; align-items: center;">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="radio" name="tk-custom-protocol" value="anthropic" checked>
          <span>Anthropic 协议</span>
          <span class="settings-hint">官方 / 任何 /v1/messages 兼容服务</span>
        </label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="radio" name="tk-custom-protocol" value="openai">
          <span>OpenAI 兼容</span>
          <span class="settings-hint">DeepSeek / 通义 / 智谱 / OpenRouter / vLLM 等</span>
        </label>
      </div>
    </div>

    <p class="hint" id="tk-custom-hint-anthropic">
      支持任何 Anthropic-API 兼容服务。常用：
      <code>https://api.deepseek.com/anthropic</code>、
      <code>https://api.moonshot.cn/anthropic</code>、
      <code>https://api.siliconflow.cn/anthropic</code>。
      留空 BASE_URL = 用 Anthropic 官方。
    </p>
    <p class="hint" id="tk-custom-hint-openai" style="display:none;">
      <strong>OpenAI Chat Completions 协议</strong> — EasyDeal 本地起一个翻译代理把 Anthropic 请求转成 OpenAI 格式发给上游, 再把响应翻回来. 支持 text / thinking (reasoning_content) / tool_use 全套.
      <br>常用 BASE_URL: <code>https://api.deepseek.com/v1</code>、<code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>、<code>https://open.bigmodel.cn/api/paas/v4</code>、<code>https://openrouter.ai/api/v1</code>.
      <br>MODEL 必填 (如 <code>deepseek-chat</code> / <code>deepseek-reasoner</code> / <code>qwen-max</code> / <code>glm-4-plus</code>).
    </p>

    <div class="row wrap" style="gap: 10px; margin-top: 12px;">
      <div class="field" style="flex: 2; min-width: 280px;">
        <label>BASE_URL</label>
        <input id="tk-custom-url" placeholder="https://api.example.com/anthropic" style="width: 100%; font-family: var(--font-mono);">
      </div>
      <div class="field" style="flex: 1; min-width: 200px;">
        <label id="tk-custom-model-label">MODEL（可选）</label>
        <input id="tk-custom-model" placeholder="如 claude-sonnet-4-5 / deepseek-chat" style="width: 100%; font-family: var(--font-mono);">
      </div>
    </div>
    <div class="field" style="margin-top: 10px;">
      <label>API_KEY <span class="settings-hint">仅本机持久化；不上传服务端</span></label>
      <input id="tk-custom-key" type="password" placeholder="sk-..." style="width: 100%; font-family: var(--font-mono);">
      <div id="tk-custom-key-info" style="margin-top: 4px; font-size: 11px; color: var(--text-4);"></div>
    </div>

    <div class="row" style="gap: 8px; margin-top: 12px; align-items: center;">
      <button class="btn primary" id="tk-custom-save">保存自定义配置</button>
      <button class="btn ghost" id="tk-custom-clear">清空</button>
      <button class="btn ghost" id="tk-custom-test" title="发一个最小请求验证 endpoint + key + model 是否可用">🔍 测试</button>
      <span id="tk-custom-test-result" style="flex: 1; font-size: 11px; color: var(--text-4);"></span>
      <span style="font-size: 11px; color: var(--text-4); white-space: nowrap;">下条消息生效，不用重启</span>
    </div>
  `;
  root.appendChild(customCard);
  customCard.querySelector('#tk-custom-buy-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.easydeal.app.openExternal(TOKEN_PURCHASE_GUIDE_URL);
  });

  // --- codex cli mode panel (displayed third, fourth persisted token mode) ---
  const codexCard = el('div', 'card tk-pane');
  codexCard.dataset.modePane = 'codex';
  codexCard.innerHTML = `
    <div class="section-head">
      <h2>codex cli</h2>
      <span class="sub">本机 ChatGPT 登录</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="tk-codex-check">检测 Codex CLI</button>
    </div>
    <p class="hint">
      EasyDeal 会在本机启动一个仅绑定 <code>127.0.0.1</code> 的临时桥接服务，
      由已登录的 <code>codex</code> CLI 响应对话；随机桥接令牌不会上传，也不会读取 OpenAI API Key。
      首次使用前请先在终端执行 <code>codex login</code>。
    </p>
    <div class="field" style="margin: 12px 0;">
      <label>MODEL（手动填写，可选）</label>
      <div class="row" style="gap: 10px; align-items: center;">
        <input id="tk-codex-model" placeholder="留空 = 跟随 Codex CLI 默认模型"
          style="flex: 1; max-width: 520px; font-family: var(--font-mono);">
        <button class="btn primary" id="tk-codex-save">保存模型</button>
        <span id="tk-codex-model-msg" class="sub"></span>
      </div>
      <div class="sub" style="margin-top: 6px;">
        非空时会作为 <code>codex exec --model</code> 的参数；代理沿用本页顶部“网络代理”配置。
      </div>
    </div>
    <div class="banner" style="margin-top: 12px;">
      <span class="banner-dot"></span>
      <span id="tk-codex-status">尚未检测</span>
    </div>
    <div class="sub" style="margin-top: 8px;">
      桥接层使用只读沙箱；MT5、定时任务及 EasyDeal 工具仍由现有权限体系执行。
      Codex CLI 会先完成整轮推理再返回，通常需 10–60 秒；超过 3 分钟会明确超时并清理子进程。切换后从下一条消息生效。
    </div>
  `;
  root.appendChild(codexCard);

  // --- WIRING ---
  let cfg = null;
  async function load() {
    cfg = await window.easydeal.token.get();
    paint();
  }
  function paint() {
    if (!cfg) return;
    // mode tag — 注意：当 custom/codex/fay 模式选了但没真正配齐时，
    // spawnEnvOverrides 会 silent fallback 到 system。这里把这个状态
    // 反映在 chip 颜色 + 文字上，让用户一眼知道是不是真生效了。
    const tag = root.querySelector('#tk-current-mode');
    const labels = { system: '🖥 系统', custom: '⚙ 自定义', codex: '⌨ codex cli', fay: '☁ Fay' };
    const modeLabel = labels[cfg.mode] || cfg.mode;
    let effective = cfg.mode;        // 实际生效的模式
    let downgradeReason = '';
    if (cfg.mode === 'custom' && !cfg.custom?.api_key_set) {
      effective = 'system';
      downgradeReason = '未填 API_KEY，回退到系统';
    } else if (cfg.mode === 'fay' && !cfg.fay?.token_alive) {
      effective = 'system';
      downgradeReason = '没申请过 Fay token（或已过期），回退到系统';
    }
    if (downgradeReason) {
      tag.innerHTML = `${modeLabel} <span style="color: var(--warn);">⚠ 实际走系统</span>`;
      tag.className = 'tag';
      tag.style.color = 'var(--warn)';
      tag.style.borderColor = 'rgba(255,188,51,0.3)';
      tag.title = downgradeReason;
    } else {
      tag.textContent = modeLabel;
      tag.className = 'tag ok';
      tag.style.color = '';
      tag.style.borderColor = '';
      tag.title = '';
    }
    // radios
    root.querySelectorAll('input[name="tk-mode"]').forEach((r) => {
      r.checked = (r.value === cfg.mode);
    });
    // mode-card highlight
    root.querySelectorAll('.tk-mode-card').forEach((c) => {
      c.classList.toggle('on', c.dataset.mode === cfg.mode);
    });
    // pane visibility — only show the one matching current mode
    root.querySelectorAll('.tk-pane').forEach((p) => {
      p.style.display = (p.dataset.modePane === cfg.mode) ? '' : 'none';
    });

    // system 模式模型回填 (1.3.16): '' = 系统默认(不注入); 非空 = 人工填写
    const sysInput = root.querySelector('#tk-system-model');
    if (sysInput) {
      const v = (cfg.system && typeof cfg.system.model === 'string') ? cfg.system.model : 'opus[1m]';
      const isManual = v !== '';
      const radio = root.querySelector(`input[name="tk-system-model-mode"][value="${isManual ? 'manual' : 'default'}"]`);
      if (radio) radio.checked = true;
      sysInput.value = v;
      const rowEl = root.querySelector('#tk-system-model-row');
      if (rowEl) rowEl.style.display = isManual ? '' : 'none';
    }

    // custom inputs
    // 0.3.244: 同步 protocol radio
    const proto = cfg.custom?.protocol || 'anthropic';
    const protoRadio = root.querySelector(`input[name="tk-custom-protocol"][value="${proto}"]`);
    if (protoRadio) protoRadio.checked = true;
    if (typeof _applyProtocolUI === 'function') _applyProtocolUI();
    root.querySelector('#tk-custom-url').value   = cfg.custom?.base_url || '';
    root.querySelector('#tk-custom-model').value = cfg.custom?.model    || '';
    const keyInfo = root.querySelector('#tk-custom-key-info');
    if (cfg.custom?.api_key_set) {
      keyInfo.textContent = `已保存 key：${cfg.custom.api_key_preview}（再输入会覆盖）`;
    } else {
      keyInfo.textContent = '没保存 key';
    }
    root.querySelector('#tk-custom-key').value = '';   // never echo the key
    const codexModel = root.querySelector('#tk-codex-model');
    if (codexModel) codexModel.value = cfg.codex?.model || '';
    // 「未填 KEY 实际仍走 system」警告横幅
    const customWarn = root.querySelector('#tk-custom-warn');
    if (customWarn) {
      customWarn.style.display = (cfg.mode === 'custom' && !cfg.custom?.api_key_set) ? '' : 'none';
    }

    // proxy 卡片
    const px = cfg.proxy || { mode: 'auto', url: '', env_https_proxy: '' };
    root.querySelector('#tk-proxy-mode').value = px.mode || 'auto';
    root.querySelector('#tk-proxy-url').value  = px.url  || '';
    const pxStatus = root.querySelector('#tk-proxy-status');
    const pxDetected = root.querySelector('#tk-proxy-detected');
    if (px.mode === 'manual' && px.url) {
      pxStatus.textContent = '✓ 手动';
      pxStatus.style.color = 'var(--success, #5fc992)';
    } else if (px.mode === 'off') {
      pxStatus.textContent = '⊘ 禁用';
      pxStatus.style.color = 'var(--warn)';
    } else {
      pxStatus.textContent = '· 自动';
      pxStatus.style.color = 'var(--text-4)';
    }
    if (px.env_https_proxy) {
      pxDetected.textContent = `EasyDeal 启动时检测到 HTTPS_PROXY=${px.env_https_proxy}（auto 模式会用这个）`;
    } else {
      pxDetected.innerHTML = '<span style="color: var(--warn);">EasyDeal 启动时没读到 HTTPS_PROXY — 国内用户建议切到「手动」填一份</span>';
    }
  }

  async function refreshCodexStatus() {
    const btn = root.querySelector('#tk-codex-check');
    const status = root.querySelector('#tk-codex-status');
    if (!btn || !status) return;
    btn.disabled = true;
    btn.textContent = '检测中…';
    status.textContent = '正在查找 Codex CLI 并验证登录状态…';
    try {
      const result = await window.easydeal.token.codexStatus();
      if (result?.ok && result?.login_ok) {
        const modelLabel = result.model ? escape(result.model) : 'CLI 默认';
        const proxyLabel = result.proxy_mode === 'manual' ? '手动代理'
          : (result.proxy_mode === 'off' ? '直连（代理已禁用）' : '自动代理');
        status.innerHTML = `<strong style="color:var(--success);">✓ Codex CLI 已登录</strong>`
          + ` · <code>${escape(result.codex_bin || 'codex')}</code>`
          + ` · 模型=<code>${modelLabel}</code>`
          + ` · 网络=<code>${escape(proxyLabel)}</code>`
          + ` · 有效输入上限=<code>${Number(result.context_chars || 0).toLocaleString('zh-CN')} 字符</code>`
          + ` · sandbox=<code>${escape(result.sandbox || 'read-only')}</code>`;
        if (cfg?.mode === 'codex') {
          const tag = root.querySelector('#tk-current-mode');
          tag.textContent = '⌨ codex cli';
          tag.className = 'tag ok';
          tag.title = result.detail || 'Codex CLI 已登录';
        }
      } else {
        status.innerHTML = `<strong style="color:var(--danger);">✖ Codex CLI 不可用</strong> · `
          + `${escape(result?.error || result?.detail || '请先运行 codex login')}`;
        if (cfg?.mode === 'codex') {
          const tag = root.querySelector('#tk-current-mode');
          tag.innerHTML = '⌨ codex cli <span style="color:var(--warn);">⚠ 不可用</span>';
          tag.className = 'tag';
          tag.title = result?.error || result?.detail || '请先运行 codex login';
        }
      }
    } catch (error) {
      status.innerHTML = `<strong style="color:var(--danger);">✖ 检测失败</strong> · ${escape(error?.message || error)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '检测 Codex CLI';
    }
  }

  // mode switch
  root.addEventListener('change', async (e) => {
    if (e.target.name === 'tk-mode') {
      cfg = await window.easydeal.token.setMode(e.target.value);
      paint();
      const modeNames = { system: '系统 Claude Code', custom: '自定义端点', codex: 'codex cli' };
      showToast(`已切换到「${modeNames[e.target.value] || e.target.value}」模式，下条消息生效`, 'ok');
      if (cfg.mode === 'codex') refreshCodexStatus();
    }
  });

  // 1.3.16: system 模式模型 — 「系统默认」立即存''(不注入); 「人工填写」显示输入框, 点保存才存
  root.querySelectorAll('input[name="tk-system-model-mode"]').forEach((r) => {
    r.addEventListener('change', async (e) => {
      const rowEl = root.querySelector('#tk-system-model-row');
      if (e.target.value === 'default') {
        cfg = await window.easydeal.token.setSystem({ model: '' });
        if (rowEl) rowEl.style.display = 'none';
        paint();
        showToast('已切为系统默认（跟随 claude CLI 配置），新会话生效', 'ok');
      } else {
        if (rowEl) rowEl.style.display = '';
        const inp = root.querySelector('#tk-system-model');
        if (inp && !inp.value) inp.value = 'opus[1m]';
        inp?.focus();
      }
    });
  });
  root.querySelector('#tk-system-model-save')?.addEventListener('click', async () => {
    const v = (root.querySelector('#tk-system-model')?.value || '').trim();
    if (!v) { showToast('模型不能为空 — 想不指定请选「系统默认」', 'warn'); return; }
    cfg = await window.easydeal.token.setSystem({ model: v });
    paint();
    showToast(`系统模式模型已保存为 ${v}，新会话生效`, 'ok');
  });

  // 0.3.244: 协议切换 — 切到 openai 时更新提示文字 / model label / placeholder
  function _getCustomProtocol() {
    const r = root.querySelector('input[name="tk-custom-protocol"]:checked');
    return r ? r.value : 'anthropic';
  }
  function _applyProtocolUI() {
    const p = _getCustomProtocol();
    const subEl = root.querySelector('#tk-custom-proto-sub');
    const hintA = root.querySelector('#tk-custom-hint-anthropic');
    const hintO = root.querySelector('#tk-custom-hint-openai');
    const urlInp = root.querySelector('#tk-custom-url');
    const modelLbl = root.querySelector('#tk-custom-model-label');
    const modelInp = root.querySelector('#tk-custom-model');
    if (p === 'openai') {
      if (subEl) subEl.textContent = 'OpenAI Chat Completions 兼容';
      if (hintA) hintA.style.display = 'none';
      if (hintO) hintO.style.display = '';
      if (urlInp) urlInp.placeholder = 'https://api.deepseek.com/v1';
      if (modelLbl) modelLbl.innerHTML = 'MODEL <span style="color: var(--danger);">*必填</span>';
      if (modelInp) modelInp.placeholder = '如 deepseek-chat / qwen-max / glm-4-plus';
    } else {
      if (subEl) subEl.textContent = 'Anthropic 兼容';
      if (hintA) hintA.style.display = '';
      if (hintO) hintO.style.display = 'none';
      if (urlInp) urlInp.placeholder = 'https://api.example.com/anthropic';
      if (modelLbl) modelLbl.textContent = 'MODEL（可选）';
      if (modelInp) modelInp.placeholder = '如 claude-sonnet-4-5 / deepseek-chat';
    }
  }
  root.querySelectorAll('input[name="tk-custom-protocol"]').forEach((r) => {
    r.addEventListener('change', _applyProtocolUI);
  });
  // custom save
  root.querySelector('#tk-custom-save').addEventListener('click', async () => {
    const protocol = _getCustomProtocol();
    const base_url = root.querySelector('#tk-custom-url').value.trim();
    const model    = root.querySelector('#tk-custom-model').value.trim();
    const apiKey   = root.querySelector('#tk-custom-key').value.trim();
    // 0.3.244: OpenAI 模式 model 必填 — 不能省, 因为没了 model 上游 API 直接 400
    if (protocol === 'openai' && !model) {
      showToast('OpenAI 模式下 model 必填 (如 deepseek-chat)', 'error');
      return;
    }
    const patch = { protocol, base_url, model };
    if (apiKey) patch.api_key = apiKey;
    cfg = await window.easydeal.token.setCustom(patch);
    paint();
    showToast('已保存', 'ok');
  });
  root.querySelector('#tk-custom-clear').addEventListener('click', async () => {
    if (!confirm('清空自定义端点配置？')) return;
    cfg = await window.easydeal.token.setCustom({ protocol: 'anthropic', base_url: '', model: '', api_key: '' });
    paint();
    showToast('已清空', 'ok');
  });
  // 0.3.161: 测试自定义 endpoint — 发 16-token 最小请求, 看是否通
  // 0.3.244: 加 protocol — anthropic 走原 /v1/messages, openai 走 OpenAI 兼容 preflightTest
  root.querySelector('#tk-custom-test').addEventListener('click', async () => {
    const btn = root.querySelector('#tk-custom-test');
    const resultEl = root.querySelector('#tk-custom-test-result');
    const protocol = _getCustomProtocol();
    const base_url = root.querySelector('#tk-custom-url').value.trim() || cfg?.custom?.base_url || '';
    const model    = root.querySelector('#tk-custom-model').value.trim() || cfg?.custom?.model || '';
    const apiKey   = root.querySelector('#tk-custom-key').value.trim();   // 输入框为空时 testCustom 走主进程读已保存 key
    btn.disabled = true;
    btn.textContent = '⌛ 测试中…';
    resultEl.textContent = '';
    resultEl.style.color = 'var(--text-4)';
    try {
      let testCfg = { protocol, base_url, model };
      if (apiKey) {
        testCfg.api_key = apiKey;
      } else {
        // 这里告诉用户先填 key.
        resultEl.textContent = '⚠ 请先在 API_KEY 框填一次明文 key 用于测试 (输入后立即测, 不会上传)';
        resultEl.style.color = 'var(--warn)';
        btn.disabled = false;
        btn.textContent = '🔍 测试';
        return;
      }
      if (protocol === 'openai' && !model) {
        resultEl.textContent = '⚠ OpenAI 模式下 model 必填';
        resultEl.style.color = 'var(--warn)';
        btn.disabled = false;
        btn.textContent = '🔍 测试';
        return;
      }
      const r = await window.easydeal.token.testCustom(testCfg);
      if (r?.ok) {
        const protoLbl = r.protocol === 'openai' ? '[OpenAI]' : '[Anthropic]';
        resultEl.innerHTML = `<span style="color:var(--success);">✓ ${protoLbl} 连通</span> · ${r.latency_ms}ms · model=<code>${r.model_used || model}</code> · sample: <code>${(r.sample || '').slice(0, 40)}</code>`;
      } else {
        const protoLbl = r?.protocol === 'openai' ? '[OpenAI]' : '[Anthropic]';
        resultEl.innerHTML = `<span style="color:var(--danger);">✖ ${protoLbl} 失败</span> · ${r?.latency_ms || '?'}ms · ${r?.status ? `HTTP ${r.status} · ` : ''}${r?.error || '未知'}`;
      }
    } catch (e) {
      resultEl.innerHTML = `<span style="color:var(--danger);">✖ 异常</span> · ${e?.message || e}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 测试';
    }
  });

  root.querySelector('#tk-codex-check')?.addEventListener('click', () => refreshCodexStatus());

  root.querySelector('#tk-codex-save')?.addEventListener('click', async () => {
    const model = root.querySelector('#tk-codex-model')?.value.trim() || '';
    const msg = root.querySelector('#tk-codex-model-msg');
    cfg = await window.easydeal.token.setCodex({ model });
    paint();
    if (msg) msg.textContent = model ? `已保存：${model}` : '已改为跟随 CLI 默认模型';
    showToast('Codex CLI 模型已保存，下条消息生效', 'ok');
    await refreshCodexStatus();
  });

  // proxy save
  root.querySelector('#tk-proxy-save').addEventListener('click', async () => {
    const mode = root.querySelector('#tk-proxy-mode').value;
    const url  = root.querySelector('#tk-proxy-url').value.trim();
    if (mode === 'manual' && !url) {
      showToast('选择 manual 模式必须填代理 URL（如 http://127.0.0.1:7890）', 'error');
      return;
    }
    cfg = await window.easydeal.token.setProxy({ mode, url });
    paint();
    showToast('代理配置已保存，下条消息生效', 'ok');
    if (cfg.mode === 'codex') await refreshCodexStatus();
  });

  // initial load
  load().then(() => {
    if (cfg?.mode === 'codex') refreshCodexStatus();
  });

  // 用户切走再切回 Token 标签时 showTab 会调这个 refresher。后台 admin 加了
  // 新的 Fay 模型时不用 F5 整个 app —— 切走一下再回来就能拉到新列表。
  return () => {
    load().then(() => {
      if (cfg?.mode === 'codex') refreshCodexStatus();
    });
  };
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
function formatN(v) {
  if (v == null) return '—';
  if (typeof v !== 'number') v = parseFloat(v);
  if (isNaN(v)) return '—';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'k';
  return String(v);
}
function showToast(msg, kind = 'ok') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden', 'error', 'ok');
  t.classList.add(kind);
  setTimeout(() => t.classList.add('hidden'), 2500);
}
