import { MoraqConfigError } from '../errors.js'
import { createAnthropicAdapter } from './anthropic.js'
import { createOpenAIAdapter } from './openai.js'
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
  type OpenAICompatibleProvider,
} from './presets.js'
import type { ProviderAdapter } from './types.js'

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

/** Builds one adapter per configured provider. Throws if a provider that needs a key has none. */
export function createAdapters(providers: ProvidersConfig): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>()
  const { anthropic, compatible = {}, ...presets } = providers

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
  return adapters
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
