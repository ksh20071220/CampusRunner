# CampusRunner
프밍기 팀플 - 제일 안뛰는 놈들이 만드는 달리기 어플

## C HTTP 백엔드

회원·대학 등록, 로그인 인증, 공용 SQLite 저장, GPS 기록 검증, 대학별 합산·평균·순위를 제공합니다.
실행과 팀원 연결 방법은 [백엔드 안내](backend/README.md), HTTP 계약은 [API 안내](backend/API.md)를 참고하세요.

PowerShell에서 backend 폴더로 이동해 .\build.ps1 -Test 후 .\start-server.ps1을 실행합니다.

한국 대학 선택 목록 385개를 내장하고, 학생증·합격증 사진을 운영진이 직접 확인하는 소속 인증을 지원합니다. [대학 목록 출처](backend/catalog/README.md)와 [사진 인증·검토 화면 안내](backend/UNIVERSITY_VERIFICATION.md)를 참고하세요. 대학 점수는 소속 승인 회원의 정상 기록만 반영합니다.
