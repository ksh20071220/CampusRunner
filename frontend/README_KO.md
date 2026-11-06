# CampusRunner 프런트엔드 (회원용 모바일 웹)

Vite + React + Leaflet(OpenStreetMap). 디자인은 운영자 검토 화면(`backend/examples/verification-admin.css`)의 색과 서체를 따르고, 화면 구성은 발표 자료 8번 슬라이드를 따른다.

## 실행

```powershell
cd frontend
npm ci
npm run dev          # http://localhost:5173
```

- **목업 모드 (서버·휴대폰 없이 화면 확인)**: `http://localhost:5173/?mock=1`
  - 닉네임 `새벽러너` / 비밀번호 `password123`이 미리 채워져 있고, 10주치 예제 기록과 가상 GPS를 쓴다.
  - `?mock=1&reset=1`: 목업 데이터 초기화
  - `?mock=1&fail=2`: 다음 러닝 저장을 2번 실패시켜 자동 재시도 화면 확인
  - `?mock=1&gpsfail=denied`: 위치 권한 거부 화면 확인
- **실제 서버 연결**: 백엔드를 띄운 뒤(`backend/start-server.ps1`) 그냥 `http://localhost:5173` 접속.
  - 서버의 `CR_ALLOWED_ORIGIN`이 프런트 주소와 **정확히** 같아야 한다 (기본값 `http://localhost:5173`).
  - API 주소는 `.env.example`을 `.env`로 복사해 `VITE_API_BASE_URL`로 바꿀 수 있다. 비우면 `현재 접속 호스트:8080`을 쓴다.
- **관리자 모드**: 실제 서버에 연결된 일반 로그인 화면에서 기본 운영자 아이디 `admin`으로 로그인하면 학교 인증 심사 화면이 열립니다. 로그아웃하면 일반 로그인으로 돌아옵니다. [관리자 계정 준비](../backend/UNIVERSITY_VERIFICATION.md#운영진-검토-화면).
- 빌드: `npm run build` → `dist/` 정적 파일
- GPS·계정별 임시 저장 테스트: `npm test`
- 개발 서버는 기본적으로 PC 내부(localhost)에서만 접속한다. 같은 Wi-Fi에 공개하려면 `npm run dev -- --host 0.0.0.0`을 명시하고, 휴대폰 GPS에는 별도 HTTPS 구성이 필요하다.

## 화면과 주소 (해시 라우팅)

| 주소 | 화면 | 주요 API |
| --- | --- | --- |
| `#/login` | 로그인·가입(학교 검색) | `login`, `register`, `universities` |
| `#/home` | 홈: 누적 거리, 러닝 횟수, 이번 주 내 대학 순위 | `myStats`, `universityStats` |
| `#/run` | 러닝 측정: 실시간 지도·거리·시간·속도·페이스 | `RunTracker` |
| `#/result` | 러닝 결과: 자동 저장·재시도, 서버 확정 기록 | `submitRun` |
| `#/records` | 개인 기록: 주간/월간 거리 그래프, 지난 기간 비교, 목록 | `myRuns` (전체 페이지) |
| `#/records/:id` | 기록 상세: 저장된 경로 지도 | `myRun` |
| `#/rankings` | 대학 순위: 이번 주/이번 달/전체, 내 대학 강조 | `rankings`, `universityStats` |

러닝 중에는 하단 메뉴를 숨긴다. 다른 화면으로 이동해도 측정은 계속되고, 상단에 "러닝 중" 막대가 떠서 돌아갈 수 있다. 러닝 중 새로고침·탭 닫기는 브라우저 확인 창으로 막고, 화면 꺼짐 방지(Wake Lock)를 요청한다.

## 파일 구조

```
frontend/
  run-tracker.js            # (1번 GPS 담당) 수정하지 않고 그대로 사용
  src/
    state/AppContext.jsx    # 앱 공통: API 클라이언트, 로그인, RunTracker 1개, RunSaver 1개
    services/run-saver.js   # 종료 후 자동 저장 + 같은 key 재시도   (2번이 확장/교체 가능)
    services/records.js     # 기록 전체 조회, 주간/월간 집계, 지난 기간 비교 (2번이 확장/교체 가능)
    services/run-actions.js # 시작/종료/폐기 공통 동작
    components/RouteMap.jsx # 좌표 배열 → 지도 경로선, 시작/끝 표시, 전체 경로/내 위치 버튼
    components/BarChart.jsx # 주간/월간 거리 막대그래프
    screens/*.jsx           # 화면
    lib/                    # 단위 변환, 한국 시간 기간 경계, 오류 문구, 라우터
    mock/                   # 목업 서버·가상 GPS
```

API 클라이언트는 복사하지 않고 `backend/examples/api-client.js`를 `@campus-api` 별칭으로 가져온다.

## 다른 역할과의 연결 약속

- **1번 GPS**: `RunTracker`의 `start / stop / subscribe / getPoints / markSaved / discardDraft`만 사용한다. 화면을 떠난다고 `dispose()`하지 않는다.
- **2번 기록**: `RunSaver.begin(points)`가 key를 한 번 만들고 `{key, points}`를 localStorage에 보관한다. 실패하면 2초→5초→10초 간격으로 자동 재시도하고, 그 뒤에는 [다시 시도] 버튼을 보여준다. 인터넷이 다시 연결되면(`online`) 바로 다시 보낸다. 서버 성공을 확인한 뒤에만 `markSaved()`를 부른다. 401이면 로그인 화면으로 보내고, 로그인 후 같은 key로 이어서 저장한다.
- **4번 회원·대학**: 화면은 `accepted`(GPS 판정)와 `counts_for_university`(학교 인증까지 충족)를 따로 안내한다. 순위는 서버 `rank`를 그대로 쓴다. 회원 토큰은 `sessionStorage`(탭을 닫으면 삭제)에 둔다. 러닝 중 실수로 새로고침해도 다시 로그인하지 않게 하려는 것이다. 관리자 토큰은 프런트에 넣지 않는다.

## 검증한 것 (2026-11-03)

- 목업 모드 390px 화면: 로그인 → 홈 → 러닝 → 다른 화면 이동 중 측정 유지 → 종료 → 저장 실패 후 자동 재시도 → 결과 → 상세 → 기록 그래프 → 순위. 콘솔 오류와 가로 넘침 없음.
- **실제 C 서버**(Linux 빌드): 화면에서 가입(학교 검색) → 가상 위치로 러닝 → **저장 직전에 서버를 끄고** 종료 → 재시도 표시 → 서버를 다시 켜고 재시도 → 서버에 기록이 **1개만** 저장됨. 승인 전에는 "학교 인증 후 반영" 안내, 승인 후에는 대학 순위 1위·참가자 1명으로 반영됨.

## 아직 안 된 것 / 실기기에서 확인할 것

- **휴대폰 HTTPS 접속**: 위치 권한은 HTTPS(또는 localhost)에서만 받을 수 있다. 같은 Wi-Fi에서 `http://PC-IP:5173`으로 접속하면 화면은 열리지만 GPS는 거부된다. 화면에도 "HTTPS 주소가 필요해요"라고 표시된다. 시험할 때는 `backend/deploy/Caddyfile`처럼 HTTPS 프록시를 두거나 터널 서비스를 쓰고, `CR_ALLOWED_ORIGIN`을 그 주소로 맞춘다.
- **실기기 GPS 점검표**: 권한 거부 → 안내 표시 / 실내에서 첫 위치 30초 초과 → 오류 표시 / 러닝 중 화면 끄기 10초 이상 → 돌아오면 안내 표시 / 비행기 모드에서 종료 → 재시도 → 연결 후 저장 / 러닝 중 새로고침 → 홈에서 "이어 달리기·종료하고 저장" 확인.
- 지도 타일은 OpenStreetMap 공용 서버를 쓴다. 발표·소규모 테스트에는 충분하지만 사용자가 많아지면 타일 이용 정책에 따라 다른 공급자로 바꿔야 한다.
- 이메일 비밀번호 찾기, 운영자별 계정, 내 정보·계정 설정 화면은 추가 구현이 남아 있다. 학교 인증 화면은 아래 최신 구현 안내를 따른다.

## 2026-11-04 계정별 러닝 보완

`services/account-runs.js`가 로그인 회원마다 GPS 측정기를 관리한다. 로그아웃·다른 계정 로그인 시 이전 측정을 중지하고 임시 좌표를 해당 회원에게만 남긴다. `RunSaver.setSession(user)`로 서버가 발급한 `{id, token}`을 전달한 뒤 `begin/save`를 호출한다. 업로드 전 `/api/me`로 소유자를 확인하고 확인·전송에 동일한 토큰을 고정한다. 도중 계정이 바뀌면 늦은 응답이 새 화면의 기록을 변경하지 않는다. 이미 서버에 전달된 요청은 원래 계정으로 저장될 수 있다.

localStorage 키는 `campusrunner.account.v2.<URL 인코딩된 API 주소 또는 mock>.<회원 ID>.pending/active`, 결과는 sessionStorage의 같은 접두사 `.result`에 둔다. 로그인 세션도 API 주소별 v2 키를 쓴다. 목업과 실제 서버의 회원 ID가 같아도 기록·세션을 공유하지 않는다. 기존 v1 로그인 세션은 가져오지 않으므로 업데이트 후 다시 로그인한다. 소유자가 없는 기존 v1 GPS 기록은 삭제하지 않고 격리하여 자동 전송하지 않는다. 필요하면 소유자 확인 후 별도로 복구해야 한다.

기기 저장 실패는 `pendingPersisted=false`, `storageWarning`으로 화면에 표시한다. 이때 기록은 현재 탭 메모리에만 존재하므로 새로고침 전에 서버 저장을 완료해야 한다. 삭제 실패는 `discard()`가 false를 반환하며 삭제 완료 화면으로 이동하지 않는다.

학교 인증 API·운영자 심사 화면과 회원용 학교 인증 화면을 연결했다. 홈의 인증 버튼에서 사진 제출·동의·상태/사유 조회·취소·재제출을 수행할 수 있다.


## 2026-11-04 오류 보완

GPS 삭제는 active/pending의 실제 삭제 결과를 확인하며 실패하면 좌표를 유지하고 안내한다. JSON 요청은 기본 15초, 사진은 45초 안에 응답 본문까지 완료되지 않으면 취소한다. 저장 재시도는 같은 key를 유지하고 서버 Retry-After를 따른다. 계정 변경 후 도착한 계정 설정 응답은 새 세션을 덮어쓰지 않는다.

개인 기록 헤더와 그래프는 `/api/me/stats`의 서버 집계를 사용한다. 목록은 `RecordHistory.jsx`에서 200개씩 불러와 20개씩 표시하며 더 보기로 이어서 조회한다. 전체 목록을 다운로드한 뒤 합산하지 않으므로 10,000개를 넘어도 누적값이 잘리지 않는다. 기존 `fetchAllRuns`는 도구 호환용으로 남겼으며 조회 상한에 도달하면 오류를 내고 조용히 자르지 않는다.

새 서버는 스키마 3과 확장된 통계 응답을 사용하므로 프런트와 백엔드를 함께 업데이트한다. 업로드 제한 기본값과 기존 DB 업그레이드·백업은 `backend/BACKEND_HANDOFF_KO.txt`의 마지막 보완 항목을 참고한다. 해당 오류 보완 당시 프록시 뒤 로그인 제한 문제와 회원 화면 추가는 제외했다. 학교 인증 회원 화면은 아래 후속 구현에서 추가했다.


## 학교 인증 회원 화면 (2026-11-04)

홈의 인증 배지/인증하기 카드 → `#/verification`에서 이용한다. JPG·PNG 최대 5MiB, 가로·세로 각각 12,000px 이하·4천만 픽셀 이하의 사진 한 장을 선택하고 미리보기와 개인정보 가림 안내를 확인한 뒤 열람 동의 후 제출한다. 검토 중에는 새 제출을 막고 취소 확인 단계를 제공한다. 반려·만료·취소·철회 뒤에는 보완한 서류를 다시 제출한다. 승인 시 프로필과 학교 점수 표시도 갱신한다.

검토 중에는 화면이 보일 때 15초마다 조회하며 수동 새로고침/다시 화면 보기로도 상태를 확인한다. 통신 오류로 제출·취소 결과가 불확실하면 서버 상태를 확인한 뒤 다음 동작을 허용한다. 중복 클릭과 늦은 응답을 막고 요청 토큰을 해당 회원에 고정한다.

`services/university-verification.js`는 상태·API 연동을, `verification-files.js`는 파일 검사와 서류 종류를, `screens/Verification.jsx`는 화면·현재 탭의 미리보기를 담당한다. 사진·파일명·미리보기 URL은 localStorage/sessionStorage에 저장하지 않으며 화면을 나갈 때 미리보기 URL을 해제한다. 목업 API도 신청 메타데이터만 보관한다. 목업 기본 회원은 이미 승인된 상태이므로 새 회원으로 가입하면 제출 흐름을 시험할 수 있다.

단독 검사: `node --test tests/university-verification.test.mjs`. `npm test`, `backend/build.ps1 -Test`, CMake/CTest에도 포함한다. 실제 운영자 이름·연락처 등 서비스 운영 안내는 배포 운영자가 결정한다.
