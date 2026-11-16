/** Minimal in-process event bus. Strategies subscribe; the indexer and executor publish. */

export type BusTopic = 'market:changed' | 'head' | 'intent:updated' | 'settings:changed' | 'activity'

type Handler = (payload: unknown) => void

export class Bus {
  private handlers = new Map<BusTopic, Set<Handler>>()

  on(topic: BusTopic, handler: Handler): () => void {
    const set = this.handlers.get(topic) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(topic, set)
    return () => set.delete(handler)
  }

  emit(topic: BusTopic, payload?: unknown): void {
    for (const h of this.handlers.get(topic) ?? []) {
      try {
        h(payload)
      } catch {
        // A faulty subscriber must never break the publisher.
      }
    }
  }
}

/** Coalesces bursts of triggers into one call after `delayMs` of quiet (or `maxWaitMs`). */
export function debounce(fn: () => void, delayMs: number, maxWaitMs = delayMs * 4): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstAt = 0
  return () => {
    const now = Date.now()
    if (!timer) firstAt = now
    if (timer) clearTimeout(timer)
    const wait = Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - now))
    timer = setTimeout(() => {
      timer = undefined
      fn()
    }, wait)
  }
}
