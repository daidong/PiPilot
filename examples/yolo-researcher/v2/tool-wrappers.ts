import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, parse } from 'node:path'

import { definePack, defineTool } from '../../../src/index.js'
import type { Pack } from '../../../src/types/pack.js'
import type { SkillScriptMetadata } from '../../../src/types/skill.js'
import type { ToolContext } from '../../../src/types/tool.js'

interface ScriptCandidate {
  skillId: string
  script: string
  score: number
  reason: string
}

interface ConversionCapability {
  extensions?: string[]
  script?: string
}

interface PreferredConversionScript {
  skillId: string
  script: string
  successes: number
  failures: number
  lastUsedAt: number
}

interface SkillScriptRunResult {
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

interface SkillScriptRunToolLike {
  execute: (input: {
    skillId: string
    script: string
    args?: string[]
    cwd?: string
    timeout?: number
  }, context?: ToolContext) => Promise<SkillScriptRunResult>
}

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeBoolean(value: unknown, fallback: boolean = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => safeString(item).trim())
    .filter(Boolean)
}

function normalizeExtension(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '').trim()
}

function normalizeScriptName(script: SkillScriptMetadata): string {
  const raw = (script.name ?? script.fileName ?? '').trim()
  if (!raw) return ''
  const dot = raw.lastIndexOf('.')
  return dot > 0 ? raw.slice(0, dot) : raw
}

function readConversionCapability(skill: { meta?: Record<string, unknown> }): ConversionCapability | null {
  const meta = skill.meta
  if (!meta || typeof meta !== 'object') return null
  const capabilities = (meta as Record<string, unknown>).capabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const convert = (capabilities as Record<string, unknown>).convert_to_markdown
  if (!convert || typeof convert !== 'object') return null

  const convertObj = convert as Record<string, unknown>
  const extensions = Array.isArray(convertObj.extensions)
    ? convertObj.extensions
      .map((item) => normalizeExtension(safeString(item)))
      .filter(Boolean)
    : undefined
  const script = safeString(convertObj.script).trim().toLowerCase() || undefined

  if ((!extensions || extensions.length === 0) && !script) return null
  return { extensions, script }
}

function scoreScriptCandidate(
  skillId: string,
  scriptName: string,
  extNoDot: string,
  options?: {
    capability?: ConversionCapability | null
    preferred?: PreferredConversionScript | null
  }
): { score: number; reason: string } | null {
  const normalizedSkill = skillId.toLowerCase()
  const normalizedScript = scriptName.toLowerCase()
  let score = 0
  const reasons: string[] = []

  if (normalizedScript === `${extNoDot}-to-markdown`) {
    score += 240
    reasons.push('exact extension converter')
  } else if (normalizedScript === 'convert-file') {
    score += 200
    reasons.push('generic file converter')
  } else if (normalizedScript === 'convert-to-markdown') {
    score += 180
    reasons.push('explicit markdown converter')
  } else if (normalizedScript.includes('to-markdown')) {
    score += 160
    reasons.push('markdown conversion script')
  } else if (normalizedScript.includes('convert') && normalizedScript.includes('markdown')) {
    score += 140
    reasons.push('convert+markdown script')
  } else if (normalizedScript.includes('convert')) {
    score += 80
    reasons.push('generic conversion script')
  }

  if (normalizedScript.includes(extNoDot)) {
    score += 40
    reasons.push('extension mentioned in script')
  }
  if (normalizedSkill.includes('markitdown')) {
    score += 35
    reasons.push('markitdown skill')
  }
  if (normalizedSkill.includes(extNoDot)) {
    score += 30
    reasons.push('extension-aligned skill')
  }
  if (options?.capability?.extensions?.includes(extNoDot)) {
    score += 90
    reasons.push('declared extension capability')
  }
  if (options?.capability?.script && options.capability.script === normalizedScript) {
    score += 110
    reasons.push('declared preferred conversion script')
  }
  if (
    options?.preferred
    && options.preferred.skillId === skillId
    && options.preferred.script.toLowerCase() === normalizedScript
  ) {
    score += 160
    reasons.push('previous successful converter')
    score += Math.min(40, options.preferred.successes * 8)
    score -= Math.min(30, options.preferred.failures * 10)
  }

  if (score <= 0) return null
  return { score, reason: reasons.join(', ') }
}

function discoverDynamicConversionScripts(
  skillManager: unknown,
  inputPath: string,
  preferredByExt?: Map<string, PreferredConversionScript>
): ScriptCandidate[] {
  const manager = toObject(skillManager)
  if (!manager || typeof manager.getAll !== 'function') return []

  const extNoDot = normalizeExtension(parse(inputPath).ext)
  if (!extNoDot) return []

  const preferred = preferredByExt?.get(extNoDot) ?? null
  const skills = (manager.getAll() as Array<{
    id: string
    meta?: Record<string, unknown> & { scripts?: SkillScriptMetadata[] }
  }>) ?? []
  const candidates: ScriptCandidate[] = []
  const seen = new Set<string>()

  for (const skill of skills) {
    const scripts = skill.meta?.scripts
    if (!Array.isArray(scripts) || scripts.length === 0) continue
    const capability = readConversionCapability(skill)

    for (const script of scripts) {
      const scriptName = normalizeScriptName(script)
      if (!scriptName) continue
      const scored = scoreScriptCandidate(skill.id, scriptName, extNoDot, { capability, preferred })
      if (!scored) continue

      const key = `${skill.id}:${scriptName}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        skillId: skill.id,
        script: scriptName,
        score: scored.score,
        reason: scored.reason
      })
    }
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.skillId !== b.skillId) return a.skillId.localeCompare(b.skillId)
    return a.script.localeCompare(b.script)
  })
  return candidates
}

function getSkillScriptRunTool(context?: ToolContext): SkillScriptRunToolLike | null {
  const tool = context?.runtime?.toolRegistry?.get('skill-script-run') as SkillScriptRunToolLike | undefined
  if (!tool || typeof tool.execute !== 'function') return null
  return tool
}

function extractStructured(resultData: Record<string, unknown> | null): Record<string, unknown> {
  const structured = toObject(resultData?.structuredResult)
  return structured ?? resultData ?? {}
}

function summarizeRunError(result: SkillScriptRunResult): string {
  const data = toObject(result.data)
  const structured = toObject(data?.structuredResult)
  const err = safeString(result.error).trim()
  const structuredErr = safeString(structured?.error).trim()
  const dataErr = safeString(data?.error).trim()
  return err || structuredErr || dataErr || 'script execution failed'
}

export function createYoloToolWrapperPack(projectPath: string, debug: boolean = false): Pack {
  const literatureSearchTool = defineTool({
    name: 'literature-search',
    description: 'Typed wrapper for literature-search skill. Runs search-sweep/search-papers with canonical args and normalized output.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literature query' },
      mode: { type: 'string', required: false, description: 'sweep (default) or quick' },
      limitPerQuery: { type: 'number', required: false, description: 'Per-source limit for sweep mode (default: 8)' },
      finalLimit: { type: 'number', required: false, description: 'Final merged top-K in sweep mode (default: 40)' },
      limit: { type: 'number', required: false, description: 'Per-source limit for quick mode (default: 8)' },
      maxSubqueries: { type: 'number', required: false, description: 'Max generated subqueries in sweep mode (default: 5)' },
      citationSeedCount: { type: 'number', required: false, description: 'OpenAlex seed papers for citation expansion (default: 5)' },
      citationLimit: { type: 'number', required: false, description: 'Citing papers per seed (default: 5)' },
      outputDir: { type: 'string', required: false, description: 'Output dir relative to project root' },
      projectRoot: { type: 'string', required: false, description: 'Project root (default: .)' },
      skipArxiv: { type: 'boolean', required: false, description: 'Skip arXiv source' },
      timeoutMs: { type: 'number', required: false, description: 'Script timeout in ms' }
    },
    execute: async (input, context) => {
      const query = safeString(input.query).trim()
      if (!query) return { success: false, error: 'query is required' }

      const mode = safeString(input.mode).trim().toLowerCase() === 'quick' ? 'quick' : 'sweep'
      const script = mode === 'quick' ? 'search-papers' : 'search-sweep'
      const projectRootArg = safeString(input.projectRoot).trim() || '.'
      const outputDir = safeString(input.outputDir).trim() || '.yolo-researcher/library/literature'
      const timeoutMs = Math.max(30_000, safeNumber(input.timeoutMs, 180_000))

      const args: string[] = ['--query', query]
      if (mode === 'quick') {
        const limit = Math.max(1, Math.min(30, Math.floor(safeNumber(input.limit, 8))))
        args.push('--limit', String(limit))
      } else {
        const limitPerQuery = Math.max(1, Math.min(20, Math.floor(safeNumber(input.limitPerQuery, 8))))
        const finalLimit = Math.max(1, Math.min(120, Math.floor(safeNumber(input.finalLimit, 40))))
        const maxSubqueries = Math.max(1, Math.min(8, Math.floor(safeNumber(input.maxSubqueries, 5))))
        const citationSeedCount = Math.max(0, Math.min(10, Math.floor(safeNumber(input.citationSeedCount, 5))))
        const citationLimit = Math.max(1, Math.min(20, Math.floor(safeNumber(input.citationLimit, 5))))
        args.push('--limit-per-query', String(limitPerQuery))
        args.push('--final-limit', String(finalLimit))
        args.push('--max-subqueries', String(maxSubqueries))
        args.push('--citation-seed-count', String(citationSeedCount))
        args.push('--citation-limit', String(citationLimit))
      }
      args.push('--project-root', projectRootArg, '--output-dir', outputDir)
      if (safeBoolean(input.skipArxiv)) args.push('--skip-arxiv')

      const skillScriptRunTool = getSkillScriptRunTool(context)
      if (!skillScriptRunTool) {
        return { success: false, error: 'skill-script-run tool is not available in runtime.' }
      }

      const runResult = await skillScriptRunTool.execute({
        skillId: 'literature-search',
        script,
        args,
        cwd: '.',
        timeout: timeoutMs
      }, context)

      if (!runResult.success) {
        return {
          success: false,
          error: `literature-search/${script} failed: ${summarizeRunError(runResult)}`
        }
      }

      const resultData = toObject(runResult.data)
      const structured = extractStructured(resultData)
      const jsonPath = safeString(structured.jsonPath || resultData?.jsonPath).trim()
      const markdownPath = safeString(structured.markdownPath || resultData?.markdownPath).trim()
      const paperCount = safeNumber(structured.paperCount || resultData?.paperCount, 0)
      const errors = toStringArray(structured.errors || resultData?.errors)

      return {
        success: true,
        data: {
          query,
          mode,
          script,
          outputDir,
          paperCount,
          errors,
          jsonPath: jsonPath || undefined,
          markdownPath: markdownPath || undefined,
          structuredResult: structured
        }
      }
    }
  })

  const dataAnalyzeTool = defineTool({
    name: 'data-analyze',
    description: 'Typed wrapper for data-analysis/analyze-dataset skill script.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Dataset path (relative to project root)' },
      taskType: { type: 'string', required: false, description: 'analyze|visualize|transform|model' },
      instructions: { type: 'string', required: false, description: 'Task instructions' },
      projectRoot: { type: 'string', required: false, description: 'Project root (default: .)' },
      outputDir: { type: 'string', required: false, description: 'Output dir relative to project root' },
      timeoutMs: { type: 'number', required: false, description: 'Script timeout in ms' }
    },
    execute: async (input, context) => {
      const filePath = safeString(input.filePath).trim()
      if (!filePath) return { success: false, error: 'filePath is required' }

      const taskType = safeString(input.taskType).trim() || 'analyze'
      const instructions = safeString(input.instructions).trim()
      const projectRootArg = safeString(input.projectRoot).trim() || '.'
      const outputDir = safeString(input.outputDir).trim() || '.yolo-researcher/library/data-analysis'
      const timeoutMs = Math.max(30_000, safeNumber(input.timeoutMs, 180_000))

      const args: string[] = [
        '--file', filePath,
        '--task', taskType,
        '--project-root', projectRootArg,
        '--output-dir', outputDir
      ]
      if (instructions) args.push('--instructions', instructions)

      const skillScriptRunTool = getSkillScriptRunTool(context)
      if (!skillScriptRunTool) {
        return { success: false, error: 'skill-script-run tool is not available in runtime.' }
      }

      const runResult = await skillScriptRunTool.execute({
        skillId: 'data-analysis',
        script: 'analyze-dataset',
        args,
        cwd: '.',
        timeout: timeoutMs
      }, context)

      if (!runResult.success) {
        return {
          success: false,
          error: `data-analysis/analyze-dataset failed: ${summarizeRunError(runResult)}`
        }
      }

      const resultData = toObject(runResult.data)
      const structured = extractStructured(resultData)
      return {
        success: true,
        data: {
          filePath,
          taskType,
          outputDir,
          jsonPath: safeString(structured.jsonPath || resultData?.jsonPath).trim() || undefined,
          markdownPath: safeString(structured.markdownPath || resultData?.markdownPath).trim() || undefined,
          outputs: toStringArray(structured.outputs || resultData?.outputs),
          warnings: toStringArray(structured.warnings || resultData?.warnings),
          rowCount: safeNumber(structured.rowCount || resultData?.rowCount, 0),
          columnCount: safeNumber(structured.columnCount || resultData?.columnCount, 0),
          structuredResult: structured
        }
      }
    }
  })

  const writingOutlineTool = defineTool({
    name: 'writing-outline',
    description: 'Typed wrapper for academic-writing/outline script.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Outline topic/title' },
      docType: { type: 'string', required: false, description: 'paper|report|review|proposal' },
      notes: { type: 'string', required: false, description: 'Optional notes' },
      literatureContext: { type: 'string', required: false, description: 'Optional literature context' },
      model: { type: 'string', required: false, description: 'Optional model id passed to script' },
      projectRoot: { type: 'string', required: false, description: 'Project root (default: .)' },
      outputDir: { type: 'string', required: false, description: 'Output dir relative to project root' },
      timeoutMs: { type: 'number', required: false, description: 'Script timeout in ms' }
    },
    execute: async (input, context) => {
      const topic = safeString(input.topic).trim()
      if (!topic) return { success: false, error: 'topic is required' }

      const docType = safeString(input.docType).trim() || 'paper'
      const notes = safeString(input.notes).trim()
      const literatureContext = safeString(input.literatureContext).trim()
      const model = safeString(input.model).trim()
      const projectRootArg = safeString(input.projectRoot).trim() || '.'
      const outputDir = safeString(input.outputDir).trim() || '.yolo-researcher/library/writing'
      const timeoutMs = Math.max(30_000, safeNumber(input.timeoutMs, 180_000))

      const args: string[] = [
        '--topic', topic,
        '--doc-type', docType,
        '--project-root', projectRootArg,
        '--output-dir', outputDir
      ]
      if (notes) args.push('--notes', notes)
      if (literatureContext) args.push('--literature-context', literatureContext)
      if (model) args.push('--model', model)

      const skillScriptRunTool = getSkillScriptRunTool(context)
      if (!skillScriptRunTool) {
        return { success: false, error: 'skill-script-run tool is not available in runtime.' }
      }

      const runResult = await skillScriptRunTool.execute({
        skillId: 'academic-writing',
        script: 'outline',
        args,
        cwd: '.',
        timeout: timeoutMs
      }, context)

      if (!runResult.success) {
        return {
          success: false,
          error: `academic-writing/outline failed: ${summarizeRunError(runResult)}`
        }
      }

      const resultData = toObject(runResult.data)
      const structured = extractStructured(resultData)
      return {
        success: true,
        data: {
          topic,
          docType,
          outputDir,
          jsonPath: safeString(structured.jsonPath || resultData?.jsonPath).trim() || undefined,
          markdownPath: safeString(structured.markdownPath || resultData?.markdownPath).trim() || undefined,
          sectionCount: safeNumber(structured.sectionCount || resultData?.sectionCount, 0),
          estimatedTotalWords: safeNumber(structured.estimatedTotalWords || resultData?.estimatedTotalWords, 0),
          source: safeString(structured.source || resultData?.source).trim() || undefined,
          warning: safeString(structured.warning || resultData?.warning).trim() || undefined,
          structuredResult: structured
        }
      }
    }
  })

  const writingDraftTool = defineTool({
    name: 'writing-draft',
    description: 'Typed wrapper for academic-writing/draft-section script.',
    parameters: {
      sectionHeading: { type: 'string', required: true, description: 'Section heading' },
      sectionOutline: { type: 'string', required: false, description: 'Optional section outline' },
      instructions: { type: 'string', required: false, description: 'Optional drafting instructions' },
      sourceNotes: { type: 'string', required: false, description: 'Optional source notes' },
      citationHints: { type: 'string', required: false, description: 'Optional citation hints' },
      model: { type: 'string', required: false, description: 'Optional model id passed to script' },
      projectRoot: { type: 'string', required: false, description: 'Project root (default: .)' },
      outputDir: { type: 'string', required: false, description: 'Output dir relative to project root' },
      timeoutMs: { type: 'number', required: false, description: 'Script timeout in ms' }
    },
    execute: async (input, context) => {
      const sectionHeading = safeString(input.sectionHeading).trim()
      if (!sectionHeading) return { success: false, error: 'sectionHeading is required' }

      const sectionOutline = safeString(input.sectionOutline).trim()
      const instructions = safeString(input.instructions).trim()
      const sourceNotes = safeString(input.sourceNotes).trim()
      const citationHints = safeString(input.citationHints).trim()
      const model = safeString(input.model).trim()
      const projectRootArg = safeString(input.projectRoot).trim() || '.'
      const outputDir = safeString(input.outputDir).trim() || '.yolo-researcher/library/writing'
      const timeoutMs = Math.max(30_000, safeNumber(input.timeoutMs, 180_000))

      const args: string[] = [
        '--section-heading', sectionHeading,
        '--project-root', projectRootArg,
        '--output-dir', outputDir
      ]
      if (sectionOutline) args.push('--section-outline', sectionOutline)
      if (instructions) args.push('--instructions', instructions)
      if (sourceNotes) args.push('--source-notes', sourceNotes)
      if (citationHints) args.push('--citation-hints', citationHints)
      if (model) args.push('--model', model)

      const skillScriptRunTool = getSkillScriptRunTool(context)
      if (!skillScriptRunTool) {
        return { success: false, error: 'skill-script-run tool is not available in runtime.' }
      }

      const runResult = await skillScriptRunTool.execute({
        skillId: 'academic-writing',
        script: 'draft-section',
        args,
        cwd: '.',
        timeout: timeoutMs
      }, context)

      if (!runResult.success) {
        return {
          success: false,
          error: `academic-writing/draft-section failed: ${summarizeRunError(runResult)}`
        }
      }

      const resultData = toObject(runResult.data)
      const structured = extractStructured(resultData)
      return {
        success: true,
        data: {
          sectionHeading,
          outputDir,
          jsonPath: safeString(structured.jsonPath || resultData?.jsonPath).trim() || undefined,
          markdownPath: safeString(structured.markdownPath || resultData?.markdownPath).trim() || undefined,
          wordCount: safeNumber(structured.wordCount || resultData?.wordCount, 0),
          source: safeString(structured.source || resultData?.source).trim() || undefined,
          warning: safeString(structured.warning || resultData?.warning).trim() || undefined,
          structuredResult: structured
        }
      }
    }
  })

  const convertToMarkdownTool = defineTool({
    name: 'convert_to_markdown',
    description: 'Convert a local document to markdown using discovered conversion scripts (markitdown preferred).',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative or absolute file path to convert' },
      timeoutMs: { type: 'number', required: false, description: 'Per-attempt timeout in ms' }
    },
    execute: async (input, context) => {
      const fileName = safeString(input.path).trim()
      if (!fileName) return { success: false, error: 'path is required' }
      const absPath = isAbsolute(fileName) ? fileName : join(projectPath, fileName)
      if (!existsSync(absPath)) {
        return { success: false, error: `File not found: ${fileName}` }
      }

      const outputName = `${parse(fileName).name}.extracted.md`
      const outputPath = join(projectPath, outputName)
      const extNoDot = normalizeExtension(parse(fileName).ext)
      const timeoutMs = Math.max(30_000, safeNumber(input.timeoutMs, 240_000))

      const preferredByExt = context.runtime.sessionState.get<Map<string, PreferredConversionScript>>('preferredConverterByExt')
        ?? new Map<string, PreferredConversionScript>()
      const dynamicCandidates = discoverDynamicConversionScripts(context.runtime.skillManager, absPath, preferredByExt)
      if (debug) {
        const top = dynamicCandidates.slice(0, 5).map((c) => `${c.skillId}/${c.script} score=${c.score}`).join(', ')
        console.log(`[yolo:convert_to_markdown] ext=${extNoDot || '(none)'} candidates=${dynamicCandidates.length}${top ? ` -> ${top}` : ''}`)
      }
      if (dynamicCandidates.length === 0) {
        return {
          success: false,
          error: 'No conversion script discovered from loaded skills. Ensure markitdown/community skills are loaded.'
        }
      }

      const skillScriptRunTool = getSkillScriptRunTool(context)
      if (!skillScriptRunTool) {
        return {
          success: false,
          error: 'skill-script-run tool is not available in runtime.'
        }
      }

      const errors: string[] = []
      let usedConverter = ''
      let usedScript = ''

      const argVariants = (sourcePath: string, targetPath: string): string[][] => ([
        [sourcePath, targetPath],
        ['--input', sourcePath, '--output', targetPath]
      ])

      for (const candidate of dynamicCandidates) {
        let success = false
        for (const args of argVariants(absPath, outputPath)) {
          const runResult = await skillScriptRunTool.execute({
            skillId: candidate.skillId,
            script: candidate.script,
            args,
            cwd: '.',
            timeout: timeoutMs
          }, context)

          if (!runResult.success) {
            errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): ${summarizeRunError(runResult)}`)
            continue
          }
          if (!existsSync(outputPath)) {
            errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): completed but output file missing`)
            continue
          }

          let generated = ''
          try {
            generated = readFileSync(outputPath, 'utf-8').trim()
          } catch {
            generated = ''
          }
          if (!generated) {
            errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): output markdown is empty`)
            continue
          }

          usedConverter = candidate.skillId
          usedScript = candidate.script
          success = true
          break
        }

        if (success) {
          if (extNoDot) {
            const previous = preferredByExt.get(extNoDot)
            const sameAsPrevious = previous
              && previous.skillId === candidate.skillId
              && previous.script.toLowerCase() === candidate.script.toLowerCase()
            preferredByExt.set(extNoDot, {
              skillId: candidate.skillId,
              script: candidate.script,
              successes: sameAsPrevious ? previous.successes + 1 : 1,
              failures: sameAsPrevious ? previous.failures : 0,
              lastUsedAt: Date.now()
            })
            context.runtime.sessionState.set('preferredConverterByExt', preferredByExt)
          }
          break
        }
      }

      if (!usedConverter) {
        return {
          success: false,
          error: [
            `Failed to convert "${fileName}" to markdown.`,
            'Tried scripts:',
            ...errors.map((line) => `- ${line}`)
          ].join('\n')
        }
      }

      const text = readFileSync(outputPath, 'utf-8')
      const allLines = text.split('\n')
      const lines = allLines.length
      const headings = allLines
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter((item) => /^#{1,4}\s/.test(item.text))
      const head = allLines.slice(0, 30).join('\n')
      const tail = lines > 60 ? allLines.slice(-30).join('\n') : ''

      return {
        success: true,
        data: {
          outputFile: outputName,
          lines,
          bytes: text.length,
          converterSkill: usedConverter,
          converterScript: usedScript,
          head,
          tail: tail || undefined,
          headings: headings.length > 0
            ? headings.map((h) => `L${h.line}: ${h.text}`).join('\n')
            : undefined,
          message: `Extracted ${lines} lines. Use read({ path: "${outputName}", offset, limit }) for targeted sections.`
        }
      }
    }
  })

  const skillsHealthCheckTool = defineTool({
    name: 'skills-health-check',
    description: 'Inspect runtime skills/scripts readiness for yolo wrapper tools.',
    parameters: {},
    execute: async (_, context) => {
      const manager = context.runtime.skillManager as {
        getAll?: () => Array<{ id: string; meta?: Record<string, unknown> }>
      } | undefined
      if (!manager || typeof manager.getAll !== 'function') {
        return {
          success: false,
          error: 'skillManager is not available in runtime.'
        }
      }

      const skills = manager.getAll() ?? []
      const byId = new Map<string, { id: string; scripts: string[] }>()
      for (const skill of skills) {
        const scriptsRaw = toObject(skill.meta)?.scripts
        const scripts = Array.isArray(scriptsRaw)
          ? scriptsRaw
            .map((row) => normalizeScriptName(row as SkillScriptMetadata))
            .filter(Boolean)
          : []
        byId.set(skill.id, { id: skill.id, scripts })
      }

      const requirements = [
        { skillId: 'literature-search', scripts: ['search-sweep', 'search-papers'] },
        { skillId: 'data-analysis', scripts: ['analyze-dataset'] },
        { skillId: 'academic-writing', scripts: ['outline', 'draft-section'] },
        { skillId: 'markitdown', scripts: ['convert-file'] }
      ]

      const checks = requirements.map((req) => {
        const hit = byId.get(req.skillId)
        const missingScripts = req.scripts.filter((s) => !(hit?.scripts ?? []).includes(s))
        return {
          skillId: req.skillId,
          present: Boolean(hit),
          scriptsFound: hit?.scripts ?? [],
          missingScripts
        }
      })
      const ready = checks.every((item) => item.present && item.missingScripts.length === 0)

      return {
        success: true,
        data: {
          ready,
          totalSkills: skills.length,
          checks
        }
      }
    }
  })

  return definePack({
    id: 'yolo-wrapper-tools',
    description: 'Typed wrappers for tools/skills integration and runtime diagnostics.',
    tools: [
      literatureSearchTool as any,
      dataAnalyzeTool as any,
      writingOutlineTool as any,
      writingDraftTool as any,
      convertToMarkdownTool as any,
      skillsHealthCheckTool as any
    ]
  })
}
