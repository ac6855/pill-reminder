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

function buildMessage(plan, s) {
  const title = siteTitle(s);
  if (s.privacy_mode === '1') {
    return {
      title: `${title}：该打卡了`,
      content: `时间 ${plan.time} 有一项待完成。打开打卡页查看详情。`
    };
  }
  const bits = [plan.time, plan.name];
  if (plan.dose) bits.push(plan.dose);
  if (plan.method) bits.push(plan.method);
  const head = bits.join(' · ');
  const tail = plan.note ? `\n备注：${plan.note}` : '';
  return { title: `${title}：${plan.time} ${plan.name}`, content: `${head}${tail}` };
}

export async function sendPush(plan) {
  const s = getSettings();
  const channel = s.push_channel || 'serverchan';
  const msg = buildMessage(plan, s);
  let ok = false;
  let detail = '';

  try {
    if (channel === 'serverchan') {
      const key = (s.serverchan_key || '').trim();
      if (!key) throw new Error('未配置 SendKey');
      const r = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
        title: msg.title,
        desp: msg.content
      });
      ok = r.status === 200 && (!r.json || r.json.code === 0);
      detail = r.json ? `code=${r.json.code} ${r.json.message || ''}` : `HTTP ${r.status}`;
    } else if (channel === 'wecom') {
      const hook = (s.wecom_webhook || '').trim();
      if (!hook) throw new Error('未配置企业微信 Webhook');
      const r = await postJson(hook, { msgtype: 'text', text: { content: `${msg.title}\n${msg.content}` } });
      ok = r.status === 200 && r.json && r.json.errcode === 0;
      detail = r.json ? `errcode=${r.json.errcode} ${r.json.errmsg || ''}` : `HTTP ${r.status}`;
    } else if (channel === 'custom') {
      const hook = (s.custom_webhook || '').trim();
      if (!hook) throw new Error('未配置自定义 Webhook');
      const r = await postJson(hook, {
        title: msg.title,
        content: msg.content,
        time: plan.time,
        name: s.privacy_mode === '1' ? '' : plan.name
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

  return { ok, detail: detail.slice(0, 300), channel, msg };
}
