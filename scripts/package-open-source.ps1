$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packageDocument = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$packageName = "allycode-$($packageDocument.version)"
$stagingPath = Join-Path $projectRoot "open-source\$packageName"
$releaseRoot = Join-Path $projectRoot "release\open-source"
$archivePath = Join-Path $releaseRoot "$packageName-source.zip"
$hashPath = "$archivePath.sha256"

& node (Join-Path $PSScriptRoot "prepare-open-source.mjs")
if ($LASTEXITCODE -ne 0) { throw "Open-source staging failed." }

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
Compress-Archive -LiteralPath $stagingPath -DestinationPath $archivePath -CompressionLevel Optimal -Force

$archiveHash = Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
Set-Content -Encoding ASCII -LiteralPath $hashPath -Value "$($archiveHash.Hash)  $([System.IO.Path]::GetFileName($archivePath))"

Write-Output "Open-source archive: $archivePath"
Write-Output "SHA-256: $($archiveHash.Hash)"
