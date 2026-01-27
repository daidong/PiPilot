/**
 * MentionPopup Component
 *
 * Displays an autocomplete dropdown when the user types @ in the input.
 * Shows matching candidates filtered by type and query text.
 * Navigate with arrow keys, select with Enter, dismiss with Escape.
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { MentionCandidate } from '../../mentions/index.js'

const MAX_VISIBLE = 8

interface MentionPopupProps {
  candidates: MentionCandidate[]
  selectedIndex: number
}

export const MentionPopup: React.FC<MentionPopupProps> = ({ candidates, selectedIndex }) => {
  if (candidates.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>No matches. Type a value or press Esc.</Text>
      </Box>
    )
  }

  // Window around selected index
  const total = candidates.length
  let start = Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2))
  if (start + MAX_VISIBLE > total) start = Math.max(0, total - MAX_VISIBLE)
  const visible = candidates.slice(start, start + MAX_VISIBLE)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text dimColor>
        @ mentions ({total} match{total !== 1 ? 'es' : ''}) — ↑↓ navigate, Enter select, Esc cancel
      </Text>
      {visible.map((c, i) => {
        const realIndex = start + i
        const isSelected = realIndex === selectedIndex
        return (
          <Box key={`${c.type}-${c.value}-${realIndex}`}>
            <Text
              bold={isSelected}
              color={isSelected ? 'cyan' : undefined}
              inverse={isSelected}
            >
              {' '}{typeIcon(c.type)} @{c.type}:{c.value}
            </Text>
            <Text dimColor={!isSelected}> {c.label}</Text>
            {c.detail && <Text dimColor> ({c.detail})</Text>}
          </Box>
        )
      })}
      {total > MAX_VISIBLE && (
        <Text dimColor>  ...{total - MAX_VISIBLE} more</Text>
      )}
    </Box>
  )
}

function typeIcon(type: string): string {
  switch (type) {
    case 'note': return 'N'
    case 'paper': return 'P'
    case 'data': return 'D'
    case 'file': return 'F'
    case 'url': return 'U'
    default: return '?'
  }
}
