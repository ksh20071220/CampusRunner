# 휴대폰 실기기 테스트: C 서버 + 화면 + HTTPS 임시 주소(Cloudflare 터널)를 한 번에 띄운다.
# 사용법: PowerShell에서 CampusRunner 폴더로 이동한 뒤  .\phone-test.ps1
# 끝낼 때: 이 스크립트가 연 창 3개(터널, 서버, 화면)를 닫는다.
# 자세한 안내: PHONE_TEST_KO.md
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$work = Join-Path $root 'backend\data'          # .gitignore에 들어 있는 폴더
New-Item -ItemType Directory -Force $work | Out-Null

if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) {
    throw '5173 포트를 이미 쓰고 있어요. npm run dev 창을 먼저 닫고(Ctrl+C) 다시 실행하세요.'
}
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
    throw '8080 포트를 이미 쓰고 있어요. 켜 둔 서버 창을 먼저 닫고 다시 실행하세요.'
}

# 1) C 서버 빌드 (처음 한 번)
if (-not (Test-Path (Join-Path $root 'backend\build\campus_server.exe'))) {
    Write-Host '[1/4] C 서버를 빌드하는 중...'
    & (Join-Path $root 'backend\build.ps1')
}

# 2) Cloudflare 터널 프로그램 (처음 한 번 내려받기)
$cloudflared = Join-Path $work 'cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
    Write-Host '[2/4] cloudflared 내려받는 중...'
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflared -UseBasicParsing
}

# 3) 터널을 열고 HTTPS 주소 받기
Write-Host '[3/4] HTTPS 임시 주소를 만드는 중...'
$log = Join-Path $work 'tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
Start-Process $cloudflared -ArgumentList 'tunnel', '--url', 'http://localhost:5173', '--no-autoupdate', '--logfile', "`"$log`""
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    try {
        $text = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object System.IO.StreamReader($text)
        $content = $reader.ReadToEnd(); $reader.Close()
        if ($content -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] }
    } catch { }
}
if (-not $url) { throw "터널 주소를 받지 못했어요. $log 를 확인하세요." }

# 4) 서버와 화면을 각각 새 창에서 실행 (둘 다 이 HTTPS 주소를 허용/사용)
Write-Host '[4/4] 서버와 화면을 실행하는 중...'
$env:CR_ALLOWED_ORIGIN = $url
$env:VITE_API_BASE_URL = $url
Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $root 'backend\start-server.ps1')`""
Start-Process powershell -WorkingDirectory (Join-Path $root 'frontend') -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'npx vite --config vite.phone.config.js'

try { Set-Clipboard $url } catch { }
Write-Host ''
Write-Host '휴대폰에서 이 주소를 여세요 (클립보드에도 복사됨):' -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host '처음 10~20초는 접속이 안 될 수 있어요. 잠시 뒤 새로고침하세요.'
