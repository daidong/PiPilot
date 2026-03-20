/**
 * Format Utility - Smart Input Formatting for Agent Prompts
 *
 * Converts various input types to readable strings for use in prompts.
 * Handles objects, arrays, strings, and edge cases gracefully.
 *
 * @example
 * ```typescript
 * const agent = defineAgent({
 *   prompt: (input) => `Analyze this:\n\n${format(input)}`
 * })
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface FormatOptions {
  /** Indentation spaces for JSON (default: 2) */
  indent?: number
  /** Max string length before truncation (default: 10000) */
  maxLength?: number
  /** Format style: 'json' | 'pretty' | 'compact' (default: 'pretty') */
  style?: 'json' | 'pretty' | 'compact'
  /** Include type hints for ambiguous values (default: false) */
  includeTypes?: boolean
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Format input for use in agent prompts.
 *
 * Intelligently converts various types to readable strings:
 * - Objects → JSON with indentation
 * - Arrays → numbered list or JSON depending on content
 * - Strings → as-is
 * - null/undefined → "(no input)"
 * - Primitives → string representation
 *
 * @example
 * ```typescript
 * // Object
 * format({ name: 'John', age: 30 })
 * // {
 * //   "name": "John",
 * //   "age": 30
 * // }
 *
 * // Array of strings
 * format(['apple', 'banana', 'cherry'])
 * // 1. apple
 * // 2. banana
 * // 3. cherry
 *
 * // Array of objects
 * format([{ id: 1 }, { id: 2 }])
 * // [
 * //   { "id": 1 },
 * //   { "id": 2 }
 * // ]
 *
 * // String
 * format('Hello world')
 * // Hello world
 *
 * // Null/undefined
 * format(null)
 * // (no input)
 * ```
 */
export function format(input: unknown, options: FormatOptions = {}): string {
  const {
    indent = 2,
    maxLength = 10000,
    style = 'pretty',
    includeTypes = false
  } = options

  const result = formatValue(input, { indent, style, includeTypes })

  // Truncate if too long
  if (result.length > maxLength) {
    return result.slice(0, maxLength) + '\n... (truncated)'
  }

  return result
}

// ============================================================================
// Internal Helpers
// ============================================================================

interface InternalOptions {
  indent: number
  style: 'json' | 'pretty' | 'compact'
  includeTypes: boolean
}

function formatValue(value: unknown, options: InternalOptions): string {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return '(no input)'
  }

  // Handle strings
  if (typeof value === 'string') {
    return value
  }

  // Handle numbers/booleans
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return formatArray(value, options)
  }

  // Handle objects
  if (typeof value === 'object') {
    return formatObject(value as Record<string, unknown>, options)
  }

  // Handle functions (shouldn't happen, but just in case)
  if (typeof value === 'function') {
    return '[Function]'
  }

  // Fallback
  return String(value)
}

function formatArray(arr: unknown[], options: InternalOptions): string {
  if (arr.length === 0) {
    return '(empty list)'
  }

  // Check if array contains simple strings - use numbered list
  const allSimpleStrings = arr.every(
    item => typeof item === 'string' && !item.includes('\n') && item.length < 100
  )

  if (allSimpleStrings && options.style === 'pretty') {
    return arr
      .map((item, index) => `${index + 1}. ${item}`)
      .join('\n')
  }

  // Check if array contains simple primitives
  const allPrimitives = arr.every(
    item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  )

  if (allPrimitives && options.style === 'compact') {
    return arr.join(', ')
  }

  // Default to JSON for complex arrays
  return JSON.stringify(arr, null, options.indent)
}

function formatObject(obj: Record<string, unknown>, options: InternalOptions): string {
  const keys = Object.keys(obj)

  if (keys.length === 0) {
    return '(empty object)'
  }

  // For pretty style with simple objects, use key-value format
  if (options.style === 'pretty') {
    const isSimple = keys.every(key => {
      const value = obj[key]
      return (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      )
    })

    if (isSimple && keys.length <= 5) {
      return keys
        .map(key => {
          const value = obj[key]
          const valueStr = value === null ? 'null' :
            typeof value === 'string' ? value :
            String(value)
          return `${key}: ${valueStr}`
        })
        .join('\n')
    }
  }

  // Default to JSON
  return JSON.stringify(obj, null, options.indent)
}

// ============================================================================
// Specialized Formatters
// ============================================================================

/**
 * Format as JSON (always)
 */
export function formatJson(input: unknown, indent = 2): string {
  if (input === null || input === undefined) {
    return 'null'
  }
  return JSON.stringify(input, null, indent)
}

/**
 * Format as a numbered list
 */
export function formatList(items: unknown[], options?: { prefix?: string }): string {
  const { prefix = '' } = options ?? {}

  if (items.length === 0) {
    return '(empty list)'
  }

  return items
    .map((item, index) => {
      const itemStr = typeof item === 'string' ? item : JSON.stringify(item)
      return `${prefix}${index + 1}. ${itemStr}`
    })
    .join('\n')
}

/**
 * Format as a bullet list
 */
export function formatBullets(items: unknown[], options?: { bullet?: string }): string {
  const { bullet = '-' } = options ?? {}

  if (items.length === 0) {
    return '(empty list)'
  }

  return items
    .map(item => {
      const itemStr = typeof item === 'string' ? item : JSON.stringify(item)
      return `${bullet} ${itemStr}`
    })
    .join('\n')
}

/**
 * Format key-value pairs
 */
export function formatKeyValue(
  obj: Record<string, unknown>,
  options?: { separator?: string; lineBreak?: boolean }
): string {
  const { separator = ': ', lineBreak = true } = options ?? {}
  const keys = Object.keys(obj)

  if (keys.length === 0) {
    return '(no data)'
  }

  const pairs = keys.map(key => {
    const value = obj[key]
    const valueStr = value === null || value === undefined
      ? '(none)'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
    return `${key}${separator}${valueStr}`
  })

  return lineBreak ? pairs.join('\n') : pairs.join(', ')
}

/**
 * Format a table (for arrays of objects with consistent keys)
 */
export function formatTable(
  items: Array<Record<string, unknown>>,
  columns?: string[]
): string {
  if (items.length === 0) {
    return '(empty table)'
  }

  // Determine columns
  const cols = columns ?? Object.keys(items[0] ?? {})
  if (cols.length === 0) {
    return '(no columns)'
  }

  // Calculate column widths
  const widths = cols.map(col => {
    const values = items.map(item => String(item[col] ?? ''))
    const maxValueWidth = Math.max(...values.map(v => v.length))
    return Math.max(col.length, maxValueWidth)
  })

  // Build header
  const header = cols.map((col, i) => col.padEnd(widths[i]!)).join(' | ')
  const separator = widths.map(w => '-'.repeat(w)).join('-+-')

  // Build rows
  const rows = items.map(item =>
    cols.map((col, i) => String(item[col] ?? '').padEnd(widths[i]!)).join(' | ')
  )

  return [header, separator, ...rows].join('\n')
}

/**
 * Format with truncation for very long content
 */
export function formatTruncated(
  input: unknown,
  maxLength: number,
  options?: { suffix?: string }
): string {
  const { suffix = '... (truncated)' } = options ?? {}
  const formatted = format(input)

  if (formatted.length <= maxLength) {
    return formatted
  }

  return formatted.slice(0, maxLength - suffix.length) + suffix
}
