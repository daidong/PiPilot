/**
 * Diagnostics public surface (P3).
 *
 * Usage:
 *   import { runDiagnostics, BUILTIN_RULES, loadTraceForDiagnostics } from '@research-pilot/telemetry/diagnostics'
 *   const trace = loadTraceForDiagnostics(projectPath, traceId)
 *   if (!trace) return
 *   const findings = runDiagnostics(trace.spans, BUILTIN_RULES, { traceId })
 */

export { runDiagnostics, buildBaseline, groupByTrace, quantile } from './engine.js'
export type { Finding, RegisteredRule, Rule, RuleContext, Severity, TraceBaseline } from './engine.js'

export {
  BUILTIN_RULES,
  prefillExplosionRule,
  slowToolTailRule,
  repeatedWorkRule,
  sequentialDependencyRule,
  cacheMissRule
} from './rules.js'

export { loadTraceForDiagnostics, loadTraceCorpus } from './load.js'
export type { LoadedTrace } from './load.js'
