// 超时升级测试:OPEN/ASSIGNED 超阈值 -> OVERDUE;再超升级阈值 -> 提醒值班长。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, T0, cfg } from './helpers.js';
import { get, all } from '../src/db.js';
import { pressButton, assignCall, ackCall, resolveCall, evaluateTimeouts } from '../src/services/calls.js';

test('超时未响应:OPEN 超阈值后进入 OVERDUE 并发出文字提醒', () => {
  const { db, btn1 } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });

  // 阈值内评估:状态不变
  evaluateTimeouts(db, T0 + cfg.responseTimeoutSec * 1000 - 1, cfg);
  assert.equal(get(db, 'SELECT status FROM calls WHERE id = ?', call.id).status, 'OPEN');

  // 超过阈值:OVERDUE
  const r = evaluateTimeouts(db, T0 + cfg.responseTimeoutSec * 1000 + 1, cfg);
  assert.equal(r.overdue, 1);
  const after = get(db, 'SELECT * FROM calls WHERE id = ?', call.id);
  assert.equal(after.status, 'OVERDUE');
  assert.equal(after.went_overdue, 1);

  const notes = all(db, "SELECT * FROM notifications WHERE ref_id = ? AND message LIKE '%超时%'", call.id);
  assert.ok(notes.length >= 2, '楼层屏与值班长都应收到超时文字提醒');
});

test('超时升级:OVERDUE 持续超升级阈值后单独提醒值班长', () => {
  const { db, btn1 } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  evaluateTimeouts(db, T0 + cfg.responseTimeoutSec * 1000 + 1, cfg);

  const r = evaluateTimeouts(db, T0 + cfg.escalateReminderSec * 1000 + 1, cfg);
  assert.equal(r.reminded, 1);
  assert.equal(get(db, 'SELECT escalate_reminded FROM calls WHERE id = ?', call.id).escalate_reminded, 1);
  const n = get(db, "SELECT * FROM notifications WHERE ref_id = ? AND level = 'EMERGENCY' AND message LIKE '%超时升级%'", call.id);
  assert.ok(n, '应有值班长超时升级提醒');

  // 重复评估不重复提醒
  const again = evaluateTimeouts(db, T0 + cfg.escalateReminderSec * 1000 + 60_000, cfg);
  assert.equal(again.reminded, 0);
});

test('已派单呼叫同样会超时;超时后仍可到达确认并正常结案', () => {
  const { db, btn1, cg1, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });

  evaluateTimeouts(db, T0 + cfg.responseTimeoutSec * 1000 + 1, cfg);
  assert.equal(get(db, 'SELECT status FROM calls WHERE id = ?', call.id).status, 'OVERDUE');

  const acked = ackCall(db, { callId: call.id, actor: cg1, at: T0 + cfg.responseTimeoutSec * 1000 + 5000 });
  assert.equal(acked.status, 'ACKED');
  assert.ok(acked.acked_at, '响应时长以 acked_at 记录,统计可追责');
});

test('结案与误触结案的呼叫不再参与超时评估', () => {
  const { db, btn1, cg1, lead, ids } = makeDb();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });
  ackCall(db, { callId: call.id, actor: cg1, at: T0 + 2000 });
  resolveCall(db, { callId: call.id, actor: cg1, resolution: '已处理', at: T0 + 3000 });

  const r = evaluateTimeouts(db, T0 + 10_000_000, cfg);
  assert.equal(r.overdue, 0);
  assert.equal(get(db, 'SELECT status FROM calls WHERE id = ?', call.id).status, 'RESOLVED');
});
