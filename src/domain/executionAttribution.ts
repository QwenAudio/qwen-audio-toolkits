type RunnerMode = 'boss' | 'workbench'

type AttributionPlugin = {
  name: string
  providerId?: string
  version: string
}

export interface RunnerAttribution {
  conversationProviderId: string | undefined
  titlePluginName: string
  readsBossTextHistory: boolean
  appendsBossTextHistory: boolean
  includesSystemPrompt: boolean
}

export function resolveRunnerAttribution({
  mode,
  providerId,
  modelId,
  selectedPlugin,
  plugins,
}: {
  mode: RunnerMode
  providerId: string
  modelId: string
  selectedPlugin: AttributionPlugin
  plugins: AttributionPlugin[]
}): RunnerAttribution {
  if (mode === 'boss') {
    return {
      conversationProviderId: selectedPlugin.providerId,
      titlePluginName: selectedPlugin.name,
      readsBossTextHistory: true,
      appendsBossTextHistory: true,
      includesSystemPrompt: true,
    }
  }

  const targetPlugin = plugins.find(
    (plugin) =>
      plugin.providerId === providerId && plugin.version === modelId,
  )

  return {
    conversationProviderId: providerId,
    titlePluginName: targetPlugin?.name ?? modelId,
    readsBossTextHistory: false,
    appendsBossTextHistory: false,
    includesSystemPrompt: false,
  }
}
