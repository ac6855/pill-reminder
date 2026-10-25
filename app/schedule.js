/* 服务端每分钟 tick 一次，这里判断某个目标时刻是否落在本次执行窗口内。
   目标用当日分钟数表示，催办目标可能超过 1440（如 23:50 + 20 分钟）。
   单独成文件是为了方便单测跨天边界。 */

export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

export function prevDate(d) {
  const [y, m, dd] = String(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
}

/* 同时比对今天与昨天两个基准，凌晨补发昨夜 23:5x 的计划或催办也能命中。
   返回该计划所属日期（跨天时为昨天）与已过去的分钟数，不命中返回 null。 */
export function dueSlot(dateStr, targetMin, nowMin, grace) {
  const todayDiff = nowMin - targetMin;
  if (todayDiff >= 0 && todayDiff <= grace) return { date: dateStr, late: todayDiff };

  const ydayDiff = nowMin + 1440 - targetMin;
  if (ydayDiff >= 0 && ydayDiff <= grace) return { date: prevDate(dateStr), late: ydayDiff };

  return null;
}
