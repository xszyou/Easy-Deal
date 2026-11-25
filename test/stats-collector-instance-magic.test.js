'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Strategies } = require('../electron/strategies');
const { StatsCollector } = require('../electron/stats-collector');

// 真实的 Strategies(魔术号 / 实例绑定走策略页同款接口) + 上传桩: 记下 raw 成交和浮盈的上传内容
async function setup(t, eas, { activeId = 'A' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-stats-magic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'strategies'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const strategies = new Strategies(workspace, path.join(root, 'data'));
  await strategies.init();
  for (const [name, instanceId, magic] of eas) {
    fs.writeFileSync(path.join(workspace, 'strategies', name + '.mq5'), `// ${name}\nvoid OnTick() {}\n`, 'utf8');
    if (instanceId) await strategies.setMt5InstanceForEa(name, instanceId);
    await strategies.setMonitorConfig(name, { symbols: ['XAUUSD'], magic_numbers: [magic] });
  }
  const uploads = { deals: [], floating: [] };
  const collector = new StatsCollector({
    strategies,
    settingsRef: { data: { activeMt5InstanceId: activeId } },
    marketplace: {
      uploadRawBalance: async () => ({ ok: true }),
      uploadRawDeals: async (items) => { uploads.deals.push(...items); return { ok: true, inserted: items.length }; },
      uploadRawEaFloating: async (items) => { uploads.floating.push(...items); return { ok: true }; },
    },
    log: () => {},
  });
  return { collector, uploads };
}

const snap = (login, magics) => ({
  ts: 1760000000,
  account: { login, balance: 1000, equity: 1000 },
  positions: magics.map((magic, i) => ({ ticket: login * 10 + i, magic, symbol: 'XAUUSD', profit: 1, swap: 0 })),
  deals: magics.map((magic, i) => ({ ticket: login * 100 + i, magic, symbol: 'XAUUSD', type: 0, entry: 1, volume: 0.1, profit: 2, time: 1760000000 })),
});
const dealNames = (uploads, login) => uploads.deals.filter((d) => d.account_login === login).map((d) => [d.magic, d.ea_name]);
const floatNames = (uploads, login) => uploads.floating.filter((f) => f.account_login === login).map((f) => f.ea_name).sort();

const TWO_INSTANCES = [
  ['GMarket_01', 'A', 100], ['GMarket_02', 'A', 101],
  ['GMarket_06', 'B', 100], ['GMarket_07', 'B', 101],
];

test('多实例复用同一组 magic: 成交和浮盈按取数的实例归到它自己的 EA', async (t) => {
  const { collector, uploads } = await setup(t, TWO_INSTANCES);
  await collector._uploadRawSnapshot(snap(1001, [100, 101]), {}, 'A');
  await collector._uploadRawSnapshot(snap(2002, [100, 101]), {}, 'B');
  assert.deepEqual(dealNames(uploads, 1001), [[100, 'GMarket_01'], [101, 'GMarket_02']]);
  assert.deepEqual(dealNames(uploads, 2002), [[100, 'GMarket_06'], [101, 'GMarket_07']],
    '实例 B 的成交不能记到实例 A 的同 magic EA 名下');
  assert.deepEqual(floatNames(uploads, 1001), ['GMarket_01', 'GMarket_02']);
  assert.deepEqual(floatNames(uploads, 2002), ['GMarket_06', 'GMarket_07']);
});

test('未绑实例的 EA 归 active 实例; 别的实例找不到本实例的 EA → 全局第一个', async (t) => {
  const { collector, uploads } = await setup(t, [['Bound_B', 'B', 100], ['Unbound', null, 100]], { activeId: 'A' });
  await collector._uploadRawSnapshot(snap(1001, [100]), {}, 'A');
  await collector._uploadRawSnapshot(snap(3003, [100]), {}, 'C');
  assert.deepEqual(dealNames(uploads, 1001), [[100, 'Unbound']], 'active 实例上的单归未绑实例的那只, 不归绑在 B 的');
  assert.deepEqual(dealNames(uploads, 3003), [[100, 'Bound_B']]);
});

test('没有实例上下文(单实例 / rebuild_raw_data): 全局第一个同 magic 的 EA; records 没有 → 磁盘 magicMap', async (t) => {
  const { collector, uploads } = await setup(t, TWO_INSTANCES);
  await collector._uploadRawSnapshot(snap(1001, [100, 777, 888]), { 777: 'FromChr' });
  assert.deepEqual(dealNames(uploads, 1001), [[100, 'GMarket_01'], [777, 'FromChr'], [888, null]]);
});
