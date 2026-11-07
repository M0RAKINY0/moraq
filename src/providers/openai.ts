import { MoraqProviderError, type ProviderErrorKind } from '../errors.js'
import type { SSEEvent } from '../sse.js'
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParams } from '../types.js'
import type { ProviderAdapter, ProviderRequest } from './types.js'

export interface OpenAIAdapterOptions {
  /** Shows up in errors and `res.moraq.provider`. Defaults to 'openai'. */
  id?: string
  /** Optional for servers without auth, like a local Ollama. */
  apiKey?: string
  baseURL?: string
  /** Sends `stream_options.include_usage`. Turn off for servers that reject the field. */
  streamUsage?: boolean
}

/** Works with OpenAI and with any server that speaks the OpenAI Chat Completions API. */
export function createOpenAIAdapter({
  id = 'openai',
  apiKey,
  baseURL = 'https://api.openai.com/v1',
  streamUsage = true,
}: OpenAIAdapterOptions = {}): ProviderAdapter {
  return {
    id,
    buildRequest(params: ChatCompletionCreateParams): ProviderRequest {
      // Without include_usage, OpenAI streams carry no token counts.
      const body =
        params.stream && streamUsage
          ? { ...params, stream_options: { ...params.stream_options, include_usage: true } }
          : params
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      return {
        url: `${baseURL}/chat/completions`,
        init: { method: 'POST', headers, body: JSON.stringify(body) },
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
          throw new MoraqProviderError(`${id} sent a stream event that is not JSON`, {
            kind: 'unknown',
            provider: id,
            body: event.data,
            cause: error,
          })
        }
        if (typeof json === 'object' && json !== null && 'error' in json) {
          throw new MoraqProviderError(`${id} sent an error in the stream`, {
            kind: 'server',
            provider: id,
            body: json,
          })
        }
        yield json as ChatCompletionChunk
      }
      throw new MoraqProviderError(`${id} stream ended before [DONE]`, {
        kind: 'network',
        provider: id,
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
  // Some OpenAI-compatible servers (Gemini's among them) wrap the error object in an array.
  const root = Array.isArray(body) ? body[0] : body
  if (typeof root !== 'object' || root === null) return undefined
  const error = (root as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { code?: unknown }).code
}
