import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FRAMEWORK_DIR } from '../constants.js'

export function resolveProjectSkillDir(projectPath: string, configuredDir?: string): string {
  const target = configuredDir?.trim()
  if (!target) {
    return resolve(projectPath, `${FRAMEWORK_DIR}/skills`)
  }
  return isAbsolute(target) ? resolve(target) : resolve(projectPath, target)
}

export function resolveCommunitySkillDir(projectPath: string, configuredDir?: string): string {
  const target = configuredDir?.trim()
  if (target) {
    return isAbsolute(target) ? resolve(target) : resolve(projectPath, target)
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const cwd = process.cwd()
  const resourcesPathCandidate = (process as { resourcesPath?: unknown }).resourcesPath
  const resourcesPath = typeof resourcesPathCandidate === 'string' ? resourcesPathCandidate : undefined
  const ladderRoots = Array.from({ length: 6 }, (_, depth) =>
    resolve(cwd, ...Array.from({ length: depth }, () => '..'))
  )

  const resourceCandidates = resourcesPath
    ? [
      resolve(resourcesPath, 'skills', 'community-builtin'),
      resolve(resourcesPath, 'app.asar.unpacked', 'dist', 'skills', 'community-builtin'),
      resolve(resourcesPath, 'app.asar.unpacked', 'node_modules', 'agent-foundry', 'dist', 'skills', 'community-builtin'),
      resolve(resourcesPath, 'app.asar', 'dist', 'skills', 'community-builtin'),
      resolve(resourcesPath, 'app.asar', 'node_modules', 'agent-foundry', 'dist', 'skills', 'community-builtin')
    ]
    : []

  const rawCandidates = [
    ...resourceCandidates,
    resolve(moduleDir, 'community-builtin'),
    resolve(moduleDir, '..', '..', 'src', 'skills', 'community-builtin'),
    resolve(moduleDir, '..', '..', 'out', 'skills', 'community-builtin'),
    resolve(moduleDir, '..', '..', 'out', 'main', 'skills', 'community-builtin'),
    resolve(projectPath, 'node_modules', 'agent-foundry', 'dist', 'skills', 'community-builtin'),
    resolve(projectPath, 'node_modules', 'agent-foundry', 'src', 'skills', 'community-builtin'),
    resolve(projectPath, 'out', 'skills', 'community-builtin'),
    resolve(projectPath, 'out', 'main', 'skills', 'community-builtin'),
    ...ladderRoots.flatMap((root) => [
      resolve(root, 'src', 'skills', 'community-builtin'),
      resolve(root, 'dist', 'skills', 'community-builtin'),
      resolve(root, 'out', 'skills', 'community-builtin'),
      resolve(root, 'out', 'main', 'skills', 'community-builtin')
    ])
  ]

  const candidates = rawCandidates.flatMap((candidate) => {
    const unpacked = candidate.replace(/\.asar([\\/])/, '.asar.unpacked$1')
    return unpacked !== candidate ? [unpacked, candidate] : [candidate]
  })

  const uniqueCandidates = [...new Set(candidates)]
  const existing = uniqueCandidates.find(path => existsSync(path))
  return existing ?? uniqueCandidates[0]!
}
