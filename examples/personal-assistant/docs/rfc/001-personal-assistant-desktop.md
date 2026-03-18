# RFC-001: Personal Assistant Desktop App

**Status**: Implemented
**Author**: Captain
**Date**: 2026-02-01

## 1. Overview

Build a desktop personal assistant app with an Electron + React UI forked from `research-pilot-desktop`, powered by a single coordinator agent backed by AgentFoundry. The app connects to a local email SQLite database and lets the user chat with an AI that can query emails, manage notes, handle reference documents, and remember preferences — all through a familiar three-panel layout.

### Design Principle

> **Fork the shell, replace the domain.**

We reuse research-pilot-desktop's UI architecture, entity management, context pipeline, and IPC contract verbatim. We then swap the domain layer:

| research-pilot | personal-assistant | Change type |
|---|---|---|
| Notes | Notes | **Unchanged** |
| Papers (Literature) | Docs (Documents) | Rename + simplify schema |
| Data (DataAttachment) | _(removed)_ | Delete — no third tab |
| literature-search subagent | _(removed)_ | Delete |
| data-analyze subagent | _(removed)_ | Delete |
| Enrich button | _(removed)_ | Delete |
| BibTeX, citeKey, venue, etc. | _(removed)_ | Delete |
| — | SQLite email queries (agent-only) | Add |

**Key insight**: This is a personal *assistant*, not an email client. Email access is purely conversational — the agent queries SQLite when asked. There is no email list tab. The left sidebar has two tabs: **Notes** and **Docs**.

---

## 2. Directory Structure

```
examples/personal-assistant/
├── docs/
│   └── rfc/
│       └── 001-personal-assistant-desktop.md   # This file
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron app init, window, menu
│   │   ├── ipc.ts                # IPC handlers (forked from research-pilot-desktop)
│   │   └── realtime-buffer.ts    # Streaming state recovery (copy as-is)
│   ├── preload/
│   │   └── index.ts              # Context bridge API (adapted)
│   └── renderer/
│       ├── main.tsx              # React entry
│       ├── App.tsx               # Root: FolderGate, theme, IPC listeners
│       ├── components/
│       │   ├── layout/
│       │   │   ├── CenterPanel.tsx
│       │   │   ├── LeftSidebar.tsx
│       │   │   ├── RightSidebar.tsx
│       │   │   └── EntityPreviewPanel.tsx
│       │   ├── center/
│       │   │   ├── ChatMessages.tsx
│       │   │   ├── ChatInput.tsx
│       │   │   ├── HeroIdle.tsx
│       │   │   ├── MentionPopover.tsx
│       │   │   └── CommandPopover.tsx
│       │   ├── left/
│       │   │   ├── EntityTabs.tsx    # Two tabs: Notes / Docs
│       │   │   ├── ModelSelector.tsx
│       │   │   └── UserProfile.tsx
│       │   └── right/
│       │       ├── WorkingFolder.tsx
│       │       ├── ContextChips.tsx
│       │       ├── ProgressSteps.tsx
│       │       └── ActivityLog.tsx
│       └── stores/
│           ├── entity-store.ts    # notes, docs + project cards/working set
│           ├── chat-store.ts
│           ├── ui-store.ts        # leftTab: 'notes' | 'docs'
│           ├── progress-store.ts
│           ├── activity-store.ts
│           └── session-store.ts
├── agents/
│   ├── coordinator.ts            # Single agent (no subagents)
│   └── prompts/
│       └── index.ts              # System prompt
├── commands/
│   ├── index.ts
│   ├── list.ts                   # listNotes, listDocs
│   ├── pin.ts                    # Project Cards (/project, legacy /pin)
│   ├── select.ts                 # toggleSelect, getSelected (reuse as-is)
│   ├── save-note.ts              # saveNote (reuse as-is)
│   ├── save-doc.ts               # saveDoc (adapted from save-paper)
│   ├── delete.ts                 # deleteEntity (reuse as-is)
│   └── search.ts                 # searchEntities (adapted)
├── tools/
│   └── entity-tools.ts           # save-note, save-doc, update-note tools
├── mentions/
│   ├── index.ts
│   ├── parser.ts                 # @note:, @doc:, @file:, @url:
│   ├── resolver.ts
│   ├── candidates.ts
│   └── document-cache.ts
├── types.ts                      # Entity types
├── package.json
├── electron.vite.config.ts
├── tsconfig.json / tsconfig.web.json / tsconfig.node.json
└── index.ts                      # Library entry (re-export createCoordinator)
```

---

## 3. Entity Types

### 3.1 types.ts

```typescript
export const PATHS = {
  root: '.personal-assistant',
  notes: '.personal-assistant/notes',
  docs: '.personal-assistant/docs',
  sessions: '.personal-assistant/sessions',
  cache: '.personal-assistant/cache',
  documentCache: '.personal-assistant/cache/documents',
  project: '.personal-assistant/project.json',
  /** Long-term memory files (RFC-002). Directories created empty in v1. */
  memory: '.personal-assistant/memory',
  memoryFile: '.personal-assistant/MEMORY.md',
  userProfile: '.personal-assistant/USER.md',
} as const

// Base entity (identical to research-pilot)
export interface Provenance {
  source: 'user' | 'agent' | 'import'
  sessionId: string
  agentId?: string
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import'
  messageId?: string
}

export interface BaseEntity {
  id: string
  createdAt: string
  updatedAt: string
  tags: string[]
  projectCard: boolean
  projectCardSource?: 'auto' | 'manual'
  provenance: Provenance
}

// --- Note (unchanged from research-pilot) ---
export interface Note extends BaseEntity {
  type: 'note'
  title: string
  content: string
}

// --- Doc (replaces Literature — simplified) ---
export interface Doc extends BaseEntity {
  type: 'doc'
  title: string
  /** Original file path (PDF, Word, etc.) */
  filePath: string
  /** Extracted/summarized content (markdown) */
  content?: string
  /** File MIME type */
  mimeType?: string
  /** User-provided description or auto-generated summary */
  description?: string
}

export type Entity = Note | Doc
```

### 3.2 Key differences from research-pilot

| Aspect | research-pilot | personal-assistant | Rationale |
|---|---|---|---|
| Entity types | Note, Literature, DataAttachment | Note, Doc | Two types instead of three |
| Literature fields | authors, year, venue, citeKey, doi, bibtex, pdfUrl, citationCount, enrichmentSource, enrichedAt, relevanceScore, searchKeywords, externalSource | _(all removed)_ | Academic-specific |
| Doc fields | — | filePath, content, mimeType, description | Simple document reference |
| DataAttachment | name, filePath, schema, runId, runLabel | _(type removed entirely)_ | Not an email client |
| Entity directories | notes/, literature/, data/ | notes/, docs/ | Two directories |

---

## 4. Email Integration

### 4.1 Agent-Only Access

Email access is **purely through the agent**. There is no email UI tab, no email list, no email preview panel. The user asks questions in chat ("show me emails from John this week"), and the agent queries SQLite via the `sqlite` pack tools.

This means:
- No `EmailEntry` entity type
- No `emails/` directory in `.personal-assistant/`
- No email-specific IPC channels
- No email renderer in EntityPreviewPanel

### 4.2 How It Works

1. User asks: "What emails did I get from John today?"
2. Agent calls `sqlite_read_query` with appropriate SQL
3. Agent formats results in its chat response
4. If user wants to save something: agent creates a **Note** with the email content/summary
5. If user pins that note, it enters the context pipeline automatically

### 4.3 SQLite Pack Configuration

```typescript
const sqlitePack = await packs.sqlite({
  dbPath: config.emailDbPath,
  toolPrefix: 'sqlite'
})
```

The agent has full read access to the email database via:
- `sqlite_list_tables` — discover schema
- `sqlite_describe_table` — inspect columns
- `sqlite_read_query` — execute SELECT queries

Schema discovery is cached in Project Cards memory (same pattern as personal-email-assistant example).

---

## 5. UI Changes

### 5.1 Left Sidebar Tabs

```
EntityTabs tabs:
  - Notes    (icon: StickyNote, yellow)    — unchanged
  - Docs     (icon: FileText, green)       — replaces "Papers"
```

**Two tabs only.** The "Data" tab is removed entirely.

**Notes tab**: Identical to research-pilot. List of notes, drag-drop to create.

**Docs tab**:
- List of Doc entities from `.personal-assistant/docs/`
- Each row: title, file type icon, description snippet
- Drag-drop files to import (PDF, Word, etc. → auto-convert via MarkItDown)
- Click → opens DocPreview in EntityPreviewPanel (rendered markdown or "open in default app")

### 5.2 EntityPreviewPanel

Simplified from research-pilot:

- **Note preview**: Unchanged (markdown rendering, edit mode)
- **Doc preview**: Shows title, file path, description. If content was extracted, renders markdown. Otherwise shows "Open in default app" button for the source file.
- **Removed**: Paper metadata section (authors, year, venue, DOI, BibTeX, citations, enrichment info)

Pin/Select/Delete buttons work unchanged.

### 5.3 Mention System

Simplified from research-pilot:

| Prefix | Target | Match by |
|---|---|---|
| `@note:` | Note | id, title |
| `@doc:` | Doc | id, title |
| `@file:` | Local file | path |
| `@url:` | URL | url |

Removed: `@paper:`, `@data:`

### 5.4 Other UI Changes

- **HeroIdle**: Change branding from "Research Pilot" to "Personal Assistant"
- **ModelSelector**: Keep as-is
- **ContextChips**: Works unchanged (shows Project Cards/WorkingSet chips)
- **WorkingFolder**: Works unchanged
- **ProgressSteps / ActivityLog**: Work unchanged
- **CommandPopover**: Adapt slash commands:
  - `/project <id>` — toggle Project Card (legacy: `/pin`)
  - `/select <id>` — toggle WorkingSet
  - `/clear` — clear selections
  - `/search <query>` — search entities
  - Remove `/enrich`

---

## 6. Agent Design

### 6.1 Single Coordinator (No Subagents)

```typescript
export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  emailDbPath?: string
  debug?: boolean
  sessionId?: string
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
}

export async function createCoordinator(config: CoordinatorConfig) {
  // Seeds MEMORY.md, USER.md, memory/ directory on first run
  // Builds bootstrap selections (USER.md, MEMORY.md, today/yesterday logs) every turn
  // Uses onPreCompaction hook to flush context to daily log before compaction

  const agent = createAgent({
    packs: [
      packs.safe(),               // read, write, edit, glob, grep
      packs.kvMemory(),           // session memory (ephemeral)
      packs.todo(),               // task tracking
      packs.sessionHistory(),     // cross-turn history persistence
      packs.contextPipeline(),    // project-cards/workingset context, compression
      documentsPack,              // convert_to_markdown wrapper
      webPack,                    // brave_web_search, fetch
      ...(sqlitePack ? [sqlitePack] : []),  // sqlite tools (if email DB available)
      entityPack,                 // save-note, save-doc, update-note
    ],
    // ...
  })

  return { agent, chat, clearSessionMemory, destroy }
}
```

### 6.2 Tools Available to Agent

| Tool | Source | Purpose |
|---|---|---|
| `read`, `write`, `edit`, `glob`, `grep` | safe pack | File operations (including memory files, scheduled-tasks.json) |
| `memory-put`, `memory-update`, `memory-delete` | kvMemory | Session memory (ephemeral scratchpad) |
| `todo-add/update/complete/remove` | todo | Task tracking |
| `ctx-get`, `ctx-expand` | contextPipeline | Context retrieval |
| `convert_to_markdown` | documents (wrapper) | PDF/Word/Excel → markdown |
| `brave_web_search`, `fetch` | web | Web lookup |
| `sqlite_read_query` | sqlite (conditional) | SELECT queries on email DB |
| `sqlite_list_tables` | sqlite (conditional) | Schema discovery |
| `sqlite_describe_table` | sqlite (conditional) | Column info |
| `save-note` | entity-tools | Create note entity (triggers IPC refresh) |
| `save-doc` | entity-tools | Create doc entity (triggers IPC refresh) |
| `update-note` | entity-tools | Update existing note |

> **Design principle**: No RFC-002 features required new agent tools. Memory management (`MEMORY.md`, `USER.md`, daily logs) and schedule management (`scheduled-tasks.json`) use the existing `safe` pack tools with prompt instructions.

### 6.3 System Prompt (Key Sections)

```
You are a Personal Assistant that helps manage emails, documents, and notes.

## Capabilities
- Query emails from a local database via SQL
- Process documents (PDF, Word, Excel) and save as Docs
- Create and manage notes for important information
- Search the web for information
- Remember user preferences across sessions

## Tools
- File: read, write, edit, glob, grep
- Email DB: sqlite_read_query, sqlite_list_tables, sqlite_describe_table
- Web: brave_web_search, fetch
- Documents: convert_to_markdown
- Entities: save-note, save-doc, update-note
- Memory: memory-put, memory-update, memory-delete
- Tasks: todo-add, todo-update, todo-complete, todo-remove
- Context: ctx-get, ctx-expand

## Email Query Rules
- ALWAYS use LIMIT (default 20) to avoid overflow
- NEVER use SELECT * — always select specific columns
- internal_date is in MILLISECONDS since epoch
- Use sqlite_read_query for email lookups, NOT grep/read
- When summarizing emails, include sender, subject, date, and key content

## Schema Discovery
- Check Project Cards context first for cached schema
- If missing, call sqlite_list_tables → sqlite_describe_table
- Store condensed schema with memory-put using tags: ["project-card"]
- Store user corrections (e.g., "internal_date is ms") as Project Cards too

## Document Workflow
- Use convert_to_markdown to extract text from PDF/Word/Excel
- Save important extractions as Doc entities via save-doc
- Use read with offset/limit to navigate large extracted documents

## Notes
- Create notes for important findings, summaries, preferences
- Promote core decisions/constraints to Project Cards (not all notes are long-term)
- Update existing notes instead of creating duplicates

## Communication Style
- Reply in the language of the user's latest message
- Be concise but specific
- After tool work: summarize findings + suggest next actions
```

### 6.4 Context Assembly

Project Cards are synced to memoryStorage for the `project-cards` phase. WorkingSet is built per turn from explicit selections + entity @mentions + query. File/URL mentions are injected via the selected phase.

```
buildBootstrapSelections(projectPath):
  - USER.md, MEMORY.md, today/yesterday logs → ContextSelection[]

getMentionWorkingSetIds(mentions):
  - Extract entity IDs from @note/@doc mentions

buildMentionSelections(mentions):
  - Convert file/url @-mentions to ContextSelection[]

chat(message, mentions):
  - syncProjectCardsToMemoryStorage()
  - selectedContext = bootstrapSelections + file/url mentions
  - workingSetIds = explicit UI selections + entity mention IDs
  - agent.run(message, { selectedContext, workingSet: { explicitIds, query: message } })
```

### 6.5 Conversation Lifecycle & Memory Integration

> **Updated**: RFC-002 implemented bootstrap injection directly in `chat()` via `buildBootstrapSelections()` — no hook abstraction was needed.

```typescript
chat(message, mentions):
  const mentionSelections = buildMentionSelections(mentions)         // file/url only
  const bootstrapSelections = buildBootstrapSelections(projectPath)  // USER.md, MEMORY.md, today/yesterday logs
  const selectedContext = [...bootstrapSelections, ...mentionSelections]

  const workingSetIds = mergeUISelectionsWithMentionIds(mentions)

  const result = await agent.run(message, {
    selectedContext,
    workingSet: { explicitIds: workingSetIds, query: message }
  })
  return result
```

The agent writes to daily logs during conversation via prompt instructions (using `edit`/`write` tools). The `onPreCompaction` framework hook triggers a silent flush to the daily log before context compaction.

---

## 7. IPC Contract

### 7.1 Channels Inherited from research-pilot-desktop (unchanged)

```
Agent:      agent:send, agent:stream-chunk, agent:done, agent:activity,
            agent:stop, agent:clear-memory, agent:get-realtime-snapshot
            agent:todo-update, agent:todo-clear, agent:entity-created,
            agent:file-created

Entity:     cmd:list-notes, cmd:delete, cmd:rename-note, cmd:update-entity,
            cmd:save-note, cmd:search
            cmd:select, cmd:get-selected, cmd:clear-selections
            cmd:pin (Project Cards), cmd:get-pinned (Project Cards)

File:       file:list-root, file:read, file:read-binary, file:resolve-path,
            file:open-external, file:drop

Session:    session:save-message, session:load-messages, session:get-total-count,
            session:mark-saved, session:load-saved-ids, session:current

Project:    project:pick-folder, project:close, project:closed

Mentions:   mention:candidates
```

### 7.2 Channels Changed

```
cmd:list-literature  →  cmd:list-docs       # Renamed
cmd:save-paper       →  cmd:save-doc        # Renamed
cmd:list-data        →  (removed)           # No third entity type
cmd:save-data        →  (removed)
cmd:enrich-papers    →  (removed)
enrich:progress      →  (removed)
```

### 7.3 Preload API Shape

```typescript
export interface ElectronAPI {
  // Agent (unchanged)
  sendMessage: (message: string, rawMentions?: string, model?: string) => Promise<any>
  onStreamChunk: (cb: (chunk: string) => void) => () => void
  onAgentDone: (cb: (result: any) => void) => () => void
  stopAgent: () => Promise<void>
  clearSessionMemory: () => Promise<void>
  getRealtimeSnapshot: () => Promise<RealtimeSnapshot>

  // Entities
  listNotes: () => Promise<NoteListItem[]>
  listDocs: () => Promise<DocListItem[]>          // was listLiterature
  search: (query: string) => Promise<SearchResult[]>
  deleteEntity: (id: string) => Promise<any>
  updateEntity: (id: string, updates: any) => Promise<any>
  saveNote: (title: string, content: string, messageId?: string) => Promise<any>
  saveDoc: (title: string, filePath: string, content?: string) => Promise<any>  // was savePaper

  // Pin/Select (unchanged)
  toggleSelect: (id: string) => Promise<any>
  getSelected: () => Promise<any>
  clearSelections: () => Promise<any>
  togglePin: (id: string) => Promise<any>
  getPinned: () => Promise<any> // Project Cards (legacy name)

  // Mentions (unchanged)
  getCandidates: (partial: string, type?: string) => Promise<any>

  // Events (unchanged)
  onTodoUpdate: (cb: (item: any) => void) => () => void
  onTodoClear: (cb: () => void) => () => void
  onActivity: (cb: (event: any) => void) => () => void
  onEntityCreated: (cb: (info: any) => void) => () => void
  onFileCreated: (cb: (path: string) => void) => () => void

  // File (unchanged)
  readFile: (path: string) => Promise<FileResult>
  openFile: (path: string) => Promise<any>
  listRootFiles: () => Promise<RootFile[]>
  dropFile: (fileName: string, content: string, tab: string) => Promise<any>

  // Session/Project (unchanged)
  getCurrentSession: () => Promise<SessionInfo>
  pickFolder: () => Promise<PickResult | null>
  closeProject: () => Promise<void>
  onProjectClosed: (cb: () => void) => () => void
  saveMessage: (sessionId: string, msg: any) => Promise<void>
  loadMessages: (sessionId: string, offset: number, limit: number) => Promise<any[]>
  getMessageCount: (sessionId: string) => Promise<number>
  markMessageSaved: (sessionId: string, messageId: string) => Promise<void>
  loadSavedMessageIds: (sessionId: string) => Promise<string[]>
}
```

---

## 8. Store Changes

### 8.1 entity-store.ts

```typescript
interface EntityState {
  notes: EntityItem[]
  docs: EntityItem[]        // was: papers
  projectCards: EntityItem[]
  selected: EntityItem[]
  // removed: data, enrichingPapers, setEnriching, clearEnriching, clearAllEnriching
  reset: () => void
  refreshAll: () => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
  updateEntity: (id: string, updates: any) => Promise<void>
}
```

`refreshAll()`:
```typescript
const [notes, docs, projectCards, selected] = await Promise.all([
  api.listNotes(),
  api.listDocs(),
  api.getPinned(), // Project Cards (legacy name)
  api.getSelected()
])
```

### 8.2 ui-store.ts

```typescript
type LeftTab = 'notes' | 'docs'  // was: 'notes' | 'data' | 'papers'
```

---

## 9. Implementation Plan

### Phase 1: Scaffold & Core Backend

1. **Create types.ts**. Define `Note`, `Doc`, `PATHS` (two entity types, two directories).
2. **Fork commands/** from research-pilot. Adapt:
   - `list.ts`: `listNotes` (as-is), `listDocs` (rename from listLiterature, remove academic fields)
   - `save-doc.ts`: adapted from `save-paper.ts` (just title, filePath, content, description)
   - `pin.ts`, `select.ts`, `delete.ts`, `search.ts`: update PATHS import, remove literature/data references
3. **Fork mentions/** from research-pilot. Remove `@paper:` and `@data:`, add `@doc:`.
4. **Fork tools/entity-tools.ts**. Replace `save-paper` → `save-doc`, remove literature-specific fields.
5. **Create agents/coordinator.ts**. Single agent with sqlite + documents + web packs. No subagents, no subagent-tools. System prompt focused on email queries + docs + notes workflow.

### Phase 2: Electron Shell

6. **Fork package.json** from research-pilot-desktop. Update name/description, remove unused deps (no bibtex, no data analysis).
7. **Fork electron.vite.config.ts** and tsconfig files as-is.
8. **Fork src/main/index.ts**. Change app title to "Personal Assistant".
9. **Copy src/main/realtime-buffer.ts** as-is.
10. **Fork src/main/ipc.ts**. Changes:
    - Replace `cmd:list-literature` → `cmd:list-docs`
    - Replace `cmd:save-paper` → `cmd:save-doc`
    - Remove `cmd:list-data`, `cmd:save-data`
    - Remove `cmd:enrich-papers` and `enrich:progress` handlers
    - Update coordinator import path
    - Pass `emailDbPath` from env to coordinator config
11. **Fork src/preload/index.ts**. Update API shape per section 7.3 (remove listData, listLiterature, enrichAllPapers; add listDocs, saveDoc).

### Phase 3: Renderer UI

12. **Fork all stores**. Changes per section 8 (two entity types, two tabs).
13. **Fork App.tsx**. Update app title, remove enrich-related IPC listeners.
14. **Fork layout components** (CenterPanel, LeftSidebar, RightSidebar). Minimal changes.
15. **Fork EntityTabs.tsx**. Two tabs (Notes, Docs), remove Enrich button, remove Data tab, update icons.
16. **Fork EntityPreviewPanel.tsx**. Remove paper metadata section (authors, venue, BibTeX, DOI, citations, enrichment). Keep note rendering and file preview (markdown/text/CSV/external). Doc preview shows title + file content.
17. **Fork center components** (ChatMessages, ChatInput, HeroIdle, MentionPopover, CommandPopover). Update branding, mention categories (@doc instead of @paper), remove /enrich command.
18. **Copy right sidebar components** as-is (WorkingFolder, ContextChips, ProgressSteps, ActivityLog).

### Phase 4: Integration & Polish

19. **Wire doc import**: Drag-drop file onto Docs tab → calls `api.dropFile(name, content, 'docs')` → creates Doc entity with optional MarkItDown extraction.
20. **Wire doc preview**: Click doc row → EntityPreviewPanel renders extracted content or "open in default app".
21. **Test full flow**: Chat → agent queries email SQLite → formats response → user creates note from chat → note appears in sidebar → mark as Project Card → appears in context next turn (budget permitting).
22. **Environment config**: `EMAIL_DB_PATH` env var for SQLite database path.
23. **Graceful degradation**: If SQLite pack fails to connect, agent works without email access (notes + docs + web still functional).

---

## 10. What We Reuse Verbatim

These components are copied with zero or trivial changes:

- `src/main/realtime-buffer.ts`
- `src/renderer/stores/chat-store.ts`
- `src/renderer/stores/progress-store.ts`
- `src/renderer/stores/activity-store.ts`
- `src/renderer/stores/session-store.ts`
- `src/renderer/components/center/ChatMessages.tsx`
- `src/renderer/components/center/ChatInput.tsx` (minor: update mention categories)
- `src/renderer/components/center/HeroIdle.tsx` (change title)
- `src/renderer/components/center/MentionPopover.tsx` (minor: update categories)
- `src/renderer/components/center/CommandPopover.tsx` (remove `/enrich`)
- `src/renderer/components/right/WorkingFolder.tsx`
- `src/renderer/components/right/ContextChips.tsx`
- `src/renderer/components/right/ProgressSteps.tsx`
- `src/renderer/components/right/ActivityLog.tsx`
- `src/renderer/components/left/ModelSelector.tsx`
- `src/renderer/components/left/UserProfile.tsx`
- `src/renderer/components/layout/CenterPanel.tsx`
- `src/renderer/components/layout/RightSidebar.tsx`
- `commands/pin.ts`, `commands/select.ts`, `commands/delete.ts` (update PATHS import)

---

## 11. What We Build New

| Component | Effort | Description |
|---|---|---|
| `types.ts` | Small | Two entity types: Note, Doc |
| `commands/list.ts` | Small | `listNotes` (as-is), `listDocs` (simplified from listLiterature) |
| `commands/save-doc.ts` | Small | Simplified from save-paper (title, filePath, content, description) |
| `agents/coordinator.ts` | Medium | Single agent with sqlite + docs + web packs, no subagents |
| `agents/prompts/index.ts` | Medium | System prompt for email/docs/notes workflow |
| `src/main/ipc.ts` | Medium | Fork + simplify (remove literature/data/enrich, add doc channels) |
| `EntityTabs.tsx` | Small | Two tabs instead of three, remove Enrich button |
| `EntityPreviewPanel.tsx` | Small | Remove paper metadata section, keep note + file preview |
| `entity-store.ts` | Small | Two entity lists instead of three |

**Estimated total new/adapted code**: ~60% fork-and-simplify, ~30% verbatim copy, ~10% net new.

---

## 12. Environment & Configuration

```bash
# Required (one of)
export OPENAI_API_KEY=sk-xxx
export ANTHROPIC_API_KEY=sk-ant-xxx

# Optional
export EMAIL_DB_PATH=~/path/to/email.db   # default: ~/Library/Application Support/ChatMail/local-email.db
export MODEL=gpt-5.4                       # default model
export BRAVE_API_KEY=BSA-xxx               # for web search (optional)
```

---

## 13. Risk & Open Questions

| Risk | Mitigation |
|---|---|
| Email DB schema varies across mail clients | Agent discovers schema at runtime via `sqlite_list_tables` + `sqlite_describe_table`. Caches in Project Cards memory. No hardcoded assumptions. |
| Large email bodies blow up token budget | `toolResultCap: 4096` in budgetConfig. Agent instructed to use LIMIT and select specific columns. |
| SQLite file locked by mail client | MCP server opens read-only. |
| No email DB available | SQLite pack fails gracefully. Agent still works for notes, docs, web search. |

### Open Questions

1. **Thread view**: Should we support email thread expansion in a future version? (Defer to v2)
2. **Write operations**: Should the agent be able to draft email replies? (Defer — read-only for v1)
3. **Multiple email accounts**: Single DB for v1. Multi-account support deferred.
4. **Offline email sync**: Out of scope — assumes external app syncs emails to SQLite.
5. **Doc auto-extraction**: When user drops a PDF into Docs tab, should we auto-run `convert_to_markdown` and store the extracted text? (Recommended yes — saves agent a tool call later)

---

## 14. Forward Compatibility with RFC-002

RFC-002 (Long-Term Memory & Autonomous Behavior) has been implemented on top of this foundation. The upgrade was purely additive — no RFC-001 code was thrown away.

| RFC-001 preparation | What RFC-002 actually did |
|---------------------|---------------------------|
| `PATHS.memory`, `PATHS.memoryFile`, `PATHS.userProfile` defined, `memory/` created empty | Agent writes `MEMORY.md`, `USER.md`, daily logs. Added `PATHS.scheduledTasks`, `PATHS.notifications`. |
| `CoordinatorConfig` includes `projectPath` | No config change needed — paths derived from `projectPath` |
| Pack slot comment for `memorySearch` | `packs.memorySearch()` built at framework level but **not wired in** — `grep` is sufficient at current scale |
| Context assembly comment for bootstrap | `buildBootstrapSelections()` implemented — injects USER.md, MEMORY.md, today/yesterday logs every turn |
| `safe` pack tools | Agent uses `read`/`write`/`edit`/`grep` for all memory and schedule operations — **zero new agent tools** |
| — | Added `onPreCompaction` hook (framework) — silent turn saves context to daily log before compaction |
| — | Added scheduler engine + notification store (application layer, Electron main process) |
| — | Added NotificationPanel + bell badge in desktop UI |

**Key outcome**: RFC-002 added zero new tools to the LLM's tool set. All memory and scheduling operations use existing `safe` pack tools with prompt instructions. This validates RFC-001's design principle that the `safe` pack provides sufficient primitives for higher-level capabilities.
