import {
  type ChatCompletionMessageParam,
  createMoraq,
  type Moraq,
  MoraqProvidersFailedError,
  type MoraqStream,
} from '@moraq/core'

// Created on the first request, not at import: `next build` loads this file on machines without the
// API keys. After that it lives for the server process, so the cache and circuit breakers carry over.
let ai: Moraq | undefined
const moraq = (): Moraq =>
  (ai ??= createMoraq({
    // Both have free tiers. Keys come from GEMINI_API_KEY and GROQ_API_KEY in .env.local.
    providers: { gemini: {}, groq: {} },
    routes: {
      chat: [
        { provider: 'gemini', model: 'gemini-flash-lite-latest' },
        { provider: 'groq', model: 'openai/gpt-oss-20b' },
      ],
    },
    cache: { ttl: '1h' },
  }))

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as { messages: ChatCompletionMessageParam[] }

  let stream: MoraqStream
  try {
    // Resolves on the first chunk, so a provider that fails before sending text falls back to Groq.
    stream = await moraq().chat.completions.create({ model: 'route:chat', messages, stream: true })
  } catch (error) {
    if (error instanceof MoraqProvidersFailedError) {
      return Response.json({ error: 'Every AI provider failed' }, { status: 502 })
    }
    throw error
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta.content
          if (text) controller.enqueue(encoder.encode(text))
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    // The browser went away: stop the provider stream too.
    cancel() {
      stream.controller.abort()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-moraq-provider': stream.moraq.provider,
      'x-moraq-cached': String(stream.moraq.cached),
    },
  })
}
