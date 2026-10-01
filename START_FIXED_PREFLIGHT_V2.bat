@echo off
setlocal DisableDelayedExpansion
title LeanBridge FIXED Preflight V2
echo.
echo LeanBridge FIXED Preflight V2 - build diagnostics revision
echo.
if not exist "%~dp0leanbridge_preflight_v2.ps1" goto missing_script
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0leanbridge_preflight_v2.ps1" -PauseInLauncher
set "PREFLIGHT_EXIT=%ERRORLEVEL%"
goto finish
:missing_script
echo [ERROR] Extract BOTH files from the ZIP into the same folder first.
set "PREFLIGHT_EXIT=1"
:finish
echo.
if not "%PREFLIGHT_EXIT%"=="0" echo [RESULT] Preflight failed. Read the message above.
pause
exit /b %PREFLIGHT_EXIT%
