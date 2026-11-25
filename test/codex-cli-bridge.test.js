const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CodexCliBridge, resolveCodexBin, resolvePythonBin, _normalizeRuntime, _applyProxyEnv,
} = require('../electron/codex-cli-bridge');
const {
  ChatSession, extractRemoteClientKeys, canResumeEndpoint, endpointResumeDecision, parseClaudeSessionLog,
  claudeProjectDir,
} = require('../electron/chat-session');


test('explicit Codex CLI executable wins discovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.writeFileSync(bin, 'fixture');
  assert.equal(resolveCodexBin(bin), path.resolve(bin));
});

test('Python executable can be resolved from PATH', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-python-bin-'));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const filename = process.platform === 'win32' ? 'easydeal-python.exe' : 'easydeal-python';
  const bin = path.join(root, filename);
  fs.writeFileSync(bin, 'fixture');
  process.env.PATH = root;
  assert.equal(resolvePythonBin('easydeal-python'), path.resolve(bin));
});

test('manual Token proxy is applied to every Codex proxy environment key', () => {
  const env = _applyProxyEnv({ NO_PROXY: '*' }, {
    proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890', model: '',
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
  assert.doesNotMatch(env.NO_PROXY, /^\*$/);
});

test('Codex bridge runtime cannot exceed the CLI one-MiB character limit', () => {
  assert.equal(_normalizeRuntime({ contextChars: 4_000_000 }).contextChars, 1_048_576);
  assert.equal(_normalizeRuntime({ contextChars: 800_000 }).contextChars, 800_000);
});

test('Codex bridge allows a 30-minute turn by default', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'python', 'easydeal_codex_cli_bridge.py'), 'utf8',
  );
  assert.match(
    source,
    /EASYDEAL_CODEX_REQUEST_TIMEOUT_SECONDS[\s\S]{0,80}"1800"/,
  );
});

test('scheduled remote keys are extracted uniquely from legacy task text', () => {
  assert.deepEqual(
    extractRemoteClientKeys(
      '用户 EZDL-AAAA-1111',
      'use mcp__remote_EZDL_AAAA_1111 and ezdl-aaaa-1111; compare EZDL-BBBB-2222',
    ),
    ['EZDL-AAAA-1111', 'EZDL-BBBB-2222'],
  );
  assert.equal(
    ChatSession.remoteServerName('EZDL-AAAA-1111', 0, 1, true),
    'remote_EZDL_AAAA_1111',
  );
});

test('turn-scoped remote target does not replace persisted chat attachment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-task-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: { endpointFingerprint: () => 'codex-cli', data: { mode: 'codex' } },
  });
  chat.remoteAttachments = [
    { clientKey: 'EZDL-BBBB-2222', note: 'demo-b', scope: 'read' },
  ];
  let observedPrompt = '';
  let observedContext = null;
  chat._runClaude = async (prompt, assistantTurn) => {
    observedPrompt = prompt;
    observedContext = assistantTurn._remoteRunContext;
    return '任务完成';
  };
  const result = await chat.send('[scheduled-trigger:test]\n检查目标', [], {
    remoteAttachments: [
      { clientKey: 'EZDL-AAAA-1111', note: 'demo-a', scope: 'read' },
    ],
    forceQualifiedRemoteNames: true,
  });
  assert.equal(result.ok, true);
  assert.match(observedPrompt, /remote_EZDL_AAAA_1111/);
  assert.deepEqual(observedContext.attachments.map((a) => a.clientKey), ['EZDL-AAAA-1111']);
  assert.deepEqual(chat.getRemoteAttachments().map((a) => a.clientKey), ['EZDL-BBBB-2222']);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'chat.json'), 'utf8'));
  assert.deepEqual(saved.remoteAttachments.map((a) => a.clientKey), ['EZDL-BBBB-2222']);
});

test('bridge manager starts, authenticates health, and stops cleanly', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows packaged runtime integration');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeCodex = path.join(root, 'codex.cmd');
  fs.writeFileSync(fakeCodex, '@echo off\r\necho Logged in using ChatGPT\r\nexit /b 0\r\n');
  const repo = path.resolve(__dirname, '..');
  const pythonBin = path.join(repo, 'python-runtime', 'python.exe');
  const scriptPath = path.join(repo, 'python', 'easydeal_codex_cli_bridge.py');
  if (!fs.existsSync(pythonBin)) return t.skip('bundled Python runtime unavailable');

  const bridge = new CodexCliBridge({
    pythonBin, scriptPath, workspaceDir: root, codexBin: fakeCodex,
  });
  t.after(async () => bridge.stop());
  const started = await bridge.start({
    model: 'gpt-easydeal-test',
    proxyMode: 'manual',
    proxyUrl: 'http://127.0.0.1:7890',
  });
  assert.equal(started.ok, true);
  assert.equal(started.login_ok, true);
  assert.equal(started.model, 'gpt-easydeal-test');
  assert.equal(started.proxy_mode, 'manual');
  assert.match(started.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(started.token.length >= 48);
  const status = await bridge.status({ start: false });
  assert.equal(status.ok, true);
  assert.equal(status.running, true);
  await bridge.stop();
  assert.equal(bridge.child, null);
});

test('Codex chat warmup is skipped to avoid a duplicate model request', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'chat-session.js'), 'utf8',
  );
  assert.match(source, /mode === 'codex'[\s\S]{0,300}skipped: 'codex-cli'/);
});

test('provider switches preserve context except when returning to Claude subscription', () => {
  assert.equal(canResumeEndpoint('codex-cli', 'codex-cli:gpt-5.6-sol'), true);
  assert.equal(canResumeEndpoint('codex-cli:default', 'codex-cli'), true);
  assert.equal(canResumeEndpoint('custom:https://a:model-a', 'custom:https://a:model-b'), true);
  assert.equal(canResumeEndpoint('fay', 'custom:https://b:model-c'), true);
  assert.deepEqual(
    endpointResumeDecision('codex-cli', 'system'),
    { resume: false, reason: 'switch-to-claude-subscription' },
  );
  assert.equal(canResumeEndpoint('system', 'codex-cli'), true);
});

test('switching back to Claude subscription announces the split and carries recent context', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-provider-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: { endpointFingerprint: () => 'system', data: { mode: 'system' } },
  });
  chat.history = [
    { id: 'old-user', role: 'user', content: '旧问题', ts: 1 },
    { id: 'old-ai', role: 'assistant', content: '旧答案', ts: 2 },
  ];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'codex-cli';
  let prompt = '';
  chat._runClaude = async (value) => { prompt = value; return '已继续'; };
  const result = await chat.send('新问题');
  assert.equal(result.ok, true);
  assert.equal(chat.lastSessionId, null);
  assert.match(prompt, /因切换到 Claude 订阅已新建会话/);
  assert.match(prompt, /用户：旧问题/);
  assert.match(prompt, /AI：旧答案/);
  assert.ok(chat.history.some((t) => t.systemNote && /原会话仍保留/.test(t.content)));
});

test('Codex bridge character overflow compacts and retries in a fresh session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-overflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: { endpointFingerprint: () => 'codex-cli', data: { mode: 'codex' } },
  });
  chat.history = [
    { id: 'old-user', role: 'user', content: '此前的问题', ts: 1 },
    { id: 'old-ai', role: 'assistant', content: '此前的结论', ts: 2 },
  ];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'codex-cli';
  const prompts = [];
  chat._runClaude = async (prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      return 'API Error: 502 conversation context is 605438 characters, above the configured 600000 character limit; bridge refused to silently truncate it';
    }
    return '压缩后继续完成';
  };
  const result = await chat.send('继续处理');
  assert.equal(result.ok, true);
  assert.equal(result.content, '压缩后继续完成');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /因对话过长已自动压缩并新建会话/);
  assert.match(prompts[1], /此前的问题/);
  assert.ok(chat.history.some((turn) => turn.systemNote && /已自动把之前的对话压缩成摘要/.test(turn.content)));
});

test('Codex CLI input_too_large error compacts and retries instead of surfacing as 502', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-hard-overflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: {
      endpointFingerprint: () => 'codex-cli',
      data: { mode: 'codex', context: { mode: 'manual', window_tokens: 1_000_000 } },
    },
  });
  chat.history = [
    { id: 'old-user', role: 'user', content: '正在执行的长任务', ts: 1 },
    { id: 'old-ai', role: 'assistant', content: '已经完成大部分步骤', ts: 2 },
  ];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'codex-cli';
  const prompts = [];
  chat._runClaude = async (prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      throw new Error('API Error: 502 Codex CLI exited 1: Input exceeds the maximum length of 1048576 characters. data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1053211}');
    }
    return '压缩上下文后确认已跑完';
  };
  const result = await chat.send('跑完了吗');
  assert.equal(result.ok, true);
  assert.equal(result.content, '压缩上下文后确认已跑完');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /因对话过长已自动压缩并新建会话/);
  assert.match(prompts[1], /正在执行的长任务/);
});

test('one-million manual setting still proactively compacts Codex at its character cap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-manual-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: {
      endpointFingerprint: () => 'codex-cli',
      data: { mode: 'codex', context: { mode: 'manual', window_tokens: 1_000_000 } },
    },
  });
  chat.history = [{ id: 'old-user', role: 'user', content: '保留长任务要点', ts: 1 }];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'codex-cli';
  chat._lastContextTokens = 210_000;
  let prompt = '';
  chat._runClaude = async (value) => { prompt = value; return '继续完成'; };
  const result = await chat.send('继续');
  assert.equal(result.ok, true);
  assert.equal(result.content, '继续完成');
  assert.equal(chat.lastSessionId, null);
  assert.match(prompt, /因对话过长已自动压缩并新建会话/);
});

test('Codex proactive compaction ignores a stale Fay context window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-codex-proactive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: {
      endpointFingerprint: () => 'codex-cli',
      data: { mode: 'codex', fay: { context_window: 1_000_000 } },
    },
  });
  chat.history = [{ id: 'old-user', role: 'user', content: '保留要点', ts: 1 }];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'codex-cli';
  chat._lastContextTokens = 121_000;
  let prompt = '';
  chat._runClaude = async (value) => { prompt = value; return '已继续'; };
  const result = await chat.send('下一步');
  assert.equal(result.ok, true);
  assert.equal(chat.lastSessionId, null);
  assert.match(prompt, /因对话过长已自动压缩并新建会话/);
  assert.ok(chat.history.some((turn) => turn.systemNote && /对话较长/.test(turn.content)));
});

test('manual context window proactively compacts every provider mode', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-global-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = new ChatSession({
    workspaceDir: root, dataDir: root,
    tokenStore: {
      endpointFingerprint: () => 'system',
      data: { mode: 'system', context: { mode: 'manual', window_tokens: 100000 } },
    },
  });
  chat.history = [{ id: 'old-user', role: 'user', content: '全局要点', ts: 1 }];
  chat.lastSessionId = '11111111-2222-4333-8444-555555555555';
  chat.lastSessionEndpoint = 'system';
  chat._lastContextTokens = 86_000;
  let prompt = '';
  chat._runClaude = async (value) => { prompt = value; return '已继续'; };
  const result = await chat.send('继续');
  assert.equal(result.ok, true);
  assert.match(prompt, /因对话过长已自动压缩并新建会话/);
  assert.equal(chat.lastSessionId, null);
});

test('Claude history parser restores visible conversation without thinking or tool payloads', () => {
  const raw = [
    { type: 'ai-title', aiTitle: '下载历史数据', timestamp: '2026-08-29T13:20:00.000Z' },
    { type: 'user', timestamp: '2026-08-29T13:21:00.000Z', message: {
      role: 'user', content: '<live-state>private state</live-state>\n【用户当前消息】\n下载好了吗？',
    } },
    { type: 'assistant', timestamp: '2026-08-29T13:21:02.000Z', message: {
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'text', text: '已经下载完成。' },
        { type: 'tool_use', name: 'Read', input: { file: 'secret' } },
      ],
    } },
    { type: 'user', timestamp: '2026-08-29T13:21:03.000Z', message: {
      role: 'user', content: [{ type: 'tool_result', content: 'secret tool output' }],
    } },
  ].map((row) => JSON.stringify(row)).join('\n');
  const parsed = parseClaudeSessionLog(raw, { sessionId: 'test', includeHistory: true });
  assert.equal(parsed.title, '下载历史数据');
  assert.equal(parsed.preview, '下载好了吗？');
  assert.deepEqual(parsed.history.map((t) => [t.role, t.content]), [
    ['user', '下载好了吗？'],
    ['assistant', '已经下载完成。'],
  ]);
  assert.equal(parsed.history.every((t) => t.historical === true), true);
});

test('recoverable Claude session can be listed and restored without touching the original JSONL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-session-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const projectDir = claudeProjectDir(workspaceDir, homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const rows = [
    { type: 'ai-title', aiTitle: '旧会话测试', timestamp: '2026-08-29T13:20:00.000Z' },
    { type: 'user', timestamp: '2026-08-29T13:21:00.000Z', message: { role: 'user', content: '记住这个上下文' } },
    { type: 'assistant', timestamp: '2026-08-29T13:21:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '已经记住。' }] } },
  ].map((row) => JSON.stringify(row)).join('\n');
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, rows, 'utf8');
  const backgroundSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const backgroundRows = [
    { type: 'user', timestamp: '2026-08-29T13:22:00.000Z', message: { role: 'user', content: '[scheduled-trigger:timer-1]\n检查策略状态' } },
    { type: 'assistant', timestamp: '2026-08-29T13:22:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }] } },
  ].map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(path.join(projectDir, `${backgroundSessionId}.jsonl`), backgroundRows, 'utf8');
  const before = fs.readFileSync(jsonlPath, 'utf8');

  const chat = new ChatSession({
    workspaceDir, dataDir, claudeHomeDir: homeDir,
    tokenStore: { endpointFingerprint: () => 'codex-cli' },
  });
  const list = await chat.listRecoverableSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].session_id, sessionId);
  assert.equal(list.some((item) => item.session_id === backgroundSessionId), false);
  assert.equal(list[0].title, '旧会话测试');
  assert.equal(list[0].message_count, 2);
  assert.equal(list[0].user_message_count, 1);
  assert.equal(list[0].assistant_message_count, 1);
  const restored = await chat.restoreClaudeSession(sessionId);
  assert.equal(restored.ok, true);
  assert.equal(restored.turns, 2);
  assert.equal(chat.lastSessionId, sessionId);
  assert.equal(chat.lastSessionEndpoint, 'codex-cli');
  assert.equal(chat.history[0].content, '记住这个上下文');
  assert.match(chat.history.at(-1).content, /已恢复历史会话/);
  const commLog = fs.readFileSync(path.join(dataDir, 'ai-comm.jsonl'), 'utf8');
  assert.doesNotMatch(commLog, /记住这个上下文|已经记住/);
  assert.match(commLog, /已恢复历史会话/);
  assert.equal(fs.readFileSync(jsonlPath, 'utf8'), before);
});
