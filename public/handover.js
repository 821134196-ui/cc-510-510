// 交班记录:链式展示(上一班未确认则不允许新开),支持本地附件上传。
renderTopbar('handover.html');
let floors = [], staffList = [];

async function boot() {
  if (!Auth.staff) { renderLogin('app', boot); return; }
  [floors, staffList] = await Promise.all([api('/api/floors'), api('/api/staff')]);
  tick();
  setInterval(tick, 5000);
}

async function tick() {
  const list = await api('/api/handovers');
  render(list);
}

function render(list) {
  const me = Auth.staff;
  const myFloor = me.floor_id || floors[0]?.id;
  const caregivers = staffList.filter((s) => s.role === 'caregiver' && s.id !== me.id);

  const chainHtml = list.length ? list.map((h) => `
    <div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <strong style="font-size:1.15rem">#${h.id} ${esc(h.floor_name)}</strong>
        ${h.status === 'ACKED'
          ? '<span class="chip chip-ok">已确认接班</span>'
          : '<span class="chip chip-warn">待接班确认</span>'}
        ${h.prev_id ? `<span class="muted">承接上一班 #${h.prev_id}</span>` : '<span class="muted">首班</span>'}
      </div>
      <div style="margin-top:8px">${esc(h.out_name)} → ${esc(h.in_name)} · ${fmtDateTime(h.created_at)}</div>
      ${h.note ? `<div style="margin-top:6px">交接说明:${esc(h.note)}</div>` : ''}
      <div style="margin-top:6px" class="muted">移交未结束呼叫 ${h.open_call_ids.length} 件${h.open_call_ids.length ? '(#' + h.open_call_ids.join(', #') + ')' : ''}</div>
      ${h.attachment_path ? `<div style="margin-top:6px"><a href="/api/handovers/${h.id}/attachment" target="_blank">📎 下载交接附件</a></div>` : ''}
      ${h.status === 'PENDING' && h.in_staff_id === me.id
        ? `<div style="margin-top:10px"><button onclick="doAck(${h.id})">确认接班</button></div>` : ''}
    </div>`).join('') : '<div class="card muted">暂无交班记录</div>';

  document.getElementById('app').innerHTML = `
    <div class="card">
      <h2>发起交班</h2>
      <div class="row">
        <div><label>楼层</label>
          <select id="h-floor">${floors.map((f) => `<option value="${f.id}" ${f.id === myFloor ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
        <div><label>接班人</label>
          <select id="h-in">${caregivers.map((s) => `<option value="${s.id}">${esc(s.name)}(护理员)</option>`).join('')}</select></div>
      </div>
      <label>交接说明</label>
      <textarea id="h-note" rows="3" placeholder="本班重点情况、需继续关注事项"></textarea>
      <label>交接附件(可选,保存为本地文件)</label>
      <input type="file" id="h-file">
      <div style="margin-top:12px"><button class="big" onclick="doCreate()">提交交班</button></div>
      <div class="err" id="h-err" style="margin-top:8px"></div>
    </div>
    <h2 style="color:var(--green-dark)">交接链</h2>
    ${chainHtml}`;
}

window.doCreate = async () => {
  const errEl = document.getElementById('h-err');
  errEl.textContent = '';
  try {
    const file = document.getElementById('h-file').files[0];
    let attachment = null;
    if (file) {
      const buf = await file.arrayBuffer();
      attachment = { name: file.name, data: btoa(String.fromCharCode(...new Uint8Array(buf))) };
    }
    await api('/api/handovers', {
      method: 'POST',
      body: {
        floor_id: Number(document.getElementById('h-floor').value),
        in_staff_id: Number(document.getElementById('h-in').value),
        note: document.getElementById('h-note').value,
        attachment,
      },
    });
    tick();
  } catch (e) { errEl.textContent = e.message; }
};

window.doAck = async (id) => {
  try { await api(`/api/handovers/${id}/ack`, { method: 'POST' }); tick(); }
  catch (e) { alert(e.message); }
};

boot();
