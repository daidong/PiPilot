#!/usr/bin/env node
/**
 * Build-time script: reads SKILL.md files and generates _generated.ts
 * with inlined Markdown content as string constants.
 *
 * This eliminates all runtime filesystem reads, making skills work
 * identically in unbundled ESM (tsx/node) and bundled (electron-vite).
 *
 * SKILL.md files remain the single source of truth.
 *
 * Usage:
 *   node examples/research-pilot/skills/generate-skill-content.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Auto-discover: any subdirectory containing SKILL.md (exclude default-project-skills)
const skillDirs = readdirSync(__dirname).filter(name => {
  if (name === 'default-project-skills') return false
  if (name.startsWith('_') || name.startsWith('.')) return false
  const fullPath = join(__dirname, name)
  return statSync(fullPath).isDirectory() && (() => {
    try { readFileSync(join(fullPath, 'SKILL.md'), 'utf-8'); return true } catch { return false }
  })()
})

const exports = []
const entries = []

for (const dir of skillDirs.sort()) {
  const content = readFileSync(join(__dirname, dir, 'SKILL.md'), 'utf-8')
  const varName = dir.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + 'Content'
  exports.push(`export const ${varName} = ${JSON.stringify(content)}`)
  entries.push(`  '${dir}': ${varName},`)
}

const output = `/**
 * AUTO-GENERATED — do not edit manually.
 * Run: node examples/research-pilot/skills/generate-skill-content.mjs
 *
 * Source of truth: SKILL.md files in sibling directories.
 */

${exports.join('\n\n')}

/** All skill content keyed by directory name */
export const skillContent: Record<string, string> = {
${entries.join('\n')}
}
`

const outPath = join(__dirname, '_generated.ts')
writeFileSync(outPath, output, 'utf-8')
console.log(`[generate-skill-content] wrote ${outPath} (${skillDirs.length} skills: ${skillDirs.join(', ')})`)
