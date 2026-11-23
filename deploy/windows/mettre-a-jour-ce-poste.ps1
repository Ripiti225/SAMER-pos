# Met a jour un poste DEJA INSTALLE depuis la cle USB : code, copies @pos et
# PosSamer.exe. Les DONNEES du site (data\pgdata, .env) ne sont jamais touchees.
#
# A lancer en DOUBLE-CLIQUANT sur mettre-a-jour-ce-poste.bat, A LA RACINE DE LA
# CLE (pas depuis le disque du poste). Ne pas lancer ce .ps1 directement.
#
# Pourquoi ce script (2026-11-23) : les sites tournent avec le lanceur no 1, qui
# porte l'ANCIENNE cle publique de signature. Les mises a jour a distance signees
# avec la nouvelle cle sont refusees ("signature invalide", 7E le 19/11). Il
# faut donc passer une fois sur chaque site pour poser le nouvel exe ; ensuite,
# les mises a jour suivantes arrivent a distance.
#
# Ce qui part de la cle : app\ SANS les node_modules (les dependances des sites
# n'ont pas change depuis d08ca34, seule la console du siege en a de nouvelles),
# PLUS les copies apps\*\node_modules\@pos\* (vraies copies sur les sites, a
# remettre a niveau a chaque report), PosSamer.exe et les scripts de la racine.
# Si le pnpm-lock.yaml du site n'est pas celui attendu, les node_modules sont
# recopies en entier (plus long).
#
# Les migrations de la base sont appliquees par le serveur a son demarrage.
$ErrorActionPreference = 'Stop'

# Empreintes attendues. A METTRE A JOUR a chaque nouvelle cle.
$EXE_SHA256 = 'C7C4E64491B810BE41870FF32DF174028A12B1A632206AED0755F7BBFC4A2C7E'
# pnpm-lock.yaml des sites installes avec la cle du 25/10 (d08ca34) : avec
# celui-la, leurs node_modules conviennent au code de la cle.
$LOCK_SITES_SHA256 = '8827EAF289D1C98A163AED53A67FAFBA9954F461D55B7431040B51C10BC9E5D3'

$cle = $PSScriptRoot
if (-not $cle) { throw "Lancez mettre-a-jour-ce-poste.bat plutot que de coller ce script dans une console." }

function Etape($texte) { Write-Host ''; Write-Host "== $texte" -ForegroundColor Cyan }
function Robo($source, $dest, [string[]]$options) {
  & robocopy $source $dest /E /R:2 /W:2 /NFL /NDL /NP /NJH /NJS @options | Out-Null
  # robocopy : 0-7 = succes (1 = fichiers copies), 8 et plus = echec.
  if ($LASTEXITCODE -ge 8) { throw "Copie echouee ($source -> $dest), code robocopy $LASTEXITCODE." }
}
function DossierPos($p) {
  $p -and (Test-Path (Join-Path $p 'runtime\node\node.exe')) -and
    (Test-Path (Join-Path $p 'app\apps\server')) -and (Test-Path (Join-Path $p 'data\pgdata'))
}

# --- 1. La cle elle-meme : complete, et pas abimee par le virus Grenam --------
Etape 'Verification de la cle'
foreach ($f in 'PosSamer.exe', 'app\VERSION.json', 'app\apps\server\src', 'app\apps\caisse\dist\index.html') {
  if (-not (Test-Path (Join-Path $cle $f))) { throw "La cle est incomplete : $f manquant. Lancez ce fichier depuis la racine de la cle." }
}
$shaExe = (Get-FileHash (Join-Path $cle 'PosSamer.exe') -Algorithm SHA256).Hash
if ($shaExe -ne $EXE_SHA256) {
  throw "PosSamer.exe de la cle n'est pas le bon (empreinte $($shaExe.Substring(0,16))...). " +
        "Virus Grenam ? Ne l'utilisez pas : faites verifier la cle."
}
$version = Get-Content (Join-Path $cle 'app\VERSION.json') -Raw | ConvertFrom-Json
Write-Host "Cle : version $($version.version), PosSamer.exe verifie."

# --- 2. Le dossier du poste ---------------------------------------------------
Etape 'Recherche du POS installe sur ce PC'
$candidats = @()
$tache = Get-ScheduledTask -TaskName 'POS-Samer' -ErrorAction SilentlyContinue
if ($tache) { $candidats += $tache.Actions | ForEach-Object { $_.WorkingDirectory } }
$candidats += 'C:\POS-Samer', "$env:USERPROFILE\Documents\POS-Samer", "$env:USERPROFILE\Desktop\POS-Samer",
  "$env:PUBLIC\Documents\POS-Samer"
$racineCle = [IO.Path]::GetPathRoot($cle)
$site = $candidats | Where-Object { (DossierPos $_) -and ([IO.Path]::GetPathRoot($_) -ne $racineCle) } | Select-Object -First 1
if ($site) {
  Write-Host "POS trouve : $site"
  $rep = Read-Host 'Est-ce le bon dossier ? (O = oui, ou tapez le bon chemin)'
  if ($rep -and $rep -notmatch '^[oO]$') { $site = $rep.Trim('"') }
} else {
  $site = (Read-Host 'POS introuvable. Tapez le chemin du dossier POS-Samer de ce PC (ex. C:\POS-Samer)').Trim('"')
}
$site = $site.TrimEnd('\')
if (-not (DossierPos $site)) { throw "'$site' n'est pas un dossier POS-Samer (runtime, app, data\pgdata attendus)." }
if ([IO.Path]::GetPathRoot($site) -eq $racineCle) { throw "Ce dossier est sur la cle elle-meme : choisissez celui du disque du PC." }

# Identite du poste, pour que l'operateur sache QUEL restaurant il met a jour.
$psql = Join-Path $site 'runtime\pgsql\bin\psql.exe'
$url = (Get-Content (Join-Path $site 'app\apps\server\.env') | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=', ''
function Requete($sql) { & $psql -X -At -d $url -c $sql 2>$null }
$resto = Requete 'select nom from restaurant'
if ($resto) { Write-Host "Restaurant de ce poste : $resto" -ForegroundColor Yellow }
$ouverts = Requete 'select count(*) from services_caisse where cloture_le is null'
if ($ouverts -and [int]$ouverts -gt 0) {
  Write-Host "ATTENTION : $ouverts service(s) de caisse encore OUVERT(S)." -ForegroundColor Yellow
  Write-Host 'Les ventes sont conservees, mais la caisse va s''arreter quelques minutes.'
}
if ((Read-Host 'Lancer la mise a jour maintenant ? La caisse sera arretee quelques minutes. (O/N)') -notmatch '^[oO]$') {
  Write-Host 'Rien n''a ete modifie.'; exit 0
}

# --- 3. Arreter le POS --------------------------------------------------------
Etape 'Arret du POS'
function PosArrete { -not (Get-Process PosSamer -ErrorAction SilentlyContinue) -and -not (Get-Process postgres -ErrorAction SilentlyContinue) }
if (-not (PosArrete)) {
  # Le kiosque refuse la fermeture classique : Ctrl+Alt+Q est sa porte de sortie,
  # qui arrete aussi le serveur et PostgreSQL proprement.
  (New-Object -ComObject WScript.Shell).SendKeys('^%q')
  $t = 0; while (-not (PosArrete) -and $t -lt 90) { Start-Sleep 2; $t += 2 }
}
if (-not (PosArrete)) {
  Read-Host 'Le POS tourne encore. Appuyez sur Ctrl+Alt+Q dans la caisse, attendez qu''elle se ferme, puis Entree'
  $t = 0; while (-not (PosArrete) -and $t -lt 60) { Start-Sleep 2; $t += 2 }
  if (-not (PosArrete)) { throw 'Le POS ne s''arrete pas : rien n''a ete modifie. Redemarrez le PC et relancez ce fichier.' }
}
Write-Host 'POS arrete.'

# --- 4. Sauvegarde ------------------------------------------------------------
$horodatage = Get-Date -Format 'yyyyMMdd-HHmm'
$sauvegarde = Join-Path $site "sauvegardes\avant-maj-$horodatage"
Etape "Sauvegarde dans $sauvegarde"
New-Item -ItemType Directory -Force $sauvegarde | Out-Null
Start-Transcript -Path (Join-Path $sauvegarde 'journal.txt') -Append | Out-Null
Robo (Join-Path $site 'data\pgdata') (Join-Path $sauvegarde 'pgdata') @()
Robo (Join-Path $site 'app') (Join-Path $sauvegarde 'app') @('/XD', 'node_modules')
Copy-Item (Join-Path $site 'PosSamer.exe') $sauvegarde -ErrorAction SilentlyContinue
Write-Host 'Base, code et exe actuels sauvegardes.'

# --- 5. Copie -----------------------------------------------------------------
Etape 'Copie de la mise a jour'
$lockSite = Join-Path $site 'app\pnpm-lock.yaml'
$depsOk = (Test-Path $lockSite) -and ((Get-FileHash $lockSite -Algorithm SHA256).Hash -eq $LOCK_SITES_SHA256)
if ($depsOk) {
  # `.env` exclu partout : il appartient au poste.
  Robo (Join-Path $cle 'app') (Join-Path $site 'app') @('/XD', 'node_modules', '/XF', '.env')
  # Copies @pos : vraies copies de packages\*, a remettre a niveau a chaque report.
  Get-ChildItem (Join-Path $cle 'app') -Directory -Recurse -Depth 3 -Filter '@pos' |
    Where-Object { $_.Parent.Name -eq 'node_modules' -and $_.Parent.Parent.Parent.Name -in 'apps', 'packages' } |
    ForEach-Object {
      $rel = $_.FullName.Substring((Join-Path $cle 'app').Length).TrimStart('\')
      Robo $_.FullName (Join-Path (Join-Path $site 'app') $rel) @()
    }
} else {
  Write-Host 'Dependances du poste differentes de celles attendues : copie COMPLETE (peut prendre 30 min).' -ForegroundColor Yellow
  Robo (Join-Path $cle 'app') (Join-Path $site 'app') @('/XF', '.env')
}
Copy-Item (Join-Path $cle 'PosSamer.exe') (Join-Path $site 'PosSamer.exe') -Force
Get-ChildItem $cle -File | Where-Object { $_.Extension -in '.bat', '.ps1', '.md' } |
  ForEach-Object { Copy-Item $_.FullName $site -Force }
if ((Get-FileHash (Join-Path $site 'PosSamer.exe') -Algorithm SHA256).Hash -ne $EXE_SHA256) {
  throw "PosSamer.exe mal copie sur le poste. Sauvegarde de l'ancien : $sauvegarde"
}
Write-Host 'Copie terminee.'

# --- 6. Redemarrage et controle -----------------------------------------------
Etape 'Redemarrage du POS (migrations appliquees au demarrage)'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $site 'PosSamer.exe') -WorkingDirectory $site
$debut = Get-Date; $etat = $null
while (-not $etat -and ((Get-Date) - $debut).TotalSeconds -lt 240) {
  Start-Sleep 3
  try { $etat = Invoke-RestMethod -TimeoutSec 3 http://localhost:3001/api/sante/version } catch {}
}
if (-not $etat) {
  throw "Le POS ne repond pas apres 4 minutes. Regardez l'ecran de la caisse. " +
        "Pour revenir en arriere : remettre $sauvegarde\pgdata, \app et \PosSamer.exe."
}
Write-Host "POS redemarre : version $($etat.version)." -ForegroundColor Green
try {
  $maj = Invoke-RestMethod -TimeoutSec 5 http://localhost:3001/api/maj/etat
  Write-Host "Mise a jour a distance : $($maj.etat)"
} catch {}
$migrations = Requete 'select count(*) from drizzle.__drizzle_migrations'
if ($migrations) { Write-Host "Migrations appliquees : $migrations" }
Write-Host ''
Write-Host "MISE A JOUR REUSSIE$(if ($resto) { " pour $resto" })." -ForegroundColor Green
Write-Host "Sauvegarde : $sauvegarde (a supprimer dans quelques jours si tout va bien)."
Stop-Transcript | Out-Null
