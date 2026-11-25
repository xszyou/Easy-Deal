const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TokenStore } = require('../electron/token-store');


test('community edition defaults to the system channel and has no Fay mode', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-token-community-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new TokenStore(dataDir);
  await store.init();
  assert.equal(store.getMasked().mode, 'system');
  assert.equal(store.getMasked().context.server_window_tokens, null);
  await assert.rejects(store.setMode('fay'), /bad mode: fay/);
});


test('codex cli is a persisted fourth token mode with local placeholders', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-token-codex-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new TokenStore(dataDir);
  await store.init();
  await store.setMode('codex');
  await store.setCodex({ model: 'gpt-manual-test' });
  await store.setContext({ mode: 'manual', window_tokens: 240000 });

  assert.equal(store.getMasked().mode, 'codex');
  assert.equal(store.getMasked().codex.label, 'codex cli');
  assert.equal(store.getMasked().codex.model, 'gpt-manual-test');
  assert.deepEqual(store.getMasked().context, {
    mode: 'manual', window_tokens: 240000, min_tokens: 16000, max_tokens: 1000000,
    server_window_tokens: null,
  });
  await assert.rejects(
    store.setContext({ mode: 'manual', window_tokens: 1 }),
    /上下文窗口必须是/,
  );
  assert.equal(store.getMasked().context.window_tokens, 240000);
  assert.equal(store.endpointFingerprint(), 'codex-cli');
  assert.deepEqual(store.envKeysToStripBeforeSpawn(), [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  ]);

  const spawn = store.spawnEnvOverrides();
  assert.equal(spawn.mode, 'codex');
  assert.equal(spawn.env.ANTHROPIC_BASE_URL, '__EASYDEAL_CODEX_BRIDGE__');
  assert.equal(spawn.env.ANTHROPIC_AUTH_TOKEN, '__EASYDEAL_CODEX_BRIDGE_TOKEN__');
  assert.equal(spawn.env.ANTHROPIC_MODEL, undefined);

  const reloaded = new TokenStore(dataDir);
  await reloaded.init();
  assert.equal(reloaded.getMasked().mode, 'codex');
  assert.equal(reloaded.getMasked().codex.model, 'gpt-manual-test');
  assert.equal(reloaded.getMasked().context.window_tokens, 240000);
});

test('codex placeholder is replaced only after authenticated bridge startup', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-token-bridge-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new TokenStore(dataDir);
  await store.setMode('codex');
  await store.setCodex({ model: 'gpt-runtime-test' });
  await store.setContext({ mode: 'manual', window_tokens: 200000 });
  await store.setProxy({ mode: 'manual', url: 'http://127.0.0.1:7890' });
  let starts = 0;
  let runtime = null;
  store._codexBridge = {
    start: async (options) => {
      starts += 1;
      runtime = options;
      return { base_url: 'http://127.0.0.1:54321', token: 'local-random-token' };
    },
    stop: async () => {},
  };
  const env = store.spawnEnvOverrides().env;
  await store.ensureLocalBridgeAndReplace(env);
  assert.equal(starts, 1);
  assert.deepEqual(runtime, {
    model: 'gpt-runtime-test', proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890',
    contextChars: 800000,
  });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:54321');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-random-token');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.doesNotMatch(JSON.stringify(store.getMasked()), /local-random-token/);
});

test('Codex manual context is clamped to the CLI character hard limit', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-token-codex-hard-limit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new TokenStore(dataDir);
  await store.setMode('codex');
  await store.setContext({ mode: 'manual', window_tokens: 1_000_000 });
  assert.equal(store._codexRuntimeConfig().contextChars, 1_048_576);
});

test('Token UI displays codex cli as the third of three choices', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'views', 'token-view.js'), 'utf8',
  );
  const modes = [...source.matchAll(/class="tk-mode-card" data-mode="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(modes, ['system', 'custom', 'codex']);
  assert.match(source, /tk-mode-title">⌨️ codex cli</);
  assert.match(source, /<span class="sub">三选一<\/span>/);
  assert.match(source, /id="tk-buy-guide"/);
  assert.match(source, /tcn83aar80mf\.feishu\.cn\/wiki\/WRAWw0V1giFwQbkdgvzcw5JunSe/);
  assert.match(source, /id="tk-codex-model"/);
  assert.match(source, /token\.setCodex\(\{ model \}\)/);
  const settingsView = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'views', 'settings-view.js'), 'utf8',
  );
  assert.match(settingsView, /AI 上下文窗口/);
  assert.match(settingsView, /token\.setContext/);
  assert.match(settingsView, /服务器返回/);
});

test('chat UI exposes recoverable Claude sessions and restore action', () => {
  const view = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'views', 'chat-view.js'), 'utf8',
  );
  const preload = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'preload.js'), 'utf8',
  );
  const main = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8',
  );
  assert.match(view, /id="chat-session-history"/);
  assert.match(view, /共 \$\{count\} 条消息/);
  assert.match(view, /recoverableSessions\(_sk\)/);
  assert.match(view, /restoreSession\(_sk, sessionId\)/);
  assert.match(preload, /chat:recoverable-sessions/);
  assert.match(preload, /chat:restore-session/);
  assert.match(main, /listRecoverableSessions\(40\)/);
  assert.match(main, /restoreClaudeSession\(sessionId\)/);
});
