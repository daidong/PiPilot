/**
 * useAgent Hook - Wraps coordinator.chat() with streaming and line tracking
 */

import { useState, useCallback, useRef } from 'react'
import { createCoordinator } from '../../agents/coordinator.js'
import { LineStore } from '../LineStore.js'
import type { ResolvedMention } from '../../mentions/index.js'

interface UseAgentOptions {
  apiKey: string
  projectPath: string
  debug: boolean
  lineStore: LineStore
}

interface UseAgentReturn {
  isStreaming: boolean
  lastResponse: string | undefined
  send: (message: string, mentions?: ResolvedMention[]) => Promise<void>
  coordinator: ReturnType<typeof createCoordinator> | null
}

export function useAgent({ apiKey, projectPath, debug, lineStore }: UseAgentOptions): UseAgentReturn {
  const [isStreaming, setIsStreaming] = useState(false)
  const [lastResponse, setLastResponse] = useState<string | undefined>()
  const coordinatorRef = useRef<ReturnType<typeof createCoordinator> | null>(null)
  // Buffer for streaming chunks to batch into LineStore
  const streamBufferRef = useRef('')

  // Lazy-init coordinator
  if (!coordinatorRef.current) {
    coordinatorRef.current = createCoordinator({
      apiKey,
      projectPath,
      debug,
      onStream: (text: string) => {
        streamBufferRef.current += text
      }
    })
  }

  const send = useCallback(async (message: string, mentions?: ResolvedMention[]) => {
    if (!coordinatorRef.current) return

    setIsStreaming(true)
    streamBufferRef.current = ''

    try {
      const result = await coordinatorRef.current.chat(message, mentions)

      if (result.success && result.response) {
        lineStore.append(result.response)
        setLastResponse(result.response)
      } else {
        const errorText = `Error: ${result.error}`
        lineStore.append(errorText)
        setLastResponse(undefined)
      }
    } catch (error) {
      const errorText = `Error: ${error instanceof Error ? error.message : String(error)}`
      lineStore.append(errorText)
      setLastResponse(undefined)
    } finally {
      setIsStreaming(false)
    }
  }, [lineStore])

  return {
    isStreaming,
    lastResponse,
    send,
    coordinator: coordinatorRef.current
  }
}
