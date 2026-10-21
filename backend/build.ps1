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
    }
} finally { Pop-Location }
