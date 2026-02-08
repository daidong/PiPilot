/**
 * Transform - Declarative transformation utilities
 */

import type { Transform } from '../types/policy.js'

/**
 * Get a value from a nested object
 */
function getByPath(obj: unknown, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }

  return current
}

/**
 * Set a value in a nested object
 */
function setByPath(obj: unknown, path: string, value: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    obj = {}
  }

  const result = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
  const keys = path.split('.')
  let current: Record<string, unknown> = result

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }

  const lastKey = keys[keys.length - 1]!
  current[lastKey] = value

  return result
}

/**
 * Delete a value from a nested object
 */
function deleteByPath(obj: unknown, path: string): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj
  }

  const result = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
  const keys = path.split('.')
  let current: Record<string, unknown> = result

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      return result
    }
    current = current[key] as Record<string, unknown>
  }

  const lastKey = keys[keys.length - 1]!
  delete current[lastKey]

  return result
}

/**
 * Apply a single transform
 */
export function applyTransform(obj: unknown, transform: Transform): unknown {
  switch (transform.op) {
    case 'set':
      return setByPath(obj, transform.path, transform.value)

    case 'delete':
      return deleteByPath(obj, transform.path)

    case 'append': {
      const currentValue = getByPath(obj, transform.path)
      if (typeof currentValue === 'string') {
        return setByPath(obj, transform.path, currentValue + String(transform.value))
      }
      if (Array.isArray(currentValue)) {
        return setByPath(obj, transform.path, [...currentValue, transform.value])
      }
      return setByPath(obj, transform.path, transform.value)
    }

    case 'limit': {
      const value = getByPath(obj, transform.path)
      if (typeof value === 'string') {
        return setByPath(obj, transform.path, value.slice(0, transform.max))
      }
      if (Array.isArray(value)) {
        return setByPath(obj, transform.path, value.slice(0, transform.max))
      }
      return obj
    }

    case 'redact': {
      const value = getByPath(obj, transform.path)
      if (typeof value === 'string') {
        const regex = new RegExp(transform.pattern, 'g')
        return setByPath(obj, transform.path, value.replace(regex, '[REDACTED]'))
      }
      return obj
    }

    case 'clamp': {
      const value = getByPath(obj, transform.path)
      if (typeof value === 'number') {
        let clamped = value
        if (transform.min !== undefined && clamped < transform.min) {
          clamped = transform.min
        }
        if (transform.max !== undefined && clamped > transform.max) {
          clamped = transform.max
        }
        return setByPath(obj, transform.path, clamped)
      }
      return obj
    }

    case 'normalize_path': {
      const value = getByPath(obj, transform.path)
      if (typeof value === 'string') {
        // Normalize path: remove redundant slashes, resolve . and ..
        const normalized = normalizePath(value)
        return setByPath(obj, transform.path, normalized)
      }
      return obj
    }

    default:
      return obj
  }
}

/**
 * Apply multiple transforms
 */
export function applyTransforms(obj: unknown, transforms: Transform[]): unknown {
  let result = obj
  for (const transform of transforms) {
    result = applyTransform(result, transform)
  }
  return result
}

/**
 * Normalize a path
 */
export function normalizePath(path: string): string {
  // Handle Windows paths
  const normalized = path.replace(/\\/g, '/')

  // Split path
  const parts = normalized.split('/').filter(Boolean)
  const result: string[] = []

  for (const part of parts) {
    if (part === '.') {
      continue
    }
    if (part === '..') {
      result.pop()
      continue
    }
    result.push(part)
  }

  // Preserve the leading slash (absolute path)
  const prefix = normalized.startsWith('/') ? '/' : ''

  return prefix + result.join('/')
}

/**
 * Validate whether a transform is valid
 */
export function validateTransform(transform: Transform): { valid: boolean; error?: string } {
  if (!transform || typeof transform !== 'object') {
    return { valid: false, error: 'Transform must be an object' }
  }

  if (!transform.op) {
    return { valid: false, error: 'Transform must have an "op" field' }
  }

  const validOps = ['set', 'delete', 'append', 'limit', 'redact', 'clamp', 'normalize_path']
  if (!validOps.includes(transform.op)) {
    return { valid: false, error: `Invalid op: ${transform.op}` }
  }

  if (typeof transform.path !== 'string') {
    return { valid: false, error: 'Transform must have a "path" field of type string' }
  }

  // Additional validation for specific operations
  if (transform.op === 'limit' && typeof transform.max !== 'number') {
    return { valid: false, error: 'limit transform must have a numeric "max" field' }
  }

  if (transform.op === 'redact' && typeof transform.pattern !== 'string') {
    return { valid: false, error: 'redact transform must have a "pattern" field' }
  }

  return { valid: true }
}
