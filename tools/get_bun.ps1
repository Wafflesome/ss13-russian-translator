# Downloads the Bun JavaScript runtime the translator runs on (the official Windows build from
# github.com/oven-sh/bun, checked against its known SHA-256) into the runtime folder. Run by the .cmd files
# when runtime\bun.exe is missing; nothing is installed system-wide.
$ErrorActionPreference = 'Stop'
$version = '1.3.5'
$sha256 = '922cffdd5143cd118c6ccec6a61dfcf5d69e0068b048ea00f0a0615016530082'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$url = "https://github.com/oven-sh/bun/releases/download/bun-v$version/bun-windows-x64.zip"
$zip = Join-Path $env:TEMP ('bun-windows-x64-' + [Guid]::NewGuid().ToString('N') + '.zip')
$tmp = Join-Path $env:TEMP ('bun-' + [Guid]::NewGuid().ToString('N'))
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host "Downloading Bun $version (about 40 MB) from $url ..."
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($got -ne $sha256) { throw "The download does not match the expected checksum ($got)." }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem -LiteralPath $tmp -Recurse -Filter 'bun.exe' | Select-Object -First 1
  if (-not $exe) { throw 'bun.exe was not found in the download.' }
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $runtime 'bun.exe') -Force
  Write-Host 'Bun is ready.'
} catch {
  Write-Host ('Could not get Bun: ' + $_.Exception.Message)
  Write-Host "Download bun-windows-x64.zip (version $version) from https://github.com/oven-sh/bun/releases yourself and put bun.exe into the runtime folder."
  exit 1
} finally {
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
