$ErrorActionPreference = 'Stop'
$racinePos = $PSScriptRoot
$serveurPos = Join-Path $racinePos 'app\apps\server'
$nodePos = Join-Path $racinePos 'runtime\node\node.exe'
$tsxPos = Join-Path $racinePos 'app\node_modules\tsx\dist\cli.mjs'
try {
    if (!(Test-Path -LiteralPath $nodePos) -or !(Test-Path -LiteralPath $tsxPos)) {
        throw 'Placer ce script dans le dossier POS-Samer, a cote de runtime et app.'
    }
    Write-Host 'Installation du profil existant A la Braise sur ce mini-PC.'
    Write-Host 'La base doit etre demarree. Ne pas saisir de commande pendant cette operation.'
    Push-Location $serveurPos
    try {
        & $nodePos $tsxPos 'src\db\migrate.ts'
        if ($LASTEXITCODE -ne 0) { throw 'Echec des migrations. Import non execute.' }
        & $nodePos $tsxPos 'src\scripts\importer-profil-restaurant.ts' '--code=ALA_BRAISE'
        if ($LASTEXITCODE -ne 0) { throw 'Import refuse ou en echec. Consulter le message ci-dessus.' }
    } finally { Pop-Location }
    Write-Host 'Profil importe. Fermer puis relancer PosSamer.exe et reconnecter les terminaux.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
