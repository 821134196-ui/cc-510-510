// 响应统计:响应时长(触发->到床旁)、结案时长、超时/急救/误触/连续呼叫计数、按护理员分组。
import { all } from '../db.js';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function responseStats(db, { floorId = null, from = null, to = null } = {}) {
  const conds = [];
  const params = [];
  if (floorId) { conds.push('b.floor_id = ?'); params.push(Number(floorId)); }
  if (from) { conds.push('c.triggered_at >= ?'); params.push(Number(from)); }
  if (to) { conds.push('c.triggered_at <= ?'); params.push(Number(to)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = all(db, `
    SELECT c.*, b.floor_id, s.name AS assignee_name
    FROM calls c JOIN beds b ON b.id = c.bed_id LEFT JOIN staff s ON s.id = c.assignee_id
    ${where} ORDER BY c.triggered_at`, ...params);

  const ackSecs = rows.filter((r) => r.acked_at).map((r) => (r.acked_at - r.triggered_at) / 1000).sort((a, b) => a - b);
  const resolveSecs = rows.filter((r) => r.resolved_at).map((r) => (r.resolved_at - r.triggered_at) / 1000).sort((a, b) => a - b);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null);

  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const perCaregiver = {};
  for (const r of rows) {
    if (!r.assignee_name) continue;
    const c = (perCaregiver[r.assignee_name] ||= { assigned: 0, acked: 0, resolved: 0, overdue: 0 });
    c.assigned++;
    if (r.acked_at) c.acked++;
    if (r.resolved_at) c.resolved++;
    if (r.went_overdue) c.overdue++;
  }

  return {
    total: rows.length,
    by_status: byStatus,
    ack_seconds: { avg: avg(ackSecs), p50: percentile(ackSecs, 50), p90: percentile(ackSecs, 90), max: ackSecs.length ? ackSecs[ackSecs.length - 1] : null, count: ackSecs.length },
    resolve_seconds: { avg: avg(resolveSecs), p50: percentile(resolveSecs, 50), p90: percentile(resolveSecs, 90), count: resolveSecs.length },
    overdue_count: rows.filter((r) => r.went_overdue).length,
    escalated_count: rows.filter((r) => r.escalated_at).length,
    false_trigger_count: rows.filter((r) => r.false_reason).length,
    repeat_press_total: rows.reduce((s, r) => s + Math.max(0, r.repeat_count - 1), 0),
    resident_away_count: rows.filter((r) => r.resident_away).length,
    per_caregiver: perCaregiver,
  };
}
