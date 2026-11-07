import { Redis } from 'ioredis'
import { afterAll, describe } from 'vitest'
import { redisStore } from '../../src/redis.js'
import { storeContract } from '../helpers/store-contract.js'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await redis.quit()
})

describe('redisStore (ioredis)', () => storeContract(() => redisStore(redis)))
