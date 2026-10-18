@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0corriger-a-la-braise.ps1"
set "RESULTAT=%ERRORLEVEL%"
pause
exit /b %RESULTAT%
