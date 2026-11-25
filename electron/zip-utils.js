// Minimal store-only ZIP encoder/decoder for marketplace EA bundles.
//
// Why hand-rolled instead of adding `archiver` / `adm-zip` as deps:
//   - .ex5 binaries are already compressed (MetaTrader native packing); DEFLATE
//     gains ~0% but adds a complex dep. Store-only is fine.
//   - Bundle size: typical EA bundle = 1 main .ex5 (50-500 KB) + 1-5 .ex5
//     indicators (20-200 KB each). Stays well under any HTTP body limit.
//   - Zero new prod dep → less surface area for npm audit / supply-chain.
//
// Format reference: ZIP APPNOTE 6.3.10
//   - Local file header: signature 0x04034b50, 30 bytes + filename
//   - Central directory entry: signature 0x02014b50, 46 bytes + filename
//   - End of central directory: signature 0x06054b50, 22 bytes
//
// Limitations (acceptable for our use case):
//   - Filenames assumed UTF-8 (we control producer + consumer)
//   - No directory entries (entries with trailing /) — we use 'indicators/foo.ex5' style names directly
//   - No ZIP64 (max ~4 GB file / archive — way more than EA bundles need)

'use strict';

// ---------- CRC-32 (IEEE 802.3 polynomial, same as gzip/zlib) ----------
let _CRC_TABLE = null;
function _buildCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
function crc32(buf) {
  if (!_CRC_TABLE) _CRC_TABLE = _buildCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- DOS date/time (used by ZIP) ----------
function dosDateTime(d = new Date()) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

/**
 * Create a store-only zip from in-memory entries.
 *
 * @param {Array<{name: string, data: Buffer}>} entries  — filenames may include forward slashes
 * @returns {Buffer}                                       — complete ZIP file
 */
function createZip(entries) {
  const now = dosDateTime();
  const localBlocks = [];
  const centralBlocks = [];
  let offset = 0;
  for (const entry of entries) {
    const name = String(entry.name);
    if (name.includes('\\') || name.startsWith('/') || name.includes('..')) {
      throw new Error(`invalid entry name: ${name}`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + nameBuf)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags (bit 11 = UTF-8 filename)
    local.writeUInt16LE(0, 8);            // compression: 0 = stored
    local.writeUInt16LE(now.time, 10);    // mod time
    local.writeUInt16LE(now.date, 12);    // mod date
    local.writeUInt32LE(crc, 14);         // crc-32
    local.writeUInt32LE(size, 18);        // compressed size
    local.writeUInt32LE(size, 22);        // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // filename length
    local.writeUInt16LE(0, 28);              // extra length

    localBlocks.push(local, nameBuf, data);

    // Central directory entry (46 bytes + nameBuf)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);      // flags (UTF-8)
    central.writeUInt16LE(0, 10);          // compression
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);  // extra length
    central.writeUInt16LE(0, 32);  // comment length
    central.writeUInt16LE(0, 34);  // disk number
    central.writeUInt16LE(0, 36);  // internal attrs
    central.writeUInt32LE(0, 38);  // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralBlocks.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralBlocks);
  const centralSize = centralBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                  // disk number
  eocd.writeUInt16LE(0, 6);                  // disk where CD starts
  eocd.writeUInt16LE(entries.length, 8);     // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);    // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...localBlocks, centralBuf, eocd]);
}

/**
 * Extract entries from a store-only zip buffer.
 * Throws if it sees compressed data (compression != 0) — we don't bundle DEFLATE
 * since producer is always our own createZip().
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>}
 */
function extractZip(buf) {
  if (buf.length < 22) throw new Error('zip too small');
  // Find EOCD by scanning backwards (up to 64KB tail for comment)
  let eocdOffset = -1;
  const minSearchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minSearchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found — not a valid zip');
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdStart = buf.readUInt32LE(eocdOffset + 16);
  if (cdStart + cdSize > buf.length) throw new Error('CD overruns buffer');

  const entries = [];
  let p = cdStart;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length) throw new Error('CD entry truncated');
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad CD signature at ${p}`);
    const compression = buf.readUInt16LE(p + 10);
    if (compression !== 0) throw new Error(`only stored entries supported (got compression=${compression})`);
    const compressedSize = buf.readUInt32LE(p + 20);
    const fnameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const fname = buf.slice(p + 46, p + 46 + fnameLen).toString('utf8');
    // Read local header to find data offset
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local sig for ${fname}`);
    const localFnameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFnameLen + localExtraLen;
    const data = buf.slice(dataStart, dataStart + compressedSize);
    entries.push({ name: fname, data: Buffer.from(data) });  // copy out of the source buffer
    p += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}

/** Detect zip by magic bytes (first 4 of any local file header). Anything else
 *  (.ex5, etc.) returns false so callers can fall back to legacy "raw .ex5" path. */
function looksLikeZip(buf) {
  if (!buf || buf.length < 4) return false;
  return buf.readUInt32LE(0) === 0x04034b50;
}


// ---------- DEFLATE-aware unzip-to-disk (0.3.182: MT5 bundle install) ----------

/** 解压 zip 文件到指定目录. 支持 stored (0) 和 DEFLATE (8) 两种压缩方式.
 *  跟 extractZip() 的区别:
 *    - 输入是文件路径而非 buffer (大 zip 不能一次塞内存)
 *    - 实际上仍 readFileSync 一次性读 (Electron 主进程内存够 — 477MB ok),
 *      但每个 entry 解压完立刻写盘释放, 总驻留内存 = zip 本身 + 当前 entry
 *    - 支持目录 entry (trailing /) + 自动 mkdir
 *    - onEntry({ index, total, name, size, written }) 回调进度
 *    - 用 Node 内置 zlib.inflateRawSync, 不引入 npm dep
 *
 *  返回 { ok, entries_count, total_uncompressed }
 */
function extractZipToDir(zipPath, targetDir, opts = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const onEntry = typeof opts.onEntry === 'function' ? opts.onEntry : () => {};
  // 0.3.193: stripFirstDir=true — 如果 zip 里所有 entry 都共享同一个一级目录前缀
  // (常见情形: 打包时多带了一层 "MetaTrader 5/"), 解压时自动剥掉这层, 让文件直接
  // 落到 targetDir 下. 老调用方不传 = 行为不变.
  const stripFirstDir = opts.stripFirstDir === true;

  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) throw new Error('zip too small');

  // Find EOCD by scanning backwards (up to 64KB tail for comment)
  let eocdOffset = -1;
  const minSearchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minSearchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found — not a valid zip');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdStart = buf.readUInt32LE(eocdOffset + 16);
  if (cdStart + cdSize > buf.length) throw new Error('CD overruns buffer');

  fs.mkdirSync(targetDir, { recursive: true });
  // 防 zip-slip: 算 normalized target abs path, 后续 resolve 每个 entry 不能逃出
  const targetAbs = path.resolve(targetDir);

  // 0.3.193: 一遍扫 CD 收集所有 entry 名字, 算 common first-dir prefix
  let commonRoot = null;
  if (stripFirstDir) {
    let q = cdStart;
    for (let i = 0; i < totalEntries; i++) {
      if (q + 46 > buf.length) break;
      const fnLen = buf.readUInt16LE(q + 28);
      const exLen = buf.readUInt16LE(q + 30);
      const cmLen = buf.readUInt16LE(q + 32);
      const name = buf.slice(q + 46, q + 46 + fnLen).toString('utf8').replace(/\\/g, '/');
      const firstSlash = name.indexOf('/');
      const firstDir = firstSlash >= 0 ? name.slice(0, firstSlash) : null;
      if (firstDir === null) { commonRoot = null; break; }   // 有 entry 不在子目录, 不能 strip
      if (commonRoot === null) commonRoot = firstDir;
      else if (commonRoot !== firstDir) { commonRoot = null; break; }
      q += 46 + fnLen + exLen + cmLen;
    }
    if (commonRoot) {
      // log to stderr-ish via console (zip-utils 也被 main.js 用过, 走默认 console)
      // 不强 require log 模块.
      console.log(`[zip-utils] stripFirstDir: removing common root "${commonRoot}/" from all entries`);
    }
  }

  let p = cdStart;
  let totalUncompressed = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length) throw new Error('CD entry truncated');
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad CD signature at ${p}`);
    const compression = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const fnameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    let fname = buf.slice(p + 46, p + 46 + fnameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local sig for ${fname}`);
    const localFnameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFnameLen + localExtraLen;
    const compressedData = buf.slice(dataStart, dataStart + compressedSize);

    // 目录 entry (trailing /) — 只 mkdir, 不写文件
    const isDir = fname.endsWith('/');
    let entryRelPath = fname.replace(/\\/g, '/');
    // 0.3.193: strip common root dir (e.g., "MetaTrader 5/")
    if (commonRoot) {
      const prefix = commonRoot + '/';
      if (entryRelPath === commonRoot || entryRelPath === prefix) {
        // 整个 root dir entry 自己 → skip (不再单独 mkdir, 等子 entry 自然 mk parents)
        p += 46 + fnameLen + extraLen + commentLen;
        onEntry({ index: i + 1, total: totalEntries, name: fname, size: uncompressedSize });
        continue;
      }
      if (entryRelPath.startsWith(prefix)) {
        entryRelPath = entryRelPath.slice(prefix.length);
      }
    }
    const entryAbsPath = path.resolve(targetAbs, entryRelPath);
    if (!entryAbsPath.startsWith(targetAbs)) {
      throw new Error(`zip-slip blocked: ${fname} escapes target dir`);
    }

    if (isDir) {
      fs.mkdirSync(entryAbsPath, { recursive: true });
    } else {
      // 确保父目录存在
      fs.mkdirSync(path.dirname(entryAbsPath), { recursive: true });
      // 解压
      let outData;
      if (compression === 0) {
        outData = compressedData;
      } else if (compression === 8) {
        outData = zlib.inflateRawSync(compressedData);
      } else {
        throw new Error(`unsupported compression ${compression} for entry ${fname}`);
      }
      fs.writeFileSync(entryAbsPath, outData);
      totalUncompressed += outData.length;
    }
    onEntry({ index: i + 1, total: totalEntries, name: fname, size: uncompressedSize });
    p += 46 + fnameLen + extraLen + commentLen;
  }
  return { ok: true, entries_count: totalEntries, total_uncompressed: totalUncompressed };
}

module.exports = { createZip, extractZip, extractZipToDir, looksLikeZip, crc32 };
