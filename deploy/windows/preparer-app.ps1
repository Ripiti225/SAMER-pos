# ===========================================================================
#  Prepare l'APPLICATION du dossier portable (a lancer UNE FOIS, sur un PC
#  Windows AVEC internet, pour fabriquer la cle master).
#  Prerequis deja en place dans le dossier portable :
#    .\runtime\node\        (Node.js portable)
#    .\runtime\pgsql\bin\   (PostgreSQL portable)
#    .\app\                 (depot pos-samer)
#  Ce script : initialise la base, l'ouvre, installe les deps, migre et seed.
# ===========================================================================
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$node   = Join-Path $root 'runtime\node'
$pgbin  = Join-Path $root 'runtime\pgsql\bin'
$pgdata = Join-Path $root 'data\pgdata'
$app    = Join-Path $root 'app'
$env:Path = "$node;$pgbin;$env:Path"

# 1) Activer pnpm (corepack fournit pnpm dans le Node portable)
Write-Host '[1/5] Activation de pnpm...'
& corepack enable
& corepack prepare pnpm@11.9.0 --activate

# 2) Initialiser PostgreSQL portable (auth "trust" en local -> pas de mot de passe)
if (-not (Test-Path $pgdata)) {
  Write-Host '[2/5] Initialisation de la base...'
  New-Item -ItemType Directory -Force -Path (Split-Path $pgdata) | Out-Null
  & initdb -D $pgdata -U postgres -A trust --encoding=UTF8
} else {
  Write-Host '[2/5] Base deja initialisee, on garde.'
}

# 3) Demarrer PostgreSQL
Write-Host '[3/5] Demarrage de PostgreSQL...'
& pg_ctl -D $pgdata -l (Join-Path $root 'data\pg.log') -w start

# 4) Installer les dependances (compile les modules natifs pour Windows)
Write-Host '[4/5] Installation des dependances (peut prendre quelques minutes)...'
Push-Location $app
& pnpm install

# 5) .env (auth trust -> connexion sans mot de passe), migration + seed
$envFile = Join-Path $app 'apps\server\.env'
if (-not (Test-Path $envFile)) {
  Write-Host '     Creation de apps\server\.env (base locale sans mot de passe)...'
  @(
    'DATABASE_URL=postgres://postgres@localhost:5432/pos_samer',
    'ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres',
    'PORT=3001',
    'SAMTRACKLY_URL=https://wlwotzxnzowbkbfcpnyi.supabase.co',
    'SAMTRACKLY_KEY='
  ) | Set-Content -Encoding UTF8 $envFile
}
Write-Host '[5/5] Migration + donnees de depart...'
& pnpm db:migrate
& pnpm db:seed
Pop-Location

& pg_ctl -D $pgdata stop
Write-Host ''
Write-Host 'OK. Le dossier portable est pret a etre copie sur cle USB puis sur chaque PC.'
Write-Host 'Pense a renseigner SAMTRACKLY_KEY dans app\apps\server\.env avant de deployer.'
