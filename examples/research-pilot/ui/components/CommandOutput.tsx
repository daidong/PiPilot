/**
 * CommandOutput Component - Renders structured command results
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { NoteListItem, LiteratureListItem, DataListItem, SearchResult } from '../../commands/index.js'
import type { SelectResult, SelectedEntity, PinResult, PinnedEntity } from '../../commands/index.js'
import type { SaveNoteResult, SavePaperResult, SaveDataResult, DeleteResult } from '../../commands/index.js'

export type CommandResult =
  | { type: 'notes'; items: NoteListItem[] }
  | { type: 'literature'; items: LiteratureListItem[] }
  | { type: 'data'; items: DataListItem[] }
  | { type: 'search'; query: string; items: SearchResult[] }
  | { type: 'select'; result: SelectResult }
  | { type: 'select-list'; items: SelectedEntity[] }
  | { type: 'select-clear'; count: number }
  | { type: 'pin'; result: PinResult }
  | { type: 'pin-list'; items: PinnedEntity[] }
  | { type: 'save-note'; result: SaveNoteResult }
  | { type: 'save-paper'; result: SavePaperResult }
  | { type: 'save-data'; result: SaveDataResult }
  | { type: 'delete'; result: DeleteResult }
  | { type: 'help' }
  | { type: 'message'; text: string }
  | { type: 'error'; text: string }
  | null

interface CommandOutputProps {
  result: CommandResult
}

function flags(pinned: boolean, selected: boolean): string {
  const f = []
  if (pinned) f.push('pinned')
  if (selected) f.push('selected')
  return f.length > 0 ? ` [${f.join(', ')}]` : ''
}

export const CommandOutput: React.FC<CommandOutputProps> = ({ result }) => {
  if (!result) return null

  switch (result.type) {
    case 'notes': {
      if (result.items.length === 0) return <Text>No notes found.</Text>
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Notes:</Text>
          <Text />
          {result.items.map(n => (
            <Box key={n.id} flexDirection="column">
              <Text>  {n.id.slice(0, 8)}... - {n.title}{flags(n.pinned, n.selectedForAI)}</Text>
              {n.tags.length > 0 && <Text dimColor>    Tags: {n.tags.join(', ')}</Text>}
            </Box>
          ))}
          <Text />
          <Text dimColor>Total: {result.items.length} note(s)</Text>
        </Box>
      )
    }

    case 'literature': {
      if (result.items.length === 0) return <Text>No literature found.</Text>
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Literature:</Text>
          <Text />
          {result.items.map(lit => {
            const authors = lit.authors.slice(0, 2).join(', ')
            const authorStr = lit.authors.length > 2 ? `${authors}, et al.` : authors
            return (
              <Box key={lit.id} flexDirection="column">
                <Text>  [{lit.citeKey}] {lit.title}{flags(lit.pinned, lit.selectedForAI)}</Text>
                <Text dimColor>    {authorStr} ({lit.year ?? 'n.d.'})</Text>
              </Box>
            )
          })}
          <Text />
          <Text dimColor>Total: {result.items.length} paper(s)</Text>
        </Box>
      )
    }

    case 'data': {
      if (result.items.length === 0) return <Text>No data files found.</Text>
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Data Files:</Text>
          <Text />
          {result.items.map(d => (
            <Box key={d.id} flexDirection="column">
              <Text>  {d.id.slice(0, 8)}... - {d.name}{flags(d.pinned, d.selectedForAI)}</Text>
              {d.rowCount != null && <Text dimColor>    Rows: {d.rowCount}</Text>}
            </Box>
          ))}
          <Text />
          <Text dimColor>Total: {result.items.length} file(s)</Text>
        </Box>
      )
    }

    case 'search': {
      if (result.items.length === 0) return <Text>No results found for "{result.query}"</Text>
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Search results for "{result.query}":</Text>
          <Text />
          {result.items.map((r, i) => (
            <Box key={i} flexDirection="column">
              <Text>  [{r.type}] {r.id}... - {r.title}</Text>
              <Text dimColor>    Match: {r.match}</Text>
            </Box>
          ))}
          <Text />
          <Text dimColor>Total: {result.items.length} result(s)</Text>
        </Box>
      )
    }

    case 'select': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      const status = r.selected ? 'selected for AI context' : 'removed from AI context'
      return <Text color="green">✓ {r.entityType} "{r.title}" {status}</Text>
    }

    case 'select-list': {
      if (result.items.length === 0) {
        return (
          <Box flexDirection="column">
            <Text>No entities selected for AI context.</Text>
            <Text dimColor>Use /select {'<id>'} to select entities.</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Selected entities for AI context:</Text>
          <Text />
          {result.items.map((item, i) => (
            <Text key={i}>  [{item.type}] {item.id}... - {item.title}</Text>
          ))}
          <Text />
          <Text dimColor>Total: {result.items.length} selected</Text>
        </Box>
      )
    }

    case 'select-clear':
      return <Text color="green">✓ Cleared {result.count} selection(s)</Text>

    case 'pin': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      const status = r.pinned ? 'pinned (always in context)' : 'unpinned'
      return <Text color="green">✓ {r.entityType} "{r.title}" {status}</Text>
    }

    case 'pin-list': {
      if (result.items.length === 0) {
        return (
          <Box flexDirection="column">
            <Text>No entities pinned.</Text>
            <Text dimColor>Use /pin {'<id>'} to pin entities (always included in context).</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Pinned entities (always in context):</Text>
          <Text />
          {result.items.map((item, i) => (
            <Text key={i}>  [{item.type}] {item.id}... - {item.title}</Text>
          ))}
          <Text />
          <Text dimColor>Total: {result.items.length} pinned</Text>
        </Box>
      )
    }

    case 'save-note': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Note saved: {r.filePath}</Text>
          <Text>  Title: {r.note!.title}</Text>
          <Text>  Tags: {r.note!.tags.length > 0 ? r.note!.tags.join(', ') : '(none)'}</Text>
        </Box>
      )
    }

    case 'save-paper': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Paper saved: {r.filePath}</Text>
          <Text>  Title: {r.paper!.title}</Text>
          <Text>  Authors: {r.paper!.authors.join(', ')}</Text>
          <Text>  CiteKey: {r.paper!.citeKey}</Text>
        </Box>
      )
    }

    case 'save-data': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Data registered: {r.filePath}</Text>
          <Text>  Name: {r.data!.name}</Text>
          <Text>  File: {r.data!.filePath}</Text>
        </Box>
      )
    }

    case 'delete': {
      const r = result.result
      if (!r.success) return <Text color="red">{r.error}</Text>
      return <Text color="green">✓ Deleted {r.entityType} "{r.title}"</Text>
    }

    case 'help':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Research Pilot - Commands</Text>
          <Text />
          <Text bold>Navigation:</Text>
          <Text>  /notes              List all notes</Text>
          <Text>  /papers             List all literature</Text>
          <Text>  /data               List all data files</Text>
          <Text>  /search {'<query>'}     Search across all entities</Text>
          <Text />
          <Text bold>Entity Management:</Text>
          <Text>  /save-note          Save content as a note</Text>
          <Text>  /save-note --from-last                Pre-fill with last response</Text>
          <Text>  /save-note --from-last --lines 5-12   Extract specific lines</Text>
          <Text>  /save-paper {'<title>'} [--authors "A, B"] [--year N]   Save a paper</Text>
          <Text>  /save-data {'<name>'} --path {'<file>'} [--rows N]       Register a data file</Text>
          <Text>  /delete {'<id>'}        Delete any entity</Text>
          <Text>  /select {'<id>'}        Toggle AI context selection</Text>
          <Text>  /select --list      List selected entities</Text>
          <Text>  /select --clear     Clear all selections</Text>
          <Text>  /pin {'<id>'}           Toggle pinned status</Text>
          <Text>  /pin --list         List pinned entities</Text>
          <Text />
          <Text bold>Agents:</Text>
          <Text>  /lit-search {'<query>'} Search for academic literature</Text>
          <Text>  (just type)         Chat with the coordinator agent</Text>
          <Text />
          <Text bold>Other:</Text>
          <Text>  /debug              Toggle debug mode</Text>
          <Text>  /help               Show this help</Text>
          <Text>  /exit               Exit the application</Text>
        </Box>
      )

    case 'message':
      return <Text>{result.text}</Text>

    case 'error':
      return <Text color="red">{result.text}</Text>
  }
}
