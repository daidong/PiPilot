import React, { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex h-screen w-screen t-bg-base t-text items-center justify-center">
        <div className="text-center max-w-md px-8">
          <div className="mx-auto mb-6 w-16 h-16 rounded-2xl t-bg-surface flex items-center justify-center">
            <AlertTriangle size={28} className="t-text-warning" />
          </div>
          <h1 className="text-lg font-semibold mb-2">Something went wrong</h1>
          <p className="t-text-secondary text-sm mb-4 leading-relaxed">
            {this.state.error?.message || 'An unexpected error occurred in the UI.'}
          </p>
          <button
            onClick={this.handleReload}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl t-bg-accent text-white font-medium hover:opacity-90 transition-colors text-sm"
          >
            <RotateCcw size={14} />
            Try Again
          </button>
        </div>
      </div>
    )
  }
}
