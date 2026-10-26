import { Redis } from 'ioredis'
import { afterAll, expect, it } from 'vitest'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await redis.quit()
})

it('reaches the test Redis', async () => {
  expect(await redis.ping()).toBe('PONG')
})
