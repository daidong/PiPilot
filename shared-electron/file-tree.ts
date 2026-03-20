/**
 * File tree traversal utilities with .gitignore support.
 * Shared between personal-assistant and research-pilot-desktop.
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'fs'
import { join, resolve, sep } from 'path'
import type { FileTreeNode, GitIgnoreRule } from './types'

export const TREE_MAX_ENTRIES = 500

export function toPosixPath(input: string): string {
  return input.split(sep).join('/')
}

export function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = resolve(rootPath)
  const normalizedTarget = resolve(targetPath)
  if (normalizedRoot === normalizedTarget) return true
  return normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

export function readGitIgnoreRules(rootPath: string): GitIgnoreRule[] {
  const filePath = join(rootPath, '.gitignore')
  if (!existsSync(filePath)) return []
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const negated = line.startsWith('!')
      let pattern = negated ? line.slice(1) : line
      const directoryOnly = pattern.endsWith('/')
      if (directoryOnly) pattern = pattern.slice(0, -1)

      const anchored = pattern.startsWith('/')
      if (anchored) pattern = pattern.slice(1)

      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')

      let regexPattern = ''
      if (anchored) {
        regexPattern = `^${escaped}${directoryOnly ? '(?:/.*)?' : '$'}`
      } else if (pattern.includes('/')) {
        regexPattern = `(?:^|/)${escaped}${directoryOnly ? '(?:/.*)?' : '$'}`
      } else {
        regexPattern = `(?:^|/)${escaped}${directoryOnly ? '(?:/.*)?' : '(?:$|/)'}`
      }

      return {
        negated,
        directoryOnly,
        regex: new RegExp(regexPattern)
      } satisfies GitIgnoreRule
    })
}

export function isHiddenPath(relativePath: string): boolean {
  return toPosixPath(relativePath)
    .split('/')
    .some(segment => segment.startsWith('.'))
}

export function isIgnored(relativePath: string, isDirectory: boolean, rules: GitIgnoreRule[], showIgnored: boolean): boolean {
  if (showIgnored) return false
  if (isHiddenPath(relativePath)) return true

  const normalized = toPosixPath(relativePath)
  let ignored = false
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory && !normalized.includes('/')) continue
    if (rule.regex.test(normalized)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

export function hasVisibleChildren(dirPath: string, relativePath: string, rules: GitIgnoreRule[], showIgnored: boolean): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (!isIgnored(childRelative, entry.isDirectory(), rules, showIgnored)) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

export function listTreeChildren(
  rootPath: string,
  relativePath: string = '',
  showIgnored: boolean = false,
  limit: number = TREE_MAX_ENTRIES
): FileTreeNode[] {
  const basePath = resolve(rootPath, relativePath || '.')
  if (!isWithinRoot(rootPath, basePath)) return []
  if (!existsSync(basePath) || !statSync(basePath).isDirectory()) return []

  const rules = readGitIgnoreRules(rootPath)
  const entries = readdirSync(basePath, { withFileTypes: true })
  const out: FileTreeNode[] = []

  entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .some(entry => {
      const childRelative = toPosixPath(relativePath ? `${relativePath}/${entry.name}` : entry.name)
      const childPath = join(basePath, entry.name)
      if (isIgnored(childRelative, entry.isDirectory(), rules, showIgnored)) return false

      let modifiedAt = 0
      try {
        modifiedAt = statSync(childPath).mtimeMs
      } catch {
        modifiedAt = Date.now()
      }

      out.push({
        name: entry.name,
        path: childPath,
        relativePath: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        hasChildren: entry.isDirectory() ? hasVisibleChildren(childPath, childRelative, rules, showIgnored) : undefined,
        modifiedAt
      })
      return out.length >= limit
    })

  return out
}

export function searchTree(rootPath: string, query: string, showIgnored: boolean = false, maxResults: number = 200): FileTreeNode[] {
  const trimmedQuery = query.trim().toLowerCase()
  if (!trimmedQuery) return []

  const rules = readGitIgnoreRules(rootPath)
  const root = resolve(rootPath)
  const stack: Array<{ absPath: string; relativePath: string }> = [{ absPath: root, relativePath: '' }]
  const out: FileTreeNode[] = []

  while (stack.length > 0 && out.length < maxResults) {
    const node = stack.pop()!
    let entries: Dirent[] = []
    try {
      entries = readdirSync(node.absPath, { withFileTypes: true }) as Dirent[]
    } catch {
      continue
    }

    for (const entry of entries) {
      const rel = toPosixPath(node.relativePath ? `${node.relativePath}/${entry.name}` : entry.name)
      const abs = join(node.absPath, entry.name)
      if (isIgnored(rel, entry.isDirectory(), rules, showIgnored)) continue

      if (entry.name.toLowerCase().includes(trimmedQuery)) {
        let modifiedAt = 0
        try {
          modifiedAt = statSync(abs).mtimeMs
        } catch {
          modifiedAt = Date.now()
        }
        out.push({
          name: entry.name,
          path: abs,
          relativePath: rel,
          type: entry.isDirectory() ? 'directory' : 'file',
          hasChildren: entry.isDirectory() ? true : undefined,
          modifiedAt
        })
        if (out.length >= maxResults) break
      }

      if (entry.isDirectory()) {
        stack.push({ absPath: abs, relativePath: rel })
      }
    }
  }

  return out
}
