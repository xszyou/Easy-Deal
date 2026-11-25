// Community edition: WeChat integration is not part of this build. The class
// exists only so main.js can load; it is never started.

const { EventEmitter } = require('node:events');

class WechatSidecar extends EventEmitter {
  constructor() { super(); this.client = null; }
  async start() { return false; }
  async stop() {}
  status() { return { logged_in: false, available: false }; }
  getStatus() { return this.status(); }
}

module.exports = { WechatSidecar };
