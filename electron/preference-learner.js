// Preference learner — periodically reads recent chat history, asks Claude
// (headless) to extract STABLE user preferences/habits/explicit instructions,
// and appends them to a managed section in workspace/CLAUDE.md so future
// chat sessions inherit them automatically.
//
// Cost model: each run = one headless Claude turn (small prompt, 180s budget).
// Guards in `shouldRun()` ensure we only run when it's likely to find
// something new (≥ 10 new user messages since last run, AND ≥ 24 hours since
// previous run). 偏好这类东西稳定性高，一天聚一次就足够；之前 30 min 太密
// 导致用户感觉它一直在烧 token。

const fs   = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawnHeadlessClaude } = require('./claude-runner');

const SECTION_HEADER = '## 用户偏好（自动学习）';
const SECTION_FOOTER = '<!-- 自动学习边界 — 删除某条偏好不影响下次学习 -->';
const STATE_FILENAME = 'preference-learner.state.json';

const MIN_NEW_USER_MSGS = 10;    // need at least this many new user msgs before re-running
const MIN_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 24 h — daily-ish cadence
const HISTORY_TURNS_TO_SCAN = 80;
// 180s — cold-spawn 在中文 Windows 上加载 claude.exe + CLAUDE.md + 扫 skills
// 目录就要 30-50s；60s 经常踩到 timeout。180s 既留够余量又限定上限。
const TIMEOUT_MS = 180_000;
const MAX_PREF_LEN = 200;
const MAX_PREFS_TOTAL = 40;       // cap section size

class PreferenceLearner {
  constructor({ workspaceDir, chatHistoryPath, wechatRecentPath, dataDir, log }) {
    this.workspaceDir    = workspaceDir;
    this.chatHistoryPath = chatHistoryPath;
    // 0.3.285: 微信对话也作为偏好学习源 — wechat-sidecar 持久化的 per-chatId
    // user/bot exchange. null 时跳过 (向前兼容老 caller).
    this.wechatRecentPath = wechatRecentPath || null;
    this.statePath       = path.join(dataDir, STATE_FILENAME);
    this.log             = log || ((m) => console.log('[pref-learn]', m));
    this.state = this._loadState();
    this._inFlight = false;
  }

  _loadState() {
    try {
      return JSON.parse(fsSync.readFileSync(this.statePath, 'utf8'));
    } catch {
      // 0.3.285: 加 lastWechatUserMsgCount 单独跟踪微信侧增量
      return { lastRunAt: 0, lastUserMsgCount: 0, lastWechatUserMsgCount: 0, runs: 0 };
    }
  }

  _saveState() {
    try {
      fsSync.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (e) {
      this.log('state save failed: ' + e.message);
    }
  }

  /**
   * Decide whether to run now. Cheap — just reads chat.json size + state
   * timestamps, no LLM call.
   * 0.3.285: chat tab 跟 wechat 增量加在一起判 — 任一源累积 ≥10 新 user msgs
   * 都触发 (允许微信沟通驱动学习, 不必等 chat tab 攒够).
   */
  async shouldRun() {
    const now = Date.now();
    if (now - this.state.lastRunAt < MIN_RUN_INTERVAL_MS) return false;
    let chatUserCount = 0;
    try {
      const raw = await fs.readFile(this.chatHistoryPath, 'utf8');
      const history = (JSON.parse(raw).history) || [];
      chatUserCount = history.filter((m) => m.role === 'user').length;
    } catch {}
    const wechatUserCount = await this._countWechatUserMsgs();
    const chatDelta = chatUserCount - (this.state.lastUserMsgCount || 0);
    const wechatDelta = wechatUserCount - (this.state.lastWechatUserMsgCount || 0);
    if (chatDelta + wechatDelta < MIN_NEW_USER_MSGS) return false;
    return true;
  }

  /** 0.3.285: 读 wechat-recent.json 统计所有 chatId 累计 user msg 数. */
  async _countWechatUserMsgs() {
    if (!this.wechatRecentPath) return 0;
    try {
      const raw = await fs.readFile(this.wechatRecentPath, 'utf8');
      const data = JSON.parse(raw) || {};
      let n = 0;
      for (const arr of Object.values(data)) {
        if (!Array.isArray(arr)) continue;
        for (const e of arr) if (e?.role === 'user') n += 1;
      }
      return n;
    } catch { return 0; }
  }

  /** 0.3.285: 读 wechat-recent.json, 聚合所有 chatId 最近 N 条对话, 返回
   *  分组文本块 (每个 chatId 一段, role/text/ts 已排序). 给 LLM 提取 prompt 用. */
  async _readWechatHistoryBlocks(maxPerChat = 60) {
    if (!this.wechatRecentPath) return [];
    let data = {};
    try {
      const raw = await fs.readFile(this.wechatRecentPath, 'utf8');
      data = JSON.parse(raw) || {};
    } catch { return []; }
    const blocks = [];
    for (const [chatId, arr] of Object.entries(data)) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const sorted = [...arr].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const tail = sorted.slice(-maxPerChat);
      const lines = tail.map((e, i) => {
        const role = e.role === 'user' ? '用户' : 'AI';
        const text = String(e.text || '').slice(0, 500);
        return `[${i}] ${role}: ${text}`;
      });
      // chatId 脱敏成短 hash (preferences.md 里不暴露 wxid 长串)
      const chatTag = String(chatId).slice(-8);
      blocks.push({
        chatId,
        chatTag,
        userMsgCount: tail.filter((e) => e.role === 'user').length,
        text: lines.join('\n'),
      });
    }
    return blocks;
  }

  /**
   * Run the extractor. Idempotent — concurrent calls are deduped.
   * Returns { ok, learned, prefs?, reason? }.
   */
  async run({ force = false } = {}) {
    if (this._inFlight) return { ok: false, reason: 'in-flight' };
    if (!force && !(await this.shouldRun())) {
      return { ok: false, reason: 'guard not met' };
    }
    this._inFlight = true;
    try {
      const result = await this._runInner();
      this.state.lastRunAt = Date.now();
      this.state.runs += 1;
      // Update message-count baseline regardless of outcome — we don't want
      // to retry the same window over and over if extraction returned NONE.
      try {
        const raw = await fs.readFile(this.chatHistoryPath, 'utf8');
        this.state.lastUserMsgCount = ((JSON.parse(raw).history) || [])
          .filter((m) => m.role === 'user').length;
      } catch {}
      // 0.3.285: 同步更新 wechat baseline
      try {
        this.state.lastWechatUserMsgCount = await this._countWechatUserMsgs();
      } catch {}
      this._saveState();
      return result;
    } finally {
      this._inFlight = false;
    }
  }

  async _runInner() {
    let history;
    try {
      history = (JSON.parse(await fs.readFile(this.chatHistoryPath, 'utf8'))).history || [];
    } catch { history = []; }   // 0.3.285: chat tab 空也允许跑 (只要微信有内容)
    history = history.slice(-HISTORY_TURNS_TO_SCAN);

    // 0.3.285: 读微信对话作为额外语料源
    const wechatBlocks = await this._readWechatHistoryBlocks(60);
    const wechatUserMsgs = wechatBlocks.reduce((s, b) => s + b.userMsgCount, 0);
    const totalUserMsgs = history.filter((m) => m.role === 'user').length + wechatUserMsgs;
    if (totalUserMsgs < 5) return { ok: false, reason: 'too few user msgs across both sources' };

    // 0.3.243: 偏好搬出 CLAUDE.md 到独立 preferences.md (CLAUDE.md 是系统 template
    // 会被 refreshClaudeMd 全量重写, 偏好放里头会丢). 读现有 preferences.md 的
    // bullets 作为 existing 让 Claude 不重复输出.
    const preferencesMdPath = path.join(this.workspaceDir, 'preferences.md');
    let preferencesMd = '';
    try { preferencesMd = await fs.readFile(preferencesMdPath, 'utf8'); }
    catch { preferencesMd = ''; }   // 文件不存在 → 第一次创建, 视为空 prefs
    const existing = this._parsePreferencesMd(preferencesMd);

    // Build extractor prompt
    const turns = history.length ? history.map((m, i) => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const c = String(m.content || '').slice(0, 500);
      return `[${i}] ${role}: ${c}`;
    }).join('\n\n') : '（chat tab 暂无对话）';

    // 0.3.285: 微信对话块组装 — 每个 chatId 一段, chatTag 脱敏只露后 8 位
    const wechatSection = wechatBlocks.length
      ? wechatBlocks.map((b) =>
          `=== 微信对话 (chatTag=...${b.chatTag}, ${b.userMsgCount} 条用户消息) ===\n${b.text}`
        ).join('\n\n')
      : '（暂无微信对话历史）';

    const prompt = [
      '你的任务：从下面的对话历史中提取**稳定的用户偏好/习惯/明确指令**，让 AI 以后能记住。',
      '',
      '**双语料源**：',
      '- chat tab：用户在 EasyDeal 客户端 AI 对话窗口的内容',
      '- 微信对话：用户通过微信 ClawBot 跟 AI 沟通的内容 (用户本人, 不是其他客户)',
      '两个源都是同一用户, 提取出的偏好都进同一份 preferences.md.',
      '',
      '只提取符合下列任一标准的：',
      '1. 用户明确说"以后"/"记住"/"永远"/"绝对不要"/"保留"/"默认"等指令',
      '2. 用户对 AI 的某种回应方式**纠正了 ≥ 2 次**（同一类问题，重复修正）',
      '3. 用户表达过的具体领域偏好（常用品种、参数范围、输出格式偏好等）',
      '',
      '**不要**提取：',
      '- 一次性请求（"帮我看看 X"）',
      '- 已经在下方"已知偏好"列表里的（不要重复）',
      '- 模糊描述（"我喜欢简洁" — 不可执行）',
      '- 错误纠正中的临时修正（"这次别 XXX"）',
      '- 微信对话里其他人 (假设跟你在跟某客户聊) 的偏好 — 用户已确认微信只他自己用,',
      '  但保险起见, 第一人称"我"才是用户; "他说"/"客户反馈" 等转述视角不提取',
      '',
      '输出格式（**严格遵守**，只输出这个，不要任何其他文字）：',
      '- 偏好 1（一句话，可执行，具体）',
      '- 偏好 2',
      '或者如果没有新的可提取：',
      'NONE',
      '',
      '已知偏好（**不要重复输出**）：',
      existing.length ? existing.map((e) => `- ${e}`).join('\n') : '（无）',
      '',
      '【chat tab 对话历史】（按时间顺序，最新在最后）：',
      turns,
      '',
      '【微信对话历史】（按 chatId 分段，每段内时间顺序）：',
      wechatSection,
      '',
      '直接输出 bullet 列表或 NONE。',
    ].join('\n');

    let extracted = '';
    try {
      extracted = await spawnHeadlessClaude({
        prompt,
        cwd: this.workspaceDir,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (e) {
      this.log('extractor spawn failed: ' + e.message);
      return { ok: false, reason: 'claude spawn failed: ' + e.message };
    }

    const newPrefs = extracted.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || l.startsWith('*'))
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l.length > 0 && l.length < MAX_PREF_LEN)
      .filter((l) => !existing.some((e) => e.toLowerCase() === l.toLowerCase()));

    if (!newPrefs.length) {
      this.log('no new preferences extracted');
      return { ok: true, learned: 0 };
    }

    // Cap total — drop oldest if we'd exceed
    let combined = [...existing, ...newPrefs];
    if (combined.length > MAX_PREFS_TOTAL) {
      combined = combined.slice(combined.length - MAX_PREFS_TOTAL);
    }

    // 0.3.243: 写到独立 preferences.md (不再写 CLAUDE.md). 整个文件由本工具
    // 独占维护, 直接全量覆盖即可 — refreshClaudeMd 不动这个文件.
    const body = [
      '_由 EasyDeal preference-learner 自动写入. 用户多次表达稳定偏好后会更新这里. 最近更新: ' +
      new Date().toLocaleString('zh-CN') + '._',
      '',
      ...combined.map((p) => `- ${p}`),
      '',
    ].join('\n');
    await fs.writeFile(preferencesMdPath, body, 'utf8');
    this.log(`learned ${newPrefs.length} new preference(s): ` + newPrefs.join(' | '));
    return { ok: true, learned: newPrefs.length, prefs: newPrefs };
  }

  /** 0.3.243: 解析 preferences.md 拿出 bullets list. 整个文件由本工具独占维护
   *  (refreshClaudeMd 不动它), 解析逻辑只看 bullet lines. */
  _parsePreferencesMd(md) {
    return md.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || l.startsWith('*'))
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l.length > 0);
  }

  _parseSection(md) {
    const sectionStart = md.indexOf(SECTION_HEADER);
    if (sectionStart < 0) {
      return { existing: [], sectionStart: -1, sectionEnd: -1 };
    }
    const sectionEnd = md.indexOf(SECTION_FOOTER, sectionStart);
    const sectionText = sectionEnd > sectionStart
      ? md.slice(sectionStart + SECTION_HEADER.length, sectionEnd)
      : md.slice(sectionStart + SECTION_HEADER.length);
    const existing = sectionText.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || l.startsWith('*'))
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l.length > 0);
    return { existing, sectionStart, sectionEnd };
  }
}

module.exports = { PreferenceLearner };
