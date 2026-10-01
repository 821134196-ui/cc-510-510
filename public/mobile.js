// 护理员手机端:只显示当前待办和确认动作;值班长登录时附加派单/急救/误触核对工作台。
renderTopbar('mobile.html');
let timer = null;
let staffCache = null;

function boot() {
  if (!Auth.staff) { renderLogin('app', boot); return; }
  // 值班长派单需要护理员名单
  if (['shift_lead', 'admin'].includes(Auth.staff.role) && !staffCache) {
    api('/api/staff').then((s) => { staffCache = s; tick(); }).catch(() => {});
  }
  tick();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 3000);
}

async function tick() {
  let d;
  try { d = await api('/api/mobile/todos'); }
  catch (e) {
    if (e.status === 401 || e.status === 403) { Auth.clear(); clearInterval(timer); renderLogin('app', boot); }
    return;
  }
  render(d);
}

function render(d) {
  const el = document.getElementById('app');
  const callsHtml = d.calls.length ? d.calls.map((c) => callCard(c, d.now)).join('')
    : '<div class="empty">✓ 当前没有待处理呼叫</div>';
  const claimHtml = (d.claimable || []).map((c) => `
    <div class="todo ${c.status === 'OVERDUE' ? 'overdue' : ''}">
      <div class="loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '')}</div>
      <div class="time">呼叫 ${fmtTime(c.triggered_at)} · 等待 ${fmtDur(d.now - c.triggered_at)}</div>
      <div style="margin-top:6px">${chip(c.status)}${c.repeat_count > 1 ? ` <span class="badge amber">连续呼叫×${c.repeat_count}</span>` : ''}</div>
      <div class="actions"><button onclick="doClaim(${c.id})">接 单</button></div>
    </div>`).join('');
  const patrolsHtml = d.patrols.length ? d.patrols.map((p) => `
    <div class="todo">
      <div class="loc">夜巡 ${esc(p.room)}室</div>
      <div class="time">计划 ${fmtHM(p.scheduled_at)} ${patrolChip(p.status)}</div>
      <div class="actions"><button onclick="doCheck(${p.id})">完成巡查</button></div>
    </div>`).join('') : '';

  el.innerHTML = `
    <h1 style="font-size:1.4rem">当前待办 <span class="muted" style="font-size:.9rem">${fmtTime(d.now)}</span></h1>
    ${callsHtml}
    ${claimHtml ? `<div class="section-title">本楼层未派单(可领取)</div>${claimHtml}` : ''}
    ${patrolsHtml ? `<div class="section-title">夜巡待办</div>${patrolsHtml}` : ''}
    ${d.lead ? leadBench(d) : ''}`;
}

function callCard(c, now) {
  const cls = c.status === 'ESCALATED' ? 'emg' : (c.status === 'OVERDUE' ? 'overdue' : '');
  let actions = '';
  if (c.status === 'ASSIGNED' || c.status === 'OVERDUE') {
    actions += `<button onclick="doAck(${c.id})">确认到达床旁</button>`;
  }
  if (c.status === 'ACKED') {
    actions += `<button onclick="doResolve(${c.id})">填写处理结果并结案</button>`;
  }
  if (c.status === 'ESCALATED') {
    actions += `<div class="banner emg" style="margin:0">急救中,等待值班长处置</div>`;
  } else if (c.status === 'FALSE_REVIEW') {
    actions += `<div class="banner info" style="margin:0">误触待值班长核对</div>`;
  } else {
    actions += `<button class="ghost" onclick="doFalse(${c.id})">报告误触</button>`;
    actions += `<button class="danger" onclick="doEscalate(${c.id})">急救升级</button>`;
  }
  return `<div class="todo ${cls}">
    <div class="loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '')}</div>
    <div class="time">呼叫 ${fmtTime(c.triggered_at)} · 等待 ${fmtDur(now - c.triggered_at)}</div>
    <div style="margin-top:6px">${chip(c.status)}
      ${c.repeat_count > 1 ? `<span class="badge amber">连续呼叫×${c.repeat_count}</span>` : ''}
      ${c.resident_away ? '<span class="badge">外出期间触发</span>' : ''}</div>
    <div class="actions">${actions}</div>
  </div>`;
}

// 值班长工作台:派单 / 急救结案 / 误触核对
function leadBench(d) {
  const { unassigned, escalated, false_review } = d.lead;
  const opts = (id) => (staffCache || [])
    .filter((s) => s.role === 'caregiver')
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const unHtml = unassigned.map((c) => `
    <div class="todo ${c.status === 'OVERDUE' ? 'overdue' : ''}">
      <div class="loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '')}</div>
      <div class="time">呼叫 ${fmtTime(c.triggered_at)} ${chip(c.status)}</div>
      <div class="actions">
        <select id="as-${c.id}" style="font-size:1.1rem;padding:12px">${opts(c.id)}</select>
        <button onclick="doAssign(${c.id})">派 单</button>
      </div>
    </div>`).join('');
  const emgHtml = escalated.map((c) => `
    <div class="todo emg">
      <div class="loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '')}</div>
      <div class="time">急救原因:${esc(c.escalation_reason || '')}</div>
      <div class="actions"><button class="danger" onclick="doEmgResolve(${c.id})">急救结案</button></div>
    </div>`).join('');
  const frHtml = false_review.map((c) => `
    <div class="todo">
      <div class="loc">${esc(c.room)}室 ${esc(c.label)}床 · ${esc(c.resident_name || '')}</div>
      <div class="time">误触说明:${esc(c.false_reason || '')}</div>
      <div class="actions">
        <button onclick="doVerify(${c.id}, true)">核对通过(误触结案)</button>
        <button class="ghost" onclick="doVerify(${c.id}, false)">核对不通过(退回处理)</button>
      </div>
    </div>`).join('');
  return `<div class="section-title">值班长工作台</div>
    ${unHtml ? `<div class="section-title" style="font-size:1rem">待派单</div>${unHtml}` : ''}
    ${emgHtml ? `<div class="section-title" style="font-size:1rem;color:var(--red)">急救中</div>${emgHtml}` : ''}
    ${frHtml ? `<div class="section-title" style="font-size:1rem">误触待核对</div>${frHtml}` : ''}
    ${!unHtml && !emgHtml && !frHtml ? '<div class="empty">✓ 没有待处理事项</div>' : ''}`;
}

async function run(fn) {
  try { await fn(); tick(); } catch (e) { alert(e.message); }
}
window.doAck = (id) => run(() => api(`/api/calls/${id}/ack`, { method: 'POST' }));
window.doClaim = (id) => run(() => api(`/api/calls/${id}/assign`, { method: 'POST', body: { staff_id: Auth.staff.id } }));
window.doAssign = (id) => run(() => api(`/api/calls/${id}/assign`, {
  method: 'POST', body: { staff_id: Number(document.getElementById(`as-${id}`).value) },
}));
window.doResolve = (id) => {
  const resolution = prompt('请填写处理结果(必填):');
  if (resolution) return run(() => api(`/api/calls/${id}/resolve`, { method: 'POST', body: { resolution } }));
};
window.doEscalate = (id) => {
  const reason = prompt('急救升级原因(必填):');
  if (reason) return run(() => api(`/api/calls/${id}/escalate`, { method: 'POST', body: { reason } }));
};
window.doEmgResolve = (id) => {
  const note = prompt('急救处置记录(必填):');
  if (note) return run(() => api(`/api/calls/${id}/emergency-resolve`, { method: 'POST', body: { note } }));
};
window.doFalse = (id) => {
  const reason = prompt('误触说明(必填,提交后由值班长核对,记录不会删除):');
  if (reason) return run(() => api(`/api/calls/${id}/false-trigger`, { method: 'POST', body: { reason } }));
};
window.doVerify = (id, approve) => run(() => api(`/api/calls/${id}/false-verify`, { method: 'POST', body: { approve } }));
window.doCheck = (id) => run(() => api(`/api/patrol/${id}/check`, { method: 'POST', body: {} }));

boot();
