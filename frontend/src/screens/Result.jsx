import { useEffect, useMemo, useState } from "react";
import { useApp, useSaverState } from "../state/AppContext.jsx";
import { apiMessage } from "../lib/messages.js";
import { duration, km } from "../lib/format.js";
import { previewOf } from "../lib/geo.js";
import { navigate } from "../lib/router.js";
import { discardRun } from "../services/run-actions.js";
import StorageNotice from "../components/StorageNotice.jsx";
import RouteMap from "../components/RouteMap.jsx";
import { AcceptBadge, RunStats, UniversityNote } from "../components/RunSummary.jsx";
import { Badge, Empty, Notice, Stat, SubHeader } from "../components/ui.jsx";

// 러닝 결과: 저장 중 → (실패 시 자동 재시도 / 수동 재시도) → 서버 확정 기록 표시

export default function Result() {
  const app = useApp();
  const { api, tracker, saver, user, handleAuthError } = app;
  const state = useSaverState();
  const { phase, pending, result, error } = state;
  const [routePoints, setRoutePoints] = useState(null);

  // 로그인이 만료되면 로그인 화면으로. 로그인 후 같은 key로 자동 재전송된다.
  useEffect(() => {
    if (phase === "needs_login") handleAuthError({ status: 401 });
  }, [phase, handleAuthError]);

  // 결과 화면을 떠나면 "저장 완료" 표시를 정리한다.
  useEffect(() => () => saver.acknowledge(), [saver]);

  // 저장된 결과의 경로: 방금 측정한 좌표가 메모리에 있으면 그대로, 새로고침 뒤라면 서버에서 다시 받는다.
  useEffect(() => {
    if (!result) return;
    const local = tracker?.getPoints() || [];
    if (local.length && local[0].timestamp === result.started_at) {
      setRoutePoints(local);
      return;
    }
    let alive = true;
    api
      .myRun(result.id)
      .then((run) => alive && setRoutePoints(run.points))
      .catch(() => alive && setRoutePoints([]));
    return () => {
      alive = false;
    };
  }, [api, tracker, result]);

  const preview = useMemo(() => previewOf(pending?.points), [pending]);

  if (pending) {
    return (
      <div className="screen">
        <SubHeader title="러닝 결과" back="/home" backLabel="홈" right={<SaveBadge state={state} />} />
        <StorageNotice state={state} />
        <RouteMap points={pending.points} />
        <div className="stat-grid">
          <Stat label="거리 (미리보기)" value={km(preview.distance)} unit="km" big />
          <Stat label="시간 (미리보기)" value={duration(preview.seconds, { alwaysHours: true })} big />
        </div>
        <SaveStatus state={state} onRetry={() => saver.retryNow()} onDiscard={() => {
          if (window.confirm("이 러닝을 저장하지 않고 삭제할까요? 되돌릴 수 없어요.")) {
            if (discardRun(app)) navigate("/home");
          }
        }} />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="screen">
        <SubHeader title="러닝 결과" back="/home" backLabel="홈" />
        <StorageNotice state={state} />
        {phase === "saved" && error?.message === "duplicate_run" ? (
          <Empty
            title="이미 저장된 러닝이에요"
            action={
              <button type="button" className="btn btn--primary" onClick={() => navigate("/records")}>
                기록 보러 가기
              </button>
            }
          >
            같은 좌표의 기록이 이미 서버에 있어서 중복 저장하지 않았어요.
          </Empty>
        ) : (
          <Empty
            title="최근 러닝 결과가 없어요"
            action={
              <button type="button" className="btn btn--primary" onClick={() => navigate("/run")}>
                러닝 하러 가기
              </button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="screen">
      <SubHeader title="러닝 결과" back="/home" backLabel="홈" right={<AcceptBadge run={result} />} />
      <RouteMap points={routePoints || []} emptyText={routePoints ? "경로를 불러오지 못했어요" : "경로 불러오는 중…"} />
      <StorageNotice state={state} />
      <RunStats run={result} />
      <UniversityNote run={result} verified={user.university_verified} />
      <div className="run-actions">
        <button type="button" className="btn btn--primary btn--xl" onClick={() => navigate(`/records/${result.id}`)}>
          기록 상세 보기
        </button>
        <button type="button" className="text-button center" onClick={() => navigate("/home")}>
          홈으로
        </button>
      </div>
    </div>
  );
}

function SaveBadge({ state }) {
  if (state.phase === "saving") return <Badge tone="warn">저장 중</Badge>;
  if (state.phase === "retrying") return <Badge tone="warn">다시 시도 중</Badge>;
  if (state.phase === "needs_login") return <Badge tone="warn">로그인 필요</Badge>;
  if (state.phase === "failed") return <Badge tone="bad">저장 실패</Badge>;
  return <Badge tone="muted">저장 대기</Badge>;
}

function SaveStatus({ state, onRetry, onDiscard }) {
  const { phase, error, attempt, nextRetryAt, retryable } = state;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "retrying" && !(error?.status === 429 && nextRetryAt > Date.now())) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [phase, error, nextRetryAt]);

  if (phase === "saving" || phase === "idle") {
    return (
      <Notice tone="info" title="서버에 저장하고 있어요">
        거리·시간·페이스는 서버가 다시 계산해서 최종 기록으로 저장해요.
      </Notice>
    );
  }
  if (phase === "retrying") {
    const seconds = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
    return (
      <Notice
        tone="warn"
        title={`저장에 실패해서 ${seconds}초 뒤 다시 보내요 (${attempt}/3)`}
        action={
          <button type="button" className="btn btn--dark btn--small" onClick={onRetry} disabled={error?.status === 429 && seconds > 0}>
            지금 재시도
          </button>
        }
      >
        {apiMessage(error)} 같은 기록으로 다시 보내므로 두 번 저장되지 않아요.
      </Notice>
    );
  }
  return (
    <div className="stack">
      <Notice tone="bad" title="저장하지 못했어요">
        {apiMessage(error)}
        {retryable && state.pendingPersisted ? " 기록은 이 기기에 보관돼 있어요. 연결되면 다시 시도해 주세요." : ""}
      </Notice>
      <div className="btn-row">
        <button type="button" className="btn btn--primary" onClick={onRetry} disabled={error?.status === 429 && nextRetryAt > now}>
          {error?.status === 429 && nextRetryAt > now ? `${Math.ceil((nextRetryAt - now) / 1000)}초 뒤 재시도` : "다시 시도"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDiscard}>
          삭제
        </button>
      </div>
    </div>
  );
}
