/**
 * Tests for format utility (RFC-002)
 */

import { describe, it, expect } from 'vitest'
import {
  format,
  formatJson,
  formatList,
  formatBullets,
  formatKeyValue,
  formatTable,
  formatTruncated
} from '../../src/team/utils/format.js'

describe('format', () => {
  describe('null/undefined handling', () => {
    it('should return "(no input)" for null', () => {
      expect(format(null)).toBe('(no input)')
    })

    it('should return "(no input)" for undefined', () => {
      expect(format(undefined)).toBe('(no input)')
    })
  })

  describe('string handling', () => {
    it('should return strings as-is', () => {
      expect(format('hello world')).toBe('hello world')
    })

    it('should handle empty strings', () => {
      expect(format('')).toBe('')
    })

    it('should handle multiline strings', () => {
      const input = 'line 1\nline 2\nline 3'
      expect(format(input)).toBe(input)
    })
  })

  describe('number handling', () => {
    it('should convert numbers to strings', () => {
      expect(format(42)).toBe('42')
      expect(format(3.14)).toBe('3.14')
      expect(format(0)).toBe('0')
      expect(format(-100)).toBe('-100')
    })
  })

  describe('boolean handling', () => {
    it('should convert booleans to strings', () => {
      expect(format(true)).toBe('true')
      expect(format(false)).toBe('false')
    })
  })

  describe('array handling', () => {
    it('should format empty arrays', () => {
      expect(format([])).toBe('(empty list)')
    })

    it('should format simple string arrays as numbered list', () => {
      const result = format(['apple', 'banana', 'cherry'])
      expect(result).toBe('1. apple\n2. banana\n3. cherry')
    })

    it('should format complex arrays as JSON', () => {
      const input = [{ id: 1 }, { id: 2 }]
      const result = format(input)
      expect(result).toContain('"id": 1')
      expect(result).toContain('"id": 2')
    })

    it('should format mixed arrays as JSON', () => {
      const input = ['string', 42, { key: 'value' }]
      const result = format(input)
      expect(result).toContain('"string"')
      expect(result).toContain('42')
      expect(result).toContain('"key"')
    })
  })

  describe('object handling', () => {
    it('should format empty objects', () => {
      expect(format({})).toBe('(empty object)')
    })

    it('should format simple objects with key-value format', () => {
      const result = format({ name: 'John', age: 30 }, { style: 'pretty' })
      // Could be key-value or JSON depending on implementation
      expect(result).toContain('name')
      expect(result).toContain('John')
      expect(result).toContain('age')
      expect(result).toContain('30')
    })

    it('should format complex objects as JSON', () => {
      const input = {
        user: { name: 'John', email: 'john@example.com' },
        settings: { theme: 'dark' }
      }
      const result = format(input)
      expect(result).toContain('"user"')
      expect(result).toContain('"name"')
      expect(result).toContain('"John"')
    })
  })

  describe('truncation', () => {
    it('should truncate long output', () => {
      const longString = 'x'.repeat(20000)
      const result = format(longString, { maxLength: 100 })
      expect(result.length).toBeLessThanOrEqual(120) // Allow for suffix
      expect(result).toContain('truncated')
    })
  })

  describe('style options', () => {
    it('should support json style', () => {
      const result = format({ key: 'value' }, { style: 'json' })
      expect(result).toContain('"key"')
      expect(result).toContain('"value"')
    })

    it('should support compact style for arrays', () => {
      const result = format(['a', 'b', 'c'], { style: 'compact' })
      expect(result).toBe('a, b, c')
    })
  })
})

describe('formatJson', () => {
  it('should format objects as JSON', () => {
    const result = formatJson({ key: 'value' })
    expect(result).toBe('{\n  "key": "value"\n}')
  })

  it('should handle null', () => {
    expect(formatJson(null)).toBe('null')
  })

  it('should handle undefined', () => {
    expect(formatJson(undefined)).toBe('null')
  })

  it('should respect custom indentation', () => {
    const result = formatJson({ key: 'value' }, 4)
    expect(result).toBe('{\n    "key": "value"\n}')
  })
})

describe('formatList', () => {
  it('should format arrays as numbered list', () => {
    const result = formatList(['first', 'second', 'third'])
    expect(result).toBe('1. first\n2. second\n3. third')
  })

  it('should handle empty arrays', () => {
    expect(formatList([])).toBe('(empty list)')
  })

  it('should format objects in list', () => {
    const result = formatList([{ id: 1 }, { id: 2 }])
    expect(result).toContain('1. ')
    expect(result).toContain('2. ')
    expect(result).toContain('"id"')
  })

  it('should support custom prefix', () => {
    const result = formatList(['a', 'b'], { prefix: '  ' })
    expect(result).toBe('  1. a\n  2. b')
  })
})

describe('formatBullets', () => {
  it('should format arrays as bullet list', () => {
    const result = formatBullets(['first', 'second'])
    expect(result).toBe('- first\n- second')
  })

  it('should handle empty arrays', () => {
    expect(formatBullets([])).toBe('(empty list)')
  })

  it('should support custom bullet', () => {
    const result = formatBullets(['a', 'b'], { bullet: '*' })
    expect(result).toBe('* a\n* b')
  })
})

describe('formatKeyValue', () => {
  it('should format objects as key-value pairs', () => {
    const result = formatKeyValue({ name: 'John', age: 30 })
    expect(result).toBe('name: John\nage: 30')
  })

  it('should handle empty objects', () => {
    expect(formatKeyValue({})).toBe('(no data)')
  })

  it('should handle null values', () => {
    const result = formatKeyValue({ key: null })
    expect(result).toBe('key: (none)')
  })

  it('should support custom separator', () => {
    const result = formatKeyValue({ key: 'value' }, { separator: ' = ' })
    expect(result).toBe('key = value')
  })

  it('should support inline format', () => {
    const result = formatKeyValue({ a: 1, b: 2 }, { lineBreak: false })
    expect(result).toBe('a: 1, b: 2')
  })
})

describe('formatTable', () => {
  it('should format array of objects as table', () => {
    const items = [
      { name: 'John', age: 30 },
      { name: 'Jane', age: 25 }
    ]
    const result = formatTable(items)
    expect(result).toContain('name')
    expect(result).toContain('age')
    expect(result).toContain('John')
    expect(result).toContain('Jane')
    expect(result).toContain('---')
  })

  it('should handle empty arrays', () => {
    expect(formatTable([])).toBe('(empty table)')
  })

  it('should support custom columns', () => {
    const items = [
      { name: 'John', age: 30, city: 'NYC' },
      { name: 'Jane', age: 25, city: 'LA' }
    ]
    const result = formatTable(items, ['name', 'city'])
    expect(result).toContain('name')
    expect(result).toContain('city')
    expect(result).not.toContain('age')
  })
})

describe('formatTruncated', () => {
  it('should not truncate short content', () => {
    const result = formatTruncated('short', 100)
    expect(result).toBe('short')
  })

  it('should truncate long content', () => {
    const longString = 'x'.repeat(100)
    const result = formatTruncated(longString, 50)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result).toContain('truncated')
  })

  it('should support custom suffix', () => {
    const longString = 'x'.repeat(100)
    const result = formatTruncated(longString, 50, { suffix: '...' })
    expect(result.endsWith('...')).toBe(true)
  })
})
