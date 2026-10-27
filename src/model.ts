import { MoraqConfigError } from './errors.js'

export function parseModel(model: string): { provider: string; model: string } {
  if (model.startsWith('route:')) {
    throw new MoraqConfigError(`Routes are not supported yet: '${model}'`)
  }
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new MoraqConfigError(
      `Model '${model}' needs a provider prefix, for example 'openai/gpt-4o-mini'`,
    )
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}
