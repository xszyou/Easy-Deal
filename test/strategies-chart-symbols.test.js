'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Strategies } = require('../electron/strategies');

const pad = (n, w = 2) => String(n).padStart(w, '0');

// MT5 日志: 当天文件, UTF-16 LE + BOM; 行按给定顺序依次晚 1ms
function writeLog(dataDir, lines) {
  const now = new Date();
  const dir = path.join(dataDir, 'Logs');
  fs.mkdirSync(dir, { recursive: true });
  const base = new Date(now.getTime() - 60_000);
  const body = lines.map((line, i) => {
    const t = new Date(base.getTime() + i);
    const hms = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
    return `KX\t0\t${hms}\t${line}`;
  }).join('\r\n');
  const name = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.log`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(`﻿${body}\r\n`, 'utf16le'));
}

function writeChart(dataDir, file, symbol, ea) {
  const dir = path.join(dataDir, 'MQL5', 'Profiles', 'Charts', 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const expert = ea ? `<expert>\r\nname=${ea}\r\nexpertmode=1\r\n</expert>\r\n` : '';
  fs.writeFileSync(path.join(dir, file),
    Buffer.from(`﻿<chart>\r\nsymbol=${symbol}\r\nperiod_type=1\r\nperiod_size=1\r\n${expert}</chart>\r\n`, 'utf16le'));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-chart-symbols-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { strategies: new Strategies(path.join(root, 'ws'), root), dataDir };
}

test('日志: 只留现在挂着 EA 的图表品种(撤掉的图表不算)', async (t) => {
  const { strategies, dataDir } = fixture(t);
  writeLog(dataDir, [
    'Experts\texpert GMarket (XAUUSD,H1) loaded successfully',
    'Experts\texpert GMarket (BTCUSD,M5) loaded successfully',
    'Experts\texpert Grid (EURUSD,M15) loaded successfully',
    'Experts\texpert GMarket (BTCUSD,M5) removed',
    'Scalper (GBPUSD,M1)\t开仓信号',
    'Experts\texpert Old (USDJPY,H1) loaded successfully',
    'Experts\texpert Old (USDJPY,H1) removed',
  ]);
  const symbols = await strategies.runningChartSymbols({ mt5DataDir: dataDir });
  assert.deepEqual(symbols.sort(), ['EURUSD', 'GBPUSD', 'XAUUSD']);
});

test('同一品种多个 EA 窗口只出一次; 撤掉后重新挂上算在跑', async (t) => {
  const { strategies, dataDir } = fixture(t);
  writeLog(dataDir, [
    'Experts\texpert A (XAUUSD,H1) loaded successfully',
    'Experts\texpert B (XAUUSD,M5) loaded successfully',
    'Experts\texpert C (EURUSD,M1) loaded successfully',
    'Experts\texpert C (EURUSD,M1) removed',
    'Experts\texpert C (EURUSD,M1) loaded successfully',
  ]);
  assert.deepEqual((await strategies.runningChartSymbols({ mt5DataDir: dataDir })).sort(), ['EURUSD', 'XAUUSD']);
});

test('.chr: 日志里没有在跑图表的 EA 用 .chr 的图表品种; 没挂 EA 的图表不算', async (t) => {
  const { strategies, dataDir } = fixture(t);
  writeLog(dataDir, ['Experts\texpert GMarket (XAUUSD,H1) loaded successfully']);
  writeChart(dataDir, 'chart01.chr', 'USDJPY', 'Quiet');
  writeChart(dataDir, 'chart02.chr', 'XAUUSD', 'GMarket');
  writeChart(dataDir, 'chart03.chr', 'EURUSD', null);
  assert.deepEqual((await strategies.runningChartSymbols({ mt5DataDir: dataDir })).sort(), ['USDJPY', 'XAUUSD']);
});

test('没有日志也没有图表 → 空', async (t) => {
  const { strategies, dataDir } = fixture(t);
  assert.deepEqual(await strategies.runningChartSymbols({ mt5DataDir: dataDir }), []);
});
