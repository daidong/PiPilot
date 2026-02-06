/**
 * Personal Assistant Commands (RFC-013)
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

// Focus canonical surface
export {
  focusAdd,
  focusList,
  focusRemove,
  focusClear,
  focusPrune
} from './focus.js'

// Task anchor canonical surface
export {
  taskAnchorGet,
  taskAnchorSet,
  taskAnchorUpdate
} from './task-anchor.js'

// Explain canonical surface
export {
  memoryExplainTurn,
  memoryExplainFact,
  memoryExplainBudget
} from './memory-explain.js'

// Legacy compatibility wrappers
export { saveNote } from './save-note.js'
export { saveDoc } from './save-doc.js'
export { deleteEntity } from './delete.js'
export { listNotes, listDocs, listEmailMessages, listCalendarEvents } from './list.js'
export { listTodos } from './list-todos.js'
export { searchEntities } from './search.js'
export { toggleTodoComplete } from './toggle-todo-complete.js'
export { toggleSelect, getSelected, clearSelections, getWorkingSetIds } from './select.js'
export { togglePin, getPinned } from './pin.js'

// Types
export type { ArtifactCreateResult, ArtifactUpdateResult, ArtifactDeleteResult, ArtifactSearchResult } from './artifact.js'
export type { FocusAddResult, FocusListResult, FocusRemoveResult, FocusPruneResult } from './focus.js'
export type { TaskAnchorResult } from './task-anchor.js'
export type { MemoryExplainResult } from './memory-explain.js'

export type { SaveNoteResult } from './save-note.js'
export type { SaveDocResult } from './save-doc.js'
export type { DeleteResult } from './delete.js'
export type { NoteListItem, DocListItem, MailListItem, CalendarListItem } from './list.js'
export type { TodoListItem } from './list-todos.js'
export type { ToggleTodoCompleteResult } from './toggle-todo-complete.js'
export type { SearchResult } from './search.js'
export type { SelectResult, SelectedEntity } from './select.js'
export type { PinResult, PinnedEntity } from './pin.js'
