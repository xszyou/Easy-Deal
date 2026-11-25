// 0.3.43: 知识库 view 改三段式
//   ① 强制下载（服务端推） — admin 后台标 force_download，启动自动拉，
//                             本地不能删，常驻文件名带"强制"标
//   ② 可选下载（服务端推） — 用户在这一栏点「下载」自己拉，下载后转入「本地已下载」状态
//   ③ 本地知识库          — 用户自己 upload 的本地文件 + 已下载的可选服务库文件
// 用一次 server-list + 一次 kb.list 拉两份数据，合并后按 origin 分组渲染。
//
// 兼容老行为：本地 upload / 删除 / 在文件管理器打开 三个按钮还在。

const fmtSize = (b) => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};
const fmtTime = (t) => {
  if (!t) return '';
  const d = typeof t === 'number' ? new Date(t) : new Date(String(t));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
};

export function renderKnowledge(root) {
  root.innerHTML = '';

  const top = el('div', 'card');
  top.innerHTML = `
    <div class="section-head">
      <h2>知识库</h2>
      <span class="sub">workspace/knowledge/</span>
    </div>
    <p class="hint">
      上传到这里的文件会落到 AI 的工作目录 <code>workspace/knowledge/</code>，
      Agent 启动后会立刻知道有这些资料，可用 Read 工具读取。客户端自带的用户手册也在这里。
    </p>
    <div class="row" style="gap: 10px;">
      <button class="btn primary" id="kb-upload">上传本地文件</button>
      <button class="btn ghost" id="kb-folder">在文件管理器打开</button>
      <button class="btn ghost" id="kb-refresh">刷新</button>
    </div>
    <div id="kb-status" class="hint" style="margin-top: 8px; min-height: 18px;"></div>
  `;
  root.appendChild(top);

  const localCard = el('div', 'card');
  localCard.innerHTML = `
    <div class="section-head">
      <h2>本地知识库</h2>
      <span class="sub">你上传的文件和客户端自带的用户手册</span>
    </div>
    <div id="kb-local"></div>
  `;
  root.appendChild(localCard);

  // Button handlers
  top.querySelector('#kb-upload').addEventListener('click', async () => {
    const r = await window.easydeal.kb.upload();
    if (!r.added?.length) return;
    const errs = r.added.filter((x) => x.error);
    if (errs.length) {
      showToast(`部分失败：${errs.map((e) => e.name).join(', ')}`, 'error');
    } else {
      showToast(`已添加 ${r.added.length} 个文件`, 'ok');
    }
    await refresh();
  });
  top.querySelector('#kb-folder').addEventListener('click', () => window.easydeal.kb.openFolder());
  top.querySelector('#kb-refresh').addEventListener('click', refresh);

  function setStatus(msg, isErr = false) {
    const s = top.querySelector('#kb-status');
    s.textContent = msg || '';
    s.style.color = isErr ? 'var(--warn)' : '';
  }

  refresh();

  async function refresh() {
    const localFiles = await window.easydeal.kb.list().catch(() => []);
    renderLocal(localCard.querySelector('#kb-local'), localFiles, refresh);
  }
}

function renderLocal(host, list, refresh) {
  host.innerHTML = '';
  if (!list.length) {
    const empty = el('div', 'empty');
    empty.textContent = '本地知识库为空。点上方"上传本地文件"添加策略说明、行情研报、规则手册等参考资料。';
    host.appendChild(empty);
    return;
  }
  const table = el('table', 'list');
  table.innerHTML = `
    <thead>
      <tr>
        <th>文件名</th>
        <th style="width: 110px;">来源</th>
        <th style="width: 100px;">大小</th>
        <th style="width: 180px;">上传时间</th>
        <th style="width: 100px;">操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  for (const it of list) {
    const tr = el('tr');
    const originBadge = it.origin === 'server-forced'
      ? '<span class="pill" style="background: rgba(239,68,68,0.15); color: #ef4444; padding: 1px 6px; border-radius: 8px; font-size: 10px;">强制</span>'
      : it.origin === 'server-optional'
      ? '<span class="pill" style="background: rgba(74,158,255,0.15); color: var(--accent, #4a9eff); padding: 1px 6px; border-radius: 8px; font-size: 10px;">已下载</span>'
      : '<span class="pill" style="background: rgba(255,255,255,0.06); color: var(--text-3); padding: 1px 6px; border-radius: 8px; font-size: 10px;">本地</span>';
    const canDelete = it.origin !== 'server-forced';
    tr.innerHTML = `
      <td>
        <div><code>knowledge/${escapeHtml(it.name)}</code></div>
        ${it.description ? `<div class="muted small" style="margin-top: 2px;">${escapeHtml(it.description)}</div>` : ''}
      </td>
      <td>${originBadge}</td>
      <td>${fmtSize(it.size)}</td>
      <td><span class="muted small">${fmtTime(it.mtime)}</span></td>
      <td>
        ${canDelete
            ? `<button class="btn danger small" data-name="${escapeAttr(it.name)}">删除</button>`
            : '<span class="muted small" title="强制下载文件不能删，请联系管理员改为可选 / 停用">🔒 锁定</span>'}
      </td>
    `;
    tb.appendChild(tr);
  }
  host.appendChild(table);

  table.addEventListener('click', async (e) => {
    const name = e.target.dataset?.name;
    if (!name) return;
    if (!confirm(`确定删除 knowledge/${name}？此操作不可撤销。`)) return;
    try {
      await window.easydeal.kb.delete(name);
      showToast('已删除', 'ok');
      await refresh();
    } catch (err) {
      showToast('删除失败：' + (err.message || err), 'error');
    }
  });
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }
