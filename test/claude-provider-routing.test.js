'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { TokenStore } = require('../electron/token-store');
const { withClaudeModelArg } = require('../electron/claude-runner');

const binary = path.join(__dirname, '../node_modules/@anthropic-ai/claude-code/bin',
  process.platform === 'win32' ? 'claude.exe' : 'claude');

test('bundled CLI sends the next custom turn to the saved endpoint with the saved model', {
  skip: !fs.existsSync(binary) && 'bundled CLI is unavailable',
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url.split('?')[0].endsWith('/v1/messages')) {
      requests.push({
        path: req.url.split('?')[0], model: JSON.parse(Buffer.concat(chunks)).model,
        auth: req.headers.authorization,
      });
    }
    // Stop after capturing the outgoing request, before any model or tool runs.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test endpoint' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(dir, 'claude');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: base + '/cc-switch',
      ANTHROPIC_AUTH_TOKEN: 'system-token',
      ANTHROPIC_MODEL: 'claude-opus-4-6',
    },
  }));
  const store = new TokenStore(dir);
  await store.setMode('custom');
  await store.setCustom({ base_url: base + '/custom', api_key: 'custom-token' });
  async function checkTurn(route, model, token) {
    const { env } = store.spawnEnvOverrides();
    const args = withClaudeModelArg(['--print', '--tools', '', '--', 'ping'], env);
    const childEnv = {
      CLAUDE_CONFIG_DIR: configDir, HOME: dir, USERPROFILE: dir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '*', ...env,
    };
    for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles']) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }
    const run = execFile(binary, args, { cwd: dir, env: childEnv, timeout: 30000, windowsHide: true });
    run.child.stdin.end();
    await assert.rejects(run, error => {
      assert.match(error.stdout + error.stderr, /test endpoint/);
      return true;
    });
    assert.deepEqual(requests.splice(0), [
      { path: `/${route}/v1/messages`, model, auth: `Bearer ${token}` },
    ]);
  }
  for (const model of ['gpt-first', 'gpt-second']) {
    await store.setCustom({ model });
    await checkTurn('custom', model, 'custom-token');
  }
  await store.setMode('system');
  await store.setSystem({ model: '' });
  await checkTurn('cc-switch', 'claude-opus-4-6', 'system-token');
});
