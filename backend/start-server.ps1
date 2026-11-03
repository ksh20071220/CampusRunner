param([string]$Listen = '127.0.0.1:8080', [string]$Database = '')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath build\campus_server.exe)) { & .\build.ps1 }
    New-Item -ItemType Directory -Force data | Out-Null
    if (-not $Database) { $Database = Join-Path $PSScriptRoot 'data\campus.sqlite3' }
    if (-not $env:CR_ADMIN_TOKEN) {
        $tokenPath = Join-Path $PSScriptRoot 'data\admin-token.txt'
        if (Test-Path -LiteralPath $tokenPath) {
            $env:CR_ADMIN_TOKEN = [System.IO.File]::ReadAllText($tokenPath).Trim()
        } else {
            $bytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            $env:CR_ADMIN_TOKEN = -join ($bytes | ForEach-Object { $_.ToString('x2') })
            [System.IO.File]::WriteAllText($tokenPath, $env:CR_ADMIN_TOKEN, [System.Text.Encoding]::ASCII)
        }
        Write-Host 'Local administrator token: backend/data/admin-token.txt (keep private).'
    }
    Write-Host "Health check: http://$Listen/health"
    Write-Host 'Stop with Ctrl+C.'
    & .\build\campus_server.exe $Database $Listen
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
} finally { Pop-Location }
