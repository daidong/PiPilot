/**
 * Todo Types - Task tracking type definitions
 *
 * Used by the todo pack for structured task management.
 * Items are stored via the kv-memory infrastructure under the "todo" namespace.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked'
export type TodoPriority = 'low' | 'medium' | 'high' | 'critical'

export interface TodoItem {
  /** Auto-generated UUID */
  id: string
  /** Short description */
  title: string
  /** Detailed description */
  description?: string
  /** Current status */
  status: TodoStatus
  /** Priority level */
  priority: TodoPriority
  /** Parent task ID for sub-tasks */
  parentId?: string
  /** IDs of blocking tasks */
  blockedBy?: string[]
  /** Tags for categorization */
  tags?: string[]
  /** Creation timestamp (ISO string) */
  createdAt: string
  /** Last update timestamp (ISO string) */
  updatedAt: string
  /** Completion timestamp (ISO string) */
  completedAt?: string
}
