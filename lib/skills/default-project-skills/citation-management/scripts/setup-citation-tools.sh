#!/usr/bin/env bash
set -euo pipefail

if command -v uv >/dev/null 2>&1; then
  uv pip install "bibtexparser>=1.4.0"
else
  python3 -m pip install --user "bibtexparser>=1.4.0"
fi

echo "citation tools setup complete"
