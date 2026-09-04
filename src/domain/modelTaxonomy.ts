import type { HarnessCapabilityId } from '../types'
import { capabilityDefinition } from './capabilities'

export const MODEL_PRIMARY_CATEGORIES = [
  { id: 'multimodal', label: 'Multimodal' },
  { id: 'vision', label: 'Vision' },
  { id: 'text', label: 'Text' },
  { id: 'audio', label: 'Audio' },
] as const

export type ModelPrimaryCategory =
  (typeof MODEL_PRIMARY_CATEGORIES)[number]['id']

type ModelModality = 'Vision' | 'Audio' | 'Text'

interface ModelTaxonomySource {
  harnessCapabilities: HarnessCapabilityId[]
  inputs?: ReadonlyArray<{ type: string }>
  outputs?: ReadonlyArray<{ type: string }>
}

interface ModelTaxonomy {
  primaryCategory: ModelPrimaryCategory
  secondaryCategory: string
  inputModalities: ModelModality[]
  outputModalities: ModelModality[]
}

const MODALITY_ORDER: Record<ModelModality, number> = {
  Vision: 0,
  Audio: 1,
  Text: 2,
}

const VISUAL_MEDIA_PORTS = new Set([
  'image',
  'images',
  'video',
  'videos',
  'vision',
  'frames',
])

function isVisionPort(type: string): boolean {
  return VISUAL_MEDIA_PORTS.has(type.toLowerCase())
}

function inputModality(type: string): ModelModality {
  if (isVisionPort(type)) return 'Vision'
  const normalized = type.toLowerCase()
  if (
    normalized === 'audio' ||
    normalized === 'audio-tracks' ||
    normalized === 'speech' ||
    normalized === 'speech-segments'
  ) {
    return 'Audio'
  }
  return 'Text'
}

function outputModality(type: string): ModelModality {
  if (isVisionPort(type)) return 'Vision'
  const normalized = type.toLowerCase()
  if (
    normalized === 'audio' ||
    normalized === 'audio-tracks' ||
    normalized === 'speech' ||
    normalized === 'stream'
  ) {
    return 'Audio'
  }
  return 'Text'
}

function uniqueModalities(
  types: readonly string[],
  resolve: (type: string) => ModelModality,
): ModelModality[] {
  return [...new Set(types.map(resolve))].sort(
    (left, right) => MODALITY_ORDER[left] - MODALITY_ORDER[right],
  )
}

function modelPortTypes(
  model: ModelTaxonomySource,
  direction: 'input' | 'output',
): string[] {
  const declared = direction === 'input' ? model.inputs : model.outputs
  if (declared?.length) return declared.map((port) => port.type)

  return model.harnessCapabilities.flatMap((capability) => {
    const definition = capabilityDefinition(capability)
    return direction === 'input'
      ? definition.inputTypes
      : [definition.outputType]
  })
}

export function modelTaxonomy(model: ModelTaxonomySource): ModelTaxonomy {
  const inputModalities = uniqueModalities(
    modelPortTypes(model, 'input'),
    inputModality,
  )
  const outputModalities = uniqueModalities(
    modelPortTypes(model, 'output'),
    outputModality,
  )
  const normalizedInputs: ModelModality[] = inputModalities.length
    ? inputModalities
    : ['Text']
  const normalizedOutputs: ModelModality[] = outputModalities.length
    ? outputModalities
    : ['Text']
  const mediaModalities = new Set(
    [...normalizedInputs, ...normalizedOutputs].filter(
      (modality) => modality !== 'Text',
    ),
  )

  let primaryCategory: ModelPrimaryCategory
  if (
    normalizedInputs.length > 1 ||
    normalizedOutputs.length > 1 ||
    mediaModalities.size > 1
  ) {
    primaryCategory = 'multimodal'
  } else if (
    normalizedInputs.includes('Vision') ||
    normalizedOutputs.includes('Vision')
  ) {
    primaryCategory = 'vision'
  } else if (
    normalizedInputs.includes('Audio') ||
    normalizedOutputs.includes('Audio')
  ) {
    primaryCategory = 'audio'
  } else {
    primaryCategory = 'text'
  }

  return {
    primaryCategory,
    secondaryCategory: `${normalizedInputs.join('-')}-to-${normalizedOutputs.join('-')}`,
    inputModalities: normalizedInputs,
    outputModalities: normalizedOutputs,
  }
}
