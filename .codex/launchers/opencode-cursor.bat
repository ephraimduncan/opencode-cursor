@echo off
setlocal
set "SHOULD_PAUSE=0"
cd /d "C:\NEW PRG\opencode-cursor"

if /I "%~1"=="status" goto action_status
if /I "%~1"=="start" goto action_start
if /I "%~1"=="restart" goto action_restart
if /I "%~1"=="stop" goto action_stop
if /I "%~1"=="auth-status" goto action_auth
if /I "%~1"=="sync-models" goto action_sync
if /I "%~1"=="build" goto action_build
if /I "%~1"=="install-deps" goto action_deps
if /I "%~1"=="tray" goto action_tray
if /I "%~1"=="menu" goto menu
if "%~1"=="" goto menu

echo OPENCODE-CURSOR - Commands
echo.
echo   opencode-cursor status        - Show proxy + auth status
echo   opencode-cursor start         - Start the proxy server
echo   opencode-cursor restart       - Restart the proxy server
echo   opencode-cursor stop          - Stop the proxy server
echo   opencode-cursor auth-status   - Show auth status
echo   opencode-cursor sync-models   - Sync models from cursor-agent
echo   opencode-cursor build         - Build the project
echo   opencode-cursor install-deps  - Install dependencies
echo   opencode-cursor tray          - Start system tray app
echo   opencode-cursor menu          - Open interactive menu
set "EXIT_CODE=1"
goto finish

:menu
set "SHOULD_PAUSE=1"
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager-menu.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_status
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action status
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_start
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action start
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_restart
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action restart
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_stop
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action stop
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_auth
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action auth-status
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_sync
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action sync-models
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_build
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action build
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_deps
powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\scripts\proxy-manager.ps1" -Action install-deps
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:action_tray
start "" wscript.exe ".codex\launchers\start-tray.vbs"
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:finish
if "%SHOULD_PAUSE%"=="1" (
	echo.
	echo Press any key to close...
	pause >nul
)
exit /b %EXIT_CODE%
