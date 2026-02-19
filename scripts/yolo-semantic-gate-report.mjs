#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { glob } from 'glob'

function toNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pct(part, total) {
  if (total <= 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function sortByTurnPath(a, b) {
  const aMatch = a.match(/turn-(\d{4,})/)
  const bMatch = b.match(/turn-(\d{4,})/)
  const aNum = aMatch ? Number(aMatch[1]) : 0
  const bNum = bMatch ? Number(bMatch[1]) : 0
  return aNum - bNum
}

function printUsage() {
  console.log('Usage: node scripts/yolo-semantic-gate-report.mjs [project_root] [--json]')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    printUsage()
    return
  }

  const jsonMode = args.includes('--json')
  const rootArg = args.find((item) => !item.startsWith('-')) || '.'
  const projectRoot = path.resolve(process.cwd(), rootArg)

  const resultFiles = (await glob('runs/turn-*/result.json', {
    cwd: projectRoot,
    absolute: true,
    nodir: true
  })).sort(sortByTurnPath)

  const stats = {
    projectRoot,
    scannedTurns: resultFiles.length,
    parsedResults: 0,
    withSemanticGate: 0,
    noDeltaMissingPlanTouch: 0,
    semanticEligible: 0,
    semanticInvoked: 0,
    semanticAccepted: 0,
    semanticShadowPotentialCorrections: 0,
    rejectReasons: {},
    modeCounts: {},
    outputVerdictCounts: {}
  }

  for (const filePath of resultFiles) {
    let parsed
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf-8'))
    } catch {
      continue
    }

    stats.parsedResults += 1

    if (parsed?.status === 'no_delta' && parsed?.blocked_reason === 'missing_plan_deliverable_touch') {
      stats.noDeltaMissingPlanTouch += 1
    }

    const semantic = parsed?.semantic_gate
    if (!semantic || typeof semantic !== 'object') continue

    stats.withSemanticGate += 1
    if (semantic.eligible === true) stats.semanticEligible += 1
    if (semantic.invoked === true) stats.semanticInvoked += 1
    if (semantic.accepted === true) stats.semanticAccepted += 1

    const mode = typeof semantic.mode === 'string' ? semantic.mode : 'unknown'
    stats.modeCounts[mode] = toNumber(stats.modeCounts[mode]) + 1

    const outputVerdict = typeof semantic.output?.verdict === 'string' ? semantic.output.verdict : 'unknown'
    stats.outputVerdictCounts[outputVerdict] = toNumber(stats.outputVerdictCounts[outputVerdict]) + 1

    const rejectReason = typeof semantic.reject_reason === 'string' ? semantic.reject_reason : ''
    if (rejectReason) {
      stats.rejectReasons[rejectReason] = toNumber(stats.rejectReasons[rejectReason]) + 1
    }

    const shadowPotential = (
      mode === 'shadow'
      && rejectReason === 'shadow_mode'
      && outputVerdict === 'touched'
    )
    if (shadowPotential) {
      stats.semanticShadowPotentialCorrections += 1
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(stats, null, 2))
    return
  }

  const rejectReasonLines = Object.entries(stats.rejectReasons)
    .sort((a, b) => toNumber(b[1]) - toNumber(a[1]))
    .map(([reason, count]) => `  - ${reason}: ${count}`)

  console.log('Semantic Gate Report')
  console.log(`Project: ${stats.projectRoot}`)
  console.log(`Turns scanned: ${stats.scannedTurns}`)
  console.log(`Result files parsed: ${stats.parsedResults}`)
  console.log(`Results with semantic_gate block: ${stats.withSemanticGate}`)
  console.log(`no_delta + missing_plan_deliverable_touch: ${stats.noDeltaMissingPlanTouch}`)
  console.log(`Eligible: ${stats.semanticEligible} (${pct(stats.semanticEligible, stats.withSemanticGate)})`)
  console.log(`Invoked: ${stats.semanticInvoked} (${pct(stats.semanticInvoked, stats.withSemanticGate)})`)
  console.log(`Accepted: ${stats.semanticAccepted} (${pct(stats.semanticAccepted, stats.semanticInvoked)})`)
  console.log(`Shadow potential corrections: ${stats.semanticShadowPotentialCorrections}`)

  const modes = Object.entries(stats.modeCounts)
    .sort((a, b) => toNumber(b[1]) - toNumber(a[1]))
    .map(([mode, count]) => `${mode}:${count}`)
  const verdicts = Object.entries(stats.outputVerdictCounts)
    .sort((a, b) => toNumber(b[1]) - toNumber(a[1]))
    .map(([verdict, count]) => `${verdict}:${count}`)

  console.log(`Modes: ${modes.join(', ') || 'n/a'}`)
  console.log(`Output verdicts: ${verdicts.join(', ') || 'n/a'}`)
  console.log('Reject reasons:')
  if (rejectReasonLines.length === 0) {
    console.log('  - none')
  } else {
    for (const line of rejectReasonLines) console.log(line)
  }
}

main().catch((error) => {
  console.error(`Failed to build semantic gate report: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
