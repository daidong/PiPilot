/**
 * AgentResponse Component - Renders response text with line numbers
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { NumberedLine } from '../LineStore.js'

interface AgentResponseProps {
  lines: NumberedLine[]
  isStreaming?: boolean
}

export const AgentResponse: React.FC<AgentResponseProps> = ({ lines, isStreaming }) => {
  if (lines.length === 0 && !isStreaming) return null

  // Calculate gutter width based on max line number
  const maxLineNum = lines.length > 0 ? lines[lines.length - 1].lineNumber : 0
  const gutterWidth = Math.max(String(maxLineNum).length, 3)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map(({ lineNumber, text }) => (
        <Box key={lineNumber}>
          <Text dimColor>
            {String(lineNumber).padStart(gutterWidth, ' ')} {'\u2502'}{' '}
          </Text>
          <Text>{text}</Text>
        </Box>
      ))}
      {isStreaming && (
        <Text dimColor>{'...streaming'}</Text>
      )}
    </Box>
  )
}
