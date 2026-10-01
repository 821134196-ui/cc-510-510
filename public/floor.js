// 楼层屏:床位图 + 实时呼叫。只读大屏,2.5 秒轮询。
let floorId = Number(localStorage.getItem('cc_floor') || 1);
let floors = [];

renderTopbar('floor.html');

async function boot() {
  floors = await api('/api/floors');
  if (!floors.find((f) => f.id === floorId)) floorId = floors[0]?.id;
  renderTabs();
  tick();
  setInterval(tick, 2500);
  setInterval(() => { document.getElementById('clock').textContent = fmtTime(Date.now()); }, 1000);
}

function renderTabs() {
  document.getElementById('floor-tabs').innerHTML = floors
    .map((f) => `<button class="${f.id === floorId ? 'sel' : 'ghost'}" onclick="switchFloor(${f.id})">${esc(f.name)}</button>`)
    .join('');
  document.getElementById('floor-name').textContent = floors.find((f) => f.id === floorId)?.name || '楼层屏';
}
window.switchFloor = (id) => { floorId = id; localStorage.setItem('cc_floor', id); renderTabs(); tick(); };

async function tick() {
  let b;
  try { b = await api(`/api/floors/${floorId}/board`); }
  catch { return; }
  renderAlerts(b);
  renderBeds(b);
  renderCalls(b);
  renderTicker(b);
}

function renderAlerts(b) {
  const emg = b.active_calls.filter((c) => c.status === 'ESCALATED');
  const overdue = b.active_calls.filter((c) => c.status === 'OVERDUE');
  const el = document.getElementById('alerts');
  let html = '';
  for (const c of emg) {
    html += `<div class="banner emg">⚠ 急救升级:${c.room}室${c.label}床 ${esc(c.resident_name || '')} —— ${esc(c.escalation_reason || '')},请立即支援</div>`;
  }
  for (const c of overdue) {
    html += `<div class="banner warn">⏱ 超时未响应:${c.room}室${c.label}床 呼叫已等待 ${fmtDur(b.now - c.triggered_at)},请立即处理</div>`;
  }
  el.innerHTML = html;
  const ec = document.getElementById('emg-count');
  ec.style.display = emg.length ? '' : 'none';
  ec.textContent = `急救 ${emg.length} 件`;
}

function bedState(bed) {
  if (bed.active_call?.status === 'ESCALATED') return 'st-emg';
  if (bed.active_call) return 'st-active';
  if (bed.button_status === 'OFFLINE') return 'st-offline';
  if (bed.resident_status && bed.resident_status !== 'IN') return 'st-away';
  return '';
}

function renderBeds(b) {
  document.getElementById('bed-grid').innerHTML = b.beds.map((bed) => {
    const c = bed.active_call;
    const away = bed.resident_status === 'AWAY' ? '<span class="badge">外出</span>'
      : bed.resident_status === 'HOSPITAL' ? '<span class="badge">就医</span>' : '';
    const offline = bed.button_status === 'OFFLINE' ? '<span class="badge amber">按钮离线</span>' : '';
    return `<div class="bed ${bedState(bed)}">
      <div class="room">${esc(bed.room)}<span style="font-size:1rem;font-weight:600"> ${esc(bed.label)}床</span></div>
      <div class="rname">${esc(bed.resident_name || '空床')} ${away}</div>
      <div class="sub">${bed.care_level ? esc(bed.care_level) : ''}</div>
      ${c ? chip(c.status) + (c.repeat_count > 1 ? ` <span class="badge amber">连续呼叫×${c.repeat_count}</span>` : '') : ''}
      ${offline}
    </div>`;
  }).join('');
}

function renderCalls(b) {
  const list = document.getElementById('call-list');
  if (!b.active_calls.length) {
    list.innerHTML = '<div class="card" style="font-size:1.3rem;color:var(--green-dark)">✓ 当前无进行中呼叫</div>';
    return;
  }
  const order = { ESCALATED: 0, OVERDUE: 1, OPEN: 2, ASSIGNED: 3, ACKED: 4, FALSE_REVIEW: 5 };
  const sorted = [...b.active_calls].sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || x.triggered_at - y.triggered_at);
  list.innerHTML = sorted.map((c) => `
    <div class="call-card ${c.status === 'ESCALATED' ? 'emg' : ''}">
      <div class="call-loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '未知住户')}</div>
      <div class="call-time">呼叫时间 ${fmtTime(c.triggered_at)} · 已等待 ${fmtDur(b.now - c.triggered_at)}</div>
      <div class="call-meta">
        ${chip(c.status)}
        ${c.repeat_count > 1 ? `<span class="badge amber">连续呼叫×${c.repeat_count}</span>` : ''}
        ${c.resident_away ? '<span class="badge">外出期间触发</span>' : ''}
        ${c.assignee_name ? `<span class="badge">护理员:${esc(c.assignee_name)}</span>` : '<span class="badge amber">未派单</span>'}
      </div>
      ${c.status === 'ESCALATED' ? `<div style="margin-top:6px;font-weight:700;color:var(--red)">急救原因:${esc(c.escalation_reason || '')}</div>` : ''}
    </div>`).join('');
}

function renderTicker(b) {
  document.getElementById('ticker').innerHTML = b.notifications.length
    ? b.notifications.map((n) => `<div>[${fmtHM(n.at)}] ${esc(n.message)}</div>`).join('')
    : '<div class="muted">暂无播报</div>';
}

boot();
