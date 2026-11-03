import { navigate } from "../lib/router.js";

// 여러 화면(홈·러닝·결과)에서 같은 방식으로 러닝을 시작/종료/폐기하기 위한 공통 동작.

/** 러닝 시작. 저장 안 된 이전 러닝이 있으면 덮어쓰지 않도록 막는다. */
export function startRun({ tracker, saver }) {
  if (!tracker) return { ok: false, reason: "tracker_unavailable" };
  if (saver.getState().pending) return { ok: false, reason: "pending_save" };
  const status = tracker.getSnapshot().status;
  if (status === "running" || status === "starting") {
    navigate("/run");
    return { ok: true };
  }
  navigate("/run");
  // 실패(권한 거부 등)는 tracker 상태(error)로 화면에 표시되므로 여기서는 삼키기만 한다.
  tracker.start().catch(() => {});
  return { ok: true };
}

/** 러닝 종료 → 좌표가 2개 이상이면 저장을 시작하고 결과 화면으로 이동 */
export function finishRun({ tracker, saver }) {
  const stopped = tracker.stop();
  if (!stopped.canSubmit) return stopped;
  saver.begin(stopped.points);
  navigate("/result");
  return stopped;
}

/** 저장하지 않고 버리기 */
export function discardRun({ tracker, saver }) {
  if (!saver.discard()) return false;
  tracker?.discardDraft();
  return true;
}
