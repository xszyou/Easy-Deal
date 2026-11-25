// MT5 instance identity and configuration validation.
//
// An MT5 instance is not identified by terminal64.exe alone.  The data
// directory selects the accounts, profiles, Experts and logs that belong to
// that instance, so both paths and the launch mode are part of its identity.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCH_MODES = new Set(['portable', 'standard']);

function normalizeMt5Path(value) {
  return String(value || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function sameMt5Path(a, b) {
  const left = normalizeMt5Path(a);
  const right = normalizeMt5Path(b);
  return !!left && left === right;
}

function inferLaunchMode(installDir, dataDir, explicitMode = null) {
  if (LAUNCH_MODES.has(explicitMode)) return explicitMode;
  if (!installDir || !dataDir) return 'unverified';
  return sameMt5Path(installDir, dataDir) ? 'portable' : 'standard';
}

function readOriginInstallDir(dataDir) {
  if (!dataDir) return null;
  try {
    const file = path.join(dataDir, 'origin.txt');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file).toString('utf16le').replace(/^\uFEFF/, '').trim() || null;
  } catch {
    return null;
  }
}

function normalizeMt5Instance(record = {}) {
  const installDir = String(record.installDir || '').trim() || null;
  const dataDir = String(record.dataDir || '').trim() || null;
  const launchMode = inferLaunchMode(installDir, dataDir, record.launchMode);
  const userIntent = record.user_intent === 'running' ? 'running' : 'stopped';
  return {
    ...record,
    installDir,
    dataDir,
    launchMode,
    user_intent: userIntent,
    lifecycle_version: 2,
  };
}

function reconcileMissingMt5Process({
  userIntent,
  seenRunning = false,
  misses = 0,
  authorized = false,
  restarting = false,
} = {}) {
  if (userIntent !== 'running') {
    return { state: 'stopped', misses: 0, action: 'none' };
  }
  if (authorized && (!seenRunning || restarting)) {
    return { state: 'starting', misses, action: 'wait' };
  }
  const nextMisses = misses + 1;
  if (nextMisses >= 2) {
    return { state: 'stopped', misses: 0, action: 'persist_stop' };
  }
  return { state: 'stopping', misses: nextMisses, action: 'wait' };
}

// Decide what the post-launch identity check does after a failed probe.
// A real identity mismatch fails at once.  "target_terminal_booting" only means
// the process is younger than the attach gate allows, so it waits out the
// remaining time without spending one of the three real attempts.
function planMt5VerificationRetry({ reason = '', attempt = 0, bootWaits = 0 } = {}) {
  const text = String(reason || '');
  if (/(?:data|install)_path_mismatch|identity_mismatch/i.test(text)) {
    return { action: 'fail' };
  }
  const booting = /target_terminal_booting:age=(\d+(?:\.\d+)?):required=(\d+(?:\.\d+)?)/.exec(text);
  if (booting && bootWaits < 4) {
    const remainingMs = Math.ceil((Number(booting[2]) - Number(booting[1])) * 1000);
    return {
      action: 'retry',
      delayMs: Math.min(60_000, Math.max(5_000, remainingMs + 2_000)),
      attempt,
      bootWaits: bootWaits + 1,
    };
  }
  if (attempt < 2) {
    return { action: 'retry', delayMs: 30_000, attempt: attempt + 1, bootWaits };
  }
  return { action: 'fail' };
}

function validateMt5Instance(record, { siblings = [] } = {}) {
  const inst = normalizeMt5Instance(record);
  const errors = [];
  const warnings = [];

  if (!inst.id) errors.push('实例缺少 id');
  if (!inst.installDir) errors.push('MT5 程序目录未配置');
  if (!inst.dataDir) errors.push('MT5 数据目录未配置');
  if (!LAUNCH_MODES.has(inst.launchMode)) errors.push('启动模式未确认，请重新选择数据目录');

  if (inst.installDir) {
    const hasExe = ['terminal64.exe', 'terminal.exe']
      .some((name) => fs.existsSync(path.join(inst.installDir, name)));
    if (!hasExe) errors.push(`程序目录中没有 terminal64.exe/terminal.exe：${inst.installDir}`);
  }
  if (inst.dataDir && !fs.existsSync(inst.dataDir)) {
    errors.push(`数据目录不存在：${inst.dataDir}`);
  }

  if (inst.launchMode === 'portable' && !sameMt5Path(inst.installDir, inst.dataDir)) {
    errors.push('便携模式要求程序目录和数据目录完全相同');
  }
  if (inst.launchMode === 'standard') {
    if (sameMt5Path(inst.installDir, inst.dataDir)) {
      errors.push('标准模式的数据目录不能等于程序目录');
    } else if (inst.dataDir) {
      const origin = readOriginInstallDir(inst.dataDir);
      if (!origin) {
        errors.push(`无法验证标准模式数据目录：${inst.dataDir} 中缺少 origin.txt`);
      } else if (!sameMt5Path(origin, inst.installDir)) {
        errors.push(`数据目录属于另一套 MT5：origin.txt 指向 ${origin}`);
      }
    }
  }

  const duplicate = siblings.find((other) =>
    other && other.id !== inst.id && sameMt5Path(other.installDir, inst.installDir));
  if (duplicate) {
    errors.push(`程序目录已被实例“${duplicate.name || duplicate.id}”使用；每个实例必须使用独立程序目录`);
  }

  return { ok: errors.length === 0, instance: inst, errors, warnings };
}

module.exports = {
  LAUNCH_MODES,
  inferLaunchMode,
  normalizeMt5Instance,
  normalizeMt5Path,
  planMt5VerificationRetry,
  readOriginInstallDir,
  reconcileMissingMt5Process,
  sameMt5Path,
  validateMt5Instance,
};
