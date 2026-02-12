import { access, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(rootDir, 'src', 'skills', 'community-builtin')
const targetDir = join(rootDir, 'dist', 'skills', 'community-builtin')

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!await pathExists(sourceDir)) {
    console.warn(`[copy-community-skills] skipped, source not found: ${sourceDir}`)
    return
  }

  await mkdir(dirname(targetDir), { recursive: true })
  await rm(targetDir, { recursive: true, force: true })
  await cp(sourceDir, targetDir, { recursive: true })

  console.log(`[copy-community-skills] copied ${sourceDir} -> ${targetDir}`)
}

main().catch((error) => {
  console.error('[copy-community-skills] failed:', error)
  process.exitCode = 1
})
