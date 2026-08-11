import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CAPABILITIES_BY_ADAPTER = new Map([
  ['bailian-audio-process', new Set(['audio.enhance', 'audio.separate'])],
  ['bailian-tts', new Set(['speech.synthesize'])],
  ['bailian-cosyvoice', new Set(['speech.synthesize'])],
  ['compatible-tts', new Set(['speech.synthesize'])],
  ['bailian-asr', new Set(['speech.transcribe'])],
  ['bailian-qwen-audio-asr', new Set(['speech.transcribe'])],
  ['bailian-funasr', new Set(['speech.transcribe'])],
  ['compatible-asr', new Set(['speech.transcribe'])],
  ['bailian-llm', new Set(['text.generate'])],
  ['compatible-llm', new Set(['text.generate'])],
])
const PROVIDERS = new Set(['api.bailian', 'api.openai-compatible'])
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/

export async function readApiModelCatalog(
  sourcePath = resolve('catalog/api-models.json'),
) {
  const models = JSON.parse(await readFile(sourcePath, 'utf8'))
  if (!Array.isArray(models) || models.length > 256) {
    throw new Error(`${sourcePath}: expected at most 256 API models`)
  }
  const ids = new Set()
  for (const model of models) {
    if (
      !model ||
      typeof model.id !== 'string' ||
      typeof model.name !== 'string' ||
      typeof model.author !== 'string' ||
      !MODEL_ID_PATTERN.test(model.modelId ?? '')
    ) {
      throw new Error(`${sourcePath}: API model has invalid required fields`)
    }
    if (ids.has(model.id)) {
      throw new Error(`${sourcePath}: duplicate API model id ${model.id}`)
    }
    ids.add(model.id)
    if (!PROVIDERS.has(model.providerId)) {
      throw new Error(`${sourcePath}: ${model.id} uses an unknown provider`)
    }
    if (
      !CAPABILITIES_BY_ADAPTER.get(model.adapter)?.has(
        model.harnessCapability,
      )
    ) {
      throw new Error(`${sourcePath}: ${model.id} has an incompatible adapter`)
    }
    if (!['batch', 'streaming'].includes(model.streamingMode)) {
      throw new Error(`${sourcePath}: ${model.id} has an invalid streaming mode`)
    }
    if (typeof model.visible !== 'boolean') {
      throw new Error(`${sourcePath}: ${model.id} must declare visible`)
    }
    if (!Array.isArray(model.aliases) || model.aliases.length > 16) {
      throw new Error(`${sourcePath}: ${model.id} has invalid aliases`)
    }
    const aliases = new Set()
    for (const alias of model.aliases) {
      if (
        !MODEL_ID_PATTERN.test(alias) ||
        alias === model.modelId ||
        aliases.has(alias)
      ) {
        throw new Error(`${sourcePath}: ${model.id} has an invalid alias`)
      }
      aliases.add(alias)
    }
  }
  return models
}
