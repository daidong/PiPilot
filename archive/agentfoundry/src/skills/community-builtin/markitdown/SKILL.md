---
name: markitdown
description: Convert files and office documents to Markdown. Supports PDF, DOCX, PPTX, XLSX, images (with OCR), audio (with transcription), HTML, CSV, JSON, XML, ZIP, YouTube URLs, EPubs and more.
allowed-tools:
  - skill-script-run
license: MIT
source: https://github.com/microsoft/markitdown
id: markitdown
shortDescription: Convert local files to Markdown via Microsoft MarkItDown
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - community
  - document-conversion
  - markdown
meta:
  approvedByUser: true
  capabilities:
    convert_to_markdown:
      script: convert-file
      extensions:
        - pdf
        - docx
        - pptx
        - xlsx
        - csv
        - html
        - json
        - xml
        - txt
        - md
        - epub
  upstream:
    repo: https://github.com/K-Dense-AI/claude-scientific-writer
    path: skills/markitdown
---

# MarkItDown - File to Markdown Conversion

## Overview

MarkItDown converts many document and media formats into Markdown optimized for LLM workflows.

Use this skill when you need to:
- Convert research papers and reports into markdown for analysis
- Extract text from office files or scanned docs
- Normalize heterogeneous source files before indexing/RAG

## Preferred Workflow in AgentFoundry

1. Ensure tool availability:
- Use `skill-script-run` and run script `setup-markitdown` once per environment.

2. Convert a single file:
- Run script `convert-file` with input path and output path.

3. Batch convert:
- Run script `batch-convert` with input directory and output directory.

4. Validate quality:
- Read output markdown and check tables, equations, and OCR-heavy sections.

## Script Interface

### `setup-markitdown`

Install MarkItDown with broad format support:

```bash
skill-script-run {
  "skillId": "markitdown",
  "script": "setup-markitdown"
}
```

### `convert-file`

Convert one file to markdown:

```bash
skill-script-run {
  "skillId": "markitdown",
  "script": "convert-file",
  "args": ["input.pdf", "output.md"]
}
```

### `batch-convert`

Convert all supported files in a directory:

```bash
skill-script-run {
  "skillId": "markitdown",
  "script": "batch-convert",
  "args": ["./docs", "./markdown"]
}
```

## Notes

- Markdown output quality depends on source file quality.
- For large batches, convert in chunks and review failures file-by-file.
- For OCR/transcription workloads, install optional extras (`[all]`) via `setup-markitdown`.
