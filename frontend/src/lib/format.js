// 서버 단위(m, 초, m/s, 초/km)를 화면 표시용 문자열로 바꾼다. 계산은 서버 값을 그대로 쓴다.

export function km(meters, digits = 2) {
  if (!Number.isFinite(meters)) return "--";
  return (meters / 1000).toFixed(digits);
}

/** 초 -> "00:18:00" (1시간 미만이면 "18:00") */
export function duration(seconds, { alwaysHours = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 || alwaysHours ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 초/km -> 6'00" . null(0m 기록)은 "--" */
export function pace(secondsPerKm) {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return "--";
  const rounded = Math.round(secondsPerKm);
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  if (m >= 100) return "--";
  return `${m}'${String(s).padStart(2, "0")}"`;
}

/** 거리·시간으로 페이스(초/km)를 구한다. 거리가 0이면 null. */
export function paceFrom(distanceMeters, seconds) {
  if (!(distanceMeters > 0) || !(seconds > 0)) return null;
  return (seconds * 1000) / distanceMeters;
}

/** m/s -> km/h */
export function kmh(metersPerSecond, digits = 1) {
  if (!Number.isFinite(metersPerSecond)) return "--";
  return (metersPerSecond * 3.6).toFixed(digits);
}

const SEOUL = "Asia/Seoul";

/** Unix 초 -> "11월 3일 (화) 오후 7:12" */
export function dateTime(unixSeconds) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: SEOUL,
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

export function shortDate(unixSeconds) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: SEOUL, month: "numeric", day: "numeric" })
    .format(new Date(unixSeconds * 1000))
    .replace(/\.$/, "")
    .replace(/\. /g, ".");
}

export function monthLabel(unixSeconds) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: SEOUL, month: "long" }).format(
    new Date(unixSeconds * 1000),
  );
}

/** Unix 초 -> 한국 날짜의 요일 한 글자 ("월") */
export function weekdayLabel(unixSeconds) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: SEOUL, weekday: "narrow" }).format(new Date(unixSeconds * 1000));
}
