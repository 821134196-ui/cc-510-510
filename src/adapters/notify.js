// 通知模拟适配器:不接入真实短信/推送,所有通知落 SQLite 并打印日志,
// 楼层屏 / 护理员手机端 / 值班长 / 夜巡 各走各的通道。
// 所有报警通知都带完整文字内容(不只依赖颜色)。
import { run } from '../db.js';
import { clock } from '../clock.js';

export const CHANNEL = { FLOOR: 'FLOOR', CAREGIVER: 'CAREGIVER', LEAD: 'LEAD', PATROL: 'PATROL' };
export const LEVEL = { INFO: 'INFO', WARN: 'WARN', EMERGENCY: 'EMERGENCY' };

export function notify(db, { channel, audience = null, message, level = LEVEL.INFO, refType = null, refId = null, at = null }) {
  const ts = at ?? clock.now();
  const { lastId } = run(
    db,
    'INSERT INTO notifications(at, channel, audience, message, level, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)',
    ts, channel, audience, message, level, refType, refId
  );
  console.log(`[notify][${channel}][${level}] ${audience ? audience + ' ' : ''}${message}`);
  return lastId;
}
