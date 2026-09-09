@echo off
rem ===========================================================================
rem  Prepare l'application du dossier portable (fabrication de la cle master) :
rem  base, migrations, seed, build de la caisse, puis PosSamer.exe.
rem  DOUBLE-CLIQUER SUR CE FICHIER. Ne pas lancer le .ps1 directement.
rem
rem  Meme raison d'etre que installer-demarrage-auto.bat : sur un Windows par
rem  defaut la strategie d'execution est "Restricted" et refuse tout .ps1, et
rem  l'entree "Executer avec PowerShell" du clic droit n'existe pas partout —
rem  la ou elle manque, le .ps1 s'ouvre dans le Bloc-notes et il ne se passe
rem  rien. Le -ExecutionPolicy Bypass ci-dessous ne vaut QUE pour ce processus.
rem
rem  Pas d'elevation ici, contrairement a l'installation du demarrage auto :
rem  ce script n'a pas besoin des droits administrateur, mais du MODE
rem  DEVELOPPEUR Windows (electron-builder cree des liens symboliques).
rem  Parametres > Confidentialite et securite > Pour les developpeurs.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%preparer-app.ps1"

if not exist "%PS1%" (
  echo ERREUR : preparer-app.ps1 est introuvable a cote de ce fichier.
  echo Les deux doivent rester ensemble a la racine du dossier POS-Samer.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
pause
