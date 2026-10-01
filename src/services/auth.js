import crypto from 'node:crypto';
import { get, run } from '../db.js';
import { clock } from '../clock.js';
import { unauthorized, forbidden } from '../errors.js';

export const ROLE = { CAREGIVER: 'caregiver', SHIFT_LEAD: 'shift_lead', ADMIN: 'admin' };

export function login(db, { name, pin }) {
  const staff = get(db, 'SELECT * FROM staff WHERE name = ? AND pin = ?', name, pin);
  if (!staff) throw unauthorized('姓名或密码错误');
  const token = crypto.randomUUID();
  run(db, 'INSERT INTO sessions(token, staff_id, created_at) VALUES (?,?,?)', token, staff.id, clock.now());
  return { token, staff: publicStaff(staff) };
}

export function staffByToken(db, token) {
  if (!token) return null;
  const row = get(
    db,
    'SELECT s.* FROM staff s JOIN sessions ss ON ss.staff_id = s.id WHERE ss.token = ?',
    token
  );
  return row || null;
}

export function requireStaff(staff) {
  if (!staff) throw unauthorized();
  return staff;
}

export function requireRole(staff, roles) {
  requireStaff(staff);
  if (!roles.includes(staff.role)) {
    throw forbidden('ROLE_FORBIDDEN', '当前岗位无权执行此操作');
  }
  return staff;
}

export function publicStaff(s) {
  return { id: s.id, name: s.name, role: s.role, floor_id: s.floor_id };
}
