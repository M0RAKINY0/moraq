import { it } from 'vitest'

// Temporary diagnostic: lists the model ids this key can call.
it.skipIf(!process.env.GEMINI_API_KEY)('lists gemini models', async () => {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', {
    headers: { authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  console.log('GEMINI_MODELS', res.status, (body.data ?? []).map((m) => m.id).filter((id) => /flash|lite/.test(id)).join(' '))
})
