"""后台监控线程：超时未响应、按钮离线、夜巡漏检（单独提醒）、急救升级。"""
from __future__ import annotations

import threading
import time

from . import config


class Monitor:
    def __init__(self, db, service, notifier):
        self.db = db
        self.svc = service
        self.notifier = notifier
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True, name="monitor")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.wait(config.TICK_SECONDS):
            try:
                self.tick()
            except Exception as e:  # 监控线程不能因一次异常死掉
                print(f"[monitor] tick error: {e}")

    def tick(self, now=None):
        now = now if now is not None else time.time()
        self._check_call_timeouts(now)
        self._check_offline_buttons(now)
        self._check_patrols(now)

    # ---------- 超时未响应 → 提醒 / 升级 ----------
    def _check_call_timeouts(self, now):
        calls = self.db.q(
            "SELECT c.*, f.name AS floor, b.label AS bed, s.name AS staff_name "
            "FROM calls c JOIN beds b ON b.id=c.bed_id JOIN floors f ON f.id=b.floor_id "
            "LEFT JOIN staff s ON s.id=c.assigned_staff_id "
            "WHERE c.status IN ('active','assigned')")
        for c in calls:
            if c["status"] == "active":
                age = now - c["opened_at"]
                if age >= config.ACTIVE_ESCALATE_SECONDS:
                    self.svc.escalate(c["id"],
                                      f"呼叫超时 {int(age)} 秒无人接单，自动急救升级")
                    continue
                if age >= config.ACTIVE_WARN_SECONDS and not c["timeout_warned"]:
                    self._warn(c, "待派单超时",
                               f"已等待 {int(age)} 秒无人接单，请立即派单；"
                               f"超时{config.ACTIVE_ESCALATE_SECONDS}秒将自动急救升级",
                               phone_target="all", level="warn")
                    self.db.execute("UPDATE calls SET timeout_warned=1 WHERE id=?", (c["id"],))
            elif c["status"] == "assigned":
                age = now - c["assigned_at"]
                if age >= config.ASSIGNED_ESCALATE_SECONDS:
                    self.svc.escalate(c["id"],
                                      f"派单后 {int(age)} 秒未到床，自动急救升级")
                    continue
                if age >= config.ASSIGNED_WARN_SECONDS and not c["timeout_warned"]:
                    self._warn(c, "到床超时",
                               f"已派给 {c['staff_name']} {int(age)} 秒，尚未到床确认",
                               phone_target=str(c["assigned_staff_id"]), level="warn")
                    self.db.execute("UPDATE calls SET timeout_warned=1 WHERE id=?", (c["id"],))

    def _warn(self, c, title_tail, body, phone_target=None, level="warn"):
        leaders = [s["id"] for s in self.svc.on_shift_staff("leader")]
        self.notifier.push(
            "timeout", level,
            f"【超时提醒】{c['floor']} · {c['bed']} — {title_tail}",
            f"{body}　{self.svc.fmt(time.time())}",
            screen_target="all",
            phone_target=phone_target, leader_targets=leaders or None,
            ref_call_id=c["id"])

    # ---------- 按钮离线（独立通道，不与呼叫混在一起）----------
    def _check_offline_buttons(self, now):
        buttons = self.db.q(
            "SELECT bt.*, b.label AS bed, f.id AS floor_id, f.name AS floor FROM buttons bt "
            "JOIN beds b ON b.id=bt.bed_id JOIN floors f ON f.id=b.floor_id WHERE bt.enabled=1")
        for b in buttons:
            stale = b["last_heartbeat"] is None or \
                now - b["last_heartbeat"] > config.OFFLINE_SECONDS
            if stale and b["online"] == 1:
                self.db.execute("UPDATE buttons SET online=0 WHERE id=?", (b["id"],))
                leaders = [s["id"] for s in self.svc.on_shift_staff("leader")]
                self.notifier.push(
                    "offline", "warn",
                    f"【按钮离线】{b['floor']} · {b['bed']}",
                    f"按钮 {b['code']} 心跳中断超过 {config.OFFLINE_SECONDS} 秒，"
                    f"请现场检查设备并改用人工巡查　{self.svc.fmt(now)}",
                    screen_target="all",
                    leader_targets=leaders or None)
            elif not stale and b["online"] == 0:
                self.db.execute("UPDATE buttons SET online=1 WHERE id=?", (b["id"],))
                self.notifier.push(
                    "offline", "info",
                    f"【按钮恢复】{b['floor']} · {b['bed']}",
                    f"按钮 {b['code']} 心跳恢复　{self.svc.fmt(now)}",
                    screen_target="all")

    # ---------- 夜巡漏检：单独 kind=patrol 提醒，不与呼叫混为一谈 ----------
    def _check_patrols(self, now):
        pending = self.db.q(
            "SELECT p.*, b.label AS bed, f.id AS floor_id, f.name AS floor FROM patrol_tasks p "
            "JOIN beds b ON b.id=p.bed_id JOIN floors f ON f.id=b.floor_id "
            "WHERE p.status='pending'")
        for p in pending:
            if now >= p["window_end"] + config.PATROL_GRACE_SECONDS:
                self.db.execute("UPDATE patrol_tasks SET status='missed' WHERE id=?", (p["id"],))
                leaders = [s["id"] for s in self.svc.on_shift_staff("leader")]
                self.notifier.push(
                    "patrol", "warn",
                    f"【夜巡漏检】{p['floor']} · {p['bed']} — {p['round_name']}",
                    f"已超过巡查窗口（应在 {self.svc.fmt(p['due_at'])} 前完成），"
                    f"请立即补查并说明原因　{self.svc.fmt(now)}",
                    screen_target="all", phone_target="all",
                    leader_targets=leaders or None)
            elif now >= p["due_at"] and not p["reminded"]:
                # 到点未巡：先提醒一次，区别于漏检
                self.db.execute("UPDATE patrol_tasks SET reminded=1 WHERE id=?", (p["id"],))
                self.notifier.push(
                    "patrol", "info",
                    f"【夜巡到时】{p['floor']} · {p['bed']} — {p['round_name']}",
                    f"现在是计划巡查时间，请前往 {p['bed']}　{self.svc.fmt(now)}",
                    phone_target="all")
