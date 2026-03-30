// Types
export type { FileTreeNode, GitIgnoreRule, ResolvedCoordinatorAuth } from './types'
export type { SharedHandlerContext } from './ipc-base'

// File tree utilities
export {
  TREE_MAX_ENTRIES,
  toPosixPath,
  isWithinRoot,
  readGitIgnoreRules,
  isHiddenPath,
  isIgnored,
  hasVisibleChildren,
  listTreeChildren,
  searchTree
} from './file-tree'

// IPC handler utilities and registrations
export {
  getFileName,
  inferMimeType,
  safeSend,
  isValidProjectDirectory,
  loadOrCreateSessionId,
  resolveCoordinatorAuth,
  registerFileHandlers,
  registerSessionHandlers,
  registerPrefsHandlers,
  registerUsageHandlers,
  registerAuthHandlers,
  registerFolderOpenHandler,
  registerConfigHandlers,
  loadApiKeysFromConfig
} from './ipc-base'
