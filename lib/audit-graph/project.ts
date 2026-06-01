/**
 * Project the on-disk telemetry of a Research Copilot project into a
 * provenance graph for the Audit tab.
 *
 * This is a pure derivation — nothing is written back. The same data is
 * still authoritative on disk under the schema in
 * docs/spec/telemetry-trace.md (v0.11). The projection just adds an index.
 *
 * Performance: synchronous reads on a JSONL ring-queue produce a graph in
 * tens of ms for a 1k-span project. The OTLP parser is permissive (drops
 * malformed lines rather than throwing) so a partially-written trace file
 * during a live session can't break the Audit tab.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { PATHS } from '../types.js'
import type { Artifact, PaperArtifact } from '../types.js'
import { getArtifacts } from '../memory-v2/indexer.js'
import { extractCitations, resolveCitations, toCanonicalDoi, toCanonicalUrl } from './citations.js'
import type {
  AuditGraph,
  EdgeRel,
  GraphEdge,
  GraphNode,
  NodeKind,
} from './types.js'

// —— OTLP/JSON minimal shape ————————————————————————————————————————————

interface OtlpAttrValue {
  stringValue?: string
  intValue?: string | number
  boolValue?: boolean
  arrayValue?: { values?: Array<{ stringValue?: string; intValue?: string | number; boolValue?: boolean }> }
}
interface OtlpKV { key: string; value: OtlpAttrValue }
interface OtlpEvent { name?: string; timeUnixNano?: string; attributes?: OtlpKV[] }
interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: OtlpKV[]
  events?: OtlpEvent[]
  links?: Array<{ traceId?: string; spanId?: string; attributes?: OtlpKV[] }>
}

interface InternalSpan {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startNs: string
  endNs: string
  attrs: Record<string, string | number | boolean | unknown>
  events: { name: string; timeNs?: string; attrs: Record<string, string | number | boolean | unknown> }[]
}

function attrMap(attrs: OtlpKV[] | undefined): Record<string, string | number | boolean | unknown> {
  const out: Record<string, string | number | boolean | unknown> = {}
  if (!attrs) return out
  for (const a of attrs) {
    const v = a.value
    if (v.stringValue !== undefined) out[a.key] = v.stringValue
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue)
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue
    else if (v.arrayValue?.values) out[a.key] = v.arrayValue.values.map(x => x.stringValue ?? x.intValue ?? x.boolValue)
  }
  return out
}

// —— Telemetry presence check ——————————————————————————————————————————

export interface TelemetryPresence {
  present: boolean
  reason?: 'no-root' | 'no-traces-dir' | 'no-span-files' | 'no-spans'
  spanFileCount: number
}

/** Quick presence check — used by the Audit tab to decide whether to render
 *  the visualization or the empty state. Cheap: just `readdir`. */
export async function checkTelemetryPresence(projectPath: string): Promise<TelemetryPresence> {
  const root = path.join(projectPath, PATHS.root)
  if (!(await exists(root))) return { present: false, reason: 'no-root', spanFileCount: 0 }
  const tracesDir = path.join(projectPath, PATHS.traces)
  if (!(await exists(tracesDir))) return { present: false, reason: 'no-traces-dir', spanFileCount: 0 }
  let files: string[]
  try { files = await fs.readdir(tracesDir) } catch { return { present: false, reason: 'no-traces-dir', spanFileCount: 0 } }
  const spanFiles = files.filter(f => f.startsWith('spans.') && f.endsWith('.jsonl'))
  if (spanFiles.length === 0) return { present: false, reason: 'no-span-files', spanFileCount: 0 }
  // Cheap: count bytes across files; if all are empty there are no spans.
  let totalSize = 0
  for (const f of spanFiles) {
    try { totalSize += (await fs.stat(path.join(tracesDir, f))).size } catch { /* ignore */ }
  }
  if (totalSize === 0) return { present: false, reason: 'no-spans', spanFileCount: spanFiles.length }
  return { present: true, spanFileCount: spanFiles.length }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

async function readJsonlIfExists<T>(filePath: string): Promise<T[]> {
  if (!(await exists(filePath))) return []
  const txt = await fs.readFile(filePath, 'utf8')
  const out: T[] = []
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* skip malformed lines */ }
  }
  return out
}

// —— Main projector —————————————————————————————————————————————————————

export async function projectGraph(projectPath: string): Promise<AuditGraph> {
  // 1. Load all spans -------------------------------------------------------
  const tracesDir = path.join(projectPath, PATHS.traces)
  const spans: InternalSpan[] = []
  let spanFileNames: string[] = []
  try { spanFileNames = (await fs.readdir(tracesDir)).filter(f => f.startsWith('spans.') && f.endsWith('.jsonl')) } catch { /* leave empty */ }
  spanFileNames.sort()

  for (const f of spanFileNames) {
    const txt = await fs.readFile(path.join(tracesDir, f), 'utf8').catch(() => '')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      let doc: { scopeSpans?: Array<{ spans?: OtlpSpan[] }> }
      try { doc = JSON.parse(line) } catch { continue }
      for (const ss of doc.scopeSpans || []) {
        for (const sp of ss.spans || []) {
          spans.push({
            traceId: sp.traceId,
            spanId: sp.spanId,
            parentSpanId: sp.parentSpanId || null,
            name: sp.name,
            startNs: sp.startTimeUnixNano,
            endNs: sp.endTimeUnixNano,
            attrs: attrMap(sp.attributes),
            events: (sp.events || []).map(ev => ({ name: ev.name || '?', timeNs: ev.timeUnixNano, attrs: attrMap(ev.attributes) })),
          })
        }
      }
    }
  }

  // 2. Load artifact ledger and trace digest -------------------------------
  interface LedgerRow {
    artifactId: string
    version: number
    op: string
    type: string
    path: string
    contentHash: string
    versionBefore: string | null
    initiator?: string
    traceId?: string
    spanId?: string
    turnId?: string
    timestamp: string
  }
  const ledger = await readJsonlIfExists<LedgerRow>(path.join(projectPath, PATHS.ledgerArtifact))
  const ledgerByArtifact = new Map<string, LedgerRow[]>()
  for (const r of ledger) {
    const list = ledgerByArtifact.get(r.artifactId)
    if (list) list.push(r); else ledgerByArtifact.set(r.artifactId, [r])
  }

  interface DigestRow { traceId: string; sessionId?: string; [k: string]: unknown }
  const digest = await readJsonlIfExists<DigestRow>(path.join(projectPath, PATHS.traceDigest))
  const digestByTrace = new Map<string, DigestRow>(digest.map(d => [d.traceId, d]))

  // 3. Build nodes / edges --------------------------------------------------
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const addNode = (id: string, kind: NodeKind, label: string, data: Partial<GraphNode> = {}): GraphNode => {
    const existing = nodes.get(id)
    if (existing) return existing
    const n: GraphNode = { id, kind, label, ...data }
    nodes.set(id, n)
    return n
  }
  const addEdge = (source: string, target: string, rel: EdgeRel) => {
    if (!nodes.has(source) || !nodes.has(target)) return
    edges.push({ source, target, rel })
  }

  // Session + trace nodes
  const traceSet = new Set<string>(spans.map(s => s.traceId))
  const sessionsByTrace = new Map<string, string>()
  for (const sp of spans) {
    const sid = sp.attrs['gen_ai.conversation.id']
    if (typeof sid === 'string') sessionsByTrace.set(sp.traceId, sid)
  }
  const sessions = new Set([...sessionsByTrace.values()])
  for (const sid of sessions) addNode(`session:${sid}`, 'session', `session ${sid.slice(0, 8)}`, { sessionId: sid })
  for (const tid of traceSet) {
    const rootSpan = spans.find(s => s.traceId === tid && !s.parentSpanId)
    const sid = sessionsByTrace.get(tid)
    addNode(`trace:${tid}`, 'trace', rootSpan?.name || '(unrooted trace)', {
      traceId: tid,
      sessionId: sid,
      startNs: rootSpan?.startNs,
      rootSpanId: rootSpan?.spanId || null,
      digest: digestByTrace.get(tid),
    })
    if (sid) addEdge(`session:${sid}`, `trace:${tid}`, 'contains')
  }

  // Span nodes (steps / tools / chats)
  for (const sp of spans) {
    const isStep = sp.name === 'invoke_agent step'
    const isTool = sp.name.startsWith('execute_tool ')
    const isChat = sp.name.startsWith('chat ')
    const isAgent = sp.name.startsWith('invoke_agent ') && !isStep

    let kind: NodeKind
    let label: string
    if (isStep) { kind = 'step'; label = `step ${sp.attrs['pipilot.step.index'] ?? '?'}` }
    else if (isTool) { kind = 'tool'; label = String(sp.attrs['gen_ai.tool.name'] || sp.name.replace('execute_tool ', '')) }
    else if (isChat) { kind = 'chat'; label = sp.name.replace('chat ', '') }
    else if (isAgent) continue // trace node already captures this
    else { kind = 'span'; label = sp.name }

    const duration = (Number(sp.endNs) - Number(sp.startNs)) / 1e6
    addNode(`span:${sp.spanId}`, kind, label, {
      traceId: sp.traceId,
      spanId: sp.spanId,
      parentSpanId: sp.parentSpanId,
      startNs: sp.startNs,
      endNs: sp.endNs,
      durationMs: Number.isFinite(duration) ? duration : undefined,
      turnId: (sp.attrs['pipilot.turn.id'] as string) || null,
      stepIndex: (sp.attrs['pipilot.step.index'] as number | undefined) ?? null,
      toolName: (sp.attrs['gen_ai.tool.name'] as string) || null,
      toolCallId: (sp.attrs['gen_ai.tool.call.id'] as string) || null,
      toolCategory: (sp.attrs['pipilot.tool.category'] as string) || null,
      model: (sp.attrs['gen_ai.request.model'] as string) || null,
      inputTokens: (sp.attrs['gen_ai.usage.input_tokens'] as number | undefined) ?? null,
      outputTokens: (sp.attrs['gen_ai.usage.output_tokens'] as number | undefined) ?? null,
      cacheReadTokens: (sp.attrs['gen_ai.usage.cache_read.input_tokens'] as number | undefined) ?? null,
      isError: !!sp.attrs['pipilot.tool.error_class'],
      eventNames: sp.events.map(e => e.name),
      rawEvents: sp.events.map(e => ({ name: e.name, body: String(e.attrs.body ?? '').slice(0, 4000) })),
    })
    addEdge(`trace:${sp.traceId}`, `span:${sp.spanId}`, 'contains')
  }

  // Step ordering (precedes)
  const stepsByTrace = new Map<string, GraphNode[]>()
  for (const n of nodes.values()) {
    if (n.kind === 'step' && n.traceId) {
      const arr = stepsByTrace.get(n.traceId); if (arr) arr.push(n); else stepsByTrace.set(n.traceId, [n])
    }
  }
  for (const arr of stepsByTrace.values()) {
    arr.sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0))
    for (let i = 1; i < arr.length; i++) addEdge(arr[i - 1].id, arr[i].id, 'precedes')
  }

  // Tool ↔ step bidirectional (invokes + returns)
  const toolsByTrace = new Map<string, GraphNode[]>()
  for (const n of nodes.values()) {
    if (n.kind === 'tool' && n.traceId) {
      const arr = toolsByTrace.get(n.traceId); if (arr) arr.push(n); else toolsByTrace.set(n.traceId, [n])
    }
  }
  for (const [tid, tools] of toolsByTrace) {
    const steps = (stepsByTrace.get(tid) || []).slice().sort((a, b) => Number(a.startNs) - Number(b.startNs))
    for (const tool of tools) {
      // INVOKES — last step started before the tool
      let owner: GraphNode | null = null
      for (const s of steps) {
        if (Number(s.startNs) <= Number(tool.startNs)) owner = s; else break
      }
      if (owner) addEdge(owner.id, tool.id, 'invokes')

      // RETURNS — the next step that starts AFTER the tool ends consumes its result
      let consumer: GraphNode | null = null
      for (const s of steps) {
        if (Number(s.startNs) >= Number(tool.endNs)) { consumer = s; break }
      }
      if (consumer) addEdge(tool.id, consumer.id, 'returns')
    }
  }

  // Sub-LLM (chat → nearest preceding step)
  const chatsByTrace = new Map<string, GraphNode[]>()
  for (const n of nodes.values()) {
    if (n.kind === 'chat' && n.traceId) {
      const arr = chatsByTrace.get(n.traceId); if (arr) arr.push(n); else chatsByTrace.set(n.traceId, [n])
    }
  }
  for (const [tid, chats] of chatsByTrace) {
    const steps = (stepsByTrace.get(tid) || []).slice().sort((a, b) => Number(a.startNs) - Number(b.startNs))
    for (const chat of chats) {
      let owner: GraphNode | null = null
      for (const s of steps) {
        if (Number(s.startNs) <= Number(chat.startNs)) owner = s; else break
      }
      if (owner) addEdge(owner.id, chat.id, 'sub-llm')
      else addEdge(`trace:${chat.traceId}`, chat.id, 'sub-llm')
    }
  }

  // 4. Artifacts (title lookup + citation resolvability) -------------------
  // Titles come from the RFC-014 derived index, not by reading the ledger's
  // `path` as JSON — post-RFC-014 that path is a real .md/.bib/.rp.yaml file, so
  // the old JSON.parse always failed and the graph fell back to bare filenames.
  // The index also carries full `content` (rebuildIndex persists the whole
  // artifact), which the A1 citation scan reads — no extra file I/O.
  let allArtifacts: Artifact[] = []
  try { allArtifacts = getArtifacts(projectPath) } catch { /* index unavailable — filenames + no citation stats */ }
  const artifactsById = new Map(allArtifacts.map(a => [a.id, a]))

  // Retrieved-identifier set for citation resolvability (A1): the project's
  // paper library plus every DOI / arXiv id / URL seen in a retrieval tool's
  // args or result. A cited id present here was actually fetched or curated;
  // one that's absent lands on the per-artifact fabrication watchlist.
  const retrievedIds = new Set<string>()
  for (const a of allArtifacts) {
    if (a.type !== 'paper') continue
    const p = a as PaperArtifact
    const d = p.doi ? toCanonicalDoi(p.doi) : null
    if (d) retrievedIds.add(d)
    const u = p.url ? toCanonicalUrl(p.url) : null
    if (u) retrievedIds.add(u)
  }
  const RETRIEVAL_TOOLS = new Set([
    'fetch-fulltext', 'web_fetch', 'web_search', 'literature-search', 'convert_document'
  ])
  for (const sp of spans) {
    if (!sp.name.startsWith('execute_tool ')) continue
    const tool = String(sp.attrs['gen_ai.tool.name'] || sp.name.replace('execute_tool ', ''))
    if (!RETRIEVAL_TOOLS.has(tool)) continue
    for (const evName of ['pipilot.tool.args', 'pipilot.tool.result']) {
      const ev = sp.events.find(e => e.name === evName)
      if (!ev) continue
      for (const c of extractCitations(String(ev.attrs.body ?? ''))) retrievedIds.add(c.canonical)
    }
  }

  // Citation stats apply only to "citing" text artifacts; papers ARE the
  // sources, data/binary have no prose. Empty content → no signal (omit).
  const CITING_TYPES = new Set(['note', 'web-content', 'tool-output'])
  const citationStats = (a: Artifact | undefined): Partial<GraphNode> => {
    if (!a || !CITING_TYPES.has(a.type)) return {}
    const text = typeof (a as { content?: unknown }).content === 'string'
      ? (a as { content: string }).content
      : ''
    if (!text) return {}
    const res = resolveCitations(extractCitations(text), retrievedIds)
    return {
      citationsTotal: res.total,
      citationsResolved: res.resolved,
      citationResolutionRate: res.rate,
      ...(res.unresolved.length > 0 && { unresolvedCitations: res.unresolved }),
    }
  }

  for (const r of ledger) {
    const id = `artifact:${r.artifactId}`
    if (nodes.has(id)) continue
    const a = artifactsById.get(r.artifactId)
    const title = (a && ((a as { title?: string }).title || (a as { summary?: string }).summary)) || null
    addNode(id, 'artifact', title || r.path.split('/').pop() || r.artifactId, {
      artifactId: r.artifactId,
      type: r.type,
      title,
      path: r.path,
      versions: ledgerByArtifact.get(r.artifactId) || [],
      ...citationStats(a),
    })
  }

  // 5. Walk tool spans for file/dir lineage --------------------------------
  function shortenPath(p: string): string { return p.replace(process.env.HOME || '~', '~') }
  function fileNode(p: string): string {
    const id = `file:${p}`
    addNode(id, 'file', p.split('/').slice(-2).join('/'), { path: p })
    return id
  }
  function dirNode(p: string): string {
    const id = `dir:${p}`
    const label = p === '.' || p === '' ? '<cwd>' : p.split('/').slice(-2).join('/')
    addNode(id, 'dir', label, { path: p })
    return id
  }
  function tryParseJson(s: unknown): unknown {
    try { return typeof s === 'string' ? JSON.parse(s) : null } catch { return null }
  }
  function extractPathsFromArgs(args: unknown): string[] {
    const out: string[] = []
    if (!args || typeof args !== 'object') return out
    const a = args as Record<string, unknown>
    for (const k of ['file_path', 'path', 'filename', 'file']) {
      const v = a[k]; if (typeof v === 'string') out.push(v)
    }
    for (const k of ['paths', 'files']) {
      const v = a[k]
      if (Array.isArray(v)) for (const p of v) if (typeof p === 'string') out.push(p)
    }
    return out
  }

  const DIR_INPUT_TOOLS = new Set(['ls', 'find'])
  for (const sp of spans) {
    if (!sp.name.startsWith('execute_tool ')) continue
    const toolName = String(sp.attrs['gen_ai.tool.name'] || sp.name.replace('execute_tool ', ''))
    const spanNodeId = `span:${sp.spanId}`
    const argsEv = sp.events.find(e => e.name === 'pipilot.tool.args')
    const resEv = sp.events.find(e => e.name === 'pipilot.tool.result')
    const args = argsEv ? tryParseJson(argsEv.attrs.body) : null
    const resBody = resEv ? tryParseJson(resEv.attrs.body) : null

    const paths = extractPathsFromArgs(args)
    if (DIR_INPUT_TOOLS.has(toolName)) {
      for (const p of paths) {
        const did = dirNode(shortenPath(p))
        addEdge(did, spanNodeId, 'listed')
      }
    } else {
      const reads = ['read', 'grep', 'convert_document'].includes(toolName)
      const writes = ['write', 'edit', 'artifact-create'].includes(toolName)
      for (const p of paths) {
        const fid = fileNode(shortenPath(p))
        if (reads) addEdge(fid, spanNodeId, 'reads')
        else if (writes) addEdge(spanNodeId, fid, 'writes')
        else addEdge(fid, spanNodeId, 'mentions')
      }
    }

    if (toolName === 'artifact-create' && resBody) {
      try {
        const r = resBody as { content?: Array<{ text?: string }> }
        const innerTxt = r.content?.[0]?.text
        if (innerTxt) {
          const inner = JSON.parse(innerTxt) as { id?: string }
          if (inner.id) addEdge(spanNodeId, `artifact:${inner.id}`, 'creates')
        }
      } catch { /* skip */ }
    }
    if (toolName === 'artifact-search' && resBody) {
      const txt = typeof resBody === 'string' ? resBody : JSON.stringify(resBody)
      const ids = [...txt.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map(m => m[0])
      for (const aid of new Set(ids)) {
        if (nodes.has(`artifact:${aid}`)) addEdge(`artifact:${aid}`, spanNodeId, 'retrieved')
      }
    }
  }

  // 6. Emit ----------------------------------------------------------------
  return {
    builtAt: new Date().toISOString(),
    source: projectPath,
    counts: {
      nodes: nodes.size,
      edges: edges.length,
      spans: spans.length,
      traces: traceSet.size,
      artifacts: ledgerByArtifact.size,
    },
    nodes: [...nodes.values()],
    edges,
  }
}
