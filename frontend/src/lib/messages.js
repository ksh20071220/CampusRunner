// 서버/GPS 오류 코드를 사용자에게 보여줄 한국어 문장으로 바꾼다.

const API_MESSAGES = {
  proof_file_required: "제출할 사진을 선택해 주세요.",
  proof_read_failed: "사진 파일을 읽지 못했어요. 파일을 다시 선택해 주세요.",
  proof_dimensions_exceeded: "사진은 가로·세로 각각 12,000px 이하, 전체 4천만 픽셀 이하로 줄여 주세요.",
  image_too_large: "사진은 최대 5MiB까지 제출할 수 있어요. 크기를 줄인 뒤 다시 선택해 주세요.",
  jpeg_or_png_required: "JPG 또는 PNG 사진을 선택해 주세요. HEIC·PDF는 변환 후 제출해 주세요.",
  jpeg_or_png_up_to_5mb_required: "5MiB 이하의 JPG·PNG 사진을 선택해 주세요.",
  invalid_image: "사진을 열 수 없어요. 정상적인 JPG·PNG 파일을 다시 선택해 주세요.",
  incomplete_image: "사진이 끝까지 전송되지 않았어요. 접수 상태를 확인하고 다시 시도해 주세요.",
  invalid_document_type: "서류 종류를 다시 선택해 주세요.",
  verification_consent_required: "사진 제출과 운영진 열람에 동의해 주세요.",
  verification_already_pending: "이미 검토 중인 신청이 있어요. 상태 확인 후 기존 신청을 확인해 주세요.",
  already_verified: "이미 학교 인증이 완료됐어요. 최신 상태를 확인해 주세요.",
  verification_not_pending: "이미 처리되었거나 만료된 신청이에요. 최신 상태를 확인해 주세요.",
  verification_upload_limit: "최근 24시간 동안 제출할 수 있는 5회 한도에 도달했어요. 시간이 지난 뒤 다시 시도해 주세요.",
  request_timeout: "서버 응답이 늦어 요청을 중단했어요. 연결을 확인하고 다시 시도해 주세요.",
  request_cancelled: "요청을 취소했어요.",
  session_changed: "로그인 계정이 변경되어 이전 요청의 화면 반영을 중단했어요.",
  run_upload_rate_limited: "러닝 저장 요청이 많아요. 잠시 기다리면 다시 시도해요.",
  run_daily_quota: "오늘의 러닝 저장 한도에 도달했어요. 한국 시간 자정 이후 저장해 주세요.",
  run_storage_quota: "계정의 러닝 보관 한도에 도달했어요. 운영자에게 문의해 주세요.",
  record_list_limit: "전체 목록 조회 한도에 도달했어요. 기간별 조회를 이용해 주세요.",
  record_owner_mismatch: "러닝의 계정 정보가 맞지 않아 전송을 중단했어요. 원래 계정으로 다시 로그인해 주세요.",
  pending_save: "저장 대기 중인 러닝부터 저장하거나 삭제해 주세요.",
  pending_not_persisted: "기기에 임시 저장하지 못했어요. 기록은 현재 화면에만 있어 새로고침하거나 탭을 닫으면 사라져요. 연결 후 저장해 주세요.",
  local_storage_unavailable: "기기 저장소를 사용할 수 없어 이전 임시 기록을 확인하지 못했어요.",
  invalid_pending_record: "임시 기록의 계정 또는 형식이 맞지 않아 자동 전송하지 않았어요.",
  pending_cleanup_failed: "임시 기록을 기기에서 지우지 못했어요. 새로고침하면 다시 나타날 수 있어요.",
  result_not_persisted: "서버에는 저장됐지만 결과를 기기에 보관하지 못했어요. 개인 기록에서 확인해 주세요.",
  local_delete_failed: "기기에서 기록을 삭제하지 못했어요. 저장소 설정을 확인한 뒤 다시 시도해 주세요.",
  authentication_required: "로그인이 만료됐어요. 다시 로그인해 주세요.",
  admin_secure_api_required: "관리자 로그인에는 HTTPS 또는 로컬 API 주소가 필요해요.",
  invalid_admin_session: "관리자 로그인 응답을 확인하지 못했어요.",
  rate_limited: "시도가 너무 많아요. 잠시 후 다시 시도해 주세요.",
  invalid_credentials: "닉네임 또는 비밀번호가 맞지 않아요.",
  invalid_credentials_format: "비밀번호는 8자 이상, 앞뒤 공백 없이 입력해 주세요.",
  nickname_taken: "이미 사용 중인 닉네임이에요.",
  invalid_university: "학교를 다시 선택해 주세요.",
  university_not_found: "학교를 찾을 수 없어요.",
  auth_rate_limited: "시도가 너무 많아요. 1분 뒤에 다시 해주세요.",
  origin_not_allowed: "서버가 이 화면 주소를 허용하지 않아요. CR_ALLOWED_ORIGIN 설정을 확인해 주세요.",
  invalid_point_count: "GPS 좌표가 부족하거나 너무 많아요.",
  invalid_gps_or_future_time: "GPS 시각이 올바르지 않아요. 휴대폰 시간 설정을 확인해 주세요.",
  invalid_run: "러닝 데이터 형식이 올바르지 않아요.",
  body_too_large: "러닝 데이터가 너무 커요.",
  submission_key_conflict: "같은 저장 요청에 다른 좌표가 들어갔어요.",
  duplicate_run: "이미 저장된 러닝이에요.",
  overlapping_run: "같은 시간대에 이미 저장된 러닝이 있어요.",
  database_busy: "서버가 바빠요. 잠시 뒤 다시 시도할게요.",
  database_unavailable: "서버 저장소에 연결하지 못했어요.",
  not_found: "기록을 찾을 수 없어요.",
  network_error: "서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.",
};

export function apiMessage(error) {
  if (!error) return "";
  const code = error.code || error.message;
  return API_MESSAGES[code] || (error.status >= 500 ? "서버 오류가 발생했어요." : "요청을 처리하지 못했어요.");
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
  geolocation_unavailable: "이 브라우저는 위치 기능을 지원하지 않아요.",
  permission_denied: "위치 권한이 거부됐어요. 브라우저 설정에서 위치 권한을 허용해 주세요.",
  position_unavailable: "현재 위치를 찾지 못하고 있어요. 하늘이 트인 곳으로 이동해 보세요.",
  first_fix_timeout: "30초 동안 GPS 신호를 받지 못했어요.",
  poor_accuracy: "GPS 정확도가 낮아요. 잠시만 기다려 주세요.",
  out_of_order_position: "시간이 맞지 않는 위치 하나를 건너뛰었어요.",
  invalid_position: "잘못된 위치 값을 건너뛰었어요.",
  point_limit: "좌표 개수 상한(20,000개)에 도달해 측정을 멈췄어요. 저장해 주세요.",
  geolocation_start_failed: "GPS 측정을 시작하지 못했어요.",
  local_storage_failed: "이 기기에 임시 저장을 하지 못했어요. 새로고침하면 기록이 사라질 수 있어요.",
  saved_run_invalid: "이전에 임시 저장된 러닝을 복구하지 못했어요.",
  insecure_context: "위치 기능은 HTTPS 주소(또는 localhost)에서만 동작해요.",
};

export function gpsMessage(error) {
  if (!error) return "";
  return GPS_MESSAGES[error.code] || error.message || "GPS 오류가 발생했어요.";
}

const REASONS = {
  fast_segment: "순간 속도가 기준(시속 36km)을 넘었어요",
  fast_window: "30초 평균 속도가 기준(시속 21.6km)을 넘었어요",
  fast_average: "전체 평균 속도가 기준(시속 21.6km)을 넘었어요",
  gps_gap: "GPS가 2분 넘게 끊긴 구간이 있어요",
  long_duration: "기록 시간이 6시간을 넘었어요",
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
