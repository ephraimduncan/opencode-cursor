@echo off
setlocal
cd /d "%~dp0..\.."

echo [start-proxy] Starting OpenCode-Cursor proxy...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action start
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
	echo [start-proxy] Failed with exit code %EXIT_CODE%.
	echo Press any key to close...
	pause >nul
) else (
	echo [start-proxy] Proxy is running.
	timeout /t 2 >nul
)
exit /b %EXIT_CODE%
