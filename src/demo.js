// 演示案例生成:一条命令启动时顺带造出"按钮离线"和"超时未响应"两个案例,
// 外加一个连续呼叫和一个住户外出触发,让五个交付页面都有真实内容可看。
import { get, run } from './db.js';
import { pressButton, evaluateTimeouts } from './services/calls.js';
import { evaluatePatrol } from './services/patrol.js';
import { goOffline } from './adapters/buttons.js';

export function generateDemoCases(db, cfg, now) {
  const out = [];
  const btn = (code) => get(db, 'SELECT * FROM buttons WHERE code = ?', code);

  // 1) 实时呼叫:201-A 刚按下(待派单)
  pressButton(db, { buttonId: btn('BTN-201A').id, at: now - 20_000 });
  out.push('实时呼叫:201室A床 20 秒前触发,待派单');

  // 2) 连续呼叫:202-A 已派单后又按了两次
  const c2 = pressButton(db, { buttonId: btn('BTN-202A').id, at: now - 90_000 });
  pressButton(db, { buttonId: btn('BTN-202A').id, at: now - 30_000 });
  pressButton(db, { buttonId: btn('BTN-202A').id, at: now - 5_000 });
  out.push(`连续呼叫:202室A床 合并为 1 条呼叫(共 ${c2.repeat_count + 2} 次按键)`);

  // 3) 超时未响应:302-B 在(阈值+60秒)前触发,评估后进入 OVERDUE
  pressButton(db, { buttonId: btn('BTN-302B').id, at: now - (cfg.responseTimeoutSec + 60) * 1000 });
  out.push(`超时未响应:302室B床 ${cfg.responseTimeoutSec + 60} 秒前触发,无人响应`);

  // 4) 按钮离线:203-A 按钮掉线
  goOffline(db, 'BTN-203A', now - 120_000);
  out.push('按钮离线:203室A床 按钮离线,已通知值班长');

  // 5) 住户外出触发:204? —— 刘德海(202-B)登记外出,按钮被触发
  pressButton(db, { buttonId: btn('BTN-202B').id, at: now - 40_000 });
  out.push('住户外出:202室B床 住户外出期间按钮触发,待值班长核实');

  // 6) 夜巡漏检:造一个 30 分钟前就该巡、宽限 15 分钟的计划
  const floor2 = get(db, "SELECT id FROM floors WHERE name LIKE '2F%'");
  run(db, 'INSERT INTO patrol_plans(floor_id, room, scheduled_at, grace_minutes) VALUES (?,?,?,?)',
    floor2.id, '205', now - 30 * 60_000, 15);
  out.push('夜巡漏检:205室 计划 30 分钟前巡查,已过宽限期');

  const t = evaluateTimeouts(db, now, cfg);
  const p = evaluatePatrol(db, now);
  out.push(`评估完成:超时 ${t.overdue} 件,超时升级提醒 ${t.reminded} 件,漏检 ${p} 件`);
  return out;
}
