'use strict';

// Read MT5's active chart profile without launching the terminal.  Current
// MT5 builds store charts in MQL5/Profiles/Charts/<ProfileLast>; the old
// profiles/default/Last lookup is retained only as a legacy fallback.

const fs = require('node:fs');
const path = require('node:path');

function decodeMt5Text(raw) {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le', 2);
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(raw.length - 2);
    for (let i = 2; i + 1 < raw.length; i += 2) {
      swapped[i - 2] = raw[i + 1];
      swapped[i - 1] = raw[i];
    }
    return swapped.toString('utf16le');
  }
  const sample = raw.subarray(0, 128);
  let zeroes = 0;
  for (const value of sample) if (value === 0) zeroes += 1;
  if (zeroes > Math.max(2, Math.floor(sample.length / 4))) return raw.toString('utf16le');
  return raw.toString('utf8');
}

function readProfileLast(root) {
  try {
    const text = decodeMt5Text(fs.readFileSync(path.join(root, 'Config', 'common.ini')));
    const match = /(?:^|\n)\s*ProfileLast\s*=\s*([^\r\n]+)/i.exec(text);
    if (!match) return null;
    const name = match[1].trim().replace(/^"|"$/g, '');
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return null;
    return name;
  } catch {
    return null;
  }
}

function profileChartDirs(installDir, dataDir) {
  const root = String(dataDir || installDir || '').trim();
  if (!root) return [];
  const active = readProfileLast(root);
  const current = path.join(root, 'MQL5', 'Profiles', 'Charts', active || 'Default');
  try { if (fs.statSync(current).isDirectory()) return [current]; } catch {}

  const defaultDir = path.join(root, 'MQL5', 'Profiles', 'Charts', 'Default');
  if (active && active.toLowerCase() !== 'default') {
    try { if (fs.statSync(defaultDir).isDirectory()) return [defaultDir]; } catch {}
  }

  const candidates = [
    path.join(root, 'profiles', 'default', 'Last'),
    path.join(root, 'profiles', 'Default', 'Last'),
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
}

function chartFiles(installDir, dataDir) {
  const files = [];
  const seen = new Set();
  for (const directory of profileChartDirs(installDir, dataDir)) {
    let names;
    try { names = fs.readdirSync(directory).sort((a, b) => a.localeCompare(b)); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.chr')) continue;
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      const key = path.resolve(file).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        files.push(file);
      }
    }
  }
  return files;
}

function normalizeEaName(value) {
  let name = String(value || '').trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  if (name.toLowerCase().startsWith('experts\\')) name = name.slice('experts\\'.length);
  if (name.toLowerCase().endsWith('.ex5')) name = name.slice(0, -4);
  return name.toLowerCase();
}

function expertNamesFromText(text) {
  const names = [];
  const blocks = /<expert>([\s\S]*?)<\/expert>/gi;
  let match;
  while ((match = blocks.exec(text)) !== null) {
    const name = /(?:^|\n)\s*name\s*=\s*([^\r\n]+)/i.exec(match[1]);
    if (name) {
      const normalized = normalizeEaName(name[1]);
      if (normalized) names.push(normalized);
    }
  }
  return names;
}

function findEaCharts(installDir, eaName, dataDir) {
  const target = normalizeEaName(eaName);
  if (!target) return [];
  return chartFiles(installDir, dataDir).filter((file) => {
    try {
      return expertNamesFromText(decodeMt5Text(fs.readFileSync(file))).includes(target);
    } catch {
      return false;
    }
  });
}

function chartHasEa(installDir, eaName, dataDir) {
  return findEaCharts(installDir, eaName, dataDir).length > 0;
}

function countMountedExpertsInProfile(installDir, dataDir) {
  const names = new Set();
  for (const file of chartFiles(installDir, dataDir)) {
    try {
      for (const name of expertNamesFromText(decodeMt5Text(fs.readFileSync(file)))) names.add(name);
    } catch {}
  }
  return names.size;
}

function planMount(installDir, eaName, dataDir) {
  const targetCharts = findEaCharts(installDir, eaName, dataDir);
  const expertCount = countMountedExpertsInProfile(installDir, dataDir);
  if (targetCharts.length) {
    return { action: 'reloaded_existing_chart', useStartupIni: false, targetCharts, expertCount };
  }
  if (expertCount >= 2) {
    return { action: 'restored_multi_ea_profile', useStartupIni: false, targetCharts, expertCount };
  }
  return { action: 'created_new_chart', useStartupIni: true, targetCharts, expertCount };
}

module.exports = {
  chartFiles,
  chartHasEa,
  countMountedExpertsInProfile,
  decodeMt5Text,
  expertNamesFromText,
  findEaCharts,
  planMount,
  profileChartDirs,
  readProfileLast,
};
