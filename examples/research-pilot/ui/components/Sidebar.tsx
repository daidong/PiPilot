/**
 * Sidebar Component - Shows pinned and selected entities
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { PinnedEntity, SelectedEntity } from '../../commands/index.js'

interface SidebarProps {
  pinned: PinnedEntity[]
  selected: SelectedEntity[]
}

export const Sidebar: React.FC<SidebarProps> = ({ pinned, selected }) => {
  if (pinned.length === 0 && selected.length === 0) return null

  return (
    <Box
      flexDirection="column"
      width={30}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginLeft={1}
    >
      {pinned.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">Pinned ({pinned.length})</Text>
          {pinned.map((item, i) => (
            <Text key={i} wrap="truncate">
              <Text dimColor>[{item.type.charAt(0)}]</Text> {item.title}
            </Text>
          ))}
        </Box>
      )}

      {selected.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="blue">Selected ({selected.length})</Text>
          {selected.map((item, i) => (
            <Text key={i} wrap="truncate">
              <Text dimColor>[{item.type.charAt(0)}]</Text> {item.title}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
