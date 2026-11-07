export type LimitStrategy = 'sliding' | 'fixed' | 'token-bucket'

export interface LimitRule {
  max: number
  windowMs: number
  strategy: LimitStrategy
}

export interface LimitState {
  allowed: boolean
  remaining: number
  /**
   * Epoch ms. With no room left, when the next request can go through. With room left, when the
   * window ends or the bucket is full again.
   */
  resetAt: number
}

/**
 * Where rate limits and the response cache keep their state. Use `memoryStore()` for one process,
 * or `redisStore()` from `moraq/redis` to share state across instances.
 */
export interface Store {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlMs: number): Promise<void>
  /** Takes one request from the limit if it has room. Atomic for each key. */
  consume(key: string, rule: LimitRule, now: number): Promise<LimitState>
  /** Reads the limit without taking anything. */
  peek(key: string, rule: LimitRule, now: number): Promise<LimitState>
  /** Gives back one request that `consume` took at `takenAt`. */
  refund(key: string, rule: LimitRule, takenAt: number): Promise<void>
}

/** Counter keys for the window that contains `at`, and the one before it. */
export function windowKeys(
  key: string,
  windowMs: number,
  at: number,
): { current: string; previous: string; start: number } {
  const index = Math.floor(at / windowMs)
  return { current: `${key}:${index}`, previous: `${key}:${index - 1}`, start: index * windowMs }
}

/**
 * Sliding window (two-counter approximation): the previous window's count fades out linearly as
 * the current window goes on. Returns when the next request fits again.
 */
export function slidingResetAt(
  rule: LimitRule,
  start: number,
  previous: number,
  current: number,
): number {
  const { max, windowMs: w } = rule
  if (current + 1 > max) return start + w + Math.max(0, w * (1 - (max - 1) / current))
  return start + w * (1 - (max - 1 - current) / previous)
}

interface Entry {
  value: string | number | { tokens: number; ts: number }
  expiresAt: number
}

export interface MemoryStoreOptions {
  /** Above this many keys, expired ones get swept and then the oldest get dropped. Defaults to 10000. */
  maxEntries?: number
}

/**
 * Keeps state in this process. Counts reset when the process restarts, and each instance of a
 * scaled-out or serverless app keeps its own counts. Use `redisStore()` for shared limits.
 */
export function memoryStore({ maxEntries = 10_000 }: MemoryStoreOptions = {}): Store {
  const entries = new Map<string, Entry>()

  const read = (key: string, now: number): Entry['value'] | undefined => {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      entries.delete(key)
      return undefined
    }
    return entry.value
  }
  const write = (key: string, value: Entry['value'], ttlMs: number, now: number) => {
    entries.delete(key)
    entries.set(key, { value, expiresAt: now + ttlMs })
    if (entries.size <= maxEntries) return
    for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k)
    // Map keeps insertion order and `write` re-inserts, so the first keys are the least recently written.
    for (const k of entries.keys()) {
      if (entries.size <= maxEntries) break
      entries.delete(k)
    }
  }
  const count = (key: string, now: number) => {
    const value = read(key, now)
    return typeof value === 'number' ? value : 0
  }

  function apply(key: string, rule: LimitRule, now: number, take: boolean): LimitState {
    const { max, windowMs } = rule
    if (rule.strategy === 'token-bucket') {
      const rate = max / windowMs
      const saved = read(`${key}:tb`, now) as { tokens: number; ts: number } | undefined
      let tokens = Math.min(max, (saved?.tokens ?? max) + (now - (saved?.ts ?? now)) * rate)
      const allowed = tokens >= 1
      if (take && allowed) tokens -= 1
      if (take) write(`${key}:tb`, { tokens, ts: now }, windowMs, now)
      const resetAt = tokens >= 1 ? now + (max - tokens) / rate : now + (1 - tokens) / rate
      return { allowed, remaining: Math.floor(tokens), resetAt: Math.floor(resetAt) }
    }

    const { current, previous, start } = windowKeys(key, windowMs, now)
    let curr = count(current, now)
    if (rule.strategy === 'fixed') {
      const allowed = curr < max
      if (take && allowed) write(current, ++curr, start + windowMs - now, now)
      return { allowed, remaining: Math.max(0, max - curr), resetAt: start + windowMs }
    }

    const prev = count(previous, now)
    let used = prev * ((windowMs - (now - start)) / windowMs) + curr
    const allowed = used + 1 <= max
    if (take && allowed) {
      write(current, ++curr, start + 2 * windowMs - now, now)
      used += 1
    }
    const remaining = Math.max(0, Math.floor(max - used))
    const full = !(used + 1 <= max)
    const resetAt = full ? slidingResetAt(rule, start, prev, curr) : start + windowMs
    return { allowed, remaining, resetAt: Math.floor(resetAt) }
  }

  return {
    async get(key) {
      const value = read(key, Date.now())
      return typeof value === 'string' ? value : undefined
    },
    async set(key, value, ttlMs) {
      write(key, value, ttlMs, Date.now())
    },
    async consume(key, rule, now) {
      return apply(key, rule, now, true)
    },
    async peek(key, rule, now) {
      return apply(key, rule, now, false)
    },
    async refund(key, rule, takenAt) {
      const now = Date.now()
      if (rule.strategy === 'token-bucket') {
        const saved = read(`${key}:tb`, now) as { tokens: number; ts: number } | undefined
        if (saved)
          write(
            `${key}:tb`,
            { tokens: Math.min(rule.max, saved.tokens + 1), ts: saved.ts },
            rule.windowMs,
            now,
          )
        return
      }
      const { current } = windowKeys(key, rule.windowMs, takenAt)
      const entry = entries.get(current)
      if (entry && typeof entry.value === 'number' && entry.value > 0) entry.value -= 1
    },
  }
}
