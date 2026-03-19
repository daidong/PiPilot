/**
 * CLI `skill` subcommand — list, install, and remove skills.
 *
 * Usage:
 *   agent-foundry skill list                           # list all skills
 *   agent-foundry skill install user/repo/path         # install from GitHub
 *   agent-foundry skill install https://...            # install from URL
 *   agent-foundry skill remove <skill-id>              # remove a skill
 */

import { resolve } from 'node:path'
import { FRAMEWORK_DIR } from '../constants.js'
import { SkillInstaller, type InstalledSkillInfo } from '../skills/skill-installer.js'
import { resolveCommunitySkillDir } from '../skills/skill-source-paths.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCommandOptions {
  subcommand: 'list' | 'install' | 'remove' | 'info'
  target?: string
  projectPath?: string
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseSkillArgs(args: string[]): SkillCommandOptions {
  const subcommand = args[0] as SkillCommandOptions['subcommand'] | undefined
  if (!subcommand || !['list', 'install', 'remove', 'info'].includes(subcommand)) {
    return { subcommand: 'list' }
  }

  let projectPath: string | undefined
  let target: string | undefined

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--project' || arg === '-p') {
      projectPath = args[++i]
    } else if (!arg.startsWith('-')) {
      target = arg
    }
  }

  return { subcommand, target, projectPath }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printSkillHelp(): void {
  console.log(`
Usage:
  agent-foundry skill <subcommand> [options]

Subcommands:
  list                        List all available skills (local + community)
  install <source>            Install a skill from GitHub or URL
  remove <skill-id>           Remove an installed skill
  info <skill-id>             Show details for a specific skill

Install sources:
  user/repo                   GitHub repo root (must contain SKILL.md)
  user/repo/path/to/skill     GitHub subdirectory path
  https://example.com/SKILL.md   Direct URL to a SKILL.md file
  https://example.com/skill.tar.gz  URL to a tar.gz archive

Options:
  --project, -p <path>        Project directory (default: cwd)

Examples:
  $ agent-foundry skill list
  $ agent-foundry skill install anthropics/af-skills/web-research
  $ agent-foundry skill install https://example.com/my-skill/SKILL.md
  $ agent-foundry skill remove web-research
  $ agent-foundry skill info markitdown

Environment:
  GITHUB_TOKEN    GitHub token for private repos and higher rate limits
`)
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export async function runSkillCommand(options: SkillCommandOptions): Promise<void> {
  const projectPath = resolve(options.projectPath ?? process.cwd())
  const skillsDir = resolve(projectPath, `${FRAMEWORK_DIR}/skills`)
  const communityDir = resolveCommunitySkillDir(projectPath)

  const installer = new SkillInstaller({
    skillsDir,
    onProgress: (msg) => console.log(`  ${msg}`),
  })

  switch (options.subcommand) {
    case 'list':
      await cmdList(installer, communityDir)
      break

    case 'install':
      if (!options.target) {
        console.error('Error: install requires a source argument')
        console.error('  Usage: agent-foundry skill install <github-path-or-url>')
        process.exit(1)
      }
      await cmdInstall(installer, options.target)
      break

    case 'remove':
      if (!options.target) {
        console.error('Error: remove requires a skill ID')
        console.error('  Usage: agent-foundry skill remove <skill-id>')
        process.exit(1)
      }
      await cmdRemove(installer, options.target)
      break

    case 'info':
      if (!options.target) {
        console.error('Error: info requires a skill ID')
        process.exit(1)
      }
      await cmdInfo(installer, communityDir, options.target)
      break
  }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function cmdList(installer: SkillInstaller, communityDir: string): Promise<void> {
  const skills = await installer.listInstalled(communityDir)

  if (skills.length === 0) {
    console.log('No skills found.')
    console.log('')
    console.log('Install skills with:')
    console.log('  agent-foundry skill install user/repo/path')
    return
  }

  // Column widths
  const idWidth = Math.max(4, ...skills.map(s => s.id.length))
  const sourceWidth = Math.max(8, ...skills.map(s => formatSource(s).length))
  const nameWidth = Math.max(6, ...skills.map(s => s.name.length))

  // Header
  const header = `${'ID'.padEnd(idWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'NAME'.padEnd(nameWidth)}  DESCRIPTION`
  console.log(header)
  console.log('-'.repeat(header.length + 10))

  for (const skill of skills) {
    const desc = skill.shortDescription.length > 60
      ? skill.shortDescription.slice(0, 57) + '...'
      : skill.shortDescription
    console.log(
      `${skill.id.padEnd(idWidth)}  ${formatSource(skill).padEnd(sourceWidth)}  ${skill.name.padEnd(nameWidth)}  ${desc}`
    )
  }

  console.log('')
  console.log(`${skills.length} skill(s) found`)
}

async function cmdInstall(installer: SkillInstaller, source: string): Promise<void> {
  try {
    let result
    if (source.startsWith('http://') || source.startsWith('https://')) {
      result = await installer.installFromURL(source)
    } else {
      result = await installer.installFromGitHub(source)
    }
    console.log('')
    console.log(`  Skill "${result.skillId}" ${result.isNew ? 'installed' : 'updated'} at:`)
    console.log(`  ${result.skillDir}`)
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    process.exit(1)
  }
}

async function cmdRemove(installer: SkillInstaller, skillId: string): Promise<void> {
  const removed = await installer.remove(skillId)
  if (removed) {
    console.log(`Removed skill "${skillId}"`)
  } else {
    console.error(`Skill "${skillId}" not found in project skills directory`)
    process.exit(1)
  }
}

async function cmdInfo(installer: SkillInstaller, communityDir: string, skillId: string): Promise<void> {
  const skills = await installer.listInstalled(communityDir)
  const skill = skills.find(s => s.id === skillId)

  if (!skill) {
    console.error(`Skill "${skillId}" not found`)
    process.exit(1)
  }

  console.log(`Skill: ${skill.name}`)
  console.log(`  ID:          ${skill.id}`)
  console.log(`  Source:      ${formatSource(skill)}`)
  console.log(`  Directory:   ${skill.dir}`)
  console.log(`  Description: ${skill.shortDescription}`)
  if (skill.sourceRef) {
    console.log(`  Source Ref:  ${skill.sourceRef}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSource(skill: InstalledSkillInfo): string {
  switch (skill.source) {
    case 'community-builtin': return 'builtin'
    case 'project-local': return skill.sourceRef ? `github` : 'local'
    case 'github': return 'github'
    case 'url': return 'url'
    default: return skill.source
  }
}
