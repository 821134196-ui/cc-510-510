// 交班:每班一条记录,prev_id 串成链。上一班未确认接班时不允许新开交班(不断链)。
// 交班时快照未结束呼叫;交出人手上未结束的呼叫移交给接班人,保证呼叫不悬空。
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify, CHANNEL, LEVEL } from '../adapters/notify.js';
import { ACTIVE_STATUSES, bedLocation } from './calls.js';

export function latestHandover(db, floorId) {
  return get(db, 'SELECT * FROM handovers WHERE floor_id = ? ORDER BY id DESC LIMIT 1', floorId);
}

export function createHandover(db, { floorId, outStaff, inStaffId, note = '', attachment = null, at = clock.now(), attachmentsDir }) {
  const inStaff = get(db, 'SELECT * FROM staff WHERE id = ?', inStaffId);
  if (!inStaff) throw notFound('STAFF_NOT_FOUND', '接班人不存在');
  if (inStaff.id === outStaff.id) throw badRequest('SAME_STAFF', '交班人与接班人不能是同一人');

  const prev = latestHandover(db, floorId);
  if (prev && prev.status !== 'ACKED') {
    throw conflict('HANDOVER_CHAIN_BROKEN',
      `上一班交接(#${prev.id})尚未被确认接班,不能断链新开交班`);
  }

  const marks = ACTIVE_STATUSES.map(() => '?').join(',');
  const openCalls = all(db,
    `SELECT c.id FROM calls c JOIN beds b ON b.id = c.bed_id
     WHERE b.floor_id = ? AND c.status IN (${marks}) ORDER BY c.id`,
    floorId, ...ACTIVE_STATUSES);
  const openIds = openCalls.map((c) => c.id);

  const { lastId } = run(db,
    `INSERT INTO handovers(floor_id, prev_id, out_staff_id, in_staff_id, created_at, note, open_call_ids, status)
     VALUES (?,?,?,?,?,?,?, 'PENDING')`,
    floorId, prev?.id ?? null, outStaff.id, inStaff.id, at, note, JSON.stringify(openIds));

  // 交接附件存本地文件
  let attachmentPath = null;
  if (attachment && attachment.data) {
    const safeName = String(attachment.name || 'attachment.bin').replace(/[^\w.\-一-鿿]/g, '_').slice(-80);
    const fname = `handover-${lastId}-${safeName}`;
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, fname), Buffer.from(attachment.data, 'base64'));
    attachmentPath = fname;
    run(db, 'UPDATE handovers SET attachment_path = ? WHERE id = ?', fname, lastId);
  }

  // 交出人手上未结束的呼叫移交给接班人(护理员),保证不悬空
  let transferred = 0;
  if (inStaff.role === 'caregiver') {
    const mine = all(db,
      `SELECT c.* FROM calls c JOIN beds b ON b.id = c.bed_id
       WHERE b.floor_id = ? AND c.assignee_id = ? AND c.status IN (${marks})`,
      floorId, outStaff.id, ...ACTIVE_STATUSES);
    for (const c of mine) {
      run(db, 'UPDATE calls SET assignee_id = ? WHERE id = ?', inStaff.id, c.id);
      run(db, 'INSERT INTO call_events(call_id, at, actor_id, type, detail) VALUES (?,?,?,?,?)',
        c.id, at, outStaff.id, 'HANDOVER_TRANSFER', `交班转移:${outStaff.name} -> ${inStaff.name}`);
      transferred++;
    }
  }

  notify(db, {
    channel: CHANNEL.LEAD, level: LEVEL.INFO, at,
    message: `交班:${outStaff.name} -> ${inStaff.name},未结束呼叫 ${openIds.length} 件${transferred ? `,转移待办 ${transferred} 件` : ''},待接班确认`,
    refType: 'handover', refId: lastId,
  });
  return getHandover(db, lastId);
}

export function acknowledgeHandover(db, { id, staff, at = clock.now() }) {
  const h = get(db, 'SELECT * FROM handovers WHERE id = ?', id);
  if (!h) throw notFound('HANDOVER_NOT_FOUND', '交班记录不存在');
  if (h.in_staff_id !== staff.id) throw forbidden('NOT_IN_STAFF', '只有接班人本人才能确认接班');
  if (h.status !== 'PENDING') throw conflict('ALREADY_ACKED', '该交班已确认,不能重复确认');
  run(db, "UPDATE handovers SET status = 'ACKED', acknowledged_at = ? WHERE id = ?", at, id);
  notify(db, {
    channel: CHANNEL.LEAD, level: LEVEL.INFO, at,
    message: `接班确认:交班 #${id} 已确认,交接链完整`,
    refType: 'handover', refId: id,
  });
  return getHandover(db, id);
}

export function getHandover(db, id) {
  const h = get(db, `
    SELECT h.*, o.name AS out_name, i.name AS in_name, f.name AS floor_name
    FROM handovers h
    JOIN staff o ON o.id = h.out_staff_id
    JOIN staff i ON i.id = h.in_staff_id
    JOIN floors f ON f.id = h.floor_id
    WHERE h.id = ?`, id);
  if (!h) throw notFound('HANDOVER_NOT_FOUND', '交班记录不存在');
  return { ...h, open_call_ids: JSON.parse(h.open_call_ids || '[]') };
}

export function listHandovers(db, floorId = null) {
  const params = [];
  let where = '';
  if (floorId) { where = 'WHERE h.floor_id = ?'; params.push(Number(floorId)); }
  const rows = all(db, `
    SELECT h.*, o.name AS out_name, i.name AS in_name, f.name AS floor_name
    FROM handovers h
    JOIN staff o ON o.id = h.out_staff_id
    JOIN staff i ON i.id = h.in_staff_id
    JOIN floors f ON f.id = h.floor_id
    ${where} ORDER BY h.id DESC`, ...params);
  return rows.map((h) => ({ ...h, open_call_ids: JSON.parse(h.open_call_ids || '[]') }));
}
