import builtinApiModels from '../catalog/api-models.json'
import type {
  ApiModelCatalogEntry,
  HarnessCatalog,
  ModelPlugin,
} from './types'

export const RETIRED_CLOUD_MODEL_IDS = new Set([
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
  return Array.from(entries.values())
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
}
