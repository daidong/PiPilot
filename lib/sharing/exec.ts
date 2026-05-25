/**
 * RFC-013 sharing — thin async wrapper over `execFile` for shelling to `git`,
 * `gh`, and `git-lfs`. Unlike `execFileAsync`, this NEVER throws on a non-zero
 * exit: callers branch on `code`/`ok` and read `stderr` for diagnostics. Stdout
 * is trimmed for convenience.
 *
 * We deliberately shell to the user's installed CLIs (RFC-013 §7): the app owns
 * no git/GitHub credentials — `gh auth` and the system git config do.
 */

import { execFile } from 'node:child_process'

export interface ExecResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  /** Set when the binary itself could not be spawned (ENOENT, timeout). */
  spawnError?: string
}

export interface ExecOptions {
  cwd?: string
  /** Milliseconds. Default 60s — git network ops can be slow. */
  timeout?: number
  /** Extra env on top of process.env. */
  env?: Record<string, string>
  /** Cap captured output. Default 16 MiB. */
  maxBuffer?: number
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = (stdout ?? '').toString()
        const errOut = (stderr ?? '').toString()
        if (err) {
          // execFile surfaces both spawn failures (ENOENT) and non-zero exits
          // here. Distinguish: a numeric `code` means the process ran and exited
          // non-zero; otherwise it never started (or timed out / was killed).
          const anyErr = err as NodeJS.ErrnoException & { code?: number | string; signal?: string }
          const numericCode = typeof anyErr.code === 'number' ? anyErr.code : 1
          const spawnFailed = typeof anyErr.code === 'string' || anyErr.signal != null
          resolve({
            ok: false,
            code: numericCode,
            stdout: out.trim(),
            stderr: errOut.trim(),
            spawnError: spawnFailed ? String(anyErr.code ?? anyErr.signal ?? err.message) : undefined,
          })
          return
        }
        resolve({ ok: true, code: 0, stdout: out.trim(), stderr: errOut.trim() })
      }
    )
  })
}
