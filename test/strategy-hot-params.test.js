'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deleteHotParamFiles, normalizeEaStem } = require('../electron/strategy-hot-params');

test('deleteHotParamFiles removes runtime and remount parameter overrides only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-hot-params-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const filesDir = path.join(root, 'MQL5', 'Files');
  const presetsDir = path.join(root, 'MQL5', 'Presets');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });

  const config = path.join(filesDir, 'GMarket_wl_config.set');
  const runtime = path.join(filesDir, 'GMarket_wl_runtime.json');
  const preset = path.join(presetsDir, 'GMarket_wl.set');
  fs.writeFileSync(config, 'Risk=1');
  fs.writeFileSync(runtime, '{"Risk":1}');
  fs.writeFileSync(preset, 'Risk=1');

  const result = await deleteHotParamFiles({ eaName: 'folder/GMarket_wl.mq5', roots: [root, root] });

  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 2);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(preset), false);
  assert.equal(fs.existsSync(runtime), true, 'runtime snapshot must reflect the still-running EA');
});

test('deleteHotParamFiles is idempotent when parameter files do not exist', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-hot-params-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await deleteHotParamFiles({ eaName: 'GMarket_wl', roots: [root] });
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 0);
  assert.equal(result.missing.length, 2);
});

test('EA stem validation rejects traversal and invalid names', () => {
  assert.equal(normalizeEaStem('folder/GMarket_wl.ex5'), 'GMarket_wl');
  assert.throws(() => normalizeEaStem('../..'), /无效/);
  assert.throws(() => normalizeEaStem('bad:name'), /无效/);
});

test('renderer and preload expose the delete-hot-file action', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'strategies-view.js'), 'utf8');
  assert.match(preload, /strategies:params-delete-hot-file/);
  assert.match(view, /删除热参文件/);
  assert.match(view, /paramsDeleteHotFile/);
});
