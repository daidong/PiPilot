import React from 'react'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { HeroIdle } from '../center/HeroIdle'
import { ChatMessages } from '../center/ChatMessages'
import { ChatInput } from '../center/ChatInput'

export function CenterPanel() {
  const isIdle = useUIStore((s) => s.isIdle)
  const messages = useChatStore((s) => s.messages)
  const showHero = isIdle && messages.length === 0

  return (
    <main className="flex-1 flex flex-col min-w-0 pt-10">
      {showHero ? (
        <div className="flex-1 flex items-center justify-center">
          <HeroIdle />
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-6 py-4">
          <ChatMessages />
        </div>
      )}

      <div className="px-6 pb-6">
        <ChatInput />
      </div>
    </main>
  )
}
