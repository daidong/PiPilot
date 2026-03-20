#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: convert-file.sh <input-file> <output-md>" >&2
  exit 1
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"

if command -v markitdown >/dev/null 2>&1; then
  markitdown "$INPUT_PATH" -o "$OUTPUT_PATH"
elif python3 -c "import markitdown" >/dev/null 2>&1; then
  python3 -m markitdown "$INPUT_PATH" -o "$OUTPUT_PATH"
else
  UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.agentfoundry/cache/uv-cache}"
  UV_TOOL_DIR="${UV_TOOL_DIR:-$PWD/.agentfoundry/cache/uv-tools}"
  mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"
  env UV_CACHE_DIR="$UV_CACHE_DIR" UV_TOOL_DIR="$UV_TOOL_DIR" \
    uvx --from "markitdown[all]" markitdown "$INPUT_PATH" -o "$OUTPUT_PATH"
fi

echo "converted: $INPUT_PATH -> $OUTPUT_PATH"
