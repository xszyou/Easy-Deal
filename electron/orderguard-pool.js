// OrderGuard pool (0.3.191 Phase 3) — manages one OrderGuard subprocess per
// MT5 instance. Routes IPC calls by EA-binding (resolveMt5ForEa) or by
// instance_id query param. Aggregates queries that span all instances
// (positions / enabled-eas / overview-stats / decisions without ea filter).
//
// 单实例用户行为不变 — pool 只一个 entry, 所有 routing 都打到那个唯一 OG, 跟
// 0.3.190 之前 single-instance 模式等价 (并且老的 orderguard.db 自动迁移到
// 新文件名, 用户历史 decisions / ea_anchors 不会丢).
//
// 多实例用户: 每个 MT5 实例独立的 OG 进程
//   - 端口段错开 (PORT_CANDIDATES + poolIndex*100 偏移)
//   - SQLite db 各自独立 (orderguard-<id>.db)
//   - mt5.initialize() attach 到各自的 installDir
//   - 启用/禁用/重置 EA 走 resolveMt5ForEa → 路由到对应 OG
//   - UI 聚合查询自动合并所有 OG 的数据

const path = require('node:path');
const fs = require('node:fs');
const { OrderGuard } = require('./orderguard');

class OrderGuardPool {
  /**
   * @param {object} opts
   * @param {string} opts.pythonBin
   * @param {string} opts.scriptPath
   * @param {string} opts.userDataDir
   * @param {string} opts.mqhSourcePath
   * @param {Function} opts.sessionTokenProvider
   * @param {string} opts.serverBaseUrl
   * @param {Function} [opts.log]
   * @param {Function} opts.listMt5Instances  () => [{ id, name, installDir, dataDir }]
   * @param {Function} opts.resolveMt5ForEa    async (eaName) => { instance_id, installDir, dataDir, source }
   * @param {Function} [opts.getActiveInstanceId]  () => string | null
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || ((m) => console.log('[orderguard-pool]', m));
    this._pool = new Map();   // instance_id → OrderGuard
    this._migrationDone = false;
  }

  /**
   * Spawn one OG per active MT5 instance. Migrates legacy orderguard.db to
   * the first instance's per-instance db file if found.
   */
  async startAll() {
    const instances = (this.opts.listMt5Instances?.() || []).filter((i) => i && i.installDir);
    if (!instances.length) {
      this.log('no MT5 instances configured — skipping OG pool startup');
      return;
    }

    // Legacy migration: if 0.3.190- has orderguard.db sitting at userData/data/,
    // move it to the first instance's per-instance db file so historical
    // decisions / anchors / rules don't get orphaned.
    this._migrateLegacyDbIfNeeded(instances[0]);

    let idx = 0;
    for (const inst of instances) {
      try {
        await this._spawnOne(inst, idx);
      } catch (e) {
        this.log(`spawn for instance ${inst.name} failed: ${e?.message || e}`);
      }
      idx++;
    }
    this.log(`pool started, ${this._pool.size}/${instances.length} OG processes running`);
  }

  /** Stop every OG in the pool. */
  async stopAll() {
    const all = Array.from(this._pool.values());
    await Promise.all(all.map((og) => og.stop().catch(() => {})));
    this._pool.clear();
    this.log('pool stopped');
  }

  /** Reconcile pool with current MT5 instances (call after add/remove instance). */
  async reconcile() {
    const desired = (this.opts.listMt5Instances?.() || []).filter((i) => i && i.installDir);
    const desiredIds = new Set(desired.map((d) => d.id));
    const currentIds = new Set(this._pool.keys());

    // stop removed
    for (const id of currentIds) {
      if (!desiredIds.has(id)) {
        const og = this._pool.get(id);
        this.log(`reconcile: instance ${id} gone, stopping OG`);
        try { await og.stop(); } catch {}
        this._pool.delete(id);
      }
    }
    // spawn added
    let idx = 0;
    for (const inst of desired) {
      if (!this._pool.has(inst.id)) {
        this.log(`reconcile: new instance ${inst.name} (${inst.id}), spawning OG`);
        try { await this._spawnOne(inst, idx); } catch (e) { this.log(`spawn err: ${e?.message || e}`); }
      }
      idx++;
    }
  }

  /**
   * Get the OG for an EA's bound instance. Falls back to active / first OG
   * if EA isn't bound or its instance no longer exists.
   * @returns {OrderGuard | null}
   */
  async getForEa(eaName) {
    try {
      const r = await this.opts.resolveMt5ForEa(eaName);
      if (r?.instance_id && this._pool.has(r.instance_id)) {
        return this._pool.get(r.instance_id);
      }
    } catch {}
    return this.getActiveOrFirst();
  }

  /** Sync version - lookup only, doesn't await resolve. For diagnostic / aggregate paths. */
  getByInstanceId(instanceId) {
    return this._pool.get(instanceId) || null;
  }

  /** Active instance's OG, or first one if no active set, or null. */
  getActiveOrFirst() {
    const activeId = this.opts.getActiveInstanceId?.() || null;
    if (activeId && this._pool.has(activeId)) return this._pool.get(activeId);
    const first = this._pool.values().next();
    return first.done ? null : first.value;
  }

  /** List all OGs as [{instance_id, name, og}]. */
  listAll() {
    const out = [];
    for (const [id, og] of this._pool.entries()) {
      out.push({ instance_id: id, name: og.instanceName, og });
    }
    return out;
  }

  /** Total count of OG processes in pool. */
  size() { return this._pool.size; }

  /**
   * Run a function on every OG (in parallel) and return an array of results
   * tagged with instance_id. Used for aggregate queries (positions, decisions
   * without ea filter, enabled-eas, overview-stats, etc.).
   * @param {(og: OrderGuard) => Promise<any>} fn
   * @returns {Promise<Array<{instance_id, name, result, error?}>>}
   */
  async fanOut(fn) {
    const tasks = this.listAll().map(async ({ instance_id, name, og }) => {
      try {
        const result = await fn(og);
        return { instance_id, name, result };
      } catch (e) {
        return { instance_id, name, error: String(e?.message || e) };
      }
    });
    return Promise.all(tasks);
  }

  /** Returns the "primary" OG (active or first) for fall-back / single-instance paths. */
  primary() { return this.getActiveOrFirst(); }

  /** Migrate legacy single-instance orderguard.db to first-instance file name. */
  _migrateLegacyDbIfNeeded(firstInstance) {
    if (this._migrationDone) return;
    this._migrationDone = true;
    try {
      const dataDir = path.join(this.opts.userDataDir, 'data');
      const legacyDb = path.join(dataDir, 'orderguard.db');
      if (!fs.existsSync(legacyDb)) return;

      const sanitizedId = String(firstInstance.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'x';
      const targetDb = path.join(dataDir, `orderguard-${sanitizedId}.db`);
      if (fs.existsSync(targetDb)) {
        this.log(`legacy migration: target ${targetDb} already exists, leaving legacy ${legacyDb} alone`);
        return;
      }
      fs.renameSync(legacyDb, targetDb);
      this.log(`legacy migration: ${legacyDb} → ${targetDb} (first instance ${firstInstance.name})`);
      // Also try to migrate WAL/SHM files if present (SQLite WAL mode)
      for (const ext of ['-wal', '-shm']) {
        const src = legacyDb + ext;
        const dst = targetDb + ext;
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try { fs.renameSync(src, dst); } catch {}
        }
      }
    } catch (e) {
      this.log(`legacy migration failed: ${e?.message || e}`);
    }
  }

  /** Spawn one OG for a given MT5 instance. */
  async _spawnOne(inst, poolIndex) {
    // 0.4.x 防进程泄漏: 若该实例已有 OG 在池里 (重复 startAll / race), 先停旧再建 —
    // 否则下面 _pool.set 覆盖 Map 会让旧 python 子进程成孤儿 (跟微信 sidecar 那个
    // 200 进程 / 32k 连接泄漏同一类教训, 这里提前堵上).
    const existing = this._pool.get(inst.id);
    if (existing) {
      this.log(`_spawnOne: 实例 ${inst.id} 已有 OG, 先停旧再重建 (防孤儿)`);
      try { await existing.stop(); } catch {}
      this._pool.delete(inst.id);
    }
    const og = new OrderGuard({
      pythonBin: this.opts.pythonBin,
      scriptPath: this.opts.scriptPath,
      userDataDir: this.opts.userDataDir,
      mt5InstallDir: inst.installDir,
      mt5DataDir: inst.dataDir || '',   // 1.5.1 多实例修复: 传本实例 dataDir 给 OG
      mt5LaunchMode: inst.launchMode || '',
      mqhSourcePath: this.opts.mqhSourcePath,
      sessionTokenProvider: this.opts.sessionTokenProvider,
      serverBaseUrl: this.opts.serverBaseUrl,
      instanceId: inst.id,
      instanceName: inst.name || inst.id,
      poolIndex,
    });
    await og.start();
    this._pool.set(inst.id, og);
    return og;
  }
}

module.exports = { OrderGuardPool };
