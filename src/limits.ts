import { MoraqConfigError, MoraqError } from './errors.js'
import type { LimitRule, LimitStrategy, Store } from './store.js'
import type { MoraqUser } from './types.js'

/** Milliseconds, or a number with a unit: `'30s'`, `'15m'`, `'1h'`, `'1d'`. */
export type Duration = number | `${number}${'s' | 'm' | 'h' | 'd'}`

export interface LimitConfig {
  requests: number
  per: Duration
  /** Defaults to 'sliding'. */
  strategy?: LimitStrategy
}

export interface PlanConfig {
  /** A request must fit every limit. */
  limits?: LimitConfig[]
  /** If set, users on this plan may only call these routes (`model: 'route:<name>'`). */
  routes?: string[]
}

export interface LimitStatus {
  limit: LimitConfig
  remaining: number
  resetAt: Date
}

/** A user hit one of their plan's limits. Nothing was sent to a provider. */
export class MoraqRateLimitError extends MoraqError {
  override name = 'MoraqRateLimitError'
  readonly limit: LimitConfig
  readonly remaining: number
  readonly resetAt: Date
  readonly retryAfterMs: number

  constructor(limit: LimitConfig, resetAt: Date, retryAfterMs: number) {
    super(`Rate limit reached: ${limit.requests} requests per ${limit.per}`)
    this.limit = limit
    this.remaining = 0
    this.resetAt = resetAt
    this.retryAfterMs = retryAfterMs
  }
}

/** A user's plan doesn't allow the route or model they called. */
export class MoraqPlanError extends MoraqError {
  override name = 'MoraqPlanError'
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export function parseDuration(value: Duration): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value)
  if (!match)
    throw new MoraqConfigError(`'${value}' is not a duration. Use e.g. '30s', '15m', '1h', '1d'`)
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
}

interface CompiledLimit {
  config: LimitConfig
  rule: LimitRule
}

export interface Limiter {
  /** Throws if the user's plan is unknown or doesn't allow `model`. Takes nothing. */
  authorize(user: MoraqUser | undefined, model: string): void
  /**
   * Takes one request from every limit on the user's plan, or throws without taking any.
   * Returns a function that gives them back.
   */
  reserve(user: MoraqUser | undefined): Promise<() => Promise<void>>
  check(user: MoraqUser): Promise<LimitStatus[]>
}

export function createLimiter(plans: Record<string, PlanConfig>, store: Store): Limiter {
  const compiled = new Map<string, { limits: CompiledLimit[]; routes?: string[] }>()
  for (const [name, plan] of Object.entries(plans)) {
    compiled.set(name, {
      limits: (plan.limits ?? []).map((config) => {
        if (!(Number.isInteger(config.requests) && config.requests > 0)) {
          throw new MoraqConfigError(`Plan '${name}' has a limit with requests ${config.requests}`)
        }
        return {
          config,
          rule: {
            max: config.requests,
            windowMs: parseDuration(config.per),
            strategy: config.strategy ?? 'sliding',
          },
        }
      }),
      ...(plan.routes && { routes: plan.routes }),
    })
  }

  const planFor = (user: MoraqUser) => {
    const plan = compiled.get(user.plan)
    if (!plan) throw new MoraqConfigError(`Plan '${user.plan}' is not in config.plans`)
    return plan
  }
  const keyFor = (user: MoraqUser, { rule }: CompiledLimit) =>
    `moraq:limit:${rule.max}/${rule.windowMs}/${rule.strategy}:${user.id}`

  return {
    authorize(user, model) {
      if (!user) return
      const plan = planFor(user)
      if (plan.routes) {
        const route = model.startsWith('route:') ? model.slice('route:'.length) : undefined
        if (route === undefined || !plan.routes.includes(route)) {
          throw new MoraqPlanError(
            `Plan '${user.plan}' can't use '${model}'. Allowed routes: ${plan.routes.join(', ')}`,
          )
        }
      }
    },
    async reserve(user) {
      if (!user) return async () => {}
      const plan = planFor(user)
      const now = Date.now()
      const taken: CompiledLimit[] = []
      const refund = async () => {
        await Promise.all(taken.map((l) => store.refund(keyFor(user, l), l.rule, now)))
      }
      for (const limit of plan.limits) {
        const state = await store.consume(keyFor(user, limit), limit.rule, now)
        if (!state.allowed) {
          await refund()
          throw new MoraqRateLimitError(
            limit.config,
            new Date(state.resetAt),
            Math.max(0, state.resetAt - now),
          )
        }
        taken.push(limit)
      }
      return refund
    },
    async check(user) {
      const now = Date.now()
      return Promise.all(
        planFor(user).limits.map(async (limit) => {
          const state = await store.peek(keyFor(user, limit), limit.rule, now)
          return {
            limit: limit.config,
            remaining: state.remaining,
            resetAt: new Date(state.resetAt),
          }
        }),
      )
    },
  }
}
