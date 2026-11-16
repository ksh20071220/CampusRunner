import { useMemo, useState } from "react";
import { useApp, useAuthErrorGuard } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { km, monthLabel, pace, shortDate, weekdayLabel } from "../lib/format.js";
import { compareLast, fetchRecordOverview } from "../services/records.js";
import RecordHistory from "../components/RecordHistory.jsx";
import BarChart from "../components/BarChart.jsx";
import { Notice, Spinner, SubHeader } from "../components/ui.jsx";

// 탭별 문구. day는 최근 7일과 그 전 7일을 비교한다.
const KINDS = {
  day: { tab: "일간", title: "일간", caption: "최근 7일", current: "최근 7일", previous: "그 전 7일" },
  week: { tab: "주간", title: "주간", caption: "최근 8주", current: "이번 주", previous: "지난주" },
  month: { tab: "월간", title: "월간", caption: "최근 6개월", current: "이번 달", previous: "지난달" },
};

function barLabels(kind, s, i, last) {
  if (kind === "day") return { label: i === last ? "오늘" : weekdayLabel(s.from), fullLabel: shortDate(s.from) };
  if (kind === "week") return { label: i === last ? "이번 주" : shortDate(s.from), fullLabel: `${shortDate(s.from)} 주` };
  return { label: monthLabel(s.from), fullLabel: monthLabel(s.from) };
}

export default function Records() {
  const { api, dataVersion } = useApp();
  const [kind, setKind] = useState("week");
  const { data, error, loading, reload } = useAsync(() => fetchRecordOverview(api, kind), [api, dataVersion, kind]);
  useAuthErrorGuard(error);
  const total = data?.total;
  const series = data?.series || [];
  const periods = data?.periods;
  const comparison = useMemo(() => (periods ? compareLast(periods) : null), [periods]);
  const names = KINDS[kind];

  return (
    <div className="screen">
      <SubHeader title="내 러닝 기록" back="/home" backLabel="홈" />
      {loading && !data && <Spinner />}
      {error && (
        <Notice
          tone="bad"
          title="기록을 불러오지 못했어요"
          action={
            <button type="button" className="btn btn--ghost btn--small" onClick={reload}>
              다시 시도
            </button>
          }
        >
          {apiMessage(normalizeApiError(error))}
        </Notice>
      )}

      {data && (
        <>
          <p className="lead">
            누적 <b>{km(total.distance, 1)}km</b> · {total.count}회 · 평균 페이스 <b>{pace(total.pace)}</b>
          </p>

          <section className="card">
            <div className="card__head">
              <h2>{names.title} 거리 변화</h2>
              <div className="segmented segmented--small" role="tablist">
                {Object.entries(KINDS).map(([value, k]) => (
                  <button key={value} type="button" role="tab" aria-selected={kind === value} onClick={() => setKind(value)}>
                    {k.tab}
                  </button>
                ))}
              </div>
            </div>
            <ChangeLine comparison={comparison} names={names} />
            <BarChart
              key={kind}
              caption={`${names.caption} 정상 기록 거리`}
              formatValue={(m) => `${km(m, 1)}km`}
              data={series.map((s, i) => ({
                key: s.from,
                ...barLabels(kind, s, i, series.length - 1),
                value: s.distance,
              }))}
            />
            <dl className="mini-stats">
              <div>
                <dt>{names.current} 러닝</dt>
                <dd>{comparison.current.count}회</dd>
              </div>
              <div>
                <dt>평균 페이스</dt>
                <dd>{pace(comparison.current.pace)}</dd>
              </div>
              <div>
                <dt>{names.previous} 페이스</dt>
                <dd>{pace(comparison.previous?.pace ?? null)}</dd>
              </div>
            </dl>
          </section>


        </>
      )}
      <RecordHistory />
    </div>
  );
}

function ChangeLine({ comparison, names }) {
  if (!comparison) return null;
  const prevName = names.previous;
  const curName = names.current;
  if (comparison.ratio === null) {
    return (
      <p className="change">
        {curName} <b>{km(comparison.current.distance, 1)}km</b>
        <span className="muted"> · {prevName} 기록 없음</span>
      </p>
    );
  }
  const up = comparison.diff >= 0;
  return (
    <p className="change">
      {curName} <b>{km(comparison.current.distance, 1)}km</b>
      <span className={up ? "change__up" : "change__down"}>
        {" "}
        {prevName}보다 {km(Math.abs(comparison.diff), 1)}km {up ? "더" : "덜"} ({up ? "+" : "−"}
        {Math.abs(Math.round(comparison.ratio * 100))}%)
      </span>
    </p>
  );
}
