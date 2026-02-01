import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square, Folder } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useSessionStore } from '../../stores/session-store'
import { useEntityStore } from '../../stores/entity-store'
import { MentionPopover } from './MentionPopover'
import { CommandPopover } from './CommandPopover'

const SLASH_COMMANDS = [
  { name: '/save-note', description: 'Save content as a note', args: '<title>' },
  { name: '/save-doc', description: 'Save a document', args: '<title>' },
  { name: '/notes', description: 'List all notes' },
  { name: '/docs', description: 'List all documents' },
  { name: '/search', description: 'Search entities', args: '<query>' },
  { name: '/select', description: 'Select entity for AI context', args: '<id>' },
  { name: '/pin', description: 'Pin entity (always in context)', args: '<id>' },
  { name: '/delete', description: 'Delete an entity', args: '<id>' },
  { name: '/help', description: 'Show available commands' }
]

const api = (window as any).api

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
  const refreshEntities = useEntityStore((s) => s.refreshAll)

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
        case '/docs': {
          const docs = await api.listDocs()
          result = docs?.length
            ? `**Docs (${docs.length}):**\n` + docs.map((d: any) => `- ${d.title} \`${d.id.slice(0, 8)}\``).join('\n')
            : 'No docs yet.'
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
        case '/save-note': {
          if (!rest) { result = 'Usage: `/save-note <title>`'; break }
          const r = await api.saveNote(rest, '')
          result = r?.success ? `Note saved: **${rest}**` : `Failed: ${r?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/save-doc': {
          if (!rest) { result = 'Usage: `/save-doc <title>`'; break }
          const r = await api.saveDoc(rest)
          result = r?.success ? `Doc saved: **${rest}**` : `Failed: ${r?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/select': {
          if (!rest) { result = 'Usage: `/select <id>`'; break }
          const r = await api.toggleSelect(rest)
          result = r ? `Toggled selection for \`${rest}\`` : `Entity not found: \`${rest}\``
          refreshEntities()
          break
        }
        case '/pin': {
          if (!rest) { result = 'Usage: `/pin <id>`'; break }
          const r = await api.togglePin(rest)
          result = r ? `Toggled pin for \`${rest}\`` : `Entity not found: \`${rest}\``
          refreshEntities()
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
        className="flex items-end gap-2 rounded-2xl border px-4 py-3 transition-colors"
        style={{
          background: 'var(--color-input-bg)',
          borderColor: 'var(--color-input-border)'
        }}
      >
        <button
          onClick={pickFolder}
          className="shrink-0 t-text-muted t-bg-hover transition-colors pb-0.5"
          title="Change working folder"
        >
          <Folder size={18} />
        </button>

        <textarea
          ref={textareaRef}
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
            className="shrink-0 p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-400 transition-colors"
            title="Stop"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="shrink-0 p-1.5 rounded-lg bg-orange-500 text-white disabled:opacity-30 hover:bg-orange-400 transition-colors"
            title="Send (Shift+Enter)"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
