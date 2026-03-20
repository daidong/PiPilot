#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: normalize-bibtex-keys.sh <file.bib>" >&2
  exit 1
fi

BIB_FILE="$1"
TMP_FILE="${BIB_FILE}.tmp"

if [ ! -f "$BIB_FILE" ]; then
  echo "BibTeX file not found: $BIB_FILE" >&2
  exit 1
fi

python3 - "$BIB_FILE" "$TMP_FILE" <<'PY'
import re
import sys

src = sys.argv[1]
dst = sys.argv[2]
counter = 0

entry_re = re.compile(r'^@([A-Za-z]+)\{([^,]+),')

with open(src, "r", encoding="utf-8") as f:
    lines = f.readlines()

normalized = []
for line in lines:
    m = entry_re.match(line)
    if not m:
        normalized.append(line)
        continue

    entry_type, raw_key = m.group(1), m.group(2)
    key = raw_key.lower()
    key = re.sub(r'[^a-z0-9:_-]+', '-', key).strip('-')
    if not key:
        counter += 1
        key = f"entry-{counter:04d}"

    normalized.append(entry_re.sub(f"@{entry_type}" + "{" + key + ",", line, count=1))

with open(dst, "w", encoding="utf-8") as f:
    f.writelines(normalized)
PY

mv "$TMP_FILE" "$BIB_FILE"
echo "normalized keys in $BIB_FILE"
