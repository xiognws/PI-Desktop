param([string]$Root = 'D:\Code\PI-Desktop-main\apps\desktop\release\win-unpacked')
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing

# Acceptance for a packaged Windows unpacked tree.
#
# Everything here is a failure the pipeline produced at least once and nobody
# noticed until it shipped: Electron's own icon in the taskbar, Electron's
# ProductName in Properties, a stale locale bundle still carrying retired copy,
# and an unsigned CPython that came back after a rebuild. The checks are content
# based (hashes and strings inside the artifacts), not timestamps.

$repo = 'D:\Code\PI-Desktop-main'
$brandIcon = Join-Path $repo 'apps\desktop\build\icon.ico'
$exe = Join-Path $Root 'Pi-Workspace.exe'
$failures = New-Object System.Collections.Generic.List[string]

function Get-IconHash([string]$path) {
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if (-not $icon) { return 'no-icon' }
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray())
    $hex = -join ($sha | ForEach-Object { $_.ToString('x2') })
    $bmp.Dispose(); $icon.Dispose(); $ms.Dispose()
    return $hex.Substring(0, 16)
  } catch { return 'unreadable' }
}

function Test-Marker([string]$file, [string]$text, [bool]$shouldExist, [string]$label) {
  if (-not (Test-Path -LiteralPath $file)) {
    $failures.Add("missing file for $label")
    return
  }
  $found = [bool](Select-String -LiteralPath $file -Pattern $text -SimpleMatch -Quiet -ErrorAction SilentlyContinue)
  Write-Output ("  {0,-34} {1}" -f $label, $found)
  if ($shouldExist -and -not $found) { $failures.Add("missing: $label") }
  if (-not $shouldExist -and $found) { $failures.Add("stale content still shipped: $label") }
}

Write-Output "=== tree: $Root ==="
if (-not (Test-Path -LiteralPath $exe)) { Write-Output "MISSING exe: $exe"; exit 1 }
$appExe = Get-Item -LiteralPath $exe
$sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
Write-Output ("exe        {0,12} bytes  {1}  sha256={2}" -f $appExe.Length, $appExe.LastWriteTime.ToString('MM-dd HH:mm'), $sha.Substring(0, 16))

# 1. Brand identity, not Electron's.
$version = $appExe.VersionInfo
Write-Output ("metadata   ProductName='{0}' FileVersion='{1}' Company='{2}'" -f $version.ProductName, $version.FileVersion, $version.CompanyName)
if ($version.ProductName -ne 'Pi-Workspace') { $failures.Add("ProductName is '$($version.ProductName)' (resource editing was skipped)") }
if (-not $version.FileVersion) { $failures.Add('FileVersion is empty') }

$exeIcon = Get-IconHash $exe
$wantIcon = Get-IconHash $brandIcon
Write-Output ("icon       exe={0}  build/icon.ico={1}" -f $exeIcon, $wantIcon)
if ($exeIcon -ne $wantIcon) { $failures.Add("exe icon $exeIcon does not match build/icon.ico $wantIcon") }

# 2. Host binary and plugin set.
$hostCore = Join-Path $Root 'resources\bin\pi-desktop-host-core.exe'
if (Test-Path -LiteralPath $hostCore) {
  $hc = Get-Item -LiteralPath $hostCore
  Write-Output ("host-core  {0,12} bytes  sha256={1}" -f $hc.Length, (Get-FileHash -LiteralPath $hostCore -Algorithm SHA256).Hash.Substring(0, 16))
} else { $failures.Add('missing resources/bin/pi-desktop-host-core.exe') }

$plugins = (Get-ChildItem -Directory (Join-Path $Root 'resources\plugins') -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output ("plugins    {0}" -f $plugins)
# The expectation is the staged set in this checkout, not a fixed number: plugins are
# retired on purpose (scripts/bundled-plugins-excluded.json), so a hard-coded floor
# turned every correct build red the day ten of them were removed. Falling back to a
# floor only when the checkout is unavailable keeps the check meaningful off-tree.
$stagedPlugins = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\desktop\resources\plugins'
if (Test-Path -LiteralPath $stagedPlugins) {
  $expectedPlugins = (Get-ChildItem -Directory $stagedPlugins | Measure-Object).Count
  Write-Output ("plugins    expected {0} from the staged set" -f $expectedPlugins)
  if ($plugins -lt $expectedPlugins) { $failures.Add("only $plugins plugins, staged set has $expectedPlugins") }
} elseif ($plugins -lt 30) {
  $failures.Add("only $plugins plugins")
}

foreach ($retired in @('pi.clipboard-history', 'cn.star.computer-use')) {
  if (Test-Path -LiteralPath (Join-Path $Root "resources\plugins\$retired")) {
    $failures.Add("retired plugin still bundled: $retired")
  }
}

# 3. Content markers. The agent runtime ships outside the asar; the Settings
#    panel and the main process ship inside it.
$asar = Join-Path $Root 'resources\app.asar'
$sidecar = Join-Path $Root 'resources\agent-runtime\sidecar.js'
Write-Output ''
Test-Marker $sidecar 'stale tool output cleared' $true 'runtime: stale tool-result elision'
Test-Marker $sidecar 'contextWindowTokens' $true 'runtime: window-sized output budget'
Test-Marker $sidecar 'Batching: when several reads' $true 'runtime: batching guidance'
Test-Marker $asar 'driveRootPythonDirs' $true 'asar: interpreter scan reads the drive'
Test-Marker $asar 'pythonLibraryCount' $true 'asar: library count per interpreter'
Test-Marker $asar 'pythonHasLibraries' $false 'asar: retired completeness badge'

# 4. When this packaging config ships an interpreter, it must be the signed one.
#    `resources/python` is not an extraResource of the desktop package, so a build made
#    by `scripts/package-windows.mjs` never carries it; requiring it unconditionally
#    turned every correct build red for a capability the pipeline does not ship.
$py = Join-Path $Root 'resources\python\runtime\python.exe'
$pyConfigured = $false
$manifestPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\desktop\package.json'
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $pyConfigured = @($manifest.build.extraResources | Where-Object { $_ -match 'resources[/\\]python' }).Count -gt 0
}
if (Test-Path -LiteralPath $py) {
  $sig = Get-AuthenticodeSignature -LiteralPath $py
  Write-Output ("python     {0}  {1}" -f $sig.Status, $sig.SignerCertificate.Subject)
  if ($sig.Status -ne 'Valid') { $failures.Add('bundled python.exe is not signed') }
} elseif ($pyConfigured) {
  $failures.Add('missing bundled python')
} else {
  Write-Output 'python     not shipped by this packaging config'
}

Write-Output ''
if ($failures.Count -eq 0) {
  Write-Output 'RESULT: PASS'
  exit 0
}
Write-Output 'RESULT: FAIL'
foreach ($f in $failures) { Write-Output ("  - {0}" -f $f) }
exit 1
