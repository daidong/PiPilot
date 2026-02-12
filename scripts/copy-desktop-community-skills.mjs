import { access, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(rootDir, 'src', 'skills', 'community-builtin')
const desktopOutDir = join(rootDir, 'examples', 'research-pilot-desktop', 'out')
const targetDir = join(desktopOutDir, 'skills', 'community-builtin')

async function pathExists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!await pathExists(sourceDir)) {
    console.warn(`[copy-desktop-community-skills] skipped, source not found: ${sourceDir}`)
    return
  }
  if (!await pathExists(desktopOutDir)) {
    console.warn(`[copy-desktop-community-skills] skipped, desktop out not found: ${desktopOutDir}`)
    return
  }

  await mkdir(dirname(targetDir), { recursive: true })
  await rm(targetDir, { recursive: true, force: true })
  await cp(sourceDir, targetDir, { recursive: true })

  console.log(`[copy-desktop-community-skills] copied ${sourceDir} -> ${targetDir}`)
}

main().catch((error) => {
  console.error('[copy-desktop-community-skills] failed:', error)
  process.exitCode = 1
})
