/**
 * /save-note Command Handler
 *
 * Saves content as a note with provenance tracking.
 * Supports extracting from last agent response and line ranges.
 *
 * Usage:
 *   /save-note                       - Interactive (readline mode only)
 *   /save-note --from-last           - Pre-fill with last agent response
 *   /save-note --from-last --lines 5-12  - Extract lines 5-12 from last response
 */

import { writeFileSync, mkdirSync } from 'fs'
import { createInterface } from 'readline'
import { PATHS, Note, CLIContext } from '../types.js'
import { LineStore } from '../ui/LineStore.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note
  filePath?: string
  error?: string
}

/**
 * Parse --lines flag value (e.g., "5-12") into [from, to]
 */
function parseLineRange(args: string[]): [number, number] | null {
  const linesIdx = args.indexOf('--lines')
  if (linesIdx === -1 || linesIdx + 1 >= args.length) return null

  const range = args[linesIdx + 1]
  const match = range.match(/^(\d+)-(\d+)$/)
  if (!match) return null

  return [parseInt(match[1], 10), parseInt(match[2], 10)]
}

/**
 * Save a note programmatically (for Ink UI).
 * Returns structured result instead of console.log.
 */
export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const note: Note = {
    id: crypto.randomUUID(),
    type: 'note',
    title,
    content,
    tags,
    pinned: false,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: 'user',
      sessionId: context.sessionId,
      extractedFrom: fromLast ? 'agent-response' : 'user-input'
    }
  }

  mkdirSync(PATHS.notes, { recursive: true })
  const filePath = `${PATHS.notes}/${note.id}.json`
  writeFileSync(filePath, JSON.stringify(note, null, 2))

  return { success: true, note, filePath }
}

/**
 * Get content for save-note based on args (--from-last, --lines).
 * Used by Ink UI to extract content before showing the save dialog.
 */
export function getSaveNoteContent(
  args: string[],
  lastAgentResponse: string | undefined,
  lineStore?: LineStore
): { content: string; error?: string } {
  const fromLast = args.includes('--from-last')
  const lineRange = parseLineRange(args)

  if (lineRange && lineStore) {
    const [from, to] = lineRange
    const lines = lineStore.getLines(from, to)
    if (lines.length === 0) {
      return { content: '', error: `No lines found in range ${from}-${to}` }
    }
    return { content: lines.join('\n') }
  }

  if (fromLast) {
    if (!lastAgentResponse) {
      return { content: '', error: 'No agent response available. Chat with the agent first.' }
    }
    return { content: lastAgentResponse }
  }

  return { content: '' }
}

// ============================================================================
// Legacy readline-based handler (kept for backward compatibility)
// ============================================================================

/** Prompt for user input (readline) */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/** Confirm yes/no (readline) */
async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(question)
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

/** Read multiline input until empty line (readline) */
async function readMultilineInput(): Promise<string> {
  const lines: string[] = []
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  for await (const line of rl) {
    if (line === '') break
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Handle /save-note command (legacy readline mode)
 */
export async function handleSaveNote(
  args: string[],
  context: CLIContext
): Promise<void> {
  const { lastAgentResponse, sessionId } = context
  const fromLast = args.includes('--from-last')

  let content = ''
  if (fromLast) {
    if (!lastAgentResponse) {
      console.log('No agent response available. Chat with the agent first.')
      return
    }
    content = lastAgentResponse
  }

  const title = await prompt('Title: ')
  if (!title) {
    console.log('Note title is required.')
    return
  }

  const tagsInput = await prompt('Tags (comma-separated): ')
  const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)

  if (content) {
    console.log('\n--- Content Preview ---')
    console.log(content.length > 500 ? content.slice(0, 500) + '\n[...truncated]' : content)
    console.log('--- End Preview ---\n')

    const edit = await confirm('Edit content? (y/N): ')
    if (edit) {
      console.log('Enter new content (end with empty line):')
      content = await readMultilineInput()
    }
  } else {
    console.log('Enter content (end with empty line):')
    content = await readMultilineInput()
  }

  if (!content) {
    console.log('Note content is required.')
    return
  }

  const result = saveNote(title, content, tags, context, fromLast)
  if (result.success) {
    console.log(`\n✓ Note saved: ${result.filePath}`)
    console.log(`  Title: ${result.note!.title}`)
    console.log(`  Tags: ${result.note!.tags.length > 0 ? result.note!.tags.join(', ') : '(none)'}`)
  } else {
    console.log(result.error)
  }
}
