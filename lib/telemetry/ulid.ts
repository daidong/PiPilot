/**
 * Minimal Crockford-base32 ULID generator (lib-internal — avoids external dep).
 *
 * 26 chars = 10 timestamp (48 bits ms since epoch) + 16 randomness (80 bits).
 * Sortable by time. Sufficient uniqueness for project ids, span instance ids, etc.
 */

import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I, L, O, U)
const ENCODING_LEN = ENCODING.length
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number): string {
  let t = now
  const out = new Array<string>(TIME_LEN)
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN
    out[i] = ENCODING[mod]!
    t = (t - mod) / ENCODING_LEN
  }
  return out.join('')
}

function encodeRandom(): string {
  // 16 chars * 5 bits = 80 bits → 10 random bytes
  const bytes = randomBytes(10)
  let out = ''
  // Treat 80-bit buffer as bigint, peel 16 base-32 digits.
  let acc = 0n
  for (const b of bytes) acc = (acc << 8n) | BigInt(b)
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ENCODING[Number(acc & 0x1fn)]! + out
    acc >>= 5n
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}
