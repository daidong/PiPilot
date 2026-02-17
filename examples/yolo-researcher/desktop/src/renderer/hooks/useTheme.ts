import { useEffect, useState } from 'react'

export type AppTheme = 'light' | 'dark'

function readThemeFromDom(): AppTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function readInitialTheme(): AppTheme {
  const saved = localStorage.getItem('yolo-theme')
  if (saved === 'dark' || saved === 'light') return saved
  return readThemeFromDom()
}

export function useTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => readInitialTheme())

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    root.classList.add(theme)
    localStorage.setItem('yolo-theme', theme)
  }, [theme])

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  return {
    theme,
    toggleTheme,
  }
}
