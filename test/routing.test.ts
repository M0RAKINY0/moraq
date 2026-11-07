import { expect, it } from 'vitest'
import {
  type ChatCompletionChunk,
  createMoraq,
  type MoraqConfig,
  MoraqProviderError,
  MoraqProvidersFailedError,
} from '../src/index.js'
import { type FakeResponse, fakeFetch } from './helpers/fake-fetch.js'

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
}
const anthropicMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: 'Hi from Claude' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 3 },
}
const messages = [{ role: 'user' as const, content: 'Hi' }]
const overloaded: FakeResponse = { status: 503, body: { error: { message: 'busy' } } }

function setup(responses: FakeResponse[], extra: Partial<MoraqConfig> = {}) {
  const fetch = fakeFetch(...responses)
  const ai = createMoraq({
    providers: { openai: { apiKey: 'sk' }, anthropic: { apiKey: 'sk-ant' } },
    routes: {
      chat: [
        { provider: 'openai', model: 'gpt-4o-mini', retries: 1 },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
    },
    retry: { baseDelayMs: 1 },
    fetch,
    ...extra,
  })
  return { ai, fetch }
}

it('retries a failing target, then falls back to the next one in the route', async () => {
  const { ai, fetch } = setup([overloaded, overloaded, { body: anthropicMessage }])

  const res = await ai.chat.completions.create({ model: 'route:chat', messages })

  expect(fetch.calls.map((c) => c.url)).toEqual([
    'https://api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
  ])
  expect(res.choices[0]?.message.content).toBe('Hi from Claude')
  expect(res.moraq).toEqual({ provider: 'anthropic', cached: false, attempts: 3 })
})

it('throws a 401 right away and reports every attempt when all targets fail', async () => {
  const auth = setup([{ status: 401, body: { error: { message: 'bad key' } } }])
  const authError = await auth.ai.chat.completions
    .create({ model: 'route:chat', messages })
    .catch((e: unknown) => e)
  expect(authError).toBeInstanceOf(MoraqProviderError)
  expect(authError).toMatchObject({ kind: 'auth' })
  expect(auth.fetch.calls).toHaveLength(1)

  // A retired model (404) skips to the next target without retrying.
  const notFound = { status: 404, body: { error: { message: 'no such model' } } }
  const all = setup([notFound, overloaded, overloaded, overloaded])
  const error = await all.ai.chat.completions
    .create({ model: 'route:chat', messages })
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(MoraqProvidersFailedError)
  expect(
    (error as MoraqProvidersFailedError).attempts.map((a) => `${a.provider}:${a.kind}`),
  ).toEqual([
    'openai:not_found',
    'anthropic:overloaded',
    'anthropic:overloaded',
    'anthropic:overloaded',
  ])
})

it('falls back when a stream fails before its first chunk', async () => {
  const errorFirst = { sse: [JSON.stringify({ error: { message: 'stream broke' } })] }
  const ok = {
    sse: [
      JSON.stringify({
        ...completion,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }],
      }),
      '[DONE]',
    ],
  }
  const { ai } = setup([errorFirst, errorFirst, ok], {
    routes: {
      chat: [
        { provider: 'openai', model: 'a', retries: 0 },
        { provider: 'openai', model: 'b' },
      ],
    },
  })

  const stream = await ai.chat.completions.create({ model: 'route:chat', messages, stream: true })
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)

  expect(chunks.map((c) => c.choices[0]?.delta.content).join('')).toBe('Hi')
  expect(stream.moraq.attempts).toBe(3)
})

it('skips a target whose circuit breaker has tripped', async () => {
  const { ai, fetch } = setup(
    [overloaded, { body: anthropicMessage }, { body: anthropicMessage }],
    { circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } },
  )

  await ai.chat.completions.create({ model: 'route:chat', messages })
  const second = await ai.chat.completions.create({ model: 'route:chat', messages })

  // The first call trips openai after one failure. The second goes straight to anthropic.
  expect(fetch.calls.map((c) => new URL(c.url).hostname)).toEqual([
    'api.openai.com',
    'api.anthropic.com',
    'api.anthropic.com',
  ])
  expect(second.moraq.attempts).toBe(1)
})
