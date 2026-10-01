// 住户资料按岗位分级查看:护理员只看照护必需字段,值班长可见健康信息,
// 紧急联系人仅管理员可见。护理员只能查看本楼层住户。
import { all, get } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { ROLE, requireStaff } from './auth.js';

const FIELDS = {
  [ROLE.CAREGIVER]: ['id', 'name', 'gender', 'age', 'care_level', 'mobility', 'status', 'bed_id', 'room', 'label', 'floor_id'],
  [ROLE.SHIFT_LEAD]: ['id', 'name', 'gender', 'age', 'care_level', 'mobility', 'status', 'bed_id', 'room', 'label', 'floor_id', 'allergy', 'medical_notes'],
  [ROLE.ADMIN]: ['id', 'name', 'gender', 'age', 'care_level', 'mobility', 'status', 'bed_id', 'room', 'label', 'floor_id', 'allergy', 'medical_notes', 'emergency_contact', 'emergency_phone'],
};

export function residentView(row, role) {
  const allowed = FIELDS[role] || [];
  const view = {};
  for (const k of allowed) view[k] = row[k] ?? null;
  return view;
}

export function listResidents(db, staff, floorId) {
  requireStaff(staff);
  let fid = floorId ? Number(floorId) : null;
  if (staff.role === ROLE.CAREGIVER) {
    if (fid && fid !== staff.floor_id) {
      throw forbidden('FLOOR_FORBIDDEN', '护理员只能查看本楼层住户资料');
    }
    fid = staff.floor_id;
  }
  const sql = `
    SELECT r.*, b.room, b.label, b.floor_id
    FROM residents r JOIN beds b ON b.id = r.bed_id
    ${fid ? 'WHERE b.floor_id = ?' : ''} ORDER BY b.floor_id, b.room, b.label`;
  const rows = fid ? all(db, sql, fid) : all(db, sql);
  return rows.map((r) => residentView(r, staff.role));
}

export function getResident(db, staff, id) {
  requireStaff(staff);
  const row = get(
    db,
    'SELECT r.*, b.room, b.label, b.floor_id FROM residents r JOIN beds b ON b.id = r.bed_id WHERE r.id = ?',
    id
  );
  if (!row) throw notFound('RESIDENT_NOT_FOUND', '住户不存在');
  if (staff.role === ROLE.CAREGIVER && row.floor_id !== staff.floor_id) {
    throw forbidden('FLOOR_FORBIDDEN', '护理员只能查看本楼层住户资料');
  }
  return residentView(row, staff.role);
}
