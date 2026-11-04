// 기록 화면 데이터(services/records.js)와 한국 시간 기간(lib/periods.js) 테스트.
// 실행: npm test   (서버 없이 가짜 api로 확인한다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineBuckets, compareLast, fetchRecordOverview } from "../src/services/records.js";
import { recentBuckets, startOfDay, startOfWeek } from "../src/lib/periods.js";

const DAY = 86400;
const kst = (text) => Date.parse(`${text}+09:00`) / 1000;
// 2026-11-05(목) 오전 1시 KST = UTC로는 아직 11월 4일. 한국 날짜 기준이어야 한다.
const NOW = kst("2026-11-05T01:00:00");

const stats = (distance_m, duration_seconds, accepted_runs = distance_m > 0 ? 1 : 0, flagged_runs = 0) => ({
  distance_m,
  duration_seconds,
  accepted_runs,
  flagged_runs,
  pace_seconds_per_km: distance_m > 0 ? (duration_seconds * 1000) / distance_m : null,
});

function fakeApi({ series = true, seriesStatus = 200, perBucket = () => stats(0, 0) } = {}) {
  const calls = [];
  const api = {
    async myStats(from, to) {
      calls.push(["myStats", from, to]);
      return from === 0 ? stats(42000, 12600, 9, 1) : perBucket(from, to);
    },
  };
  if (series) {
    api.myStatsSeries = async (from, to, bucket) => {
      calls.push(["myStatsSeries", from, to, bucket]);
      if (seriesStatus !== 200) throw Object.assign(new Error("not_found"), { status: seriesStatus });
      const size = bucket === "day" ? DAY : 7 * DAY;
      const rows = [];
      for (let start = from; start < to; start += size) rows.push({ from: start, to: start + size, ...perBucket(start) });
      return rows;
    };
  }
  return { api, calls };
}

test("periods use Korean dates and Monday weeks", () => {
  assert.equal(startOfDay(NOW), kst("2026-11-05T00:00:00"));
  assert.equal(startOfWeek(NOW), kst("2026-11-02T00:00:00")); // 월요일
  assert.equal(startOfWeek(kst("2026-11-08T23:59:59")), kst("2026-11-02T00:00:00")); // 일요일 밤도 같은 주
  const days = recentBuckets("day", 3, NOW);
  assert.deepEqual(days, [
    { from: kst("2026-11-03T00:00:00"), to: kst("2026-11-04T00:00:00") },
    { from: kst("2026-11-04T00:00:00"), to: kst("2026-11-05T00:00:00") },
    { from: kst("2026-11-05T00:00:00"), to: kst("2026-11-06T00:00:00") },
  ]);
});

test("daily overview asks the server once for 14 days and charts the last 7", async () => {
  const today = startOfDay(NOW);
  const { api, calls } = fakeApi({ perBucket: (from) => (from === today ? stats(5000, 1500) : from === today - 8 * DAY ? stats(2000, 720) : stats(0, 0)) });
  const view = await fetchRecordOverview(api, "day", NOW);

  assert.deepEqual(calls.filter((c) => c[0] === "myStatsSeries"), [["myStatsSeries", today - 13 * DAY, today + DAY, "day"]]);
  assert.equal(calls.filter((c) => c[0] === "myStats").length, 1); // 누적 합계 한 번뿐
  assert.equal(view.total.distance, 42000);
  assert.equal(view.series.length, 7);
  assert.equal(view.series[6].from, today);
  assert.equal(view.series[6].distance, 5000);
  // 비교: 최근 7일(5km) vs 그 전 7일(2km)
  const change = compareLast(view.periods);
  assert.equal(change.previous.distance, 2000);
  assert.equal(change.current.distance, 5000);
  assert.equal(change.diff, 3000);
  assert.equal(change.ratio, 1.5);
});

test("weekly overview is one series request instead of one request per week", async () => {
  const { api, calls } = fakeApi();
  const view = await fetchRecordOverview(api, "week", NOW);
  const week = startOfWeek(NOW);
  assert.deepEqual(calls.filter((c) => c[0] === "myStatsSeries"), [["myStatsSeries", week - 7 * 7 * DAY, week + 7 * DAY, "week"]]);
  assert.equal(calls.length, 2);
  assert.equal(view.series.length, 8);
  assert.equal(view.periods, view.series);
});

test("older servers without the series API still work through /api/me/stats", async () => {
  const { api, calls } = fakeApi({ seriesStatus: 404 });
  const view = await fetchRecordOverview(api, "week", NOW);
  assert.equal(view.series.length, 8);
  assert.equal(calls.filter((c) => c[0] === "myStats").length, 1 + 8);
});

test("other series errors are shown instead of silently retried", async () => {
  const { api } = fakeApi({ seriesStatus: 401 });
  await assert.rejects(fetchRecordOverview(api, "day", NOW), (error) => error.status === 401);
});

test("monthly overview keeps per-month requests (months differ in length)", async () => {
  const { api, calls } = fakeApi();
  const view = await fetchRecordOverview(api, "month", NOW);
  assert.equal(calls.filter((c) => c[0] === "myStatsSeries").length, 0);
  assert.equal(view.series.length, 6);
  assert.equal(view.series[5].from, kst("2026-11-01T00:00:00"));
});

test("combined pace is total time / total distance, not an average of paces", () => {
  const fast = { from: 0, to: 1, distance: 10000, seconds: 3000, count: 1, flagged: 0 }; // 5'00"/km
  const slow = { from: 1, to: 2, distance: 1000, seconds: 600, count: 1, flagged: 1 }; // 10'00"/km
  const both = combineBuckets([fast, slow]);
  assert.equal(both.distance, 11000);
  assert.equal(both.count, 2);
  assert.equal(both.flagged, 1);
  assert.equal(both.pace, (3600 * 1000) / 11000); // 327초, 단순 평균(450초)이 아니다
  assert.equal(combineBuckets([{ from: 0, to: 1, distance: 0, seconds: 0, count: 1, flagged: 0 }]).pace, null);
});

test("no change ratio when the previous period is 0 km", () => {
  const change = compareLast([{ distance: 0 }, { distance: 3000 }]);
  assert.equal(change.ratio, null);
  assert.equal(change.diff, null);
});
