import { describe, expect, it } from 'vitest'
import { fakeFetch } from './fake-fetch.js'

describe('fakeFetch', () => {
  it('returns queued responses in order and records each request', async () => {
    const fetch = fakeFetch(
      { status: 429, headers: { 'retry-after': '2' } },
      { sse: ['{"a":1}', '[DONE]'] },
    )

    const first = await fetch('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'm' }),
    })
    expect(first.status).toBe(429)
    expect(first.headers.get('retry-after')).toBe('2')

    const second = await fetch('https://api.example.com/v1/chat')
    expect(await second.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')

    expect(fetch.calls[0]).toEqual({
      url: 'https://api.example.com/v1/chat',
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: { model: 'm' },
    })
    await expect(fetch('https://api.example.com')).rejects.toThrow('no response queued for call #3')
  })
})
