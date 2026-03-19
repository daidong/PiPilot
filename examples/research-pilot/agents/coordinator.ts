/**
 * Coordinator Agent (Research Pilot Memory Minimal Core - RFC-015)
 *
 * Key behavior:
 * - Canonical durable memory surface: Artifact
 * - Cross-turn continuity is provided by Session Summary snapshots
 * - Context is assembled by Kernel V2 with mention selections + latest session summary
 */

import { join, parse } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createAgent, packs, definePack, defineTool } from '../../../src/index.js'
import { createLLMClientFromModelId } from '../../../src/llm/index.js'
import { getModel } from '../../../src/llm/models.js'
import { createSubagentTools } from './subagent-tools.js'
import { createResearchMemoryTools } from '../tools/entity-tools.js'
import { RESEARCH_PILOT_KERNEL_V2_CONFIG } from '../config/kernel-v2.js'
import type { Agent } from '../../../src/types/agent.js'
import type { ContextSelection } from '../../../src/types/context-pipeline.js'
import type { SkillScriptMetadata } from '../../../src/types/skill.js'
import { countTokens } from '../../../src/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'
import { researchPilotSkills } from '../skills/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, AGENT_MD_ID, type SessionSummary, type NoteArtifact } from '../types.js'
import {
  migrateLegacyArtifacts,
  findArtifactById,
  readLatestSessionSummary,
  writeSessionSummary
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

type IntentLabel =
  | 'literature'
  | 'data'
  | 'writing'
  | 'critique'
  | 'web'
  | 'citation'
  | 'grants'
  | 'docx'
  | 'general'
type PersistenceDecision = 'ephemeral' | 'conditional' | 'persist-requested'

const INTENT_PRIORITY: IntentLabel[] = [
  'data',
  'literature',
  'critique',
  'writing',
  'citation',
  'grants',
  'docx',
  'web',
  'general'
]

const INTENT_MODULES: Partial<Record<IntentLabel, string>> = {
  literature: 'coordinator-module-literature',
  data: 'coordinator-module-data',
  writing: 'coordinator-module-writing',
  critique: 'coordinator-module-critique'
}

const INTENT_SKILL_IDS: Partial<Record<IntentLabel, string>> = {
  literature: 'literature-skill',
  data: 'data-analysis-skill',
  writing: 'academic-writing-skill',
  citation: 'citation-management',
  grants: 'research-grants',
  docx: 'document-docx'
}

const INTENT_TAG_HINTS: Partial<Record<IntentLabel, string[]>> = {
  literature: ['literature', 'papers', 'research'],
  data: ['data', 'analysis'],
  writing: ['writing', 'academic'],
  citation: ['citations', 'bibtex', 'doi'],
  grants: ['grants', 'proposal'],
  docx: ['docx', 'document-processing']
}

interface TurnExplainSnapshot {
  timestamp: string
  sessionId: string
  intents: string[]
  skillRouting?: {
    explicitPreloads: string[]
    recommendedPreloads: string[]
  }
  selectedContext: {
    mentionSelections: number
    approxTokens: number
  }
  persistence: {
    decision: PersistenceDecision
    reason: string
  }
  sessionSummary: {
    included: boolean
    turnRange?: [number, number]
    approxTokens: number
  }
  budget: {
    model: string
    contextWindow?: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

function detectIntentsByRules(message: string): Set<IntentLabel> {
  const text = message.toLowerCase()
  const intents = new Set<IntentLabel>()

  if (/(paper|papers|literature|related work|citation|survey|systematic review|find papers|arxiv|doi|bibtex|scholar)/.test(text)) intents.add('literature')
  if (/(data|dataset|csv|tsv|xlsx|xls|json|parquet|statistics|statistical|analysis|analyze|visualize|plot|chart|graph|matplotlib|seaborn|regression|modeling|correlation|distribution|outlier)/.test(text)) intents.add('data')
  if (/(rewrite|draft|write|outline|abstract|introduction|section|manuscript|proposal|review article|写作|改写|润色|摘要|大纲)/.test(text)) intents.add('writing')
  if (/(citation|cite|bibtex|endnote|zotero|doi|reference list|references|参考文献|引文|引证)/.test(text)) intents.add('citation')
  if (/(grant|grants|proposal|specific aims|broader impacts|nih|nsf|doe|darpa|funding|资助|基金|申报书)/.test(text)) intents.add('grants')
  if (/(docx|word document|tracked changes|track changes|ooxml|comment thread|批注|修订)/.test(text)) intents.add('docx')
  if (/(critique|review|evaluate|assessment|assess|weakness|limitation|pros|cons|flaw|评审|评价|批评|缺陷|可行性)/.test(text)) intents.add('critique')
  if (/(latest|today|news|deadline|release|price|官网|新闻|截止|版本)/.test(text)) intents.add('web')

  return intents
}

async function classifyIntentWithLLM(
  routerClient: ReturnType<typeof createLLMClientFromModelId> | null,
  message: string
): Promise<IntentLabel> {
  if (!routerClient) return 'general'

  const system = [
    'You are an intent router for a research assistant.',
    'Choose ONE label from: literature, data, writing, critique, web, citation, grants, docx, general.',
    'Output only the label.'
  ].join(' ')

  try {
    const result = await routerClient.generate({
      system,
      messages: [{ role: 'user', content: message }],
      maxTokens: 6
    })
    const label = result.text.trim().toLowerCase().split(/\s+/)[0] as IntentLabel
    if (INTENT_PRIORITY.includes(label)) return label
  } catch {
    // fallback
  }

  return 'general'
}

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

interface SkillPreloadDecision {
  explicitPreloads: string[]
  recommendedPreloads: string[]
}

function isScriptOnlySkill(skill: { tools?: unknown[] } | null | undefined): boolean {
  if (!skill || !Array.isArray(skill.tools)) return false
  return skill.tools.length === 1 && skill.tools[0] === 'skill-script-run'
}

function normalizeExtension(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '').trim()
}

function normalizeScriptName(script: SkillScriptMetadata): string {
  const raw = (script.name ?? script.fileName ?? '').trim()
  if (!raw) return ''
  const ext = raw.lastIndexOf('.')
  return ext > 0 ? raw.slice(0, ext) : raw
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
      .map(item => typeof item === 'string' ? normalizeExtension(item) : '')
      .filter(Boolean)
    : undefined
  const script = typeof convertObj.script === 'string' && convertObj.script.trim()
    ? convertObj.script.trim().toLowerCase()
    : undefined

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
    options?.preferred &&
    options.preferred.skillId === skillId &&
    options.preferred.script.toLowerCase() === normalizedScript
  ) {
    score += 160
    reasons.push('previous successful converter')
    score += Math.min(40, options.preferred.successes * 8)
    score -= Math.min(30, options.preferred.failures * 10)
  }

  if (score <= 0) return null

  return {
    score,
    reason: reasons.join(', ')
  }
}

function discoverDynamicConversionScripts(
  skillManager: any,
  inputPath: string,
  preferredByExt?: Map<string, PreferredConversionScript>
): ScriptCandidate[] {
  if (!skillManager || typeof skillManager.getAll !== 'function') {
    return []
  }

  const extNoDot = normalizeExtension(parse(inputPath).ext)
  if (!extNoDot) return []

  const preferred = preferredByExt?.get(extNoDot) ?? null
  const skills = skillManager.getAll() as Array<{
    id: string
    meta?: Record<string, unknown> & { scripts?: SkillScriptMetadata[] }
  }>
  const candidates: ScriptCandidate[] = []
  const seen = new Set<string>()

  for (const skill of skills) {
    const scripts = skill.meta?.scripts
    if (!Array.isArray(scripts) || scripts.length === 0) continue
    const capability = readConversionCapability(skill)

    for (const script of scripts) {
      const scriptName = normalizeScriptName(script)
      if (!scriptName) continue

      const scored = scoreScriptCandidate(skill.id, scriptName, extNoDot, {
        capability,
        preferred
      })
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

function recommendSkillsForMessage(
  message: string,
  intents: Set<IntentLabel>,
  skillRegistry: any
): string[] {
  if (!skillRegistry || typeof skillRegistry.findMatches !== 'function') {
    return []
  }

  const tagHints = new Set<string>()
  for (const intent of intents) {
    const tags = INTENT_TAG_HINTS[intent] ?? []
    for (const tag of tags) tagHints.add(tag)
  }

  const matches = skillRegistry.findMatches({
    ...(tagHints.size > 0 ? { tags: Array.from(tagHints) } : {}),
    search: message
  }) as Array<{
    score: number
    skill?: { id?: string; loadingStrategy?: string; meta?: Record<string, unknown>; tools?: unknown[] }
  }>

  if (!Array.isArray(matches) || matches.length === 0) {
    return []
  }

  const recommended: string[] = []
  for (const match of matches) {
    const skill = match.skill
    if (!skill?.id) continue
    if ((match.score ?? 0) < 25) continue
    if (skill.loadingStrategy === 'on-demand') continue
    if (isScriptOnlySkill(skill)) continue
    const sourceType = typeof skill.meta?.sourceType === 'string' ? skill.meta.sourceType : ''
    if (sourceType !== 'community-builtin' && sourceType !== 'project-local') continue
    recommended.push(skill.id)
    if (recommended.length >= 3) break
  }

  return recommended
}

function preloadSkillsForIntents(
  message: string,
  intents: Set<IntentLabel>,
  skillManager: any,
  skillRegistry: any
): SkillPreloadDecision {
  const decision: SkillPreloadDecision = {
    explicitPreloads: [],
    recommendedPreloads: []
  }
  if (!skillManager || typeof skillManager.loadFully !== 'function') return decision

  const loaded = new Set<string>()
  for (const intent of intents) {
    const skillId = INTENT_SKILL_IDS[intent]
    if (!skillId || loaded.has(skillId)) continue
    const skill = typeof skillManager.get === 'function' ? skillManager.get(skillId) : null
    if (isScriptOnlySkill(skill)) continue
    loaded.add(skillId)
    decision.explicitPreloads.push(skillId)
    skillManager.loadFully(skillId)
  }

  const recommended = recommendSkillsForMessage(message, intents, skillRegistry)
  for (const skillId of recommended) {
    if (loaded.has(skillId)) continue
    loaded.add(skillId)
    decision.recommendedPreloads.push(skillId)
    skillManager.loadFully(skillId)
  }

  return decision
}

function classifyPersistenceDecision(message: string): { decision: PersistenceDecision; reason: string } {
  const text = message.toLowerCase()

  if (/(do not save|don't save|no artifact|just answer|不要保存|别保存|不用保存)/.test(text)) {
    return { decision: 'ephemeral', reason: 'User explicitly requested no persistence.' }
  }

  if (/(save|persist|remember|track|record|store|archive|保存|记住|记录|跟踪|持久化)/.test(text)) {
    return { decision: 'persist-requested', reason: 'User requested durable tracking or saving.' }
  }

  if (/(^|\s)(why|what|how|status|clarify|explain|check)(\s|$)|为什么|怎么|是否|有无|确认/.test(text)) {
    return { decision: 'ephemeral', reason: 'Message appears to be clarification/status Q&A.' }
  }

  return { decision: 'conditional', reason: 'Persist only if reuse/traceability triggers are met during execution.' }
}

function buildAdditionalInstructions(intents: Set<IntentLabel>): string | undefined {
  const ordered = INTENT_PRIORITY.filter(i => intents.has(i)).slice(0, 2)
  const modules: string[] = []

  for (const intent of ordered) {
    if (INTENT_SKILL_IDS[intent]) continue

    const name = INTENT_MODULES[intent]
    if (name) {
      modules.push(loadPrompt(name))
    }
  }

  return modules.length > 0 ? modules.join('\n\n') : undefined
}

function buildMentionSelections(mentions?: ResolvedMention[]): ContextSelection[] {
  if (!mentions) return []

  return mentions
    .filter(m => !m.error)
    .map(m => ({
      type: 'custom' as const,
      ref: m.ref.raw,
      resolve: async () => {
        const content = `### ${m.label}\n\n${m.content}`
        return {
          source: `mention:${m.ref.raw}`,
          content,
          tokens: countTokens(content)
        }
      }
    }))
}

function buildSessionSummarySelection(summary: SessionSummary): ContextSelection {
  const lines = [
    '## Session Summary',
    `Turns ${summary.turnRange[0]}-${summary.turnRange[1]}:`,
    summary.summary,
    '',
    `Topics: ${summary.topicsDiscussed.join(', ')}`,
    ...(summary.openQuestions.length > 0
      ? ['Open questions:', ...summary.openQuestions.map(q => `- ${q}`)]
      : [])
  ]
  const content = lines.join('\n')
  const tokens = countTokens(content)

  return {
    type: 'custom',
    ref: 'session:summary',
    resolve: async () => ({
      source: 'session:summary',
      content,
      tokens
    })
  }
}

function writeExplainSnapshot(projectPath: string, snapshot: TurnExplainSnapshot): void {
  const explainDir = join(projectPath, PATHS.explainDir)
  mkdirSync(explainDir, { recursive: true })
  const ts = Date.now().toString(36)
  const path = join(explainDir, `${ts}.${snapshot.sessionId}.turn.json`)
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8')
}

export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  debug?: boolean
  sessionId?: string
  externalSkillsDir?: string
  communitySkillsDir?: string
  watchExternalSkills?: boolean
  watchCommunitySkills?: boolean
  reasoningEffort?: 'high' | 'medium' | 'low'
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
  onUsage?: (usage: unknown, cost: unknown) => void
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  clearSessionMemory: () => Promise<void>
  destroy: () => Promise<void>
}> {
  const {
    apiKey,
    model,
    projectPath = process.cwd(),
    debug = false,
    sessionId = 'default',
    externalSkillsDir,
    communitySkillsDir,
    watchExternalSkills,
    watchCommunitySkills,
    reasoningEffort = 'high',
    onStream,
    onToolCall,
    onToolResult,
    onUsage
  } = config

  let lastTurnExplain: TurnExplainSnapshot | null = null
  let lastBudgetExplain: TurnExplainSnapshot['budget'] | null = null
  let turnCount = 0
  let activeTurnToolCallCount: number | null = null
  const turnHistory: Array<{ userMessage: string; response: string; toolCallCount: number; timestamp: string }> = []

  const migration = migrateLegacyArtifacts(projectPath)
  if (debug && migration.updatedFiles > 0) {
    console.log(`[Coordinator] migrated legacy artifacts: files=${migration.updatedFiles}, literature->paper=${migration.convertedLiteratureType}, data.name removed=${migration.removedDataNameField}`)
  }

  // Select intent router model based on coordinator's provider
  const coordinatorProvider = getModel(model ?? '')?.providerID
  const intentRouterModelId = coordinatorProvider === 'anthropic'
    ? 'claude-haiku-4-5-20251001'
    : 'gpt-5.4-nano'

  let intentRouterClient: ReturnType<typeof createLLMClientFromModelId> | null = null
  try {
    intentRouterClient = createLLMClientFromModelId(intentRouterModelId, { apiKey })
  } catch (err) {
    if (debug) {
      console.warn(`[IntentRouter] Failed to init ${intentRouterModelId}:`, err)
    }
  }

  const wrappedOnToolResult = (tool: string, result: unknown, args?: unknown) => {
    if (activeTurnToolCallCount !== null) {
      activeTurnToolCallCount++
    }
    onToolResult?.(tool, result, args)
  }

  const { literatureSearchTool, dataAnalyzeTool } = createSubagentTools(
    apiKey,
    model,
    wrappedOnToolResult,
    projectPath,
    sessionId,
    onToolCall
  )

  const memoryTools = createResearchMemoryTools({
    sessionId,
    projectPath
  })

  const convertToMarkdownTool = defineTool({
    name: 'convert_to_markdown',
    description: 'Convert document to markdown, save local .md file, and return preview + headings for targeted reads.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative path to document file (e.g., "report.pdf")',
        required: true
      }
    },
    execute: async (input, context) => {
      const fileName = (input as { path: string }).path
      const absPath = join(projectPath, fileName)
      if (!existsSync(absPath)) {
        return { success: false, error: `File not found: ${fileName}` }
      }

      const outputName = `${parse(fileName).name}.extracted.md`
      const outputPath = join(projectPath, outputName)
      const extension = normalizeExtension(parse(fileName).ext)
      const preferredByExt = context.runtime.sessionState.get<Map<string, PreferredConversionScript>>('preferredConverterByExt')
        ?? new Map<string, PreferredConversionScript>()
      const dynamicCandidates = discoverDynamicConversionScripts(context.runtime.skillManager, absPath, preferredByExt)
      if (debug) {
        const preview = dynamicCandidates
          .slice(0, 5)
          .map(c => `${c.skillId}/${c.script} score=${c.score}`)
          .join(', ')
        console.log(`[convert_to_markdown] extension=${extension || '(none)'} candidates=${dynamicCandidates.length}${preview ? ` -> ${preview}` : ''}`)
      }
      const errors: string[] = []
      let usedConverter: string | null = null
      let usedScript: string | null = null

      if (dynamicCandidates.length === 0) {
        if (debug) {
          console.log('[convert_to_markdown] no converter scripts discovered from loaded skills')
        }
        return {
          success: false,
          error: [
            `Failed to convert "${fileName}" because no conversion script was discovered from loaded skills.`,
            'Expected scripts like: convert-file, <ext>-to-markdown, convert-to-markdown.',
            'Tip: ensure community skill "markitdown" or project-local converter skills are loaded.'
          ].join('\n')
        }
      }

      const skillScriptRunTool = context.runtime.toolRegistry.get('skill-script-run')
      if (!skillScriptRunTool) {
        if (debug) {
          console.log('[convert_to_markdown] skill-script-run not available in runtime')
        }
        return {
          success: false,
          error: 'skill-script-run tool is not available in runtime.'
        }
      }

      for (const candidate of dynamicCandidates) {
        const runResult = await skillScriptRunTool.execute({
          skillId: candidate.skillId,
          script: candidate.script,
          args: [absPath, outputPath],
          cwd: '.',
          timeout: 240000
        }, context)

        if (!runResult.success) {
          if (debug) {
            console.log(`[convert_to_markdown] failed ${candidate.skillId}/${candidate.script}: ${runResult.error ?? 'execution failed'}`)
          }
          errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): ${runResult.error ?? 'execution failed'}`)

          if (extension) {
            const preferred = preferredByExt.get(extension)
            if (
              preferred &&
              preferred.skillId === candidate.skillId &&
              preferred.script.toLowerCase() === candidate.script.toLowerCase()
            ) {
              preferredByExt.set(extension, {
                ...preferred,
                failures: preferred.failures + 1,
                lastUsedAt: Date.now()
              })
              context.runtime.sessionState.set('preferredConverterByExt', preferredByExt)
            }
          }
          continue
        }

        if (!existsSync(outputPath)) {
          errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): completed but output file missing`)
          continue
        }

        const generated = readFileSync(outputPath, 'utf-8').trim()
        if (!generated) {
          errors.push(`${candidate.skillId}/${candidate.script} (${candidate.reason}): output markdown is empty`)
          continue
        }

        usedConverter = candidate.skillId
        usedScript = candidate.script
        if (debug) {
          console.log(`[convert_to_markdown] selected ${usedConverter}/${usedScript}`)
        }
        if (extension) {
          const preferred = preferredByExt.get(extension)
          const sameAsPreferred = preferred &&
            preferred.skillId === candidate.skillId &&
            preferred.script.toLowerCase() === candidate.script.toLowerCase()

          preferredByExt.set(extension, {
            skillId: candidate.skillId,
            script: candidate.script,
            successes: sameAsPreferred ? preferred.successes + 1 : 1,
            failures: sameAsPreferred ? preferred.failures : 0,
            lastUsedAt: Date.now()
          })
          context.runtime.sessionState.set('preferredConverterByExt', preferredByExt)
        }
        break
      }

      if (!usedConverter) {
        return {
          success: false,
          error: [
            `Failed to convert document "${fileName}" to markdown.`,
            'Tried skill scripts:',
            ...errors.map((line) => `- ${line}`)
          ].join('\n')
        }
      }

      const text = readFileSync(outputPath, 'utf-8')

      const allLines = text.split('\n')
      const lines = allLines.length
      const headings = allLines
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter(item => /^#{1,4}\s/.test(item.text))

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
            ? headings.map(h => `L${h.line}: ${h.text}`).join('\n')
            : undefined,
          message: `Extracted ${lines} lines. Use read({ path: "${outputName}", offset, limit }) for targeted sections.`
        }
      }
    }
  })

  const webPack = await packs.web({
    timeout: 30000,
    enabledTools: ['brave_web_search']
  })

  const subagentPack = definePack({
    id: 'subagents',
    name: 'Subagent Tools',
    description: 'Literature search and data analysis tools',
    tools: [literatureSearchTool, dataAnalyzeTool, ...memoryTools]
  })

  const agent = createAgent({
    apiKey,
    model,
    projectPath,
    reasoningEffort,
    identity: SYSTEM_PROMPT,
    constraints: [
      'For multi-step work, briefly state intent before acting',
      'Ask for clarification when instructions are ambiguous',
      'For repo/file investigation: locate with glob/grep first, then use targeted read with offset/limit; avoid bash unless execution or built-in tools cannot perform the task.'
    ],
    packs: [
      packs.safe(),
      packs.exec({ approvalMode: 'none', denyPatterns: [] }),
      packs.todo(),
      definePack({
        id: 'documents-wrapper',
        description: 'Document conversion wrapper',
        tools: [convertToMarkdownTool as unknown as Tool]
      }),
      webPack,
      subagentPack,
      definePack({
        id: 'research-skills',
        description: 'Research pilot skills for literature, writing, and data analysis',
        skills: researchPilotSkills,
        skillLoadingConfig: {
          lazy: ['academic-writing-skill', 'literature-skill', 'data-analysis-skill']
        }
      })
    ],
    onStream,
    onToolCall: (name: string, args: unknown) => {
      onToolCall?.(name, args)
      if (debug) {
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 120)}...)`)
      }
    },
    onToolResult: wrappedOnToolResult,
    externalSkillsDir,
    communitySkillsDir,
    watchExternalSkills,
    watchCommunitySkills,
    sessionId,
    debug,
    taskProfile: 'research',
    outputReserveStrategy: {
      intermediate: 16384,
      final: 8192,
      extended: 16384
    },
    budgetConfig: {
      enabled: true,
      modelId: model,
      toolResultCap: 4096,
      priorityTools: ['read', 'write', 'edit', 'grep', 'glob', 'literature-search', 'artifact-search']
    },
    toolLoopThreshold: 15,
    maxSteps: 100,
    onUsage,
    contextWindow,
    kernelV2: RESEARCH_PILOT_KERNEL_V2_CONFIG
  })

  await agent.ensureInit()

  async function clearSessionMemory() {
    const storage = agent.runtime.memoryStorage
    if (!storage) return
    const { items } = await storage.list({ namespace: 'session', status: 'active' })
    for (const item of items) {
      await storage.delete('session', item.key, 'session-clear')
    }
  }

  await clearSessionMemory()

  async function maybeGenerateSummary(): Promise<void> {
    if (turnHistory.length === 0) return

    // Trigger conditions
    const isBaselineTrigger = turnCount % 5 === 0
    const last3 = turnHistory.slice(-3)
    const toolCallSum = last3.reduce((sum, t) => sum + t.toolCallCount, 0)
    const isHeavyToolUsage = last3.length >= 3 && toolCallSum > 15
    const responseCharSum = last3.reduce((sum, t) => sum + t.response.length, 0)
    const isLotsOfContent = last3.length >= 3 && responseCharSum > 8000

    if (!isBaselineTrigger && !isHeavyToolUsage && !isLotsOfContent) return

    if (!intentRouterClient) return

    const historyText = turnHistory
      .map((t, i) => `Turn ${turnCount - turnHistory.length + i + 1}: User: ${t.userMessage}\nAssistant: ${t.response}`)
      .join('\n\n')

    const prompt = [
      'Summarize this research assistant conversation excerpt.',
      'Output JSON: {"summary":"<2-3 sentences>","topicsDiscussed":["topic1","topic2"],"openQuestions":["q1"]}',
      '',
      historyText
    ].join('\n')

    try {
      const result = await intentRouterClient.generate({
        system: 'You summarize research conversations. Output valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200
      })

      const text = result.text.trim()
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return

      const parsed = JSON.parse(jsonMatch[0]) as {
        summary: string
        topicsDiscussed: string[]
        openQuestions: string[]
      }

      const summary: SessionSummary = {
        sessionId,
        turnRange: [Math.max(1, turnCount - turnHistory.length + 1), turnCount],
        summary: parsed.summary,
        topicsDiscussed: parsed.topicsDiscussed ?? [],
        openQuestions: parsed.openQuestions ?? [],
        createdAt: new Date().toISOString()
      }

      writeSessionSummary(projectPath, summary)

      if (debug) {
        console.log(`[Summary] Generated session summary at turn ${turnCount}: ${parsed.summary.slice(0, 80)}...`)
      }
    } catch (err) {
      if (debug) {
        console.warn('[Summary] Failed to generate session summary:', err)
      }
    }
  }

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        const intents = detectIntentsByRules(message)
        const hasModuleIntent = ['literature', 'data', 'writing', 'citation', 'grants', 'docx', 'critique']
          .some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterClient, message)
          if (label !== 'general') intents.add(label)
        }
        const skillRouting = preloadSkillsForIntents(
          message,
          intents,
          agent.runtime.skillManager,
          agent.runtime.skillRegistry
        )
        const baseAdditionalInstructions = buildAdditionalInstructions(intents)

        // Read agent.md and prepend to additionalInstructions (system prompt level, never truncated)
        const agentMdRecord = findArtifactById(projectPath, AGENT_MD_ID)
        const agentMdContent = agentMdRecord?.artifact?.type === 'note'
          ? (agentMdRecord.artifact as NoteArtifact).content
          : ''
        const additionalInstructions = agentMdContent
          ? `## User Instructions (agent.md)\n\n${agentMdContent}\n\n${baseAdditionalInstructions ?? ''}`
          : baseAdditionalInstructions

        const persistence = classifyPersistenceDecision(message)

        const mentionSelections = buildMentionSelections(mentions)
        const latestSummary = readLatestSessionSummary(projectPath, sessionId)
        const summarySelection = latestSummary ? buildSessionSummarySelection(latestSummary) : null
        const summaryTokens = summarySelection
          ? countTokens(`Session summary (~${latestSummary!.turnRange[0]}-${latestSummary!.turnRange[1]})`)
          : 0

        const selectedContext: ContextSelection[] = [
          ...mentionSelections,
          ...(summarySelection ? [summarySelection] : [])
        ]

        const explain: TurnExplainSnapshot = {
          timestamp: new Date().toISOString(),
          sessionId,
          intents: Array.from(intents),
          skillRouting,
          selectedContext: {
            mentionSelections: mentionSelections.length,
            approxTokens: summaryTokens
          },
          persistence: {
            decision: persistence.decision,
            reason: persistence.reason
          },
          sessionSummary: {
            included: !!summarySelection,
            turnRange: latestSummary?.turnRange,
            approxTokens: summaryTokens
          },
          budget: {
            model: model ?? 'default'
          }
        }

        lastTurnExplain = explain
        lastBudgetExplain = explain.budget

        if (debug) {
          const intentList = Array.from(intents).join(', ') || 'none'
          console.log(`[Chat] Intents: ${intentList}`)
          if (skillRouting.explicitPreloads.length > 0 || skillRouting.recommendedPreloads.length > 0) {
            console.log(`[Chat] Skill preloads: explicit=[${skillRouting.explicitPreloads.join(', ')}] recommended=[${skillRouting.recommendedPreloads.join(', ')}]`)
          }
          console.log(`[Chat] Sending message to agent (${mentionSelections.length} mention selections, summary=${!!summarySelection})...`)
        }

        // Count tool calls for this turn via coordinator-level onToolResult wrapper.
        let perTurnToolCallCount = 0
        activeTurnToolCallCount = 0
        let result: Awaited<ReturnType<Agent['run']>>
        try {
          result = await agent.run(message, {
            ...(selectedContext.length > 0 ? { selectedContext } : {}),
            ...(additionalInstructions ? { additionalInstructions } : {})
          })
          perTurnToolCallCount = activeTurnToolCallCount ?? 0
        } finally {
          activeTurnToolCallCount = null
        }

        if (result.usage?.tokens) {
          explain.budget.promptTokens = result.usage.tokens.promptTokens
          explain.budget.completionTokens = result.usage.tokens.completionTokens
          explain.budget.totalTokens = result.usage.tokens.totalTokens
          lastBudgetExplain = explain.budget
          lastTurnExplain = explain
        }

        writeExplainSnapshot(projectPath, explain)

        // Update turn history and count (single-point increment)
        turnCount++
        turnHistory.push({
          userMessage: message.slice(0, 300),
          response: (result.output ?? '').slice(0, 300),
          toolCallCount: perTurnToolCallCount,
          timestamp: new Date().toISOString()
        })
        if (turnHistory.length > 8) turnHistory.shift()

        // Smart summary trigger
        void maybeGenerateSummary()

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}, turn=${turnCount}`)
        }

        if (result.success) {
          return { success: true, response: result.output }
        }

        return {
          success: false,
          error: result.error || 'Agent failed (no error message)'
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        if (debug) {
          console.log(`[Chat] Exception: ${errorMsg}`)
        }
        return { success: false, error: errorMsg }
      }
    },

    clearSessionMemory,

    async destroy() {
      await agent.destroy()
    }
  }
}

export { createCoordinator as createCoordinatorRunner }
