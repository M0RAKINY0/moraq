import { expect, it } from 'vitest'
import {
  type ChatCompletionChunk,
  createMoraq,
  type MoraqConfig,
  type RequestEvent,
} from '../src/index.js'
import { type FakeResponse, fakeFetch, fixture } from './helpers/fake-fetch.js'

const answer = (content: string, finish = 'stop'): FakeResponse => ({
  body: {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
})
const messages = [{ role: 'user' as const, content: 'Hi' }]

function setup(responses: FakeResponse[], extra: Partial<MoraqConfig> = {}) {
  const fetch = fakeFetch(...responses)
  const events: RequestEvent[] = []
  const ai = createMoraq({
    providers: { openai: { apiKey: 'sk' } },
    routes: {
      chat: [{ provider: 'openai', model: 'gpt-4o-mini' }],
      live: { targets: [{ provider: 'openai', model: 'gpt-4o-mini' }], cache: false },
    },
    cache: { ttl: '1h' },
    plans: { free: { limits: [{ requests: 1, per: '1m' }] } },
    onRequest: (event) => {
      events.push(event)
    },
    fetch,
    ...extra,
  })
  return { ai, fetch, events }
}

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? ''
  return text
}

it('answers a repeated request from the cache, without a provider call or a rate limit', async () => {
  const { ai, fetch, events } = setup([answer('Hello')])
  const user = { id: 'u1', plan: 'free' }

  const first = await ai.chat.completions.create({ model: 'route:chat', messages, user })
  // The plan allows 1 request a minute, but a cache hit doesn't count.
  const second = await ai.chat.completions.create({ model: 'route:chat', messages, user })

  expect(fetch.calls).toHaveLength(1)
  expect(first.moraq).toEqual({ provider: 'openai', cached: false, attempts: 1 })
  expect(second.moraq).toEqual({ provider: 'openai', cached: true, attempts: 0 })
  expect(second.choices[0]?.message.content).toBe('Hello')
  expect(events.map((e) => e.cached)).toEqual([false, true])
  expect(events[0]).toMatchObject({ model: 'route:chat', provider: 'openai', user, stream: false })
})

it('fills the cache from a stream and replays it to streams and plain calls alike', async () => {
  const { ai, fetch } = setup([{ chunks: [fixture('openai/stream-basic.sse')] }])

  const live = await ai.chat.completions.create({ model: 'route:chat', messages, stream: true })
  expect(await collect(live)).toBe('Hello')

  const replay = await ai.chat.completions.create({ model: 'route:chat', messages, stream: true })
  expect(replay.moraq.cached).toBe(true)
  expect(await collect(replay)).toBe('Hello')

  const plain = await ai.chat.completions.create({ model: 'route:chat', messages })
  expect(plain.choices[0]?.message.content).toBe('Hello')
  expect(plain.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
  expect(fetch.calls).toHaveLength(1)
})

it('shares one provider call between identical requests in flight', async () => {
  const { ai, fetch } = setup([answer('Once')])
  const [a, b] = await Promise.all([
    ai.chat.completions.create({ model: 'route:chat', messages }),
    ai.chat.completions.create({ model: 'route:chat', messages }),
  ])
  expect(fetch.calls).toHaveLength(1)
  expect([a.moraq.cached, b.moraq.cached]).toEqual([false, true])
})

it('skips the cache for tool calls, abandoned streams, cache: false and uncached routes', async () => {
  const toolCall: FakeResponse = {
    body: {
      ...(answer('').body as object),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  }
  const stream: FakeResponse = { chunks: [fixture('openai/stream-basic.sse')] }
  const { ai, fetch } = setup([
    toolCall,
    toolCall,
    stream,
    answer('a'),
    answer('b'),
    answer('c'),
    answer('d'),
  ])
  const ask = (content: string, model = 'route:chat') => ({
    model,
    messages: [{ role: 'user' as const, content }],
  })

  await ai.chat.completions.create(ask('tool'))
  await ai.chat.completions.create(ask('tool'))

  const abandoned = await ai.chat.completions.create({ ...ask('stream'), stream: true })
  for await (const _ of abandoned) break
  await ai.chat.completions.create(ask('stream'))

  await ai.chat.completions.create(ask('opt-out'), { cache: false })
  await ai.chat.completions.create(ask('opt-out'), { cache: false })

  await ai.chat.completions.create(ask('live', 'route:live'))

  expect(fetch.calls).toHaveLength(7)
})
