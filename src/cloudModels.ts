import builtinApiModels from '../catalog/api-models.json'
import type {
  ApiModelCatalogEntry,
  CustomApiModelDefinition,
  HarnessCatalog,
  ModelPlugin,
} from './types'

const RETIRED_CLOUD_MODEL_IDS = new Set([
  'bailian-fun-audio-mss',
  'fun-audio-mss',
])

export function isRetiredCloudModelId(id: string): boolean {
  return RETIRED_CLOUD_MODEL_IDS.has(id)
}

function supportedEntry(entry: ApiModelCatalogEntry): boolean {
  return (
    entry.visible !== false &&
    !isRetiredCloudModelId(entry.id) &&
    !isRetiredCloudModelId(entry.modelId)
  )
}

export function cloudModelsFromCatalog(
  catalog: HarnessCatalog | null,
  installedModelIds: readonly string[] = [],
  remoteModels: readonly ApiModelCatalogEntry[] = [],
  customModels: readonly CustomApiModelDefinition[] = [],
): ModelPlugin[] {
  if (!catalog) return []

  const entries = new Map(
    (builtinApiModels as ApiModelCatalogEntry[]).map((entry) => [
      entry.id,
      entry,
    ]),
  )
  for (const entry of remoteModels) entries.set(entry.id, entry)

  const installedIds = new Set(installedModelIds)
  const models: ModelPlugin[] = Array.from(entries.values())
    .filter(supportedEntry)
    .flatMap((entry) => {
      const provider = catalog.providers.find(
        (item) => item.id === entry.providerId,
      )
      if (!provider) return []
      return [
        {
          id: entry.id,
          name: entry.name,
          author: entry.author,
          engineAuthor: entry.author,
          description: entry.description,
          capabilities: entry.capabilities,
          harnessCapabilities: [entry.harnessCapability],
          runtime:
            entry.providerId === 'api.bailian'
              ? 'Bailian API'
              : 'Compatible API',
          acceleration: ['云端'],
          version: entry.modelId,
          size: '',
          installed: installedIds.has(entry.id),
          enabled: provider.status === 'ready',
          builtin: true,
          featured: entry.featured,
          installCount: 0,
          tone: 'violet' as const,
          providerId: entry.providerId,
          adapter: entry.adapter,
          installPath: '',
          catalogManaged: true,
          streamingMode: entry.streamingMode,
          apiAliases: entry.aliases,
        },
      ]
    })

  for (const definition of customModels) {
    const customProvider = catalog.providers.find(
      ({ id }) => id === definition.providerId,
    )
    if (!customProvider || !definition.modelId.trim()) continue
    const presentation =
      definition.capability === 'speech.transcribe'
        ? {
            description: `通过 ${customProvider.name || '自定义 Provider'} 调用的语音识别模型。`,
            capabilities: ['ASR', '语音识别', 'Custom API'],
            adapter: 'compatible-asr',
          }
        : definition.capability === 'speech.synthesize'
          ? {
              description: `通过 ${customProvider.name || '自定义 Provider'} 调用的语音合成模型。`,
              capabilities: ['TTS', '语音合成', 'Custom API'],
              adapter: 'compatible-tts',
            }
          : {
              description: `通过 ${customProvider.name || '自定义 Provider'} 调用的 LLM。`,
              capabilities: ['LLM', '文本生成', 'Custom API'],
              adapter: 'compatible-llm',
            }
    models.push({
      id: definition.id,
      name: definition.name.trim() || definition.modelId,
      author: customProvider.name || 'Custom Provider',
      engineAuthor: customProvider.name || 'Custom Provider',
      description: presentation.description,
      capabilities: presentation.capabilities,
      harnessCapabilities: [definition.capability],
      runtime: 'Compatible API',
      acceleration: ['云端'],
      version: definition.modelId,
      size: '',
      installed: installedIds.has(definition.id),
      enabled: customProvider.status === 'ready',
      builtin: true,
      featured: false,
      installCount: 0,
      tone: 'violet',
      providerId: definition.providerId,
      adapter: presentation.adapter,
      installPath: '',
      catalogManaged: true,
      streamingMode: 'batch',
      apiAliases: [],
      defaultVoice: definition.defaultVoice,
    })
  }

  return models
}
