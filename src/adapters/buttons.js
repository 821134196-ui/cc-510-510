// 呼叫按钮模拟适配器:真实硬件的按键/心跳/掉线在这里用函数模拟。
import { get, run } from '../db.js';
import { clock } from '../clock.js';
import { notFound, conflict } from '../errors.js';
import { notify, CHANNEL, LEVEL } from './notify.js';

export function getButtonByCode(db, code) {
  const btn = get(db, 'SELECT * FROM buttons WHERE code = ?', code);
  if (!btn) throw notFound('BUTTON_NOT_FOUND', `按钮 ${code} 不存在`);
  return btn;
}

// 模拟按钮心跳上线
export function heartbeat(db, code, at = clock.now()) {
  const btn = getButtonByCode(db, code);
  run(db, 'UPDATE buttons SET last_seen_at = ? WHERE id = ?', at, btn.id);
  return btn;
}

// 模拟按钮离线:通知值班长与楼层屏(文字告警)
export function goOffline(db, code, at = clock.now()) {
  const btn = getButtonByCode(db, code);
  const bed = get(db, 'SELECT * FROM beds WHERE id = ?', btn.bed_id);
  run(db, "UPDATE buttons SET status = 'OFFLINE', last_seen_at = ? WHERE id = ?", at, btn.id);
  notify(db, {
    channel: CHANNEL.LEAD,
    level: LEVEL.WARN,
    message: `按钮离线:${bed.room}室${bed.label}床(编号 ${code})失去联系,请检查设备`,
    refType: 'button',
    refId: btn.id,
    at,
  });
  notify(db, {
    channel: CHANNEL.FLOOR,
    level: LEVEL.WARN,
    message: `设备提示:${bed.room}室${bed.label}床呼叫按钮离线`,
    refType: 'button',
    refId: btn.id,
    at,
  });
  return { ...btn, status: 'OFFLINE' };
}

export function goOnline(db, code, at = clock.now()) {
  const btn = getButtonByCode(db, code);
  run(db, "UPDATE buttons SET status = 'ONLINE', last_seen_at = ? WHERE id = ?", at, btn.id);
  return { ...btn, status: 'ONLINE' };
}

// 模拟按键。离线按钮物理上无法触发,直接拒绝。
export function press(db, code, { at = clock.now(), via = 'BUTTON' } = {}) {
  const btn = getButtonByCode(db, code);
  if (btn.status === 'OFFLINE') {
    throw conflict('BUTTON_OFFLINE', `按钮 ${code} 处于离线状态,无法触发呼叫`);
  }
  heartbeat(db, code, at);
  return btn;
}
