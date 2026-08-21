# Propage packages/* (@pos/shared, @pos/theme, @pos/shared-ui) dans le
# node_modules de chaque app qui en dépend.
#
# POURQUOI CE SCRIPT EXISTE
# -------------------------
# Le workspace utilise `injectWorkspacePackages: true` (pnpm-workspace.yaml) :
# les paquets internes sont COPIÉS dans chaque app au lieu d'être liés, pour que
# la copie du dossier sur clé USB ne dépende d'aucun lien symbolique.
#
# Contrepartie : modifier `packages/shared/src/...` ne change RIEN pour les apps
# tant que la copie n'est pas refaite — et `pnpm install`, même avec `--force`,
# répond « Already up to date » sans la refaire (l'état du workspace lui paraît
# complet). Pire : supprimer les copies ne le décide pas davantage à les
# recréer. Les apps compilent alors contre une version périmée du paquet, avec
# des erreurs de type incompréhensibles ou, plus vicieux, aucune erreur du tout
# et un ancien comportement à l'exécution.
#
# À LANCER APRÈS CHAQUE MODIFICATION DE packages/*, avant tout typecheck/build :
#   powershell -ExecutionPolicy Bypass -File scripts\propager-paquets.ps1

$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$Packages = Join-Path $App 'packages'

$cibles = @()
foreach ($dossier in @('apps', 'packages')) {
  $cibles += Get-ChildItem (Join-Path $App $dossier) -Directory
}

$total = 0
foreach ($cible in $cibles) {
  $manifeste = Join-Path $cible.FullName 'package.json'
  if (-not (Test-Path $manifeste)) { continue }

  $json = Get-Content $manifeste -Raw | ConvertFrom-Json
  $deps = @()
  foreach ($champ in @('dependencies', 'devDependencies')) {
    if ($json.PSObject.Properties.Name -contains $champ -and $null -ne $json.$champ) {
      $deps += $json.$champ.PSObject.Properties.Name
    }
  }

  foreach ($dep in ($deps | Where-Object { $_ -like '@pos/*' } | Sort-Object -Unique)) {
    $nom = $dep -replace '^@pos/', ''
    $source = Join-Path $Packages $nom
    if (-not (Test-Path $source)) {
      Write-Warning "$dep introuvable dans packages/ - ignore"
      continue
    }
    $destination = Join-Path $cible.FullName "node_modules\$dep"

    # /MIR pour que la destination soit le reflet exact de la source (un fichier
    # supprimé du paquet doit disparaitre de la copie). /XD node_modules : la
    # copie ne doit jamais embarquer les dependances du paquet source.
    robocopy $source $destination /MIR /XD node_modules /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Echec de la copie $dep vers $($cible.Name) (robocopy $LASTEXITCODE)" }
    Write-Host ("  {0,-14} -> {1}" -f $dep, $cible.Name)
    $total++
  }
}

Write-Host "OK : $total copie(s) de paquets internes a jour." -ForegroundColor Green
