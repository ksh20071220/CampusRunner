import { useState } from "react";
import { useApp, useAuthErrorGuard, useSaverState, useTrackerSnapshot } from "../state/AppContext.jsx";
import { useAsync } from "../lib/hooks.js";
import { namedPeriod, nowSeconds, MAX_SERVER_TIME } from "../lib/periods.js";
import { km } from "../lib/format.js";
import { apiMessage, gpsMessage, normalizeApiError, VERIFICATION_LABEL } from "../lib/messages.js";
import { navigate } from "../lib/router.js";
import { discardRun, finishRun, startRun } from "../services/run-actions.js";
import { Badge, ModeBadge, Notice, Spinner, TopBar } from "../components/ui.jsx";

export default function Home() {
  const app = useApp();
  const { api, user, logout, dataVersion, trackerError } = app;
  const snapshot = useTrackerSnapshot();
  const saverState = useSaverState();
  const [startMessage, setStartMessage] = useState("");

  const { data, error, loading, reload } = useAsync(async () => {
    const now = nowSeconds();
    const week = namedPeriod("week", now);
    const [total, thisWeek, campus] = await Promise.all([
      api.myStats(0, Math.min(now + 86400, MAX_SERVER_TIME)),
      api.myStats(week.from, week.to),
      api.universityStats(user.university_id, week.from, week.to),
    ]);
    return { total, thisWeek, campus };
  }, [api, user.university_id, dataVersion]);

  useAuthErrorGuard(error);

  const verification = VERIFICATION_LABEL[user.verification_status] || VERIFICATION_LABEL.not_submitted;
  const verified = user.university_verified || user.verification_status === "approved";

  const onStart = () => {
    setStartMessage("");
    const result = startRun(app);
    if (result.reason === "pending_save") setStartMessage("저장하지 않은 러닝을 먼저 처리해 주세요.");
    if (result.reason === "tracker_unavailable") setStartMessage(gpsMessage(trackerError));
  };

  return (
    <div className="screen">
      <TopBar
        right={
          <div className="topbar__actions">
            <ModeBadge />
            <button type="button" className="text-button" onClick={logout}>
              로그아웃
            </button>
          </div>
        }
      />

      <section className="profile">
        <span className="avatar" aria-hidden="true">
          {user.nickname.slice(0, 1)}
        </span>
        <div className="profile__text">
          <strong>{user.nickname}</strong>
          <span>{user.university_name}</span>
        </div>
        <Badge tone={verification.tone}>{verification.text}</Badge>
      </section>

      <RecoveryBanner app={app} snapshot={snapshot} saverState={saverState} />

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
          <section className="card total-card">
            <span className="card__label">누적 거리</span>
            <div className="hero-number">
              {km(data.total.distance_m)}
              <small>km</small>
            </div>
            <div className="total-card__row">
              <span>
                러닝 <b>{data.total.accepted_runs}</b>회
              </span>
              <span>
                이번 주 <b>{km(data.thisWeek.distance_m)}</b>km
              </span>
              {data.total.flagged_runs > 0 && (
                <span className="muted">의심 기록 {data.total.flagged_runs}회 제외</span>
              )}
            </div>
          </section>

          <button type="button" className="card campus-card" onClick={() => navigate("/rankings")}>
            <div className="campus-card__head">
              <span className="card__label">이번 주 {user.university_name}</span>
              <span className="chevron" aria-hidden="true">›</span>
            </div>
            <div className="campus-card__body">
              <div>
                <span className="rank-number">
                  {data.campus.participants > 0 ? data.campus.rank : "-"}
                  <small>위</small>
                </span>
              </div>
              <dl>
                <div>
                  <dt>1인당 평균</dt>
                  <dd>{km(data.campus.average_distance_m)} km</dd>
                </div>
                <div>
                  <dt>참가자</dt>
                  <dd>{data.campus.participants}명</dd>
                </div>
              </dl>
            </div>
            {!verified && <p className="campus-card__note">학교 인증이 승인되면 내 기록도 학교 점수에 들어가요.</p>}
          </button>
        </>
      )}

      <div className="home-actions">
        {startMessage && <p className="form-error">{startMessage}</p>}
        {snapshot.status === "running" || snapshot.status === "starting" ? (
          <button type="button" className="btn btn--primary btn--xl" onClick={() => navigate("/run")}>
            진행 중인 러닝 보기
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--xl" onClick={onStart} disabled={Boolean(saverState.pending)}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 5v14l11-7L8 5Z" fill="currentColor" />
            </svg>
            러닝 시작
          </button>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn--outline" onClick={() => navigate("/records")}>
            개인 기록
          </button>
          <button type="button" className="btn btn--outline" onClick={() => navigate("/rankings")}>
            대학 순위
          </button>
        </div>
      </div>
    </div>
  );
}

/** 저장 대기 중이거나, 새로고침 등으로 측정이 끊긴 러닝 안내 */
function RecoveryBanner({ app, snapshot, saverState }) {
  if (saverState.pending) {
    return (
      <Notice
        tone="warn"
        title="저장하지 못한 러닝이 있어요"
        action={
          <button type="button" className="btn btn--dark btn--small" onClick={() => navigate("/result")}>
            저장하기
          </button>
        }
      >
        같은 기록으로 다시 보내서 중복 없이 저장해요.
      </Notice>
    );
  }
  if (snapshot.status === "recovered") {
    return (
      <div className="notice notice--warn notice--stack">
        <div>
          <strong>측정이 중간에 끊긴 러닝이 있어요</strong>
          <p>
            {km(snapshot.distanceMeters)}km · 좌표 {snapshot.pointCount}개가 이 기기에 남아 있어요.
          </p>
        </div>
        <div className="btn-row btn-row--tight">
          <button type="button" className="btn btn--dark btn--small" onClick={() => startRun(app)}>
            이어 달리기
          </button>
          {snapshot.pointCount >= 2 && (
            <button type="button" className="btn btn--outline btn--small" onClick={() => finishRun(app)}>
              종료하고 저장
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => window.confirm("이 러닝을 삭제할까요? 되돌릴 수 없어요.") && discardRun(app)}
          >
            삭제
          </button>
        </div>
      </div>
    );
  }
  return null;
}
