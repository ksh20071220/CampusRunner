# 소속 대학 사진 인증 운영

## 이용자 흐름

1. 회원 가입 시 한국 대학 목록을 검색해 소속 대학을 선택합니다.
2. 학생증·합격증·재학증명서 등의 JPEG/PNG 사진을 제출합니다.
3. 상태가 `pending`(검토 중)으로 표시됩니다. 운영진이 사진을 직접 확인합니다. OCR·AI 자동 승인은 사용하지 않습니다.
4. 승인 시 `approved`, 반려 시 `rejected`와 사유가 표시됩니다. 반려 후 다시 제출할 수 있습니다.
5. 미인증·검토 중에도 개인 러닝을 저장할 수 있습니다. **승인되면 해당 회원의 기존 정상 기록도 기간 규칙에 따라 대학 점수에 반영**됩니다. 승인 철회 시 다시 제외되며 개인 기록은 유지됩니다.

가입·로그인·GET /api/me에 `verification_status`, `university_verified`가 추가됩니다. 초기 상태는 `not_submitted`입니다. 기타 상태는 cancelled(제출 취소·학교 변경), expired(미검토 만료), revoked(승인 철회)입니다.

## 제출 안내·동의 문구 예시

> 소속 대학 확인을 위해 학생증·합격증·재학증명서 사진을 제출해 주세요. 학교명과 소속 근거를 읽을 수 있게 하고, 주민등록번호·주소·전화번호·학번·바코드·QR 등 확인에 필요 없는 정보는 가려 주세요. 운영진이 직접 확인하며 사진은 검토 완료·제출 취소 즉시 또는 미검토 7일 후 삭제합니다. 이 용도의 사진 제출과 운영진 열람에 동의합니다.

실제 서비스의 운영 주체·연락처 등 안내는 운영진이 정해 프런트엔드에 함께 표시하세요. 동의 체크 없이 업로드하지 않도록 하고, 사용자가 동의한 경우에만 `X-Verification-Consent: 1`을 전송합니다. 서류 사진만으로 실제 사람의 신원까지 자동 확인했다고 표시하지 마세요.

- JPEG 또는 PNG만 지원합니다. HEIC·PDF·SVG는 받지 않습니다. 최대 5MiB, 가로·세로 각각 12,000px 이하, 4천만 픽셀 이하입니다.
- 서버는 MIME, 시그니처와 구조·크기를 검사합니다. 이미지 전체 디코딩·문서 진위 판정은 자동 수행하지 않습니다. 운영진이 화면에서 읽을 수 없는 자료는 반려하세요.
- 회원당 검토 대기 1건, 최근 24시간 최대 제출 5건입니다. 이미 승인된 회원은 새 자료를 제출할 수 없습니다.
- 학교를 바꾸면 기존 대기/승인은 무효화되고 사진이 삭제됩니다. 러닝 기록이 있는 회원의 학교 변경은 기존 정책대로 차단합니다.

## 운영진 검토 화면

서버 실행 후 별도 터미널에서:

```powershell
cd backend
python -m http.server 5173 --bind 127.0.0.1 --directory examples
```

브라우저에서 **http://localhost:5173/verification-admin.html**을 엽니다. API 주소, 관리자 토큰, 담당자 이름을 입력한 뒤 검토 대기 목록을 불러옵니다. 담당자 이름은 공동 관리자 토큰을 사용하는 팀의 감사 기록용 표시이며 별도 운영자 계정 인증은 아닙니다.

신청을 클릭하면 닉네임·선택 대학·서류 종류·사진을 확인할 수 있습니다. 사진이 실제 표시되기 전에는 승인 버튼이 활성화되지 않습니다. 학교명·소속 근거를 사람이 확인한 뒤 승인하거나 구체적 사유를 적어 반려합니다. 반려 사유는 이용자에게 공개됩니다. 승인된 항목을 잘못 처리했다면 상태를 승인으로 바꾸어 조회하고 승인 철회할 수 있습니다.

토큰은 서버 `data/admin-token.txt` 또는 배포 환경의 CR_ADMIN_TOKEN입니다. URL에 토큰을 넣지 않습니다. 검토 화면은 토큰·사진을 localStorage/sessionStorage에 보관하지 않으며 사진은 인증된 fetch로 받아 임시 blob URL로 표시합니다. 창을 닫거나 다른 사진을 선택하면 blob URL을 해제합니다. 열람한 사진을 개인 기기에 따로 저장하지 마세요.

기본 CORS 허용 Origin은 http://localhost:5173입니다. 다른 호스트·포트에서 검토 화면을 제공하면 서버 CR_ALLOWED_ORIGIN을 맞추세요. 이 화면은 개발·팀 운영 예제이며 인터넷 공개에는 HTTPS·관리자 토큰 접근 통제를 구성해야 합니다.

## API

| 메서드 | 경로 | 권한 | 기능 |
| --- | --- | --- | --- |
| POST | /api/me/university-verifications | 회원 | 바이너리 이미지 제출, 201 |
| GET | /api/me/university-verifications | 회원 | 본인 최근 신청 최대 20건 |
| GET | /api/me/university-verifications/{id}/image | 본인 | 대기 중 원본 열람 |
| POST | /api/me/university-verifications/{id}/cancel | 본인 | 대기 중 신청 취소, 본문 {} |
| GET | /api/admin/university-verifications?status=pending | 관리자 | 오래된 순 최대 100건 |
| GET | /api/admin/university-verifications/{id}/image | 관리자 | 사진 열람 |
| POST | /api/admin/university-verifications/{id}/decision | 관리자 | 승인·반려 |
| POST | /api/admin/university-verifications/{id}/revoke | 관리자 | 승인 철회 |

업로드는 JSON·multipart가 아닌 **사진 파일 자체**를 body에 보냅니다. 필수 헤더:

```text
Authorization: Bearer <회원 토큰>
Content-Type: image/jpeg 또는 image/png
X-Document-Type: student_card | admission_letter | enrollment_certificate | other
X-Verification-Consent: 1
```

검토 요청 본문:

```json
{"decision":"approved","reviewer":"검토 담당자","reason":"학교명 및 서류 확인"}
```

반려는 decision을 rejected로 바꾸고 이유를 씁니다. reason은 1~512 UTF-8 바이트, reviewer는 1~95바이트입니다. 승인 철회는 `{ "reviewer": "담당자", "reason": "오승인 정정" }`입니다. 두 담당자가 동시에 처리해도 첫 처리만 적용하며 후속 처리는 409입니다.

신청 JSON 예:

```json
{"id":1,"member_id":1,"university_id":123456,"document_type":"student_card","status":"pending","submitted_at":1792623600,"expires_at":1793228400,"reviewed_at":null,"reason":"","image_available":true,"nickname":"러너","university_name":"서울대학교"}
```

사진이 없는 과거 신청의 image 경로는 410 image_deleted입니다. 다른 회원은 404, 관리자 토큰이 없으면 관리자 경로는 403입니다. 신청 목록에는 이미지 bytes·개인 서류 내용·해시를 포함하지 않습니다. 사진 응답은 no-store·nosniff이며 공개 정적 경로를 만들지 않습니다.

추가 오류: invalid_document_type, verification_consent_required, jpeg_or_png_required, image_too_large, invalid_image, incomplete_image, already_verified, verification_already_pending, verification_upload_limit, invalid_review, verification_not_pending, invalid_verification_status.

## 보관·마이그레이션

이미지는 SQLite의 보호된 BLOB으로 저장합니다. 파일명·업로드 경로를 입력받지 않습니다. 승인·반려·취소·철회 시 활성 이미지 값을 제거하며, 미검토 7일이 지나면 expired 처리합니다. 만료 정리는 시작·매분·API 접근 시 수행합니다. 서버가 중지돼 있으면 다음 실행 시 정리합니다. 신청 상태·사유·처리 담당자·처리 시간의 감사 기록은 유지합니다.

SQLite는 WAL을 사용하므로 삭제가 저장 장치의 모든 과거 블록까지 즉시 물리 소거한다는 보장은 하지 않습니다. 제공된 backup.py는 **인증 사진을 백업에서 제외하고 압축 정리**합니다. 복원본의 대기 신청은 재제출이 필요하도록 cancelled 상태가 됩니다. 외부 디스크 스냅샷·이전 백업을 운영진이 별도로 만들었다면 그 사본의 보관·삭제도 관리해야 합니다.

DB 버전은 1에서 2로 자동 업그레이드합니다. 기존 회원·토큰·러닝·대학 ID를 보존하지만, 이전의 자기 신고 소속을 인증 완료로 간주하지 않습니다. **기존 회원도 사진 승인 전까지 대학 점수에서 제외**됩니다. 사용자에게 인증 절차 변경을 안내하세요. 업그레이드 전 백업을 권장하며 이전 서버 실행 파일은 버전 2 DB를 열지 않습니다.
