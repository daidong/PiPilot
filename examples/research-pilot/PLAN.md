# Research Pilot - Implementation Plan (Updated)

## Overview

Research Pilot is a CLI-based research assistant that fully exercises the Context Assembly Pipeline (RFC-003):

- **5-Phase Context Pipeline**: System → Pinned → Selected → Session → Index
- **Multi-Agent Team**: Coordinator, WritingAgent, LiteratureAgent, DataAnalysisAgent
- **Research Entities**: Notes, Literature, Data with provenance tracking
- **Disk-as-Memory**: All state persisted to JSON files
- **Claude Code-like UX**: Tabbed CLI interface

## Design Decisions

### 1. Simplified Tool Layer

**Decision**: Use existing framework tools instead of custom CRUD tools.

**Rationale**:
- Existing `read`, `write`, `edit`, `glob`, `grep` from safe pack handle file operations
- JSON files can be managed with generic file tools
- Less code to maintain
- Provenance tracking handled in CLI commands (user-initiated)

**Tools Used**:
| Tool | From Pack | Purpose |
|------|-----------|---------|
| `read` | safe | Read entity JSON files |
| `write` | safe | Create/update entity files |
| `glob` | safe | List entities by pattern |
| `grep` | safe | Search within entities |
| `ctx-expand` | context-pipeline | **EXISTING** - Retrieve compressed history |

**NOT Implementing** (originally planned):
- ~~note-tools.ts~~ - Use write/read instead
- ~~literature-tools.ts~~ - Use write/read instead
- ~~data-tools.ts~~ - Use write/read instead
- ~~ctx-expand.ts~~ - **Already exists** at `src/tools/ctx-expand.ts`

### 2. User-Driven Note Selection from Agent Output

**Decision**: Add `/save-note` command for manual note extraction.

**Rationale**:
- All notes are user-initiated, not auto-discovered by LLM
- User controls what gets saved and how it's tagged
- Provenance still tracks which session the content came from

**CLI Commands**:
```bash
/save-note                    # Interactive: prompt for title, tags, content
/save-note --from-last        # Pre-fill with last agent response
/save-note --lines 5-12       # Extract specific lines from last response
```

**Interactive Flow**:
```
Agent: Here are the key findings about transformers:
       1. Self-attention mechanism allows...
       2. Positional encoding is needed because...
       3. Multi-head attention enables...

You: /save-note --from-last
> Title: Transformer Key Findings
> Tags (comma-separated): transformers, attention, architecture
> Edit content? (y/N): y
> [Opens editor with agent response pre-filled]

✓ Note saved: notes/note-abc123.json
  Provenance: user, session-xyz, extracted from agent response
```

---

## Updated Project Structure

```
examples/research-pilot/
├── index.ts                      # Main entry point & CLI
├── types.ts                      # Research entity types + path constants
├── agents/
│   ├── coordinator.ts            # Main chat coordinator (with context loading)
│   ├── literature-agent.ts       # Literature search/review
│   ├── writing-agent.ts          # Writing assistance
│   └── data-agent.ts             # Data analysis
├── commands/
│   ├── save-note.ts              # /save-note command handler
│   ├── select.ts                 # /select command handler
│   └── pin.ts                    # /pin command handler
└── .research-pilot/              # Default data directory
    ├── project.json              # Project config (pinned)
    ├── notes/
    ├── literature/
    ├── data/
    └── sessions/
```

**What we DON'T need:**
- ~~`storage.ts`~~ - Use fs + PATHS constants directly
- ~~`context/`~~ - Context loading is 3 simple functions in coordinator.ts

---

## Implementation Phases

### Phase 1: Core Types

**File: `types.ts`**
```typescript
// Path constants - agents use these with read/write/glob/grep tools
export const PATHS = {
  root: '.research-pilot',
  notes: '.research-pilot/notes',
  literature: '.research-pilot/literature',
  data: '.research-pilot/data',
  sessions: '.research-pilot/sessions',
  project: '.research-pilot/project.json'
} as const

// Research entity types with provenance
export interface ResearchEntity {
  id: string
  createdAt: string
  updatedAt: string
  tags: string[]
  pinned: boolean           // Auto-include in context
  selectedForAI: boolean    // User-selected for current request
  provenance: {
    source: 'user' | 'agent' | 'import'
    sessionId: string
    agentId?: string
    extractedFrom?: 'agent-response' | 'user-input' | 'file-import'
  }
}

export interface Note extends ResearchEntity {
  type: 'note'
  title: string
  content: string
}

export interface Literature extends ResearchEntity {
  type: 'literature'
  title: string
  authors: string[]
  abstract: string
  citeKey: string
}

export interface DataAttachment extends ResearchEntity {
  type: 'data'
  name: string
  filePath: string
  schema?: DataSchema
}

export interface ProjectConfig {
  name: string
  questions: string[]
  userCorrections: UserCorrection[]
}
```

**No `storage.ts` needed** - agents use framework tools directly:
- `write` → create/update JSON files in PATHS locations
- `read` → read JSON files
- `glob` → list files (e.g., `glob('.research-pilot/notes/*.json')`)
- `grep` → search within files

### Phase 2: Context Assembly Pipeline (No New Code Needed)

**100% Reuses existing framework components:**

| Framework Component | Location | What It Does |
|---------------------|----------|--------------|
| `createContextPipeline` | `src/context/pipeline.ts` | Pipeline executor with budget management |
| `createSystemPhase` | `src/context/phases/system-phase.ts` | System prompt assembly |
| `createPinnedPhase` | `src/context/phases/pinned-phase.ts` | Pinned context assembly |
| `createSelectedPhase` | `src/context/phases/selected-phase.ts` | User-selected context |
| `createSessionPhase` | `src/context/phases/session-phase.ts` | Session history |
| `createIndexPhase` | `src/context/phases/index-phase.ts` | Compressed history index |
| `SimpleHistoryCompressor` | `src/context/compressors/simple-compressor.ts` | History compression |
| `ctx-expand` | `src/tools/ctx-expand.ts` | On-demand expansion |
| `contextPipeline` pack | `src/packs/context-pipeline.ts` | Ready-to-use bundle |

**Default Phase Budgets (from framework):**

| Phase | Priority | Budget | Content |
|-------|----------|--------|---------|
| `system` | 100 | reserved 2000 | System prompt + tool descriptions |
| `pinned` | 90 | reserved 2000 | Project config, user corrections, pinned entities |
| `selected` | 80 | 30% | User-selected notes/papers/data for this request |
| `session` | 50 | remaining | Recent conversation history |
| `index` | 30 | fixed 500 | Compressed history + knowledge catalog |

**Usage in research-pilot:**
```typescript
import { contextPipeline } from 'agent-foundry'
import { packs } from 'agent-foundry'

const agent = createAgent({
  packs: [
    packs.safe(),           // File tools
    packs.contextPipeline() // Context pipeline + ctx-expand
  ]
})
```

### Phase 3: CLI Commands

**File: `commands/save-note.ts`**
```typescript
import { writeFileSync, mkdirSync } from 'fs'
import { PATHS, Note } from '../types.js'

export async function handleSaveNote(args: string[], context: CLIContext): Promise<void> {
  const { lastAgentResponse, sessionId } = context

  // Parse args
  const fromLast = args.includes('--from-last')
  const linesMatch = args.find(a => a.startsWith('--lines'))

  // Determine initial content
  let content = ''
  if (fromLast && lastAgentResponse) {
    content = linesMatch
      ? extractLines(lastAgentResponse, linesMatch)
      : lastAgentResponse
  }

  // Interactive prompts
  const title = await prompt('Title: ')
  const tagsInput = await prompt('Tags (comma-separated): ')
  const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)

  const editContent = await confirm('Edit content? (y/N): ')
  if (editContent) {
    content = await openEditor(content)
  } else if (!content) {
    content = await prompt('Content: ')
  }

  // Create note with provenance
  const note: Note = {
    id: crypto.randomUUID(),
    type: 'note',
    title,
    content,
    tags,
    pinned: false,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: 'user',
      sessionId,
      extractedFrom: fromLast ? 'agent-response' : 'user-input'
    }
  }

  // Write directly to file system
  mkdirSync(PATHS.notes, { recursive: true })
  const filePath = `${PATHS.notes}/${note.id}.json`
  writeFileSync(filePath, JSON.stringify(note, null, 2))
  console.log(`✓ Note saved: ${filePath}`)
}
```

**File: `commands/select.ts`**
```typescript
import { readFileSync, writeFileSync } from 'fs'
import { PATHS } from '../types.js'

// /select <id> - Toggle context selection for an entity
export async function handleSelect(entityId: string): Promise<void> {
  const filePath = findEntityFile(entityId) // searches notes/, literature/, data/
  if (!filePath) {
    console.log(`Entity not found: ${entityId}`)
    return
  }

  const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
  entity.selectedForAI = !entity.selectedForAI
  entity.updatedAt = new Date().toISOString()
  writeFileSync(filePath, JSON.stringify(entity, null, 2))

  const status = entity.selectedForAI ? 'selected for AI context' : 'removed from AI context'
  console.log(`✓ ${entity.type} "${entity.id}" ${status}`)
}
```

**File: `commands/pin.ts`**
```typescript
import { readFileSync, writeFileSync } from 'fs'

// /pin <id> - Toggle pinned status (auto-include in every context)
export async function handlePin(entityId: string): Promise<void> {
  const filePath = findEntityFile(entityId)
  if (!filePath) {
    console.log(`Entity not found: ${entityId}`)
    return
  }

  const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
  entity.pinned = !entity.pinned
  entity.updatedAt = new Date().toISOString()
  writeFileSync(filePath, JSON.stringify(entity, null, 2))

  const status = entity.pinned ? 'pinned (always in context)' : 'unpinned'
  console.log(`✓ ${entity.type} "${entity.id}" ${status}`)
}
```

### Phase 4: Sub-Agents

**File: `agents/literature-agent.ts`** (based on examples/literature-agent)
- `literaturePlanner`: Plans search strategies
- `literatureSearcher`: Calls APIs (semantic_scholar, arxiv)
- `literatureReviewer`: Evaluates results, requests more if needed

**File: `agents/writing-agent.ts`**
- `writingOutliner`: Creates structured outlines
- `writingDrafter`: Drafts sections with citations

**File: `agents/data-agent.ts`**
- `dataAnalyzer`: Analyzes datasets, generates insights

**File: `agents/coordinator.ts`**
- Routes requests to appropriate sub-agents
- Manages research entities (via file tools)
- Synthesizes results

### Phase 5: CLI Application

**File: `index.ts`**

```typescript
// Main CLI with tabs: Overview, Notes, Literature, Data, Chat
// Commands:
//   /notes           - List notes
//   /papers          - List literature
//   /data            - List datasets
//   /select <id>     - Toggle context selection
//   /pin <id>        - Toggle pinned status
//   /search <query>  - Search across entities
//   /save-note       - Save content as note (user-initiated)
//   /save-note --from-last          - Pre-fill with last agent response
//   /save-note --lines 5-12         - Extract specific lines
//   --debug          - Show context pipeline breakdown
```

**Interactive Features:**
- Tab navigation (Tab key)
- Context sidebar showing selected items
- Streaming AI responses
- Provenance display for agent-generated content
- **User-initiated note saving** via `/save-note`

---

## Framework Components Used

| Component | Location | Purpose in Research Pilot |
|-----------|----------|---------------------------|
| `ctx-expand` | `src/tools/ctx-expand.ts` | Retrieve compressed history segments |
| `SimpleHistoryCompressor` | `src/context/compressors/simple-compressor.ts` | Compress long conversations |
| `contextPipeline` pack | `src/packs/context-pipeline.ts` | Bundle compressor + ctx-expand |
| `safe` pack | `src/packs/safe.ts` | File operations (read, write, edit, glob, grep) |
| `defineLLMAgent` | `src/agent/define-llm-agent.ts` | Define sub-agents with schemas |
| `defineTeam` | `src/team/define-team.ts` | Orchestrate multi-agent collaboration |

---

## Context Pipeline Testing

### Test 1: Pinned Memory
```bash
# First session: discover schema
You: what tables are in my data?
# Agent uses read tool on data files, stores result as pinned note

# Second session: schema auto-loaded
You: query the users table
# No file read needed - pinned note has schema
```

### Test 2: Selected Context
```bash
# Select specific notes for context
/select note-abc123
/select note-def456
You: summarize these selected notes
# Agent receives notes in selected phase
```

### Test 3: History Compression
```bash
# Long conversation (50+ messages)
You: ... many research questions ...
You: what did we discuss about transformers?
# Agent uses ctx-expand to retrieve compressed segment
```

### Test 4: User Corrections
```bash
You: when I say "ML", I mean "Machine Learning"
# User runs: /save-note --from-last
# Tags it as "correction", pins it
# Future sessions: correction auto-applied from pinned context
```

### Test 5: Manual Note Extraction
```bash
Agent: The key insight from this paper is that attention mechanisms
       can replace recurrence entirely...

You: /save-note --from-last
> Title: Key Insight - Attention Replaces Recurrence
> Tags: attention, transformers, insight
> Edit content? (y/N): N

✓ Note saved: notes/note-xyz789.json
```

---

## Verification Plan

1. **Build**: `npm run build` - no TypeScript errors
2. **Unit Tests**: `npm test` - all context pipeline tests pass
3. **Integration Test**: Run full research workflow
   - Create project
   - Add notes via `/save-note`, import literature
   - Ask questions, verify context phases work
   - Long conversation, verify compression works (ctx-expand)
4. **Debug Mode**: `npx tsx examples/research-pilot/index.ts --debug`
   - Verify phase breakdown shown
   - Verify token allocations correct
   - Verify pinned items auto-loaded

---

## Critical Files

| File | Purpose |
|------|---------|
| `examples/research-pilot/index.ts` | Main CLI entry point |
| `examples/research-pilot/types.ts` | Research entity types + path constants |
| `examples/research-pilot/commands/save-note.ts` | User-initiated note saving |
| `examples/research-pilot/agents/coordinator.ts` | Main chat agent |

**Framework files used (no modification needed):**
| File | Purpose |
|------|---------|
| `src/context/pipeline.ts` | Context assembly pipeline |
| `src/context/phases/*.ts` | All 5 built-in phases |
| `src/tools/ctx-expand.ts` | Context expansion tool |
| `src/packs/context-pipeline.ts` | Ready-to-use pack |

## Reference Files

- `examples/personal-email-assistant/index.ts` - CLI pattern reference
- `examples/literature-agent/index.ts` - Multi-agent team reference
