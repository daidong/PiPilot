/**
 * Personal Assistant Commands
 */

// Entity CRUD
export { saveNote } from './save-note.js'
export { saveDoc } from './save-doc.js'
export { deleteEntity } from './delete.js'

// Entity queries
export { listNotes, listDocs } from './list.js'
export { listTodos } from './list-todos.js'
export { searchEntities } from './search.js'

// Todo operations
export { toggleTodoComplete } from './toggle-todo-complete.js'

// Selection & pinning
export { toggleSelect, getSelected, clearSelections } from './select.js'
export { togglePin, getPinned } from './pin.js'

// Types
export type { SaveNoteResult } from './save-note.js'
export type { SaveDocResult } from './save-doc.js'
export type { DeleteResult } from './delete.js'
export type { NoteListItem, DocListItem } from './list.js'
export type { TodoListItem } from './list-todos.js'
export type { ToggleTodoCompleteResult } from './toggle-todo-complete.js'
export type { SearchResult } from './search.js'
export type { SelectResult, SelectedEntity } from './select.js'
export type { PinResult, PinnedEntity } from './pin.js'
