// Jin10 实时财经快讯 polling provider.
//
// 数据源：https://www.jin10.com/flash_newest.js  返回 JSONP-style：
//   var newest = [{id, time, type, data:{content, title, source, ...},
//                  important, tags, channel, remark}, ...];
// 一次返 ~50-100 条最新，时间倒序。我们每 30s 拉一次，按 id 去重，
// 维护一个内存 ring buffer（默认 200 条），落地到
//   <userData>/data/news-buffer.json  给 MCP 子进程读（AI 通过
//   `mcp__easydeal__list_recent_news` 调）。
//
// 0.3.219: 多写一份 daily log 持久化 — <userData>/data/news/YYYY-MM-DD.jsonl
//   append-only 每行一条 JSON. ring buffer 只保留近期 200 条 (UI 快查 + MCP
//   短窗口快查), 但 daily log 永不删. MCP 拉大时间窗 (>1h) 会扫 daily files
//   合并去重 — 让 AI 能查到几天/几周前的资讯, 不再被 200 条上限卡住.
//
// 关键词命中事件由 main.js 订阅 'new-items' 后判断 + 推系统消息到 chat /
// wechat — 不写在这里以免循环引用。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const EventEmitter = require('node:events');

const JIN10_URL = 'https://www.jin10.com/flash_newest.js';
const POLL_INTERVAL_MS = 30_000;
const BUFFER_MAX = 200;

class NewsProvider extends EventEmitter {
  constructor({ bufferPath, dailyLogDir } = {}) {
    super();
    this.bufferPath = bufferPath || null;   // <userData>/data/news-buffer.json
    // 0.3.219: 持久 daily log 目录, 每天一个 YYYY-MM-DD.jsonl 文件
    this.dailyLogDir = dailyLogDir || (
      bufferPath ? path.join(path.dirname(bufferPath), 'news') : null
    );
    this._items = [];                       // 倒序 (newest first)
    this._seen = new Set();                 // dedup by id
    this._timer = null;
    this._stopped = true;
    this._lastFetchAt = 0;
    this._lastError = null;
  }

  async start() {
    if (!this._stopped) return;
    this._stopped = false;
    // Try to restore previous buffer so a restart doesn't lose history.
    if (this.bufferPath) {
      try {
        const raw = await fsp.readFile(this.bufferPath, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this._items = arr.slice(0, BUFFER_MAX);
          for (const it of this._items) {
            if (it && it.id) this._seen.add(String(it.id));
          }
        }
      } catch { /* fresh start */ }
    }
    // Tick immediately, then schedule.
    this._tick().catch(() => {});
    this._timer = setInterval(() => this._tick().catch(() => {}),
                              POLL_INTERVAL_MS);
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // 0.3.152: timer-registry 联动
  async pause()  { this.stop(); }
  async resume() { return this.start(); }

  status() {
    return {
      running: !this._stopped,
      items_count: this._items.length,
      last_fetch_at: this._lastFetchAt || null,
      last_error: this._lastError || null,
    };
  }

  /**
   * 拉一轮金十快讯。返新增的（按 id 去重过的）items 数组；副作用：
   * push 到 _items / _seen / 写 buffer 文件 / emit 'new-items'.
   */
  async _tick() {
    if (this._stopped) return [];
    let txt;
    try {
      txt = await this._httpGet(JIN10_URL);
    } catch (e) {
      this._lastError = String(e?.message || e);
      return [];
    }
    this._lastFetchAt = Date.now();
    this._lastError = null;

    // Parse: strip "var newest = " prefix and trailing ";" if present.
    let m = txt.match(/var\s+newest\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
    if (!m) {
      // Some builds wrap in "var newest=[...]" without spaces; permissive parse.
      m = txt.match(/=\s*(\[[\s\S]*\])\s*;?/);
    }
    if (!m) { this._lastError = 'jin10 response: no array found'; return []; }
    let arr;
    try { arr = JSON.parse(m[1]); }
    catch (e) { this._lastError = 'json parse: ' + e.message; return []; }
    if (!Array.isArray(arr)) return [];

    // Normalize + dedup.
    const fresh = [];
    for (const raw of arr) {
      if (!raw || !raw.id) continue;
      const id = String(raw.id);
      if (this._seen.has(id)) continue;
      this._seen.add(id);
      const item = {
        id,
        ts: _parseTime(raw.time),               // ms epoch
        time: raw.time || '',
        important: Number(raw.important || 0),  // 0 | 1
        type: Number(raw.type || 0),            // 0=text, 1=chart, 5=data, ...
        title: (raw.data && raw.data.title) || '',
        content: (raw.data && raw.data.content) || '',
        source: (raw.data && raw.data.source) || '',
        source_link: (raw.data && raw.data.source_link) || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        channel: Array.isArray(raw.channel) ? raw.channel : [],
        // remark 含相关品种代码 — 留着给关键词匹配 / UI 显示用
        remark: Array.isArray(raw.remark)
          ? raw.remark.map((r) => ({
              title: r?.title || '',
              symbol: r?.symbol || '',
              type: r?.type || '',
            }))
          : [],
      };
      fresh.push(item);
    }
    if (!fresh.length) return [];

    // Prepend fresh (jin10 returns newest first, but 'fresh' is ones we
    // haven't seen — preserve their internal order).
    this._items = [...fresh, ...this._items].slice(0, BUFFER_MAX);

    // Trim seen set so it doesn't grow unbounded — keep one round more
    // than buffer.
    if (this._seen.size > BUFFER_MAX * 3) {
      const keep = new Set(this._items.map((it) => it.id));
      this._seen = keep;
    }

    // Write buffer file (best-effort, don't block).
    if (this.bufferPath) {
      try {
        await fsp.mkdir(path.dirname(this.bufferPath), { recursive: true });
        await fsp.writeFile(this.bufferPath,
          JSON.stringify(this._items, null, 2), 'utf8');
      } catch (e) {
        console.warn('[news] buffer write failed:', e?.message || e);
      }
    }

    // 0.3.219: 同步 append 到 daily log file 持久化 (按 item.ts 归档到对应日期)
    if (this.dailyLogDir && fresh.length) {
      try {
        await fsp.mkdir(this.dailyLogDir, { recursive: true });
        // 按日期分组 fresh items (跨日 fresh 很少见但理论可能)
        const byDate = new Map();
        for (const it of fresh) {
          const d = _dateKeyForTs(it.ts);
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d).push(it);
        }
        for (const [dateKey, arr] of byDate) {
          const fp = path.join(this.dailyLogDir, `${dateKey}.jsonl`);
          const lines = arr.map((it) => JSON.stringify(it)).join('\n') + '\n';
          await fsp.appendFile(fp, lines, 'utf8');
        }
      } catch (e) {
        console.warn('[news] daily-log append failed:', e?.message || e);
      }
    }

    this.emit('new-items', fresh);
    return fresh;
  }

  /**
   * 0.3.219: 跨日扫 daily log files 拿历史快讯. MCP 拉大时间窗 (>1h) 时调.
   * @param {object} opts
   * @param {number} opts.cutoffMs - 只返 ts >= cutoffMs 的
   * @param {Array<string>|null} opts.keywords
   * @param {boolean} opts.importantOnly
   * @param {number} opts.maxItems - 默认 500 上限防内存爆
   * @returns {Promise<Array>} 倒序 (newest first)
   */
  async recentFromDisk({ cutoffMs, keywords = null, importantOnly = false,
                         maxItems = 500 } = {}) {
    if (!this.dailyLogDir || !fs.existsSync(this.dailyLogDir)) return [];
    // 算出 cutoffMs 覆盖的日期范围 (含余地一天防时区边界)
    const cutoffDate = new Date(cutoffMs - 86400_000);
    const today = new Date();
    const datesToScan = [];
    const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    while (cursor >= new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate())) {
      datesToScan.push(_dateKey(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    const kw = (Array.isArray(keywords) && keywords.length)
      ? keywords.map((s) => String(s).trim()).filter(Boolean)
      : null;
    const seen = new Set();
    const out = [];
    // newest date 优先, 跟内存 buffer 顺序一致
    for (const d of datesToScan) {
      if (out.length >= maxItems) break;
      const fp = path.join(this.dailyLogDir, `${d}.jsonl`);
      let txt;
      try { txt = await fsp.readFile(fp, 'utf8'); }
      catch { continue; }   // 该日没文件
      // 文件内是 append-only, 早 → 晚. 反向 push 让最新排前面
      const lines = txt.split(/\r?\n/).filter(Boolean);
      const dayItems = [];
      for (const ln of lines) {
        try {
          const it = JSON.parse(ln);
          if (!it || !it.id) continue;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          if (typeof it.ts === 'number' && it.ts < cutoffMs) continue;
          if (importantOnly && !it.important) continue;
          if (kw) {
            const hay = `${it.title || ''}\n${it.content || ''}`;
            if (!kw.some((k) => hay.includes(k))) continue;
          }
          dayItems.push(it);
        } catch { /* malformed line, skip */ }
      }
      // 当日内倒序
      dayItems.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      for (const it of dayItems) {
        out.push(it);
        if (out.length >= maxItems) break;
      }
    }
    return out;
  }

  /**
   * 取最近 N 分钟内的快讯。可选关键词数组（任一命中即返）+ important_only。
   * 用于 IPC 渲染端 + 关键词检测 + MCP tool。
   */
  recent({ minutesBack = 30, keywords = null, importantOnly = false } = {}) {
    const cutoff = Date.now() - minutesBack * 60_000;
    const kw = (Array.isArray(keywords) && keywords.length)
      ? keywords.map((s) => String(s).trim()).filter(Boolean)
      : null;
    const out = [];
    for (const it of this._items) {
      if (it.ts && it.ts < cutoff) continue;
      if (importantOnly && !it.important) continue;
      if (kw) {
        const hay = `${it.title}\n${it.content}`;
        if (!kw.some((k) => hay.includes(k))) continue;
      }
      out.push(it);
    }
    return out;
  }

  // ---- internals ----
  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (EasyDeal news-provider)',
          'Accept': '*/*',
          'Referer': 'https://www.jin10.com/',
        },
        timeout: 10_000,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          // Jin10 returns UTF-8; sanity-check encoding fallback later if needed
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    });
  }
}

// 0.3.219: 时间戳 → 本地日期 key (YYYY-MM-DD), 用作 daily log 文件名
function _dateKeyForTs(ts) {
  const d = new Date(ts || Date.now());
  return _dateKey(d);
}
function _dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _parseTime(s) {
  // "2026-05-11 15:54:22"  → ms epoch (treat as Asia/Shanghai = UTC+8)
  if (!s) return Date.now();
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return Date.now();
  // Use local time (Date constructor) — jin10 timestamps are in Beijing,
  // and EasyDeal users are mostly in mainland China; for non-CN users the
  // displayed time will be slightly off but ordering stays correct.
  const [, y, mo, d, h, mi, s2] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s2).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

module.exports = { NewsProvider };
