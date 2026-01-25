/**
 * Blackboard - Shared State for Multi-Agent Collaboration
 *
 * The blackboard provides a shared state store that agents can read and write to.
 * All operations are versioned and traced for replay capability.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Blackboard configuration
 */
export interface BlackboardConfig {
  /** Storage backend */
  storage: 'memory' | 'sqlite'
  /** Namespace for this team's state */
  namespace: string
  /** Versioning strategy */
  versioning?: 'optimistic' | 'appendOnly'
  /** Optional JSON schema for validation */
  schema?: unknown
}

/**
 * State entry with metadata
 */
export interface StateEntry {
  /** Path in the state tree */
  path: string
  /** Value at this path */
  value: unknown
  /** Version number */
  version: number
  /** Last modified timestamp */
  updatedAt: number
  /** Who wrote this value */
  writtenBy?: string
}

/**
 * Trace event for state operations
 */
export interface StateTraceEvent {
  type: 'state.write' | 'state.read'
  runId: string
  ts: number
  path: string
  version?: number
  bytes?: number
  op?: 'put' | 'append' | 'patch' | 'delete'
}

/**
 * Trace context for state operations
 */
export interface StateTraceContext {
  runId: string
  trace: {
    record: (event: StateTraceEvent) => void
  }
}

// ============================================================================
// Blackboard Implementation
// ============================================================================

/**
 * Blackboard shared state store
 */
export class Blackboard {
  private config: BlackboardConfig
  private state: Map<string, StateEntry> = new Map()
  private globalVersion = 0

  constructor(config: BlackboardConfig) {
    this.config = config
  }

  /**
   * Get the namespace
   */
  get namespace(): string {
    return this.config.namespace
  }

  /**
   * Get value at path
   */
  get(path: string, ctx?: StateTraceContext): unknown {
    const fullPath = this.resolvePath(path)
    const entry = this.state.get(fullPath)

    if (ctx) {
      ctx.trace.record({
        type: 'state.read',
        runId: ctx.runId,
        ts: Date.now(),
        path: fullPath,
        version: entry?.version,
        bytes: entry ? JSON.stringify(entry.value).length : 0
      })
    }

    return entry?.value
  }

  /**
   * Check if path exists
   */
  has(path: string): boolean {
    const fullPath = this.resolvePath(path)
    return this.state.has(fullPath)
  }

  /**
   * Put value at path
   */
  put(
    path: string,
    value: unknown,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const fullPath = this.resolvePath(path)
    const existing = this.state.get(fullPath)

    this.globalVersion++
    const entry: StateEntry = {
      path: fullPath,
      value,
      version: existing ? existing.version + 1 : 1,
      updatedAt: Date.now(),
      writtenBy
    }

    this.state.set(fullPath, entry)

    if (ctx) {
      ctx.trace.record({
        type: 'state.write',
        runId: ctx.runId,
        ts: Date.now(),
        path: fullPath,
        version: entry.version,
        bytes: JSON.stringify(value).length,
        op: 'put'
      })
    }

    return entry
  }

  /**
   * Append to array at path
   */
  append(
    path: string,
    value: unknown,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const fullPath = this.resolvePath(path)
    const existing = this.state.get(fullPath)
    const currentValue = existing?.value

    let newValue: unknown[]
    if (Array.isArray(currentValue)) {
      newValue = [...currentValue, value]
    } else if (currentValue === undefined) {
      newValue = [value]
    } else {
      throw new Error(`Cannot append to non-array at path: ${fullPath}`)
    }

    this.globalVersion++
    const entry: StateEntry = {
      path: fullPath,
      value: newValue,
      version: existing ? existing.version + 1 : 1,
      updatedAt: Date.now(),
      writtenBy
    }

    this.state.set(fullPath, entry)

    if (ctx) {
      ctx.trace.record({
        type: 'state.write',
        runId: ctx.runId,
        ts: Date.now(),
        path: fullPath,
        version: entry.version,
        bytes: JSON.stringify(newValue).length,
        op: 'append'
      })
    }

    return entry
  }

  /**
   * Patch object at path (shallow merge)
   */
  patch(
    path: string,
    patch: Record<string, unknown>,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const fullPath = this.resolvePath(path)
    const existing = this.state.get(fullPath)
    const currentValue = existing?.value

    let newValue: Record<string, unknown>
    if (typeof currentValue === 'object' && currentValue !== null && !Array.isArray(currentValue)) {
      newValue = { ...currentValue as Record<string, unknown>, ...patch }
    } else if (currentValue === undefined) {
      newValue = patch
    } else {
      throw new Error(`Cannot patch non-object at path: ${fullPath}`)
    }

    this.globalVersion++
    const entry: StateEntry = {
      path: fullPath,
      value: newValue,
      version: existing ? existing.version + 1 : 1,
      updatedAt: Date.now(),
      writtenBy
    }

    this.state.set(fullPath, entry)

    if (ctx) {
      ctx.trace.record({
        type: 'state.write',
        runId: ctx.runId,
        ts: Date.now(),
        path: fullPath,
        version: entry.version,
        bytes: JSON.stringify(newValue).length,
        op: 'patch'
      })
    }

    return entry
  }

  /**
   * Delete value at path
   */
  delete(path: string, ctx?: StateTraceContext): boolean {
    const fullPath = this.resolvePath(path)
    const existed = this.state.has(fullPath)

    if (existed) {
      this.state.delete(fullPath)
      this.globalVersion++

      if (ctx) {
        ctx.trace.record({
          type: 'state.write',
          runId: ctx.runId,
          ts: Date.now(),
          path: fullPath,
          op: 'delete'
        })
      }
    }

    return existed
  }

  /**
   * Query paths matching a prefix
   */
  query(prefix: string): StateEntry[] {
    const fullPrefix = this.resolvePath(prefix)
    const results: StateEntry[] = []

    for (const [path, entry] of this.state) {
      if (path.startsWith(fullPrefix)) {
        results.push(entry)
      }
    }

    // Sort by path for determinism
    results.sort((a, b) => a.path.localeCompare(b.path))
    return results
  }

  /**
   * Get all state as a nested object
   */
  toObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    for (const [path, entry] of this.state) {
      setNestedPath(result, path, entry.value)
    }

    return result
  }

  /**
   * Get state at a specific path as a nested object
   */
  getTree(path: string): unknown {
    const fullPath = this.resolvePath(path)
    const entries = this.query(fullPath)

    if (entries.length === 0) {
      return this.get(path)
    }

    const result: Record<string, unknown> = {}
    for (const entry of entries) {
      const relativePath = entry.path.slice(fullPath.length).replace(/^\./, '')
      if (relativePath) {
        setNestedPath(result, relativePath, entry.value)
      } else {
        return entry.value
      }
    }

    return result
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.state.clear()
    this.globalVersion = 0
  }

  /**
   * Get current global version
   */
  getVersion(): number {
    return this.globalVersion
  }

  /**
   * Export state for serialization
   */
  export(): { entries: StateEntry[]; version: number } {
    return {
      entries: Array.from(this.state.values()),
      version: this.globalVersion
    }
  }

  /**
   * Import state from serialized form
   */
  import(data: { entries: StateEntry[]; version: number }): void {
    this.state.clear()
    for (const entry of data.entries) {
      this.state.set(entry.path, entry)
    }
    this.globalVersion = data.version
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private resolvePath(path: string): string {
    // If path already starts with namespace, use as-is
    if (path.startsWith(this.config.namespace + '.') || path === this.config.namespace) {
      return path
    }
    // Otherwise, prepend namespace
    return `${this.config.namespace}.${path}`
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Set a value at a nested path in an object
 */
function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  if (parts.length === 0) return

  let current = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (part === undefined || part === '') continue
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  const lastPart = parts[parts.length - 1]
  if (lastPart !== undefined && lastPart !== '') {
    current[lastPart] = value
  }
}

/**
 * Get a value at a nested path in an object
 */
export function getNestedPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current = obj

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a blackboard instance
 */
export function createBlackboard(config: BlackboardConfig): Blackboard {
  // For now, only memory storage is implemented
  // SQLite storage can be added in Phase 2+
  if (config.storage === 'sqlite') {
    console.warn('SQLite storage not yet implemented, falling back to memory')
  }

  return new Blackboard({
    ...config,
    storage: 'memory'
  })
}
