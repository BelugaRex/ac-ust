#!/usr/bin/env bash
# ============================================================
# AC-UST Build Script (WSL/Linux)
# Builds dist/ and packages a ZIP for Chrome Web Store / Edge Add-ons upload.
# Requires Python 3 only.
# ============================================================

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DIST="$ROOT/dist"
RELEASES="$ROOT/releases"
RUNTIME_FILES=(
  manifest.json
  background.js
  content.js
  page-confirm.js
  popup.html
  popup.css
  popup.js
  popup-diagnostic-fallback.js
  i18n.js
  billing-helpers.js
  sync-helpers.js
  pwm-phase.js
  smart-mode.js
  offscreen.html
  offscreen.js
  _locales
  icons
)

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to run build.sh." >&2
  exit 1
fi

VERSION="$(python3 - "$ROOT/manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as manifest_file:
    print(json.load(manifest_file)['version'])
PY
)"
IFS='|' read -r BUILD_TIME_EPOCH_MS BUILD_TIME < <(python3 <<'PY'
from datetime import datetime
import time

epoch_ms = int(time.time() * 1000)
build_time = datetime.fromtimestamp(epoch_ms / 1000).strftime('%Y-%m-%d %H:%M:%S')
print(f'{epoch_ms}|{build_time}')
PY
)

echo "Cleaning old dist directory..."
rm -rf "$DIST"
mkdir -p "$DIST" "$RELEASES"

echo "Building extension package..."
for file in "${RUNTIME_FILES[@]}"; do
  source_path="$ROOT/$file"
  if [[ -e "$source_path" ]]; then
    cp -R "$source_path" "$DIST/"
    echo "  OK  $file"
  else
    echo "  SKIP $file not found"
  fi
done

python3 - "$DIST/popup.js" "$DIST/popup.html" "$VERSION" "$BUILD_TIME" "$BUILD_TIME_EPOCH_MS" <<'PY'
import re
import sys

popup_path, popup_html_path, version, build_time, build_time_epoch_ms = sys.argv[1:]
with open(popup_path, encoding='utf-8') as popup_file:
    content = popup_file.read()

content, version_replacements = re.subn(
    r"const APP_VERSION = '[^']*'",
    f"const APP_VERSION = '{version}'",
    content,
    count=1,
)
content, build_time_replacements = re.subn(
    r"const BUILD_TIME = '[^']*'",
    f"const BUILD_TIME = '{build_time}'",
    content,
    count=1,
)
content, build_epoch_replacements = re.subn(
  r"const BUILD_TIME_EPOCH_MS = \d+;",
  f"const BUILD_TIME_EPOCH_MS = {build_time_epoch_ms};",
  content,
  count=1,
)
if version_replacements != 1 or build_time_replacements != 1 or build_epoch_replacements != 1:
  raise SystemExit('Could not inject version, build time, and build epoch into dist/popup.js.')

with open(popup_path, 'w', encoding='utf-8', newline='\n') as popup_file:
    popup_file.write(content)

with open(popup_html_path, encoding='utf-8') as popup_html_file:
  popup_html = popup_html_file.read()

popup_html, cache_version_replacements = re.subn(
  r'(popup\.(?:css|js)\?v=)[^"\s]+',
  rf'\g<1>{version}',
  popup_html,
)
if cache_version_replacements != 2:
  raise SystemExit('Could not inject both popup asset cache versions into dist/popup.html.')

with open(popup_html_path, 'w', encoding='utf-8', newline='\n') as popup_html_file:
  popup_html_file.write(popup_html)
PY
echo "  OK  popup assets (version: $VERSION, build: $BUILD_TIME, epoch: $BUILD_TIME_EPOCH_MS)"

ZIP_PATH="$RELEASES/ac-ust-v$VERSION.zip"
rm -f "$ZIP_PATH"

echo "Packaging ZIP for Chrome Web Store / Edge Add-ons..."
python3 - "$DIST" "$ZIP_PATH" <<'PY'
import sys
import zipfile
from pathlib import Path

dist_path = Path(sys.argv[1])
zip_path = Path(sys.argv[2])
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(dist_path.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(dist_path).as_posix())
PY

ZIP_KB="$(python3 - "$ZIP_PATH" <<'PY'
import os
import sys

print(round(os.path.getsize(sys.argv[1]) / 1024, 1))
PY
)"

echo ""
echo "============================================"
echo "Build complete!"
echo "  dist/ : $DIST"
echo "  ZIP  : $ZIP_PATH ($ZIP_KB KB)"
echo "============================================"
echo ""
echo "Load Unpacked from dist/ in chrome://extensions or edge://extensions."
