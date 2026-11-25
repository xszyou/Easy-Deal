// 0.3.152: 全局 Timer / Service 注册器 — 统一管理后台 ticker, 支持「全停」联动.
//
// 设计:
//   - register(spec) — 一个 ticker = setInterval + wrapper (try/catch + stats)
//   - registerService(spec) — 子模块自己管 setInterval, 暴露 pause()/resume() 给 registry 调
//   - pauseAll(reason, durationMs?) — 非 critical 全停 + 自动 resume (panic 用)
//   - resumeAll() — 全开
//   - pause(id) / resume(id) — 单条手动控制
//   - list() — UI 「监控」tab 列所有 timer 状态
//
// critical=true 的 timer panic 时也跑 (license heartbeat 之类不能掉).
// critical=false 的 timer 在 pauseAll 时停 (背景统计 / 跑 LLM / 推微信 等).

class TimerRegistry {
  constructor({ log = (...a) => console.log('[timer-registry]', ...a) } = {}) {
    this.log = log;
    /** @type {Map<string, object>} 受管 timer (setInterval-based, main.js 起的) */
    this.timers = new Map();
    /** @type {Map<string, object>} 受管 service (子模块自己 setInterval, 暴露 pause/resume) */
    this.services = new Map();
    this.paused = false;
    this.pausedReason = null;
    this.pausedAt = 0;
    /** @type {NodeJS.Timeout|null} 自动 resume timer */
    this._resumeTimer = null;
  }

  /**
   * 注册一个 ticker.
   * spec = {
   *   id: string,                  // 唯一 id, 用于 list / pause / resume
   *   intervalMs: number,          // 周期
   *   fn: async function,          // 每轮跑啥
   *   critical?: boolean,          // panic 时是否也跑 (default false)
   *   firstRunDelayMs?: number,    // 第一次跑前等多久 (default = intervalMs, 错峰用)
   *   runOnRegister?: boolean,     // 注册时立刻跑一次 (default false)
   *   description?: string,        // UI 显的说明
   * }
   */
  register(spec) {
    const { id, intervalMs, fn } = spec;
    if (!id) throw new Error('timer id required');
    if (typeof fn !== 'function') throw new Error('timer fn required');
    if (typeof intervalMs !== 'number' || intervalMs <= 0) {
      throw new Error('timer intervalMs required > 0');
    }
    if (this.timers.has(id)) {
      this.log(`WARN duplicate register id=${id}, replacing`);
      this.unregister(id);
    }
    const t = {
      id,
      intervalMs,
      fn,
      critical: !!spec.critical,
      description: spec.description || '',
      // runtime stats
      _interval: null,
      _firstRunTimer: null,
      runCount: 0,
      lastRunAt: 0,
      lastDurationMs: 0,
      lastError: null,
      consecutiveFails: 0,
      paused: false,
      pausedReason: null,
    };
    this.timers.set(id, t);

    // 首次执行: runOnRegister=true 立刻跑, 否则等 firstRunDelayMs (default = intervalMs)
    const firstDelay = spec.runOnRegister === true
      ? 0
      : (typeof spec.firstRunDelayMs === 'number' ? spec.firstRunDelayMs : intervalMs);
    t._firstRunTimer = setTimeout(() => {
      t._firstRunTimer = null;
      if (this.paused && !t.critical) {
        // 暂停中 — 不启 interval
        t.paused = true; t.pausedReason = this.pausedReason || 'paused';
        return;
      }
      this._runOnce(t).catch(() => {});
      this._startInterval(t);
    }, Math.max(0, firstDelay));
  }

  /**
   * 注册一个 service (子模块自己管 setInterval, 暴露 pause/resume hook).
   * spec = { id, critical?, description?, pause: async fn, resume: async fn, status?: () => object }
   */
  registerService(spec) {
    const { id, pause, resume } = spec;
    if (!id) throw new Error('service id required');
    if (typeof pause !== 'function' || typeof resume !== 'function') {
      throw new Error('service must expose pause() + resume()');
    }
    this.services.set(id, {
      id,
      critical: !!spec.critical,
      description: spec.description || '',
      pause, resume,
      status: spec.status || (() => ({})),
      paused: false,
      pausedReason: null,
      lastPauseError: null,
      lastResumeError: null,
    });
  }

  _startInterval(t) {
    if (t._interval) return;
    t._interval = setInterval(() => {
      this._runOnce(t).catch(() => {});
    }, t.intervalMs);
  }

  async _runOnce(t) {
    if (t.paused) return;
    const t0 = Date.now();
    try {
      await t.fn();
      t.runCount += 1;
      t.lastRunAt = t0;
      t.lastDurationMs = Date.now() - t0;
      t.lastError = null;
      t.consecutiveFails = 0;
    } catch (e) {
      t.lastError = String(e?.message || e).slice(0, 200);
      t.consecutiveFails += 1;
      t.lastDurationMs = Date.now() - t0;
      this.log(`[${t.id}] tick failed (${t.consecutiveFails}): ${t.lastError}`);
    }
  }

  unregister(id) {
    const t = this.timers.get(id);
    if (!t) return;
    if (t._interval) { clearInterval(t._interval); t._interval = null; }
    if (t._firstRunTimer) { clearTimeout(t._firstRunTimer); t._firstRunTimer = null; }
    this.timers.delete(id);
  }

  /**
   * 暂停所有 non-critical timer + service.
   * @param reason 描述性原因 (panic / user_request / ...)
   * @param durationMs 自动 resume 时间; null = 永不自动恢复, 等 resumeAll().
   */
  async pauseAll(reason = 'manual', durationMs = null) {
    this.paused = true;
    this.pausedReason = reason;
    this.pausedAt = Date.now();
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }

    // 停 main.js 自己的 timer
    let paused_count = 0;
    for (const t of this.timers.values()) {
      if (t.critical) continue;
      if (t._interval) { clearInterval(t._interval); t._interval = null; }
      if (t._firstRunTimer) { clearTimeout(t._firstRunTimer); t._firstRunTimer = null; }
      t.paused = true;
      t.pausedReason = reason;
      paused_count++;
    }

    // 停 子模块 service
    for (const s of this.services.values()) {
      if (s.critical) continue;
      try {
        await s.pause();
        s.paused = true;
        s.pausedReason = reason;
        s.lastPauseError = null;
        paused_count++;
      } catch (e) {
        s.lastPauseError = String(e?.message || e).slice(0, 200);
        this.log(`service ${s.id} pause() failed: ${s.lastPauseError}`);
      }
    }

    if (typeof durationMs === 'number' && durationMs > 0) {
      this._resumeTimer = setTimeout(() => {
        this.resumeAll().catch(() => {});
      }, durationMs);
    }
    this.log(`pauseAll(${reason}) — paused ${paused_count} timer/service${durationMs ? ` for ${durationMs}ms` : ''}`);
    return { ok: true, paused_count, reason, durationMs };
  }

  async resumeAll() {
    if (!this.paused) return { ok: true, already: true };
    this.paused = false;
    this.pausedReason = null;
    this.pausedAt = 0;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }

    let resumed_count = 0;
    for (const t of this.timers.values()) {
      if (!t.paused) continue;
      t.paused = false;
      t.pausedReason = null;
      // 立刻跑一次再启 interval — 让用户立刻看到效果
      this._runOnce(t).catch(() => {});
      this._startInterval(t);
      resumed_count++;
    }

    for (const s of this.services.values()) {
      if (!s.paused) continue;
      try {
        await s.resume();
        s.paused = false;
        s.pausedReason = null;
        s.lastResumeError = null;
        resumed_count++;
      } catch (e) {
        s.lastResumeError = String(e?.message || e).slice(0, 200);
        this.log(`service ${s.id} resume() failed: ${s.lastResumeError}`);
      }
    }
    this.log(`resumeAll — resumed ${resumed_count} timer/service`);
    return { ok: true, resumed_count };
  }

  async pause(id, reason = 'manual') {
    if (this.timers.has(id)) {
      const t = this.timers.get(id);
      if (t._interval) { clearInterval(t._interval); t._interval = null; }
      if (t._firstRunTimer) { clearTimeout(t._firstRunTimer); t._firstRunTimer = null; }
      t.paused = true; t.pausedReason = reason;
      return { ok: true };
    }
    if (this.services.has(id)) {
      const s = this.services.get(id);
      try { await s.pause(); s.paused = true; s.pausedReason = reason; return { ok: true }; }
      catch (e) { return { ok: false, error: String(e?.message || e) }; }
    }
    return { ok: false, error: 'not found' };
  }

  async resume(id) {
    if (this.timers.has(id)) {
      const t = this.timers.get(id);
      if (!t.paused) return { ok: true, already: true };
      t.paused = false; t.pausedReason = null;
      this._runOnce(t).catch(() => {});
      this._startInterval(t);
      return { ok: true };
    }
    if (this.services.has(id)) {
      const s = this.services.get(id);
      try { await s.resume(); s.paused = false; s.pausedReason = null; return { ok: true }; }
      catch (e) { return { ok: false, error: String(e?.message || e) }; }
    }
    return { ok: false, error: 'not found' };
  }

  /** UI 「监控」tab 用 — 列所有 timer/service 状态. */
  list() {
    const timers = [];
    for (const t of this.timers.values()) {
      timers.push({
        kind: 'timer',
        id: t.id,
        description: t.description,
        critical: t.critical,
        intervalMs: t.intervalMs,
        runCount: t.runCount,
        lastRunAt: t.lastRunAt,
        lastDurationMs: t.lastDurationMs,
        lastError: t.lastError,
        consecutiveFails: t.consecutiveFails,
        paused: t.paused,
        pausedReason: t.pausedReason,
      });
    }
    const services = [];
    for (const s of this.services.values()) {
      let st = {};
      try { st = s.status() || {}; } catch {}
      services.push({
        kind: 'service',
        id: s.id,
        description: s.description,
        critical: s.critical,
        paused: s.paused,
        pausedReason: s.pausedReason,
        lastPauseError: s.lastPauseError,
        lastResumeError: s.lastResumeError,
        status: st,
      });
    }
    return {
      paused: this.paused,
      pausedReason: this.pausedReason,
      pausedAt: this.pausedAt,
      timers,
      services,
    };
  }
}

// 模块单例 — main.js 用 `require('./timer-registry').timerRegistry`
const timerRegistry = new TimerRegistry();

module.exports = { TimerRegistry, timerRegistry };
