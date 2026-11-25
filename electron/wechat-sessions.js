// Community edition: WeChat integration is not part of this build.

class WechatSessionStore {
  async load() {}
  pruneOlderThan() { return 0; }
  getSessionId() { return null; }
  setSessionId() {}
  getEndpoint() { return null; }
  clear() {}
  summary() { return { count: 0 }; }
}

module.exports = { WechatSessionStore };
