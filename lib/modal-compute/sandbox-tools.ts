/**
 * Sandboxed file tools for the Modal compute plan agent.
 *
 * Three tools (read_file, list_dir, grep) that are path-jailed to a sandbox
 * directory. All requested paths are resolved relative to the sandbox root
 * and rejected if they escape it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'

/** Resolve a path relative to the sandbox root and reject escapes. */
function safePath(sandboxRoot: string, requested: string): string | null {
  const resolved = path.resolve(sandboxRoot, requested)
  if (resolved !== sandboxRoot && !resolved.startsWith(sandboxRoot + path.sep)) {
    return null
  }
  return resolved
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

export function createSandboxTools(sandboxRoot: string): AgentTool[] {
  return [
    {
      name: 'read_file',
      label: 'Read File',
      description: 'Read the contents of a file. Path is relative to the working directory.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path to the file' }),
      }),
      execute: async (_id, params) => {
        const p = safePath(sandboxRoot, (params as any).path)
        if (!p) return textResult('Error: path is outside the working directory.')
        try {
          const content = fs.readFileSync(p, 'utf-8')
          return textResult(content)
        } catch (err) {
          return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
    {
      name: 'list_dir',
      label: 'List Directory',
      description:
        'List files and subdirectories. Path is relative to the working directory. Defaults to "." (root).',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: 'Relative directory path (default: ".")' })),
      }),
      execute: async (_id, params) => {
        const dir = safePath(sandboxRoot, (params as any).path ?? '.')
        if (!dir) return textResult('Error: path is outside the working directory.')
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
          return textResult(lines.join('\n') || '(empty)')
        } catch (err) {
          return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
    {
      name: 'grep',
      label: 'Search Files',
      description:
        'Search file contents for a pattern (case-insensitive substring match). Returns matching lines with filenames and line numbers.',
      parameters: Type.Object({
        pattern: Type.String({ description: 'Search string' }),
        path: Type.Optional(Type.String({ description: 'Directory or file to search (default: ".")' })),
      }),
      execute: async (_id, params) => {
        const { pattern, path: searchPath } = params as { pattern: string; path?: string }
        const root = safePath(sandboxRoot, searchPath ?? '.')
        if (!root) return textResult('Error: path is outside the working directory.')

        const results: string[] = []
        const search = pattern.toLowerCase()

        function walk(dir: string) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              walk(full)
            } else {
              try {
                const lines = fs.readFileSync(full, 'utf-8').split('\n')
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(search)) {
                    const rel = path.relative(sandboxRoot, full)
                    results.push(`${rel}:${i + 1}: ${lines[i]}`)
                  }
                }
              } catch { /* skip unreadable files */ }
            }
          }
        }

        try {
          const stat = fs.statSync(root)
          if (stat.isFile()) {
            const lines = fs.readFileSync(root, 'utf-8').split('\n')
            const rel = path.relative(sandboxRoot, root)
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(search)) {
                results.push(`${rel}:${i + 1}: ${lines[i]}`)
              }
            }
          } else {
            walk(root)
          }
        } catch (err) {
          return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }

        return textResult(results.length ? results.join('\n') : 'No matches.')
      },
    },
  ]
}
