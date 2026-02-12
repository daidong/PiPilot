#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: check-grant-compliance.sh <proposal-dir>" >&2
  exit 1
fi

PROPOSAL_DIR="$1"
REQUIRED_FILES=(
  "00-overview.md"
  "01-specific-aims.md"
  "02-methods.md"
  "03-risks-mitigation.md"
  "04-timeline-budget.md"
)

missing=0
for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$PROPOSAL_DIR/$file" ]; then
    echo "missing: $file"
    missing=$((missing + 1))
  fi
done

total_words=0
for file in "$PROPOSAL_DIR"/*.md; do
  [ -f "$file" ] || continue
  words="$(wc -w < "$file" | awk '{print $1}')"
  total_words=$((total_words + words))
  echo "$(basename "$file"): ${words} words"
done

echo "total_words: $total_words"
if [ "$missing" -gt 0 ]; then
  echo "compliance check failed: missing ${missing} required files" >&2
  exit 2
fi

echo "compliance check passed"
