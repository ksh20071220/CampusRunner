# 휴대폰 실기기 테스트 (Windows)

명령 하나로 **C 서버 + 화면 + HTTPS 임시 주소**를 띄워, 같은 Wi-Fi가 아니어도 휴대폰에서 앱을 열 수 있다.
휴대폰 위치(GPS) 권한은 HTTPS 주소에서만 받을 수 있어서 이 방법이 필요하다.

## 준비 (처음 한 번)

1. Visual Studio Build Tools (C 컴파일러)
   ```
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
2. Node.js LTS, 그리고 `frontend` 폴더에서 `npm install`
3. PowerShell 스크립트 실행 허용: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

## 실행

```
cd CampusRunner
.\phone-test.ps1
```

1. 처음에는 C 서버 빌드와 `cloudflared.exe` 다운로드 때문에 몇 분 걸린다. (`backend/data/`에 저장되며 Git에 올라가지 않는다.)
2. 창이 2개(서버, 화면) 더 열리고, 처음 창에 초록색 `https://○○○.trycloudflare.com` 주소가 나온다. 클립보드에도 복사된다.
3. 휴대폰 브라우저에서 그 주소를 연다. 10~20초 동안은 접속이 안 될 수 있다.
4. 실제 서버라서 회원가입부터 한다. 기록은 내 PC의 `backend/data/campus.sqlite3`에 저장된다.

## 주의

- 실행 전에 `npm run dev`나 서버 창을 닫는다 (5173, 8080 포트를 쓴다).
- 테스트하는 동안 PC와 열린 창들을 끄지 않는다. PC가 꺼지면 휴대폰에서 접속할 수 없다.
- 주소는 실행할 때마다 바뀐다. 바뀐 주소로 들어가 다시 로그인하면 기록은 그대로 있다.
- Cloudflare 무료 임시 터널이라 테스트·시연용이다. 상시 서비스용 주소가 아니다.
- 홈 화면 추가: 안드로이드 크롬 ⋮ → 앱 설치 / 아이폰 사파리 공유 → 홈 화면에 추가

## 구성

| 파일 | 역할 |
| --- | --- |
| `phone-test.ps1` | 서버 빌드·실행, cloudflared 터널, 화면 실행을 순서대로 처리 |
| `frontend/vite.phone.config.js` | 기본 `vite.config.js`에 터널 주소 허용과 `/api` → `127.0.0.1:8080` 전달을 더한 설정 |

화면과 API가 같은 HTTPS 주소를 쓰므로 서버의 `CR_ALLOWED_ORIGIN`과 화면의 `VITE_API_BASE_URL`을 스크립트가 그 주소로 맞춘다.
