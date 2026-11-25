// 0.3.244: 本地 HTTP 代理 — 让「自定义端点」支持 OpenAI Chat Completions 兼容服务
// (DeepSeek / 智谱 / 通义 / OpenRouter / vLLM 等). 不再只能填 Anthropic 协议端点.
//
// 工作原理:
//   Claude Code SDK → POST 127.0.0.1:<port>/v1/messages (Anthropic 协议)
//     → 本代理翻译成 OpenAI Chat Completions 格式
//     → POST <user_filled_upstream_url>/chat/completions
//     → 边读 OpenAI SSE 边翻译成 Anthropic SSE 流回 SDK
//
// 支持:
//   - text content (basic chat)
//   - thinking blocks (reasoning_content 字段, DeepSeek-R1 / mimo 等)
//   - tool_use / tool_result (Claude Code 主要靠这个调 MCP)
//   - stream + non-stream
//   - system role (Anthropic top-level system → OpenAI messages[0])
//
// 不支持 (MVP 留坑):
//   - vision (image_url content)
//   - audio
//   - cache_control (Anthropic prompt caching, OpenAI 无对应)
//   - 失败 fail-over (server-side openai.py 有, 本地代理只有一个 upstream)

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// 0.3.291: 浏览器 UA — 跟 server 0.5.56 同款. Cloudflare 对 default node http UA
// (空 / `node-fetch/x.y`) 一律 1010 ban (例: opencode.ai/zen/go/v1, openrouter,
// groq 等多家上游都走 CF). probe + non-stream + stream 3 处 outbound 统一塞这个,
// 避免上游 endpoint 把我们当 bot 干掉.
const _OUTBOUND_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

class OpenAIProxyServer {
  /**
   * @param {object} opts
   * @param {string} opts.upstreamBaseUrl — 用户填的 OpenAI 兼容端点 base url
   *   (https://api.deepseek.com/v1 / https://dashscope.aliyuncs.com/compatible-mode/v1 等).
   *   末尾不带 / chat/completions, 我们拼.
   * @param {string} opts.upstreamApiKey — 用户填的 API key (放 Authorization: Bearer)
   * @param {string} opts.upstreamModel — 用户填的 model id (deepseek-chat / qwen-max 等)
   * @param {Function} [opts.log] — log function
   */
  constructor({ upstreamBaseUrl, upstreamApiKey, upstreamModel, log }) {
    this.upstreamBaseUrl = String(upstreamBaseUrl || '').replace(/\/+$/, '');
    this.upstreamApiKey = String(upstreamApiKey || '');
    this.upstreamModel = String(upstreamModel || '');
    this.log = log || ((m) => console.log('[openai-proxy]', m));
    this.server = null;
    this.port = 0;
  }

  /** 启动 server, 监听 127.0.0.1 随机端口. 返实际端口. */
  async start() {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = this.server.address().port;
    this.log(`server listening on http://127.0.0.1:${this.port} (upstream=${this.upstreamBaseUrl} model=${this.upstreamModel})`);
    return this.port;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
    this.port = 0;
  }

  /** Pre-flight test — 发一个最小 OpenAI 请求验证 base_url + api_key + model. */
  async preflightTest() {
    const body = JSON.stringify({
      model: this.upstreamModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      stream: false,
    });
    // 0.3.246: 不能用前导 '/chat/completions' — `new URL(absolute_path, base)` 会
    // 把 base 的 pathname 整个吃掉, 只保留 origin. 用户填 BASE=`https://x.com/v1/openai`
    // 会被拼成 `https://x.com/chat/completions` (掉了 `/v1/openai`) → 404. 改成 relative.
    const _normBase = this.upstreamBaseUrl.endsWith('/') ? this.upstreamBaseUrl : this.upstreamBaseUrl + '/';
    const url = new URL('chat/completions', _normBase);
    return new Promise((resolve) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.upstreamApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': _OUTBOUND_UA,   // 0.3.291: 防 Cloudflare 1010
        },
        timeout: 20_000,
      }, (resp) => {
        let chunks = '';
        resp.on('data', (c) => chunks += c.toString('utf8'));
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try {
              const j = JSON.parse(chunks);
              const text = j?.choices?.[0]?.message?.content || '';
              resolve({ ok: true, status: resp.statusCode, sample_text: text.slice(0, 100) });
            } catch (e) {
              resolve({ ok: false, status: resp.statusCode, error: 'parse JSON failed', body: chunks.slice(0, 300) });
            }
          } else {
            resolve({ ok: false, status: resp.statusCode, error: `HTTP ${resp.statusCode}`, body: chunks.slice(0, 500) });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: String(e?.message || e) }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout 20s' }); });
      req.write(body);
      req.end();
    });
  }

  // ============================================================
  // HTTP handler
  // ============================================================
  async _handle(req, res) {
    // /v1/messages 是 Anthropic 协议端点. /messages 也接 (Claude Code SDK 看 ANTHROPIC_BASE_URL 拼).
    const url = req.url || '';
    if (req.method !== 'POST' || !/\/(v1\/)?messages\b/.test(url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `unsupported ${req.method} ${url}` } }));
      return;
    }
    // 读完整 request body
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    let anthropicReq;
    try {
      anthropicReq = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }));
      return;
    }

    let openaiReq;
    try {
      openaiReq = this._anthropicToOpenai(anthropicReq);
    } catch (e) {
      this.log(`translate request failed: ${e?.message || e}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'translate_error', message: String(e?.message || e) } }));
      return;
    }

    const isStream = !!anthropicReq.stream;
    if (isStream) {
      this._proxyStream(openaiReq, anthropicReq, res);
    } else {
      this._proxyNonStream(openaiReq, anthropicReq, res);
    }
  }

  // ============================================================
  // 请求翻译: Anthropic Messages → OpenAI Chat Completions
  // ============================================================
  _anthropicToOpenai(req) {
    const out = {
      model: this.upstreamModel,
      messages: [],
      max_tokens: req.max_tokens || 4096,
      stream: !!req.stream,
    };
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop_sequences && req.stop_sequences.length) out.stop = req.stop_sequences;

    // system → OpenAI messages[0] (role=system).
    // Anthropic system 可以是 string 或 array of content blocks (cache_control 等). 全合并成 string.
    if (req.system) {
      let systemText = '';
      if (typeof req.system === 'string') {
        systemText = req.system;
      } else if (Array.isArray(req.system)) {
        systemText = req.system.map((b) => b?.text || '').join('\n');
      }
      if (systemText.trim()) {
        out.messages.push({ role: 'system', content: systemText });
      }
    }

    // tools → OpenAI function tools
    if (Array.isArray(req.tools) && req.tools.length) {
      out.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    }
    if (req.tool_choice) {
      // Anthropic: {type: 'auto'/'any'/'tool', name?}
      // OpenAI: 'auto'/'none'/{type:'function', function:{name}}
      const tc = req.tool_choice;
      if (tc.type === 'auto') out.tool_choice = 'auto';
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    }

    // messages — Anthropic content 可能是 string 或 content blocks array
    for (const msg of req.messages || []) {
      const role = msg.role;
      const content = msg.content;
      if (typeof content === 'string') {
        out.messages.push({ role, content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      // 多 block 内容. user/assistant 都可能有 mix.
      const textParts = [];
      const toolUses = [];     // assistant 发出的 tool_use → tool_calls
      const toolResults = [];  // user 端的 tool_result → role=tool 单独 message
      const thinkingParts = [];  // 0.3.297: assistant 的 thinking blocks → reasoning_content
      for (const block of content) {
        if (block?.type === 'text') {
          textParts.push(block.text || '');
        } else if (block?.type === 'tool_use' && role === 'assistant') {
          toolUses.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block?.type === 'tool_result' && role === 'user') {
          // tool_result 在 user message 里; OpenAI 需要单独 role=tool message
          let resultContent = '';
          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content.map((b) => b?.text || '').join('\n');
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
        } else if (block?.type === 'thinking') {
          // 0.3.297: DeepSeek (通过 opencode 等代理) thinking mode 要求 multi-turn
          // 对话**必须把上轮 reasoning_content 回传**, 否则报错:
          //   "The reasoning_content in the thinking mode must be passed back to the API"
          // 标准 OpenAI 不要这字段, 但 DeepSeek-R1 / mimo / Qwen-thinking 等带 thinking
          // 的 model 都按 DeepSeek 习惯. 提取 thinking text 后面塞到 assistant
          // message.reasoning_content 字段.
          if (role === 'assistant') {
            thinkingParts.push(String(block.thinking || ''));
          }
        }
        // image_url / 其他类型暂不支持
      }

      if (role === 'user') {
        // user message 把 text 拼成 content, tool_result 单独发
        if (textParts.length || (!toolResults.length && !toolUses.length)) {
          out.messages.push({ role: 'user', content: textParts.join('\n') });
        }
        for (const tr of toolResults) out.messages.push(tr);
      } else if (role === 'assistant') {
        const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
        if (toolUses.length) assistantMsg.tool_calls = toolUses;
        // 0.3.297: 见上面 thinking block 注释 — 把 thinking 内容塞到 reasoning_content
        // 字段透传给 DeepSeek 类 thinking-mode 上游. 标准 OpenAI 上游会 ignore 这字段
        // (它不在 spec 里), 不会破坏. 对带 thinking 的 model (R1/mimo/...) 是必需.
        if (thinkingParts.length) {
          assistantMsg.reasoning_content = thinkingParts.join('\n');
        }
        out.messages.push(assistantMsg);
      }
    }

    // 0.3.332: post-process Step 1 — 合并连续 assistant tool_calls messages.
    // Anthropic SDK 把 parallel tool_use 拆成多条独立 assistant messages,
    // 转 OpenAI 后变成连续多条 assistant tool_calls, 违反 OpenAI 协议
    // 「assistant w/ tool_calls 必须紧接对应数量 tool messages」.
    const merged = [];
    for (const m of out.messages) {
      const prev = merged[merged.length - 1];
      const isPureToolCallsAssistant = (mm) =>
        mm && mm.role === 'assistant' &&
        Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0 &&
        (mm.content === null || mm.content === '' || mm.content === undefined) &&
        !mm.reasoning_content;
      if (isPureToolCallsAssistant(m) && isPureToolCallsAssistant(prev)) {
        prev.tool_calls = [...prev.tool_calls, ...m.tool_calls];
      } else {
        merged.push(m);
      }
    }

    // 0.3.333: post-process Step 2 — 按 tool_call_id 重排 tool messages 到对应
    // assistant 之后. 用户实测 0.3.332 仍报错 — 因为 Anthropic 允许 tool_result
    // 异步返回 (跨多个 assistant 轮), 顺序如:
    //   assistant [c0,c1,c2] → tool c0 → tool c1 → assistant [c3,c4] → tool c2 → ...
    // c2 的 result 跑到 c3/c4 之后, OpenAI 严格协议 reject. 0.3.332 的合并修不了
    // 跨轮乱序 — 因为 c0/c1 跟 c2 中间被 tool c0/c1 隔开了, 不再连续.
    //
    // 修法: 提取所有 tool messages 到 by-id map, 然后遍历 non-tool messages,
    // 每条 assistant w/ tool_calls 后按 call_id 顺序插入对应 tool message.
    const toolById = new Map();
    const nonTool = [];
    for (const m of merged) {
      if (m.role === 'tool' && m.tool_call_id) {
        toolById.set(m.tool_call_id, m);
      } else {
        nonTool.push(m);
      }
    }
    const normalized = [];
    for (const m of nonTool) {
      normalized.push(m);
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const tm = toolById.get(tc.id);
          if (tm) {
            normalized.push(tm);
            toolById.delete(tc.id);
          }
        }
      }
    }
    if (toolById.size > 0) {
      // unmatched tool messages — 没对应的 assistant tool_calls. 防御性 drop,
      // 别 push 进 normalized (push 进去会违反 OpenAI 协议 — orphan tool).
      try {
        const orphanIds = [...toolById.keys()].slice(0, 5);
        if (typeof this?.log === 'function') {
          this.log(`[openai-proxy] dropped ${toolById.size} orphan tool messages: ${orphanIds.join(',')}`);
        }
      } catch {}
    }
    out.messages = normalized;

    return out;
  }

  // ============================================================
  // Non-streaming proxy
  // ============================================================
  _proxyNonStream(openaiReq, anthropicReq, clientRes) {
    // 0.3.246: 不能用前导 '/chat/completions' — `new URL(absolute_path, base)` 会
    // 把 base 的 pathname 整个吃掉, 只保留 origin. 用户填 BASE=`https://x.com/v1/openai`
    // 会被拼成 `https://x.com/chat/completions` (掉了 `/v1/openai`) → 404. 改成 relative.
    const _normBase = this.upstreamBaseUrl.endsWith('/') ? this.upstreamBaseUrl : this.upstreamBaseUrl + '/';
    const url = new URL('chat/completions', _normBase);
    const lib = url.protocol === 'https:' ? https : http;
    const reqBody = JSON.stringify(openaiReq);
    const upstreamReq = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${this.upstreamApiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
        'User-Agent': _OUTBOUND_UA,   // 0.3.291: 防 Cloudflare 1010
      },
      timeout: 120_000,
    }, (upRes) => {
      let chunks = '';
      upRes.on('data', (c) => chunks += c.toString('utf8'));
      upRes.on('end', () => {
        if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
          this.log(`upstream HTTP ${upRes.statusCode}: ${chunks.slice(0, 200)}`);
          clientRes.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'upstream_error', message: `HTTP ${upRes.statusCode}: ${chunks.slice(0, 500)}` },
          }));
          return;
        }
        let openaiResp;
        try { openaiResp = JSON.parse(chunks); }
        catch (e) {
          clientRes.writeHead(500, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ type: 'error', error: { type: 'parse_error', message: 'upstream non-JSON' } }));
          return;
        }
        const anthropicResp = this._openaiToAnthropic(openaiResp, anthropicReq);
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify(anthropicResp));
      });
    });
    upstreamReq.on('error', (e) => {
      this.log(`upstream connect error: ${e.message}`);
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'connect_error', message: e.message } }));
    });
    upstreamReq.write(reqBody);
    upstreamReq.end();
  }

  // ============================================================
  // 响应翻译 (non-stream): OpenAI Chat Completion → Anthropic Messages
  // ============================================================
  _openaiToAnthropic(openaiResp, anthropicReq) {
    const choice = openaiResp?.choices?.[0] || {};
    const msg = choice.message || {};
    const finish = choice.finish_reason;
    const content = [];
    // reasoning_content (DeepSeek-R1 / mimo / Qwen-thinking 等) → thinking block
    const reasoning = msg.reasoning_content;
    if (reasoning && typeof reasoning === 'string' && reasoning.trim()) {
      content.push({ type: 'thinking', thinking: reasoning, signature: '' });
    }
    // text content — 0.3.260: detect Qwen / 国产模型 XML-style tool_call 嵌入 text
    // 的 case. 这些 model 用 <tool_call><function=NAME><parameter=KEY>VAL</parameter>
    // </function></tool_call> 格式输出 tool call (不走标准 OpenAI tool_calls 字段).
    // Claude SDK 不认这格式 → 当 text 渲染 → 用户看到一堆 XML 文本而不是真发起 tool call.
    // 实测用户撞: 模型回复「<tool_call><function=mcp__easydeal__get_account></function>
    // </tool_call>」, AI 完全没调 tool. 修法: regex 扫文本提 XML tool_call → 转 tool_use
    // blocks, 剩下的 plain text (XML 之外) 作为 text block.
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
      const parsed = _parseXmlToolCalls(msg.content);
      // 先 emit plain text (如果有)
      if (parsed.text && parsed.text.trim()) {
        content.push({ type: 'text', text: parsed.text });
      }
      // 再 emit 从 XML 提取的 tool_use blocks
      for (const tu of parsed.toolUses) {
        content.push(tu);
      }
      // 如果整段 text 没 XML 也没残余 plain text (理论上不会), 退回原 text
      if (!parsed.text.trim() && !parsed.toolUses.length) {
        content.push({ type: 'text', text: msg.content });
      }
    }
    // tool_calls → tool_use blocks (标准 OpenAI tools 协议)
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); }
        catch { input = { __raw: tc.function?.arguments || '' }; }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: tc.function?.name || 'unknown',
          input,
        });
      }
    }
    // 0.3.260: 如果解析出 XML tool_use 且 finish_reason !== tool_calls, 强制升 stop_reason
    // 让 SDK 知道下一轮要 reply tool_result. 在底部 stop_reason 映射之前 mark 一下.
    const _hasXmlToolUse = content.some((b) => b.type === 'tool_use')
                            && !Array.isArray(msg.tool_calls);
    // 至少要有一个 block, 否则 SDK 会抱怨
    if (!content.length) content.push({ type: 'text', text: '' });

    // finish_reason 映射
    let stop_reason = 'end_turn';
    if (finish === 'length') stop_reason = 'max_tokens';
    else if (finish === 'tool_calls' || finish === 'function_call') stop_reason = 'tool_use';
    else if (finish === 'stop') stop_reason = 'end_turn';
    else if (finish === 'content_filter') stop_reason = 'end_turn';
    // 0.3.260: XML tool_use 被检测出来时, 即使 upstream finish=stop 也升为 tool_use,
    // 让 SDK 知道 assistant 要 tool 结果. 不然 SDK 看 end_turn 就停了不发 tool_result.
    if (_hasXmlToolUse) stop_reason = 'tool_use';

    return {
      id: openaiResp?.id || `msg_${Math.random().toString(36).slice(2, 12)}`,
      type: 'message',
      role: 'assistant',
      model: anthropicReq.model || this.upstreamModel,
      content,
      stop_reason,
      stop_sequence: null,
      usage: {
        input_tokens: openaiResp?.usage?.prompt_tokens || 0,
        output_tokens: openaiResp?.usage?.completion_tokens || 0,
      },
    };
  }

  // ============================================================
  // Streaming proxy
  // ============================================================
  _proxyStream(openaiReq, anthropicReq, clientRes) {
    // 0.3.246: 不能用前导 '/chat/completions' — `new URL(absolute_path, base)` 会
    // 把 base 的 pathname 整个吃掉, 只保留 origin. 用户填 BASE=`https://x.com/v1/openai`
    // 会被拼成 `https://x.com/chat/completions` (掉了 `/v1/openai`) → 404. 改成 relative.
    const _normBase = this.upstreamBaseUrl.endsWith('/') ? this.upstreamBaseUrl : this.upstreamBaseUrl + '/';
    const url = new URL('chat/completions', _normBase);
    const lib = url.protocol === 'https:' ? https : http;
    const reqBody = JSON.stringify(openaiReq);

    // Anthropic SSE 设置 — 必须 chunked, content-type: text/event-stream
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendEvent = (event, data) => {
      try {
        clientRes.write(`event: ${event}\n`);
        clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    // 状态机
    const msgId = `msg_${Math.random().toString(36).slice(2, 12)}`;
    let messageStarted = false;
    let currentBlockIndex = -1;
    let currentBlockType = null;   // 'text' | 'thinking' | 'tool_use'
    let toolCallsState = new Map();   // index → { id, name, args_buffer, anthropic_block_index }
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = null;

    const closeCurrentBlock = () => {
      if (currentBlockIndex >= 0) {
        sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
      }
    };

    const openTextBlock = () => {
      closeCurrentBlock();
      currentBlockIndex += 1;
      currentBlockType = 'text';
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIndex,
        content_block: { type: 'text', text: '' },
      });
    };

    const openThinkingBlock = () => {
      closeCurrentBlock();
      currentBlockIndex += 1;
      currentBlockType = 'thinking';
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
    };

    const openToolUseBlock = (tcIndex, id, name) => {
      closeCurrentBlock();
      currentBlockIndex += 1;
      currentBlockType = 'tool_use';
      toolCallsState.set(tcIndex, {
        id: id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: name || 'unknown',
        args_buffer: '',
        anthropic_block_index: currentBlockIndex,
      });
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIndex,
        content_block: {
          type: 'tool_use',
          id: toolCallsState.get(tcIndex).id,
          name: toolCallsState.get(tcIndex).name,
          input: {},
        },
      });
    };

    const upstreamReq = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${this.upstreamApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(reqBody),
        'User-Agent': _OUTBOUND_UA,   // 0.3.291: 防 Cloudflare 1010
      },
      timeout: 300_000,    // SSE 长 — 5min
    }, (upRes) => {
      if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
        // 错误 — 不能再走 SSE (headers 已发), 拼一条 error event
        let errChunks = '';
        upRes.on('data', (c) => errChunks += c.toString('utf8'));
        upRes.on('end', () => {
          this.log(`upstream stream HTTP ${upRes.statusCode}: ${errChunks.slice(0, 200)}`);
          sendEvent('error', {
            type: 'error',
            error: {
              type: 'upstream_error',
              message: `HTTP ${upRes.statusCode}: ${errChunks.slice(0, 500)}`,
            },
          });
          try { clientRes.end(); } catch {}
        });
        return;
      }

      let buf = '';
      upRes.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        // 按 \n\n 切 SSE event
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // 每个 event 可能多行, 找 data: 行
          let dataLine = '';
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('data:')) {
              dataLine += line.slice(5).trim();
            }
          }
          if (!dataLine) continue;
          if (dataLine === '[DONE]') {
            // 结束 — emit message_delta + message_stop
            closeCurrentBlock();
            let stop_reason = 'end_turn';
            if (finishReason === 'length') stop_reason = 'max_tokens';
            else if (finishReason === 'tool_calls' || finishReason === 'function_call') stop_reason = 'tool_use';
            sendEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason, stop_sequence: null },
              usage: { output_tokens: outputTokens },
            });
            sendEvent('message_stop', { type: 'message_stop' });
            try { clientRes.end(); } catch {}
            continue;
          }
          let chunkJson;
          try { chunkJson = JSON.parse(dataLine); }
          catch { continue; }
          this._handleOpenaiChunk(chunkJson, {
            sendEvent,
            ensureMessageStart: () => {
              if (!messageStarted) {
                messageStarted = true;
                sendEvent('message_start', {
                  type: 'message_start',
                  message: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    model: anthropicReq.model || this.upstreamModel,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                  },
                });
              }
            },
            getCurrentBlockType: () => currentBlockType,
            getCurrentBlockIndex: () => currentBlockIndex,
            openTextBlock,
            openThinkingBlock,
            openToolUseBlock,
            updateToolUseArgs: (tcIndex, deltaArgs) => {
              const st = toolCallsState.get(tcIndex);
              if (!st) return;
              st.args_buffer += deltaArgs || '';
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: st.anthropic_block_index,
                delta: { type: 'input_json_delta', partial_json: deltaArgs || '' },
              });
            },
            recordFinish: (r) => { finishReason = r; },
            recordUsage: (u) => {
              if (u?.prompt_tokens) inputTokens = u.prompt_tokens;
              if (u?.completion_tokens) outputTokens = u.completion_tokens;
            },
          });
        }
      });
      upRes.on('end', () => {
        // 没收到 [DONE] 也要 finalize
        if (messageStarted) {
          closeCurrentBlock();
          let stop_reason = 'end_turn';
          if (finishReason === 'length') stop_reason = 'max_tokens';
          else if (finishReason === 'tool_calls' || finishReason === 'function_call') stop_reason = 'tool_use';
          sendEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          sendEvent('message_stop', { type: 'message_stop' });
        }
        try { clientRes.end(); } catch {}
      });
      upRes.on('error', (e) => {
        this.log(`upstream stream error: ${e.message}`);
        sendEvent('error', {
          type: 'error',
          error: { type: 'upstream_error', message: e.message },
        });
        try { clientRes.end(); } catch {}
      });
    });
    upstreamReq.on('error', (e) => {
      this.log(`upstream connect error: ${e.message}`);
      sendEvent('error', {
        type: 'error',
        error: { type: 'connect_error', message: e.message },
      });
      try { clientRes.end(); } catch {}
    });
    upstreamReq.write(reqBody);
    upstreamReq.end();
  }

  // ============================================================
  // 处理一条 OpenAI SSE chunk — 翻译成 0+ 个 Anthropic SSE event
  // ============================================================
  _handleOpenaiChunk(chunk, ctx) {
    ctx.ensureMessageStart();
    if (chunk.usage) ctx.recordUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (choice.finish_reason) ctx.recordFinish(choice.finish_reason);

    // reasoning_content → thinking block
    const reasoning = delta.reasoning_content;
    if (reasoning && typeof reasoning === 'string') {
      if (ctx.getCurrentBlockType() !== 'thinking') {
        ctx.openThinkingBlock();
      }
      ctx.sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: ctx.getCurrentBlockIndex(),
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }

    // content → text block
    if (delta.content && typeof delta.content === 'string') {
      if (ctx.getCurrentBlockType() !== 'text') {
        ctx.openTextBlock();
      }
      ctx.sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: ctx.getCurrentBlockIndex(),
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // tool_calls → tool_use block
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;
        // First chunk for this tool_call usually has id + function.name; subsequent only have arguments delta
        if (tc.id || tc.function?.name) {
          ctx.openToolUseBlock(tcIndex, tc.id, tc.function?.name);
        }
        if (tc.function?.arguments) {
          ctx.updateToolUseArgs(tcIndex, tc.function.arguments);
        }
      }
    }
  }
}

// ============================================================
// 0.3.260: XML-style tool_call 解析 (Qwen / 国产模型常见格式)
// ============================================================
// 这些 model 把 tool call 嵌入到 msg.content (普通文本) 而不是 msg.tool_calls.
// 格式样本 (实测用户撞):
//   <tool_call>
//   <function=mcp__easydeal__get_account>
//   </function>
//   </tool_call>
// 或带参数 (Qwen 标准):
//   <tool_call>
//   <function=name>
//   <parameter=key>value</parameter>
//   <parameter=k2>v2</parameter>
//   </function>
//   </tool_call>
//
// 返回 { text: <剥离 XML 后的 plain text>, toolUses: [<anthropic tool_use blocks>] }.
const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const FUNCTION_NAME_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/;
const PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;

function _parseXmlToolCalls(content) {
  const toolUses = [];
  // 替换每个 <tool_call>...</tool_call> 块为空字符串, 同时收集 tool_use
  const text = content.replace(TOOL_CALL_BLOCK_RE, (_match, inner) => {
    const fnMatch = FUNCTION_NAME_RE.exec(inner);
    if (!fnMatch) return '';   // 格式不对, 丢
    const name = fnMatch[1].trim();
    const paramBlob = fnMatch[2];
    const input = {};
    let pm;
    PARAMETER_RE.lastIndex = 0;
    while ((pm = PARAMETER_RE.exec(paramBlob)) !== null) {
      const key = pm[1].trim();
      let val = (pm[2] || '').trim();
      // 尝试 JSON parse — 数字 / boolean / object 直接转
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (val === 'null') val = null;
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      else if ((val.startsWith('{') && val.endsWith('}'))
            || (val.startsWith('[') && val.endsWith(']'))) {
        try { val = JSON.parse(val); } catch { /* 留 string */ }
      }
      input[key] = val;
    }
    toolUses.push({
      type: 'tool_use',
      id: `toolu_${Math.random().toString(36).slice(2, 12)}`,
      name,
      input,
    });
    return '';   // 把 XML 块从 text 移除
  });
  return { text: text.trim(), toolUses };
}

module.exports = { OpenAIProxyServer };
