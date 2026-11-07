import { expect, it } from 'vitest'
import {
  createMoraq,
  MoraqConfigError,
  MoraqPlanError,
  MoraqProviderError,
  MoraqRateLimitError,
} from '../src/index.js'
import { type FakeResponse, fakeFetch } from './helpers/fake-fetch.js'

const ok: FakeResponse = {
  body: {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  },
}
const messages = [{ role: 'user' as const, content: 'Hi' }]
const free = { id: 'u1', plan: 'free' }

function setup(...responses: FakeResponse[]) {
  const fetch = fakeFetch(...responses)
  const ai = createMoraq({
    providers: { openai: { apiKey: 'sk' } },
    routes: { cheap: [{ provider: 'openai', model: 'gpt-4o-mini' }] },
    plans: {
      free: { limits: [{ requests: 2, per: '1m', strategy: 'fixed' }], routes: ['cheap'] },
    },
    fetch,
  })
  return { ai, fetch }
}

it('lets a user make `requests` calls, then throws without calling the provider', async () => {
  const { ai, fetch } = setup(ok, ok, ok)
  const call = () => ai.chat.completions.create({ model: 'route:cheap', messages, user: free })

  await call()
  await call()
  const error = await call().catch((e: unknown) => e)

  expect(error).toBeInstanceOf(MoraqRateLimitError)
  expect(error).toMatchObject({ limit: { requests: 2, per: '1m' }, remaining: 0 })
  expect((error as MoraqRateLimitError).retryAfterMs).toBeGreaterThan(0)
  expect(fetch.calls).toHaveLength(2)
  // `user` never reaches the provider.
  expect(fetch.calls[0]?.body).not.toHaveProperty('user')

  const [status] = await ai.limits.check(free)
  expect(status?.remaining).toBe(0)
  // Calls without a user (admin scripts, cron jobs) aren't limited.
  await ai.chat.completions.create({ model: 'route:cheap', messages })
})

it('gives the request back when the call fails', async () => {
  const { ai } = setup({ status: 401, body: { error: { message: 'bad key' } } }, ok, ok)
  const call = () => ai.chat.completions.create({ model: 'route:cheap', messages, user: free })

  await expect(call()).rejects.toBeInstanceOf(MoraqProviderError)
  await call()
  await call()
  expect((await ai.limits.check(free))[0]?.remaining).toBe(0)
})

it("throws when a plan calls a route it doesn't allow, or names an unknown plan or route", async () => {
  const { ai } = setup(ok)
  await expect(
    ai.chat.completions.create({ model: 'openai/gpt-4o', messages, user: free }),
  ).rejects.toBeInstanceOf(MoraqPlanError)
  await expect(
    ai.chat.completions.create({
      model: 'route:cheap',
      messages,
      user: { id: 'u2', plan: 'gold' },
    }),
  ).rejects.toBeInstanceOf(MoraqConfigError)
  expect(() =>
    createMoraq({
      providers: { openai: { apiKey: 'sk' } },
      plans: { free: { routes: ['missing'] } },
    }),
  ).toThrow(/not defined/)
})
