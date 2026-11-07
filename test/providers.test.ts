import { expect, it } from 'vitest'
import { createMoraq, MoraqConfigError } from '../src/index.js'
import { fakeFetch } from './helpers/fake-fetch.js'

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
}
const messages = [{ role: 'user' as const, content: 'Hi' }]

it('routes presets and custom OpenAI-compatible servers to the right URL with the right key', async () => {
  const fetch = fakeFetch({ body: completion }, { body: completion }, { body: completion })
  const ai = createMoraq({
    providers: {
      gemini: { apiKey: 'gemini-key' },
      ollama: {},
      compatible: { lab: { baseURL: 'https://llm.example.test/v1', apiKey: 'lab-key' } },
    },
    fetch,
  })

  const gemini = await ai.chat.completions.create({ model: 'gemini/gemini-2.5-flash', messages })
  await ai.chat.completions.create({ model: 'ollama/llama3.2', messages })
  await ai.chat.completions.create({ model: 'lab/my-model', messages })

  const [g, o, l] = fetch.calls
  expect(g?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  expect(g?.headers.authorization).toBe('Bearer gemini-key')
  expect(g?.body).toMatchObject({ model: 'gemini-2.5-flash' })
  expect(gemini.moraq.provider).toBe('gemini')
  expect(o?.url).toBe('http://localhost:11434/v1/chat/completions')
  expect(o?.headers.authorization).toBeUndefined()
  expect(l?.url).toBe('https://llm.example.test/v1/chat/completions')
  expect(l?.headers.authorization).toBe('Bearer lab-key')
})

it('reads preset keys from the environment and throws when one is missing', () => {
  const saved = process.env.MISTRAL_API_KEY
  delete process.env.MISTRAL_API_KEY
  try {
    expect(() => createMoraq({ providers: { mistral: {} } })).toThrow(MoraqConfigError)
    expect(() => createMoraq({ providers: { mistral: {} } })).toThrow(/MISTRAL_API_KEY/)
    expect(() =>
      createMoraq({
        providers: {
          compatible: { openai: { baseURL: 'https://x.test' } },
          openai: { apiKey: 'k' },
        },
      }),
    ).toThrow(/clashes/)
  } finally {
    if (saved !== undefined) process.env.MISTRAL_API_KEY = saved
  }
})
