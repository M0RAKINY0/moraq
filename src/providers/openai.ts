import type { ProviderErrorKind } from '../errors.js'
import type { ChatCompletion, ChatCompletionCreateParams } from '../types.js'
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
      return {
        url: `${baseURL}/chat/completions`,
        init: {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(params),
        },
      }
    },
    parseResponse(json: unknown): ChatCompletion {
      return json as ChatCompletion
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
