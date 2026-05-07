/**
 * Tests for memory-tools → memory-ledger plumbing (G1).
 *
 * Verifies that save-memory and delete-memory tool execute paths actually
 * write rows to .research-pilot/memory-v2/ledger.jsonl, with the right op,
 * type, scope, and turnId. The ledger writer was defined long before but
 * had no production caller until this fix.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSaveMemoryTool, createDeleteMemoryTool } from '../memory-tools.js'
import { PATHS } from '../../types.js'
import type { AgentTool } from '@mariozechner/pi-agent-core'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-mem-ledger-'))
}

function readLedger(project: string): Array<Record<string, unknown>> {
  const file = join(project, PATHS.ledgerMemory)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
}

async function waitForRows(project: string, expected: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const rows = readLedger(project)
    if (rows.length >= expected) return rows
    await new Promise(r => setTimeout(r, 20))
  }
  return readLedger(project)
}

async function runSave(tool: AgentTool, params: Record<string, unknown>): Promise<void> {
  // pi's AgentTool.execute signature: (toolCallId, params, signal?, onUpdate?)
  await tool.execute('tc-test', params)
}

test('save-memory: ledger row carries op=create + scope=project + turnId', async () => {
  const project = tmpProject()
  try {
    const tool = createSaveMemoryTool(project, () => 'turn-A')
    await runSave(tool, { type: 'user', name: 'foo', content: 'hello world' })
    const rows = await waitForRows(project, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].op, 'create')
    assert.equal(rows[0].scope, 'project')
    assert.equal(rows[0].type, 'user')
    assert.equal(rows[0].turnId, 'turn-A')
    assert.match(String(rows[0].memoryId), /\.md$/, 'memoryId is a markdown filename')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('save-memory: overwriting same name+type → op=update on second row', async () => {
  const project = tmpProject()
  try {
    const tool = createSaveMemoryTool(project, () => 'turn-B')
    await runSave(tool, { type: 'feedback', name: 'tone', content: 'be brief' })
    await waitForRows(project, 1)
    await runSave(tool, { type: 'feedback', name: 'tone', content: 'be brief and direct' })
    const rows = await waitForRows(project, 2)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].op, 'create')
    assert.equal(rows[1].op, 'update')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('delete-memory: ledger row op=delete with turnId from accessor', async () => {
  const project = tmpProject()
  try {
    const save = createSaveMemoryTool(project, () => 'turn-create')
    await runSave(save, { type: 'project', name: 'goal', content: 'finish paper by Friday' })
    await waitForRows(project, 1)

    const del = createDeleteMemoryTool(project, () => 'turn-delete')
    await runSave(del, { name: 'goal', type: 'project' })
    const rows = await waitForRows(project, 2)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].op, 'delete')
    assert.equal(rows[1].turnId, 'turn-delete')
    assert.equal(rows[1].type, 'project')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('save-memory: missing getTurnId → ledger row has no turnId field', async () => {
  const project = tmpProject()
  try {
    const tool = createSaveMemoryTool(project) // no getTurnId
    await runSave(tool, { type: 'reference', name: 'doi', content: 'https://doi.org/...' })
    const rows = await waitForRows(project, 1)
    assert.equal(rows.length, 1)
    // Writer strips undefined for tidiness — key must be absent.
    assert.equal('turnId' in rows[0], false)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('save-memory + delete-memory: provenance.source is "tool-output"', async () => {
  const project = tmpProject()
  try {
    const save = createSaveMemoryTool(project, () => 'turn-X')
    await runSave(save, { type: 'user', name: 'name', content: 'Captain' })
    await waitForRows(project, 1)
    const del = createDeleteMemoryTool(project, () => 'turn-Y')
    await runSave(del, { name: 'name' })
    const rows = await waitForRows(project, 2)
    for (const r of rows) {
      assert.deepEqual(r.provenance, { source: 'tool-output' })
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
