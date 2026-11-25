// chat-session-manager.js — 多会话管理(1.3.x)
//
// 把原来的「全局单例 chat」升级成「按 sessionKey 存多个独立 ChatSession 实例」。
//   · global                → 默认全局会话(行为与旧版完全一致, 文件 chat.json, channel 'chat')
//   · strat:<login>:<ea>    → 每个(账户,策略)一条独立 Claude Code 会话(独立 sessionId/历史/
//                             上下文种子, 文件 chat-strat-<hash>.json, channel = sessionKey)
//
// 每个 ChatSession 已是 per-instance 状态(history/lastSessionId/busy/activeChild), 这里只负责
// 「谁持有 + 按 key 路由 + 按 key 定制持久化文件/channel/上下文种子」。所有会话共用同一 workspace
// + 同一 tokenStore(凭据), 靠 --resume <各自 sessionId> 天然隔离(跟 wechat-sessions 同思路)。

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ChatSession } = require('./chat-session');

const GLOBAL_KEY = 'global';

function _hash(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12);
}

// sessionKey → {kind, login, ea}
function parseKey(key) {
  if (!key || key === GLOBAL_KEY) return { kind: 'global', login: null, ea: null };
  const m = /^strat:([^:]+):([\s\S]+)$/.exec(String(key));
  if (m) return { kind: 'strategy', login: m[1], ea: m[2] };
  return { kind: 'global', login: null, ea: null };  // 未知格式兜底到全局, 绝不 throw
}

// (login, ea) → sessionKey
function stratKey(login, ea) {
  return `strat:${login}:${ea}`;
}

class ChatSessionManager {
  constructor({ workspaceDir, dataDir, tokenStore, tokenReissuer,
                buildGlobalContext, buildStrategyContext, onEvent, remoteMcpProvider }) {
    this.workspaceDir = workspaceDir;
    this.dataDir = dataDir;
    this.tokenStore = tokenStore || null;
    this.tokenReissuer = tokenReissuer || null;
    // 1.4.x「附加远程会话」: (session) => Promise<mcpConfigPath|null>, 透传给每个 ChatSession
    this._remoteMcpProvider = (typeof remoteMcpProvider === 'function') ? remoteMcpProvider : null;
    this._buildGlobalContext = buildGlobalContext || null;      // () => Promise<string>
    this._buildStrategyContext = buildStrategyContext || null;  // (login, ea) => Promise<string>
    // 把每个会话的 UI 事件转发给 renderer, 带上 sessionKey(第 2 参), renderer 据此过滤到当前
    // 激活会话。老监听者(renderer 未读徽章)只读第 1 参 → 兼容。
    this._onEvent = (typeof onEvent === 'function') ? onEvent : null;
    this._map = new Map();   // sessionKey → ChatSession
  }

  _dataFileName(key) {
    return key === GLOBAL_KEY ? 'chat.json' : `chat-strat-${_hash(key)}.json`;
  }

  _create(key) {
    const info = parseKey(key);
    const channel = (info.kind === 'global') ? 'chat' : key;
    let contextProvider = null;
    if (info.kind === 'global') {
      contextProvider = this._buildGlobalContext;
    } else if (this._buildStrategyContext) {
      contextProvider = (opts) => this._buildStrategyContext(info.login, info.ea, opts);
    }
    const s = new ChatSession({
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
      contextProvider,
      tokenStore: this.tokenStore,
      tokenReissuer: this.tokenReissuer,
      sessionKey: key,
      channel,
      dataFileName: this._dataFileName(key),
      remoteMcpProvider: this._remoteMcpProvider,
    });
    // 转发本会话 UI 事件到 renderer(带 sessionKey)。tool-use 不在此转发 —— 由 main.js 在
    // 全局会话上单独挂(策略创建通知 / 微信回流是全局关注点), 避免重复触发。
    // 'persist-error' 单独在此列出: 用户案例(升级强制退出后发现最近两天对话没持久化,
    // 之前的记录都在)坐实——durableWriteSync 失败时早就会 emit 这个事件, 但之前完全没人
    // 监听, 用户对"正在悄悄丢数据"毫无察觉, 直到某次冷启动读盘才发现内存与磁盘的差距。
    // 现转发给 renderer 显眼横幅 + main 进程系统通知(双通道, 覆盖"没在看这个tab"的情况)。
    if (this._onEvent) {
      for (const ev of ['append', 'update', 'progress', 'stream', 'busy', 'reset', 'persist-error']) {
        s.on(ev, (payload) => { try { this._onEvent(key, ev, payload); } catch { /* ignore */ } });
      }
    }
    return s;
  }

  // 懒创建 + init。同 key 复用同一实例。
  async get(sessionKey) {
    const key = sessionKey && String(sessionKey) || GLOBAL_KEY;
    let s = this._map.get(key);
    if (s) return s;
    s = this._create(key);
    await s.init();
    this._map.set(key, s);
    return s;
  }

  // 同步取已存在的(不创建); 给 panic-stop 之类遍历用。
  peek(sessionKey) {
    return this._map.get(sessionKey && String(sessionKey) || GLOBAL_KEY) || null;
  }

  getGlobal() { return this.get(GLOBAL_KEY); }

  // 启动: 建全局会话 + 预热磁盘上已有的策略会话文件(chat-strat-*.json), 让 list() 一开机就全。
  async init() {
    await this.get(GLOBAL_KEY);
    try {
      const files = fs.readdirSync(this.dataDir).filter((f) => /^chat-strat-[0-9a-f]{12}\.json$/.test(f));
      // 文件名是 hash, 无法从名字反推 sessionKey; 文件内容里存了 sessionKey(见下 _save 扩展)。
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
          const key = j && typeof j.sessionKey === 'string' ? j.sessionKey : null;
          if (key && key !== GLOBAL_KEY && !this._map.has(key)) await this.get(key);
        } catch { /* 坏文件跳过 */ }
      }
    } catch { /* 无 strat 文件 */ }
  }

  // 会话清单(供 UI)。global 恒首位; 策略按最近使用倒序。
  list() {
    const out = [];
    for (const [key, s] of this._map.entries()) {
      const info = parseKey(key);
      const hist = s.history || [];
      const last = hist.length ? hist[hist.length - 1] : null;
      out.push({
        key,
        kind: info.kind,
        login: info.login,
        ea: info.ea,
        turns: hist.length,
        busy: !!s.busy,
        last_ts: last && Number(last.ts) || 0,
      });
    }
    out.sort((a, b) => {
      if (a.kind === 'global') return -1;
      if (b.kind === 'global') return 1;
      return (b.last_ts || 0) - (a.last_ts || 0);
    });
    return out;
  }

  // 删策略会话: stop + 删持久化文件 + 移出 Map。全局不可删(只能 reset)。
  async delete(sessionKey) {
    const key = String(sessionKey || '');
    if (!key || key === GLOBAL_KEY) return { ok: false, error: '全局会话不可删除(可用「新会话」清空)' };
    const s = this._map.get(key);
    if (s) {
      try { await s.stop({ reason: 'session_deleted' }); } catch { /* ignore */ }
      this._map.delete(key);
    }
    try { fs.unlinkSync(path.join(this.dataDir, this._dataFileName(key))); } catch { /* 文件可能不存在 */ }
    return { ok: true };
  }

  // 删某 EA 的所有策略会话(该 EA 可能在多个账户下各有一条 strat:<login>:<ea>)。
  // 用户删策略时连带清理(内存实例 + 磁盘文件); 也扫磁盘上未加载的 chat-strat-*.json。
  async deleteByEa(eaName) {
    const stem = String(eaName || '').replace(/\.(mq5|ex5)$/i, '');
    if (!stem) return { ok: false, deleted: 0 };
    const targets = new Set();
    // 已加载的会话: key 尾段 == ea
    for (const key of this._map.keys()) {
      const info = parseKey(key);
      if (info.kind === 'strategy' && info.ea === stem) targets.add(key);
    }
    // 磁盘上未加载的策略会话文件(内含 sessionKey)
    try {
      for (const f of fs.readdirSync(this.dataDir).filter((n) => /^chat-strat-[0-9a-f]{12}\.json$/.test(n))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
          const k = j && typeof j.sessionKey === 'string' ? j.sessionKey : null;
          if (k && parseKey(k).ea === stem) targets.add(k);
        } catch { /* 坏文件跳过 */ }
      }
    } catch { /* 无文件 */ }
    let deleted = 0;
    for (const key of targets) { try { await this.delete(key); deleted += 1; } catch { /* ignore */ } }
    return { ok: true, deleted };
  }

  // 全停: 停所有会话在跑的 Claude 进程 + 标记中断(供 panic-stop)。
  async stopAll(opts = {}) {
    const jobs = [];
    for (const s of this._map.values()) {
      jobs.push(Promise.resolve().then(() => s.stop(opts)).catch(() => {}));
      if (typeof s.dismissInterruptedTurn === 'function') {
        jobs.push(Promise.resolve().then(() => s.dismissInterruptedTurn('panic_stop_all')).catch(() => {}));
      }
    }
    await Promise.all(jobs);
  }

  // 有没有任一会话在忙(全局忙碌指示)。
  anyBusy() {
    for (const s of this._map.values()) if (s.busy) return true;
    return false;
  }
}

module.exports = { ChatSessionManager, parseKey, stratKey, GLOBAL_KEY };
