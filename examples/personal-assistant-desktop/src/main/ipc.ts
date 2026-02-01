import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { createCoordinator, type CoordinatorConfig } from '@personal-assistant/agents/coordinator'
import {
  listNotes, listDocs,
  searchEntities, deleteEntity,
  toggleSelect, getSelected, clearSelections,
  togglePin, getPinned
} from '@personal-assistant/commands/index'
import { saveNote } from '@personal-assistant/commands/save-note'
import { saveDoc } from '@personal-assistant/commands/save-doc'
import { parseMentions, resolveMentions, getCandidates } from '@personal-assistant/mentions/index'
import { setCachedMarkdown, fileUriToPath } from '@personal-assistant/mentions/document-cache'
import { PATHS, type ProjectConfig } from '@personal-assistant/types'
import { Scheduler } from '@personal-assistant/scheduler/scheduler'
import { NotificationStore } from '@personal-assistant/scheduler/notifications'
import { createActivityFormatter } from '../../../../src/trace/activity-formatter.js'
import { realtimeBuffer } from './realtime-buffer'

/** Extract just the filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

const fmt = createActivityFormatter({
  // Lazy getter: registry becomes available after coordinator is created
  toolRegistry: () => coordinator?.agent?.runtime?.toolRegistry,
  customRules: [
    {
      match: 'convert_to_markdown',
      formatCall: (_, a) => ({ label: `Convert: ${getFileName((a.uri as string) || '')}`, icon: 'file' }),
      formatResult: (_, _r, a) => ({ label: `Converted ${getFileName((a?.uri as string) || '')}`, icon: 'file' }),
    },
    {
      match: 'save-note',
      formatCall: (_, a) => ({ label: `Save note: ${((a.title as string) || 'note').slice(0, 35)}`, icon: 'file' }),
      formatResult: (_, r) => {
        const title = ((r.data as any)?.title as string) || ''
        return { label: title ? `Saved note: ${title.slice(0, 30)}` : 'Saved note', icon: 'file' }
      }
    },
    {
      match: 'save-doc',
      formatCall: (_, a) => ({ label: `Save doc: ${((a.title as string) || 'doc').slice(0, 35)}`, icon: 'file' }),
      formatResult: (_, r) => {
        const title = ((r.data as any)?.title as string) || ''
        return { label: title ? `Saved doc: ${title.slice(0, 30)}` : 'Saved doc', icon: 'file' }
      }
    },
  ]
})

let coordinator: ReturnType<typeof createCoordinator> | null = null
let scheduler: Scheduler | null = null
let notificationStore: NotificationStore | null = null
let currentModel = 'gpt-5.2'
// Start with empty project path — user must select a folder
let projectPath = ''
let sessionId = crypto.randomUUID()
let isClosing = false

/** Initialize .personal-assistant directory structure in the project folder */
function initializeProject(path: string): void {
  const dirs = [PATHS.root, PATHS.notes, PATHS.docs, PATHS.memory, PATHS.sessions, PATHS.cache, PATHS.documentCache]

  for (const dir of dirs) {
    const fullPath = join(path, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }
  }

  const projectFile = join(path, PATHS.project)
  if (!existsSync(projectFile)) {
    const defaultConfig: ProjectConfig = {
      name: 'Personal Assistant Project',
      description: 'A new personal assistant project',
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

/** Safely send an IPC message — no-op if the window has been destroyed. */
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

async function ensureCoordinator(win: BrowserWindow, model?: string) {
  if (isClosing) throw new Error('Project is closing')
  const requestedModel = model || currentModel
  // Recreate coordinator if model changed
  if (coordinator && requestedModel !== currentModel) {
    coordinator.destroy().catch(() => {})
    coordinator = null
  }
  currentModel = requestedModel

  if (!coordinator) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || ''

    // Notify UI that we're initializing (includes MCP servers like MarkItDown)
    const initEvent = { type: 'system', summary: 'Initializing agent (first run may take 1-2 minutes for document processing setup)...' }
    realtimeBuffer.pushActivity(initEvent)
    safeSend(win, 'agent:activity', initEvent)

    // Initialize notification store and scheduler before coordinator
    if (!notificationStore) {
      notificationStore = new NotificationStore(projectPath)
    }
    if (!scheduler) {
      scheduler = new Scheduler({
        projectPath,
        onTrigger: async (task) => {
          try {
            const coord = await coordinator
            if (!coord) return
            const result = await coord.chat(`[SCHEDULED: ${task.id}] ${task.instruction}`)
            if (result.success && result.response && notificationStore) {
              const n = notificationStore.add({
                type: 'info',
                title: task.instruction.slice(0, 60),
                body: result.response.slice(0, 500),
                scheduledTaskId: task.id
              })
              safeSend(win, 'notification:new', notificationStore.list())
            }
          } catch (err) {
            console.error(`[Scheduler] onTrigger error for ${task.id}:`, err)
          }
        }
      })
    }

    coordinator = await createCoordinator({
      apiKey,
      model: currentModel,
      projectPath,
      sessionId,
      emailDbPath: process.env.EMAIL_DB_PATH,
      debug: true,
      onStream: (chunk: string) => {
        realtimeBuffer.appendChunk(chunk)
        safeSend(win, 'agent:stream-chunk', chunk)
      },
      onToolCall: (tool: string, args: unknown) => {
        // Send activity event for tool invocation
        const summary = fmt.formatToolCall(tool, args).label
        const event = { type: 'tool-call', tool, summary }
        realtimeBuffer.pushActivity(event)
        safeSend(win, 'agent:activity', event)
      },
      onToolResult: (tool: string, result: unknown, args?: unknown) => {
        if (tool.startsWith('todo-') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.item) {
            realtimeBuffer.upsertProgressItem(r.item)
            safeSend(win, 'agent:todo-update', r.item)
          }
        }

        // Track files created/modified by write and edit tools
        if ((tool === 'write' || tool === 'edit') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success && r.data?.path) {
            safeSend(win, 'agent:file-created', r.data.path)
          }
        }

        // Track extracted markdown files created by convert_to_markdown
        if (tool === 'convert_to_markdown' && result && typeof result === 'object' && 'success' in result) {
          const r2 = result as any
          if (r2.success && r2.data?.outputFile) {
            safeSend(win, 'agent:file-created', r2.data.outputFile)
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

        // Notify UI to refresh entity lists when notes or docs are saved
        if ((tool === 'save-note' || tool === 'save-doc') && result && typeof result === 'object' && 'success' in result) {
          const r = result as any
          if (r.success) {
            safeSend(win, 'agent:entity-created', {
              type: tool === 'save-note' ? 'note' : 'doc',
              id: r.data?.id,
              title: r.data?.title
            })
          }
        }

        // Send activity event for tool result
        const r = result as any
        const success = r?.success !== false
        const error = !success ? (r?.error || 'Unknown error') : undefined
        const summary = fmt.formatToolResult(tool, result, args).label
        const actEvent = { type: 'tool-result', tool, summary, success, error }
        realtimeBuffer.pushActivity(actEvent)
        safeSend(win, 'agent:activity', actEvent)
      }
    })

    // Start scheduler after coordinator is ready
    scheduler?.start()

    // Notify UI that initialization is complete
    const readyEvent = { type: 'system', summary: 'Agent ready' }
    realtimeBuffer.pushActivity(readyEvent)
    safeSend(win, 'agent:activity', readyEvent)
  }
  return coordinator
}


export function registerIpcHandlers(win: BrowserWindow): void {
  // Agent chat
  ipcMain.handle('agent:send', async (_e, message: string, rawMentions?: string, model?: string) => {
    if (!projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }

    const coord = await ensureCoordinator(win, model)
    realtimeBuffer.clearRun()
    safeSend(win, 'agent:todo-clear')
    let mentions: any[] = []
    if (rawMentions) {
      const parsed = parseMentions(rawMentions)
      if (parsed.mentions.length > 0) {
        mentions = await resolveMentions(parsed.mentions, projectPath)
      }
    }
    try {
      const result = await coord.chat(message, mentions)
      realtimeBuffer.finishStreaming()
      safeSend(win, 'agent:done', result)
      return result
    } catch (err: any) {
      realtimeBuffer.finishStreaming()
      const errResult = { success: false, error: err.message }
      safeSend(win, 'agent:done', errResult)
      return errResult
    }
  })

  // Realtime state recovery (renderer calls this on mount to restore lost state)
  ipcMain.handle('agent:get-realtime-snapshot', () => {
    return realtimeBuffer.getSnapshot()
  })

  // Stop running agent
  ipcMain.handle('agent:stop', () => {
    if (coordinator) {
      (coordinator as any).agent.stop()
    }
  })

  // Clear session memory
  ipcMain.handle('agent:clear-memory', async () => {
    if (coordinator) {
      await (coordinator as any).clearSessionMemory()
    }
  })

  // Commands - entities
  ipcMain.handle('cmd:list-notes', () => {
    if (!projectPath) return []
    return listNotes(projectPath)
  })
  ipcMain.handle('cmd:list-docs', () => {
    if (!projectPath) return []
    return listDocs(projectPath)
  })
  ipcMain.handle('cmd:search', (_e, query: string) => {
    if (!projectPath) return []
    return searchEntities(projectPath, query)
  })
  ipcMain.handle('cmd:delete', (_e, id: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return deleteEntity(id, projectPath)
  })

  // Commands - rename note
  ipcMain.handle('cmd:rename-note', (_e, id: string, newTitle: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    // Search across all entity directories
    const dirs = [PATHS.notes, PATHS.docs]
    for (const dir of dirs) {
      const filePath = join(projectPath, dir, `${id}.json`)
      if (!existsSync(filePath)) continue
      try {
        const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
        entity.title = newTitle
        entity.updatedAt = new Date().toISOString()
        writeFileSync(filePath, JSON.stringify(entity, null, 2))
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
    return { success: false, error: 'Entity not found.' }
  })

  // Commands - update entity (title + content)
  ipcMain.handle('cmd:update-entity', (_e, id: string, updates: { title?: string; content?: string }) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    const dirs = [PATHS.notes, PATHS.docs]
    for (const dir of dirs) {
      const filePath = join(projectPath, dir, `${id}.json`)
      if (!existsSync(filePath)) continue
      try {
        const entity = JSON.parse(readFileSync(filePath, 'utf-8'))
        if (updates.title !== undefined) {
          entity.title = updates.title
        }
        if (updates.content !== undefined) {
          if (entity.type === 'doc') {
            entity.description = updates.content
          } else {
            entity.content = updates.content
          }
        }
        entity.updatedAt = new Date().toISOString()
        writeFileSync(filePath, JSON.stringify(entity, null, 2))
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
    return { success: false, error: 'Entity not found.' }
  })

  // Commands - save
  ipcMain.handle('cmd:save-note', (_e, title: string, content: string, messageId?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return saveNote(title, content, [], { sessionId, projectPath, lastAgentResponse: '' }, false, messageId)
  })
  ipcMain.handle('cmd:save-doc', (_e, title: string, filePath: string, content?: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }
    return saveDoc(title, { filePath, content }, { sessionId, projectPath })
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
        // Skip hidden directories/files like .personal-assistant, .git, etc.
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

  // Resolve a file path to an absolute path (for file:// URLs)
  ipcMain.handle('file:resolve-path', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      return { success: true, absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Open a file in the system default application
  ipcMain.handle('file:open-external', (_e, filePath: string) => {
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
    if (!existsSync(absPath)) return { success: false, error: 'File not found' }
    shell.openPath(absPath)
    return { success: true }
  })

  // Binary file reading (images, PDFs) — returns base64
  ipcMain.handle('file:read-binary', (_e, filePath: string) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, error: 'File not found' }
      }
      const buffer = readFileSync(absPath)
      const base64 = buffer.toString('base64')
      const ext = absPath.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        pdf: 'application/pdf'
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      return { success: true, base64, mime, path: absPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Drop file handler — copies file into project and creates entity
  ipcMain.handle('file:drop', async (_e, fileName: string, content: string, tab: string) => {
    if (!projectPath) return { success: false, error: 'No project folder selected.' }

    if (tab === 'notes') {
      // Save text content as a note entity
      const title = fileName.replace(/\.\w+$/, '')
      return saveNote(title, content, [], { sessionId, projectPath, lastAgentResponse: '' }, false)
    }

    if (tab === 'docs') {
      // Write file into .personal-assistant/docs/ and register as doc entity
      const docsDir = join(projectPath, PATHS.docs)
      if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true })
      const destPath = join(docsDir, fileName)
      writeFileSync(destPath, content, 'utf-8')

      const title = fileName.replace(/\.\w+$/, '')
      return saveDoc(title, { filePath: destPath, content }, { sessionId, projectPath })
    }

    return { success: false, error: `Unknown tab: ${tab}` }
  })

  // Notifications
  ipcMain.handle('notification:list', () => {
    return notificationStore?.list() ?? []
  })
  ipcMain.handle('notification:mark-read', (_e, id: string) => {
    notificationStore?.markRead(id)
  })
  ipcMain.handle('notification:mark-all-read', () => {
    notificationStore?.markAllRead()
  })
  ipcMain.handle('notification:unread-count', () => {
    return notificationStore?.unreadCount() ?? 0
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
      // Initialize .personal-assistant directory structure
      initializeProject(projectPath)
      // Reset coordinator and memory storage for new project
      if (coordinator) {
        await coordinator.destroy()
        coordinator = null
      }
      // Reuse persistent session ID for this project folder
      sessionId = loadOrCreateSessionId(projectPath)
      return { projectPath, sessionId }
    }
    return null
  })

  // Close project: stop agent, destroy coordinator, reset state
  ipcMain.handle('project:close', async () => {
    isClosing = true
    try {
      // Stop any running agent
      if (coordinator) {
        try {
          ;(coordinator as any).agent.stop()
        } catch {
          /* agent may not be running */
        }
      }

      // Stop scheduler
      if (scheduler) {
        scheduler.stop()
        scheduler = null
      }
      notificationStore = null

      // Destroy coordinator (agent + MCP servers + subagents)
      if (coordinator) {
        try {
          await coordinator.destroy()
        } catch (err) {
          console.error('[Close] coordinator.destroy() error:', err)
        }
        coordinator = null
      }

      // Reset main-process state
      realtimeBuffer.reset()
      projectPath = ''
      sessionId = crypto.randomUUID()
      currentModel = 'gpt-5.2'
    } finally {
      isClosing = false
    }
  })
}
