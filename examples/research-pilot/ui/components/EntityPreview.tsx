/**
 * EntityPreview Component
 *
 * Full-screen overlay that displays the content of a selected entity.
 * Overlaps the main view. Press Esc to dismiss.
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import type { Entity, Note, Literature, DataAttachment } from '../../types.js'

interface EntityPreviewProps {
  entity: Entity
  onClose: () => void
}

export const EntityPreview: React.FC<EntityPreviewProps> = ({ entity, onClose }) => {
  useInput((_input, key) => {
    if (key.escape) {
      onClose()
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      flexGrow={1}
    >
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{typeLabel(entity.type)} Preview</Text>
        <Text dimColor>  (Esc to close)</Text>
      </Box>

      {/* Metadata */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>ID: {entity.id}</Text>
        <Text dimColor>Created: {formatDate(entity.createdAt)}</Text>
        <Text dimColor>Updated: {formatDate(entity.updatedAt)}</Text>
        {entity.tags.length > 0 && <Text dimColor>Tags: {entity.tags.join(', ')}</Text>}
        {entity.pinned && <Text color="yellow">Pinned</Text>}
        {entity.selectedForAI && <Text color="blue">Selected for AI</Text>}
      </Box>

      <Text color="gray">{'─'.repeat(56)}</Text>

      {/* Content */}
      <Box flexDirection="column" marginTop={1}>
        {renderContent(entity)}
      </Box>
    </Box>
  )
}

function typeLabel(type: string): string {
  switch (type) {
    case 'note': return 'Note'
    case 'literature': return 'Paper'
    case 'data': return 'Data'
    default: return type
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function renderContent(entity: Entity): React.ReactNode {
  if (entity.type === 'note') {
    const note = entity as Note
    return (
      <>
        <Text bold>{note.title}</Text>
        <Text />
        <Text>{note.content}</Text>
      </>
    )
  }

  if (entity.type === 'literature') {
    const lit = entity as Literature
    return (
      <>
        <Text bold>{lit.title}</Text>
        <Text />
        <Text>Authors: {lit.authors.join(', ')}</Text>
        {lit.year && <Text>Year: {lit.year}</Text>}
        {lit.venue && <Text>Venue: {lit.venue}</Text>}
        <Text>CiteKey: {lit.citeKey}</Text>
        {lit.url && <Text>URL: {lit.url}</Text>}
        <Text />
        <Text bold>Abstract:</Text>
        <Text>{lit.abstract}</Text>
      </>
    )
  }

  if (entity.type === 'data') {
    const data = entity as DataAttachment
    return (
      <>
        <Text bold>{data.name}</Text>
        <Text />
        <Text>File: {data.filePath}</Text>
        {data.mimeType && <Text>MIME: {data.mimeType}</Text>}
        {data.schema && (
          <>
            <Text />
            <Text bold>Schema:</Text>
            {data.schema.description && <Text>{data.schema.description}</Text>}
            {data.schema.rowCount != null && <Text>Rows: {data.schema.rowCount}</Text>}
            {data.schema.columns && data.schema.columns.map((col, i) => (
              <Text key={i}>  {col.name} ({col.type}){col.description ? ` - ${col.description}` : ''}</Text>
            ))}
          </>
        )}
      </>
    )
  }

  return <Text>{JSON.stringify(entity, null, 2)}</Text>
}
