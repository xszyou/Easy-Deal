const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inferLaunchMode,
  normalizeMt5Instance,
  planMt5VerificationRetry,
  reconcileMissingMt5Process,
  validateMt5Instance,
} = require('../electron/mt5-instance');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-mt5-'));
  const install = path.join(root, 'terminal-a');
  const data = path.join(root, 'data-a');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(install, 'terminal64.exe'), 'fixture');
  fs.writeFileSync(path.join(data, 'origin.txt'), `\ufeff${install}`, 'utf16le');
  return { root, install, data };
}

test('launch mode is derived only from configured paths', () => {
  assert.equal(inferLaunchMode('D:\\mt5', 'd:/mt5'), 'portable');
  assert.equal(inferLaunchMode('D:\\mt5', 'C:\\Users\\u\\AppData\\MT5'), 'standard');
  assert.equal(inferLaunchMode('D:\\mt5', ''), 'unverified');
});

test('legacy records migrate to explicit stopped intent', () => {
  const out = normalizeMt5Instance({ id: 'old', installDir: 'D:\\mt5', dataDir: 'D:\\mt5' });
  assert.equal(out.user_intent, 'stopped');
  assert.equal(out.launchMode, 'portable');
  assert.equal(out.lifecycle_version, 2);
});

test('manual process exit becomes persistent stopped state after two observations', () => {
  const first = reconcileMissingMt5Process({
    userIntent: 'running', seenRunning: true, misses: 0,
  });
  assert.deepEqual(first, { state: 'stopping', misses: 1, action: 'wait' });
  const second = reconcileMissingMt5Process({
    userIntent: 'running', seenRunning: true, misses: first.misses,
  });
  assert.deepEqual(second, { state: 'stopped', misses: 0, action: 'persist_stop' });
});

test('authorized startup and explicit restart are not mistaken for user exit', () => {
  assert.equal(reconcileMissingMt5Process({
    userIntent: 'running', seenRunning: false, authorized: true,
  }).state, 'starting');
  assert.equal(reconcileMissingMt5Process({
    userIntent: 'running', seenRunning: true, authorized: true, restarting: true,
  }).state, 'starting');
});

test('portable instance requires identical install and data directory', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const ok = validateMt5Instance({
    id: 'p1', name: 'portable', installDir: f.install, dataDir: f.install,
    launchMode: 'portable', user_intent: 'stopped',
  });
  assert.equal(ok.ok, true);
  const bad = validateMt5Instance({
    id: 'p2', name: 'bad', installDir: f.install, dataDir: f.data,
    launchMode: 'portable', user_intent: 'stopped',
  });
  assert.equal(bad.ok, false);
});

test('standard instance accepts only an origin.txt owned by its install', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const good = validateMt5Instance({
    id: 's1', name: 'standard', installDir: f.install, dataDir: f.data,
    launchMode: 'standard', user_intent: 'stopped',
  });
  assert.equal(good.ok, true);

  fs.writeFileSync(path.join(f.data, 'origin.txt'), '\ufeffD:\\another-mt5', 'utf16le');
  const bad = validateMt5Instance({
    id: 's1', name: 'standard', installDir: f.install, dataDir: f.data,
    launchMode: 'standard', user_intent: 'stopped',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /另一套 MT5/);
});

test('two logical instances cannot share one executable directory', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = validateMt5Instance({
    id: 'two', name: 'two', installDir: f.install, dataDir: f.install,
    launchMode: 'portable', user_intent: 'stopped',
  }, { siblings: [{ id: 'one', name: 'one', installDir: f.install, dataDir: f.install }] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /独立程序目录/);
});

test('booting terminal waits out the attach gate without spending a verification attempt', () => {
  const next = planMt5VerificationRetry({
    reason: 'mt5 attach blocked: target_terminal_booting:age=9.6:required=60.0',
    attempt: 2, bootWaits: 0,
  });
  assert.deepEqual(next, { action: 'retry', delayMs: 52_400, attempt: 2, bootWaits: 1 });
  // A terminal that never stops looking young must not retry forever.
  assert.deepEqual(planMt5VerificationRetry({
    reason: 'mt5 attach blocked: target_terminal_booting:age=9.6:required=60.0',
    attempt: 2, bootWaits: 4,
  }), { action: 'fail' });
});

test('probe failures get three attempts and identity mismatch fails at once', () => {
  assert.deepEqual(planMt5VerificationRetry({ reason: 'probe parse failed: {', attempt: 0 }),
    { action: 'retry', delayMs: 30_000, attempt: 1, bootWaits: 0 });
  assert.deepEqual(planMt5VerificationRetry({ reason: 'probe parse failed: {', attempt: 2 }),
    { action: 'fail' });
  assert.deepEqual(planMt5VerificationRetry({
    reason: 'mt5 attach blocked: data_path_mismatch:D:\other', attempt: 0,
  }), { action: 'fail' });
});
