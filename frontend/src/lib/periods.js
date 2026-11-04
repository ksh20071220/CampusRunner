// 한국 시간(Asia/Seoul, UTC+9, 서머타임 없음) 날짜 경계를 Unix 초로 계산한다.
// 서버 기간은 [from, to) 이며 러닝 "시작 시각" 기준으로 집계된다.

const KST = 9 * 3600;
const DAY = 86400;
export const MAX_SERVER_TIME = 4102444800;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

function kstParts(unix) {
  const d = new Date((unix + KST) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function startOfDay(unix) {
  return Math.floor((unix + KST) / DAY) * DAY - KST;
}

/** 월요일 00:00 KST */
export function startOfWeek(unix) {
  const { weekday } = kstParts(unix);
  const daysSinceMonday = (weekday + 6) % 7;
  return startOfDay(unix) - daysSinceMonday * DAY;
}

export function startOfMonth(unix) {
  const { year, month } = kstParts(unix);
  return Date.UTC(year, month, 1) / 1000 - KST;
}

export function addMonths(monthStart, count) {
  const { year, month } = kstParts(monthStart);
  return Date.UTC(year, month + count, 1) / 1000 - KST;
}

/** 오늘을 포함하는 최근 n개 일/주/월 구간 (오래된 것부터) */
export function recentBuckets(kind, count, now = nowSeconds()) {
  const buckets = [];
  if (kind === "day") {
    const today = startOfDay(now);
    for (let i = count - 1; i >= 0; i -= 1) {
      const from = today - i * DAY;
      buckets.push({ from, to: from + DAY });
    }
  } else if (kind === "week") {
    const current = startOfWeek(now);
    for (let i = count - 1; i >= 0; i -= 1) {
      const from = current - i * 7 * DAY;
      buckets.push({ from, to: from + 7 * DAY });
    }
  } else {
    const current = startOfMonth(now);
    for (let i = count - 1; i >= 0; i -= 1) {
      const from = addMonths(current, -i);
      buckets.push({ from, to: addMonths(from, 1) });
    }
  }
  return buckets;
}

/** 순위 화면 등에서 쓰는 이름 있는 기간 */
export function namedPeriod(name, now = nowSeconds()) {
  if (name === "week") {
    const from = startOfWeek(now);
    return { from, to: from + 7 * DAY, label: "이번 주" };
  }
  if (name === "month") {
    const from = startOfMonth(now);
    return { from, to: addMonths(from, 1), label: "이번 달" };
  }
  return { from: 0, to: Math.min(now + DAY, MAX_SERVER_TIME), label: "전체 기간" };
}
