// 公共前端工具:鉴权、API、格式化、状态徽章。
const Auth = {
  get token() { return localStorage.getItem('cc_token') || ''; },
  get staff() { try { return JSON.parse(localStorage.getItem('cc_staff') || 'null'); } catch { return null; } },
  save(token, staff) { localStorage.setItem('cc_token', token); localStorage.setItem('cc_staff', JSON.stringify(staff)); },
  clear() { localStorage.removeItem('cc_token'); localStorage.removeItem('cc_staff'); },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(Auth.token ? { Authorization: `Bearer ${Auth.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败(${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtHM(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtHM(ms)}`;
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), sec = s % 60;
  const h = Math.floor(m / 60);
  return h ? `${h}时${m % 60}分` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const STATUS_TEXT = {
  OPEN: '待派单', ASSIGNED: '已派单', ACKED: '已到床旁', OVERDUE: '超时未响应',
  ESCALATED: '急救升级', RESOLVED: '已结案', FALSE_REVIEW: '误触待核对', CLOSED_FALSE: '误触已结案',
};
const STATUS_CLASS = {
  OPEN: 'chip-warn', ASSIGNED: 'chip-info', ACKED: 'chip-ok', OVERDUE: 'chip-warn',
  ESCALATED: 'chip-emg', RESOLVED: 'chip-ok', FALSE_REVIEW: 'chip-muted', CLOSED_FALSE: 'chip-muted',
};
function chip(status) {
  return `<span class="chip ${STATUS_CLASS[status] || 'chip-muted'}">${STATUS_TEXT[status] || status}</span>`;
}

const PATROL_TEXT = { PENDING: '待巡查', DONE: '已巡查', MISSED: '漏检', DONE_LATE: '已补巡' };
const PATROL_CLASS = { PENDING: 'chip-info', DONE: 'chip-ok', MISSED: 'chip-warn', DONE_LATE: 'chip-muted' };
function patrolChip(s) { return `<span class="chip ${PATROL_CLASS[s]}">${PATROL_TEXT[s] || s}</span>`; }

function renderTopbar(active) {
  const s = Auth.staff;
  const links = [
    ['floor.html', '楼层屏'], ['mobile.html', '手机端'], ['patrol.html', '夜巡'],
    ['handover.html', '交班'], ['stats.html', '统计'],
  ];
  document.getElementById('topbar').innerHTML = `
    <span class="brand">颐年呼叫联动</span>
    <nav>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <span class="who">${s ? `${esc(s.name)} · ${{ caregiver: '护理员', shift_lead: '值班长', admin: '管理员' }[s.role] || s.role}
      <button class="ghost" style="color:#fff;border-color:#9fc3b2;padding:4px 10px" onclick="Auth.clear();location.reload()">退出</button>`
      : '<a href="index.html" style="color:#cfe0d6">登录</a>'}</span>`;
}

// 登录面板:渲染到指定容器,成功后回调
function renderLogin(containerId, onOk) {
  const el = document.getElementById(containerId);
  el.innerHTML = `
    <div class="card login-box">
      <h2>员工登录</h2>
      <label>姓名</label>
      <select id="lg-name">
        <option>陈静</option><option>刘洋</option><option>赵敏</option><option>孙浩</option>
        <option>周岚</option><option>系统管理员</option>
      </select>
      <label>密码(PIN)</label>
      <input id="lg-pin" type="password" placeholder="演示:护理员1001-1004 / 值班长2001 / 管理员9001">
      <div style="margin-top:14px"><button class="big" style="width:100%" id="lg-btn">登 录</button></div>
      <div class="err" id="lg-err" style="margin-top:8px"></div>
    </div>`;
  el.querySelector('#lg-btn').onclick = async () => {
    try {
      const r = await api('/api/login', { method: 'POST', body: { name: el.querySelector('#lg-name').value, pin: el.querySelector('#lg-pin').value } });
      Auth.save(r.token, r.staff);
      onOk();
    } catch (e) { el.querySelector('#lg-err').textContent = e.message; }
  };
}
