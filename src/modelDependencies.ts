import type { ModelDependencyBindings, ModelPlugin } from './types'

export type ModelDependencyRole = string

export interface ModelDependency {
  role: ModelDependencyRole
  label: string
  pluginId: string
  capability: ModelPlugin['harnessCapabilities'][number]
  default: boolean
  optional: boolean
}

// These ASR adapters call the FunASR llama.cpp/GGUF CLI, which does its own internal FSMN-VAD
// segmentation (bundled fsmn-vad.gguf) and never reads the harness's speechSegments input, so
// recommending an external speech-segmentation dependency for them is misleading and wasteful.
const IGNORES_SPEECH_SEGMENTATION_DEPENDENCY = [
  'funasr-nano',
  'funasr-sensevoice-gguf',
  'funasr-paraformer-gguf',
]

export function recommendedDependencies(plugin: ModelPlugin): ModelDependency[] {
  if (plugin.recommendedDependencies?.length) {
    return plugin.recommendedDependencies.map((dependency) => ({
      role: dependency.role,
      label: dependency.label,
      pluginId: dependency.pluginId,
      capability: dependency.capability,
      default: dependency.default,
      optional: dependency.optional,
    }))
  }
  if (
    plugin.harnessCapabilities.includes('speech.transcribe') &&
    !IGNORES_SPEECH_SEGMENTATION_DEPENDENCY.includes(plugin.adapter)
  ) {
    return [
      {
        role: 'speech-segmentation',
        label: '自动分段',
        pluginId: 'silero-vad',
        capability: 'speech.detect',
        default: true,
        optional: true,
      },
    ]
  }
  const voiceClone =
    plugin.harnessCapabilities.includes('speech.synthesize') &&
    (plugin.inputs?.some((input) => input.type === 'audio') ||
      ['zipvoice', 'pocket-tts', 'cosyvoice-local'].includes(plugin.adapter))
  return voiceClone
    ? [
        {
          role: 'reference-transcription',
          label: '参考文本识别',
          pluginId: 'funaudiollm.sensevoice-small-gguf',
          capability: 'speech.transcribe',
          default: true,
          optional: true,
        },
      ]
    : []
}

export function getModelBinding(
  bindings: ModelDependencyBindings,
  pluginId: string,
  role: ModelDependencyRole,
  fallback: string,
): string {
  return bindings[pluginId]?.[role] ?? fallback
}

export function referencingModels(
  dependencyId: string,
  models: ModelPlugin[],
  bindings: ModelDependencyBindings,
): ModelPlugin[] {
  return models.filter(
    (model) =>
      model.installed &&
      model.id !== dependencyId &&
      recommendedDependencies(model).some((dependency) => {
        const selectedId = getModelBinding(
          bindings,
          model.id,
          dependency.role,
          dependency.default ? dependency.pluginId : '',
        )
        return selectedId === dependencyId
      }),
  )
}