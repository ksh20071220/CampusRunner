import { useMemo, useState } from "react";
import { useApp, useAuthErrorGuard } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { dateTime, duration, km, monthLabel, pace, shortDate } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { compareLast, fetchAllRuns, periodSeries, summarize } from "../services/records.js";
import BarChart from "../components/BarChart.jsx";
import { Badge, Empty, Notice, Spinner, SubHeader } from "../components/ui.jsx";

const VISIBLE_STEP = 20;

export default function Records() {
  const { api, dataVersion } = useApp();
  const [kind, setKind] = useState("week");
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const { data: runs, error, loading, reload } = useAsync(() => fetchAllRuns(api), [api, dataVersion]);
  useAuthErrorGuard(error);

  const total = useMemo(() => (runs ? summarize(runs) : null), [runs]);
  const series = useMemo(() => (runs ? periodSeries(runs, kind, kind === "week" ? 8 : 6) : []), [runs, kind]);
  const comparison = useMemo(() => compareLast(series), [series]);

  return (
    <div className="screen">
      <SubHeader title="내 러닝 기록" back="/home" backLabel="홈" />
      {loading && !runs && <Spinner />}
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

      {runs && runs.length === 0 && (
        <Empty
          title="아직 기록이 없어요"
          action={
            <button type="button" className="btn btn--primary" onClick={() => navigate("/run")}>
              첫 러닝 시작하기
            </button>
          }
        >
          달리고 저장하면 여기에 쌓여요.
        </Empty>
      )}

      {runs && runs.length > 0 && (
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

          <section>
            <h2 className="section-title">과거 기록 {runs.length}개</h2>
            <ul className="run-list">
              {runs.slice(0, visible).map((run) => (
                <li key={run.id}>
                  <a href={`#/records/${run.id}`} className="run-item">
                    <div className="run-item__main">
                      <span className="run-item__date">{dateTime(run.started_at)}</span>
                      <span className="run-item__meta">
                        {duration(run.duration_seconds)} · {pace(run.pace_seconds_per_km)}/km
                        {!run.accepted && <Badge tone="bad">의심</Badge>}
                      </span>
                    </div>
                    <span className={`run-item__distance ${run.accepted ? "" : "is-flagged"}`}>
                      {km(run.distance_m)}
                      <small>km</small>
                    </span>
                    <span className="chevron" aria-hidden="true">›</span>
                  </a>
                </li>
              ))}
            </ul>
            {visible < runs.length && (
              <button type="button" className="btn btn--outline btn--block" onClick={() => setVisible((v) => v + VISIBLE_STEP)}>
                더 보기 ({runs.length - visible}개 남음)
              </button>
            )}
          </section>
        </>
      )}
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
