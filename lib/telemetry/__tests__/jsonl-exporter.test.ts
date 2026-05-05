import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExportResultCode } from '@opentelemetry/core'
import { NodeTracerProvider, InMemorySpanExporter, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { trace, SpanKind } from '@opentelemetry/api'
import { JsonlSpanExporter } from '../exporters/jsonl.js'
import { SCHEMA_URL } from '../semantic-registry.js'
import { PATHS } from '../../types.js'

function makeProvider(projectPath: string) {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      'service.name': 'research-copilot',
      'service.version': '0.0.0-test',
      'pipilot.runtime.app_build_commit': 'test-commit'
    })
  })
  const exporter = new JsonlSpanExporter({ projectPath })
  // SimpleSpanProcessor would be cleaner; use BatchSpanProcessor with very small
  // settings so flush happens fast.
  const proc = new BatchSpanProcessor(exporter, {
    scheduledDelayMillis: 10,
    maxExportBatchSize: 8,
    maxQueueSize: 64
  })
  provider.addSpanProcessor(proc)
  provider.register()
  return { provider, exporter, proc }
}

test('exports a span as OTLP/JSON ResourceSpans envelope to dated file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-jsonl-'))
  const { provider, exporter } = makeProvider(dir)
  try {
    const tracer = trace.getTracer('test-tracer', '1.0.0', { schemaUrl: SCHEMA_URL })
    const span = tracer.startSpan('chat test-model', { kind: SpanKind.CLIENT })
    span.setAttribute('gen_ai.provider.name', 'anthropic')
    span.setAttribute('gen_ai.usage.input_tokens', 100)
    span.end()

    await provider.forceFlush()
    await new Promise((r) => setTimeout(r, 50))

    const today = new Date()
    const expected = exporter.spansFilePathFor(today)
    assert.ok(existsSync(expected), `spans file at ${expected}`)
    const content = readFileSync(expected, 'utf8')
    assert.match(content, /\n$/, 'ends with \\n')
    const lines = content.trim().split('\n')
    assert.ok(lines.length >= 1)
    const env = JSON.parse(lines[0]!)
    assert.equal(env.schemaUrl, SCHEMA_URL)
    assert.ok(Array.isArray(env.resource.attributes))
    assert.ok(Array.isArray(env.scopeSpans))
    const scope = env.scopeSpans[0]
    assert.equal(scope.scope.name, 'test-tracer')
    assert.equal(scope.scope.version, '1.0.0')
    assert.equal(scope.schemaUrl, SCHEMA_URL)
    const otlpSpan = scope.spans[0]
    assert.equal(otlpSpan.name, 'chat test-model')
    assert.equal(otlpSpan.kind, SpanKind.CLIENT)
    assert.match(otlpSpan.traceId, /^[0-9a-f]{32}$/)
    assert.match(otlpSpan.spanId, /^[0-9a-f]{16}$/)
    assert.match(otlpSpan.startTimeUnixNano, /^\d+$/)
    assert.ok(Array.isArray(otlpSpan.attributes))
    const providerAttr = otlpSpan.attributes.find((a: any) => a.key === 'gen_ai.provider.name')
    assert.equal(providerAttr.value.stringValue, 'anthropic')
    const tokAttr = otlpSpan.attributes.find((a: any) => a.key === 'gen_ai.usage.input_tokens')
    assert.equal(tokAttr.value.intValue, '100')
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shutdown blocks further exports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-jsonl-'))
  try {
    const exporter = new JsonlSpanExporter({ projectPath: dir })
    await exporter.shutdown()
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([], (r) => resolve(r as any))
    })
    assert.equal(result.code, ExportResultCode.FAILED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes traces under PATHS.traces inside project root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-jsonl-'))
  try {
    const exporter = new JsonlSpanExporter({ projectPath: dir })
    const target = exporter.spansFilePathFor(new Date('2026-05-05T12:34:56Z'))
    assert.equal(target, join(dir, PATHS.traces, 'spans.2026-05-05.jsonl'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
