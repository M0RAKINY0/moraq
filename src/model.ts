import { MoraqConfigError } from './errors.js'

export type ParsedModel = { route: string } | { provider: string; model: string }

/** Splits `route:<name>` or `<provider>/<model>`. The model part may contain more slashes. */
export function parseModel(model: string): ParsedModel {
  if (model.startsWith('route:')) {
    const route = model.slice('route:'.length)
    if (route === '') throw new MoraqConfigError(`Model '${model}' is missing a route name`)
    return { route }
  }
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new MoraqConfigError(
      `Model '${model}' needs a provider prefix, for example 'openai/gpt-4o-mini', or a route, for example 'route:chat'`,
    )
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}
