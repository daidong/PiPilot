/**
 * InputBar Component - Text input for commands and chat
 *
 * Detects @-mention triggers and shows an autocomplete popup.
 * Keyboard: arrow up/down to navigate, Enter to select, Escape to dismiss.
 */

import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { MentionPopup } from './MentionPopup.js'
import { getCandidates } from '../../mentions/index.js'
import type { MentionType, MentionCandidate } from '../../mentions/index.js'

interface InputBarProps {
  onSubmit: (value: string) => void
  isStreaming?: boolean
  projectPath: string
}

// Regex to detect an in-progress @mention at the end of the current input
const TRIGGER_RE = /@(note|paper|data|file|url)?(?::(?:"([^"]*)|(\S*)))?$/

interface MentionTrigger {
  /** Start index of the @ in the input */
  start: number
  /** Mention type if typed, e.g. "note" */
  type?: MentionType
  /** Query text after the colon */
  query?: string
}

function detectTrigger(value: string): MentionTrigger | null {
  // Also match bare @ at end with optional partial type
  const bareRe = /@([a-z]*)$/
  const match = TRIGGER_RE.exec(value) || bareRe.exec(value)
  if (!match) return null

  const start = match.index
  const typeStr = match[1] as MentionType | undefined

  // If using TRIGGER_RE (has colon), extract query
  if (match.length > 2) {
    const query = match[2] ?? match[3] ?? ''
    return { start, type: typeStr, query }
  }

  // Bare @ or @partial-type — no colon yet
  return { start, type: undefined, query: typeStr || '' }
}

export const InputBar: React.FC<InputBarProps> = ({ onSubmit, isStreaming, projectPath }) => {
  const [value, setValue] = useState('')
  const [popupIndex, setPopupIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const trigger = useMemo(() => (dismissed ? null : detectTrigger(value)), [value, dismissed])

  const candidates = useMemo(() => {
    if (!trigger) return []

    // If no type yet, filter type names by what's typed so far
    if (!trigger.type || !value.includes('@' + trigger.type + ':')) {
      const partial = trigger.query || ''
      const types: MentionType[] = ['note', 'paper', 'data', 'file', 'url']
      const matchingTypes = partial
        ? types.filter(t => t.startsWith(partial.toLowerCase()))
        : types

      // Show candidates from all matching types
      const all: MentionCandidate[] = []
      for (const t of matchingTypes) {
        all.push(...getCandidates(projectPath, t).slice(0, 10))
      }
      return all.slice(0, 20)
    }

    return getCandidates(projectPath, trigger.type, trigger.query).slice(0, 20)
  }, [trigger, projectPath, value])

  const popupActive = trigger !== null && candidates.length > 0

  // Handle keyboard for popup navigation
  useInput((input, key) => {
    if (!popupActive) return

    if (key.escape) {
      setDismissed(true)
      return
    }

    if (key.upArrow) {
      setPopupIndex(i => Math.max(0, i - 1))
      return
    }

    if (key.downArrow) {
      setPopupIndex(i => Math.min(candidates.length - 1, i + 1))
      return
    }

    if (key.tab) {
      applyCandidate(candidates[popupIndex])
      return
    }
  })

  function applyCandidate(candidate: MentionCandidate) {
    if (!trigger) return
    const needsQuote = candidate.value.includes(' ')
    const replacement = needsQuote
      ? `@${candidate.type}:"${candidate.value}" `
      : `@${candidate.type}:${candidate.value} `
    const newValue = value.slice(0, trigger.start) + replacement
    setValue(newValue)
    setPopupIndex(0)
    setDismissed(false)
  }

  const handleChange = (newValue: string) => {
    setValue(newValue)
    setPopupIndex(0)
    // Un-dismiss when input changes
    if (dismissed) setDismissed(false)
  }

  const handleSubmit = (text: string) => {
    if (popupActive) {
      // Enter with popup open = select candidate
      applyCandidate(candidates[popupIndex])
      return
    }
    if (!text.trim()) return
    onSubmit(text.trim())
    setValue('')
    setPopupIndex(0)
    setDismissed(false)
  }

  return (
    <Box flexDirection="column">
      {popupActive && (
        <MentionPopup candidates={candidates} selectedIndex={popupIndex} />
      )}
      <Box>
        <Text bold color="green">You: </Text>
        {isStreaming ? (
          <Text dimColor>(waiting for response...)</Text>
        ) : (
          <TextInput value={value} onChange={handleChange} onSubmit={handleSubmit} />
        )}
      </Box>
    </Box>
  )
}
