/**
 * Banner Component - Displays startup info
 */

import React from 'react'
import { Box, Text } from 'ink'

interface BannerProps {
  sessionId: string
  projectPath: string
  debug: boolean
}

export const Banner: React.FC<BannerProps> = ({ sessionId, projectPath, debug }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">{'='.repeat(60)}</Text>
      <Text bold color="cyan">Research Pilot</Text>
      <Text bold color="cyan">{'='.repeat(60)}</Text>
      <Text />
      <Text>A research assistant with context-aware memory.</Text>
      <Text>Type /help for commands, or just start chatting.</Text>
      <Text />
      <Text dimColor>Session: {sessionId.slice(0, 8)}...</Text>
      <Text dimColor>Project: {projectPath}</Text>
      {debug && <Text color="yellow">Debug mode: ON</Text>}
    </Box>
  )
}
