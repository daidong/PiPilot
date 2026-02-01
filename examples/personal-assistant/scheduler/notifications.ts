/**
 * NotificationStore - Persisted notification storage
 *
 * Stores agent notifications to disk with FIFO eviction at 100 items.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { PATHS, type AgentNotification } from '../types.js'

const MAX_NOTIFICATIONS = 100

export class NotificationStore {
  private notifications: AgentNotification[] = []
  private projectPath: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.load()
  }

  private get filePath(): string {
    return join(this.projectPath, PATHS.notifications)
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        this.notifications = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      } catch {
        this.notifications = []
      }
    }
  }

  private save(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.notifications, null, 2))
  }

  /** Add a notification, evicting oldest if over limit */
  add(n: Omit<AgentNotification, 'id' | 'createdAt'>): AgentNotification {
    const full: AgentNotification = {
      ...n,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }
    this.notifications.push(full)
    // FIFO eviction
    while (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications.shift()
    }
    this.save()
    return full
  }

  /** List all notifications, newest first */
  list(): AgentNotification[] {
    return [...this.notifications].reverse()
  }

  /** Mark a single notification as read */
  markRead(id: string): boolean {
    const n = this.notifications.find(n => n.id === id)
    if (n && !n.readAt) {
      n.readAt = new Date().toISOString()
      this.save()
      return true
    }
    return false
  }

  /** Mark all notifications as read */
  markAllRead(): void {
    const now = new Date().toISOString()
    let changed = false
    for (const n of this.notifications) {
      if (!n.readAt) {
        n.readAt = now
        changed = true
      }
    }
    if (changed) this.save()
  }

  /** Count unread notifications */
  unreadCount(): number {
    return this.notifications.filter(n => !n.readAt).length
  }
}
