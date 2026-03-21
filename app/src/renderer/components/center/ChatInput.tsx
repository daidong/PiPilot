import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square, Folder } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useSessionStore } from '../../stores/session-store'
import { useEntityStore } from '../../stores/entity-store'
import { MentionPopover } from './MentionPopover'
import { CommandPopover } from './CommandPopover'

const SLASH_COMMANDS = [
  { name: '/note', description: 'Create a note artifact', args: '<title>' },
  { name: '/save-paper', description: 'Create a paper artifact', args: '<title> [--authors ...]' },
  { name: '/save-data', description: 'Create a data artifact', args: '<name> --path <file>' },
  { name: '/notes', description: 'List all notes' },
  { name: '/papers', description: 'List all literature' },
  { name: '/data', description: 'List all data attachments' },
  { name: '/search', description: 'Search entities', args: '<query>' },
  { name: '/summary', description: 'Show latest session summary' },
  { name: '/delete', description: 'Delete an entity', args: '<id>' },
  { name: '/help', description: 'Show available commands' }
]

const api = (window as any).api

function parseFlagArgs(raw: string): { cleaned: string; flags: Record<string, string> } {
  const flagPattern = /--(\w+)\s+"([^"]+)"|--(\w+)\s+(\S+)/g
  const flags: Record<string, string> = {}
  let cleaned = raw
  let match: RegExpExecArray | null
  while ((match = flagPattern.exec(raw)) !== null) {
    const key = match[1] || match[3]
    const value = match[2] || match[4]
    flags[key] = value
    cleaned = cleaned.replace(match[0], '')
  }
  return { cleaned: cleaned.trim(), flags }
}

export function ChatInput() {
  const [text, setText] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [showCommand, setShowCommand] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const setIdle = useUIStore((s) => s.setIdle)
  const pickFolder = useSessionStore((s) => s.pickFolder)
  const hasProject = useSessionStore((s) => s.hasProject)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  // Clear draft text when switching projects
  useEffect(() => {
    setText('')
    setShowMention(false)
    setShowCommand(false)
  }, [hasProject])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return

    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed)
      setText('')
      setShowCommand(false)
      return
    }

    setIdle(false)
    send(trimmed)
    setText('')
    setShowMention(false)
    setShowCommand(false)
  }, [text, isStreaming, send, setIdle])

  const handleSlashCommand = async (input: string) => {
    const parts = input.split(/\s+/)
    const cmd = parts[0]
    const rest = parts.slice(1).join(' ')

    useChatStore.getState().messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: Date.now()
    })

    let result: string

    try {
      switch (cmd) {
        case '/notes': {
          const notes = await api.listNotes()
          result = notes?.length
            ? `**Notes (${notes.length}):**\n` + notes.map((n: any) => `- ${n.title} \`${n.id.slice(0, 8)}\``).join('\n')
            : 'No notes yet.'
          break
        }
        case '/papers': {
          const papers = await api.listLiterature()
          result = papers?.length
            ? `**Papers (${papers.length}):**\n` + papers.map((p: any) => `- ${p.title} \`${p.citeKey}\``).join('\n')
            : 'No papers yet.'
          break
        }
        case '/data': {
          const data = await api.listData()
          result = data?.length
            ? `**Data (${data.length}):**\n` + data.map((d: any) => `- ${d.name} \`${d.id.slice(0, 8)}\``).join('\n')
            : 'No data attachments yet.'
          break
        }
        case '/search': {
          if (!rest) { result = 'Usage: `/search <query>`'; break }
          const results = await api.search(rest)
          result = results?.length
            ? `**Search results for "${rest}":**\n` + results.map((r: any) => `- [${r.type}] ${r.title} \`${r.id.slice(0, 8)}\``).join('\n')
            : `No results for "${rest}".`
          break
        }
        case '/note': {
          if (!rest) { result = 'Usage: `/note <title>`'; break }
          const r = await api.artifactCreate({ type: 'note', title: rest, content: '' })
          result = r?.success ? `Note saved: **${rest}**` : `Failed: ${r?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/save-paper': {
          if (!rest) { result = 'Usage: `/save-paper <title> [--authors ...]`'; break }
          const { cleaned, flags } = parseFlagArgs(rest)
          if (!cleaned) { result = 'Usage: `/save-paper <title> [--authors ...]`'; break }
          const authors = flags.authors
            ? flags.authors.split(',').map((a) => a.trim()).filter(Boolean)
            : ['Unknown']
          const parsedYear = flags.year ? parseInt(flags.year, 10) : NaN
          const year = Number.isFinite(parsedYear) ? parsedYear : undefined
          const citeKey = flags.citekey || flags.citeKey || `${authors[0]?.split(/\s+/).pop()?.toLowerCase() || 'unknown'}${year ?? 'nd'}`
          const doi = flags.doi || `unknown:${citeKey}`
          const bibtex = flags.bibtex || `@article{${citeKey},\n  title = {${cleaned}}\n}`
          const r = await api.artifactCreate({
            type: 'paper',
            title: cleaned,
            authors,
            year,
            abstract: flags.abstract || '',
            venue: flags.venue,
            url: flags.url,
            citeKey,
            doi,
            bibtex,
            tags: flags.tags ? flags.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
          })
          result = r?.success
            ? `Paper saved: **${cleaned}**`
            : `Failed: ${r?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/save-data': {
          if (!rest) { result = 'Usage: `/save-data <name> --path <file>`'; break }
          const { cleaned, flags } = parseFlagArgs(rest)
          if (!cleaned || !flags.path) { result = 'Usage: `/save-data <name> --path <file>`'; break }
          const r = await api.artifactCreate({
            type: 'data',
            title: cleaned,
            filePath: flags.path,
            mimeType: flags.mime
          })
          result = r?.success
            ? `Data saved: **${cleaned}**`
            : `Failed: ${r?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/summary': {
          const summaryResult = await api.sessionSummaryGet()
          if (!summaryResult?.success || !summaryResult?.summary) {
            result = 'No session summary available yet.'
            break
          }
          const s = summaryResult.summary
          result = `**Session Summary** (turns ${s.turnRange[0]}-${s.turnRange[1]})\n\n${s.summary}`
          if (s.topicsDiscussed?.length > 0) {
            result += `\n\n**Topics:** ${s.topicsDiscussed.join(', ')}`
          }
          if (s.openQuestions?.length > 0) {
            result += `\n\n**Open questions:**\n${s.openQuestions.map((q: string) => `- ${q}`).join('\n')}`
          }
          break
        }
        case '/delete': {
          if (!rest) { result = 'Usage: `/delete <id>`'; break }
          const r = await api.deleteEntity(rest)
          result = r?.success ? `Deleted \`${rest}\`` : `Failed: ${r?.error || 'not found'}`
          refreshEntities()
          break
        }
        case '/help':
          result = '**Available commands:**\n' + SLASH_COMMANDS.map(c =>
            `- \`${c.name}\` ${c.args ? c.args : ''} — ${c.description}`
          ).join('\n')
          break
        default:
          result = `Unknown command: \`${cmd}\`. Type \`/help\` for available commands.`
      }
    } catch (err: any) {
      result = `Command error: ${err.message}`
    }

    const messages = useChatStore.getState().messages
    messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: result,
      timestamp: Date.now()
    })
    useChatStore.setState({ messages: [...messages] })
    setIdle(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMention || showCommand) {
      if (['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) return
      if (e.key === 'Enter') return
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMention(false)
        setShowCommand(false)
        return
      }
    }

    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setText(val)

    const cursor = e.target.selectionStart
    const before = val.slice(0, cursor)

    const mentionMatch = before.match(/@(\w*)$/)
    if (mentionMatch) {
      setShowMention(true)
      setMentionQuery(mentionMatch[1])
      setShowCommand(false)
      return
    }
    setShowMention(false)

    const cmdMatch = before.match(/^\/(\w*)$/)
    if (cmdMatch) {
      setShowCommand(true)
      setCommandQuery(cmdMatch[1])
      return
    }
    setShowCommand(false)
  }

  const handleMentionSelect = (value: string) => {
    const cursor = textareaRef.current?.selectionStart ?? text.length
    const before = text.slice(0, cursor)
    const after = text.slice(cursor)
    const replaced = before.replace(/@\w*$/, value + ' ')
    setText(replaced + after)
    setShowMention(false)
    textareaRef.current?.focus()
  }

  const handleCommandSelect = (command: string) => {
    setText(command + ' ')
    setShowCommand(false)
    textareaRef.current?.focus()
  }

  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
    }
  }, [text])

  return (
    <div className="relative">
      {showMention && (
        <MentionPopover
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => setShowMention(false)}
        />
      )}

      {showCommand && (
        <CommandPopover
          query={commandQuery}
          commands={SLASH_COMMANDS}
          onSelect={handleCommandSelect}
          onClose={() => setShowCommand(false)}
        />
      )}

      <div
        className="flex items-end gap-2 rounded-2xl border px-4 py-3 transition-colors t-input-container"
        style={{
          background: 'var(--color-input-bg)',
          borderColor: 'var(--color-input-border)'
        }}
      >
        <button
          onClick={() => {
            if (isStreaming) {
              const ok = window.confirm(
                'Switching projects will stop the current task. Continue?'
              )
              if (!ok) return
              stop()
            }
            pickFolder()
          }}
          className="shrink-0 t-text-muted t-bg-hover transition-colors pb-0.5"
          title="Change working folder"
          aria-label="Change working folder"
        >
          <Folder size={18} />
        </button>

        <textarea
          ref={textareaRef}
          data-chat-input
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything, use @mentions, or type /commands..."
          rows={1}
          className="flex-1 bg-transparent text-sm t-text placeholder:t-text-muted resize-none outline-none"
        />

        {isStreaming ? (
          <button
            onClick={stop}
            className="shrink-0 p-2.5 rounded-lg t-bg-error text-white hover:opacity-90 transition-colors"
            title="Stop generation"
            aria-label="Stop generation"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="shrink-0 p-2.5 rounded-lg t-bg-accent text-white disabled:opacity-30 hover:opacity-90 transition-colors"
            title="Send (Shift+Enter)"
            aria-label="Send message (Shift+Enter)"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
