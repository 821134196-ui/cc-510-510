// 权限测试:住户资料按岗位分级、护理员限本楼层、关键操作鉴权(含 HTTP 层 401/403)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDb, T0 } from './helpers.js';
import { residentView, listResidents, getResident } from '../src/services/residents.js';
import { get } from '../src/db.js';
import { createServer } from '../src/server.js';
import { login } from '../src/services/auth.js';

test('住户资料按岗位分级返回字段', () => {
  const { db, r1 } = makeDb();
  const row = get(db, `SELECT r.*, b.room, b.label, b.floor_id FROM residents r JOIN beds b ON b.id = r.bed_id WHERE r.id = ?`, r1);

  const cg = residentView(row, 'caregiver');
  assert.ok(cg.name && cg.care_level, '护理员可见姓名与照护等级');
  assert.equal(cg.medical_notes, undefined, '护理员不可见健康备注');
  assert.equal(cg.allergy, undefined, '护理员不可见过敏史');
  assert.equal(cg.emergency_contact, undefined, '护理员不可见紧急联系人');

  const lead = residentView(row, 'shift_lead');
  assert.equal(lead.medical_notes, '高血压(测试)');
  assert.equal(lead.allergy, '青霉素');
  assert.equal(lead.emergency_contact, undefined, '值班长不可见紧急联系人');

  const admin = residentView(row, 'admin');
  assert.equal(admin.emergency_contact, '家属甲');
  assert.equal(admin.emergency_phone, '13800000000');
});

test('护理员只能查看本楼层住户', () => {
  const { db, cg1, lead, f2 } = makeDb();
  // 不指定楼层 -> 自动限定本楼层
  const own = listResidents(db, cg1, null);
  assert.ok(own.every((r) => r.floor_id !== f2), '护理员列表不含其他楼层');
  // 显式请求其他楼层 -> 403
  assert.throws(() => listResidents(db, cg1, f2), (e) => e.status === 403 && e.code === 'FLOOR_FORBIDDEN');
  // 值班长不受楼层限制
  assert.ok(listResidents(db, lead, f2).length >= 0);
  // 跨楼层单条访问 -> 403
  const otherFloorResident = get(db, 'SELECT r.id FROM residents r JOIN beds b ON b.id = r.bed_id WHERE b.floor_id = ?', f2);
  if (otherFloorResident) {
    assert.throws(() => getResident(db, cg1, otherFloorResident.id), (e) => e.status === 403);
  }
});

// ---- HTTP 层:真实起服务,验证 401/403 与分级数据 ----
let server, base, db, tokens;
before(async () => {
  const fx = makeDb();
  db = fx.db;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carecall-test-'));
  server = createServer({ db, cfg: { responseTimeoutSec: 60, escalateReminderSec: 300 }, attachmentsDir: tmp, publicDir: tmp });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens = {
    cg: login(db, { name: '护工甲', pin: '1' }).token,
    lead: login(db, { name: '值班长', pin: '1' }).token,
    admin: login(db, { name: '管理员', pin: '1' }).token,
  };
});
after(() => server?.close());

const j = (res) => res.json();
const authH = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

test('HTTP:未登录访问受保护接口返回 401', async () => {
  const res = await fetch(`${base}/api/residents`);
  assert.equal(res.status, 401);
  assert.equal((await j(res)).error.code, 'UNAUTHORIZED');
});

test('HTTP:护理员无权核对误触(403),值班长可以', async () => {
  // 造一条误触待核对呼叫
  const press = await fetch(`${base}/api/calls/press`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ button_code: 'BTN-101A' }) });
  const call = await j(press);
  await fetch(`${base}/api/calls/${call.id}/assign`, { method: 'POST', headers: authH(tokens.lead), body: JSON.stringify({ staff_id: 1 }) });
  await fetch(`${base}/api/calls/${call.id}/false-trigger`, { method: 'POST', headers: authH(tokens.cg), body: JSON.stringify({ reason: '住户误碰' }) });

  const forbidden = await fetch(`${base}/api/calls/${call.id}/false-verify`, { method: 'POST', headers: authH(tokens.cg), body: JSON.stringify({ approve: true }) });
  assert.equal(forbidden.status, 403);

  const ok = await fetch(`${base}/api/calls/${call.id}/false-verify`, { method: 'POST', headers: authH(tokens.lead), body: JSON.stringify({ approve: true }) });
  assert.equal(ok.status, 200);
  assert.equal((await j(ok)).status, 'CLOSED_FALSE');
});

test('HTTP:护理员请求其他楼层住户列表返回 403', async () => {
  const res = await fetch(`${base}/api/residents?floor_id=2`, { headers: authH(tokens.cg) });
  assert.equal(res.status, 403);
  assert.equal((await j(res)).error.code, 'FLOOR_FORBIDDEN');
});

test('HTTP:不同岗位拿到的住户字段不同', async () => {
  const cgRows = await (await fetch(`${base}/api/residents`, { headers: authH(tokens.cg) })).json();
  const leadRows = await (await fetch(`${base}/api/residents`, { headers: authH(tokens.lead) })).json();
  const adminRows = await (await fetch(`${base}/api/residents`, { headers: authH(tokens.admin) })).json();

  assert.equal(cgRows[0].medical_notes, undefined);
  assert.ok('medical_notes' in leadRows[0]);
  assert.ok('emergency_contact' in adminRows[0]);
  assert.equal(leadRows[0].emergency_contact, undefined);
});
