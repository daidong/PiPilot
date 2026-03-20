#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: extract-docx-text.sh <input.docx> <output.txt>" >&2
  exit 1
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"

if ! python3 -c "from docx import Document" >/dev/null 2>&1; then
  echo "python-docx is not installed. Run setup-docx-tools.sh first." >&2
  exit 1
fi

python3 - "$INPUT_PATH" "$OUTPUT_PATH" <<'PY'
import sys
from docx import Document

src, dst = sys.argv[1], sys.argv[2]
doc = Document(src)
lines = [p.text for p in doc.paragraphs]
with open(dst, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
PY

echo "extracted text: $INPUT_PATH -> $OUTPUT_PATH"
