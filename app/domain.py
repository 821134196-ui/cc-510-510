"""领域服务：呼叫状态机、夜巡、交班、权限。

状态约束（核心规则）：
  active（待派单）→ assigned（已派单）→ arrived（已到床）→ resolved / false_pending
  - 一通未结束呼叫只能有一名负责护理员（DB 部分唯一索引 + 状态守卫双保险）
  - 误触不得删除：先书面说明转 false_pending，值班长核对：确认/驳回（驳回恢复原状态）
  - escalated=1 后只允许急救结案，普通结案被阻断
  - 同床连续呼叫达到阈值自动急救升级
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime

from . import config

OPEN_STATUSES = ("active", "assigned", "arrived", "false_pending")


class BizError(Exception):
    """业务规则冲突，消息可直接展示给用户。"""


# 护理员可见的呼叫状态（含连续呼叫标记）
STATUS_LABEL = {
    "active": "待派单",
    "assigned": "已派单",
    "arrived": "已到床",
    "resolved": "已结案",
    "false_pending": "误触待核",
    "false_confirmed": "误触已核实",
    "false_rejected": "误触驳回",
}


class Service:
    def __init__(self, db, notifier, clock=time.time):
        self.db = db
        self.notifier = notifier
        self.now = clock

    # ---------- 基础工具 ----------
    def _log(self, etype, detail="", call_id=None, actor_id=None, shift_id=None):
        self.db.execute(
            "INSERT INTO events(ts,call_id,shift_id,type,actor_staff_id,detail)"
            " VALUES(?,?,?,?,?,?)",
            (self.now(), call_id, shift_id, etype, actor_id, detail),
        )

    def _audit(self, actor_id, action, detail=""):
        self.db.execute(
            "INSERT INTO audit_log(ts,actor_id,action,detail) VALUES(?,?,?,?)",
            (self.now(), actor_id, action, detail),
        )

    def current_shift(self):
        return self.db.q1("SELECT * FROM shifts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")

    def on_shift_staff(self, role=None):
        shift = self.current_shift()
        if not shift:
            return []
        sql = ("SELECT s.* FROM staff s JOIN shift_staff ss ON ss.staff_id=s.id "
               "WHERE ss.shift_id=? AND ss.left_at IS NULL AND s.active=1")
        params = [shift["id"]]
        if role:
            sql += " AND ss.role_on_shift=?"
            params.append(role)
        return self.db.q(sql + " ORDER BY s.id", params)

    def fmt(self, ts):
        return datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else ""

    # ---------- 呼叫 ----------
    def open_call(self, button_code=None, bed_id=None, source_type="button", actor_id=None):
        """按钮触发（或值班长补发）一通呼叫。"""
        shift = self.current_shift()
        if not shift:
            raise BizError("当前没有进行中的班次")
        if button_code:
            btn = self.db.q1("SELECT * FROM buttons WHERE code=?", (button_code,))
            if not btn:
                raise BizError(f"未知按钮 {button_code}")
            if not btn["enabled"]:
                raise BizError("该按钮已停用（维护中），请用值班长台补发")
        elif bed_id:
            btn = self.db.q1("SELECT * FROM buttons WHERE bed_id=?", (bed_id,))
            if not btn:
                raise BizError("该床位未安装按钮")
        else:
            raise BizError("缺少按钮或床位")

        bed = self.db.q1("SELECT * FROM beds WHERE id=?", (btn["bed_id"],))
        floor = self.db.q1("SELECT * FROM floors WHERE id=?", (bed["floor_id"],))
        resident = self.db.q1("SELECT * FROM residents WHERE bed_id=?", (bed["id"],))

        # 连续呼叫链：同床位 10 分钟内的上一通
        window_start = self.now() - 600
        prev = self.db.q1(
            "SELECT * FROM calls WHERE bed_id=? AND opened_at>=? ORDER BY id DESC LIMIT 1",
            (bed["id"], window_start),
        )
        repeat_index = (prev["repeat_index"] + 1) if prev else 1
        away = 0 if (resident and resident["present"]) else 1

        cur = self.db.execute(
            "INSERT INTO calls(bed_id,button_id,resident_id,shift_id,source_type,"
            "opened_at,status,repeat_of,repeat_index,away_flag)"
            " VALUES(?,?,?,?,?,?, 'active',?,?,?)",
            (bed["id"], btn["id"], resident["id"] if resident else None, shift["id"],
             source_type, self.now(), prev["id"] if prev else None, repeat_index, away),
        )
        call_id = cur.lastrowid

        loc = f"{floor['name']} · {bed['label']}"
        if resident:
            loc += f"（{resident['name']}）"
        repeat_txt = f"·第{repeat_index}次连续呼叫 " if repeat_index > 1 else ""
        away_txt = "　⚠该床位住户外出，请现场核实" if away else ""
        title = f"【呼叫】{loc}"
        body = f"{repeat_txt}按钮 {btn['code']}　{self.fmt(self.now())}{away_txt}"
        level = "warn" if away else "urgent"
        self.notifier.push("call", level, title, body,
                           screen_target="all", ref_call_id=call_id)
        self._log("call_opened",
                  f"{source_type}; repeat={repeat_index}; away={away}",
                  call_id=call_id, actor_id=actor_id, shift_id=shift["id"])

        if repeat_index >= config.REPEAT_ESCALATE_COUNT:
            self.escalate(call_id, f"同床位 {repeat_index} 次连续呼叫，自动急救升级")
        return self.get_call(call_id)

    def get_call(self, call_id):
        return self.db.q1("SELECT * FROM calls WHERE id=?", (call_id,))

    def _call_location(self, call):
        return self.db.q1(
            "SELECT f.name AS floor, b.label AS bed, r.name AS resident "
            "FROM calls c JOIN beds b ON b.id=c.bed_id JOIN floors f ON f.id=b.floor_id "
            "LEFT JOIN residents r ON r.id=c.resident_id WHERE c.id=?",
            (call["id"],),
        )

    def assign_call(self, call_id, staff_id, actor_id=None):
        """派单给护理员。重复派单（呼叫已有人 / 护理员手上有未结束呼叫）一律拒绝。"""
        call = self.get_call(call_id)
        if not call:
            raise BizError("呼叫不存在")
        staff = self.db.q1("SELECT * FROM staff WHERE id=? AND active=1", (staff_id,))
        if not staff or staff["role"] != "nurse":
            raise BizError("只能派单给在岗护理员")
        if not any(s["id"] == staff_id for s in self.on_shift_staff("caregiver")):
            raise BizError("该护理员不在当前班次")
        if call["status"] != "active":
            raise BizError(f"呼叫当前为「{STATUS_LABEL[call['status']]}」，不能重复派单")
        try:
            cur = self.db.execute(
                "UPDATE calls SET status='assigned', assigned_staff_id=?, assigned_at=? "
                "WHERE id=? AND status='active'",
                (staff_id, self.now(), call_id),
            )
        except sqlite3.IntegrityError:
            raise BizError("该护理员手上已有未结束呼叫，不能同时派两通")
        if cur.rowcount == 0:  # 并发下被别人抢先派单
            raise BizError("该呼叫已被派单，不能重复派给两人")

        loc = self._call_location(call)
        self.notifier.push("call", "info",
                           f"【派单】{loc['floor']} · {loc['bed']}",
                           f"已派给 {staff['name']}　{self.fmt(self.now())}",
                           screen_target=None, phone_target=str(staff_id),
                           ref_call_id=call_id)
        self._log("assigned", f"staff={staff_id}", call_id=call_id, actor_id=actor_id or staff_id)
        return self.get_call(call_id)

    def arrive(self, call_id, staff_id):
        """护理员到床旁确认。"""
        call = self.get_call(call_id)
        if not call or call["assigned_staff_id"] != staff_id:
            raise BizError("只有该呼叫的负责护理员能确认到床")
        if call["status"] != "assigned":
            raise BizError(f"当前状态「{STATUS_LABEL[call['status']]}」无需到床确认")
        self.db.execute(
            "UPDATE calls SET status='arrived', arrivals=arrivals+1, arrived_at=? WHERE id=?",
            (self.now(), call_id),
        )
        loc = self._call_location(call)
        self.notifier.push("call", "info",
                           f"【到床】{loc['floor']} · {loc['bed']}",
                           f"{self._staff_name(staff_id)} 已到床旁　{self.fmt(self.now())}",
                           ref_call_id=call_id)
        self._log("arrived", "护理员已到床旁", call_id=call_id, actor_id=staff_id)
        return self.get_call(call_id)

    def resolve_call(self, call_id, staff_id, resolution, emergency=False):
        """填写处理结果并结案。急救升级后普通结案被阻断。"""
        call = self.get_call(call_id)
        if not call:
            raise BizError("呼叫不存在")
        if call["assigned_staff_id"] != staff_id:
            raise BizError("只有负责护理员能结案")
        if call["status"] != "arrived":
            raise BizError("须先到床旁确认才能填写处理结果")
        if not resolution or not resolution.strip():
            raise BizError("处理结果不能为空")
        if call["escalated"] and not emergency:
            raise BizError("该呼叫已急救升级，普通结案已阻断，请按急救流程结案")
        self.db.execute(
            "UPDATE calls SET status='resolved', resolved_at=?, resolution=?, resolved_by=?,"
            " emergency_close=? WHERE id=?",
            (self.now(), resolution.strip(), staff_id, 1 if emergency else 0, call_id),
        )
        loc = self._call_location(call)
        tag = "【急救结案】" if emergency else "【已结案】"
        self.notifier.push("call", "urgent" if emergency else "info",
                           f"{tag}{loc['floor']} · {loc['bed']}",
                           f"{resolution.strip()}　{self.fmt(self.now())}",
                           ref_call_id=call_id)
        self._log("resolved",
                  f"emergency={emergency}; {rescription_safe(resolution)}",
                  call_id=call_id, actor_id=staff_id)
        self._audit(staff_id, "call.resolve", f"call={call_id} emergency={emergency}")
        return self.get_call(call_id)

    # ---------- 误触：不能删，只能说明 + 值班长核对 ----------
    def request_false_alarm(self, call_id, staff_id, reason, note):
        call = self.get_call(call_id)
        if not call or call["assigned_staff_id"] != staff_id:
            raise BizError("只有负责护理员能提交误触说明")
        if call["status"] not in ("assigned", "arrived"):
            raise BizError(f"当前状态「{STATUS_LABEL[call['status']]}」不能提交误触")
        if not note or not note.strip():
            raise BizError("误触必须填写书面说明，不能直接删除记录")
        self.db.execute(
            "UPDATE calls SET status='false_pending', prior_status=?,"
            " false_reason=?, false_note=?, false_requested_by=?, false_requested_at=? WHERE id=?",
            (call["status"], reason, note.strip(), staff_id, self.now(), call_id),
        )
        leaders = [s["id"] for s in self.on_shift_staff("leader")]
        self.notifier.push("system", "warn",
                           "【误触待核】有一条误触说明等待值班长核对",
                           f"呼叫 #{call_id}；原因：{reason}；说明：{note.strip()}",
                           leader_targets=leaders or None, ref_call_id=call_id)
        self._log("false_requested", f"{reason}: {note.strip()}",
                  call_id=call_id, actor_id=staff_id)
        return self.get_call(call_id)

    def review_false_alarm(self, call_id, leader_id, approve, review_note=""):
        call = self.get_call(call_id)
        if not call:
            raise BizError("呼叫不存在")
        leader = self.db.q1("SELECT * FROM staff WHERE id=?", (leader_id,))
        if not leader or leader["role"] != "leader":
            raise BizError("只有值班长能核对误触")
        if call["status"] != "false_pending":
            raise BizError("该呼叫不在待核状态")
        if approve:
            new_status = "false_confirmed"
            self.db.execute(
                "UPDATE calls SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
                (new_status, leader_id, self.now(), review_note, call_id),
            )
            self.notifier.push("system", "info",
                               f"【误触已核实】呼叫 #{call_id} 经值班长核实为误触",
                               f"记录保留不删除。{review_note}", ref_call_id=call_id)
        else:
            new_status = call["prior_status"] or "assigned"
            self.db.execute(
                "UPDATE calls SET status=?, prior_status=NULL, reviewed_by=?,"
                " reviewed_at=?, review_note=? WHERE id=?",
                (new_status, leader_id, self.now(), review_note, call_id),
            )
            self.notifier.push("system", "warn",
                               f"【误触驳回】呼叫 #{call_id} 恢复为「{STATUS_LABEL[new_status]}」",
                               f"请继续处理。{review_note}", ref_call_id=call_id)
        self._log("false_reviewed" if approve else "false_rejected",
                  f"note={review_note}", call_id=call_id, actor_id=leader_id)
        self._audit(leader_id, "call.false_review",
                    f"call={call_id} approve={approve}")
        return self.get_call(call_id)

    # ---------- 急救升级 ----------
    def escalate(self, call_id, reason, actor_id=None):
        call = self.get_call(call_id)
        if not call or call["escalated"]:
            return call
        self.db.execute(
            "UPDATE calls SET escalated=1, escalated_at=?, escalate_reason=? WHERE id=?",
            (self.now(), reason, call_id),
        )
        loc = self._call_location(call)
        leaders = [s["id"] for s in self.on_shift_staff("leader")]
        self.notifier.push("escalate", "urgent",
                           f"【急救升级】{loc['floor']} · {loc['bed']}",
                           f"{reason}　{self.fmt(self.now())}　普通结案已阻断，请按急救流程处置",
                           screen_target="all", phone_target="all",
                           leader_targets=leaders or None, ref_call_id=call_id)
        self._log("escalated", reason, call_id=call_id, actor_id=actor_id)
        self._audit(actor_id, "call.escalate", f"call={call_id} {reason}")
        return self.get_call(call_id)

    # ---------- 夜巡 ----------
    def patrol_done(self, task_id, staff_id, result):
        task = self.db.q1("SELECT * FROM patrol_tasks WHERE id=?", (task_id,))
        if not task:
            raise BizError("夜巡任务不存在")
        if task["status"] not in ("pending", "late"):
            raise BizError("该夜巡任务已结束")
        if not result or not result.strip():
            raise BizError("请填写夜巡结果")
        late = self.now() > task["window_end"]
        self.db.execute(
            "UPDATE patrol_tasks SET status=?, done_at=?, done_by=?, result=? WHERE id=?",
            ("late" if late else "done", self.now(), staff_id, result.strip(), task_id),
        )
        self._log("patrol_done", f"task={task_id} late={late}",
                  shift_id=task["shift_id"], actor_id=staff_id)
        return self.db.q1("SELECT * FROM patrol_tasks WHERE id=?", (task_id,))

    # ---------- 交班（不断链）----------
    def handover(self, from_staff_id, to_staff_id, leader_id, summary,
                 new_shift_label, attachment_src=None, attachment_name=None):
        """护理员交班：未结束呼叫与待办夜巡全部转交，事件链不断。"""
        shift = self.current_shift()
        if not shift:
            raise BizError("没有进行中的班次")
        leader = self.db.q1("SELECT * FROM staff WHERE id=? AND role='leader'", (leader_id,))
        if not leader:
            raise BizError("交班必须由值班长见证")
        a = self.db.q1("SELECT * FROM staff WHERE id=?", (from_staff_id,))
        b = self.db.q1("SELECT * FROM staff WHERE id=? AND active=1", (to_staff_id,))
        if not a or not b:
            raise BizError("交接双方员工信息有误")
        if a["id"] == b["id"]:
            raise BizError("不能交给自己")

        open_calls = self.db.q(
            "SELECT * FROM calls WHERE assigned_staff_id=? AND status IN "
            "('assigned','arrived','false_pending')",
            (from_staff_id,))
        # 新班次：旧班次封存，接班人进入新班次
        self.db.execute("UPDATE shifts SET ended_at=? WHERE id=?", (self.now(), shift["id"]))
        cur = self.db.execute(
            "INSERT INTO shifts(label,started_at) VALUES(?,?)",
            (new_shift_label, self.now()),
        )
        new_shift_id = cur.lastrowid
        self.db.execute(
            "INSERT INTO shift_staff(shift_id,staff_id,role_on_shift,joined_at) VALUES(?,?,?,?)",
            (new_shift_id, leader_id, "leader", self.now()),
        )
        self.db.execute(
            "INSERT INTO shift_staff(shift_id,staff_id,role_on_shift,joined_at) VALUES(?,?,?,?)",
            (new_shift_id, to_staff_id, "caregiver", self.now()),
        )
        self.db.execute("UPDATE shift_staff SET left_at=? WHERE shift_id=? AND staff_id=?",
                        (self.now(), shift["id"], from_staff_id))
        others = self.db.q(
            "SELECT staff_id, role_on_shift FROM shift_staff WHERE shift_id=? AND left_at IS NULL "
            "AND staff_id NOT IN (?,?)",
            (shift["id"], from_staff_id, leader_id),
        )
        for row in others:
            self.db.execute(
                "INSERT OR IGNORE INTO shift_staff(shift_id,staff_id,role_on_shift,joined_at)"
                " VALUES(?,?,?,?)",
                (new_shift_id, row["staff_id"], row["role_on_shift"], self.now()),
            )

        call_ids, patrol_ids = [], []
        # 待派单呼叫没有具体负责人：转入新班次继续排队，绝不在交班时静默丢失
        active_calls = self.db.q(
            "SELECT * FROM calls WHERE status='active' AND shift_id=?", (shift["id"],))
        for c in active_calls:
            self.db.execute("UPDATE calls SET shift_id=? WHERE id=?",
                            (new_shift_id, c["id"]))
            call_ids.append(c["id"])
            self._log("handover_call",
                      "待派单呼叫随班次转入，继续排队（交班不断链）",
                      call_id=c["id"], actor_id=leader_id, shift_id=new_shift_id)
        for c in open_calls:
            self.db.execute(
                "UPDATE calls SET assigned_staff_id=?, shift_id=? WHERE id=?",
                (to_staff_id, new_shift_id, c["id"]),
            )
            call_ids.append(c["id"])
            self._log("handover_call",
                      f"{a['name']} → {b['name']}（交班转交，呼叫不断链）",
                      call_id=c["id"], actor_id=leader_id, shift_id=new_shift_id)

        # 未完成夜巡转入新班次，旧任务置 transferred
        pending_patrols = self.db.q(
            "SELECT * FROM patrol_tasks WHERE shift_id=? AND status IN ('pending','late')",
            (shift["id"],))
        for p in pending_patrols:
            nc = self.db.execute(
                "INSERT INTO patrol_tasks(shift_id,bed_id,round_name,due_at,window_end,status)"
                " VALUES(?,?,?,?,?,?)",
                (new_shift_id, p["bed_id"], p["round_name"], p["due_at"], p["window_end"],
                 p["status"]),
            )
            patrol_ids.append(nc.lastrowid)
            self.db.execute("UPDATE patrol_tasks SET status='transferred' WHERE id=?", (p["id"],))

        attach_path = None
        if attachment_src:
            import shutil
            from pathlib import Path
            att_dir = Path(self.db.path).parent / "attachments"
            att_dir.mkdir(parents=True, exist_ok=True)
            ext = Path(attachment_src).suffix
            dst = att_dir / f"handover_{self.now():.0f}_{from_staff_id}_to_{to_staff_id}{ext}"
            shutil.copy(attachment_src, dst)
            attach_path = str(dst)

        self.db.execute(
            "INSERT INTO handovers(shift_id,from_staff_id,to_staff_id,leader_id,ts,summary,"
            "attachment_path,attachment_name,transferred_call_ids,transferred_patrol_ids)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (new_shift_id, from_staff_id, to_staff_id, leader_id, self.now(), summary,
             attach_path, attachment_name, json.dumps(call_ids), json.dumps(patrol_ids)),
        )
        self._audit(leader_id, "handover",
                    f"{a['name']}→{b['name']} calls={call_ids} patrols={patrol_ids}")
        self.notifier.push("handover", "info",
                           f"【交班完成】{a['name']} → {b['name']}",
                           f"转交未结呼叫 {len(call_ids)} 通、夜巡 {len(patrol_ids)} 项；"
                           f"责任已接续，链路不断。",
                           phone_target=str(to_staff_id))
        return {"shift_id": new_shift_id, "calls": call_ids, "patrols": patrol_ids}

    # ---------- 住户外出 / 资料权限 ----------
    def set_resident_away(self, resident_id, away, reason="", actor_id=None):
        r = self.db.q1("SELECT * FROM residents WHERE id=?", (resident_id,))
        if not r:
            raise BizError("住户不存在")
        self.db.execute(
            "UPDATE residents SET present=?, out_since=?, out_reason=? WHERE id=?",
            (0 if away else 1, self.now() if away else None, reason or None, resident_id),
        )
        self._log("resident_away" if away else "resident_back",
                  reason, actor_id=actor_id, shift_id=self.current_shift()["id"]
                  if self.current_shift() else None)
        self._audit(actor_id, "resident.away", f"resident={resident_id} away={away}")

    def residents_for(self, staff):
        """岗位限制：护理员只看照护必需字段；值班长可看完整资料。"""
        rows = self.db.q(
            "SELECT r.*, b.label AS bed, f.name AS floor FROM residents r "
            "JOIN beds b ON b.id=r.bed_id JOIN floors f ON f.id=b.floor_id ORDER BY b.id")
        data = []
        for r in rows:
            item = {
                "id": r["id"], "name": r["name"], "bed": r["bed"], "floor": r["floor"],
                "care_level": r["care_level"], "present": bool(r["present"]),
                "out_reason": r["out_reason"],
            }
            if staff["role"] == "leader":
                item.update({"dietary": r["dietary"], "medical_note": r["medical_note"],
                             "contact": r["contact"]})
            else:
                # 护理员岗位：敏感字段显式屏蔽（API 层也不返回）
                item.update({"dietary": None, "medical_note": None, "contact": None,
                             "restricted": True})
            data.append(item)
        return data

    # ---------- 统计 ----------
    def stats(self):
        shift = self.current_shift()
        sid = shift["id"] if shift else -1
        total = self.db.q1("SELECT COUNT(*) c FROM calls WHERE shift_id=?", (sid,))["c"]
        by_status = {r["status"]: r["c"] for r in self.db.q(
            "SELECT status, COUNT(*) c FROM calls WHERE shift_id=? GROUP BY status", (sid,))}
        resolved = self.db.q(
            "SELECT * FROM calls WHERE shift_id=? AND status='resolved'", (sid,))
        response_seconds, emergency, false_n = [], 0, 0
        for c in resolved:
            if c["assigned_at"] and c["resolved_at"]:
                response_seconds.append(c["resolved_at"] - c["opened_at"])
            emergency += c["emergency_close"]
        false_n = self.db.q1(
            "SELECT COUNT(*) c FROM calls WHERE shift_id=? AND status='false_confirmed'",
            (sid,))["c"]
        patrols = self.db.q(
            "SELECT status, COUNT(*) c FROM patrol_tasks WHERE shift_id=? GROUP BY status", (sid,))
        return {
            "shift": shift["label"] if shift else None,
            "total_calls": total,
            "by_status": by_status,
            "resolved": len(resolved),
            "emergency_close": emergency,
            "false_confirmed": false_n,
            "avg_response_seconds": round(sum(response_seconds) / len(response_seconds), 1)
            if response_seconds else None,
            "patrol": {r["status"]: r["c"] for r in patrols},
        }

    def _staff_name(self, sid):
        r = self.db.q1("SELECT name FROM staff WHERE id=?", (sid,))
        return r["name"] if r else f"#{sid}"


def rescription_safe(text, limit=80):
    text = (text or "").replace("\n", " ")
    return text[:limit]
