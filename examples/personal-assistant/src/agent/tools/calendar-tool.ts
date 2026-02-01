/**
 * Calendar Tool
 *
 * Queries macOS Calendar.app via icalBuddy CLI.
 * Requires: brew install ical-buddy
 */

import { execSync } from 'child_process'
import { defineTool } from '@framework/factories/define-tool.js'

/**
 * Resolve the full path to icalBuddy.
 * Electron's main process may have a stripped PATH that doesn't include
 * /opt/homebrew/bin, so we probe common locations.
 */
function findIcalBuddy(): string {
  const candidates = [
    '/opt/homebrew/bin/icalBuddy',
    '/usr/local/bin/icalBuddy',
    'icalBuddy'
  ]
  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: 'ignore' })
      return bin
    } catch {
      // try next
    }
  }
  throw new Error('icalBuddy not found. Install with: brew install ical-buddy')
}

let icalBuddyPath: string | null = null

export function createCalendarTool() {
  return defineTool({
    name: 'calendar',
    description:
      'Query macOS Calendar events. Returns events for a date range. ' +
      'Supports: today, tomorrow, upcoming N days, or a specific date range.',
    parameters: {
      range: {
        type: 'string',
        description:
          'Date range to query. Examples: "today", "today+7" (next 7 days), ' +
          '"2026-02-01 to 2026-02-07". Default: "today"',
        required: false
      },
      calendars: {
        type: 'string',
        description:
          'Comma-separated calendar names to include. Omit for all calendars.',
        required: false
      }
    },
    execute: async (input) => {
      const { range = 'today', calendars } = input as {
        range?: string
        calendars?: string
      }

      try {
        if (!icalBuddyPath) {
          icalBuddyPath = findIcalBuddy()
        }

        const args: string[] = [
          '-f',           // no formatting (plain text)
          '-b', '',       // no bullet
          '-nc',          // no calendar names in section headers
          '-nrd',         // no relative dates
          '-df', '%Y-%m-%d %a',
          '-tf', '%H:%M',
          '-iep', 'title,datetime,location,notes,attendees',
          '-po', 'title,datetime,location,attendees,notes',
          '-ps', '| ',    // property separator
          '-ss', '---\n', // section separator
        ]

        if (calendars) {
          args.push('-ic', calendars)
        }

        // Parse range
        let cmd: string
        const dateRange = range.trim().toLowerCase()

        if (dateRange === 'today') {
          args.push('eventsToday')
        } else if (dateRange === 'tomorrow') {
          args.push('eventsToday+1')
        } else if (/^today\+\d+$/.test(dateRange)) {
          args.push(`eventsToday+${dateRange.split('+')[1]}`)
        } else if (dateRange.includes(' to ')) {
          const [from, to] = dateRange.split(' to ').map(s => s.trim())
          args.push('eventsFrom:' + from, 'to:' + to)
        } else {
          // Treat as eventsToday+N or pass through
          args.push(dateRange)
        }

        cmd = `${icalBuddyPath} ${args.map(a => `'${a}'`).join(' ')}`

        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 10000,
          env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }
        }).trim()

        if (!output) {
          return { success: true, data: `No events found for range: ${range}` }
        }

        return { success: true, data: output }
      } catch (err: any) {
        return {
          success: false,
          error: `Calendar query failed: ${err.message}`
        }
      }
    }
  })
}
