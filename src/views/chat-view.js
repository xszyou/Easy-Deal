import { renderMarkdown } from '../markdown.js';
// Chat view — talk to Claude Code in-app, with file/image attachments.
//
// Attachment flows:
//   1. Click 📎 button   → main process opens file picker
//   2. Paste in textarea → ClipboardEvent images/files captured
//   3. Drag onto chat    → files dropped, paths sent to main
// All three end up in workspace/.attachments/<draftId>/, then the prompt
// references them so Claude reads them with its standard Read tool.

let currentDraftId = null;
let currentAttachments = []; // mirrored from main process for rendering

export function renderChat(root) {
  root.innerHTML = '';

  // One global lightbox per chat mount — clicking any rendered .md-img opens it.
  // 0.2.6 起也接管附件 chip 缩略图 (.chat-chip-thumb)：用户在 composer chip
  // 或 bubble chip 上点缩略图都能放大到全屏 —— 跟 Claude Code 端 UI 体感
  // 对齐（之前只能 hover 出小浮窗，没法真正看清细节）。
  const lightbox = ensureLightbox();
  document.addEventListener('click', (e) => {
    const img = e.target?.closest?.('.md-img, .chat-chip-thumb');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    showLightbox(lightbox, img.src, img.alt);
  });

  const wrap = el('div', 'chat-wrap');
  wrap.innerHTML = `
    <header class="chat-head">
      <div>
        <h2>AI 对话</h2>
        <p class="hint" style="margin: 4px 0 0;">
          EasyDeal 是一个帮 AI 接通 MT5 与策略代码的客户端。据此你可以：
          <strong>1.</strong> 自动编写策略；<strong>2.</strong> 监控策略执行；<strong>3.</strong> 交易秘书。
        </p>
      </div>
      <div class="chat-head-actions">
        <!--
          Fay 通道用户：直接在对话头里换 model。下拉只显示当前序列号
          有权限 + 通道有效 + (manual_grant 通道还要看是否被授权 + 有
          额度) 的 model。切换会调 fayIssue 重签 token，覆盖
          tokenStore.fay.cached_model + cached_token，下次发话即生效。
          非 fay 模式（custom / system）下整个选择器隐藏。
        -->
        <span id="chat-model-wrap" style="display:none;align-items:center;gap:4px;font-size: var(--fs-md)">
          <span class="muted">模型:</span>
          <select id="chat-model-pick" style="padding:3px 6px;font-family:var(--font-mono);font-size: var(--fs-md);max-width:240px"></select>
          <span id="chat-model-msg" class="muted small" style="margin-left:4px;min-width:50px"></span>
        </span>
        <!-- 隐藏通知消息: 隐藏系统注入的通知类(护航告警/定时汇报/绑定授权等), 只看纯对话。
             每次回到本 tab 都恢复默认不勾选(见 renderChat 返回的 refresher)。 -->
        <label id="chat-hide-notes" title="隐藏护航告警 / 定时汇报 / 绑定授权等系统通知, 只看你与 AI 的对话"
               style="display:inline-flex;align-items:center;gap:4px;font-size:var(--fs-md);cursor:pointer;user-select:none;color:var(--text-2)">
          <input type="checkbox" id="chat-hide-notes-cb" style="cursor:pointer">
          <span>隐藏通知消息</span>
        </label>
        <span class="chat-status" id="chat-status"></span>
        <button class="btn ghost small" id="chat-stop" disabled>停止</button>
        <button class="btn ghost small" id="chat-session-history" title="查找并恢复 Claude Code 的旧会话">历史会话</button>
        <button class="btn ghost small" id="chat-reset">新会话</button>
        <!-- 0.3.102: 全停按钮从 topbar 挪到这里。永远可见、永远可点（无任务也能点 — confirm 文案说明）。
             click handler 在 renderer.js 用事件委托接的，不依赖 mount 时机。 -->
        <button id="panic-stop-btn" class="panic-stop-btn"
                title="紧急停止：杀掉正在跑的 AI 任务 + 所有回测/优化 + 放弃中断消息。执行后立即恢复正常运行，无冷却时间"
                type="button">🛑 全停</button>
      </div>
    </header>
    <!-- 1.3.x 多会话: 会话切换条(全局 + 每策略独立会话)。默认「全局」= 与旧版完全一致。 -->
    <div class="chat-sessions" id="chat-sessions">
      <div class="chat-sessions-pills" id="chat-sessions-pills"></div>
      <button class="btn ghost small chat-sessions-add" id="chat-sessions-add" title="按策略新建独立会话">＋策略会话</button>
    </div>
    <!-- 1.5.1: AI 任务进度面板 — 常驻显示当前会话的 TodoWrite 项(读 CC 原生 todos)。
         无待办时整块隐藏; 有则显示「X/Y 完成」+ 可折叠清单。数据 = window.easydeal.chat.getTodos。
         1.5.3: 加手动增删改 — 点状态图标切完成/未完成、✎ 编辑、× 删除、底部输入框新增,
         写回 CC 原生任务存储文件, AI 下次读取也能看到。 -->
    <div class="chat-todos" id="chat-todos" style="display:none;">
      <div class="chat-todos-head" id="chat-todos-head" title="点击折叠 / 展开">
        <span class="chat-todos-caret" id="chat-todos-caret">▾</span>
        <span class="chat-todos-title">📋 任务进度</span>
        <span class="chat-todos-count" id="chat-todos-count"></span>
        <div class="chat-todos-bar"><div class="chat-todos-bar-fill" id="chat-todos-bar-fill"></div></div>
      </div>
      <ul class="chat-todos-list" id="chat-todos-list"></ul>
      <div class="chat-todos-add-row" id="chat-todos-add-row">
        <input type="text" class="chat-todos-add-input" id="chat-todos-add-input" placeholder="添加一项任务…" maxlength="200" />
        <button class="chat-todos-add-btn" id="chat-todos-add-btn" title="添加">＋</button>
      </div>
    </div>
    <div class="chat-stream" id="chat-stream"></div>
    <div class="chat-busy-footer" id="chat-busy-footer" style="display: none;">
      <span class="chat-busy-dots"><span></span><span></span><span></span></span>
      <span class="chat-busy-text">AI 正在工作…</span>
    </div>
    <div class="chat-quote-tray" id="chat-quote-tray" style="display:none;"></div>
    <div class="chat-composer">
      <div class="chat-attachments" id="chat-attachments"></div>
      <div class="chat-input-row">
        <div class="chat-input-box">
          <textarea id="chat-input" placeholder="需要我做点什么，可拖文件或粘贴图片…  (Enter 发送，Shift+Enter 换行)" rows="3"></textarea>
          <button class="btn ghost icon" id="chat-attach" title="添加附件 (也可拖入或粘贴图片)">📎</button>
          <button class="btn primary chat-send-inside" id="chat-send" title="发送 (Enter)">发送</button>
        </div>
      </div>
    </div>
    <div class="chat-drop-overlay" id="chat-drop"><div class="chat-drop-inner">拖到这里上传</div></div>

    <div id="wx-history-drawer"
      style="position:fixed; top:0; right:-440px; width:420px; height:100vh;
             background:var(--bg); color:var(--text);
             border-left:1px solid var(--overlay-4);
             box-shadow:-8px 0 30px rgba(0,0,0,0.4);
             transition:right 0.25s ease;
             display:flex; flex-direction:column; z-index:7400;">
      <div style="padding:14px 16px; border-bottom:1px solid var(--overlay-4);
                  display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:600; font-size: var(--fs-lg);">微信聊天记录</div>
          <div id="wx-history-meta" class="muted small" style="margin-top:2px;">载入中…</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button id="wx-history-refresh" class="btn ghost small" title="刷新">⟳</button>
          <button id="wx-history-close"   class="btn ghost small" title="关闭">✕</button>
        </div>
      </div>
      <div id="wx-history-body" style="flex:1; overflow-y:auto; padding:8px 4px;"></div>
    </div>
  `;
  root.appendChild(wrap);

  // 0.3.54: 微信记录抽屉。0.3.54 改：不再在 textarea 加按钮，改用 topbar 现成的
  // 「微信」pill（renderer.js 里 wxPulse）click → 切到 AI tab + 调
  // window.openWechatHistoryDrawer() 打开抽屉。
  const wxDrawer  = wrap.querySelector('#wx-history-drawer');
  const wxBody    = wrap.querySelector('#wx-history-body');
  const wxMeta    = wrap.querySelector('#wx-history-meta');
  const wxRefresh = wrap.querySelector('#wx-history-refresh');
  const wxClose   = wrap.querySelector('#wx-history-close');
  let _wxDrawerOpen = false;
  const _wxEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const _wxFmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  async function _wxLoadHistory() {
    wxBody.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-3);">载入中…</div>';
    try {
      const r = await window.easydeal.wechat?.history?.({ limitPerChat: 30, maxChats: 30 });
      if (!r?.ok) {
        wxMeta.textContent = '未启动微信 sidecar';
        wxBody.innerHTML = `<div style="padding:24px; color:var(--warn);">${_wxEscape(r?.error || '微信 sidecar 未启动')}</div>`;
        return;
      }
      const items = r.items || [];
      wxMeta.textContent = r.logged_in
        ? `已登录 · ${items.length} 个会话`
        : `⚠ 未登录 · ${items.length} 个历史会话`;
      if (!items.length) {
        wxBody.innerHTML = '<div style="padding:24px; color:var(--text-3); text-align:center;">还没有微信聊天记录</div>';
        return;
      }
      wxBody.innerHTML = items.map((item) => {
        const bubbles = (item.exchanges || []).map((e) => {
          const isBot = e.role === 'bot';
          return `<div style="display:flex; ${isBot ? 'justify-content:flex-end' : ''}; margin:4px 0;">
            <div style="max-width:78%; padding:6px 10px; border-radius:8px;
                        background:${isBot ? 'rgba(34,197,94,0.18)' : 'var(--overlay-2)'};
                        font-size: var(--fs-md); line-height:1.4; word-break:break-word; white-space:pre-wrap;">
              ${_wxEscape(e.text || '')}
              <div class="muted" style="font-size: var(--fs-xs); margin-top:3px; opacity:0.55;">
                ${isBot ? '🤖 AI' : '👤 用户'} · ${_wxFmtTime(e.ts)}
              </div>
            </div>
          </div>`;
        }).join('');
        return `<div style="margin:6px 8px; padding:8px; border:1px solid var(--overlay-3); border-radius:6px;">
          <div style="font-size: var(--fs-sm); color:var(--text-3); margin-bottom:6px; word-break:break-all;">
            chat=${_wxEscape(item.chatId)} · ${item.count} 条 · 最后 ${_wxFmtTime(item.lastTs)}
          </div>
          ${bubbles}
        </div>`;
      }).join('');
      // 滚到底，看最新
      wxBody.scrollTop = wxBody.scrollHeight;
    } catch (e) {
      wxBody.innerHTML = `<div style="padding:24px; color:var(--warn);">${_wxEscape(e?.message || e)}</div>`;
    }
  }
  function _wxToggleDrawer() {
    _wxDrawerOpen = !_wxDrawerOpen;
    wxDrawer.style.right = _wxDrawerOpen ? '0' : '-440px';
    if (_wxDrawerOpen) _wxLoadHistory();
  }
  wxClose.addEventListener('click', _wxToggleDrawer);
  wxRefresh.addEventListener('click', _wxLoadHistory);
  // Esc 关
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _wxDrawerOpen) _wxToggleDrawer();
  });
  // 0.3.54: 暴露给 renderer.js 的 wxPulse click handler 用
  window.openWechatHistoryDrawer = () => {
    if (!_wxDrawerOpen) _wxToggleDrawer();
    else _wxLoadHistory();   // 已开 → 强刷
  };

  // 0.4.6: 抽屉打开期间监听 wechat:exchange 事件，新消息进来自动刷一次。
  // debounce 800ms 防 inbound 长 poll 一次性塞多条时刷太频繁。
  let _wxRefreshTimer = null;
  window.easydeal.wechat.onExchange?.(() => {
    if (!_wxDrawerOpen) return;   // 抽屉关着不刷，省 IPC 调用
    if (_wxRefreshTimer) return;
    _wxRefreshTimer = setTimeout(() => {
      _wxRefreshTimer = null;
      _wxLoadHistory().catch(() => {});
    }, 800);
  });

  const stream = wrap.querySelector('#chat-stream');
  const input = wrap.querySelector('#chat-input');
  const sendBtn = wrap.querySelector('#chat-send');

  // 「隐藏通知消息」: 勾选给 stream 容器加 .hide-system-notes(CSS 隐藏 .chat-turn.system-note)。
  // resetHideNotes() 在每次回到本 tab 时调(refresher)恢复默认不勾选。
  const hideNotesCb = wrap.querySelector('#chat-hide-notes-cb');
  const applyHideNotes = () => stream.classList.toggle('hide-system-notes', !!hideNotesCb?.checked);
  const resetHideNotes = () => { if (hideNotesCb) hideNotesCb.checked = false; applyHideNotes(); };
  hideNotesCb?.addEventListener('change', applyHideNotes);

  // 跨 tab 给输入框塞内容用 — 别的 view（比如「我的策略」回测错误行
  // 那个「让 AI 引导我修」按钮）调 window.showTab('chat') 切过来后调
  // window.populateChatInput(prompt, {focus:true}) 把 prompt 填进去。
  // 不自动发送 — 让用户 review 一眼再敲回车，避免误触一次回测就花 token。
  window.populateChatInput = function (msg, opts = {}) {
    if (typeof msg !== 'string' || !msg.trim()) return;
    input.value = msg;
    if (opts.focus !== false) input.focus();
    // 移动光标到末尾（textarea 默认会在 0 位置）
    try { input.setSelectionRange(msg.length, msg.length); } catch {}
    // 滚到底，确保用户看到的是最新塞进去的内容
    try { input.scrollTop = input.scrollHeight; } catch {}
  };
  const stopBtn = wrap.querySelector('#chat-stop');
  const sessionHistoryBtn = wrap.querySelector('#chat-session-history');
  const resetBtn = wrap.querySelector('#chat-reset');
  const attachBtn = wrap.querySelector('#chat-attach');
  const attachStrip = wrap.querySelector('#chat-attachments');
  const dropOverlay = wrap.querySelector('#chat-drop');
  const status = wrap.querySelector('#chat-status');

  // ===== 1.3.x 多会话状态 =====
  // activeSessionKey: 当前激活会话('global' 或 'strat:<login>:<ea>')。默认全局 = 旧行为。
  let activeSessionKey = 'global';

  // ===== 1.4.x 附加远程会话(只读) =====
  // 输入栏 🖥 → 选一台已授权(as_operator, approved)的被控机附加到当前会话。附加状态
  // 跟会话持久化走(chat 文件里 remoteAttachment 字段), 切会话/重启都保留; 点 chip × 移除,
  // 再点 🖥 可更换。附加期间每轮 spawn 带该机的 remote MCP(read 档), AI 可直接查它。
  const remoteAttachBtn = wrap.querySelector('#chat-remote-attach');
  const _skArg = () => (activeSessionKey === 'global' ? undefined : activeSessionKey);
  // 1.5.5: 一个会话可挂**多台**被控机 → 每台一个 chip, × 只拆自己那台。
  // 容器固定一个 #chat-remote-chip(旧 id 沿用, 避免样式失配), 里面横排多个 chip。
  async function refreshRemoteChip() {
    let atts = [];
    try {
      atts = (await window.easydeal.chat.getRemoteAttachments(_skArg())) || [];
    } catch {
      // 老 main 进程(还没重启)没有这个 handler → 回退到单台接口, 不让 UI 空掉
      try {
        const one = await window.easydeal.chat.getRemoteAttachment(_skArg());
        atts = one?.clientKey ? [one] : [];
      } catch {}
    }
    let box = wrap.querySelector('#chat-remote-chip');
    if (!atts.length) {
      box?.remove();
      remoteAttachBtn?.classList.remove('active');
      return;
    }
    remoteAttachBtn?.classList.add('active');
    if (!box) {
      box = el('div', 'chat-remote-chip');
      box.id = 'chat-remote-chip';
      const composer = wrap.querySelector('.chat-composer');
      composer?.insertBefore(box, composer.firstChild);
    }
    const _scopeLabel = (s) => ({ read: '只读', manage: '管理', trade: '交易' }[s] || '只读');
    box.innerHTML = atts.map((att) =>
      `<span class="chat-remote-one" data-key="${_qesc(att.clientKey)}">`
      + `🖥 远程(${_scopeLabel(att.scope)}): <b>${_qesc(att.note || '未备注')}</b>`
      + `<span class="muted" style="font-size:11px;">${_qesc(att.clientKey)}</span>`
      + `<span class="chat-remote-chip-x" title="移除这台" data-remote-detach="${_qesc(att.clientKey)}">×</span>`
      + `</span>`).join('');
    box.querySelectorAll('[data-remote-detach]').forEach((x) => {
      x.addEventListener('click', async () => {
        try { await window.easydeal.chat.detachRemote(_skArg(), x.getAttribute('data-remote-detach')); } catch {}
        refreshRemoteChip();
      });
    });
  }
  remoteAttachBtn?.addEventListener('click', async () => {
    let cands = [];
    try { cands = await window.easydeal.chat.remoteCandidates(); } catch {}
    if (!cands.length) {
      try { window.showToast && window.showToast('没有可附加的被控机 — 先在 IM 会话里发起远程控制授权(对方通过后再来)', 'warn'); } catch {}
      return;
    }
    let curList = [];
    try { curList = (await window.easydeal.chat.getRemoteAttachments(_skArg())) || []; } catch {}
    const curKeys = new Set(curList.map((x) => x.clientKey));
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.className = 'card';
    box.style.cssText = 'width:400px;max-width:90vw;padding:16px;';
    const close = () => { try { document.body.removeChild(ov); } catch {} };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    // 1.5.5: 可挂多台 —— 点一项 = 切换该台的挂/拆(不再是"选中就顶掉别的"), 弹窗不关,
    // 方便连着勾几台。已挂的显示 ✅ 且按钮高亮。
    const rows = [`<h3 style="margin:0 0 4px;">🖥 附加远程会话</h3>`,
      `<p class="hint" style="font-size:11px;margin:0 0 10px;">可选<b>多台</b>已授权的被控机接入当前会话(点一下挂上, 再点一下拆掉)。权限与通讯栏远程控制授权一致(见各项「授权」档位)。AI 可查询各机持仓/策略/行情, 管理/交易档还能改参/操作。挂多台时 AI 会先跟你确认指的是哪一台。</p>`];
    for (const c of cands) {
      const isCur = curKeys.has(c.clientKey);
      rows.push(`<button class="btn ${isCur ? 'primary' : 'ghost'}" data-key="${_qesc(c.clientKey)}" style="display:block;width:100%;text-align:left;margin:4px 0;">
        ${isCur ? '✅ ' : ''}${_qesc(c.note || c.clientKey)} <span class="muted" style="font-size:11px;">${_qesc(c.clientKey)} · 授权:${_qesc(c.scope)}</span>
      </button>`);
    }
    if (curKeys.size) rows.push(`<button class="btn danger small" data-detach style="margin-top:8px;">全部移除(${curKeys.size} 台)</button>`);
    rows.push(`<button class="btn ghost small" data-cancel style="margin-top:8px;float:right;">完成</button>`);
    box.innerHTML = rows.join('');
    box.addEventListener('click', async (e) => {
      const t = e.target.closest?.('button');
      if (!t) return;
      if (t.hasAttribute('data-cancel')) { close(); return; }
      if (t.hasAttribute('data-detach')) {
        try { await window.easydeal.chat.detachRemote(_skArg()); } catch {}
        close(); refreshRemoteChip(); return;
      }
      const key = t.getAttribute('data-key');
      if (key) {
        const cand = cands.find((c) => c.clientKey === key);
        // 1.5.5: 点一下 = 切换挂/拆。**弹窗不关** —— 挂多台时一台台点比开关弹窗顺手。
        try {
          if (curKeys.has(key)) {
            await window.easydeal.chat.detachRemote(_skArg(), key);
            curKeys.delete(key);
          } else {
            // 1.5.x: scope 跟随通讯栏授权档位(grant 里带), 不再固定只读
            await window.easydeal.chat.attachRemote(_skArg(), key, (cand && cand.note) || '', (cand && cand.scope) || 'read');
            curKeys.add(key);
          }
        } catch {}
        // 就地更新这一行的样子, 不重建整个弹窗(重建会丢滚动位置)
        t.classList.toggle('primary', curKeys.has(key));
        t.classList.toggle('ghost', !curKeys.has(key));
        t.innerHTML = `${curKeys.has(key) ? '✅ ' : ''}${_qesc((cand && cand.note) || key)} `
          + `<span class="muted" style="font-size:11px;">${_qesc(key)} · 授权:${_qesc((cand && cand.scope) || 'read')}</span>`;
        const dz = box.querySelector('[data-detach]');
        if (dz) { dz.textContent = `全部移除(${curKeys.size} 台)`; dz.style.display = curKeys.size ? '' : 'none'; }
        refreshRemoteChip();
      }
    });
    ov.appendChild(box);
    document.body.appendChild(ov);
  });
  const unreadByKey = {};   // sessionKey → 未读 assistant 条数(非当前会话来消息时累加, 切过去清零)
  // 引用: 点消息上的「引用」→ 进引用条(可多条), 发送时作上下文前置。桌面不占任何长按/选择手势。
  const quoteTray = wrap.querySelector('#chat-quote-tray');
  let quotedRefs = [];   // [{id, role, content}]
  const _qesc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function renderQuoteTray() {
    if (!quoteTray) return;
    if (!quotedRefs.length) { quoteTray.style.display = 'none'; quoteTray.innerHTML = ''; return; }
    quoteTray.style.display = 'flex';
    quoteTray.innerHTML = `<span class="chat-quote-label">引用 ${quotedRefs.length} 条:</span>` +
      quotedRefs.map((q) => `<span class="chat-quote-chip" title="${_qesc(q.content)}">${q.role === 'user' ? '你' : 'AI'}: ${_qesc((q.content || '').replace(/\s+/g, ' ').trim().slice(0, 40))}<span class="chat-quote-x" data-unquote="${_qesc(q.id)}">×</span></span>`).join('') +
      `<span class="chat-quote-clear" data-quote-clear>清空</span>`;
  }
  // 引用条上点 × / 清空
  quoteTray?.addEventListener('click', (e) => {
    const x = e.target.closest?.('[data-unquote]');
    if (x) { const id = x.getAttribute('data-unquote'); quotedRefs = quotedRefs.filter((q) => q.id !== id); renderQuoteTray(); return; }
    if (e.target.closest?.('[data-quote-clear]')) { quotedRefs = []; renderQuoteTray(); }
  });
  // 消息上「引用」按钮 → 把该条(role + 纯文本内容)加进引用条(去重)。
  const onQuoteClick = (e) => {
    const btn = e.target.closest?.('.chat-quote-btn[data-quote]');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const turnNode = btn.closest('.chat-turn');
    if (!turnNode) return;
    const id = btn.getAttribute('data-quote') || turnNode.dataset.turnId || ('q' + Date.now());
    if (quotedRefs.some((q) => q.id === id)) { input.focus(); return; }
    const role = turnNode.classList.contains('user') ? 'user' : 'assistant';
    const content = (turnNode.querySelector('.chat-content')?.textContent || '').trim();
    if (!content) return;
    quotedRefs.push({ id, role, content });
    renderQuoteTray();
    input.focus();
  };
  stream.addEventListener('click', onQuoteClick);
  const pillsBox = wrap.querySelector('#chat-sessions-pills');
  const addSessBtn = wrap.querySelector('#chat-sessions-add');
  const _esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 渲染会话切换条: 全局 + 已存在的策略会话(listSessions)。
  async function renderSessionBar() {
    if (!pillsBox) return;
    let sessions = [];
    try { sessions = (await window.easydeal.chat.listSessions?.()) || []; } catch {}
    // 保证全局恒在; 已含则用返回值
    if (!sessions.some((s) => s.key === 'global')) sessions.unshift({ key: 'global', kind: 'global', busy: false });
    // 若当前激活的策略会话还没进 listSessions(刚建、还没发消息)也补进去
    if (activeSessionKey !== 'global' && !sessions.some((s) => s.key === activeSessionKey)) {
      const parts = /^strat:([^:]+):([\s\S]+)$/.exec(activeSessionKey);
      sessions.push({ key: activeSessionKey, kind: 'strategy', login: parts?.[1], ea: parts?.[2], busy: false });
    }
    pillsBox.innerHTML = sessions.map((s) => {
      const isActive = s.key === activeSessionKey;
      const label = s.kind === 'global' ? '🌐 全局' : `${_esc(s.ea || '')}`;
      const sub = s.kind === 'strategy' && s.login ? `<span class="chat-pill-sub">${_esc(String(s.login))}</span>` : '';
      const dot = s.busy ? '<span class="chat-pill-busy"></span>' : '';
      const n = unreadByKey[s.key] || 0;
      const badge = (!isActive && n > 0) ? `<span class="chat-pill-badge">${n > 99 ? '99+' : n}</span>` : '';
      const del = s.kind === 'strategy' ? `<span class="chat-pill-del" data-del="${_esc(s.key)}" title="删除该策略会话">×</span>` : '';
      return `<button class="chat-pill${isActive ? ' active' : ''}" data-key="${_esc(s.key)}">${dot}<span class="chat-pill-label">${label}</span>${sub}${badge}${del}</button>`;
    }).join('');
  }

  async function switchSession(key) {
    if (!key || key === activeSessionKey) return;
    activeSessionKey = key;
    unreadByKey[key] = 0;   // 切过去 = 已读
    await renderSessionBar();
    await refreshHistory();
    refreshTodos();        // 切会话 → 换成该会话的任务进度
    refreshRemoteChip();   // 附加远程会话是 per-session 的, 切会话跟着换
    // 切到该会话时刷新一次它的 busy 态(停止按钮/footer)
    try {
      const busy = await window.easydeal.chat.busy(activeSessionKey === 'global' ? undefined : activeSessionKey);
      applyBusyUi(!!busy);
    } catch {}
    input.focus();
  }

  // 点 pill 切会话 / 点 × 删会话
  pillsBox?.addEventListener('click', async (e) => {
    const del = e.target.closest?.('[data-del]');
    if (del) {
      e.stopPropagation();
      const key = del.getAttribute('data-del');
      if (!confirm('删除这个策略会话?（会清掉它的对话历史，全局会话不受影响）')) return;
      try { await window.easydeal.chat.deleteSession(key); } catch {}
      if (activeSessionKey === key) { activeSessionKey = 'global'; await refreshHistory(); }
      await renderSessionBar();
      return;
    }
    const pill = e.target.closest?.('[data-key]');
    if (pill) await switchSession(pill.getAttribute('data-key'));
  });

  // 「＋策略会话」: 列出实时 MT5 各账户的策略, 选一个建独立会话
  addSessBtn?.addEventListener('click', async () => {
    let cands = [];
    try { cands = (await window.easydeal.chat.strategyCandidates?.()) || []; } catch {}
    // 去掉已存在的
    let existing = [];
    try { existing = (await window.easydeal.chat.listSessions?.()) || []; } catch {}
    const have = new Set(existing.map((s) => s.key));
    const fresh = cands.filter((c) => !have.has(c.key));
    if (!cands.length) { alert('没检测到正在运行的策略(先在 MT5 上挂载 EA)。'); return; }
    const pick = await openSessionPicker(fresh.length ? fresh : cands);
    if (pick) await switchSession(pick);
  });

  refreshHistory();
  renderSessionBar();
  refreshRemoteChip();
  refreshTodos();

  // 防御性清理：用户经常反馈「在设置页做完一个操作后回到对话页，输入框点不了」。
  // 怀疑是某个 overlay（drag-drop / lightbox / modal）的 dragenter 没有匹配的
  // dragleave，或者 modal 没正常 remove 残留在 body 上挡住底层 click。
  // 这里在 chat-view 入选时强制把已知会卡住的状态全清一遍 —— cheap，宁可多清。
  function _hardClearStuckOverlays() {
    try {
      const dropEl = wrap.querySelector('#chat-drop');
      if (dropEl) dropEl.classList.remove('active');
      // dragDepth 不能在这里 reset —— let 声明在下面，TDZ 问题。
      // 视觉上 active class 已经清掉，下一次 dragenter 会重新累加 dragDepth。
    } catch {}
    try {
      // 隐藏 lightbox（如果之前打开过没关闭）
      const lb = document.getElementById('chat-lightbox');
      if (lb) lb.classList.add('hidden');
    } catch {}
    try {
      // 隐藏 attachment 预览（鼠标移走时偶尔不触发 mouseleave）
      if (typeof hideAttachmentPreview === 'function') hideAttachmentPreview();
    } catch {}
    try {
      // body 上残留的 modal overlay（数据导入 / 诊断快照 / 截图查看 / 回测设置）
      // 全部清掉。所有这类 modal 都用 .modal-overlay 命名（如果某个用了别的
      // 名字，看不见也无所谓 —— 这里只清确认是 overlay 性质的 fixed 元素）
      for (const node of document.querySelectorAll('body > .modal-overlay, body > [data-modal="true"]')) {
        try { node.remove(); } catch {}
      }
    } catch {}
  }
  _hardClearStuckOverlays();

  // 新序列号首次登录后自动跑一次「7 步配置引导」对话。条件：
  //   1. 当前 license key 还没在 onboarding-state.json 里登记过
  //   2. chat 历史是空的（避免在已经有内容的会话里突然插一条）
  //   3. 不在忙（没正在跑的对话）
  // 触发后 main 会标记这条 key 为已启动，下次启动不再重弹。
  // 用户想重跑：教程标签的「重新跑一次首次配置引导」按钮（IPC reset-onboarding + requestOnboarding）。
  (async () => {
    try {
      const status = await window.easydeal.app?.onboardingStatus?.();
      if (!status?.needed) return;
      const history = await window.easydeal.chat.history();
      if (history.length > 0) return;
      const busy = await window.easydeal.chat.busy();
      if (busy) return;
      // 等 1.5s 让 chat-empty 引导文案先出来 —— 用户先看到欢迎再开始引导
      // 比一上来就刷长串 prompt 更有节奏感。
      setTimeout(() => {
        window.easydeal.app.requestOnboarding().catch((e) =>
          console.warn('[onboarding] requestOnboarding failed:', e?.message || e));
      }, 1500);
    } catch (e) {
      console.warn('[onboarding] auto-trigger check failed:', e?.message || e);
    }
  })();

  // -------- history --------
  // 1.4.x 历史分页: 滚到顶部再往上翻, 从 ai-comm-log(保留4000+行, 远超 chat.json
  // 硬截断的200条)回读更早消息。每次切会话/刷新都重置这三个状态。
  let _oldestLoadedTs = null;   // 当前已加载最早一条的 ts, 分页的 beforeTs 锚点
  let _noMoreOlder = false;     // 上次分页拉空 = 真没有更早的了, 不再触发
  let _loadingOlder = false;    // 防抖: 拉取进行中不重入

  async function loadOlderMessages() {
    if (_loadingOlder || _noMoreOlder || _oldestLoadedTs == null) return;
    _loadingOlder = true;
    let tip = stream.querySelector('#chat-load-older-tip');
    if (!tip) { tip = el('div', 'chat-load-older-tip'); tip.id = 'chat-load-older-tip'; stream.insertBefore(tip, stream.firstChild); }
    tip.textContent = '加载更早的消息…';
    try {
      const sk = activeSessionKey === 'global' ? undefined : activeSessionKey;
      const older = await window.easydeal.chat.historyBefore(sk, _oldestLoadedTs, 30);
      if (!older || !older.length) {
        _noMoreOlder = true;
        tip.textContent = '没有更早的消息了';
        setTimeout(() => { try { tip.remove(); } catch {} }, 1500);
        return;
      }
      const prevScrollHeight = stream.scrollHeight;
      const prevScrollTop = stream.scrollTop;
      const frag = document.createDocumentFragment();
      for (const t of older) renderTurn(frag, t);
      stream.insertBefore(frag, tip);
      // 保持视觉锚点: 插入内容后把 scrollTop 顺移新增的高度, 视觉上不跳动。
      stream.scrollTop = prevScrollTop + (stream.scrollHeight - prevScrollHeight);
      _oldestLoadedTs = older[0].ts;
    } catch { /* 拉取失败静默, 下次滚动再重试(不置 _noMoreOlder) */ }
    finally { _loadingOlder = false; }
  }
  stream.addEventListener('scroll', () => {
    if (stream.scrollTop < 60) loadOlderMessages();
  });

  // 1.5.1: AI 任务进度面板 —— 读当前会话 CC 原生 todos。
  // 1.5.3: 加手动增删改, 面板不再"全部完成/无待办就隐藏"——只要能看到就能管理,
  // 用户可以随时手动加一条(不用等 AI 自己建); 真正 0 条(且没在编辑/没在加)时
  // 才隐藏整块, 避免每个新会话都常驻一条空面板。
  const todosBox      = wrap.querySelector('#chat-todos');
  const todosList     = wrap.querySelector('#chat-todos-list');
  const todosCount    = wrap.querySelector('#chat-todos-count');
  const todosBarFill  = wrap.querySelector('#chat-todos-bar-fill');
  const todosHead     = wrap.querySelector('#chat-todos-head');
  const todosCaret    = wrap.querySelector('#chat-todos-caret');
  const todosAddRow   = wrap.querySelector('#chat-todos-add-row');
  const todosAddInput = wrap.querySelector('#chat-todos-add-input');
  const todosAddBtn   = wrap.querySelector('#chat-todos-add-btn');
  let _todosCollapsed = false;
  todosHead?.addEventListener('click', () => {
    _todosCollapsed = !_todosCollapsed;
    todosList.style.display = _todosCollapsed ? 'none' : '';
    todosAddRow.style.display = _todosCollapsed ? 'none' : '';
    todosCaret.textContent = _todosCollapsed ? '▸' : '▾';
  });

  async function _submitAddTodo() {
    const text = (todosAddInput.value || '').trim();
    if (!text) return;
    todosAddBtn.disabled = true;
    try {
      const r = await window.easydeal.chat.addTodo?.(_skArg(), text);
      if (r && r.ok) { todosAddInput.value = ''; await refreshTodos(); }
    } catch { /* 静默, 输入内容保留让用户重试 */ }
    finally { todosAddBtn.disabled = false; }
  }
  todosAddBtn?.addEventListener('click', _submitAddTodo);
  todosAddInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _submitAddTodo(); }
  });

  // 事件委托: 列表整个 innerHTML 每次刷新都会重建, 监听器挂在常驻的 <ul> 上,
  // 不用每次刷新后重新逐项绑定。
  todosList?.addEventListener('click', async (e) => {
    const li = e.target.closest?.('.chat-todo-item');
    if (!li) return;
    const id = li.getAttribute('data-id');
    if (!id) return;
    if (e.target.closest('.chat-todo-icon')) {
      // 点状态图标: 完成 ↔ 未完成(pending) 切换; in_progress 点一下直接标完成。
      const cur = li.getAttribute('data-status');
      const next = cur === 'completed' ? 'pending' : 'completed';
      try { await window.easydeal.chat.setTodoStatus?.(_skArg(), id, next); await refreshTodos(); } catch {}
      return;
    }
    if (e.target.closest('.chat-todo-del')) {
      if (!confirm('删除这条任务?')) return;
      try { await window.easydeal.chat.deleteTodo?.(_skArg(), id); await refreshTodos(); } catch {}
      return;
    }
    if (e.target.closest('.chat-todo-edit')) {
      const textSpan = li.querySelector('.chat-todo-text');
      if (!textSpan || li.querySelector('.chat-todo-edit-input')) return;   // 已经在编辑中
      const cur = textSpan.textContent;
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'chat-todo-edit-input'; input.maxLength = 200;
      input.value = cur;
      textSpan.replaceWith(input);
      input.focus(); input.select();
      // Enter 提交后 refreshTodos() 会把这个 input 从 DOM 换掉, 浏览器可能对
      // 被移除的焦点元素补触发一次 blur → 再调一次 commit()。加标记防止重复提交。
      let _committed = false;
      const commit = async () => {
        if (_committed) return;
        _committed = true;
        const v = input.value.trim();
        if (v && v !== cur) {
          try { await window.easydeal.chat.editTodo?.(_skArg(), id, v); } catch {}
        }
        await refreshTodos();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); _committed = true; refreshTodos(); }
      });
      input.addEventListener('blur', commit);
    }
  });

  async function refreshTodos() {
    let todos = [];
    try { todos = (await window.easydeal.chat.getTodos?.(_skArg())) || []; }
    catch { todos = []; }
    if (!todos.length) { todosBox.style.display = 'none'; return; }
    todosBox.style.display = '';
    const done = todos.filter((t) => t.status === 'completed').length;
    todosCount.textContent = `${done}/${todos.length}`;
    todosBarFill.style.width = `${Math.round(done / todos.length * 100)}%`;
    todosList.innerHTML = todos.map((t) => {
      const st = t.status;
      const icon = st === 'completed' ? '✓' : (st === 'in_progress' ? '🔄' : '○');
      const text = st === 'in_progress' ? (t.activeForm || t.content || '(空)') : (t.content || t.activeForm || '(空)');
      return `<li class="chat-todo-item status-${st}" data-id="${escape(t.id || '')}" data-status="${st}">`
        + `<span class="chat-todo-icon" title="点击切换完成/未完成">${icon}</span>`
        + `<span class="chat-todo-text">${escape(text)}</span>`
        + `<span class="chat-todo-actions">`
        + `<button class="chat-todo-edit" title="编辑">✎</button>`
        + `<button class="chat-todo-del" title="删除">×</button>`
        + `</span></li>`;
    }).join('');
  }

  async function refreshHistory() {
    // 多会话: 拉当前激活会话的历史(全局传 undefined = 旧行为)。
    const history = await window.easydeal.chat.history(activeSessionKey === 'global' ? undefined : activeSessionKey);
    stream.innerHTML = '';
    // 切会话/刷新 → 重置分页状态; 空历史不提供分页入口(避免新会话翻出重置前的老消息)。
    _oldestLoadedTs = history.length ? history[0].ts : null;
    _noMoreOlder = false;
    if (!history.length) {
      const empty = el('div', 'chat-empty');
      empty.innerHTML = `
        <div class="chat-empty-icon">🤝</div>
        <h3>和 EasyDeal 一起打造自己的交易系统</h3>
        <ol class="chat-onboarding">
          <li>
            <strong>创建策略</strong>
            <span>用 AI 创建自己的策略并自动回测验证</span>
            <span class="chat-suggest" data-msg="我想创建一个策略，帮我从思路开始引导：先问我交易品种 / 周期 / 入场逻辑 / 风控规则，然后写到 strategies/，编译，跑一次回测看看效果">动手</span>
          </li>
          <li>
            <strong>监控策略</strong>
            <span>持续盯着策略执行情况，异常时提醒、自要时调参</span>
            <span class="chat-suggest" data-msg="帮我把现在跑着的 EA 接入监控：先确保每只 EA 都有 strategies/&lt;EA&gt;.md 策略说明（没有的话基于源码生成一份），再基于说明里的「Agent 监控建议」章节给我建对应的定时任务">动手</span>
          </li>
          <li>
            <strong>分析决策</strong>
            <span>接通 MT5 盘面情况、深入分析运行策略，给出处理意见</span>
            <span class="chat-suggest" data-msg="看一下我现在 MT5 的账户状态、所有持仓、最近 50 根 K 线，结合在跑的 EA 的策略说明，给我一份现状评估和建议">动手</span>
          </li>
          <li>
            <strong>代理操作</strong>
            <span>AI 会尽量完成你提出的所有要求</span>
            <span class="chat-suggest" data-msg="我要你帮我做点事：">动手</span>
          </li>
        </ol>
        <div class="chat-onboarding-hint">
          点「动手」自动填到输入框 — 你可以再改改再发。<br>
          <span class="chat-suggest" data-msg="我自己在 MT5 里跑过了 strategy tester，把 Detailed Report 存到了 analysis/ 下了，路径我等下发你 — 你 Read 那个 .htm 报告，对照对应 EA 的 strategies/&lt;EA&gt;.md 给我评估和下一步建议。">已经手动跑过了 — 让 AI 读报告分析</span>
        </div>
      `;
      stream.appendChild(empty);
      empty.addEventListener('click', (e) => {
        const m = e.target.dataset?.msg;
        if (m) { input.value = m; input.focus(); }
      });
      return;
    }
    for (const turn of history) renderTurn(stream, turn);
    stream.scrollTop = stream.scrollHeight;
  }

  // 滚动跟随策略：用户在 AI 还在 streaming 时往上翻去看历史，新消息更新
  // 不能把视图硬拽回底部 —— 不然根本读不下去。规则：在更新 DOM 之前 snapshot
  // 一下「用户当前是不是基本贴在底部」，只有贴底时才在更新后跟着往下走。
  // 80px 容差是经验值：浏览器 layout 经常给底部留几像素，过紧会假阴性，
  // 过松又会在用户故意往上翻一两屏时还是被拉回。
  const STICK_BOTTOM_THRESHOLD_PX = 80;
  const isStickingToBottom = () =>
    (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < STICK_BOTTOM_THRESHOLD_PX;
  const stickToBottomIfWasSticking = (wasSticking) => {
    if (wasSticking) stream.scrollTop = stream.scrollHeight;
  };

  // 0.3.7: 用户主动 send 时的强制滚底。直接 `scrollTop = scrollHeight`
  // 在 .chat-stream 上不靠谱：CSS 设了 `scroll-behavior: smooth`，赋值
  // 触发的是动画；而紧接着 busy footer 显出来 + assistant 占位 turn
  // append + spinner 入场，scrollHeight 一直在涨，smooth 动画的目标点
  // 是赋值那一帧的旧值 → 动画走完落点不是新底。临时把 behavior 切成
  // auto 瞬时落定，再用 double-rAF 在后续 layout 也定下来后补一次。
  // 同时记一个 250ms 的窗口，期间任何 append/stream 事件都按"刚发完"
  // 处理（强制贴底，绕开 stickiness 阈值），覆盖 spinner / footer 的
  // 二次扰动。
  let _justSentUntilTs = 0;
  const forceScrollToBottom = () => {
    const prev = stream.style.scrollBehavior;
    stream.style.scrollBehavior = 'auto';
    stream.scrollTop = stream.scrollHeight;
    requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
      requestAnimationFrame(() => {
        stream.scrollTop = stream.scrollHeight;
        stream.style.scrollBehavior = prev;
      });
    });
  };
  const inJustSentWindow = () => Date.now() < _justSentUntilTs;

  // 序列号绑定授权卡片按钮(CSP 禁内联 onclick → 事件委托)
  stream.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-bind-approve], button[data-bind-reject]');
    if (!btn) return;
    const approve = btn.hasAttribute('data-bind-approve');
    const reqId = parseInt(btn.getAttribute(approve ? 'data-bind-approve' : 'data-bind-reject'), 10);
    if (!reqId) return;
    const card = btn.closest('.bind-approval-card');
    if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    let r;
    try { r = await window.easydeal.chat.decideBindApproval(reqId, approve); }
    catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    const ok = r && (r.ok || r.status === 'approved' || r.status === 'denied');
    if (card) {
      const tip = document.createElement('div');
      tip.style.cssText = 'margin-top:8px;font-size:13px;font-weight:600;';
      let msg;
      if (ok) msg = approve ? '✓ 已授权 — 手机已开通终身免费' : '已拒绝';
      else if (r?.status === 'expired') msg = '⏰ 该授权请求已过期,请在手机上重新发起绑定(升级电脑端后,过期也可直接授权)';
      else msg = '操作失败: ' + (r?.error || r?.detail || '网络异常,请重试');
      tip.textContent = msg;
      card.appendChild(tip);
      if (!ok) card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });

  // -------- IPC subscriptions --------
  // 多会话: 事件带 sessionKey(第2参)。只有属于「当前激活会话」的事件才动 stream;
  // 别的会话的事件用来刷会话条(busy 点)。evtKey 缺省(老全局事件无第2参)= 'global'。
  const _isActiveEvt = (sessionKey) => (sessionKey || 'global') === activeSessionKey;
  // 把 busy UI 逻辑抽出来复用(切会话时也要按目标会话 busy 态刷一遍)。
  function applyBusyUi(busy) {
    sendBtn.disabled = false;
    if (busy) {
      sendBtn.textContent = '补充';
      sendBtn.title = 'AI 正在跑——发送会停下当前回复，把新消息接上去（已经做的事会留作上下文）';
    } else {
      sendBtn.textContent = '发送';
      sendBtn.title = '发送 (Enter)';
    }
    stopBtn.disabled = !busy;
    status.textContent = busy ? 'AI 思考中…' : '';
    status.className = 'chat-status' + (busy ? ' active' : '');
    const footer = wrap.querySelector('#chat-busy-footer');
    if (footer) footer.style.display = busy ? 'flex' : 'none';
    if (!busy) {
      try { stream.querySelectorAll('details.chat-thinking[open]').forEach((d) => d.removeAttribute('open')); } catch {}
    }
  }
  window.easydeal.chat.on('append', (turn, sessionKey) => {
    if (!_isActiveEvt(sessionKey)) {
      // 别的会话来消息 → 累加未读(只算 AI 回复, 不算它自己的用户消息) + 刷会话条角标
      if (turn && turn.role === 'assistant') {
        const k = sessionKey || 'global';
        unreadByKey[k] = (unreadByKey[k] || 0) + 1;
      }
      renderSessionBar();
      return;
    }
    if (stream.querySelector('.chat-empty')) stream.innerHTML = '';
    if (turn.id && stream.querySelector(`[data-turn-id="${turn.id}"]`)) return;
    // 0.3.1: 用户自己发的 turn 强制滚到底（不论之前是否贴底）—— 用户
    // 点了发送就期望立刻看到自己的消息，跟看 AI streaming 时的"翻历史
    // 不被拽回"是两件事。AI / 系统 turn 仍走 sticky-bottom 逻辑。
    // 0.3.7: 用 forceScrollToBottom 替掉简单 scrollTop 赋值（绕开 smooth
    // 动画 + 后续 layout 抖动），并开启 250ms just-sent 窗口让紧跟着
    // 进来的 assistant 占位 turn / spinner 也强制贴底。
    if (turn.role === 'user') {
      renderTurn(stream, turn);
      _justSentUntilTs = Date.now() + 250;
      forceScrollToBottom();
      return;
    }
    const stick = inJustSentWindow() ? true : isStickingToBottom();
    renderTurn(stream, turn);
    if (inJustSentWindow()) forceScrollToBottom();
    else stickToBottomIfWasSticking(stick);
  });
  window.easydeal.chat.on('update', (turn, sessionKey) => {
    if (!_isActiveEvt(sessionKey)) return;
    const sel = turn.id ? `[data-turn-id="${turn.id}"]` : `[data-turn-ts="${turn.ts}"]`;
    const node = stream.querySelector(sel);
    const stick = isStickingToBottom();
    if (!node) renderTurn(stream, turn);
    else updateTurn(node, turn);
    stickToBottomIfWasSticking(stick);
  });
  window.easydeal.chat.on('progress', ({ id, partial }, sessionKey) => {
    if (!_isActiveEvt(sessionKey)) return;
    if (!id) return;
    const node = stream.querySelector(`[data-turn-id="${id}"]`);
    if (!node) return;
    const c = node.querySelector('.chat-content');
    if (!c) return;
    const stick = inJustSentWindow() ? true : isStickingToBottom();
    c.innerHTML = formatContent({ role: 'assistant', content: partial, pending: true });
    if (inJustSentWindow()) forceScrollToBottom();
    else stickToBottomIfWasSticking(stick);
  });
  window.easydeal.chat.on('stream', ({ id, append, mutate }, sessionKey) => {
    if (!_isActiveEvt(sessionKey)) return;
    const node = stream.querySelector(`[data-turn-id="${id}"]`);
    if (!node) return;
    const c = node.querySelector('.chat-content');
    if (!c) return;
    // Remove the "thinking..." spinner once any real content arrives.
    if (c.querySelector('.chat-spinner')) c.innerHTML = '';
    const stick = inJustSentWindow() ? true : isStickingToBottom();
    if (append) appendSegment(c, append);
    else if (mutate) mutateSegment(c, mutate.index, mutate.segment);
    if (inJustSentWindow()) forceScrollToBottom();
    else stickToBottomIfWasSticking(stick);
  });
  window.easydeal.chat.on('busy', (busy, sessionKey) => {
    // 别的会话 busy 变化 → 只刷会话条上的 busy 点, 不动当前视图的按钮/footer。
    if (!_isActiveEvt(sessionKey)) { renderSessionBar(); return; }
    // 当前激活会话: 更新发送/停止/footer(补充=发送会中断当前轮并接上新消息)。
    applyBusyUi(!!busy);
    // 轮次进行/结束都刷任务进度(CC 在轮内多次 TodoWrite, 结束时收尾)。
    refreshTodos();
  });
  window.easydeal.chat.on('reset', async (_payload, sessionKey) => {
    if (!_isActiveEvt(sessionKey)) { renderSessionBar(); return; }
    if (currentDraftId) {
      try { await window.easydeal.chat.clearDraft(currentDraftId); } catch {}
      currentDraftId = null;
    }
    currentAttachments = [];
    renderAttachmentStrip();
    refreshHistory();
  });
  // 用户案例: 升级强制退出后发现最近对话没持久化(之前记录都在)——durableWriteSync
  // 失败时早就 emit persist-error, 但之前没人监听, 用户对"正在悄悄丢数据"毫无察觉,
  // 直到某次冷启动读盘才发现差距。这里加一条**不自动消失**的顶部横幅(跟普通 4s toast
  // 不同, 数据风险类提示要用户主动点掉才算看到), 点「知道了」才关闭; 系统通知见 main.js。
  window.easydeal.chat.on('persist-error', (payload) => {
    try {
      let bar = document.getElementById('chat-persist-error-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'chat-persist-error-bar';
        bar.className = 'chat-persist-error-bar';
        wrap.insertBefore(bar, wrap.firstChild);
      }
      bar.innerHTML = `⚠ 对话记录保存失败(${(payload && payload.reason) || '未知原因'})，最新消息可能未落盘。
        请检查磁盘空间/权限，必要时重启客户端。<button id="chat-persist-error-dismiss">知道了</button>`;
      bar.querySelector('#chat-persist-error-dismiss')?.addEventListener('click', () => bar.remove());
    } catch {}
  });

  // -------- send --------
  async function send() {
    const raw = input.value.trim();
    if (!raw && !currentAttachments.length) return;
    // 引用: 把引用条里的消息拼成上下文块前置到正文, 然后清空引用条。
    let msg = raw;
    if (quotedRefs.length) {
      const q = quotedRefs.map((x) => `> [${x.role === 'user' ? '我' : 'AI'}] ${(x.content || '').replace(/\s+/g, ' ').trim().slice(0, 500)}`).join('\n');
      msg = `【引用了以下 ${quotedRefs.length} 条消息作为上下文】\n${q}\n\n${raw}`;
      quotedRefs = [];
      renderQuoteTray();
    }
    const draftId = currentDraftId;
    input.value = '';
    // Don't disable the send button — main process handles abort+queue
    // internally. Disabling here would just create a tiny dead window.
    currentDraftId = null;
    currentAttachments = [];
    renderAttachmentStrip();
    await window.easydeal.chat.send(msg, draftId, activeSessionKey === 'global' ? undefined : activeSessionKey);
  }
  sendBtn.addEventListener('click', send);

  // ---------- @-mention strategy picker ----------
  // Type "@" anywhere in the input → popup lists strategies (workspace/strategies/).
  // Continue typing to filter. Arrow keys + Enter to pick. Esc to cancel.
  // Selecting "GMarket" inserts the literal token `@GMarket` so Claude sees a
  // clear reference (the Claude system prompt explains @ refers to a strategy file).
  const mention = createMentionPicker(input);

  input.addEventListener('keydown', (e) => {
    // Mention popup intercepts arrow keys / enter / esc / tab when open.
    if (mention.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mention.move(+1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); mention.move(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        mention.commit();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); mention.close(); return; }
    }
    // Default: Enter sends; Shift+Enter for newline; Ctrl+Enter still sends as alt.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // Detect @-trigger after each keystroke / input change. We use 'input'
  // (covers paste, IME composition end, programmatic edits) instead of
  // keypress so we don't miss anything.
  input.addEventListener('input', () => mention.refresh());
  input.addEventListener('blur', () => setTimeout(() => mention.close(), 200));
  sessionHistoryBtn.addEventListener('click', async () => {
    const _sk = activeSessionKey === 'global' ? undefined : activeSessionKey;
    const oldText = sessionHistoryBtn.textContent;
    sessionHistoryBtn.disabled = true;
    sessionHistoryBtn.textContent = '读取中…';
    try {
      const sessions = await window.easydeal.chat.recoverableSessions(_sk);
      const sessionId = await openClaudeSessionHistoryModal(sessions || []);
      if (!sessionId) return;
      const r = await window.easydeal.chat.restoreSession(_sk, sessionId);
      if (!r?.ok) {
        alert('恢复会话失败：' + (r?.error || '未知错误'));
        return;
      }
      const toast = document.createElement('div');
      toast.className = 'chat-toast';
      toast.textContent = `↩ 已恢复「${r.title || '历史会话'}」，下一条消息会接着该会话继续`;
      wrap.appendChild(toast);
      setTimeout(() => toast.remove(), 5000);
    } catch (e) {
      alert('读取历史会话失败：' + (e?.message || e));
    } finally {
      sessionHistoryBtn.disabled = false;
      sessionHistoryBtn.textContent = oldText;
    }
  });
  resetBtn.addEventListener('click', async () => {
    // 0.2.4 起：「新会话」给三选一对话框（不是单纯的 confirm）：
    //   - 清除记录：彻底重置，AI 重新认识你
    //   - 带摘要去新会话：先让 AI 总结现有对话 + 列出仍要保留的附件，
    //     落地 chat-carryover.json，下条新消息发送时会把摘要 prepend
    //     给 Claude；摘要里点名要保留的附件目录免被 7 天 GC 误删
    //   - 取消
    const choice = await openNewChatChoiceModal();
    if (choice === 'cancel' || !choice) return;
    const _sk = activeSessionKey === 'global' ? undefined : activeSessionKey;
    if (choice === 'clear') {
      await window.easydeal.chat.reset(_sk);
      return;
    }
    if (choice === 'carryover') {
      // 立即在 UI 显示一个轻量提示：AI 正在整理摘要……
      // chat.requestCarryoverAndReset() 自己会通过 chat:append 事件把
      // 摘要请求 + AI 摘要回复写到当前 history（用户能看见整理过程，
      // 不是黑箱），然后 reset 触发 chat:reset 把 history 清掉。
      const r = await window.easydeal.chat.resetWithCarryover(_sk);
      if (!r?.ok) {
        alert('摘要生成失败：' + (r?.error || '未知错误'));
        return;
      }
      // reset 已触发，UI 自动刷成新会话；这里给个 toast 风格提示
      try {
        const toast = document.createElement('div');
        toast.className = 'chat-toast';
        toast.textContent = `✅ 已带摘要进入新会话${r.kept_files?.length ? `，保留 ${r.kept_files.length} 个文件` : ''}`;
        wrap.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
      } catch {}
    }
  });
  stopBtn.addEventListener('click', () => window.easydeal.chat.stop(activeSessionKey === 'global' ? undefined : activeSessionKey));

  // -------- attachments: pick button --------
  attachBtn.addEventListener('click', async () => {
    const did = await ensureDraftId();
    const added = await window.easydeal.chat.attachPick(did);
    handleAttachResult(added);
  });

  // -------- attachments: paste --------
  input.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const items = cd.items ? Array.from(cd.items) : [];
    const files = cd.files ? Array.from(cd.files) : [];

    // Pick image/file items first; if none, let the default paste (text) happen.
    const fileItems = items.filter((i) => i.kind === 'file');
    if (!fileItems.length && !files.length) return; // plain text paste — proceed normally
    e.preventDefault();

    const did = await ensureDraftId();
    const added = [];
    for (const it of fileItems) {
      const blob = it.getAsFile();
      if (!blob) continue;
      const name = blob.name && blob.name !== 'image.png'
        ? blob.name
        : `pasted-${Date.now()}.${(it.type.split('/')[1] || 'bin')}`;
      const buf = new Uint8Array(await blob.arrayBuffer());
      const b64 = bufferToBase64(buf);
      const r = await window.easydeal.chat.attachBuffer(did, name, b64);
      added.push(r);
    }
    handleAttachResult(added);
  });

  // -------- attachments: drag-drop --------
  let dragDepth = 0;
  wrap.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('active');
  });
  wrap.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  wrap.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.remove('active');
  });
  wrap.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('active');
    const files = Array.from(e.dataTransfer.files);
    const paths = files.map((f) => f.path).filter(Boolean);
    if (!paths.length) return;
    const did = await ensureDraftId();
    const added = await window.easydeal.chat.attachPaths(did, paths);
    handleAttachResult(added);
  });

  // -------- attachment chip strip --------
  attachStrip.addEventListener('click', async (e) => {
    const name = e.target.dataset?.removeName;
    if (!name) return;
    if (!currentDraftId) return;
    // 1.4.11: 删附件前先强制藏 hover 预览浮窗 —— 鼠标悬在 chip 上时删除, chip 元素被移除后
    // mouseleave 不会触发 → 放大预览卡死在客户端上不消失(用户报)。这里主动清一次。
    hideAttachmentPreview();
    try {
      await window.easydeal.chat.removeAttachment(currentDraftId, name);
      currentAttachments = currentAttachments.filter((a) => a.name !== name);
      renderAttachmentStrip();
    } catch (err) {
      showToast('删除失败：' + err.message, 'error');
    }
  });

  function handleAttachResult(added) {
    if (!Array.isArray(added)) return;
    const errs = added.filter((a) => a.error);
    const okItems = added.filter((a) => !a.error);
    for (const a of okItems) {
      // If adding an updated copy with same name (uniqueness ensures distinct names),
      // just append.
      currentAttachments.push(a);
    }
    if (errs.length) {
      showToast(`部分文件未添加：${errs.map((e) => `${e.name}: ${e.error}`).join('; ')}`, 'error');
    }
    renderAttachmentStrip();
  }

  function renderAttachmentStrip() {
    // 1.4.11: 重渲染前藏预览浮窗 —— innerHTML='' 会移除正被 hover 的 chip, mouseleave 不触发,
    // 预览残留。删除/发送清空/切会话等任何重渲染路径都覆盖到, 防浮窗卡死。
    hideAttachmentPreview();
    attachStrip.innerHTML = '';
    if (!currentAttachments.length) {
      attachStrip.classList.add('empty');
      return;
    }
    attachStrip.classList.remove('empty');
    for (const a of currentAttachments) {
      const chip = el('div', 'chat-chip');
      const isImg = a.kind === 'image';
      if (isImg) chip.classList.add('chat-chip-image');
      // 0.2.6 起：composer chip 跟 bubble chip 一致，图片附件直接渲染 inline
      // 缩略图（点击放大走全局 lightbox 委托）；非图片仍是 emoji icon。
      // src 不立刻塞 —— 异步拿 data URL 再设，避免阻塞 UI 渲染。
      // 0.x: composer 预览缩略图直接用 easydeal-asset 协议(跟发送后气泡同源, 立即渲染)。
      // 之前靠异步 getAttachmentDataUrl 塞 src, 该 IPC 偶发失败 → 粘贴后预览破图(发出去却正常)。
      const assetSrc = a.relPath ? `easydeal-asset:///${encodeURI(a.relPath)}` : '';
      const head = isImg
        ? `<img class="chat-chip-thumb"${assetSrc ? ` src="${assetSrc}"` : ''} alt="${escape(a.name)}" title="点击放大">`
        : `<span class="chip-icon">${kindIcon(a.kind)}</span>`;
      chip.innerHTML = `
        ${head}
        <span class="chip-name" title="${escape(a.relPath)}">${escape(a.name)}</span>
        <span class="chip-size">${fmtSize(a.size)}</span>
        <button class="chip-x" data-remove-name="${escape(a.name)}" title="移除">×</button>
      `;
      if (isImg) {
        // 异步拿 data URL 塞 <img>.src，同时缓存到 dataset 给 hover 浮窗 +
        // 点击 lightbox 复用，避免反复 IPC。
        const img = chip.querySelector('.chat-chip-thumb');
        if (assetSrc) chip.dataset.previewSrc = assetSrc;   // 先用 asset(hover/lightbox 兜底可用)
        // 仍异步拿 data URL: 成功则覆盖(hover 更稳/离线可用), 失败也不影响缩略图(已有 asset src)。
        (async () => {
          if (!currentDraftId) return;
          try {
            const url = await window.easydeal.chat.getAttachmentDataUrl(currentDraftId, a.name);
            if (!url) return;
            chip.dataset.previewSrc = url;
            if (img) img.src = url;
          } catch {}
        })();
        // hover 浮窗预览（鼠标静止时显示中等尺寸预览，跟 0.1.x 行为一致）
        chip.addEventListener('mouseenter', () => {
          if (chip.dataset.previewSrc) showAttachmentPreview(chip, chip.dataset.previewSrc);
        });
        chip.addEventListener('mouseleave', hideAttachmentPreview);
      }
      attachStrip.appendChild(chip);
    }
  }

  // 浮窗预览 — 单例，鼠标进 chip 显示，离开时藏。挂在 body 上 absolute
  // 定位，避免被 chat-input-row 的 overflow 切掉。
  let _previewEl = null;
  function showAttachmentPreview(chip, src) {
    if (!_previewEl) {
      _previewEl = document.createElement('div');
      _previewEl.className = 'chat-chip-preview';
      document.body.appendChild(_previewEl);
    }
    _previewEl.innerHTML = `<img src="${src}" alt="">`;
    // 定位到 chip 正上方居中，没空间往下放就翻到 chip 下方
    const r = chip.getBoundingClientRect();
    _previewEl.style.display = 'block';
    // 下一帧拿到 _previewEl 实际尺寸再算位置（避免首次显示位置错位）
    requestAnimationFrame(() => {
      if (!_previewEl) return;
      const pw = _previewEl.offsetWidth;
      const ph = _previewEl.offsetHeight;
      let left = r.left + r.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      let top = r.top - ph - 8;
      if (top < 8) top = r.bottom + 8;
      _previewEl.style.left = left + 'px';
      _previewEl.style.top = top + 'px';
    });
  }
  function hideAttachmentPreview() {
    if (_previewEl) _previewEl.style.display = 'none';
  }

  async function ensureDraftId() {
    if (!currentDraftId) currentDraftId = await window.easydeal.chat.newDraft();
    return currentDraftId;
  }

  // ---- Model switcher (Fay mode only) ----
  // 头部下拉：只在 fay 模式下展示。列出当前 license 有权限 + 服务端
  // 当前可用的 model；选择后立刻调 fayIssue 重签 token。
  const modelWrap = wrap.querySelector('#chat-model-wrap');
  const modelSel  = wrap.querySelector('#chat-model-pick');
  const modelMsg  = wrap.querySelector('#chat-model-msg');

  async function refreshModelSwitcher() {
    if (!modelWrap) return;
    let cfg;
    try { cfg = await window.easydeal.token.get(); } catch { cfg = null; }
    if (!cfg || cfg.mode !== 'fay') {
      modelWrap.style.display = 'none';
      return;
    }
    modelWrap.style.display = 'inline-flex';
    modelSel.innerHTML = `<option value="">— 加载中 —</option>`;
    modelSel.disabled = true;
    modelMsg.textContent = '';
    let r;
    try { r = await window.easydeal.token.listFayModels(); }
    catch (e) {
      modelSel.innerHTML = `<option value="">加载失败</option>`;
      modelMsg.textContent = e.message || '失败';
      return;
    }
    if (!r.ok || !r.models?.length) {
      modelSel.innerHTML = `<option value="">无可用模型</option>`;
      modelMsg.textContent = r.note || (r.error || '无可用模型');
      return;
    }
    // 0.2.6 起：模型下拉只显示模型名，不再带「· 可用 NN」尾巴 ——
    // 跟 token-view 0.1.52 同一逻辑（用户反馈这个数字让人误以为是「这个
    // 模型还能发多少条」，其实是后端通道总额度，对单条对话没意义）。
    // 1.x 计费倍率: ≠1 的带「⚡2.5x」标 — 选贵模型前心里有数(按倍率扣配额)。
    modelSel.innerHTML = r.models.map((m) => {
      const mult = (m.multiplier ?? 1) !== 1 ? ` ⚡${m.multiplier}x` : '';
      return `<option value="${escape(m.id)}">${escape(m.name || m.id)}${mult}</option>`;
    }).join('');
    if (cfg.fay?.cached_model) modelSel.value = cfg.fay.cached_model;
    modelSel.disabled = false;
  }

  if (modelSel) {
    modelSel.addEventListener('change', async () => {
      const m = modelSel.value;
      if (!m) return;
      modelMsg.textContent = '签发中…';
      modelSel.disabled = true;
      try {
        const r = await window.easydeal.token.fayIssue(m);
        if (r.ok) {
          modelMsg.textContent = `✓ 已切到 ${m.length > 16 ? m.slice(0, 14) + '…' : m}`;
          setTimeout(() => { modelMsg.textContent = ''; }, 3000);
        } else {
          modelMsg.textContent = r.error || '签发失败';
        }
      } catch (e) {
        modelMsg.textContent = e.message || '失败';
      } finally {
        modelSel.disabled = false;
      }
    });
  }

  // 第一次刷一遍。
  refreshModelSwitcher();
  // 0.3.29 fix: 用户在 Token tab 改 mode 后切回 chat tab，必须重检 model
  // selector 可见性（之前 chat-view 是 mounted 状态，refresher 没注册，
  // 下拉僵在旧状态 — fay→custom 后下拉还显示 / custom→fay 后下拉不出来）。
  // 把 refreshModelSwitcher 作为 refresher 返回给 renderer.js，切回本 tab
  // 自动重跑。
  //
  // 0.3.49 加：订阅 token cache 变化事件 —— 主进程 channel fallback / auto-issue
  // 后 setFay 完会 broadcast 这个事件，下拉立刻同步到新 cached_model（之前
  // 只 tab 切回才 refresh，用户在 chat tab 不动时看不到 fallback 的 model 切换）。
  try { window.easydeal.token.onCachedChanged?.(() => refreshModelSwitcher()); } catch {}
  return () => { refreshModelSwitcher(); resetHideNotes(); };
}

function formatN(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1000) return Math.round(n / 100) / 10 + 'k';
  return String(n);
}

// ---------------- helpers ----------------

function fmtTurnTs(ts) {
  // 北京时间显示。今天的消息 → HH:mm；非今天 → MM-DD HH:mm。
  if (!ts || !Number.isFinite(Number(ts))) return '';
  try {
    const d = new Date(Number(ts));
    const now = new Date();
    const sameDay =
      d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) ===
      now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      ...(sameDay
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    });
  } catch { return ''; }
}

function renderTurn(host, turn) {
  // system-note class → 「隐藏通知消息」勾选时由 CSS 隐藏(stream 容器加 .hide-system-notes)
  const node = el('div', `chat-turn ${turn.role}${turn.systemNote ? ' system-note' : ''}`);
  if (turn.id) node.dataset.turnId = turn.id;
  if (turn.ts) node.dataset.turnTs = turn.ts;
  const tsStr = fmtTurnTs(turn.ts);
  node.innerHTML = `
    <div class="chat-bubble ${turn.error ? 'error' : ''}">
      <div class="chat-role">
        <span>${turn.role === 'user' ? '你' : 'AI'}</span>
        ${tsStr ? `<span class="chat-ts" title="${escape(new Date(Number(turn.ts)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}">${tsStr}</span>` : ''}
        <button class="chat-quote-btn" data-quote="${turn.id || ''}" title="引用这条消息(可引多条)">引用</button>
      </div>
      ${renderAttachments(turn.attachments)}
      <div class="chat-content">${formatContent(turn)}</div>
    </div>
  `;
  host.appendChild(node);
}

function updateTurn(node, turn) {
  const c = node.querySelector('.chat-content');
  if (c) c.innerHTML = formatContent(turn);
  if (turn.error) node.querySelector('.chat-bubble')?.classList.add('error');
  else node.querySelector('.chat-bubble')?.classList.remove('error');
}

function renderAttachments(list) {
  if (!list || !list.length) return '';
  const chips = list.map((a) => {
    const isImg = a.kind === 'image';
    // 0.2.6 起：图片附件直接渲染缩略图（用 easydeal-asset:/// 协议读
    // workspace 下的实际文件），点击触发全局 lightbox 监听放大；非图片
    // 还是显示 emoji icon。relPath 由 attachments.js 给出，形如
    // ".attachments/<draftId>/<file>"，工作目录下相对路径。
    const head = isImg
      ? `<img class="chat-chip-thumb" src="easydeal-asset:///${encodeURI(a.relPath || '')}" alt="${escape(a.name)}" title="点击放大">`
      : `<span class="chip-icon">${kindIcon(a.kind)}</span>`;
    return `
      <div class="chat-chip in-bubble${isImg ? ' chat-chip-image' : ''}">
        ${head}
        <span class="chip-name" title="${escape(a.relPath)}">${escape(a.name)}</span>
        <span class="chip-size">${fmtSize(a.size)}</span>
      </div>
    `;
  }).join('');
  return `<div class="chat-bubble-attachments">${chips}</div>`;
}

function renderBindApprovalCard(turn) {
  // 序列号绑定授权: 通讯区可点卡片(CSP 禁内联 onclick → data-* + 委托监听)
  const d = turn.noteData || {};
  return `
    <div class="bind-approval-card" style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:14px;">
      <div style="margin-bottom:10px;">${renderText(turn.content || '')}</div>
      <div style="display:flex;gap:8px;">
        <button class="btn primary small" data-bind-approve="${d.reqId}" style="flex:1;">✓ 授权</button>
        <button class="btn ghost small"   data-bind-reject="${d.reqId}"  style="flex:1;">✕ 拒绝</button>
      </div>
    </div>`;
}

function formatContent(turn) {
  // 序列号绑定授权请求: 渲染成可点的卡片(授权/拒绝)
  if (turn.systemNote && turn.noteKind === 'bind_approval' && turn.noteData && turn.noteData.reqId) {
    return renderBindApprovalCard(turn);
  }
  // For assistant turns we may have streamed segments; render those preferentially.
  if (turn.role === 'assistant' && Array.isArray(turn.segments) && turn.segments.length) {
    const tmp = document.createElement('div');
    for (const s of turn.segments) appendSegment(tmp, s);
    if (turn.pending && !turn.segments.some((s) => s.kind === 'text' && s.text)) {
      // No text yet, only tool calls so far — keep a small pending indicator.
      const dot = document.createElement('span');
      dot.className = 'chat-spinner';
      tmp.appendChild(dot);
    }
    // 0.3.54: 历史 turn（pending=false）回放时把 thinking 块默认收起 —— streaming
    // 期间 appendSegment 把 details 默认 open，这里给已完成的 turn 收起来。
    if (!turn.pending) {
      tmp.querySelectorAll('details.chat-thinking[open]').forEach((d) => {
        d.removeAttribute('open');
      });
    }
    return tmp.innerHTML;
  }
  if (turn.pending && !turn.content) return `<span class="chat-spinner"></span>`;
  return renderText(turn.content || '', turn.role === 'assistant');
}

// Delegate to the shared markdown module so segment streaming and one-shot
// rendering use identical formatting.
function renderText(raw, assistantSemanticBlocks = false) {
  return renderMarkdown(raw || '', { assistantSemanticBlocks });
}

// Append one stream segment to a content host. Returns the created element.
function appendSegment(host, seg) {
  // Coalesce adjacent text segments into the same .chat-text block so that
  // streamed character chunks build up smoothly.
  if (seg.kind === 'text') {
    let last = host.lastElementChild;
    if (!last || !last.classList?.contains('chat-text')) {
      last = el('div', 'chat-text');
      host.appendChild(last);
    }
    last.innerHTML = renderText((last.dataset.raw || '') + seg.text, true);
    last.dataset.raw = (last.dataset.raw || '') + seg.text;
    return last;
  }
  if (seg.kind === 'thinking') {
    // 0.3.54: 思考过程包成 <details open> —— streaming 期间展开看实时输出，
    // 这一轮跑完（busy=false）后由 'busy' 事件 handler 自动 remove open 收起。
    const node = el('details', 'chat-thinking');
    node.open = true;
    node.innerHTML = `
      <summary class="chat-thinking-summary">
        <span class="chat-segment-tag">thinking</span>
        <span class="muted small">点击展开 / 收起</span>
      </summary>
      <div class="chat-thinking-body">${renderText(seg.text)}</div>
    `;
    host.appendChild(node);
    return node;
  }
  if (seg.kind === 'tool_use') {
    const argSummary = summarizeToolInput(seg.name, seg.input);
    const node = el('div', 'chat-tool');
    node.dataset.toolUseId = seg.id || '';
    node.innerHTML = `
      <div class="chat-tool-head">
        <span class="chat-tool-icon">🔧</span>
        <span class="chat-tool-name">${escape(seg.name)}</span>
        <span class="chat-tool-arg">${escape(argSummary)}</span>
      </div>
      <details class="chat-tool-body"><summary>查看参数 / 结果</summary>
        <div class="chat-tool-input">
          <div class="chat-tool-label">arguments</div>
          <pre class="code">${escape(JSON.stringify(seg.input ?? {}, null, 2))}</pre>
        </div>
        <div class="chat-tool-result-slot"></div>
      </details>
    `;
    host.appendChild(node);
    return node;
  }
  if (seg.kind === 'tool_result') {
    // Try to attach to the matching tool_use card by id.
    const target = host.querySelector(`[data-tool-use-id="${seg.tool_use_id || ''}"] .chat-tool-result-slot`);
    if (target) {
      const head = host.querySelector(`[data-tool-use-id="${seg.tool_use_id || ''}"] .chat-tool-head`);
      if (head) {
        const status = el('span', 'chat-tool-status');
        status.textContent = seg.is_error ? '✗' : '✓';
        if (seg.is_error) status.classList.add('error');
        // Replace any old status dot
        head.querySelectorAll('.chat-tool-status').forEach((n) => n.remove());
        head.appendChild(status);
      }
      target.innerHTML = `
        <div class="chat-tool-label">result</div>
        <pre class="code">${escape((seg.content || '').slice(0, 4000))}</pre>
      `;
      return target;
    }
    // Orphan tool result — render as standalone segment
    const node = el('div', 'chat-tool');
    node.innerHTML = `<div class="chat-tool-head"><span class="chat-tool-icon">↩</span><span class="chat-tool-name">tool_result</span></div>
      <pre class="code">${escape((seg.content || '').slice(0, 4000))}</pre>`;
    host.appendChild(node);
    return node;
  }
  return null;
}

function mutateSegment(host, _index, segment) {
  // Currently only used for streaming text growth — re-render the last text block.
  if (segment.kind === 'text') {
    const blocks = host.querySelectorAll('.chat-text');
    const last = blocks[blocks.length - 1];
    if (!last) return appendSegment(host, segment);
    last.dataset.raw = segment.text;
    last.innerHTML = renderText(segment.text, true);
  }
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (!keys.length) return '';
  // Pick a sensible "headline" arg per common tool name.
  const headlineKey = ({
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    Glob: 'pattern',
    Grep: 'pattern',
    Bash: 'command',
    schedule_task: 'name',
    list_knowledge: '',
    update_strategy_param: 'param_name',
  })[name];
  const showKey = headlineKey != null ? headlineKey : keys[0];
  if (!showKey) return '';
  const v = input[showKey];
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > 90) s = s.slice(0, 87) + '…';
  return s;
}

function kindIcon(kind) {
  switch (kind) {
    case 'image': return '🖼';
    case 'pdf':   return '📄';
    case 'mq5':   return '📈';
    case 'text':  return '📝';
    default:      return '📎';
  }
}

function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (!dt.types) return false;
  return Array.from(dt.types).includes('Files');
}

function bufferToBase64(uint8) {
  // Build base64 from Uint8Array without blowing the call stack on big files.
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < uint8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ---------------- @-mention strategy picker ----------------
//
// Watches a textarea for `@<query>` patterns at the cursor position. Pops a
// floating dropdown of strategy names (from workspace/strategies/), filtered
// by `<query>` substring. Pick → replace the `@<query>` with `@<EAName>`.
//
// Strategies are loaded once on first @ trigger and cached for 30s.
//
// Public surface:
//   const m = createMentionPicker(textarea);
//   m.refresh()      — call after every input event
//   m.isOpen()       — true if popup is visible
//   m.move(±1)       — keyboard navigation
//   m.commit()       — pick highlighted item
//   m.close()        — dismiss popup
function createMentionPicker(textarea) {
  let popup = null;
  let items = [];        // filtered list shown
  let highlightIdx = 0;
  let triggerStart = -1; // index in textarea.value where the '@' lives
  let strategiesCache = null;
  let strategiesCachedAt = 0;
  const CACHE_MS = 30_000;

  async function loadStrategies() {
    if (strategiesCache && Date.now() - strategiesCachedAt < CACHE_MS) {
      return strategiesCache;
    }
    try {
      const list = await window.easydeal.strategies.list();
      // Strip extension; show "GMarket" not "GMarket.mq5"
      strategiesCache = (list || []).map((it) => ({
        name: it.name.replace(/\.(mq5|ex5|mqh|set)$/i, ''),
        mounted: !!it.is_mounted,
        hasSource: !!it.has_source,
        hasCompiled: !!it.has_compiled,
      }));
      strategiesCachedAt = Date.now();
    } catch {
      strategiesCache = [];
    }
    return strategiesCache;
  }

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'mention-popup';
    popup.style.display = 'none';
    document.body.appendChild(popup);
    popup.addEventListener('mousedown', (e) => {
      // Prevent textarea blur before click is handled
      e.preventDefault();
    });
    popup.addEventListener('click', (e) => {
      const row = e.target.closest?.('[data-idx]');
      if (!row) return;
      highlightIdx = parseInt(row.dataset.idx, 10) || 0;
      commit();
    });
    return popup;
  }

  function positionPopup() {
    // Position near cursor — Window-relative bounding box of the textarea
    // approximated above the input area.
    const r = textarea.getBoundingClientRect();
    popup.style.left   = `${Math.round(r.left)}px`;
    popup.style.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
    popup.style.width  = `${Math.max(280, Math.min(420, r.width / 2))}px`;
  }

  function render() {
    const p = ensurePopup();
    if (!items.length) {
      p.innerHTML = `<div class="mention-empty">没有匹配的策略</div>`;
    } else {
      p.innerHTML = items.map((it, i) => {
        const tag = it.mounted ? '<span class="mention-tag mention-mounted">运行中</span>' :
                    (it.hasCompiled ? '<span class="mention-tag">已编译</span>' : '<span class="mention-tag">仅源码</span>');
        return `<div class="mention-item ${i === highlightIdx ? 'on' : ''}" data-idx="${i}">
          <span class="mention-name">${escape(it.name)}</span>
          ${tag}
        </div>`;
      }).join('');
    }
    p.style.display = 'block';
    positionPopup();
    // Scroll selected into view
    const sel = p.querySelector('.mention-item.on');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    if (popup) popup.style.display = 'none';
    triggerStart = -1;
    items = [];
    highlightIdx = 0;
  }

  function isOpen() {
    return !!popup && popup.style.display !== 'none';
  }

  function move(delta) {
    if (!items.length) return;
    highlightIdx = (highlightIdx + delta + items.length) % items.length;
    render();
  }

  function commit() {
    if (!items.length || triggerStart < 0) { close(); return; }
    const picked = items[highlightIdx];
    const before = textarea.value.slice(0, triggerStart);
    // Find end of current @-token (cursor or whitespace, whichever first)
    const cursor = textarea.selectionStart;
    let endIdx = cursor;
    // Scan forward from trigger for a space/newline/end
    for (let i = triggerStart + 1; i <= textarea.value.length; i++) {
      const ch = textarea.value[i];
      if (i >= cursor && (ch === undefined || /\s/.test(ch))) { endIdx = i; break; }
    }
    const after = textarea.value.slice(endIdx);
    const insertion = `@${picked.name} `;   // trailing space for fluency
    textarea.value = before + insertion + after;
    const newCursor = before.length + insertion.length;
    textarea.setSelectionRange(newCursor, newCursor);
    textarea.focus();
    close();
  }

  async function refresh() {
    // Find @-token immediately before cursor.
    const cursor = textarea.selectionStart;
    const prefix = textarea.value.slice(0, cursor);
    const at = prefix.lastIndexOf('@');
    if (at < 0) { close(); return; }
    // Ensure @ is at start or preceded by whitespace (avoid emails, etc.)
    if (at > 0 && !/\s/.test(textarea.value[at - 1])) { close(); return; }
    const token = prefix.slice(at + 1);
    // Token can't contain whitespace
    if (/\s/.test(token)) { close(); return; }
    triggerStart = at;
    const all = await loadStrategies();
    const q = token.toLowerCase();
    items = all.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 12);
    if (!items.length && q === '') items = all.slice(0, 12); // bare @ → show all
    highlightIdx = 0;
    render();
  }

  return { refresh, isOpen, move, commit, close };
}
function escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- lightbox ----------------

function ensureLightbox() {
  let n = document.getElementById('chat-lightbox');
  if (n) return n;
  n = document.createElement('div');
  n.id = 'chat-lightbox';
  n.className = 'chat-lightbox hidden';
  n.innerHTML = `
    <button class="chat-lightbox-close" type="button" aria-label="关闭">×</button>
    <img class="chat-lightbox-img" alt="">
    <div class="chat-lightbox-caption"></div>
  `;
  document.body.appendChild(n);
  const close = () => n.classList.add('hidden');
  n.addEventListener('click', (e) => {
    if (e.target === n || e.target.classList.contains('chat-lightbox-close')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !n.classList.contains('hidden')) close();
  });
  return n;
}

function showLightbox(node, src, caption) {
  const img = node.querySelector('.chat-lightbox-img');
  const cap = node.querySelector('.chat-lightbox-caption');
  img.src = src;
  cap.textContent = caption || '';
  cap.style.display = caption ? 'block' : 'none';
  node.classList.remove('hidden');
}

// 0.2.4 起：「新会话」按钮的三选一对话框。Promise resolve 'clear' /
// 'carryover' / 'cancel'。点遮罩 / Esc / 「取消」按钮都返回 'cancel'。
// 0.3.3 起：fetch 当前 session 的 pending TodoWrite 项，渲染在 modal 顶部，
// 让用户看着自己即将放弃的待办做"带摘要 vs 清除"决策（有 todos 时清除按钮
// 加红色尾巴标"会丢这 N 条"）。
function openClaudeSessionHistoryModal(sessions) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (ts) => {
    try { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; }
    catch { return '时间未知'; }
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { document.removeEventListener('keydown', onKey, true); } catch {}
      try { overlay.remove(); } catch {}
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    const overlay = document.createElement('div');
    overlay.className = 'chat-choice-overlay';
    const items = (sessions || []).map((s) => {
      const tags = [
        s.current ? '<span class="chat-choice-btn-tag">当前</span>' : '',
        s.background ? '<span class="chat-history-kind">后台任务</span>' : '',
      ].join('');
      const count = Number(s.message_count);
      const countText = Number.isFinite(count) ? ` · 共 ${count} 条消息` : '';
      return `<button class="chat-choice-btn chat-history-item${s.current ? ' is-current' : ''}"
                      data-session-id="${esc(s.session_id)}" ${s.current ? 'disabled' : ''}>
        <div class="chat-choice-btn-title">${esc(s.title || '未命名会话')}${tags}</div>
        <div class="chat-history-meta">${esc(fmt(s.started_at))} — ${esc(fmt(s.updated_at))}${esc(countText)}</div>
        ${s.preview ? `<div class="chat-choice-btn-desc">${esc(s.preview)}</div>` : ''}
      </button>`;
    }).join('');
    overlay.innerHTML = `
      <div class="chat-choice-modal chat-history-modal" role="dialog" aria-label="历史会话">
        <div class="chat-choice-title">历史 Claude 会话</div>
        <div class="chat-choice-body">选择一条旧会话恢复。恢复不会删除当前或其他会话；下一条消息将从所选会话继续。</div>
        <div class="chat-choice-options chat-session-history-list">
          ${items || '<div class="chat-history-empty">没有找到可恢复的 Claude 会话</div>'}
        </div>
        <div class="chat-choice-actions"><button class="btn ghost small" data-cancel>取消</button></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-cancel]')) { finish(null); return; }
      const btn = e.target.closest('[data-session-id]');
      if (btn && !btn.disabled) finish(btn.getAttribute('data-session-id'));
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
  });
}

async function openNewChatChoiceModal() {
  // 拉 pending todos —— 失败 / 没 lastSessionId 都返 []，UI 不挡
  let pendingTodos = [];
  try {
    pendingTodos = (await window.easydeal.chat.getPendingTodos?.()) || [];
  } catch {}

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      try { document.removeEventListener('keydown', onKey, true); } catch {}
      try { overlay.remove(); } catch {}
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
    };
    const overlay = document.createElement('div');
    overlay.className = 'chat-choice-overlay';
    const todosBlock = pendingTodos.length ? `
      <div class="chat-choice-todos">
        <div class="chat-choice-todos-head">⚠ 当前对话有 ${pendingTodos.length} 项 AI 待办未完成</div>
        <ul>
          ${pendingTodos.slice(0, 8).map((t) => `
            <li>
              <span class="chat-choice-todo-status status-${t.status}">${t.status === 'in_progress' ? '🔄' : '⏸'}</span>
              <span class="chat-choice-todo-text">${escape(t.content || t.activeForm || '(空)')}</span>
            </li>
          `).join('')}
          ${pendingTodos.length > 8 ? `<li class="chat-choice-todo-more">…还有 ${pendingTodos.length - 8} 项</li>` : ''}
        </ul>
      </div>
    ` : '';
    const clearWarn = pendingTodos.length
      ? `<div class="chat-choice-btn-desc"><span class="chat-choice-warn">⚠ 上面这 ${pendingTodos.length} 项待办会丢</span> — 彻底重置，AI 重新认识你。聊天历史本地保留可翻阅，但 AI 看不到。</div>`
      : `<div class="chat-choice-btn-desc">彻底重置 — 当前对话不再带过去，AI 重新认识你。聊天历史本地保留可翻阅，但 AI 看不到。</div>`;
    overlay.innerHTML = `
      <div class="chat-choice-modal" role="dialog" aria-label="新会话">
        <div class="chat-choice-title">新会话怎么开？</div>
        <div class="chat-choice-body">
          继续往下做的话，AI 默认是不知道你之前聊过什么的。可以选：
        </div>
        ${todosBlock}
        <div class="chat-choice-options">
          <button class="chat-choice-btn primary" data-act="carryover">
            <div class="chat-choice-btn-title">📝 带摘要去新会话<span class="chat-choice-btn-tag">推荐</span></div>
            <div class="chat-choice-btn-desc">让 AI 先把当前对话总结一下${pendingTodos.length ? '（含上面那 ' + pendingTodos.length + ' 项待办）' : ''}，挑出仍要保留的附件 / 文件。下条新消息发给 AI 时会带上摘要做开篇上下文，相关文件免被自动 GC 清理。</div>
          </button>
          <button class="chat-choice-btn" data-act="clear">
            <div class="chat-choice-btn-title">🗑 清除记录</div>
            ${clearWarn}
          </button>
        </div>
        <div class="chat-choice-actions">
          <button class="btn ghost small" data-act="cancel">取消</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { finish('cancel'); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      finish(btn.dataset.act);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    // 默认聚焦到「带摘要」（Enter 直接走推荐项）
    setTimeout(() => {
      try { overlay.querySelector('.chat-choice-btn.primary')?.focus(); } catch {}
    }, 0);
  });
}

// 1.3.x 多会话: 从策略候选里挑一个建独立会话。resolve 选中的 sessionKey 或 null(取消)。
function openSessionPicker(candidates) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { document.removeEventListener('keydown', onKey, true); } catch {} try { overlay.remove(); } catch {} resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
    const overlay = document.createElement('div');
    overlay.className = 'chat-choice-overlay';
    const items = (candidates || []).map((c) =>
      `<button class="chat-choice-btn" data-key="${esc(c.key)}">
         <div class="chat-choice-btn-title">${esc(c.ea || c.label || c.key)}</div>
         <div class="chat-choice-btn-desc">账户 ${esc(String(c.login || ''))} · 为这个策略开一条独立 AI 会话（自动带上它的说明/参数/战绩）</div>
       </button>`).join('');
    overlay.innerHTML = `
      <div class="chat-choice-modal" role="dialog" aria-label="选择策略会话">
        <div class="chat-choice-title">给哪个策略开会话？</div>
        <div class="chat-choice-body">每个策略是一条独立的 Claude Code 会话，AI 一进来就聚焦这个策略。</div>
        <div class="chat-choice-options">${items || '<div class="chat-choice-body">没有可用策略</div>'}</div>
        <div class="chat-choice-actions"><button class="btn ghost small" data-cancel>取消</button></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-cancel]')) { finish(null); return; }
      const btn = e.target.closest('[data-key]');
      if (btn) finish(btn.getAttribute('data-key'));
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
  });
}
