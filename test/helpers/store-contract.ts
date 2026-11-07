import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { LimitRule, Store } from '../../src/index.js'

/**
 * The behaviour every Store must share. Runs against the memory store in the unit tests and against
 * Redis in the redis tests, so the Lua scripts can't drift from the JS version.
 */
export function storeContract(makeStore: () => Store): void {
  const w = 60_000
  // Synthetic clock, aligned to a window start and close to real time so TTLs stay sensible.
  const start = Math.floor(Date.now() / w) * w
  const key = () => `test:${randomUUID()}`

  it('fixed window: allows `max`, then denies until the window ends, and refunds', async () => {
    const store = makeStore()
    const rule: LimitRule = { max: 2, windowMs: w, strategy: 'fixed' }
    const k = key()
    expect(await store.consume(k, rule, start + 1000)).toEqual({
      allowed: true,
      remaining: 1,
      resetAt: start + w,
    })
    expect(await store.consume(k, rule, start + 2000)).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: start + w,
    })
    expect(await store.consume(k, rule, start + 3000)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: start + w,
    })
    await store.refund(k, rule, start + 2000)
    expect((await store.consume(k, rule, start + 4000)).allowed).toBe(true)
  })

  it('sliding window: the previous window fades out as the current one goes on', async () => {
    const store = makeStore()
    const rule: LimitRule = { max: 2, windowMs: w, strategy: 'sliding' }
    const k = key()
    await store.consume(k, rule, start + 1000)
    await store.consume(k, rule, start + 2000)
    expect((await store.consume(k, rule, start + 3000)).allowed).toBe(false)

    // Halfway through the next window, the previous 2 count as 1, so one more fits.
    const next = start + w
    expect(await store.consume(k, rule, next + w / 2)).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: next + w,
    })
    expect(await store.consume(k, rule, next + w / 2)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: next + w,
    })
  })

  it('token bucket: refills one request every windowMs / max', async () => {
    const store = makeStore()
    const rule: LimitRule = { max: 2, windowMs: w, strategy: 'token-bucket' }
    const k = key()
    const t = start + 1000
    await store.consume(k, rule, t)
    await store.consume(k, rule, t)
    expect(await store.consume(k, rule, t)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: t + w / 2,
    })
    expect((await store.consume(k, rule, t + w / 2)).allowed).toBe(true)
  })

  it('peek reads a limit without taking from it, and get/set round-trip a value', async () => {
    const store = makeStore()
    const rule: LimitRule = { max: 1, windowMs: w, strategy: 'fixed' }
    const k = key()
    expect((await store.peek(k, rule, start + 1000)).remaining).toBe(1)
    expect((await store.peek(k, rule, start + 1000)).remaining).toBe(1)
    expect((await store.consume(k, rule, start + 1000)).allowed).toBe(true)

    expect(await store.get(`${k}:value`)).toBeUndefined()
    await store.set(`${k}:value`, 'hello', 10_000)
    expect(await store.get(`${k}:value`)).toBe('hello')
  })
}
