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
        <strong>대학 점수 제외</strong>
        <ul>
          {(run.reasons || []).map((code) => (
            <li key={code}>{reasonText(code)}</li>
          ))}
        </ul>
        <p>개인 기록에만 저장</p>
      </div>
    );
  }
  if (run.counts_for_university) {
    return (
      <div className="note note--ok">
        <strong>학교 점수 반영 완료</strong>
        <p>1인당 평균 거리·순위에 포함</p>
      </div>
    );
  }
  if (run.distance_m === 0) {
    return (
      <div className="note">
        <strong>이동 거리 0m · 점수 미반영</strong>
      </div>
    );
  }
  return (
    <div className="note">
      <strong>{verified ? "대학 점수 반영 대기" : "학교 인증 후 점수 반영"}</strong>
      <p>개인 기록 저장 완료</p>
    </div>
  );
}
