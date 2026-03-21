import React, { useEffect, useRef, useState } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useUIStore } from '../../stores/ui-store'
import { useSessionStore } from '../../stores/session-store'

const api = (window as any).api

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [alive, setAlive] = useState(false)
  const projectPath = useSessionStore((s) => s.projectPath)
  const theme = useUIStore((s) => s.theme)
  const visible = useUIStore((s) => s.terminalVisible)

  const spawn = async () => {
    if (!projectPath) return
    const result = await api.terminalSpawn(projectPath)
    if (result.success) setAlive(true)
  }

  // Initialize xterm instance once (component stays mounted while alive)
  useEffect(() => {
    if (!termRef.current) return

    const isDark = theme === 'dark'
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      allowProposedApi: true,
      theme: isDark ? {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a3a5a'
      } : {
        background: '#fafafa',
        foreground: '#1a1a1a',
        cursor: '#1a1a1a',
        selectionBackground: '#c0d0e0'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(termRef.current)

    // Fit after layout settles
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fit.fit()
        api.terminalResize(term.cols, term.rows)
      })
    })

    xtermRef.current = term
    fitRef.current = fit

    // Send user input to PTY
    term.onData((data) => {
      api.terminalInput(data)
    })

    // Receive PTY output
    const unsubData = api.onTerminalData((data: string) => {
      term.write(data)
    })

    const unsubExit = api.onTerminalExit(() => {
      setAlive(false)
      term.write('\r\n\x1b[90m[Process exited. Press any key to restart.]\x1b[0m\r\n')
    })

    // Resize observer
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        api.terminalResize(term.cols, term.rows)
      } catch {}
    })
    observer.observe(termRef.current)

    // Auto-spawn on first mount
    spawn()

    return () => {
      observer.disconnect()
      unsubData()
      unsubExit()
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      // Kill PTY when component unmounts (X button closes terminal)
      api.terminalKill()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when visibility changes (container goes from 0 to real height)
  useEffect(() => {
    if (!visible) return
    const fit = fitRef.current
    if (!fit) return
    requestAnimationFrame(() => {
      fit.fit()
      const term = xtermRef.current
      if (term) api.terminalResize(term.cols, term.rows)
    })
  }, [visible])

  // Update theme without re-creating terminal
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    const isDark = theme === 'dark'
    term.options.theme = isDark ? {
      background: '#1a1a1a',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      selectionBackground: '#3a3a5a'
    } : {
      background: '#fafafa',
      foreground: '#1a1a1a',
      cursor: '#1a1a1a',
      selectionBackground: '#c0d0e0'
    }
  }, [theme])

  // Handle key press to restart when shell has exited
  useEffect(() => {
    const term = xtermRef.current
    if (!term || alive) return
    const disposable = term.onKey(() => {
      spawn()
    })
    return () => disposable.dispose()
  }, [alive, projectPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestart = async () => {
    await api.terminalKill()
    xtermRef.current?.clear()
    await spawn()
  }

  // X button: fully destroy terminal (unmounts component)
  const handleClose = () => {
    useUIStore.getState().closeTerminal()
  }

  return (
    <div className="flex flex-col border-t t-border" style={{ height: '100%' }}>
      {/* Header bar */}
      <div className="h-7 flex items-center justify-between px-3 border-b t-border t-bg-surface shrink-0">
        <span className="text-[11px] font-medium t-text-muted uppercase tracking-wider">Terminal</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRestart}
            className="p-0.5 rounded t-text-muted hover:t-text-secondary t-bg-hover"
            title="Restart terminal"
          >
            <RotateCcw size={12} />
          </button>
          <button
            onClick={handleClose}
            className="p-0.5 rounded t-text-muted hover:t-text-secondary t-bg-hover"
            title="Close terminal"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {/* Terminal viewport */}
      <div ref={termRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
