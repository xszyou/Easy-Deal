const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  chartHasEa,
  countMountedExpertsInProfile,
  findEaCharts,
  planMount,
} = require('../electron/mt5-profile');

function chart(eaName, mode = 33) {
  const expert = eaName
    ? `<expert>\r\nname=${eaName}\r\npath=Experts\\${eaName}.ex5\r\nexpertmode=${mode}\r\n</expert>\r\n`
    : '';
  return `<chart>\r\nsymbol=XAUUSDc\r\n${expert}</chart>\r\n`;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easydeal-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'terminal');
  const data = path.join(root, 'data');
  const charts = path.join(data, 'MQL5', 'Profiles', 'Charts', 'Trading');
  fs.mkdirSync(path.join(data, 'Config'), { recursive: true });
  fs.mkdirSync(charts, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(
    path.join(data, 'Config', 'common.ini'),
    Buffer.from('\ufeff[Common]\r\nProfileLast=Trading\r\n', 'utf16le'),
  );
  const writeChart = (name, body, encoding = 'utf16le') => {
    const target = path.join(charts, name);
    const content = encoding === 'utf16le' ? `\ufeff${body}` : body;
    fs.writeFileSync(target, Buffer.from(content, encoding));
    return target;
  };
  return { install, data, charts, writeChart };
}

test('reads ProfileLast and recognizes real expertmode=33', (t) => {
  const f = fixture(t);
  const expected = f.writeChart('chart01.chr', chart('GMarket_wl', 33));
  assert.deepEqual(findEaCharts(f.install, 'GMarket_wl', f.data), [expected]);
  assert.equal(countMountedExpertsInProfile(f.install, f.data), 1);
});

test('existing target remounts on its original chart without startup ini', (t) => {
  const f = fixture(t);
  f.writeChart('chart01.chr', chart('GMarket_wl'));
  const plan = planMount(f.install, 'GMarket_wl.ex5', f.data);
  assert.equal(plan.action, 'reloaded_existing_chart');
  assert.equal(plan.useStartupIni, false);
});

test('EA matching is exact rather than a byte substring', (t) => {
  const f = fixture(t);
  f.writeChart('chart01.chr', chart('GMarket_wl_v2', 1), 'utf8');
  const plan = planMount(f.install, 'GMarket_wl', f.data);
  assert.equal(plan.action, 'created_new_chart');
  assert.equal(plan.useStartupIni, true);
});

test('configured data directory wins over a stale install profile', (t) => {
  const f = fixture(t);
  const stale = path.join(f.install, 'MQL5', 'Profiles', 'Charts', 'Default');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'chart01.chr'), Buffer.from(`\ufeff${chart('GMarket_wl')}`, 'utf16le'));
  f.writeChart('chart01.chr', chart(null));
  assert.equal(chartHasEa(f.install, 'GMarket_wl', f.data), false);
});

test('ProfileLast is authoritative over a stale Default profile', (t) => {
  const f = fixture(t);
  const stale = path.join(f.data, 'MQL5', 'Profiles', 'Charts', 'Default');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'chart01.chr'), Buffer.from(`\ufeff${chart('GMarket_wl')}`, 'utf16le'));
  f.writeChart('chart01.chr', chart(null));
  assert.equal(chartHasEa(f.install, 'GMarket_wl', f.data), false);
});

test('multi-EA profile is restored without forcing a single startup chart', (t) => {
  const f = fixture(t);
  f.writeChart('chart01.chr', chart('Alpha'));
  f.writeChart('chart02.chr', chart('Beta'));
  const plan = planMount(f.install, 'Gamma', f.data);
  assert.equal(plan.action, 'restored_multi_ea_profile');
  assert.equal(plan.useStartupIni, false);
});
