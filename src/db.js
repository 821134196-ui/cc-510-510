import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  room TEXT NOT NULL,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS residents (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  name TEXT NOT NULL,
  gender TEXT,
  age INTEGER,
  care_level TEXT,
  mobility TEXT,
  medical_notes TEXT,
  allergy TEXT,
  emergency_contact TEXT,
  emergency_phone TEXT,
  status TEXT NOT NULL DEFAULT 'IN' -- IN 在院 | AWAY 外出 | HOSPITAL 就医
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- caregiver 护理员 | shift_lead 值班长 | admin 管理员
  pin TEXT NOT NULL,
  floor_id INTEGER REFERENCES floors(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buttons (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ONLINE', -- ONLINE | OFFLINE
  last_seen_at INTEGER
);

-- 呼叫事件主表。状态机:
-- OPEN 待派单 -> ASSIGNED 已派单 -> ACKED 已到床旁 -> RESOLVED 已结案
-- OPEN/ASSIGNED 超时 -> OVERDUE 超时未响应
-- 任意未结束状态 -> ESCALATED 急救升级(阻断普通结案,须值班长急救结案)
-- 误触: -> FALSE_REVIEW 待值班长核对 -> CLOSED_FALSE 误触结案(记录保留,不删除)
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  button_id INTEGER NOT NULL REFERENCES buttons(id),
  resident_id INTEGER REFERENCES residents(id),
  triggered_at INTEGER NOT NULL,
  last_triggered_at INTEGER NOT NULL,
  repeat_count INTEGER NOT NULL DEFAULT 1,   -- 连续呼叫合并计数
  status TEXT NOT NULL DEFAULT 'OPEN',
  assignee_id INTEGER REFERENCES staff(id),
  assigned_at INTEGER,
  acked_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT,
  escalated_at INTEGER,
  escalated_by INTEGER,
  escalation_reason TEXT,
  went_overdue INTEGER NOT NULL DEFAULT 0,
  escalate_reminded INTEGER NOT NULL DEFAULT 0,
  resident_away INTEGER NOT NULL DEFAULT 0,  -- 住户外出期间触发,需核实
  false_reason TEXT,
  false_marked_by INTEGER,
  false_verified_by INTEGER,
  false_verified_at INTEGER,
  created_via TEXT NOT NULL DEFAULT 'BUTTON'
);

-- 呼叫全生命周期审计流水(任何状态变化都留痕)
CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  at INTEGER NOT NULL,
  actor_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS patrol_plans (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  room TEXT NOT NULL,
  bed_id INTEGER REFERENCES beds(id),
  scheduled_at INTEGER NOT NULL,
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'PENDING' -- PENDING 待巡 | DONE 已巡 | MISSED 漏检 | DONE_LATE 补巡
);

CREATE TABLE IF NOT EXISTS patrol_checks (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES patrol_plans(id),
  checked_at INTEGER NOT NULL,
  checked_by INTEGER NOT NULL REFERENCES staff(id),
  note TEXT
);

-- 交班记录链:prev_id 串起上一班;上一班未确认则不允许新开交班(不断链)
CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  prev_id INTEGER REFERENCES handovers(id),
  out_staff_id INTEGER NOT NULL REFERENCES staff(id),
  in_staff_id INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  note TEXT,
  attachment_path TEXT,       -- 交接附件存本地文件
  open_call_ids TEXT NOT NULL DEFAULT '[]', -- 交班时未结束呼叫快照
  status TEXT NOT NULL DEFAULT 'PENDING' -- PENDING 待接班确认 | ACKED 已确认
);

-- 通知模拟适配器的落地表(楼层屏/护理员/值班长/夜巡各通道)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  channel TEXT NOT NULL, -- FLOOR | CAREGIVER | LEAD | PATROL
  audience TEXT,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO', -- INFO | WARN | EMERGENCY
  ref_type TEXT,
  ref_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_bed ON calls(bed_id);
CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_notifications_at ON notifications(at);
CREATE INDEX IF NOT EXISTS idx_patrol_sched ON patrol_plans(scheduled_at);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

// ---- 通用小工具 ----
export function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(db, sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}
