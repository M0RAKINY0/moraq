import { expect, it } from 'vitest'
import { createMoraq } from '../src/index.js'
import { fakeFetch } from './helpers/fake-fetch.js'

it('sends an OpenAI request and adds moraq info to the response', async () => {
  const completion = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  const fetch = fakeFetch({ body: completion })
  const ai = createMoraq({ providers: { openai: { apiKey: 'sk-test' } }, fetch })

  const res = await ai.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
  })

  const call = fetch.calls[0]
  expect(call?.url).toBe('https://api.openai.com/v1/chat/completions')
  expect(call?.method).toBe('POST')
  expect(call?.headers.authorization).toBe('Bearer sk-test')
  expect(call?.body).toMatchObject({ model: 'gpt-4o-mini' })
  expect(res).toEqual({ ...completion, moraq: { provider: 'openai', cached: false, attempts: 1 } })
})
