import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './global.css'
import { bootTheme } from './theme-boot'

// Apply the theme class to <html> before React's first render so CSS
// custom properties are already resolved and no flash of default-white
// background paints on the welcome screen.
bootTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
