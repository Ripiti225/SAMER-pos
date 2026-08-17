# Fait demarrer le POS automatiquement a l'ouverture de session Windows.
# A lancer UNE FOIS sur chaque PC (clic droit > Executer avec PowerShell),
# depuis le dossier portable copie sur le PC.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root 'PosSamer.exe'
if (-not (Test-Path $exe)) { throw "PosSamer.exe introuvable a cote de ce script." }

$action  = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'POS-Samer' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

# Raccourci sur le Bureau, pour un lancement manuel rapide (en plus du
# demarrage automatique ci-dessus).
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'PosSamer.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'POS Samer - Caisse (plein ecran)'
$shortcut.Save()

Write-Host 'OK : le POS demarrera automatiquement a chaque ouverture de session.'
Write-Host 'Raccourci ajoute sur le Bureau pour un lancement manuel.'
Write-Host 'Pour retirer : Unregister-ScheduledTask -TaskName POS-Samer -Confirm:$false'
