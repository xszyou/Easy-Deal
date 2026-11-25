'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Strategies } = require('../electron/strategies');

test('monitor marker update preserves source timestamp and collapses duplicate markers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-monitor-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const strategiesDir = path.join(workspace, 'strategies');
  fs.mkdirSync(strategiesDir, { recursive: true });

  const mq5 = path.join(strategiesDir, 'DemoEA.mq5');
  fs.writeFileSync(mq5,
    '//@easydeal symbol=XAUUSDm magic=999\r\n' +
    '#property strict\r\n' +
    '// @easydeal symbol=XAUUSD magic=999\r\n' +
    'input int InpMagicNumber = 999;\r\n',
    'utf8');
  const fixed = new Date('2026-08-29T10:12:07.000Z');
  fs.utimesSync(mq5, fixed, fixed);
  const before = fs.statSync(mq5);

  const strategies = new Strategies(workspace, path.join(root, 'data'));
  await strategies._writeEasydealMarkerToMq5('DemoEA', 'XAUUSDc', 888);

  const after = fs.statSync(mq5);
  const source = fs.readFileSync(mq5, 'utf8');
  assert.equal(after.mtimeMs, before.mtimeMs, 'metadata-only marker must not make the EX5 stale');
  assert.equal(after.birthtimeMs, before.birthtimeMs, 'metadata-only marker must not reorder the strategy');
  assert.equal((source.match(/@easydeal/g) || []).length, 1);
  assert.match(source, /^\/\/@easydeal symbol=XAUUSDc magic=888\r?\n/);
  assert.match(source, /input int InpMagicNumber = 999;/);
  assert.equal(fs.existsSync(mq5 + '.easydeal-marker.bak'), false);
});

test('unchanged monitor marker is a no-op', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-monitor-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const strategiesDir = path.join(workspace, 'strategies');
  fs.mkdirSync(strategiesDir, { recursive: true });
  const mq5 = path.join(strategiesDir, 'DemoEA.mq5');
  fs.writeFileSync(mq5, '//@easydeal symbol=XAUUSDc magic=888\nvoid OnTick() {}\n', 'utf8');
  const before = fs.statSync(mq5);

  const strategies = new Strategies(workspace, path.join(root, 'data'));
  await strategies._writeEasydealMarkerToMq5('DemoEA', 'XAUUSDc', 888);

  const after = fs.statSync(mq5);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(mq5, 'utf8'), '//@easydeal symbol=XAUUSDc magic=888\nvoid OnTick() {}\n');
});
