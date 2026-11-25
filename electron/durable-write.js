// Durable atomic file write — 0.4.18.
//
// 背景 (用户模拟盘确诊): EasyDeal 在「频繁被 SIGKILL」的机器上 (升级 quit ×N /
// chat turn timeout SIGTERM / orphan reaper kill) 丢数据. 根因两类:
//
//   1. dirty-page-loss: Node `fs.writeFile` 把数据写进 OS write-back 缓存就返回,
//      `statSync` 读缓存里的新 mtime/size「验证通过」, 但 dirty page 还没 flush
//      到物理磁盘时进程就被杀 → 数据丢. 磁盘还是旧文件.
//   2. fake-success: 个别机器 EDR / fs filter 让 writeFile + statSync 都报成功但
//      实际没写 (metadata 层骗过 0.3.1 的 statSync 验证).
//
// 解法 = 标准 durable atomic write:
//   open(tmp) → write → **fsync** (强制刷物理盘, 治 dirty-page-loss)
//   → **readback 内容比对** (治 fake-success, filter 难同时骗 write+read 内容)
//   → **rename** (Windows libuv 用 MoveFileEx REPLACE_EXISTING|WRITE_THROUGH,
//      原子替换 + 自身刷盘, 进程此刻被杀也不会留半个损坏文件).
//
// 返回 { ok, reason?, error? }. caller 据此决定告警 / 重试.

const fs = require('node:fs');
const path = require('node:path');

/**
 * 原子 + 落盘 + 校验地写一个文件 (同步). 失败返回 {ok:false,...} 不抛.
 * @param {string} filePath 目标路径
 * @param {string|Buffer} data 内容
 * @param {object} [opts]
 * @param {BufferEncoding} [opts.encoding='utf8']
 */
function durableWriteSync(filePath, data, opts = {}) {
  const encoding = opts.encoding || 'utf8';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
  let tmp = null;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // tmp 名带 pid + 时间戳 + 随机, 避免多实例 / 多次写撞同一 tmp,
    // 也避免「固定名 chat.json 被独占持有」时连 tmp 都写不了.
    tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);          // 关键: 强制 dirty page 落物理盘
    fs.closeSync(fd);
    fd = null;
    // readback 内容校验 — 戳穿 metadata-fake (filter 让 write/stat 假成功但 read 露馅)
    const back = fs.readFileSync(tmp);
    if (back.length !== buf.length || !back.equals(buf)) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, reason: 'readback_mismatch', wrote: buf.length, read: back.length };
    }
    // 0.4.24 关键修复 — 原子替换加「重试 + 落地校验 + 兜底直写」。
    // 根因 (作者模拟盘实证): chat.json / settings.json / backtests.json 主文件长期
    // 停在很久以前 (settings 卡 5/25, chat 卡 5/11), 而同目录的 .bak (唯一名直写) /
    // scheduler.db / writeprobe 都是新的。差别就在这一步 rename: Windows 上
    // 「另一个进程正持有目标文件的读句柄」(settings 被 settings-MCP 读 / chat 被
    // diag 上报读 / backtests 被 UI 5s 轮询 + Python sidecar lazy-load 读) 时,
    // MoveFileEx 覆盖会失败 (ERROR_SHARING_VIOLATION / ACCESS_DENIED), 老代码这步一
    // throw 就走外层 catch 返回 ok:false, 但**只写了唯一名的 .bak、主文件没动** →
    // 配置/聊天/回测看着「保存成功」实际没落盘, 干净重启就回退到旧文件。
    // 修法三层兜底:
    //   ① rename 重试 10 次 (递增退避到 ~2.7s), 错开读句柄释放窗口;
    //   ② 还失败 → 直接 open(target,'w')+write+fsync 原地覆盖 (非原子, 但至少落盘);
    //   ③ 最后**回读目标文件本身** (不是回读 tmp!) 比对内容, 戳穿「rename 报成功却
    //      没真覆盖」的 fs-filter 假象 —— 没真落盘就返回 ok:false 让 caller 告警。
    let replaced = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.renameSync(tmp, filePath);   // Windows: MoveFileEx REPLACE_EXISTING|WRITE_THROUGH
        replaced = true;
        break;
      } catch (e) {
        lastErr = e;
        _sleepSync(60 * (attempt + 1));   // 60,120,…600ms 递增退避, 同步 sleep
      }
    }
    if (!replaced) {
      // 兜底: 目标被独占改不了名 → 直接原地覆盖 (open 'w' 截断 + 写 + fsync)。
      // 比一直丢数据强; 多数情况下读句柄是 share-read, open 'w' 能成。
      try {
        const wfd = fs.openSync(filePath, 'w');
        fs.writeSync(wfd, buf, 0, buf.length, 0);
        fs.fsyncSync(wfd);
        fs.closeSync(wfd);
        try { fs.unlinkSync(tmp); } catch {}
        replaced = true;
      } catch (e2) {
        try { fs.unlinkSync(tmp); } catch {}
        return { ok: false, reason: 'rename_and_inplace_failed',
                 error: String(lastErr?.message || lastErr) + ' | ' + String(e2?.message || e2) };
      }
    }
    // 落地校验 — 回读「目标文件」本身确认真覆盖了 (不是回读 tmp)。
    try {
      const finalBack = fs.readFileSync(filePath);
      if (finalBack.length !== buf.length || !finalBack.equals(buf)) {
        return { ok: false, reason: 'post_write_mismatch', wrote: buf.length, read: finalBack.length };
      }
    } catch (e3) {
      return { ok: false, reason: 'post_read_failed', error: String(e3?.message || e3) };
    }
    return { ok: true };
  } catch (e) {
    try { if (fd != null) fs.closeSync(fd); } catch {}
    try { if (tmp) fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'exception', error: String(e?.message || e) };
  }
}

/** 同步 sleep (ms) — durableWriteSync 是同步函数, rename 重试退避不能用 setTimeout.
 *  用 Atomics.wait 在一个临时 SharedArrayBuffer 上阻塞当前线程, 不空转烧 CPU. */
function _sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
  } catch {
    // SharedArrayBuffer/Atomics 不可用时的退化兜底: 忙等 (极少触发)
    const end = Date.now() + Math.max(0, ms | 0);
    while (Date.now() < end) { /* spin */ }
  }
}

/** async 包装 — 内部仍走 sync (fsync 必须 sync 保证落盘), 用 Promise 包一层方便 await. */
async function durableWriteFile(filePath, data, opts = {}) {
  return durableWriteSync(filePath, data, opts);
}

module.exports = { durableWriteSync, durableWriteFile };
