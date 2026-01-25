import { describe, it, expect } from 'vitest'
import { getMCPServerByName, scoreMCPByQuery } from '../../src/recommendation/mcp-catalog.js'

describe('MarkItDown MCP Server', () => {
  it('should exist in catalog', () => {
    const entry = getMCPServerByName('markitdown')
    expect(entry).toBeDefined()
    expect(entry?.category).toBe('documents')
    expect(entry?.riskLevel).toBe('safe')
  })

  it('should have correct transport config', () => {
    const entry = getMCPServerByName('markitdown')
    expect(entry?.configTemplate.transport.type).toBe('stdio')
    expect(entry?.configTemplate.transport.command).toBe('npx')
  })

  it('should be recommended for document conversion queries', () => {
    const results = scoreMCPByQuery('convert pdf to markdown')
    const markitdown = results.find(r => r.entry.name === 'markitdown')
    expect(markitdown).toBeDefined()
    expect(markitdown?.score).toBeGreaterThan(0.3)
  })

  it('should be recommended for audio transcription', () => {
    const results = scoreMCPByQuery('transcribe audio to text')
    const markitdown = results.find(r => r.entry.name === 'markitdown')
    expect(markitdown).toBeDefined()
  })

  it('should be recommended for Chinese queries', () => {
    const results = scoreMCPByQuery('文档转换 PDF')
    const markitdown = results.find(r => r.entry.name === 'markitdown')
    expect(markitdown).toBeDefined()
  })

  it('should have correct package name', () => {
    const entry = getMCPServerByName('markitdown')
    expect(entry?.package).toBe('markitdown-mcp-npx')
  })

  it('should have high popularity', () => {
    const entry = getMCPServerByName('markitdown')
    expect(entry?.popularity).toBe('high')
  })

  it('should list required dependencies', () => {
    const entry = getMCPServerByName('markitdown')
    expect(entry?.requires?.dependencies).toContain('Node.js 16+')
    expect(entry?.requires?.dependencies).toContain('Python 3.10+')
  })

  it('should have filesystem and network permissions', () => {
    const entry = getMCPServerByName('markitdown')
    const permissions = entry?.permissions
    expect(permissions).toBeDefined()
    expect(permissions?.some(p => p.type === 'filesystem')).toBe(true)
    expect(permissions?.some(p => p.type === 'network')).toBe(true)
  })
})
