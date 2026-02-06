/**
 * Legacy list wrappers over Memory V2 artifacts.
 */

import { artifactList } from './artifact.js'
import type { Provenance } from '../types.js'

export interface NoteListItem {
  id: string
  title: string
  content: string
  tags: string[]
  projectCard: boolean
  pinned: boolean
  selectedForAI: boolean
  provenance?: Provenance
}

export interface DocListItem {
  id: string
  title: string
  filePath: string
  mimeType?: string
  description?: string
  projectCard: boolean
  pinned: boolean
  selectedForAI: boolean
  tags?: string[]
  provenance?: Provenance
}

export interface MailListItem {
  id: string
  title: string
  threadId?: string
  from?: string
  subject?: string
  snippet?: string
  sentAt?: string
  tags?: string[]
}

export interface CalendarListItem {
  id: string
  title: string
  calendarName?: string
  startAt?: string
  endAt?: string
  location?: string
  tags?: string[]
}

export function listNotes(projectPath: string): NoteListItem[] {
  return artifactList(projectPath, ['note'])
    .filter(item => item.type === 'note')
    .map(note => ({
      id: note.id,
      title: note.title,
      content: note.content,
      tags: note.tags,
      projectCard: false,
      pinned: false,
      selectedForAI: false,
      provenance: note.provenance
    }))
}

export function listDocs(projectPath: string): DocListItem[] {
  return artifactList(projectPath, ['doc'])
    .filter(item => item.type === 'doc')
    .map(doc => ({
      id: doc.id,
      title: doc.title,
      filePath: doc.filePath,
      mimeType: doc.mimeType,
      description: doc.description,
      projectCard: false,
      pinned: false,
      selectedForAI: false,
      tags: doc.tags,
      provenance: doc.provenance
    }))
}

export function listEmailMessages(projectPath: string): MailListItem[] {
  return artifactList(projectPath, ['email-message'])
    .filter(item => item.type === 'email-message')
    .map(mail => ({
      id: mail.id,
      title: mail.title,
      threadId: mail.threadId,
      from: mail.from,
      subject: mail.subject,
      snippet: mail.snippet,
      sentAt: mail.sentAt,
      tags: mail.tags
    }))
}

export function listCalendarEvents(projectPath: string): CalendarListItem[] {
  return artifactList(projectPath, ['calendar-event'])
    .filter(item => item.type === 'calendar-event')
    .map(event => ({
      id: event.id,
      title: event.title,
      calendarName: event.calendarName,
      startAt: event.startAt,
      endAt: event.endAt,
      location: event.location,
      tags: event.tags
    }))
}
