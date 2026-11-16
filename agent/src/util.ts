/** Small shared helpers: time, bigint math, JSON with bigint, sleep. */

export const nowMs = (): number => Date.now()
export const nowSec = (): number => Math.floor(Date.now() / 1000)

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: divisor must be positive')
  return a >= 0n ? (a + b - 1n) / b : a / b
}

/** Round up to the next multiple of `tick`. */
export function ceilToTick(value: bigint, tick: bigint): bigint {
  if (tick <= 0n) throw new Error('tick must be positive')
  return ceilDiv(value, tick) * tick
}

/** Round down to a multiple of `tick`. */
export function floorToTick(value: bigint, tick: bigint): bigint {
  if (tick <= 0n) throw new Error('tick must be positive')
  return (value / tick) * tick
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b)
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b)

/** JSON.stringify that writes bigint as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function median(values: bigint[]): bigint | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

/** Lowercase an address for map keys. Never use for checksum display. */
export const lc = (address: string): string => address.toLowerCase()

export function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0].slice(0, 300)
  return String(error).slice(0, 300)
}
