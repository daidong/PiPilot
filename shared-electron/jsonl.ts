import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'

const TAIL_CHUNK_BYTES = 64 * 1024

export function readJsonlPageFromEnd<T>(filePath: string, offset: number, limit: number): T[] {
  const safeOffset = Math.max(0, Math.floor(offset))
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return []

  const lines = readLastNonEmptyLines(filePath, safeOffset + safeLimit)
  const end = lines.length - safeOffset
  if (end <= 0) return []
  const start = Math.max(0, end - safeLimit)
  return lines.slice(start, end).map((line) => JSON.parse(line) as T)
}

export function countJsonlRows(filePath: string): number {
  if (!existsSync(filePath)) return 0
  const size = statSync(filePath).size
  if (size === 0) return 0

  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(TAIL_CHUNK_BYTES)
    let position = 0
    let count = 0
    let lineHasContent = false
    while (position < size) {
      const readSize = Math.min(buf.length, size - position)
      const bytesRead = readSync(fd, buf, 0, readSize, position)
      if (bytesRead === 0) break
      position += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) {
          if (lineHasContent) count++
          lineHasContent = false
        } else {
          lineHasContent = true
        }
      }
    }
    if (lineHasContent) count++
    return count
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readLastNonEmptyLines(filePath: string, maxLines: number): string[] {
  if (maxLines <= 0 || !existsSync(filePath)) return []
  const size = statSync(filePath).size
  if (size === 0) return []

  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    let position = size
    const chunks: Buffer[] = []
    let completeLines: string[] = []
    while (position > 0 && countNonEmpty(completeLines) < maxLines) {
      const readSize = Math.min(TAIL_CHUNK_BYTES, position)
      position -= readSize
      const buf = Buffer.allocUnsafe(readSize)
      const bytesRead = readSync(fd, buf, 0, readSize, position)
      chunks.unshift(bytesRead === readSize ? buf : buf.subarray(0, bytesRead))
      const parts = Buffer.concat(chunks).toString('utf-8').split('\n')
      completeLines = position === 0 ? parts : parts.slice(1)
    }
    return completeLines.filter(Boolean).slice(-maxLines)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function countNonEmpty(lines: string[]): number {
  let count = 0
  for (const line of lines) {
    if (line) count++
  }
  return count
}
