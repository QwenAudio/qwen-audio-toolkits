import type { ModelPlugin } from '../types'

type InputAwareModel = Pick<
  ModelPlugin,
  'adapter' | 'id' | 'inputs' | 'providerId' | 'version'
>

const REFERENCE_AUDIO_ADAPTERS = new Set([
  'cosyvoice-local',
  'pocket-tts',
  'zipvoice',
])
const REFERENCE_TEXT_ADAPTERS = new Set(['cosyvoice-local', 'zipvoice'])
const CUSTOM_COSYVOICE_MODELS = new Set([
  'cosyvoice-v3.5-flash',
  'cosyvoice-v3.5-plus',
])
const CLOUD_VOICE_CREATION_MODELS = new Set([
  'qwen-audio-3.0-tts-flash',
  'qwen-audio-3.0-tts-plus',
  'cosyvoice-v3-plus',
  ...CUSTOM_COSYVOICE_MODELS,
])

function speakerCount(model: InputAwareModel): number | null {
  if (model.adapter === 'kokoro') return 103
  if (model.id === 'k2-fsa.vits-aishell3') return 174
  if (model.id === 'k2-fsa.vits-melo-zh-en') return 1
  return null
}

export function modelInputProfile(model: InputAwareModel) {
  const apiModel = model.providerId?.startsWith('api.') === true
  const declaredReferenceAudio = model.inputs?.find(
    (port) => port.type === 'audio',
  )
  const ttsSpeakerCount = speakerCount(model) ?? 0

  return {
    apiModel,
    requiresCustomCosyVoice: CUSTOM_COSYVOICE_MODELS.has(model.version),
    supportsCloudVoiceCreation:
      model.providerId === 'api.bailian' &&
      CLOUD_VOICE_CREATION_MODELS.has(model.version),
    supportsVoiceDesign: model.version.startsWith('cosyvoice-v3.5-'),
    supportsTtsInstruction:
      model.providerId === 'api.bailian' &&
      (model.version.startsWith('qwen-audio-3.0-tts-') ||
        CUSTOM_COSYVOICE_MODELS.has(model.version)),
    requiresTtsReferenceAudio:
      Boolean(declaredReferenceAudio) ||
      REFERENCE_AUDIO_ADAPTERS.has(model.adapter),
    ttsReferenceAudioLabel: declaredReferenceAudio?.label ?? '参考音频',
    requiresTtsReferenceText: REFERENCE_TEXT_ADAPTERS.has(model.adapter),
    supportsTtsLanguage: model.adapter === 'supertonic',
    speakerCount: ttsSpeakerCount,
    supportsSpeakerSelection:
      !apiModel && ttsSpeakerCount > 1,
  }
}
