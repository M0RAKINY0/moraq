import { MoraqError, MoraqProviderError } from './errors.js'
import type { ChatCompletionChunk, MoraqResponseInfo } from './types.js'

/**
 * A streamed chat completion. Iterate it with `for await` to get `ChatCompletionChunk`s, the same
 * way as the OpenAI SDK. It can be iterated once. Breaking out of the loop or calling
 * `controller.abort()` closes the connection to the provider.
 */
export class MoraqStream implements AsyncIterable<ChatCompletionChunk> {
  readonly moraq: MoraqResponseInfo
  readonly controller: AbortController
  readonly #chunks: AsyncIterable<ChatCompletionChunk>
  #iterated = false

  constructor(
    chunks: AsyncIterable<ChatCompletionChunk>,
    moraq: MoraqResponseInfo,
    controller: AbortController,
  ) {
    this.#chunks = chunks
    this.moraq = moraq
    this.controller = controller
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.#iterated) throw new MoraqError('A stream can only be iterated once')
    this.#iterated = true
    try {
      yield* this.#chunks
    } catch (error) {
      if (this.controller.signal.aborted || error instanceof MoraqError) throw error
      throw new MoraqProviderError(`Stream from ${this.moraq.provider} failed`, {
        kind: 'network',
        provider: this.moraq.provider,
        cause: error,
      })
    }
  }
}
