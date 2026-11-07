import { describe, expect, it } from 'vitest'
import { createMoraq } from '../../src/index.js'

// Gemini 2.5 models think before answering, so they get room beyond the reply itself.
describe.skipIf(!process.env.GEMINI_API_KEY)('gemini smoke', () => {
  const model = `gemini/${process.env.MORAQ_SMOKE_GEMINI_MODEL ?? 'gemini-2.5-flash'}`
  // Built per test: vitest runs this describe body even when skipped, and a missing key throws.
  const client = () => createMoraq({ providers: { gemini: {} } })
  const messages = [{ role: 'user' as const, content: 'Say hi in one word.' }]

  it('gets a reply', async () => {
    const res = await client().chat.completions.create({ model, messages, max_tokens: 300 })
    expect(res.choices[0]?.message.content).toBeTruthy()
    expect(res.moraq.provider).toBe('gemini')
  })

  it('streams a reply with usage in the last chunk', async () => {
    const stream = await client().chat.completions.create({
      model,
      messages,
      max_tokens: 300,
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
