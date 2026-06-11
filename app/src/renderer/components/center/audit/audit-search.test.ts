import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AuditGraph, GraphNode } from '../../../../../../lib/audit-graph/index'
import { searchAuditGraph } from './audit-search'

function n(id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, label: id, ...extra }
}

const graph: AuditGraph = {
  builtAt: 'now',
  source: 'test',
  counts: { nodes: 0, edges: 0, spans: 1, traces: 1, artifacts: 0 },
  nodes: [
    n('span:tool-1', 'tool', {
      label: 'data-analyze',
      toolName: 'data-analyze',
      rawEvents: [
        { name: 'pipilot.tool.args', body: JSON.stringify({ path: 'input.csv', operation: 'mean' }) },
        { name: 'pipilot.tool.result', body: 'The measured mean is 4.2 for cohort A.' },
      ],
    }),
    n('span:step-1', 'step', {
      label: 'step 1',
      rawEvents: [
        { name: 'pipilot.chat.response_text', body: 'Updated results.md with Mean 4.2.' },
      ],
    }),
  ],
  edges: [],
}

test('searchAuditGraph finds provenance input and output raw events', () => {
  const input = searchAuditGraph(graph, 'input.csv', false)
  assert.equal(input.length, 1)
  assert.equal(input[0].nodeId, 'span:tool-1')
  assert.equal(input[0].field, 'tool input')

  const output = searchAuditGraph(graph, 'cohort A', false)
  assert.equal(output.length, 1)
  assert.equal(output[0].field, 'tool output')
  assert.match(output[0].excerpt, /measured mean/)
})

test('searchAuditGraph defaults to case-insensitive and supports case-sensitive mode', () => {
  assert.equal(searchAuditGraph(graph, 'updated', false).length, 1)
  assert.equal(searchAuditGraph(graph, 'updated', true).length, 0)
  assert.equal(searchAuditGraph(graph, 'Updated', true).length, 1)
})
