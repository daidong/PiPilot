import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square, Folder } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useSessionStore } from '../../stores/session-store'
import { useEntityStore } from '../../stores/entity-store'
import { MentionPopover } from './MentionPopover'
import { CommandPopover } from './CommandPopover'

const SLASH_COMMANDS = [
  { name: '/notes', description: 'List all notes' },
  { name: '/docs', description: 'List all documents' },
  { name: '/todo', description: 'Create a todo artifact', args: '<title>' },
  { name: '/focus', description: 'Toggle focus for an artifact', args: '<id>' },
  { name: '/anchor', description: 'Show current task anchor' },
  { name: '/explain', description: 'Explain memory behavior', args: '[turn|budget|fact <id>]' },
  { name: '/search', description: 'Search entities', args: '<query>' },
  { name: '/clear', description: 'Clear all focus entries' },
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
        case '/todo': {
          if (!rest) { result = 'Usage: `/todo <title>`'; break }
          const created = await api.artifactCreate({
            type: 'todo',
            title: rest,
            content: '',
            status: 'pending',
            tags: ['manual']
          })
          const todoId = created?.artifact?.id || created?.data?.id
          result = created?.success
            ? `Todo created: **${rest}**${todoId ? ` (\`${String(todoId).slice(0, 8)}\`)` : ''}`
            : `Failed: ${created?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/focus': {
          if (!rest) { result = 'Usage: `/focus <artifact-id>`'; break }
          const focus = await api.focusList()
          const entries: any[] = focus?.entries || []
          const existing = entries.find((entry: any) => entry.refId === rest || entry.id === rest)
          if (existing) {
            const removed = await api.focusRemove(existing.id || existing.refId || rest)
            result = removed?.success ? `Removed from focus: \`${rest}\`` : `Failed: ${removed?.error || 'unable to remove focus'}`
          } else {
            const added = await api.focusAdd({
              refType: 'artifact',
              refId: rest,
              reason: 'manual slash command',
              source: 'manual',
              ttl: '2h'
            })
            result = added?.success ? `Added to focus: \`${rest}\`` : `Failed: ${added?.error || 'unable to add focus'}`
          }
          refreshEntities()
          break
        }
        case '/anchor': {
          const anchorResult = await api.taskAnchorGet()
          if (!anchorResult?.success || !anchorResult?.anchor) {
            result = `No task anchor available${anchorResult?.error ? `: ${anchorResult.error}` : '.'}`
            break
          }
          const anchor = anchorResult.anchor
          const blockedBy = Array.isArray(anchor.blockedBy) && anchor.blockedBy.length > 0
            ? anchor.blockedBy.map((item: string) => `  - ${item}`).join('\n')
            : '  - (none)'
          result = `**Task Anchor**\n- CurrentGoal: ${anchor.currentGoal || '(empty)'}\n- NowDoing: ${anchor.nowDoing || '(empty)'}\n- BlockedBy:\n${blockedBy}\n- NextAction: ${anchor.nextAction || '(empty)'}`
          break
        }
        case '/explain': {
          const explainParts = rest.split(/\s+/).filter(Boolean)
          const mode = explainParts[0] || 'turn'
          if (mode === 'budget') {
            const explained = await api.memoryExplainBudget()
            result = explained?.success
              ? `**Memory Explain (budget)**\n\`\`\`json\n${JSON.stringify(explained.data, null, 2)}\n\`\`\``
              : `Failed: ${explained?.error || 'unknown error'}`
            break
          }
          if (mode === 'fact') {
            const factId = explainParts[1]
            if (!factId) { result = 'Usage: `/explain fact <factId>`'; break }
            const explained = await api.memoryExplainFact(factId)
            result = explained?.success
              ? `**Memory Explain (fact)**\n\`\`\`json\n${JSON.stringify(explained.data, null, 2)}\n\`\`\``
              : `Failed: ${explained?.error || 'unknown error'}`
            break
          }
          const explained = await api.memoryExplainTurn()
          result = explained?.success
            ? `**Memory Explain (turn)**\n\`\`\`json\n${JSON.stringify(explained.data, null, 2)}\n\`\`\``
            : `Failed: ${explained?.error || 'unknown error'}`
          refreshEntities()
          break
        }
        case '/clear': {
          const cleared = await api.focusClear?.()
          if (cleared?.success) {
            result = 'All focus entries cleared.'
          } else {
            await api.clearSelections()
            result = 'All selections cleared.'
          }
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
            className="shrink-0 p-1.5 rounded-lg bg-blue-500 text-white disabled:opacity-30 hover:bg-blue-400 transition-colors"
            title="Send (Shift+Enter)"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
