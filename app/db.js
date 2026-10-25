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
  ok         INTEGER NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_push_plan_date ON push_logs (plan_id, date, time);
`);

const DEFAULT_SETTINGS = {
  push_enabled: '0',
  push_channel: 'serverchan',
  serverchan_key: '',
  wecom_webhook: '',
  custom_webhook: '',
  privacy_mode: '1',
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
    enabled: input.enabled === 0 || input.enabled === '0' || input.enabled === false ? 0 : 1
  };
}

export function createPlan(input) {
  const p = normalizePlan(input);
  const info = db
    .prepare('INSERT INTO plans (time, name, dose, method, note, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.time, p.name, p.dose, p.method, p.note, p.enabled);
  return getPlan(Number(info.lastInsertRowid));
}

export function updatePlan(id, input) {
  const p = normalizePlan(input);
  db.prepare(
    'UPDATE plans SET time = ?, name = ?, dose = ?, method = ?, note = ?, enabled = ? WHERE id = ?'
  ).run(p.time, p.name, p.dose, p.method, p.note, p.enabled, Number(id));
  return getPlan(id);
}

export function setPlanEnabled(id, enabled) {
  db.prepare('UPDATE plans SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
  return getPlan(id);
}

export function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(Number(id));
  db.prepare('DELETE FROM checkins WHERE plan_id = ?').run(Number(id));
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

export function pushStateFor(planId, date, time) {
  const rows = db
    .prepare('SELECT ok FROM push_logs WHERE plan_id = ? AND date = ? AND time = ?')
    .all(Number(planId), date, time);
  const ok = rows.some((r) => r.ok === 1);
  return { ok, attempts: rows.length };
}

export function logPush(planId, date, time, channel, ok, detail) {
  db.prepare(
    'INSERT INTO push_logs (plan_id, date, time, channel, ok, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(Number(planId) || null, date, time, channel, ok ? 1 : 0, String(detail || '').slice(0, 300));
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

export function statsFor(date) {
  const plans = db.prepare('SELECT * FROM plans WHERE enabled = 1 ORDER BY time ASC').all();
  const done = new Set(listCheckins(date).map((r) => r.plan_id));
  return {
    date,
    total: plans.length,
    done: plans.filter((p) => done.has(p.id)).length
  };
}
