import { describe, expect, it } from 'vitest'
import { createMoraq } from '../../src/index.js'

// Groq speaks the OpenAI format and has a free tier, so it runs the OpenAI adapter against a real
// server at no cost.
describe.skipIf(!process.env.GROQ_API_KEY)('groq smoke (OpenAI adapter)', () => {
  const model = `openai/${process.env.MORAQ_SMOKE_GROQ_MODEL ?? 'llama-3.1-8b-instant'}`
  // Built per test: vitest runs this describe body even when skipped, and a missing key throws.
  const client = () =>
    createMoraq({
      providers: {
        openai: {
          apiKey: process.env.GROQ_API_KEY ?? '',
          baseURL: 'https://api.groq.com/openai/v1',
        },
      },
    })
  const messages = [{ role: 'user' as const, content: 'Say hi in one word.' }]

  it('gets a reply', async () => {
    const res = await client().chat.completions.create({ model, messages, max_tokens: 5 })
    expect(res.choices[0]?.message.content).toBeTruthy()
    expect(res.usage?.total_tokens).toBeGreaterThan(0)
  })

  it('streams a reply with usage in the last chunk', async () => {
    const stream = await client().chat.completions.create({
      model,
      messages,
      max_tokens: 5,
      stream: true,
    })
    let text = ''
    let total = 0
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? ''
      total = chunk.usage?.total_tokens ?? total
    }
    expect(text).toBeTruthy()
    expect(total).toBeGreaterThan(0)
  })
})
