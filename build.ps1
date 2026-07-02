# ============================================================
# AC-UST Build Script
# Copies extension runtime files into dist/ for stable local use.
# ============================================================

param(
  [string]$OutputDir = "dist",
  [switch]$Crx,
  [ValidateSet("Edge","Chrome")][string]$Browser = "Chrome",
  [string]$BrowserPath,
  [string]$KeyPath
)

$ErrorActionPreference = "Stop"

# Project root
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Runtime files/directories required by the extension
$FilesToCopy = @(
  "manifest.json",
  "background.js",
  "content.js",
  "page-confirm.js",
  "popup.html",
  "popup.js",
  "i18n.js",
  "offscreen.html",
  "offscreen.js",
  "_locales",
  "icons"
)

# Clean old output
if (Test-Path $OutputDir) {
  Write-Host "Cleaning old dist directory..."
  Remove-Item -Recurse -Force $OutputDir
}

# Create output directory
New-Item -ItemType Directory -Path $OutputDir | Out-Null

# Copy files
Write-Host "Building extension package..."
foreach ($file in $FilesToCopy) {
  $source = Join-Path $Root $file
  $dest = Join-Path $OutputDir $file
  
  if (Test-Path $source) {
    Copy-Item -Path $source -Destination $dest -Recurse
    Write-Host "  OK  $file"
  }
  else {
    Write-Host "  SKIP $file not found"
  }
}

# Inject version from manifest.json into popup.js
# CRITICAL: 必须用 [System.IO.File]::ReadAllText/WriteAllText 而非 Get-Content/Set-Content。
# PowerShell 的 Get-Content/Set-Content 默认用系统代码页 (中文 Windows 是 GBK)，
# 会把 UTF-8 中文字符损坏为乱码。.NET 方法默认 UTF-8 无 BOM，不破坏编码。
$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $manifest.version
# 构建时间戳:精确到秒,用于诊断"扩展实际加载的是哪次 build"
# 版本号相同(如 0.4.28)无法区分 SW 是否跑最新代码,构建时间戳可以。
$buildTime = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
if ($ver) {
  $popupPath = Join-Path $OutputDir "popup.js"
  # 用 .NET 方法读写,保证 UTF-8 编码不被损坏
  $popupContent = [System.IO.File]::ReadAllText($popupPath)
  $popupContent = $popupContent -replace "const APP_VERSION = '[^']*'", "const APP_VERSION = '$ver'"
  $popupContent = $popupContent -replace "const BUILD_TIME = '[^']*'", "const BUILD_TIME = '$buildTime'"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($popupPath, $popupContent, $utf8NoBom)
  Write-Host "  OK  popup.js (version injected: $ver, build: $buildTime)"
}

Write-Host ""
Write-Host "============================================"
Write-Host "Build complete! Directory: $(Resolve-Path $OutputDir)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open the Chrome/Edge extensions page"
Write-Host "  2. Enable Developer mode"
Write-Host "  3. Click 'Load unpacked'"
Write-Host "  4. Select the dist folder, not the project root"
Write-Host "============================================"
Write-Host ""

# ============================================================
# CRX packaging (optional, -Crx switch)
# ============================================================
if ($Crx) {
  # --- Resolve browser executable ---
  $browserExe = $null
  if ($BrowserPath) {
    if (Test-Path $BrowserPath) {
      $browserExe = $BrowserPath
    } else {
      Write-Error "Browser not found at: $BrowserPath"
      exit 1
    }
  } else {
    # Auto-detect
    $candidates = @()
    if ($Browser -eq "Edge") {
      $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
        "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe"
      )
    } else {
      $candidates = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
      )
    }
    foreach ($c in $candidates) {
      if (Test-Path $c) { $browserExe = $c; break }
    }
    if (-not $browserExe) {
      Write-Error "Cannot find $Browser executable. Use -BrowserPath to specify."
      exit 1
    }
  }
  Write-Host "Browser: $browserExe"

  # --- Resolve key path ---
  $distAbs = (Resolve-Path $OutputDir).Path
  if ($KeyPath) {
    $pemPath = $KeyPath
  } else {
    $pemPath = Join-Path $Root "ac-ust.pem"
  }
  $releasesDir = Join-Path $Root "releases"
  if (-not (Test-Path $releasesDir)) { New-Item -ItemType Directory -Path $releasesDir | Out-Null }
  $crxPath = Join-Path $releasesDir "ac-ust-v$ver.crx"

  $packArgs = @("--pack-extension=$distAbs")
  if (Test-Path $pemPath) {
    Write-Host "Reusing existing key: $pemPath"
    $packArgs += "--pack-extension-key=$pemPath"
  } else {
    Write-Host "First pack — browser will generate key at: $pemPath"
  }

  Write-Host ""
  Write-Host "Packaging CRX..."
  $process = Start-Process -FilePath $browserExe -ArgumentList $packArgs -Wait -NoNewWindow -PassThru

  if ($process.ExitCode -ne 0) {
    Write-Error "CRX packaging failed (exit code: $($process.ExitCode))"
    exit 1
  }

  # Browser outputs .crx next to the extension dir with same name
  $browserCrx = Join-Path (Split-Path $distAbs -Parent) "$((Split-Path $distAbs -Leaf)).crx"
  if (Test-Path $browserCrx) {
    Move-Item -Force $browserCrx $crxPath
  }
  # Move .pem if first time
  if (-not (Test-Path $pemPath)) {
    $browserPem = Join-Path (Split-Path $distAbs -Parent) "$((Split-Path $distAbs -Leaf)).pem"
    if (Test-Path $browserPem) {
      Move-Item -Force $browserPem $pemPath
    }
  }

  Write-Host ""
  Write-Host "============================================"
  Write-Host "CRX package created!"
  Write-Host "  CRX : $crxPath"
  Write-Host "  Key : $pemPath (keep this file safe - NOT tracked by git!)"
  Write-Host "============================================"
  Write-Host ""
  Write-Host "Note: .crx is for enterprise/offline distribution."
  Write-Host "For Chrome Web Store / Edge Add-ons, upload .zip instead."
  Write-Host ""
  Write-Host "!! IMPORTANT: Modern browsers BLOCK drag-and-drop CRX install !!"
  Write-Host "   Error: crx_required_proof_missing"
  Write-Host "   Reason: Browsers require Web Store signature on CRX files."
  Write-Host "   For personal multi-machine use:"
  Write-Host "     - Clone repo -> ./build.ps1 -> Load Unpacked dist/"
  Write-Host "     - Or wait for Chrome Web Store listing"
  Write-Host "   For enterprise deployment:"
  Write-Host "     - Use ExtensionInstallForcelist policy + update.xml"
  Write-Host "============================================"
}
