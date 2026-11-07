import { Redis } from 'ioredis'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe } from 'vitest'
import { redisStore } from '../../src/redis.js'
import { storeContract } from '../helpers/store-contract.js'

const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
const ioredis = new Redis(url)
const nodeRedis = createClient({ url })

beforeAll(async () => {
  await nodeRedis.connect()
})

afterAll(async () => {
  await ioredis.quit()
  await nodeRedis.quit()
})

describe('redisStore (ioredis)', () => storeContract(() => redisStore(ioredis)))
describe('redisStore (node-redis)', () => storeContract(() => redisStore(nodeRedis)))
