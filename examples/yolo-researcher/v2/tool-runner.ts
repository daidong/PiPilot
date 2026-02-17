import { spawn } from 'node:child_process'

import type { ExecOutcome, ExecRequest, ToolRunner } from './types.js'
import { toIso } from './utils.js'

export class LocalShellToolRunner implements ToolRunner {
  async runExec(input: ExecRequest): Promise<ExecOutcome> {
    const startedAtDate = new Date()
    const startedAt = toIso(startedAtDate)

    return await new Promise<ExecOutcome>((resolve) => {
      const env = {
        ...process.env,
        ...(input.env ?? {}),
        YOLO_RUNTIME: input.runtime
      }

      const child = spawn(input.cmd, {
        cwd: input.cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      const timer = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL')
            }, 2_000)
          }, input.timeoutMs)
        : null

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      child.on('error', (error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const endedAt = toIso(new Date())
        resolve({
          cmd: input.cmd,
          runtime: input.runtime,
          cwd: input.cwd,
          stdout,
          stderr: `${stderr}${stderr.endsWith('\n') ? '' : '\n'}${error.message}\n`,
          exitCode: 1,
          timedOut,
          startedAt,
          endedAt
        })
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const endedAt = toIso(new Date())
        resolve({
          cmd: input.cmd,
          runtime: input.runtime,
          cwd: input.cwd,
          stdout,
          stderr,
          exitCode: typeof code === 'number' ? code : 1,
          timedOut,
          startedAt,
          endedAt
        })
      })
    })
  }
}
