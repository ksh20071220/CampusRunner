import { useApp, useAuthErrorGuard } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { apiMessage, normalizeApiError } from "../lib/messages.js";
import { dateTime } from "../lib/format.js";
import RouteMap from "../components/RouteMap.jsx";
import { AcceptBadge, RunStats, UniversityNote } from "../components/RunSummary.jsx";
import { Notice, Spinner, SubHeader } from "../components/ui.jsx";

export default function RecordDetail({ id }) {
  const { api, user } = useApp();
  const { data: run, error, loading, reload } = useAsync(() => api.myRun(id), [api, id]);
  useAuthErrorGuard(error);

  return (
    <div className="screen">
      <SubHeader title="기록 상세" back="/records" backLabel="기록" right={run ? <AcceptBadge run={run} /> : null} />
      {loading && !run && <Spinner />}
      {error && (
        <Notice
          tone="bad"
          title="기록 불러오기 실패"
          action={
            normalizeApiError(error).status !== 404 && (
              <button type="button" className="btn btn--ghost btn--small" onClick={reload}>
                다시 시도
              </button>
            )
          }
        >
          {apiMessage(normalizeApiError(error))}
        </Notice>
      )}
      {run && (
        <>
          <p className="lead">{dateTime(run.started_at)}</p>
          <RouteMap points={run.points} />
          <RunStats run={run} />
          <UniversityNote run={run} verified={user.university_verified} />
          <p className="hint">GPS 좌표 {run.points.length.toLocaleString()}개 · 판정 기준 버전 {run.policy_version}</p>
        </>
      )}
    </div>
  );
}
