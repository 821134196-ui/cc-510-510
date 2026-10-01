"""虚构演示数据。所有住户、员工均为虚构样本，不对应任何真实人士。"""
from __future__ import annotations

import time
from datetime import datetime

# 楼层 / 床位（楼层屏按楼层分组展示）
FLOORS = [
    (1, "一楼照护区", 1),
    (2, "二楼照护区", 2),
    (3, "三楼特护区", 3),
]

# (楼层id, 房号, 床序号) —— 每层 4 间房 × 2 床
BEDS = []
_bed_id = 1
for _fid, _, _ in FLOORS:
    for _room in range(1, 5):
        for _n in (1, 2):
            _room_no = _fid * 100 + _room
            BEDS.append((_bed_id, _fid, f"{_room_no}-{_n}",
                         f"{_room_no}房{_n}号床", _bed_id))
            _bed_id += 1

# 虚构住户（资料为演示用虚构样本；敏感字段仅值班长可查看）
RESIDENTS = [
    # (床位id, 姓名, 护理等级, 饮食, 病史摘要, 家属联系方式)
    (1,  "林秀兰", "半护", "软烂少盐", "高血压，规律服药", "138****1101（虚构）"),
    (2,  "周建国", "自理", "普食",     "无重大病史",       "138****1102（虚构）"),
    (3,  "陈桂英", "全护", "鼻饲",     "脑梗后康复期",     "138****1103（虚构）"),
    (4,  "黄德海", "半护", "糖尿病餐", "2型糖尿病",       "138****1104（虚构）"),
    (5,  "吴玉珍", "自理", "普食",     "睡眠浅",          "138****1105（虚构）"),
    (6,  "郑文斌", "特护", "鼻饲",     "气切、长期卧床",   "138****1106（虚构）"),
    (7,  "孙丽华", "半护", "少盐",     "冠心病",          "138****1107（虚构）"),
    (8,  "马长青", "全护", "软烂餐",   "阿尔茨海默症中期", "138****1108（虚构）"),
    (9,  "高淑敏", "自理", "普食",     "无重大病史",       "138****1109（虚构）"),
    (10, "罗永康", "半护", "少糖少盐", "糖尿病合并高血压", "138****1110（虚构）"),
    (11, "何秀凤", "全护", "鼻饲",     "帕金森晚期",       "138****1111（虚构）"),
    (12, "梁广志", "特护", "匀浆膳",   "气切，癫痫史",     "138****1112（虚构）"),
    (13, "宋雅琴", "自理", "普食",     "无重大病史",       "138****1113（虚构）"),
    (14, "唐守义", "半护", "软烂餐",   "心律失常",         "138****1114（虚构）"),
    (15, "冯玉梅", "全护", "少盐",     "脑卒中恢复期",     "138****1115（虚构）"),
    (16, "韩明远", "特护", "鼻饲",     "心衰，长期吸氧",   "138****1116（虚构）"),
    (17, "曹桂芳", "半护", "普食",     "骨质疏松",         "138****1117（虚构）"),
    (18, "沈松林", "自理", "普食",     "无重大病史",       "138****1118（虚构）"),
    (19, "潘玉华", "全护", "软烂少盐", "脑梗后失语",       "138****1119（虚构）"),
    (20, "苏振华", "半护", "糖尿病餐", "糖尿病、轻度认知障碍", "138****1120（虚构）"),
    (21, "卢秀珍", "特护", "鼻饲",     "气切、压疮护理",   "138****1121（虚构）"),
    (22, "彭国梁", "自理", "普食",     "无重大病史",       "138****1122（虚构）"),
    (23, "范淑娟", "半护", "少盐",     "冠心病术后",       "138****1123（虚构）"),
    (24, "白景田", "全护", "匀浆膳",   "阿尔茨海默症、卧床", "138****1124（虚构）"),
]

# 虚构员工：2 名值班长 + 4 名护理员（交班演示需要）
STAFF = [
    ("L1", "值班长·钱敏", "leader", "1234"),
    ("L2", "值班长·许岚", "leader", "1234"),
    ("N1", "护理员·王芳", "nurse", "0000"),
    ("N2", "护理员·李军", "nurse", "0000"),
    ("N3", "护理员·赵雪", "nurse", "0000"),
    ("N4", "护理员·孙浩", "nurse", "0000"),
]


def seed(db, now=None):
    now = now if now is not None else time.time()
    if db.q1("SELECT COUNT(*) c FROM beds")["c"] > 0:
        return False
    for fid, name, seq in FLOORS:
        db.execute("INSERT INTO floors(id,name,seq) VALUES(?,?,?)", (fid, name, seq))
    for bid, fid, code, label, seq in BEDS:
        db.execute("INSERT INTO beds(id,floor_id,code,label,seq) VALUES(?,?,?,?,?)",
                   (bid, fid, code, label, seq))
    for idx, (bid, name, level, dietary, note, contact) in enumerate(RESIDENTS, start=1):
        db.execute(
            "INSERT INTO residents(id,name,bed_id,care_level,dietary,medical_note,contact,present)"
            " VALUES(?,?,?,?,?,?,?,1)",
            (idx, name, bid, level, dietary, note, contact))
    for i, (code, name, role, pin) in enumerate(STAFF, start=1):
        db.execute("INSERT INTO staff(id,code,name,role,pin,active) VALUES(?,?,?,?,?,1)",
                   (i, code, name, role, pin))
    # 每床一个按钮
    for bid, fid, bcode, *_ in BEDS:
        db.execute(
            "INSERT INTO buttons(bed_id,code,online,enabled,last_heartbeat,installed_at)"
            " VALUES(?,?,1,1,?,?)",
            (bid, f"B-{bcode}", now, now))

    # 当前班次：白班；值班长 L1，护理员 N1/N2/N3
    cur = db.execute("INSERT INTO shifts(label,started_at) VALUES('白班',?)", (now,))
    shift_id = cur.lastrowid
    for sid, role in ((1, "leader"), (3, "caregiver"), (4, "caregiver"), (5, "caregiver")):
        db.execute(
            "INSERT INTO shift_staff(shift_id,staff_id,role_on_shift,joined_at)"
            " VALUES(?,?,?,?)", (shift_id, sid, role, now))

    # 夜巡计划：今晚 22:00 与次日 02:00 两轮，全护/特护床位必巡
    today = datetime.fromtimestamp(now).replace(hour=22, minute=0, second=0, microsecond=0)
    t22 = today.timestamp()
    if t22 < now:
        t22 += 86400
    t02 = t22 + 4 * 3600
    cared_beds = db.q(
        "SELECT b.id FROM beds b JOIN residents r ON r.bed_id=b.id "
        "WHERE r.care_level IN ('全护','特护') ORDER BY b.id")
    seq = 0
    for due in (t22, t02):
        for b in cared_beds:
            seq += 1
            db.execute(
                "INSERT INTO patrol_tasks(shift_id,bed_id,round_name,due_at,window_end,status)"
                " VALUES(?,?,?,?,?, 'pending')",
                (shift_id, b["id"],
                 "22:00 夜巡" if due == t22 else "02:00 夜巡",
                 due, due + 600))
    return True
