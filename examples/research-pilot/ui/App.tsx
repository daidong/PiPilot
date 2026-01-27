/**
 * App Component - Root Ink component for Research Pilot
 */

import React, { useState, useMemo, useCallback } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { Banner } from './components/Banner.js'
import { AgentResponse } from './components/AgentResponse.js'
import { CommandOutput, CommandResult } from './components/CommandOutput.js'
import { InputBar } from './components/InputBar.js'
import { ActivityPanel } from './components/ActivityPanel.js'
import { EntityPreview } from './components/EntityPreview.js'
import { LineStore } from './LineStore.js'
import { useAgent } from './hooks/useAgent.js'
import {
  listNotes, listLiterature, listData, searchEntities,
  toggleSelect, getSelected, clearSelections,
  togglePin, getPinned,
  saveNote, getSaveNoteContent,
  savePaper, parseSavePaperArgs,
  saveData, parseSaveDataArgs,
  deleteEntity
} from '../commands/index.js'
import type { SelectedEntity } from '../commands/index.js'
import { createLiteratureAgent } from '../agents/literature-agent.js'
import { parseMentions, resolveMentions } from '../mentions/index.js'
import type { Entity } from '../types.js'

interface AppProps {
  apiKey: string
  projectPath: string
  debug: boolean
  sessionId: string
}

export const App: React.FC<AppProps> = ({ apiKey, projectPath, debug: initialDebug, sessionId }) => {
  const { exit } = useApp()
  const lineStore = useMemo(() => new LineStore(), [])
  const [commandResult, setCommandResult] = useState<CommandResult>(null)
  const [debug, setDebug] = useState(initialDebug)
  const [panelFocused, setPanelFocused] = useState(false)
  const [previewEntity, setPreviewEntity] = useState<Entity | null>(null)
  const [panelRefreshKey, setPanelRefreshKey] = useState(0)

  const { isStreaming, lastResponse, send } = useAgent({
    apiKey,
    projectPath,
    debug,
    lineStore
  })

  // Force-refresh activity panel data from disk
  const refreshSidebar = useCallback(() => {
    setPanelRefreshKey(k => k + 1)
  }, [])

  // Ctrl+R toggles right panel focus, Esc closes preview or unfocuses panel
  useInput((_input, key) => {
    if (_input === 'r' && key.ctrl) {
      if (previewEntity) return // don't toggle while preview open
      setPanelFocused(f => !f)
      return
    }
    if (key.escape) {
      if (previewEntity) {
        setPreviewEntity(null)
        return
      }
      if (panelFocused) {
        setPanelFocused(false)
        return
      }
    }
  })

  const handleInput = useCallback(async (input: string) => {
    const trimmed = input.trim()

    // Exit commands
    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
      exit()
      return
    }

    // Help
    if (trimmed === '/help' || trimmed === '/?') {
      setCommandResult({ type: 'help' })
      return
    }

    // List commands
    if (trimmed === '/notes') {
      setCommandResult({ type: 'notes', items: listNotes(projectPath) })
      return
    }
    if (trimmed === '/papers' || trimmed === '/literature') {
      setCommandResult({ type: 'literature', items: listLiterature(projectPath) })
      return
    }
    if (trimmed === '/data') {
      setCommandResult({ type: 'data', items: listData(projectPath) })
      return
    }

    // Search
    if (trimmed.startsWith('/search ')) {
      const query = trimmed.slice(8).trim()
      if (query) {
        setCommandResult({ type: 'search', query, items: searchEntities(projectPath, query) })
      } else {
        setCommandResult({ type: 'message', text: 'Usage: /search <query>' })
      }
      return
    }

    // Save note (simplified for Ink - uses args for content extraction)
    if (trimmed.startsWith('/save-note')) {
      const args = trimmed.slice(10).trim().split(/\s+/).filter(Boolean)
      const { content, error } = getSaveNoteContent(args, lastResponse, lineStore)
      if (error) {
        setCommandResult({ type: 'error', text: error })
        return
      }
      if (!content) {
        setCommandResult({ type: 'message', text: 'Usage: /save-note --from-last [--lines N-M]\nContent required. Use --from-last to capture agent response.' })
        return
      }
      // Auto-generate title from first line
      const title = content.split('\n')[0].slice(0, 80) || 'Untitled Note'
      const result = saveNote(title, content, [], {
        sessionId,
        projectPath,
        lastAgentResponse: lastResponse,
        debug
      }, args.includes('--from-last'))
      setCommandResult({ type: 'save-note', result })
      refreshSidebar()
      return
    }

    // Save paper
    if (trimmed.startsWith('/save-paper')) {
      const raw = trimmed.slice(11).trim()
      if (!raw) {
        setCommandResult({ type: 'message', text: 'Usage: /save-paper <title> [--authors "A, B"] [--year N] [--abstract "..."] [--citekey key]' })
        return
      }
      const parsed = parseSavePaperArgs(raw)
      const result = savePaper(parsed.title, parsed, {
        sessionId,
        projectPath,
        lastAgentResponse: lastResponse,
        debug
      })
      setCommandResult({ type: 'save-paper', result })
      refreshSidebar()
      return
    }

    // Save data
    if (trimmed.startsWith('/save-data')) {
      const raw = trimmed.slice(10).trim()
      if (!raw) {
        setCommandResult({ type: 'message', text: 'Usage: /save-data <name> --path <file> [--mime type] [--rows N] [--tags "a, b"]' })
        return
      }
      const parsed = parseSaveDataArgs(raw)
      const result = saveData(parsed.name, parsed, {
        sessionId,
        projectPath,
        lastAgentResponse: lastResponse,
        debug
      })
      setCommandResult({ type: 'save-data', result })
      refreshSidebar()
      return
    }

    // Delete entity
    if (trimmed.startsWith('/delete')) {
      const entityId = trimmed.slice(7).trim()
      if (!entityId) {
        setCommandResult({ type: 'message', text: 'Usage: /delete <id>' })
        return
      }
      const result = deleteEntity(entityId)
      setCommandResult({ type: 'delete', result })
      refreshSidebar()
      return
    }

    // Select
    if (trimmed.startsWith('/select')) {
      const args = trimmed.slice(7).trim().split(/\s+/).filter(Boolean)
      if (args.includes('--list')) {
        setCommandResult({ type: 'select-list', items: getSelected() })
        return
      }
      if (args.includes('--clear')) {
        const count = clearSelections()
        setCommandResult({ type: 'select-clear', count })
        refreshSidebar()
        return
      }
      const entityId = args[0]
      if (!entityId) {
        setCommandResult({ type: 'message', text: 'Usage: /select <id> | /select --list | /select --clear' })
        return
      }
      setCommandResult({ type: 'select', result: toggleSelect(entityId) })
      refreshSidebar()
      return
    }

    // Pin
    if (trimmed.startsWith('/pin')) {
      const args = trimmed.slice(4).trim().split(/\s+/).filter(Boolean)
      if (args.includes('--list')) {
        setCommandResult({ type: 'pin-list', items: getPinned() })
        return
      }
      const entityId = args[0]
      if (!entityId) {
        setCommandResult({ type: 'message', text: 'Usage: /pin <id> | /pin --list' })
        return
      }
      setCommandResult({ type: 'pin', result: togglePin(entityId) })
      refreshSidebar()
      return
    }

    // Literature search
    if (trimmed.startsWith('/lit-search ')) {
      const query = trimmed.slice(12).trim()
      if (!query) {
        setCommandResult({ type: 'message', text: 'Usage: /lit-search <query>' })
        return
      }
      setCommandResult({ type: 'message', text: 'Starting literature search...' })
      try {
        const litAgent = createLiteratureAgent({ apiKey })
        const result = await litAgent.search(query)
        if (result.success && result.summary) {
          const text = [
            '='.repeat(60),
            `Title: ${result.summary.title}`,
            '='.repeat(60),
            '',
            'Overview:',
            result.summary.overview,
            '',
            ...(result.summary.papers.length > 0
              ? ['Papers found:', ...result.summary.papers.slice(0, 5).map(
                  (p: { title: string; year: number; authors: string }) =>
                    `  - ${p.title} (${p.year})\n    ${p.authors}`
                )]
              : []),
            '',
            `Duration: ${(result.durationMs / 1000).toFixed(1)}s`
          ].join('\n')
          lineStore.append(text)
          setCommandResult({ type: 'message', text: '' })
        } else {
          setCommandResult({ type: 'error', text: `Search failed: ${result.error}` })
        }
      } catch (error) {
        setCommandResult({ type: 'error', text: `Search failed: ${error}` })
      }
      return
    }

    // Debug toggle
    if (trimmed === '/debug') {
      setDebug(d => !d)
      setCommandResult({ type: 'message', text: `Debug mode: ${!debug ? 'ON' : 'OFF'}` })
      return
    }

    // Unknown command
    if (trimmed.startsWith('/')) {
      setCommandResult({ type: 'error', text: `Unknown command: ${trimmed}\nType /help for available commands.` })
      return
    }

    // Chat with agent — parse @-mentions first
    setCommandResult(null)
    const { cleanMessage, mentions } = parseMentions(trimmed)
    if (mentions.length > 0) {
      const resolved = await resolveMentions(mentions, projectPath)
      const errors = resolved.filter(r => r.error)
      if (errors.length > 0 && errors.length === resolved.length) {
        // All mentions failed — show error but still send
        setCommandResult({ type: 'error', text: errors.map(e => `${e.ref.raw}: ${e.error}`).join('\n') })
      }
      await send(cleanMessage, resolved)
    } else {
      await send(trimmed)
    }
  }, [projectPath, lastResponse, lineStore, sessionId, debug, send, exit, refreshSidebar, apiKey])

  // When preview is open, it overlaps the main view
  if (previewEntity) {
    return (
      <Box flexDirection="row">
        <EntityPreview entity={previewEntity} onClose={() => setPreviewEntity(null)} />
        <ActivityPanel
          projectPath={projectPath}
          focused={false}
          onPreview={setPreviewEntity}
          refreshKey={panelRefreshKey}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1}>
        <Banner sessionId={sessionId} projectPath={projectPath} debug={debug} />
        <AgentResponse lines={lineStore.getAll()} isStreaming={isStreaming} />
        <CommandOutput result={commandResult} />
        <InputBar onSubmit={handleInput} isStreaming={isStreaming} projectPath={projectPath} />
        {!panelFocused && (
          <Text dimColor>Ctrl+R: open activity panel</Text>
        )}
      </Box>
      <ActivityPanel
        projectPath={projectPath}
        focused={panelFocused}
        onPreview={setPreviewEntity}
        refreshKey={panelRefreshKey}
      />
    </Box>
  )
}
