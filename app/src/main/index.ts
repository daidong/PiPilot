import { app, BrowserWindow, protocol, shell, Menu } from 'electron'
import { setMaxListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'

// workspace-asset://  —  serves local workspace files (e.g. images
// referenced by markdown previews) to the renderer. Registered before
// app-ready so it's treated like a first-class web origin: supports
// fetch, streams, and image-element src. URLs look like:
//   workspace-asset://asset/<percent-encoded-absolute-path>
// The handler below decodes the pathname and readFile's it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'workspace-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

function mimeForExtension(p: string): string {
  const ext = (p.split('.').pop() || '').toLowerCase()
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    heic: 'image/heic',
    heif: 'image/heif'
  }
  return table[ext] || 'application/octet-stream'
}

// Raise the default EventTarget max-listener threshold for the main process.
//
// pi-agent-core shares a single AbortSignal across an entire agent turn and
// attaches a per-LLM-call abort listener inside its proxy fetch path
// (node_modules/@mariozechner/pi-agent-core/dist/proxy.js:79-81) without ever
// removing it on completion. A long turn with many sub-LLM calls (e.g. a
// literature-search batch + several follow-on tool calls) easily blows past
// Node's default of 10, and with the previous setting of 20 we still saw
// 21-listener warnings in the wild. Bump to 50 — the listeners are bounded
// per turn (signal is discarded when agent.run() returns and GC reclaims
// everything attached to it), so this caps the warning without masking a
// genuine indefinite leak.
setMaxListeners(50)
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

// macOS / Linux apps launched from Finder / .desktop launcher don't
// inherit shell env vars. Load them from the user's login shell so:
//   1) API keys (ANTHROPIC_API_KEY, etc.) defined in ~/.zshrc are picked up
//   2) PATH includes user-installed CLIs (modal, docker, brew/pyenv shims)
//
// PATH gets special handling: Electron pre-populates it with a minimal
// `/usr/bin:/bin:/usr/sbin:/sbin` set, so the "don't clobber existing
// vars" rule below would skip it and leave the shelled-out availability
// probes for Modal / Docker broken in packaged builds. Instead we PREPEND
// the shell's PATH so user-installed binaries (~/.local/bin,
// /opt/homebrew/bin, /usr/local/bin, pyenv shims) are found first while
// the minimal Electron defaults remain as a fallback.
if ((process.platform === 'darwin' || process.platform === 'linux') && !is.dev) {
  try {
    const shellPath = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const raw = execSync(`${shellPath} -ilc 'env'`, { encoding: 'utf-8', timeout: 5000 })
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx)
      const val = line.slice(idx + 1)
      // Don't overwrite Electron-internal vars
      if (key.startsWith('ELECTRON_')) continue
      if (key === 'PATH') {
        // Prepend shell PATH so user-installed CLIs win lookup, but keep
        // the Electron defaults appended for safety. Deduplicate entries
        // so a long-lived process doesn't accumulate bloat on re-runs.
        // This block only runs on darwin/linux (see the guard above), so the
        // POSIX ':' separator is always correct here.
        const sep = ':'
        const existing = (process.env.PATH || '').split(sep)
        const shellParts = val.split(sep)
        const seen = new Set<string>()
        const merged: string[] = []
        for (const p of [...shellParts, ...existing]) {
          if (!p || seen.has(p)) continue
          seen.add(p)
          merged.push(p)
        }
        process.env.PATH = merged.join(sep)
        continue
      }
      // For non-PATH vars, keep the original behavior — don't clobber an
      // already-set value (so explicit launch-time overrides still win).
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    // Silently ignore — user will see the "Modal CLI not installed" /
    // "Docker not detected" hints in the Compute sidebar as fallback.
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

  // Bind the workspace-asset:// handler once the app is ready. Any failure
  // (missing file, permission denied, etc.) returns 404 — the <img> tag
  // falls back to the browser's broken-image glyph rather than breaking
  // the whole drawer.
  protocol.handle('workspace-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const absPath = decodeURIComponent(url.pathname)
      const data = await readFile(absPath)
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mimeForExtension(absPath),
          'Cache-Control': 'no-cache'
        }
      })
    } catch {
      return new Response('', { status: 404 })
    }
  })

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
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
                  if (target) target.webContents.send('menu:open-settings')
                }
              },
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
        ...(process.platform === 'darwin'
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
                  if (target) target.webContents.send('menu:open-settings')
                }
              }
            ]),
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
