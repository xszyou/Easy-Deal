'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeEaStem(eaName) {
  const raw = String(eaName || '').trim();
  const leaf = raw.split(/[\\/]/).pop() || '';
  const stem = leaf.replace(/\.(mq5|ex5|mqh|set)$/i, '').trim();
  if (!stem || stem === '.' || stem === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(stem)) {
    throw new Error('无效的 EA 名称');
  }
  return stem;
}

function uniqueRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots || []) {
    if (!root) continue;
    const resolved = path.resolve(String(root));
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * 删除指定 EA 在目标 MT5 实例中的参数覆盖文件。
 *
 * config.set 是运行时热更新入口；Presets/<EA>.set 会在下次启动/重挂时再次
 * 注入参数。两份必须一起删，否则旧参数会在下一次挂载时“复活”。runtime.json
 * 是 EA 当前真实运行值快照，故意保留，避免界面把仍在运行的旧值误报成默认值。
 */
async function deleteHotParamFiles({ eaName, roots }) {
  const stem = normalizeEaStem(eaName);
  const targetRoots = uniqueRoots(roots);
  if (!targetRoots.length) {
    return { ok: false, error: '没有可用的 MT5 数据目录', ea_name: stem, removed: [] };
  }

  const targets = [];
  for (const root of targetRoots) {
    targets.push({ kind: 'config.set', path: path.join(root, 'MQL5', 'Files', `${stem}_config.set`) });
    targets.push({ kind: 'preset.set', path: path.join(root, 'MQL5', 'Presets', `${stem}.set`) });
  }

  const removed = [];
  const missing = [];
  const errors = [];
  for (const target of targets) {
    try {
      await fs.promises.unlink(target.path);
      removed.push(target);
    } catch (e) {
      if (e?.code === 'ENOENT') missing.push(target);
      else errors.push({ ...target, error: e?.message || String(e) });
    }
  }

  return {
    ok: errors.length === 0,
    ea_name: stem,
    removed,
    missing,
    errors,
    requires_remount: removed.length > 0,
  };
}

module.exports = { deleteHotParamFiles, normalizeEaStem };
