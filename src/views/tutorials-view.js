// Tutorials view — card grid pulled from server, with platform / difficulty filters.

const PLATFORMS = [
  { key: '',                label: '全部'   },
  { key: 'douyin',          label: '抖音'   },
  { key: 'wechat_channels', label: '视频号' },
  { key: 'bilibili',        label: 'B站'    },
];

const PLATFORM_META = {
  douyin:          { name: '抖音',    cls: 'pl-douyin' },
  wechat_channels: { name: '视频号',  cls: 'pl-wechat' },
  bilibili:        { name: 'B站',     cls: 'pl-bili'   },
  xhs:             { name: '小红书',  cls: 'pl-xhs'    },
  youtube:         { name: 'YouTube', cls: 'pl-yt'     },
  other:           { name: '其他',    cls: 'pl-other'  },
};

const DIFFICULTIES = [
  { key: '',     label: '全部难度' },
  { key: '入门', label: '入门'     },
  { key: '进阶', label: '进阶'     },
  { key: '高手', label: '高手'     },
];

const DIFF_CLASS = { '入门': 'df-entry', '进阶': 'df-mid', '高手': 'df-pro' };

let currentPlatform = '';
let currentDifficulty = '';

export function renderTutorials(root) {
  root.innerHTML = '';

  const hero = el('section', 'hero-tight');
  hero.innerHTML = `
    <h1>教程</h1>
    <p class="lede">高赞作者 + 官方课程，按平台和难度筛。<span class="lede-dim">点开后会用对应 App 扫码观看。</span></p>
  `;
  root.appendChild(hero);

  const offline = el('div', 'banner banner-info');
  offline.innerHTML = `
    <span class="banner-dot"></span>
    <span>当前未连接服务端，展示<strong>预览课程</strong>。</span>
  `;
  offline.style.display = 'none';
  root.appendChild(offline);

  const filterCard = el('div', 'card');
  filterCard.innerHTML = `
    <div class="row wrap" style="gap: 22px; align-items: baseline;">
      <div>
        <label>平台</label>
        <div class="pill-row" id="tut-platforms"></div>
      </div>
      <div>
        <label>难度</label>
        <div class="pill-row" id="tut-diffs"></div>
      </div>
    </div>
  `;
  root.appendChild(filterCard);
  filterCard.querySelector('#tut-platforms').innerHTML = PLATFORMS.map((p) =>
    `<button class="pill ${p.key === currentPlatform ? 'active' : ''}" data-pl="${p.key}">${p.label}</button>`
  ).join('');
  filterCard.querySelector('#tut-diffs').innerHTML = DIFFICULTIES.map((d) =>
    `<button class="pill ${d.key === currentDifficulty ? 'active' : ''}" data-diff="${d.key}">${d.label}</button>`
  ).join('');
  filterCard.querySelector('#tut-platforms').addEventListener('click', (e) => {
    const v = e.target.dataset?.pl; if (v == null) return;
    currentPlatform = v; updatePills(filterCard, 'pl', v); refresh();
  });
  filterCard.querySelector('#tut-diffs').addEventListener('click', (e) => {
    const v = e.target.dataset?.diff; if (v == null) return;
    currentDifficulty = v; updatePills(filterCard, 'diff', v); refresh();
  });

  const grid = el('div');
  grid.id = 'tut-grid';
  root.appendChild(grid);

  refresh();

  async function refresh() {
    grid.innerHTML = `<div class="empty">加载中…</div>`;
    const r = await window.easydeal.server.tutorials({
      platform: currentPlatform || undefined,
      difficulty: currentDifficulty || undefined,
    });
    offline.style.display = r.offline ? 'flex' : 'none';
    renderGrid(grid, r.items || []);
  }
}

function renderGrid(host, items) {
  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = `<div class="empty">没有匹配的课程</div>`;
    return;
  }
  const grid = el('div', 'tut-grid');
  for (const it of items) {
    const platKey = it.platform || 'other';
    const platMeta = PLATFORM_META[platKey] || PLATFORM_META.other;
    const diffCls = DIFF_CLASS[it.difficulty] || 'df-entry';
    const card = el('a', 'tut-card');
    card.href = it.url || '#';
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML = `
      <div class="tut-cover ${it.cover_url ? '' : 'tut-cover-empty'}"
           ${it.cover_url ? `style="background-image: url('${escape(it.cover_url)}');"` : ''}>
        ${it.cover_url ? '' : '<span>▷</span>'}
        <span class="tut-duration">${it.duration_min ?? '—'} min</span>
      </div>
      <div class="tut-body">
        <div class="tut-meta">
          <span class="tut-plat ${platMeta.cls}">${platMeta.name}</span>
          ${it.difficulty ? `<span class="tut-diff ${diffCls}">${escape(it.difficulty)}</span>` : ''}
          ${it.tag ? `<span class="tut-tag">${escape(it.tag)}</span>` : ''}
        </div>
        <h3>${escape(it.title)}</h3>
        <p>${escape(it.description || '')}</p>
        <div class="tut-foot">
          <span>${escape(it.author || '')}</span>
          <span style="color: var(--text-4);">${fmtDate(it.published_at)}</span>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
  host.appendChild(grid);
}

function updatePills(host, attr, active) {
  for (const b of host.querySelectorAll(`button[data-${attr}]`)) {
    b.classList.toggle('active', b.dataset[attr] === active);
  }
}
function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString('zh-CN'); }
  catch { return ''; }
}
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
