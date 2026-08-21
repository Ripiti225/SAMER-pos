@echo off
REM ===========================================================================
REM  ENROLEMENT DE CE POSTE POUR LA SYNCHRO CLOUD
REM
REM  A lancer APRES avoir choisi le restaurant dans Reglages > Restaurant :
REM  le script refuse un poste encore en A_CONFIGURER, parce que c'est ce
REM  passage qui donne au poste son identifiant unique. Sans lui, les sept
REM  restaurants remonteraient leurs ventes sous la meme identite.
REM
REM  Le script est IDEMPOTENT : relance-le autant de fois que necessaire, il
REM  reutilise la cle deja posee et reaffiche le meme SQL a coller. C'est la
REM  facon de retrouver le texte si tu l'as perdu.
REM
REM  Sur un poste de restaurant, pnpm n'existe pas : on passe par node et tsx,
REM  livres dans runtime\node.
REM ===========================================================================
setlocal
cd /d "%~dp0"

if not exist "runtime\node\node.exe" (
  echo ERREUR : runtime\node\node.exe introuvable.
  echo Lance ce fichier depuis le dossier POS-Samer copie sur le DISQUE DUR.
  pause
  exit /b 1
)

REM La base doit tourner : le script lit l'identite du poste. Sans ce controle,
REM un operateur recevrait une trace d'erreur Drizzle de trente lignes au lieu
REM d'une phrase lui disant quoi faire.
"runtime\pgsql\bin\pg_isready.exe" -q -h localhost -p 5432
if errorlevel 1 (
  echo.
  echo ERREUR : la base de donnees ne repond pas.
  echo.
  echo   Lance d'abord PosSamer.exe et laisse la caisse ouverte,
  echo   puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

set "PATH=%~dp0runtime\node;%PATH%"
REM Adresse du cloud, commune aux sept sites. La cle de site, elle, est propre
REM a ce poste et reste en local (parametres_locaux.cle_site).
set "SUPABASE_SYNC_URL=https://vbsmxwlxlcgkodwkbhfa.supabase.co/functions/v1"

cd app\apps\server
node "..\..\node_modules\tsx\dist\cli.mjs" "src\scripts\enroler-site.ts"

echo.
echo ---------------------------------------------------------------------
echo  Copie les deux blocs INSERT ci-dessus dans l'editeur SQL Supabase,
echo  puis relance PosSamer.exe. Le journal doit afficher
echo  " Synchro cloud activee. "
echo.
echo  Astuce : clic droit dans cette fenetre pour selectionner et copier.
echo ---------------------------------------------------------------------
echo.
pause
