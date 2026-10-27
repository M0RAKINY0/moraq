import type { ProviderErrorKind } from '../errors.js'
import type { ChatCompletion, ChatCompletionCreateParams } from '../types.js'

export interface ProviderRequest {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/**
 * Translates between moraq's OpenAI-shaped format and one provider's HTTP API.
 * Adapters do no I/O. The client sends the request and turns failures into errors.
 */
export interface ProviderAdapter {
  id: string
  /** `params.model` arrives without the provider prefix. */
  buildRequest(params: ChatCompletionCreateParams): ProviderRequest
  parseResponse(json: unknown): ChatCompletion
  classifyError(status: number, body: unknown, headers: Headers): ProviderErrorKind
}
