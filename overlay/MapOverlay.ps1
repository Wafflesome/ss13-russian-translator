# SS13 Translator - map overlay worker.
# Watches the game's map area of the screen for speech bubbles (rows of outlined, single-colour letters)
# and draws the English labels the translator sends back over them, following each bubble as it moves.
# It reads the Russian letters in the game's own pixel fonts (to know which chat line a bubble is, and the
# hover name at the top of the map); the bubble English comes from the already-translated chat.
# Started and stopped by the translator (src/overlay.js).
param(
  [string]$LogFile = "",
  [string]$DebugDir = "",
  [int]$IntervalMs = 450,
  [string]$CacheDir = "",
  [int]$ShowInScreenshots = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Say([string]$json) { [Console]::Out.WriteLine($json); [Console]::Out.Flush() }

try {
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms
  $files = @((Join-Path $PSScriptRoot 'OverlayHost.cs'), (Join-Path $PSScriptRoot 'PixelReader.cs'))
  # The overlay code is compiled once (optimised) and kept in the cache folder; it is compiled again only
  # when the .cs files change. That makes the overlay start faster and run with less processor time.
  $loaded = $false
  if ($CacheDir) {
    try {
      $hash = (($files | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.Substring(0, 12) }) -join '')
      $dll = Join-Path $CacheDir ('overlay_' + $hash + '.dll')
      if (-not (Test-Path -LiteralPath $dll)) {
        New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
        Get-ChildItem -LiteralPath $CacheDir -Filter 'overlay_*.dll' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        $tmp = Join-Path $CacheDir ('overlay_build_' + [Guid]::NewGuid().ToString('N') + '.dll')
        $cp = New-Object System.CodeDom.Compiler.CompilerParameters
        [void]$cp.ReferencedAssemblies.Add('System.dll')
        [void]$cp.ReferencedAssemblies.Add('System.Core.dll')
        [void]$cp.ReferencedAssemblies.Add('System.Drawing.dll')
        [void]$cp.ReferencedAssemblies.Add('System.Windows.Forms.dll')
        $cp.GenerateInMemory = $false
        $cp.GenerateExecutable = $false
        $cp.IncludeDebugInformation = $false
        $cp.CompilerOptions = '/optimize+'
        $cp.TreatWarningsAsErrors = $false
        $cp.WarningLevel = 1
        $cp.OutputAssembly = $tmp
        $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
        $result = $provider.CompileAssemblyFromFile($cp, [string[]]$files)
        if ($result.Errors.HasErrors) {
          $all = @($result.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { $_.ToString() })
          throw ('compile: ' + ($all -join ' | '))
        }
        Move-Item -LiteralPath $tmp -Destination $dll -Force
      }
      [void][System.Reflection.Assembly]::LoadFrom($dll)
      $null = [SS13Overlay.Host]
      $loaded = $true
    } catch {
      if ($LogFile) { try { Add-Content -LiteralPath $LogFile -Value ('cached build not used: ' + $_.Exception.Message) } catch { } }
    }
  }
  if (-not $loaded) {
    $ev = @()
    $term = $null
    try {
      Add-Type -Path $files -ReferencedAssemblies System.Drawing, System.Windows.Forms -IgnoreWarnings -ErrorAction SilentlyContinue -ErrorVariable ev
    } catch { $term = $_ }
    if ($ev.Count -gt 0 -or $term) {
      # every compiler message goes to logs/overlay.log, not just the first
      $msgs = @($ev | ForEach-Object { $_.ToString() })
      if ($term) { $msgs += $term.ToString() }
      if ($LogFile) { try { Add-Content -LiteralPath $LogFile -Value ('compile failed:' + [Environment]::NewLine + '  ' + ($msgs -join ([Environment]::NewLine + '  '))) } catch { } }
      throw ($msgs -join ' | ')
    }
  }
} catch {
  Say ('{"t":"error","code":"compile","msg":"' + ($_.Exception.Message -replace '["\\\r\n]', ' ') + '"}')
  exit 2
}

$dbg = $null
if ($DebugDir) { $dbg = $DebugDir }
try {
  # 0: the English boxes are left out of screen captures (the overlay's own and screenshots) - fastest
  [SS13Overlay.Host]::HideFromCapture = ($ShowInScreenshots -eq 0)
  [SS13Overlay.Host]::Start((Join-Path $PSScriptRoot 'fonts'), $LogFile, $dbg)
} catch {
  Say ('{"t":"error","code":"start","msg":"' + ($_.Exception.Message -replace '["\\\r\n]', ' ') + '"}')
  exit 3
}
# Start() reports {"t":"ready"}. RunLoop runs until the translator sends Q (or closes our input).
[SS13Overlay.Host]::RunLoop($IntervalMs)
