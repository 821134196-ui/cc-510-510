// 零依赖 HTTP 服务:JSON API + 静态页面。每个 API 请求前先做一次惰性评估
// (超时升级 / 夜巡漏检),保证页面轮询到的状态总是新鲜的。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from './db.js';
import { clock } from './clock.js';
import { ApiError, unauthorized } from './errors.js';
import * as auth from './services/auth.js';
import * as calls from './services/calls.js';
import * as patrol from './services/patrol.js';
import * as handover from './services/handover.js';
import * as residents from './services/residents.js';
import { responseStats } from './services/stats.js';
import * as buttons from './adapters/buttons.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createServer({ db, cfg, attachmentsDir, publicDir }) {
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler, ...opts });
  };

  // ---------- 认证 ----------
  route('POST', '/api/login', async ({ body }) => auth.login(db, body));
  route('GET', '/api/me', async ({ staff }) => ({ staff: auth.publicStaff(staff) }), { auth: true });

  // ---------- 楼层屏(床位图 + 实时呼叫,只读,免登录)----------
  route('GET', '/api/floors', async () =>
    all(db, 'SELECT * FROM floors ORDER BY id'));

  route('GET', '/api/floors/:id/board', async ({ params }) => {
    const floorId = Number(params.id);
    const beds = all(db, `
      SELECT b.id, b.room, b.label, b.sort,
             r.id AS resident_id, r.name AS resident_name, r.care_level, r.status AS resident_status,
             bt.status AS button_status, bt.code AS button_code
      FROM beds b
      LEFT JOIN residents r ON r.bed_id = b.id
      LEFT JOIN buttons bt ON bt.bed_id = b.id
      WHERE b.floor_id = ? ORDER BY b.sort`, floorId);
    const active = calls.listCalls(db, { floorId, activeOnly: true });
    const activeByBed = {};
    for (const c of active) activeByBed[c.bed_id] = c;
    const recent = all(db,
      "SELECT * FROM notifications WHERE channel IN ('FLOOR','PATROL') ORDER BY id DESC LIMIT 8");
    return {
      now: clock.now(),
      beds: beds.map((b) => ({ ...b, active_call: activeByBed[b.id] || null })),
      active_calls: active,
      notifications: recent,
    };
  });

  // ---------- 呼叫 ----------
  route('GET', '/api/calls', async ({ query }) =>
    calls.listCalls(db, {
      floorId: query.floor_id ? Number(query.floor_id) : null,
      activeOnly: query.status === 'active',
    }), { auth: true });

  route('GET', '/api/calls/:id', async ({ params }) =>
    calls.callDetail(db, Number(params.id)), { auth: true });

  // 模拟按键(演示/联调用,等价于硬件按键上报)
  route('POST', '/api/calls/press', async ({ body }) => {
    const btn = buttons.press(db, body.button_code, {});
    return calls.pressButton(db, { buttonId: btn.id });
  });

  route('POST', '/api/calls/:id/assign', async ({ params, body, staff }) =>
    calls.assignCall(db, { callId: Number(params.id), staffId: Number(body.staff_id), actor: staff }),
    { auth: true });

  route('POST', '/api/calls/:id/ack', async ({ params, staff }) =>
    calls.ackCall(db, { callId: Number(params.id), actor: staff }), { auth: true });

  route('POST', '/api/calls/:id/resolve', async ({ params, body, staff }) =>
    calls.resolveCall(db, { callId: Number(params.id), actor: staff, resolution: body.resolution }),
    { auth: true });

  route('POST', '/api/calls/:id/escalate', async ({ params, body, staff }) =>
    calls.escalateCall(db, { callId: Number(params.id), actor: staff, reason: body.reason }),
    { auth: true });

  route('POST', '/api/calls/:id/emergency-resolve', async ({ params, body, staff }) =>
    calls.emergencyResolve(db, { callId: Number(params.id), actor: staff, note: body.note }),
    { auth: true });

  route('POST', '/api/calls/:id/false-trigger', async ({ params, body, staff }) =>
    calls.markFalseTrigger(db, { callId: Number(params.id), actor: staff, reason: body.reason }),
    { auth: true });

  route('POST', '/api/calls/:id/false-verify', async ({ params, body, staff }) =>
    calls.verifyFalseTrigger(db, { callId: Number(params.id), actor: staff, approve: !!body.approve }),
    { auth: true });

  // ---------- 护理员手机端待办 ----------
  route('GET', '/api/mobile/todos', async ({ staff }) => {
    const active = calls.listCalls(db, { activeOnly: true });
    const my = active.filter((c) => c.assignee_id === staff.id);
    // 本楼层未派单的呼叫也作为可领取待办
    const claimable = staff.role === auth.ROLE.CAREGIVER
      ? active.filter((c) => !c.assignee_id && c.floor_id === staff.floor_id && c.status !== 'FALSE_REVIEW')
      : [];
    const due = patrol.tonightPlans(db, staff.floor_id)
      .filter((p) => p.status === 'PENDING' || p.status === 'MISSED')
      .slice(0, 20);
    const result = { now: clock.now(), calls: my, claimable, patrols: due };
    // 值班长工作台:派单、急救结案、误触核对
    if (staff.role === auth.ROLE.SHIFT_LEAD || staff.role === auth.ROLE.ADMIN) {
      result.lead = {
        unassigned: active.filter((c) => !c.assignee_id && c.status !== 'FALSE_REVIEW'),
        escalated: active.filter((c) => c.status === 'ESCALATED'),
        false_review: active.filter((c) => c.status === 'FALSE_REVIEW'),
      };
    }
    return result;
  }, { auth: true, roles: [auth.ROLE.CAREGIVER, auth.ROLE.SHIFT_LEAD, auth.ROLE.ADMIN] });

  // ---------- 住户资料(按岗位分级)----------
  route('GET', '/api/residents', async ({ query, staff }) =>
    residents.listResidents(db, staff, query.floor_id), { auth: true });

  route('GET', '/api/residents/:id', async ({ params, staff }) =>
    residents.getResident(db, staff, Number(params.id)), { auth: true });

  // ---------- 夜巡 ----------
  route('GET', '/api/patrol/tonight', async ({ query }) =>
    patrol.tonightPlans(db, query.floor_id ? Number(query.floor_id) : null), { auth: true });

  route('GET', '/api/patrol/missed', async () => patrol.missedPatrols(db), { auth: true });

  route('POST', '/api/patrol/:id/check', async ({ params, body, staff }) =>
    patrol.checkPatrol(db, { planId: Number(params.id), staff, note: body.note || '' }),
    { auth: true, roles: [auth.ROLE.CAREGIVER, auth.ROLE.SHIFT_LEAD] });

  // ---------- 交班 ----------
  route('GET', '/api/handovers', async ({ query }) =>
    handover.listHandovers(db, query.floor_id ? Number(query.floor_id) : null), { auth: true });

  route('POST', '/api/handovers', async ({ body, staff }) =>
    handover.createHandover(db, {
      floorId: Number(body.floor_id),
      outStaff: staff,
      inStaffId: Number(body.in_staff_id),
      note: body.note || '',
      attachment: body.attachment || null,
      attachmentsDir,
    }), { auth: true });

  route('POST', '/api/handovers/:id/ack', async ({ params, staff }) =>
    handover.acknowledgeHandover(db, { id: Number(params.id), staff }), { auth: true });

  route('GET', '/api/handovers/:id/attachment', async ({ params, staff, res }) => {
    const h = handover.getHandover(db, Number(params.id));
    if (!h.attachment_path) throw new ApiError(404, 'NO_ATTACHMENT', '该交班没有附件');
    const file = path.join(attachmentsDir, path.basename(h.attachment_path));
    if (!fs.existsSync(file)) throw new ApiError(404, 'ATTACHMENT_MISSING', '附件文件不存在');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(h.attachment_path)}`,
    });
    fs.createReadStream(file).pipe(res);
    return STREAMED;
  }, { auth: true });

  // ---------- 统计 / 通知 / 员工 / 按钮模拟 ----------
  route('GET', '/api/stats/response', async ({ query }) =>
    responseStats(db, {
      floorId: query.floor_id ? Number(query.floor_id) : null,
      from: query.from ? Number(query.from) : null,
      to: query.to ? Number(query.to) : null,
    }), { auth: true });

  route('GET', '/api/notifications', async ({ query }) =>
    all(db, `SELECT * FROM notifications ${query.channel ? 'WHERE channel = ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...(query.channel ? [query.channel] : []), Math.min(Number(query.limit) || 30, 200)),
    { auth: true });

  route('GET', '/api/staff', async ({ query }) =>
    all(db,
      `SELECT id, name, role, floor_id FROM staff ${query.floor_id ? 'WHERE floor_id = ? OR floor_id IS NULL' : ''} ORDER BY role, id`,
      ...(query.floor_id ? [Number(query.floor_id)] : [])),
    { auth: true });

  route('POST', '/api/buttons/:code/offline', async ({ params }) => buttons.goOffline(db, params.code));
  route('POST', '/api/buttons/:code/online', async ({ params }) => buttons.goOnline(db, params.code));

  // ---------- 请求处理 ----------
  const STREAMED = Symbol('streamed');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const query = Object.fromEntries(url.searchParams);

    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    // 惰性评估:超时升级 + 夜巡漏检
    const now = clock.now();
    calls.evaluateTimeouts(db, now, cfg);
    patrol.evaluatePatrol(db, now);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.rx);
      if (!m) continue;
      try {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const staff = auth.staffByToken(db, (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        if (r.auth) {
          if (!staff) throw unauthorized();
          if (r.roles) auth.requireRole(staff, r.roles);
        }
        const body = await readBody(req, cfg.maxBodyBytes);
        const result = await r.handler({ req, res, params, query, body, staff });
        if (result === STREAMED) return;
        sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', String(err?.message || err));
        if (e.status === 500) console.error(err);
        sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  }

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('页面不存在');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'TOO_LARGE', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
