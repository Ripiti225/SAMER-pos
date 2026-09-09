@echo off
rem ===========================================================================
rem  Installe le demarrage automatique du POS + le raccourci sur le Bureau.
rem  DOUBLE-CLIQUER SUR CE FICHIER. Ne pas lancer le .ps1 directement.
rem
rem  Pourquoi ce lanceur .bat existe, alors qu'il ne fait qu'appeler le .ps1 :
rem   1. Sur un Windows par defaut, la strategie d'execution PowerShell est
rem      "Restricted" : lancer un .ps1 echoue avec "l'execution de scripts est
rem      desactivee sur ce systeme". Ici, on passe -ExecutionPolicy Bypass, qui
rem      ne vaut QUE pour ce processus : rien n'est desserre sur la machine.
rem   2. Le menu "Executer avec PowerShell" du clic droit n'existe pas partout
rem      (la cle Shell\0 peut etre absente : le .ps1 s'ouvre alors dans le
rem      Bloc-notes, et l'installation ne se fait jamais sans qu'on comprenne
rem      pourquoi). Un .bat, lui, se double-clique toujours.
rem   3. Creer la tache planifiee demande les droits administrateur. On les
rem      demande explicitement ci-dessous, au lieu d'echouer sur un refus.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%installer-demarrage-auto.ps1"

if not exist "%PS1%" (
  echo ERREUR : installer-demarrage-auto.ps1 est introuvable a cote de ce fichier.
  echo Les deux doivent rester ensemble a la racine du dossier POS-Samer.
  pause
  exit /b 1
)

rem Deja administrateur ? "net session" echoue sans elevation.
net session >nul 2>&1
if %errorlevel% equ 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
  echo.
  pause
  exit /b 0
)

rem Sinon : on relance CE fichier en demandant l'elevation (fenetre UAC).
echo Droits administrateur necessaires pour creer la tache planifiee.
echo Validez la fenetre de Windows qui va s'ouvrir.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 0
