/**
 * Extract the first JSON object from an LLM response.
 *
 * Model responses often include Markdown fences or short prose around the
 * object. This parser keeps the caller-facing contract conservative: it only
 * returns a parsed object when a balanced `{...}` candidate parses cleanly.
 */
export function parseJsonObjectFromText<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string
): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) {
    const parsed = parseFirstObjectCandidate<T>(fenced[1])
    if (parsed) return parsed
  }
  return parseFirstObjectCandidate<T>(text)
}

function parseFirstObjectCandidate<T extends Record<string, unknown>>(text: string): T | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findBalancedObjectEnd(text, start)
    if (end === -1) continue
    try {
      return JSON.parse(text.slice(start, end + 1)) as T
    } catch {
      // Keep scanning; earlier braces may belong to prose or invalid examples.
    }
  }
  return null
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
      if (depth < 0) return -1
    }
  }
  return -1
}
