# ===========================================================================
#  Prepare l'APPLICATION du dossier portable (a lancer UNE FOIS, sur un PC
#  Windows AVEC internet, pour fabriquer la cle master).
#  Prerequis deja en place dans le dossier portable :
#    .\runtime\node\        (Node.js portable)
#    .\runtime\pgsql\bin\   (PostgreSQL portable)
#    .\app\                 (depot pos-samer)
#  Ce script : initialise la base, l'ouvre, installe les deps, migre, seed,
#  build la caisse et produit PosSamer.exe (l'app desktop plein ecran).
#
#  IMPORTANT : le packaging de PosSamer.exe (electron-builder) a besoin du
#  Mode developpeur Windows (creation de liens symboliques sans droits admin).
#  Si absent : Parametres > Confidentialite et securite > Pour les
#  developpeurs > Mode developpeur. Sinon ce script s'arrete avec un message
#  clair a cette etape (la base/migrations/seed restent quand meme faites).
# ===========================================================================
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$node   = Join-Path $root 'runtime\node'
$pgbin  = Join-Path $root 'runtime\pgsql\bin'
$pgdata = Join-Path $root 'data\pgdata'
$app    = Join-Path $root 'app'
$env:Path = "$node;$pgbin;$env:Path"

# 1) Activer pnpm (corepack fournit pnpm dans le Node portable)
Write-Host '[1/7] Activation de pnpm...'
& corepack enable
& corepack prepare pnpm@11.9.0 --activate

# 2) Initialiser PostgreSQL portable (auth "trust" en local -> pas de mot de passe)
if (-not (Test-Path $pgdata)) {
  Write-Host '[2/7] Initialisation de la base...'
  New-Item -ItemType Directory -Force -Path (Split-Path $pgdata) | Out-Null
  & initdb -D $pgdata -U postgres -A trust --encoding=UTF8 --locale=en-US
} else {
  Write-Host '[2/7] Base deja initialisee, on garde.'
}

# 3) Demarrer PostgreSQL
Write-Host '[3/7] Demarrage de PostgreSQL...'
& pg_ctl -D $pgdata -l (Join-Path $root 'data\pg.log') -w start

# 4) Installer les dependances (compile les modules natifs pour Windows)
Write-Host '[4/7] Installation des dependances (peut prendre quelques minutes)...'
Push-Location $app
& pnpm install

# 5) .env (auth trust -> connexion sans mot de passe), migration + seed
$envFile = Join-Path $app 'apps\server\.env'
if (-not (Test-Path $envFile)) {
  Write-Host '     Creation de apps\server\.env (base locale sans mot de passe)...'
  # Set-Content -Encoding UTF8 ajoute un BOM en Windows PowerShell 5.1, ce qui
  # corrompt le nom de la 1ere variable lue par process.loadEnvFile() (Node).
  # On ecrit donc en UTF8 SANS BOM via .NET.
  $envLignes = @(
    'DATABASE_URL=postgres://postgres@localhost:5432/pos_samer',
    'ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres',
    'PORT=3001',
    'SAMTRACKLY_URL=https://wlwotzxnzowbkbfcpnyi.supabase.co',
    'SAMTRACKLY_KEY='
  )
  [System.IO.File]::WriteAllLines($envFile, $envLignes, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host '[5/7] Migration + donnees de depart...'
& pnpm db:migrate
& pnpm db:seed

& pg_ctl -D $pgdata stop

# 6) Build de la caisse (necessaire pour que le serveur la serve en statique,
#    meme origine que l'API -> cookies de session + fetch relatifs valides)
Write-Host '[6/7] Build de la caisse...'
& pnpm --filter caisse build

# 7) Packaging de l'app desktop (Electron, plein ecran kiosque)
Write-Host '[7/7] Packaging de PosSamer.exe...'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
try {
  & pnpm --filter @pos/desktop build
  if ($LASTEXITCODE -ne 0) { throw "electron-builder a retourne le code $LASTEXITCODE" }
  Copy-Item (Join-Path $app 'apps\desktop\release\PosSamer.exe') (Join-Path $root 'PosSamer.exe') -Force
} catch {
  Write-Host ''
  Write-Host 'ATTENTION : le packaging de PosSamer.exe a echoue.'
  Write-Host 'Cause frequente : Mode developpeur Windows desactive (necessaire'
  Write-Host 'pour electron-builder). Active-le puis relance juste ce script :'
  Write-Host '  Parametres Windows > Confidentialite et securite >'
  Write-Host '  Pour les developpeurs > Mode developpeur.'
  Write-Host 'La base/migrations/seed sont deja faites, pas besoin de tout refaire.'
}
Pop-Location

Write-Host ''
Write-Host 'OK. Le dossier portable est pret a etre copie sur cle USB puis sur chaque PC.'
Write-Host 'Pense a renseigner SAMTRACKLY_KEY dans app\apps\server\.env avant de deployer.'
