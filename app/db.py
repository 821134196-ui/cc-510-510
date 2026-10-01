"""SQLite 持久层：建表、迁移与基础查询封装。"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  code TEXT NOT NULL,             -- 301-1
  label TEXT NOT NULL,            -- 301房 1号床
  seq INTEGER NOT NULL,
  UNIQUE(floor_id, code)
);
CREATE TABLE IF NOT EXISTS residents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bed_id INTEGER UNIQUE REFERENCES beds(id),
  care_level TEXT NOT NULL,       -- 自理 / 半护 / 全护 / 特护
  dietary TEXT,                   -- 饮食（敏感信息）
  medical_note TEXT,              -- 病史摘要（敏感信息）
  contact TEXT,                   -- 家属联系方式（敏感信息）
  present INTEGER NOT NULL DEFAULT 1,  -- 0=住户外出
  out_since REAL,
  out_reason TEXT
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,      -- 登录代号
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('nurse','leader')),
  pin TEXT NOT NULL DEFAULT '0000',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS buttons (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL UNIQUE REFERENCES beds(id),
  code TEXT NOT NULL UNIQUE,      -- B-301-1
  online INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,  -- 维护时停用
  last_heartbeat REAL,
  installed_at REAL
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,            -- 白班 / 夜班
  started_at REAL NOT NULL,
  ended_at REAL
);
CREATE TABLE IF NOT EXISTS shift_staff (
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  role_on_shift TEXT NOT NULL,    -- caregiver / leader
  joined_at REAL NOT NULL,
  left_at REAL,
  PRIMARY KEY(shift_id, staff_id)
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  button_id INTEGER NOT NULL REFERENCES buttons(id),
  resident_id INTEGER REFERENCES residents(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  source_type TEXT NOT NULL,      -- button 按钮 / manual 后台补发 / repeat 连续呼叫
  opened_at REAL NOT NULL,
  status TEXT NOT NULL,           -- active 待派单 / assigned 已派单 / arrived 已到床
                                  -- resolved 已结案 / false_pending 误触待核
                                  -- / false_confirmed 误触已核实 / false_rejected 误触驳回
  assigned_staff_id INTEGER REFERENCES staff(id),
  assigned_at REAL,
  arrivals INTEGER NOT NULL DEFAULT 0,
  arrived_at REAL,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_at REAL,
  escalate_reason TEXT,
  timeout_warned INTEGER NOT NULL DEFAULT 0,
  repeat_of INTEGER REFERENCES calls(id),  -- 连续呼叫链：上一通
  repeat_index INTEGER NOT NULL DEFAULT 1, -- 同床连续序号
  away_flag INTEGER NOT NULL DEFAULT 0,    -- 触发时住户外出
  resolved_at REAL,
  resolution TEXT,
  resolved_by INTEGER REFERENCES staff(id),
  emergency_close INTEGER NOT NULL DEFAULT 0, -- 急救结案
  prior_status TEXT,              -- 误触上报前状态，驳回时恢复
  false_reason TEXT,              -- 误触/设备测试/清洁碰压…
  false_note TEXT,                -- 护理员书面说明（必填）
  false_requested_by INTEGER REFERENCES staff(id),
  false_requested_at REAL,
  reviewed_by INTEGER REFERENCES staff(id),
  reviewed_at REAL,
  review_note TEXT
);
-- 一名护理员同时只能持有一通未结束呼叫；一通呼叫只有一个 assigned_staff_id 列，
-- 两条约束共同保证「一个未结束呼叫不能重复派给两人」。
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_one_open_call
  ON calls(assigned_staff_id)
  WHERE assigned_staff_id IS NOT NULL
    AND status IN ('active','assigned','arrived','false_pending');
CREATE INDEX IF NOT EXISTS idx_calls_bed_time ON calls(bed_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  call_id INTEGER REFERENCES calls(id),
  shift_id INTEGER,
  type TEXT NOT NULL,
  actor_staff_id INTEGER REFERENCES staff(id),
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_call ON events(call_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);

CREATE TABLE IF NOT EXISTS patrol_tasks (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  round_name TEXT NOT NULL,      -- 22:00 夜巡 / 02:00 夜巡
  due_at REAL NOT NULL,
  window_end REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / done / missed / late
  done_at REAL,
  done_by INTEGER REFERENCES staff(id),
  result TEXT,
  reminded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_patrol_status ON patrol_tasks(status);

CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),  -- 交接后所在班次
  from_staff_id INTEGER NOT NULL REFERENCES staff(id),
  to_staff_id INTEGER REFERENCES staff(id),
  leader_id INTEGER REFERENCES staff(id),
  ts REAL NOT NULL,
  summary TEXT NOT NULL,
  attachment_path TEXT,
  attachment_name TEXT,
  transferred_call_ids TEXT NOT NULL DEFAULT '[]',  -- JSON
  transferred_patrol_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  channel TEXT NOT NULL,          -- screen 楼层屏 / phone 手机端 / leader 值班长台
  target TEXT,                    -- 员工id / 楼层id / all
  level TEXT NOT NULL,            -- info / warn / urgent
  kind TEXT NOT NULL,             -- call / timeout / offline / patrol / escalate / repeat / handover / system
  title TEXT NOT NULL,            -- 文字说明（红色报警必配文字）
  body TEXT NOT NULL,
  ref_call_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_lookup ON notifications(channel, target, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  actor_id INTEGER REFERENCES staff(id),
  action TEXT NOT NULL,
  detail TEXT
);
"""


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA foreign_keys=ON;")
        self.init_schema()

    def init_schema(self) -> None:
        with self.lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    def q(self, sql: str, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def q1(self, sql: str, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def execute(self, sql: str, params=()):
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def close(self) -> None:
        with self.lock:
            self.conn.commit()
            self.conn.close()
