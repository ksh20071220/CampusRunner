import { duration, kmh, km, pace } from "../lib/format.js";
import { reasonText } from "../lib/messages.js";
import { Badge, Stat } from "./ui.jsx";

/** 서버가 계산한 러닝 결과 (결과 화면·기록 상세 공통) */
export function RunStats({ run }) {
  return (
    <div className="stat-grid">
      <Stat label="거리" value={km(run.distance_m)} unit="km" big />
      <Stat label="시간" value={duration(run.duration_seconds, { alwaysHours: true })} big />
      <Stat label="평균 속도" value={kmh(run.average_mps)} unit="km/h" />
      <Stat label="평균 페이스" value={pace(run.pace_seconds_per_km)} unit="/km" />
    </div>
  );
}

export function AcceptBadge({ run }) {
  return run.accepted ? <Badge tone="ok">✓ 정상 기록</Badge> : <Badge tone="bad">의심 기록</Badge>;
}

/**
 * accepted = GPS 판정 / counts_for_university = 학교 인증까지 충족해 대학 점수에 반영되는지.
 * 둘은 다를 수 있으므로 나눠서 안내한다.
 */
export function UniversityNote({ run, verified }) {
  if (!run.accepted) {
    return (
      <div className="note note--bad">
        <strong>대학 점수에서 제외돼요</strong>
        <ul>
          {(run.reasons || []).map((code) => (
            <li key={code}>{reasonText(code)}</li>
          ))}
        </ul>
        <p>개인 기록에는 남지만 누적 거리와 학교 점수에는 들어가지 않아요.</p>
      </div>
    );
  }
  if (run.counts_for_university) {
    return (
      <div className="note note--ok">
        <strong>우리 학교 점수에 반영됐어요</strong>
        <p>이 기간 1인당 평균 거리와 순위에 들어가요.</p>
      </div>
    );
  }
  if (run.distance_m === 0) {
    return (
      <div className="note">
        <strong>이동 거리가 0m라 점수에는 반영되지 않아요</strong>
      </div>
    );
  }
  return (
    <div className="note">
      <strong>{verified ? "대학 점수 반영 대기" : "학교 인증 후 대학 점수에 반영돼요"}</strong>
      <p>정상 기록이라 개인 기록에는 저장됐어요. 학생증 인증이 승인되면 이 기록도 학교 점수에 들어가요.</p>
    </div>
  );
}
