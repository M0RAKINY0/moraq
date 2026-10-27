import { describe, expect, it } from 'vitest'
import { createMoraq } from '../../src/index.js'

describe.skipIf(!process.env.OPENAI_API_KEY)('openai smoke', () => {
  it('gets a reply from a real model', async () => {
    const model = process.env.MORAQ_SMOKE_OPENAI_MODEL ?? 'gpt-4.1-nano'
    const ai = createMoraq({ providers: { openai: {} } })
    const res = await ai.chat.completions.create({
      model: `openai/${model}`,
      messages: [{ role: 'user', content: 'Say hi in one word.' }],
      max_tokens: 5,
    })
    expect(res.choices[0]?.message.content).toBeTruthy()
    expect(res.moraq.provider).toBe('openai')
  })
})
