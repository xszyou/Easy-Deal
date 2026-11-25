// Token store — persists which Claude Code credential channel the user is
// using, plus per-mode config. Four mutually-exclusive modes:
//
//   1. "system"  — let Claude Code use its own bundled login and endpoint.
//                  Anthropic-paid plan / personal claude-code login. An
//                  optional EasyDeal model can still be pinned per spawn.
//
//   2. "custom"  — user provides their own endpoint:
//                    base_url   — Anthropic-compatible API base
//                    model      — model id to pin (optional; CLI default if blank)
//                    api_key    — Bearer / x-api-key
//                  We inject these as ANTHROPIC_BASE_URL / ANTHROPIC_MODEL /
//                  ANTHROPIC_AUTH_TOKEN env vars when spawning `claude --print`.
//                  A non-empty model is also promoted to the explicit CLI
//                  `--model` option so CC Switch cannot silently replace it.
//
//   3. "codex"   — local Anthropic-compatible bridge backed by the user's
//                  officially logged-in Codex CLI / ChatGPT subscription.
//
//   4. "fay"     — official Fay relay. Server (easydeal-server) holds many
//                  channel keys, picks one per request via load-balancing,
//                  hands the client a short-lived token + base_url to spawn
//                  with. Server also tracks usage per Fay-account. **Default
//                  for new installs** — purchased serial number includes Fay
//                  quota, so a fresh user shouldn't have to set anything up.
//                  Boot-time auto-issue (see main.js _autoIssueFayIfNeeded)
//                  picks the first available model and caches a token.
//
// Persisted at <userData>/data/token.json. Sensitive (api_key, fay token)
// is stored plain — same risk profile as the broker creds in settings.json.
// Future: encrypt-at-rest with OS keystore.

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');

const VALID_MODES = new Set(['system', 'custom', 'codex']);
const CONTEXT_WINDOW_MIN_TOKENS = 16_000;
const CONTEXT_WINDOW_MAX_TOKENS = 1_000_000;
const CONTEXT_WINDOW_MANUAL_DEFAULT = 200_000;

class TokenStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path    = path.join(dataDir, 'token.json');
    this.data = {
      mode: 'system',
      // 0.3.244: custom 加 protocol — 'anthropic' (默认, 跟之前完全一致) /
      // 'openai' (OpenAI Chat Completions 兼容端点, 走本地代理做协议翻译).
      // 选 'openai' 时 spawnEnvOverrides 会启 OpenAIProxyServer 本地 server,
      // ANTHROPIC_BASE_URL 指向 127.0.0.1:<proxy_port>, 透传所有 Anthropic 请求
      // 翻译成 OpenAI 格式发给 base_url. 支持 text / thinking / tool_use 全套.
      custom: { protocol: 'anthropic', base_url: '', model: '', api_key: '' },
      // 1.3.16: system 模式可选模型 — 非空时由 spawn 层同时传 --model。
      // 'opus[1m]' = 最新 Opus + 1M 上下文(历史默认); '' = 不注入, 跟随 CLI 自己的配置。
      system: { model: 'opus[1m]' },
      // 留空使用 Codex CLI 自身默认模型；非空通过 --model 传给 codex exec。
      codex: { label: 'codex cli', model: '' },
      // 全局上下文窗口策略，四种 token 模式共用。manual 只控制 EasyDeal 的
      // 自动压缩边界（以及 Codex 本地 Bridge 的保护线），不会改变上游模型硬上限。
      context: { mode: 'auto', window_tokens: CONTEXT_WINDOW_MANUAL_DEFAULT },
      fay: {
        bound_account: null,    // user's Fay account id (after binding)
        cached_token:  null,    // last issued temp token
        cached_base_url: null,  // server-assigned API base
        cached_model:  null,    // model server actually bound the token to
                                // (when requested='auto', this is the concrete
                                // id server picked, e.g. claude-sonnet-4-5)
        // 0.3.285: 默认 'auto' 而不是 null. server 收到 'auto' 选 5h 用量最少
        // 的 channel (跟 OpenAI 兼容接口的 auto-model 同款逻辑). 用户在 token tab
        // 仍可改具体 model id, cached_model_requested 跟随用户选择.
        cached_model_requested: 'auto',
        cached_until:  0,       // expires-at unix ms
        // 1.2.31: 服务端下发的当前 model 上下文窗口(token)。chat-session 据此
        // 决定何时主动压缩长对话。null = 服务端没给(老服务端 / 未知 model),
        // 客户端按内置默认兜底。
        context_window: null,
      },
      // 0.3.285: schema migration version — 老 token.json 没有这字段或值 < 1
      // 时, init() 会做一次性 migration 把 cached_model_requested 强制翻为
      // 'auto' (用户明确决策: 「所有人都强制翻为 auto」). 写完 bump 到 1,
      // 下次 init() 跳过.
      auto_migration_version: 1,
      // HTTP/HTTPS proxy for the spawned `claude` process. Critical for
      // mainland China users — Anthropic API isn't directly reachable, so
      // claude.exe needs HTTPS_PROXY pointing at the user's local Clash /
      // V2Ray / 等等. EasyDeal launched from desktop shortcut DOESN'T
      // inherit shell env, so we have to plumb it through explicitly.
      // url:  e.g. "http://127.0.0.1:7890" — empty = no proxy injected
      // mode: "auto" = use process.env's HTTP[S]_PROXY if any (current
      //                behavior); fall back to no proxy
      //       "manual" = always inject `url`
      //       "off" = explicitly disable (sets NO_PROXY=*)
      proxy: { mode: 'auto', url: '' },
    };
    this._codexBridgeOptions = null;
    this._codexBridge = null;
  }

  async init() {
    try {
      const buf = await fsp.readFile(this.path, 'utf8');
      const j = JSON.parse(buf);
      this.data = deepMerge(this.data, j);
      // Validate mode (in case the file was hand-edited to garbage).
      if (!VALID_MODES.has(this.data.mode)) this.data.mode = 'system';
      // 0.3.285: 一次性 migration — 把所有用户的 cached_model_requested 翻为
      // 'auto' (用户决策: 「所有人强制翻为 auto」让服务端选 least-loaded channel).
      // 用 schema version 字段防重复 migrate: 老 token.json 缺这字段 →
      // 视为 v0, 跑 migration, bump 到 1. 想保持手动选可去 token tab 改回.
      const fromVersion = Number(j?.auto_migration_version || 0);
      if (fromVersion < 1) {
        const oldRequested = this.data.fay?.cached_model_requested;
        if (oldRequested && oldRequested !== 'auto') {
          console.log(`[token-store] migration v1: cached_model_requested ${JSON.stringify(oldRequested)} → 'auto' (force least-loaded)`);
          this.data.fay.cached_model_requested = 'auto';
          // 清掉旧 token 让下次 spawn 重新 issue (server 按 'auto' 选 least-loaded)
          this.data.fay.cached_token = null;
          this.data.fay.cached_until = 0;
          // cached_model 留着供 UI 显示 (chip "上次实际 model: X"), 下次 re-issue 会覆盖
        }
        this.data.auto_migration_version = 1;
        try { await this._save(); } catch (e) {
          console.warn('[token-store] migration v1 save failed:', e?.message || e);
        }
      }
    } catch { /* first run */ }
  }

  async _save() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /** Snapshot for UI / status. Hides the actual key value (returns just
   *  a masked length indicator). */
  getMasked() {
    // 目前只有 Fay 签发接口会明确返回所选模型的 context_window。
    // 其他模式不猜值，UI 自动模式应如实显示「服务器未返回」。
    const serverContextWindow = this.data.mode === 'fay'
      && Number(this.data.fay?.context_window) > 0
      ? Number(this.data.fay.context_window) : null;
    return {
      mode: this.data.mode,
      system: { model: (this.data.system && this.data.system.model) ?? 'opus[1m]' },
      custom: {
        // 0.3.244: protocol — 'anthropic' (默认) / 'openai' (走本地代理翻译)
        protocol: this.data.custom.protocol || 'anthropic',
        base_url: this.data.custom.base_url || '',
        model:    this.data.custom.model    || '',
        api_key_set: !!(this.data.custom.api_key && this.data.custom.api_key.length > 0),
        api_key_preview: this.data.custom.api_key
          ? `${this.data.custom.api_key.slice(0, 6)}…${this.data.custom.api_key.slice(-4)}`
          : '',
      },
      codex: {
        label: 'codex cli',
        model: this.data.codex?.model || '',
        configured: !!this._codexBridgeOptions,
      },
      context: {
        mode: this.data.context?.mode === 'manual' ? 'manual' : 'auto',
        window_tokens: Number(this.data.context?.window_tokens) || CONTEXT_WINDOW_MANUAL_DEFAULT,
        min_tokens: CONTEXT_WINDOW_MIN_TOKENS,
        max_tokens: CONTEXT_WINDOW_MAX_TOKENS,
        server_window_tokens: serverContextWindow,
      },
      fay: {
        bound_account: this.data.fay.bound_account,
        cached_model:  this.data.fay.cached_model,
        cached_model_requested: this.data.fay.cached_model_requested || null,
        cached_until:  this.data.fay.cached_until,
        token_alive:   !!(this.data.fay.cached_token && this.data.fay.cached_until > Date.now()),
      },
      proxy: {
        mode: this.data.proxy?.mode || 'auto',
        url:  this.data.proxy?.url  || '',
        // Show what process.env currently has so user can see if "auto"
        // mode is going to pick anything up.
        env_https_proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
      },
    };
  }

  async setProxy(patch) {
    const p = this.data.proxy = this.data.proxy || { mode: 'auto', url: '' };
    if (typeof patch?.mode === 'string'
        && ['auto', 'manual', 'off'].includes(patch.mode)) p.mode = patch.mode;
    if (typeof patch?.url === 'string') p.url = patch.url.trim();
    await this._save();
    // Codex bridge 的子进程在启动时读取代理环境；配置变化后必须重启。
    try { await this.restartCodexBridge(); } catch {}
    return this.getMasked();
  }

  async setMode(mode) {
    if (!VALID_MODES.has(mode)) throw new Error(`bad mode: ${mode}`);
    this.data.mode = mode;
    await this._save();
    return this.getMasked();
  }

  async setCustom(patch) {
    const c = this.data.custom;
    if (typeof patch?.base_url === 'string') c.base_url = patch.base_url.trim();
    if (typeof patch?.model    === 'string') c.model    = patch.model.trim();
    if (typeof patch?.api_key  === 'string') c.api_key  = patch.api_key.trim();
    // 0.3.244: 加 protocol 字段 ('anthropic' / 'openai')
    if (typeof patch?.protocol === 'string' && ['anthropic', 'openai'].includes(patch.protocol)) {
      c.protocol = patch.protocol;
    }
    await this._save();
    // 0.3.244: 用户改了 custom 配置 → 关掉旧 OpenAI 代理, 下次 spawn 会拿新配置启新代理
    try { await this.restartOpenaiProxy(); } catch {}
    return this.getMasked();
  }

  /** 1.3.16: system 模式模型选择 — '' = 跟随 CLI 默认(不注入 ANTHROPIC_MODEL) */
  async setSystem(patch) {
    if (!this.data.system) this.data.system = { model: 'opus[1m]' };
    if (typeof patch?.model === 'string') this.data.system.model = patch.model.trim();
    await this._save();
    return this.getMasked();
  }

  /** Codex CLI 模式模型；空字符串表示跟随 codex 自身默认配置。 */
  async setCodex(patch) {
    if (!this.data.codex) this.data.codex = { label: 'codex cli', model: '' };
    if (typeof patch?.model === 'string') this.data.codex.model = patch.model.trim();
    await this._save();
    try { await this.restartCodexBridge(); } catch {}
    return this.getMasked();
  }

  /** 所有模型共用的上下文窗口策略；manual 值单位为 token。 */
  async setContext(patch) {
    const current = this.data.context || {
      mode: 'auto', window_tokens: CONTEXT_WINDOW_MANUAL_DEFAULT,
    };
    let nextMode = current.mode === 'manual' ? 'manual' : 'auto';
    let nextWindow = Number(current.window_tokens) || CONTEXT_WINDOW_MANUAL_DEFAULT;
    if (typeof patch?.mode === 'string') {
      if (!['auto', 'manual'].includes(patch.mode)) throw new Error('上下文窗口模式无效');
      nextMode = patch.mode;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'window_tokens')) {
      const value = Number(patch.window_tokens);
      if (!Number.isInteger(value)
          || value < CONTEXT_WINDOW_MIN_TOKENS
          || value > CONTEXT_WINDOW_MAX_TOKENS) {
        throw new Error(`上下文窗口必须是 ${CONTEXT_WINDOW_MIN_TOKENS}–${CONTEXT_WINDOW_MAX_TOKENS} token`);
      }
      nextWindow = value;
    }
    // 校验全部通过后再一次性替换，避免失败请求污染内存中的当前配置。
    this.data.context = { mode: nextMode, window_tokens: nextWindow };
    await this._save();
    // Codex Bridge 的字符保护线上限来自这项配置，保存后让下次请求拿新值。
    try { await this.restartCodexBridge(); } catch {}
    return this.getMasked();
  }

  async setFay(patch) {
    const f = this.data.fay;
    if ('bound_account'   in (patch || {})) f.bound_account   = patch.bound_account   || null;
    if ('cached_token'    in (patch || {})) f.cached_token    = patch.cached_token    || null;
    if ('cached_base_url' in (patch || {})) f.cached_base_url = patch.cached_base_url || null;
    if ('cached_model'    in (patch || {})) f.cached_model    = patch.cached_model    || null;
    if ('cached_model_requested' in (patch || {})) f.cached_model_requested = patch.cached_model_requested || null;
    if ('cached_until'    in (patch || {})) f.cached_until    = patch.cached_until    || 0;
    // 1.2.31: 服务端下发的上下文窗口(token)。null/缺省不动以保留上次值。
    if ('context_window'  in (patch || {})) f.context_window  = patch.context_window  || null;
    await this._save();
    return this.getMasked();
  }

  /**
   * Return the env vars to inject when spawning `claude --print`. System mode
   * may contain ANTHROPIC_MODEL; spawn callers also pass it as CLI --model.
   *
   * For custom mode: ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / ANTHROPIC_AUTH_TOKEN
   * For fay mode:    same env vars, sourced from cached server-issued token.
   *
   * Returns { env: {...}, mode, warning?: string } — warning is set when
   * Fay mode is active but token is expired or never fetched (caller may
   * choose to refresh or fall back to system).
   */
  /**
   * 0.3.4 起：返回当前 endpoint 的 fingerprint —— mode + 端点 URL + model
   * 三者合一。chat-session / wechat-sessions 用这个判断 "上次 session
   * 是不是同一个 endpoint 签的 thinking blocks"。不同就别 --resume，否则
   * Anthropic API 验旧 sig 失败 → `Invalid signature in thinking block` 400。
   */
  endpointFingerprint() {
    const m = this.data.mode;
    if (m === 'custom') {
      const c = this.data.custom || {};
      return `custom:${c.base_url || ''}:${c.model || ''}`;
    }
    if (m === 'fay') {
      // 0.3.223: 不再 fingerprint cached_base_url + cached_model — 用户用 'auto'
      // 时 server 每次重签可能给不同 channel + model (least-loaded 算法决定 +
      // 0.5.46 disable 失败 channel 后强制换), fingerprint 一变就预防性不 --resume
      // 导致"昨天会话掉失". 实际 chat-session 已有 thinking-signature-mismatch
      // retry fallback (清 sid 重起 session), 不需要预防性退化. 改成只看 mode,
      // 跨重启 / 跨 channel / 跨 model 都视为同一 endpoint 尝试 --resume.
      return 'fay';
    }
    // Codex bridge is a local protocol adapter: unlike an Anthropic endpoint,
    // it neither creates nor validates server-signed thinking blocks. Keep
    // one stable fingerprint when the user changes the Codex model so the
    // Claude CLI can keep resuming the same local conversation.
    if (m === 'codex') return 'codex-cli';
    return 'system';
  }

  /**
   * 0.3.52: spawn claude 时，process.env 里 OS 配置的 ANTHROPIC_* 环境变量
   * 会跟我们 inject 的 token-mode env 冲突 —— 比如 custom 模式用户只填了
   * api_key 没填 base_url，OS 又设了 ANTHROPIC_BASE_URL=https://corp.proxy
   * → spawn 出去 Claude 拿到「OS 的 base_url + 用户的 api_key」杂交，行为
   * 不可预测（绕过用户的客户端配置 → 用户找半天找不到原因）。
   *
   * 返回 spawn 前要从 process.env 里剥掉的 key 列表：custom / codex / fay 模式下
   * 完全清掉所有 ANTHROPIC_*（包括 SDK 另一种 auth 路径 ANTHROPIC_API_KEY），
   * 让我们的 tokenOverride.env 独占；system 模式不剥 —— 用户在 system 模式
   * 就靠 OS env / claude credential.json，OS env 该被尊重。
   */
  envKeysToStripBeforeSpawn() {
    if (this.data.mode === 'custom' || this.data.mode === 'codex' || this.data.mode === 'fay') {
      return ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
              'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'];
    }
    return [];
  }

  spawnEnvOverrides() {
    const m = this.data.mode;
    let env = {};
    let warning;
    // 0.3.116: 永远关掉 claude-code 的 attribution header（跟 ~/.claude/settings.json
    // 里设 CLAUDE_CODE_ATTRIBUTION_HEADER=0 等价）。Fay / custom 代理通道有些不接受
    // claude-code 标识 header，关了避免被代理 reject / 影响计费 attribution。system
    // 模式下关掉也无害（Anthropic 直连不强制需要这个 header）。
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    if (m === 'custom') {
      const c = this.data.custom;
      if (!c.api_key) {
        warning = 'custom mode but api_key empty — falling back to system claude login';
      } else if (c.protocol === 'openai') {
        // 0.3.244: OpenAI 兼容协议 — 走本地代理. base_url 在代理里持有 (不直接
        // 注入 env), env.ANTHROPIC_BASE_URL 指向 localhost. 代理在 main.js
        // ensureOpenaiProxyForCustom() 里 lazy 启动 (chat / wechat batch spawn
        // 前). 这里只填 placeholder, caller 拿到 env 后会把 ANTHROPIC_BASE_URL
        // 替换成实际本地代理 URL.
        env.ANTHROPIC_AUTH_TOKEN = 'unused-but-claude-sdk-checks-truthy';
        env.ANTHROPIC_BASE_URL = '__EASYDEAL_OPENAI_PROXY__';   // placeholder, caller replace
        if (c.model) env.ANTHROPIC_MODEL = c.model;
      } else {
        // protocol='anthropic' (默认 / 兼容老配置无 protocol 字段) — 直接注入
        env.ANTHROPIC_AUTH_TOKEN = c.api_key;
        if (c.base_url) env.ANTHROPIC_BASE_URL = c.base_url;
        if (c.model)    env.ANTHROPIC_MODEL    = c.model;
      }
    } else if (m === 'codex') {
      // The bridge is started lazily immediately before a Claude spawn.  A
      // random per-process token replaces this placeholder at that point.
      env.ANTHROPIC_AUTH_TOKEN = '__EASYDEAL_CODEX_BRIDGE_TOKEN__';
      env.ANTHROPIC_BASE_URL = '__EASYDEAL_CODEX_BRIDGE__';
    } else if (m === 'fay') {
      const f = this.data.fay;
      if (!f.cached_token || f.cached_until < Date.now()) {
        warning = 'fay mode but no fresh server-issued token; refresh from Token tab or fall back to system';
      } else {
        env.ANTHROPIC_AUTH_TOKEN = f.cached_token;
        if (f.cached_base_url) env.ANTHROPIC_BASE_URL = f.cached_base_url;
        // 绝不把字面 'auto' 注入 ANTHROPIC_MODEL —— claude-code 会拿它去 /v1/models 预检,
        // 'auto' 不是具体 model → 直接拒("selected model (auto) may not exist")。
        // 正常 cached_model 已是 server 解析出的具体 model; 这里是兜底防旧状态/旧 token 残留。
        if (f.cached_model && f.cached_model !== 'auto') env.ANTHROPIC_MODEL = f.cached_model;
      }
    } else if (m === 'system') {
      // 1.0.9: 系统 CLI 登录模式 —— auth 仍由 claude.exe 读自己的
      // ~/.claude/.credentials.json (订阅 / OAuth, 不注入 token)。
      // 1.3.16: 模型改为可配置(Token 页下拉) — data.system.model 注入 ANTHROPIC_MODEL;
      // spawn 层会再提升为显式 --model，避免 CC Switch 的 settings env 覆盖；
      // '' = 不注入, 跟随 CLI 自己的模型配置。默认 'opus[1m]'(历史行为: 最新 Opus +
      // 1M 上下文; 1M 需账户有权限, 无权限 API 直接拒, 可在下拉换 200K 档)。
      const sysModel = (this.data.system && typeof this.data.system.model === 'string')
        ? this.data.system.model : 'opus[1m]';
      if (sysModel) env.ANTHROPIC_MODEL = sysModel;
    }
    // --model selects the CLI model, but settings.json (e.g. CC Switch)
    // can still replace the endpoint and credentials. Protect the route
    // only when EasyDeal supplies it, including either local bridge.
    if (env.ANTHROPIC_AUTH_TOKEN) env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';

    // Proxy injection — applies to ALL modes (mainland China users need
    // it for Anthropic + their custom relay alike). EasyDeal launched
    // from desktop shortcut doesn't inherit shell env so we have to
    // plumb HTTPS_PROXY explicitly.
    const px = this.data.proxy || { mode: 'auto', url: '' };
    if (px.mode === 'manual' && px.url) {
      env.HTTPS_PROXY = px.url;
      env.HTTP_PROXY  = px.url;
      // Don't proxy localhost — Fay token relay is on local server in dev,
      // and our own MCP servers are localhost too.
      if (!process.env.NO_PROXY) {
        env.NO_PROXY = 'localhost,127.0.0.1,::1,.local';
      }
    } else if (px.mode === 'off') {
      // Explicitly disable — useful when user's process.env has stale
      // proxy that's broken.
      env.HTTPS_PROXY = '';
      env.HTTP_PROXY  = '';
      env.NO_PROXY    = '*';
    }
    // 'auto' mode: don't override; spawn inherits parent process.env's
    // HTTP[S]_PROXY (which is empty when launched from desktop shortcut
    // — that's the bug we're working around with 'manual' mode).

    return { env, mode: m, ...(warning ? { warning } : {}) };
  }

  /** 0.3.244: OpenAI 兼容代理 lifecycle.
   *  custom protocol='openai' 时, spawnEnvOverrides 返的 env 含 placeholder
   *  ANTHROPIC_BASE_URL=__EASYDEAL_OPENAI_PROXY__. caller 在 spawn claude 前 await
   *  此 helper, 它懒启动本地 OpenAIProxyServer + 把 placeholder 替换成 真实
   *  127.0.0.1:<port>. 一个 OpenAIProxyServer 实例够所有 spawn 共用 (multi
   *  spawn 同时跑 OK — HTTP server 支持并发). config 变化时调 restartOpenaiProxy.
   */
  async ensureOpenaiProxyAndReplace(env) {
    if (!env || env.ANTHROPIC_BASE_URL !== '__EASYDEAL_OPENAI_PROXY__') return env;
    if (!this._openaiProxy) {
      const { OpenAIProxyServer } = require('./openai-proxy-server');
      const c = this.data.custom || {};
      this._openaiProxy = new OpenAIProxyServer({
        upstreamBaseUrl: c.base_url || '',
        upstreamApiKey:  c.api_key  || '',
        upstreamModel:   c.model    || '',
        log: (m) => console.log('[openai-proxy]', m),
      });
      try {
        await this._openaiProxy.start();
      } catch (e) {
        console.warn('[token-store] OpenAI proxy start failed:', e?.message || e);
        this._openaiProxy = null;
        throw e;
      }
    }
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${this._openaiProxy.port}`;
    return env;
  }

  /** Configure the bundled Python bridge after Settings has resolved paths. */
  configureCodexBridge(options) {
    this._codexBridgeOptions = { ...(options || {}) };
  }

  _getCodexBridge() {
    if (!this._codexBridge) {
      if (!this._codexBridgeOptions) throw new Error('Codex CLI bridge 尚未配置');
      const { CodexCliBridge } = require('./codex-cli-bridge');
      this._codexBridge = new CodexCliBridge({
        ...this._codexBridgeOptions,
        log: (message) => console.log('[codex-cli-bridge]', message),
      });
    }
    return this._codexBridge;
  }

  _codexRuntimeConfig() {
    const proxy = this.data.proxy || { mode: 'auto', url: '' };
    const manualContext = this.data.context?.mode === 'manual'
      ? Number(this.data.context.window_tokens) : 0;
    const {
      CODEX_CLI_MAX_INPUT_CHARS,
      CODEX_BRIDGE_DEFAULT_CONTEXT_CHARS,
    } = require('./codex-cli-bridge');
    return {
      model: this.data.codex?.model || '',
      proxyMode: ['auto', 'manual', 'off'].includes(proxy.mode) ? proxy.mode : 'auto',
      proxyUrl: proxy.mode === 'manual' ? (proxy.url || '') : '',
      // 全局设置单位是 token，bridge 单位是字符。Codex turn/start 另有
      // 1,048,576 字符的协议硬上限；手动填 1M token 也不能越过该上限。
      contextChars: Math.min(
        manualContext > 0 ? manualContext * 4 : CODEX_BRIDGE_DEFAULT_CONTEXT_CHARS,
        CODEX_CLI_MAX_INPUT_CHARS,
      ),
    };
  }

  /** Resolve either local protocol bridge placeholder before spawning Claude. */
  async ensureLocalBridgeAndReplace(env) {
    if (!env) return env;
    if (env.ANTHROPIC_BASE_URL === '__EASYDEAL_OPENAI_PROXY__') {
      return this.ensureOpenaiProxyAndReplace(env);
    }
    if (env.ANTHROPIC_BASE_URL !== '__EASYDEAL_CODEX_BRIDGE__') return env;
    const result = await this._getCodexBridge().start(this._codexRuntimeConfig());
    env.ANTHROPIC_BASE_URL = result.base_url;
    env.ANTHROPIC_AUTH_TOKEN = result.token;
    const currentNoProxy = String(env.NO_PROXY || process.env.NO_PROXY || '');
    const entries = currentNoProxy.split(',').map((part) => part.trim()).filter(Boolean);
    for (const local of ['localhost', '127.0.0.1', '::1']) {
      if (!entries.includes(local) && !entries.includes('*')) entries.push(local);
    }
    env.NO_PROXY = entries.join(',');
    return env;
  }

  async codexStatus() {
    return this._getCodexBridge().status({
      start: true,
      runtime: this._codexRuntimeConfig(),
    });
  }

  async restartCodexBridge() {
    if (!this._codexBridge) return;
    try { await this._codexBridge.stop(); } finally { this._codexBridge = null; }
  }

  async stopLocalBridges() {
    await this.restartOpenaiProxy();
    try { await this.restartCodexBridge(); } catch {}
  }

  /** 用户在 Token tab 改了 custom 配置 → 关掉旧 proxy 让下次 spawn 启新的 with new config. */
  async restartOpenaiProxy() {
    if (!this._openaiProxy) return;
    try { await this._openaiProxy.stop(); } catch {}
    this._openaiProxy = null;
  }

  /** Pre-flight test for OpenAI custom endpoint — 用临时 server 实例发一个最小请求验证. */
  async testOpenaiCustomEndpoint() {
    const c = this.data.custom || {};
    if (c.protocol !== 'openai') return { ok: false, error: 'protocol 不是 openai' };
    if (!c.base_url) return { ok: false, error: 'base_url 必填' };
    if (!c.api_key) return { ok: false, error: 'api_key 必填' };
    if (!c.model) return { ok: false, error: 'model 必填' };
    const { OpenAIProxyServer } = require('./openai-proxy-server');
    const tmp = new OpenAIProxyServer({
      upstreamBaseUrl: c.base_url,
      upstreamApiKey: c.api_key,
      upstreamModel: c.model,
      log: () => {},
    });
    return await tmp.preflightTest();
  }
}

/**
 * Pre-flight check before spawning claude. Looks at what spawnEnvOverrides()
 * is about to inject and decides whether the spawn would silently fall back
 * to system mode when the user actually wanted fay/custom — i.e. the
 * "选了 Fay 但没 token，spawn 出去后 claude exited 1 (no stderr) 没头没尾"
 * failure mode the user keeps complaining about.
 *
 * Returns null when spawn is OK to proceed, or { title, body } when the
 * caller should ABORT and surface the message instead of spawning a doomed
 * claude.exe.
 *
 * Specifically catches:
 *   - mode=fay   + no fresh cached_token → 联系 Fay 充 token / 切其他模式
 *   - mode=custom + no api_key            → 去 Token 通道页填 api_key
 * (mode=system is left to the runtime — we can't tell here if the user's
 * ~/.claude OAuth is valid; that fails at spawn-time and is caught by
 * chat-session.js's "exited 1 (no stderr)" classifier.)
 */
function classifyTokenSpawnIssue(spawnInfo) {
  if (!spawnInfo) return null;
  const mode = spawnInfo.mode;
  const w = spawnInfo.warning || '';
  if (mode === 'fay' && /fay.*no fresh|no fresh.*token|cached_token/i.test(w)) {
    return {
      title: 'Fay 通道 token 不可用',
      body:
        '当前选了 Fay 通道，但服务端没给你签到可用的 token。可能原因：\n'
        + '1. ⭐ **token 配额用完了** — 联系 Fay 数字人开源社区购买 / 充值 token（QQ / 微信群在「资讯」页）\n'
        + '2. 序列号已过期 — 同样联系社区续期\n'
        + '3. 服务端 Fay 通道暂时不可用 — 在「Token 通道」页点「刷新」重试，或者切到「自定义端点」用自己的 API_KEY\n'
        + '4. 切到「系统 Claude Code」 — 前提是你本机 ~/.claude 已经 OAuth 登录过',
    };
  }
  if (mode === 'custom' && /custom.*api_key|api_key empty/i.test(w)) {
    return {
      title: '自定义端点没填 API_KEY',
      body:
        '当前选了「自定义端点」模式，但 api_key 是空的。去「Token 通道」页：\n'
        + '1. 填 base_url（Anthropic 兼容端点）+ api_key\n'
        + '2. 保存后重试\n\n'
        + '或者切回「Fay」/「系统」模式（不需要自己填 key）。',
    };
  }
  return null;
}

function deepMerge(a, b) {
  if (typeof a !== 'object' || a == null || Array.isArray(a)) return b ?? a;
  if (typeof b !== 'object' || b == null || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

module.exports = { TokenStore, classifyTokenSpawnIssue };
