// 夜巡计划与漏检提醒。漏检走独立的 PATROL 通道单独提醒,不与普通呼叫混在一起。
import { all, get, run } from '../db.js';
import { clock } from '../clock.js';
import { conflict, notFound } from '../errors.js';
import { notify, CHANNEL, LEVEL } from '../adapters/notify.js';

export function evaluatePatrol(db, now) {
  const due = all(db,
    "SELECT * FROM patrol_plans WHERE status = 'PENDING' AND ? > scheduled_at + grace_minutes * 60000", now);
  for (const p of due) {
    run(db, "UPDATE patrol_plans SET status = 'MISSED' WHERE id = ?", p.id);
    notify(db, {
      channel: CHANNEL.PATROL, level: LEVEL.WARN, at: now,
      message: `夜巡漏检:计划 ${fmtTime(p.scheduled_at)} 巡查 ${p.room}室 未在宽限时间内完成,请立即补巡`,
      refType: 'patrol', refId: p.id,
    });
  }
  return due.length;
}

export function checkPatrol(db, { planId, staff, note = '', at = clock.now() }) {
  const plan = get(db, 'SELECT * FROM patrol_plans WHERE id = ?', planId);
  if (!plan) throw notFound('PLAN_NOT_FOUND', '夜巡计划不存在');
  if (plan.status === 'DONE' || plan.status === 'DONE_LATE') {
    throw conflict('ALREADY_CHECKED', '该巡查点已完成,不能重复打卡');
  }
  const late = plan.status === 'MISSED';
  run(db, 'INSERT INTO patrol_checks(plan_id, checked_at, checked_by, note) VALUES (?,?,?,?)',
    planId, at, staff.id, note);
  run(db, "UPDATE patrol_plans SET status = ? WHERE id = ?", late ? 'DONE_LATE' : 'DONE', planId);
  if (late) {
    notify(db, {
      channel: CHANNEL.PATROL, level: LEVEL.INFO, at,
      message: `夜巡补巡:${plan.room}室 漏检项已由 ${staff.name} 补巡完成`,
      refType: 'patrol', refId: planId,
    });
  }
  return get(db, 'SELECT * FROM patrol_plans WHERE id = ?', planId);
}

export function tonightPlans(db, floorId = null) {
  const params = [];
  let where = '';
  if (floorId) { where = 'WHERE p.floor_id = ?'; params.push(Number(floorId)); }
  return all(db, `
    SELECT p.*, f.name AS floor_name,
           c.checked_at, c.note AS check_note, s.name AS checked_by_name
    FROM patrol_plans p
    JOIN floors f ON f.id = p.floor_id
    LEFT JOIN patrol_checks c ON c.plan_id = p.id
    LEFT JOIN staff s ON s.id = c.checked_by
    ${where} ORDER BY p.scheduled_at, p.room`, ...params);
}

export function missedPatrols(db) {
  return all(db, `
    SELECT p.*, f.name AS floor_name FROM patrol_plans p JOIN floors f ON f.id = p.floor_id
    WHERE p.status = 'MISSED' ORDER BY p.scheduled_at`);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
