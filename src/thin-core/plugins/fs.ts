import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { PluginDefinition } from '../types.js'

export function fsPlugin(): PluginDefinition {
  return {
    manifest: {
      id: 'core.fs',
      version: '1.0.0',
      capabilities: ['fs'],
      permissions: {
        fs: {
          read: ['.'],
          write: ['.']
        }
      }
    },
    prompts: [
      'Use fs.read/fs.write/fs.list for file operations. Prefer reading existing files before edits.'
    ],
    tools: [
      {
        name: 'fs.read',
        description: 'Read UTF-8 text from a file path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to project root' }
          },
          required: ['path']
        },
        async execute(args, ctx) {
          const input = args as { path?: string }
          const path = input.path ?? ''
          const full = resolve(ctx.projectPath, path)
          const content = await readFile(full, 'utf8')
          return {
            ok: true,
            content,
            data: {
              path,
              bytes: Buffer.byteLength(content, 'utf8')
            }
          }
        }
      },
      {
        name: 'fs.write',
        description: 'Write UTF-8 content to a file path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to project root' },
            content: { type: 'string', description: 'File content' }
          },
          required: ['path', 'content']
        },
        async execute(args, ctx) {
          const input = args as { path?: string; content?: string }
          const path = input.path ?? ''
          const content = input.content ?? ''
          const full = resolve(ctx.projectPath, path)
          await mkdir(dirname(full), { recursive: true })
          await writeFile(full, content, 'utf8')
          return {
            ok: true,
            content: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}`,
            data: {
              path,
              bytes: Buffer.byteLength(content, 'utf8')
            }
          }
        }
      },
      {
        name: 'fs.list',
        description: 'List directory entries.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path relative to project root' }
          },
          required: []
        },
        async execute(args, ctx) {
          const input = args as { path?: string }
          const path = input.path ?? '.'
          const full = resolve(ctx.projectPath, path)
          const entries = await readdir(full, { withFileTypes: true })
          const formatted = entries.map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n')
          return {
            ok: true,
            content: formatted || '(empty)',
            data: {
              path,
              count: entries.length
            }
          }
        }
      }
    ]
  }
}
