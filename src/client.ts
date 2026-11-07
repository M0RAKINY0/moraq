import { MoraqConfigError, MoraqError, MoraqProviderError } from './errors.js'
import { parseModel } from './model.js'
import { createAdapters, type ProvidersConfig } from './providers/registry.js'
import type { ProviderAdapter } from './providers/types.js'
import {
  type CircuitBreakerConfig,
  createRouter,
  type RetryConfig,
  type RouteTarget,
} from './router.js'
import { parseSSE } from './sse.js'
import { MoraqStream } from './stream.js'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  MoraqChatCompletion,
} from './types.js'

export type {
  AnthropicProviderConfig,
  CompatibleProviderConfig,
  ProviderConfig,
  ProvidersConfig,
} from './providers/registry.js'

export interface MoraqConfig {
  providers: ProvidersConfig
  /** Named fallback chains, called as `model: 'route:<name>'`. */
  routes?: Record<string, RouteTarget[]>
  retry?: RetryConfig
  /** Skips a target that keeps failing. `false` turns it off. */
  circuitBreaker?: CircuitBreakerConfig | false
  /**
   * How long one attempt may wait for the provider to respond, or for a stream's first chunk.
   * Defaults to 60000.
   */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface RequestOptions {
  signal?: AbortSignal
}

export interface Moraq {
  chat: {
    completions: {
      create(
        params: ChatCompletionCreateParamsNonStreaming,
        options?: RequestOptions,
      ): Promise<MoraqChatCompletion>
      /**
       * Resolves once the first chunk arrives. Until then a failing provider can fall back to the
       * next target in the route. After it, the stream stays on that provider.
       */
      create(
        params: ChatCompletionCreateParamsStreaming,
        options?: RequestOptions,
      ): Promise<MoraqStream>
      create(
        params: ChatCompletionCreateParams,
        options?: RequestOptions,
      ): Promise<MoraqChatCompletion | MoraqStream>
    }
  }
}

type AttemptResult =
  | { type: 'completion'; provider: string; completion: ChatCompletion }
  | { type: 'stream'; provider: string; chunks: AsyncIterable<ChatCompletionChunk> }

export function createMoraq(config: MoraqConfig): Moraq {
  const fetchFn = config.fetch ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? 60_000
  const adapters = createAdapters(config.providers)
  const routes = config.routes ?? {}
  const router = createRouter({
    ...(config.retry !== undefined && { retry: config.retry }),
    ...(config.circuitBreaker !== undefined && { circuitBreaker: config.circuitBreaker }),
  })

  for (const [name, targets] of Object.entries(routes)) {
    if (targets.length === 0) throw new MoraqConfigError(`Route '${name}' has no targets`)
    for (const target of targets) {
      if (!adapters.has(target.provider)) {
        throw new MoraqConfigError(
          `Route '${name}' uses provider '${target.provider}', which is not configured`,
        )
      }
    }
  }

  function targetsFor(model: string): RouteTarget[] {
    const parsed = parseModel(model)
    if ('route' in parsed) {
      const targets = routes[parsed.route]
      if (!targets) throw new MoraqConfigError(`Route '${parsed.route}' is not defined`)
      return targets
    }
    if (!adapters.has(parsed.provider)) {
      throw new MoraqConfigError(`Provider '${parsed.provider}' is not configured`)
    }
    return [parsed]
  }

  /** One HTTP call to one target. Throws `MoraqProviderError` for anything the router can act on. */
  async function attempt(
    target: RouteTarget,
    params: ChatCompletionCreateParams,
    signal: AbortSignal | undefined,
  ): Promise<AttemptResult> {
    const adapter = adapters.get(target.provider) as ProviderAdapter
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const attemptSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    const providerParams = { ...params, model: target.model }

    try {
      const { url, init } = adapter.buildRequest(providerParams)
      const response = await fetchFn(url, { ...init, signal: attemptSignal })

      if (!response.ok) {
        const body = await readBody(response)
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        throw new MoraqProviderError(`${adapter.id} returned HTTP ${response.status}`, {
          kind: adapter.classifyError(response.status, body, response.headers),
          provider: adapter.id,
          status: response.status,
          body,
          ...(retryAfterMs !== undefined && { retryAfterMs }),
        })
      }

      if (!params.stream) {
        const completion = adapter.parseResponse(await readBody(response), providerParams)
        return { type: 'completion', provider: adapter.id, completion }
      }
      if (!response.body) {
        throw new MoraqProviderError(`${adapter.id} returned an empty stream`, {
          kind: 'network',
          provider: adapter.id,
        })
      }
      // Wait for the first chunk, so an error before any text reaches the user can still fall back.
      const iterator = adapter
        .parseStream(parseSSE(response.body), providerParams)
        [Symbol.asyncIterator]()
      const first = await iterator.next()
      return { type: 'stream', provider: adapter.id, chunks: prepend(first, iterator) }
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.signal.aborted) {
        throw new MoraqProviderError(`${adapter.id} did not respond within ${timeoutMs} ms`, {
          kind: 'timeout',
          provider: adapter.id,
          cause: error,
        })
      }
      if (error instanceof MoraqError) throw error
      throw new MoraqProviderError(`Request to ${adapter.id} failed`, {
        kind: 'network',
        provider: adapter.id,
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // Every call goes through here. Rate limits and caching wrap this in later milestones.
  async function execute(
    params: ChatCompletionCreateParams,
    options: RequestOptions,
  ): Promise<MoraqChatCompletion | MoraqStream> {
    const targets = targetsFor(params.model)
    // Streams get their own controller so `stream.controller.abort()` works without a user signal.
    const controller = params.stream ? new AbortController() : undefined
    const signals = [options.signal, controller?.signal].filter((s) => s !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    const { result, attempts } = await router.run(
      targets,
      (target) => attempt(target, params, signal),
      signal,
    )
    const info = { provider: result.provider, cached: false, attempts }
    if (result.type === 'stream') {
      return new MoraqStream(result.chunks, info, controller as AbortController)
    }
    return { ...result.completion, moraq: info }
  }

  return {
    chat: {
      completions: {
        create: ((params: ChatCompletionCreateParams, options: RequestOptions = {}) =>
          execute(params, options)) as Moraq['chat']['completions']['create'],
      },
    },
  }
}

/** Puts an already-read first result back in front of the rest of the iterator. */
async function* prepend<T>(first: IteratorResult<T>, rest: AsyncIterator<T>): AsyncGenerator<T> {
  try {
    if (first.done) return
    yield first.value
    while (true) {
      const next = await rest.next()
      if (next.done) return
      yield next.value
    }
  } finally {
    // Closes the connection when the caller stops early.
    await rest.return?.()
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}
