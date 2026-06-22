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
  "offscreen.html",
  "offscreen.js",
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
