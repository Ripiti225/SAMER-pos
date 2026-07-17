@echo off
rem Arrete proprement le POS Samer (serveur + base).
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%runtime\pgsql\bin;%PATH%"

echo Arret du serveur POS...
taskkill /f /im node.exe >nul 2>&1

echo Arret de la base de donnees...
pg_ctl -D "%ROOT%data\pgdata" stop >nul 2>&1

echo Termine.
endlocal
