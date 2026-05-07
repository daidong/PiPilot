/**
 * Diagnostics CLI implementation (P3.8 — runs under tsx via bin/diagnostics.mjs).
 *
 * Two modes:
 *   <projectPath>           — scan the last N days, summary by rule
 *   <projectPath> <traceId> — detailed per-finding for one trace
 *
 * Flags:
 *   --json
 *   --days N
 *   --rule R
 */

import { existsSync } from 'node:fs'
import { runDiagnostics, buildBaseline, groupByTrace } from './engine.js'
import { BUILTIN_RULES } from './rules.js'
import { loadTraceForDiagnostics, loadTraceCorpus } from './load.js'
import type { Finding, Severity } from './engine.js'

interface CliArgs {
  projectPath: string
  traceId: string | null
  json: boolean
  days: number
  ruleFilter: string | null
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  if (argv.length === 0) {
    return { error: 'Usage: diagnostics <projectPath> [traceId] [--json] [--days N] [--rule ID]' }
  }
  const positional: string[] = []
  let json = false
  let days: number | null = null
  let ruleFilter: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') json = true
    else if (arg === '--days') {
      const next = argv[++i]
      const n = next ? Number.parseInt(next, 10) : Number.NaN
      if (!Number.isFinite(n) || n < 1 || n > 365) return { error: '--days must be between 1 and 365' }
      days = n
    } else if (arg === '--rule') {
      const next = argv[++i]
      if (!next) return { error: '--rule requires an id' }
      ruleFilter = next
    } else if (arg.startsWith('--')) {
      return { error: `Unknown flag: ${arg}` }
    } else {
      positional.push(arg)
    }
  }
  if (positional.length === 0) return { error: 'projectPath is required' }
  if (positional.length > 2) return { error: 'too many positional arguments' }
  const [projectPath, traceId = null] = positional
  if (!existsSync(projectPath!)) return { error: `projectPath does not exist: ${projectPath}` }
  return {
    projectPath: projectPath!,
    traceId,
    json,
    days: days ?? (traceId ? 7 : 1),
    ruleFilter
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

function severityColor(sev: Severity): string {
  if (process.stdout.isTTY) {
    if (sev === 'error') return `\x1b[31m${sev.toUpperCase()}\x1b[0m`
    if (sev === 'warn') return `\x1b[33m${sev.toUpperCase()}\x1b[0m`
    return `\x1b[36m${sev.toUpperCase()}\x1b[0m`
  }
  return sev.toUpperCase()
}

function applyFilter(findings: Finding[], ruleFilter: string | null): Finding[] {
  if (!ruleFilter) return findings
  return findings.filter((f) => f.ruleId === ruleFilter || f.ruleId.startsWith(ruleFilter + '.'))
}

function runForSingleTrace(args: CliArgs): number {
  const trace = loadTraceForDiagnostics(args.projectPath, args.traceId!, args.days)
  if (!trace) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ traceId: args.traceId, error: 'trace not found or tombstoned' }) + '\n')
    } else {
      console.error(`No trace found for id ${args.traceId} in the last ${args.days} day(s).`)
      console.error('(Tombstoned traces are excluded — the partial spans on disk would mislead diagnostics.)')
    }
    return 2
  }
  // Baseline from the corpus to power slow-tool-tail rule.
  const corpus = loadTraceCorpus(args.projectPath, args.days)
  const baseline = buildBaseline(corpus.allSpans)
  const findings = applyFilter(
    runDiagnostics(trace.spans, BUILTIN_RULES, { traceId: trace.traceId, baseline }),
    args.ruleFilter
  )
  if (args.json) {
    process.stdout.write(JSON.stringify({ traceId: trace.traceId, findings }, null, 2) + '\n')
    return findings.some((f) => f.severity === 'error') ? 1 : 0
  }
  console.log(`Trace ${trace.traceId} — ${trace.spans.length} spans, ${findings.length} finding(s)`)
  if (findings.length === 0) {
    console.log('  ✓ no issues detected')
    return 0
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  for (const f of findings) {
    console.log(`  [${severityColor(f.severity)}] ${f.ruleId}: ${f.summary}`)
    if (f.spanIds.length > 0 && f.spanIds.length <= 5) {
      console.log(`         spans: ${f.spanIds.join(', ')}`)
    } else if (f.spanIds.length > 5) {
      console.log(`         spans: ${f.spanIds.slice(0, 3).join(', ')} … (+${f.spanIds.length - 3} more)`)
    }
  }
  return findings.some((f) => f.severity === 'error') ? 1 : 0
}

function runForCorpus(args: CliArgs): number {
  const corpus = loadTraceCorpus(args.projectPath, args.days)
  if (corpus.spansByTrace.size === 0) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ traces: 0, findings: [] }) + '\n')
    } else {
      console.log(`No traces found in ${args.projectPath} for the last ${args.days} day(s).`)
    }
    return 0
  }
  const baseline = buildBaseline(corpus.allSpans)
  const allFindings: Array<Finding & { traceId: string }> = []
  for (const [traceId, spans] of corpus.spansByTrace) {
    for (const f of runDiagnostics(spans, BUILTIN_RULES, { traceId, baseline })) {
      allFindings.push({ ...f, traceId })
    }
  }
  const filtered = applyFilter(allFindings, args.ruleFilter) as Array<Finding & { traceId: string }>
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          traces: corpus.spansByTrace.size,
          spans: corpus.allSpans.length,
          baseline,
          findings: filtered
        },
        null,
        2
      ) + '\n'
    )
    return filtered.some((f) => f.severity === 'error') ? 1 : 0
  }
  // Group by ruleId for the summary view.
  const byRule = new Map<string, Array<Finding & { traceId: string }>>()
  for (const f of filtered) {
    let bucket = byRule.get(f.ruleId)
    if (!bucket) {
      bucket = []
      byRule.set(f.ruleId, bucket)
    }
    bucket.push(f)
  }
  console.log(
    `Scanned ${corpus.spansByTrace.size} trace(s), ${corpus.allSpans.length} span(s) over the last ${args.days} day(s).`
  )
  if (filtered.length === 0) {
    console.log('  ✓ no issues detected')
    return 0
  }
  for (const [ruleId, group] of byRule) {
    const sev = group[0]!.severity
    const distinctTraces = new Set(group.map((f) => f.traceId)).size
    console.log(
      `  [${severityColor(sev)}] ${ruleId}: ${group.length} finding(s) across ${distinctTraces} trace(s)`
    )
    for (const f of group.slice(0, 3)) {
      console.log(`      • trace ${f.traceId.slice(0, 8)}…  ${f.summary}`)
    }
    if (group.length > 3) {
      console.log(`      • … (+${group.length - 3} more — re-run with --json or --rule ${ruleId} to see all)`)
    }
  }
  void groupByTrace
  return filtered.some((f) => f.severity === 'error') ? 1 : 0
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(parsed.error)
    return 64 // EX_USAGE
  }
  if (parsed.traceId) return runForSingleTrace(parsed)
  return runForCorpus(parsed)
}

process.exit(main())
