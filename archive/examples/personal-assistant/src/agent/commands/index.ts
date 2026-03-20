/**
 * Personal Assistant Commands (Minimal)
 */

// Artifact canonical surface
export {
  artifactCreate,
  artifactUpdate,
  artifactGet,
  artifactList,
  artifactSearch,
  artifactDelete
} from './artifact.js'

// Session summary
export {
  sessionSummaryGet
} from './session-summary.js'

// Read/list convenience commands
export { deleteEntity } from './delete.js'
export { listNotes, listDocs, listEmailMessages, listCalendarEvents } from './list.js'
export { listTodos } from './list-todos.js'
export { searchEntities } from './search.js'
export { toggleTodoComplete } from './toggle-todo-complete.js'

// Types
export type { ArtifactCreateResult, ArtifactUpdateResult, ArtifactDeleteResult, ArtifactSearchResult } from './artifact.js'
export type { SessionSummaryResult } from './session-summary.js'
export type { DeleteResult } from './delete.js'
export type { NoteListItem, DocListItem, MailListItem, CalendarListItem } from './list.js'
export type { TodoListItem } from './list-todos.js'
export type { ToggleTodoCompleteResult } from './toggle-todo-complete.js'
export type { SearchResult } from './search.js'
