import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { createCoordinator, type CoordinatorConfig } from '@research-pilot/agents/coordinator'
import { FileMemoryStorage } from '../../../../src/core/memory-storage.js'
import type { MemoryItem } from '../../../../src/types/memory.js'
import {
  listNotes, listLiterature, listData,
  searchEntities, deleteEntity,
  toggleSelect, getSelected, clearSelections,
  togglePin, getPinned
} from '@research-pilot/commands/index'
import { saveNote, getSaveNoteContent } from '@research-pilot/commands/save-note'
import { savePaper, parseSavePaperArgs } from '@research-pilot/commands/save-paper'
import { saveData, parseSaveDataArgs } from '@research-pilot/commands/save-data'
import { parseMentions, resolveMentions, getCandidates } from '@research-pilot/mentions/index'
import { setCachedMarkdown, fileUriToPath } from '@research-pilot/mentions/document-cache'
import { PATHS, type ProjectConfig } from '@research-pilot/types'

let coordinator: ReturnType<typeof createCoordinator> | null = null
let currentModel = 'gpt-5.2'
// Start with empty project path — user must select a folder
let projectPath = ''
let sessionId = crypto.randomUUID()
let memoryStorage: FileMemoryStorage | null = null
let memoryInitPromise: Promise<FileMemoryStorage> | null = null

/** Get or create the memory storage instance for the current project */
async function getMemoryStorage(): Promise<FileMemoryStorage | null> {
  if (!projectPath) return null
  if (!memoryInitPromise) {
    const storage = new FileMemoryStorage(projectPath)
    memoryInitPromise = storage.init().then(() => {
      memoryStorage = storage
      return storage
    })
  }
  return memoryInitPromise
}

/** Initialize .research-pilot directory structure in the project folder */
function initializeProject(path: string): void {
  const dirs = [PATHS.root, PATHS.notes, PATHS.literature, PATHS.data, PATHS.sessions, PATHS.cache, PATHS.documentCache]

  for (const dir of dirs) {
    const fullPath = join(path, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }
  }

  const projectFile = join(path, PATHS.project)
  if (!existsSync(projectFile)) {
    const defaultConfig: ProjectConfig = {
      name: 'Research Project',
      description: 'A new research project',
      questions: [],
      userCorrections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeFileSync(projectFile, JSON.stringify(defaultConfig, null, 2))
  }

  // Change cwd so relative PATHS in save commands resolve correctly
  process.chdir(path)
}

/** Load or create a persistent session ID for a project folder */
function loadOrCreateSessionId(path: string): string {
  const sessionFile = join(path, PATHS.root, 'session.json')
  if (existsSync(sessionFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionFile, 'utf-8'))
      if (data.sessionId) return data.sessionId
    } catch {
      // Corrupted file, create new
    }
  }
  const newId = crypto.randomUUID()
  writeFileSync(sessionFile, JSON.stringify({ sessionId: newId }))
  return newId
}

async function ensureCoordinator(win: BrowserWindow, model?: string) {
  const requestedModel = model || currentModel
  // Recreate coordinator if model changed
  if (coordinator && requestedModel !== currentModel) {
    coordinator.destroy().catch(() => {})
    coordinator = null
  }
  currentModel = requestedModel

  if (!coordinator) {
    const apiKey = process.env.OPENAI_API_KEY || ''

    // Notify UI that we're initializing (includes MCP servers like MarkItDown)
    win.webContents.send('agent:activity', {
      type: 'system',
      summary: 'Initializing agent (first run may take 1-2 minutes for document processing setup)...'
    })

    coordinator = await createCoordinator({
      apiKey,
      model: currentModel,
      projectPath,
      sessionId,
      debug: true,
      onStream: (chunk: string) => {
        win.webContents.send('agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown) => {
        // Send activity event for tool invocation
        const summary = formatToolCallSummary(tool, args)
        win.webContents.send('agent:activity', {
          type: 'tool-call',
          tool,
          summary
        })
      },
      onToolResult: (tool: string, result: unknown, args?: unknown) => {
        if (tool.startsWith('todo-') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.item) {
            win.webContents.send('agent:todo-update', r.item)
          }
        }

        // Track files created/modified by write and edit tools
        if ((tool === 'write' || tool === 'edit') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.path) {
            win.webContents.send('agent:file-created', r.data.path)
          }
        }

        // Cache convert_to_markdown results for document files
        if (tool === 'convert_to_markdown' && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.content && args && typeof args === 'object' && 'uri' in args) {
            const uri = (args as { uri: string }).uri
            const filePath = fileUriToPath(uri)
            if (filePath && projectPath) {
              setCachedMarkdown(filePath, r.data.content, projectPath)
            }
          }
        }

        // Notify UI to refresh entity lists when notes or papers are saved
        if ((tool === 'save-note' || tool === 'save-paper') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success) {
            win.webContents.send('agent:entity-created', {
              type: tool === 'save-note' ? 'note' : 'literature',
              id: r.data?.id,
              title: r.data?.title
            })
          }
        }

        // Send activity event for tool result
        const r = result as any
        const success = r?.success !== false
        const error = !success ? (r?.error || 'Unknown error') : undefined
        const summary = formatToolResultSummary(tool, result, args)
        win.webContents.send('agent:activity', {
          type: 'tool-result',
          tool,
          summary,
          success,
          error
        })
      }
    })

    // Notify UI that initialization is complete
    win.webContents.send('agent:activity', {
      type: 'system',
      summary: 'Agent ready'
    })
  }
  return coordinator
}

/** Extract just the filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

/** Format a short summary for a tool call activity event */
function formatToolCallSummary(tool: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined
  switch (tool) {
    case 'literature-search': {
      const query = (a?.query as string) || ''
      return `Search: ${query.slice(0, 40)}${query.length > 40 ? '...' : ''}`
    }
    case 'data-analyze': {
      const file = getFileName((a?.filePath as string) || '')
      return `Analyze: ${file || 'data'}`
    }
    case 'read': {
      const file = getFileName((a?.path as string) || (a?.file as string) || '')
      return `Read ${file}`
    }
    case 'write': {
      const file = getFileName((a?.path as string) || (a?.file as string) || '')
      return `Write ${file}`
    }
    case 'edit': {
      const file = getFileName((a?.path as string) || (a?.file as string) || '')
      return `Edit ${file}`
    }
    case 'glob': {
      const pattern = (a?.pattern as string) || ''
      return `Glob ${pattern}`
    }
    case 'grep': {
      const pattern = (a?.pattern as string) || ''
      return `Grep "${pattern.slice(0, 30)}${pattern.length > 30 ? '...' : ''}"`
    }
    case 'bash': {
      const cmd = (a?.command as string) || ''
      // Show first meaningful part of command
      const shortCmd = cmd.split('\n')[0].slice(0, 40)
      return `Run: ${shortCmd}${cmd.length > 40 ? '...' : ''}`
    }
    case 'memory-put':
    case 'ctx-set': {
      const key = (a?.key as string) || ''
      return key ? `Store: ${key.slice(0, 40)}` : 'Store memory'
    }
    case 'memory-get':
    case 'ctx-get': {
      const key = (a?.key as string) || (a?.query as string) || ''
      return key ? `Recall: ${key.slice(0, 40)}` : 'Recall memory'
    }
    case 'ctx-expand': {
      const seg = (a?.segment as string) || (a?.query as string) || ''
      return `Expand: ${seg.slice(0, 40)}`
    }
    case 'fetch': {
      const url = (a?.url as string) || ''
      // Extract domain or filename
      try {
        const u = new URL(url)
        return `Fetch: ${u.hostname}`
      } catch {
        return `Fetch: ${url.slice(0, 40)}`
      }
    }
    case 'convert_to_markdown': {
      const uri = (a?.uri as string) || ''
      const filename = getFileName(uri)
      return `Convert: ${filename}`
    }
    case 'save-note': {
      const title = (a?.title as string) || 'note'
      return `Save note: ${title.slice(0, 35)}`
    }
    case 'save-paper': {
      const title = (a?.title as string) || 'paper'
      return `Save paper: ${title.slice(0, 35)}`
    }
    default:
      if (tool.startsWith('todo-')) {
        const action = tool.replace('todo-', '')
        const subject = (a?.subject as string) || (a?.id as string) || ''
        return subject ? `Task ${action}: ${subject.slice(0, 40)}` : `Task ${action}`
      }
      return tool
  }
}

/** Format a short summary for a tool result activity event */
function formatToolResultSummary(tool: string, result: unknown, args?: unknown): string {
  const r = result as Record<string, unknown> | undefined
  const a = args as Record<string, unknown> | undefined
  const success = r?.success !== false
  if (!success) {
    const error = (r?.error as string) || 'failed'
    return `Failed: ${error.slice(0, 50)}`
  }
  switch (tool) {
    case 'literature-search': {
      const data = r?.data as Record<string, unknown> | undefined
      const local = data?.localPapersUsed as number | undefined
      const external = data?.externalPapersUsed as number | undefined
      const saved = data?.savedPapers as number | undefined
      let summary = 'Search done'
      if (typeof local === 'number' && typeof external === 'number') {
        summary = `Found ${local + external} papers`
        if (local > 0) summary += ` (${local} local)`
      }
      if (saved && saved > 0) summary += `, saved ${saved}`
      return summary
    }
    case 'read': {
      const data = r?.data as Record<string, unknown> | undefined
      const content = (data?.content as string) || ''
      const lines = content.split('\n').length
      const file = getFileName((a?.path as string) || (a?.file as string) || '')
      return `Read ${file} (${lines} lines)`
    }
    case 'write': {
      const data = r?.data as Record<string, unknown> | undefined
      const file = getFileName((data?.path as string) || (a?.path as string) || '')
      return `Wrote ${file}`
    }
    case 'edit': {
      const file = getFileName((a?.path as string) || (a?.file as string) || '')
      return `Edited ${file}`
    }
    case 'bash': {
      const cmd = (a?.command as string) || ''
      const shortCmd = cmd.split(/[\n|&;]/)[0].trim().slice(0, 25)
      const data = r?.data as Record<string, unknown> | undefined
      const output = (data?.output as string) || (data?.stdout as string) || ''
      const lines = output.split('\n').filter(Boolean).length
      return lines > 0 ? `${shortCmd}: ${lines} lines` : `${shortCmd}: done`
    }
    case 'memory-put':
    case 'ctx-set': {
      const key = (a?.key as string) || ''
      return key ? `Stored "${key.slice(0, 30)}"` : 'Stored memory'
    }
    case 'memory-get':
    case 'ctx-get': {
      const key = (a?.key as string) || (a?.query as string) || ''
      const data = r?.data as Record<string, unknown> | undefined
      const value = data?.value || data?.content
      const keyPart = key ? `"${key.slice(0, 25)}"` : 'memory'
      return value ? `Recalled ${keyPart}` : `${keyPart}: not found`
    }
    case 'ctx-expand': {
      const seg = (a?.segment as string) || (a?.query as string) || ''
      return seg ? `Expanded "${seg.slice(0, 30)}"` : 'Expanded context'
    }
    case 'glob': {
      const pattern = (a?.pattern as string) || ''
      const data = r?.data as Record<string, unknown> | undefined
      const files = (data?.files as string[]) || (data?.matches as string[]) || []
      return `${pattern}: ${files.length} files`
    }
    case 'grep': {
      const pattern = (a?.pattern as string) || ''
      const data = r?.data as Record<string, unknown> | undefined
      const matches = (data?.matches as unknown[]) || (data?.results as unknown[]) || []
      return `"${pattern.slice(0, 20)}": ${matches.length} matches`
    }
    case 'fetch': {
      const url = (a?.url as string) || ''
      try {
        const u = new URL(url)
        return `Fetched ${u.hostname}`
      } catch {
        return 'Fetched URL'
      }
    }
    case 'convert_to_markdown': {
      const uri = (a?.uri as string) || ''
      const file = getFileName(uri)
      return `Converted ${file}`
    }
    case 'save-note': {
      const data = r?.data as Record<string, unknown> | undefined
      const title = (data?.title as string) || ''
      return title ? `Saved note: ${title.slice(0, 30)}` : 'Saved note'
    }
    case 'save-paper': {
      const data = r?.data as Record<string, unknown> | undefined
      const title = (data?.title as string) || ''
      return title ? `Saved paper: ${title.slice(0, 30)}` : 'Saved paper'
    }
    default:
      if (tool.startsWith('todo-')) {
        const action = tool.replace('todo-', '')
        const data = r?.data as Record<string, unknown> | undefined
        const item = (data ?? r?.item ?? r) as Record<string, unknown> | undefined
        const subject = (item?.subject as string) || (item?.id as string) || ''
        if (action === 'add') return subject ? `Task added: ${subject.slice(0, 35)}` : 'Task added'
        if (action === 'complete') return subject ? `Task done: ${subject.slice(0, 35)}` : 'Task done'
        if (action === 'remove') return subject ? `Task removed: ${subject.slice(0, 35)}` : 'Task removed'
        return subject ? `Task updated: ${subject.slice(0, 35)}` : 'Task updated'
      }
      return `${tool}: done`
  }
}

export function registerIpcHandlers(win: BrowserWindow): void {
  // Agent chat
  ipcMain.handle('agent:send', async (_e, message: string, rawMentions?: string, model?: string) => {
    if (!projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      win.webContents.send('agent:done', errResult)
      return errResult
    }

    const coord = await ensureCoordinator(win, model)
    win.webContents.send('agent:todo-clear')
    let mentions: any[] = []
    if (rawMentions) {
      const parsed = parseMentions(rawMentions)
      if (parsed.mentions.length > 0) {
        mentions = await resolveMentions(parsed.mentions, projectPath)
      }
    }
    try {
      const result = await coord.chat(message, mentions)
      win.webContents.send('agent:done', result)
      return result
    } catch (err: any) {
      const errResult = { success: false, error: err.message }
      win.webContents.send('agent:done', errResult)
      return errResult
    }
  })

  // Commands - entities
  ipcMain.handle('cmd:list-notes', () => {
    if (!projectPath) return []
    return listNotes(projectPath)
  })
  ipcMain.handle('cmd:list-literature', () => {
    if (!projectPath) return []
    return listLiterature(projectPath)
  })
  ipcMain.handle('cmd:list-data', () => {
    if (!projectPath) return []
    return listData(projectPath)
  })
  ipcMain.handle('cmd:search', (_e, query: string) => {
    if (!projectPath) return []
    return searchEntities(query, projectPath)
  })
  ipcMain.handle('cmd:delete', (_e, id: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return deleteEntity(id, projectPath)
  })

  // Commands - rename note
  ipcMain.handle('cmd:rename-note', (_e, id: string, newTitle: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const filePath = join(projectPath, PATHS.notes, `${id}.json`)
    if (!existsSync(filePath)) return { success: false, error: 'Note not found.' }
    try {
      const note = JSON.parse(readFileSync(filePath, 'utf-8'))
      note.title = newTitle
      note.updatedAt = new Date().toISOString()
      writeFileSync(filePath, JSON.stringify(note, null, 2))
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Commands - save
  // saveNote signature: saveNote(title, content, tags, context, fromLast)
  ipcMain.handle('cmd:save-note', (_e, title: string, content: string, messageId?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return saveNote(title, content, [], { sessionId, projectPath, lastAgentResponse: '' }, false, messageId)
  })
  ipcMain.handle('cmd:save-paper', (_e, argsStr: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSavePaperArgs(argsStr)
    return savePaper({ ...args, projectPath, sessionId })
  })
  ipcMain.handle('cmd:save-data', (_e, argsStr: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const args = parseSaveDataArgs(argsStr)
    return saveData({ ...args, projectPath, sessionId })
  })

  // Commands - select/pin
  ipcMain.handle('cmd:select', (_e, id: string) => {
    if (!projectPath) return null
    return toggleSelect(id, projectPath)
  })
  ipcMain.handle('cmd:get-selected', () => {
    if (!projectPath) return []
    return getSelected(projectPath)
  })
  ipcMain.handle('cmd:clear-selections', () => {
    if (!projectPath) return null
    return clearSelections(projectPath)
  })
  ipcMain.handle('cmd:pin', (_e, id: string) => {
    if (!projectPath) return null
    return togglePin(id, projectPath)
  })
  ipcMain.handle('cmd:get-pinned', () => {
    if (!projectPath) return []
    return getPinned(projectPath)
  })

  // Memory items
  ipcMain.handle('cmd:list-memory', async () => {
    const storage = await getMemoryStorage()
    if (!storage) return []
    const { items } = await storage.list({ status: 'active', limit: 200 })
    // Filter out 'research' namespace (entity-sync mirrors)
    return items
      .filter((item: MemoryItem) => item.namespace !== 'research')
      .map((item: MemoryItem) => ({
        id: item.id,
        type: 'memory' as const,
        title: item.key,
        pinned: item.tags.includes('pinned'),
        selectedForAI: item.tags.includes('selected'),
        namespace: item.namespace,
        valueText: item.valueText,
        createdAt: item.createdAt
      }))
  })

  ipcMain.handle('cmd:memory-pin', async (_e, id: string) => {
    const storage = await getMemoryStorage()
    if (!storage) return null
    const { items } = await storage.list({ status: 'active', limit: 500 })
    const item = items.find((i: MemoryItem) => i.id === id)
    if (!item) return null
    const newTags = item.tags.includes('pinned')
      ? item.tags.filter((t: string) => t !== 'pinned')
      : [...item.tags, 'pinned']
    return storage.update(item.namespace, item.key, { tags: newTags })
  })

  ipcMain.handle('cmd:memory-select', async (_e, id: string) => {
    const storage = await getMemoryStorage()
    if (!storage) return null
    const { items } = await storage.list({ status: 'active', limit: 500 })
    const item = items.find((i: MemoryItem) => i.id === id)
    if (!item) return null
    const newTags = item.tags.includes('selected')
      ? item.tags.filter((t: string) => t !== 'selected')
      : [...item.tags, 'selected']
    return storage.update(item.namespace, item.key, { tags: newTags })
  })

  ipcMain.handle('cmd:memory-delete', async (_e, id: string) => {
    const storage = await getMemoryStorage()
    if (!storage) return false
    const { items } = await storage.list({ status: 'active', limit: 500 })
    const item = items.find((i: MemoryItem) => i.id === id)
    if (!item) return false
    return storage.delete(item.namespace, item.key)
  })

  // Mentions — signature: getCandidates(projectPath, typeFilter?, query?)
  ipcMain.handle('mention:candidates', (_e, query: string, type?: string) => {
    if (!projectPath) return []
    try {
      return getCandidates(projectPath, type as any, query)
    } catch {
      return []
    }
  })

  // List files in the project root folder (non-recursive, files only)
  ipcMain.handle('file:list-root', () => {
    if (!projectPath) return []
    try {
      const entries = readdirSync(projectPath)
      const files: { path: string; name: string }[] = []
      for (const entry of entries) {
        // Skip hidden directories/files like .research-pilot, .git, etc.
        if (entry.startsWith('.')) continue
        const fullPath = join(projectPath, entry)
        try {
          if (statSync(fullPath).isFile()) {
            files.push({ path: fullPath, name: entry })
          }
        } catch {
          // Skip files we can't stat
        }
      }
      return files
    } catch {
      return []
    }
  })

  // File reading for working folder preview
  ipcMain.handle('file:read', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      const content = readFileSync(absPath, 'utf-8')
      return { success: true, content, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Session - chat history persistence
  ipcMain.handle('session:save-message', (_e, sid: string, msg: any) => {
    if (!projectPath) return
    const dir = join(projectPath, PATHS.sessions)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sid}.jsonl`)
    appendFileSync(file, JSON.stringify(msg) + '\n')
  })

  ipcMain.handle('session:load-messages', (_e, sid: string, offset: number, limit: number) => {
    if (!projectPath) return []
    const file = join(projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    // offset=0 means most recent batch; we read from the end
    const start = Math.max(0, lines.length - offset - limit)
    const end = lines.length - offset
    return lines.slice(start, end).map((l) => JSON.parse(l))
  })

  ipcMain.handle('session:get-total-count', (_e, sid: string) => {
    if (!projectPath) return 0
    const file = join(projectPath, PATHS.sessions, `${sid}.jsonl`)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).length
  })

  ipcMain.handle('session:mark-saved', (_e, sid: string, messageId: string) => {
    if (!projectPath) return
    const file = join(projectPath, PATHS.sessions, `${sid}.saved.json`)
    let ids: string[] = []
    if (existsSync(file)) {
      try { ids = JSON.parse(readFileSync(file, 'utf-8')) } catch { ids = [] }
    }
    if (!ids.includes(messageId)) {
      ids.push(messageId)
      writeFileSync(file, JSON.stringify(ids))
    }
  })

  ipcMain.handle('session:load-saved-ids', (_e, sid: string) => {
    if (!projectPath) return []
    const file = join(projectPath, PATHS.sessions, `${sid}.saved.json`)
    if (!existsSync(file)) return []
    try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return [] }
  })

  // Session
  ipcMain.handle('session:current', () => ({ sessionId, projectPath }))

  // Project - pick folder and initialize
  ipcMain.handle('project:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      projectPath = result.filePaths[0]
      // Initialize .research-pilot directory structure
      initializeProject(projectPath)
      // Reset coordinator and memory storage for new project
      if (coordinator) {
        await coordinator.destroy()
        coordinator = null
      }
      memoryStorage = null
      memoryInitPromise = null
      // Reuse persistent session ID for this project folder
      sessionId = loadOrCreateSessionId(projectPath)
      return { projectPath, sessionId }
    }
    return null
  })
}
