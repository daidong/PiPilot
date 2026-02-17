/**
 * bash - Command execution tool
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface BashInput {
  command: string
  cwd?: string
  timeout?: number
}

export interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number
}

const FAILURE_SNIPPET_LIMIT = 200

function summarizeShellOutput(text: string): string | undefined {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  if (compact.length <= FAILURE_SNIPPET_LIMIT) return compact
  return `${compact.slice(0, FAILURE_SNIPPET_LIMIT)}...`
}

function buildCommandFailureError(output: BashOutput): string {
  const base = `Command exited with code ${output.exitCode}`
  const stderrSnippet = summarizeShellOutput(output.stderr)
  if (stderrSnippet) return `${base}: ${stderrSnippet}`
  const stdoutSnippet = summarizeShellOutput(output.stdout)
  if (stdoutSnippet) return `${base} (stdout): ${stdoutSnippet}`
  return base
}

export const bash: Tool<BashInput, BashOutput> = defineTool({
  name: 'bash',
  description: 'Execute bash commands. Used to run system commands, build scripts, etc.',
  parameters: {
    command: {
      type: 'string',
      description: 'Command to execute',
      required: true
    },
    cwd: {
      type: 'string',
      description: 'Working directory (relative to project root)',
      required: false
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds, defaults to 60000',
      required: false,
      default: 60000
    }
  },
  activity: {
    formatCall: (a) => {
      const cmd = (a.command as string) || ''
      const short = (cmd.split('\n')[0] ?? '').slice(0, 40)
      return { label: `Run: ${short}${cmd.length > 40 ? '...' : ''}`, icon: 'run' }
    },
    formatResult: (r, a) => {
      const cmd = ((a?.command as string) || '').split(/[\n|&;]/)[0]?.trim().slice(0, 25) || ''
      const output = (r.data as any)?.output as string || (r.data as any)?.stdout as string || ''
      const lines = output.split('\n').filter(Boolean).length
      return { label: lines > 0 ? `${cmd}: ${lines} lines` : `${cmd}: done`, icon: 'run' }
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.exec(input.command, {
      cwd: input.cwd,
      timeout: input.timeout,
      caller: 'bash'
    })

    if (!result.success && !result.data) {
      return { success: false, error: result.error }
    }

    const output = result.data!

    return {
      success: output.exitCode === 0,
      data: output,
      error: output.exitCode !== 0 ? buildCommandFailureError(output) : undefined
    }
  }
})
