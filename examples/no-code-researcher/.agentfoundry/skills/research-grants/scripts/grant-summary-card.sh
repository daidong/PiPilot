#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: grant-summary-card.sh <proposal-dir> <output-file>" >&2
  exit 1
fi

PROPOSAL_DIR="$1"
OUTPUT_FILE="$2"

{
  echo "# Grant Summary Card"
  echo
  echo "Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  for file in \
    "00-overview.md" \
    "01-specific-aims.md" \
    "02-methods.md" \
    "03-risks-mitigation.md" \
    "04-timeline-budget.md"; do
    target="$PROPOSAL_DIR/$file"
    if [ -f "$target" ]; then
      echo "## ${file}"
      sed -n '1,40p' "$target"
      echo
    fi
  done
} > "$OUTPUT_FILE"

echo "summary card written to $OUTPUT_FILE"
