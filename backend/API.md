# HTTP API v1

기본 URL: `http://127.0.0.1:8080`. 일반 본문은 `application/json` UTF-8 객체이며, 사진 업로드·조회는 이미지 바이너리입니다. 개인 API는 `Authorization: Bearer <token>`이 필요합니다. 쿠키 인증은 사용하지 않습니다. 사진 인증 API·상태·오류는 [소속 인증 안내](UNIVERSITY_VERIFICATION.md)를 참고하세요.

## 엔드포인트

| Method | URL | 권한 | 결과 |
| --- | --- | --- | --- |
| GET | /health | 공개 | 200 상태 |
| GET | /api/universities?q=서울&region=서울특별시&kind=대학교 | 공개 | 200 대학 배열, 검색 조건 선택 |
| POST | /api/universities | 관리자 토큰 | 201 대학 등록 |
| POST | /api/auth/register | 공개 | 201 회원·토큰 |
| POST | /api/auth/login | 공개 | 200 회원·토큰 |
| POST | /api/auth/logout | 회원 | 204 현재 세션 폐기 |
| POST | /api/auth/logout-all | 회원 | 204 본인 모든 기기의 세션 폐기 |
| GET | /api/me | 회원 | 200 본인 프로필 |
| PATCH | /api/me | 회원 | 200 프로필 변경 |
| DELETE | /api/me | 회원·비밀번호 재확인 | 204 회원 탈퇴·개인 데이터 삭제 |
| PATCH | /api/me/password | 회원·비밀번호 재확인 | 200 새 비밀번호·교체 세션 |
| POST | /api/runs | 회원 | 201 러닝, 같은 제출 재시도는 200 |
| GET | /api/me/runs?limit=50&offset=0 | 회원 | 200 본인 러닝 요약 배열 |
| GET | /api/me/runs/{id} | 본인 | 200 원본 좌표 포함 러닝 |
| GET | /api/me/stats?from=0&to=2000000000 | 회원 | 200 정상 거리·정상/의심 기록 건수 |
| GET | /api/rankings?from=0&to=2000000000&limit=100&offset=0 | 공개 | 200 대학 순위 배열 |
| GET | /api/universities/{id}/stats?from=0&to=2000000000 | 공개 | 200 해당 대학의 기간 성적·전체 순위 객체 |

알 수 없는 경로는 404, 허용하지 않는 HTTP 메서드는 405입니다. 알려진 개인 경로는 메서드 검사보다 인증을 먼저 수행하므로 미인증 요청은 401일 수 있습니다. 보호된 POST/PATCH/DELETE는 본문을 읽기 전에 권한부터 확인합니다. Origin 헤더가 있으면 설정한 Origin과 일치해야 합니다. OPTIONS preflight도 앱의 동일한 Origin 검사를 통과해야 하며 DELETE를 지원합니다. GET 조회 응답도 `Cache-Control: no-store`입니다.

요청에는 정확한 십진수 Content-Length를 보내세요. Transfer-Encoding은 지원하지 않으며 Host·Content-Length·Authorization·Origin·Content-Type·사진 제출 헤더의 중복은 400 invalid_request입니다. API 경로는 문서의 ASCII 경로 그대로 사용하고 검색 값만 URL 인코딩합니다. 경로의 퍼센트 인코딩, 쿼리의 NUL·제어 문자·잘못된 퍼센트 인코딩·잘못된 UTF-8은 400입니다.

JSON은 숫자 문법·문자열 이스케이프·UTF-8을 엄격히 확인합니다. 예를 들어 03, 4., +4, 수직 탭 공백, NUL 문자열은 거부하며 유효한 지수 표기와 유니코드 문자는 지원합니다. 본문은 최대 2MiB·깊이 32·어휘 토큰 180,000개이며 GPS 최대 20,000점을 수용합니다. 로그아웃은 빈 객체 `{}`를 보내며 알 수 없는 필드를 추가하면 400 invalid_logout입니다.

## 입력

대학 목록은 내장된 한국 대학 385개가 자동 등록됩니다. 기본 출처·기준연도와 최신 변경 반영 범위는 [대학 목록](catalog/README.md)을 참고하세요. 목록 외 대학을 추가할 때 관리자 등록 API를 사용합니다: `{ "id": 99, "name": "추가 학교명" }`. 이미 등록된 이름이나 ID는 409입니다.

대학 조회는 id·name 외 kind, regions 배열, aliases 배열, campuses 배열, source_date를 반환합니다. q는 현재 학교명 또는 통합 전 이름 부분 검색, region은 캠퍼스 지역 이름, kind는 학교 종류 정확 일치입니다. 한글 검색 값은 URL 인코딩하세요. 전체 목록을 받아 프런트엔드에서 필터링해도 됩니다.

회원 가입:

```json
{"nickname":"달리는학생","password":"long-random-password","university_id":1}
```

로그인: `{ "nickname": "달리는학생", "password": "long-random-password" }`.

가입·로그인 응답:

```json
{"id":1,"nickname":"달리는학생","university_id":1,"university_name":"서울대학교","verification_status":"not_submitted","university_verified":false,"token":"64자리16진수토큰","expires_at":1793228400}
```

`GET /api/me`는 위 응답에서 token·expires_at이 없는 프로필입니다. PATCH는 nickname·university_id 중 변경할 항목만 전송합니다. 기록이 하나라도 있으면 대학 변경을 409로 거부합니다. 닉네임은 이후에도 변경할 수 있습니다. 대학을 변경하면 이전 사진 신청·승인이 취소되며 새 대학에 대해 다시 사진 인증해야 합니다.

닉네임·대학명: 비어 있지 않은 UTF-8 최대 95바이트, 제어 문자·앞뒤 ASCII 공백 불가. 닉네임과 대학명은 각각 대소문자를 구분해 유일합니다. Unicode 정규화는 하지 않습니다. 비밀번호: 8~128 UTF-8 바이트, 제어 문자·앞뒤 공백 불가. 대학 ID: 1~2147483647 정수. 회원 ID는 서버가 발급합니다.

## 회원 탈퇴·비밀번호 변경·전체 로그아웃

`DELETE /api/me`에 아래 JSON과 회원 Bearer 토큰을 보냅니다. 탈퇴 화면에서 영구 삭제 내용과 대학 점수 감소를 안내하고, 명시적으로 확인받은 뒤 호출하세요. 비밀번호가 틀리면 401, confirmation이 정확히 DELETE가 아니거나 추가 필드가 있으면 400입니다. 본인 ID는 토큰에서 결정하며 member_id를 받지 않습니다.

```json
{"password":"현재 비밀번호","confirmation":"DELETE"}
```

성공은 본문 없는 204입니다. 회원·비밀번호 해시·모든 세션·정상/의심 러닝 및 GPS·사진 신청/이미지·해당 회원의 검토 이력을 한 트랜잭션에서 삭제합니다. 실패하면 모두 롤백합니다. 다른 회원과 대학 목록은 보존하며 본인 기여분이 대학 합산·참가자 수·평균·순위에서 즉시 빠집니다. 탈퇴한 닉네임으로 다시 가입할 수 있지만 새 회원 ID이며 이전 기록·인증·토큰은 이어받지 않습니다.

삭제는 현재 운영 DB 기준입니다. 기존 백업/외부 스냅샷은 별도 보관·삭제 정책을 적용해야 하며 과거 백업 복원 시 탈퇴 회원이 다시 나타날 수 있습니다. WAL/저장 장치의 과거 블록까지 즉시 물리 소거를 보장하지 않습니다. 계정과 연결하지 않는 IP별 인증 시도 제한은 공유 정책을 유지합니다.

`PATCH /api/me/password` 요청:

```json
{"current_password":"현재 비밀번호","new_password":"새로운 비밀번호"}
```

새 비밀번호는 가입과 같은 8~128 UTF-8 바이트 규칙이며 현재와 달라야 합니다. 성공은 가입/로그인과 같은 프로필·token·expires_at 객체입니다. 새 salt와 해시로 저장하고 모든 이전 세션을 폐기한 다음 새 세션 하나를 발급합니다. 프런트엔드는 반환된 token으로 즉시 교체해야 합니다. 사진 인증·프로필·러닝은 보존합니다. 세션 발급까지 실패하면 비밀번호와 기존 세션을 모두 롤백합니다.

`POST /api/auth/logout-all`은 빈 객체 `{}`만 받습니다. 본인 모든 세션을 삭제하고 204를 반환하며 현재 토큰도 즉시 무효입니다. 계정과 러닝은 남아 다시 로그인할 수 있습니다. 기존 logout은 요청에 사용한 세션만 삭제합니다.

비밀번호 재확인은 가입·로그인과 같은 원격 IP별 60초/30회 제한을 공유합니다. 쓰기 잠금을 얻은 뒤 세션과 검증에 사용한 자격 증명을 다시 확인하므로, 기다리는 도중 폐기된 토큰이나 변경된 비밀번호로 상태를 변경할 수 없습니다. 로그인도 잠금 뒤 비밀번호 스냅샷을 재확인합니다.

클라이언트: `api.deleteAccount(password)`, `api.changePassword(currentPassword,newPassword)`, `api.logoutAll()`을 제공합니다. 이 예제는 API 연결용이며 회원가입·설정 화면은 프런트엔드에서 연결해야 합니다. 이메일 주소/메일 발송 기반 비밀번호 분실 복구는 현재 API에 포함하지 않습니다.

러닝 제출:

```json
{
  "key":"4cc9b258-c627-45be-afcc-e6916952dfd1",
  "points":[
    {"timestamp":1792623600,"latitude":37.500,"longitude":127.0},
    {"timestamp":1792623660,"latitude":37.501,"longitude":127.0}
  ]
}
```

key는 최대 63 UTF-8 바이트입니다. 동일 러닝의 재전송은 같은 key·같은 points를 유지하세요. 좌표 필드 순서와 숫자 표기 차이는 서버가 정규화합니다. 계정별로 key와 좌표 내용의 유일성을 검사합니다. 다른 회원의 같은 key는 허용합니다.

points: 최소 2개, 최대 20,000개. timestamp는 UTC Unix **초**, 0~4102444800 정수이며 strictly increasing. latitude [-90,90], longitude [-180,180] 유한 숫자. 종료 시각은 서버 현재 시각+300초 이하여야 합니다. 추가 JSON 필드는 거부하므로 distance_m·member_id·university_id를 넣지 마세요. 요청 크기는 2MiB 이하입니다.

러닝 응답 예시(수치는 예):

```json
{
  "id":1,"key":"4cc9b258-c627-45be-afcc-e6916952dfd1","university_id":1,
  "started_at":1792623600,"ended_at":1792623660,"duration_seconds":60,
  "distance_m":111.195,"average_mps":1.853248777,
  "max_segment_mps":1.853248777,"max_window_mps":1.853248777,
  "pace_seconds_per_km":539.593,"flags":0,"accepted":true,"counts_for_university":false,
  "policy_version":1,"reasons":[]
}
```

제자리 기록의 pace_seconds_per_km은 null입니다. `GET /api/me/runs/{id}`는 여기에 points 배열을 추가합니다. accepted는 GPS 판정, counts_for_university는 소속 승인까지 충족해 대학 점수에 반영되는지 나타냅니다. 정상 기록도 소속 승인 전에는 후자가 false입니다. 의심 기록은 HTTP 201·accepted:false로 보관하며 잘못된 입력은 저장하지 않고 HTTP 400입니다.

## 순위·기간·페이지

from·to는 UTC Unix 초 정수이며 `0 <= from < to <= 4102444800`입니다. 러닝 시작이 from 이상, to 미만인 기록을 집계합니다. 원본 timestamp·from·to에 밀리초를 넣지 마세요. from·to는 필수입니다.

```json
[
  {"university_id":1,"university_name":"서울대학교","distance_m":3000,
   "participants":2,"runs":3,"average_distance_m":1500,"rank":1}
]
```

활동 없는 대학도 0m·0명으로 포함합니다. 소속 사진 승인을 받은 회원의 정상·양수 거리만 합산하고 같은 회원의 여러 러닝은 인원 한 명으로 셉니다. 미인증 회원은 분모에서도 제외합니다. 평균 거리 기준 공동 순위 1·1·3이며 대학 ID로 동점 표시 순서를 정합니다. 순위는 전체 대학에 대해 계산한 뒤 페이지를 잘라 반환합니다.

rankings: 기본 limit 100, 최대 500. me/runs: 기본 limit 50, 최대 200. 공통 offset 기본 0, 최대 1000000. 배열 길이가 limit보다 작으면 마지막 페이지입니다. 개인 기록은 started_at 내림차순, 같은 시간이면 id 내림차순입니다. 조회 사이 새 기록이 추가되면 offset 페이지가 이동할 수 있으므로 새로고침 시 첫 페이지부터 조회하세요.

`GET /api/universities/{id}/stats?from=...&to=...`는 위 순위 배열 중 해당 대학의 항목 하나를 **객체**로 반환합니다. 같은 기간의 전체 순위와 완전히 같은 집계·공동 순위를 사용합니다. 활동이 없으면 거리·참가자·러닝 수가 0인 항목을 반환하며, 없는 대학 ID는 404입니다. from·to는 필수이고 이 경로에는 페이지 인자를 적용하지 않습니다. 프런트엔드에서는 `api.universityStats(me.university_id, from, to)`로 소속 대학 성적을 조회할 수 있습니다.

`GET /api/me/stats` 응답: `{ "distance_m": 3000, "accepted_runs": 3, "flagged_runs": 1 }`. accepted_runs에는 0m 정상 기록도 포함되지만 대학 참여자에는 포함되지 않습니다.

## 오류

```json
{"error":"authentication_required"}
```

| HTTP | 주요 코드 | 처리 |
| --- | --- | --- |
| 400 | invalid_request, invalid_json, invalid_query, invalid_logout, invalid_account_deletion, invalid_password_change, password_unchanged, invalid_credentials_format, invalid_profile, invalid_university, invalid_run, invalid_point_count, invalid_gps_or_future_time, invalid_period, invalid_period_or_pagination, invalid_pagination, university_not_found | 입력 수정 |
| 401 | authentication_required, invalid_credentials | 재로그인·비밀번호 확인 |
| 403 | admin_required, origin_not_allowed | 권한·Origin 설정 확인 |
| 404 | not_found | 경로·본인 소유 기록 확인 |
| 405 | method_not_allowed | 메서드 수정 |
| 409 | nickname_taken, duplicate_university, profile_conflict | 중복·대학 변경 조건 확인 |
| 409 | submission_key_conflict | 같은 key로 다른 좌표를 보내지 않기 |
| 409 | duplicate_run, overlapping_run | 같은 활동 재등록 금지 |
| 411 | invalid_json | Content-Length가 있는 JSON 요청 사용 |
| 413 | body_too_large | GPS 표본/본문 크기 확인 |
| 415 | json_required | Content-Type: application/json 지정 |
| 429 | auth_rate_limited | Retry-After: 60 이후 재시도 |
| 500 | database_error, crypto_error, out_of_memory, internal_error | 서버 로그·상태 확인 |
| 503 | database_busy, database_unavailable | 잠시 뒤 동일 key로 재시도 |

서버가 응답하기 전에 연결이 끊어져도 러닝을 저장했을 수 있습니다. **동일 key와 동일 points로 재시도**하면 기존 결과를 받습니다. 프록시·HTTP 라이브러리가 API 핸들러 이전에 거부한 요청은 위 JSON 형식과 다를 수 있습니다.
