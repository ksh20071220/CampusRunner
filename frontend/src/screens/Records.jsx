import { useMemo, useState } from "react";
import { useApp, useAuthErrorGuard } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { km, monthLabel, pace, shortDate } from "../lib/format.js";
import { compareLast, fetchRecordOverview } from "../services/records.js";
import RecordHistory from "../components/RecordHistory.jsx";
import BarChart from "../components/BarChart.jsx";
import { Notice, Spinner, SubHeader } from "../components/ui.jsx";

export default function Records() {
  const { api, dataVersion } = useApp();
  const [kind, setKind] = useState("week");
  const { data, error, loading, reload } = useAsync(() => fetchRecordOverview(api, kind), [api, dataVersion, kind]);
  useAuthErrorGuard(error);
  const total = data?.total;
  const series = data?.series || [];
  const comparison = useMemo(() => compareLast(series), [series]);

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
              <h2>{kind === "week" ? "주간" : "월간"} 거리 변화</h2>
              <div className="segmented segmented--small" role="tablist">
                <button type="button" role="tab" aria-selected={kind === "week"} onClick={() => setKind("week")}>
                  주간
                </button>
                <button type="button" role="tab" aria-selected={kind === "month"} onClick={() => setKind("month")}>
                  월간
                </button>
              </div>
            </div>
            <ChangeLine comparison={comparison} kind={kind} />
            <BarChart
              key={kind}
              caption={`${kind === "week" ? "최근 8주" : "최근 6개월"} 정상 기록 거리`}
              formatValue={(m) => `${km(m, 1)}km`}
              data={series.map((s, i) => ({
                key: s.from,
                label: kind === "week" ? (i === series.length - 1 ? "이번 주" : shortDate(s.from)) : monthLabel(s.from),
                fullLabel: kind === "week" ? `${shortDate(s.from)} 주` : monthLabel(s.from),
                value: s.distance,
              }))}
            />
            <dl className="mini-stats">
              <div>
                <dt>{kind === "week" ? "이번 주" : "이번 달"} 러닝</dt>
                <dd>{comparison.current.count}회</dd>
              </div>
              <div>
                <dt>평균 페이스</dt>
                <dd>{pace(comparison.current.pace)}</dd>
              </div>
              <div>
                <dt>{kind === "week" ? "지난주" : "지난달"} 페이스</dt>
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

function ChangeLine({ comparison, kind }) {
  if (!comparison) return null;
  const prevName = kind === "week" ? "지난주" : "지난달";
  const curName = kind === "week" ? "이번 주" : "이번 달";
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
