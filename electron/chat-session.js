// In-app chat with Claude Code.
//
// We don't keep a long-running stdio session because Claude Code's main use
// case is per-turn invocation. Instead, each user message triggers
//   claude --print --continue "<msg>"  in cwd=workspace.
// `--continue` resumes the previous conversation in the same workspace, so
// from the user's POV the chat has memory across turns.
//
// History is mirrored locally for fast UI render and persisted to
// <userData>/data/chat.json. Use `reset()` to start a fresh thread (which
// also creates a fresh Claude session: we omit --continue on the next call).

const fs = require('node:fs/promises');
const fsNative = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { resolveClaudeBin, withClaudeModelArg, formatClaudeExitError } = require('./claude-runner');
const { classifyTokenSpawnIssue } = require('./token-store');

const HISTORY_CAP = 200;

// Marker prefix used to smuggle a structured friendly error through the
// normal Error.message channel. Recognised by _classifyChatError.
const FRIENDLY_ERR_MARKER = '__easydeal_friendly__:';

// 1.2.30: 「上下文超出模型窗口」错误识别。这跟 channel error 完全是两码事 ——
// 它是「这次请求的输入(累积对话历史 + 工具输出)太大，超过了当前模型的 context
// window」。**切换通道 / 换模型对它毫无帮助**(代理的各家模型窗口都差不多大，新
// 模型照样撞墙)，唯一的解是把上下文压小(摘要 + 新会话)。常见文案：
//   MiniMax  : "invalid params, context window exceeds limit (2013)"
//   通用      : "prompt is too long", "maximum context length", "context_length_exceeded"
//   Anthropic: "input length and max_tokens exceed context limit"
//   Codex CLI Bridge: "conversation context is N characters ... character limit;
//                     bridge refused to silently truncate it"
const _CTX_OVERFLOW_RE = /context window exceeds? limit|context[_ ]length[_ ]exceeded|exceeds? (?:the )?(?:model'?s? )?context|maximum context length|prompt is too long|input length .* exceed .* context|input exceeds the maximum length of \d+ characters|input_too_large|max_chars["']?\s*:\s*\d+|conversation context is \d+ characters|configured \d+ character limit|refused to silently truncate|\(2013\)/i;

// 压缩后带进新会话的摘要前缀。
const CTX_COMPACT_PREFIX =
  '【上文摘要 — 因对话过长已自动压缩并新建会话，以下是之前对话的要点，请据此继续】';

const PROVIDER_SWITCH_PREFIX =
  '【上文摘要 — 因切换到 Claude 订阅已新建会话，以下是上一会话的要点，请据此继续】';

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 1.5.11 曾把默认 Codex 指纹写成 codex-cli:default、手填模型写成
// codex-cli:<model>。这些全是同一个本地 bridge，不应因此断开 Claude
// 本地 session；保留兼容判断，避免已经落盘的旧标记再制造一次新会话。
function endpointResumeDecision(previous, current) {
  if (previous === current) return { resume: true, reason: 'same-endpoint' };
  const isCodex = (value) => /^codex-cli(?::|$)/.test(String(value || ''));
  if (isCodex(previous) && isCodex(current)) return { resume: true, reason: 'same-codex-bridge' };
  // Claude 订阅端会严格校验上游 thinking block 的签名。只有切回系统 Claude
  // 时主动断开旧 session；其余通道/模型切换先尝试续接，若真实上游返回签名
  // 不兼容，再由 send() 的错误分支带摘要重建，避免预防性丢上下文。
  if (current === 'system' && previous && previous !== 'system') {
    return { resume: false, reason: 'switch-to-claude-subscription' };
  }
  return { resume: true, reason: 'optimistic-cross-endpoint' };
}

function canResumeEndpoint(previous, current) {
  return endpointResumeDecision(previous, current).resume;
}

function claudeProjectDir(workspaceDir, homeDir = os.homedir()) {
  const encoded = path.resolve(workspaceDir).replace(/[:\\/]/g, '-');
  return path.join(homeDir, '.claude', 'projects', encoded);
}

function _claudeContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function _cleanRestoredUserText(value) {
  let text = String(value || '').trim();
  for (const marker of ['【用户当前消息】', '用户新消息：', '用户消息：']) {
    const at = text.lastIndexOf(marker);
    if (at >= 0) text = text.slice(at + marker.length).trim();
  }
  text = text
    .replace(/<live-state>[\s\S]*?<\/live-state>/gi, '')
    .replace(/<remote-attachment>[\s\S]*?<\/remote-attachment>/gi, '')
    .trim();
  return text.slice(0, 16_000);
}

/** Parse Claude Code JSONL without exposing thinking/tool payloads to the UI. */
function parseClaudeSessionLog(raw, { sessionId = '', includeHistory = false } = {}) {
  let title = '';
  let firstUser = '';
  let lastUser = '';
  let firstTs = 0;
  let lastTs = 0;
  const history = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(row.timestamp || '') || 0;
    if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) {
      title = row.aiTitle.trim().slice(0, 120);
    }
    if (row.isMeta || row.isSidechain || !row.message) continue;
    const role = row.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = _claudeContentText(row.message.content);
    if (role === 'user') text = _cleanRestoredUserText(text);
    else text = String(text || '').trim().slice(0, 16_000);
    if (!text) continue;
    if (role === 'user') {
      if (!firstUser) firstUser = text;
      lastUser = text;
    }
    if (!includeHistory) continue;
    const prev = history[history.length - 1];
    if (prev && prev.role === role && role === 'assistant') {
      if (!prev.content.includes(text)) prev.content += `\n\n${text}`;
      if (ts) prev.ts = ts;
      continue;
    }
    if (prev && prev.role === role && prev.content === text) continue;
    history.push({
      id: `restored_${sessionId || 'session'}_${history.length}`,
      role,
      content: text,
      ts: ts || Date.now(),
      historical: true,
    });
  }
  const preview = (lastUser || firstUser || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    title: title || preview || '未命名会话',
    preview,
    firstTs,
    lastTs,
    background: /^\[(?:scheduled|system)-trigger:/i.test(firstUser),
    history,
  };
}

async function countClaudeSessionMessages(file) {
  let count = 0;
  let userCount = 0;
  let assistantCount = 0;
  let lastVisibleRole = '';
  const input = fsNative.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.isMeta || row.isSidechain || !row.message) continue;
      const role = row.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      let text = _claudeContentText(row.message.content);
      if (role === 'user') text = _cleanRestoredUserText(text);
      else text = String(text || '').trim();
      if (!text) continue; // tool_result / thinking / tool_use 都不计消息
      if (role === 'assistant' && lastVisibleRole === 'assistant') continue;
      count += 1;
      if (role === 'user') userCount += 1;
      else assistantCount += 1;
      lastVisibleRole = role;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { count, userCount, assistantCount };
}

// fay 模式主动压缩：优先用服务端下发的**该 model 真实上下文窗口**(token-store
// fay.context_window，由服务端 model_specs 探测/手填/内置写入)× 安全系数。
// 服务端没给(老服务端 / 未知 model)时退回这个保守默认。fay 代理的模型
// (MiniMax / GLM / DeepSeek 等)窗口比 Claude(1M)小很多(多为 128K~256K)，
// 上一轮真实 input_tokens 峰值超过软上限就在下一轮发送前先压缩，避免撞 (2013)。
// 比软上限更小窗口的模型(罕见)由 catch 里的反应式自愈兜底。
const FAY_CONTEXT_SOFT_LIMIT_FALLBACK = 120_000;   // 服务端没下发窗口时的兜底软上限
const CONTEXT_SOFT_FACTOR = 0.85;                  // 软上限 = 真实窗口 × 此系数
const CODEX_CONTEXT_CHARS_DEFAULT = 600_000;
const CODEX_CONTEXT_CHARS_HARD_MAX = 1_048_576;
const CODEX_CONTEXT_CHARS_PER_TOKEN = 4;
const CODEX_CONTEXT_SOFT_FACTOR = 0.80;             // 600K 字符默认在约 480K 时提前压缩

/**
 * Classify a Claude Code error message into a friendly Chinese summary
 * with actionable advice. Returns null when nothing matches (caller falls
 * back to the raw error). Detects:
 *   - quota_exhausted        → license quota dry, ask to switch channel / contact admin
 *   - license_expired        → license expired, ask to renew
 *   - 401 / token expired    → Fay token expired, prompt re-issue / switch
 *   - 403 / forbidden        → permission / proxy issue, prompt proxy check
 *   - sha256_mismatch        → file integrity (build-time concern, rare)
 */
// 1.3.17: Windows Server 2016 / Win10 <1809 跑不了 Claude Code 2.x 原生 exe(Bun 运行时,
// 官方最低 Win10 1809 / Server 2019) — 进程秒崩 0xC0000409(=3221225785)、无 stderr。
// 实测(用户, 阿里云 ECS Server 2016): 换模型/重试全崩, 被误报「模型暂时不可用」查偏方向。
function _isUnsupportedWindows() {
  try {
    if (process.platform !== 'win32') return false;
    const p = String(require('node:os').release()).split('.');
    const major = Number(p[0] || 0), build = Number(p[2] || 0);
    return major < 10 || (major === 10 && build < 17763);
  } catch { return false; }
}

function _classifyChatError(msg) {
  const s = String(msg || '');
  // Marker: a friendly { title, body } was packed into the Error message
  // by the pre-flight token check. Just unpack and return.
  if (s.startsWith(FRIENDLY_ERR_MARKER)) {
    try {
      return JSON.parse(s.slice(FRIENDLY_ERR_MARKER.length));
    } catch {
      // fall through to other classifiers
    }
  }
  // 1.3.17: 老系统上 claude.exe 秒崩 — 给准确指向, 别让用户当通道问题查。
  if (/3221225785|0xC0000409/i.test(s) && _isUnsupportedWindows()) {
    return {
      title: '系统版本过低 — AI 引擎无法在本机运行',
      body:
        `本机 Windows 版本（${require('node:os').release()}）低于 AI 引擎的最低要求 `
        + '**Windows 10 1809 / Windows Server 2019**，AI 进程启动即崩溃 —— '
        + '这不是模型或通道问题，换模型 / 重试都没用。\n\n'
        + '解决：把操作系统升级到 Windows 10(1809+) / Server 2019 / Server 2022。'
        + '云服务器（阿里云等）可在控制台「更换操作系统」，数据盘不受影响（EasyDeal 与 MT5 需重装）。',
    };
  }
  // claude exited 1 with no stderr — almost always means the spawned
  // claude.exe couldn't authenticate at all (system mode + no OAuth, or
  // injected ANTHROPIC_AUTH_TOKEN was rejected before any output). User
  // sees this constantly when fay token quota runs out + system fallback
  // also has no creds.
  if (/claude exited 1.*\(no stderr\)|exit.*code 1.*no stderr/i.test(s)) {
    return {
      title: 'Claude 启动失败 — 八成是凭据有问题',
      body:
        '通常原因（按概率从高到低）：\n'
        + '1. ⭐ **你在用 Fay 通道但 token 配额用完了** — 联系 Fay 数字人开源社区购买 token（QQ / 微信群在「资讯」页）\n'
        + '2. 系统 Claude 模式下 ~/.claude OAuth 过期 — 跑一次 `claude /login` 续约\n'
        + '3. 自定义端点的 api_key 失效 — 去「Token 通道」页换新的\n'
        + '4. 网络 / 代理问题 — 确认 HTTPS_PROXY 设了',
    };
  }
  if (/quota_exhausted|monthly_quota_exhausted|quota.*exceeded/i.test(s)) {
    // Try to detect trial vs pro from the error body (server emits
    // is_trial:true in detail JSON for monthly_quota_exhausted).
    const isTrial = /is_trial.*true|"trial"/i.test(s);
    return {
      title: 'Token 用量已达上限',
      body: isTrial
        ? '试用配额（10 万 token）用完了。试用号配额一次性，不会重置。建议：\n'
          + '1. ⭐ **联系 Fay 数字人开源社区购买正式版序列号**（QQ / 微信群在「资讯」页都有）\n'
          + '2. 临时顶上：「Token 通道」页 → 切「自定义端点」用自己的 API_KEY'
        : '本月配额用完了。建议：\n'
          + '1. ⭐ **联系 Fay 数字人开源社区充值 token**（QQ / 微信群在「资讯」页都有）\n'
          + '2. 临时顶上：「Token 通道」页 → 切「自定义端点」用自己的 API_KEY\n'
          + '3. 等下个月（北京时间月初）自动重置',
    };
  }
  if (/license[_ ]?expired|序列号已过期|machine_locked/i.test(s)) {
    return {
      title: '序列号问题',
      body:
        '你的序列号已过期或机器锁定。可以：\n'
        + '1. 试用版到期 → 联系管理员升级 / 续期\n'
        + '2. 换机器 → 联系管理员解绑\n'
        + '3. 或填一个**未绑定**的新序列号（在登录界面）',
    };
  }
  if (/(401|403).*(forbidden|unauthorized|request not allowed|fay_token)/i.test(s)
      || /fay.*token.*expired|fay.*token.*invalid|token.*revoked/i.test(s)) {
    return {
      title: 'Fay 通道 token 不可用',
      body:
        '可能原因：token 过期 / 通道挂了 / 配额满。可以：\n'
        + '1. 「Token 通道」页 → Fay → 刷新 → 重新申请 token\n'
        + '2. 切到「自定义端点」用自己的 API_KEY 临时顶上\n'
        + '3. 切回「系统 Claude Code」配合 HTTP 代理\n'
        + '4. 还不行就联系管理员看看通道健康度',
    };
  }
  if (/Request not allowed|API Error: 403/i.test(s)) {
    return {
      title: 'Anthropic API 拒绝了请求',
      body:
        '通常是网络 / 代理 / 凭据问题。如果你在中国大陆：\n'
        + '1. 确认「Token 通道 → HTTP 代理」设了「手动」+ 你的本地 Clash/V2Ray 端口\n'
        + '2. 系统 Claude 模式：本地 ~/.claude/.credentials.json 的 OAuth token 可能过期，跑一次 `claude /login` 续约\n'
        + '3. 或直接切到「自定义端点」用国内可达的兼容服务',
    };
  }
  if (/(?:Codex CLI|AI engine).*(?:no final agent message|no final text|without a text response)/i.test(s)) {
    return {
      title: 'Codex 本轮没有返回正文',
      body:
        'Codex 进程已经结束，但没有生成最终回复。客户端已把本轮标记为失败，不会再把空结果伪装成“已完成”。\n\n'
        + '如果来自定时任务，下一次触发会重新执行；也可以在任务页手动点一次运行。',
    };
  }
  // 502/upstream_unreachable: Fay 中转能联通，但 Anthropic 那头不通；
  // 500: Fay 中转自己挂了 / 代码 bug。两种都建议先重试，再换通道。
  // Codex 的 input_too_large 也可能被桥接层包成 502；保留给下方的
  // 上下文超限分支处理，避免误报成 Fay 上游故障。
  if (/upstream_unreachable|API Error: 502|HTTP 502/i.test(s) && !_CTX_OVERFLOW_RE.test(s)) {
    return {
      title: 'Fay 通道上游不可达',
      body:
        '中转服务能联到，但 Anthropic 那头超时或拒绝了。可以：\n'
        + '1. 等 1 分钟重试（多半是上游瞬时抽风）\n'
        + '2. 「Token 通道」页 → Fay → 选另一个模型（不同模型走不同上游）\n'
        + '3. 切到「自定义端点」用自己的 API_KEY\n'
        + '4. 多次重现请反馈给社区，我们看通道健康度',
    };
  }
  if (/API Error: 500|HTTP 500|Internal Server Error/i.test(s)) {
    return {
      title: 'Fay 中转服务报错',
      body:
        '通常是临时故障，先重试一次。如果一直 500：\n'
        + '1. 「Token 通道」页 → Fay → 刷新 → 重新申请 token（旧 token 可能踩到坏通道）\n'
        + '2. 暂时切到「自定义端点」或「系统 Claude」\n'
        + '3. 告知社区，附上原始错误便于排查',
    };
  }
  // 0.3.22: 429 自动重试失败后兜底。客户端 0.3.6 起 catch 块已经会尝试
  // tokenReissuer 切到另一条通道；只有当**同 model 在你这边只有一条通道，
  // 或所有通道都被限流**时，才会把原 429 抛到 friendly classifier 这层。
  // 用户实测撞过 — 不能让它再吐英文 stack 给用户脸上。
  if (/\b429\b|rate.?limit|too many requests|该模型当前访问量过大|Request rejected.*429/i.test(s)) {
    return {
      title: '该 model 当前所有通道都满载了',
      body:
        '客户端已经尝试自动切换到别的通道但失败了 —— 这通常意味着：\n'
        + '• 同一个 model 在 Fay 后台只配了一条通道，没第二条可换；或\n'
        + '• 所有同 model 的通道都被上游网关限流（cooldown 中）\n\n'
        + '建议（按生效快慢）：\n'
        + '1. ⭐ **「Token 通道」页换一个 model** — 切到 GLM-5.1 / Doubao / DeepSeek 任一个不冲突的模型，立刻能用\n'
        + '2. 等 5-10 分钟让上游冷却 — 通道限流通常 1-2 小时内自动恢复\n'
        + '3. 临时切「自定义端点」用自己的 API key 顶一会儿\n'
        + '4. 反馈给社区，让管理员给这个 model 加多一条通道做真正的负载均衡',
    };
  }
  // 1.2.30: 上下文超出模型窗口。只有连压缩+重试都救不回来(摘要本身还太大 /
  // 单条消息+附件就超窗)才会落到这层 friendly。明确告诉用户切模型没用、要新会话。
  if (_CTX_OVERFLOW_RE.test(s)) {
    return {
      title: '对话太长了 — 超出模型上下文上限',
      body:
        '这次对话累积的内容(历史 + 附件 / 工具输出)超过了当前模型能装下的上限。\n'
        + '**换模型解决不了**(各家模型窗口都差不多大，新模型照样装不下)。建议：\n'
        + '1. ⭐ **点「新会话」重新开始**(可选「带摘要」保留要点)，立刻就能继续\n'
        + '2. 如果这条消息带了很大的附件 / 文件，拆小一点再发\n'
        + '3. 长对话养成习惯：阶段性点「新会话(带摘要)」，既保留上下文又不会越积越大',
    };
  }
  return null;
}

/**
 * Decode a list of Buffer chunks (typically stderr) to text. On Chinese
 * Windows, claude-code emits error messages in the active code page (GBK)
 * rather than UTF-8. Naive .toString('utf8') turns those into a string
 * full of U+FFFD replacement chars — useless for debugging.
 *
 * Strategy: try UTF-8 first; if too many replacement chars (>5%), retry
 * with GBK via TextDecoder. Falls back to raw UTF-8 if GBK also fails.
 */
function _decodeStderr(chunks) {
  if (!chunks || !chunks.length) return '';
  const buf = Buffer.concat(chunks);
  const utf8 = buf.toString('utf8');
  const replCount = (utf8.match(/�/g) || []).length;
  if (replCount > 0 && replCount / Math.max(1, utf8.length) > 0.02) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      try { return new TextDecoder('gb18030').decode(buf); } catch {}
    }
  }
  return utf8;
}

/**
 * Extract explicit EasyDeal remote client keys from task metadata/prompt text.
 * Scheduled tasks created before structured remote bindings existed already
 * carry the key in their name or prompt, so this is also the migration path.
 */
function extractRemoteClientKeys(...values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const matches = String(value || '').match(/\bEZDL-[A-Z0-9]+-[A-Z0-9]+\b/gi) || [];
    for (const match of matches) {
      const key = match.toUpperCase();
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
  }
  return out;
}

class ChatSession extends EventEmitter {
  constructor({ workspaceDir, dataDir, contextProvider, tokenStore, tokenReissuer,
                sessionKey, channel, dataFileName, remoteMcpProvider, claudeHomeDir }) {
    super();
    this.workspaceDir = workspaceDir;
    this._claudeHomeDir = claudeHomeDir || os.homedir();
    // 多会话(1.3.x): sessionKey 标识本会话(global / strat:<login>:<ea>); channel 是
    // 手机镜像侧的会话隔离维度(global→'chat' 不变, 策略→同 sessionKey), 写进 ai-comm-log
    // 每条 turn。dataFileName 让每个会话持久化到各自文件(global→chat.json 不变)。
    this.sessionKey = sessionKey || 'global';
    this.channel = channel || 'chat';
    this.dataPath = path.join(dataDir, dataFileName || 'chat.json');
    this.history = [];
    this.busy = false;
    this.activeChild = null;
    this.continueNext = false; // 旧字段，保留 back-compat 但 0.2.6 起不再读它决定 resume
    // 0.2.6 起：跟踪用户对话专属的 Claude session id，next send 用
    // `--resume <id>` 而不是 `--continue`。原因：`--continue` 会 resume
    // cwd 下"最新的"那个 session，但 EasyDeal 在同一个 workspace 里同时
    // 跑 cron 任务 / 健康检查 / 微信回话等，每一个都写自己的 session
    // JSONL —— 用户敲完一句，--continue 经常 resume 到最近的 cron 任务
    // 上下文里去，AI 拿用户问题去对照之前的"回测进度查询"指令，自然
    // 答得不对。改成显式 --resume <userChatSessionId> 就跟 wechat-sessions
    // 走的同一套思路（按 chatId 隔离），用户对话只跟自己之前续，不被
    // 任何后台任务截胡。
    this.lastSessionId = null;
    // 0.3.4 起：跟 lastSessionId 配套记录"上一次 spawn 时用的 endpoint
    // fingerprint"。切回系统 Claude 时主动新建并带摘要；其他通道/模型变化
    // 先续接，只有上游真的报 thinking 签名不兼容才带摘要重建。Codex CLI
    // 模型切换始终复用同一条本地会话。
    this.lastSessionEndpoint = null;
    // tokenStore.spawnEnvOverrides() returns the ANTHROPIC_* envs to inject
    // when spawning `claude --print` (so the user can route to a custom
    // endpoint or Fay's relay instead of the system claude login).
    this.tokenStore = tokenStore || null;
    // 0.4.0: 拿到 429 / rate_limit 错误时调这个函数重新 issue fay token，
    // 服务端会按 cooldown / consecutive_failures 自动绕开挂掉的 channel
    // 给个健康的（Phase 1+5 配套）。返回 promise，resolve = 成功换好 token
    // （tokenStore 已被更新），reject = 换不到（所有 channel 都挂或 license
    // 配额满之类）。
    this._tokenReissuer = (typeof tokenReissuer === 'function') ? tokenReissuer : null;
    // Optional async fn returning a string of "live workspace state" to
    // prepend on every turn. Lets the agent stay aware of which EAs are
    // mounted on MT5 right now without the user re-stating it each turn.
    this._contextProvider = contextProvider || null;
    // 1.4.x「附加远程会话」: 用户在输入栏点 🖥 把一台被控机附加到本会话。
    // remoteAttachment = { clientKey, note } | null, 随 chat 文件持久化。
    // remoteMcpProvider(session) 由 main.js 注入: 每次 spawn 前现写一份
    // per-session 的 remote mcp-config(带当前 token, 避免 env 快照 stale),
    // 返回文件路径; 拿不到 token/未配置返回 null(该轮就不带远程工具)。
    this.remoteAttachment = null;
    this._remoteMcpProvider = (typeof remoteMcpProvider === 'function') ? remoteMcpProvider : null;
  }

  // ── 附加远程会话 — set/clear 都立即持久化, UI 随时可换可拆 ──
  // 1.5.x: scope 跟随通讯栏远程控制授权的档位(read/manage/trade), 不再固定只读。
  // 服务端每次调用仍按真实 grant 闸(客户端声明高了也 403), 这里只决定暴露哪些工具。
  //
  // 2026-08-08 改成**可附加多台**(用户要求)。存储从单对象换成数组 remoteAttachments。
  // `remoteAttachment`(单数)保留为**取第一台的 getter**, 让老代码路径不用全改;
  // 新代码一律走 remoteAttachments。
  /** 被控机 → MCP server 名。**单台时保持历史上的 `remote`** —— 改名会让存量会话
   *  里 AI 记住的工具名(mcp__remote__get_status)全部失效。多台时才按 key 加后缀。 */
  static remoteServerName(clientKey, idx, total, forceQualified = false) {
    if (!forceQualified && (!total || total <= 1)) return 'remote';
    return 'remote_' + String(clientKey || ('c' + idx)).replace(/[^A-Za-z0-9_]/g, '_');
  }

  static _normAtt(att) {
    if (!att || typeof att.clientKey !== 'string' || !att.clientKey.trim()) return null;
    const scope = ['read', 'manage', 'trade'].includes(att.scope) ? att.scope : 'read';
    return { clientKey: att.clientKey.trim(), note: String(att.note || ''), scope };
  }

  get remoteAttachment() {
    return (this.remoteAttachments && this.remoteAttachments.length) ? this.remoteAttachments[0] : null;
  }

  // 兼容旧写法 `this.remoteAttachment = x` / `= null`(init 里就有)
  set remoteAttachment(att) {
    const n = ChatSession._normAtt(att);
    this.remoteAttachments = n ? [n] : [];
  }

  /** 整体替换附加列表。传 null/[] = 全拆。也接受单个对象(向后兼容)。 */
  async setRemoteAttachment(att) {
    const list = Array.isArray(att) ? att : (att ? [att] : []);
    const seen = new Set();
    const out = [];
    for (const a of list) {
      const n = ChatSession._normAtt(a);
      // 同一台被控机只留一条(以先出现的为准), 免得 MCP server 名字撞车
      if (n && !seen.has(n.clientKey)) { seen.add(n.clientKey); out.push(n); }
    }
    this.remoteAttachments = out;
    await this._save();
    return { ok: true, attachment: this.remoteAttachment, attachments: this.remoteAttachments };
  }

  /** 追加一台(已存在则更新其 scope/note)。 */
  async addRemoteAttachment(att) {
    const n = ChatSession._normAtt(att);
    if (!n) return { ok: false, error: 'clientKey required' };
    const cur = (this.remoteAttachments || []).filter((x) => x.clientKey !== n.clientKey);
    cur.push(n);
    this.remoteAttachments = cur;
    await this._save();
    return { ok: true, attachments: this.remoteAttachments };
  }

  /** 拆掉一台。 */
  async removeRemoteAttachment(clientKey) {
    const k = String(clientKey || '').trim();
    this.remoteAttachments = (this.remoteAttachments || []).filter((x) => x.clientKey !== k);
    await this._save();
    return { ok: true, attachments: this.remoteAttachments };
  }

  getRemoteAttachment() { return this.remoteAttachment; }

  getRemoteAttachments() { return (this.remoteAttachments || []).slice(); }

  async init() {
    try {
      const buf = await fs.readFile(this.dataPath, 'utf8');
      const j = JSON.parse(buf);
      this.history = Array.isArray(j.history) ? j.history : [];
      this.continueNext = !!j.continueNext;
      this.lastSessionId = (typeof j.lastSessionId === 'string' && j.lastSessionId) ? j.lastSessionId : null;
      this.lastSessionEndpoint = (typeof j.lastSessionEndpoint === 'string' && j.lastSessionEndpoint) ? j.lastSessionEndpoint : null;
      // 2026-08-08: 先读新字段 remoteAttachments(数组), 没有再回落到旧的单数字段
      // —— 存量 chat 文件全是旧格式, 不兼容读会让用户已附加的被控机凭空消失。
      // 写入侧只写新字段(见 _save), 所以是「读双写单」的一次性迁移。
      const _rawList = Array.isArray(j.remoteAttachments)
        ? j.remoteAttachments
        : (j.remoteAttachment ? [j.remoteAttachment] : []);
      const _seen = new Set();
      this.remoteAttachments = [];
      for (const a of _rawList) {
        const n = ChatSession._normAtt(a);
        if (n && !_seen.has(n.clientKey)) { _seen.add(n.clientKey); this.remoteAttachments.push(n); }
      }
      // Repair: any turn left in 'pending' from a previous crashed run
      // would render forever as a spinner. Mark it as interrupted so the
      // bubble shows useful text instead.
      let dirty = false;
      for (const t of this.history) {
        if (t.pending) {
          t.pending = false;
          if (!t.content) t.content = '_(上次运行被中断)_';
          dirty = true;
        }
        if (!t.id) { t.id = `turn_recover_${t.ts || 0}_${Math.random().toString(36).slice(2, 6)}`; dirty = true; }
      }
      if (dirty) await this._save();
    } catch { /* first run */ }
  }

  getHistory() { return this.history.slice(); }

  isBusy() { return this.busy; }

  async _readClaudeSession(sessionId, maxBytes = null) {
    if (!CLAUDE_SESSION_ID_RE.test(String(sessionId || ''))) {
      throw new Error('invalid session id');
    }
    const dir = claudeProjectDir(this.workspaceDir, this._claudeHomeDir);
    const file = path.join(dir, `${sessionId}.jsonl`);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('session file not found');
    const bytes = maxBytes == null ? stat.size : Math.min(stat.size, maxBytes);
    if (bytes > 32 * 1024 * 1024) throw new Error('session file is too large to restore');
    const handle = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return { raw: buf.subarray(0, bytesRead).toString('utf8'), stat, file };
    } finally {
      await handle.close();
    }
  }

  /** List recoverable top-level Claude Code sessions for this EasyDeal workspace. */
  async listRecoverableSessions(limit = 40) {
    const dir = claudeProjectDir(this.workspaceDir, this._claudeHomeDir);
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const maxRows = Math.max(1, Math.min(Number(limit) || 40, 100));
    const candidates = [];
    for (const entry of entries) {
      const sessionId = entry.name.replace(/\.jsonl$/i, '');
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name) || !CLAUDE_SESSION_ID_RE.test(sessionId)) continue;
      try {
        const file = path.join(dir, entry.name);
        const stat = await fs.stat(file);
        candidates.push({ entry, sessionId, file, stat });
      } catch { /* 单个文件刚好被清理 */ }
    }
    candidates.sort((a, b) => Number(b.stat.mtimeMs || 0) - Number(a.stat.mtimeMs || 0));
    const rows = [];
    const inspected = new Set();
    const inspectCandidate = async (candidate) => {
      const { sessionId, file, stat } = candidate;
      inspected.add(sessionId);
      try {
        const { raw } = await this._readClaudeSession(sessionId, 512 * 1024);
        const meta = parseClaudeSessionLog(raw, { sessionId, includeHistory: false });
        // 定时任务 / 系统触发产生的 Claude 会话属于内部运行记录，不是用户聊天历史。
        // 在数据源处排除，既不占正常会话的列表名额，也不会让 UI 误导用户去恢复。
        if (meta.background) return null;
        const counts = await countClaudeSessionMessages(file);
        const startedAt = meta.firstTs || Number(stat.birthtimeMs) || Number(stat.ctimeMs) || 0;
        const updatedAt = Math.max(meta.lastTs || 0, Number(stat.mtimeMs) || 0);
        return {
          session_id: sessionId,
          title: meta.title,
          preview: meta.preview,
          started_at: startedAt,
          updated_at: updatedAt,
          message_count: counts.count,
          user_message_count: counts.userCount,
          assistant_message_count: counts.assistantCount,
          background: meta.background,
          current: sessionId === this.lastSessionId,
        };
      } catch { return null; /* 单个坏文件不影响其余历史 */ }
    };
    // 先过滤后台会话再限量，避免大量定时任务挤掉真正可恢复的用户会话。
    for (const candidate of candidates) {
      const row = await inspectCandidate(candidate);
      if (row) rows.push(row);
      if (rows.length >= maxRows) break;
    }
    // 当前用户会话即使很久没活动，也必须能看到；后台会话仍然不例外放行。
    const currentCandidate = candidates.find((c) => c.sessionId === this.lastSessionId);
    if (currentCandidate && !inspected.has(currentCandidate.sessionId)) {
      const currentRow = await inspectCandidate(currentCandidate);
      if (currentRow) {
        if (rows.length >= maxRows) rows[rows.length - 1] = currentRow;
        else rows.push(currentRow);
      }
    }
    rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return rows.slice(0, maxRows);
  }

  /** Explicit user action: point this chat back at an existing Claude session. */
  async restoreClaudeSession(sessionId) {
    if (this.busy) return { ok: false, error: '当前对话仍在执行，请停止或等待完成后再恢复历史会话' };
    try {
      const { raw, stat } = await this._readClaudeSession(String(sessionId || ''), null);
      const parsed = parseClaudeSessionLog(raw, { sessionId, includeHistory: true });
      const restored = parsed.history.slice(-HISTORY_CAP);
      const restoredTurnCount = restored.length;
      this.history = restored;
      this.continueNext = false;
      this.lastSessionId = String(sessionId);
      // 恢复是用户明确要求的强制续接：先按当前通道尝试。若旧会话的 thinking
      // 签名确实不兼容，send() 会明确提示并带摘要重建，不会静默丢上下文。
      this.lastSessionEndpoint = this.tokenStore?.endpointFingerprint?.() || 'unknown';
      this._lastContextTokens = 0;
      const when = parsed.lastTs || Number(stat.mtimeMs) || Date.now();
      const note = {
        id: genTurnId(), role: 'assistant', ts: Date.now(), pending: false,
        content: `↩ 已恢复历史会话「${parsed.title}」（最后活动：${new Date(when).toLocaleString('zh-CN')}）。下一条消息会从这条 Claude 会话继续；若当前通道无法验证旧 thinking 签名，客户端会明确提示并带最近摘要重建。`,
        systemNote: true, noteKind: 'session-restored', noteSource: 'user',
      };
      this.history.push(note);
      await this._save();
      this.emit('reset', { restored: true, sessionId: this.lastSessionId });
      return { ok: true, session_id: this.lastSessionId, title: parsed.title, turns: restoredTurnCount };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async reset() {
    this.history = [];
    this.continueNext = false;
    this.lastSessionId = null;   // 「新会话」= 抛掉之前 Claude session id，下次 spawn 不带 --resume，让 Claude 起一条全新 thread
    this.lastSessionEndpoint = null;
    await this._save();
    this.emit('reset');
    return { ok: true };
  }

  // 0.2.4 起：用户在「新会话」对话框选「带摘要去新会话」时调这个。流程：
  //   1. 让 AI 把当前对话总结成 200~400 字 + 列出仍要保留的附件 / 中间文件
  //   2. 解析 AI 回复里的 <CARRYOVER_SUMMARY> 和 <CARRYOVER_KEEP>
  //   3. 落到 chat-carryover.json
  //   4. reset()
  // 下次 send() 起首会把摘要 prepend 到新 prompt 里（一次性 consumed），
  // 让 Claude 在新 session 里有上下文但又是一条全新的 thread。
  // 摘要里提到要保留的 .attachments/<draftId>/ 子目录会被 _gcChatScratch
  // 跳过，不会被 7 天 GC 误删。
  async requestCarryoverAndReset() {
    if (this.busy) {
      return { ok: false, error: '当前对话还在跑，请等它结束再点新会话' };
    }
    if (!this.history.length) {
      // 空对话直接 reset，没什么好摘要的
      await this.reset();
      return { ok: true, summary: '', kept_files: [], kept_drafts: [], skipped: 'empty_history' };
    }
    const summaryPrompt = [
      '【新会话切换准备 — 客户端代发，不是用户问的】我准备开新会话了，请你做两件事，**严格按下面格式输出**，不要做其他工作、不要调任何工具：',
      '',
      '1. 用 200~400 字总结当前对话：',
      '   - 我们在做什么（主题）',
      '   - 已经达成了什么（决策 / 完成项）',
      '   - 还在路上的（待办 / 未确认 / 卡点）',
      '   - 关键事实（EA 名 / 品种 / 周期 / 关键参数 / 重要文件路径）',
      '',
      '2. 列出本对话用过的**附件 / 中间文件**里，你判断「下一阶段还要继续看 / 引用」的，按 JSON 数组返回 workspace 相对路径。例：',
      '   `["strategies/GMarket.mq5", ".attachments/draft_abc/report.htm"]`',
      '   没有要保留的就返回 `[]`。**只列真实存在的、本对话里出现过的**，不要凭空编。',
      '',
      '**输出格式（严格，客户端要解析）**：',
      '```',
      '<CARRYOVER_SUMMARY>',
      '（这里写摘要正文）',
      '</CARRYOVER_SUMMARY>',
      '<CARRYOVER_KEEP>',
      '["相对路径1", "相对路径2"]',
      '</CARRYOVER_KEEP>',
      '```',
    ].join('\n');

    const r = await this.send(summaryPrompt, []);
    if (!r.ok) {
      return { ok: false, error: r.error || 'AI 摘要生成失败' };
    }
    const lastAssistant = [...this.history].reverse().find((t) => t.role === 'assistant');
    const reply = lastAssistant?.content || '';
    const summaryMatch = /<CARRYOVER_SUMMARY>([\s\S]*?)<\/CARRYOVER_SUMMARY>/.exec(reply);
    const keepMatch    = /<CARRYOVER_KEEP>\s*(\[[\s\S]*?\])\s*<\/CARRYOVER_KEEP>/.exec(reply);
    // 兜底：AI 没遵循格式时把整段 reply 当 summary 用（截 1500 字）
    const summary = summaryMatch ? summaryMatch[1].trim() : reply.trim().slice(0, 1500);
    let kept_files = [];
    if (keepMatch) {
      try { kept_files = JSON.parse(keepMatch[1]); } catch {}
    }
    if (!Array.isArray(kept_files)) kept_files = [];
    // 把 .attachments/<draftId>/... 的路径里 draftId 抠出来，给
    // _gcChatScratch 用作「这些 draft 子目录别 GC」白名单。
    const kept_drafts = [];
    for (const fp of kept_files) {
      const m = /^\.?[/\\]?\.attachments[/\\]([^/\\]+)/.exec(String(fp || ''));
      if (m) kept_drafts.push(m[1]);
    }
    const carryoverPath = path.join(path.dirname(this.dataPath), 'chat-carryover.json');
    await fs.writeFile(carryoverPath, JSON.stringify({
      summary,
      kept_files,
      kept_drafts: [...new Set(kept_drafts)],
      generated_at: Date.now(),
      consumed: false,
    }, null, 2), 'utf8');
    await this.reset();
    return {
      ok: true,
      summary,
      kept_files,
      kept_drafts: [...new Set(kept_drafts)],
    };
  }

  // 0.3.3 起：返回当前 Claude session 里 pending / in_progress 的 TodoWrite
  // 项。Claude Code 把每个 session 的 todos 存到
  // `~/.claude/todos/<sid>-agent-<sid>.json`，结构是数组 of {status, content,...}。
  // 用户在「新会话」对话框里要看到自己即将放弃的待办，作为「带摘要 vs 清除」
  // 的决策依据。lastSessionId 不存在（首次启动 / 刚 reset 过）→ 返 []。
  async getPendingTodos() {
    // 1.5.2: 复用 getTodos 的双存储兼容(新 tasks/ 目录 + 老 todos/ 文件),
    // 这里只保留原语义: 过滤出未完成项。
    const all = await this.getTodos();
    return all.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  }

  // 1.5.1: getPendingTodos 的全量版 —— 返回全部任务项(含 completed), 给 AI 栏常驻
  // 「任务进度」面板用: 让用户看到 X/Y 完成 + 每项勾选态。
  // getPendingTodos 保持只返 pending/in_progress 不动(新会话对话框那处语义不变)。
  // 1.5.2: 兼容两套存储 —— 新版 Claude Code 用 TaskCreate/TaskUpdate, 存
  // ~/.claude/tasks/<sid>/<id>.json(每任务一文件, subject/status/activeForm);
  // 老版 TodoWrite 存 ~/.claude/todos/<sid>-agent-<sid>.json(整表一文件)。
  // 新目录有内容就用它, 否则回退老文件(用户实测: AI 用 TaskCreate 记了 6 项,
  // 老路径读不到 → 面板永远不出现)。
  // 1.5.3: 加回 id 字段(之前特意剥掉) —— 手动标记完成/删除/编辑需要按 id 定位
  // 具体某一项写回。新版格式 id = 任务文件名去掉 .json(字符串数字); 老版数组
  // 没有原生 id, 用 `legacy:<数组下标>` 当合成 id, 写回时按下标 splice/替换。
  async getTodos() {
    if (!this.lastSessionId) return [];
    const os = require('node:os');
    const _ok = (s) => s === 'pending' || s === 'in_progress' || s === 'completed';
    // ── 新版: tasks/<sid>/ 目录 ──
    try {
      const dir = path.join(os.homedir(), '.claude', 'tasks', this.lastSessionId);
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
      if (files.length) {
        const out = [];
        for (const f of files) {
          try {
            const t = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
            if (!t || !_ok(t.status)) continue;
            out.push({
              _sort: parseInt(t.id, 10) || 0,
              id: String(t.id),
              status: t.status,
              content: String(t.subject || t.description || '').slice(0, 200),
              activeForm: String(t.activeForm || t.subject || '').slice(0, 200),
            });
          } catch { /* 单文件坏了跳过 */ }
        }
        if (out.length) {
          out.sort((a, b) => a._sort - b._sort);   // 按创建序显示
          return out.map(({ _sort, ...rest }) => rest);
        }
      }
    } catch { /* 目录不存在 → 走老路径 */ }
    // ── 老版: todos/<sid>-agent-<sid>.json ──
    try {
      const buf = await fs.readFile(path.join(
        os.homedir(), '.claude', 'todos',
        `${this.lastSessionId}-agent-${this.lastSessionId}.json`,
      ), 'utf8');
      const arr = JSON.parse(buf);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t && _ok(t.status))
        .map(({ t, i }) => ({
          id: `legacy:${i}`,
          status: t.status,
          content: String(t.content || '').slice(0, 200),
          activeForm: String(t.activeForm || '').slice(0, 200),
        }));
    } catch {
      return [];
    }
  }

  // ── 1.5.3: 任务面板手动增删改 —— 直接写回 Claude Code 自己的任务存储文件,
  // 让 AI 下次读 TaskList/TaskGet(或老版 TodoWrite 上下文)时能看到用户的手动修改,
  // 不是一份脱节的本地 UI 状态。写回目标由 id 的形状决定: 'legacy:<idx>' → 老版
  // 单文件数组; 纯数字字符串 → 新版 tasks/<sid>/<id>.json 单文件。
  // ⚠ 已知局限: 没有实现跨进程文件锁 —— 如果用户手动编辑的同时 AI 也正在用
  // TaskCreate/TaskUpdate 写同一目录, 理论上存在极小概率的竞态。低频手动操作
  // 场景下可接受, 不为此引入复杂的跨进程锁机制(过度设计)。
  async _legacyPath() {
    const os = require('node:os');
    return path.join(os.homedir(), '.claude', 'todos',
      `${this.lastSessionId}-agent-${this.lastSessionId}.json`);
  }

  async _tasksDir() {
    const os = require('node:os');
    return path.join(os.homedir(), '.claude', 'tasks', this.lastSessionId);
  }

  // 新增任务写去哪: 新版目录已存在(哪怕当前是空目录)就写新版, 否则老版文件
  // 存在就写老版; 都没有 → 默认新版(当前 CC 版本的存储方案), 顺手建目录。
  async _addTargetIsTasksDir() {
    try { await fs.stat(await this._tasksDir()); return true; } catch {}
    try { await fs.access(await this._legacyPath()); return false; } catch {}
    return true;
  }

  async addTodo(content) {
    if (!this.lastSessionId) return { ok: false, error: 'no_session' };
    const text = String(content || '').trim().slice(0, 200);
    if (!text) return { ok: false, error: 'empty' };
    if (await this._addTargetIsTasksDir()) {
      const dir = await this._tasksDir();
      await fs.mkdir(dir, { recursive: true });
      let files = [];
      try { files = await fs.readdir(dir); } catch {}
      const maxId = files.reduce((m, f) => {
        const n = parseInt(f.replace(/\.json$/, ''), 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0);
      const newId = String(maxId + 1);
      const task = {
        id: newId, subject: text, description: text, activeForm: text,
        status: 'pending', blocks: [], blockedBy: [],
      };
      await fs.writeFile(path.join(dir, `${newId}.json`), JSON.stringify(task, null, 2), 'utf8');
      return { ok: true, id: newId };
    }
    const legacyPath = await this._legacyPath();
    let arr = [];
    try {
      const parsed = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* 文件不存在/坏了 → 从空数组起 */ }
    arr.push({ status: 'pending', content: text, activeForm: text });
    await fs.writeFile(legacyPath, JSON.stringify(arr, null, 2), 'utf8');
    return { ok: true, id: `legacy:${arr.length - 1}` };
  }

  // 共用: 按 id 定位一项、跑 mutator(task, isLegacy) 改字段、写回原文件。
  async _mutateTodo(id, mutator) {
    if (!this.lastSessionId) return { ok: false, error: 'no_session' };
    const sid = String(id || '');
    if (sid.startsWith('legacy:')) {
      const idx = parseInt(sid.slice(7), 10);
      const legacyPath = await this._legacyPath();
      let arr;
      try { arr = JSON.parse(await fs.readFile(legacyPath, 'utf8')); }
      catch (e) { return { ok: false, error: 'read_fail: ' + (e?.message || e) }; }
      if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) {
        return { ok: false, error: 'not_found' };
      }
      mutator(arr[idx], true);
      await fs.writeFile(legacyPath, JSON.stringify(arr, null, 2), 'utf8');
      return { ok: true };
    }
    const dir = await this._tasksDir();
    const fp = path.join(dir, `${sid}.json`);
    let task;
    try { task = JSON.parse(await fs.readFile(fp, 'utf8')); }
    catch (e) { return { ok: false, error: 'read_fail: ' + (e?.message || e) }; }
    mutator(task, false);
    await fs.writeFile(fp, JSON.stringify(task, null, 2), 'utf8');
    return { ok: true };
  }

  async updateTodoStatus(id, status) {
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return { ok: false, error: 'bad_status' };
    }
    return this._mutateTodo(id, (task) => { task.status = status; });
  }

  async editTodoContent(id, content) {
    const text = String(content || '').trim().slice(0, 200);
    if (!text) return { ok: false, error: 'empty' };
    return this._mutateTodo(id, (task, isLegacy) => {
      if (isLegacy) task.content = text;
      else task.subject = text;
    });
  }

  async deleteTodo(id) {
    if (!this.lastSessionId) return { ok: false, error: 'no_session' };
    const sid = String(id || '');
    if (sid.startsWith('legacy:')) {
      const idx = parseInt(sid.slice(7), 10);
      const legacyPath = await this._legacyPath();
      let arr;
      try { arr = JSON.parse(await fs.readFile(legacyPath, 'utf8')); }
      catch (e) { return { ok: false, error: 'read_fail: ' + (e?.message || e) }; }
      if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) {
        return { ok: false, error: 'not_found' };
      }
      arr.splice(idx, 1);
      await fs.writeFile(legacyPath, JSON.stringify(arr, null, 2), 'utf8');
      return { ok: true };
    }
    const dir = await this._tasksDir();
    try { await fs.unlink(path.join(dir, `${sid}.json`)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  // Read+consume carryover prepend (single-use). Called from send()'s prompt
  // builder. When the user picked「带摘要去新会话」, the previous chat's
  // summary is prepended to the FIRST send after reset, then marked consumed
  // so it never repeats.
  async _takeCarryoverIfAny() {
    const carryoverPath = path.join(path.dirname(this.dataPath), 'chat-carryover.json');
    try {
      const buf = await fs.readFile(carryoverPath, 'utf8');
      const j = JSON.parse(buf);
      if (j.consumed) return '';
      j.consumed = true;
      try { await fs.writeFile(carryoverPath, JSON.stringify(j, null, 2), 'utf8'); } catch {}
      const filesLine = (j.kept_files && j.kept_files.length)
        ? '保留的关键文件（你可以 Read 这些路径继续工作）：' + j.kept_files.map((f) => '`' + f + '`').join('、')
        : '（上次对话没有需要保留的文件）';
      return [
        '【上一会话摘要 — 用户在新会话开篇时让我整理给你的，不是用户当前的提问】',
        (j.summary || '(空摘要)').trim(),
        '',
        filesLine,
        '',
        '（以上是新会话起点的上下文。下面是用户当前的新消息：）',
        '',
      ].join('\n');
    } catch { return ''; }
  }

  async send(message, attachments = [], opts = {}) {
    const trimmed = String(message || '').trim();
    if (!trimmed && (!attachments || !attachments.length)) {
      return { ok: false, error: 'empty message' };
    }

    // If a previous turn is still running, kill it and wait for cleanup.
    // Claude Code persists session JSONL as it goes, and --continue will
    // pick up whatever was flushed — so the in-progress turn becomes
    // historical context for THIS new message instead of being lost.
    if (this.busy) {
      this._userAborted = true;
      try { this.activeChild?.kill('SIGTERM'); } catch {}
      const hardKill = setTimeout(() => {
        try { this.activeChild?.kill('SIGKILL'); } catch {}
      }, 3000);
      const deadline = Date.now() + 8000;
      while (this.busy && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      clearTimeout(hardKill);
    }

    // Provider switching policy: only a switch back to the strict Claude
    // subscription proactively starts a new underlying session. Preserve a
    // bounded digest and tell the user exactly why; other switches optimistically
    // resume and fall back only if the upstream actually rejects a signature.
    let providerSwitchPrefix = '';
    let providerSwitchNotice = '';
    const currentEndpoint = this.tokenStore?.endpointFingerprint?.() || 'unknown';
    const resumeDecision = this.lastSessionId
      ? endpointResumeDecision(this.lastSessionEndpoint, currentEndpoint)
      : { resume: true, reason: 'no-session' };
    if (this.lastSessionId && !resumeDecision.resume) {
      const digest = this._buildCarryoverDigest();
      providerSwitchPrefix = digest
        ? `${PROVIDER_SWITCH_PREFIX}\n${digest}\n\n【用户当前消息】\n`
        : '';
      providerSwitchNotice =
        'ℹ 已切换到 Claude 订阅。Claude 会严格校验其他通道产生的 thinking 签名，因此已新建底层会话，并把最近对话摘要带入。原会话仍保留，可从「历史会话」恢复。';
      this.lastSessionId = null;
      this.lastSessionEndpoint = null;
      this._lastContextTokens = 0;
    }

    const userTurn = {
      id: genTurnId(),
      role: 'user',
      content: trimmed,
      attachments: (attachments || []).map((a) => ({
        name: a.name, relPath: a.relPath, kind: a.kind, size: a.size,
      })),
      ts: Date.now(),
    };
    this.history.push(userTurn);
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
    this.emit('append', userTurn);
    await this._save();

    if (providerSwitchNotice) {
      this.appendSystemNote(providerSwitchNotice, {
        kind: 'provider-session-transition', source: 'token-mode-switch',
      });
    }

    const assistantTurn = {
      id: genTurnId(),
      role: 'assistant',
      content: '',
      ts: Date.now(),
      pending: true,
    };
    // A scheduled task may need a remote target that is different from the
    // machine(s) the user has attached to this chat. Keep that binding scoped
    // to this one turn: it must neither alter the UI chips nor be persisted in
    // chat.json. A non-enumerable property survives all retry paths while being
    // omitted by JSON.stringify in _save().
    const hasRemoteOverride = !!opts
      && Object.prototype.hasOwnProperty.call(opts, 'remoteAttachments');
    const rawTurnAttachments = hasRemoteOverride
      ? (Array.isArray(opts.remoteAttachments) ? opts.remoteAttachments : [])
      : (this.remoteAttachments || []);
    const turnRemoteAttachments = [];
    const seenRemoteKeys = new Set();
    for (const raw of rawTurnAttachments) {
      const normalized = ChatSession._normAtt(raw);
      if (normalized && !seenRemoteKeys.has(normalized.clientKey)) {
        seenRemoteKeys.add(normalized.clientKey);
        turnRemoteAttachments.push(normalized);
      }
    }
    Object.defineProperty(assistantTurn, '_remoteRunContext', {
      value: {
        attachments: turnRemoteAttachments,
        forceQualifiedNames: !!opts?.forceQualifiedRemoteNames,
      },
      enumerable: false,
      configurable: true,
    });
    this.history.push(assistantTurn);
    this.emit('append', assistantTurn);

    this.busy = true;
    this.emit('busy', true);

    try {
      let liveCtx = '';
      if (this._contextProvider) {
        // firstTurn = 新会话未 resume(lastSessionId 空): 策略会话据此只在首轮注入重种子
        // (说明/参数), 之后轮只注入精简提醒 —— 否则每轮重注入大种子且随 --resume 累积,
        // 几轮就把上下文顶到软上限触发压缩(用户实测「没几条就会话满了」)。
        try { liveCtx = await this._contextProvider({ firstTurn: !this.lastSessionId }); } catch {}
      }
      // 附加了远程会话 → 每轮告诉 AI 有哪台被控机 + 授权档位。不放进大种子
      // (一行而已), 换/拆附加后下一轮提示即消失, 跟 --mcp-config 同步生效。
      // 1.5.x: 档位跟随通讯栏授权(read/manage/trade), 提示词同步说清能干什么。
      // 2026-08-08 多台附加: 逐台列出, 并**点明每台的工具前缀** —— 挂了多台时
      // MCP server 名字不同(remote / remote_<key>), AI 必须知道调哪一组才落到对的机器。
      const _remoteRunContext = assistantTurn._remoteRunContext || {};
      const _atts = Array.isArray(_remoteRunContext.attachments)
        ? _remoteRunContext.attachments : (this.remoteAttachments || []);
      const _forceQualifiedRemoteNames = !!_remoteRunContext.forceQualifiedNames;
      if (_atts.length) {
        const _desc = (sc) => (sc === 'trade'
          ? '交易授权 — 可查询、改参/挂载, 也可下单/平仓, 但任何交易动作前必须先向用户确认意图'
          : sc === 'manage'
            ? '管理授权 — 可查询, 也可改 EA 参数/挂载管理, 动手前先说明你要做什么'
            : '只读授权 — 仅查询');
        const _lines = _atts.map((a, i) => {
          const srv = ChatSession.remoteServerName(
            a.clientKey, i, _atts.length, _forceQualifiedRemoteNames,
          );
          return `  - ${a.clientKey}${a.note ? `(${a.note})` : ''} → 工具前缀 \`${srv}\`, ${_desc(a.scope || 'read')}`;
        }).join('\n');
        const _multi = _atts.length > 1;
        liveCtx = (liveCtx || '')
          + `\n<remote-attachment>本会话已附加 ${_atts.length} 台远程被控机:\n${_lines}\n`
          + '这些 remote MCP 工具(get_status/list_all_mt5_status/get_ea_realtime_stats/get_klines 等)'
          + '作用于**被控机**, 不是本机。'
          + (_multi
            ? '⚠ 挂了多台 —— 调工具前先确认用户指的是哪一台, **别把 A 的数据当成 B 的**; '
              + '需要对比时分别调各自前缀的工具再并列呈现。'
            : '用户问到该机器的持仓/策略/行情时直接调它们查询。')
          + '</remote-attachment>';
      }
      // Resume hint — when the previous turn was interrupted (kill / restart /
      // process crash mid-tool-call), `--continue` alone is not enough: Claude
      // resumes the JSONL session but doesn't necessarily realize it should
      // FINISH the prior partial work. Prepend a system note so it explicitly
      // checks state. We detect "previous interrupted" by:
      //   - There's a previous assistant turn flagged `interrupted: true`, AND
      //   - It's the most recent assistant turn before this new user msg
      let resumeHint = '';
      const prevAssistant = [...this.history].reverse()
        .find((t) => t.role === 'assistant' && t.id !== userTurn.id);
      if (prevAssistant?.interrupted) {
        resumeHint = (
          '【系统提示】上一轮因为中断（应用重启 / 你被 stop / 手动中断）没跑完。\n' +
          '先用 TodoRead 看看当时进行到哪一步、还剩什么；如果用户下面的新消息跟之前那任务相关，**接着完成**它；\n' +
          '如果新消息明显是另一个话题，正常切换即可。\n\n' +
          '用户新消息：\n'
        );
      }
      // 上一会话摘要（如果用户开新会话时选了「带摘要去新会话」），单次 consumed
      // 后下一轮就不再 prepend。注意：跑摘要请求自身的那一轮（特征是 prompt
      // 以 "【新会话切换准备" 起头）不能再 prepend 摘要，否则会自我引用。
      let carryoverPrefix = '';
      if (!trimmed.startsWith('【新会话切换准备')) {
        carryoverPrefix = await this._takeCarryoverIfAny();
      }
      // 中继(手机 App 转发)可传 opts.aiText: 发给 AI 的是带「来自手机 / 别调发送工具」包装的
      // prompt, 但上面 history 里记的 userTurn.content 仍是用户原话(trimmed) —— 电脑端 + 手机
      // 同步显示的都是干净原话, 不再把「用户从【易策随身】…」那条包装也当成一条用户消息显示。
      // (history 只是本地镜像; AI 的记忆来自这里 spawn 出去的 enriched, 不受 history.content 影响)
      const aiBody = (opts && typeof opts.aiText === 'string' && opts.aiText.trim()) ? opts.aiText : trimmed;
      let enriched = providerSwitchPrefix + resumeHint + carryoverPrefix
        + buildPromptWithAttachments(aiBody, attachments, liveCtx);
      assistantTurn.segments = [];

      // 1.2.30 主动压缩：fay 模式下代理的模型窗口比 Claude 小很多，上一轮真实
      // 上下文峰值已逼近软上限时，这一轮发送前先把历史压成摘要 + 新建会话，
      // 避免直接撞「context window exceeds limit (2013)」。用真实 usage 判断，
      // 不会误触发；摘要请求自身那一轮(以「【新会话切换准备」起头)不压缩。
      try {
        // 1.4.11: custom 模式(用户自己端点/系统环境变量配的小窗口模型, 如用户的
        // GLM-5.2)也要主动压缩 —— 之前只 fay 模式压缩, custom 模式完全裸奔, 上下文
        // 一大直接撞上游窗口报超限。custom 拿不到 context_window → 走 120k 兜底软上限。
        const _mode = this.tokenStore?.data?.mode;
        // Fay 的窗口配置只属于 Fay。切到 custom / codex 后不能沿用这个残留值，
        // 否则一个 1M 的 Fay 窗口会把 Codex Bridge 的 600K 字符保护线完全遮住。
        const _manualWindow = this.tokenStore?.data?.context?.mode === 'manual'
          ? Number(this.tokenStore.data.context.window_tokens) : 0;
        const _win = _mode === 'fay' ? this.tokenStore?.data?.fay?.context_window : null;
        const _codexChars = Math.min(
          _manualWindow > 0
            ? _manualWindow * CODEX_CONTEXT_CHARS_PER_TOKEN
            : CODEX_CONTEXT_CHARS_DEFAULT,
          CODEX_CONTEXT_CHARS_HARD_MAX,
        );
        // Codex's character transport cap wins over the global/manual token
        // value. For every other provider the user's manual token window keeps
        // its original semantics.
        const _softLimit = _mode === 'codex'
          ? Math.floor((_codexChars / CODEX_CONTEXT_CHARS_PER_TOKEN) * CODEX_CONTEXT_SOFT_FACTOR)
          : (_manualWindow > 0
            ? Math.floor(_manualWindow * CONTEXT_SOFT_FACTOR)
            : ((typeof _win === 'number' && _win > 0)
              ? Math.floor(_win * CONTEXT_SOFT_FACTOR)
              : FAY_CONTEXT_SOFT_LIMIT_FALLBACK));
        // 1.3.22: 定时任务(cron/scheduled-trigger)专项防护。这类任务反复注入主对话,
        // 把上下文越堆越大直到撞 (2013)(用户黄金波动预警/用户奇数单巡检实测)。
        // 问题: 主动压缩只看「上一轮真实 usage」_lastContextTokens, 而 cron 高频追加时
        // 它可能还没反映当前膨胀(或首轮就溢出)→ 漏判撞墙。
        // 修: cron 触发前**先按本地 history 估算当前上下文**(中文+工具JSON, ~2.2 char/token),
        // 逼近软上限就先压缩+新会话再跑, 不赌 _lastContextTokens。cron 任务多是自包含的
        // (查 MT5 报个数), 丢掉主对话历史无损。
        const _isCron = trimmed.startsWith('[scheduled-trigger:');
        let _estTokens = this._lastContextTokens || 0;
        if (_isCron) {
          try {
            let chars = 0;
            for (const t of (this.history || [])) chars += String(t?.content || '').length;
            _estTokens = Math.max(_estTokens, Math.floor(chars / 2.2));
          } catch {}
        }
        const _proactiveEnabled = _manualWindow > 0
          ? ['system', 'fay', 'custom', 'codex'].includes(_mode)
          : (_mode === 'fay' || _mode === 'custom' || _mode === 'codex');
        if (_proactiveEnabled
            && this.lastSessionId
            && _estTokens > _softLimit
            && !trimmed.startsWith('【新会话切换准备')) {
          const _windowLabel = _mode === 'codex'
            ? `codex:${_codexChars}chars`
            : (_manualWindow > 0 ? `manual:${_manualWindow}` : (_win || 'default'));
          console.warn(`[chat] proactive compaction: est≈${_estTokens} (lastCtx=${this._lastContextTokens}, cron=${_isCron}) > soft limit ${_softLimit} (window=${_windowLabel})`);
          const digest = this._buildCarryoverDigest([assistantTurn.id, userTurn.id]);
          this.lastSessionId = null;
          this.lastSessionEndpoint = null;
          this._lastContextTokens = 0;
          const prefix = digest ? `${CTX_COMPACT_PREFIX}\n${digest}\n\n【用户当前消息】\n` : '';
          enriched = prefix + buildPromptWithAttachments(aiBody, attachments, liveCtx);
          this.appendSystemNote(
            '💡 对话较长，已自动把之前的内容压缩成摘要并新建会话，以保持流畅、避免超出模型上下文上限。',
            { kind: 'context-compacted', source: 'auto-proactive' },
          );
        }
      } catch (e) { console.warn('[chat] proactive compaction check failed:', e?.message || e); }

      let finalText;
      try {
        finalText = await this._runClaude(enriched, assistantTurn);
        // Claude Code 偶尔把上游 API 失败包装成 subtype=success 的最终文本。
        // 这时 _runClaude 不会 reject；在这里把明确的上下文错误重新送进同一套
        // 摘要 + 新会话 + 重试流程，覆盖 WaitForMcpServers 后的二次请求场景。
        if (/^\s*API Error:/i.test(String(finalText || ''))
            && _CTX_OVERFLOW_RE.test(String(finalText || ''))) {
          throw new Error(String(finalText));
        }
      } catch (firstErr) {
        // thinking signature 真不兼容时才新建：明确告知用户，并带最近摘要重试。
        const errMsg = String(firstErr?.message || '');
        const isThinkingSigError = /Invalid.*signature.*thinking|thinking.*Invalid.*signature/i.test(errMsg);
        // 0.4.0: 抓 429 / rate_limit / channel 故障 → 重新 issue fay token
        // （服务端 Phase 1+5 自动绕开挂掉的 channel 给个健康的）+ 重试一次
        // 0.3.22: 加 `exit 1 (no stderr)` 模式 — Claude Code SDK 撞到上游 429
        // 时 spawn 进程退 1 但不写 stderr（429 response 被 SDK 内部消化），
        // 错误文本就是字面 `exit 1: (no stderr)`。之前正则不认这种 case →
        // retry 不触发 → 用户永远卡在挂掉的 channel 上（即使 server 已 cooldown
        // 该 channel + 重新 issue 能拿到健康 channel）。
        // 实测用户 0.3.21 撞这个 bug：fay 模式 / GLM-5.1 / 全部命中 ch4 的
        // 5h cooldown 但没 fail-over 到 ch5。
        // 0.3.49: 同 claude-runner._CHANNEL_ERR_RE — `exit(?:ed)?` 同时认现在式
        // (chat-session 自己抛的「exit 1: (no stderr)」) + 过去式（headless 路径
        // 透传上来的「claude exited 1: (no stderr)」）。exit code 也放宽到 \d+。
        const isChannelError = /\b429\b|rate_limit|too many requests|channel_quota|upstream_unreachable|API Error: 50[0-9]|exit(?:ed)?\s+\d+.*\(no stderr\)/i.test(errMsg);
        // 1.2.30: 「上下文超出模型窗口」必须在 channel 分支之前判定 —— 它不是
        // 通道故障，切模型 / 重 issue 都没用(各家模型窗口一样大，照样撞墙)。
        // 唯一的解是压小上下文：用本地 history 拼机械摘要(不 resume 超大 session
        // 避免二次溢出)+ 新建会话，带摘要把这条消息重试一次。压缩后仍失败(摘要
        // 本身就超 / 单条消息+附件就超窗)才抛 friendly「对话太长」。
        const isContextOverflow = _CTX_OVERFLOW_RE.test(errMsg);
        if (isThinkingSigError && this.lastSessionId) {
          console.warn('[chat] thinking signature mismatch detected, carrying context into a fresh session');
          finalText = await this._compactAndRetry({
            assistantTurn, aiBody, attachments, liveCtx,
            excludeTurnIds: [assistantTurn.id, userTurn.id],
            note: '⚠ 当前通道无法验证上一通道的 thinking 签名，已新建底层会话并把最近对话摘要带入。原会话仍保留，可从「历史会话」恢复。',
            noteSource: 'thinking-signature-mismatch',
          });
        } else if (isContextOverflow) {
          console.warn('[chat] context window exceeded — compacting to fresh session + retry (switching model would not help, same window)');
          finalText = await this._compactAndRetry({
            assistantTurn, aiBody, attachments, liveCtx,
            excludeTurnIds: [assistantTurn.id, userTurn.id],
            note: '⚠ 对话太长，已超出当前模型的上下文上限。已自动把之前的对话压缩成摘要、新建会话继续（切换模型解决不了，因为各模型窗口都差不多大）。如需完全干净的上下文，可点「新会话」。',
          });
          // _compactAndRetry 若再抛(摘要仍超窗) → 落到外层 catch，由
          // _classifyChatError 命中 _CTX_OVERFLOW_RE 给「对话太长」友好提示。
        } else if (isChannelError && this._tokenReissuer && this.tokenStore?.data?.mode === 'fay') {
          // 0.3.44: 两层 fail-over
          //   ① same-model reissue（覆盖单 channel 死，server 端 _record_channel_failure
          //      已经 cooldown 那条，重 issue 同款 model 会拿到健康 channel）
          //   ② cross-model fallback（覆盖 same-model 的所有 channel 都死的极端
          //      case —— 用户撞过：所选 DeepSeek 通道全 500，server-side
          //      proxy() 也撑不住）。fallback 拉模型列表挑一个不同的 issue，
          //      并在用户那里 appendSystemNote 一条「由 X 切到 Y」让 UI 有反馈。
          // 第二层失败才抛复合错误（最多三段：原始 + same-model 重试 + fallback 重试）
          //
          // 0.3.96 重大修：之前 reissue / fallback 后都把 lastSessionId / lastSessionEndpoint
          // 清空，下次 spawn 就没 --resume，整段对话历史从 AI 视角看就 「memory 是空的」。
          // 作者 5/17 反馈 + 模拟盘 / 用户反映「模型多次中断后 memory 掉失」根因就是这。
          // 修：reissue / fallback 时**不再清 sid** — 让重试也用 --resume 接着原 session 跑。
          // claude-code 的 session JSONL 跟 model 无关（只是对话历史），换 model 仍能 resume。
          const curModel = this.tokenStore.data.fay?.cached_model || null;
          console.warn('[chat] channel error detected (', errMsg.slice(0, 120), '), reissuing fay token + retry');
          let sameModelErr = null;
          try {
            await this._tokenReissuer({ model: curModel });
            // 不清 lastSessionId — 让重试 resume 已有 session
            assistantTurn.segments = [];
            finalText = await this._runClaude(enriched, assistantTurn);
          } catch (e2) {
            sameModelErr = e2;
            // 第 2 次失败如果还是 channel error（说明同款 model 的所有
            // channel 都挂了）→ 退到不同 model 再试一次。如果不是 channel
            // error（比如 SDK bug / API 协议错），就别再换 model 了，直接抛。
            const e2Msg = String(e2?.message || e2 || '');
            // 1.2.30: 真通道错先发，reissue 重试时撞上下文超窗(同款 model 历史太长)
            // → 别再跨模型 fallback(没用)，直接压缩 + 带摘要重试。
            if (_CTX_OVERFLOW_RE.test(e2Msg)) {
              console.warn('[chat] reissue retry hit context overflow — compacting instead of cross-model fallback');
              finalText = await this._compactAndRetry({
                assistantTurn, aiBody, attachments, liveCtx,
                excludeTurnIds: [assistantTurn.id, userTurn.id],
                note: '⚠ 对话太长，已超出当前模型的上下文上限。已自动把之前的对话压缩成摘要、新建会话继续（切换模型解决不了，因为各模型窗口都差不多大）。如需完全干净的上下文，可点「新会话」。',
              });
              // finalText 已 set → 不抛、不再 fallback，落到下方共享收尾逻辑。
            } else {
            const e2IsChan = /\b429\b|rate_limit|too many requests|channel_quota|upstream_unreachable|API Error: 50[0-9]|exit(?:ed)?\s+\d+.*\(no stderr\)/i.test(e2Msg);
            if (!e2IsChan) {
              const composite = new Error(
                `${firstErr.message}\n\n[第 1 次失败上面] [reissue 后第 2 次失败 → ${e2Msg.slice(0, 300)}]`
              );
              composite._composite = true;
              composite._first = firstErr;
              composite._second = e2;
              throw composite;
            }
            console.warn('[chat] same-model reissue still failed; trying cross-model fallback');
            try {
              const fb = await this._tokenReissuer({ tryFallback: true });
              const newModel = fb?.model || '(?)';
              this.appendSystemNote(
                `⚠ ${curModel || '当前模型'} 暂时不可用（连续 ${e2IsChan ? 2 : 1} 次失败），已自动切换到 **${newModel}** 继续。如需切回，去 Token tab 重选。`,
                { kind: 'channel-fallback', source: 'auto' },
              );
              // 0.3.96: 同样不清 sid，model 换了 session 仍能 resume，memory 不丢
              assistantTurn.segments = [];
              finalText = await this._runClaude(enriched, assistantTurn);
            } catch (e3) {
              const e3Msg = String(e3?.message || e3 || '?');
              console.warn('[chat] cross-model fallback also failed:', e3Msg);
              const composite = new Error(
                `${firstErr.message}\n\n` +
                `[第 1 次失败上面] [same-model reissue 重试 → ${e2Msg.slice(0, 200)}] ` +
                `[fallback 到其他模型重试 → ${e3Msg.slice(0, 200)}]`
              );
              composite._composite = true;
              composite._first = firstErr;
              composite._second = sameModelErr;
              composite._third = e3;
              throw composite;
            }
            }
          }
        } else {
          throw firstErr;
        }
      }
      const responseText = finalText || assistantTurn.segments
        .filter((s) => s.kind === 'text')
        .map((s) => s.text)
        .join('');
      if (!String(responseText || '').trim()) {
        throw new Error('AI engine completed successfully but produced no final text response');
      }
      assistantTurn.content = responseText;
      assistantTurn.pending = false;
      this.continueNext = true;
      this.emit('update', assistantTurn);
      await this._save();
      return { ok: true, content: assistantTurn.content };
    } catch (e) {
      const wasAborted = this._userAborted || /killed|SIGTERM|SIGKILL/i.test(String(e.message || ''));
      this._userAborted = false;
      if (wasAborted) {
        // User-initiated stop (explicit 停止 button OR a new send while busy
        // OR panic 全停 OR session-replaced by 新 send).
        // Preserve whatever segments streamed so far; just append a marker.
        if (!Array.isArray(assistantTurn.segments)) assistantTurn.segments = [];
        // 0.3.167: 三种模式分别给不同结尾文案 ——
        //   panic 全停 → 完全不 push 任何文字 (用户反馈「全停时不需要提醒」)
        //   普通停止  → "_（已停止）_" (不再承诺 "等待 1 分钟恢复" — 0.3.152
        //                后没有真的冷却时间, 老文案误导用户)
        const isPanic = !!this._panicStopping;
        this._panicStopping = false;
        if (!isPanic) {
          assistantTurn.segments.push({ kind: 'text', text: '\n\n_（已停止）_' });
        }
        assistantTurn.content = assistantTurn.segments
          .filter((s) => s.kind === 'text')
          .map((s) => s.text)
          .join('') || (isPanic ? '(已停止)' : '(已中断)');
        assistantTurn.pending = false;
        assistantTurn.interrupted = true;
        // panic 模式 → continueNext=false, 不让 sys_chat_resume / send() resumeHint 自动续这条 turn.
        // 普通停止 → continueNext=true, 用户下次发消息时自动续上 (功能, 不是 bug).
        this.continueNext = !isPanic;
        if (isPanic) {
          // 标 dismissed 让 chat-resume ticker 也跳过这条 (跟 dismissInterruptedTurn 一致)
          assistantTurn.resume_attempted = true;
          assistantTurn.dismissed_at_ts = Date.now();
          assistantTurn.dismissed_reason = 'panic_stop_all';
        }
        this.emit('update', assistantTurn);
        await this._save();
        return { ok: false, interrupted: true };
      }
      // 检查是否是 token / 通道相关的错误，给用户更可操作的提示。
      const friendly = _classifyChatError(e.message);
      if (friendly) {
        assistantTurn.content = `⚠️ ${friendly.title}\n\n${friendly.body}\n\n_原始错误：${e.message.slice(0, 200)}_`;
      } else {
        assistantTurn.content = `⚠️ 调用 Claude Code 失败：${e.message}`;
      }
      assistantTurn.error = true;
      assistantTurn.pending = false;
      this.emit('update', assistantTurn);
      await this._save();
      return { ok: false, error: e.message };
    } finally {
      this.busy = false;
      this.emit('busy', false);
      this.activeChild = null;
    }
  }

  /**
   * Push a non-Claude assistant message into the chat history (and emit
   * 'append' so the renderer shows it). Used by background callers like
   * the scheduler runner to deliver a finished-backtest notification when
   * the user is mid-conversation or doesn't have the chat tab open.
   *
   * Doesn't touch `busy` / `continueNext` — this is an out-of-band message,
   * NOT a turn that resumes Claude's session.
   *
   * @param {string} text       — markdown body
   * @param {object} [meta]     — optional { kind, source } stored on the turn
   */
  appendSystemNote(text, meta = {}) {
    const turn = {
      id: genTurnId(),
      role: 'assistant',
      content: String(text || ''),
      ts: Date.now(),
      pending: false,
      systemNote: true,
      noteKind: meta.kind || 'background',
      noteSource: meta.source || null,
      noteData: meta.data || null,     // 交互卡片附加数据(如绑定授权的 reqId / phone)
    };
    this.history.push(turn);
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
    this.emit('append', turn);
    // Best-effort persist; don't await so we don't block the caller.
    this._save().catch(() => {});
    return turn;
  }

  // 0.3.167: 加 opts.panic — 全停场景下 catch 块不再 push 「已经被中断, 等待 1 分钟恢复」
  // segment, 用户反馈「点全停时无需中断提醒, 更不需 1 分钟恢复」.
  async stop(opts = {}) {
    if (!this.activeChild) return { ok: false, error: 'not running' };
    this._userAborted = true;
    if (opts.panic) this._panicStopping = true;
    try { this.activeChild.kill('SIGTERM'); } catch {}
    const hardKill = setTimeout(() => {
      try { this.activeChild?.kill('SIGKILL'); } catch {}
    }, 3000);
    // Wait for the in-flight send() to finish its cleanup (busy → false).
    const deadline = Date.now() + 8000;
    while (this.busy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    clearTimeout(hardKill);
    return { ok: true };
  }

  // ---------- internal ----------

  // 1.2.30: 从本地 history(user/assistant 对话文本，体量小、不含已撑爆窗口的
  // 工具输出)拼一份机械摘要。用于「上下文超窗」时——此时已经无法 resume 那条
  // 超大 session 让 AI 来总结(会二次溢出)，只能用本地镜像里的对话原文兜底。
  _buildCarryoverDigest(excludeTurnIds) {
    try {
      const excluded = new Set(Array.isArray(excludeTurnIds)
        ? excludeTurnIds.filter(Boolean)
        : (excludeTurnIds ? [excludeTurnIds] : []));
      const turns = this.history.filter((t) =>
        (t.role === 'user' || t.role === 'assistant')
        && !t.systemNote
        && !excluded.has(t.id)
        && t.content && String(t.content).trim());
      const recent = turns.slice(-14);
      const lines = [];
      for (const t of recent) {
        const who = t.role === 'user' ? '用户' : 'AI';
        let txt = String(t.content).replace(/\s+/g, ' ').trim();
        if (txt.length > 500) txt = txt.slice(0, 500) + '…';
        if (txt) lines.push(`${who}：${txt}`);
      }
      let digest = lines.join('\n');
      if (digest.length > 5000) digest = '…' + digest.slice(-5000);
      return digest;
    } catch { return ''; }
  }

  // 1.2.30: 把当前对话压缩成摘要 + 抛掉旧 Claude session(下次 spawn 无 --resume
  // = 全新空上下文)，带摘要重试用户「这一条」消息。供两处复用：
  //   ① 反应式：catch 里检测到上下文超窗(切模型没用)→ 自愈
  //   ② 主动式：send() 发送前发现上一轮上下文已逼近软上限 → 提前压缩
  // 注意不能调 this.send()(busy 守卫 + 会多记一条 user turn)，直接走 _runClaude。
  async _compactAndRetry({ assistantTurn, aiBody, attachments, liveCtx, note, noteSource,
                           excludeTurnIds }) {
    const digest = this._buildCarryoverDigest(excludeTurnIds || assistantTurn.id);
    this.lastSessionId = null;
    this.lastSessionEndpoint = null;
    this._lastContextTokens = 0;
    if (note) {
      this.appendSystemNote(note, { kind: 'context-compacted', source: noteSource || 'auto' });
    }
    const prefix = digest ? `${CTX_COMPACT_PREFIX}\n${digest}\n\n【用户当前消息】\n` : '';
    const retryPrompt = prefix + buildPromptWithAttachments(aiBody, attachments, liveCtx);
    assistantTurn.segments = [];
    return await this._runClaude(retryPrompt, assistantTurn);
  }

  // Run claude in stream-json mode so we get tool calls, thinking blocks
  // and partial text in real time. The agent's final answer (resolved when
  // the `result` event arrives) is returned via the promise.
  /**
   * 检查最近一个 assistant turn 是否被中断、且还没尝试过自动恢复。
   * 用于 sys_chat_resume 每分钟系统任务 — 用户中断对话 / 应用崩溃 / chat
   * session 被新消息 kill 后留下「_(已经被中断，等待 1 分钟恢复)_」气泡，
   * 之前必须等用户主动再发一条才会被 send() 里的 resumeHint 接续。
   * 现在系统任务自动接续，1 分钟内 resume，不用等用户。
   *
   * 防止无限重试：每条 interrupted turn 只 auto-resume 一次（resume_attempted
   * 落到该 turn 上）。用户可以手动发新消息绕过 — 那条会清掉 interrupted
   * 标记重新跑。
   */
  async tryAutoResume() {
    if (this.busy) return { skipped: 'busy' };
    const last = [...this.history].reverse().find((t) => t.role === 'assistant');
    if (!last) return { skipped: 'no_assistant_turn' };
    if (!last.interrupted) return { skipped: 'not_interrupted' };
    if (last.resume_attempted) return { skipped: 'already_attempted' };
    last.resume_attempted = true;
    await this._save();
    // 走正常 send 路径 — 它内部检测到 prevAssistant.interrupted 会自动
    // prepend resume hint，加 --continue 拿历史 session 接着跑。
    return this.send('[系统自动恢复] 继续上次被中断的任务（先用 TodoRead 看进度，再接着完成）');
  }

  /**
   * 0.3.152: panic 用 — 把最后一条 interrupted assistant turn 标 dismissed,
   * tryAutoResume 之后跳过这条不再续上 (用户主动放弃, 不希望系统自动恢复).
   * 返 {ok, dismissed_turn_uuid?, skipped?}.
   */
  async dismissInterruptedTurn(reason = 'panic_stop_all') {
    const last = [...this.history].reverse().find((t) => t.role === 'assistant');
    if (!last) return { ok: true, skipped: 'no_assistant_turn' };
    if (!last.interrupted) return { ok: true, skipped: 'not_interrupted' };
    if (last.resume_attempted) return { ok: true, skipped: 'already_attempted' };
    last.resume_attempted = true;     // 跟 tryAutoResume 用同 flag → 永远跳过
    last.dismissed_at_ts = Date.now();
    last.dismissed_reason = reason;
    // 0.3.163: panic 全停后不再自动恢复 — 用户反馈「点了全停就不应该做这个提醒了」。
    // 把之前 catch 块加的「_（已经被中断，等待 1 分钟恢复）_」气泡换成「_（已停止）_」，
    // 避免误导用户以为系统会自己恢复。
    if (Array.isArray(last.segments)) {
      const idx = last.segments.findIndex(
        (s) => s && s.kind === 'text' && typeof s.text === 'string' && s.text.includes('已经被中断')
      );
      if (idx >= 0) {
        last.segments[idx] = { kind: 'text', text: '\n\n_（已停止）_' };
        last.content = last.segments
          .filter((s) => s.kind === 'text')
          .map((s) => s.text)
          .join('') || '(已停止)';
      }
    }
    this.continueNext = false;       // 同步关掉 resumeHint 触发条件，双保险
    this.emit('update', last);
    await this._save();
    return { ok: true, dismissed_turn_uuid: last.uuid || last.id || null };
  }

  /**
   * 暖一次 Claude 会话 — 启动时 fire-and-forget 跑一个很小的 prompt，
   * 让 `claude --print --continue` 完成 session JSONL load / MCP 子进程
   * 拉起 / 凭据握手 等冷启动事项，**不进 history、不 emit 到 UI**。
   *
   * 用户场景：升完级 / 重启 EasyDeal 后第一条消息走微信，会被「session
   * 还没暖」拖住 → 用户感觉「微信没反应，但客户端 AI 能回」。提前热好
   * 这条路径解决问题。代价：一次 claude --print 额外 spawn（~5-10s），
   * 不影响 UI / token 消耗微乎其微（prompt < 20 字符）。
   */
  async warmup({ timeoutMs = 30_000 } = {}) {
    if (this._warmedUp) return { ok: true, skipped: true };
    if (this.busy) return { ok: false, reason: 'busy' };
    // Codex bridge 每次请求都会启动一次真实的 `codex exec`。Claude warmup
    // 会提前取消外层进程，却无法把已经提交给 bridge 的模型调用变成缓存，
    // 反而造成一条无用请求与用户正式请求并发，必须跳过。
    if (this.tokenStore?.getMasked?.().mode === 'codex') {
      this._warmedUp = true;
      console.log('[chat-warmup] skipped for codex cli mode');
      return { ok: true, skipped: 'codex-cli' };
    }
    this._warmedUp = true;
    // 0.3.244: 提前 resolve tokenOverride.env — 因为 OpenAI 兼容代理 placeholder
    // 替换是 async, 必须在 spawn 前 await 完
    const _bin0 = resolveClaudeBin();
    const tokenOverride = this.tokenStore ? this.tokenStore.spawnEnvOverrides() : { env: {} };
    if (this.tokenStore && String(tokenOverride.env?.ANTHROPIC_BASE_URL || '').startsWith('__EASYDEAL_')) {
      try { await this.tokenStore.ensureLocalBridgeAndReplace(tokenOverride.env); }
      catch (e) {
        console.warn('[chat-warmup] 本地 AI 桥接启动失败:', e?.message || e);
        return { ok: false, error: e?.message || String(e) };
      }
    }
    const warmupBaseEnv = { ...process.env };
    for (const key of (this.tokenStore?.envKeysToStripBeforeSpawn?.() || [])) {
      delete warmupBaseEnv[key];
    }
    return new Promise((resolve) => {
      const bin = _bin0;
      // 故意不传 --continue：让 warmup 走最纯净的「新建一次性 session」
      // 路径，避免历史 session 不兼容时反而把 warmup 自己搞崩。
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        'ok',
      ];
      const isJs = bin.endsWith('.js');
      const useShell = /\.(cmd|bat)$/i.test(bin);
      const spawnArgs = withClaudeModelArg(args, tokenOverride.env);
      const child = spawn(
        isJs ? process.execPath : bin,
        isJs ? [bin, ...spawnArgs] : spawnArgs,
        {
          cwd: this.workspaceDir,
          env: {
            ...warmupBaseEnv,
            ...(isJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            ...(tokenOverride.env || {}),
            // 0.3.5: 来源标记 —— 让 MCP 知道这次 spawn 是为电脑端 AI 对话
            // 服务的，回测 cron 的 notify_json 设成 ["chat"]，不会乱推到微信
            EASYDEAL_NOTIFY_DEFAULT: 'chat',
          },
          shell: useShell,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let killed = false;
      const t = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        const ok = !killed && (code === 0 || code === null);
        console.log(`[chat-warmup] claude exited code=${code} (${ok ? 'ok' : 'fail'})`);
        resolve({ ok, code, killed });
      });
      child.on('error', (e) => {
        clearTimeout(t);
        console.warn('[chat-warmup] spawn error:', e.message);
        resolve({ ok: false, error: e.message });
      });
      // 排空 stdio 避免 pipe 满死锁
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
    });
  }

  _runClaude(message, assistantTurn) {
    return new Promise((resolve, reject) => {
      // 0.3.244: async IIFE 让 ensureOpenaiProxyAndReplace 能 await
      (async () => {
      const bin = resolveClaudeBin();
      // --output-format stream-json requires --verbose per Claude Code docs.
      // --dangerously-skip-permissions bypasses ALL tool permission checks
      //   (built-in Read/Write/Edit/Bash/etc. AND every MCP tool). The user
      //   has explicitly opted into this for the desktop chat experience —
      //   they don't want to approve every single action.
      // 0.3.49: defense-in-depth — Node `spawn` 收到含 `\0` 的 arg 直接 reject
      // 「The argument 'args[5]' must be a string without null bytes」。这种情况
      // 通常源头是 prompt 拼装时不小心把二进制当文本读了（用户 撞过：
      // .ex5-only 策略的 doc_path 被错算成 .ex5 文件，utf8 读出来全是 \0）。
      // 那条根因已经在 strategies.js 修了，但这里再加一道保险：spawn 前把
      // `\0` 替成空。代价微小，避免任何漏网之鱼让用户看到 spawn 异常报错。
      const sanitizedMessage = String(message || '').replace(/ /g, '');
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        sanitizedMessage,
      ];
      // 附加远程会话: spawn 前现生成 per-session remote mcp-config(带最新 token,
      // 不吃 .mcp.json env 快照 stale 的亏), --mcp-config 与 workspace 自身的
      // .mcp.json 合并加载。拿不到(未登录/未配置)就本轮不带, 不影响主流程。
      // ⚠ 必须用 `--mcp-config=<path>` 等号内联形式: CLI 里该选项是可变参数
      // (--mcp-config <configs...>), 空格分隔形式会把后面的 prompt 一并吞成
      // 第二个配置路径 → "MCP config file not found: ...<live-workspace-state>"
      // (用户 1.4.4 实测踩坑)。等号形式只吃一个值, prompt 保持位置参数。
      const remoteRunContext = assistantTurn?._remoteRunContext || null;
      const remoteRunAttachments = Array.isArray(remoteRunContext?.attachments)
        ? remoteRunContext.attachments : (this.remoteAttachments || []);
      if (remoteRunAttachments.length && this._remoteMcpProvider) {
        try {
          // The provider only needs these fields. Supplying a turn-scoped view
          // prevents a scheduler run from mutating/persisting the user's own
          // remote attachments.
          const providerSession = remoteRunContext ? {
            sessionKey: this.sessionKey,
            remoteAttachment: remoteRunAttachments[0] || null,
            getRemoteAttachments: () => remoteRunAttachments.slice(),
            _forceQualifiedRemoteNames: !!remoteRunContext.forceQualifiedNames,
          } : this;
          const mcpPath = await this._remoteMcpProvider(providerSession);
          if (mcpPath) args.splice(args.length - 1, 0, `--mcp-config=${mcpPath}`);
        } catch (e) { console.warn('[chat] remote mcp-config 生成失败(本轮不带远程工具):', e?.message || e); }
      }
      // 0.2.6: 用 --resume <id> 取代 --continue（见 constructor 里 lastSessionId
      // 注释解释为什么）。没记 id（首次 / reset 后）就不传，让 Claude 起新
      // session，下面 stream 解析的第一条事件里就能拿到 sessionId。
      // endpoint policy: 切回 Claude 订阅时主动新建（send() 已提示并带摘要）；
      // 其他切换先尝试续接，真实签名不兼容再由错误分支带摘要重建。
      const _currentEndpoint = this.tokenStore?.endpointFingerprint?.() || 'unknown';
      const _canResume = this.lastSessionId
        && this.lastSessionEndpoint
        && canResumeEndpoint(this.lastSessionEndpoint, _currentEndpoint);
      if (this.lastSessionId && !_canResume) {
        // endpoint 变了 — 抛掉旧 sid，让 Claude 起新 session。
        // 不删 lastSessionId 字段（先保留 in-memory），spawn 完拿到新 sid 会
        // 覆盖；万一 spawn 报错（403 等）老 sid 跟着 endpoint 留个 fallback。
        // 但 args 里不传 --resume。
      } else if (this.lastSessionId) {
        args.unshift('--resume', this.lastSessionId);
      }
      // 把当前 endpoint 缓存到本次 spawn 的 closure，下面错误处理 / 成功落
      // 库时一起用。
      this._spawnEndpoint = _currentEndpoint;

      const isJs = bin.endsWith('.js');
      // Token-mode env override — see token-store.js. Empty for system mode;
      // ANTHROPIC_BASE_URL/MODEL/AUTH_TOKEN for custom + fay modes.
      const tokenOverride = this.tokenStore ? this.tokenStore.spawnEnvOverrides() : { env: {} };
      if (tokenOverride.warning) {
        console.warn('[chat] token-mode warning:', tokenOverride.warning);
      }
      // Pre-flight: if token mode (fay/custom) is missing required creds,
      // spawning would silently fall back to system mode and either work
      // (rare) or `claude exited 1 (no stderr)` (common). Better to abort
      // here with a friendly explanation than ship a doomed spawn.
      const tokenIssue = classifyTokenSpawnIssue(tokenOverride);
      if (tokenIssue) {
        return reject(new Error(
          FRIENDLY_ERR_MARKER + JSON.stringify(tokenIssue)
        ));
      }
      // 0.3.244: OpenAI 兼容代理 placeholder 替换. 这步必须在 spawn 前.
      if (this.tokenStore && String(tokenOverride.env?.ANTHROPIC_BASE_URL || '').startsWith('__EASYDEAL_')) {
        try { await this.tokenStore.ensureLocalBridgeAndReplace(tokenOverride.env); }
        catch (e) {
          return reject(new Error(
            FRIENDLY_ERR_MARKER + JSON.stringify({
              title: tokenOverride.mode === 'codex' ? 'Codex CLI 启动失败' : 'OpenAI 兼容代理启动失败',
              body: tokenOverride.mode === 'codex'
                ? `${e?.message || e}。请先在终端运行 codex login，然后到 Token 页点“检测 Codex CLI”。`
                : `检查 Token tab 的 base_url / api_key / model: ${e?.message || e}`,
            })
          ));
        }
      }
      // Only use shell:true for .cmd / .bat shims (npm-generated). Native
      // .exe runs directly — wrapping in cmd.exe just opens us up to arg
      // quoting issues like "命令语法不正确" on zh-CN Windows.
      const useShell = /\.(cmd|bat)$/i.test(bin);
      // 0.3.52: custom / fay 模式下剥掉 OS env 里的 ANTHROPIC_*，避免 OS
      // 环境变量 hijack 用户在客户端配的 token-mode 设置（用户报：custom
      // 模式只填了 api_key 没填 base_url，OS 设了 ANTHROPIC_BASE_URL →
      // 实际 spawn 时 Claude 拿到 OS 的 base_url + 用户的 api_key 杂交）。
      const stripKeys = this.tokenStore
        ? this.tokenStore.envKeysToStripBeforeSpawn()
        : [];
      const baseEnv = { ...process.env };
      for (const k of stripKeys) delete baseEnv[k];
      const spawnArgs = withClaudeModelArg(args, tokenOverride.env);
      const child = spawn(
        isJs ? process.execPath : bin,
        isJs ? [bin, ...spawnArgs] : spawnArgs,
        {
          cwd: this.workspaceDir,
          env: {
            ...baseEnv,
            // CRITICAL: process.execPath is THIS app's binary (EasyDeal.exe
            // in packaged mode, electron.exe in dev). Without this flag,
            // spawning it with a JS file arg would re-initialise the
            // Electron app and pop ANOTHER EasyDeal window for every chat
            // turn. ELECTRON_RUN_AS_NODE=1 makes the binary behave as
            // plain Node, no window, no second app instance. Only relevant
            // for the legacy 1.x cli.js path; 2.x uses bin/claude.exe.
            ELECTRON_RUN_AS_NODE: isJs ? '1' : (process.env.ELECTRON_RUN_AS_NODE || ''),
            ...tokenOverride.env,
            // 0.3.5: 来源标记 —— 让 MCP 知道这是 chat 触发的，回测 cron
            // notify_json = ["chat"]，不会乱推到微信
            EASYDEAL_NOTIFY_DEFAULT: 'chat',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: useShell,
          windowsHide: true,
        },
      );
      this.activeChild = child;

      let buf = '';
      // Keep stderr as raw Buffer chunks until error display — Windows zh-CN
      // claude-code emits GBK-encoded error messages, which decode as mojibake
      // via toString('utf8'). We try utf-8 first, then GBK fallback when we
      // see replacement chars (U+FFFD).
      const stderrChunks = [];
      let finalText = null;
      // 0.3.44: Claude Code SDK 撞上游 API 错（429 / 5xx / channel quota）时
      // 会 emit `{type:"result", subtype:"error_during_execution", is_error:true,
      // result:"API Error: 500 ..."}` 但**进程退码 0**。老逻辑把这种事件当
      // 正常 final text 走，外层 try/catch 永远抓不到 → channel-error retry
      // 链全部失效，用户看到的就是「API Error: 500 ...」干瘪一句。这里捕获
      // result 事件的 subtype/is_error，在 close 时如果是 error 子类型就
      // reject(Error(result_text)) 让 isChannelError 正则去匹配 + 触发兜底。
      let resultSubtype = null;
      let resultIsError = false;
      // 1.2.30: 本轮上下文规模(token)峰值 —— 取每次 API 调用 message.usage 里
      // (input + cache_read + cache_creation) 的最大值。用单次调用的峰值(而非
      // result 事件里跨多次 tool-call 累加的聚合值)更贴近「模型实际看到的上下文
      // 大小」，不会被 multi-tool 轮次虚高。供 send() 的主动压缩守卫用。
      let turnMaxCtx = 0;
      const _ctxOf = (u) => {
        if (!u) return 0;
        return (u.input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0);
      };

      const handleEvent = (evt) => {
        // 0.2.6：每个 stream-json 事件都带 sessionId（init / queue-operation
        // 事件头一条就有）；抓出来记到 this.lastSessionId，下次 spawn 用
        // --resume 显式 resume 这条，而不是被 --continue 拽到 cron 任务的
        // session 上。Claude 重连 / SDK 在中途换 sessionId 的话也能跟着更
        // 新（实际中 --resume 后整段 turn 共用同一个 id）。
        try {
          const sid = evt && (evt.sessionId || evt.session_id);
          if (typeof sid === 'string' && sid && sid !== this.lastSessionId) {
            this.lastSessionId = sid;
            // 0.3.4: 跟当前 endpoint fingerprint 一起记下，下次 send 时
            // 比对决定能不能 --resume。
            this.lastSessionEndpoint = this._spawnEndpoint || (this.tokenStore?.endpointFingerprint?.() || 'unknown');
          }
        } catch {}
        // Track the SDK's result event subtype outside of parseStreamEvent
        // (parseStreamEvent only returns segment shapes; the error signal
        // lives on the event itself).
        if (evt && evt.type === 'result') {
          resultSubtype = evt.subtype || null;
          resultIsError = !!evt.is_error
                       || (evt.subtype && evt.subtype !== 'success');
        }
        // 1.2.30: 抓每次 model 调用的上下文规模峰值(供主动压缩用)。每条
        // assistant 事件的 message.usage.input_tokens(+cache)= 那一次调用模型
        // 看到的输入大小；一个 turn 里多次 tool-call 会有多条，取最大值。
        try {
          if (evt && evt.type === 'assistant' && evt.message && evt.message.usage) {
            const c = _ctxOf(evt.message.usage);
            if (c > turnMaxCtx) turnMaxCtx = c;
          }
        } catch {}
        const segments = parseStreamEvent(evt);
        for (const seg of segments) {
          if (seg.kind === 'final') {
            finalText = seg.text;
            continue;
          }
          // Emit per-tool-use event so external listeners (e.g. the
          // strategy-creation notifier in main.js) can react to specific
          // tools. Generic, used for any future hooks too.
          if (seg.kind === 'tool_use') {
            this.emit('tool-use', { name: seg.name, input: seg.input, id: seg.id });
          }
          // Merge consecutive text segments into one growing block so the UI
          // streams smoothly instead of fragmenting.
          const last = assistantTurn.segments[assistantTurn.segments.length - 1];
          if (seg.kind === 'text' && last && last.kind === 'text') {
            last.text += seg.text;
            this.emit('stream', { id: assistantTurn.id, mutate: { index: assistantTurn.segments.length - 1, segment: last } });
          } else {
            assistantTurn.segments.push(seg);
            this.emit('stream', { id: assistantTurn.id, append: seg });
          }
        }
      };

      // 0.4.16: absolute 5min timeout → **纯 idle timeout, 无绝对上限**.
      // 老逻辑: 无条件 5min SIGTERM 杀 → heavy turn (改大策略多处 / 连续多 tool
      // call / 慢 model) 正常就 >5min 被切断, turn 中途「（已停止）」(模型盘报 AI
      // 改 GMarket.mq5 改一半自己停).
      // 不设绝对上限 (之前想加 30min ABS, 但那跟 5min 同类问题 — 真在干活的长
      // turn 比如大重构+多步回测分析可能 >30min, 绝对上限照样误杀). claude 只要
      // 还在持续输出 (thinking/tool_use/text/tool_result 任何 stream 事件都触发
      // stdout) 就 reset idle timer → active turn 无论跑多久都不被杀. 只有进程
      // **连续 IDLE_MS 完全无 stdout** (= 真卡死/hang/等一个永不返回的 tool) 才
      // SIGTERM. 极端「死循环持续吐 noise」由 OUTPUT_CAP 截断 + 用户手动「停止」
      // 按钮兜底, 不靠绝对 timer.
      // IDLE_MS 取 10min: 留足慢 MCP tool (如同步回测) 单步执行 + 慢 model 首
      // token 延迟的空窗; 真 hang 等 10min 才杀可接受 (用户能提前手动停).
      // 定义放 stdout.on 注册之前 — 避免 const armIdle 的 TDZ (回调引用它).
      const IDLE_MS = 10 * 60 * 1000;   // 10min 完全无输出 = 判定卡死
      let idleTimer = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, IDLE_MS);
      };
      armIdle();
      const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); };

      child.stdout.on('data', (d) => {
        armIdle();   // 0.4.16: 有 stdout 输出 = claude 还在干活, 重置 idle timer
        buf += d.toString();
        // Drain whole lines; stream-json is line-delimited JSON.
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); }
          catch { continue; } // skip malformed line
          handleEvent(evt);
        }
      });
      child.stderr.on('data', (d) => { armIdle(); stderrChunks.push(d); });

      child.on('error', (e) => {
        clearTimers();
        reject(new Error(`spawn ${bin} failed: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimers();
        // Drain any remaining partial line.
        if (buf.trim()) {
          try { handleEvent(JSON.parse(buf.trim())); } catch {}
        }
        if (signal) return reject(new Error(`killed (${signal})`));
        if (code !== 0) {
          // Decode stderr smartly: utf-8 first, GBK fallback if mojibake.
          // 2026-10-28: 真错在 result 事件(finalText)里, stderr 可能只有 CLI 诊断行
          const errText = formatClaudeExitError('exit', code,
            _decodeStderr(stderrChunks), resultIsError ? finalText : '');
          return reject(new Error(errText.slice(0, 700)));
        }
        // 0.3.44: SDK 进程 exit 0 但 result.subtype != 'success' → 仍当失败
        // 抛 reject，让外层 retry 链能识别 channel error 重试 / 切 model。
        if (resultIsError && finalText) {
          return reject(new Error(String(finalText)));
        }
        // 1.2.30: 记下本轮真实上下文峰值，供下一次 send() 的主动压缩守卫判断。
        if (turnMaxCtx > 0) this._lastContextTokens = turnMaxCtx;
        resolve(finalText);
      });
      })().catch(reject);  // 0.3.244: close async IIFE
    });
  }

  async _save() {
    // 0.2.9: trace log to <userData>/startup-trace.log to definitively answer
    // "is _save being called and does fs.writeFile complete?" — multiple
    // versions of EasyDeal main process showed chat.json mtime stuck for
    // days even though chat IPC clearly works. console.warn 在 packaged
    // 模式下看不到，只能写文件诊断。
    const _fsSync = require('node:fs');
    const _userData = path.dirname(path.dirname(this.dataPath));  // dataDir = <userData>/data
    const _tracePath = path.join(_userData, 'startup-trace.log');
    const _trace = (msg) => {
      try { _fsSync.appendFileSync(_tracePath, `[${new Date().toISOString()}] chat._save :: ${msg}\n`, 'utf8'); }
      catch {}
    };
    _trace(`ENTER turns=${this.history.length} sid=${this.lastSessionId || '(none)'} path=${this.dataPath}`);
    try {
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      _trace('mkdir DONE');
      const payload = JSON.stringify({
        sessionKey: this.sessionKey,   // 1.3.x: 策略会话文件名是 hash, 存 key 供 manager 预热反查
        history: this.history,
        continueNext: this.continueNext,
        lastSessionId: this.lastSessionId || null,
        lastSessionEndpoint: this.lastSessionEndpoint || null,
        // 2026-08-08 多台附加: 权威字段是数组。
        remoteAttachments: this.remoteAttachments || [],
        // 单数字段继续写第一台 —— 纯为「装了新版又回退回旧版」留退路(旧版只认它,
        // 至少不会一台都不剩)。读取侧优先读数组, 见 init()。
        remoteAttachment: this.remoteAttachment || null,
      }, null, 2);
      // 0.3.1 老防御 (writeFile + statSync 验证 mtime/size) 0.4.18 删除 —
      // statSync 读 OS write-back 缓存里的新元数据, dirty page 没刷盘时被骗
      // "verified" (用户模拟盘确诊). 改 durableWriteSync (fsync + readback).
      const expectedBytes = Buffer.byteLength(payload, 'utf8');
      _trace(`durableWrite START chars=${payload.length} bytes=${expectedBytes}`);
      // 0.4.18: 改用 durableWriteSync — temp + fsync + readback 内容校验 + 原子 rename.
      // 老逻辑 fs.writeFile + statSync 验证 mtime/size 被 OS write-back 缓存骗 (用户
      // 模拟盘确诊: statSync 读缓存新值"verified"但 dirty page 没刷盘, 进程被频繁
      // SIGKILL 后丢). durableWrite 的 fsync 强制刷盘 + readback 读真实内容校验.
      const { durableWriteSync } = require('./durable-write');
      const r = durableWriteSync(this.dataPath, payload, { encoding: 'utf8' });
      if (r.ok) {
        _trace(`durableWrite DONE (fsync+readback verified) bytes=${expectedBytes}`);
      } else {
        _trace(`!! durableWrite FAILED reason=${r.reason} ${r.error || ''} wrote=${r.wrote} read=${r.read}`);
        // 0.4.18: 持久化真失败 → 通知上层 (UI banner 告警, 不再静默丢数据).
        try { this.emit('persist-error', { file: 'chat.json', reason: r.reason, error: r.error || null }); } catch {}
      }
    } catch (e) {
      _trace(`ERROR ${e?.message || e}`);
      console.warn('[chat] save failed:', e.message);
    }
    // 2026-06-13: 同步落 append-only AI 沟通日志(主对话 user/assistant + appendSystemNote
    // 通知如「回测完成」)。从内存 history 读, 不依赖 chat.json 写成功; 模块内按 id 去重 +
    // 跳 pending, 所以流式中 _save 多次触发也安全, assistant 定型那次才记。relay 按 seq
    // 游标续传到 server, 滚动窗挤掉/relay 没起都不丢(产生即落盘, 起来补发)。
    try {
      require('./ai-comm-log').syncHistory(path.dirname(this.dataPath), this.history, this.channel);
    } catch { /* best-effort, 绝不影响 chat 主流程 */ }
  }
}

let _turnCounter = 0;
function genTurnId() {
  _turnCounter += 1;
  return `turn_${Date.now().toString(36)}_${_turnCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

// Translate one Claude Code stream-json event into a list of UI segments.
// Segment shapes:
//   { kind: 'text',        text }
//   { kind: 'thinking',    text }
//   { kind: 'tool_use',    name, input, id }
//   { kind: 'tool_result', tool_use_id, content, is_error }
//   { kind: 'final',       text }   // synthetic — terminal answer
function parseStreamEvent(evt) {
  if (!evt || typeof evt !== 'object') return [];
  if (evt.type === 'assistant' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        out.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool_use',
          name: block.name,
          input: block.input,
          id: block.id,
        });
        // Surface WeChat outbound text directly in chat — when Claude
        // calls mcp__wechat__send_message, the actual reply text is
        // hidden behind "查看参数" in the tool-use card. Users want to
        // see WHAT was sent without expanding it. Emit a synthetic text
        // segment marking it as a WeChat-bound message.
        if (block.name === 'mcp__wechat__send_message' && block.input?.text) {
          const to = block.input.to_user_id ? ` (${block.input.to_user_id})` : '';
          out.push({
            kind: 'text',
            text: `📱 → 微信${to}：${block.input.text}`,
          });
        }
      } else if (block.type === 'thinking' && block.thinking) {
        out.push({ kind: 'thinking', text: block.thinking });
      }
    }
    return out;
  }
  if (evt.type === 'user' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type !== 'tool_result') continue;
      const raw = block.content;
      let str = '';
      if (typeof raw === 'string') str = raw;
      else if (Array.isArray(raw)) {
        str = raw.map((p) => p?.text || JSON.stringify(p)).join('\n');
      } else {
        str = JSON.stringify(raw);
      }
      out.push({
        kind: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: str,
        is_error: !!block.is_error,
      });
    }
    return out;
  }
  if (evt.type === 'result' && evt.result) {
    return [{ kind: 'final', text: evt.result }];
  }
  return [];
}

// Embed attachment references in the prompt so Claude knows to Read them.
// We don't inline file contents because images can't go in text and large
// files would blow the prompt — Claude Code's Read tool handles both.
function buildPromptWithAttachments(message, attachments, liveCtx) {
  const userMsg = message || '（无文字，仅附件）';
  const head = [];
  if (liveCtx && liveCtx.trim()) {
    head.push('<live-workspace-state>');
    head.push(liveCtx.trim());
    head.push('</live-workspace-state>');
    head.push('');
    head.push('（以上为 EasyDeal 客户端附加的实时状态，仅供你了解当前环境；用户没看到这段。）');
    head.push('');
  }
  if (!attachments || !attachments.length) {
    if (!head.length) return userMsg;
    head.push('用户消息：');
    head.push(userMsg);
    return head.join('\n');
  }
  const lines = attachments.map((a) => {
    const hint = a.kind === 'image'
      ? '（图片，Read 工具会以图像方式呈现给你）'
      : a.kind === 'mq5'
      ? '（EA 源码 / 配置）'
      : '';
    return `- ${a.relPath}  ${hint}`.trim();
  }).join('\n');
  return [
    ...head,
    `用户消息：`,
    userMsg,
    ``,
    `用户附了下面这些文件，请用 Read 工具逐个读后再回答：`,
    lines,
  ].join('\n');
}

module.exports = {
  ChatSession,
  extractRemoteClientKeys,
  canResumeEndpoint,
  endpointResumeDecision,
  claudeProjectDir,
  parseClaudeSessionLog,
};
