import { access, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopOutDir = join(rootDir, 'examples', 'research-pilot-desktop', 'out')
const copyJobs = [
  {
    sourceDir: join(rootDir, 'src', 'skills', 'community-builtin'),
    targetName: 'community-builtin'
  },
  {
    sourceDir: join(rootDir, 'examples', 'research-pilot', 'skills', 'default-project-skills'),
    targetName: 'research-pilot-default-project-skills'
  }
]
const targetRoots = [
  join(desktopOutDir, 'skills'),
  join(desktopOutDir, 'main', 'skills')
]

async function pathExists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!await pathExists(desktopOutDir)) {
    console.warn(`[copy-desktop-community-skills] skipped, desktop out not found: ${desktopOutDir}`)
    return
  }

  for (const job of copyJobs) {
    if (!await pathExists(job.sourceDir)) {
      console.warn(`[copy-desktop-community-skills] skipped, source not found: ${job.sourceDir}`)
      continue
    }
    for (const root of targetRoots) {
      const targetDir = join(root, job.targetName)
      await mkdir(dirname(targetDir), { recursive: true })
      await rm(targetDir, { recursive: true, force: true })
      await cp(job.sourceDir, targetDir, { recursive: true })
      console.log(`[copy-desktop-community-skills] copied ${job.sourceDir} -> ${targetDir}`)
    }
  }
}

main().catch((error) => {
  console.error('[copy-desktop-community-skills] failed:', error)
  process.exitCode = 1
})
