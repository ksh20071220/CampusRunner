param([switch]$Test)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools with Desktop development with C++ is required.' }
    $vs = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw 'MSVC C compiler was not found.' }
    $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
    New-Item -ItemType Directory -Force build | Out-Null
    # One cmd process preserves the compiler environment. No files are deleted.
    $compile = 'cl /nologo /std:c11 /W4 /WX /utf-8 /D_CRT_SECURE_NO_WARNINGS /Iinclude src\campus_runner.c src\storage.c src\file_io.c src\main.c /Febuild\campus_runner.exe /Fobuild\'
    @("@call `"$vcvars`" >nul", '@if errorlevel 1 exit /b 1', "@$compile") | Set-Content -LiteralPath build\compile.cmd -Encoding ascii
    & cmd.exe /d /c build\compile.cmd
    if ($LASTEXITCODE -ne 0) { throw 'Backend compilation failed.' }
    $serverCommands = @(
        'cl /nologo /std:c11 /O2 /w /D_CRT_SECURE_NO_WARNINGS /DSQLITE_THREADSAFE=1 /DSQLITE_DQS=0 /DSQLITE_OMIT_LOAD_EXTENSION /c vendor\sqlite3.c /Fobuild\sqlite3.obj',
        'cl /nologo /std:c11 /O2 /w /D_CRT_SECURE_NO_WARNINGS /DCJSON_NESTING_LIMIT=32 /c vendor\cJSON.c /Fobuild\cJSON.obj',
        'cl /nologo /std:c11 /O2 /w /D_CRT_SECURE_NO_WARNINGS /DNO_SSL /DNO_CGI /DNO_FILES /DNO_CACHING /Ivendor\civetweb\include /c vendor\civetweb\src\civetweb.c /Fobuild\civetweb.obj',
        'cl /nologo /std:c11 /W4 /WX /utf-8 /D_CRT_SECURE_NO_WARNINGS /Iinclude /Ivendor /Ivendor\civetweb\include src\server_main.c src\api.c src\auth.c src\auth_api.c src\database.c src\runs_api.c src\catalog.c src\verification.c src\campus_runner.c build\sqlite3.obj build\cJSON.obj build\civetweb.obj bcrypt.lib ws2_32.lib /Febuild\campus_server.exe /Fobuild\'
    )
    $commands = @("@call `"$vcvars`" >nul", '@if errorlevel 1 exit /b 1')
    foreach ($command in $serverCommands) { $commands += "@$command"; $commands += '@if errorlevel 1 exit /b 1' }
    $commands | Set-Content -LiteralPath build\compile-server.cmd -Encoding ascii
    & cmd.exe /d /c build\compile-server.cmd
    if ($LASTEXITCODE -ne 0) { throw 'Server compilation failed.' }
    if ($Test) {
        $testCompile = 'cl /nologo /std:c11 /W4 /WX /utf-8 /D_CRT_SECURE_NO_WARNINGS /UNDEBUG /Iinclude src\campus_runner.c src\storage.c src\file_io.c tests\test_backend.c /Febuild\test_backend.exe /Fobuild\'
        @("@call `"$vcvars`" >nul", '@if errorlevel 1 exit /b 1', "@$testCompile") | Set-Content -LiteralPath build\compile.cmd -Encoding ascii
        & cmd.exe /d /c build\compile.cmd
        if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
        Push-Location build
        try {
            & .\test_backend.exe
            if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
        } finally { Pop-Location }
        & python tests\test_cli.py (Join-Path $PSScriptRoot 'build\campus_runner.exe')
        if ($LASTEXITCODE -ne 0) { throw 'CLI integration tests failed.' }
        & python tests\test_server.py (Join-Path $PSScriptRoot 'build\campus_server.exe')
        if ($LASTEXITCODE -ne 0) { throw 'HTTP server integration tests failed.' }
        & python tests\test_backup.py
        if ($LASTEXITCODE -ne 0) { throw 'Backup failure-injection tests failed.' }
        if (Get-Command node -ErrorAction SilentlyContinue) {
            & node --test tests\test_verification_admin.cjs
            if ($LASTEXITCODE -ne 0) { throw 'Verification admin UI tests failed.' }
        } else {
            Write-Warning 'Node.js 18+ is required for optional admin UI race tests; these tests were skipped.'
        }
    }
} finally { Pop-Location }
