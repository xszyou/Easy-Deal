// Thin HTTP client for the EasyDeal authorization server.
//
// Base URL resolution:
//   1. EASYDEAL_API_URL env (dev override)
//   2. <userData>/easydeal-server.json  ({"url": "..."})
//   3. DEFAULT_BASE_URL fallback
//
// To point a packaged build at a custom server, drop:
//   { "url": "https://license.your-domain.com" }
// at  %APPDATA%\easydeal-client\easydeal-server.json

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedServerRequest } = require('./community-edition');

// Default = production server. Dev still overrides via EASYDEAL_API_URL
// env (e.g. `EASYDEAL_API_URL=http://127.0.0.1:8088 npm start`) or a
// per-machine config file as documented above.
const DEFAULT_BASE_URL = 'https://easydeal.fay-agent.com';

function _readConfigUrl() {
  try {
    const { app } = require('electron');
    if (!app) return null;
    const cfg = path.join(app.getPath('userData'), 'easydeal-server.json');
    if (!fs.existsSync(cfg)) return null;
    const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (obj && typeof obj.url === 'string' && /^https?:\/\//.test(obj.url)) {
      return obj.url.replace(/\/$/, '');
    }
  } catch {}
  return null;
}

let baseUrl = process.env.EASYDEAL_API_URL
  || _readConfigUrl()
  || DEFAULT_BASE_URL;

function setBaseUrl(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    baseUrl = url.replace(/\/$/, '');
  }
}
function getBaseUrl() { return baseUrl; }

async function request(method, p, { body, timeoutMs = 10000, _retriesLeft = 2 } = {}) {
  if (!isAllowedServerRequest(method, p)) {
    const err = new Error('not available in community edition');
    err.status = 0;
    err.offline = true;
    err.disabled = true;
    throw err;
  }
  const url = baseUrl + p;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      // 1.1.21: 5xx 自动重试 —— 服务端 git pull/重启那几秒会瞬时 502/503/500,
      // 用户(用户/用户 都撞过)在登录界面看到「Internal Server Error」红字。
      // 只对 5xx 重试(4xx 如 machine_locked/expired/revoked/bad_format 是确定性
      // 错误, 重试无意义且会误导); offline/timeout 仍走 catch 快速提示, 不在这退避。
      if (res.status >= 500 && _retriesLeft > 0) {
        clearTimeout(t);
        await new Promise((r) => setTimeout(r, 2500));
        return request(method, p, { body, timeoutMs, _retriesLeft: _retriesLeft - 1 });
      }
      const detail = (json && (json.detail || json.error)) || res.statusText || 'http_error';
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('timeout');
      err.status = 0;
      throw err;
    }
    if (!e.status) {
      e.status = 0;
      e.offline = true;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  get:  (p, opts)       => request('GET', p, opts),
  post: (p, body, opts) => request('POST', p, { ...(opts || {}), body }),
  put:  (p, body, opts) => request('PUT', p, { ...(opts || {}), body }),
  setBaseUrl, getBaseUrl,
};
