import { type LimitRule, type LimitState, type Store, windowKeys } from './store.js'

export type { LimitRule, LimitState, LimitStrategy, Store } from './store.js'

/**
 * The part of a Redis client moraq uses. ioredis exposes `call(...)`. node-redis (v4 and up)
 * exposes `sendCommand([...])`.
 */
export type RedisClient =
  | { call(command: string, ...args: (string | number)[]): Promise<unknown> }
  | { sendCommand(args: string[]): Promise<unknown> }

// Each script handles one limit and runs atomically. Modes: consume, peek, refund.
// Keys are computed in JS and passed in, so the scripts also work on Redis Cluster.

const FIXED = `
local mode, max, w, now, start = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local curr = tonumber(redis.call('GET', KEYS[1]) or '0')
if mode == 'refund' then
  if curr > 0 then redis.call('DECR', KEYS[1]) end
  return {1, 0, 0}
end
local allowed = curr < max
if mode == 'consume' and allowed then
  curr = redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], start + w - now)
end
return {allowed and 1 or 0, math.max(0, max - curr), start + w}
`

const SLIDING = `
local mode, max, w, now, start = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local curr = tonumber(redis.call('GET', KEYS[1]) or '0')
if mode == 'refund' then
  if curr > 0 then redis.call('DECR', KEYS[1]) end
  return {1, 0, 0}
end
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local used = prev * ((w - (now - start)) / w) + curr
local allowed = used + 1 <= max
if mode == 'consume' and allowed then
  curr = redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], start + 2 * w - now)
  used = used + 1
end
local reset = start + w
if not (used + 1 <= max) then
  if curr + 1 > max then
    reset = start + w + math.max(0, w * (1 - (max - 1) / curr))
  else
    reset = start + w * (1 - (max - 1 - curr) / prev)
  end
end
return {allowed and 1 or 0, math.max(0, math.floor(max - used)), math.floor(reset)}
`

const TOKEN_BUCKET = `
local mode, max, w, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local rate = max / w
local saved = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local savedTokens, savedTs = tonumber(saved[1]), tonumber(saved[2])
if mode == 'refund' then
  if savedTokens then
    redis.call('HSET', KEYS[1], 'tokens', tostring(math.min(max, savedTokens + 1)))
    redis.call('PEXPIRE', KEYS[1], w)
  end
  return {1, 0, 0}
end
local tokens = math.min(max, (savedTokens or max) + (now - (savedTs or now)) * rate)
local allowed = tokens >= 1
if mode == 'consume' then
  if allowed then tokens = tokens - 1 end
  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], w)
end
local reset
if tokens >= 1 then reset = now + (max - tokens) / rate else reset = now + (1 - tokens) / rate end
return {allowed and 1 or 0, math.floor(tokens), math.floor(reset)}
`

/**
 * Keeps rate limits and the cache in Redis, so every instance of your app shares them.
 * Pass an ioredis or node-redis client that is already connected.
 */
export function redisStore(client: RedisClient): Store {
  const command = (args: (string | number)[]): Promise<unknown> =>
    'call' in client
      ? client.call(String(args[0]), ...args.slice(1))
      : client.sendCommand(args.map(String))

  async function run(
    mode: 'consume' | 'peek' | 'refund',
    key: string,
    rule: LimitRule,
    now: number,
  ): Promise<LimitState> {
    let script: string
    let keys: string[]
    const extra: number[] = []
    if (rule.strategy === 'token-bucket') {
      script = TOKEN_BUCKET
      keys = [`${key}:tb`]
    } else {
      const { current, previous, start } = windowKeys(key, rule.windowMs, now)
      script = rule.strategy === 'fixed' ? FIXED : SLIDING
      keys = rule.strategy === 'fixed' ? [current] : [current, previous]
      extra.push(start)
    }
    const reply = (await command([
      'EVAL',
      script,
      keys.length,
      ...keys,
      mode,
      rule.max,
      rule.windowMs,
      now,
      ...extra,
    ])) as [number, number, number]
    return {
      allowed: Number(reply[0]) === 1,
      remaining: Number(reply[1]),
      resetAt: Number(reply[2]),
    }
  }

  return {
    async get(key) {
      const value = await command(['GET', key])
      return value == null ? undefined : String(value)
    },
    async set(key, value, ttlMs) {
      await command(['SET', key, value, 'PX', Math.max(1, Math.round(ttlMs))])
    },
    consume: (key, rule, now) => run('consume', key, rule, now),
    peek: (key, rule, now) => run('peek', key, rule, now),
    async refund(key, rule, takenAt) {
      await run('refund', key, rule, takenAt)
    },
  }
}
