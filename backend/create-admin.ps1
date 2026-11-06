$ErrorActionPreference = 'Stop'
$backend = $PSScriptRoot
$exe = Join-Path $backend 'build\campus_server.exe'
$database = Join-Path $backend 'data\campus.sqlite3'
$privateFolder = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CampusRunner'
$credentialFile = Join-Path $privateFolder 'admin-account.txt'

if (-not (Test-Path -LiteralPath $exe)) { & (Join-Path $backend 'build.ps1') }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $database), $privateFolder | Out-Null

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
$bytes = New-Object byte[] 24
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')

# Reserve an empty file exclusively, apply its private ACL, then persist the secret
# before creating the database account. Never overwrite a prior credential file.
$file = [IO.File]::Open($credentialFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
$file.Dispose()
$startingProvision = $false
try {
    Set-Acl -LiteralPath $credentialFile -AclObject $acl
    [IO.File]::WriteAllText($credentialFile, "Username: admin`r`nPassword: $password`r`n", [Text.Encoding]::ASCII)
    $startingProvision = $true
    $password | & $exe --create-admin $database admin
    if ($LASTEXITCODE -ne 0) {
        $startingProvision = $false
        throw "Administrator was not created (exit code $LASTEXITCODE)."
    }
} catch {
    if (-not $startingProvision) { Remove-Item -LiteralPath $credentialFile }
    throw
}
Write-Host "Private administrator credentials: $credentialFile"
