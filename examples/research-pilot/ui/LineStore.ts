/**
 * LineStore - Tracks agent output with global line numbers.
 * Used for /save-note --lines 5-12 to extract specific lines.
 */

export interface NumberedLine {
  lineNumber: number
  text: string
}

export class LineStore {
  private lines: string[] = []

  /** Append text (may contain newlines), assigning sequential line numbers */
  append(text: string): void {
    const newLines = text.split('\n')
    this.lines.push(...newLines)
  }

  /** Get lines in a 1-based inclusive range */
  getLines(from: number, to: number): string[] {
    return this.lines.slice(from - 1, to)
  }

  /** Get all lines with their 1-based line numbers */
  getAll(): NumberedLine[] {
    return this.lines.map((text, i) => ({ lineNumber: i + 1, text }))
  }

  /** Get total number of lines */
  get length(): number {
    return this.lines.length
  }

  /** Clear all stored lines */
  clear(): void {
    this.lines = []
  }
}
