import { recentBuckets, MAX_SERVER_TIME } from "../lib/periods.js";
import { paceFrom } from "../lib/format.js";

// 화면의 총계·기간 통계는 서버 집계를 사용한다. 전체 목록 조회와 순수 합산
// 함수는 도구/목업 호환을 위해 남기고 실제 화면은 목록을 페이지별로 읽는다.

const PAGE = 200;
// Compatibility export for tools that need every record. Screens use server
// aggregates plus lazy pages instead of downloading the whole history.

export async function fetchAllRuns(api) {
  const runs = [];
  for (let page = 0; ; page += 1) {
    if (page * PAGE > 1000000) throw Object.assign(new Error("record_list_limit"), { status: 400 });
    const batch = await api.myRuns(PAGE, page * PAGE);
    runs.push(...batch);
    if (batch.length < PAGE) break;
  }
  // 페이지 사이에 새 기록이 들어오면 같은 id가 두 번 올 수 있다.
  const seen = new Set();
  return runs.filter((run) => (seen.has(run.id) ? false : (seen.add(run.id), true)));
}

/** 정상(accepted) 기록만 합산. 평균 페이스는 총 시간 / 총 거리 (러닝별 평균의 평균 아님). */
export function summarize(runs) {
  let distance = 0;
  let seconds = 0;
  let count = 0;
  let flagged = 0;
  for (const run of runs) {
    if (!run.accepted) {
      flagged += 1;
      continue;
    }
    count += 1;
    distance += run.distance_m;
    if (run.distance_m > 0) seconds += run.duration_seconds;
  }
  return { distance, seconds, count, flagged, pace: paceFrom(distance, seconds) };
}

/** 최근 n주/n개월 막대그래프 데이터 */
export function periodSeries(runs, kind, count) {
  const buckets = recentBuckets(kind, count).map((bucket) => ({ ...bucket, runs: [] }));
  for (const run of runs) {
    const bucket = buckets.find((b) => run.started_at >= b.from && run.started_at < b.to);
    if (bucket) bucket.runs.push(run);
  }
  return buckets.map((bucket) => ({ from: bucket.from, to: bucket.to, ...summarize(bucket.runs) }));
}

/** 이번 기간과 직전 기간 비교 문구에 쓸 값. 이전이 0이면 비율을 만들지 않는다. */
export function compareLast(series) {
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  if (!current) return null;
  if (!previous || previous.distance === 0) {
    return { current, previous: previous || null, diff: null, ratio: null };
  }
  const diff = current.distance - previous.distance;
  return { current, previous, diff, ratio: diff / previous.distance };
}

function statsSummary(stats) {
  return { distance: stats.distance_m, seconds: stats.duration_seconds, count: stats.accepted_runs,
    flagged: stats.flagged_runs, pace: stats.pace_seconds_per_km };
}

/** 여러 구간 통계를 하나로 합친다. 페이스는 합친 시간 / 합친 거리 (구간 페이스의 평균 아님). */
export function combineBuckets(buckets) {
  const distance = buckets.reduce((sum, b) => sum + b.distance, 0);
  const seconds = buckets.reduce((sum, b) => sum + b.seconds, 0);
  return {
    from: buckets[0]?.from,
    to: buckets[buckets.length - 1]?.to,
    distance,
    seconds,
    count: buckets.reduce((sum, b) => sum + b.count, 0),
    flagged: buckets.reduce((sum, b) => sum + b.flagged, 0),
    pace: paceFrom(distance, seconds),
  };
}

// 화면별 기간 설정. day는 최근 7일을 그리고, 비교용으로 그 전 7일까지 14일을 받는다.
export const OVERVIEW = {
  day: { fetch: 14, show: 7 },
  week: { fetch: 8, show: 8 },
  month: { fetch: 6, show: 6 },
};

/**
 * 구간별 통계. 일·주는 서버 /api/me/stats/series 한 번으로 받는다 (C 서버가 GROUP BY로 집계).
 * 월은 달마다 길이가 달라 /api/me/stats를 달마다 부른다.
 * series API가 없는 예전 서버(404)면 구간마다 /api/me/stats를 부르는 방식으로 대신한다.
 */
export async function fetchBuckets(api, buckets, kind) {
  if (kind !== "month" && typeof api.myStatsSeries === "function") {
    try {
      const rows = await api.myStatsSeries(buckets[0].from, buckets[buckets.length - 1].to, kind);
      if (rows.length !== buckets.length) throw Object.assign(new Error("series_length_mismatch"), { status: 500 });
      return rows.map((row, i) => ({ ...buckets[i], ...statsSummary(row) }));
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  const rows = await Promise.all(buckets.map(({ from, to }) => api.myStats(from, Math.min(to, MAX_SERVER_TIME))));
  return rows.map((row, i) => ({ ...buckets[i], ...statsSummary(row) }));
}

/**
 * 기록 화면 데이터.
 * total: 전체 누적, series: 그래프 막대, periods: [직전 기간, 이번 기간] 비교용 (compareLast에 넘긴다).
 */
export async function fetchRecordOverview(api, kind, now) {
  const { fetch, show } = OVERVIEW[kind];
  const buckets = recentBuckets(kind, fetch, now);
  const [total, all] = await Promise.all([api.myStats(0, MAX_SERVER_TIME), fetchBuckets(api, buckets, kind)]);
  const series = all.slice(-show);
  const periods = kind === "day" ? [combineBuckets(all.slice(0, show)), combineBuckets(series)] : series;
  return { total: statsSummary(total), series, periods };
}
