"""模拟适配器：按钮硬件 + 通知通道。真实环境可替换为 MQTT / 网关 SDK，接口保持不变。"""
from __future__ import annotations

import threading
import time


class Notifier:
    """通知适配器：落库 notifications，并向实时订阅（SSE）广播。

    所有报警同时携带 title/body 文字 —— 楼层屏上红色报警必配文字，不允许只靠颜色。
    """

    def __init__(self, db):
        self.db = db
        self._cond = threading.Condition()
        self._max_id = db.q1("SELECT COALESCE(MAX(id),0) m FROM notifications")["m"]

    def push(self, kind, level, title, body, screen_target=None, phone_target=None,
             leader_targets=None, ref_call_id=None):
        rows = []
        if screen_target is not None:
            rows.append(("screen", str(screen_target)))
        if phone_target is not None:
            rows.append(("phone", str(phone_target)))
        if leader_targets is not None:
            for lid in leader_targets:
                rows.append(("leader", str(lid)))
        if not rows:
            # 没有显式通道时进全员系统通道，保证不丢
            rows.append(("leader", "all"))
        new_ids = []
        for channel, target in rows:
            cur = self.db.execute(
                "INSERT INTO notifications(ts,channel,target,level,kind,title,body,ref_call_id)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (time.time(), channel, target, level, kind, title, body, ref_call_id),
            )
            new_ids.append(cur.lastrowid)
        with self._cond:
            self._max_id = max(new_ids)
            self._cond.notify_all()
        return new_ids

    def wait(self, since_id, timeout=15):
        """阻塞等待新通知；返回最新 id。"""
        with self._cond:
            self._cond.wait_for(lambda: self._max_id > since_id, timeout)
            return self._max_id

    def latest_id(self):
        with self._cond:
            return self._max_id

    def fetch(self, channel, target, since_id=0, limit=50):
        return self.db.q(
            "SELECT * FROM notifications WHERE channel=? AND (target=? OR target='all')"
            " AND id>? ORDER BY id DESC LIMIT ?",
            (channel, str(target), since_id, limit),
        )[::-1]


class ButtonAdapter:
    """模拟床头呼叫按钮：周期性心跳；press() 触发呼叫；离线靠心跳超时被监控识别。"""

    HEARTBEAT_INTERVAL = 5

    def __init__(self, db, service):
        self.db = db
        self.service = service
        self._stop = threading.Event()
        self._offline_simulated = set()  # 演示用：人为断开心跳的按钮
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True,
                                        name="button-heartbeat")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _heartbeat_loop(self):
        while not self._stop.wait(self.HEARTBEAT_INTERVAL):
            for btn in self.db.q("SELECT code FROM buttons WHERE enabled=1"):
                if btn["code"] in self._offline_simulated:
                    continue
                self.db.execute("UPDATE buttons SET last_heartbeat=?, online=1 WHERE code=?",
                                (time.time(), btn["code"]))

    def press(self, button_code, source_type="button"):
        """物理按钮被按下（或演示脚本模拟按下）。"""
        return self.service.open_call(button_code=button_code, source_type=source_type)

    # ---- 演示 / 运维接口 ----
    def simulate_offline(self, button_code):
        self._offline_simulated.add(button_code)  # 停心跳；监控线程稍后判离线

    def simulate_online(self, button_code):
        self._offline_simulated.discard(button_code)
        self.db.execute(
            "UPDATE buttons SET last_heartbeat=?, online=1 WHERE code=?",
            (time.time(), button_code),
        )
