#!/usr/bin/env bash
set -euo pipefail

if command -v uv >/dev/null 2>&1; then
  uv pip install "markitdown[all]"
else
  python3 -m pip install --user "markitdown[all]"
fi

echo "markitdown installation completed"
