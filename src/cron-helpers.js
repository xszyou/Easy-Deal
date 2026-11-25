// User-friendly cron helpers — the form composes a cron expression behind
// the scenes; the list view renders cron back into Chinese for casual users.

export const PRESETS = [
  { key: 'every-5min',  label: '每 5 分钟',       build: () => '*/5 * * * *' },
  { key: 'every-15min', label: '每 15 分钟',      build: () => '*/15 * * * *' },
  { key: 'every-30min', label: '每 30 分钟',      build: () => '*/30 * * * *' },
  { key: 'every-hour',  label: '每小时整点',      build: () => '0 * * * *' },
  { key: 'every-2h',    label: '每 2 小时',       build: () => '0 */2 * * *' },
  { key: 'daily',       label: '每天某时刻 …',    needs: 'time',     build: ({ time }) => timeToCron(time) },
  { key: 'weekdays',    label: '工作日某时刻 …',  needs: 'time',     build: ({ time }) => timeToCron(time, '1-5') },
  { key: 'weekly',      label: '每周某天某时 …',  needs: 'weekday-time', build: ({ time, weekday }) => timeToCron(time, weekday) },
  { key: 'once',        label: '一次性触发 …',    needs: 'datetime', build: ({ datetime }) => datetime },
  { key: 'custom',      label: '自定义 cron …',   needs: 'cron',     build: ({ cron }) => cron },
];

export const WEEKDAYS = [
  { v: '1', label: '周一' },
  { v: '2', label: '周二' },
  { v: '3', label: '周三' },
  { v: '4', label: '周四' },
  { v: '5', label: '周五' },
  { v: '6', label: '周六' },
  { v: '0', label: '周日' },
];

function timeToCron(timeStr, dow = '*') {
  const [h, m] = String(timeStr || '09:00').split(':').map((s) => parseInt(s, 10));
  const hour = isFinite(h) ? h : 9;
  const min = isFinite(m) ? m : 0;
  return `${min} ${hour} * * ${dow}`;
}

// Reverse: cron / ISO datetime → human-friendly Chinese description.
export function humanizeSchedule(expr) {
  if (!expr) return '—';
  // ISO 8601 datetime → one-shot
  if (/^\d{4}-\d{2}-\d{2}T/.test(expr)) {
    try {
      return '一次性 · ' + new Date(expr).toLocaleString('zh-CN', { hour12: false });
    } catch { return expr; }
  }

  // Exact preset matches
  const exact = {
    '*/1 * * * *':  '每分钟',
    '*/5 * * * *':  '每 5 分钟',
    '*/10 * * * *': '每 10 分钟',
    '*/15 * * * *': '每 15 分钟',
    '*/30 * * * *': '每 30 分钟',
    '0 * * * *':    '每小时整点',
    '0 */2 * * *':  '每 2 小时',
    '0 */4 * * *':  '每 4 小时',
    '0 */6 * * *':  '每 6 小时',
    '0 0 * * *':    '每天 00:00',
  };
  if (exact[expr]) return exact[expr];

  // Pattern: M H * * D
  const m = expr.match(/^(\*\/\d+|\d+)\s+(\*\/\d+|\d+)\s+\*\s+\*\s+(\*|\*\/\d+|\d+(?:[,\-]\d+)*|\d+-\d+)$/);
  if (m) {
    const [, mm, hh, dow] = m;
    const tm = formatTime(hh, mm);
    if (tm) {
      if (dow === '*') return `每天 ${tm}`;
      if (dow === '1-5') return `工作日 ${tm}`;
      if (dow === '0,6' || dow === '6,0') return `周末 ${tm}`;
      const single = dow.match(/^(\d)$/);
      if (single) {
        const n = parseInt(single[1], 10);
        const labels = ['周日','周一','周二','周三','周四','周五','周六'];
        return `每${labels[n % 7]} ${tm}`;
      }
    }
  }

  // Pattern: every-N minutes only (M */N * * *)
  const ne = expr.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (ne) return `每 ${ne[1]} 分钟`;

  return expr; // fallback to raw cron
}

function formatTime(hh, mm) {
  if (/^\*\//.test(hh) || /^\*\//.test(mm)) return null;
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  if (!isFinite(h) || !isFinite(m)) return null;
  return `${pad(h)}:${pad(m)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
