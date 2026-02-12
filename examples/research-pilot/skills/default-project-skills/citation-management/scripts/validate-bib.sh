#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: validate-bib.sh <file.bib>" >&2
  exit 1
fi

BIB_FILE="$1"

if [ ! -f "$BIB_FILE" ]; then
  echo "BibTeX file not found: $BIB_FILE" >&2
  exit 1
fi

ENTRY_COUNT="$(grep -cE '^@[A-Za-z]+' "$BIB_FILE" || true)"
YEAR_FIELDS="$(grep -cE '^\s*year\s*=' "$BIB_FILE" || true)"
TITLE_FIELDS="$(grep -cE '^\s*title\s*=' "$BIB_FILE" || true)"
AUTHOR_FIELDS="$(grep -cE '^\s*author\s*=' "$BIB_FILE" || true)"

echo "entries: $ENTRY_COUNT"
echo "title fields: $TITLE_FIELDS"
echo "author fields: $AUTHOR_FIELDS"
echo "year fields: $YEAR_FIELDS"

if [ "$ENTRY_COUNT" -eq 0 ]; then
  echo "warning: no BibTeX entries found" >&2
  exit 2
fi

echo "basic validation complete"
