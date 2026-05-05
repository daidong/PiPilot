import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpanKind } from '@opentelemetry/api'
import { PipilotTracer } from '../tracer.js'
import { PATHS } from '../../types.js'

function mkTracer(extra: Partial<ConstructorParameters<typeof PipilotTracer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tracer-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'test-commit',
    projectId: 'PROJ-X',
    sessionId: 'SESS-Y',
    ...extra
  })
  return { dir, t }
}

test('startSpan stamps project-scoped attributes', async () => {
  const { dir, t } = mkTracer({ projectTag: 'experiment-a', agentProfile: 'main' })
  try {
    const span = t.startSpan('chat foo', SpanKind.CLIENT)
    span.end()
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const span0 = env.scopeSpans[0].spans[0]
    const findAttr = (k: string) => span0.attributes.find((a: any) => a.key === k)?.value
    assert.equal(findAttr('pipilot.project.id').stringValue, 'PROJ-X')
    assert.equal(findAttr('gen_ai.conversation.id').stringValue, 'SESS-Y')
    assert.equal(findAttr('pipilot.project.tag').stringValue, 'experiment-a')
    assert.equal(findAttr('pipilot.runtime.agent_profile').stringValue, 'main')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Resource attributes carry process/build identity only (no project state)', async () => {
  const { dir, t } = mkTracer()
  try {
    const span = t.startSpan('foo')
    span.end()
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const resourceKeys = (env.resource.attributes as Array<{ key: string }>).map((a) => a.key)
    // Resource MUST contain process/build identity:
    for (const k of [
      'service.name',
      'service.version',
      'service.instance.id',
      'process.runtime.name',
      'process.runtime.version',
      'os.type',
      'pipilot.runtime.app_build_commit'
    ]) {
      assert.ok(resourceKeys.includes(k), `Resource has ${k}`)
    }
    // Resource MUST NOT contain per-project state:
    for (const k of ['pipilot.project.id', 'gen_ai.conversation.id', 'pipilot.runtime.full_prompt_hash']) {
      assert.equal(resourceKeys.includes(k), false, `Resource does NOT have ${k}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withProjectScope overrides default scope for spans inside the callback', async () => {
  const { dir, t } = mkTracer()
  try {
    t.withProjectScope({ projectId: 'OVERRIDE-Z', sessionId: 'SESS-ALT' }, () => {
      const span = t.startSpan('inner')
      span.end()
    })
    // Outside the scope, default applies.
    const outer = t.startSpan('outer')
    outer.end()

    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const spans: Array<{ name: string; attributes: Array<{ key: string; value: any }> }> = env.scopeSpans[0].spans
    const inner = spans.find((s) => s.name === 'inner')!
    const outerSpan = spans.find((s) => s.name === 'outer')!
    const proj = (s: typeof inner) => s.attributes.find((a) => a.key === 'pipilot.project.id')?.value.stringValue
    assert.equal(proj(inner), 'OVERRIDE-Z')
    assert.equal(proj(outerSpan), 'PROJ-X')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runInSpan ends span on success', async () => {
  const { dir, t } = mkTracer()
  try {
    const result = await t.runInSpan('async-op', SpanKind.INTERNAL, async (s) => {
      s.setAttribute('user.attr', 'ok')
      return 42
    })
    assert.equal(result, 42)
    await t.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runInSpan ends span on thrown error and rethrows', async () => {
  const { dir, t } = mkTracer()
  try {
    await assert.rejects(
      t.runInSpan('failing', SpanKind.INTERNAL, async () => {
        throw new Error('boom')
      }),
      /boom/
    )
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const span0 = env.scopeSpans[0].spans[0]
    assert.equal(span0.status.code, 2, 'span ERROR status')
    assert.match(span0.status.message ?? '', /boom/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
