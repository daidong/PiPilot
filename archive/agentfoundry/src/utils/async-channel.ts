/**
 * AsyncChannel — bridges push-based callbacks to pull-based AsyncIterator.
 *
 * Used to convert LLM streaming callbacks (onText, onToolCall) into an
 * async iterable that can be `yield*`'d from an AsyncGenerator.
 */

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void
}

export interface AsyncChannel<T> {
  /** Push a value into the channel (producer side) */
  push(value: T): void
  /** Signal that no more values will be pushed */
  done(): void
  /** Signal an error — the next pull will reject */
  error(err: Error): void
  /** AsyncIterator protocol */
  [Symbol.asyncIterator](): AsyncIterator<T>
}

/**
 * Create a simple unbuffered async channel.
 *
 * - `push(value)` enqueues a value; if a consumer is waiting, it's resolved immediately
 * - `done()` signals end-of-stream
 * - `error(err)` signals an error
 * - `for await (const v of channel)` consumes values as they arrive
 */
export function createChannel<T>(): AsyncChannel<T> {
  const buffer: T[] = []
  let finished = false
  let channelError: Error | undefined
  let waiter: Waiter<T> | null = null

  function push(value: T): void {
    if (finished) return
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve({ done: false, value })
    } else {
      buffer.push(value)
    }
  }

  function done(): void {
    finished = true
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve({ done: true, value: undefined as any })
    }
  }

  function error(err: Error): void {
    channelError = err
    finished = true
    if (waiter) {
      const w = waiter
      waiter = null
      // Resolve with done=true; the error will be thrown on next iteration
      w.resolve({ done: true, value: undefined as any })
    }
  }

  const iterator: AsyncIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      // Drain error
      if (channelError) {
        const err = channelError
        channelError = undefined
        return Promise.reject(err)
      }

      // Drain buffer
      if (buffer.length > 0) {
        return Promise.resolve({ done: false, value: buffer.shift()! })
      }

      // Stream ended
      if (finished) {
        return Promise.resolve({ done: true, value: undefined as any })
      }

      // Wait for next push
      return new Promise<IteratorResult<T>>((resolve) => {
        waiter = { resolve }
      })
    }
  }

  return {
    push,
    done,
    error,
    [Symbol.asyncIterator]() { return iterator }
  }
}
