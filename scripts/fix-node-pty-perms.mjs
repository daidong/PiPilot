import { chmodSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// spawn-helper is only used on Unix platforms; Windows uses conpty.
if (process.platform === 'win32') process.exit(0)

const require = createRequire(import.meta.url)

try {
  // Resolve from package.json so we rely only on node-pty's public layout,
  // not internal modules or runtime-loaded native bindings.
  const ptyDir = path.dirname(require.resolve('node-pty/package.json'))
  const prebuildsDir = path.join(ptyDir, 'prebuilds')

  for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const helper = path.join(prebuildsDir, entry.name, 'spawn-helper')
    try {
      const stat = statSync(helper)
      if ((stat.mode & 0o111) !== 0o111) {
        chmodSync(helper, stat.mode | 0o755)
        console.log(`[postinstall] fixed node-pty helper permissions: ${helper}`)
      }
    } catch {
      // Arch dirs without spawn-helper (e.g., win32-*) — skip silently.
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[postinstall] skipped node-pty helper permission fix: ${message}`)
}
