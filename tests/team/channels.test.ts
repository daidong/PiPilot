/**
 * Channel Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChannelHub, createChannelHub } from '../../src/team/channels/channel.js'
import type { ChannelMessage, ChannelTraceContext } from '../../src/team/channels/channel.js'

describe('ChannelHub', () => {
  let hub: ChannelHub
  let traceEvents: unknown[]
  let traceCtx: ChannelTraceContext

  beforeEach(() => {
    hub = createChannelHub()
    traceEvents = []
    traceCtx = {
      runId: 'run-001',
      trace: {
        record: (event) => traceEvents.push(event)
      }
    }
    hub.setTraceContext(traceCtx)
  })

  describe('publish/subscribe', () => {
    it('should deliver messages to subscribers', async () => {
      const received: ChannelMessage[] = []

      hub.subscribe('test-channel', 'subscriber1', (msg) => {
        received.push(msg)
      })

      await hub.publish('test-channel', { data: 'hello' }, 'publisher1')

      expect(received.length).toBe(1)
      expect(received[0].payload).toEqual({ data: 'hello' })
      expect(received[0].from).toBe('publisher1')
    })

    it('should support multiple subscribers', async () => {
      const received1: ChannelMessage[] = []
      const received2: ChannelMessage[] = []

      hub.subscribe('test-channel', 'sub1', (msg) => received1.push(msg))
      hub.subscribe('test-channel', 'sub2', (msg) => received2.push(msg))

      await hub.publish('test-channel', 'message', 'pub')

      expect(received1.length).toBe(1)
      expect(received2.length).toBe(1)
    })

    it('should support wildcard subscriptions', async () => {
      const received: ChannelMessage[] = []

      hub.subscribe('events.*', 'subscriber', (msg) => {
        received.push(msg)
      })

      await hub.publish('events.user', { type: 'user' }, 'pub')
      await hub.publish('events.system', { type: 'system' }, 'pub')
      await hub.publish('other.channel', { type: 'other' }, 'pub')

      expect(received.length).toBe(2)
    })

    it('should support message filters', async () => {
      const received: ChannelMessage[] = []

      hub.subscribe('test-channel', 'subscriber', (msg) => {
        received.push(msg)
      }, {
        filter: (msg) => (msg.payload as { priority?: string }).priority === 'high'
      })

      await hub.publish('test-channel', { priority: 'low' }, 'pub')
      await hub.publish('test-channel', { priority: 'high' }, 'pub')

      expect(received.length).toBe(1)
      expect((received[0].payload as { priority: string }).priority).toBe('high')
    })
  })

  describe('unsubscribe', () => {
    it('should stop receiving messages after unsubscribe', async () => {
      const received: ChannelMessage[] = []

      const sub = hub.subscribe('test-channel', 'subscriber', (msg) => {
        received.push(msg)
      })

      await hub.publish('test-channel', 'msg1', 'pub')
      hub.unsubscribe(sub.id)
      await hub.publish('test-channel', 'msg2', 'pub')

      expect(received.length).toBe(1)
    })

    it('should return false for invalid subscription ID', () => {
      expect(hub.unsubscribe('invalid-id')).toBe(false)
    })
  })

  describe('request/response', () => {
    it('should support request/response pattern', async () => {
      // Set up responder
      hub.subscribe('service', 'responder', async (msg) => {
        await hub.reply(msg, { result: 'success', input: msg.payload }, 'responder')
      })

      const response = await hub.request<{ query: string }, { result: string; input: unknown }>(
        'service',
        { query: 'test' },
        'requester',
        { timeoutMs: 1000 }
      )

      expect(response.result).toBe('success')
      expect(response.input).toEqual({ query: 'test' })
    })

    it('should timeout on no response', async () => {
      // No responder set up

      await expect(
        hub.request('service', { query: 'test' }, 'requester', { timeoutMs: 100 })
      ).rejects.toThrow('timeout')
    })
  })

  describe('message history', () => {
    it('should retain message history', async () => {
      await hub.publish('test-channel', 'msg1', 'pub')
      await hub.publish('test-channel', 'msg2', 'pub')
      await hub.publish('test-channel', 'msg3', 'pub')

      const history = hub.getHistory('test-channel')

      expect(history.length).toBe(3)
      expect(history.map(m => m.payload)).toEqual(['msg1', 'msg2', 'msg3'])
    })

    it('should limit history size', async () => {
      const smallHub = createChannelHub({ maxRetainedMessages: 2 })

      await smallHub.publish('ch', 'msg1', 'pub')
      await smallHub.publish('ch', 'msg2', 'pub')
      await smallHub.publish('ch', 'msg3', 'pub')

      const history = smallHub.getHistory('ch')

      expect(history.length).toBe(2)
      expect(history.map(m => m.payload)).toEqual(['msg2', 'msg3'])
    })

    it('should return limited history', async () => {
      await hub.publish('test-channel', 'msg1', 'pub')
      await hub.publish('test-channel', 'msg2', 'pub')
      await hub.publish('test-channel', 'msg3', 'pub')

      const history = hub.getHistory('test-channel', 2)

      expect(history.length).toBe(2)
    })
  })

  describe('tracing', () => {
    it('should record publish events', async () => {
      await hub.publish('test-channel', 'data', 'publisher')

      expect(traceEvents.some(e =>
        (e as any).type === 'channel.publish' &&
        (e as any).channel === 'test-channel'
      )).toBe(true)
    })

    it('should record subscribe events', () => {
      hub.subscribe('test-channel', 'subscriber', () => {})

      expect(traceEvents.some(e =>
        (e as any).type === 'channel.subscribe' &&
        (e as any).channel === 'test-channel'
      )).toBe(true)
    })
  })

  describe('utility methods', () => {
    it('should return subscription patterns', () => {
      hub.subscribe('channel1', 'sub', () => {})
      hub.subscribe('channel2', 'sub', () => {})

      const patterns = hub.getSubscriptionPatterns()

      expect(patterns).toContain('channel1')
      expect(patterns).toContain('channel2')
    })

    it('should return subscriber count', () => {
      hub.subscribe('test-channel', 'sub1', () => {})
      hub.subscribe('test-channel', 'sub2', () => {})

      expect(hub.getSubscriberCount('test-channel')).toBe(2)
      expect(hub.getSubscriberCount('empty-channel')).toBe(0)
    })

    it('should clear all state', async () => {
      hub.subscribe('test-channel', 'sub', () => {})
      await hub.publish('test-channel', 'data', 'pub')

      hub.clear()

      expect(hub.getSubscriptionPatterns().length).toBe(0)
      expect(hub.getHistory('test-channel').length).toBe(0)
    })
  })
})
