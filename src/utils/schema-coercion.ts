/**
 * Schema Coercion Utilities
 *
 * Handles type conversion for dynamic object parameters when using
 * OpenAI's Responses API which requires strict JSON schemas.
 *
 * ## Background
 *
 * OpenAI's Responses API (used by GPT-5.x) requires `additionalProperties`
 * to have an explicit `type` key. For flexible object parameters, we use
 * `additionalProperties: { type: 'string' }` in the schema, then convert
 * string values back to their intended types at runtime.
 *
 * ## Design Decision
 *
 * This is a trade-off between:
 * - Internal type safety (keeping tool definitions with proper types)
 * - External API compatibility (satisfying OpenAI's strict schema requirements)
 *
 * The conversion happens at the tool execution layer, transparent to both
 * the LLM and the internal tool implementation.
 *
 * @see docs/SCHEMA-COERCION.md for detailed documentation
 */

/**
 * Parse a string value to its most likely intended type.
 *
 * Attempts to parse in order:
 * 1. JSON (for objects, arrays, booleans, null)
 * 2. Number (for integers and floats)
 * 3. Keep as string (fallback)
 *
 * @example
 * parseValue("5")        // returns 5 (number)
 * parseValue("true")     // returns true (boolean)
 * parseValue('{"a":1}')  // returns {a: 1} (object)
 * parseValue("hello")    // returns "hello" (string)
 */
export function parseValue(value: unknown): unknown {
  // If not a string, return as-is
  if (typeof value !== 'string') {
    return value
  }

  // Try JSON parse first (handles objects, arrays, booleans, null)
  try {
    return JSON.parse(value)
  } catch {
    // Not valid JSON, continue
  }

  // Try parsing as number
  const num = Number(value)
  if (!isNaN(num) && value.trim() !== '') {
    return num
  }

  // Keep as string
  return value
}

/**
 * Coerce all string values in an object to their intended types.
 *
 * Used for dynamic object parameters like `ctx-get.params` where
 * the schema specifies `additionalProperties: { type: 'string' }`
 * but the actual values should be various types.
 *
 * @example
 * coerceObjectValues({ query: "test", k: "5", verbose: "true" })
 * // returns { query: "test", k: 5, verbose: true }
 */
export function coerceObjectValues(
  obj: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!obj) return undefined

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    result[key] = parseValue(value)
  }
  return result
}

/**
 * Type guard to check if a value needs coercion.
 *
 * Returns true if the object has string values that look like
 * they should be other types (numbers, booleans, etc.)
 */
export function needsCoercion(obj: Record<string, unknown> | undefined): boolean {
  if (!obj) return false

  for (const value of Object.values(obj)) {
    if (typeof value !== 'string') continue

    // Check if it looks like JSON
    if (value.startsWith('{') || value.startsWith('[')) return true

    // Check if it looks like a number
    if (!isNaN(Number(value)) && value.trim() !== '') return true

    // Check if it looks like a boolean
    if (value === 'true' || value === 'false') return true

    // Check if it looks like null
    if (value === 'null') return true
  }

  return false
}

/**
 * Recursively coerce all string values in a nested structure.
 *
 * Used for deeply nested objects like memory-put.value where
 * the entire structure may have string-encoded values.
 *
 * @example
 * coerceDeep({ user: { age: "25", active: "true" } })
 * // returns { user: { age: 25, active: true } }
 */
export function coerceDeep(value: unknown): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(coerceDeep)
  }

  // Handle objects
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = coerceDeep(val)
    }
    return result
  }

  // Handle strings - attempt type conversion
  if (typeof value === 'string') {
    return parseValue(value)
  }

  // Return other primitives as-is
  return value
}
