import { app, BrowserWindow, shell, Menu } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'path'
import { is } from '@electron-toolkit/utils'
import { closeProjectForWindow, registerIpcHandlers, registerWindow } from './ipc'

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
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'YOLO Researcher',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0a0a0a',
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

  win.webContents.on('will-navigate', (event, url) => {
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
  if (iconPath && process.platform === 'darwin') app.dock?.setIcon(iconPath)

  registerIpcHandlers()
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
      ? [{
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
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => registerWindow(createWindow())
        },
        { type: 'separator' },
        {
          label: 'Close Project',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (target) {
              void closeProjectForWindow(target)
            }
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
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
