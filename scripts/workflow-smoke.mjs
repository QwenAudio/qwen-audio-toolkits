import assert from 'node:assert/strict'
import { planWorkflow } from '../src/services/workflowPlanner.ts'
import {
  parameterSchemaForModel,
  workflowParametersForModel,
} from '../src/domain/capabilities.ts'
import { modelInputProfile } from '../src/domain/modelInputs.ts'
import { cloudModelsFromCatalog } from '../src/cloudModels.ts'

const input = {
  id: 'input',
  data: {
    kind: 'input',
    label: '音频输入',
    outputType: 'audio',
  },
}
const output = (id, inputTypes = ['text']) => ({
  id,
  data: {
    kind: 'output',
    label: id,
    inputTypes,
  },
})
const model = (
  id,
  capability,
  inputTypes,
  outputType,
  streamingMode = 'batch',
  adapter,
) => ({
  id,
  data: {
    kind: id,
    label: id,
    capability,
    providerId: `provider.${id}`,
    adapter,
    streamingMode,
    inputTypes,
    outputType,
  },
})
const edge = (source, target, id = `${source}-${target}`) => ({
  id,
  source,
  target,
})
const workflow = (models, outputs, extraEdges = []) => {
  const nodes = [input, ...models, ...outputs]
  const chainEdges = models.map((node, index) =>
    edge(index ? models[index - 1].id : input.id, node.id),
  )
  return { nodes, edges: [...chainEdges, ...extraEdges] }
}

const streamingAsr = model(
  'asr',
  'speech.transcribe',
  ['audio'],
  'text',
  'streaming',
  'streaming-zipformer',
)
const vad = model(
  'vad',
  'speech.detect',
  ['audio'],
  'audio',
  'streaming',
  'silero-vad',
)
const enhancer = model(
  'enhance',
  'audio.enhance',
  ['audio'],
  'audio',
  'streaming',
  'deepfilternet',
)
const punctuation = model(
  'punctuation',
  'text.punctuate',
  ['text'],
  'text',
)
const itn = model('itn', 'text.normalize', ['text'], 'text')
const llm = model('llm', 'text.generate', ['text'], 'text')
const tts = model(
  'tts',
  'speech.synthesize',
  ['text'],
  'audio',
  'streaming',
  'bailian-cosyvoice',
)

const validCases = [
  workflow([streamingAsr], [output('text-output')], [
    edge('asr', 'text-output'),
  ]),
  workflow([vad, streamingAsr], [output('text-output')], [
    edge('asr', 'text-output'),
  ]),
  workflow([enhancer, vad, streamingAsr], [output('text-output')], [
    edge('asr', 'text-output'),
  ]),
  workflow(
    [enhancer, vad, streamingAsr, punctuation, itn],
    [output('captions')],
    [edge('itn', 'captions')],
  ),
  workflow(
    [vad, streamingAsr, punctuation, llm, tts],
    [output('captions'), output('audio-output', ['audio'])],
    [edge('punctuation', 'captions'), edge('tts', 'audio-output')],
  ),
]

for (const candidate of validCases) {
  assert.doesNotThrow(() => planWorkflow(candidate))
}

const invalidCases = [
  workflow(
    [
      model('batch-enhance', 'audio.enhance', ['audio'], 'audio'),
      streamingAsr,
    ],
    [output('text-output')],
    [edge('asr', 'text-output')],
  ),
  workflow(
    [
      streamingAsr,
      model('post-enhance', 'audio.enhance', ['text'], 'audio', 'streaming'),
    ],
    [output('audio-output', ['audio'])],
    [edge('post-enhance', 'audio-output')],
  ),
  workflow([streamingAsr, tts, enhancer], [output('audio-output', ['audio'])], [
    edge('enhance', 'audio-output'),
  ]),
  {
    nodes: [input, { ...streamingAsr }, { ...streamingAsr }, output('out')],
    edges: [edge('input', 'asr'), edge('asr', 'out')],
  },
  {
    nodes: [input, streamingAsr, punctuation, output('out')],
    edges: [
      edge('input', 'asr'),
      edge('input', 'punctuation'),
      edge('asr', 'punctuation', 'merge'),
      edge('punctuation', 'out'),
    ],
  },
]

for (const candidate of invalidCases) {
  assert.throws(() => planWorkflow(candidate))
}

for (const [capability, adapter] of [
  ['speech.detect', 'funasr-fsmn-vad-gguf'],
  ['audio.enhance', 'bailian-audio-process'],
]) {
  assert.deepEqual(
    parameterSchemaForModel(capability, { adapter }),
    [],
    `${adapter} must not expose parameters that its runtime ignores`,
  )
  assert.deepEqual(
    workflowParametersForModel(capability, { adapter }),
    {},
    `${adapter} must not persist parameters that its runtime ignores`,
  )
}

const inputProfile = (model) =>
  modelInputProfile({
    id: 'test-model',
    adapter: 'test-adapter',
    providerId: 'plugin.test',
    version: 'test-version',
    inputs: [],
    ...model,
  })
const expectProfile = (overrides) => ({
  apiModel: false,
  requiresCustomCosyVoice: false,
  supportsCloudVoiceCreation: false,
  supportsVoiceDesign: false,
  supportsTtsInstruction: false,
  requiresTtsReferenceAudio: false,
  ttsReferenceAudioLabel: '参考音频',
  requiresTtsReferenceText: false,
  supportsTtsLanguage: false,
  speakerCount: 0,
  supportsSpeakerSelection: false,
  ...overrides,
})

assert.deepEqual(
  inputProfile({ adapter: 'pocket-tts' }),
  expectProfile({ requiresTtsReferenceAudio: true }),
)
assert.deepEqual(
  inputProfile({ adapter: 'zipvoice' }),
  expectProfile({
    requiresTtsReferenceAudio: true,
    requiresTtsReferenceText: true,
  }),
)
assert.deepEqual(
  inputProfile({
    providerId: 'api.bailian',
    version: 'qwen-audio-3.0-tts-flash',
  }),
  expectProfile({
    apiModel: true,
    supportsCloudVoiceCreation: true,
    supportsTtsInstruction: true,
  }),
)
assert.deepEqual(
  inputProfile({
    providerId: 'api.bailian',
    version: 'cosyvoice-v3-plus',
  }),
  expectProfile({
    apiModel: true,
    supportsCloudVoiceCreation: true,
  }),
)
assert.deepEqual(
  inputProfile({ adapter: 'supertonic' }),
  expectProfile({ supportsTtsLanguage: true }),
)
assert.deepEqual(
  inputProfile({ id: 'k2-fsa.vits-aishell3' }),
  expectProfile({ speakerCount: 174, supportsSpeakerSelection: true }),
)

assert.deepEqual(
  workflowParametersForModel('speech.transcribe', {
    adapter: 'bailian-funasr',
    version: 'qwen-audio-3.0-asr-flash-streaming',
  }),
  { language: 'auto', context: '', semanticPunctuation: true },
)

const cloudCatalog = {
  capabilities: [],
  providers: [
    {
      id: 'api.bailian',
      name: '阿里云百炼',
      kind: 'api',
      runtime: 'dashscope.aliyuncs.com',
      status: 'ready',
      configured: true,
      local: false,
      capabilities: ['speech.transcribe'],
      models: [],
    },
    {
      id: 'api.openai-compatible',
      name: 'Local Ollama',
      kind: 'api',
      runtime: 'localhost:11434',
      status: 'ready',
      configured: true,
      local: false,
      capabilities: ['text.generate'],
      models: [
        {
          id: 'qwen3:8b',
          name: 'qwen3:8b',
          installed: true,
          loaded: false,
        },
      ],
    },
  ],
}
const streamingCloudModel = cloudModelsFromCatalog(cloudCatalog, [
  'bailian-funasr-realtime',
]).find((entry) => entry.id === 'bailian-funasr-realtime')
assert.equal(
  streamingCloudModel?.name,
  'Qwen-Audio-3.0-ASR-Flash-Streaming',
)
assert.deepEqual(streamingCloudModel?.apiAliases, ['fun-asr-realtime'])
assert.equal(streamingCloudModel?.installed, true)

const customLlm = cloudModelsFromCatalog(
  cloudCatalog,
  ['custom-qwen3-8b'],
  [],
  [
    {
      id: 'custom-qwen3-8b',
      name: 'Qwen 3 Local',
      modelId: 'qwen3:8b',
      providerId: 'api.openai-compatible',
      capability: 'text.generate',
    },
  ],
).find((entry) => entry.id === 'custom-qwen3-8b')
assert.equal(customLlm?.name, 'Qwen 3 Local')
assert.equal(customLlm?.author, 'Local Ollama')
assert.equal(customLlm?.version, 'qwen3:8b')
assert.equal(customLlm?.providerId, 'api.openai-compatible')
assert.equal(customLlm?.adapter, 'compatible-llm')
assert.equal(customLlm?.installed, true)

const unconfiguredCustomCatalog = structuredClone(cloudCatalog)
unconfiguredCustomCatalog.providers[1].status = 'unconfigured'
unconfiguredCustomCatalog.providers[1].configured = false
const unavailableCustomLlm = cloudModelsFromCatalog(
  unconfiguredCustomCatalog,
  [],
  [],
  [
    {
      id: 'custom-qwen3-8b',
      name: 'Qwen 3 Local',
      modelId: 'qwen3:8b',
      providerId: 'api.openai-compatible',
      capability: 'text.generate',
    },
  ],
).find((entry) => entry.id === 'custom-qwen3-8b')
assert.equal(unavailableCustomLlm?.enabled, false)

const customAsr = cloudModelsFromCatalog(
  cloudCatalog,
  ['custom-asr'],
  [],
  [
    {
      id: 'custom-asr',
      name: 'OpenAI Transcribe',
      modelId: 'gpt-4o-mini-transcribe',
      providerId: 'api.openai-compatible',
      capability: 'speech.transcribe',
    },
  ],
).find((entry) => entry.id === 'custom-asr')
assert.deepEqual(customAsr?.harnessCapabilities, ['speech.transcribe'])
assert.equal(customAsr?.adapter, 'compatible-asr')

const customTts = cloudModelsFromCatalog(
  cloudCatalog,
  ['custom-tts'],
  [],
  [
    {
      id: 'custom-tts',
      name: 'OpenAI Speech',
      modelId: 'gpt-4o-mini-tts',
      providerId: 'api.openai-compatible',
      capability: 'speech.synthesize',
      defaultVoice: 'alloy',
    },
  ],
).find((entry) => entry.id === 'custom-tts')
assert.deepEqual(customTts?.harnessCapabilities, ['speech.synthesize'])
assert.equal(customTts?.adapter, 'compatible-tts')
assert.equal(customTts?.defaultVoice, 'alloy')

const multiProviderTts = cloudModelsFromCatalog(
  {
    ...cloudCatalog,
    providers: [
      ...cloudCatalog.providers,
      {
        id: 'api.custom.voice-service',
        name: 'Voice Service',
        kind: 'api',
        runtime: 'https://voice.example.com/v1',
        status: 'ready',
        configured: true,
        local: false,
        capabilities: ['speech.synthesize'],
        models: [],
      },
    ],
  },
  ['custom-provider-tts'],
  [],
  [
    {
      id: 'custom-provider-tts',
      name: 'Custom Voice',
      modelId: 'voice-model-v1',
      providerId: 'api.custom.voice-service',
      capability: 'speech.synthesize',
      defaultVoice: 'voice-1',
    },
  ],
).find((entry) => entry.id === 'custom-provider-tts')
assert.equal(multiProviderTts?.providerId, 'api.custom.voice-service')
assert.equal(multiProviderTts?.author, 'Voice Service')
assert.equal(multiProviderTts?.adapter, 'compatible-tts')

const hiddenStreamingModel = {
  id: 'bailian-funasr-realtime',
  name: 'Hidden Streaming ASR',
  author: '阿里云百炼',
  description: '',
  capabilities: ['ASR'],
  harnessCapability: 'speech.transcribe',
  providerId: 'api.bailian',
  adapter: 'bailian-funasr',
  modelId: 'qwen-audio-3.0-asr-flash-streaming',
  aliases: ['fun-asr-realtime'],
  streamingMode: 'streaming',
  featured: false,
  visible: false,
}
assert.equal(
  cloudModelsFromCatalog(cloudCatalog, [], [hiddenStreamingModel]).some(
    (entry) => entry.id === hiddenStreamingModel.id,
  ),
  false,
)

console.log(
  JSON.stringify({
    validTopologies: validCases.length,
    rejectedTopologies: invalidCases.length,
    remoteApiCatalog: true,
  }),
)
