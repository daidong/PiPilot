#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: batch-convert.sh <input-dir> <output-dir>" >&2
  exit 1
fi

INPUT_DIR="$1"
OUTPUT_DIR="$2"

mkdir -p "$OUTPUT_DIR"

if command -v markitdown >/dev/null 2>&1; then
  MARKITDOWN_CMD=(markitdown)
elif python3 -c "import markitdown" >/dev/null 2>&1; then
  MARKITDOWN_CMD=(python3 -m markitdown)
else
  UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.agentfoundry/cache/uv-cache}"
  UV_TOOL_DIR="${UV_TOOL_DIR:-$PWD/.agentfoundry/cache/uv-tools}"
  mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"
  MARKITDOWN_CMD=(env UV_CACHE_DIR="$UV_CACHE_DIR" UV_TOOL_DIR="$UV_TOOL_DIR" uvx --from "markitdown[all]" markitdown)
fi

find "$INPUT_DIR" -type f | while IFS= read -r source_file; do
  rel_path="${source_file#"$INPUT_DIR"/}"
  file_stem="$(basename "$rel_path")"
  file_stem="${file_stem%.*}"
  out_dir="$OUTPUT_DIR/$(dirname "$rel_path")"
  out_file="$out_dir/$file_stem.md"

  mkdir -p "$out_dir"
  echo "converting: $source_file -> $out_file"

  "${MARKITDOWN_CMD[@]}" "$source_file" -o "$out_file" || {
    echo "warning: failed to convert $source_file" >&2
  }
done

echo "batch conversion complete: $INPUT_DIR -> $OUTPUT_DIR"
