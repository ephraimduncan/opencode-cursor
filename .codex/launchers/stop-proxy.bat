@echo off
setlocal
cd /d "%~dp0..\.."

echo [stop-proxy] Stopping OpenCode-Cursor proxy...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action stop
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
	echo [stop-proxy] Failed with exit code %EXIT_CODE%.
	echo Press any key to close...
	pause >nul
) else (
	echo [stop-proxy] Proxy stopped.
	timeout /t 2 >nul
)
exit /b %EXIT_CODE%
