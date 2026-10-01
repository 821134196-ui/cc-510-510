// 公共工具：鉴权、请求、弹窗、轮询
const api = {
  token: localStorage.getItem('token') || '',
  staff: JSON.parse(localStorage.getItem('staff') || 'null'),

  async req(method, path, body) {
    const opt = { method, headers: {} };
    if (body instanceof FormData) {
      opt.body = body;
    } else if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    if (this.token) opt.headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(path, opt);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) {
      this.token = ''; this.staff = null;
      localStorage.removeItem('token'); localStorage.removeItem('staff');
      if (!location.pathname.endsWith('/screen')) showLogin();
      throw new Error(data.error || '未登录');
    }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  },

  async login(code, pin) {
    const data = await this.req('POST', '/api/login', { code, pin });
    this.token = data.token; this.staff = data.staff;
    localStorage.setItem('token', data.token);
    localStorage.setItem('staff', JSON.stringify(data.staff));
    return data.staff;
  },

  logout() {
    this.req('POST', '/api/logout').catch(() => {});
    this.token = ''; this.staff = null;
    localStorage.removeItem('token'); localStorage.removeItem('staff');
    showLogin();
  }
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

function toast(msg, kind = '') {
  let host = document.querySelector('.toast-host');
  if (!host) { host = el('div', { class: 'toast-host' }); document.body.append(host); }
  const t = el('div', { class: 'toast ' + kind }, msg);
  host.append(t);
  setTimeout(() => t.remove(), 4200);
}

function dialog(title, bodyNodes, actions) {
  const back = el('div', { class: 'dialog-back' });
  const box = el('div', { class: 'dialog' },
    el('h3', {}, title), ...(Array.isArray(bodyNodes) ? bodyNodes : [bodyNodes]));
  const actionBar = el('div', { class: 'dialog-actions' });
  const close = () => back.remove();
  for (const a of actions) {
    actionBar.append(el('button', {
      class: a.class || 'secondary',
      onclick: () => { if (a.onClick(close) !== false) close(); }
    }, a.text));
  }
  box.append(actionBar);
  back.append(box);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.append(back);
  return box;
}

function promptText(title, { label = '说明', placeholder = '', textarea = true, required = true,
  options = null, defaultVal = '' } = {}) {
  return new Promise(resolve => {
    let input;
    const nodes = [];
    if (options) {
      input = el('select', {}, ...options.map(o =>
        el('option', { value: o.value }, o.label)));
      nodes.push(el('label', {}, label + '：', input));
    } else if (textarea) {
      input = el('textarea', { placeholder });
      nodes.push(el('label', {}, label + '：', input));
    } else {
      input = el('input', { placeholder, value: defaultVal });
      nodes.push(el('label', {}, label + '：', input));
    }
    dialog(title, nodes, [
      { text: '取消', class: 'ghost', onClick: () => resolve(null) },
      {
        text: '确定', onClick: close => {
          const v = input.value.trim();
          if (required && !v) { toast('请填写必填内容', 'err'); return false; }
          resolve(v);
        }
      }
    ]);
    setTimeout(() => input.focus(), 50);
  });
}

function showLogin(infoText = '') {
  document.querySelectorAll('.login-card').forEach(n => n.remove());
  const code = el('input', { placeholder: '工号，如 N1 / L1', autocomplete: 'username' });
  const pin = el('input', { type: 'password', placeholder: '口令：护理员 0000 / 值班长 1234',
    autocomplete: 'current-password' });
  const err = el('div', { class: 'muted', style: 'color:var(--emergency)' }, infoText);
  const card = el('div', { class: 'login-card' },
    el('h1', {}, '登录'),
    code, pin, err,
    el('button', {}, '登录'),
    el('div', { class: 'demo-hint' }, '虚构演示账号：值班长 L1/L2（1234），护理员 N1–N4（0000）'));
  card.querySelector('button').addEventListener('click', doLogin);
  pin.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  async function doLogin() {
    try {
      await api.login(code.value.trim(), pin.value.trim());
      location.reload();
    } catch (e) { err.textContent = e.message; }
  }
  document.body.append(card);
}

function topbar(title, rightExtra = []) {
  const who = api.staff ? `${api.staff.name}（${api.staff.role === 'leader' ? '值班长' : '护理员'}）` : '';
  const bar = el('div', { class: 'topbar' },
    el('h1', {}, title),
    el('div', { class: 'spacer' }),
    ...rightExtra,
    who ? el('span', { class: 'muted', style: 'color:#d8e7dc' }, who) : null,
    api.staff ? el('button', { class: 'secondary', onclick: () => api.logout() }, '退出')
      : el('button', { class: 'secondary', onclick: () => showLogin() }, '登录'));
  document.body.prepend(bar);
}

async function poll(fn, ms) {
  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try { await fn(); } catch (e) { /* 瞬时错误下轮重试 */ }
      await new Promise(r => setTimeout(r, ms));
    }
  };
  run();
  return () => { stopped = true; };
}

function ageText(sec) {
  if (sec < 60) return sec + ' 秒';
  return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
}

function statusBadge(c) {
  const map = {
    active: ['待派单', 'red'], assigned: ['已派单·待到床', 'amber'],
    arrived: ['已到床·待处理', 'amber'], resolved: ['已结案', 'green'],
    false_pending: ['误触待核', 'amber'], false_confirmed: ['误触已核实', 'gray'],
    false_rejected: ['误触驳回', 'red']
  };
  const [txt, cls] = map[c.status] || [c.status, 'gray'];
  return el('span', { class: 'badge ' + cls }, txt);
}
