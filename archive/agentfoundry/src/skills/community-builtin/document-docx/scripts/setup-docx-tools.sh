#!/usr/bin/env bash
set -euo pipefail

if command -v uv >/dev/null 2>&1; then
  uv pip install "markitdown[all]" "python-docx>=1.1.0"
else
  python3 -m pip install --user "markitdown[all]" "python-docx>=1.1.0"
fi

echo "docx tools setup complete"
