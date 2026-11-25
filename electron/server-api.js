// Thin HTTP client for the EasyDeal backend.
//
// Backend URL is read from EASYDEAL_API_URL (env) or falls back to a
// localhost dev placeholder. Each method gracefully returns
// { offline: true, items: [] } shaped data when the server is unreachable —
// callers can pair this with mock-data.js for a usable preview.

const http = require('node:http');
const https = require('node:https');
const { isAllowedServerRequest } = require('./community-edition');

// Default = production server. For dev, run with EASYDEAL_API_URL=http://127.0.0.1:8088
const BASE = (process.env.EASYDEAL_API_URL || 'https://easydeal.fay-agent.com').replace(/\/$/, '');

function request(method, path, body, { timeoutMs = 8000, headers = {} } = {}) {
  if (!isAllowedServerRequest(method, path)) {
    return Promise.resolve({ ok: false, offline: true, disabled: true, error: 'not available in community edition' });
  }
  return new Promise((resolve) => {
    let url;
    try { url = new URL(BASE + path); }
    catch (e) { return resolve({ ok: false, offline: true, error: 'invalid base url' }); }

    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = lib.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,                       // 调用方自定义头（如 X-License-Key，手机中继用）
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c.toString('utf8')));
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; }
        catch { parsed = { raw: buf }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, ...((parsed && typeof parsed === 'object') ? parsed : { data: parsed }) });
        } else {
          // FastAPI 把结构化错误塞在 `detail` 字段里 ——
          //   - 字符串 detail (HTTPException(403, "expired"))    → detail = "expired"
          //   - dict   detail (HTTPException(402, detail={...})) → detail = {error, message, ...}
          // 之前只读 parsed.error，对 dict-detail 完全捞不到任何信息，
          // 用户看到一个 "Forbidden" 就懵了。这里按优先级提取最具体的字段。
          const detail = parsed && typeof parsed === 'object' ? parsed.detail : null;
          let bestMsg = null;
          let detailObj = null;
          if (typeof detail === 'string') {
            bestMsg = detail;
          } else if (detail && typeof detail === 'object') {
            bestMsg = detail.message || detail.error || null;
            detailObj = detail;
          }
          if (!bestMsg) {
            bestMsg = parsed?.message || parsed?.error || res.statusMessage;
          }
          resolve({
            ok: false,
            status: res.statusCode,
            error: bestMsg,
            detail: detailObj,             // 结构化错误体；含 scope / tier / quota 等
            detail_raw: detail ?? null,    // 原始 detail（字符串或对象）
          });
        }
      });
    });

    req.on('error', () => resolve({ ok: false, offline: true, error: 'unreachable' }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, offline: true, error: 'timeout' }); });

    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  baseUrl: () => BASE,
  get:  (p, opts)       => request('GET', p, null, opts),
  post: (p, body, opts) => request('POST', p, body, opts),
  put:  (p, body, opts) => request('PUT', p, body, opts),
  del:  (p, opts)       => request('DELETE', p, null, opts),
};
