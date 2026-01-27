import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { createCoordinator, type CoordinatorConfig } from '@research-pilot/agents/coordinator'
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
import { PATHS, type ProjectConfig } from '@research-pilot/types'

let coordinator: ReturnType<typeof createCoordinator> | null = null
// Start with empty project path — user must select a folder
let projectPath = ''
let sessionId = crypto.randomUUID()

/** Initialize .research-pilot directory structure in the project folder */
function initializeProject(path: string): void {
  const dirs = [PATHS.root, PATHS.notes, PATHS.literature, PATHS.data, PATHS.sessions]

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

function ensureCoordinator(win: BrowserWindow) {
  if (!coordinator) {
    const apiKey = process.env.OPENAI_API_KEY || ''
    coordinator = createCoordinator({
      apiKey,
      projectPath,
      onStream: (chunk: string) => {
        win.webContents.send('agent:stream-chunk', chunk)
      },
      onToolResult: (tool: string, result: unknown) => {
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
      }
    })
  }
  return coordinator
}

export function registerIpcHandlers(win: BrowserWindow): void {
  // Agent chat
  ipcMain.handle('agent:send', async (_e, message: string, rawMentions?: string) => {
    if (!projectPath) {
      const errResult = { success: false, error: 'No project folder selected. Please select a folder first.' }
      win.webContents.send('agent:done', errResult)
      return errResult
    }

    const coord = ensureCoordinator(win)
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
      // Reset coordinator for new project
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
}
