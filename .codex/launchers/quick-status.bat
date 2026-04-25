@echo off
setlocal
cd /d "%~dp0..\.."

powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action status
echo.
echo Press any key to close...
pause >nul
