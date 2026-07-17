# Fait demarrer le POS automatiquement a l'ouverture de session Windows.
# A lancer UNE FOIS sur chaque PC (clic droit > Executer avec PowerShell),
# depuis le dossier portable copie sur le PC.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat  = Join-Path $root 'demarrer-pos.bat'
if (-not (Test-Path $bat)) { throw "demarrer-pos.bat introuvable a cote de ce script." }

$action  = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'POS-Samer' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

Write-Host 'OK : le POS demarrera automatiquement a chaque ouverture de session.'
Write-Host 'Pour retirer : Unregister-ScheduledTask -TaskName POS-Samer -Confirm:$false'
