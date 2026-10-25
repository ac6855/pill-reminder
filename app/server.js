import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listPlans,
  createPlan,
  importPlans,
  updatePlan,
  deletePlan,
  setPlanEnabled,
  listCheckins,
  setCheckin,
  getSettings,
  setSetting,
  listPushLogs,
  listCheckinsDetail,
  pushStateFor,
  logPush,
  wipeAll,
  seedDemo
} from './db.js';
import { sendPush } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const TZ = process.env.TZ || 'Asia/Shanghai';
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 5);
const MAX_PUSH_ATTEMPTS = 3;

/* ---------- 时间工具（统一按 TZ 计算，不依赖容器默认时区） ---------- */

const dateFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const timeFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

function today() {
  return dateFmt.format(new Date());
}

function nowHM() {
  return timeFmt.format(new Date());
}

function minutesBetween(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* ---------- HTTP 辅助 ---------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ---------- 管理端鉴权 ---------- */

function adminToken() {
  return (getSettings().admin_token || '').trim();
}

function isAuthorized(req, url) {
  const expected = adminToken();
  if (!expected) return true;
  const header = req.headers['x-admin-token'];
  const query = url.searchParams.get('token');
  return header === expected || query === expected;
}

/* ---------- 路由 ---------- */

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);
  const seg = (i) => parts[i];

  if (url.pathname === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, today: today(), now: nowHM(), tz: TZ });
  }

  // 读接口：打卡页需要，不鉴权
  if (url.pathname === '/api/day' && method === 'GET') {
    const date = url.searchParams.get('date') || today();
    if (!isValidDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
    const plans = listPlans();
    const doneMap = new Map(listCheckins(date).map((r) => [r.plan_id, r.done_at]));
    const items = plans.map((p) => ({
      id: p.id,
      time: p.time,
      name: p.name,
      dose: p.dose,
      method: p.method,
      note: p.note,
      enabled: p.enabled,
      done: doneMap.has(p.id),
      done_at: doneMap.get(p.id) || null
    }));
    const active = items.filter((i) => i.enabled);
    return json(res, 200, {
      date,
      isToday: date === today(),
      now: nowHM(),
      items,
      stats: { total: active.length, done: active.filter((i) => i.done).length },
      title: getSettings().site_title || '用药提醒'
    });
  }

  if (url.pathname === '/api/checkin' && method === 'POST') {
    const body = await readBody(req);
    const date = body.date || today();
    if (!isValidDate(date)) return json(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
    if (!body.planId) return json(res, 400, { error: '缺少 planId' });
    setCheckin(Number(body.planId), date, !!body.done);
    const doneMap = new Map(listCheckins(date).map((r) => [r.plan_id, r.done_at]));
    return json(res, 200, { ok: true, done: doneMap.has(Number(body.planId)), done_at: doneMap.get(Number(body.planId)) || null });
  }

  // 以下均为管理接口
  if (url.pathname.startsWith('/api/') && !isAuthorized(req, url)) {
    return json(res, 401, { error: '管理口令无效，请在页面右上角重新输入' });
  }

  if (url.pathname === '/api/plans' && method === 'GET') {
    return json(res, 200, { items: listPlans() });
  }

  if (url.pathname === '/api/plans' && method === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, { ok: true, item: createPlan(body) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (url.pathname === '/api/plans/import' && method === 'POST') {
    const body = await readBody(req);
    try {
      const mode = body.mode === 'replace' ? 'replace' : 'append';
      return json(res, 200, { ok: true, ...importPlans(body.items, mode) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (seg(0) === 'api' && seg(1) === 'plans' && seg(2) && !seg(3)) {
    const id = Number(seg(2));
    if (method === 'PUT') {
      const body = await readBody(req);
      try {
        return json(res, 200, { ok: true, item: updatePlan(id, body) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (method === 'DELETE') {
      deletePlan(id);
      return json(res, 200, { ok: true });
    }
  }

  if (seg(0) === 'api' && seg(1) === 'plans' && seg(2) && seg(3) === 'enabled' && method === 'PATCH') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, item: setPlanEnabled(Number(seg(2)), !!body.enabled) });
  }

  if (url.pathname === '/api/settings' && method === 'GET') {
    const s = getSettings();
    const masked = { ...s };
    for (const k of ['serverchan_key', 'admin_token']) {
      if (masked[k]) masked[k] = '••••••••';
    }
    return json(res, 200, { settings: s, masked });
  }

  if (url.pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const allowed = [
      'push_enabled',
      'push_channel',
      'serverchan_key',
      'wecom_webhook',
      'custom_webhook',
      'privacy_mode',
      'site_title',
      'admin_token'
    ];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        if (k === 'admin_token' && body[k] === '••••••••') continue;
        setSetting(k, body[k]);
      }
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/push/test' && method === 'POST') {
    const fake = { time: nowHM(), name: '测试项目', dose: '1 片', method: '口服', note: '这是一条测试推送' };
    const r = await sendPush(fake);
    logPush(null, today(), nowHM(), r.channel, r.ok, r.detail);
    return json(res, 200, { ok: r.ok, detail: r.detail, channel: r.channel, preview: r.msg });
  }

  if (url.pathname === '/api/logs' && method === 'GET') {
    return json(res, 200, { items: listPushLogs(url.searchParams.get('limit') || 100) });
  }

  if (url.pathname === '/api/checkins' && method === 'GET') {
    return json(res, 200, { items: listCheckinsDetail(url.searchParams.get('limit') || 5000) });
  }

  if (url.pathname === '/api/demo' && method === 'POST') {
    return json(res, 200, { ok: true, items: seedDemo() });
  }

  if (url.pathname === '/api/wipe' && method === 'POST') {
    wipeAll();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, url.pathname);
    } else {
      res.writeHead(405).end('method not allowed');
    }
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

/* ---------- 定时推送 ---------- */

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = getSettings();
    if (s.push_enabled !== '1') return;

    const date = today();
    const now = nowHM();
    const plans = listPlans().filter((p) => p.enabled === 1);

    for (const plan of plans) {
      const diff = minutesBetween(plan.time, now);
      if (diff < 0 || diff > GRACE_MINUTES) continue;

      const state = pushStateFor(plan.id, date, plan.time);
      if (state.ok || state.attempts >= MAX_PUSH_ATTEMPTS) continue;

      const r = await sendPush(plan);
      logPush(plan.id, date, plan.time, r.channel, r.ok, r.detail);
      console.log(
        `[push] ${date} ${plan.time} #${plan.id} -> ${r.ok ? 'OK' : 'FAIL'} ${r.detail}`
      );
    }
  } catch (e) {
    console.error('[tick] error:', e.message);
  } finally {
    ticking = false;
  }
}

function scheduleTick() {
  const now = new Date();
  const msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  setTimeout(() => {
    tick();
    setInterval(tick, 60000);
  }, msToNextMinute + 50);
}

server.listen(PORT, () => {
  console.log(`用药提醒服务已启动: http://0.0.0.0:${PORT}  时区=${TZ}`);
  const s = getSettings();
  if (!s.admin_token) {
    console.warn('[warn] 未设置管理口令（admin_token），管理接口对局域网内任何人开放，建议尽快设置');
  }
  scheduleTick();
});
