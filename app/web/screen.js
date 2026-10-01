// 楼层屏：高对比大字；呼叫位置与时间紧邻；所有报警同时配文字。
const tickerEl = document.getElementById('ticker');
const floorsEl = document.getElementById('floors');
const clockEl = document.getElementById('clock');

let notifSince = 0;
let activeNotifs = new Map(); // id -> notif（屏上横幅，urgent 持续展示）

function h(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids.flat()) n.append(k);
  return n;
}

async function loadState() {
  const data = await fetch('/api/state').then(r => r.json());
  clockEl.textContent = data.now;
  floorsEl.innerHTML = '';
  const urgent = [];
  for (const f of data.floors) {
    const grid = h('div', 'screen-grid');
    for (const b of f.beds) {
      const call = b.call;
      const bed = h('div', 'screen-bed');
      if (!b.present) bed.classList.add('away');
      if (!b.online) bed.classList.add('offline');
      if (call) {
        bed.classList.add('calling', call.status);
        if (call.escalated) bed.classList.add('escalated');
      }
      bed.append(h('div', 'bed-label', b.label));
      bed.append(h('div', 'bed-meta',
        `${b.resident} · ${b.care_level || '—'}${b.present ? '' : ' · 外出'}`));
      if (!b.online) {
        bed.append(h('div', 'offline-tag', '⚠ 按钮离线 ' + b.button + '（请人工巡查）'));
      }
      if (call) {
        // 位置与时间紧邻：同一行
        const where = h('span', 'call-where',
          call.escalated ? '急救！' + call.floor : call.floor);
        const time = h('span', 'call-time', call.opened_at_txt);
        bed.append(h('div', 'call-line', where, time));
        const desc = call.status === 'active'
          ? (call.repeat_index > 1 ? `连续呼叫第${call.repeat_index}次 · 等待派单` : '呼叫 · 等待派单')
          : call.status === 'assigned'
            ? `已派 ${call.assigned_staff || ''} · 待到床（${call.age_seconds}秒）`
            : `${call.assigned_staff || ''} 已到床 · 处置中`;
        bed.append(h('div', 'bed-meta', desc));
        if (call.away_flag) bed.append(h('div', 'bed-meta', '⚠ 该床位登记住户外出，请现场核实'));
      }
      grid.append(bed);
    }
    floorsEl.append(h('div', 'screen-floor', h('h2', null, f.name), grid));
  }
  renderTicker();
}

function renderTicker() {
  // 横幅：取未消除的最高级通知（急救/呼叫/超时/漏检/离线）
  const order = { urgent: 0, warn: 1, info: 2 };
  const items = [...activeNotifs.values()]
    .filter(n => n.kind !== 'offline' || n.level === 'warn')
    .sort((a, b) => (order[a.level] - order[b.level]) || b.id - a.id);
  tickerEl.innerHTML = '';
  for (const n of items.slice(0, 3)) {
    const bar = h('div', 'screen-ticker' + (n.level === 'warn' ? ' warn' : ''),
      h('span', 'dot'),
      h('span', null, n.title + '　' + n.body));
    tickerEl.append(bar);
  }
}

async function pollNotifs() {
  try {
    const data = await fetch(`/api/notifications?channel=screen&target=all&since=${notifSince}`)
      .then(r => r.json());
    for (const n of data.notifications) {
      // 结案/恢复类文字消除对应横幅；紧急类保持在屏上
      if (/已结案|误触已核实|按钮恢复|到床/.test(n.title) && n.ref_call_id) {
        for (const [k, old] of activeNotifs) {
          if (old.ref_call_id === n.ref_call_id && old.kind === n.kind) activeNotifs.delete(k);
        }
      } else if (n.level !== 'info' && ['call', 'timeout', 'offline', 'patrol', 'escalate',
        'repeat'].includes(n.kind)) {
        activeNotifs.set(n.id, n);
      }
    }
    notifSince = data.latest;
    renderTicker();
  } catch (_) {}
}

loadState();
setInterval(loadState, 2000);
setInterval(pollNotifs, 1500);
