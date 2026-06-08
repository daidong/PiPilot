#!/usr/bin/env node
// Smoke test for the coordinator's LLM-based skill router.
//
// Reproduces `matchSkillsWithLLM` in lib/agents/coordinator.ts verbatim:
//   - Same system prompt
//   - Same `- <name>: <description>` skill list
//   - Same router-model class (Haiku / GPT-5-nano / Gemini-2.0-flash-lite)
//   - Same JSON-array parse
//
// Usage:
//   node scripts/test-skill-routing.mjs            # anthropic (default), needs ANTHROPIC_API_KEY
//   node scripts/test-skill-routing.mjs --provider=openai    # needs OPENAI_API_KEY
//   node scripts/test-skill-routing.mjs --provider=google    # needs GEMINI_API_KEY
//   node scripts/test-skill-routing.mjs --cases=path/to/cases.json
//
// Exits non-zero if any case fails (expected skill missing, or forbidden skill present).

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getModel, getEnvApiKey, completeSimple } from '@mariozechner/pi-ai'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BUILTIN_SKILLS_DIR = join(REPO_ROOT, 'lib', 'skills', 'builtin')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  })
)

const PROVIDER = args.provider ?? 'anthropic'
const CASES_PATH = args.cases

const ROUTER_BY_PROVIDER = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.4-nano',
  google: 'gemini-2.0-flash-lite'
}

// ---------------------------------------------------------------------------
// Skill discovery — mirrors lib/skills/loader.ts frontmatter parse
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  if (end < 0) return null
  const fm = md.slice(3, end).trim()
  const out = {}
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function loadBuiltinSkills() {
  const skills = []
  for (const name of readdirSync(BUILTIN_SKILLS_DIR)) {
    const skillFile = join(BUILTIN_SKILLS_DIR, name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const md = readFileSync(skillFile, 'utf-8')
    const fm = parseFrontmatter(md)
    if (!fm?.name || !fm?.description) continue
    skills.push({ name: fm.name, description: fm.description })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Exact copy of matchSkillsWithLLM prompt (coordinator.ts:99-148)
// ---------------------------------------------------------------------------

const MAX_SKILL_PRELOAD = 5

function buildSystemPrompt(skills) {
  const skillList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
  return [
    'You are a skill router for a research assistant. Given a user message, select which skills should be activated.',
    'Return ONLY a JSON array of skill names. Return [] if none are relevant.',
    '',
    'Rules:',
    '- Only select skills directly relevant to the user\'s request',
    '- Do not select skills speculatively',
    `- Maximum ${MAX_SKILL_PRELOAD} skills`,
    '- Consider both English and Chinese messages',
    '',
    'Available skills:',
    skillList
  ].join('\n')
}

async function routeOnce(model, apiKey, systemPrompt, message) {
  const result = await completeSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: message, timestamp: Date.now() }]
  }, { maxTokens: 100, apiKey })

  const textContent = result.content.find(c => c.type === 'text')
  const text = textContent?.text?.trim() ?? ''
  if (!text) return { raw: '', picked: [] }

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*?\])/)
  const jsonStr = jsonMatch?.[1]?.trim() ?? text
  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return { raw: text, picked: [] }
    return {
      raw: text,
      picked: parsed.filter(n => typeof n === 'string').slice(0, MAX_SKILL_PRELOAD)
    }
  } catch {
    return { raw: text, picked: [] }
  }
}

// ---------------------------------------------------------------------------
// Test cases — focused on the two new marp skills
// ---------------------------------------------------------------------------

const DEFAULT_CASES = [
  {
    msg: "let's work in week10_dist folder, create a new week10B_storage_design_slides_v2.md for teaching next week. You can check other docs in the week10_dist folder as your references and write high quality teaching slides.",
    expect: ['teaching-marp-slides'],
    forbid: ['academic-marp-slides']
  },
  {
    msg: 'Make lecture slides for CS101 on backpropagation',
    expect: ['teaching-marp-slides'],
    forbid: ['academic-marp-slides']
  },
  {
    msg: '我要做个论文答辩 PPT',
    expect: ['academic-marp-slides'],
    forbid: ['teaching-marp-slides']
  },
  {
    msg: '下周课件，讲 LR 和 logistic regression',
    expect: ['teaching-marp-slides'],
    forbid: ['academic-marp-slides']
  },
  {
    msg: 'slides for my group meeting',
    expect: ['academic-marp-slides'],
    forbid: ['teaching-marp-slides']
  },
  {
    msg: 'revise slide 7 of my conference talk',
    expect: ['academic-marp-slides'],
    forbid: ['teaching-marp-slides']
  },
  {
    msg: 'add a worked example to my lecture slides',
    expect: ['teaching-marp-slides'],
    forbid: ['academic-marp-slides']
  },
  {
    msg: 'help me draft a NeurIPS paper intro',
    expect: ['paper-writing'],
    forbid: ['academic-marp-slides', 'teaching-marp-slides']
  },
  {
    msg: 'brainstorm research ideas for agentic HPC scheduling',
    expect: ['research-strategy'],
    forbid: ['academic-marp-slides', 'teaching-marp-slides']
  },
  {
    msg: '这个研究方向值不值得做？帮我审一下premise和最强反对意见',
    expect: ['research-strategy'],
    forbid: ['paper-writing', 'academic-marp-slides']
  }
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const skills = loadBuiltinSkills()
  console.log(`Loaded ${skills.length} builtin skills from ${BUILTIN_SKILLS_DIR}`)
  const marpOnes = skills.filter(s => s.name.includes('marp'))
  for (const s of marpOnes) console.log(`  • ${s.name}`)
  console.log()

  const routerModelId = ROUTER_BY_PROVIDER[PROVIDER]
  if (!routerModelId) {
    console.error(`Unknown provider "${PROVIDER}". Pick one of: ${Object.keys(ROUTER_BY_PROVIDER).join(', ')}`)
    process.exit(2)
  }
  const apiKey = getEnvApiKey(PROVIDER)
  if (!apiKey) {
    console.error(`No API key for provider "${PROVIDER}" in env. Set the provider's standard env var (e.g., ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY).`)
    process.exit(2)
  }
  const model = getModel(PROVIDER, routerModelId)
  console.log(`Using router: ${PROVIDER}/${routerModelId}\n`)

  const cases = CASES_PATH
    ? JSON.parse(readFileSync(CASES_PATH, 'utf-8'))
    : DEFAULT_CASES

  const systemPrompt = buildSystemPrompt(skills)

  let failures = 0
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] "${c.msg}" ... `)
    let result
    try {
      result = await routeOnce(model, apiKey, systemPrompt, c.msg)
    } catch (err) {
      console.log('ERROR')
      console.log(`  ${err?.message ?? err}`)
      failures++
      continue
    }

    const picked = new Set(result.picked)
    const missing = (c.expect ?? []).filter(name => !picked.has(name))
    const forbidHits = (c.forbid ?? []).filter(name => picked.has(name))
    const ok = missing.length === 0 && forbidHits.length === 0

    console.log(ok ? 'PASS' : 'FAIL')
    console.log(`  picked: [${result.picked.join(', ')}]`)
    if (c.expect?.length) console.log(`  expect: [${c.expect.join(', ')}]`)
    if (c.forbid?.length) console.log(`  forbid: [${c.forbid.join(', ')}]`)
    if (missing.length) console.log(`  MISSING: [${missing.join(', ')}]`)
    if (forbidHits.length) console.log(`  UNWANTED: [${forbidHits.join(', ')}]`)
    if (!ok) failures++
  }

  console.log(`\n${cases.length - failures}/${cases.length} passed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
