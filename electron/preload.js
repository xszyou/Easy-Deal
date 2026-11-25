// Preload — narrow IPC surface exposed to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easydeal', {
  timers: {
    list:    () => ipcRenderer.invoke('timers:list'),
    create:  (p) => ipcRenderer.invoke('timers:create', p),
    cancel:  (id) => ipcRenderer.invoke('timers:cancel', id),
    toggle:  (id, en) => ipcRenderer.invoke('timers:toggle', id, en),
    history: (id) => ipcRenderer.invoke('timers:history', id),
    runNow:  (id) => ipcRenderer.invoke('timers:run-now', id),
    clearRuns: (id) => ipcRenderer.invoke('timers:clear-runs', id),
    deleteRun: (runId) => ipcRenderer.invoke('timers:delete-run', runId),
    // 0.3.120: 重置系统任务到首次安装状态（不动用户任务）
    resetSystem: () => ipcRenderer.invoke('timers:reset-system'),
  },
  kb: {
    list:           () => ipcRenderer.invoke('kb:list'),
    upload:         () => ipcRenderer.invoke('kb:upload'),
    delete:         (n) => ipcRenderer.invoke('kb:delete', n),
    openFolder:     () => ipcRenderer.invoke('kb:open-folder'),
    serverList:     () => ipcRenderer.invoke('kb:server-list'),
    serverSync:     () => ipcRenderer.invoke('kb:server-sync'),
    serverDownload: (id) => ipcRenderer.invoke('kb:server-download', id),
  },
  strategies: {
    list:           () => ipcRenderer.invoke('strategies:list'),
    upload:         () => ipcRenderer.invoke('strategies:upload'),
    delete:         (n) => ipcRenderer.invoke('strategies:delete', n),
    copy:           (opts) => ipcRenderer.invoke('strategies:copy', opts),
    unmount:        (n) => ipcRenderer.invoke('strategies:unmount', n),
    openFolder:     () => ipcRenderer.invoke('strategies:open-folder'),
    openInEditor:   (n) => ipcRenderer.invoke('strategies:open-in-editor', n),
    readDoc:        (n) => ipcRenderer.invoke('strategies:read-doc', n),
    writeDoc:       (n, content) => ipcRenderer.invoke('strategies:write-doc', n, content),
    requestDocAction: (action, n) => ipcRenderer.invoke('strategies:request-doc-action', action, n),
    deployCompiled:       (n) => ipcRenderer.invoke('strategies:deploy-compiled', n),
    compile:              (n) => ipcRenderer.invoke('strategies:compile', n),
    autoAttachEA:         (n, opts) => ipcRenderer.invoke('strategies:auto-attach-ea', n, opts || {}),
    // 0.3.189 Phase 2: per-EA MT5 instance 绑定
    getMt5Instance:       (eaName) => ipcRenderer.invoke('strategies:get-mt5-instance', eaName),
    setMt5Instance:       (eaName, instanceId, opts) => ipcRenderer.invoke('strategies:set-mt5-instance', { eaName, instanceId, opts: opts || {} }),
    // 0.4.34: 从服务端权威 metric 恢复被误重置/清零的本地统计
    restoreStats:         (eaName) => ipcRenderer.invoke('strategies:restore-stats', eaName),
    // 0.3.308: 用户「我已设置好」按钮 → 写 mounted-state.json first_mount_confirmed=true
    confirmFirstMount:    (eaName) => ipcRenderer.invoke('strategies:confirm-first-mount', { ea_name: eaName }),
    // 0.3.49: 实时 per-EA 成绩单（替代老 records-based UI）。返回 MCP
    // get_ea_realtime_stats 原样：{ok, ts, account, items:[{ea_name, trades,
    // pnl_pct, max_drawdown_pct, today_*, open_*, magic_resolved_by, ...}]}
    liveStats:            (opts) => ipcRenderer.invoke('strategies:live-stats', opts || {}),
    debugMounts:          ()  => ipcRenderer.invoke('strategies:debug-mounts'),
    // 0.3.53: 参数管理
    paramsListInputs:     (n) => ipcRenderer.invoke('strategies:params-list-inputs', n),
    paramsDetectHotReload:(n) => ipcRenderer.invoke('strategies:params-detect-hot-reload', n),
    paramsRead:           (n) => ipcRenderer.invoke('strategies:params-read', n),
    paramsWrite:          (payload) => ipcRenderer.invoke('strategies:params-write', payload),
    paramsDeleteHotFile:  (n) => ipcRenderer.invoke('strategies:params-delete-hot-file', n),
    paramsImportSetFile:  () => ipcRenderer.invoke('strategies:params-import-set-file'),
    setLbOptin:           (n, on) => ipcRenderer.invoke('strategies:set-lb-optin', n, on),
    // 0.3.119: per-EA 监控配置
    getMonitorConfig:     (n)     => ipcRenderer.invoke('strategies:get-monitor-config', n),
    setMonitorConfig:     (n, c)  => ipcRenderer.invoke('strategies:set-monitor-config', n, c),
    // 0.3.151: 护航阈值 (AI 建议 + 用户改) per-EA persistent
    getOrderguardThresholds:  (n)    => ipcRenderer.invoke('strategies:get-orderguard-thresholds', n),
    saveOrderguardThresholds: (n, t) => ipcRenderer.invoke('strategies:save-orderguard-thresholds', n, t),
    // 0.3.130: 手动重置该 EA 的「基准余额」(标 needs_anchor_reseed=true，下次 tick 真正 reset)
    resetAnchor:          (n, manualInitialBalance) => ipcRenderer.invoke('strategies:reset-anchor', n, manualInitialBalance ?? null),
    listBacktests:        (n) => ipcRenderer.invoke('strategies:list-backtests', n),
    deleteBacktest:       (btId) => ipcRenderer.invoke('strategies:delete-backtest', btId),
    clearBacktests:       (n) => ipcRenderer.invoke('strategies:clear-backtests', n),
    // 0.3.95: 把 .mq5 回退到回测当时的源码版本
    restoreMq5FromBacktest: (payload) => ipcRenderer.invoke('strategies:restore-mq5-from-backtest', payload),
    unreadBacktests:      ()  => ipcRenderer.invoke('strategies:unread-backtests'),
    markBacktestsRead:    (n) => ipcRenderer.invoke('strategies:mark-backtests-read', n),
    // Per-EA "best passing 3-month backtest" + hours_run, used by the listing
    // eligibility gate (上架门槛 = 24h 在线 + 一次回测 ≥ 90 天且盈利).
    eligibilityBundle:    ()  => ipcRenderer.invoke('strategies:eligibility-bundle'),
    // 0.4.6 marketplace v2 升级 ribbon 用：读 <ea>.installed.json sidecar
    getInstalledVersion:  (n) => ipcRenderer.invoke('strategies:get-installed-version', n),
    // 0.3.55: EA 关联指标依赖（iCustom 调的 .ex5 等）— 客户端「我的策略 → 📎 关联指标」用
    indicatorsList:       (ea) => ipcRenderer.invoke('strategies:indicators-list', ea),
    indicatorsAdd:        (ea, srcPath) => ipcRenderer.invoke('strategies:indicators-add', ea, srcPath),
    indicatorsRemove:     (ea, name) => ipcRenderer.invoke('strategies:indicators-remove', ea, name),
    indicatorsSniff:      (ea) => ipcRenderer.invoke('strategies:indicators-sniff', ea),
    indicatorsAutoImport: (ea) => ipcRenderer.invoke('strategies:indicators-auto-import', ea),
    indicatorsPickFiles:  () => ipcRenderer.invoke('strategies:indicators-pick-files'),
    // Manually push today's running totals as a daily-stats snapshot — for
    // verifying the leaderboard JOIN without waiting for tomorrow's rollover.
    forceUploadStats:     ()  => ipcRenderer.invoke('strategies:force-upload-stats'),
    // 0.3.17: 上架前 ownership 校验 — 本地 .mq5 重新编译一次，返 workspace 新 .ex5 sha256
    compileVerify:        (eaName, opts) => ipcRenderer.invoke('strategies:compile-verify', { eaName, ...(opts || {}) }),
  },
  chat: {
    // 1.3.x 多会话: 每个方法末尾可选 sessionKey(缺省 = 全局会话, 行为同旧版)。
    history: (sk)      => ipcRenderer.invoke('chat:history', sk),
    historyBefore: (sk, beforeTs, limit) => ipcRenderer.invoke('chat:history-before', sk, beforeTs, limit),
    send:    (m, did, sk) => ipcRenderer.invoke('chat:send', m, did, sk),
    reset:   (sk)      => ipcRenderer.invoke('chat:reset', sk),
    resetWithCarryover: (sk) => ipcRenderer.invoke('chat:reset-with-carryover', sk),
    recoverableSessions: (sk) => ipcRenderer.invoke('chat:recoverable-sessions', sk),
    restoreSession: (sk, sessionId) => ipcRenderer.invoke('chat:restore-session', sk, sessionId),
    getPendingTodos: (sk) => ipcRenderer.invoke('chat:get-pending-todos', sk),
    getTodos: (sk) => ipcRenderer.invoke('chat:get-todos', sk),
    addTodo:      (sk, content) => ipcRenderer.invoke('chat:todo-add', sk, content),
    setTodoStatus:(sk, id, status) => ipcRenderer.invoke('chat:todo-set-status', sk, id, status),
    editTodo:     (sk, id, content) => ipcRenderer.invoke('chat:todo-edit', sk, id, content),
    deleteTodo:   (sk, id) => ipcRenderer.invoke('chat:todo-delete', sk, id),
    stop:    (sk)      => ipcRenderer.invoke('chat:stop', sk),
    busy:    (sk)      => ipcRenderer.invoke('chat:busy', sk),
    listSessions:  ()  => ipcRenderer.invoke('chat:list-sessions'),
    strategyCandidates: () => ipcRenderer.invoke('chat:strategy-candidates'),
    deleteSession: (sk) => ipcRenderer.invoke('chat:delete-session', sk),
    // 1.4.x 附加远程会话(只读): 🖥 按钮
    remoteCandidates:    ()            => ipcRenderer.invoke('chat:remote-candidates'),
    // 1.5.5 多台附加: attach 现在是**追加**; detach 传 clientKey 只拆那一台, 不传=全拆。
    attachRemote:        (sk, clientKey, note, scope) => ipcRenderer.invoke('chat:attach-remote', sk, clientKey, note, scope),
    detachRemote:        (sk, clientKey) => ipcRenderer.invoke('chat:detach-remote', sk, clientKey),
    getRemoteAttachment: (sk)          => ipcRenderer.invoke('chat:get-remote-attachment', sk),
    getRemoteAttachments:(sk)          => ipcRenderer.invoke('chat:get-remote-attachments', sk),
    // attachments
    newDraft:        ()              => ipcRenderer.invoke('chat:new-draft'),
    listAttachments: (did)           => ipcRenderer.invoke('chat:list-attachments', did),
    attachBuffer:    (did, name, b64) => ipcRenderer.invoke('chat:attach-buffer', did, name, b64),
    attachPaths:     (did, paths)    => ipcRenderer.invoke('chat:attach-paths', did, paths),
    attachPick:      (did)           => ipcRenderer.invoke('chat:attach-pick', did),
    getAttachmentDataUrl: (did, name) => ipcRenderer.invoke('chat:get-attachment-data-url', did, name),
    removeAttachment:(did, name)     => ipcRenderer.invoke('chat:remove-attachment', did, name),
    clearDraft:      (did)           => ipcRenderer.invoke('chat:clear-draft', did),
    // 序列号绑定授权: 通讯区卡片点「授权/拒绝」→ 经主进程回写 server
    decideBindApproval: (reqId, approve) => ipcRenderer.invoke('chat:bind-approval-decide', { reqId, approve }),
    // events
    on: (event, handler) => {
      const ch = `chat:${event}`;
      // 1.3.x 多会话: 事件带 sessionKey(第2参); 老监听只读第1参→兼容, 新代码可据 sessionKey 过滤。
      const wrapped = (_e, payload, sessionKey) => handler(payload, sessionKey);
      ipcRenderer.on(ch, wrapped);
      return () => ipcRenderer.removeListener(ch, wrapped);
    },
  },
  server: {
    leaderboard:     (q) => ipcRenderer.invoke('server:leaderboard', q),
    tutorials:       (q) => ipcRenderer.invoke('server:tutorials', q),
    news:            (q) => ipcRenderer.invoke('server:news', q),
    market:          (q) => ipcRenderer.invoke('server:market', q),
    sentiment:       () => ipcRenderer.invoke('server:sentiment'),
    installStrategy: (item) => ipcRenderer.invoke('server:install-strategy', item),
  },
  // 经济日历(MT5 内 EA 直传 → 服务端 /v1/calendar)
  calendar: {
    get: () => ipcRenderer.invoke('calendar:get'),
    analyze: (event) => ipcRenderer.invoke('calendar:analyze', event),
  },
  // 0.3.14: 金十快讯（实时金融新闻 — 区别于 server.news 那个社区公告）
  // 0.3.15: 加 unread / markRead + onUnreadCount，让 资讯 tab 按钮显红点
  news: {
    flashRecent: (opts) => ipcRenderer.invoke('news:flash-recent', opts || {}),
    analyze:     (item) => ipcRenderer.invoke('news:analyze', item),
    flashStatus: ()     => ipcRenderer.invoke('news:flash-status'),
    unreadCount: ()     => ipcRenderer.invoke('news:unread-count'),
    markRead:    ()     => ipcRenderer.invoke('news:mark-read'),
    onNewItems:  (cb)   => {
      const handler = (_e, items) => { try { cb(items); } catch {} };
      ipcRenderer.on('news:new-items', handler);
      return () => ipcRenderer.removeListener('news:new-items', handler);
    },
    onUnreadCount: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('news:unread-count', handler);
      return () => ipcRenderer.removeListener('news:unread-count', handler);
    },
  },
  app: {
    openWorkspace:  () => ipcRenderer.invoke('app:open-workspace'),
    revealInWorkspace: (relPath) => ipcRenderer.invoke('app:reveal-in-workspace', relPath),
    info:           () => ipcRenderer.invoke('app:info'),
    checkMt5:       () => ipcRenderer.invoke('app:check-mt5'),
    launchMt5:      () => ipcRenderer.invoke('app:launch-mt5'),
    requestMt5InstallGuide: () => ipcRenderer.invoke('app:request-mt5-install-guide'),
    // 0.3.182: 「一键下载并安装 MT5」— 从 OSS 拉 portable zip, 解压到 target_dir.
    // 0.3.193: 加 opts.flat — true 时文件直接落 targetDir 下 (剥 "MetaTrader 5/" 前缀) + 要求 targetDir 空目录;
    // false (默认, 老 settings-view 路径) — 老 nested 布局 + 自动设 settings.mt5.
    // 进度走 'mt5-install-progress' 事件 (phase=downloading/extracting/done/error + downloaded/total/percent).
    downloadAndInstallMt5: (targetDir, opts = {}) => ipcRenderer.invoke('app:download-and-install-mt5', { target_dir: targetDir, flat: opts.flat === true, name: opts.name }),
    onMt5InstallProgress: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('mt5-install-progress', handler);
      return () => ipcRenderer.removeListener('mt5-install-progress', handler);
    },
    requestEaCreateGuide:   () => ipcRenderer.invoke('app:request-ea-create-guide'),
    requestHotReloadRetrofit: (eaName) => ipcRenderer.invoke('app:request-hot-reload-retrofit', { ea_name: eaName }),
    // 0.3.67: AI 改造 EA 源码插入 OrderGuard 拦截调用
    // 0.3.163: 接收 thresholds — 用户启用拦截模式时一起带过来, AI 改完 + 编译成功后 main.js 自动 enableEa(magic, 'enforce', thresholds), 用户点全停时 last turn interrupted → 不 enableEa, EA 状态保持「未启用」 (用户反馈「让 AI 修改完，再由 AI 去改变状态」)
    requestOrderguardRetrofit: (eaName, magic, thresholds) => ipcRenderer.invoke('app:request-orderguard-retrofit', { ea_name: eaName, magic, thresholds: thresholds || null }),
    // 0.3.74 P2-B: AI 读 EA 源码生成定制 OrderGuard rules
    requestOrderguardRuleGeneration: (eaName) => ipcRenderer.invoke('app:request-orderguard-rule-generation', { ea_name: eaName }),
    // 0.3.90: AI 分析在跑订单 — 跳到 AI tab 让它结合 EA 源码 + decision 上下文分析订单生命周期
    requestAnalyzePosition:          (payload) => ipcRenderer.invoke('app:request-analyze-position', payload),
    onboardingStatus:       () => ipcRenderer.invoke('app:onboarding-status'),
    requestOnboarding:      () => ipcRenderer.invoke('app:request-onboarding'),
    resetOnboarding:        () => ipcRenderer.invoke('app:reset-onboarding'),
    requestBacktest:        (payload) => ipcRenderer.invoke('app:request-backtest', payload),
    uploadDiagnostic:       (userReport) => ipcRenderer.invoke('app:upload-diagnostic', userReport),
    diagPreflight:          () => ipcRenderer.invoke('app:diag-preflight'),
    probeMt5:               () => ipcRenderer.invoke('app:probe-mt5'),
    cancelBacktest:         (btId)   => ipcRenderer.invoke('app:cancel-backtest', btId),
    panicStopAll:           ()       => ipcRenderer.invoke('app:panic-stop-all'),
    // 0.3.134: 解除全停 — 清掉 panic.flag，让 AI / chat auto-resume / run_backtest 重新可用
    clearPanicFlag:         ()       => ipcRenderer.invoke('app:clear-panic-flag'),
    // 0.3.152: 全局 timer-registry 控制台 (UI 「监控」tab + debug 用)
    listTimers:             ()       => ipcRenderer.invoke('app:list-timers'),
    pauseTimer:    (id, reason)      => ipcRenderer.invoke('app:pause-timer', id, reason),
    resumeTimer:   (id)              => ipcRenderer.invoke('app:resume-timer', id),
    pauseAllTimers: (reason, ms)     => ipcRenderer.invoke('app:pause-all-timers', reason, ms),
    resumeAllTimers: ()              => ipcRenderer.invoke('app:resume-all-timers'),
    requestDeploy:          (payload) => ipcRenderer.invoke('app:request-deploy', payload),
    requestRedeploy:        (payload) => ipcRenderer.invoke('app:request-redeploy', payload),
    listSkills:    () => ipcRenderer.invoke('app:list-skills'),
    licenseStatus: () => ipcRenderer.invoke('app:license-status'),
    // 退出当前序列号：本地清 cached state + server /v1/session/end + 1.5s 后
    // app.relaunch 让 license-gate 重弹。
    // 0.4.42: opts.unbindMachine=true 时 server 额外清 license 的 bound_machine_id ——
    // license 可在新机器激活（替代了原来的 resetMachineId「重置本机 ID」选项,
    // 那个语义太技术, 实际换电脑场景要的是 server 解绑）。
    licenseLogout: (opts) => ipcRenderer.invoke('app:license-logout', opts || {}),
    // Read .mcp.json from disk to verify EASYDEAL_TRADING_WRITE actually
    // got written — used by 「设置 → 高级 → 验证生效状态」 button.
    checkMcpTradingWrite: () => ipcRenderer.invoke('app:check-mcp-trading-write'),
    systemTasks:   () => ipcRenderer.invoke('app:system-tasks'),
    checkUpdate:   () => ipcRenderer.invoke('app:check-update'),
    getReleaseNotes: (version) => ipcRenderer.invoke('app:get-release-notes', version),
    // Download a new release's installer to <userData>/updates/ — verifies
    // sha256, atomic rename, returns { ok, localPath }. Renderer should
    // pre-attach onUpdateProgress() to see streaming progress.
    downloadUpdate:  (latest) => ipcRenderer.invoke('app:update-download', latest),
    // Launch the downloaded .exe and quit the app (NSIS will replace files).
    installUpdate:   (localPath) => ipcRenderer.invoke('app:update-install', localPath),
    // Open a URL in the user's default browser (for 「在浏览器下载」 fallback).
    openExternal:    (url) => ipcRenderer.invoke('app:open-external', url),
    // Subscribe to download progress events. Returns an unsubscribe fn.
    onUpdateProgress: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('app:update-progress', wrapped);
      return () => ipcRenderer.removeListener('app:update-progress', wrapped);
    },
    // 0.3.196: electron-updater 差分下载 (blockmap-based) — 用 OSS 上的
    // <ver>.exe.blockmap 跟本地比对, 只下载变动的 256KB block, 通常 5–10 MB
    // 替代完整 215 MB 下载. 安装也是静默 (NSIS /S) + 自动重启新版.
    autoUpdaterStatus:    ()        => ipcRenderer.invoke('app:autoupdater-status'),
    autoUpdaterCheck:     ()        => ipcRenderer.invoke('app:autoupdater-check'),
    autoUpdaterDownload:  ()        => ipcRenderer.invoke('app:autoupdater-download'),
    autoUpdaterInstall:   (opts)    => ipcRenderer.invoke('app:autoupdater-install', opts || {}),
    onAutoUpdaterEvent:   (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('app:autoupdater-event', wrapped);
      return () => ipcRenderer.removeListener('app:autoupdater-event', wrapped);
    },
    // license tier 在 admin 后台被改后，server heartbeat 响应里带新值，
    // main 推 'license:status-changed'。设置页授权信息卡片订阅它就能立刻刷。
    onLicenseStatusChanged: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('license:status-changed', wrapped);
      return () => ipcRenderer.removeListener('license:status-changed', wrapped);
    },
  },
  // License gate (only used by license-gate.html; ok if exposed in main
  // window too).
  licenseSubmitKey: (key) => ipcRenderer.invoke('easydeal:license-submit-key', key),
  licenseGateCancel: ()    => ipcRenderer.invoke('easydeal:license-cancel'),
  licenseClaimTrial: ()    => ipcRenderer.invoke('easydeal:license-claim-trial'),
  licenseRecentKeys: ()    => ipcRenderer.invoke('easydeal:license-recent-keys'),
  // Marketplace + listing + order flow
  mkt: {
    list:           (q)         => ipcRenderer.invoke('mkt:list', q),
    myListings:     ()          => ipcRenderer.invoke('mkt:my-listings'),
    myStats:        ()          => ipcRenderer.invoke('mkt:my-stats'),
    // 0.5.0 P2: metric API (统计重构) — 用户可直接拿 raw-derived metric
    metric:         (opts)      => ipcRenderer.invoke('mkt:metric', opts || {}),
    metricExplain:  (opts)      => ipcRenderer.invoke('mkt:metric-explain', opts || {}),
    anchorsList:    ()          => ipcRenderer.invoke('mkt:anchors-list'),
    anchorSet:      (opts)      => ipcRenderer.invoke('mkt:anchor-set', opts || {}),
    get:            (id)        => ipcRenderer.invoke('mkt:get', id),
    stats:          (id)        => ipcRenderer.invoke('mkt:stats', id),
    submit:         (payload)   => ipcRenderer.invoke('mkt:submit', payload),
    withdraw:       (id)        => ipcRenderer.invoke('mkt:withdraw', id),
    setPrice:       (id, p)     => ipcRenderer.invoke('mkt:set-price', id, p),
    // 0.4.6 marketplace v2
    release:        (payload)   => ipcRenderer.invoke('mkt:release', payload),
    versions:       (id)        => ipcRenderer.invoke('mkt:versions', id),
    buyerStats:     (id)        => ipcRenderer.invoke('mkt:buyer-stats', id),
    setOptOut:      (optOut)    => ipcRenderer.invoke('mkt:opt-out', optOut),
    getOptOut:      ()          => ipcRenderer.invoke('mkt:opt-out-read'),
    getProfile:     ()          => ipcRenderer.invoke('mkt:profile'),
    setDisplayName: (n)         => ipcRenderer.invoke('mkt:set-display-name', n),
    clearLeaderboardRecords:   () => ipcRenderer.invoke('mkt:clear-leaderboard-records'),
    orderCreate:    (p)         => ipcRenderer.invoke('mkt:order-create', p),
    myOrders:       ()          => ipcRenderer.invoke('mkt:my-orders'),
    listingOrders:  (id)        => ipcRenderer.invoke('mkt:listing-orders', id),
    orderApprove:   (id)        => ipcRenderer.invoke('mkt:order-approve', id),
    orderReject:    (id, r)     => ipcRenderer.invoke('mkt:order-reject', id, r),
    inbox:          ()          => ipcRenderer.invoke('mkt:inbox'),
    install:        (id, eaName) => ipcRenderer.invoke('mkt:install', id, eaName),
    browseFile:     (opts)      => ipcRenderer.invoke('mkt:browse-file', opts),
  },
  // 0.4.10: 跟单 (copy-trade) — 排行榜上申请跟某 listing → 作者审批 → 后续实时跟单
  copyTrade: {
    request:           (p)              => ipcRenderer.invoke('ct:request', p),
    mySubscriptions:   ()               => ipcRenderer.invoke('ct:my-subscriptions'),
    requestsForMe:     ()               => ipcRenderer.invoke('ct:requests-for-me'),
    myFollowers:       ()               => ipcRenderer.invoke('ct:my-followers'),
    approve:           (id)             => ipcRenderer.invoke('ct:approve', id),
    reject:            (id, reason)     => ipcRenderer.invoke('ct:reject', id, reason),
    pauseAsAuthor:     (id)             => ipcRenderer.invoke('ct:pause-author', id),
    resumeAsAuthor:    (id)             => ipcRenderer.invoke('ct:resume-author', id),
    pauseAsFollower:   (id)             => ipcRenderer.invoke('ct:pause-follower', id),
    resumeAsFollower:  (id)             => ipcRenderer.invoke('ct:resume-follower', id),
    revoke:            (id, reason)     => ipcRenderer.invoke('ct:revoke', id, reason),
    streamStatus:      ()               => ipcRenderer.invoke('ct:stream-status'),
  },
  // 0.4.4: IM 私信 (买卖双方 + 用户↔客服)
  im: {
    open:           (opts)      => ipcRenderer.invoke('im:open', opts),
    openSupport:    ()          => ipcRenderer.invoke('im:open-support'),
    list:           ()          => ipcRenderer.invoke('im:list'),
    messages:       (opts)      => ipcRenderer.invoke('im:messages', opts),
    send:           (opts)      => ipcRenderer.invoke('im:send', opts),
    read:           (convId)    => ipcRenderer.invoke('im:read', convId),
    getMeta:        ()          => ipcRenderer.invoke('im:get-meta'),
    setMeta:        (opts)      => ipcRenderer.invoke('im:set-meta', opts),
  },
  // 序列号远程控制 (操盘手, 一期)
  remote: {
    requestGrant: (opts)        => ipcRenderer.invoke('remote:request-grant', opts),
    listGrants:   ()            => ipcRenderer.invoke('remote:list-grants'),
    decide:       (opts)        => ipcRenderer.invoke('remote:decide', opts),
    revoke:       (opts)        => ipcRenderer.invoke('remote:revoke', opts),
    call:         (opts)        => ipcRenderer.invoke('remote:call', opts),
    aiTurn:       (opts)        => ipcRenderer.invoke('remote:ai-turn', opts),
    pushStrategy: (opts)        => ipcRenderer.invoke('remote:push-strategy', opts),
    listClientStrategies: (opts) => ipcRenderer.invoke('remote:list-client-strategies', opts),
    getChat:      (clientKey)   => ipcRenderer.invoke('remote:get-chat', clientKey),
    appendChat:   (opts)        => ipcRenderer.invoke('remote:append-chat', opts),
  },
  experience: {
    get: (ea)          => ipcRenderer.invoke('experience:get', ea),
    set: (ea, content) => ipcRenderer.invoke('experience:set', { ea, content }),
  },
  wechat: {
    status:    ()             => ipcRenderer.invoke('wechat:status'),
    refresh:   ()             => ipcRenderer.invoke('wechat:refresh'),
    loginQr:   ()             => ipcRenderer.invoke('wechat:login-qr'),
    loginPoll: (qrcodeToken, verifyCode) =>
                ipcRenderer.invoke('wechat:login-poll', { qrcodeToken, verifyCode }),
    logout:    ()             => ipcRenderer.invoke('wechat:logout'),
    send:      (to, text, contextToken) =>
                ipcRenderer.invoke('wechat:send', { to, text, contextToken }),
    // 0.3.54: 跨 chat 拉聊天历史，给 AI 面板悬浮抽屉用
    history:   (opts) => ipcRenderer.invoke('wechat:history', opts || {}),
    onStatus: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('wechat:status', wrapped);
      return () => ipcRenderer.removeListener('wechat:status', wrapped);
    },
    // 0.4.6: 单条 exchange 实时推 — 聊天记录抽屉打开期间用，避免要手动 🔄 刷新
    onExchange: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('wechat:exchange', wrapped);
      return () => ipcRenderer.removeListener('wechat:exchange', wrapped);
    },
    // 0.3.262: pending queue 信息 + 实时事件,给 dormant chip 用
    pendingInfo: () => ipcRenderer.invoke('wechat:pending-info'),
    onPendingChanged: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('wechat:pending-changed', wrapped);
      return () => ipcRenderer.removeListener('wechat:pending-changed', wrapped);
    },
    // 0.3.252: 探活机制 (sidecar 每 15min ping filehelper) 连续 3 次失败时
    // main 重 spawn sidecar 同时推这个事件. UI 显红 banner 提示用户「微信断了
    // 已自动重启, 仍失败请重扫码」让用户感知 + 必要时主动介入.
    onHealthDied: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('wechat:health-died', wrapped);
      return () => ipcRenderer.removeListener('wechat:health-died', wrapped);
    },
  },
  // 1.4.x 顶部「app连接状态」: 列出/断开当前绑定本机 license 的 app 手机号
  appAccounts: {
    list:   ()           => ipcRenderer.invoke('app-accounts:list'),
    unbind: (accountId)  => ipcRenderer.invoke('app-accounts:unbind', accountId),
  },
  token: {
    get:         ()       => ipcRenderer.invoke('token:get-config'),
    setMode:     (mode)   => ipcRenderer.invoke('token:set-mode', mode),
    setCustom:   (patch)  => ipcRenderer.invoke('token:set-custom', patch),
    setSystem:   (patch)  => ipcRenderer.invoke('token:set-system', patch),  // 1.3.16: system 模式模型选择
    setCodex:    (patch)  => ipcRenderer.invoke('token:set-codex', patch),
    setContext:  (patch)  => ipcRenderer.invoke('token:set-context', patch),
    testCustom:  (cfg)    => ipcRenderer.invoke('token:test-custom', cfg),  // 0.3.160: 测试自定义 endpoint 连通
    codexStatus: ()       => ipcRenderer.invoke('token:codex-status'),
    setProxy:    (patch)  => ipcRenderer.invoke('token:set-proxy', patch),
    listFayModels: ()     => ipcRenderer.invoke('token:list-fay-models'),
    fayIssue:    (model)  => ipcRenderer.invoke('token:fay-issue', { model }),
    fayUsage:    ()       => ipcRenderer.invoke('token:fay-usage'),
    // 0.3.49: token cache 变化（auto-issue / 手动切 / channel fallback 后 reissue）
    // → 通知所有 renderer 重刷模型下拉，避免 fallback 切到 MiniMax 后下拉还
    // 显示老 model。
    onCachedChanged: (handler) => {
      const wrapped = () => handler();
      ipcRenderer.on('token:cached-changed', wrapped);
      return () => ipcRenderer.removeListener('token:cached-changed', wrapped);
    },
  },
  // 0.3.188: 多 MT5 实例管理
  mt5Instances: {
    list:         ()                 => ipcRenderer.invoke('mt5-instances:list'),
    add:          (payload)          => ipcRenderer.invoke('mt5-instances:add', payload),
    remove:       (id)               => ipcRenderer.invoke('mt5-instances:remove', { id }),
    update:       (id, patch)        => ipcRenderer.invoke('mt5-instances:update', { id, patch }),
    setActive:    (id)               => ipcRenderer.invoke('mt5-instances:set-active', { id }),
    launch:       (id)               => ipcRenderer.invoke('mt5-instances:launch', { id }),
    // 0.3.195: 关闭某实例的 MT5 (按 installDir 找 PID, taskkill)
    kill:           (id)             => ipcRenderer.invoke('mt5-instances:kill', { id }),
    // 0.3.220: 把某实例的 MT5 主窗口拉到前台 (老版本是 toggleAutoTrade 注入
    // Ctrl+E 切算法交易, 在 Win11 UIPI 上不稳, 改成只显示窗口让用户自己点)
    showWindow:    (id)              => ipcRenderer.invoke('mt5-instances:show-window', { id }),
    // 0.3.207: 用户外部启动 MT5 后, 卡片提示「切到运行状态」按钮调这个
    adoptExternalLaunch: (id)        => ipcRenderer.invoke('mt5-instances:adopt-external-launch', { id }),
    checkInstalled: (targetDir)      => ipcRenderer.invoke('mt5-instances:check-installed', { target_dir: targetDir }),
    // 0.3.193: 检查目标目录状态 — { exists, is_empty, has_mt5, layout, mt5_install_dir }
    checkTargetDir: (targetDir)      => ipcRenderer.invoke('mt5-instances:check-target-dir', { target_dir: targetDir }),
    accountInfo:    (id)             => ipcRenderer.invoke('mt5-instances:account-info', { id }),
  },

  settings: {
    get:         ()      => ipcRenderer.invoke('settings:get'),
    set:         (patch) => ipcRenderer.invoke('settings:set', patch),
    resetField:  (key)   => ipcRenderer.invoke('settings:reset-field', key),
    redetect:    ()      => ipcRenderer.invoke('settings:redetect'),
    exportFile:  ()      => ipcRenderer.invoke('settings:export'),
    importFile:  ()      => ipcRenderer.invoke('settings:import'),
    browseDir:   (opts)  => ipcRenderer.invoke('settings:browse-dir', opts),
    browseFile:  (opts)  => ipcRenderer.invoke('settings:browse-file', opts),
    // bootstrapLiveLogin removed (实盘 MT5 登录 card was redundant with launchMt5)
    // settings.json 被外部（Claude 通过 easydeal-settings MCP）改了的时候 main
    // 主动推 settings:changed —— 设置页订阅它来重绘。返回 unsubscribe 函数。
    onChanged: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('settings:changed', handler);
      return () => ipcRenderer.removeListener('settings:changed', handler);
    },
  },
  // 0.3.64 OrderGuard 护航：P0a 监控模式骨架 + P0b UI 接入
  orderguard: {
    status:        ()             => ipcRenderer.invoke('orderguard:status'),
    health:        ()             => ipcRenderer.invoke('orderguard:health'),
    stats:         (ea, intent)   => ipcRenderer.invoke('orderguard:stats', ea, intent),
    positions:     ()             => ipcRenderer.invoke('orderguard:positions'),
    decisions:     (opts)         => ipcRenderer.invoke('orderguard:decisions', opts || {}),
    enabledEas:    ()             => ipcRenderer.invoke('orderguard:enabled-eas'),
    overviewStats: ()             => ipcRenderer.invoke('orderguard:overview-stats'),
    forcePoll:     ()             => ipcRenderer.invoke('orderguard:force-poll'),
    closedOrders:  (limit)        => ipcRenderer.invoke('orderguard:closed-orders', limit || 50),
    resetAnchor:   (ea)           => ipcRenderer.invoke('orderguard:reset-anchor', ea),
    // 1.0.8: 护航视图 per-EA 拦截开关 (平仓拦截 close_guard.enabled / 拦 SL 外扩 modify_guard.block_sl_widen)
    setGuardRule:  (ea, key, value) => ipcRenderer.invoke('orderguard:set-guard-rule', ea, key, value),
    enableEa:      (ea, magic, mode, thresholds) => ipcRenderer.invoke('orderguard:enable-ea', ea, magic, mode || 'observe', thresholds || null),
    disableEa:     (ea)           => ipcRenderer.invoke('orderguard:disable-ea', ea),
    // 0.3.66 P1-A: 拦截模式
    deployIntercept: (ea)         => ipcRenderer.invoke('orderguard:deploy-intercept', ea),
    // 0.3.86: 自动识别 EA magic（启用护航对话框用）
    inferMagic:      (ea)         => ipcRenderer.invoke('orderguard:infer-magic', ea),
    // 0.3.151: AI 分析 EA 源码给护航阈值建议 (single_loss / max_holding / max_account_loss / max_locked)
    suggestThresholds: (ea)       => ipcRenderer.invoke('orderguard:suggest-thresholds', ea),
    // 0.3.74 P3: 学习中心
    ruleSuggestions:        (opts) => ipcRenderer.invoke('orderguard:rule-suggestions', opts || {}),
    applyRuleSuggestion:    (id)   => ipcRenderer.invoke('orderguard:apply-rule-suggestion', id),
    dismissRuleSuggestion:  (id)   => ipcRenderer.invoke('orderguard:dismiss-rule-suggestion', id),
    rollbackRuleSuggestion: (id)   => ipcRenderer.invoke('orderguard:rollback-rule-suggestion', id),
    scanRuleSuggestionsNow: (ea)   => ipcRenderer.invoke('orderguard:scan-rule-suggestions-now', ea),
    // 0.3.75 AI 校准统计
    aiAccuracy:             (ea)   => ipcRenderer.invoke('orderguard:ai-accuracy', ea),
    // 0.3.238: 监听拦截模式 AI 改造完后 auto-enableEa 失败事件 —
    // 之前 enableEa 返 {ok:false} 时没通知用户, 用户以为护航成功但实际没.
    onAutoEnableFailed: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('orderguard:auto-enable-failed', wrapped);
      return () => ipcRenderer.removeListener('orderguard:auto-enable-failed', wrapped);
    },
    // 0.3.238: 监听护航状态变化 — main.js enableEa/disableEa 成功后 broadcast,
    // strategies-view 收到后立刻 invalidate cache + refresh 表行 chip,
    // 不用等 5s pollTimer 才显示「监控中/拦截中」.
    onStateChanged: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('orderguard:state-changed', wrapped);
      return () => ipcRenderer.removeListener('orderguard:state-changed', wrapped);
    },
  },
});
