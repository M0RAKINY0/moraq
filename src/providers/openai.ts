import { MoraqProviderError, type ProviderErrorKind } from '../errors.js'
import type { SSEEvent } from '../sse.js'
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParams } from '../types.js'
import type { ProviderAdapter, ProviderRequest } from './types.js'

export interface OpenAIAdapterOptions {
  apiKey: string
  baseURL?: string
}

export function createOpenAIAdapter({
  apiKey,
  baseURL = 'https://api.openai.com/v1',
}: OpenAIAdapterOptions): ProviderAdapter {
  return {
    id: 'openai',
    buildRequest(params: ChatCompletionCreateParams): ProviderRequest {
      // Without include_usage, OpenAI streams carry no token counts.
      const body = params.stream
        ? { ...params, stream_options: { ...params.stream_options, include_usage: true } }
        : params
      return {
        url: `${baseURL}/chat/completions`,
        init: {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      }
    },
    parseResponse(json: unknown): ChatCompletion {
      return json as ChatCompletion
    },
    async *parseStream(events: AsyncIterable<SSEEvent>): AsyncIterable<ChatCompletionChunk> {
      for await (const event of events) {
        if (event.data === '[DONE]') return
        let json: unknown
        try {
          json = JSON.parse(event.data)
        } catch (error) {
          throw new MoraqProviderError('openai sent a stream event that is not JSON', {
            kind: 'unknown',
            provider: 'openai',
            body: event.data,
            cause: error,
          })
        }
        if (typeof json === 'object' && json !== null && 'error' in json) {
          throw new MoraqProviderError('openai sent an error in the stream', {
            kind: 'server',
            provider: 'openai',
            body: json,
          })
        }
        yield json as ChatCompletionChunk
      }
      throw new MoraqProviderError('openai stream ended before [DONE]', {
        kind: 'network',
        provider: 'openai',
      })
    },
    classifyError(status: number, body: unknown): ProviderErrorKind {
      const code = errorCode(body)
      if (status === 401 || status === 403) return 'auth'
      if (status === 429) return code === 'insufficient_quota' ? 'quota_exhausted' : 'rate_limit'
      if (status === 400 && code === 'context_length_exceeded') return 'context_length'
      if (status === 400 && (code === 'content_filter' || code === 'content_policy_violation')) {
        return 'content_filter'
      }
      if (status >= 400 && status < 500) return 'bad_request'
      if (status === 503) return 'overloaded'
      if (status >= 500 && status < 600) return 'server'
      return 'unknown'
    },
  }
}

function errorCode(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { code?: unknown }).code
}
