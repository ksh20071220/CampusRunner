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
| GET | /api/me | 회원 | 200 본인 프로필 |
| PATCH | /api/me | 회원 | 200 프로필 변경 |
| POST | /api/runs | 회원 | 201 러닝, 같은 제출 재시도는 200 |
| GET | /api/me/runs?limit=50&offset=0 | 회원 | 200 본인 러닝 요약 배열 |
| GET | /api/me/runs/{id} | 본인 | 200 원본 좌표 포함 러닝 |
| GET | /api/me/stats?from=0&to=2000000000 | 회원 | 200 정상 거리·정상/의심 기록 건수 |
| GET | /api/rankings?from=0&to=2000000000&limit=100&offset=0 | 공개 | 200 대학 순위 배열 |

알 수 없는 경로는 404, 허용하지 않는 HTTP 메서드는 405입니다. 알려진 개인 경로는 메서드 검사보다 인증을 먼저 수행하므로 미인증 요청은 401일 수 있습니다. Origin 헤더가 있으면 설정한 Origin과 일치해야 합니다. OPTIONS preflight를 지원합니다. GET 조회 응답도 `Cache-Control: no-store`입니다.

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

`GET /api/me/stats` 응답: `{ "distance_m": 3000, "accepted_runs": 3, "flagged_runs": 1 }`. accepted_runs에는 0m 정상 기록도 포함되지만 대학 참여자에는 포함되지 않습니다.

## 오류

```json
{"error":"authentication_required"}
```

| HTTP | 주요 코드 | 처리 |
| --- | --- | --- |
| 400 | invalid_json, invalid_query, invalid_credentials_format, invalid_profile, invalid_university, invalid_run, invalid_point_count, invalid_gps_or_future_time, invalid_period, invalid_period_or_pagination, invalid_pagination, university_not_found | 입력 수정 |
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
