@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || goto end
if exist "runtime\.ready" if exist "engine\.ready" if exist "model\.ready" goto run
powershell -NoProfile -Command "try { & ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) 'setup-vosk.ps1')))) } catch { Write-Host $_; exit 1 }"
if errorlevel 1 goto end
:run
if "%~1"=="--register" goto register
"runtime\python.exe" "vosk_bridge.py"
goto end
:register
"runtime\python.exe" "vosk_bridge.py" --register
:end
pause
