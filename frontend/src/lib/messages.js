// 서버/GPS 오류 코드를 사용자에게 보여줄 한국어 문장으로 바꾼다.

const API_MESSAGES = {
  request_timeout: "서버 응답 지연 · 연결 확인 후 재시도",
  request_cancelled: "요청 취소됨",
  session_changed: "로그인 계정 변경 · 이전 요청 중단",
  run_upload_rate_limited: "저장 요청 과다 · 잠시 후 자동 재시도",
  run_daily_quota: "오늘 저장 한도 도달 · 자정 이후 저장 가능",
  run_storage_quota: "계정 보관 한도 도달 · 운영자 문의",
  record_list_limit: "목록 조회 한도 도달 · 기간별 조회 이용",
  record_owner_mismatch: "계정 정보 불일치로 전송 중단 · 원래 계정으로 로그인 필요",
  pending_save: "저장 대기 중인 러닝 먼저 저장 또는 삭제",
  pending_not_persisted: "기기 임시 저장 실패 · 화면을 닫으면 기록 삭제 · 연결 후 저장 필요",
  local_storage_unavailable: "기기 저장소 사용 불가 · 이전 임시 기록 확인 실패",
  invalid_pending_record: "임시 기록 계정·형식 불일치 · 자동 전송 안 함",
  pending_cleanup_failed: "임시 기록 삭제 실패 · 새로고침 시 다시 표시될 수 있음",
  result_not_persisted: "서버 저장 완료 · 결과는 개인 기록에서 확인",
  local_delete_failed: "기록 삭제 실패 · 저장소 설정 확인 후 재시도",
  authentication_required: "로그인 만료 · 다시 로그인 필요",
  invalid_credentials: "닉네임 또는 비밀번호 불일치",
  invalid_credentials_format: "비밀번호 8자 이상 · 앞뒤 공백 불가",
  nickname_taken: "이미 사용 중인 닉네임",
  invalid_university: "학교 다시 선택",
  university_not_found: "학교 찾기 실패",
  auth_rate_limited: "시도 횟수 초과 · 1분 후 재시도",
  origin_not_allowed: "허용되지 않은 화면 주소 · CR_ALLOWED_ORIGIN 설정 확인",
  invalid_point_count: "GPS 좌표 수 부족 또는 초과",
  invalid_gps_or_future_time: "GPS 시각 오류 · 휴대폰 시간 설정 확인",
  invalid_run: "러닝 데이터 형식 오류",
  body_too_large: "러닝 데이터 용량 초과",
  submission_key_conflict: "같은 저장 요청에 다른 좌표 포함",
  duplicate_run: "이미 저장된 러닝",
  overlapping_run: "같은 시간대 러닝 기록 존재",
  database_busy: "서버 혼잡 · 잠시 후 자동 재시도",
  database_unavailable: "서버 저장소 연결 실패",
  not_found: "기록 없음",
  network_error: "서버 연결 실패 · 인터넷 연결 확인",
};

export function apiMessage(error) {
  if (!error) return "";
  const code = error.code || error.message;
  return API_MESSAGES[code] || (error.status >= 500 ? "서버 오류" : "요청 처리 실패");
}

/** fetch 자체가 실패(TypeError)했거나 JSON이 아닌 응답이면 status가 없다. */
export function normalizeApiError(error) {
  if (error && Number.isInteger(error.status)) return error;
  const wrapped = new Error("network_error");
  wrapped.code = "network_error";
  wrapped.cause = error;
  return wrapped;
}

const GPS_MESSAGES = {
  geolocation_unavailable: "위치 기능 미지원 브라우저",
  permission_denied: "위치 권한 거부 · 설정에서 허용 필요",
  position_unavailable: "현재 위치 찾기 실패 · 트인 곳으로 이동 권장",
  first_fix_timeout: "GPS 신호 없음 (30초)",
  poor_accuracy: "GPS 정확도 낮음 · 잠시 대기",
  out_of_order_position: "시간 오류 위치 1개 제외",
  invalid_position: "잘못된 위치 값 제외",
  point_limit: "좌표 개수 상한(20,000개) 도달 · 측정 중단 · 저장 필요",
  geolocation_start_failed: "GPS 측정 시작 실패",
  local_storage_failed: "기기 임시 저장 실패 · 새로고침 시 기록 삭제 가능",
  saved_run_invalid: "임시 저장된 러닝 복구 실패",
  insecure_context: "위치 기능은 HTTPS 주소(또는 localhost)에서만 동작",
};

export function gpsMessage(error) {
  if (!error) return "";
  return GPS_MESSAGES[error.code] || error.message || "GPS 오류";
}

const REASONS = {
  fast_segment: "순간 속도 기준 초과 (시속 36km)",
  fast_window: "30초 평균 속도 기준 초과 (시속 21.6km)",
  fast_average: "전체 평균 속도 기준 초과 (시속 21.6km)",
  gps_gap: "GPS 2분 이상 끊김",
  long_duration: "기록 시간 6시간 초과",
};

export function reasonText(code) {
  return REASONS[code] || code;
}

export const VERIFICATION_LABEL = {
  not_submitted: { text: "학교 인증 전", tone: "muted" },
  pending: { text: "인증 검토 중", tone: "warn" },
  approved: { text: "학교 인증 완료", tone: "ok" },
  rejected: { text: "인증 반려", tone: "bad" },
  cancelled: { text: "인증 취소", tone: "muted" },
  expired: { text: "인증 만료", tone: "muted" },
  revoked: { text: "인증 철회", tone: "bad" },
};
