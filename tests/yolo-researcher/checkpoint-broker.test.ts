import { describe, expect, it } from 'vitest'

import { CheckpointBroker } from '../../examples/yolo-researcher/runtime/checkpoint-broker.js'

describe('checkpoint broker queue controls', () => {
  it('supports reprioritize, move, and remove operations', () => {
    const broker = new CheckpointBroker()
    const a = broker.enqueueInput('A', 'normal')
    const b = broker.enqueueInput('B', 'normal')
    const c = broker.enqueueInput('C', 'urgent')

    broker.updateQueuedInputPriority(a.id, 'urgent')
    let queue = broker.getQueueSnapshot()
    expect(queue.map((item) => item.priority)).toEqual(['urgent', 'normal', 'urgent'])

    broker.moveQueuedInput(c.id, 0)
    queue = broker.getQueueSnapshot()
    expect(queue.map((item) => item.id)).toEqual([c.id, a.id, b.id])

    broker.removeQueuedInput(a.id)
    queue = broker.getQueueSnapshot()
    expect(queue.map((item) => item.id)).toEqual([c.id, b.id])
  })

  it('drains with urgent-first ordering at turn boundary', () => {
    const broker = new CheckpointBroker()
    const first = broker.enqueueInput('first', 'normal')
    const second = broker.enqueueInput('second', 'urgent')
    const third = broker.enqueueInput('third', 'urgent')
    const fourth = broker.enqueueInput('fourth', 'normal')

    const merged = broker.drainAtTurnBoundary()
    expect(merged.map((item) => item.id)).toEqual([second.id, third.id, first.id, fourth.id])
    expect(broker.getQueueSnapshot()).toHaveLength(0)
  })
})
