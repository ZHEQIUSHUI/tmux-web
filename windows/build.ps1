# Builds the Windows app: build\tmux-web\ (tmux-web.exe and what it needs) and build\tmux-web-windows.zip.
# Needs the C# compiler of Visual Studio 2022 or its Build Tools (any edition) and .NET Framework 4.8,
# which Windows 10/11 have. Run from anywhere:  powershell -ExecutionPolicy Bypass -File windows\build.ps1
# Env: VERSION (the app's version, e.g. 2026.11.15.3), EASYTIER_DIR (a folder that already has
# easytier-core.exe 2.6.4, instead of downloading it), EASYTIER_BASE_URL (a mirror of the release).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Set-Location $PSScriptRoot

$Version = if ($env:VERSION) { $env:VERSION } else { '0.0.0.0' }
$WebView2Version = '1.0.4314.35'
$EasyTierVersion = '2.6.4'
$EasyTierZip = "easytier-windows-x86_64-v$EasyTierVersion.zip"
$EasyTierSha = '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84'
$EasyTierBase = if ($env:EASYTIER_BASE_URL) { $env:EASYTIER_BASE_URL } else { "https://github.com/EasyTier/EasyTier/releases/download/v$EasyTierVersion" }

$cache = Join-Path $PSScriptRoot '.build'
$out = Join-Path $PSScriptRoot 'build'
$app = Join-Path $out 'tmux-web'
New-Item -ItemType Directory -Force $cache | Out-Null

# ---- the compiler (Roslyn, from Visual Studio or its Build Tools)
$csc = $null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  $vs = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
  if ($vs) { $c = Join-Path $vs 'MSBuild\Current\Bin\Roslyn\csc.exe'; if (Test-Path $c) { $csc = $c } }
}
if (-not $csc) { throw 'C# compiler not found: install Visual Studio 2022 or its Build Tools (MSBuild).' }
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'

# ---- WebView2 SDK (NuGet)
$wv = Join-Path $cache "webview2-$WebView2Version"
if (-not (Test-Path (Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))) {
  Write-Host "downloading WebView2 SDK $WebView2Version"
  $nupkg = Join-Path $cache 'webview2.zip'
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebView2Version/microsoft.web.webview2.$WebView2Version.nupkg" -OutFile $nupkg -UseBasicParsing
  if (Test-Path $wv) { Remove-Item -Recurse -Force $wv }
  Expand-Archive $nupkg $wv
  Remove-Item $nupkg
}

# ---- EasyTier Core (no TUN: easytier-core.exe and its two DLLs)
$et = Join-Path $cache "easytier-$EasyTierVersion"
if (-not (Test-Path (Join-Path $et 'easytier-core.exe'))) {
  New-Item -ItemType Directory -Force $et | Out-Null
  if ($env:EASYTIER_DIR) {
    foreach ($f in 'easytier-core.exe', 'Packet.dll', 'wintun.dll') { Copy-Item (Join-Path $env:EASYTIER_DIR $f) $et }
  } else {
    $zip = Join-Path $cache $EasyTierZip
    if (-not (Test-Path $zip) -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $EasyTierSha) {
      Write-Host "downloading EasyTier $EasyTierVersion"
      Invoke-WebRequest "$EasyTierBase/$EasyTierZip" -OutFile "$zip.part" -UseBasicParsing
      if ((Get-FileHash "$zip.part" -Algorithm SHA256).Hash.ToLower() -ne $EasyTierSha) { throw "EasyTier download: SHA-256 mismatch" }
      Move-Item -Force "$zip.part" $zip
    }
    $tmp = Join-Path $cache 'et-unzip'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip $tmp
    foreach ($f in 'easytier-core.exe', 'Packet.dll', 'wintun.dll') {
      $src = Get-ChildItem -Recurse $tmp -Filter $f | Select-Object -First 1
      if (-not $src) { throw "$f not in $EasyTierZip" }
      Copy-Item $src.FullName $et
    }
    Remove-Item -Recurse -Force $tmp
  }
}

# ---- the icon, from the web page's (PNG entries in one .ico)
Add-Type -AssemblyName System.Drawing
$png = Join-Path $PSScriptRoot '..\src\web\public\icon-512.png'
$ico = Join-Path $cache 'app.ico'
$src = [System.Drawing.Image]::FromFile((Resolve-Path $png))
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$imgs = foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $s, $s); $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  , $ms.ToArray()
}
$src.Dispose()
$fs = [System.IO.File]::Create($ico)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$imgs[$i].Length); $w.Write([UInt32]$offset)
  $offset += $imgs[$i].Length
}
foreach ($d in $imgs) { $w.Write($d) }
$w.Close()

# ---- version, manifest
$num = ($Version -split '\.' | ForEach-Object { [int]$_ % 65535 }) -join '.'
@"
using System.Reflection;
[assembly: AssemblyTitle("tmux-web")]
[assembly: AssemblyProduct("tmux-web")]
[assembly: AssemblyDescription("tmux-web")]
[assembly: AssemblyCompany("tmux-web")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("$num")]
[assembly: AssemblyFileVersion("$num")]
[assembly: AssemblyInformationalVersion("$Version")]
"@ | Set-Content -Encoding UTF8 (Join-Path $cache 'Version.cs')

# ---- compile
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
New-Item -ItemType Directory -Force $app | Out-Null
$refs = 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Management.dll',
  'System.Security.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll', 'Microsoft.CSharp.dll' | ForEach-Object { "/r:$(Join-Path $fw $_)" }
$refs += "/r:$(Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.Core.dll')"
$refs += "/r:$(Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.WinForms.dll')"
$sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'src') -Filter *.cs | ForEach-Object FullName) + (Join-Path $cache 'Version.cs')
& $csc /nologo /noconfig /nostdlib- /target:winexe /platform:anycpu /optimize+ /langversion:latest /utf8output /codepage:65001 `
  /warn:4 /nowarn:1591 "/out:$(Join-Path $app 'tmux-web.exe')" "/win32icon:$ico" "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')" `
  $refs $sources
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

# ---- what it needs next to it
Copy-Item (Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.Core.dll') $app
Copy-Item (Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') $app
foreach ($rid in 'win-x64', 'win-arm64', 'win-x86') {
  $d = Join-Path $app "runtimes\$rid\native"
  New-Item -ItemType Directory -Force $d | Out-Null
  Copy-Item (Join-Path $wv "runtimes\$rid\native\WebView2Loader.dll") $d
}
Copy-Item -Recurse (Join-Path $PSScriptRoot 'ui') (Join-Path $app 'ui')
Copy-Item (Join-Path $PSScriptRoot '..\src\web\public\icon-192.png') (Join-Path $app 'ui\icon.png')
New-Item -ItemType Directory -Force (Join-Path $app 'EasyTier') | Out-Null
Copy-Item (Join-Path $et '*') (Join-Path $app 'EasyTier')
Copy-Item (Join-Path $PSScriptRoot '..\mac\ThirdParty\EasyTier-LICENSE') (Join-Path $app 'EasyTier\LICENSE.txt')
Copy-Item (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') $app
Copy-Item (Join-Path $PSScriptRoot '..\LICENSE') (Join-Path $app 'LICENSE.txt')

# ---- the zip: a tmux-web folder
$zipOut = Join-Path $out 'tmux-web-windows.zip'
if (Test-Path $zipOut) { Remove-Item $zipOut }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zipOut, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Write-Host "built $app and $zipOut ($Version)"
