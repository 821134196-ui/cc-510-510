// 护理员手机端：只保留当前待办与确认动作。
if (!api.staff) {
  showLogin();
} else {
  init();
}

function init() {
  if (api.staff.role !== 'nurse') {
    topbar('护理员手机端');
    document.body.append(el('div', { class: 'phone-wrap' },
      el('div', { class: 'card' },
        el('div', { class: 'where' }, '当前账号不是护理员'),
        el('div', { class: 'muted' }, '值班长请使用值班长台 /leader'),
        el('div', { class: 'actions' },
          el('a', { href: '/leader' }, el('button', {}, '前往值班长台'))))));
    return;
  }
  topbar('护理员待办 · ' + api.staff.name);
  const wrap = el('div', { class: 'phone-wrap' });
  const todoH = el('h2', { class: 'section-title' }, '我的待办');
  const todoBox = el('div', { class: 'cards' });
  const openH = el('h2', { class: 'section-title' }, '待接单呼叫');
  const openBox = el('div', { class: 'cards' });
  const patrolH = el('h2', { class: 'section-title' }, '本班夜巡任务');
  const patrolBox = el('div', { class: 'cards' });
  wrap.append(todoH, todoBox, openH, openBox, patrolH, patrolBox);
  document.body.append(wrap);

  async function refresh() {
    const [mine, open, patrols] = await Promise.all([
      api.req('GET', '/api/calls?scope=mine'),
      api.req('GET', '/api/calls?scope=open'),
      api.req('GET', '/api/patrols')
    ]);
    renderMine(mine.calls);
    renderOpen(open.calls.filter(c => c.status === 'active'));
    renderPatrols(patrols.patrols);
  }

  function renderMine(calls) {
    todoBox.innerHTML = '';
    const actionable = calls.filter(c => c.status !== 'false_pending');
    if (!actionable.length) {
      todoBox.append(el('div', { class: 'phone-todo-empty' }, '当前没有分派给你的待办 🎉'));
    }
    for (const c of actionable) todoBox.append(callCard(c));
    // 误触待核的呼叫单独提示：等待值班长核对，护理员不能自行结案
    for (const c of calls.filter(c => c.status === 'false_pending')) {
      todoBox.append(el('div', { class: 'card warn' },
        el('div', { class: 'where' }, `${c.floor} · ${c.bed}`),
        el('div', {}, '误触说明已提交，等待值班长核对…'),
        el('div', { class: 'muted' }, `原因：${c.false_reason}；说明：${c.false_note}`)));
    }
  }

  function callCard(c) {
    const card = el('div', { class: 'card' + (c.escalated ? ' emergency' : '') });
    card.append(
      el('div', { class: 'row' },
        el('span', { class: 'where' }, `${c.floor} · ${c.bed}`),
        statusBadge(c)),
      el('div', { class: 'muted' },
        `${c.resident || '空床'}（${c.care_level || '—'}） · 按钮 ${c.button}`),
      el('div', { class: 'muted' },
        `呼叫时间 ${c.opened_at_txt} · 已持续 ${ageText(c.age_seconds)}` +
        (c.assigned_staff ? ` · ${c.assigned_staff}` : '')));
    if (c.repeat_index > 1) {
      card.append(el('div', { class: 'muted' }, `连续呼叫第 ${c.repeat_index} 次`));
    }
    if (c.away_flag) {
      card.append(el('div', { class: 'muted', style: 'color:var(--warn);font-weight:700' },
        '⚠ 该床位登记住户外出，仍须现场核实'));
    }
    if (c.escalated) {
      card.append(el('div', { style: 'color:var(--emergency);font-weight:800' },
        `🚑 已急救升级：${c.escalate_reason || ''}（普通结案已阻断，仅可急救结案）`));
    }
    const actions = el('div', { class: 'actions' });
    if (c.status === 'active') {
      actions.append(el('button', {
        onclick: async () => {
          try { await api.req('POST', '/api/calls/assign', { call_id: c.id }); toast('已接单', 'ok'); refresh(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }, '我来接单'));
    }
    if (c.status === 'assigned') {
      actions.append(el('button', {
        onclick: async () => {
          try { await api.req('POST', '/api/calls/arrive', { call_id: c.id }); toast('已确认到床', 'ok'); refresh(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }, '✅ 已到床确认'));
    }
    if (c.status === 'arrived') {
      actions.append(el('button', {
        class: 'secondary',
        onclick: async () => askFalse(c)
      }, '误触说明'));
      if (c.escalated) {
        actions.append(el('button', {
          class: 'danger',
          onclick: async () => askResolve(c, true)
        }, '🚑 急救结案'));
      } else {
        actions.append(el('button', {
          onclick: async () => askResolve(c, false)
        }, '填写处理结果并结案'));
      }
    }
    if (actions.children.length) card.append(actions);
    return card;
  }

  function renderOpen(calls) {
    openBox.innerHTML = '';
    if (!calls.length) openBox.append(el('div', { class: 'muted' }, '暂无待派单呼叫'));
    for (const c of calls) {
      const card = el('div', { class: 'card' + (c.escalated ? ' emergency' : '') },
        el('div', { class: 'row' },
          el('span', { class: 'where' }, `${c.floor} · ${c.bed}`), statusBadge(c)),
        el('div', { class: 'muted' },
          `${c.opened_at_txt} 呼叫 · 已等待 ${ageText(c.age_seconds)}` +
          (c.away_flag ? ' · 住户外出登记' : '')),
        el('div', { class: 'actions' },
          el('button', {
            onclick: async () => {
              try { await api.req('POST', '/api/calls/assign', { call_id: c.id }); toast('已接单', 'ok'); refresh(); }
              catch (e) { toast(e.message, 'err'); }
            }
          }, '我来接单')));
      openBox.append(card);
    }
  }

  function renderPatrols(patrols) {
    patrolBox.innerHTML = '';
    const mine = patrols.filter(p => p.status === 'pending' || p.status === 'late');
    if (!mine.length) {
      patrolBox.append(el('div', { class: 'muted' }, '暂无待办夜巡'));
      return;
    }
    for (const p of mine) {
      const cls = p.status === 'late' ? 'card warn' : 'card';
      patrolBox.append(el('div', { class: cls },
        el('div', { class: 'where' }, `${p.floor} · ${p.bed} — ${p.round_name}`),
        el('div', { class: 'muted' },
          `应在 ${p.due_at_txt} 前完成（窗口至 ${p.window_end_txt}）`),
        el('div', { class: 'actions' },
          el('button', {
            onclick: async () => {
              const result = await promptText(`夜巡确认 · ${p.bed}`,
                { label: '巡查结果', placeholder: '如：住户安睡，生命体征平稳，无异常' });
              if (!result) return;
              try {
                await api.req('POST', '/api/patrols/done', { task_id: p.id, result });
                toast('夜巡已确认', 'ok'); refresh();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '✅ 完成巡查'))));
    }
  }

  async function askResolve(c, emergency) {
    const result = await promptText(
      emergency ? '急救结案（须填写处置经过）' : '处理结果',
      { label: emergency ? '急救处置经过' : '处理结果',
        placeholder: emergency ? '如：已联系120，现场采取…' : '如：协助饮水、调整体位，已安抚' });
    if (!result) return;
    try {
      await api.req('POST', '/api/calls/resolve',
        { call_id: c.id, resolution: result, emergency });
      toast(emergency ? '急救已结案' : '已结案', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function askFalse(c) {
    const reason = await promptText('误触说明（记录不可删除，将提交值班长核对）', {
      label: '误触原因',
      options: [
        { value: '误触', label: '住户不慎触碰' },
        { value: '清洁碰压', label: '清洁/整理时碰压' },
        { value: '设备测试', label: '设备测试' },
        { value: '其他', label: '其他' }
      ]
    });
    if (!reason) return;
    const note = await promptText('误触说明（记录不可删除，将提交值班长核对）',
      { label: '书面说明', placeholder: '请写明现场情况，如：换床单时肘部碰到按钮，住户无呼叫需求' });
    if (!note) return;
    try {
      await api.req('POST', '/api/calls/false', { call_id: c.id, reason, note });
      toast('误触说明已提交，等待值班长核对', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  poll(refresh, 2000);
  refresh();
}
