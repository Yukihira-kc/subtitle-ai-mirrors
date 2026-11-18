@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "try { & ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) 'setup-vosk.ps1')))) } catch { Write-Host $_; exit 1 }"
if errorlevel 1 goto end
runtime\python.exe vosk_bridge.py
:end
pause
