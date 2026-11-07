import {
  assembleCompletion,
  type CacheConfig,
  type CacheEntry,
  cacheKey,
  isCacheable,
  replayChunks,
} from './cache.js'
import { MoraqConfigError, MoraqError, MoraqProviderError } from './errors.js'
import { createLimiter, type LimitStatus, type PlanConfig, parseDuration } from './limits.js'
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
import { memoryStore, type Store } from './store.js'
import { MoraqStream } from './stream.js'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  CompletionUsage,
  MoraqChatCompletion,
  MoraqUser,
} from './types.js'

export type {
  AnthropicProviderConfig,
  CompatibleProviderConfig,
  ProviderConfig,
  ProvidersConfig,
} from './providers/registry.js'

/** A route with its own settings. A plain array of targets is the short form. */
export interface RouteConfig {
  targets: RouteTarget[]
  /** Overrides the global `cache` for this route. `false` turns it off here. */
  cache?: CacheConfig | false
}

/** Passed to `onRequest` once per `create()` call, when it finishes. */
export interface RequestEvent {
  /** What the caller asked for: `route:<name>` or `<provider>/<model>`. */
  model: string
  user?: MoraqUser
  stream: boolean
  /** The provider that answered. Missing when every target failed. */
  provider?: string
  cached: boolean
  attempts?: number
  usage?: CompletionUsage
  /** For streams, measured until the stream ends. */
  durationMs: number
  /** Set when the call failed, or when a stream broke midway. */
  error?: unknown
}

export interface MoraqConfig {
  providers: ProvidersConfig
  /** Named fallback chains, called as `model: 'route:<name>'`. */
  routes?: Record<string, RouteTarget[] | RouteConfig>
  /** Caches answers for every route and direct call. Off by default. */
  cache?: CacheConfig | false
  /**
   * Runs once per call when it finishes, for logging or billing. Errors it throws reach the caller,
   * except on a call that already failed.
   */
  onRequest?: (event: RequestEvent) => void | Promise<void>
  retry?: RetryConfig
  /** Skips a target that keeps failing. `false` turns it off. */
  circuitBreaker?: CircuitBreakerConfig | false
  /**
   * How long one attempt may wait for the provider to respond, or for a stream's first chunk.
   * Defaults to 60000.
   */
  timeoutMs?: number
  /** Rate limits per user plan. A call passes `user: { id, plan }` to be counted. */
  plans?: Record<string, PlanConfig>
  /**
   * Where limits (and later the cache) keep state. Defaults to `memoryStore()`, which is per
   * process. Use `redisStore()` from `@moraq/core/redis` when you run more than one instance.
   */
  store?: Store
  fetch?: typeof fetch
}

export interface RequestOptions {
  signal?: AbortSignal
  /** `false` skips the cache for this call: no lookup and nothing stored. */
  cache?: boolean
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
  limits: {
    /** The user's remaining quota for each limit on their plan. Takes nothing. */
    check(user: MoraqUser): Promise<LimitStatus[]>
  }
}

type AttemptResult =
  | { type: 'completion'; provider: string; completion: ChatCompletion }
  | { type: 'stream'; provider: string; chunks: AsyncIterable<ChatCompletionChunk> }

export function createMoraq(config: MoraqConfig): Moraq {
  const fetchFn = config.fetch ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? 60_000
  const adapters = createAdapters(config.providers)
  const routes: Record<string, RouteTarget[]> = {}
  const routeCache: Record<string, CacheConfig | false | undefined> = {}
  for (const [name, route] of Object.entries(config.routes ?? {})) {
    routes[name] = Array.isArray(route) ? route : route.targets
    if (!Array.isArray(route)) routeCache[name] = route.cache
  }
  const cacheFor = (model: string): CacheConfig | undefined => {
    const route = model.startsWith('route:') ? model.slice('route:'.length) : undefined
    const setting = route !== undefined && route in routeCache ? routeCache[route] : config.cache
    return setting === false ? undefined : (setting ?? (config.cache || undefined))
  }
  // Fail at startup, not on the first request, if a ttl is malformed.
  for (const setting of [config.cache, ...Object.values(routeCache)]) {
    if (setting) parseDuration(setting.ttl)
  }
  const inflight = new Map<string, Promise<CacheEntry | undefined>>()
  const store = config.store ?? memoryStore()
  const limiter = createLimiter(config.plans ?? {}, store)
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

  for (const [name, plan] of Object.entries(config.plans ?? {})) {
    for (const route of plan.routes ?? []) {
      if (!routes[route]) {
        throw new MoraqConfigError(`Plan '${name}' allows route '${route}', which is not defined`)
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

  /**
   * Claims a cache key for this call. If an identical call is already running, waits for its answer
   * (up to `timeoutMs`) instead of making a second provider call.
   */
  async function claim(
    key: string,
  ): Promise<{ hit: CacheEntry } | { settle: (entry: CacheEntry | undefined) => void }> {
    const pending = inflight.get(key)
    if (pending) {
      const entry = await Promise.race([
        pending,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), timeoutMs).unref(),
        ),
      ])
      if (entry) return { hit: entry }
      return claim(key)
    }
    let resolve!: (entry: CacheEntry | undefined) => void
    inflight.set(key, new Promise((r) => (resolve = r)))
    let settled = false
    const settle = (entry: CacheEntry | undefined) => {
      if (settled) return
      settled = true
      inflight.delete(key)
      resolve(entry)
    }
    try {
      const raw = await store.get(key)
      if (raw !== undefined) {
        const entry = JSON.parse(raw) as CacheEntry
        settle(entry)
        return { hit: entry }
      }
    } catch (error) {
      settle(undefined)
      throw error
    }
    return { settle }
  }

  // Every call goes through here: plan check, cache, rate limits, then the router.
  async function execute(
    params: ChatCompletionCreateParams,
    options: RequestOptions,
  ): Promise<MoraqChatCompletion | MoraqStream> {
    const started = Date.now()
    // `user` is moraq's, never the provider's.
    const { user, ...rest } = params
    const request = rest as ChatCompletionCreateParams
    const stream = request.stream === true
    const targets = targetsFor(request.model)
    limiter.authorize(user, request.model)

    const report = async (
      event: Omit<RequestEvent, 'model' | 'user' | 'stream' | 'durationMs'>,
    ) => {
      await config.onRequest?.({
        model: request.model,
        ...(user && { user }),
        stream,
        durationMs: Date.now() - started,
        ...event,
      })
    }

    // Cache hits are free: they skip rate limits and providers.
    const cache = options.cache === false ? undefined : cacheFor(request.model)
    const key =
      cache && (cache.scope !== 'user' || user)
        ? await cacheKey(request, cache.scope === 'user' ? user?.id : undefined)
        : undefined
    let settle: ((entry: CacheEntry | undefined) => void) | undefined
    if (key) {
      const claimed = await claim(key)
      if ('hit' in claimed) {
        const { provider, completion } = claimed.hit
        const info = { provider, cached: true, attempts: 0 }
        await report({ provider, cached: true, attempts: 0, ...usageOf(completion.usage) })
        if (stream) return new MoraqStream(replayChunks(completion), info, new AbortController())
        return { ...completion, moraq: info }
      }
      settle = claimed.settle
    }
    const ttlMs = cache ? parseDuration(cache.ttl) : 0
    const remember = async (provider: string, completion: ChatCompletion | undefined) => {
      if (!key || !completion || !isCacheable(completion)) return settle?.(undefined)
      const entry = { provider, completion }
      await store.set(key, JSON.stringify(entry), ttlMs)
      settle?.(entry)
    }

    // Streams get their own controller so `stream.controller.abort()` works without a user signal.
    const controller = stream ? new AbortController() : undefined
    const signals = [options.signal, controller?.signal].filter((s) => s !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    // One create() counts once, whatever retries or fallbacks happen inside it.
    let refund = async () => {}
    let routed: { result: AttemptResult; attempts: number }
    try {
      refund = await limiter.reserve(user)
      routed = await router.run(targets, (target) => attempt(target, request, signal), signal)
    } catch (error) {
      settle?.(undefined)
      await refund()
      // The caller needs the original error, so a failing hook doesn't replace it.
      await report({ cached: false, error }).catch(() => {})
      throw error
    }

    const { result, attempts } = routed
    const info = { provider: result.provider, cached: false, attempts }
    if (result.type === 'stream') {
      const chunks = observe(result.chunks, async (collected, error) => {
        const completion = collected && assembleCompletion(collected)
        await remember(result.provider, completion)
        const usage = collected?.findLast((c) => c.usage)?.usage ?? undefined
        await report({
          provider: result.provider,
          cached: false,
          attempts,
          ...usageOf(usage),
          ...(error !== undefined && { error }),
        })
      })
      return new MoraqStream(chunks, info, controller as AbortController)
    }
    await remember(result.provider, result.completion)
    await report({
      provider: result.provider,
      cached: false,
      attempts,
      ...usageOf(result.completion.usage),
    })
    return { ...result.completion, moraq: info }
  }

  return {
    chat: {
      completions: {
        create: ((params: ChatCompletionCreateParams, options: RequestOptions = {}) =>
          execute(params, options)) as Moraq['chat']['completions']['create'],
      },
    },
    limits: {
      check: (user) => limiter.check(user),
    },
  }
}

/**
 * Passes chunks through and collects them. Calls `onEnd` once: with the chunks when the stream
 * finished, with nothing when the caller stopped early, or with the error if it broke.
 */
async function* observe<T>(
  chunks: AsyncIterable<T>,
  onEnd: (collected: T[] | undefined, error?: unknown) => Promise<void>,
): AsyncGenerator<T> {
  const collected: T[] = []
  let ended = false
  try {
    for await (const chunk of chunks) {
      collected.push(chunk)
      yield chunk
    }
    ended = true
    await onEnd(collected)
  } catch (error) {
    if (ended) throw error
    ended = true
    await onEnd(undefined, error).catch(() => {})
    throw error
  } finally {
    // The caller broke out of the loop early: report it, cache nothing.
    if (!ended) await onEnd(undefined)
  }
}

function usageOf(usage: CompletionUsage | null | undefined): { usage?: CompletionUsage } {
  return usage ? { usage } : {}
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
