"use strict";
const electron = require("electron");
const api = {
  sendMessage: (message, rawMentions) => electron.ipcRenderer.invoke("agent:send", message, rawMentions),
  onStreamChunk: (cb) => {
    const handler = (_, chunk) => cb(chunk);
    electron.ipcRenderer.on("agent:stream-chunk", handler);
    return () => electron.ipcRenderer.removeListener("agent:stream-chunk", handler);
  },
  onAgentDone: (cb) => {
    const handler = (_, result) => cb(result);
    electron.ipcRenderer.on("agent:done", handler);
    return () => electron.ipcRenderer.removeListener("agent:done", handler);
  },
  listNotes: () => electron.ipcRenderer.invoke("cmd:list-notes"),
  listLiterature: () => electron.ipcRenderer.invoke("cmd:list-literature"),
  listData: () => electron.ipcRenderer.invoke("cmd:list-data"),
  search: (query) => electron.ipcRenderer.invoke("cmd:search", query),
  deleteEntity: (id) => electron.ipcRenderer.invoke("cmd:delete", id),
  saveNote: (title, content, messageId) => electron.ipcRenderer.invoke("cmd:save-note", title, content, messageId),
  savePaper: (argsStr) => electron.ipcRenderer.invoke("cmd:save-paper", argsStr),
  saveData: (argsStr) => electron.ipcRenderer.invoke("cmd:save-data", argsStr),
  toggleSelect: (id) => electron.ipcRenderer.invoke("cmd:select", id),
  getSelected: () => electron.ipcRenderer.invoke("cmd:get-selected"),
  clearSelections: () => electron.ipcRenderer.invoke("cmd:clear-selections"),
  togglePin: (id) => electron.ipcRenderer.invoke("cmd:pin", id),
  getPinned: () => electron.ipcRenderer.invoke("cmd:get-pinned"),
  getCandidates: (partial, type) => electron.ipcRenderer.invoke("mention:candidates", partial, type),
  onTodoUpdate: (cb) => {
    const handler = (_, item) => cb(item);
    electron.ipcRenderer.on("agent:todo-update", handler);
    return () => electron.ipcRenderer.removeListener("agent:todo-update", handler);
  },
  onTodoClear: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on("agent:todo-clear", handler);
    return () => electron.ipcRenderer.removeListener("agent:todo-clear", handler);
  },
  onFileCreated: (cb) => {
    const handler = (_, path) => cb(path);
    electron.ipcRenderer.on("agent:file-created", handler);
    return () => electron.ipcRenderer.removeListener("agent:file-created", handler);
  },
  readFile: (path) => electron.ipcRenderer.invoke("file:read", path),
  listRootFiles: () => electron.ipcRenderer.invoke("file:list-root"),
  getCurrentSession: () => electron.ipcRenderer.invoke("session:current"),
  pickFolder: () => electron.ipcRenderer.invoke("project:pick-folder"),
  saveMessage: (sessionId, msg) => electron.ipcRenderer.invoke("session:save-message", sessionId, msg),
  loadMessages: (sessionId, offset, limit) => electron.ipcRenderer.invoke("session:load-messages", sessionId, offset, limit),
  getMessageCount: (sessionId) => electron.ipcRenderer.invoke("session:get-total-count", sessionId),
  markMessageSaved: (sessionId, messageId) => electron.ipcRenderer.invoke("session:mark-saved", sessionId, messageId),
  loadSavedMessageIds: (sessionId) => electron.ipcRenderer.invoke("session:load-saved-ids", sessionId)
};
electron.contextBridge.exposeInMainWorld("api", api);
