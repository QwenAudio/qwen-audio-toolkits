import assert from 'node:assert/strict'
import { planWorkflow } from '../src/services/workflowPlanner.ts'
import {
  parameterSchemaForModel,
  workflowParametersForModel,
} from '../src/domain/capabilities.ts'
import { modelInputProfile } from '../src/domain/modelInputs.ts'

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

console.log(
  JSON.stringify({
    validTopologies: validCases.length,
    rejectedTopologies: invalidCases.length,
  }),
)
