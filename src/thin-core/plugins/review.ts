import type { PluginDefinition } from '../types.js'

interface ReviewPacket {
  id: string
  title: string
  summary: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected'
  ask?: string
  createdAt: number
  updatedAt: number
  decision?: {
    action: 'approve' | 'request_changes' | 'reject'
    comment?: string
    at: number
  }
}

const KEY = 'review.packets'

async function loadPackets(getMemory: (key: string) => Promise<unknown>): Promise<ReviewPacket[]> {
  const current = await getMemory(KEY)
  if (!Array.isArray(current)) return []
  return current as ReviewPacket[]
}

export function reviewPlugin(): PluginDefinition {
  return {
    manifest: {
      id: 'core.review',
      version: '1.0.0',
      capabilities: ['review', 'ui']
    },
    prompts: [
      'Use review.create when work is ready for user decision. Use review.decide for approve/request_changes/reject.'
    ],
    tools: [
      {
        name: 'review.create',
        description: 'Create a review packet for human decision.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Packet title' },
            summary: { type: 'string', description: 'What changed and why' },
            ask: { type: 'string', description: 'Specific ask for reviewer' }
          },
          required: ['title', 'summary']
        },
        async execute(args, ctx) {
          const input = args as { title?: string; summary?: string; ask?: string }
          const packets = await loadPackets(ctx.store.getMemory.bind(ctx.store))
          const seq = packets.length + 1
          const id = `RP-${String(seq).padStart(4, '0')}`
          const now = Date.now()
          const packet: ReviewPacket = {
            id,
            title: input.title ?? 'Untitled Packet',
            summary: input.summary ?? '',
            ask: input.ask,
            status: 'pending',
            createdAt: now,
            updatedAt: now
          }

          packets.push(packet)
          await ctx.store.setMemory(KEY, packets)
          await ctx.emit('review.packet_created', {
            packetId: id,
            title: packet.title
          })

          return {
            ok: true,
            content: JSON.stringify(packet, null, 2),
            data: packet
          }
        }
      },
      {
        name: 'review.list',
        description: 'List review packets.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Optional status filter' }
          },
          required: []
        },
        async execute(args, ctx) {
          const input = args as { status?: string }
          const packets = await loadPackets(ctx.store.getMemory.bind(ctx.store))
          const filtered = input.status
            ? packets.filter(packet => packet.status === input.status)
            : packets

          return {
            ok: true,
            content: JSON.stringify(filtered, null, 2),
            data: filtered
          }
        }
      },
      {
        name: 'review.decide',
        description: 'Record review decision: approve/request_changes/reject.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Packet ID' },
            action: { type: 'string', description: 'approve | request_changes | reject' },
            comment: { type: 'string', description: 'Optional comment' }
          },
          required: ['id', 'action']
        },
        async execute(args, ctx) {
          const input = args as { id?: string; action?: string; comment?: string }
          const packets = await loadPackets(ctx.store.getMemory.bind(ctx.store))
          const packet = packets.find(item => item.id === input.id)
          if (!packet) {
            return {
              ok: false,
              isError: true,
              content: `review packet not found: ${input.id}`
            }
          }

          let status: ReviewPacket['status']
          switch (input.action) {
            case 'approve':
              status = 'approved'
              break
            case 'request_changes':
              status = 'changes_requested'
              break
            case 'reject':
              status = 'rejected'
              break
            default:
              return {
                ok: false,
                isError: true,
                content: `invalid review action: ${input.action}`
              }
          }

          packet.status = status
          packet.updatedAt = Date.now()
          packet.decision = {
            action: input.action as 'approve' | 'request_changes' | 'reject',
            comment: input.comment,
            at: Date.now()
          }

          await ctx.store.setMemory(KEY, packets)
          await ctx.emit('review.packet_decided', {
            packetId: packet.id,
            action: input.action,
            status
          })

          return {
            ok: true,
            content: JSON.stringify(packet, null, 2),
            data: packet
          }
        }
      }
    ]
  }
}
