"""HTTP 服务（Python 标准库，零第三方依赖）。

三类终端：
  /screen  楼层屏（高对比大字、位置与时间紧邻）
  /phone   护理员手机端（只有当前待办和确认动作）
  /leader  值班长台（呼叫总览、误触核对、夜巡、交班、统计、住户资料）
"""
from __future__ import annotations

import json
import mimetypes
import secrets
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .db import Database
from .domain import Service, BizError, STATUS_LABEL
from .adapters import Notifier, ButtonAdapter
from .monitor import Monitor
from . import seed as seed_mod

WEB_DIR = Path(__file__).parent / "web"


class App:
    def __init__(self, db_path, start_background=True):
        self.db = Database(db_path)
        self.notifier = Notifier(self.db)
        self.svc = Service(self.db, self.notifier)
        self.buttons = ButtonAdapter(self.db, self.svc)
        self.monitor = Monitor(self.db, self.svc, self.notifier)
        self.sessions = {}  # token -> staff_id
        if start_background:
            self.buttons.start()
            self.monitor.start()

    def reset(self):
        """测试辅助：清空并重新播种。"""
        self.db.execute("DELETE FROM notifications")
        for tbl in ("audit_log", "handovers", "patrol_tasks", "events", "calls",
                    "shift_staff", "shifts", "buttons", "residents", "staff",
                    "beds", "floors"):
            self.db.execute(f"DELETE FROM {tbl}")
        seed_mod.seed(self.db)


# ---------------------------------------------------------------- 序列化
def call_dto(db, c, now=None):
    now = now if now is not None else time.time()
    loc = db.q1(
        "SELECT b.code bed_code,b.label bed,f.name floor,f.id floor_id,r.name resident,"
        " r.present, r.care_level, s.name staff_name, bt.code button_code, bt.online"
        " FROM calls c JOIN beds b ON b.id=c.bed_id JOIN floors f ON f.id=b.floor_id"
        " LEFT JOIN residents r ON r.id=c.resident_id"
        " LEFT JOIN staff s ON s.id=c.assigned_staff_id"
        " JOIN buttons bt ON bt.id=c.button_id WHERE c.id=?", (c["id"],))
    return {
        "id": c["id"],
        "status": c["status"],
        "status_label": STATUS_LABEL.get(c["status"], c["status"]),
        "floor": loc["floor"], "floor_id": loc["floor_id"],
        "bed": loc["bed"], "bed_code": loc["bed_code"],
        "resident": loc["resident"], "resident_present": bool(loc["present"]),
        "care_level": loc["care_level"],
        "button": loc["button_code"], "button_online": bool(loc["online"]),
        "opened_at": c["opened_at"], "opened_at_txt": fmt(c["opened_at"]),
        "age_seconds": max(0, int(now - c["opened_at"])),
        "assigned_staff_id": c["assigned_staff_id"],
        "assigned_staff": loc["staff_name"],
        "assigned_at_txt": fmt(c["assigned_at"]),
        "arrived_at_txt": fmt(c["arrived_at"]),
        "escalated": bool(c["escalated"]),
        "escalated_at_txt": fmt(c["escalated_at"]),
        "escalate_reason": c["escalate_reason"],
        "timeout_warned": bool(c["timeout_warned"]),
        "repeat_index": c["repeat_index"],
        "away_flag": bool(c["away_flag"]),
        "resolution": c["resolution"],
        "resolved_at_txt": fmt(c["resolved_at"]),
        "emergency_close": bool(c["emergency_close"]),
        "false_reason": c["false_reason"], "false_note": c["false_note"],
        "false_status": c["status"] if c["status"].startswith("false_") else None,
        "review_note": c["review_note"],
        "source_type": c["source_type"],
    }


def fmt(ts):
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else ""


# ---------------------------------------------------------------- HTTP
def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CareCall/1.0"

        def log_message(self, fmt_, *args):
            pass  # 安静；事件本身已落库

        # ---- 基础响应 ----
        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _err(self, msg, status=400):
            self._json({"error": msg}, status)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            raw = self.rfile.read(length)
            ctype = self.headers.get("Content-Type", "")
            if ctype.startswith("application/json") or raw[:1] in (b"{", b"["):
                try:
                    return json.loads(raw.decode())
                except Exception:
                    raise BizError("请求体不是合法 JSON")
            if "application/x-www-form-urlencoded" in ctype:
                return {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            return {}

        def _file(self, path: Path):
            if not path.is_file():
                self._err("not found", 404)
                return
            body = path.read_bytes()
            ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/")
                                                      or "javascript" in ctype else ""))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # ---- 鉴权 ----
        def _token(self):
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                return auth[7:]
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                k, _, v = part.strip().partition("=")
                if k == "token":
                    return v
            return parse_qs(urlparse(self.path).query).get("token", [None])[0]

        def _me(self):
            tok = self._token()
            sid = app.sessions.get(tok)
            if not sid:
                return None, None
            return sid, app.db.q1("SELECT * FROM staff WHERE id=? AND active=1", (sid,))

        def _require(self):
            sid, staff = self._me()
            if not staff:
                self._err("未登录或会话已失效", 401)
                return None, None
            return sid, staff

        def _require_leader(self):
            sid, staff = self._require()
            if not staff:
                return None, None
            if staff["role"] != "leader":
                self._err("该操作仅值班长可执行（岗位权限）", 403)
                return None, None
            return sid, staff

        # ================= 路由 =================
        def do_GET(self):
            u = urlparse(self.path)
            p, q = u.path, parse_qs(u.query)
            try:
                if p in ("/", "/index.html"):
                    return self._file(WEB_DIR / "index.html")
                if p == "/screen":
                    return self._file(WEB_DIR / "screen.html")
                if p == "/phone":
                    return self._file(WEB_DIR / "phone.html")
                if p == "/leader":
                    return self._file(WEB_DIR / "leader.html")
                if p.startswith("/web/"):
                    return self._file(WEB_DIR / p[5:].lstrip("/"))

                if p == "/api/me":
                    sid, staff = self._me()
                    return self._json({"staff": staff_dict(staff)} if staff else {"staff": None})
                if p == "/api/state":
                    return self._state(q)
                if p == "/api/calls":
                    return self._calls(q)
                if p == "/api/patrols":
                    return self._patrols()
                if p == "/api/handovers":
                    return self._handovers()
                if p == "/api/residents":
                    return self._residents()
                if p == "/api/stats":
                    return self._json(app.svc.stats())
                if p == "/api/shift":
                    return self._shift()
                if p == "/api/events":
                    return self._events(q)
                if p == "/api/notifications":
                    return self._notifications(q)
                if p == "/api/notifications/stream":
                    return self._sse(q)
                if p == "/api/attachments":
                    return self._attachment(q)
                self._err("not found", 404)
            except BizError as e:
                self._err(str(e))
            except Exception as e:
                self._err(f"服务器错误: {e}", 500)

        def do_POST(self):
            p = urlparse(self.path).path
            try:
                if p == "/api/login":
                    return self._login()
                if p == "/api/logout":
                    sid, _ = self._require()
                    if sid is None:
                        return
                    tok = self._token()
                    app.sessions.pop(tok, None)
                    return self._json({"ok": True})

                _, staff = self._require()
                if staff is None:
                    return

                if p == "/api/calls/press":
                    data = self._read_json()
                    c = app.buttons.press(data["button"], source_type=data.get("source", "button"))
                    return self._json({"call": call_dto(app.db, c)})
                if p == "/api/calls/assign":
                    return self._assign(staff)
                if p == "/api/calls/arrive":
                    return self._arrive(staff)
                if p == "/api/calls/resolve":
                    return self._resolve(staff)
                if p == "/api/calls/false":
                    return self._false_req(staff)
                if p == "/api/calls/escalate":
                    return self._escalate_manual(staff)
                if p == "/api/calls/false/review":
                    return self._false_review()
                if p == "/api/patrols/done":
                    return self._patrol_done(staff)
                if p == "/api/residents/away":
                    return self._resident_away(staff)
                if p == "/api/handovers":
                    return self._handover_post(staff)
                if p == "/api/demo/offline":
                    data = self._read_json()
                    app.buttons.simulate_offline(data["button"])
                    return self._json({"ok": True})
                if p == "/api/demo/online":
                    data = self._read_json()
                    app.buttons.simulate_online(data["button"])
                    return self._json({"ok": True})
                self._err("not found", 404)
            except BizError as e:
                self._err(str(e))
            except KeyError as e:
                self._err(f"缺少字段: {e}")
            except Exception as e:
                self._err(f"服务器错误: {e}", 500)

        # ---------------- 接口实现 ----------------
        def _login(self):
            data = self._read_json()
            staff = app.db.q1("SELECT * FROM staff WHERE code=? AND active=1",
                              (data.get("code"),))
            if not staff or staff["pin"] != str(data.get("pin", "")):
                return self._err("工号或口令错误", 401)
            token = secrets.token_hex(16)
            app.sessions[token] = staff["id"]
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Set-Cookie",
                             f"token={token}; Path=/; HttpOnly; SameSite=Lax")
            body = json.dumps({"token": token, "staff": staff_dict(staff)},
                              ensure_ascii=False).encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _state(self, q):
            """楼层屏一屏所需：楼层→床位图 + 未结束呼叫。"""
            floor_rows = app.db.q("SELECT * FROM floors ORDER BY seq")
            open_calls = {
                c["bed_id"]: c for c in app.db.q(
                    "SELECT * FROM calls WHERE status IN ('active','assigned','arrived')")
            }
            floors = []
            for f in floor_rows:
                beds = []
                for b in app.db.q("SELECT * FROM beds WHERE floor_id=? ORDER BY seq", (f["id"],)):
                    btn = app.db.q1("SELECT * FROM buttons WHERE bed_id=?", (b["id"],))
                    r = app.db.q1("SELECT * FROM residents WHERE bed_id=?", (b["id"],))
                    c = open_calls.get(b["id"])
                    beds.append({
                        "code": b["code"], "label": b["label"],
                        "resident": r["name"] if r else "（空床）",
                        "present": bool(r["present"]) if r else True,
                        "care_level": r["care_level"] if r else "",
                        "button": btn["code"], "online": bool(btn["online"]),
                        "enabled": bool(btn["enabled"]),
                        "call": call_dto(app.db, c) if c else None,
                    })
                floors.append({"id": f["id"], "name": f["name"], "beds": beds})
            only = q.get("floor", [None])[0]
            if only:
                floors = [x for x in floors if str(x["id"]) == only] or floors
            return self._json({"floors": floors, "now": fmt(time.time())})

        def _calls(self, q):
            scope = q.get("scope", ["all"])[0]
            sid, staff = self._me()
            if scope == "mine":
                if not staff:
                    return self._err("未登录", 401)
                rows = app.db.q(
                    "SELECT * FROM calls WHERE assigned_staff_id=? "
                    "AND status IN ('assigned','arrived','false_pending') ORDER BY id DESC",
                    (staff["id"],))
            elif scope == "open":
                rows = app.db.q(
                    "SELECT * FROM calls WHERE status IN ('active','assigned','arrived',"
                    "'false_pending') ORDER BY escalated DESC, id DESC")
            else:
                if not staff or staff["role"] != "leader":
                    return self._err("查看全部呼叫仅值班长可执行", 403)
                rows = app.db.q("SELECT * FROM calls ORDER BY id DESC LIMIT 100")
            return self._json({"calls": [call_dto(app.db, c) for c in rows]})

        def _assign(self, staff):
            data = self._read_json()
            call_id = int(data["call_id"])
            target = int(data.get("staff_id") or staff["id"])
            if staff["role"] != "leader" and target != staff["id"]:
                return self._err("护理员只能给自己接单", 403)
            c = app.svc.assign_call(call_id, target, actor_id=staff["id"])
            self._json({"call": call_dto(app.db, c)})

        def _arrive(self, staff):
            data = self._read_json()
            c = app.svc.arrive(int(data["call_id"]), staff["id"])
            self._json({"call": call_dto(app.db, c)})

        def _resolve(self, staff):
            data = self._read_json()
            c = app.svc.resolve_call(int(data["call_id"]), staff["id"],
                                     data.get("resolution", ""),
                                     emergency=bool(data.get("emergency")))
            self._json({"call": call_dto(app.db, c)})

        def _false_req(self, staff):
            data = self._read_json()
            c = app.svc.request_false_alarm(int(data["call_id"]), staff["id"],
                                            data.get("reason", "误触"),
                                            data.get("note", ""))
            self._json({"call": call_dto(app.db, c)})

        def _escalate_manual(self, staff):
            data = self._read_json()
            c = app.svc.escalate(int(data["call_id"]),
                                 data.get("reason", "现场请求急救升级"),
                                 actor_id=staff["id"])
            self._json({"call": call_dto(app.db, c)})

        def _false_review(self):
            sid, _ = self._require_leader()
            if sid is None:
                return
            data = self._read_json()
            c = app.svc.review_false_alarm(int(data["call_id"]), sid,
                                           bool(data.get("approve")),
                                           data.get("note", ""))
            self._json({"call": call_dto(app.db, c)})

        def _patrols(self):
            sid, staff = self._me()
            if not staff:
                return self._err("未登录", 401)
            shift = app.svc.current_shift()
            rows = app.db.q(
                "SELECT p.*, b.label bed, f.name floor, s.name done_name FROM patrol_tasks p "
                "JOIN beds b ON b.id=p.bed_id JOIN floors f ON f.id=b.floor_id "
                "LEFT JOIN staff s ON s.id=p.done_by "
                "WHERE p.shift_id=? ORDER BY p.due_at, p.id", (shift["id"],))
            self._json({"patrols": [patrol_dto(p) for p in rows]})

        def _patrol_done(self, staff):
            data = self._read_json()
            p = app.svc.patrol_done(int(data["task_id"]), staff["id"],
                                    data.get("result", ""))
            self._json({"patrol": patrol_dto(p)})

        def _handovers(self):
            sid, staff = self._me()
            if not staff or staff["role"] != "leader":
                return self._err("仅值班长可查看交班记录", 403)
            rows = app.db.q(
                "SELECT h.*, a.name from_name, b.name to_name, l.name leader_name "
                "FROM handovers h JOIN staff a ON a.id=h.from_staff_id "
                "JOIN staff b ON b.id=h.to_staff_id JOIN staff l ON l.id=h.leader_id "
                "ORDER BY h.id DESC")
            out = []
            for h in rows:
                d = dict_from_row(h)
                d["ts_txt"] = fmt(h["ts"])
                d["transferred_call_ids"] = json.loads(h["transferred_call_ids"])
                d["transferred_patrol_ids"] = json.loads(h["transferred_patrol_ids"])
                d["attachment_name"] = h["attachment_name"]
                d["has_attachment"] = bool(h["attachment_path"])
                d.pop("attachment_path", None)  # 路径不直接外泄，经 /api/attachments 下载
                out.append(d)
            self._json({"handovers": out})

        def _handover_post(self, leader_staff):
            sid, leader = self._require_leader()
            if sid is None:
                return
            # multipart/form-data：可能带交接附件
            ctype = self.headers.get("Content-Type", "")
            if ctype.startswith("multipart/form-data"):
                fields, attachment = self._parse_multipart(ctype)
                src = None
                if attachment:
                    att_dir = Path(app.db.path).parent / "attachments"
                    att_dir.mkdir(parents=True, exist_ok=True)
                    src = att_dir / f"upload_{uuid.uuid4().hex}_{attachment[0]}"
                    src.write_bytes(attachment[1])
                result = app.svc.handover(
                    int(fields["from_staff_id"]), int(fields["to_staff_id"]), sid,
                    fields.get("summary", ""), fields.get("new_shift_label", "夜班"),
                    attachment_src=str(src) if src else None,
                    attachment_name=attachment[0] if attachment else None)
            else:
                data = self._read_json()
                result = app.svc.handover(
                    int(data["from_staff_id"]), int(data["to_staff_id"]), sid,
                    data.get("summary", ""), data.get("new_shift_label", "夜班"))
            self._json({"ok": True, **result})

        def _parse_multipart(self, ctype):
            import cgi
            import warnings
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            length = int(self.headers.get("Content-Length") or 0)
            fs = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                  environ={"REQUEST_METHOD": "POST",
                                           "CONTENT_TYPE": ctype,
                                           "CONTENT_LENGTH": str(length)})
            fields = {}
            attachment = None
            for key in fs.keys():
                item = fs[key]
                if item.filename:
                    attachment = (item.filename, item.file.read())
                else:
                    fields[key] = item.value
            return fields, attachment

        def _residents(self):
            sid, staff = self._me()
            if not staff:
                return self._err("未登录", 401)
            self._json({"residents": app.svc.residents_for(staff)})

        def _resident_away(self, staff):
            data = self._read_json()
            app.svc.set_resident_away(int(data["resident_id"]),
                                      bool(data.get("away")),
                                      data.get("reason", ""), actor_id=staff["id"])
            self._json({"ok": True})

        def _shift(self):
            sid, staff = self._me()
            if not staff:
                return self._err("未登录", 401)
            shift = app.svc.current_shift()
            self._json({
                "shift": {"id": shift["id"], "label": shift["label"],
                          "started_at_txt": fmt(shift["started_at"])} if shift else None,
                "staff": [staff_dict(s) for s in app.svc.on_shift_staff()],
            })

        def _events(self, q):
            call_id = q.get("call_id", [None])[0]
            if call_id:
                rows = app.db.q(
                    "SELECT e.*, s.name actor FROM events e "
                    "LEFT JOIN staff s ON s.id=e.actor_staff_id "
                    "WHERE e.call_id=? ORDER BY e.id", (call_id,))
            else:
                rows = app.db.q(
                    "SELECT e.*, s.name actor FROM events e "
                    "LEFT JOIN staff s ON s.id=e.actor_staff_id "
                    "ORDER BY e.id DESC LIMIT 100")
            self._json({"events": [{
                "id": e["id"], "ts_txt": fmt(e["ts"]), "type": e["type"],
                "actor": e["actor"], "detail": e["detail"]} for e in rows]})

        def _notifications(self, q):
            sid, staff = self._me()
            channel = q.get("channel", ["screen"])[0]
            target = q.get("target", ["all"])[0]
            since = int(q.get("since", ["0"])[0])
            if channel != "screen" and not staff:
                return self._err("未登录", 401)
            rows = app.notifier.fetch(channel, target, since)
            self._json({"notifications": [notif_dto(n) for n in rows],
                        "latest": app.notifier.latest_id()})

        def _sse(self, q):
            channel = q.get("channel", ["screen"])[0]
            target = q.get("target", ["all"])[0]
            since = app.notifier.latest_id()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                self.wfile.write(b"retry: 3000\n\n")
                self.wfile.flush()
                while True:
                    new_id = app.notifier.wait(since, timeout=20)
                    if new_id > since:
                        rows = app.notifier.fetch(channel, target, since)
                        since = new_id
                        for n in rows:
                            payload = json.dumps(notif_dto(n), ensure_ascii=False)
                            self.wfile.write(f"data: {payload}\n\n".encode())
                        self.wfile.flush()
                    else:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def _attachment(self, q):
            sid, staff = self._me()
            if not staff or staff["role"] != "leader":
                return self._err("仅值班长可下载交接附件", 403)
            handover_id = int(q.get("id", ["0"])[0])
            h = app.db.q1("SELECT * FROM handovers WHERE id=?", (handover_id,))
            if not h or not h["attachment_path"]:
                return self._err("附件不存在", 404)
            path = Path(h["attachment_path"])
            if not path.is_file() or not str(path.resolve()).startswith(
                    str((Path(app.db.path).parent / "attachments").resolve())):
                return self._err("附件不存在", 404)
            self._file(path)

    return Handler


def staff_dict(s):
    if not s:
        return None
    return {"id": s["id"], "code": s["code"], "name": s["name"], "role": s["role"]}


def dict_from_row(row):
    return {k: row[k] for k in row.keys()}


def patrol_dto(p):
    return {
        "id": p["id"], "bed": p["bed"], "floor": p["floor"],
        "round_name": p["round_name"],
        "due_at_txt": fmt(p["due_at"]), "window_end_txt": fmt(p["window_end"]),
        "status": p["status"],
        "status_label": {"pending": "待巡", "done": "已巡", "late": "迟巡",
                         "missed": "漏检", "transferred": "已转交"}.get(p["status"], p["status"]),
        "done_at_txt": fmt(p["done_at"]), "done_by": p["done_name"], "result": p["result"],
    }


def notif_dto(n):
    return {"id": n["id"], "ts_txt": fmt(n["ts"]), "level": n["level"],
            "kind": n["kind"], "title": n["title"], "body": n["body"],
            "ref_call_id": n["ref_call_id"]}


def serve(db_path="data/carecall.db", host="0.0.0.0", port=8000):
    app = App(db_path)
    seed_mod.seed(app.db)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    print(f"养老机构呼叫与夜巡系统已启动: http://localhost:{port}")
    print("  楼层屏 /screen   护理员 /phone   值班长 /leader")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        app.buttons.stop()
        app.monitor.stop()
