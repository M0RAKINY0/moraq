import { MoraqProviderError, MoraqProvidersFailedError, type ProviderErrorKind } from './errors.js'

export interface RouteTarget {
  provider: string
  model: string
  /** Retries on this target before moving to the next one. Defaults to `retry.retries`. */
  retries?: number
}

export interface RetryConfig {
  /** Defaults to 2. */
  retries?: number
  /** First backoff step. Each retry doubles it, with random jitter. Defaults to 500. */
  baseDelayMs?: number
  /**
   * Longest moraq waits between retries. A `retry-after` longer than this moves on to the next
   * target instead of waiting. Defaults to 8000.
   */
  maxDelayMs?: number
}

export interface CircuitBreakerConfig {
  /** Failures in a row before a target gets skipped. Defaults to 5. */
  failureThreshold?: number
  /** How long a tripped target gets skipped. After that it gets one trial call. Defaults to 30000. */
  cooldownMs?: number
}

type Action = 'retry' | 'next' | 'throw'

function actionFor(kind: ProviderErrorKind): Action {
  switch (kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'server':
    case 'timeout':
    case 'network':
      return 'retry'
    case 'auth':
    case 'bad_request':
      // A bug in the caller's code or keys. Another provider won't fix it.
      return 'throw'
    default:
      return 'next'
  }
}

export interface RouterOptions {
  retry?: RetryConfig
  circuitBreaker?: CircuitBreakerConfig | false
}

export interface Router {
  /**
   * Calls `attempt` for each target in order until one succeeds. Returns the result and how many
   * attempts it took.
   */
  run<T>(
    targets: RouteTarget[],
    attempt: (target: RouteTarget) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ result: T; attempts: number }>
}

export function createRouter({ retry = {}, circuitBreaker = {} }: RouterOptions): Router {
  const { retries: defaultRetries = 2, baseDelayMs = 500, maxDelayMs = 8000 } = retry
  const breaker = circuitBreaker === false ? undefined : new CircuitBreaker(circuitBreaker)

  return {
    async run(targets, attempt, signal) {
      const failures: MoraqProviderError[] = []
      const failed: RouteTarget[] = []
      // If every target is tripped, try them anyway rather than fail without a single call.
      const open = targets.filter((t) => breaker?.allows(key(t)) ?? true)
      for (const target of open.length > 0 ? open : targets) {
        const retries = target.retries ?? defaultRetries
        for (let i = 0; i <= retries; i++) {
          try {
            const result = await attempt(target)
            breaker?.success(key(target))
            return { result, attempts: failures.length + 1 }
          } catch (error) {
            if (!(error instanceof MoraqProviderError)) throw error
            failures.push(error)
            failed.push(target)
            const action = actionFor(error.kind)
            if (action === 'throw') throw error
            breaker?.failure(key(target))
            const tripped = breaker !== undefined && !breaker.allows(key(target))
            if (action === 'next' || i === retries || tripped) break
            const delay = backoff(i, error.retryAfterMs, baseDelayMs, maxDelayMs)
            if (delay === undefined) break
            await sleep(delay, signal)
          }
        }
      }
      throw new MoraqProvidersFailedError(
        failures.map((error, i) => ({
          provider: error.provider,
          model: failed[i]?.model ?? '',
          kind: error.kind,
          ...(error.status !== undefined && { status: error.status }),
          message: error.message,
        })),
        { cause: failures.at(-1) },
      )
    },
  }
}

function key(target: RouteTarget): string {
  return `${target.provider}/${target.model}`
}

/** Full jitter: a random wait up to the exponential step. Undefined means don't wait, move on. */
function backoff(
  attempt: number,
  retryAfterMs: number | undefined,
  baseDelayMs: number,
  maxDelayMs: number,
): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs <= maxDelayMs ? retryAfterMs : undefined
  return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class CircuitBreaker {
  readonly #threshold: number
  readonly #cooldownMs: number
  readonly #state = new Map<string, { failures: number; openedAt?: number }>()

  constructor({ failureThreshold = 5, cooldownMs = 30_000 }: CircuitBreakerConfig) {
    this.#threshold = failureThreshold
    this.#cooldownMs = cooldownMs
  }

  allows(key: string): boolean {
    const openedAt = this.#state.get(key)?.openedAt
    return openedAt === undefined || Date.now() - openedAt >= this.#cooldownMs
  }

  success(key: string): void {
    this.#state.delete(key)
  }

  failure(key: string): void {
    const state = this.#state.get(key) ?? { failures: 0 }
    state.failures++
    // Past the threshold, every failure (including the trial call after a cooldown) re-opens it.
    if (state.failures >= this.#threshold) state.openedAt = Date.now()
    this.#state.set(key, state)
  }
}
