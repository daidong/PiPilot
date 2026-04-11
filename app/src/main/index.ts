import { app, BrowserWindow, shell, Menu } from 'electron'
import { setMaxListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Raise default max listeners — pi-agent-core's parallel tool execution
// shares a single AbortSignal across many tools, exceeding the default of 10.
setMaxListeners(20)
import { join, resolve } from 'path'
import { is } from '@electron-toolkit/utils'
import { loadApiKeysFromConfig } from '@shared-electron/ipc-base'
import { registerIpcHandlers, registerWindow, destroyAllCoordinators } from './ipc'
import { registerTerminalHandlers, destroyAllTerminals } from './terminal'

// Load API keys from ~/.research-copilot/config.json (lowest priority).
// Environment variables from shell or process take precedence.
loadApiKeysFromConfig()

// Enable long-lived prompt cache (1h TTL) for Anthropic API.
// Other providers (OpenAI, Google) use automatic prefix caching and ignore this.
if (!process.env.PI_CACHE_RETENTION) {
  process.env.PI_CACHE_RETENTION = 'long'
}

// macOS apps launched from Finder don't inherit shell env vars.
// Load them from the user's login shell so API keys etc. are available.
if (process.platform === 'darwin' && !is.dev) {
  try {
    const shellPath = process.env.SHELL || '/bin/zsh'
    const raw = execSync(`${shellPath} -ilc 'env'`, { encoding: 'utf-8', timeout: 5000 })
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const key = line.slice(0, idx)
        const val = line.slice(idx + 1)
        // Don't overwrite Electron-internal vars
        if (!key.startsWith('ELECTRON_') && !process.env[key]) {
          process.env[key] = val
        }
      }
    }
  } catch {
    // Silently ignore — user will see the "key missing" dialog as fallback
  }
}

function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'build', 'icon.png'),
    resolve(__dirname, '../../build/icon.png'),
    resolve(__dirname, '../../../build/icon.png'),
    resolve(__dirname, '../build/icon.png'),
    process.resourcesPath ? join(process.resourcesPath, 'build', 'icon.png') : ''
  ].filter(Boolean)

  return candidates.find((p) => existsSync(p))
}

function createWindow(): BrowserWindow {
  const iconPath = resolveAppIconPath()
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#141a1e',
    ...(process.platform === 'darwin' ? {} : iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Open all external links in the system browser instead of navigating in-app
  win.webContents.on('will-navigate', (event, url) => {
    // Allow dev server reloads
    if (is.dev && url.startsWith(process.env.ELECTRON_RENDERER_URL || '')) return
    event.preventDefault()
    shell.openExternal(url)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const iconPath = resolveAppIconPath()
  if (iconPath && process.platform === 'darwin') {
    app.dock?.setIcon(iconPath)
  }
  registerIpcHandlers()
  registerTerminalHandlers()
  registerWindow(createWindow())
  buildMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      registerWindow(createWindow())
    }
  })
})

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            registerWindow(createWindow())
          }
        },
        { type: 'separator' },
        {
          label: 'Export Chat…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (target) target.webContents.send('menu:export-chat')
          }
        },
        { type: 'separator' },
        {
          label: 'Close Project',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (target) target.webContents.send('project:closed')
          }
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('window-all-closed', () => {
  destroyAllTerminals()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  destroyAllTerminals()
  // Ensure compute processes are cleaned up before quitting.
  // Prevent default quit, run async cleanup, then quit.
  event.preventDefault()
  destroyAllCoordinators().finally(() => {
    // Remove this handler to avoid infinite loop, then quit
    app.exit(0)
  })
})
