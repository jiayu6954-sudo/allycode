param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
  $manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'launch-manifest.json') -Raw | ConvertFrom-Json
  foreach ($entry in @(@($manifest.executable, $manifest.executableSha256), @($manifest.archive, $manifest.archiveSha256))) {
    $artifactPath = [IO.Path]::GetFullPath((Join-Path $releaseRoot $entry[0]))
    if (-not $artifactPath.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid artifact path.' }
    if ((Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash -ne $entry[1]) { throw 'Build integrity mismatch. Please rebuild the local package.' }
  }
  foreach ($resource in $manifest.resources) {
    $resourcePath = [IO.Path]::GetFullPath((Join-Path $releaseRoot $resource.path))
    if (-not $resourcePath.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid resource path.' }
    if ((Get-FileHash -LiteralPath $resourcePath -Algorithm SHA256).Hash -ne $resource.sha256) { throw 'Skill resource integrity mismatch. Please rebuild the local package.' }
  }
  if ($CheckOnly) { Write-Output ('Verified AllyCode ' + $manifest.version + ' / ' + $manifest.sourceHash); exit 0 }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:ALLYCODE_VISION_HOME = Join-Path $projectRoot '.allycode\vision'
  $env:ALLYCODE_DOCUMENT_HOME = Join-Path $projectRoot '.allycode\documents'
  Start-Process -FilePath (Join-Path $releaseRoot $manifest.executable) -WorkingDirectory $projectRoot
} catch {
  Write-Host ('AllyCode launch failed: ' + $_.Exception.Message)
  Read-Host 'Press Enter to close'
  exit 1
}
