/**
 * ActivityPanel Component
 *
 * Right-side panel showing recent activity across Notes, Papers, Data tabs.
 * - Tab/Shift+Tab switches tabs
 * - Arrow up/down navigates items within the active tab
 * - Enter opens entity preview overlay
 * - The panel can be focused/unfocused from the parent via `focused` prop
 */

import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity, Note, Literature, DataAttachment } from '../../types.js'

const TABS = ['Notes', 'Papers', 'Data'] as const
type TabName = typeof TABS[number]

export interface ActivityItem {
  id: string
  type: 'note' | 'literature' | 'data'
  title: string
  detail: string
  updatedAt: string
  entity: Entity
}

interface ActivityPanelProps {
  projectPath: string
  focused: boolean
  onPreview: (entity: Entity) => void
  refreshKey?: number
}

function loadAllEntities(projectPath: string): ActivityItem[] {
  const items: ActivityItem[] = []

  const dirs: Array<{ dir: string; type: 'note' | 'literature' | 'data' }> = [
    { dir: join(projectPath, PATHS.notes), type: 'note' },
    { dir: join(projectPath, PATHS.literature), type: 'literature' },
    { dir: join(projectPath, PATHS.data), type: 'data' },
  ]

  for (const { dir, type } of dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8')
        const entity = JSON.parse(raw) as Entity
        items.push({
          id: entity.id,
          type,
          title: entityTitle(entity),
          detail: entityDetail(entity),
          updatedAt: entity.updatedAt || entity.createdAt,
          entity,
        })
      } catch { /* skip */ }
    }
  }

  // Sort by most recently updated
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return items
}

function entityTitle(e: Entity): string {
  if (e.type === 'note') return (e as Note).title
  if (e.type === 'literature') return (e as Literature).title
  if (e.type === 'data') return (e as DataAttachment).name
  return e.id
}

function entityDetail(e: Entity): string {
  if (e.type === 'note') {
    const note = e as Note
    return note.tags.length > 0 ? note.tags.join(', ') : 'no tags'
  }
  if (e.type === 'literature') {
    const lit = e as Literature
    const authors = lit.authors.slice(0, 2).join(', ')
    return authors + (lit.year ? ` (${lit.year})` : '')
  }
  if (e.type === 'data') {
    const data = e as DataAttachment
    return data.schema?.rowCount != null ? `${data.schema.rowCount} rows` : data.filePath
  }
  return ''
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const MAX_VISIBLE = 12

export const ActivityPanel: React.FC<ActivityPanelProps> = ({ projectPath, focused, onPreview, refreshKey }) => {
  const [activeTab, setActiveTab] = useState<number>(0)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const allItems = useMemo(() => loadAllEntities(projectPath), [projectPath, refreshKey])

  const tabFilter: Record<TabName, 'note' | 'literature' | 'data'> = {
    Notes: 'note',
    Papers: 'literature',
    Data: 'data',
  }

  const currentTab = TABS[activeTab]
  const items = useMemo(() =>
    allItems.filter(i => i.type === tabFilter[currentTab]),
    [allItems, currentTab]
  )

  useInput((input, key) => {
    if (!focused) return

    // Tab switching
    if (key.tab && !key.shift) {
      setActiveTab(i => (i + 1) % TABS.length)
      setSelectedIndex(0)
      return
    }
    if (key.tab && key.shift) {
      setActiveTab(i => (i - 1 + TABS.length) % TABS.length)
      setSelectedIndex(0)
      return
    }

    // Navigate items
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(items.length - 1, i + 1))
      return
    }

    // Open preview
    if (key.return && items.length > 0) {
      onPreview(items[selectedIndex].entity)
      return
    }
  })

  // Window around selected index
  let start = Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2))
  if (start + MAX_VISIBLE > items.length) start = Math.max(0, items.length - MAX_VISIBLE)
  const visible = items.slice(start, start + MAX_VISIBLE)

  return (
    <Box
      flexDirection="column"
      width={34}
      borderStyle={focused ? 'double' : 'single'}
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
      marginLeft={1}
    >
      {/* Tab bar */}
      <Box marginBottom={1}>
        {TABS.map((tab, i) => (
          <Box key={tab} marginRight={1}>
            <Text
              bold={i === activeTab}
              color={i === activeTab ? 'cyan' : 'gray'}
              inverse={i === activeTab && focused}
            >
              {tab}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Item count */}
      <Text dimColor>{items.length} {currentTab.toLowerCase()}</Text>

      {/* Item list */}
      {items.length === 0 ? (
        <Text dimColor>No {currentTab.toLowerCase()} yet.</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((item, i) => {
            const realIndex = start + i
            const isSel = realIndex === selectedIndex && focused
            return (
              <Box key={item.id} flexDirection="column">
                <Text
                  bold={isSel}
                  color={isSel ? 'cyan' : undefined}
                  inverse={isSel}
                  wrap="truncate"
                >
                  {' '}{item.title}
                </Text>
                <Text dimColor wrap="truncate">
                  {'  '}{item.detail} - {relativeTime(item.updatedAt)}
                </Text>
              </Box>
            )
          })}
          {items.length > MAX_VISIBLE && (
            <Text dimColor>  ...{items.length - MAX_VISIBLE} more</Text>
          )}
        </Box>
      )}

      {/* Keyboard hints */}
      {focused && (
        <Box marginTop={1}>
          <Text dimColor>Tab:switch  {'\u2191\u2193'}:nav  Enter:view</Text>
        </Box>
      )}
    </Box>
  )
}
