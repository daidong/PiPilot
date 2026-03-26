#!/usr/bin/env node
// Backfill paper artifacts from existing literature-run review.json files.
// Usage: node scripts/backfill-papers.mjs <projectPath>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const projectPath = process.argv[2]
if (!projectPath) {
  console.error('Usage: node scripts/backfill-papers.mjs <projectPath>')
  process.exit(1)
}

const litRunsDir = join(projectPath, '.research-pilot/literature-runs')
const papersDir = join(projectPath, '.research-pilot/artifacts/papers')
mkdirSync(papersDir, { recursive: true })

// Load existing papers for dedup
const existingPapers = []
if (existsSync(papersDir)) {
  for (const f of readdirSync(papersDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(papersDir, f), 'utf-8'))
      existingPapers.push(p)
    } catch {}
  }
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function isDuplicate(title, year) {
  const nt = normalizeTitle(title)
  return existingPapers.some(p => {
    const pt = normalizeTitle(p.title)
    if (pt !== nt) return false
    if (!year || !p.year) return true
    return p.year === year
  })
}

function generateCiteKey(authors, year) {
  const firstAuthor = (authors?.[0] ?? 'unknown').split(/\s+/).pop()?.toLowerCase() ?? 'unknown'
  return `${firstAuthor}${year ?? 'nd'}`
}

const AUTO_SAVE_THRESHOLD = 7
let saved = 0
let skippedDup = 0
let skippedScore = 0

if (!existsSync(litRunsDir)) {
  console.error(`No literature-runs dir at ${litRunsDir}`)
  process.exit(1)
}

const runs = readdirSync(litRunsDir)
for (const runId of runs) {
  const reviewPath = join(litRunsDir, runId, 'review.json')
  if (!existsSync(reviewPath)) continue

  let data
  try {
    data = JSON.parse(readFileSync(reviewPath, 'utf-8'))
  } catch { continue }

  const papers = data.review?.relevantPapers ?? []
  const subTopics = data.plan?.subTopics ?? []
  const roundLabel = `R-${runId}`

  for (const paper of papers) {
    if ((paper.relevanceScore ?? 0) < AUTO_SAVE_THRESHOLD) {
      skippedScore++
      continue
    }
    if (isDuplicate(paper.title, paper.year)) {
      skippedDup++
      continue
    }

    const authors = paper.authors?.length > 0 ? paper.authors : ['Unknown']
    const citeKey = generateCiteKey(authors, paper.year)
    const doi = (paper.doi ?? '').trim() || `unknown:${citeKey}`
    const now = new Date().toISOString()
    const id = randomUUID()

    // Match subtopic
    const matchedSubTopic = subTopics.find(st =>
      paper.relevanceJustification?.toLowerCase().includes(st.name.toLowerCase())
    )?.name

    const artifact = {
      id,
      type: 'paper',
      title: paper.title,
      authors,
      abstract: paper.abstract ?? '',
      citeKey,
      doi,
      bibtex: `@article{${citeKey},\n  title = {${paper.title}},\n  author = {${authors.join(' and ')}},${paper.year ? `\n  year = {${paper.year}},` : ''}${paper.venue ? `\n  journal = {${paper.venue}},` : ''}${doi ? `\n  doi = {${doi}},` : ''}${paper.url ? `\n  url = {${paper.url}},` : ''}\n}`,
      year: paper.year ?? undefined,
      venue: paper.venue ?? undefined,
      url: paper.url ?? undefined,
      tags: [],
      provenance: {
        source: 'agent',
        sessionId: 'backfill',
        agentId: 'literature-team',
        extractedFrom: 'agent-response'
      },
      createdAt: now,
      updatedAt: now,
      externalSource: paper.source,
      relevanceScore: paper.relevanceScore,
      citationCount: paper.citationCount ?? undefined,
      relevanceJustification: paper.relevanceJustification,
      subTopic: matchedSubTopic,
      addedInRound: roundLabel,
      addedByTask: 'deep_literature_study',
      identityConfidence: paper.doi ? 'high' : 'medium',
      semanticScholarId: paper.source === 'semantic_scholar' ? paper.id : undefined,
      arxivId: paper.source === 'arxiv' ? paper.id : undefined,
    }

    // Remove undefined keys for clean JSON
    for (const [k, v] of Object.entries(artifact)) {
      if (v === undefined) delete artifact[k]
    }

    const filePath = join(papersDir, `${id}.json`)
    writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf-8')

    // Track for dedup within this run
    existingPapers.push(artifact)
    saved++
    console.log(`  + ${paper.title.slice(0, 80)}  (score: ${paper.relevanceScore})`)
  }
}

console.log(`\nDone: ${saved} papers saved, ${skippedDup} duplicates skipped, ${skippedScore} below threshold (< ${AUTO_SAVE_THRESHOLD})`)
