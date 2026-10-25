import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  time       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  dose       TEXT    NOT NULL DEFAULT '',
  method     TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  weekdays   INTEGER NOT NULL DEFAULT 127,
  push_on    INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS checkins (
  plan_id    INTEGER NOT NULL,
  date       TEXT    NOT NULL,
  done_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (plan_id, date)
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS push_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER,
  date       TEXT NOT NULL,
  time       TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'first',
  ok         INTEGER NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_push_plan_date ON push_logs (plan_id, date, time);
`);

/* 老库补列：weekdays 为位掩码，bit0=周一 … bit6=周日，127 表示每天 */
{
  const cols = db.prepare('PRAGMA table_info(plans)').all();
  if (!cols.some((c) => c.name === 'weekdays')) {
    db.exec('ALTER TABLE plans ADD COLUMN weekdays INTEGER NOT NULL DEFAULT 127');
  }
  /* push_on：该条计划是否发送微信推送（1 发 / 0 只打卡不打扰） */
  if (!cols.some((c) => c.name === 'push_on')) {
    db.exec('ALTER TABLE plans ADD COLUMN push_on INTEGER NOT NULL DEFAULT 1');
  }
  /* push_logs.kind：first=到点提醒，remind=超时催办 */
  const logCols = db.prepare('PRAGMA table_info(push_logs)').all();
  if (!logCols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE push_logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'first'");
  }
}

/* ---------- 星期 ---------- */

export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WD_ALL = 127;
const WD_WORKDAY = 31;
const WD_WEEKEND = 96;

/** 返回日期对应的 ISO 星期：1=周一 … 7=周日（按日历日计算，不受容器时区影响） */
export function isoDowOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return 1;
  const jsDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return ((jsDow + 6) % 7) + 1;
}

/** 掩码是否包含某 ISO 星期 */
export function weekdayMatch(mask, isoDow) {
  const m = Number(mask);
  const bits = Number.isFinite(m) && m > 0 && m <= 127 ? m : WD_ALL;
  return ((bits >> (isoDow - 1)) & 1) === 1;
}

const WD_ALIAS = new Map([
  ['每天', WD_ALL], ['每日', WD_ALL], ['天天', WD_ALL], ['全部', WD_ALL],
  ['all', WD_ALL], ['everyday', WD_ALL], ['every', WD_ALL], ['*', WD_ALL],
  ['工作日', WD_WORKDAY], ['平时', WD_WORKDAY], ['weekday', WD_WORKDAY], ['weekdays', WD_WORKDAY],
  ['周末', WD_WEEKEND], ['双休', WD_WEEKEND], ['weekend', WD_WEEKEND], ['weekends', WD_WEEKEND]
]);

const WD_CHAR = new Map([
  ['1', 1], ['一', 1], ['2', 2], ['二', 2], ['3', 3], ['三', 3], ['4', 4], ['四', 4],
  ['5', 5], ['五', 5], ['6', 6], ['六', 6], ['7', 7], ['日', 7], ['天', 7], ['七', 7]
]);

function parseWeekdayToken(v) {
  let t = String(v ?? '').trim().toLowerCase();
  if (!t) return 0;
  if (WD_ALIAS.has(t)) return WD_ALIAS.get(t);
  t = t.replace(/^(周|星期|礼拜|week)/, '').replace(/(周|day)$/, '');
  const hit = WD_CHAR.get(t);
  return hit ? 1 << (hit - 1) : 0;
}

/** 把各种写法（"每天"/"工作日"/"1,3,5"/"周一、周三"/数组/掩码）统一成位掩码 */
export function normalizeWeekdays(raw) {
  if (raw === undefined || raw === null || raw === '') return WD_ALL;
  if (typeof raw === 'number') {
    const n = Math.trunc(raw);
    return n > 0 && n <= 127 ? n : WD_ALL;
  }
  if (Array.isArray(raw)) {
    let mask = 0;
    for (const v of raw) mask |= parseWeekdayToken(v);
    return mask || WD_ALL;
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return WD_ALL;
  if (WD_ALIAS.has(s)) return WD_ALIAS.get(s);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 7 && n <= 127) return n;
    if (n >= 1 && n <= 7) return 1 << (n - 1);
    return WD_ALL;
  }
  let mask = 0;
  for (const part of s.split(/[,，、;；/|\s]+/).filter(Boolean)) {
    mask |= parseWeekdayToken(part);
  }
  return mask || WD_ALL;
}

/** 掩码转可读中文，用于导出与提示 */
export function weekdaysLabel(mask) {
  const m = normalizeWeekdays(mask);
  if (m === WD_ALL) return '每天';
  if (m === WD_WORKDAY) return '工作日';
  if (m === WD_WEEKEND) return '周末';
  const out = [];
  for (let i = 1; i <= 7; i++) if (m & (1 << (i - 1))) out.push(WEEKDAY_NAMES[i - 1]);
  return out.join('、') || '每天';
}

const DEFAULT_SETTINGS = {
  push_enabled: '0',
  push_channel: 'serverchan',
  serverchan_key: '',
  wecom_webhook: '',
  wecom_mention_all: '1',
  custom_webhook: '',
  privacy_mode: '1',
  remind_after: '20',
  evening_summary: '0',
  evening_time: '21:30',
  site_title: '用药提醒',
  admin_token: ''
};

export function getSetting(k) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  if (row) return row.v;
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k) ? DEFAULT_SETTINGS[k] : '';
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT k, v FROM settings').all()) {
    out[row.k] = row.v;
  }
  return out;
}

export function setSetting(k, v) {
  db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).run(String(k), v === null || v === undefined ? '' : String(v));
}

export function listPlans() {
  return db.prepare('SELECT * FROM plans ORDER BY time ASC, id ASC').all();
}

export function getPlan(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizePlan(input) {
  const time = String(input.time ?? '').trim();
  if (!TIME_RE.test(time)) throw new Error('时间格式必须为 HH:MM（00:00–23:59）');
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('药品名称不能为空');
  if (name.length > 60) throw new Error('药品名称过长（上限 60 字）');
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  return {
    time,
    name,
    dose: clip(input.dose, 40),
    method: clip(input.method, 20),
    note: clip(input.note, 120),
    weekdays: normalizeWeekdays(input.weekdays),
    push_on: input.push_on === 0 || input.push_on === '0' || input.push_on === false ? 0 : 1,
    enabled: input.enabled === 0 || input.enabled === '0' || input.enabled === false ? 0 : 1
  };
}

export function createPlan(input) {
  const p = normalizePlan(input);
  const info = db
    .prepare(
      'INSERT INTO plans (time, name, dose, method, note, weekdays, push_on, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(p.time, p.name, p.dose, p.method, p.note, p.weekdays, p.push_on, p.enabled);
  return getPlan(Number(info.lastInsertRowid));
}

export function updatePlan(id, input) {
  const p = normalizePlan(input);
  db.prepare(
    'UPDATE plans SET time = ?, name = ?, dose = ?, method = ?, note = ?, weekdays = ?, push_on = ?, enabled = ? WHERE id = ?'
  ).run(p.time, p.name, p.dose, p.method, p.note, p.weekdays, p.push_on, p.enabled, Number(id));
  return getPlan(id);
}

export function setPlanEnabled(id, enabled) {
  db.prepare('UPDATE plans SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
  return getPlan(id);
}

/** 单独切换某条计划是否推送，与「启用」独立 */
export function setPlanPush(id, pushOn) {
  db.prepare('UPDATE plans SET push_on = ? WHERE id = ?').run(pushOn ? 1 : 0, Number(id));
  return getPlan(id);
}

export function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(Number(id));
  db.prepare('DELETE FROM checkins WHERE plan_id = ?').run(Number(id));
}

export function importPlans(items, mode = 'append') {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new Error('没有可导入的行');
  if (list.length > 200) throw new Error('单次最多导入 200 行');

  const out = { imported: 0, skipped: 0, errors: [] };
  const dup = db.prepare('SELECT id FROM plans WHERE time = ? AND name = ?');
  const ins = db.prepare(
    'INSERT INTO plans (time, name, dose, method, note, weekdays, push_on, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  db.exec('BEGIN');
  try {
    if (mode === 'replace') {
      db.exec('DELETE FROM checkins');
      db.exec('DELETE FROM plans');
    }
    list.forEach((row, i) => {
      let p;
      try {
        p = normalizePlan(row || {});
      } catch (e) {
        out.errors.push({ line: Number(row && row.__line) || i + 1, message: e.message });
        return;
      }
      if (dup.get(p.time, p.name)) {
        out.skipped++;
        return;
      }
      ins.run(p.time, p.name, p.dose, p.method, p.note, p.weekdays, p.push_on, p.enabled);
      out.imported++;
    });
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已自动结束，忽略回滚失败 */
    }
    throw e;
  }
  return out;
}

export function listCheckins(date) {
  return db.prepare('SELECT plan_id, done_at FROM checkins WHERE date = ?').all(date);
}

export function listCheckinsDetail(limit = 5000) {
  const n = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  return db
    .prepare(
      `SELECT c.date, p.time, p.name, c.done_at
         FROM checkins c JOIN plans p ON p.id = c.plan_id
        ORDER BY c.date DESC, p.time ASC LIMIT ?`
    )
    .all(n);
}

export function setCheckin(planId, date, done) {
  if (done) {
    db.prepare(
      'INSERT INTO checkins (plan_id, date) VALUES (?, ?) ON CONFLICT(plan_id, date) DO NOTHING'
    ).run(Number(planId), date);
  } else {
    db.prepare('DELETE FROM checkins WHERE plan_id = ? AND date = ?').run(Number(planId), date);
  }
}

export function hasCheckin(planId, date) {
  return !!db.prepare('SELECT 1 AS x FROM checkins WHERE plan_id = ? AND date = ?').get(Number(planId), date);
}

/** kind: 'first' 到点提醒 / 'remind' 超时催办 / 'evening' 晚间总结，各自独立计数 */
const PUSH_KINDS = new Set(['first', 'remind', 'evening']);

export function pushStateFor(planId, date, time, kind = 'first') {
  const rows = db
    .prepare('SELECT ok FROM push_logs WHERE plan_id = ? AND date = ? AND time = ? AND kind = ?')
    .all(Number(planId), date, time, kind);
  const ok = rows.some((r) => r.ok === 1);
  return { ok, attempts: rows.length };
}

/** 晚间总结不属于任何计划，plan_id 为 NULL，单独查 */
export function eveningStateFor(date, time) {
  const rows = db
    .prepare("SELECT ok FROM push_logs WHERE plan_id IS NULL AND date = ? AND time = ? AND kind = 'evening'")
    .all(date, time);
  return { ok: rows.some((r) => r.ok === 1), attempts: rows.length };
}

export function logPush(planId, date, time, channel, ok, detail, kind = 'first') {
  db.prepare(
    'INSERT INTO push_logs (plan_id, date, time, channel, kind, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    Number(planId) || null,
    date,
    time,
    channel,
    PUSH_KINDS.has(kind) ? kind : 'first',
    ok ? 1 : 0,
    String(detail || '').slice(0, 300)
  );
}

export function listPushLogs(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db
    .prepare(
      `SELECT l.*, p.name AS plan_name
         FROM push_logs l LEFT JOIN plans p ON p.id = l.plan_id
        ORDER BY l.id DESC LIMIT ?`
    )
    .all(n);
}

export function wipeAll() {
  db.exec('DELETE FROM checkins; DELETE FROM push_logs; DELETE FROM plans;');
}

export function seedDemo() {
  const demo = [
    { time: '08:00', name: '示例药品 A', dose: '1 片', method: '口服', note: '示例行，请改成真实内容' },
    { time: '12:30', name: '示例药品 B', dose: '2 粒', method: '口服', note: '' },
    { time: '21:00', name: '示例测量项', dose: '—', method: '自测', note: '示例：记录数值' }
  ];
  const tx = db.prepare('INSERT INTO plans (time, name, dose, method, note, enabled) VALUES (?, ?, ?, ?, ?, 1)');
  for (const d of demo) tx.run(d.time, d.name, d.dose, d.method, d.note);
  return listPlans();
}

/** 某一天应当执行的计划（已启用 + 星期匹配） */
export function plansForDate(date) {
  const dow = isoDowOf(date);
  return db
    .prepare('SELECT * FROM plans WHERE enabled = 1 ORDER BY time ASC, id ASC')
    .all()
    .filter((p) => weekdayMatch(p.weekdays, dow));
}

export function statsFor(date) {
  const plans = plansForDate(date);
  const done = new Set(listCheckins(date).map((r) => r.plan_id));
  return {
    date,
    total: plans.length,
    done: plans.filter((p) => done.has(p.id)).length
  };
}

/** 晚间总结用的当天快照：总数、已完成、未完成明细；口径与打卡页一致（只算启用且当天该执行的） */
export function daySummary(date) {
  const plans = plansForDate(date);
  const done = new Set(listCheckins(date).map((r) => r.plan_id));
  const pending = plans
    .filter((p) => !done.has(p.id))
    .map((p) => ({ id: p.id, time: p.time, name: p.name, dose: p.dose }));
  return { date, total: plans.length, done: plans.length - pending.length, pending };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** 区间统计，周/月记录共用。days 含区间内每一天（未来的标 future，不计入汇总）；
 *  按项目的统计只算已经过去的日子，免得分母被未来天数撑大。 */
export function rangeStats(from, to, todayStr) {
  const today = todayStr || from;
  const plans = db
    .prepare('SELECT * FROM plans WHERE enabled = 1 ORDER BY time ASC, id ASC')
    .all();
  const doneRows = db
    .prepare('SELECT plan_id, date FROM checkins WHERE date BETWEEN ? AND ?')
    .all(from, to);
  const doneSet = new Set(doneRows.map((r) => r.date + '#' + r.plan_id));

  const days = [];
  for (let ds = from; ds <= to; ds = addDays(ds, 1)) {
    const dow = isoDowOf(ds);
    const active = plans.filter((p) => weekdayMatch(p.weekdays, dow));
    const done = active.filter((p) => doneSet.has(ds + '#' + p.id)).length;
    days.push({
      date: ds,
      dow,
      total: active.length,
      done,
      future: ds > today,
      isToday: ds === today
    });
  }

  const elapsed = days.filter((d) => !d.future);
  const perPlan = plans.map((p) => {
    let total = 0;
    let done = 0;
    for (const d of elapsed) {
      if (!weekdayMatch(p.weekdays, d.dow)) continue;
      total++;
      if (doneSet.has(d.date + '#' + p.id)) done++;
    }
    return {
      id: p.id,
      time: p.time,
      name: p.name,
      dose: p.dose,
      weekdays: p.weekdays,
      total,
      done
    };
  });

  return {
    from,
    to,
    today,
    days,
    plans: perPlan,
    summary: {
      days: elapsed.length,
      fullDays: elapsed.filter((d) => d.total > 0 && d.done === d.total).length,
      activeDays: elapsed.filter((d) => d.total > 0).length,
      total: elapsed.reduce((s, d) => s + d.total, 0),
      done: elapsed.reduce((s, d) => s + d.done, 0)
    }
  };
}
