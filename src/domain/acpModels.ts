export interface AcpModelCatalog {
  models: Array<{ id: string; name: string }>
  currentModelId: string | null
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export function parseAcpModelCatalog(value: unknown): AcpModelCatalog {
  if (!record(value)) return { models: [], currentModelId: null }
  const config = Array.isArray(value.configOptions) ? value.configOptions.find(option => record(option) &&
    option.type === 'select' && (option.category === 'model' || option.id === 'model')) : null
  const models: AcpModelCatalog['models'] = []
  const add = (id: unknown, name: unknown) => {
    if (typeof id === 'string' && id && !models.some(model => model.id === id)) models.push({ id, name: typeof name === 'string' ? name : id })
  }
  if (record(config)) {
    const collect = (options: unknown, depth = 0) => {
      if (!Array.isArray(options) || depth > 8) return
      for (const option of options) {
        if (!record(option)) continue
        if (Array.isArray(option.options)) collect(option.options, depth + 1)
        else add(option.value, option.name)
      }
    }
    collect(config.options)
    return { models, currentModelId: typeof config.currentValue === 'string' ? config.currentValue : null }
  }
  const state = record(value.models) ? value.models : {}
  const available = Array.isArray(state.availableModels) ? state.availableModels : Array.isArray(value.models) ? value.models : []
  for (const model of available) if (record(model)) add(model.modelId ?? model.id, model.name)
  return { models, currentModelId: typeof state.currentModelId === 'string' ? state.currentModelId : null }
}
