export type ProviderErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'bad_request'
  | 'context_length'
  | 'content_filter'
  | 'quota_exhausted'
  | 'not_found'
  | 'unknown'

export class MoraqError extends Error {
  override name = 'MoraqError'
}

export class MoraqConfigError extends MoraqError {
  override name = 'MoraqConfigError'
}

export interface MoraqProviderErrorOptions {
  kind: ProviderErrorKind
  provider: string
  status?: number
  retryAfterMs?: number
  body?: unknown
  cause?: unknown
}

export class MoraqProviderError extends MoraqError {
  override name = 'MoraqProviderError'
  readonly kind: ProviderErrorKind
  readonly provider: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly body?: unknown

  constructor(message: string, options: MoraqProviderErrorOptions) {
    super(message, { cause: options.cause })
    this.kind = options.kind
    this.provider = options.provider
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.body !== undefined) this.body = options.body
  }
}

export interface ProviderAttempt {
  provider: string
  model: string
  kind: ProviderErrorKind
  status?: number
  message: string
}

/** Every target in a route failed. `attempts` lists each try in order. */
export class MoraqProvidersFailedError extends MoraqError {
  override name = 'MoraqProvidersFailedError'
  readonly attempts: ProviderAttempt[]

  constructor(attempts: ProviderAttempt[], options?: { cause?: unknown }) {
    const tried = attempts.map((a) => `${a.provider}/${a.model} (${a.kind})`).join(', ')
    super(`Every provider failed: ${tried}`, options)
    this.attempts = attempts
  }
}
