// 呼叫生命周期状态机。所有状态迁移都写 call_events 审计流水并发出文字通知。
//
//   按键 -> OPEN(待派单)
//   OPEN --派单--> ASSIGNED --到床旁确认--> ACKED --填写处理结果--> RESOLVED
//   OPEN/ASSIGNED 超过响应阈值 --> OVERDUE(超时未响应,可继续接单/到达)
//   任意未结束状态 --急救升级--> ESCALATED(普通结案被阻断,仅值班长可急救结案)
//   误触: --填报原因--> FALSE_REVIEW --值班长核对--> CLOSED_FALSE(记录保留,不删除)
//   同一床位有未结束呼叫时再次按键 -> 合并为"连续呼叫"(repeat_count+1),不新建、不重复派单
import { get, all, run } from '../db.js';
import { clock } from '../clock.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';
import { notify, CHANNEL, LEVEL } from '../adapters/notify.js';
import { ROLE } from './auth.js';

export const CALL_STATUS = {
  OPEN: 'OPEN',
  ASSIGNED: 'ASSIGNED',
  ACKED: 'ACKED',
  OVERDUE: 'OVERDUE',
  ESCALATED: 'ESCALATED',
  RESOLVED: 'RESOLVED',
  FALSE_REVIEW: 'FALSE_REVIEW',
  CLOSED_FALSE: 'CLOSED_FALSE',
};

// 未结束 = 还会出现在待办/楼层屏上的状态
export const ACTIVE_STATUSES = [
  CALL_STATUS.OPEN,
  CALL_STATUS.ASSIGNED,
  CALL_STATUS.ACKED,
  CALL_STATUS.OVERDUE,
  CALL_STATUS.ESCALATED,
  CALL_STATUS.FALSE_REVIEW,
];

const STATUS_TEXT = {
  OPEN: '待派单',
  ASSIGNED: '已派单',
  ACKED: '已到床旁',
  OVERDUE: '超时未响应',
  ESCALATED: '急救升级',
  RESOLVED: '已结案',
  FALSE_REVIEW: '误触待核对',
  CLOSED_FALSE: '误触已结案',
};

function addEvent(db, callId, type, { at, actorId = null, detail = '' }) {
  run(db, 'INSERT INTO call_events(call_id, at, actor_id, type, detail) VALUES (?,?,?,?,?)',
    callId, at, actorId, type, detail);
}

export function bedLocation(db, bedId) {
  const b = get(db, 'SELECT b.room, b.label, f.name AS floor_name, b.floor_id FROM beds b JOIN floors f ON f.id = b.floor_id WHERE b.id = ?', bedId);
  return b ? `${b.floor_name} ${b.room}室${b.label}床` : `床位#${bedId}`;
}

function getCall(db, id) {
  const c = get(db, 'SELECT * FROM calls WHERE id = ?', id);
  if (!c) throw notFound('CALL_NOT_FOUND', `呼叫 #${id} 不存在`);
  return c;
}

function activeCallForBed(db, bedId) {
  const marks = ACTIVE_STATUSES.map(() => '?').join(',');
  return get(db, `SELECT * FROM calls WHERE bed_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT 1`,
    bedId, ...ACTIVE_STATUSES);
}

// ---- 按键触发(由按钮适配器调用)----
export function pressButton(db, { buttonId, at = clock.now(), via = 'BUTTON' }) {
  const btn = get(db, 'SELECT * FROM buttons WHERE id = ?', buttonId);
  if (!btn) throw notFound('BUTTON_NOT_FOUND', '按钮不存在');
  if (btn.status === 'OFFLINE') throw conflict('BUTTON_OFFLINE', '按钮离线,无法触发呼叫');
  const bed = get(db, 'SELECT * FROM beds WHERE id = ?', btn.bed_id);
  const resident = get(db, 'SELECT * FROM residents WHERE bed_id = ?', btn.bed_id);
  const where = bedLocation(db, btn.bed_id);

  // 同一床位存在未结束呼叫 -> 连续呼叫合并,绝不新建第二条、不重复派单
  const existing = activeCallForBed(db, btn.bed_id);
  if (existing) {
    run(db, 'UPDATE calls SET repeat_count = repeat_count + 1, last_triggered_at = ? WHERE id = ?', at, existing.id);
    addEvent(db, existing.id, 'REPEAT', { at, detail: `连续呼叫,第 ${existing.repeat_count + 1} 次按键` });
    notify(db, {
      channel: CHANNEL.FLOOR, level: LEVEL.WARN, at,
      message: `连续呼叫:${where} 再次按键(共 ${existing.repeat_count + 1} 次),请尽快处理`,
      refType: 'call', refId: existing.id,
    });
    if (existing.assignee_id) {
      const st = get(db, 'SELECT name FROM staff WHERE id = ?', existing.assignee_id);
      notify(db, {
        channel: CHANNEL.CAREGIVER, audience: st?.name, level: LEVEL.WARN, at,
        message: `连续呼叫提醒:${where} 住户再次按键,请尽快到床旁`,
        refType: 'call', refId: existing.id,
      });
    }
    return getCall(db, existing.id);
  }

  const away = resident && resident.status !== 'IN' ? 1 : 0;
  const { lastId } = run(
    db,
    `INSERT INTO calls(bed_id, button_id, resident_id, triggered_at, last_triggered_at, status, resident_away, created_via)
     VALUES (?,?,?,?,?,?,?,?)`,
    btn.bed_id, btn.id, resident?.id ?? null, at, at, CALL_STATUS.OPEN, away, via
  );
  addEvent(db, lastId, 'PRESS', { at, detail: `${where} 按键触发` });
  notify(db, {
    channel: CHANNEL.FLOOR, level: LEVEL.WARN, at,
    message: `呼叫:${where}${resident ? ' ' + resident.name : ''} 按下呼叫按钮,等待派单`,
    refType: 'call', refId: lastId,
  });
  if (away) {
    addEvent(db, lastId, 'RESIDENT_AWAY_FLAG', { at, detail: `住户当前状态:${resident.status}` });
    notify(db, {
      channel: CHANNEL.LEAD, level: LEVEL.WARN, at,
      message: `住户外出:${where} ${resident.name} 登记为外出/就医期间按钮被触发,请核实是否误触或他人误碰`,
      refType: 'call', refId: lastId,
    });
  }
  return getCall(db, lastId);
}

// ---- 派单:一个未结束呼叫只能派给一人 ----
export function assignCall(db, { callId, staffId, actor, at = clock.now() }) {
  const call = getCall(db, callId);
  if ([CALL_STATUS.RESOLVED, CALL_STATUS.CLOSED_FALSE].includes(call.status)) {
    throw conflict('CALL_CLOSED', '呼叫已结束,不能派单');
  }
  if (call.status === CALL_STATUS.FALSE_REVIEW) {
    throw conflict('CALL_IN_FALSE_REVIEW', '呼叫正在误触核对中,不能派单');
  }
  if (call.assignee_id) {
    throw conflict('CALL_ALREADY_ASSIGNED', `呼叫 #${callId} 已派给护理员(#${call.assignee_id}),不能重复派给两人`);
  }
  const target = get(db, 'SELECT * FROM staff WHERE id = ?', staffId);
  if (!target) throw notFound('STAFF_NOT_FOUND', '护理员不存在');
  if (target.role !== ROLE.CAREGIVER) throw badRequest('NOT_CAREGIVER', '只能派给护理员');
  // 护理员只能自己接单;值班长/管理员可派给任意护理员
  if (actor.role === ROLE.CAREGIVER && actor.id !== target.id) {
    throw forbidden('ASSIGN_FORBIDDEN', '护理员只能领取自己的待办,不能替他人派单');
  }
  const keepEscalated = call.status === CALL_STATUS.ESCALATED;
  run(db, "UPDATE calls SET assignee_id = ?, assigned_at = ?, status = ? WHERE id = ?",
    staffId, at, keepEscalated ? CALL_STATUS.ESCALATED : CALL_STATUS.ASSIGNED, callId);
  addEvent(db, callId, 'ASSIGN', { at, actorId: actor.id, detail: `派单给 ${target.name}` });
  notify(db, {
    channel: CHANNEL.CAREGIVER, audience: target.name, level: LEVEL.WARN, at,
    message: `新待办:${bedLocation(db, call.bed_id)} 呼叫已派给你,请尽快到床旁确认`,
    refType: 'call', refId: callId,
  });
  return getCall(db, callId);
}

// ---- 到床旁确认 ----
export function ackCall(db, { callId, actor, at = clock.now() }) {
  const call = getCall(db, callId);
  if (call.assignee_id !== actor.id) throw forbidden('NOT_ASSIGNEE', '只有被指派的护理员才能确认到达');
  if (![CALL_STATUS.ASSIGNED, CALL_STATUS.OVERDUE].includes(call.status)) {
    throw conflict('BAD_STATE', `当前状态(${STATUS_TEXT[call.status]})不能确认到达`);
  }
  run(db, "UPDATE calls SET status = 'ACKED', acked_at = ? WHERE id = ?", at, callId);
  addEvent(db, callId, 'ACK', { at, actorId: actor.id, detail: '护理员到床旁确认' });
  return getCall(db, callId);
}

// ---- 普通结案:填写处理结果。急救升级后被阻断。----
export function resolveCall(db, { callId, actor, resolution, at = clock.now() }) {
  const call = getCall(db, callId);
  if (call.status === CALL_STATUS.ESCALATED) {
    throw conflict('CALL_ESCALATED_BLOCKED', '呼叫已急救升级,普通结案被阻断,须由值班长按急救流程结案');
  }
  if (call.assignee_id !== actor.id) throw forbidden('NOT_ASSIGNEE', '只有被指派的护理员才能结案');
  if (call.status !== CALL_STATUS.ACKED) {
    throw conflict('BAD_STATE', '需先到床旁确认,再填写处理结果结案');
  }
  if (!resolution || !resolution.trim()) throw badRequest('RESOLUTION_REQUIRED', '结案必须填写处理结果');
  run(db, "UPDATE calls SET status = 'RESOLVED', resolved_at = ?, resolution = ? WHERE id = ?", at, resolution.trim(), callId);
  addEvent(db, callId, 'RESOLVE', { at, actorId: actor.id, detail: resolution.trim() });
  notify(db, {
    channel: CHANNEL.FLOOR, level: LEVEL.INFO, at,
    message: `已处理:${bedLocation(db, call.bed_id)} 呼叫已结案(${resolution.trim()})`,
    refType: 'call', refId: callId,
  });
  return getCall(db, callId);
}

// ---- 急救升级 ----
export function escalateCall(db, { callId, actor, reason, at = clock.now() }) {
  const call = getCall(db, callId);
  if ([CALL_STATUS.RESOLVED, CALL_STATUS.CLOSED_FALSE].includes(call.status)) {
    throw conflict('CALL_CLOSED', '呼叫已结束,不能升级');
  }
  if (call.status === CALL_STATUS.ESCALATED) throw conflict('ALREADY_ESCALATED', '呼叫已处于急救升级状态');
  if (!reason || !reason.trim()) throw badRequest('REASON_REQUIRED', '急救升级必须填写原因');
  run(db, "UPDATE calls SET status = 'ESCALATED', escalated_at = ?, escalated_by = ?, escalation_reason = ? WHERE id = ?",
    at, actor.id, reason.trim(), callId);
  addEvent(db, callId, 'ESCALATE', { at, actorId: actor.id, detail: reason.trim() });
  const where = bedLocation(db, call.bed_id);
  notify(db, {
    channel: CHANNEL.FLOOR, level: LEVEL.EMERGENCY, at,
    message: `急救升级:${where} —— ${reason.trim()},请附近人员立即支援`,
    refType: 'call', refId: callId,
  });
  notify(db, {
    channel: CHANNEL.LEAD, level: LEVEL.EMERGENCY, at,
    message: `急救升级:${where} —— ${reason.trim()},请值班长立即介入`,
    refType: 'call', refId: callId,
  });
  return getCall(db, callId);
}

// ---- 急救结案:仅值班长 ----
export function emergencyResolve(db, { callId, actor, note, at = clock.now() }) {
  if (actor.role !== ROLE.SHIFT_LEAD && actor.role !== ROLE.ADMIN) {
    throw forbidden('LEAD_ONLY', '急救结案只能由值班长执行');
  }
  const call = getCall(db, callId);
  if (call.status !== CALL_STATUS.ESCALATED) throw conflict('NOT_ESCALATED', '只有急救升级中的呼叫才能急救结案');
  if (!note || !note.trim()) throw badRequest('NOTE_REQUIRED', '急救结案必须填写处置记录');
  const text = `【急救结案】${note.trim()}`;
  run(db, "UPDATE calls SET status = 'RESOLVED', resolved_at = ?, resolution = ? WHERE id = ?", at, text, callId);
  addEvent(db, callId, 'EMERGENCY_RESOLVE', { at, actorId: actor.id, detail: note.trim() });
  notify(db, {
    channel: CHANNEL.FLOOR, level: LEVEL.INFO, at,
    message: `急救已处置:${bedLocation(db, call.bed_id)} ${note.trim()}`,
    refType: 'call', refId: callId,
  });
  return getCall(db, callId);
}

// ---- 误触:不能直接删除,需说明原因并由值班长核对 ----
export function markFalseTrigger(db, { callId, actor, reason, at = clock.now() }) {
  const call = getCall(db, callId);
  if ([CALL_STATUS.RESOLVED, CALL_STATUS.CLOSED_FALSE].includes(call.status)) {
    throw conflict('CALL_CLOSED', '呼叫已结束');
  }
  if (call.status === CALL_STATUS.ESCALATED) {
    throw conflict('CALL_ESCALATED_BLOCKED', '急救升级中的呼叫不能按误触处理');
  }
  if (actor.role === ROLE.CAREGIVER && call.assignee_id !== actor.id) {
    throw forbidden('NOT_ASSIGNEE', '只有被指派的护理员或值班长才能填报误触');
  }
  if (!reason || !reason.trim()) throw badRequest('FALSE_REASON_REQUIRED', '误触必须填写说明,不能直接删除');
  run(db, "UPDATE calls SET status = 'FALSE_REVIEW', false_reason = ?, false_marked_by = ? WHERE id = ?",
    reason.trim(), actor.id, callId);
  addEvent(db, callId, 'FALSE_MARK', { at, actorId: actor.id, detail: reason.trim() });
  notify(db, {
    channel: CHANNEL.LEAD, level: LEVEL.WARN, at,
    message: `误触待核对:${bedLocation(db, call.bed_id)} 填报误触,说明:${reason.trim()},请值班长核对`,
    refType: 'call', refId: callId,
  });
  return getCall(db, callId);
}

export function verifyFalseTrigger(db, { callId, actor, approve, at = clock.now() }) {
  if (actor.role !== ROLE.SHIFT_LEAD && actor.role !== ROLE.ADMIN) {
    throw forbidden('LEAD_ONLY', '误触核对只能由值班长执行');
  }
  const call = getCall(db, callId);
  if (call.status !== CALL_STATUS.FALSE_REVIEW) throw conflict('NOT_IN_FALSE_REVIEW', '该呼叫不在误触核对状态');
  if (approve) {
    run(db, "UPDATE calls SET status = 'CLOSED_FALSE', false_verified_by = ?, false_verified_at = ? WHERE id = ?",
      actor.id, at, callId);
    addEvent(db, callId, 'FALSE_VERIFY_OK', { at, actorId: actor.id, detail: '值班长核对确认误触,记录保留' });
  } else {
    // 核对不通过:退回继续处理(有指派则回到已派单,否则回到待派单)
    const back = call.assignee_id ? CALL_STATUS.ASSIGNED : CALL_STATUS.OPEN;
    run(db, 'UPDATE calls SET status = ?, false_verified_by = ?, false_verified_at = ? WHERE id = ?',
      back, actor.id, at, callId);
    addEvent(db, callId, 'FALSE_VERIFY_REJECT', { at, actorId: actor.id, detail: '值班长核对不通过,退回继续处理' });
    if (call.assignee_id) {
      const st = get(db, 'SELECT name FROM staff WHERE id = ?', call.assignee_id);
      notify(db, {
        channel: CHANNEL.CAREGIVER, audience: st?.name, level: LEVEL.WARN, at,
        message: `误触被退回:${bedLocation(db, call.bed_id)} 仍需处理,请到床旁确认`,
        refType: 'call', refId: callId,
      });
    }
  }
  return getCall(db, callId);
}

// ---- 超时评估:OPEN/ASSIGNED 超阈值 -> OVERDUE;再超升级阈值 -> 提醒值班长 ----
export function evaluateTimeouts(db, now, cfg) {
  const responseMs = cfg.responseTimeoutSec * 1000;
  const remindMs = cfg.escalateReminderSec * 1000;
  const stale = all(db,
    "SELECT * FROM calls WHERE status IN ('OPEN','ASSIGNED') AND ? - triggered_at > ?", now, responseMs);
  for (const c of stale) {
    run(db, "UPDATE calls SET status = 'OVERDUE', went_overdue = 1 WHERE id = ?", c.id);
    addEvent(db, c.id, 'OVERDUE', { at: now, detail: `超过 ${cfg.responseTimeoutSec} 秒未响应` });
    const where = bedLocation(db, c.bed_id);
    notify(db, {
      channel: CHANNEL.FLOOR, level: LEVEL.WARN, at: now,
      message: `超时未响应:${where} 呼叫已超过 ${Math.round(responseMs / 1000)} 秒无人响应`,
      refType: 'call', refId: c.id,
    });
    notify(db, {
      channel: CHANNEL.LEAD, level: LEVEL.WARN, at: now,
      message: `超时未响应:${where} 呼叫超时,请值班长关注`,
      refType: 'call', refId: c.id,
    });
  }
  const overdue = all(db,
    "SELECT * FROM calls WHERE status = 'OVERDUE' AND escalate_reminded = 0 AND ? - triggered_at > ?", now, remindMs);
  for (const c of overdue) {
    run(db, 'UPDATE calls SET escalate_reminded = 1 WHERE id = ?', c.id);
    addEvent(db, c.id, 'OVERDUE_REMIND', { at: now, detail: '超时升级提醒值班长' });
    notify(db, {
      channel: CHANNEL.LEAD, level: LEVEL.EMERGENCY, at: now,
      message: `超时升级:${bedLocation(db, c.bed_id)} 呼叫长时间无人响应,请值班长立即介入处理`,
      refType: 'call', refId: c.id,
    });
  }
  return { overdue: stale.length, reminded: overdue.length };
}

// ---- 查询 ----
export function callDetail(db, id) {
  const call = getCall(db, id);
  const events = all(db,
    `SELECT e.*, s.name AS actor_name FROM call_events e LEFT JOIN staff s ON s.id = e.actor_id
     WHERE e.call_id = ? ORDER BY e.at, e.id`, id);
  return { ...call, status_text: STATUS_TEXT[call.status], events };
}

export function listCalls(db, { floorId = null, activeOnly = false } = {}) {
  const conds = [];
  const params = [];
  if (floorId) { conds.push('b.floor_id = ?'); params.push(Number(floorId)); }
  if (activeOnly) { conds.push(`c.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`); params.push(...ACTIVE_STATUSES); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return all(db, `
    SELECT c.*, b.room, b.label, b.floor_id, r.name AS resident_name, s.name AS assignee_name
    FROM calls c
    JOIN beds b ON b.id = c.bed_id
    LEFT JOIN residents r ON r.id = c.resident_id
    LEFT JOIN staff s ON s.id = c.assignee_id
    ${where} ORDER BY c.triggered_at DESC`, ...params)
    .map((c) => ({ ...c, status_text: STATUS_TEXT[c.status] }));
}

export { STATUS_TEXT };
