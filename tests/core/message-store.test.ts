/**
 * MessageStore 行为测试
 *
 * Step 0 of the MessageStore extraction plan.
 * These tests lock down current message management behavior before refactoring.
 */

import { describe, it, expect, vi } from 'vitest'
import { MessageStore } from '../../src/core/message-store.js'
import type { Message } from '../../src/llm/index.js'

// Helper to create a message with known content
function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content }
}

// Helper to create a large message (~N tokens via the heuristic tokenizer)
// The SimpleTokenizer counts ~1 token per 4 non-CJK chars
function bigMsg(role: 'user' | 'assistant', approxTokens: number): Message {
  return { role, content: 'x'.repeat(approxTokens * 4) }
}

describe('MessageStore', () => {
  // ── Test 1: append() correctly adds messages to history ──────────────
  it('appends messages to history in order', () => {
    const store = new MessageStore()

    store.append(msg('user', 'hello'))
    store.append(msg('assistant', 'hi'))
    store.append(msg('user', 'bye'))

    const history = store.getHistory()
    expect(history).toHaveLength(3)
    expect(history[0]).toEqual(msg('user', 'hello'))
    expect(history[1]).toEqual(msg('assistant', 'hi'))
    expect(history[2]).toEqual(msg('user', 'bye'))
    expect(store.length).toBe(3)
  })

  // ── Test 2: pinned messages always appear first in buildView() ──────
  it('prepends pinned messages in buildView()', async () => {
    const pinned = msg('user', '[PINNED] always first')
    const store = new MessageStore({ pinnedMessages: [pinned] })

    store.append(msg('user', 'task'))
    store.append(msg('assistant', 'done'))

    const view = await store.buildView()
    expect(view[0]).toEqual(pinned)
    expect(view).toHaveLength(3)
  })

  // ── Test 3: buildView() applies transformContext ─────────────────────
  it('applies transformContext hook in buildView()', async () => {
    const transform = vi.fn(async (msgs: Message[]) => {
      return [...msgs, msg('user', '[injected context]')]
    })

    const store = new MessageStore({ transformContext: transform })
    store.append(msg('user', 'hello'))

    const view = await store.buildView()

    expect(transform).toHaveBeenCalledOnce()
    // transform receives a copy, not the internal array
    expect(transform).toHaveBeenCalledWith([msg('user', 'hello')])
    // injected context should be in the view
    expect(view[view.length - 1]).toEqual(msg('user', '[injected context]'))
  })

  // ── Test 4: GAP-6 token trim drops earliest non-pinned messages ─────
  it('trims oldest non-pinned messages when over token limit', async () => {
    // contextWindow=100, threshold=0.85 → limit=85 tokens
    // Each bigMsg(50) ≈ 50 tokens of content + JSON overhead
    const store = new MessageStore({
      contextWindow: 100,
      preCallTrimThreshold: 0.85,
    })

    // Add several messages that together exceed the limit
    store.append(bigMsg('user', 50))
    store.append(bigMsg('assistant', 50))
    store.append(bigMsg('user', 50))

    const view = await store.buildView()

    // Some messages should have been trimmed — view should be smaller than 3
    expect(view.length).toBeLessThan(3)
    // The last message should always survive (mutable.length > 1 guard)
    expect(view.length).toBeGreaterThanOrEqual(1)
  })

  // ── Test 5: pinned messages are never trimmed ───────────────────────
  it('never trims pinned messages even when over limit', async () => {
    const pinned = msg('user', '[PINNED] critical context')
    const store = new MessageStore({
      contextWindow: 100,
      preCallTrimThreshold: 0.85,
      pinnedMessages: [pinned],
    })

    // Fill with large messages
    store.append(bigMsg('user', 50))
    store.append(bigMsg('assistant', 50))
    store.append(bigMsg('user', 50))

    const view = await store.buildView()

    // Pinned message must still be first
    expect(view[0]).toEqual(pinned)
    // Non-pinned messages may be trimmed, but pinned survives
    expect(view.some(m => m.content === '[PINNED] critical context')).toBe(true)
  })

  // ── Test 6: pin() at runtime adds to pinned list ────────────────────
  it('runtime pin() adds messages to pinned set', async () => {
    const store = new MessageStore()
    store.append(msg('user', 'task'))

    store.pin(msg('user', '[DYNAMIC PIN] remember this'))

    const view = await store.buildView()
    expect(view[0]).toEqual(msg('user', '[DYNAMIC PIN] remember this'))
    expect(view).toHaveLength(2)
  })

  // ── Test 7: getHistory() returns immutable snapshot ─────────────────
  it('getHistory() returns a copy — mutations do not affect internal state', () => {
    const store = new MessageStore()
    store.append(msg('user', 'original'))

    const snapshot = store.getHistory()
    snapshot.push(msg('assistant', 'injected'))
    snapshot[0] = msg('user', 'tampered')

    // Internal state unchanged
    const fresh = store.getHistory()
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toEqual(msg('user', 'original'))
  })

  // ── Test 8: empty history + pin edge case ───────────────────────────
  it('buildView() works with empty history and pinned messages', async () => {
    const pinned = msg('user', '[PINNED] context')
    const store = new MessageStore({ pinnedMessages: [pinned] })

    // No messages appended
    const view = await store.buildView()
    expect(view).toHaveLength(1)
    expect(view[0]).toEqual(pinned)
  })

  it('buildView() returns empty array with no messages and no pins', async () => {
    const store = new MessageStore()
    const view = await store.buildView()
    expect(view).toEqual([])
  })

  // ── Additional: setHistory() and clear() ────────────────────────────
  it('setHistory() replaces messages without affecting pinned', async () => {
    const pinned = msg('user', '[PINNED]')
    const store = new MessageStore({ pinnedMessages: [pinned] })
    store.append(msg('user', 'old'))

    store.setHistory([msg('user', 'replaced')])

    expect(store.getHistory()).toEqual([msg('user', 'replaced')])
    expect(store.length).toBe(1)
    // Pinned still intact
    const view = await store.buildView()
    expect(view[0]).toEqual(pinned)
  })

  it('clear() removes history but preserves pinned', async () => {
    const pinned = msg('user', '[PINNED]')
    const store = new MessageStore({ pinnedMessages: [pinned] })
    store.append(msg('user', 'will be cleared'))

    store.clear()

    expect(store.length).toBe(0)
    expect(store.getHistory()).toEqual([])
    const view = await store.buildView()
    expect(view).toEqual([pinned])
  })

  // ── transformContext receives copy, not internal reference ───────────
  it('transformContext cannot mutate internal message history', async () => {
    const evilTransform = vi.fn((msgs: Message[]) => {
      msgs.push(msg('user', 'sneaky'))
      msgs[0].content = 'tampered'
      return msgs
    })

    const store = new MessageStore({ transformContext: evilTransform })
    store.append(msg('user', 'safe'))

    await store.buildView()

    // Internal state must be untouched
    expect(store.getHistory()).toEqual([msg('user', 'safe')])
  })
})
