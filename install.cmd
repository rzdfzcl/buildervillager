@echo off
chcp 65001 >nul
setlocal
set "BV_INSTALL_SELF=%~f0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$lines=Get-Content -LiteralPath $env:BV_INSTALL_SELF; $i=[Array]::IndexOf($lines,'# POWERSHELL-BEGIN'); & ([scriptblock]::Create(($lines[($i+1)..($lines.Length-1)] -join [Environment]::NewLine)))"
if not errorlevel 1 exit /b 0
echo Installation failed. See the error above.
pause
exit /b 1
# POWERSHELL-BEGIN
$ErrorActionPreference = 'Stop'
function Get-InstallerHash([string]$File,[string]$Algorithm) {
  $hasher=[Security.Cryptography.HashAlgorithm]::Create($Algorithm)
  $stream=[IO.File]::OpenRead($File)
  try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
}
try {
  $version = '0.1.4'
  $base = Split-Path -Parent $env:BV_INSTALL_SELF
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (!$node) { throw 'Node.js 22.16+ is required to run this installer.' }
  $entry = Join-Path $base 'bin/buildervillager.js'
  if (!(Test-Path -LiteralPath $entry)) {
    $archive = Join-Path $base ('rzdfzcl-buildervillager-' + $version + '.tgz')
    if (!(Test-Path -LiteralPath $archive)) {
      Write-Host 'Downloading complete BuilderVillager installation package...'
      $temporary = $archive + '.download'
      $metadata = $null
      try { $metadata = Invoke-RestMethod ('https://registry.npmjs.org/@rzdfzcl/buildervillager/' + $version) -TimeoutSec 20 } catch { Write-Host 'Using GitHub Release download...' }
      if ($metadata) {
        Invoke-WebRequest -UseBasicParsing $metadata.dist.tarball -OutFile $temporary
        $expected = [Convert]::FromBase64String(($metadata.dist.integrity -replace '^sha512-', ''))
        $expectedHex = ([BitConverter]::ToString($expected) -replace '-', '').ToLowerInvariant()
        if ((Get-InstallerHash $temporary 'SHA512') -ne $expectedHex) { throw 'Package integrity check failed.' }
      } else {
        $release = 'https://github.com/rzdfzcl/buildervillager/releases/download/v' + $version
        $sums = (Invoke-WebRequest -UseBasicParsing ($release + '/SHA256SUMS.txt')).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $name = [IO.Path]::GetFileName($archive)
        $line = @(([string]$sums) -split '\r?\n' | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($name) + '$') })
        if ($line.Count -ne 1) { throw 'GitHub Release checksum is missing.' }
        $expectedHex = ($line[0] -split '\s+')[0].ToLowerInvariant()
        Invoke-WebRequest -UseBasicParsing ($release + '/' + $name) -OutFile $temporary
        if ((Get-InstallerHash $temporary 'SHA256') -ne $expectedHex) { throw 'Package integrity check failed.' }
      }
      Move-Item -LiteralPath $temporary -Destination $archive -Force
    }
    $cache = Join-Path $base ('.buildervillager-installer/' + $version)
    $entry = Join-Path $cache 'package/bin/buildervillager.js'
    $ready = Join-Path $cache 'ready.txt'
    if (!(Test-Path -LiteralPath $ready)) {
      Write-Host 'Extracting complete installation package...'
      New-Item -ItemType Directory -Force -Path $cache | Out-Null
      & (Join-Path $env:SystemRoot 'System32/tar.exe') -xf $archive -C $cache
      if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $entry)) { throw 'Package extraction failed.' }
      Set-Content -LiteralPath $ready -Value $version -Encoding ASCII
    }
  }
  Write-Host 'Starting installation automatically...'
  $arguments = @($entry, '--dir', (Join-Path $base 'buildervillager-server'), '--no-interactive')
  if ($env:BV_INSTALL_CHECK_ONLY -eq '1') { $arguments += '--check' }
  & $node.Source @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ('Ready. Start both services with: ' + (Join-Path $base 'buildervillager-server/start.cmd'))
  exit 0
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
