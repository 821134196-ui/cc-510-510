// 虚构样本数据:所有住户姓名/病情/联系方式均为虚构,仅用于演示。
import { all, get, run } from './db.js';

const FLOORS = ['2F 安宁层', '3F 康养层'];

// [房号, 床, 姓名, 性别, 年龄, 照护等级, 行动能力, 健康备注, 过敏, 紧急联系人, 电话, 状态]
const RESIDENTS = [
  ['201', 'A', '王秀兰', '女', 82, '全护', '卧床', '高血压,每日两次血压监测', '青霉素', '王强(子)', '13800000001', 'IN'],
  ['201', 'B', '李建国', '男', 79, '半护', '助行器', '糖尿病,餐前胰岛素', null, '李芳(女)', '13800000002', 'IN'],
  ['202', 'A', '张淑芬', '女', 88, '全护', '卧床', '阿尔茨海默症,防走失', '磺胺类', '张立(子)', '13800000003', 'IN'],
  ['202', 'B', '刘德海', '男', 85, '半护', '轮椅', '脑梗后遗症,左侧偏瘫', null, '刘敏(女)', '13800000004', 'AWAY'],
  ['203', 'A', '陈桂英', '女', 91, '全护', '卧床', '心衰,夜间需关注呼吸', null, '陈军(子)', '13800000005', 'IN'],
  ['203', 'B', '杨守业', '男', 77, '自理', '独立', '偶发低血糖', null, '杨帆(子)', '13800000006', 'IN'],
  ['204', 'A', '赵玉梅', '女', 84, '半护', '助行器', '骨质疏松,防跌倒', '海鲜', '赵静(女)', '13800000007', 'IN'],
  ['205', 'A', '孙长福', '男', 90, '全护', '卧床', '帕金森,吞咽困难', null, '孙丽(女)', '13800000008', 'IN'],
  ['301', 'A', '周凤霞', '女', 80, '半护', '轮椅', '关节炎,定期复健', null, '周涛(子)', '13800000009', 'IN'],
  ['301', 'B', '吴广志', '男', 76, '自理', '独立', '慢性咳嗽观察中', null, '吴敏(女)', '13800000010', 'IN'],
  ['302', 'A', '郑玉兰', '女', 86, '全护', '卧床', '褥疮护理,每2小时翻身', '碘伏', '郑华(子)', '13800000011', 'IN'],
  ['302', 'B', '马文轩', '男', 83, '半护', '助行器', '轻度认知障碍', null, '马莉(女)', '13800000012', 'IN'],
  ['303', 'A', '高秀珍', '女', 89, '全护', '卧床', '尿毒症,每周透析三次', null, '高强(子)', '13800000013', 'HOSPITAL'],
  ['304', 'A', '林振国', '男', 78, '自理', '独立', '体检指标正常', null, '林芳(女)', '13800000014', 'IN'],
];

// [姓名, 角色, PIN, 楼层序号(0-based,null=全院)]
const STAFF = [
  ['陈静', 'caregiver', '1001', 0],
  ['刘洋', 'caregiver', '1002', 0],
  ['赵敏', 'caregiver', '1003', 1],
  ['孙浩', 'caregiver', '1004', 1],
  ['周岚', 'shift_lead', '2001', null],
  ['系统管理员', 'admin', '9001', null],
];

export function seedIfEmpty(db, now) {
  if (get(db, 'SELECT id FROM floors LIMIT 1')) return false;

  const floorIds = FLOORS.map((name) => run(db, 'INSERT INTO floors(name) VALUES (?)', name).lastId);

  // 每层楼 6 个房间 × 2 床
  const bedByRoomLabel = {};
  for (const [fi, floorId] of floorIds.entries()) {
    const base = fi === 0 ? 200 : 300;
    for (let r = 1; r <= 6; r++) {
      const room = String(base + r);
      for (const label of ['A', 'B']) {
        const sort = r * 10 + (label === 'A' ? 1 : 2);
        const bedId = run(db, 'INSERT INTO beds(floor_id, room, label, sort) VALUES (?,?,?,?)', floorId, room, label, sort).lastId;
        bedByRoomLabel[`${room}-${label}`] = bedId;
        run(db, 'INSERT INTO buttons(bed_id, code, status, last_seen_at) VALUES (?,?,?,?)',
          bedId, `BTN-${room}${label}`, 'ONLINE', now);
      }
    }
  }

  for (const [room, label, name, gender, age, care, mobility, notes, allergy, contact, phone, status] of RESIDENTS) {
    const bedId = bedByRoomLabel[`${room}-${label}`];
    if (!bedId) continue;
    run(db, `INSERT INTO residents(bed_id, name, gender, age, care_level, mobility, medical_notes, allergy, emergency_contact, emergency_phone, status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      bedId, name, gender, age, care, mobility, notes, allergy, contact, phone, status);
  }

  for (const [name, role, pin, fi] of STAFF) {
    run(db, 'INSERT INTO staff(name, role, pin, floor_id) VALUES (?,?,?,?)',
      name, role, pin, fi === null ? null : floorIds[fi]);
  }

  seedPatrolPlans(db, floorIds, now);
  return true;
}

// 生成今夜夜巡计划:每层楼每个有住户的房间,22:00/00:00/02:00/04:00/06:00 各一次
export function seedPatrolPlans(db, floorIds, now) {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const rounds = [22, 24, 26, 28, 30]; // 22:00 起每 2 小时(24=次日00:00)
  for (const floorId of floorIds) {
    const rooms = all(db,
      'SELECT DISTINCT b.room FROM beds b JOIN residents r ON r.bed_id = b.id WHERE b.floor_id = ? ORDER BY b.room',
      floorId);
    for (const { room } of rooms) {
      for (const h of rounds) {
        run(db, 'INSERT INTO patrol_plans(floor_id, room, scheduled_at, grace_minutes) VALUES (?,?,?,?)',
          floorId, room, dayStart + h * 3600_000, 15);
      }
    }
  }
}
