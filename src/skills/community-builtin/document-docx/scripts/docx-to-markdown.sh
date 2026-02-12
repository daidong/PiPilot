#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: docx-to-markdown.sh <input.docx> <output.md>" >&2
  exit 1
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"

if command -v markitdown >/dev/null 2>&1; then
  markitdown "$INPUT_PATH" -o "$OUTPUT_PATH"
elif command -v pandoc >/dev/null 2>&1; then
  pandoc "$INPUT_PATH" -f docx -t markdown -o "$OUTPUT_PATH"
else
  uvx --from "markitdown[all]" markitdown "$INPUT_PATH" -o "$OUTPUT_PATH"
fi

echo "converted: $INPUT_PATH -> $OUTPUT_PATH"
