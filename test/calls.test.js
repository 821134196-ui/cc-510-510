// 呼叫状态机测试:重复派发阻断、连续呼叫合并、急救阻断普通结案、误触说明+值班长核对。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, T0 } from './helpers.js';
import { get, all } from '../src/db.js';
import {
  pressButton, assignCall, ackCall, resolveCall, escalateCall,
  emergencyResolve, markFalseTrigger, verifyFalseTrigger,
} from '../src/services/calls.js';

test('一个未结束呼叫不能重复派给两人', () => {
  const { db, btn1, cg1, cg2, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });

  const assigned = assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });
  assert.equal(assigned.status, 'ASSIGNED');
  assert.equal(assigned.assignee_id, ids.cg1);

  // 值班长再派给第二个人 -> 409
  assert.throws(
    () => assignCall(db, { callId: call.id, staffId: ids.cg2, actor: lead, at: T0 + 2000 }),
    (e) => e.status === 409 && e.code === 'CALL_ALREADY_ASSIGNED'
  );
  // 另一个护理员自己抢单 -> 同样被拒
  assert.throws(
    () => assignCall(db, { callId: call.id, staffId: ids.cg2, actor: cg2, at: T0 + 2000 }),
    (e) => e.status === 409 && e.code === 'CALL_ALREADY_ASSIGNED'
  );
  // 结案后可以派新呼叫,但旧呼叫依然不能改派
  ackCall(db, { callId: call.id, actor: cg1, at: T0 + 3000 });
  resolveCall(db, { callId: call.id, actor: cg1, resolution: '已协助饮水', at: T0 + 4000 });
  assert.throws(
    () => assignCall(db, { callId: call.id, staffId: ids.cg2, actor: lead, at: T0 + 5000 }),
    (e) => e.status === 409 && e.code === 'CALL_CLOSED'
  );
});

test('护理员不能替别人派单,只能自己接单', () => {
  const { db, btn1, cg1, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assert.throws(
    () => assignCall(db, { callId: call.id, staffId: ids.cg2, actor: cg1, at: T0 }),
    (e) => e.status === 403
  );
  const ok = assignCall(db, { callId: call.id, staffId: ids.cg1, actor: cg1, at: T0 });
  assert.equal(ok.status, 'ASSIGNED');
});

test('连续呼叫合并为同一条,不产生第二条未结束呼叫', () => {
  const { db, btn1, bed1 } = makeDb();
  const c1 = pressButton(db, { buttonId: btn1, at: T0 });
  const c2 = pressButton(db, { buttonId: btn1, at: T0 + 10_000 });
  const c3 = pressButton(db, { buttonId: btn1, at: T0 + 20_000 });
  assert.equal(c1.id, c2.id);
  assert.equal(c1.id, c3.id);
  assert.equal(c3.repeat_count, 3);
  const active = all(db, "SELECT * FROM calls WHERE bed_id = ? AND status != 'RESOLVED'", bed1);
  assert.equal(active.length, 1);
  const events = all(db, "SELECT * FROM call_events WHERE call_id = ? AND type = 'REPEAT'", c1.id);
  assert.equal(events.length, 2);
});

test('急救升级后普通结案被阻断,仅值班长可急救结案', () => {
  const { db, btn1, cg1, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });
  ackCall(db, { callId: call.id, actor: cg1, at: T0 + 2000 });
  escalateCall(db, { callId: call.id, actor: cg1, reason: '住户呼吸困难', at: T0 + 3000 });

  // 普通结案被阻断
  assert.throws(
    () => resolveCall(db, { callId: call.id, actor: cg1, resolution: 'x', at: T0 + 4000 }),
    (e) => e.status === 409 && e.code === 'CALL_ESCALATED_BLOCKED'
  );
  // 护理员不能急救结案
  assert.throws(
    () => emergencyResolve(db, { callId: call.id, actor: cg1, note: 'x', at: T0 + 5000 }),
    (e) => e.status === 403
  );
  // 值班长急救结案
  const done = emergencyResolve(db, { callId: call.id, actor: lead, note: '已送医', at: T0 + 6000 });
  assert.equal(done.status, 'RESOLVED');
  assert.match(done.resolution, /急救结案/);
});

test('误触必须填说明、由值班长核对,记录不删除', () => {
  const { db, btn1, cg1, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });

  // 无说明 -> 400
  assert.throws(
    () => markFalseTrigger(db, { callId: call.id, actor: cg1, reason: '  ', at: T0 + 2000 }),
    (e) => e.status === 400 && e.code === 'FALSE_REASON_REQUIRED'
  );
  const marked = markFalseTrigger(db, { callId: call.id, actor: cg1, reason: '住户翻身压到按钮', at: T0 + 2000 });
  assert.equal(marked.status, 'FALSE_REVIEW');

  // 护理员无权核对
  assert.throws(
    () => verifyFalseTrigger(db, { callId: call.id, actor: cg1, approve: true, at: T0 + 3000 }),
    (e) => e.status === 403
  );
  // 值班长核对通过
  const closed = verifyFalseTrigger(db, { callId: call.id, actor: lead, approve: true, at: T0 + 4000 });
  assert.equal(closed.status, 'CLOSED_FALSE');
  assert.equal(closed.false_verified_by, ids.lead);

  // 记录仍在数据库中(不删除),且审计流水完整
  const row = get(db, 'SELECT * FROM calls WHERE id = ?', call.id);
  assert.ok(row, '误触呼叫记录必须保留');
  const types = all(db, 'SELECT type FROM call_events WHERE call_id = ? ORDER BY id', call.id).map((e) => e.type);
  assert.deepEqual(types, ['PRESS', 'ASSIGN', 'FALSE_MARK', 'FALSE_VERIFY_OK']);
});

test('误触核对不通过则退回继续处理', () => {
  const { db, btn1, cg1, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });
  markFalseTrigger(db, { callId: call.id, actor: cg1, reason: '疑似误触', at: T0 + 2000 });
  const back = verifyFalseTrigger(db, { callId: call.id, actor: lead, approve: false, at: T0 + 3000 });
  assert.equal(back.status, 'ASSIGNED');
  assert.equal(back.assignee_id, ids.cg1);
});

test('住户外出期间触发自动标记并通知值班长', () => {
  const { db, btn2 } = makeDb(); // bed2 住户登记为 AWAY
  const call = pressButton(db, { buttonId: btn2, at: T0 });
  assert.equal(call.resident_away, 1);
  const n = get(db, "SELECT * FROM notifications WHERE channel = 'LEAD' AND ref_id = ?", call.id);
  assert.ok(n, '应有值班长通知');
  assert.match(n.message, /外出/);
});

test('离线按钮不能触发呼叫', () => {
  const { db, btn1 } = makeDb();
  db.prepare("UPDATE buttons SET status = 'OFFLINE' WHERE id = ?").run(btn1);
  assert.throws(
    () => pressButton(db, { buttonId: btn1, at: T0 }),
    (e) => e.status === 409 && e.code === 'BUTTON_OFFLINE'
  );
});
