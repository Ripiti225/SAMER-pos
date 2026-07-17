@echo off
rem ===========================================================================
rem  Demarre le POS Samer (base PostgreSQL portable + serveur + caisses).
rem  A placer a la RACINE du dossier portable. Layout attendu :
rem    .\runtime\node\        (Node.js portable, node.exe)
rem    .\runtime\pgsql\bin\   (PostgreSQL portable)
rem    .\data\pgdata\         (base initialisee + seedee)
rem    .\app\                 (depot pos-samer avec node_modules)
rem  Laisser cette fenetre OUVERTE : elle fait tourner le POS.
rem ===========================================================================
title POS Samer
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%runtime\node;%ROOT%runtime\pgsql\bin;%PATH%"
set "PGDATA=%ROOT%data\pgdata"

echo [1/3] Demarrage de la base de donnees...
pg_ctl -D "%PGDATA%" -l "%ROOT%data\pg.log" -w start
if errorlevel 1 (
  echo    (la base est peut-etre deja demarree, on continue)
)

echo [2/3] Ouverture de la caisse dans le navigateur...
start "" http://localhost:5173

echo [3/3] Demarrage du serveur POS + apps (ne fermez pas cette fenetre)...
cd /d "%ROOT%app"
call pnpm dev

rem Si pnpm dev s'arrete, on stoppe proprement la base.
pg_ctl -D "%PGDATA%" stop
endlocal
