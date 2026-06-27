# ============================================================
# AC-UST Build Script
# Copies extension runtime files into dist/ for stable local use.
# ============================================================

param(
  [string]$OutputDir = "dist"
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
$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw | ConvertFrom-Json
$ver = $manifest.version
# 构建时间戳:精确到秒,用于诊断"扩展实际加载的是哪次 build"
# 版本号相同(如 0.4.28)无法区分 SW 是否跑最新代码,构建时间戳可以。
$buildTime = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
if ($ver) {
  $popupPath = Join-Path $OutputDir "popup.js"
  $popupContent = Get-Content $popupPath -Raw
  $popupContent = $popupContent -replace "const APP_VERSION = '[^']*'", "const APP_VERSION = '$ver'"
  $popupContent = $popupContent -replace "const BUILD_TIME = '[^']*'", "const BUILD_TIME = '$buildTime'"
  Set-Content $popupPath -Value $popupContent -NoNewline
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
