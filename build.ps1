# ============================================================
# AC-UST Build Script
# Builds dist/ and packages a ZIP for Chrome Web Store / Edge Add-ons upload.
# Default (no flags): build + ZIP.  -Crx: also package CRX (deprecated, enterprise only).
# ============================================================

param(
  [string]$OutputDir = "dist",
  [switch]$Crx,
  [switch]$Zip,
  [ValidateSet("Edge","Chrome")][string]$Browser = "Chrome",
  [string]$BrowserPath,
  [string]$KeyPath
)

$ErrorActionPreference = "Stop"

# Default: produce ZIP for store upload (primary workflow since store launch).
# -Crx is explicit opt-in; when used alone, skip auto-ZIP.
if (-not $Crx -and -not $Zip) {
  $Zip = $true
}

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
  "sync-helpers.js",
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
Write-Host "Build complete! dist/ staged: $(Resolve-Path $OutputDir)"
Write-Host "============================================"
Write-Host ""

# ============================================================
# CRX packaging (optional, -Crx switch)
# ============================================================
if ($Crx) {
  Write-Host ""
  Write-Host "!! DEPRECATED: -Crx is no longer the recommended packaging method."
  Write-Host "   Users should install from Chrome Web Store / Edge Add-ons."
  Write-Host "   Use -Zip for store upload packages instead."
  Write-Host "   CRX is kept ONLY for enterprise policy deployment (ExtensionInstallForcelist)."
  Write-Host ""
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

# ============================================================
# ZIP packaging (default behavior, -Zip switch)
#   生成可直接上传 Chrome Web Store / Edge Add-ons 的 ZIP 包。
#   默认行为: 不指定 -Crx 时自动执行。
# ============================================================
if ($Zip) {
  $distAbs = (Resolve-Path $OutputDir).Path
  $releasesDir = Join-Path $Root "releases"
  if (-not (Test-Path $releasesDir)) { New-Item -ItemType Directory -Path $releasesDir | Out-Null }
  $zipPath = Join-Path $releasesDir "ac-ust-v$ver.zip"

  # 先删除旧 ZIP (Compress-Archive 在 -Force 模式下不会删自还会叠)
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  # 清空同名旧 .crx 不会被影响

  Write-Host ""
  Write-Host "Packaging ZIP for Chrome Web Store / Edge Add-ons..."
  # 关键: 必须进 dist 目录制包, 仓库根目录额外文件不应进 ZIP
  # 用 -Path "$distAbs/*" 打包 dist 内内容(不含 dist 父目录)
  Push-Location $distAbs
  Compress-Archive -Path "./*" -DestinationPath $zipPath -CompressionLevel Optimal
  Pop-Location

  if (-not (Test-Path $zipPath)) {
    Write-Error "ZIP packaging failed"
    exit 1
  }

  $zipKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  Write-Host ""
  Write-Host "============================================"
  Write-Host "ZIP package created!"
  Write-Host "  ZIP : $zipPath ($zipKb KB)"
  Write-Host "============================================"
  Write-Host ""
  Write-Host "上传到 Chrome Web Store:"
  Write-Host "  1. https://chrome.google.com/webstore/devconsole"
  Write-Host "  2. 选 AC-UST 项目 -> 打包 -> 上传新的 ZIP"
  Write-Host "  3. version 必须 > 上次发布版本(Chrome Web Store 严格递增)"
  Write-Host "上传到 Edge Add-ons:"
  Write-Host "  1. https://partner.microsoft.com/dashboard/microsoftedge"
  Write-Host "  2. Update -> Upload package"
  Write-Host "============================================"
}

# ZIP is now default — no "no package" path exists
