const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

class BacktestsStore {
  constructor(filePath, pythonBin, service) {
    this.path = filePath;
    this.pythonBin = pythonBin;
    this.service = service;
  }

  static normalizeName(name) {
    return String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.mq5$/i, '');
  }

  async byEa() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8')).by_ea || {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  async all() {
    return Object.values(await this.byEa()).flat();
  }

  async listForEa(name) {
    return (await this.byEa())[BacktestsStore.normalizeName(name)] || [];
  }

  async unreadCountByEa() {
    const groups = await this.byEa();
    return Object.fromEntries(Object.entries(groups).map(([ea, rows]) =>
      [ea, rows.filter(r => !r.viewed && !['running', 'queued'].includes(r.status)).length]));
  }

  async change(action, value = null) {
    const { stdout } = await execute(this.pythonBin(), [this.service, action, this.path, JSON.stringify(value)],
      { windowsHide: true });
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  async userAction(action, value) {
    try { return await this.change(action, value); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  markEaRead(name) { return this.userAction('read', BacktestsStore.normalizeName(name)); }
  clearForEa(name) { return this.userAction('clear', BacktestsStore.normalizeName(name)); }
  deleteRecord(id) { return this.userAction('delete', id); }
}

module.exports = { BacktestsStore };
