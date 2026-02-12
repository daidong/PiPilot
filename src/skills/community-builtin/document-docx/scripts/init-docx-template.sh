#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: init-docx-template.sh <output.docx>" >&2
  exit 1
fi

OUTPUT_PATH="$1"

if ! python3 -c "from docx import Document" >/dev/null 2>&1; then
  echo "python-docx is not installed. Run setup-docx-tools.sh first." >&2
  exit 1
fi

python3 - "$OUTPUT_PATH" <<'PY'
import sys
from docx import Document

dst = sys.argv[1]
doc = Document()
doc.add_heading("Document Title", level=1)
doc.add_paragraph("Author: ")
doc.add_paragraph("Date: ")
doc.add_heading("Abstract", level=2)
doc.add_paragraph("")
doc.add_heading("Main Content", level=2)
doc.add_paragraph("")
doc.save(dst)
PY

echo "template created: $OUTPUT_PATH"
