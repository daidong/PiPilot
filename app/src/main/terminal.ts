/**
 * Terminal — node-pty backend for integrated terminal.
 *
 * Manages PTY processes per BrowserWindow. Each window gets one terminal
 * instance that persists until the window is closed or the shell exits.
 */

import { ipcMain, BrowserWindow } from 'electron'
import os from 'os'

// node-pty is a native module — lazy-import to avoid build issues
let pty: typeof import('node-pty') | null = null
async function getPty() {
  if (!pty) pty = await import('node-pty')
  return pty
}

type IPty = import('node-pty').IPty

const terminals = new Map<number, IPty>()

function getShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function registerTerminalHandlers(): void {
  ipcMain.handle('terminal:spawn', async (event, cwd: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window' }
    const winId = win.id

    // Kill existing terminal for this window
    const existing = terminals.get(winId)
    if (existing) {
      existing.kill()
      terminals.delete(winId)
    }

    try {
      const nodePty = await getPty()
      const shell = getShell()
      const term = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: cwd || os.homedir(),
        env: { ...process.env } as Record<string, string>
      })

      terminals.set(winId, term)

      // Forward PTY output to renderer
      term.onData((data: string) => {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:data', data)
        }
      })

      term.onExit(({ exitCode }) => {
        terminals.delete(winId)
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:exit', exitCode)
        }
      })

      return { success: true, pid: term.pid }
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
    }
  })

  ipcMain.on('terminal:input', (event, data: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const term = terminals.get(win.id)
    term?.write(data)
  })

  ipcMain.on('terminal:resize', (event, cols: number, rows: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const term = terminals.get(win.id)
    try {
      term?.resize(cols, rows)
    } catch {
      // Ignore resize errors (can happen during shutdown)
    }
  })

  ipcMain.handle('terminal:kill', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const existing = terminals.get(win.id)
    if (existing) {
      existing.kill()
      terminals.delete(win.id)
    }
  })
}

/** Clean up all terminals (call on app quit). */
export function destroyAllTerminals(): void {
  for (const [id, term] of terminals) {
    try { term.kill() } catch {}
    terminals.delete(id)
  }
}
