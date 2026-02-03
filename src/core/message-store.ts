/**
 * MessageStore - Persistent storage for conversation messages
 *
 * Storage structure:
 * .agent-foundry/
 * ├── sessions/
 * │   ├── index.json              # Sessions index
 * │   ├── {sessionId}/
 * │   │   ├── messages.jsonl      # Message log (append-only)
 * │   │   ├── index.json          # Inverted index for search
 * │   │   └── meta.json           # Session metadata
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  Message,
  MessageStore,
  SessionMeta,
  SessionsIndex,
  SessionSearchResult,
  SessionSearchOptions
} from '../types/session.js'
import { generateMessageId, generateSessionId } from '../types/session.js'

/**
 * Simple tokenizer for keyword extraction
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2 && word.length <= 30)
    .filter(word => !STOP_WORDS.has(word))
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how'
])

/**
 * Session index for keyword search
 */
interface SessionIndexData {
  version: string
  updatedAt: string
  /** Keyword to message IDs mapping */
  keywords: Record<string, string[]>
  /** Message ID to line number mapping (for quick access) */
  messageLines: Record<string, number>
}

/**
 * File-based message store implementation
 */
export class FileMessageStore implements MessageStore {
  private basePath: string
  private sessionsPath: string
  private indexPath: string
  private sessionsIndex: SessionsIndex | null = null
  private initialized = false

  constructor(projectPath: string) {
    this.basePath = path.join(projectPath, '.agent-foundry')
    this.sessionsPath = path.join(this.basePath, 'sessions')
    this.indexPath = path.join(this.sessionsPath, 'index.json')
  }

  async init(): Promise<void> {
    if (this.initialized) return

    // Ensure directories exist
    await fs.mkdir(this.sessionsPath, { recursive: true })

    // Load or create sessions index
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8')
      this.sessionsIndex = JSON.parse(content)
    } catch {
      this.sessionsIndex = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        currentSessionId: null,
        sessions: {}
      }
      await this.saveSessionsIndex()
    }

    this.initialized = true
  }

  async close(): Promise<void> {
    if (this.sessionsIndex) {
      await this.saveSessionsIndex()
    }
    this.initialized = false
  }

  private async saveSessionsIndex(): Promise<void> {
    if (!this.sessionsIndex) return
    this.sessionsIndex.updatedAt = new Date().toISOString()
    await fs.writeFile(this.indexPath, JSON.stringify(this.sessionsIndex, null, 2), 'utf-8')
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsPath, sessionId)
  }

  private getMessagesPath(sessionId: string): string {
    return path.join(this.getSessionPath(sessionId), 'messages.jsonl')
  }

  private getSessionMetaPath(sessionId: string): string {
    return path.join(this.getSessionPath(sessionId), 'meta.json')
  }

  private getSessionIndexPath(sessionId: string): string {
    return path.join(this.getSessionPath(sessionId), 'index.json')
  }

  // ============ Write Operations ============

  async appendMessage(messageData: Omit<Message, 'id' | 'keywords'>): Promise<Message> {
    await this.init()

    const sessionId = messageData.sessionId
    const sessionPath = this.getSessionPath(sessionId)
    const messagesPath = this.getMessagesPath(sessionId)

    // Ensure session directory exists
    await fs.mkdir(sessionPath, { recursive: true })

    // Extract keywords
    const keywords = tokenize(messageData.content)

    // Create message with ID
    const message: Message = {
      ...messageData,
      id: generateMessageId(),
      keywords
    }

    // Append to messages file
    const line = JSON.stringify(message) + '\n'
    await fs.appendFile(messagesPath, line, 'utf-8')

    // Update session index (non-fatal — message is already persisted)
    try {
      await this.indexMessage(sessionId, message)
    } catch (err) {
      console.warn('[MessageStore] indexMessage failed (non-fatal):', err)
    }

    // Update session metadata
    await this.updateSessionMeta(sessionId, message)

    return message
  }

  private async indexMessage(sessionId: string, message: Message): Promise<void> {
    const indexPath = this.getSessionIndexPath(sessionId)
    let index: SessionIndexData

    try {
      const content = await fs.readFile(indexPath, 'utf-8')
      index = JSON.parse(content)
    } catch {
      index = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        keywords: {},
        messageLines: {}
      }
    }

    // Get current line count for this message
    const messagesPath = this.getMessagesPath(sessionId)
    try {
      const content = await fs.readFile(messagesPath, 'utf-8')
      const lines = content.trim().split('\n')
      index.messageLines[message.id] = lines.length - 1
    } catch {
      index.messageLines[message.id] = 0
    }

    // Index keywords (use Object.hasOwn to avoid prototype collisions like "constructor")
    for (const keyword of message.keywords) {
      if (!Object.hasOwn(index.keywords, keyword) || !Array.isArray(index.keywords[keyword])) {
        index.keywords[keyword] = []
      }
      if (!index.keywords[keyword]!.includes(message.id)) {
        index.keywords[keyword]!.push(message.id)
      }
    }

    index.updatedAt = new Date().toISOString()
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private async updateSessionMeta(sessionId: string, message: Message): Promise<void> {
    const metaPath = this.getSessionMetaPath(sessionId)
    let meta: SessionMeta

    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      meta = JSON.parse(content)
    } catch {
      meta = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        totalTokens: 0,
        status: 'active'
      }
    }

    meta.messageCount += 1
    meta.totalTokens += message.tokens ?? 0
    meta.updatedAt = new Date().toISOString()

    // Extract title from first user message
    if (!meta.title && message.role === 'user') {
      meta.title = message.content.substring(0, 100)
      if (message.content.length > 100) {
        meta.title += '...'
      }
    }

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

    // Update sessions index
    if (this.sessionsIndex) {
      this.sessionsIndex.sessions[sessionId] = meta
      await this.saveSessionsIndex()
    }
  }

  // ============ Read Operations ============

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    await this.init()

    const messagesPath = this.getMessagesPath(sessionId)

    try {
      const content = await fs.readFile(messagesPath, 'utf-8')
      const lines = content.trim().split('\n').filter(line => line.length > 0)

      // Get last N messages
      const startIdx = Math.max(0, lines.length - limit)
      const messages: Message[] = []

      for (let i = startIdx; i < lines.length; i++) {
        try {
          messages.push(JSON.parse(lines[i]!))
        } catch {
          // Skip malformed lines
        }
      }

      return messages
    } catch {
      return []
    }
  }

  async getMessage(messageId: string): Promise<Message | null> {
    await this.init()

    // Search all sessions for the message
    if (!this.sessionsIndex) return null

    for (const sessionId of Object.keys(this.sessionsIndex.sessions)) {
      const indexPath = this.getSessionIndexPath(sessionId)

      try {
        const content = await fs.readFile(indexPath, 'utf-8')
        const index: SessionIndexData = JSON.parse(content)

        if (index.messageLines[messageId] !== undefined) {
          const lineNum = index.messageLines[messageId]
          const messagesPath = this.getMessagesPath(sessionId)
          const messagesContent = await fs.readFile(messagesPath, 'utf-8')
          const lines = messagesContent.trim().split('\n')

          if (lineNum < lines.length) {
            return JSON.parse(lines[lineNum]!)
          }
        }
      } catch {
        continue
      }
    }

    return null
  }

  async getMessageRange(sessionId: string, startIdx: number, endIdx: number): Promise<Message[]> {
    await this.init()

    const messagesPath = this.getMessagesPath(sessionId)

    try {
      const content = await fs.readFile(messagesPath, 'utf-8')
      const lines = content.trim().split('\n').filter(line => line.length > 0)

      const messages: Message[] = []
      const actualStart = Math.max(0, startIdx)
      const actualEnd = Math.min(lines.length, endIdx)

      for (let i = actualStart; i < actualEnd; i++) {
        try {
          messages.push(JSON.parse(lines[i]!))
        } catch {
          // Skip malformed lines
        }
      }

      return messages
    } catch {
      return []
    }
  }

  async searchMessages(sessionId: string, query: string, limit = 20): Promise<Message[]> {
    await this.init()

    const indexPath = this.getSessionIndexPath(sessionId)
    const queryKeywords = tokenize(query)

    if (queryKeywords.length === 0) {
      return []
    }

    try {
      const content = await fs.readFile(indexPath, 'utf-8')
      const index: SessionIndexData = JSON.parse(content)

      // Find message IDs that match query keywords
      const messageScores: Map<string, number> = new Map()

      for (const keyword of queryKeywords) {
        const raw = index.keywords[keyword]
        const matchingIds = Array.isArray(raw) ? raw : []
        for (const id of matchingIds) {
          messageScores.set(id, (messageScores.get(id) ?? 0) + 1)
        }
      }

      // Sort by score and get top results
      const sortedIds = [...messageScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id)

      // Load matching messages
      const messagesPath = this.getMessagesPath(sessionId)
      const messagesContent = await fs.readFile(messagesPath, 'utf-8')
      const lines = messagesContent.trim().split('\n')

      const messages: Message[] = []
      for (const msgId of sortedIds) {
        const lineNum = index.messageLines[msgId]
        if (lineNum !== undefined && lineNum < lines.length) {
          try {
            messages.push(JSON.parse(lines[lineNum]!))
          } catch {
            // Skip malformed
          }
        }
      }

      return messages
    } catch {
      return []
    }
  }

  // ============ Session Management ============

  async createSession(): Promise<string> {
    await this.init()

    const sessionId = generateSessionId()
    const sessionPath = this.getSessionPath(sessionId)

    await fs.mkdir(sessionPath, { recursive: true })

    const meta: SessionMeta = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      totalTokens: 0,
      status: 'active'
    }

    await fs.writeFile(this.getSessionMetaPath(sessionId), JSON.stringify(meta, null, 2), 'utf-8')

    // Create empty index
    const index: SessionIndexData = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      keywords: {},
      messageLines: {}
    }
    await fs.writeFile(this.getSessionIndexPath(sessionId), JSON.stringify(index, null, 2), 'utf-8')

    // Update sessions index
    if (this.sessionsIndex) {
      this.sessionsIndex.sessions[sessionId] = meta
      this.sessionsIndex.currentSessionId = sessionId
      await this.saveSessionsIndex()
    }

    return sessionId
  }

  async getCurrentSessionId(): Promise<string | null> {
    await this.init()
    return this.sessionsIndex?.currentSessionId ?? null
  }

  async setCurrentSession(sessionId: string): Promise<void> {
    await this.init()

    if (!this.sessionsIndex) return

    // Verify session exists
    if (!this.sessionsIndex.sessions[sessionId]) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    this.sessionsIndex.currentSessionId = sessionId
    await this.saveSessionsIndex()
  }

  async getSession(sessionId: string): Promise<SessionMeta | null> {
    await this.init()

    const metaPath = this.getSessionMetaPath(sessionId)

    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return null
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    await this.init()

    if (!this.sessionsIndex) return []

    return Object.values(this.sessionsIndex.sessions)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.init()

    const metaPath = this.getSessionMetaPath(sessionId)

    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      const meta: SessionMeta = JSON.parse(content)
      meta.status = 'archived'
      meta.updatedAt = new Date().toISOString()
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

      // Update sessions index
      if (this.sessionsIndex) {
        this.sessionsIndex.sessions[sessionId] = meta
        if (this.sessionsIndex.currentSessionId === sessionId) {
          this.sessionsIndex.currentSessionId = null
        }
        await this.saveSessionsIndex()
      }
    } catch {
      throw new Error(`Failed to archive session: ${sessionId}`)
    }
  }

  // ============ Search with Options ============

  async searchWithOptions(
    sessionId: string,
    query: string,
    options?: SessionSearchOptions
  ): Promise<SessionSearchResult[]> {
    await this.init()

    const limit = options?.limit ?? 20
    const recencyBias = options?.recencyBias ?? 'medium'
    const includeTools = options?.includeTools ?? true

    const queryKeywords = tokenize(query)
    if (queryKeywords.length === 0) {
      return []
    }

    const indexPath = this.getSessionIndexPath(sessionId)
    const messagesPath = this.getMessagesPath(sessionId)

    try {
      const indexContent = await fs.readFile(indexPath, 'utf-8')
      const index: SessionIndexData = JSON.parse(indexContent)

      const messagesContent = await fs.readFile(messagesPath, 'utf-8')
      const lines = messagesContent.trim().split('\n')

      // Calculate scores for each message
      const results: SessionSearchResult[] = []
      const totalMessages = lines.length

      // Find messages matching keywords
      const messageMatches: Map<string, { score: number; keywords: string[] }> = new Map()

      for (const keyword of queryKeywords) {
        const raw = index.keywords[keyword]
        const matchingIds = Array.isArray(raw) ? raw : []
        for (const id of matchingIds) {
          const existing = messageMatches.get(id) ?? { score: 0, keywords: [] }
          existing.score += 1
          existing.keywords.push(keyword)
          messageMatches.set(id, existing)
        }
      }

      // Load and score messages
      for (const [msgId, match] of messageMatches) {
        const lineNum = index.messageLines[msgId]
        if (lineNum === undefined || lineNum >= lines.length) continue

        try {
          const message: Message = JSON.parse(lines[lineNum]!)

          // Filter by role
          if (!includeTools && message.role === 'tool') continue

          // Filter by time range
          if (options?.timeRange) {
            const msgTime = new Date(message.timestamp).getTime()
            if (options.timeRange.from && msgTime < new Date(options.timeRange.from).getTime()) continue
            if (options.timeRange.to && msgTime > new Date(options.timeRange.to).getTime()) continue
          }

          // Calculate final score with recency bias
          let score = match.score / queryKeywords.length

          // Apply recency bias
          const recencyFactor = (lineNum + 1) / totalMessages
          switch (recencyBias) {
            case 'high':
              score = score * 0.5 + recencyFactor * 0.5
              break
            case 'medium':
              score = score * 0.7 + recencyFactor * 0.3
              break
            case 'low':
              score = score * 0.9 + recencyFactor * 0.1
              break
          }

          // Create snippet
          let snippet = message.content
          if (snippet.length > 150) {
            snippet = snippet.substring(0, 147) + '...'
          }

          results.push({
            message,
            score,
            matchedKeywords: match.keywords,
            snippet
          })
        } catch {
          continue
        }
      }

      // Sort by score and limit
      results.sort((a, b) => b.score - a.score)
      return results.slice(0, limit)
    } catch {
      return []
    }
  }
}

/**
 * Create a new FileMessageStore instance
 */
export function createMessageStore(projectPath: string): MessageStore {
  return new FileMessageStore(projectPath)
}
