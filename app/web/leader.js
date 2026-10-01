// 值班长台：实时呼叫 · 误触核对 · 夜巡 · 交班 · 统计 · 住户资料（按岗位授权）
if (!api.staff) {
  showLogin();
} else if (api.staff.role !== 'leader') {
  topbar('值班长台');
  document.body.append(el('div', { class: 'wrap' },
    el('div', { class: 'card' },
      el('div', { class: 'where' }, '当前账号是护理员，无值班长权限'),
      el('div', { class: 'actions' },
        el('a', { href: '/phone' }, el('button', {}, '前往护理员手机端'))))));
} else {
  init();
}

let stopPoll = null;

async function init() {
  topbar('值班长台 · ' + api.staff.name);
  const wrap = el('div', { class: 'wrap' });
  const tabs = el('div', { class: 'tabs' });
  const panels = {};
  const tabDefs = [
    ['calls', '实时呼叫'],
    ['review', '误触核对'],
    ['patrols', '夜巡任务'],
    ['handovers', '交班记录'],
    ['stats', '响应统计'],
    ['residents', '住户资料'],
    ['demo', '演示控制'],
  ];
  for (const [key, label] of tabDefs) {
    const panel = el('div', { class: 'tab-panel hidden' });
    panels[key] = panel;
    const btn = el('button', {
      onclick: () => {
        for (const b of tabs.children) b.classList.remove('active');
        btn.classList.add('active');
        for (const k in panels) panels[k].classList.toggle('hidden', k !== key);
        loaders[key]?.();
      }
    }, label);
    tabs.append(btn);
    wrap.append(panel);
    if (key === 'calls') btn.classList.add('active');
    else panel.classList.add('hidden');
  }
  document.body.append(wrap);
  wrap.prepend(tabs);

  const loaders = { calls: loadCalls, review: loadReview, patrols: loadPatrols,
    handovers: loadHandovers, stats: loadStats, residents: loadResidents,
    demo: loadDemo };

  // 实时呼叫 / 误触核对两个页签每 2 秒自动刷新
  let currentTab = 'calls';
  const origSwitch = tabs.querySelectorAll('button');
  origSwitch.forEach((b, i) => b.addEventListener('click', () => { currentTab = tabDefs[i][0]; }));
  poll(async () => {
    if (currentTab === 'calls') await loadCalls();
    if (currentTab === 'review') await loadReview();
  }, 2000);
  loadCalls();

  // ---------------- 实时呼叫 ----------------
  async function loadCalls() {
    const [{ calls: open }, { calls: recent }] = await Promise.all([
      api.req('GET', '/api/calls?scope=open'),
      api.req('GET', '/api/calls?scope=all')
    ]);
    const p = panels.calls;
    p.innerHTML = '';
    p.append(el('h2', { class: 'section-title' }, `进行中（${open.length}）`));
    const grid = el('div', { class: 'cards' });
    if (!open.length) grid.append(el('div', { class: 'muted' }, '暂无进行中的呼叫'));
    for (const c of open) grid.append(await callCard(c));
    p.append(grid);

    p.append(el('h2', { class: 'section-title' }, '最近记录（含误触/急救结案）'));
    const table = el('table', {}, el('thead', {}, el('tr', {},
      ...['#', '位置', '住户', '状态', '负责人', '呼叫→结案', '处理结果/误触说明'].map(
        t => el('th', {}, t)))));
    const tbody = el('tbody');
    for (const c of recent.slice(0, 20)) {
      tbody.append(el('tr', {},
        el('td', {}, String(c.id)),
        el('td', {}, `${c.floor} ${c.bed}`),
        el('td', {}, c.resident || '—'),
        el('td', {}, c.status_label + (c.escalated ? ' 🚑' : '')),
        el('td', {}, c.assigned_staff || '—'),
        el('td', {}, c.opened_at_txt + (c.resolved_at_txt ? ' → ' + c.resolved_at_txt : '')),
        el('td', {}, c.resolution || (c.false_note ? `[${c.false_reason}] ${c.false_note}` : '—'))));
    }
    table.append(tbody);
    p.append(table);
  }

  async function callCard(c) {
    const shift = await api.req('GET', '/api/shift');
    const card = el('div', { class: 'card' + (c.escalated ? ' emergency' :
      c.status === 'active' || c.status === 'false_pending' ? ' warn' : '') });
    card.append(
      el('div', { class: 'row' },
        el('span', { class: 'where' }, `#${c.id} ${c.floor} · ${c.bed}`),
        statusBadge(c),
        c.escalated ? el('span', { class: 'badge red' }, '🚑 急救升级') : null,
        c.repeat_index > 1 ? el('span', { class: 'badge red' }, `连续${c.repeat_index}`) : null,
        c.away_flag ? el('span', { class: 'badge gray' }, '住户外出') : null),
      el('div', { class: 'muted' },
        `${c.resident || '空床'}（${c.care_level}）· 按钮 ${c.button}` +
        (c.button_online ? '' : ' · ⚠按钮离线')),
      el('div', { class: 'muted' },
        `呼叫 ${c.opened_at_txt} · 已 ${ageText(c.age_seconds)}` +
        (c.assigned_staff ? ` · ${c.assigned_staff} ${c.assigned_at_txt ? '派单于 ' + c.assigned_at_txt : ''}` : ' · 无人接单')),
    );
    if (c.escalated) {
      card.append(el('div', { style: 'color:var(--emergency);font-weight:700' },
        '升级原因：' + (c.escalate_reason || '')));
    }
    if (c.timeout_warned) {
      card.append(el('div', { class: 'muted', style: 'color:var(--warn)' }, '已发超时提醒'));
    }
    const actions = el('div', { class: 'actions' });
    if (c.status === 'active') {
      const sel = el('select', {}, ...shift.staff
        .filter(s => s.role === 'nurse')
        .map(s => el('option', { value: s.id }, s.name)));
      actions.append(sel, el('button', {
        onclick: async () => {
          try {
            await api.req('POST', '/api/calls/assign',
              { call_id: c.id, staff_id: Number(sel.value) });
            toast('派单成功', 'ok'); loadCalls();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, '派单'));
    }
    actions.append(el('button', { class: 'ghost', onclick: () => showEvents(c) }, '事件链'),
      el('button', {
        class: c.escalated ? 'ghost' : 'danger',
        onclick: async () => {
          const reason = await promptText('急救升级', {
            label: '升级原因', textarea: true,
            placeholder: '如：住户主诉胸痛、意识改变，按急救流程升级' });
          if (!reason) return;
          try { await api.req('POST', '/api/calls/escalate', { call_id: c.id, reason });
            toast('已急救升级并全员通知', 'ok'); loadCalls();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, '急救升级'));
    card.append(actions);
    return card;
  }

  function showEvents(c) {
    api.req('GET', '/api/events?call_id=' + c.id).then(data => {
      const feed = el('div', { class: 'feed' },
        ...data.events.map(e => el('div', { class: 'ev' },
          el('b', {}, `[${e.ts_txt}] ${eventLabel(e.type)}`),
          ' ', (e.actor || '系统'), '：', e.detail || '')));
      dialog(`呼叫 #${c.id} 事件链（全程留痕，交班不断链）`, feed,
        [{ text: '关闭', class: 'secondary' }]);
    });
  }

  // ---------------- 误触核对 ----------------
  async function loadReview() {
    const { calls } = await api.req('GET', '/api/calls?scope=open');
    const pending = calls.filter(c => c.status === 'false_pending');
    const p = panels.review;
    p.innerHTML = '';
    p.append(el('h2', { class: 'section-title' },
      `待值班长核对（${pending.length}）— 误触记录不可删除`));
    if (!pending.length) p.append(el('div', { class: 'muted' }, '没有待核对的误触说明'));
    for (const c of pending) {
      p.append(el('div', { class: 'card warn' },
        el('div', { class: 'where' }, `#${c.id} ${c.floor} · ${c.bed}（${c.resident || ''}）`),
        el('div', {}, `护理员：${c.assigned_staff}　呼叫时间：${c.opened_at_txt}`),
        el('div', {}, '误触原因：', el('b', {}, c.false_reason)),
        el('div', {}, '书面说明：', c.false_note),
        c.escalated ? el('div', { style: 'color:var(--emergency);font-weight:700' },
          '注意：该呼叫曾急救升级，核对为误触前请确认现场') : null,
        el('div', { class: 'actions' },
          el('button', {
            class: 'secondary',
            onclick: async () => {
              const note = await promptText('核实为误触（记录保留）',
                { label: '核对备注（可选）', required: false,
                  placeholder: '如：已查看楼层屏回放，确认为清洁碰压' });
              try {
                await api.req('POST', '/api/calls/false/review',
                  { call_id: c.id, approve: true, note: note || '' });
                toast('已核实为误触，记录保留', 'ok'); loadReview();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '✓ 核实为误触'),
          el('button', {
            class: 'danger',
            onclick: async () => {
              const note = await promptText('驳回误触（呼叫恢复处理）',
                { label: '驳回理由', placeholder: '如：住户表示确有呼叫需求' });
              if (!note) return;
              try {
                await api.req('POST', '/api/calls/false/review',
                  { call_id: c.id, approve: false, note });
                toast('已驳回，呼叫恢复处理流程', 'ok'); loadReview();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '✗ 驳回，继续处理'))));
    }
  }

  // ---------------- 夜巡 ----------------
  async function loadPatrols() {
    const { patrols } = await api.req('GET', '/api/patrols');
    const p = panels.patrols;
    p.innerHTML = '';
    const counts = patrols.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
    p.append(el('div', { class: 'muted', style: 'margin:8px 0 14px' },
      `待巡 ${counts.pending || 0} · 已巡 ${counts.done || 0} · 迟巡 ${counts.late || 0} · ` +
      `漏检 ${counts.missed || 0} · 已转交 ${counts.transferred || 0}　漏检会单独推送提醒`));
    const table = el('table', {}, el('thead', {}, el('tr', {},
      ...['楼层', '床位', '轮次', '应巡时间', '窗口至', '状态', '完成情况'].map(
        t => el('th', {}, t)))));
    const tbody = el('tbody');
    for (const x of patrols) {
      const badge = { done: 'green', late: 'amber', missed: 'red', pending: 'gray',
        transferred: 'gray' }[x.status] || 'gray';
      tbody.append(el('tr', x.status === 'missed' ? { style: 'background:var(--emergency-bg)' } : {},
        el('td', {}, x.floor), el('td', {}, x.bed), el('td', {}, x.round_name),
        el('td', {}, x.due_at_txt), el('td', {}, x.window_end_txt),
        el('td', {}, el('span', { class: 'badge ' + badge }, x.status_label)),
        el('td', {}, x.result
          ? `${x.result}（${x.done_by || ''} ${x.done_at_txt}）` : '—')));
    }
    table.append(tbody);
    p.append(table);
  }

  // ---------------- 交班 ----------------
  async function loadHandovers() {
    const [{ handovers }, shift, { residents }] = await Promise.all([
      api.req('GET', '/api/handovers'),
      api.req('GET', '/api/shift'),
      api.req('GET', '/api/residents')
    ]);
    const p = panels.handovers;
    p.innerHTML = '';
    p.append(el('h2', { class: 'section-title' }, '办理交班（未结呼叫与待办夜巡自动转交，链路不断）'));
    const nurses = shift.staff.filter(s => s.role === 'nurse');
    const fromSel = el('select', {}, ...nurses.map(s => el('option', { value: s.id }, s.name)));
    const toSel = el('select', {}, ...nurses.map(s => el('option', { value: s.id }, s.name)));
    toSel.value = String(nurses.find(s => Number(s.id) !== Number(fromSel.value))?.id || '');
    fromSel.addEventListener('change', () => {
      const other = nurses.find(s => Number(s.id) !== Number(fromSel.value));
      if (other) toSel.value = String(other.id);
    });
    const labelIn = el('input', { value: '夜班', placeholder: '新班次名称，如 夜班' });
    const summary = el('textarea', { placeholder: '交班摘要：在院重点住户、未结事项、设备异常…' });
    const fileIn = el('input', { type: 'file' });
    p.append(el('div', { class: 'card' },
      el('div', { class: 'row' }, el('label', {}, '交班人 ', fromSel),
        el('label', {}, '接班人 ', toSel),
        el('label', {}, '新班次 ', labelIn)),
      el('label', {}, '交班摘要', summary),
      el('label', {}, '交接附件（存入本地文件，不进数据库）', fileIn),
      el('div', { class: 'actions' },
        el('button', {
          onclick: async () => {
            if (!summary.value.trim()) { toast('请填写交班摘要', 'err'); return; }
            if (Number(fromSel.value) === Number(toSel.value)) {
              toast('交班人与接班人不能相同', 'err'); return;
            }
            const fd = new FormData();
            fd.append('from_staff_id', fromSel.value);
            fd.append('to_staff_id', toSel.value);
            fd.append('new_shift_label', labelIn.value || '夜班');
            fd.append('summary', summary.value);
            if (fileIn.files[0]) fd.append('attachment', fileIn.files[0]);
            try {
              const r = await api.req('POST', '/api/handovers', fd);
              toast(`交班完成：转交呼叫 ${r.calls.length} 通、夜巡 ${r.patrols.length} 项`, 'ok');
              loadHandovers();
            } catch (e) { toast(e.message, 'err'); }
          }
        }, '确认交班（值班长见证）'))));

    p.append(el('h2', { class: 'section-title' }, '交班记录'));
    const table = el('table', {}, el('thead', {}, el('tr', {},
      ...['时间', '交班人', '接班人', '值班长', '新班次', '转交呼叫', '转交夜巡',
        '摘要', '附件'].map(t => el('th', {}, t)))));
    const tbody = el('tbody');
    for (const h of handovers) {
      tbody.append(el('tr', {},
        el('td', {}, h.ts_txt), el('td', {}, h.from_name), el('td', {}, h.to_name),
        el('td', {}, h.leader_name),
        el('td', {}, shiftLabel(h.shift_id)),
        el('td', {}, h.transferred_call_ids.length
          ? '#' + h.transferred_call_ids.join('、#') : '无'),
        el('td', {}, h.transferred_patrol_ids.length
          ? String(h.transferred_patrol_ids.length) + ' 项' : '无'),
        el('td', {}, h.summary),
        el('td', {}, h.has_attachment
          ? el('a', { href: `/api/attachments?id=${h.id}`, target: '_blank' },
            h.attachment_name || '附件') : '—')));
    }
    table.append(tbody);
    p.append(table);

    // 住户外出登记也放在交班页（交班时核对在院情况）
    p.append(el('h2', { class: 'section-title' }, '住户外出登记'));
    const awayTable = el('table', {}, el('thead', {}, el('tr', {},
      ...['位置', '住户', '在院状态', '外出原因', '操作'].map(t => el('th', {}, t)))));
    const ab = el('tbody');
    for (const r of residents) {
      ab.append(el('tr', {},
        el('td', {}, `${r.floor} ${r.bed}`), el('td', {}, r.name),
        el('td', {}, r.present ? '在院' : '外出'),
        el('td', {}, r.out_reason || '—'),
        el('td', {}, r.present
          ? el('button', {
            class: 'secondary', onclick: async () => {
              const reason = await promptText(`${r.name} 外出登记`,
                { label: '外出原因', textarea: false, placeholder: '如：家属接回体检，今晚返院' });
              if (!reason) return;
              await api.req('POST', '/api/residents/away',
                { resident_id: r.id, away: true, reason });
              toast('已登记外出，该床呼叫会带外出提示', 'ok'); loadHandovers();
            }
          }, '登记外出')
          : el('button', {
            class: 'secondary', onclick: async () => {
              await api.req('POST', '/api/residents/away',
                { resident_id: r.id, away: false });
              toast('已登记返院', 'ok'); loadHandovers();
            }
          }, '登记返院'))));
    }
    awayTable.append(ab);
    p.append(awayTable);
  }

  function shiftLabel(sid) { return '班次#' + sid; }

  // ---------------- 统计 ----------------
  async function loadStats() {
    const s = await api.req('GET', '/api/stats');
    const p = panels.stats;
    p.innerHTML = '';
    const kpi = (n, l) => el('div', { class: 'kpi' }, el('div', { class: 'n' }, String(n)),
      el('div', { class: 'l' }, l));
    p.append(el('h2', { class: 'section-title' }, `本班（${s.shift || '—'}）响应统计`),
      el('div', { class: 'kpis' },
        kpi(s.total_calls, '呼叫总数'),
        kpi(s.by_status.active || 0, '待派单'),
        kpi(s.resolved, '已结案'),
        kpi(s.emergency_close, '急救结案'),
        kpi(s.false_confirmed, '误触已核实'),
        kpi(s.avg_response_seconds != null ? s.avg_response_seconds + ' 秒' : '—',
          '平均响应时长（呼叫→结案）')),
      el('h3', { class: 'section-title' }, '夜巡'),
      el('div', { class: 'kpis' },
        kpi(s.patrol.done || 0, '已巡'),
        kpi(s.patrol.late || 0, '迟巡'),
        kpi(s.patrol.missed || 0, '漏检'),
        kpi(s.patrol.pending || 0, '待巡')));
    const events = await api.req('GET', '/api/events');
    const feed = el('div', { class: 'feed' }, ...events.events.slice(0, 40).map(e =>
      el('div', { class: 'ev' },
        el('b', {}, `[${e.ts_txt}] ${eventLabel(e.type)}`),
        ' ', e.actor || '系统', e.detail ? '：' + e.detail : '')));
    p.append(el('h3', { class: 'section-title' }, '本班事件流'), feed);
  }

  // ---------------- 住户资料（岗位限制：仅值班长可见敏感字段）----------------
  async function loadResidents() {
    const { residents } = await api.req('GET', '/api/residents');
    const p = panels.residents;
    p.innerHTML = '';
    p.append(el('div', { class: 'muted', style: 'margin:8px 0' },
      '以下为虚构样本。饮食/病史/家属联系方式为敏感信息，仅值班长可见；护理员端已按岗位屏蔽。'));
    const table = el('table', {}, el('thead', {}, el('tr', {},
      ...['位置', '姓名', '护理等级', '在院', '饮食', '病史摘要', '家属联系'].map(
        t => el('th', {}, t)))));
    const tb = el('tbody');
    for (const r of residents) {
      tb.append(el('tr', {},
        el('td', {}, `${r.floor} ${r.bed}`), el('td', {}, r.name),
        el('td', {}, r.care_level),
        el('td', {}, r.present ? '在院' : '外出'),
        el('td', {}, r.dietary || '—'),
        el('td', {}, r.medical_note || '—'),
        el('td', {}, r.contact || '—')));
    }
    table.append(tb);
    p.append(table);
  }

  // ---------------- 演示控制 ----------------
  async function loadDemo() {
    const p = panels.demo;
    p.innerHTML = '';
    const state = await fetch('/api/state').then(r => r.json());
    const btnSel = el('select', {}, ...state.floors.flatMap(f =>
      f.beds.map(b => el('option', { value: b.button },
        `${f.name} ${b.label} ${b.resident === '（空床）' ? '' : b.resident}（${b.button}）`))));
    p.append(el('h2', { class: 'section-title' }, '模拟按钮'),
      el('div', { class: 'card' },
        el('div', { class: 'row' }, btnSel,
          el('button', {
            onclick: async () => {
              try {
                await api.req('POST', '/api/calls/press', { button: btnSel.value });
                toast('按钮已按下（呼叫产生）', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '按下呼叫'),
          el('button', {
            class: 'secondary', onclick: async () => {
              await api.req('POST', '/api/demo/offline', { button: btnSel.value });
              toast('已断开心跳，约20秒后楼层屏与值班长台收到离线提醒', 'ok');
            }
          }, '模拟离线'),
          el('button', {
            class: 'secondary', onclick: async () => {
              await api.req('POST', '/api/demo/online', { button: btnSel.value });
              toast('心跳已恢复', 'ok');
            }
          }, '恢复在线')),
      el('div', { class: 'muted' },
        '超时案例：按下按钮后不派单（15秒超时提醒、30秒自动急救升级）；派单后不到床（20秒提醒、45秒升级）。同床连续按 3 次自动急救升级。')));
  }
}

function eventLabel(type) {
  return {
    call_opened: '呼叫产生', assigned: '派单', arrived: '到床确认',
    resolved: '结案', escalated: '急救升级', false_requested: '提交误触',
    false_reviewed: '误触已核实', false_rejected: '误触驳回',
    patrol_done: '夜巡完成', handover_call: '交班转交',
    resident_away: '登记外出', resident_back: '登记返院'
  }[type] || type;
}
