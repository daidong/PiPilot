#!/usr/bin/env bash
set -euo pipefail

echo "[audit] git status"
git status --short || true

echo "[audit] todo count"
if command -v rg >/dev/null 2>&1; then
  rg --glob '!node_modules/**' --glob '!.git/**' "TODO|FIXME" . | wc -l | awk '{print $1}'
else
  grep -R --exclude-dir=node_modules --exclude-dir=.git -E "TODO|FIXME" . | wc -l | awk '{print $1}'
fi

echo "[audit] merge markers"
if command -v rg >/dev/null 2>&1; then
  rg --glob '!node_modules/**' --glob '!.git/**' "^(<<<<<<<|=======|>>>>>>>)" . || true
else
  grep -R --exclude-dir=node_modules --exclude-dir=.git -E "^(<<<<<<<|=======|>>>>>>>)" . || true
fi
