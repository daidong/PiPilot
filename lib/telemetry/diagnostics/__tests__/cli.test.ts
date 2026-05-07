/**
 * Smoke tests for the diagnostics CLI (P3.8).
 *
 * Builds a temp project, writes synthetic spans.{date}.jsonl, runs the CLI
 * via child_process, asserts exit code + JSON shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..', '..')
const cliPath = join(repoRoot, 'bin', 'diagnostics.mjs')

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-cli-'))
  mkdirSync(join(dir, '.research-pilot/traces'), { recursive: true })
  return dir
}

function writeSyntheticTrace(projectPath: string, traceId: string): void {
  const stamp = new Date().toISOString().slice(0, 10)
  const file = join(projectPath, '.research-pilot/traces', `spans.${stamp}.jsonl`)
  // Two chats: second hits cache_miss (no cache_read despite same parent).
  const env = {
    schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
    resource: {
      attributes: [{ key: 'service.name', value: { stringValue: 'research-copilot' } }]
    },
    scopeSpans: [
      {
        scope: { name: 'pipilot' },
        schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
        spans: [
          {
            traceId,
            spanId: 'aaaaaaaaaaaaaaa1',
            name: 'invoke_agent test-model',
            kind: 1,
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '5000000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-7' } }
            ],
            events: [],
            status: { code: 0 },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
            links: []
          },
          {
            traceId,
            spanId: 'bbbbbbbbbbbbbbb1',
            parentSpanId: 'aaaaaaaaaaaaaaa1',
            name: 'chat claude-opus-4-7',
            kind: 3,
            startTimeUnixNano: '1100000000',
            endTimeUnixNano: '1200000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-7' } },
              { key: 'gen_ai.usage.input_tokens', value: { intValue: '5000' } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: '500' } },
              { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '4000' } }
            ],
            events: [],
            status: { code: 0 },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
            links: []
          },
          {
            traceId,
            spanId: 'bbbbbbbbbbbbbbb2',
            parentSpanId: 'aaaaaaaaaaaaaaa1',
            name: 'chat claude-opus-4-7',
            kind: 3,
            startTimeUnixNano: '2100000000',
            endTimeUnixNano: '2200000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
              { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-7' } },
              // Same model + parent as bbbbbbbbbbbbbbb1 but cache_read=0 → cache_miss.
              { key: 'gen_ai.usage.input_tokens', value: { intValue: '6000' } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: '500' } },
              { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '0' } }
            ],
            events: [],
            status: { code: 0 },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
            links: []
          }
        ]
      }
    ]
  }
  writeFileSync(file, JSON.stringify(env) + '\n')
}

test('CLI: scan mode returns JSON with findings', () => {
  const dir = makeProject()
  try {
    const traceId = '0123456789abcdef0123456789abcdef'
    writeSyntheticTrace(dir, traceId)
    const r = spawnSync('node', [cliPath, dir, '--json'], { encoding: 'utf8' })
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.traces, 1)
    assert.ok(Array.isArray(out.findings))
    assert.ok(out.findings.some((f: any) => f.ruleId === 'cache_miss'), 'cache_miss should fire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: single-trace mode returns detailed JSON', () => {
  const dir = makeProject()
  try {
    const traceId = '0123456789abcdef0123456789abcdef'
    writeSyntheticTrace(dir, traceId)
    const r = spawnSync('node', [cliPath, dir, traceId, '--json'], { encoding: 'utf8' })
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.traceId, traceId)
    assert.ok(Array.isArray(out.findings))
    assert.ok(out.findings.some((f: any) => f.ruleId === 'cache_miss'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: --rule filter narrows findings', () => {
  const dir = makeProject()
  try {
    const traceId = '0123456789abcdef0123456789abcdef'
    writeSyntheticTrace(dir, traceId)
    const r = spawnSync('node', [cliPath, dir, '--json', '--rule', 'prefill_explosion'], { encoding: 'utf8' })
    assert.equal(r.status, 0, `CLI failed: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    // No prefill explosion in our synthetic input; filter should produce empty findings.
    assert.equal(out.findings.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: missing project path exits with usage error', () => {
  const r = spawnSync('node', [cliPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Usage:/)
})

test('CLI: nonexistent project path exits with error', () => {
  const r = spawnSync('node', [cliPath, '/nope/totally/missing/project'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /does not exist/)
})

test('CLI: empty project (no traces) returns 0 traces JSON cleanly', () => {
  const dir = makeProject()
  try {
    const r = spawnSync('node', [cliPath, dir, '--json'], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.traces, 0)
    assert.deepEqual(out.findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
