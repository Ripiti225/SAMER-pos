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
rem   3. Creer la tache planifiee demande les droits administrateur.
rem
rem  REGLE DE CONDUITE DE CE SCRIPT : ne jamais se fermer sans avoir dit ce
rem  qui s'est passe. Une premiere version sortait en silence quand l'UAC etait
rem  refuse ou ne s'affichait pas — la fenetre clignotait et disparaissait, et
rem  rien ne permettait de savoir que rien n'avait ete installe.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%installer-demarrage-auto.ps1"

if not exist "%PS1%" (
  echo ERREUR : installer-demarrage-auto.ps1 est introuvable a cote de ce fichier.
  echo Les deux doivent rester ensemble a la racine du dossier POS-Samer.
  echo.
  pause
  exit /b 1
)

rem Deja administrateur ? "net session" echoue sans elevation.
net session >nul 2>&1
if %errorlevel% equ 0 goto :administrateur

rem "deja-tente" est passe par la relance elevee ci-dessous. S'il est la et
rem qu'on N'EST TOUJOURS PAS admin, l'elevation a echoue : on s'arrete en le
rem disant, au lieu de redemander l'UAC en boucle.
if /i "%~1"=="deja-tente" (
  echo.
  echo ECHEC : l'elevation n'a pas abouti, rien n'a ete installe.
  echo Faites un clic droit sur ce fichier, puis
  echo    "Executer en tant qu'administrateur".
  echo.
  pause
  exit /b 1
)

echo.
echo Droits administrateur necessaires pour creer la tache planifiee.
echo Windows va demander votre autorisation : repondez OUI.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList 'deja-tente' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo L'autorisation a ete REFUSEE ou annulee : rien n'a ete installe.
  echo Reessayez en repondant OUI, ou faites un clic droit sur ce fichier
  echo puis "Executer en tant qu'administrateur".
  echo.
  pause
  exit /b 1
)
rem L'elevation a reussi : le travail se fait dans la NOUVELLE fenetre, qui
rem reste ouverte sur son resultat. Celle-ci n'a plus rien a faire.
echo Fenetre administrateur ouverte : la suite s'y passe.
exit /b 0

:administrateur
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" (
  echo L'installation a ECHOUE ^(code %CODE%^). La raison est dans le message ci-dessus.
) else (
  echo Termine.
)
echo.
pause
exit /b %CODE%
