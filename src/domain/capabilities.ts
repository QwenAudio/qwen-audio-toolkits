import type {
  HarnessCapabilityId,
  ModelPlugin,
  PluginParameterDefinition,
} from '../types'

export type CapabilityCategory =
  | '音频处理'
  | '音频理解'
  | '文本智能'
  | '音频生成'

export type WorkflowNodeKind = 'enhance' | 'vad' | 'asr' | 'llm' | 'tts'

export type WorkflowPortType =
  | 'audio'
  | 'speech-segments'
  | 'transcript'
  | 'text'
  | 'boolean'
  | 'keyword-events'
  | 'audio-tags'
  | 'language'
  | 'speaker-embedding'
  | 'speaker-segments'
  | 'audio-tracks'

export type ResultPresentation =
  | 'audio'
  | 'transcript'
  | 'timed-segments'
  | 'text'
  | 'tags'
  | 'events'
  | 'language'
  | 'embedding'
  | 'audio-tracks'
  | 'stream'

export interface CapabilityDefinition {
  id: HarnessCapabilityId
  label: string
  category: CapabilityCategory
  nodeKind: WorkflowNodeKind
  inputTypes: WorkflowPortType[]
  outputType: WorkflowPortType
  composer: 'audio' | 'text'
  result: ResultPresentation
  defaultParameters: Record<string, string | number | boolean>
}

const VOICE_ASSISTANT_PROMPT =
  '你是一个简洁自然的语音助手。直接回答问题，回复适合朗读，不使用 Markdown。'

export const CAPABILITY_DEFINITIONS: Record<
  HarnessCapabilityId,
  CapabilityDefinition
> = {
  'speech.synthesize': {
    id: 'speech.synthesize',
    label: '文字生成语音',
    category: '音频生成',
    nodeKind: 'tts',
    inputTypes: ['text', 'transcript'],
    outputType: 'audio',
    composer: 'text',
    result: 'audio',
    defaultParameters: { speed: 1 },
  },
  'speech.transcribe': {
    id: 'speech.transcribe',
    label: '语音识别',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio', 'speech-segments'],
    outputType: 'transcript',
    composer: 'audio',
    result: 'transcript',
    defaultParameters: {},
  },
  'speech.detect': {
    id: 'speech.detect',
    label: '语音活动检测',
    category: '音频处理',
    nodeKind: 'vad',
    inputTypes: ['audio'],
    outputType: 'speech-segments',
    composer: 'audio',
    result: 'timed-segments',
    defaultParameters: {
      threshold: 0.25,
      minSpeechDuration: 0.18,
      minSilenceDuration: 0.2,
    },
  },
  'text.generate': {
    id: 'text.generate',
    label: '文本生成',
    category: '文本智能',
    nodeKind: 'llm',
    inputTypes: ['transcript', 'text'],
    outputType: 'text',
    composer: 'text',
    result: 'text',
    defaultParameters: {
      temperature: 0.7,
      maxTokens: 320,
      systemPrompt: VOICE_ASSISTANT_PROMPT,
    },
  },
  'audio.enhance': {
    id: 'audio.enhance',
    label: '音频增强',
    category: '音频处理',
    nodeKind: 'enhance',
    inputTypes: ['audio'],
    outputType: 'audio',
    composer: 'audio',
    result: 'audio',
    defaultParameters: { denoiseStrength: 0.58 },
  },
  'audio.live': {
    id: 'audio.live',
    label: '实时音频',
    category: '音频处理',
    nodeKind: 'enhance',
    inputTypes: ['audio'],
    outputType: 'audio',
    composer: 'audio',
    result: 'stream',
    defaultParameters: {},
  },
  'audio.classify': {
    id: 'audio.classify',
    label: '音频标签',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio'],
    outputType: 'audio-tags',
    composer: 'audio',
    result: 'tags',
    defaultParameters: {},
  },
  'speech.keyword': {
    id: 'speech.keyword',
    label: '关键词检测',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio'],
    outputType: 'keyword-events',
    composer: 'audio',
    result: 'events',
    defaultParameters: { keywords: '你好小助手' },
  },
  'speech.language': {
    id: 'speech.language',
    label: '语言识别',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio'],
    outputType: 'language',
    composer: 'audio',
    result: 'language',
    defaultParameters: {},
  },
  'text.punctuate': {
    id: 'text.punctuate',
    label: '标点恢复',
    category: '文本智能',
    nodeKind: 'llm',
    inputTypes: ['text', 'transcript'],
    outputType: 'text',
    composer: 'text',
    result: 'text',
    defaultParameters: {},
  },
  'text.normalize': {
    id: 'text.normalize',
    label: '文本归一化',
    category: '文本智能',
    nodeKind: 'llm',
    inputTypes: ['text', 'transcript'],
    outputType: 'text',
    composer: 'text',
    result: 'text',
    defaultParameters: {
      operator: 'itn',
      language: 'auto',
      fullToHalf: true,
    },
  },
  'speaker.embed': {
    id: 'speaker.embed',
    label: '声纹提取',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio'],
    outputType: 'speaker-embedding',
    composer: 'audio',
    result: 'embedding',
    defaultParameters: {},
  },
  'speaker.diarize': {
    id: 'speaker.diarize',
    label: '说话人分离',
    category: '音频理解',
    nodeKind: 'asr',
    inputTypes: ['audio'],
    outputType: 'speaker-segments',
    composer: 'audio',
    result: 'timed-segments',
    defaultParameters: {},
  },
  'audio.separate': {
    id: 'audio.separate',
    label: '人声分离',
    category: '音频处理',
    nodeKind: 'enhance',
    inputTypes: ['audio'],
    outputType: 'audio-tracks',
    composer: 'audio',
    result: 'audio-tracks',
    defaultParameters: {},
  },
}

export function capabilityDefinition(
  capability: HarnessCapabilityId,
): CapabilityDefinition {
  return CAPABILITY_DEFINITIONS[capability]
}

export function capabilityAcceptsAudio(
  capability: HarnessCapabilityId,
): boolean {
  return capabilityDefinition(capability).composer === 'audio'
}

export function capabilityProducesAudio(
  capability: HarnessCapabilityId,
): boolean {
  const result = capabilityDefinition(capability).result
  return result === 'audio' || result === 'audio-tracks'
}

export function workflowParametersForModel(
  capability: HarnessCapabilityId,
  model: { adapter: string; providerId?: string },
): Record<string, string | number | boolean> {
  const parameters = {
    ...capabilityDefinition(capability).defaultParameters,
  }
  if (capability === 'speech.transcribe' && model.adapter === 'bailian-funasr') {
    return {
      ...parameters,
      language: 'auto',
      context: '',
      semanticPunctuation: true,
    }
  }
  if (capability === 'speech.synthesize') {
    if (model.adapter === 'bailian-cosyvoice') {
      return { ...parameters, voice: 'longxiaochun_v2' }
    }
    if (model.providerId === 'api.bailian') {
      return { ...parameters, voice: 'longanhuan_v3.6' }
    }
  }
  return parameters
}

const COMMON_PARAMETER_SCHEMAS: Partial<
  Record<HarnessCapabilityId, PluginParameterDefinition[]>
> = {
  'speech.detect': [
    {
      name: 'threshold',
      label: '检测阈值',
      type: 'number',
      default: 0.25,
      min: 0.05,
      max: 0.95,
      step: 0.05,
    },
    {
      name: 'minSpeechDuration',
      label: '最短语音',
      type: 'number',
      default: 0.18,
      min: 0.05,
      max: 2,
      step: 0.05,
    },
    {
      name: 'minSilenceDuration',
      label: '结束静音',
      type: 'number',
      default: 0.2,
      min: 0.05,
      max: 3,
      step: 0.05,
    },
  ],
  'audio.enhance': [
    {
      name: 'denoiseStrength',
      label: '降噪强度',
      type: 'number',
      default: 0.58,
      min: 0,
      max: 1,
      step: 0.05,
    },
  ],
  'text.generate': [
    {
      name: 'temperature',
      label: 'Temperature',
      type: 'number',
      default: 0.7,
      min: 0,
      max: 2,
      step: 0.1,
    },
    {
      name: 'maxTokens',
      label: '最大输出长度',
      type: 'number',
      default: 320,
      min: 32,
      max: 4096,
      step: 32,
    },
    {
      name: 'systemPrompt',
      label: 'System Prompt',
      type: 'string',
      default: VOICE_ASSISTANT_PROMPT,
      multiline: true,
    },
  ],
  'speech.synthesize': [
    {
      name: 'speed',
      label: '语速',
      type: 'number',
      default: 1,
      min: 0.5,
      max: 1.5,
      step: 0.05,
    },
  ],
}

const FUNASR_PARAMETERS: PluginParameterDefinition[] = [
  {
    name: 'language',
    label: '识别语言',
    type: 'enum',
    default: 'auto',
    options: [
      { label: '自动识别', value: 'auto' },
      { label: '中文', value: 'zh' },
      { label: '英文', value: 'en' },
      { label: '日语', value: 'ja' },
      { label: '韩语', value: 'ko' },
    ],
  },
  {
    name: 'context',
    label: '上下文',
    type: 'string',
    default: '',
    multiline: true,
  },
  {
    name: 'semanticPunctuation',
    label: '语义断句',
    type: 'boolean',
    default: true,
  },
]

export function parameterSchemaForModel(
  capability: HarnessCapabilityId,
  model: Pick<ModelPlugin, 'adapter' | 'parameterSchema'>,
): PluginParameterDefinition[] {
  if (model.parameterSchema?.length) return model.parameterSchema
  if (
    capability === 'speech.transcribe' &&
    model.adapter === 'bailian-funasr'
  ) {
    return FUNASR_PARAMETERS
  }
  return COMMON_PARAMETER_SCHEMAS[capability] ?? []
}

export function parameterDefaults(
  schema: readonly PluginParameterDefinition[],
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    schema
      .filter((parameter) => parameter.default !== undefined)
      .map((parameter) => [parameter.name, parameter.default!]),
  )
}
