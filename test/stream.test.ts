import { expect, it } from 'vitest'
import { type ChatCompletionChunk, createMoraq, MoraqProviderError } from '../src/index.js'
import { fakeFetch, fixture } from './helpers/fake-fetch.js'

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Splits a string into pieces of `size` characters, so events and `\r\n` break across chunks. */
function split(text: string, size: number): string[] {
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size))
  return pieces
}

it('streams OpenAI chunks, asks for usage and parses events split across network chunks', async () => {
  const body = fixture('openai/stream-basic.sse').replaceAll('\n', '\r\n')
  const fetch = fakeFetch({ chunks: split(body, 7) })
  const ai = createMoraq({ providers: { openai: { apiKey: 'sk-test' } }, fetch })

  const stream = await ai.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  })
  const chunks = await collect(stream)

  expect(fetch.calls[0]?.body).toMatchObject({
    model: 'gpt-4o-mini',
    stream: true,
    stream_options: { include_usage: true },
  })
  expect(stream.moraq).toEqual({ provider: 'openai', cached: false, attempts: 1 })
  expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello')
  expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
})

it('throws a network error when the stream ends before [DONE]', async () => {
  const truncated = fixture('openai/stream-basic.sse').replace('data: [DONE]\n\n', '')
  const fetch = fakeFetch({ chunks: [truncated] })
  const ai = createMoraq({ providers: { openai: { apiKey: 'sk-test' } }, fetch })

  const stream = await ai.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  })

  const error = await collect(stream).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(MoraqProviderError)
  expect(error).toMatchObject({ kind: 'network', provider: 'openai' })
})
