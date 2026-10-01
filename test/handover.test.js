// 交班不断链测试:上一班未确认不得新开;确认后 prev_id 成链;未结束呼叫随班移交;附件落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDb, T0 } from './helpers.js';
import { get, all } from '../src/db.js';
import { pressButton, assignCall } from '../src/services/calls.js';
import { createHandover, acknowledgeHandover, listHandovers } from '../src/services/handover.js';

function setup() {
  const fx = makeDb();
  const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carecall-attach-'));
  return { ...fx, attachmentsDir };
}

test('交班链:上一班未确认时禁止新开交班(不断链)', () => {
  const { db, f1, cg1, cg2, ids, attachmentsDir } = setup();
  const h1 = createHandover(db, { floorId: f1, outStaff: cg1, inStaffId: ids.cg2, note: '第一班', at: T0, attachmentsDir });
  assert.equal(h1.status, 'PENDING');
  assert.equal(h1.prev_id, null, '首班无前驱');

  // 上一班未确认 -> 409
  assert.throws(
    () => createHandover(db, { floorId: f1, outStaff: cg2, inStaffId: ids.cg1, at: T0 + 1000, attachmentsDir }),
    (e) => e.status === 409 && e.code === 'HANDOVER_CHAIN_BROKEN'
  );

  // 非接班人确认 -> 403
  assert.throws(
    () => acknowledgeHandover(db, { id: h1.id, staff: cg1, at: T0 + 2000 }),
    (e) => e.status === 403
  );
  // 接班人确认 -> 成链
  acknowledgeHandover(db, { id: h1.id, staff: cg2, at: T0 + 2000 });
  const h2 = createHandover(db, { floorId: f1, outStaff: cg2, inStaffId: ids.cg1, at: T0 + 3000, attachmentsDir });
  assert.equal(h2.prev_id, h1.id, '新交班必须挂接上一班');

  const chain = listHandovers(db, f1);
  assert.equal(chain.length, 2);
  assert.deepEqual(chain.map((h) => h.prev_id).sort(), [null, h1.id].sort());
});

test('交班快照未结束呼叫,交出人手上待办转移给接班人', () => {
  const { db, f1, btn1, cg1, cg2, lead, ids, attachmentsDir } = setup();
  const call = pressButton(db, { buttonId: btn1, at: T0 });
  assignCall(db, { callId: call.id, staffId: ids.cg1, actor: lead, at: T0 + 1000 });

  const h = createHandover(db, { floorId: f1, outStaff: cg1, inStaffId: ids.cg2, note: '夜班交接', at: T0 + 2000, attachmentsDir });
  assert.deepEqual(h.open_call_ids, [call.id], '未结束呼叫进入交接快照');

  // 呼叫不悬空:assignee 从护工甲转给护工乙
  const after = get(db, 'SELECT * FROM calls WHERE id = ?', call.id);
  assert.equal(after.assignee_id, ids.cg2);
  const ev = get(db, "SELECT * FROM call_events WHERE call_id = ? AND type = 'HANDOVER_TRANSFER'", call.id);
  assert.ok(ev, '转移必须留痕');
  assert.match(ev.detail, /护工甲.*护工乙/);
});

test('交接附件保存为本地文件并可读回', () => {
  const { db, f1, cg1, ids, attachmentsDir } = setup();
  const content = Buffer.from('本班重点关注:302 床夜间翻身记录(虚构测试数据)').toString('base64');
  const h = createHandover(db, {
    floorId: f1, outStaff: cg1, inStaffId: ids.cg2, note: '见附件',
    attachment: { name: '交接记录.txt', data: content }, at: T0, attachmentsDir,
  });
  assert.ok(h.attachment_path, '应记录附件路径');
  const file = path.join(attachmentsDir, h.attachment_path);
  assert.ok(fs.existsSync(file), '附件文件必须存在于本地目录');
  assert.equal(fs.readFileSync(file, 'utf8'), '本班重点关注:302 床夜间翻身记录(虚构测试数据)');
});

test('重复确认接班被拒绝', () => {
  const { db, f1, cg1, cg2, ids, attachmentsDir } = setup();
  const h = createHandover(db, { floorId: f1, outStaff: cg1, inStaffId: ids.cg2, at: T0, attachmentsDir });
  acknowledgeHandover(db, { id: h.id, staff: cg2, at: T0 + 1000 });
  assert.throws(
    () => acknowledgeHandover(db, { id: h.id, staff: cg2, at: T0 + 2000 }),
    (e) => e.status === 409
  );
});
