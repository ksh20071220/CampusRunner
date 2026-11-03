# CampusRunner 프런트엔드 (회원용 모바일 웹)

Vite + React + Leaflet(OpenStreetMap). 디자인은 운영자 검토 화면(`backend/examples/verification-admin.css`)의 색과 서체를 따르고, 화면 구성은 발표 자료 8번 슬라이드를 따른다.

## 실행

```powershell
cd frontend
npm install
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
- 빌드: `npm run build` → `dist/` 정적 파일
- GPS 모듈 테스트: `npm run test:tracker`

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
- 이메일 비밀번호 찾기, 운영자별 계정, 학교 인증 서류 제출·내 정보 화면은 이 범위에 포함하지 않았다 (4번 담당).
