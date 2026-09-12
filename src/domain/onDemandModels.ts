import type { GeneralAgentAttachment, GeneralAgentInstallModelAction } from './agents'
import type { ModelPlugin } from '../types'

export type OnDemandModelInstallMode = 'ask' | 'auto'

export interface OnDemandModelNeed {
  id: string
  capability: ModelPlugin['harnessCapabilities'][number]
  label: string
  actionLabel: string
  preferredModelIds: string[]
}

export interface OnDemandModelResolution {
  need: OnDemandModelNeed
  installedModel: ModelPlugin | null
  recommendedModel: ModelPlugin | null
}

export interface OnDemandModelExecutionCandidate {
  resolution: OnDemandModelResolution
  model: ModelPlugin
  plan: OnDemandModelExecutionPlan
}

export type OnDemandModelExecutionPlan =
  | {
    capability: 'audio.enhance'
    outputFileName: string
    parameters: {
      operations: ['denoise']
      denoiseStrength: number
      outputFileName: string
    }
  }
  | {
    capability: 'speech.transcribe'
    parameters: {
      language: 'auto'
    }
  }

export type OnDemandModelAction =
  | { kind: 'none' }
  | { kind: 'use-installed'; resolution: OnDemandModelResolution; model: ModelPlugin }
  | { kind: 'ask-install'; resolution: OnDemandModelResolution; model: ModelPlugin }
  | { kind: 'auto-install'; resolution: OnDemandModelResolution; model: ModelPlugin }
  | { kind: 'unavailable'; resolution: OnDemandModelResolution }

const ON_DEMAND_NEEDS: OnDemandModelNeed[] = [
  {
    id: 'audio-denoise',
    capability: 'audio.enhance',
    label: '音频降噪',
    actionLabel: '降噪',
    preferredModelIds: [
      'rikorose.deepfilternet3',
      'modelscope.zipenhancer-16k',
      'xiph.rnnoise',
    ],
  },
  {
    id: 'speech-transcribe',
    capability: 'speech.transcribe',
    label: '语音转写',
    actionLabel: '转写',
    preferredModelIds: [
      'funaudiollm.sensevoice-small-gguf',
      'k2-fsa.funasr-nano',
      'funaudiollm.paraformer-gguf',
    ],
  },
  {
    id: 'audio-separate',
    capability: 'audio.separate',
    label: '音频分离',
    actionLabel: '分离',
    preferredModelIds: [
      'modelscope.mossformer2-separation-8k',
      'k2-fsa.spleeter-2stems',
    ],
  },
]

const NEED_KEYWORDS: Record<string, RegExp[]> = {
  'audio-denoise': [
    /降噪/u,
    /去噪/u,
    /消噪/u,
    /噪声/u,
    /底噪/u,
    /风噪/u,
    /电流声/u,
    /\bdenoise\b/iu,
    /\bnoise\s*reduction\b/iu,
  ],
  'speech-transcribe': [
    /转写/u,
    /听写/u,
    /识别.*(语音|音频|录音)/u,
    /(语音|音频|录音).*识别/u,
    /字幕/u,
    /\basr\b/iu,
    /\btranscri(?:be|ption)\b/iu,
  ],
  'audio-separate': [
    /人声分离/u,
    /伴奏分离/u,
    /分离.*(人声|伴奏|说话人|音轨)/u,
    /(人声|伴奏|说话人|音轨).*分离/u,
    /\bsource\s*separation\b/iu,
    /\bvocal\s*separation\b/iu,
  ],
}

function scoreModelForNeed(model: ModelPlugin, need: OnDemandModelNeed): number {
  const preferredIndex = need.preferredModelIds.indexOf(model.id)
  const preferredScore = preferredIndex >= 0 ? 100 - preferredIndex : 0
  const featuredScore = model.featured ? 6 : 0
  const localScore = model.providerId?.startsWith('plugin.') ? 3 : 0
  const installableScore = model.installable === false ? -20 : 0
  return preferredScore + featuredScore + localScore + installableScore
}

function fileNameFromAttachment(attachment: GeneralAgentAttachment): string {
  return attachment.name || attachment.path.split(/[\\/]/u).at(-1) || 'audio.wav'
}

export function enhancedAudioFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/u).at(-1) || 'audio.wav'
  const stem = baseName.replace(/\.[^.\\/]+$/u, '').trim() || 'audio'
  const safeStem = stem.replace(/[^\p{Letter}\p{Number}_-]+/gu, '_').replace(/^_+|_+$/gu, '')
  return `${safeStem || 'audio'}_enhanced.wav`
}

export function createOnDemandModelExecutionPlan(
  resolution: OnDemandModelResolution,
  model: ModelPlugin,
  attachment: GeneralAgentAttachment | null,
): OnDemandModelExecutionPlan | null {
  if (!attachment) return null
  if (resolution.need.id === 'audio-denoise') {
    if (model.id !== 'rikorose.deepfilternet3' && model.adapter !== 'deepfilternet') return null
    const fileName = fileNameFromAttachment(attachment)
    if (!/\.wav$/iu.test(fileName)) return null
    const outputFileName = enhancedAudioFileName(fileName)
    return {
      capability: 'audio.enhance',
      outputFileName,
      parameters: {
        operations: ['denoise'],
        denoiseStrength: 0.3,
        outputFileName,
      },
    }
  }
  if (resolution.need.id === 'speech-transcribe') {
    const isPreferredLocalModel =
      resolution.need.preferredModelIds.includes(model.id) ||
      model.adapter === 'funasr-sensevoice-gguf' ||
      model.adapter === 'funasr-paraformer-gguf' ||
      model.providerId?.startsWith('plugin.')
    if (!isPreferredLocalModel || !model.harnessCapabilities.includes('speech.transcribe')) return null
    return {
      capability: 'speech.transcribe',
      parameters: {
        language: 'auto',
      },
    }
  }
  return null
}

export function resolveOnDemandModelExecution(
  content: string,
  models: ModelPlugin[],
  attachment: GeneralAgentAttachment | null,
): OnDemandModelExecutionCandidate | null {
  const candidates = resolveOnDemandModelExecutions(content, models, attachment)
  if (!candidates.length) return null
  const installed = candidates.find(({ model }) => model.installed) ?? null
  const installable = candidates.find(({ model }) =>
    model.catalogManaged && model.installable !== false,
  ) ?? null
  return installed ?? installable ?? null
}

export function resolveOnDemandModelExecutions(
  content: string,
  models: ModelPlugin[],
  attachment: GeneralAgentAttachment | null,
): OnDemandModelExecutionCandidate[] {
  const need = detectOnDemandModelNeed(content)
  if (!need) return []
  return sortCandidatesForNeed(models, need)
    .flatMap((model) => {
      const resolution: OnDemandModelResolution = {
        need,
        installedModel: model.installed ? model : null,
        recommendedModel: model,
      }
      const plan = createOnDemandModelExecutionPlan(resolution, model, attachment)
      return plan ? [{ resolution, model, plan }] : []
    })
    .filter(({ model }) =>
      model.installed || (model.catalogManaged && model.installable !== false),
    )
}

function sortCandidatesForNeed(models: ModelPlugin[], need: OnDemandModelNeed): ModelPlugin[] {
  return models
    .filter((model) =>
      model.extensionKind !== 'workspace-agent' &&
      model.harnessCapabilities.includes(need.capability),
    )
    .sort((left, right) => scoreModelForNeed(right, need) - scoreModelForNeed(left, need))
}

export function detectOnDemandModelNeed(content: string): OnDemandModelNeed | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return ON_DEMAND_NEEDS.find((need) =>
    NEED_KEYWORDS[need.id]?.some((pattern) => pattern.test(trimmed)),
  ) ?? null
}

export function resolveOnDemandModelNeed(
  content: string,
  models: ModelPlugin[],
): OnDemandModelResolution | null {
  const need = detectOnDemandModelNeed(content)
  if (!need) return null
  const candidates = sortCandidatesForNeed(models, need)
  const primaryModel = candidates.find((model) => model.id === need.preferredModelIds[0]) ?? null
  const installedModel =
    primaryModel?.installed
      ? primaryModel
      : need.id === 'audio-denoise' && primaryModel
        ? null
        : candidates.find((model) => model.installed) ?? null
  const recommendedModel =
    installedModel ??
    (primaryModel?.catalogManaged && primaryModel.installable !== false ? primaryModel : null) ??
    candidates.find((model) => model.catalogManaged && model.installable !== false) ??
    candidates[0] ??
    null
  return {
    need,
    installedModel,
    recommendedModel,
  }
}

export function planOnDemandModelAction(
  content: string,
  models: ModelPlugin[],
  installMode: OnDemandModelInstallMode,
): OnDemandModelAction {
  const resolution = resolveOnDemandModelNeed(content, models)
  if (!resolution) return { kind: 'none' }
  if (resolution.installedModel) {
    return { kind: 'use-installed', resolution, model: resolution.installedModel }
  }
  if (!resolution.recommendedModel) {
    return { kind: 'unavailable', resolution }
  }
  return installMode === 'auto'
    ? { kind: 'auto-install', resolution, model: resolution.recommendedModel }
    : { kind: 'ask-install', resolution, model: resolution.recommendedModel }
}

export function createInstallModelAction(
  resolution: OnDemandModelResolution,
  model: ModelPlugin,
  request: {
    prompt: string
    selectedModeName: string | null
    attachmentHint: string
    attachment?: GeneralAgentAttachment | null
  },
): GeneralAgentInstallModelAction {
  return {
    id: resolution.need.id,
    kind: 'install-on-demand-model',
    status: 'pending',
    modelId: model.id,
    modelName: model.name,
    capability: resolution.need.capability,
    needLabel: resolution.need.label,
    actionLabel: resolution.need.actionLabel,
    prompt: request.prompt,
    selectedModeName: request.selectedModeName,
    attachmentHint: request.attachmentHint,
    attachment: request.attachment ?? null,
  }
}

export function isInstallApproval(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/gu, '')
  return [
    '安装',
    '同意',
    '可以',
    '好的',
    '好',
    '确认',
    '帮我安装',
    '现在安装',
    '自动安装',
    '直接安装',
    'yes',
    'y',
    'ok',
    'install',
  ].includes(normalized)
}
