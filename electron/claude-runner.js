// Locate and spawn the Claude Code CLI.
//
// Resolution order:
//   1. CLAUDE_BIN env var (manual override)
//   2. node_modules/@anthropic-ai/claude-code (bundled with the client)
//   3. node_modules/.bin/claude (npm bin shim)
//   4. `claude` on PATH (legacy / system install)
//
// All call sites use resolveClaudeBin() so the bundled binary is preferred —
// users do NOT need to install Claude Code separately.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_CAP = 12_000;

// See chat-session.js for the same helper. Decode stderr buffer chunks
// with utf-8 first, GBK fallback when zh-CN Windows claude-code emits
// in the active code page.
function _decodeStderr(chunks) {
  if (!chunks || !chunks.length) return '';
  const buf = Buffer.concat(chunks);
  const utf8 = buf.toString('utf8');
  const replCount = (utf8.match(/�/g) || []).length;
  if (replCount > 0 && replCount / Math.max(1, utf8.length) > 0.02) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch {
      try { return new TextDecoder('gb18030').decode(buf); } catch {}
    }
  }
  return utf8;
}

let _cachedBin = null;
function resolveClaudeBin() {
  if (_cachedBin) return _cachedBin;

  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) {
    _cachedBin = fromEnv; return _cachedBin;
  }

  // claude-code 2.x layout: bin/claude.exe is a native binary (Rust),
  // NOT a Node JS entry like 1.x had. Prefer the package's own binary
  // first; the .bin/claude.cmd npm shim is a fallback that triggers
  // cmd.exe parsing (broke args on zh-CN Windows: "命令语法不正确").
  //
  // Packaged mode: __dirname lives inside app.asar (virtual fs). spawn()
  // uses raw OS APIs and CAN'T read inside asar — only fs (Electron's
  // patched fs) can. So we MUST resolve to app.asar.unpacked first.
  // Match both `\app.asar\` and trailing `\app.asar` (no separator) to
  // cover all path shapes.
  const root = path.resolve(__dirname, '..');
  const unpackRoot = root.replace(
    /([\\\/])app\.asar(?=([\\\/]|$))/, '$1app.asar.unpacked',
  );
  const roots = unpackRoot !== root ? [unpackRoot, root] : [root];

  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];
  for (const r of roots) {
    candidates.push(
      // 2.x: bin/claude.exe is a native binary inside the package
      path.join(r, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
      // 1.x legacy: cli.js was a Node script
      path.join(r, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      // npm-generated shim — last resort, .cmd triggers cmd.exe parsing
      // and breaks arg quoting on Windows
      path.join(r, 'node_modules', '.bin', exe),
      path.join(r, 'node_modules', '.bin', 'claude'),
    );
  }
  for (const c of candidates) {
    // Reject paths inside app.asar (without .unpacked) — fs.existsSync
    // returns true for those via Electron's virtual fs patch, but spawn()
    // uses raw OS APIs and can't read inside the archive → ENOENT at run.
    if (/[\\\/]app\.asar[\\\/]/.test(c)) continue;
    try { if (fs.existsSync(c)) { _cachedBin = c; return c; } } catch {}
  }

  // Last resort: 'claude' on PATH
  _cachedBin = 'claude';
  return _cachedBin;
}

// Claude Code also reads `env` entries from ~/.claude/settings.json (commonly
// written by CC Switch). In practice that setting can replace an
// ANTHROPIC_MODEL supplied through the child process environment. Promote an
// EasyDeal-selected model to the CLI's explicit --model option, whose purpose
// is to select the model for this invocation. An empty model intentionally
// leaves the args untouched so CC Switch / Claude Code remains authoritative.
function withClaudeModelArg(args, env = {}, fallbackEnv = {}) {
  const out = Array.isArray(args) ? args.slice() : [];
  const primaryModel = typeof env?.ANTHROPIC_MODEL === 'string'
    ? env.ANTHROPIC_MODEL.trim() : '';
  const fallbackModel = typeof fallbackEnv?.ANTHROPIC_MODEL === 'string'
    ? fallbackEnv.ANTHROPIC_MODEL.trim() : '';
  const model = primaryModel || fallbackModel;
  if (!model) return out;
  if (out.some((arg) => arg === '--model' || String(arg).startsWith('--model='))) return out;
  return ['--model', model, ...out];
}

// 2026-10-28: claude-code 2.1.x 在 --print 模式下会往 stderr 写 `[claude-code:<tag>] {...}`
// 诊断行(如 unrecognized_model: 请求的 model ID 本版本 CLI 不认识)。它只是提示, 不是
// 失败原因; 真正的错误(Prompt is too long / API Error ...)在 stdout 的 result 事件里。
// 老逻辑非 0 退出时只拼 stderr → 用户只看到这行诊断, 真错丢了, 上下文超窗压缩重试和
// 通道重试的正则也都匹配不上(10-28 舰队巡检实测)。
const _CLI_DIAG_LINE_RE = /^\[claude-code:[a-z0-9_]+\].*$/gim;

function formatClaudeExitError(prefix, code, stderrText, resultText) {
  const raw = String(stderrText || '');
  const diag = raw.match(_CLI_DIAG_LINE_RE) || [];
  if (diag.length) console.warn('[claude] cli diagnostics:', diag.join(' | '));
  const stderr = raw.replace(_CLI_DIAG_LINE_RE, '').trim();
  const result = String(resultText || '').trim();
  const detail = [result, stderr].filter(Boolean).join('\n');
  return `${prefix} ${code}: ${detail || '(no stderr)'}`;
}

// 0.3.38 channel-error retry：headless 路径（微信 + 定时任务）撞 channel
// 429 / 5xx / `exit 1 (no stderr)` 时自动重 issue fay token + 重试一次。
// 跟 chat-session.js 同一个 regex / 同一个 _sharedReissuer（main.js 注到
// _token-accessor）。命中条件 + 处理逻辑跨两条 spawn 路径完全一致。
// 0.3.49: `exit(?:ed)?` 覆盖 chat-session.js 抛的「exit 1: (no stderr)」
// + claude-runner.js 抛的「claude exited 1: (no stderr)」两种文案。老正则
// 只认 "exit\s+1"，过去式 "exited 1" 直接漏过 —— 等于 0.3.38 加的 wechat /
// scheduler headless retry 整条链路从来没在过去式错文上触发过（用户撞
// channel 5 不可用一动不动的根因）。\d+ 也放宽下，不限定 exit code = 1。
const _CHANNEL_ERR_RE = /\b429\b|rate_limit|too many requests|channel_quota|upstream_unreachable|API Error: 50[0-9]|exit(?:ed)?\s+\d+.*\(no stderr\)/i;

// Spawn `claude --print` for headless one-shot runs (used by scheduler + wechat).
// 0.3.38: 加 channel-error retry —— 撞 fay channel 故障自动重签 + 重试一次。
async function spawnHeadlessClaude(opts = {}) {
  try {
    return await _spawnHeadlessClaudeOnce(opts);
  } catch (e) {
    const msg = String(e?.message || '');
    if (!_CHANNEL_ERR_RE.test(msg)) throw e;
    // 是 channel error → 看能否 reissue
    let reissuer = null;
    let ts = null;
    try {
      const acc = require('./_token-accessor');
      reissuer = acc.getReissuer && acc.getReissuer();
      ts = acc.get && acc.get();
    } catch {}
    if (!reissuer || !ts || ts.data?.mode !== 'fay') {
      // 不是 fay 模式或没注 reissuer → 抛原错（保留原诊断信息）
      throw e;
    }
    console.warn('[headless] channel error detected (', msg.slice(0, 120), '), reissuing fay token + retry');
    const curModel = ts.data?.fay?.cached_model || null;
    try {
      await reissuer({ model: curModel });
    } catch (reissueErr) {
      throw new Error(`${msg}\n\n[reissue 失败 → ${(reissueErr?.message || reissueErr).toString().slice(0, 200)}]`);
    }
    try {
      return await _spawnHeadlessClaudeOnce(opts);
    } catch (secondErr) {
      // 0.3.44: 第 2 次还是 channel error → 退到不同 model 再试（headless
      // 路径 = 微信 / 定时任务，没 UI 提示，但 channel 全死时切 model 比
      // 直接报错给用户更有用）
      const m2 = String(secondErr?.message || '');
      if (!_CHANNEL_ERR_RE.test(m2)) {
        throw new Error(`${msg}\n\n[reissue 后第 2 次失败 → ${m2.slice(0, 200)}]`);
      }
      console.warn('[headless] same-model reissue still failed; trying cross-model fallback');
      try {
        const fb = await reissuer({ tryFallback: true });
        console.warn(`[headless] switched to fallback model: ${fb?.model || '?'}`);
      } catch (fbReissueErr) {
        throw new Error(
          `${msg}\n\n[same-model reissue 重试 → ${m2.slice(0, 150)}] ` +
          `[fallback reissue 失败 → ${(fbReissueErr?.message || fbReissueErr).toString().slice(0, 150)}]`
        );
      }
      try {
        return await _spawnHeadlessClaudeOnce(opts);
      } catch (thirdErr) {
        const m3 = String(thirdErr?.message || '');
        throw new Error(
          `${msg}\n\n[same-model reissue 重试 → ${m2.slice(0, 150)}] ` +
          `[fallback 到其他模型重试 → ${m3.slice(0, 150)}]`
        );
      }
    }
  }
}

function _spawnHeadlessClaudeOnce({
  prompt,
  cwd,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resume = false,
} = {}) {
  return new Promise((resolve, reject) => {
    // 0.3.244: wrap 在 async IIFE — token-mode 是 'custom' + protocol='openai' 时
    // 需要 await ts.ensureOpenaiProxyAndReplace(tokenEnv) 启动本地 OpenAI 代理.
    (async () => {
    if (!prompt) return reject(new Error('prompt is required'));
    const bin = resolveClaudeBin();
    // --dangerously-skip-permissions: same rationale as chat-session.js;
    // scheduler-driven headless runs must not block on permission prompts.
    const args = ['--print', '--dangerously-skip-permissions', prompt];
    if (resume) args.unshift('--continue');

    let child;
    try {
      const isJs = bin.endsWith('.js');
      // Token-mode env override (custom endpoint / Fay relay). The caller
      // can pass tokenStore via the env-passing path; if not, headless
      // spawn uses whatever's in process.env (== system claude login).
      // We resolve via a global accessor to avoid threading tokenStore
      // through every scheduler call site.
      let tokenEnv = {};
      let tokenIssue = null;
      let tsRef = null;
      try {
        const ts = require('./_token-accessor').get();
        tsRef = ts;
        if (ts) {
          let o = ts.spawnEnvOverrides();
          const { classifyTokenSpawnIssue } = require('./token-store');
          tokenIssue = classifyTokenSpawnIssue(o);
          // 0.3.309: 用户报 fay token 不可用. 根因 client cached_token 缺失
          // (`_autoIssueFayIfNeeded` boot 时跑一次失败后没自动 retry). 之前直接
          // reject 让用户看 friendly modal — 但实测 server 端 issue 200 OK, 只是
          // client 没拉到. 这里 pre-spawn 同步 await reissuer 重试一次, 拿到 token
          // 后再 check, 仍 fail 才弹 modal. 大幅减少「Fay token 不可用」误报.
          if (tokenIssue && o.mode === 'fay') {
            try {
              const reissuer = require('./_token-accessor').getReissuer?.();
              if (reissuer) {
                console.log('[claude-runner] fay token missing pre-spawn — attempt sync reissue');
                await reissuer({});  // model=undefined → 让 _autoIssueFayIfNeeded 走 list-models 选第一个
                // 重新 check
                o = ts.spawnEnvOverrides();
                tokenIssue = classifyTokenSpawnIssue(o);
                if (!tokenIssue) {
                  console.log('[claude-runner] fay token sync reissue OK, spawn 继续');
                }
              }
            } catch (e) {
              console.warn('[claude-runner] fay token sync reissue 失败:', e?.message || e);
              // 仍 fall-through reject 弹 modal (用户至少能看到原因)
            }
          }
          if (!tokenIssue) tokenEnv = o.env || {};
          if (tokenIssue) tokenIssue._mode = o.mode;
        }
      } catch {
        // require() failure / unexpected throw — fall through to system env.
      }
      if (tokenIssue) {
        return reject(new Error(
          `[token-mode-${tokenIssue._mode}] ${tokenIssue.title} — `
          + tokenIssue.body.split('\n')[0]
        ));
      }
      // 0.3.244: custom protocol='openai' 时 spawnEnvOverrides 填的 ANTHROPIC_BASE_URL
      // 是 __EASYDEAL_OPENAI_PROXY__ placeholder. await 这步把它替换成 127.0.0.1:<port>.
      if (tsRef && tokenEnv && String(tokenEnv.ANTHROPIC_BASE_URL || '').startsWith('__EASYDEAL_')) {
        try { await tsRef.ensureLocalBridgeAndReplace(tokenEnv); }
        catch (e) {
          return reject(new Error(`本地 AI 桥接启动失败 — ${e?.message || e}`));
        }
      }
      // Only use shell:true for .cmd / .bat shims. Native .exe runs directly.
      const useShell = /\.(cmd|bat)$/i.test(bin);
      // 0.3.52: 同 chat-session — custom / codex / fay 模式剥掉 OS 的 ANTHROPIC_*
      // 避免被 hijack。tokenStore 通过 _token-accessor 拿到。
      const tsForStrip = (() => {
        try { return require('./_token-accessor').get(); } catch { return null; }
      })();
      const stripKeys = tsForStrip ? tsForStrip.envKeysToStripBeforeSpawn() : [];
      const baseEnv = { ...process.env };
      for (const k of stripKeys) delete baseEnv[k];
      const spawnArgs = withClaudeModelArg(args, tokenEnv, env);
      child = spawn(
        isJs ? process.execPath : bin,
        isJs ? [bin, ...spawnArgs] : spawnArgs,
        {
          cwd,
          env: {
            ...baseEnv,
            ELECTRON_RUN_AS_NODE: isJs ? '1' : (process.env.ELECTRON_RUN_AS_NODE || ''),
            ...env,
            ...tokenEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: useShell,
          windowsHide: true,
        },
      );
    } catch (e) {
      return reject(new Error(`failed to spawn '${bin}': ${e.message}`));
    }

    let out = '';
    // Stderr stays as raw Buffer chunks so we can decode with GBK fallback
    // for Chinese Windows claude-code (defaults to active CP, not UTF-8).
    const stderrChunks = [];
    let stderrBytes = 0;
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2);
    });
    child.stderr.on('data', (d) => {
      stderrChunks.push(d);
      stderrBytes += d.length;
      // Cap the buffered stderr to avoid runaway memory.
      while (stderrBytes > 8000 && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift().length;
      }
    });

    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(killer);
      reject(new Error(`claude spawn failed: ${e.message}. Bin: ${bin}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new Error(`claude run timed out after ${timeoutMs}ms`));
      }
      if (code !== 0) {
        const errText = formatClaudeExitError('claude exited', code,
          _decodeStderr(stderrChunks), out.trim().slice(-1000));
        return reject(new Error(errText.slice(0, 1100)));
      }
      resolve(out.trim().slice(-OUTPUT_CAP));
    });
    })().catch(reject);  // 0.3.244: close async IIFE for ensureOpenaiProxyAndReplace
  });
}

// Spawn `claude --print --output-format json` and return both the textual
// result AND the session_id captured from the JSON envelope. Required for
// per-conversation persistence (e.g. wechat-sessions.js — each chatId must
// resume the same session JSONL across spawns to keep context).
//
//   sessionId = null  → fresh conversation; Claude generates a new id
//   sessionId = "..." → resume that exact JSONL session
//
// Returns: {
//   result: string,
//   session_id: string | null,
//   total_cost_usd: number | null,
//   called_send_message: boolean,                            // 0.3.283: Claude 这 turn 调过 mcp__wechat__send_message?
//   send_message_invocations: Array<{tool_use_id, input}>,   // 0.3.283: 每次调用的参数 (诊断用)
//   all_tool_uses: string[],                                  // 0.3.283: 这 turn 所有 tool_use 工具名
// }
// 0.3.38: 同上 — session 版本（微信走这条）也加 channel-error retry
async function spawnHeadlessClaudeWithSession(opts = {}) {
  try {
    return await _spawnHeadlessClaudeWithSessionOnce(opts);
  } catch (e) {
    const msg = String(e?.message || '');
    if (!_CHANNEL_ERR_RE.test(msg)) throw e;
    let reissuer = null;
    let ts = null;
    try {
      const acc = require('./_token-accessor');
      reissuer = acc.getReissuer && acc.getReissuer();
      ts = acc.get && acc.get();
    } catch {}
    if (!reissuer || !ts || ts.data?.mode !== 'fay') throw e;
    console.warn('[wechat] channel error detected (', msg.slice(0, 120), '), reissuing fay token + retry');
    const curModel = ts.data?.fay?.cached_model || null;
    try {
      await reissuer({ model: curModel });
    } catch (reissueErr) {
      throw new Error(`${msg}\n\n[reissue 失败 → ${(reissueErr?.message || reissueErr).toString().slice(0, 200)}]`);
    }
    try {
      return await _spawnHeadlessClaudeWithSessionOnce(opts);
    } catch (secondErr) {
      const m2 = String(secondErr?.message || '');
      // 0.3.44: 同款 model 重试还是 channel error → 切到不同 model 再试一次
      if (!_CHANNEL_ERR_RE.test(m2)) {
        throw new Error(`${msg}\n\n[reissue 后第 2 次失败 → ${m2.slice(0, 200)}]`);
      }
      console.warn('[wechat] same-model reissue still failed; trying cross-model fallback');
      try {
        const fb = await reissuer({ tryFallback: true });
        console.warn(`[wechat] switched to fallback model: ${fb?.model || '?'}`);
      } catch (fbReissueErr) {
        throw new Error(
          `${msg}\n\n[same-model reissue 重试 → ${m2.slice(0, 150)}] ` +
          `[fallback reissue 失败 → ${(fbReissueErr?.message || fbReissueErr).toString().slice(0, 150)}]`
        );
      }
      try {
        return await _spawnHeadlessClaudeWithSessionOnce(opts);
      } catch (thirdErr) {
        const m3 = String(thirdErr?.message || '');
        throw new Error(
          `${msg}\n\n[same-model reissue 重试 → ${m2.slice(0, 150)}] ` +
          `[fallback 到其他模型重试 → ${m3.slice(0, 150)}]`
        );
      }
    }
  }
}

function _spawnHeadlessClaudeWithSessionOnce({
  prompt,
  cwd,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sessionId = null,
} = {}) {
  return new Promise((resolve, reject) => {
    // 0.3.244: async IIFE — 同 _spawnHeadlessClaudeOnce, OpenAI 兼容代理懒启动
    (async () => {
    if (!prompt) return reject(new Error('prompt is required'));
    const bin = resolveClaudeBin();
    // 0.3.283: 改用 stream-json 让我们能解析每个 tool_use 事件 (而不是只拿
    // 最后的 result 文本). 用户报「微信收到多条噪音回复」, 根因是 fallback
    // 不知道 Claude 是否真调过 mcp__wechat__send_message 就盲发 r.result.
    // stream-json 流式输出 JSONL, 每行一个 event (system/assistant/user/result),
    // assistant.message.content 里就有 tool_use 块. 解析出来后 _fireWechatBatch
    // 能精准判断 fallback 该不该 fire.
    // CLI 要求: stream-json + -p 必须配 --verbose.
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (sessionId) {
      // --resume <id> resumes that specific session JSONL.
      args.unshift('--resume', sessionId);
    }
    args.push(prompt);

    let child;
    try {
      const isJs = bin.endsWith('.js');
      let tokenEnv = {};
      let tokenIssue = null;
      let tsRef2 = null;
      try {
        const ts = require('./_token-accessor').get();
        tsRef2 = ts;
        if (ts) {
          let o = ts.spawnEnvOverrides();
          const { classifyTokenSpawnIssue } = require('./token-store');
          tokenIssue = classifyTokenSpawnIssue(o);
          // 0.3.309: 同 line ~195 注释. 第二处 spawn (headless 微信 / 定时任务路径)
          // 也加 sync reissue 重试.
          if (tokenIssue && o.mode === 'fay') {
            try {
              const reissuer = require('./_token-accessor').getReissuer?.();
              if (reissuer) {
                console.log('[claude-runner headless] fay token missing — attempt sync reissue');
                await reissuer({});
                o = ts.spawnEnvOverrides();
                tokenIssue = classifyTokenSpawnIssue(o);
                if (!tokenIssue) console.log('[claude-runner headless] sync reissue OK');
              }
            } catch (e) {
              console.warn('[claude-runner headless] sync reissue 失败:', e?.message || e);
            }
          }
          if (!tokenIssue) tokenEnv = o.env || {};
          if (tokenIssue) tokenIssue._mode = o.mode;
        }
      } catch {}
      if (tokenIssue) {
        return reject(new Error(
          `[token-mode-${tokenIssue._mode}] ${tokenIssue.title} — `
          + tokenIssue.body.split('\n')[0]
        ));
      }
      // 0.3.244: OpenAI 兼容代理 placeholder 替换
      if (tsRef2 && tokenEnv && String(tokenEnv.ANTHROPIC_BASE_URL || '').startsWith('__EASYDEAL_')) {
        try { await tsRef2.ensureLocalBridgeAndReplace(tokenEnv); }
        catch (e) {
          return reject(new Error(`本地 AI 桥接启动失败 — ${e?.message || e}`));
        }
      }
      const useShell = /\.(cmd|bat)$/i.test(bin);
      // 0.3.52: 同 chat-session — custom / codex / fay 模式剥掉 OS 的 ANTHROPIC_*
      const tsForStrip2 = (() => {
        try { return require('./_token-accessor').get(); } catch { return null; }
      })();
      const stripKeys2 = tsForStrip2 ? tsForStrip2.envKeysToStripBeforeSpawn() : [];
      const baseEnv2 = { ...process.env };
      for (const k of stripKeys2) delete baseEnv2[k];
      const spawnArgs = withClaudeModelArg(args, tokenEnv, env);
      child = spawn(
        isJs ? process.execPath : bin,
        isJs ? [bin, ...spawnArgs] : spawnArgs,
        {
          cwd,
          env: {
            ...baseEnv2,
            ELECTRON_RUN_AS_NODE: isJs ? '1' : (process.env.ELECTRON_RUN_AS_NODE || ''),
            ...env,
            ...tokenEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: useShell,
          windowsHide: true,
        },
      );
    } catch (e) {
      return reject(new Error(`failed to spawn '${bin}': ${e.message}`));
    }

    let out = '';
    let lineBuf = '';     // 0.3.283: 流式 JSONL 解析累积器, 累到换行才尝试 parse 一行
    const stderrChunks = [];
    let stderrBytes = 0;
    // 0.3.283: 解析 stream-json 事件累积的状态
    let finalResult = '';
    let finalSessionId = null;
    let finalCost = null;
    let finalIsError = false;
    let resultLineSeen = false;
    const sendMessageInvocations = [];   // mcp__wechat__send_message tool_use 记录
    const allToolUses = [];               // 所有 tool_use 用于诊断
    const _SEND_MSG_RE = /(^|\W)mcp__wechat__send_message$/;
    const _processEvent = (evt) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block && block.type === 'tool_use') {
            const name = String(block.name || '');
            allToolUses.push(name);
            if (_SEND_MSG_RE.test(name)) {
              sendMessageInvocations.push({
                tool_use_id: block.id || null,
                input: block.input || {},
              });
            }
          }
        }
      } else if (evt.type === 'result') {
        // 流终结事件 — 跟老 --output-format json 同款 schema
        finalResult = typeof evt.result === 'string' ? evt.result : '';
        finalSessionId = evt.session_id || null;
        finalCost = typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null;
        finalIsError = !!evt.is_error;
        resultLineSeen = true;
      } else if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
        // init 事件里也带 session_id — 万一 result 缺失兜底
        if (!finalSessionId) finalSessionId = evt.session_id;
      }
    };
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      out += chunk;
      lineBuf += chunk;
      // JSONL: 每行一个 JSON event, 用 \n 分割
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try { _processEvent(JSON.parse(line)); }
        catch { /* 部分行不是 JSON / 半截 — 忽略 */ }
      }
    });
    child.stderr.on('data', (d) => {
      stderrChunks.push(d);
      stderrBytes += d.length;
      while (stderrBytes > 8000 && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift().length;
      }
    });

    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(killer);
      reject(new Error(`claude spawn failed: ${e.message}. Bin: ${bin}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new Error(`claude run timed out after ${timeoutMs}ms`));
      }
      // 0.3.283: flush 最后可能剩的半行 (一般没有, 但保险)
      // 2026-10-28: 提到非 0 退出判断之前 — 失败时真错就在这条 result 事件里
      if (lineBuf.trim()) {
        try { _processEvent(JSON.parse(lineBuf.trim())); } catch {}
      }
      if (code !== 0) {
        const errText = formatClaudeExitError('claude exited', code,
          _decodeStderr(stderrChunks), finalIsError ? finalResult : '');
        return reject(new Error(errText.slice(0, 1100)));
      }
      if (!resultLineSeen) {
        return reject(new Error(`claude stream-json 没看到 result 事件; raw=${out.slice(0, 500)}`));
      }
      if (finalIsError) {
        return reject(new Error(`claude reported is_error=true: ${finalResult.slice(0, 500)}`));
      }
      resolve({
        result: finalResult,
        session_id: finalSessionId,
        total_cost_usd: finalCost,
        // 0.3.283: 新增 — 让 _fireWechatBatch 精准判断 fallback 该不该 fire
        called_send_message: sendMessageInvocations.length > 0,
        send_message_invocations: sendMessageInvocations,
        all_tool_uses: allToolUses,
      });
    });
    })().catch(reject);  // 0.3.244: close async IIFE
  });
}

module.exports = {
  resolveClaudeBin,
  withClaudeModelArg,
  formatClaudeExitError,
  spawnHeadlessClaude,
  spawnHeadlessClaudeWithSession,
};
