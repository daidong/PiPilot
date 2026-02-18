#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const COMPONENTS_DIR = path.join(ROOT, 'examples/yolo-researcher/desktop/src/renderer/components')

const STRICT_NO_INLINE_STYLE_FILES = new Set([
  'examples/yolo-researcher/desktop/src/renderer/components/ActivityView.tsx',
  'examples/yolo-researcher/desktop/src/renderer/components/ControlPanel.tsx',
  'examples/yolo-researcher/desktop/src/renderer/components/EvidenceView.tsx',
  'examples/yolo-researcher/desktop/src/renderer/components/TerminalView.tsx',
  'examples/yolo-researcher/desktop/src/renderer/components/StatusBar.tsx'
])

const RULES = [
  {
    id: 'raw-hex-color',
    description: 'Raw hex color literal is not allowed in renderer components',
    regex: /(?<!&)#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
  },
  {
    id: 'raw-rgb-hsl-color',
    description: 'Raw rgb/rgba/hsl/hsla color literal is not allowed in renderer components',
    regex: /\b(?:rgba?|hsla?)\s*\(/g
  },
  {
    id: 'tailwind-status-color',
    description: 'Tailwind status color utility is not allowed; use token classes (t-status-*, t-dot-*)',
    regex: /\b(?:border|bg|text|accent)-(?:emerald|rose|amber|sky|violet|teal|red|green|yellow|blue|zinc|slate|neutral)-\d{2,3}(?:\/\d{1,3})?\b/g
  }
]

function toPos(source, index) {
  const head = source.slice(0, index)
  const lines = head.split('\n')
  return { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

async function collectTsxFiles(dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectTsxFiles(abs))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(abs)
  }
  return out
}

function findMatches(source, regex) {
  const results = []
  const re = new RegExp(regex.source, regex.flags)
  let match
  while ((match = re.exec(source)) !== null) {
    results.push({ index: match.index, text: match[0] })
  }
  return results
}

async function main() {
  try {
    await fs.access(COMPONENTS_DIR)
  } catch {
    console.log('[ui-color-guard] components directory not found, skipping.')
    return
  }

  const files = await collectTsxFiles(COMPONENTS_DIR)
  const errors = []

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
    const source = await fs.readFile(abs, 'utf8')

    for (const rule of RULES) {
      const hits = findMatches(source, rule.regex)
      for (const hit of hits) {
        const pos = toPos(source, hit.index)
        errors.push({
          file: rel,
          line: pos.line,
          col: pos.col,
          rule: rule.id,
          detail: `${rule.description}: ${hit.text}`
        })
      }
    }

    if (STRICT_NO_INLINE_STYLE_FILES.has(rel)) {
      const inlineStyleHits = findMatches(source, /style=\{\{/g)
      for (const hit of inlineStyleHits) {
        const pos = toPos(source, hit.index)
        errors.push({
          file: rel,
          line: pos.line,
          col: pos.col,
          rule: 'inline-style-forbidden',
          detail: 'Inline style is forbidden in strict files; use token utility classes instead'
        })
      }
    }
  }

  if (errors.length > 0) {
    console.error(`[ui-color-guard] Found ${errors.length} violation(s):`)
    for (const err of errors) {
      console.error(`- ${err.file}:${err.line}:${err.col} [${err.rule}] ${err.detail}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`[ui-color-guard] OK (${files.length} files checked)`)
}

main().catch((error) => {
  console.error('[ui-color-guard] failed:', error)
  process.exitCode = 1
})
