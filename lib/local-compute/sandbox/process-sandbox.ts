/**
 * Process Sandbox — executes commands in an isolated process group.
 *
 * stdout+stderr both go to the combined output file (for progress extraction — tqdm writes to stderr).
 * stderr also goes to a separate file for failure analysis.
 * Uses bash wrapper to tee stderr to both files.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SandboxProvider, SandboxHandle, SpawnConfig } from '../types.js'

export class ProcessSandbox implements SandboxProvider {
  readonly name = 'process' as const

  async available(): Promise<boolean> {
    return true
  }

  async spawn(config: SpawnConfig): Promise<SandboxHandle> {
    const outputDir = path.dirname(config.outputPath)
    fs.mkdirSync(outputDir, { recursive: true })

    const stderrPath = config.outputPath + '.stderr'

    // Use bash to tee stderr to both the combined output file and a separate stderr file.
    // This ensures progress bars (tqdm writes to stderr) appear in the combined output
    // while stderr is also captured separately for failure analysis.
    //
    // RFC-016 §4.1: when an exitCodePath is configured, the CHILD records
    // its own exit code as a durable sentinel the moment the command
    // finishes. `$?` here is the user command's exit status — process
    // substitutions (the `tee` redirections) don't clobber it. This is
    // the slow-path completion fact: if our in-memory `handle.wait()` is
    // gone after a runner reconstruction, the monitor reads this file to
    // finalize the run instead of leaving it a zombie `running`.
    const core = `( ${config.command} ) 2> >(tee -a ${JSON.stringify(stderrPath)} >&2) >> ${JSON.stringify(config.outputPath)} 2>&1`
    // Capture the user command's exit code into `rc`, persist it to the
    // sentinel, then RE-EXIT with `rc` so the bash process's own exit code
    // still matches the user command. (Without `exit $rc`, the trailing
    // `echo` would make the wrapper exit 0 and the in-memory fast path
    // would mislabel every run as completed.)
    const wrappedCommand = config.exitCodePath
      ? `${core}; rc=$?; echo $rc > ${JSON.stringify(config.exitCodePath)}; exit $rc`
      : core

    // Initialize output files
    fs.writeFileSync(config.outputPath, '')
    fs.writeFileSync(stderrPath, '')
    // Clear any stale sentinel from a prior run reusing this directory so
    // a leftover exit_code can never be mistaken for this run's result.
    if (config.exitCodePath) {
      try { fs.rmSync(config.exitCodePath, { force: true }) } catch { /* ignore */ }
    }

    const child = spawn('/bin/bash', ['-c', wrappedCommand], {
      cwd: config.workDir,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })

    const pid = child.pid
    if (pid === undefined) {
      throw new Error('Failed to spawn process: no PID returned')
    }

    // Abort signal handling
    if (config.signal) {
      const onAbort = () => {
        try { process.kill(-pid, 'SIGTERM') } catch { /* already dead */ }
      }
      config.signal.addEventListener('abort', onAbort, { once: true })
      child.on('exit', () => config.signal!.removeEventListener('abort', onAbort))
    }

    // Wait promise — use a settled flag to prevent double resolve
    let settled = false
    const waitPromise = new Promise<{ exitCode: number; exitSignal?: string }>((resolve) => {
      child.on('exit', (code, signal) => {
        if (settled) return
        settled = true
        resolve({
          exitCode: code ?? 1,
          exitSignal: signal ?? undefined,
        })
      })
      child.on('error', () => {
        if (settled) return
        settled = true
        resolve({ exitCode: 1, exitSignal: undefined })
      })
    })

    return {
      pid,

      async kill(sig = 'SIGTERM'): Promise<void> {
        try {
          process.kill(-pid, sig as NodeJS.Signals)
        } catch { /* already dead */ }
      },

      wait(): Promise<{ exitCode: number; exitSignal?: string }> {
        return waitPromise
      },

      async cleanup(): Promise<void> {
        try { child.unref() } catch { /* ignore */ }
      },
    }
  }
}
