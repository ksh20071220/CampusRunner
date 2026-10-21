# CampusRunner 대학 챌린지 C 백엔드

담당 범위: 회원·소속 대학 등록, 대학별 거리 합산, 참여자 1인당 평균 거리, 기간별 대학 순위, 비정상 GPS 기록 탐지.

제안서의 **웹에서 GPS 파일 수집 → PC에서 C로 계산·검증 → 결과 반영** 흐름에 맞춘 C11 라이브러리와 CLI입니다. CLI 결과는 JSON이므로 UI 담당자가 파일로 읽거나 추후 서버에서 연결할 수 있습니다. HTTP 서버, 로그인·인증, 모바일 GPS 수집과 지도 화면은 포함하지 않습니다. 닉네임·대학 등록은 프로필 등록이며 계정 인증 기능과 구별됩니다.

## Windows 실행

Visual Studio 또는 Build Tools의 **C++를 사용한 데스크톱 개발** 구성 요소가 필요합니다. 현재 PC의 MSVC로 빌드·테스트했습니다. 테스트에는 Python 3도 사용합니다.

저장소 루트에서 PowerShell 실행:

```powershell
cd backend
.\build.ps1 -Test

# 대학 → 회원 → GPS 기록 순서로 등록
.\build\campus_runner.exe campus.tsv university-add 1 "서울대학교"
.\build\campus_runner.exe campus.tsv university-add 2 "연세대학교"
.\build\campus_runner.exe campus.tsv member-add 101 "달리는학생" 1
.\build\campus_runner.exe campus.tsv run-import run-101-001 101 examples\normal.csv
.\build\campus_runner.exe campus.tsv rankings 1792620000 1792706400

# 의심 기록도 보관하지만 대학 점수에서는 제외
.\build\campus_runner.exe campus.tsv run-import run-101-002 101 examples\suspicious.csv
.\build\campus_runner.exe campus.tsv runs
```

다시 실행해도 `campus.tsv`에서 회원과 기록을 읽습니다. 예제 명령은 새 데이터 파일에서 한 번 실행하세요. 같은 대학 ID·이름, 회원 ID·닉네임, 러닝 key를 다시 등록하면 `duplicate` 오류가 납니다. 닉네임과 대학 이름의 중복 비교는 대소문자를 구분하는 UTF-8 바이트 비교입니다. 앞뒤 공백이나 유니코드 표기 차이를 정규화하지 않습니다.

`build.ps1`은 개발자 명령 프롬프트를 직접 열지 않아도 MSVC를 찾습니다. `-Test` 없이 실행하면 프로그램만 빌드합니다. Windows에서도 한글 인수·파일 경로·JSON 출력을 UTF-8로 처리합니다. GPS CSV 파일은 **UTF-8 BOM 없이** 저장하세요.

현재 PC에서 CMake + MSVC는 한글이 포함된 빌드 경로의 디버그 파일 생성 시 오류가 발생했습니다. 이 저장소 경로에서는 위의 build.ps1을 사용하세요. CMake 빌드와 CTest는 한글이 없는 별도 경로에서 통과했습니다.

## CMake / Linux / macOS

```sh
cmake -S backend -B backend/build-cmake -DCMAKE_BUILD_TYPE=Debug
cmake --build backend/build-cmake --config Debug
ctest --test-dir backend/build-cmake -C Debug --output-on-failure
```

C11 컴파일러와 CMake 3.16 이상이 필요합니다. Python 3이 발견되면 CTest에 CLI 통합 테스트도 등록됩니다. Linux·macOS용 코드와 CI 설정을 제공하며, 로컬 실행 검증은 Windows에서 수행했습니다.

## 명령 계약

모든 명령의 형식은 `campus_runner <데이터파일> <명령> <인수...>`입니다.

| 명령 | 인수 | 기능 |
| --- | --- | --- |
| `university-add` | `id name` | 대학 등록 |
| `member-add` | `id nickname university-id` | 존재하는 대학에 회원 등록 |
| `universities` | 없음 | 대학 목록 JSON |
| `members` | 없음 | 회원 목록 JSON |
| `run-import` | `key member-id gps.csv` | GPS 검증·거리 계산·기록 저장 |
| `runs` | 없음 | 정상·의심 기록과 판정 수치 조회 |
| `rankings` | `from-epoch to-epoch` | 기간별 대학 순위 JSON |

성공 시 종료 코드 `0`, 실패 시 `1`, 기본 사용법 출력 시 `2`입니다. 성공 결과는 stdout, 오류 JSON은 stderr입니다. `run-import`가 의심 기록을 저장한 경우에도 처리는 성공이므로 종료 코드 `0`이며 `accepted:false`입니다. 입력 자체가 잘못된 경우에는 저장하지 않습니다.

오류 값: `invalid_input`, `not_found`, `duplicate`, `capacity_exceeded`, `io_error`.

대학 ID·회원 ID는 1 이상 2,147,483,647 이하 정수입니다. 이름·닉네임은 최대 95바이트, 러닝 key는 최대 63바이트입니다. 한글은 보통 글자당 3바이트를 사용합니다. 빈 문자열·탭·개행·제어 문자는 허용하지 않습니다.

## GPS 담당자와 연결

GPS CSV 형식은 다음과 같습니다. 헤더와 열 순서를 지켜야 합니다.

```csv
timestamp,latitude,longitude
1792623600,37.500000,127.000000
1792623660,37.501000,127.000000
1792623720,37.502000,127.000000
```

- `timestamp`: UTC Unix **초**, 소수점 없는 정수. JavaScript `Date.now()`는 밀리초이므로 `Math.floor(Date.now() / 1000)`으로 바꾸세요. 같은 초에 여러 위치가 있으면 GPS 담당자가 대표 표본을 선택해야 합니다.
- 위도 `[-90,90]`, 경도 `[-180,180]`, 유한한 숫자만 허용합니다.
- 최소 2개, 최대 100,000개 좌표이며 시간이 반드시 증가해야 합니다.
- 좌표 사이 거리는 Haversine 공식(지구 반지름 6,371,000m)으로 계산합니다. 화면에서 계산한 거리를 신뢰해 입력받는 대신 좌표에서 다시 계산합니다.
- 러닝 key는 클라이언트가 한 번 생성하고 재전송 시에도 유지합니다. 이미 존재하는 key는 다른 회원이 사용해도 중복 오류입니다.

JS 측 전달 예:

```javascript
const csv = "timestamp,latitude,longitude\n" + samples.map(sample =>
  `${Math.floor(sample.timestampMs / 1000)},${sample.latitude},${sample.longitude}`
).join("\n") + "\n";
// CSV 다운로드 후 C CLI로 처리. 브라우저에서 로컬 exe를 직접 실행할 수는 없습니다.
```

## 집계 규칙

1. `flags == 0`이고 거리가 0보다 큰 기록만 반영합니다. 제자리 기록은 활동 참여자로 세지 않습니다.
2. 기간은 UTC `[시작, 종료)`이며 **러닝 시작 시각**으로 귀속합니다. 시작 경계는 포함, 종료 경계는 제외합니다. 자정을 넘긴 러닝도 시작일에 전부 반영하며 거리를 일별로 나누지 않습니다.
3. 대학 합산 거리 = 기간 내 정상 기록 거리 합계.
4. 참여자 수 = 기간 내 정상 기록이 있는 고유 회원 수. 같은 회원의 여러 러닝은 거리에는 모두 합산하고 인원에는 한 번만 셉니다. 등록만 한 회원은 분모에서 제외합니다.
5. 1인당 평균 거리 = 합산 거리 / 참여자 수. 참여자가 없으면 0m입니다.
6. 평균 거리 내림차순으로 순위를 매깁니다. 계산된 double 값이 정확히 같으면 공동 순위(1, 1, 3)이며 표시 순서는 대학 ID 오름차순입니다. JSON에 반올림된 값이 같아도 내부 값이 다르면 순위가 다를 수 있습니다.
7. 활동이 없는 대학도 목록에 포함합니다. 회원 대학 변경·삭제 기능은 이번 범위에 포함하지 않아 과거 기록의 귀속을 유지합니다.

## 비정상 기록 판정

기본 정책은 `cr_default_policy()`에 정의됩니다. 팀 실측을 바탕으로 조정할 **초기 휴리스틱**이며 실제 이동 수단을 확정하지 않습니다. 느린 자전거는 통과할 수 있고 빠른 정상 러닝은 의심 판정될 수 있습니다.

| 플래그 | 값 | 기본 판정 조건 |
| --- | --- | --- |
| `CR_FAST_SEGMENT` | 1 | 연속 GPS 좌표 사이 속도 > 10m/s (36km/h) |
| `CR_FAST_WINDOW` | 2 | 표본 시점에서 직전 30초 평균 속도 > 6m/s (21.6km/h) |
| `CR_FAST_AVERAGE` | 4 | 전체 거리 / 전체 경과 시간 > 6m/s (21.6km/h) |

값은 비트 OR로 합쳐집니다. 예를 들어 `6`은 구간 평균과 전체 평균 모두 초과했다는 뜻입니다. 좌표 급변은 구간 과속으로 감지합니다. 30초 경계가 표본 사이에 있으면 그 구간에서 일정 속도로 이동했다고 가정하여 누적 거리를 보간합니다. 30초 미만 기록은 전체 평균·구간 속도로 판단합니다. 정지 시간도 경과 시간에 포함하며 자동 일시정지는 하지 않습니다.

의심 구간이 하나라도 있으면 **해당 러닝 전체를 대학 점수에서 제외**합니다. 정상 구간만 잘라 붙이는 방식은 채택하지 않았습니다. `runs`에는 검토할 수 있도록 의심 기록과 속도 수치를 남깁니다. 원본 GPS는 CSV 담당 측에서 보관해야 합니다. 이 저장소에는 좌표 원본을 복사하지 않습니다. 정책 변경은 향후 제출에 적용되며 기존 기록을 자동 재판정하지 않습니다.

## C 모듈 연결

`include/campus_runner.h`가 공개 인터페이스입니다. 다른 C 담당자는 `campus_runner_core`에 연결하고 아래 순서로 호출하면 됩니다.

```c
CrStore *store = calloc(1, sizeof(*store)); /* 큰 구조체이므로 힙에 할당 */
CrStatus status = cr_load(store, "campus.tsv");
if (status != CR_OK && status != CR_NOT_FOUND) { /* 오류 처리 */ }
/* cr_add_university / cr_add_member */
CrRun report;
status = cr_submit_run(store, "unique-key", member_id, points, point_count,
                       NULL, &report); /* NULL이면 기본 정책 */
if (status == CR_OK) {
    status = cr_save(store, "campus.tsv");
    /* 저장 성공을 확인한 뒤 호출 측에 성공 응답 */
}
free(store);
```

집계에는 `cr_rankings()`를 사용합니다. 수정 함수는 메모리에만 반영하므로 저장 실패 시 호출 측은 기존 파일을 다시 로드하거나 변경을 폐기해야 합니다. 구조체 필드를 임의로 바꾸지 말고 등록·제출 함수를 통해 갱신하세요.

## 저장·운영 범위

- 버전 1 TSV 스냅샷을 임시 파일에 기록한 뒤 같은 경로의 기존 파일을 교체합니다. 손상 파일을 읽으면 전체 로드를 실패시키며 기존 메모리 상태를 보존합니다. 테스트용 파일을 실제 데이터로 사용하지 마세요.
- 단일 로컬 프로세스를 위한 저장 방식입니다. 여러 실행이 같은 데이터 파일을 동시에 갱신하면 덮어쓰기가 발생할 수 있으므로 호출 측에서 **로드 → 변경 → 저장 전체를 직렬화**해야 합니다. 임시 파일 독점 생성만으로 전체 작업의 동시성을 보장하지 않습니다.
- 중단 후 `.tmp` 파일이 남았다면 실행 중인 작성자가 없는지 확인하고 별도 보관·확인 후 정리하세요. 프로그램은 기존 임시 파일을 덮어쓰지 않고 오류를 반환합니다.
- 로컬 TSV는 신뢰하는 저장 파일이며 직접 편집을 통한 점수 위변조를 방어하지 않습니다. 실제 서비스에는 인증, 회원 본인 확인, 대학 인증, 서버 권한 검증, 트랜잭션 DB가 추가로 필요합니다.
- 기본 용량: 대학 128개, 회원 4,096명, 러닝 16,384건. 한계에 도달하면 오류를 반환합니다. 큰 규모에서는 DB 집계로 옮겨야 합니다.

## 검증

`tests/test_backend.c`: 등록 중복·참조 검증, 거리 계산, 시간 역전·동일 시각·NaN·좌표 범위 오류, 순간 과속·구간 평균·전체 평균, 날짜변경선, 불규칙 GPS 간격, 정상 기록만 합산, 고유 참여자, 기간 경계, 공동 순위, 파일 재저장, 손상 파일·저장 실패 처리.

`tests/test_cli.py`: 별도 프로세스 재실행을 통한 영속성, JSON 파싱·문자열 escaping, 중복 제출, 의심 기록 제외, 잘못된 CSV 시 기존 파일 보존, 한글 닉네임·대학·파일 경로. 테스트는 임시 폴더에서 실행합니다.
