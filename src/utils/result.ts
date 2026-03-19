/**
 * Result<T, E> — lightweight discriminated union for no-throw code paths.
 *
 * Instead of throwing, functions return Ok | Err so callers are forced to
 * handle both branches at compile-time.
 *
 * @example
 * const r = await tryCatch(() => riskyAsyncOp())
 * if (!r.ok) { console.error(r.error); return }
 * console.log(r.value)
 */

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/**
 * Wrap an async function so that throws become `{ ok: false, error }`.
 * The returned promise itself never rejects.
 */
export async function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}
