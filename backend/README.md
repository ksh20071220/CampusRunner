# CampusRunner C 서버 백엔드

회원·대학 등록, GPS 기록 검증, 대학별 거리 합산·참여자 평균·기간 순위를 **하나의 HTTP 서버와 SQLite 공용 DB**로 제공합니다. 프런트엔드는 각 사용자 휴대폰에서 같은 서버 주소로 요청합니다. 거리나 회원 ID를 클라이언트가 임의로 보내 점수를 올리는 방식은 허용하지 않습니다.

```text
모바일 웹 GPS → POST /api/runs + 로그인 토큰
                         ↓
                 C 좌표 검증·거리 재계산
                         ↓
                 SQLite 트랜잭션 저장
                         ↓
모든 사용자 ← GET /api/rankings?from=...&to=...
```

## 1. Windows에서 시작

Visual Studio/Build Tools의 **C++를 사용한 데스크톱 개발**과 Python 3이 필요합니다. 의존성 C 소스는 `vendor`에 버전을 고정해 포함했으므로 별도로 내려받지 않습니다.

저장소 폴더에서 PowerShell:

```powershell
cd backend
.\build.ps1 -Test
.\start-server.ps1
```

- 기본 주소: `http://127.0.0.1:8080`
- 상태 확인: `http://127.0.0.1:8080/health`
- 공용 DB: `backend/data/campus.sqlite3`
- 최초 실행 시 임의의 관리자 토큰을 `backend/data/admin-token.txt`에 생성합니다. 이 파일·DB는 Git에서 제외합니다.
- 종료: `Ctrl+C`. 같은 명령으로 재실행하면 DB·로그인 세션이 유지됩니다.
- `build.ps1 -Test`는 기존 C 단위 테스트·CLI 테스트와 실제 HTTP 서버 통합 테스트를 실행합니다. 서버 테스트에는 localhost 통신이 허용되어야 합니다.

한국 대학 목록 385개가 서버 시작 시 자동 등록됩니다. 별도의 PowerShell 창에서 검색할 수 있습니다.

```powershell
cd backend
$q = [uri]::EscapeDataString('서울')
Invoke-RestMethod "http://127.0.0.1:8080/api/universities?q=$q"
```

목록의 기준연도·통폐합 반영 범위는 [대학 목록 출처](catalog/README.md)를 참고하세요. 누락 학교는 기존 관리자 등록 API로 추가할 수 있습니다. 관리자 토큰을 프런트엔드 소스나 Git에 넣지 마세요. **소속 인증은 사진을 운영진이 직접 검토하는 방식**입니다. [사진 인증·운영진 검토 화면 안내](UNIVERSITY_VERIFICATION.md)를 따르세요.

## 2. 프런트엔드와 연결

`examples/api-client.js`를 ES 모듈로 가져오세요. 기본 허용 Origin은 `http://localhost:5173`입니다. 다른 개발 주소를 쓸 경우 서버 실행 전에 `$env:CR_ALLOWED_ORIGIN = 'http://localhost:3000'`처럼 **실제 프런트엔드 Origin 하나**를 지정합니다. 뒤에 `/`를 붙이지 않습니다.

```javascript
import { CampusRunnerApi } from './api-client.js';
const api = new CampusRunnerApi('http://127.0.0.1:8080');
const universities = await api.universities();
await api.register('달리는학생', 'long-random-password', universities[0].id);
// 이후에는 api.login(nickname, password)

const key = crypto.randomUUID(); // 한 번 생성하고 네트워크 재전송 시에도 유지
const result = await api.submitRun(key, [
  { timestamp: 1792623600, latitude: 37.500, longitude: 127 },
  { timestamp: 1792623660, latitude: 37.501, longitude: 127 },
]);
const rankings = await api.rankings(1792620000, 1792706400);
```

원시 GPS의 JS timestamp는 밀리초인 경우가 많으므로 `Math.floor(timestampMs / 1000)`으로 바꾸세요. 같은 초의 여러 표본은 대표 위치 하나로 정리합니다. UI는 `accepted`와 `reasons`로 GPS 판정을 표시하고 `counts_for_university`로 대학 점수 반영 여부를 확인합니다. 승인 전에도 개인 기록은 저장되지만 대학 점수에는 포함되지 않습니다. 가입·로그인·me의 `verification_status`를 표시하고 별도의 사진 업로드 화면을 연결하세요. API 클라이언트에 submitUniversityProof, universityVerifications, cancelUniversityVerification을 추가했습니다. 실패 응답은 `{ "error": "오류코드" }`이며 HTTP 401이면 재로그인하세요. 토큰은 메모리에만 유지되며 새로고침하면 다시 로그인해야 합니다.

자세한 요청·응답 규격은 [API 안내](API.md), 이전 파일 처리 방식은 [CLI 안내](CLI_REFERENCE.md)를 참고하세요. CLI의 TSV와 서버의 SQLite는 별도 저장소이며 서로 자동 동기화하지 않습니다. 팀 전체 집계에는 서버 API를 사용하세요.

## 3. 집계·공정성 규칙

- 모든 시간은 UTC Unix 초. 기간은 `[from,to)`이며 **러닝 시작 시각**으로 귀속합니다. 자정에 걸쳐도 시작 시점에 전체 거리를 반영합니다.
- 소속 사진 인증이 승인된 회원의 정상·양수 거리 기록만 대학 점수에 포함합니다. 합산 거리 / 기간 내 해당 기록이 있는 **고유 회원 수**가 1인당 평균 거리입니다. 미인증·등록만 한 회원과 제자리 기록은 분모에서 제외합니다. 승인하면 해당 회원의 과거 정상 기록도 반영하며, 승인 철회 시 다시 제외합니다.
- 거리를 서버에서 재계산해 1mm 단위 정수로 저장한 뒤 집계합니다. 평균 거리 내림차순, 동점은 1·1·3 공동 순위이며 대학 ID 순으로 표시합니다. 화면 반올림은 순위 판정 뒤에 하세요.
- 같은 회원의 같은 key·같은 좌표 재전송은 HTTP 200으로 기존 결과를 돌려주며 한 번만 반영합니다. key를 바꾸어 같은 좌표를 재제출하거나 기존 key에 다른 내용을 보내면 HTTP 409입니다.
- 같은 회원의 정상 러닝 시간 구간이 겹치면 HTTP 409입니다. 종료 시각과 다음 시작 시각이 같은 인접 기록은 허용합니다.
- 회원 대학은 로그인 계정에서 결정하며 러닝 요청의 `member_id`, `university_id`, `distance_m` 입력은 거부합니다. 기록이 생긴 뒤 대학 변경도 차단해 과거 점수 이동을 막습니다.
- 의심 기록은 원본 좌표·이유·정책 버전과 함께 보관하고, 해당 러닝 전체를 대학 점수에서 제외합니다. 본인만 개인 좌표를 조회할 수 있습니다.

## 4. 비정상 기록 정책 v1

| 코드 | 비트 | 조건 |
| --- | --- | --- |
| fast_segment | 1 | 연속 좌표 구간 속도 > 10m/s |
| fast_window | 2 | 표본 시점의 직전 30초 평균 속도 > 6m/s |
| fast_average | 4 | 전체 평균 속도 > 6m/s |
| gps_gap | 8 | 연속 GPS 표본 간격 > 120초 |
| long_duration | 16 | 전체 러닝 시간 > 6시간 |

30초 경계는 구간 내 일정 속도를 가정해 보간합니다. 모든 조건은 초과일 때 적용합니다. 30초 미만 러닝에는 구간 속도와 전체 평균을 적용합니다. 시간이 증가하지 않거나 좌표 범위·형식이 잘못되거나 종료 시각이 서버 현재 시각보다 5분 넘게 미래이면 저장하지 않고 HTTP 400을 반환합니다.

이 기준은 이동 수단을 확정하는 모델이 아닙니다. 느린 자전거·위치 조작을 완벽히 구분할 수 없고 빠른 정상 러닝이 의심 판정될 수 있습니다. 실제 GPS 표본으로 기준을 조정해야 합니다. 기본값은 `cr_default_policy()`에서 관리하며 정책을 바꾸면 서버 저장의 policy_version과 문서도 함께 갱신하세요. 기존 저장 기록은 자동 재판정하지 않습니다. GPS 정확도·가속도 센서 기반 판단은 이번 범위에 포함하지 않습니다.

## 5. 저장·인증

- SQLite WAL, 외래 키·유일성 제약, prepared statement, 5초 busy timeout, `BEGIN IMMEDIATE` 트랜잭션을 사용합니다. 읽기·쓰기 요청마다 별도 연결을 사용하며 여러 프로세스에서도 같은 로컬 DB의 중복 방지 제약이 적용됩니다.
- 대학 점수는 저장된 정상 기록을 SQL로 집계합니다. 별도 합산 카운터를 갱신하는 방식에서 생길 수 있는 이중 반영·증분 누락을 피합니다.
- 비밀번호: 사용자별 16바이트 무작위 salt, PBKDF2-HMAC-SHA256 600,000회. Windows는 BCrypt, Linux는 OpenSSL을 사용합니다.
- 세션: 암호학적 난수 32바이트, 응답에 한 번 전달하는 Bearer 토큰. DB에는 SHA-256 해시만 저장합니다. 7일 만료, 로그아웃 즉시 해당 토큰 폐기, 회원당 최근 8개 세션 유지.
- 가입·로그인은 원격 IP 기준 60초에 30회로 제한합니다. X-Forwarded-For를 신뢰하지 않으므로 리버스 프록시를 쓰면 이 제한은 프록시 IP에 합산됩니다. 여러 사용자의 공개 서비스에는 프록시에서 실제 IP 기준 제한도 구성하세요.
- JSON 본문 최대 2MiB, GPS 최대 20,000개, 인증 사진 최대 5MiB, 요청 읽기 제한 15초, JSON 깊이 제한 32입니다. 중복 JSON 키·NUL·잘못된 UTF-8 이름을 차단합니다.
- DB 스키마 버전 2입니다. 버전 1은 회원·토큰·기록을 보존해 자동 업그레이드하되 기존 회원의 소속도 사진 승인 전까지 미인증으로 취급합니다. 더 높은 버전의 DB는 열지 않습니다. 기존 TSV 사용자는 자동 가져오지 않습니다.

## 6. 여러 휴대폰·배포

같은 네트워크에서 PC에 연결하려면 `./start-server.ps1 -Listen '0.0.0.0:8080'`으로 실행하고 프런트엔드 API 주소를 `http://PC의LAN주소:8080`으로 바꿉니다. 실제 접속 허용은 PC 방화벽과 네트워크 설정에 따릅니다. 이 저장소는 방화벽을 자동 변경하지 않습니다.

모바일 브라우저의 GPS는 일반적으로 HTTPS가 필요합니다. 로컬 호스트 외의 실제 휴대폰 데모·공개 배포에서는 **프런트엔드와 API에 HTTPS를 구성**하세요. API 자체는 HTTP이며 `deploy/Caddyfile`에 HTTPS 리버스 프록시 예제를 제공합니다. 도메인·서버·인증서는 실행 환경에 맞춰 지정해야 합니다. 공유기 외부 공개나 클라우드 배포는 자동 수행하지 않았습니다.

Docker가 있는 환경에서는:

```sh
export CR_ADMIN_TOKEN="$(openssl rand -hex 32)"
export CR_ALLOWED_ORIGIN="https://your-frontend.example.com"
docker compose up --build -d
```

컨테이너는 non-root 사용자로 동작하고 DB는 `campus-data` 볼륨에 유지합니다. 호스트 포트는 127.0.0.1에만 공개하므로 HTTPS 프록시를 거쳐 접근합니다. `Dockerfile`은 빌드 과정에서 테스트도 실행합니다. 현재 작업 PC에는 Docker가 없어 이미지 빌드·배포 자체는 검증하지 않았습니다.

대학 소속은 사용자가 선택한 뒤 학생증·합격증 등의 사진을 운영진이 검토해 승인합니다. 자동 문서 진위·실명 인증을 제공하는 것은 아닙니다. 비밀번호 복구 이메일과 실제 도메인 배포는 별도 연동이 필요합니다.

## 7. CMake / CI

```sh
# Linux: C11 compiler, CMake, Python 3, OpenSSL development headers 필요
cmake -S backend -B backend/build-cmake -DCMAKE_BUILD_TYPE=Debug
cmake --build backend/build-cmake --config Debug
ctest --test-dir backend/build-cmake -C Debug --output-on-failure
```

Windows에서 한글 경로에 있는 MSVC CMake 디버그 파일 생성 문제가 있어 이 프로젝트 경로에서는 `build.ps1`을 권장합니다. CMake는 한글이 없는 빌드 경로를 사용하세요. GitHub Actions는 Windows·Linux에 빌드·테스트를 설정합니다. CI 결과는 원격 푸시 후 확인할 수 있습니다.

## 8. 백업

```powershell
python tools\backup.py data\campus.sqlite3 backups\campus-20261022.sqlite3
```

SQLite online backup으로 커밋된 WAL 데이터까지 포함하고 integrity_check를 실행합니다. **인증 서류 사진은 백업에서 제거**하며 복원본의 대기 신청은 재제출 상태로 바뀝니다. 이미 있는 대상 파일은 덮어쓰지 않습니다. 복원 시 서버를 종료하고 현재 DB와 WAL·SHM을 함께 보관한 뒤 백업 파일을 DB 경로로 배치하세요. DB·백업에는 개인 GPS가 있으므로 접근 권한과 보관 기간을 관리하세요.

## 9. 테스트

- 기존 C 단위 테스트: 등록·거리 계산·비정상 판정·UTF-8·파일 저장 검증.
- CLI 통합 테스트: 5개.
- HTTP 통합 테스트: 20개. 인증·권한·대학 검색·여러 회원 합산·동시 제출·사진 업로드·수동 승인/반려/철회·사진 삭제·동시 검토·v1 DB 마이그레이션·서류 사진을 제외한 백업까지 확인합니다.

외부 라이브러리의 버전·라이선스·원본 다운로드 해시는 [vendor 안내](vendor/README.md)와 manifest.json에 있습니다. 저장소의 MIT 라이선스와 별도로 각 라이브러리 고지를 유지합니다.
