"""领域规则测试：重复派发、超时升级、误触核对、急救阻断、权限、交班不断链、漏检/离线。

运行：python -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from app.db import Database
from app.domain import Service, BizError
from app.adapters import Notifier
from app.monitor import Monitor
from app import seed as seed_mod, config
from app.server import App, make_handler

T0 = 1_900_000_000.0  # 固定虚拟时间戳，避免依赖真实时钟


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class CaseBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "test.db")
        self.clock = Clock()
        self.db = Database(self.db_path)
        seed_mod.seed(self.db, now=T0)
        self.notifier = Notifier(self.db)
        self.svc = Service(self.db, self.notifier, clock=self.clock)
        self.monitor = Monitor(self.db, self.svc, self.notifier)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def call(self, button="B-201-1"):
        return self.svc.open_call(button_code=button)

    def staff_id(self, code):
        return self.db.q1("SELECT id FROM staff WHERE code=?", (code,))["id"]

    def notifications(self, kind=None):
        rows = self.db.q("SELECT * FROM notifications ORDER BY id")
        return [r for r in rows if kind is None or r["kind"] == kind]


class TestAssign(CaseBase):
    def test_open_call_has_source_time(self):
        c = self.call("B-301-1")
        self.assertEqual(c["status"], "active")
        self.assertEqual(c["source_type"], "button")
        self.assertAlmostEqual(c["opened_at"], T0)
        n = self.notifications("call")[-1]
        self.assertIn("三楼特护区", n["title"])   # 来源位置
        self.assertIn(self.svc.fmt(T0), n["body"])  # 时间
        self.assertTrue(n["title"])                 # 报警必配文字
        self.assertTrue(n["body"])

    def test_no_double_assign_two_people(self):
        n1, n2 = self.staff_id("N1"), self.staff_id("N2")
        c = self.call()
        self.svc.assign_call(c["id"], n1)
        with self.assertRaises(BizError):  # 已派给 N1，不能再派 N2
            self.svc.assign_call(c["id"], n2)
        self.assertEqual(self.svc.get_call(c["id"])["assigned_staff_id"], n1)

    def test_one_caregiver_cannot_hold_two_open_calls(self):
        n1 = self.staff_id("N1")
        c1 = self.call("B-201-1")
        c2 = self.call("B-202-1")
        self.svc.assign_call(c1["id"], n1)
        with self.assertRaises(BizError):  # N1 手上有未结束呼叫，不能接第二通
            self.svc.assign_call(c2["id"], n1)
        # N2 仍可接第二通
        self.svc.assign_call(c2["id"], self.staff_id("N2"))

    def test_full_happy_path(self):
        c = self.call()
        self.svc.assign_call(c["id"], self.staff_id("N1"))
        self.svc.arrive(c["id"], self.staff_id("N1"))
        with self.assertRaises(BizError):
            self.svc.resolve_call(c["id"], self.staff_id("N1"), "  ")  # 结果不能为空
        self.svc.resolve_call(c["id"], self.staff_id("N1"), "协助饮水后安睡")
        # 结案后 N1 可以接新呼叫（唯一索引释放）
        c2 = self.call("B-202-2")
        self.svc.assign_call(c2["id"], self.staff_id("N1"))

    def test_only_assignee_can_act(self):
        c = self.call()
        self.svc.assign_call(c["id"], self.staff_id("N1"))
        with self.assertRaises(BizError):
            self.svc.arrive(c["id"], self.staff_id("N2"))


class TestFalseAlarm(CaseBase):
    def _to_arrived(self, button="B-201-1"):
        c = self.call(button)
        self.svc.assign_call(c["id"], self.staff_id("N1"))
        self.svc.arrive(c["id"], self.staff_id("N1"))
        return c

    def test_false_alarm_requires_note_and_keeps_record(self):
        c = self._to_arrived()
        with self.assertRaises(BizError):  # 不能无说明
            self.svc.request_false_alarm(c["id"], self.staff_id("N1"), "误触", "")
        self.svc.request_false_alarm(c["id"], self.staff_id("N1"),
                                     "清洁碰压", "换床单时肘部碰到")
        self.assertEqual(self.svc.get_call(c["id"])["status"], "false_pending")
        self.assertIsNotNone(self.db.q1("SELECT * FROM calls WHERE id=?", (c["id"],)))

    def test_leader_approve_and_reject(self):
        leader = self.staff_id("L1")
        c = self._to_arrived()
        self.svc.request_false_alarm(c["id"], self.staff_id("N1"), "误触", "测试")
        # 护理员不能自己核对
        with self.assertRaises(BizError):
            self.svc.review_false_alarm(c["id"], self.staff_id("N1"), True)
        # 驳回 → 恢复到 arrived
        self.svc.review_false_alarm(c["id"], leader, False, "住户说有需求")
        self.assertEqual(self.svc.get_call(c["id"])["status"], "arrived")
        # 再次上报并核实
        self.svc.request_false_alarm(c["id"], self.staff_id("N1"), "误触", "再次确认")
        self.svc.review_false_alarm(c["id"], leader, True, "已核实")
        self.assertEqual(self.svc.get_call(c["id"])["status"], "false_confirmed")
        self.assertEqual(self.db.q1("SELECT COUNT(*) c FROM calls")["c"], 1)  # 记录仍在


class TestEmergency(CaseBase):
    def test_escalation_blocks_normal_resolve(self):
        c = self.call()
        self.svc.assign_call(c["id"], self.staff_id("N1"))
        self.svc.arrive(c["id"], self.staff_id("N1"))
        self.svc.escalate(c["id"], "住户意识改变")
        with self.assertRaises(BizError):  # 普通结案被阻断
            self.svc.resolve_call(c["id"], self.staff_id("N1"), "没事了")
        self.svc.resolve_call(c["id"], self.staff_id("N1"),
                              "已送医并交接120", emergency=True)
        self.assertEqual(self.svc.get_call(c["id"])["status"], "resolved")
        self.assertEqual(self.svc.get_call(c["id"])["emergency_close"], 1)

    def test_repeat_calls_auto_escalate(self):
        for _ in range(config.REPEAT_ESCALATE_COUNT - 1):
            self.call("B-203-1")
        c3 = self.call("B-203-1")
        self.assertEqual(c3["repeat_index"], 3)
        self.assertEqual(self.svc.get_call(c3["id"])["escalated"], 1)
        self.assertTrue(any(n["kind"] == "escalate" for n in self.notifications()))

    def test_resident_away_flag(self):
        rid = self.db.q1(
            "SELECT r.id FROM residents r JOIN beds b ON b.id=r.bed_id WHERE b.code='204-1'")["id"]
        self.svc.set_resident_away(rid, True, "家属接出体检", actor_id=self.staff_id("L1"))
        c = self.call("B-204-1")
        self.assertEqual(c["away_flag"], 1)


class TestMonitor(CaseBase):
    def test_active_timeout_warn_then_escalate(self):
        c = self.call("B-201-1")
        self.clock.advance(config.ACTIVE_WARN_SECONDS + 1)
        self.monitor.tick(self.clock())
        self.assertEqual(self.svc.get_call(c["id"])["timeout_warned"], 1)
        self.assertTrue(any(n["kind"] == "timeout" for n in self.notifications()))
        self.clock.advance(config.ACTIVE_ESCALATE_SECONDS - config.ACTIVE_WARN_SECONDS)
        self.monitor.tick(self.clock())
        self.assertEqual(self.svc.get_call(c["id"])["escalated"], 1)

    def test_assigned_timeout_then_escalate(self):
        c = self.call("B-201-1")
        self.svc.assign_call(c["id"], self.staff_id("N1"))
        self.clock.advance(config.ASSIGNED_WARN_SECONDS + 1)
        self.monitor.tick(self.clock())
        self.assertTrue(any("到床超时" in n["title"] for n in self.notifications("timeout")))
        self.clock.advance(config.ASSIGNED_ESCALATE_SECONDS - config.ASSIGNED_WARN_SECONDS + 1)
        self.monitor.tick(self.clock())
        self.assertEqual(self.svc.get_call(c["id"])["escalated"], 1)

    def test_button_offline_single_alert(self):
        self.db.execute("UPDATE buttons SET last_heartbeat=? WHERE code='B-103-1'",
                        (T0 - config.OFFLINE_SECONDS - 5,))
        self.monitor.tick(self.clock())
        self.assertEqual(self.db.q1(
            "SELECT online FROM buttons WHERE code='B-103-1'")["online"], 0)
        # 同一次离线在多个通道各落一行，但同通道只提醒一次
        screen_offline = [n for n in self.notifications("offline") if n["channel"] == "screen"]
        self.assertEqual(len(screen_offline), 1)
        self.assertIn("按钮离线", screen_offline[0]["title"])
        # 再跑一个周期不重复提醒
        self.clock.advance(config.TICK_SECONDS)
        self.monitor.tick(self.clock())
        screen_offline = [n for n in self.notifications("offline") if n["channel"] == "screen"]
        self.assertEqual(len(screen_offline), 1)
        # 心跳恢复 → 恢复通知
        self.db.execute("UPDATE buttons SET last_heartbeat=? WHERE code='B-103-1'",
                        (self.clock(),))
        self.monitor.tick(self.clock())
        screen_offline = [n for n in self.notifications("offline") if n["channel"] == "screen"]
        self.assertEqual(len(screen_offline), 2)
        self.assertEqual(self.db.q1(
            "SELECT online FROM buttons WHERE code='B-103-1'")["online"], 1)

    def test_patrol_due_reminder_then_missed_is_separate(self):
        p = self.db.q1("SELECT * FROM patrol_tasks WHERE status='pending'")
        # 到点：到时提醒
        self.db.execute("UPDATE patrol_tasks SET due_at=? WHERE id=?", (T0, p["id"]))
        self.monitor.tick(self.clock())
        msgs = self.notifications("patrol")
        self.assertTrue(any("夜巡到时" in n["title"] for n in msgs))
        self.assertEqual(
            self.db.q1("SELECT status FROM patrol_tasks WHERE id=?", (p["id"],))["status"],
            "pending")
        # 过窗口+宽限：漏检，单独的漏检提醒
        self.db.execute("UPDATE patrol_tasks SET window_end=? WHERE id=?",
                        (T0 - config.PATROL_GRACE_SECONDS - 1, p["id"]))
        self.monitor.tick(self.clock())
        self.assertEqual(
            self.db.q1("SELECT status FROM patrol_tasks WHERE id=?", (p["id"],))["status"],
            "missed")
        self.assertTrue(any("夜巡漏检" in n["title"] for n in self.notifications("patrol")))

    def test_patrol_late_done(self):
        p = self.db.q1("SELECT * FROM patrol_tasks WHERE status='pending'")
        self.db.execute("UPDATE patrol_tasks SET due_at=?, window_end=? WHERE id=?",
                        (T0 - 200, T0 - 100, p["id"]))
        done = self.svc.patrol_done(p["id"], self.staff_id("N1"), "体征平稳")
        self.assertEqual(done["status"], "late")


class TestHandover(CaseBase):
    def test_handover_keeps_chain(self):
        n1, n4, leader = self.staff_id("N1"), self.staff_id("N4"), self.staff_id("L1")
        # N1 持有一通到床未结案的呼叫
        c = self.call("B-201-1")
        self.svc.assign_call(c["id"], n1)
        self.svc.arrive(c["id"], n1)
        pending_patrol = self.db.q1(
            "SELECT COUNT(*) c FROM patrol_tasks WHERE status='pending'")["c"]
        self.assertGreater(pending_patrol, 0)

        result = self.svc.handover(n1, n4, leader, "201房1号床处置中，继续跟进",
                                   "夜班")
        # 呼叫仍未结束，负责人变为接班人
        c_after = self.svc.get_call(c["id"])
        self.assertEqual(c_after["assigned_staff_id"], n4)
        self.assertEqual(c_after["status"], "arrived")
        self.assertIn(c["id"], result["calls"])
        # 接班人能继续走完流程 —— 链路不断
        self.svc.resolve_call(c["id"], n4, "交班后继续观察，无异常")
        # 夜巡任务转入新班次，旧任务标记 transferred
        new_pending = self.db.q1(
            "SELECT COUNT(*) c FROM patrol_tasks WHERE shift_id=? AND status='pending'",
            (result["shift_id"],))["c"]
        self.assertGreater(new_pending, 0)
        old = self.db.q1(
            "SELECT COUNT(*) c FROM patrol_tasks WHERE status='transferred'")["c"]
        self.assertGreater(old, 0)
        # 事件链中有交班转交记录
        ev = self.db.q1("SELECT * FROM events WHERE call_id=? AND type='handover_call'",
                        (c["id"],))
        self.assertIsNotNone(ev)
        self.assertIn("→", ev["detail"])
        # 交班人离开旧班次，接班人在新班次
        self.assertTrue(any(s["id"] == n4 for s in self.svc.on_shift_staff("caregiver")))
        self.assertFalse(any(s["id"] == n1 for s in self.svc.on_shift_staff("caregiver")))

    def test_handover_requires_leader(self):
        with self.assertRaises(BizError):
            self.svc.handover(self.staff_id("N1"), self.staff_id("N4"),
                              self.staff_id("N2"), "x", "夜班")

    def test_handover_attachment_goes_to_local_file(self):
        src = Path(self.tmp.name) / "note.txt"
        src.write_text("纸质交接单扫描件（虚构）", encoding="utf-8")
        result = self.svc.handover(self.staff_id("N1"), self.staff_id("N4"),
                                   self.staff_id("L1"), "附件交接", "夜班",
                                   attachment_src=str(src),
                                   attachment_name="note.txt")
        h = self.db.q1("SELECT * FROM handovers WHERE shift_id=?", (result["shift_id"],))
        self.assertTrue(Path(h["attachment_path"]).is_file())
        self.assertEqual(Path(h["attachment_path"]).parent.name, "attachments")


class TestPermissions(CaseBase):
    def test_resident_fields_by_role(self):
        nurse = self.db.q1("SELECT * FROM staff WHERE code='N1'")
        leader = self.db.q1("SELECT * FROM staff WHERE code='L1'")
        n_view = self.svc.residents_for(nurse)[0]
        l_view = self.svc.residents_for(leader)[0]
        self.assertIsNone(n_view["medical_note"])   # 护理员看不到敏感资料
        self.assertIsNone(n_view["contact"])
        self.assertTrue(n_view["restricted"])
        self.assertTrue(l_view["medical_note"])      # 值班长可见完整资料
        self.assertTrue(l_view["contact"])
        # 基础照护信息双方都可见
        self.assertTrue(n_view["name"] and n_view["care_level"])


# ---------------- HTTP 端到端（含真实 HTTP 状态码）----------------
class HttpBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "test.db")
        self.app = App(self.db_path, start_background=False)
        seed_mod.seed(self.app.db, now=T0)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.app))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.app.db.close()
        self.tmp.cleanup()

    def api(self, method, path, token=None, body=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, data=data, timeout=5) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def login(self, code, pin):
        st, data = self.api("POST", "/api/login", None, {"code": code, "pin": pin})
        self.assertEqual(st, 200)
        return data["token"], data["staff"]


class TestHttp(HttpBase):
    def test_auth_and_role_permissions(self):
        # 未登录
        st, _ = self.api("GET", "/api/residents")
        self.assertEqual(st, 401)
        ntok, nurse = self.login("N1", "0000")
        ltok, leader = self.login("L1", "1234")
        self.assertEqual(nurse["role"], "nurse")

        # 错误口令
        st, _ = self.api("POST", "/api/login", None, {"code": "N1", "pin": "9999"})
        self.assertEqual(st, 401)

        # 护理员：住户敏感字段被屏蔽
        st, data = self.api("GET", "/api/residents", ntok)
        self.assertEqual(st, 200)
        self.assertTrue(all(r["medical_note"] is None for r in data["residents"]))

        # 值班长：可见完整虚构资料
        st, data = self.api("GET", "/api/residents", ltok)
        self.assertTrue(all(r["medical_note"] for r in data["residents"]))

        # 护理员不能看全部呼叫、不能核对误触
        st, _ = self.api("GET", "/api/calls?scope=all", ntok)
        self.assertEqual(st, 403)
        st, _ = self.api("POST", "/api/calls/false/review", ntok,
                         {"call_id": 1, "approve": True})
        self.assertEqual(st, 403)

        # 护理员不能替别人派单
        st, data = self.api("POST", "/api/calls/press", ntok, {"button": "B-201-1"})
        call_id = data["call"]["id"]
        other = self.app.db.q1("SELECT id FROM staff WHERE code='N2'")["id"]
        st, data = self.api("POST", "/api/calls/assign", ntok,
                            {"call_id": call_id, "staff_id": other})
        self.assertEqual(st, 403)

    def test_double_assign_over_http(self):
        ntok, _ = self.login("N1", "0000")
        n2tok, _ = self.login("N2", "0000")
        st, data = self.api("POST", "/api/calls/press", ntok, {"button": "B-202-2"})
        cid = data["call"]["id"]
        st, _ = self.api("POST", "/api/calls/assign", ntok, {"call_id": cid})
        self.assertEqual(st, 200)
        st, data = self.api("POST", "/api/calls/assign", n2tok, {"call_id": cid})
        self.assertEqual(st, 400)  # 重复派发被拒
        self.assertIn("不能重复派单", data["error"])

    def test_emergency_block_over_http(self):
        ntok, _ = self.login("N1", "0000")
        st, data = self.api("POST", "/api/calls/press", ntok, {"button": "B-302-1"})
        cid = data["call"]["id"]
        self.api("POST", "/api/calls/assign", ntok, {"call_id": cid})
        self.api("POST", "/api/calls/arrive", ntok, {"call_id": cid})
        self.api("POST", "/api/calls/escalate", ntok,
                 {"call_id": cid, "reason": "呼吸异常"})
        st, data = self.api("POST", "/api/calls/resolve", ntok,
                            {"call_id": cid, "resolution": "已安抚"})
        self.assertEqual(st, 400)
        self.assertIn("普通结案", data["error"])
        st, _ = self.api("POST", "/api/calls/resolve", ntok,
                         {"call_id": cid, "resolution": "已送医", "emergency": True})
        self.assertEqual(st, 200)

    def test_false_alarm_review_over_http(self):
        ntok, _ = self.login("N1", "0000")
        ltok, _ = self.login("L1", "1234")
        _, data = self.api("POST", "/api/calls/press", ntok, {"button": "B-303-1"})
        cid = data["call"]["id"]
        self.api("POST", "/api/calls/assign", ntok, {"call_id": cid})
        self.api("POST", "/api/calls/arrive", ntok, {"call_id": cid})
        st, _ = self.api("POST", "/api/calls/false", ntok,
                         {"call_id": cid, "reason": "设备测试", "note": "例行测试"})
        self.assertEqual(st, 200)
        st, data = self.api("POST", "/api/calls/false/review", ltok,
                            {"call_id": cid, "approve": True, "note": "知悉"})
        self.assertEqual(st, 200)
        self.assertEqual(data["call"]["status"], "false_confirmed")

    def test_screen_state_and_bedmap(self):
        st, data = self.api("GET", "/api/state")
        self.assertEqual(st, 200)
        self.assertEqual(len(data["floors"]), 3)
        self.assertTrue(all(len(f["beds"]) == 8 for f in data["floors"]))


if __name__ == "__main__":
    unittest.main()
