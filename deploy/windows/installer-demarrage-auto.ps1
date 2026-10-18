# Fait demarrer le POS automatiquement a l'ouverture de session Windows.
# A lancer UNE FOIS sur chaque PC, en DOUBLE-CLIQUANT sur
# installer-demarrage-auto.bat, qui est a cote de ce fichier.
#
# Ne pas lancer ce .ps1 directement : sur un Windows par defaut la strategie
# d'execution est "Restricted" (le script est refuse), et le menu "Executer
# avec PowerShell" du clic droit n'existe pas sur toutes les machines — le
# fichier s'ouvre alors dans le Bloc-notes et l'installation ne se fait jamais.
# Le .bat regle ces deux points et demande les droits administrateur.
$ErrorActionPreference = 'Stop'

# $PSScriptRoot est vide quand le contenu est colle dans une console plutot
# qu'execute comme fichier : on le dit, au lieu de planter sur un chemin vide.
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $root) {
  throw "Lancez installer-demarrage-auto.bat plutot que de coller ce script dans une console."
}

$exe = Join-Path $root 'PosSamer.exe'
if (-not (Test-Path $exe)) { throw "PosSamer.exe introuvable a cote de ce script." }

# La tache planifiee (RunLevel Highest) exige l'elevation. Sans ce test, l'echec
# arrive sous la forme d'un "Acces refuse" au milieu du script, apres avoir
# laisse croire que quelque chose avait ete installe.
$estAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  throw "Droits administrateur requis. Double-cliquez sur installer-demarrage-auto.bat."
}

$action   = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'POS-Samer' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

# Raccourci sur le Bureau, pour un lancement manuel rapide (en plus du
# demarrage automatique ci-dessus).
#
# Le Bureau peut etre redirige vers OneDrive (c'est le cas ici :
# %USERPROFILE%\OneDrive\Desktop). GetFolderPath suit cette redirection ; un
# chemin ecrit en dur "$env:USERPROFILE\Desktop" poserait le raccourci dans un
# dossier que l'utilisateur ne voit pas.
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'PosSamer.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'POS Samer - Caisse (plein ecran)'
$shortcut.Save()

# Verification, plutot qu'un message de succes ecrit d'avance : le script a
# deja pu afficher "OK" sans que rien ne soit installe.
$tache = Get-ScheduledTask -TaskName 'POS-Samer' -ErrorAction SilentlyContinue
if (-not $tache) { throw "La tache planifiee n'a pas ete creee." }
if (-not (Test-Path $shortcutPath)) { throw "Le raccourci du Bureau n'a pas ete cree." }

Write-Host "OK : tache planifiee 'POS-Samer' creee (demarrage a l'ouverture de session)."
Write-Host "OK : raccourci cree dans $desktop"
Write-Host 'Pour retirer : Unregister-ScheduledTask -TaskName POS-Samer -Confirm:$false'
