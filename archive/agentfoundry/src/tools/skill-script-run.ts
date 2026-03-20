/**
 * skill-script-run - Run a script from a loaded skill directory.
 */

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { defineTool } from '../factories/define-tool.js'
import type { SkillScriptMetadata } from '../types/skill.js'
import type { Tool, ToolContext } from '../types/tool.js'

export interface SkillScriptRunInput {
  skillId: string
  script: string
  args?: string[]
  cwd?: string
  timeout?: number
}

export interface SkillScriptRunOutput {
  skillId: string
  script: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  structuredResult?: Record<string, unknown>
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function normalizeScriptId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
}

function normalizeLongOptionToken(token: string): string {
  if (!token.startsWith('--') || token === '--') return token
  const eqIndex = token.indexOf('=')
  const key = eqIndex >= 0 ? token.slice(0, eqIndex) : token
  const value = eqIndex >= 0 ? token.slice(eqIndex + 1) : ''
  const optionBody = key.slice(2)
  if (!optionBody) return token
  const normalizedBody = optionBody
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/-{2,}/g, '-')
    .toLowerCase()
  if (normalizedBody === optionBody) return token
  if (eqIndex >= 0) return `--${normalizedBody}=${value}`
  return `--${normalizedBody}`
}

function normalizeScriptArgs(args: string[]): string[] {
  return args.map(normalizeLongOptionToken)
}

function hasOptionArg(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`))
}

function readSessionStateString(
  runtime: ToolContext['runtime'],
  key: string
): string {
  const value = runtime.sessionState.get<string>(key)
  return typeof value === 'string' ? value.trim() : ''
}

function buildAgentFoundryEnv(runtime: ToolContext['runtime']): Record<string, string> {
  const env: Record<string, string> = {}
  const workspaceRoot = readSessionStateString(runtime, 'yolo.workspaceRoot') || runtime.projectPath
  const turnId = readSessionStateString(runtime, 'yolo.turnId')
  const artifactsRel = readSessionStateString(runtime, 'yolo.turnArtifactsDir')
  const artifactsAbs = readSessionStateString(runtime, 'yolo.turnArtifactsAbsDir')

  if (workspaceRoot) env.AF_WORKSPACE_ROOT = workspaceRoot
  if (turnId) env.AF_TURN_ID = turnId
  if (artifactsRel) env.AF_TURN_ARTIFACTS_REL = artifactsRel
  if (artifactsAbs) env.AF_TURN_ARTIFACTS_ABS = artifactsAbs
  return env
}

const SCRIPT_DEFAULT_OUTPUT_SUBDIR = new Map<string, string>([
  ['academic-writing/outline', 'writing'],
  ['academic-writing/draft-section', 'writing'],
  ['literature-search/search-papers', 'literature'],
  ['literature-search/search-sweep', 'literature'],
  ['data-analysis/analyze-dataset', 'data-analysis']
])

function maybeInjectDefaultOutputDir(
  args: string[],
  input: { skillId: string; scriptName: string },
  runtime: ToolContext['runtime']
): string[] {
  if (hasOptionArg(args, '--output-dir')) return args
  const scriptKey = `${normalizeScriptId(input.skillId)}/${normalizeScriptId(input.scriptName)}`
  const outputSubdir = SCRIPT_DEFAULT_OUTPUT_SUBDIR.get(scriptKey)
  if (!outputSubdir) return args
  const turnArtifactsDir = readSessionStateString(runtime, 'yolo.turnArtifactsDir')
  if (!turnArtifactsDir) return args
  const outputDir = toPosix(path.posix.join(toPosix(turnArtifactsDir), outputSubdir))
  return [...args, '--output-dir', outputDir]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value)
    if (!isObject(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function extractStructuredResultFromText(text: string): Record<string, unknown> | undefined {
  const marker = 'AF_RESULT_JSON:'
  const lines = text.split(/\r?\n/)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith(marker)) continue
    const payload = line.slice(marker.length).trim()
    if (!payload) continue
    const parsed = tryParseJsonObject(payload)
    if (parsed) return parsed
  }

  return undefined
}

function extractStructuredResultFromOutput(stdout: string, stderr: string): Record<string, unknown> | undefined {
  return extractStructuredResultFromText(stdout) ?? extractStructuredResultFromText(stderr)
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveScriptEntry(scripts: SkillScriptMetadata[], scriptName: string): SkillScriptMetadata | undefined {
  const wanted = scriptName.trim()
  if (!wanted) return undefined

  return scripts.find((entry) => {
    const name = entry.name?.trim()
    const fileName = entry.fileName?.trim()
    if (name === wanted || fileName === wanted) return true
    if (fileName) {
      const withoutExt = fileName.replace(/\.[^.]+$/, '')
      if (withoutExt === wanted) return true
    }
    return false
  })
}

function isAsarVirtualPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.includes('.asar/') && !normalized.includes('.asar.unpacked/')
}

function toAsarUnpackedPath(filePath: string): string {
  return filePath.replace(/\.asar([\\/])/, '.asar.unpacked$1')
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function buildMaterializedScriptName(skillId: string, scriptName: string, originalPath: string): string {
  const ext = path.extname(originalPath) || '.sh'
  const base = path.basename(originalPath, ext).replace(/[^a-zA-Z0-9._-]/g, '-')
  const digest = createHash('sha1')
    .update(`${skillId}:${scriptName}:${originalPath}`)
    .digest('hex')
    .slice(0, 10)
  return `${base}-${digest}${ext}`
}

async function resolveScriptPathForExecution(
  entry: SkillScriptMetadata,
  skillId: string,
  scriptName: string
): Promise<string> {
  const originalPath = entry.filePath?.trim()
  if (!originalPath) {
    throw new Error('Skill script metadata missing filePath.')
  }

  if (!isAsarVirtualPath(originalPath)) {
    return originalPath
  }

  const unpackedPath = toAsarUnpackedPath(originalPath)
  if (unpackedPath !== originalPath && await pathExists(unpackedPath)) {
    return unpackedPath
  }

  if (!await pathExists(originalPath)) {
    throw new Error(`Skill script file not found: ${originalPath}`)
  }

  const cacheDir = path.join(tmpdir(), 'agent-foundry', 'skill-scripts', skillId)
  await mkdir(cacheDir, { recursive: true })

  const materializedPath = path.join(
    cacheDir,
    buildMaterializedScriptName(skillId, scriptName, originalPath)
  )

  if (!await pathExists(materializedPath)) {
    const scriptContent = await readFile(originalPath)
    await writeFile(materializedPath, scriptContent)
    try {
      await chmod(materializedPath, 0o755)
    } catch {
      // chmod can fail on restricted filesystems; best-effort only.
    }
  }

  return materializedPath
}

function buildCommand(entry: SkillScriptMetadata, args: string[], scriptPathOverride?: string): string {
  const scriptPath = scriptPathOverride?.trim() || entry.filePath?.trim()
  if (!scriptPath) {
    throw new Error('Skill script metadata missing filePath.')
  }

  const quotedScriptPath = shellEscape(scriptPath)
  const quotedArgs = args.map(shellEscape).join(' ')
  const argSuffix = quotedArgs.length > 0 ? ` ${quotedArgs}` : ''

  switch (entry.runner) {
    case 'node':
      return `node ${quotedScriptPath}${argSuffix}`
    case 'python':
      return `python3 ${quotedScriptPath}${argSuffix}`
    case 'executable':
      return `${quotedScriptPath}${argSuffix}`
    case 'bash':
    default:
      return `bash ${quotedScriptPath}${argSuffix}`
  }
}

export const skillScriptRunTool: Tool<SkillScriptRunInput, SkillScriptRunOutput> = defineTool({
  name: 'skill-script-run',
  description: 'Run a script from a loaded skill (scripts/*) by skillId + script name.',
  parameters: {
    skillId: {
      type: 'string',
      required: true,
      description: 'Skill ID that owns the script'
    },
    script: {
      type: 'string',
      required: true,
      description: 'Script name (e.g. "setup" or "setup.sh")'
    },
    args: {
      type: 'array',
      required: false,
      description: 'Script arguments'
    },
    cwd: {
      type: 'string',
      required: false,
      description: 'Working directory relative to project root (default ".")'
    },
    timeout: {
      type: 'number',
      required: false,
      description: 'Timeout in milliseconds (default 60000)'
    }
  },
  activity: {
    formatCall: (a) => {
      const skillId = typeof a.skillId === 'string' ? a.skillId : 'unknown'
      const script = typeof a.script === 'string' ? a.script : 'script'
      return { label: `Run skill script: ${skillId}/${script}`, icon: 'run' }
    },
    formatResult: (r) => {
      const exitCode = (r.data as any)?.exitCode
      return { label: typeof exitCode === 'number' ? `script exit ${exitCode}` : 'script complete', icon: 'run' }
    }
  },
  execute: async (input, { runtime }) => {
    try {
      if (!runtime.skillManager) {
        return {
          success: false,
          error: 'SkillManager is not available in runtime.'
        }
      }

      const skill = runtime.skillManager.get(input.skillId)
      if (!skill) {
        return {
          success: false,
          error: `Unknown skill: ${input.skillId}`
        }
      }

      runtime.skillManager.loadFully(input.skillId, {
        trigger: 'tool',
        triggerTool: 'skill-script-run'
      })

      const scripts = (skill.meta?.scripts ?? []) as SkillScriptMetadata[]
      if (!Array.isArray(scripts) || scripts.length === 0) {
        return {
          success: false,
          error: `Skill "${input.skillId}" has no registered scripts.`
        }
      }

      const scriptEntry = resolveScriptEntry(scripts, input.script)
      if (!scriptEntry) {
        const available = scripts
          .map(entry => entry.fileName || entry.name)
          .filter(Boolean)
          .join(', ')
        return {
          success: false,
          error: `Script "${input.script}" not found for skill "${input.skillId}". Available: ${available || '(none)'}`
        }
      }

      const normalizedInputArgs = normalizeScriptArgs(normalizeStringArray(input.args))
      const args = maybeInjectDefaultOutputDir(
        normalizedInputArgs,
        {
          skillId: input.skillId,
          scriptName: scriptEntry.name || scriptEntry.fileName || input.script
        },
        runtime
      )
      const scriptPath = await resolveScriptPathForExecution(scriptEntry, input.skillId, input.script)
      const command = buildCommand(scriptEntry, args, scriptPath)
      const execResult = await runtime.io.exec(command, {
        cwd: input.cwd ?? '.',
        timeout: input.timeout,
        env: buildAgentFoundryEnv(runtime),
        caller: 'skill-script-run'
      })

      if (!execResult.success && !execResult.data) {
        return {
          success: false,
          error: execResult.error ?? 'Script execution failed.'
        }
      }

      const output = execResult.data!
      const structuredResult = extractStructuredResultFromOutput(output.stdout, output.stderr)
      return {
        success: output.exitCode === 0,
        data: {
          skillId: input.skillId,
          script: input.script,
          command,
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
          structuredResult
        },
        error: output.exitCode !== 0 ? `Script exited with code ${output.exitCode}` : undefined
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
