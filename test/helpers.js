// 测试夹具:内存 SQLite + 最小数据集(2 楼层 / 2 床 / 4 员工 / 2 住户)。
import { openDb, run, get } from '../src/db.js';

export const T0 = 1_800_000_000_000; // 固定基准时间

export function makeDb() {
  const db = openDb(':memory:');
  const f1 = run(db, "INSERT INTO floors(name) VALUES ('1F 测试层')").lastId;
  const f2 = run(db, "INSERT INTO floors(name) VALUES ('2F 测试层')").lastId;
  const bed1 = run(db, "INSERT INTO beds(floor_id, room, label, sort) VALUES (?, '101', 'A', 1)", f1).lastId;
  const bed2 = run(db, "INSERT INTO beds(floor_id, room, label, sort) VALUES (?, '102', 'A', 2)", f1).lastId;
  const bed3 = run(db, "INSERT INTO beds(floor_id, room, label, sort) VALUES (?, '201', 'A', 1)", f2).lastId;
  const btn1 = run(db, "INSERT INTO buttons(bed_id, code, status) VALUES (?, 'BTN-101A', 'ONLINE')", bed1).lastId;
  const btn2 = run(db, "INSERT INTO buttons(bed_id, code, status) VALUES (?, 'BTN-102A', 'ONLINE')", bed2).lastId;
  run(db, "INSERT INTO buttons(bed_id, code, status) VALUES (?, 'BTN-201A', 'ONLINE')", bed3);
  const r1 = run(db, `INSERT INTO residents(bed_id, name, gender, age, care_level, mobility, medical_notes, allergy, emergency_contact, emergency_phone, status)
                      VALUES (?, '测试住户甲', '女', 80, '全护', '卧床', '高血压(测试)', '青霉素', '家属甲', '13800000000', 'IN')`, bed1).lastId;
  run(db, `INSERT INTO residents(bed_id, name, status) VALUES (?, '测试住户乙', 'AWAY')`, bed2);
  const cg1 = run(db, "INSERT INTO staff(name, role, pin, floor_id) VALUES ('护工甲', 'caregiver', '1', ?)", f1).lastId;
  const cg2 = run(db, "INSERT INTO staff(name, role, pin, floor_id) VALUES ('护工乙', 'caregiver', '1', ?)", f1).lastId;
  const lead = run(db, "INSERT INTO staff(name, role, pin, floor_id) VALUES ('值班长', 'shift_lead', '1', NULL)").lastId;
  const admin = run(db, "INSERT INTO staff(name, role, pin, floor_id) VALUES ('管理员', 'admin', '1', NULL)").lastId;
  const staff = (id) => get(db, 'SELECT * FROM staff WHERE id = ?', id);
  return {
    db, f1, f2, bed1, bed2, bed3, btn1, btn2, r1,
    ids: { cg1, cg2, lead, admin },
    cg1: staff(cg1), cg2: staff(cg2), lead: staff(lead), admin: staff(admin),
  };
}

export const cfg = { responseTimeoutSec: 60, escalateReminderSec: 300, patrolGraceMin: 15 };
