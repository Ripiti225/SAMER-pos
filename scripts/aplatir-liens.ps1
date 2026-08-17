# ===========================================================================
#  Remplace les liens symboliques de node_modules par de VRAIES copies.
#
#  Pourquoi : le dossier portable est dupliqué sur clé USB puis sur les 7
#  restaurants. Les outils de copie Windows ne recréent un lien symbolique
#  qu'avec des droits administrateur (robocopy /SL, que robocopy ignore en
#  prime dès que /MT est actif) : un lien perdu devient un dossier VIDE, et
#  l'application s'arrête au démarrage sur un « module introuvable ».
#
#  `nodeLinker: hoisted` (pnpm-workspace.yaml) supprime déjà les ~2 500 liens
#  des dépendances externes. Restent les paquets internes du monorepo
#  (@pos/shared, @pos/theme, @pos/shared-ui) que pnpm lie toujours : ce script
#  les aplatit.
#
#  À RELANCER après chaque `pnpm install` (qui recrée les liens), avant de
#  copier le dossier. Sans effet si tout est déjà aplati.
# ===========================================================================
param(
  [string]$App = 'C:\Users\PC\Documents\POS-Samer-deploiement\POS-Samer\app'
)
$ErrorActionPreference = 'Stop'

function Liens($racine) {
  Get-ChildItem $racine -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LinkType }
}

$racines = @()
Get-ChildItem "$App\apps", "$App\packages" -Directory | ForEach-Object {
  $p = Join-Path $_.FullName 'node_modules'
  if (Test-Path $p) { $racines += $p }
}
$racines += "$App\node_modules"

# packages/ d'abord : un paquet interne peut lui-même lier un autre paquet
# interne (shared-ui -> shared). On aplatit la source avant de la recopier.
$aTraiter = @()
foreach ($r in $racines) { if ($r -like "$App\packages\*") { $aTraiter += Liens $r } }
foreach ($r in $racines) { if ($r -notlike "$App\packages\*") { $aTraiter += Liens $r } }

if ($aTraiter.Count -eq 0) {
  Write-Host 'Aucun lien symbolique : rien a faire.' -ForegroundColor Green
  exit 0
}

Write-Host "$($aTraiter.Count) lien(s) a remplacer par des copies reelles."
$n = 0
foreach ($lien in $aTraiter) {
  $chemin = $lien.FullName
  # .Target peut être relatif au dossier parent du lien : on résout en absolu.
  $cible = $lien.Target | Select-Object -First 1
  if (-not [System.IO.Path]::IsPathRooted($cible)) {
    $cible = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $chemin -Parent) $cible))
  }
  if (-not (Test-Path $cible)) {
    Write-Host "  IGNORE (cible absente) : $chemin" -ForegroundColor Yellow
    continue
  }
  # Retirer le LIEN sans toucher à sa cible : rmdir sur un lien de répertoire
  # supprime le lien seul (Remove-Item -Recurse suivrait le lien et viderait
  # le paquet source du monorepo).
  cmd /c rmdir "$chemin" | Out-Null
  if (Test-Path $chemin) { throw "Impossible de retirer le lien : $chemin" }

  # Copie réelle, sans les node_modules internes (ils seraient redondants et
  # rallongeraient inutilement la copie sur clé).
  robocopy $cible $chemin /E /XD node_modules /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copie echouee : $cible -> $chemin" }
  $n++
}

$restants = 0
foreach ($r in $racines) { $restants += (Liens $r).Count }
Write-Host ''
Write-Host "$n lien(s) remplace(s). Liens restants : $restants"
if ($restants -eq 0) {
  Write-Host 'OK : node_modules ne contient plus aucun lien symbolique.' -ForegroundColor Green
} else {
  Write-Host 'ATTENTION : des liens subsistent.' -ForegroundColor Red
  exit 1
}
