import { useMemo, useState } from "react";
import { useApp, useSaverState, useTrackerSnapshot } from "../state/AppContext.jsx";
import { useHiddenNotice, useLeaveGuard, useWakeLock } from "../lib/hooks.js";
import { duration, kmh, km, pace, paceFrom } from "../lib/format.js";
import { gpsMessage } from "../lib/messages.js";
import { navigate } from "../lib/router.js";
import { discardRun, finishRun, startRun } from "../services/run-actions.js";
import StorageNotice from "../components/StorageNotice.jsx";
import RouteMap from "../components/RouteMap.jsx";
import { Badge, Notice, Stat, SubHeader } from "../components/ui.jsx";

export default function Run() {
  const app = useApp();
  const { tracker, trackerError } = app;
  const snapshot = useTrackerSnapshot();
  const saverState = useSaverState();
  const [confirming, setConfirming] = useState(false);
  const [stopProblem, setStopProblem] = useState(null);
  const [startProblem, setStartProblem] = useState("");

  const { status } = snapshot;
  const active = status === "running" || status === "starting";
  const wake = useWakeLock(active);
  useLeaveGuard(active);
  const [hiddenFor, clearHidden] = useHiddenNotice(status === "running");

  // 저장까지 끝난 이전 러닝은 새 러닝 준비 화면에서 보여주지 않는다.
  const showCurrent =
    active || status === "recovered" || status === "error" || Boolean(stopProblem) || (status === "stopped" && Boolean(saverState.pending));

  // 좌표가 늘어날 때만 배열을 새로 받아 지도에 넘긴다 (매초 시간 갱신 때는 재사용).
  const points = useMemo(
    () => (tracker && showCurrent ? tracker.getPoints() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracker, snapshot.pointCount, showCurrent],
  );

  const distance = showCurrent ? snapshot.distanceMeters : 0;
  const elapsed = showCurrent ? snapshot.elapsedSeconds : 0;
  const speed = elapsed > 0 ? distance / elapsed : 0;
  const livePace = paceFrom(distance, elapsed);

  const onStart = () => {
    setStopProblem(null);
    setStartProblem("");
    const result = startRun(app);
    if (result.reason === "pending_save") setStartProblem("저장하지 않은 러닝이 있어요. 먼저 저장하거나 삭제해 주세요.");
  };

  const onFinish = () => {
    setConfirming(false);
    const stopped = finishRun(app);
    if (!stopped.canSubmit) setStopProblem(stopped);
  };

  const onDiscard = () => {
    if (!window.confirm("이 러닝을 저장하지 않고 삭제할까요?")) return;
    setStopProblem(null);
    discardRun(app);
  };

  if (!tracker) {
    return (
      <div className="screen">
        <SubHeader title="러닝" />
        <Notice tone="bad" title="GPS 사용 불가">
          {gpsMessage(trackerError)}
        </Notice>
      </div>
    );
  }

  return (
    <div className={`screen screen--run ${active ? "is-active" : ""}`}>
      <SubHeader
        title={active ? "러닝 중" : "러닝"}
        back="/home"
        backLabel="홈"
        right={<GpsBadge snapshot={snapshot} />}
      />

      {trackerError?.code === "insecure_context" && (
        <Notice tone="bad" title="HTTPS 주소 필요">
          {gpsMessage(trackerError)}
        </Notice>
      )}

      <StorageNotice state={saverState} />
      <RouteMap
        points={points}
        live={active}
        className="route-map--run"
        emptyText={status === "starting" ? "위치 찾는 중…" : "시작 후 경로 표시"}
      />

      <div className="stat-grid">
        <Stat label="거리" value={km(distance)} unit="km" big />
        <Stat label="시간" value={duration(elapsed, { alwaysHours: true })} big />
        <Stat label="평균 속도" value={kmh(speed)} unit="km/h" />
        <Stat label="평균 페이스" value={pace(livePace)} unit="/km" />
      </div>
      {active && <p className="hint center">임시 값 · 저장 후 최종 기록 확정</p>}

      {snapshot.error && active && (
        <Notice tone="warn">{gpsMessage(snapshot.error)}</Notice>
      )}
      {hiddenFor > 0 && (
        <Notice
          tone="warn"
          title={`화면 꺼짐 ${hiddenFor}초`}
          action={
            <button type="button" className="btn btn--ghost btn--small" onClick={clearHidden}>
              확인
            </button>
          }
        >
          화면이 꺼지면 위치 기록 중단 가능 · 2분 이상 끊기면 비정상 기록
        </Notice>
      )}
      {active && wake.supported && !wake.held && (
        <p className="hint center">화면 꺼짐 방지 미지원 · 화면을 켠 채 러닝 권장</p>
      )}

      {status === "error" && (
        <Notice tone="bad" title="측정 중단">
          {gpsMessage(snapshot.error)}
        </Notice>
      )}
      {stopProblem && (
        <Notice tone="warn" title="저장 불가">
          이동 거리 부족
        </Notice>
      )}
      {startProblem && <p className="form-error">{startProblem}</p>}

      <div className="run-actions">
        {active && (
          <button type="button" className="btn btn--dark btn--xl" onClick={() => setConfirming(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
            러닝 종료
          </button>
        )}

        {(status === "idle" || (status === "stopped" && !stopProblem && !saverState.pending)) && (
          <button type="button" className="btn btn--primary btn--xl" onClick={onStart}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 5v14l11-7L8 5Z" fill="currentColor" />
            </svg>
            {status === "stopped" ? "새 러닝 시작" : "러닝 시작"}
          </button>
        )}

        {status === "recovered" && (
          <div className="stack">
            <Notice tone="warn" title="중단된 러닝">
              이어 달리기 또는 저장 가능
            </Notice>
            <button type="button" className="btn btn--primary btn--xl" onClick={onStart}>
              이어 달리기
            </button>
            <div className="btn-row">
              <button type="button" className="btn btn--outline" onClick={onFinish} disabled={snapshot.pointCount < 2}>
                종료하고 저장
              </button>
              <button type="button" className="btn btn--ghost" onClick={onDiscard}>
                삭제
              </button>
            </div>
          </div>
        )}

        {(status === "error" || stopProblem) && (
          <div className="btn-row">
            {snapshot.pointCount >= 2 && status === "error" ? (
              <button type="button" className="btn btn--primary" onClick={onFinish}>
                지금까지 기록 저장
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={onStart}>
                다시 시작
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={onDiscard}>
              삭제
            </button>
          </div>
        )}

        {status === "stopped" && saverState.pending && (
          <button type="button" className="btn btn--dark btn--xl" onClick={() => navigate("/result")}>
            저장 상태 보기
          </button>
        )}
      </div>

      {confirming && (
        <div className="sheet-backdrop" role="presentation" onClick={() => setConfirming(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="stop-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="stop-title">러닝을 종료할까요?</h2>
            <p className="muted">
              {km(snapshot.distanceMeters)}km · {duration(snapshot.elapsedSeconds)} 기록 저장
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn--outline" onClick={() => setConfirming(false)}>
                계속 달리기
              </button>
              <button type="button" className="btn btn--dark" onClick={onFinish}>
                종료하고 저장
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GpsBadge({ snapshot }) {
  const { status, error, lastAccuracyMeters } = snapshot;
  if (status === "starting") return <Badge tone="warn">위치 찾는 중</Badge>;
  if (status === "running" && error) return <Badge tone="warn">GPS 신호 약함</Badge>;
  if (status === "running") {
    return (
      <Badge tone="ok">
        <span className="pulse" aria-hidden="true" />
        GPS 수신 중{Number.isFinite(lastAccuracyMeters) ? ` ±${Math.round(lastAccuracyMeters)}m` : ""}
      </Badge>
    );
  }
  if (status === "error") return <Badge tone="bad">GPS 오류</Badge>;
  return null;
}
