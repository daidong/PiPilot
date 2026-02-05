/**
 * Calendar Skill
 *
 * Procedural knowledge for macOS Calendar operations:
 * - icalBuddy integration
 * - Date range formats
 * - Event querying and formatting
 *
 * Migrated from:
 * - coordinator-module-calendar (~100 tokens)
 * - calendar-tool description (~80 tokens)
 *
 * Total before: ~180 tokens (always loaded)
 * After: ~50 tokens (summary) → ~350 tokens (full, lazy loaded)
 */

import { defineSkill } from '../../../../src/skills/define-skill.js'
import type { Skill } from '../../../../src/types/skill.js'

/**
 * Calendar Skill
 *
 * Guidance for querying macOS Calendar events
 * via icalBuddy integration.
 */
export const calendarSkill: Skill = defineSkill({
  id: 'calendar-skill',
  name: 'Calendar Operations',
  shortDescription: 'Query macOS Calendar events with flexible date ranges',

  instructions: {
    summary: `Calendar integration (macOS Calendar.app via icalBuddy):
- **Range formats**: "today", "tomorrow", "today+7" (next 7 days), "YYYY-MM-DD to YYYY-MM-DD"
- **Output**: Event title, datetime, location, attendees, notes
- **Filter**: Optional calendar names (comma-separated)`,

    procedures: `
## Date Range Formats

The calendar tool accepts flexible range specifications:

| Format | Description | Example |
|--------|-------------|---------|
| \`today\` | Today's events only | "today" |
| \`tomorrow\` | Tomorrow's events | "tomorrow" |
| \`today+N\` | Next N days from today | "today+7" for next week |
| \`YYYY-MM-DD to YYYY-MM-DD\` | Specific date range | "2026-02-01 to 2026-02-07" |

## Event Output Format

Each event includes:
- **Title**: Event name/subject
- **DateTime**: Start and end time
- **Location**: Physical or virtual location (if set)
- **Attendees**: List of participants (if any)
- **Notes**: Event description/notes (if any)

## Calendar Filtering

Optionally filter by calendar name:
\`\`\`json
{
  "range": "today+7",
  "calendars": "Work,Personal"
}
\`\`\`

If no calendars specified, all calendars are queried.

## Common Use Cases

### Check Today's Schedule
- Use range: "today"
- Good for morning briefings

### Plan the Week
- Use range: "today+7"
- Identify busy days and free slots

### Check Specific Date
- Use range: "YYYY-MM-DD to YYYY-MM-DD"
- Good for planning meetings on specific dates

### Filter Work Events
- Use calendars: "Work" or similar
- Focus on professional commitments

## Integration Notes

### icalBuddy Dependency
- Requires icalBuddy CLI tool installed
- Common paths: /opt/homebrew/bin, /usr/local/bin
- Install via: \`brew install ical-buddy\`

### Calendar.app Sync
- Reads from macOS Calendar.app database
- Includes iCloud, Google, Exchange calendars synced to the app
- Real-time updates when Calendar.app syncs

### Time Zones
- Events shown in local time zone
- All-day events shown without specific times
`,

    examples: `
## Query: Today's Events

\`\`\`json
{
  "tool": "calendar",
  "input": {
    "range": "today"
  }
}
\`\`\`

**Output:**
\`\`\`
• Team Standup
  9:00 AM - 9:30 AM
  Location: Zoom Meeting

• Project Review
  2:00 PM - 3:00 PM
  Location: Conference Room A
  Attendees: Alice, Bob, Charlie
\`\`\`

## Query: Next 7 Days

\`\`\`json
{
  "tool": "calendar",
  "input": {
    "range": "today+7"
  }
}
\`\`\`

## Query: Specific Date Range

\`\`\`json
{
  "tool": "calendar",
  "input": {
    "range": "2026-02-10 to 2026-02-14"
  }
}
\`\`\`

## Query: Work Calendar Only

\`\`\`json
{
  "tool": "calendar",
  "input": {
    "range": "today+7",
    "calendars": "Work"
  }
}
\`\`\`

## Query: Multiple Specific Calendars

\`\`\`json
{
  "tool": "calendar",
  "input": {
    "range": "tomorrow",
    "calendars": "Work,Family,Health"
  }
}
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "icalBuddy not found"
- Install via Homebrew: \`brew install ical-buddy\`
- Verify installation: \`which icalBuddy\`
- Common paths: /opt/homebrew/bin/icalBuddy, /usr/local/bin/icalBuddy

### "No events found"
- Check the date range is correct
- Verify Calendar.app has synced recently
- Try without calendar filter to see all calendars
- Check if events exist in Calendar.app directly

### "Calendar not found"
- Calendar names are case-sensitive
- Check exact calendar name in Calendar.app
- Use comma separation without spaces for multiple calendars

### "Permission denied"
- Grant calendar access in System Preferences → Privacy & Security → Calendars
- May need to restart terminal/app after granting access

### "Events missing attendees/location"
- These fields are optional in calendar events
- Empty fields won't be shown
- Check if event has these details in Calendar.app

### "Timezone confusion"
- All events shown in system local timezone
- All-day events don't have specific times
- For international events, verify in Calendar.app
`
  },

  tools: ['calendar'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 50,
    full: 550
  },

  tags: ['calendar', 'scheduling', 'events', 'macos']
})

export default calendarSkill
