import { recentBuckets } from "../lib/periods.js";
import { paceFrom } from "../lib/format.js";

// 개인 기록 조회와 화면용 기간 통계. 전용 집계 API가 없으므로 목록을 끝까지 읽어
// 브라우저에서 한국 날짜 기준으로 묶는다 (FRONTEND_PLAN: 데이터가 적은 1차 버전).

const PAGE = 200;
const MAX_PAGES = 50; // 최대 10,000개. 넘으면 서버 집계 API를 백엔드와 협의한다.

export async function fetchAllRuns(api) {
  const runs = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
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
