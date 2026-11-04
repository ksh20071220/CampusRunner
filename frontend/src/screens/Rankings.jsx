import { useState } from "react";
import { useApp } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { km } from "../lib/format.js";
import { namedPeriod } from "../lib/periods.js";
import { Empty, Notice, Spinner, SubHeader } from "../components/ui.jsx";

// 대학 순위: 같은 from/to로 전체 순위와 내 대학 성적을 함께 조회한다.
// 서버가 정한 rank를 그대로 쓰고, 화면에서 반올림한 값으로 다시 순위를 매기지 않는다.

const PERIODS = [
  { id: "week", label: "이번 주" },
  { id: "month", label: "이번 달" },
  { id: "all", label: "전체" },
];
const PAGE = 100;

export default function Rankings() {
  const { api, user, dataVersion } = useApp();
  const [periodId, setPeriodId] = useState("week");
  const [limit, setLimit] = useState(PAGE);
  const period = namedPeriod(periodId);

  const { data, error, loading, reload } = useAsync(async () => {
    const [rows, mine] = await Promise.all([
      api.rankings(period.from, period.to, limit, 0),
      api.universityStats(user.university_id, period.from, period.to),
    ]);
    return { rows, mine };
  }, [api, periodId, limit, user.university_id, dataVersion]);

  const active = data?.rows.filter((row) => row.participants > 0) || [];
  const hasMore = data && data.rows.length === limit && active.length === data.rows.length;

  return (
    <div className="screen">
      <SubHeader title="대학 챌린지" back="/home" backLabel="홈" />
      <p className="lead">1인당 평균 거리 기준 순위</p>

      <div className="segmented" role="tablist">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={periodId === p.id}
            onClick={() => {
              setPeriodId(p.id);
              setLimit(PAGE);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && !data && <Spinner />}
      {error && (
        <Notice
          tone="bad"
          title="순위 불러오기 실패"
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
          <section className="card my-school">
            <span className="card__label">
              내 대학 · {period.label}
            </span>
            <div className="my-school__row">
              <strong>{data.mine.university_name}</strong>
              <span className="rank-number">
                {data.mine.participants > 0 ? data.mine.rank : "-"}
                <small>위</small>
              </span>
            </div>
            <dl className="mini-stats">
              <div>
                <dt>1인당 평균</dt>
                <dd>{km(data.mine.average_distance_m)}km</dd>
              </div>
              <div>
                <dt>참가자</dt>
                <dd>{data.mine.participants}명</dd>
              </div>
              <div>
                <dt>총 거리</dt>
                <dd>{km(data.mine.distance_m)}km</dd>
              </div>
            </dl>
            <p className="badge-line">
              <span className="badge badge--ok">✓ 학교 인증 회원의 정상 기록만 반영</span>
            </p>
          </section>

          {active.length === 0 ? (
            <Empty title={`${period.label} 참가 학교 없음`} />
          ) : (
            <ol className="rank-list">
              {active.map((row) => (
                <li key={row.university_id} className={row.university_id === user.university_id ? "is-mine" : ""}>
                  <span className={`rank-pill ${row.rank <= 3 ? "is-top" : ""}`}>{row.rank}</span>
                  <span className="rank-list__name">
                    {row.university_name}
                    <small>
                      {row.participants}명 · {row.runs}회
                    </small>
                  </span>
                  <span className="rank-list__value">
                    {km(row.average_distance_m)}
                    <small>km</small>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {hasMore && (
            <button type="button" className="btn btn--outline btn--block" onClick={() => setLimit((l) => Math.min(l + PAGE, 500))}>
              더 보기
            </button>
          )}
          {data.rows.length > active.length && (
            <p className="hint center">참가 기록 없는 학교 제외</p>
          )}
        </>
      )}
    </div>
  );
}
