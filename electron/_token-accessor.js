// Tiny singleton bridge so claude-runner.js (used by both chat-session and
// the headless scheduler / wechat spawns) can pull the active TokenStore
// and a token-reissuer function without threading through every call site.
// main.js sets both once at boot.
//
// 0.3.38: 加 reissuer 持有 —— wechat / 定时任务 spawn 撞 channel 429
// (`claude exited 1: (no stderr)`) 时，claude-runner 调 reissuer 重签 fay
// token + 重试一次，跟 chat-session.js 同一套机制。

let _tokenStore = null;
let _reissuer = null;

module.exports = {
  set(ts)             { _tokenStore = ts; },
  get()                { return _tokenStore; },
  setReissuer(fn)      { _reissuer = (typeof fn === 'function') ? fn : null; },
  getReissuer()        { return _reissuer; },
};
