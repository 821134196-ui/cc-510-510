// 夜巡任务:漏检单独提醒(置顶独立区块),计划列表按时间分组。
renderTopbar('patrol.html');

function boot() {
  if (!Auth.staff) { renderLogin('app', boot); return; }
  tick();
  setInterval(tick, 5000);
}

async function tick() {
  const [plans, missed] = await Promise.all([api('/api/patrol/tonight'), api('/api/patrol/missed')]);
  render(plans, missed);
}

function render(plans, missed) {
  const el = document.getElementById('app');
  const canCheck = ['caregiver', 'shift_lead'].includes(Auth.staff?.role);

  const missedHtml = missed.length ? `
    <div class="banner warn">⚠ 夜巡漏检 ${missed.length} 项,请立即补巡:
      <ul style="margin:8px 0 0">${missed.map((p) => `<li>${esc(p.floor_name)} ${esc(p.room)}室 · 计划 ${fmtHM(p.scheduled_at)}</li>`).join('')}</ul>
    </div>` : '<div class="banner info">✓ 当前没有漏检项</div>';

  // 按巡查轮次时间分组
  const groups = {};
  for (const p of plans) (groups[p.scheduled_at] ||= []).push(p);
  const rows = Object.keys(groups).sort((a, b) => a - b).map((t) => {
    const items = groups[t];
    const done = items.filter((i) => i.status === 'DONE' || i.status === 'DONE_LATE').length;
    return `<div class="card">
      <h2>${fmtHM(Number(t))} 轮次 <span class="muted" style="font-size:.85rem">${done}/${items.length} 完成</span></h2>
      <table class="grid"><tr><th>楼层</th><th>房间</th><th>状态</th><th>执行人</th><th>完成时间</th><th></th></tr>
      ${items.map((p) => `<tr>
        <td>${esc(p.floor_name)}</td><td style="font-weight:700">${esc(p.room)}室</td>
        <td>${patrolChip(p.status)}</td>
        <td>${esc(p.checked_by_name || '—')}</td>
        <td>${p.checked_at ? fmtHM(p.checked_at) : '—'}</td>
        <td>${canCheck && (p.status === 'PENDING' || p.status === 'MISSED')
          ? `<button onclick="doCheck(${p.id})">${p.status === 'MISSED' ? '补巡' : '巡查'}打卡</button>` : ''}</td>
      </tr>`).join('')}</table>
    </div>`;
  }).join('');

  el.innerHTML = missedHtml + rows;
}

window.doCheck = async (id) => {
  try { await api(`/api/patrol/${id}/check`, { method: 'POST', body: {} }); tick(); }
  catch (e) { alert(e.message); }
};

boot();
