import { getSettings } from './db.js';

const TIMEOUT_MS = 10000;

async function postForm(url, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return { status: res.status, json, text };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

function siteTitle(s) {
  return (s.site_title || '用药提醒').trim().slice(0, 40);
}

function buildMessage(plan, s, opts) {
  const title = siteTitle(s);
  const kind = opts.kind === 'remind' ? 'remind' : 'first';
  const late = Number(opts.minutesLate) || 0;

  if (s.privacy_mode === '1') {
    return kind === 'remind'
      ? {
          title: `${title}：还有一项没打卡`,
          content: `时间 ${plan.time} 的项目提醒后 ${late} 分钟仍未打卡，麻烦去点一下。`
        }
      : {
          title: `${title}：该打卡了`,
          content: `时间 ${plan.time} 有一项待完成。打开打卡页查看详情。`
        };
  }

  const bits = [plan.time, plan.name];
  if (plan.dose) bits.push(plan.dose);
  if (plan.method) bits.push(plan.method);
  const head = bits.join(' · ');

  if (kind === 'remind') {
    const tail = plan.note ? `\n备注：${plan.note}` : '';
    return {
      title: `${title}：${plan.time} ${plan.name} 还没打卡`,
      content: `${head}\n到点提醒已过 ${late} 分钟，确认后请到打卡页点一下。${tail}`
    };
  }

  const tail = plan.note ? `\n备注：${plan.note}` : '';
  return { title: `${title}：${plan.time} ${plan.name}`, content: `${head}${tail}` };
}

/** 晚间总结：汇总当天完成情况；隐私模式只报数量、不列药名 */
function buildSummary(sum, s) {
  const title = siteTitle(s);
  const total = Math.max(Number(sum.total) || 0, 0);
  const done = Math.min(Math.max(Number(sum.done) || 0, 0), total);
  const left = Array.isArray(sum.pending) ? sum.pending : [];

  if (!left.length) {
    return {
      title: `${title}：今天 ${total} 项都完成了`,
      content: `今天共 ${total} 项，已全部打卡，辛苦啦。`
    };
  }

  const head = `今天共 ${total} 项，已完成 ${done} 项，还有 ${left.length} 项没打卡`;
  if (s.privacy_mode === '1') {
    return {
      title: `${title}：今天还有 ${left.length} 项没打卡`,
      content: `${head}。\n打开打卡页查看详情。`
    };
  }

  /* 企业微信文本消息上限 2048 字节，留出余量只列前 10 条 */
  const MAX_LINES = 10;
  const lines = left
    .slice(0, MAX_LINES)
    .map((i) => `· ${i.time} ${i.name}${i.dose ? ' ' + i.dose : ''}`);
  if (left.length > MAX_LINES) lines.push(`· 另外还有 ${left.length - MAX_LINES} 项`);
  return {
    title: `${title}：今天还有 ${left.length} 项没打卡`,
    content: `${head}：\n${lines.join('\n')}\n打开打卡页补一下。`
  };
}

/** Server 酱支持多个 SendKey（各自绑定一个人的微信），用逗号/空格/换行分隔 */
function splitKeys(raw) {
  return String(raw || '')
    .split(/[\s,;，；|]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** 按渠道把消息真正发出去，提醒与总结共用 */
async function dispatch(msg, s, meta = {}) {
  const channel = s.push_channel || 'serverchan';
  let ok = false;
  let detail = '';

  try {
    if (channel === 'serverchan') {
      const keys = splitKeys(s.serverchan_key);
      if (!keys.length) throw new Error('未配置 SendKey');
      const results = [];
      for (const key of keys) {
        const r = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
          title: msg.title,
          desp: msg.content
        });
        const oneOk = r.status === 200 && (!r.json || r.json.code === 0);
        results.push({ ok: oneOk, text: r.json ? `code=${r.json.code}` : `HTTP ${r.status}` });
      }
      const failed = results.filter((x) => !x.ok);
      ok = failed.length === 0;
      detail =
        keys.length > 1
          ? `${keys.length - failed.length}/${keys.length} 个 SendKey 成功${failed.length ? '；失败：' + failed.map((f) => f.text).join(',') : ''}`
          : results[0] && results[0].text;
    } else if (channel === 'wecom') {
      const hook = (s.wecom_webhook || '').trim();
      if (!hook) throw new Error('未配置企业微信 Webhook');
      const payload = { msgtype: 'text', text: { content: `${msg.title}\n${msg.content}` } };
      if (s.wecom_mention_all === '1') payload.text.mentioned_list = ['@all'];
      const r = await postJson(hook, payload);
      ok = r.status === 200 && r.json && r.json.errcode === 0;
      detail = r.json ? `errcode=${r.json.errcode} ${r.json.errmsg || ''}` : `HTTP ${r.status}`;
    } else if (channel === 'custom') {
      const hook = (s.custom_webhook || '').trim();
      if (!hook) throw new Error('未配置自定义 Webhook');
      const r = await postJson(hook, {
        title: msg.title,
        content: msg.content,
        kind: meta.kind || 'first',
        time: meta.time || '',
        name: s.privacy_mode === '1' ? '' : meta.name || ''
      });
      ok = r.status >= 200 && r.status < 300;
      detail = `HTTP ${r.status}`;
    } else {
      throw new Error(`未知渠道：${channel}`);
    }
  } catch (e) {
    ok = false;
    detail = e.name === 'TimeoutError' ? '请求超时' : String(e.message || e);
  }

  return { ok, detail: String(detail || '').slice(0, 300), channel };
}

/** 单条计划的到点提醒 / 超时催办 */
export async function sendPush(plan, opts = {}) {
  const s = getSettings();
  const msg = buildMessage(plan, s, opts);
  const r = await dispatch(msg, s, {
    kind: opts.kind === 'remind' ? 'remind' : 'first',
    time: plan.time,
    name: plan.name
  });
  return { ...r, msg };
}

/** 晚间总结 */
export async function sendSummary(sum) {
  const s = getSettings();
  const msg = buildSummary(sum, s);
  const r = await dispatch(msg, s, { kind: 'evening', time: sum.time || '' });
  return { ...r, msg };
}
