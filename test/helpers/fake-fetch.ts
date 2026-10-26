import { readFileSync } from 'node:fs'

export interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  /** JSON body. Ignored when `sse` is set. */
  body?: unknown
  /** Server-sent event payloads, sent one per chunk as `data: <payload>\n\n`. */
  sse?: string[]
}

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export type FakeFetch = typeof fetch & { calls: RecordedCall[] }

/**
 * A `fetch` replacement that returns the given responses in order, one per call,
 * and records every request it receives. Throws if called more times than it has responses.
 */
export function fakeFetch(...responses: FakeResponse[]): FakeFetch {
  const queue = [...responses]
  const calls: RecordedCall[] = []

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    })

    const next = queue.shift()
    if (!next) throw new Error(`fakeFetch: no response queued for call #${calls.length}`)

    const status = next.status ?? 200
    if (next.sse) {
      return new Response(sseStream(next.sse), {
        status,
        headers: { 'content-type': 'text/event-stream', ...next.headers },
      })
    }
    return Response.json(next.body ?? null, {
      status,
      ...(next.headers && { headers: next.headers }),
    })
  }

  return Object.assign(fn, { calls }) as FakeFetch
}

/** Reads a recorded provider response from `test/fixtures/`. */
export function fixture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`))
      controller.close()
    },
  })
}
