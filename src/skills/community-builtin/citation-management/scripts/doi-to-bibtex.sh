#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: doi-to-bibtex.sh <doi> [output-bib]" >&2
  exit 1
fi

DOI="$1"
OUT_FILE="${2:-}"

ENTRY="$(curl -fsSL -H 'Accept: application/x-bibtex; charset=utf-8' "https://doi.org/${DOI}")"

if [ -z "$ENTRY" ]; then
  echo "No BibTeX returned for DOI: $DOI" >&2
  exit 1
fi

if [ -n "$OUT_FILE" ]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  printf "%s\n\n" "$ENTRY" >> "$OUT_FILE"
  echo "appended BibTeX to $OUT_FILE"
else
  printf "%s\n" "$ENTRY"
fi
