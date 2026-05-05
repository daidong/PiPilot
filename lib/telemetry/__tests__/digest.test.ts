import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpanKind, context, trace } from '@opentelemetry/api'
import { PipilotTracer } from '../tracer.js'
import { PATHS } from '../../types.js'
import { TRACE_POLICY_VERSION } from '../semantic-registry.js'

test('digest row materializes when invoke_agent root span ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-digest-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'PROJ',
    sessionId: 'SESS'
  })
  try {
    // Root invoke_agent span with one chat child.
    const rootSpan = t.startSpan('invoke_agent test-model', SpanKind.INTERNAL)
    rootSpan.setAttribute('gen_ai.operation.name', 'invoke_agent')
    rootSpan.setAttribute('gen_ai.request.model', 'test-model')

    const ctxWithRoot = trace.setSpan(context.active(), rootSpan)
    await context.with(ctxWithRoot, async () => {
      const child = t.rawTracer().startSpan('chat test-model', { kind: SpanKind.CLIENT })
      child.setAttribute('gen_ai.operation.name', 'chat')
      child.setAttribute('gen_ai.usage.input_tokens', 100)
      child.setAttribute('gen_ai.usage.output_tokens', 50)
      child.end()

      const tool = t.rawTracer().startSpan('execute_tool web_search', { kind: SpanKind.INTERNAL })
      tool.setAttribute('gen_ai.operation.name', 'execute_tool')
      tool.setAttribute('pipilot.tool.category', 'web')
      tool.end()
    })
    rootSpan.end()

    await t.shutdown()
    // Digest writer is async append; allow a tick.
    await new Promise((r) => setTimeout(r, 100))

    const digestFile = join(dir, PATHS.traceDigest)
    assert.ok(existsSync(digestFile), 'digest file created')
    const lines = readFileSync(digestFile, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    const row = JSON.parse(lines[0]!)
    assert.match(row.traceId, /^[0-9a-f]{32}$/)
    assert.equal(row.sessionId, 'SESS')
    assert.equal(row.projectId, 'PROJ')
    assert.equal(row.tokens.input, 100)
    assert.equal(row.tokens.output, 50)
    assert.equal(row.toolCallsByCategory.web, 1)
    assert.equal(row.tracePolicyVersion, TRACE_POLICY_VERSION)
    assert.match(row.startedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(row.endedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('digest covers multiple chat spans in a trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-digest-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  try {
    const rootSpan = t.startSpan('invoke_agent m', SpanKind.INTERNAL)
    rootSpan.setAttribute('gen_ai.operation.name', 'invoke_agent')
    const rctx = trace.setSpan(context.active(), rootSpan)
    await context.with(rctx, async () => {
      for (let i = 0; i < 3; i++) {
        const c = t.rawTracer().startSpan(`chat m-${i}`, { kind: SpanKind.CLIENT })
        c.setAttribute('gen_ai.operation.name', 'chat')
        c.setAttribute('gen_ai.usage.input_tokens', 10)
        c.setAttribute('gen_ai.usage.output_tokens', 20)
        c.end()
      }
    })
    rootSpan.end()
    await t.shutdown()
    await new Promise((r) => setTimeout(r, 100))
    const row = JSON.parse(readFileSync(join(dir, PATHS.traceDigest), 'utf8').trim().split('\n')[0]!)
    assert.equal(row.tokens.input, 30)
    assert.equal(row.tokens.output, 60)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
