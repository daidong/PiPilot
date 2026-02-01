import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppWithErrorBoundary } from './App'
import './global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppWithErrorBoundary />
  </React.StrictMode>
)
