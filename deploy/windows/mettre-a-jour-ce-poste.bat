@echo off
rem ===========================================================================
rem  Met a jour un poste DEJA INSTALLE depuis la cle USB (code + PosSamer.exe).
rem  DOUBLE-CLIQUER SUR CE FICHIER, A LA RACINE DE LA CLE.
rem  Les donnees du restaurant (base, .env) ne sont pas touchees, et sont
rem  sauvegardees avant toute copie.
rem
rem  Droits administrateur : le POS est lance par une tache planifiee en mode
rem  eleve ; seul un processus eleve peut lui envoyer Ctrl+Alt+Q pour l'arreter
rem  proprement, et ecrire dans un dossier comme C:\POS-Samer.
rem  Meme schema que installer-demarrage-auto.bat : ne jamais se fermer sans
rem  avoir dit ce qui s'est passe.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%mettre-a-jour-ce-poste.ps1"

if not exist "%PS1%" (
  echo ERREUR : mettre-a-jour-ce-poste.ps1 est introuvable a cote de ce fichier.
  echo.
  pause
  exit /b 1
)

net session >nul 2>&1
if %errorlevel% equ 0 goto :administrateur

if /i "%~1"=="deja-tente" (
  echo.
  echo ECHEC : l'elevation n'a pas abouti, rien n'a ete modifie.
  echo Faites un clic droit sur ce fichier, puis
  echo    "Executer en tant qu'administrateur".
  echo.
  pause
  exit /b 1
)

echo.
echo Droits administrateur necessaires pour mettre a jour le POS.
echo Windows va demander votre autorisation : repondez OUI.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList 'deja-tente' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo L'autorisation a ete REFUSEE ou annulee : rien n'a ete modifie.
  echo.
  pause
  exit /b 1
)
echo Fenetre administrateur ouverte : la suite s'y passe.
exit /b 0

:administrateur
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" (
  echo La mise a jour a ECHOUE ^(code %CODE%^). La raison est dans le message ci-dessus.
) else (
  echo Termine.
)
echo.
pause
exit /b %CODE%
