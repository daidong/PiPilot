import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { PluginDefinition } from '../types.js'

const exec = promisify(execCb)

export function execPlugin(): PluginDefinition {
  return {
    manifest: {
      id: 'core.exec',
      version: '1.0.0',
      capabilities: ['bash'],
      permissions: {
        bash: {
          commands: ['*']
        },
        limits: {
          timeoutMs: 20_000,
          maxConcurrentOps: 2,
          maxMemoryMb: 128
        }
      }
    },
    prompts: [
      'Use bash.exec for shell commands that cannot be solved by direct file tools.'
    ],
    tools: [
      {
        name: 'bash.exec',
        description: 'Run a bash command in project root.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds' }
          },
          required: ['command']
        },
        timeoutMs: 30_000,
        async execute(args, ctx) {
          const input = args as { command?: string; timeoutMs?: number }
          const command = input.command ?? ''
          const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 20_000
          const result = await exec(command, {
            cwd: ctx.projectPath,
            timeout: timeoutMs,
            maxBuffer: 512 * 1024
          })
          const stdout = result.stdout || ''
          const stderr = result.stderr || ''
          const body = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
          return {
            ok: true,
            content: body || '(no output)',
            data: {
              stdout,
              stderr,
              code: 0
            }
          }
        }
      }
    ]
  }
}
