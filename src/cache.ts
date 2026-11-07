import type { Duration } from './limits.js'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  CompletionUsage,
} from './types.js'

export interface CacheConfig {
  /** How long an answer stays cached, e.g. `'1h'`. */
  ttl: Duration
  /**
   * `'global'` (default) shares answers between all users. `'user'` keeps them per `user.id`, and
   * calls without a user skip the cache.
   */
  scope?: 'global' | 'user'
}

/** What the store holds for one cached answer. */
export interface CacheEntry {
  provider: string
  completion: ChatCompletion
}

/**
 * SHA-256 of the request with sorted keys. Leaves out what doesn't change the answer: `stream`
 * and `stream_options`, so streamed and plain calls share entries.
 */
export async function cacheKey(
  request: ChatCompletionCreateParams,
  userId: string | undefined,
): Promise<string> {
  const { stream: _stream, ...rest } = request
  const { stream_options: _options, ...answerShaping } = rest as typeof rest & {
    stream_options?: unknown
  }
  // Web Crypto rather than node:crypto, so this runs on Bun, Deno and edge runtimes too.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableJson(answerShaping)),
  )
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return userId === undefined ? `moraq:cache:${hash}` : `moraq:cache:${userId}:${hash}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Only finished text answers get cached. Tool-call turns depend on what the tools return next. */
export function isCacheable(completion: ChatCompletion): boolean {
  const choice = completion.choices[0]
  if (!choice || completion.choices.length !== 1) return false
  if (choice.message.tool_calls?.length) return false
  return choice.finish_reason === 'stop' || choice.finish_reason === 'length'
}

/** Rebuilds a full completion from a finished stream, so streams can fill the cache too. */
export function assembleCompletion(chunks: ChatCompletionChunk[]): ChatCompletion | undefined {
  const first = chunks[0]
  if (!first) return undefined
  let content = ''
  let finish: ChatCompletion['choices'][number]['finish_reason'] = null
  let usage: CompletionUsage | undefined
  let toolCalls = false
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices) {
      if (choice.index !== 0) return undefined
      content += choice.delta.content ?? ''
      if (choice.delta.tool_calls?.length) toolCalls = true
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }
  if (toolCalls) return undefined
  return {
    id: first.id,
    object: 'chat.completion',
    created: first.created,
    model: first.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    ...(usage && { usage }),
  }
}

/** Plays a cached completion back as stream chunks, shaped like a live OpenAI stream. */
export async function* replayChunks(
  completion: ChatCompletion,
): AsyncGenerator<ChatCompletionChunk> {
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk' as const,
    created: completion.created,
    model: completion.model,
  }
  const choice = completion.choices[0]
  yield {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  }
  if (choice?.message.content) {
    yield {
      ...base,
      choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
    }
  }
  yield {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }],
  }
  if (completion.usage) yield { ...base, choices: [], usage: completion.usage }
}
