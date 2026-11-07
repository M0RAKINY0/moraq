import { MoraqConfigError, MoraqProviderError } from './errors.js'
import { parseModel } from './model.js'
import { createAnthropicAdapter } from './providers/anthropic.js'
import { createOpenAIAdapter } from './providers/openai.js'
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
  type OpenAICompatibleProvider,
} from './providers/presets.js'
import type { ProviderAdapter } from './providers/types.js'
import { parseSSE } from './sse.js'
import { MoraqStream } from './stream.js'
import type {
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  MoraqChatCompletion,
} from './types.js'

export interface ProviderConfig {
  apiKey?: string
  baseURL?: string
}

export interface AnthropicProviderConfig extends ProviderConfig {
  /** Used when a request has no `max_tokens`, since Anthropic requires one. Defaults to 4096. */
  defaultMaxTokens?: number
}

/** Any server that speaks the OpenAI Chat Completions API. */
export interface CompatibleProviderConfig {
  baseURL: string
  apiKey?: string
  /** Set to false if the server rejects `stream_options`. Defaults to true. */
  streamUsage?: boolean
}

export type ProvidersConfig = { [P in OpenAICompatibleProvider]?: ProviderConfig } & {
  anthropic?: AnthropicProviderConfig
  /** Your own OpenAI-compatible servers, called as `<name>/<model>`. */
  compatible?: Record<string, CompatibleProviderConfig>
}

export interface MoraqConfig {
  providers: ProvidersConfig
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
      /** Resolves once the provider accepts the request, so HTTP errors throw here, not mid-loop. */
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

export function createMoraq(config: MoraqConfig): Moraq {
  const fetchFn = config.fetch ?? globalThis.fetch
  const adapters = new Map<string, ProviderAdapter>()

  const { anthropic, compatible = {}, ...presets } = config.providers
  for (const [id, preset] of Object.entries(OPENAI_COMPATIBLE_PRESETS) as Array<
    [OpenAICompatibleProvider, OpenAICompatiblePreset]
  >) {
    const provider = presets[id]
    if (!provider) continue
    const apiKey = preset.envVar ? requireKey(id, provider, preset.envVar) : provider.apiKey
    adapters.set(
      id,
      createOpenAIAdapter({
        id,
        baseURL: provider.baseURL ?? preset.baseURL,
        ...(apiKey !== undefined && { apiKey }),
        ...(preset.streamUsage !== undefined && { streamUsage: preset.streamUsage }),
      }),
    )
  }
  for (const [id, provider] of Object.entries(compatible)) {
    if (adapters.has(id) || id === 'anthropic') {
      throw new MoraqConfigError(`providers.compatible.${id} clashes with a built-in provider`)
    }
    adapters.set(id, createOpenAIAdapter({ id, ...provider }))
  }
  if (anthropic) {
    adapters.set(
      'anthropic',
      createAnthropicAdapter({
        apiKey: requireKey('anthropic', anthropic, 'ANTHROPIC_API_KEY'),
        ...(anthropic.baseURL !== undefined && { baseURL: anthropic.baseURL }),
        ...(anthropic.defaultMaxTokens !== undefined && {
          defaultMaxTokens: anthropic.defaultMaxTokens,
        }),
      }),
    )
  }

  // Every call goes through here so later milestones can add limits, routing and caching.
  async function execute(
    params: ChatCompletionCreateParams,
    options: RequestOptions,
  ): Promise<MoraqChatCompletion | MoraqStream> {
    const target = parseModel(params.model)
    const adapter = adapters.get(target.provider)
    if (!adapter) {
      throw new MoraqConfigError(`Provider '${target.provider}' is not configured`)
    }

    // Streams get their own controller so `stream.controller.abort()` works without a user signal.
    const controller = params.stream ? new AbortController() : undefined
    const signals = [options.signal, controller?.signal].filter((s) => s !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    const providerParams = { ...params, model: target.model }
    const { url, init } = adapter.buildRequest(providerParams)
    let response: Response
    try {
      response = await fetchFn(url, { ...init, ...(signal !== undefined && { signal }) })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new MoraqProviderError(`Request to ${adapter.id} failed`, {
        kind: 'network',
        provider: adapter.id,
        cause: error,
      })
    }

    if (response.ok && controller) {
      if (!response.body) {
        throw new MoraqProviderError(`${adapter.id} returned an empty stream`, {
          kind: 'network',
          provider: adapter.id,
        })
      }
      const info = { provider: adapter.id, cached: false, attempts: 1 }
      const chunks = adapter.parseStream(parseSSE(response.body), providerParams)
      return new MoraqStream(chunks, info, controller)
    }

    const body = await readBody(response)
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      throw new MoraqProviderError(`${adapter.id} returned HTTP ${response.status}`, {
        kind: adapter.classifyError(response.status, body, response.headers),
        provider: adapter.id,
        status: response.status,
        body,
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      })
    }

    const completion = adapter.parseResponse(body, providerParams)
    return { ...completion, moraq: { provider: adapter.id, cached: false, attempts: 1 } }
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

function requireKey(provider: string, config: ProviderConfig, envVar: string): string {
  const apiKey = config.apiKey ?? process.env[envVar]
  if (!apiKey) {
    throw new MoraqConfigError(
      `Provider ${provider} has no API key. Pass providers.${provider}.apiKey or set ${envVar}`,
    )
  }
  return apiKey
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
