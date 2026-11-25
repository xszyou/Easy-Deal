// AI 沟通统一日志 — append-only, 单调 seq, 跨重启去重。
//
// 设计动机(2026-06-13, 用户「手机与电脑 AI 沟通完全同步」需求):
// 旧同步靠 relay 每 30s scrape chat.history(滚动窗 cap 200) + 两个 JSON,
// 结构性盲区 = ① 滚动窗挤掉的老消息永久丢 ② relay 没起/那 30s 挂了就漏。
// 改成「产生即落盘」: 主对话/通知/微信/远程任一消息产生时写一行到
// data/ai-comm.jsonl(append-only, 永不被滚动窗影响), relay 按持久游标(seq)
// 续传到 server。进程没起时消息照样落盘, 起来后从游标补发, 不重不漏。
//
// 每行: {seq, id, channel, role, content, ts}
//   seq     — 模块级单调自增(启动从文件末尾恢复), relay 游标按它续传
//   id      — 去重键(turn id / 派生); server 端 (license,channel,id) 幂等
//   channel — chat | wechat | im | notify
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'ai-comm.jsonl';
const MAX_LINES = 6000;       // 超过此行数触发轮转
const KEEP_LINES = 4000;      // 轮转后保留尾部行数(seq 不重置, 仍单调)
const MAX_CONTENT = 16000;

let _seq = 0;
let _seen = null;             // Set<id>; null = 未初始化

function _fp(dataDir) { return path.join(dataDir, FILE); }

function _init(dataDir) {
  if (_seen) return;
  _seen = new Set();
  try {
    const raw = fs.readFileSync(_fp(dataDir), 'utf8');
    for (const ln of raw.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o.id) _seen.add(String(o.id));
        if (typeof o.seq === 'number' && o.seq > _seq) _seq = o.seq;
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件还不存在 */ }
}

// 从 turn / 消息对象提取纯文本(content 可能是 string、segments 数组、blocks 数组)
function _text(o) {
  if (!o) return '';
  if (typeof o.content === 'string' && o.content) return o.content;
  if (Array.isArray(o.segments)) {
    return o.segments.filter((s) => s && s.kind === 'text').map((s) => s.text || '').join('');
  }
  if (Array.isArray(o.content)) {
    return o.content.filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '').join('');
  }
  return '';
}

function _rotate(dataDir) {
  try {
    const p = _fp(dataDir);
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(p, lines.slice(-KEEP_LINES).join('\n') + '\n');
    }
  } catch { /* best-effort */ }
}

/**
 * 记录一条 AI 沟通消息。已记过(同 id)直接跳过 — 所以可重复调用(_save
 * 流式中多次触发也安全), pending 消息不记(等定型那次)。
 * @param {string} dataDir  <userData>/data
 * @param {object} msg      { id, role, content|segments, ts, pending? }
 * @param {string} channel  chat | wechat | im | notify
 */
function record(dataDir, msg, channel = 'chat') {
  // 从 Claude JSONL 恢复出来的旧 turn 只用于界面回看/上下文续接，不能再次
  // 作为“新消息”写入统一日志并同步到手机端，否则恢复一次就重复推送一次。
  if (!dataDir || !msg || !msg.id || msg.pending || msg.historical) return;
  if (msg.role !== 'user' && msg.role !== 'assistant') return;
  _init(dataDir);
  const id = String(msg.id);
  if (_seen.has(id)) return;
  const content = String(_text(msg) || '').trim();
  if (!content) return;
  _seq += 1;
  const entry = {
    seq: _seq, id, channel, role: msg.role,
    content: content.slice(0, MAX_CONTENT), ts: Number(msg.ts) || Date.now(),
    // 通知类消息(护航告警/定时汇报/绑定授权等系统注入, 非用户↔AI 对话) — 手机端可一键隐藏
    system_note: !!msg.systemNote,
  };
  try {
    fs.appendFileSync(_fp(dataDir), JSON.stringify(entry) + '\n');
    _seen.add(id);
  } catch { return; }
  if (_seq % 500 === 0) _rotate(dataDir);
}

/** 把整个 history 过一遍(内部按 id 去重 + 跳 pending), chat-session._save 后调。 */
function syncHistory(dataDir, history, channel = 'chat') {
  for (const t of (history || [])) record(dataDir, t, channel);
}

/** 读 seq > afterSeq 的所有 entry(给 relay 游标续传)。 */
function readAfter(dataDir, afterSeq = 0) {
  const out = [];
  try {
    const raw = fs.readFileSync(_fp(dataDir), 'utf8');
    for (const ln of raw.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (typeof o.seq === 'number' && o.seq > afterSeq) out.push(o);
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return out;
}

/**
 * 1.4.x: 历史往前翻分页 —— 给 AI 栏「滚到顶部再往上翻」用。ai-comm.jsonl 保留
 * 4000~6000 行(远超 chat.json 里 HISTORY_CAP=200 的硬截断), 是分页回读老消息的
 * 数据源。按 channel 过滤(区分全局/各策略会话), 取 ts < beforeTs 里最近的 limit 条,
 * 按时间升序返回(供前端直接 prepend)。
 * ⚠ 这里只是纯文本快照(record() 落盘时已 flatten content), 附件缩略图等不随分页
 * 恢复 —— 翻回的老消息只显文字, 是可接受的降级(比翻不到强)。
 */
function readBefore(dataDir, channel, beforeTs, limit = 30) {
  const rows = [];
  try {
    const raw = fs.readFileSync(_fp(dataDir), 'utf8');
    for (const ln of raw.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o.channel === channel && typeof o.ts === 'number' && o.ts < beforeTs) rows.push(o);
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  rows.sort((a, b) => a.ts - b.ts);
  return rows.slice(Math.max(0, rows.length - limit));
}

module.exports = { record, syncHistory, readAfter, readBefore };
