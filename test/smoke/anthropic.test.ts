import { describe, expect, it } from 'vitest'
import { createMoraq } from '../../src/index.js'

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('anthropic smoke', () => {
  const model = `anthropic/${process.env.MORAQ_SMOKE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5'}`
  // Built per test: vitest runs this describe body even when skipped, and a missing key throws.
  const client = () => createMoraq({ providers: { anthropic: {} } })
  const messages = [{ role: 'user' as const, content: 'Say hi in one word.' }]

  it('gets a reply', async () => {
    const res = await client().chat.completions.create({ model, messages, max_tokens: 5 })
    expect(res.choices[0]?.message.content).toBeTruthy()
    expect(res.moraq.provider).toBe('anthropic')
  })

  it('streams a reply', async () => {
    const stream = await client().chat.completions.create({
      model,
      messages,
      max_tokens: 5,
      stream: true,
    })
    let text = ''
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? ''
    expect(text).toBeTruthy()
  })
})
