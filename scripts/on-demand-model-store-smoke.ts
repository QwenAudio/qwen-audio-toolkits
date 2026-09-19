import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createOnDemandModelExecutionPlan,
  createInstallModelAction,
  detectOnDemandModelNeeds,
  enhancedAudioFileName,
  isInstallApproval,
  planOnDemandModelAction,
  resolveOnDemandModelExecution,
  resolveOnDemandModelExecutions,
  resolveOnDemandModelNeed,
  resolveOnDemandModelNeeds,
} from '../src/domain/onDemandModels'
import type { ModelPlugin } from '../src/types'

const modelStoreSource = readFileSync(
  new URL('../src/views/ExtensionModelStoreView.tsx', import.meta.url),
  'utf8',
)
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

type ExtensionModelStoreLifecycle = {
  installLocalModelAndRefresh<T>(actions: {
    installModel(): Promise<T>
    installDependencies(model: T): Promise<readonly string[]>
    refreshModels(): Promise<void>
  }): Promise<
    | { status: 'installed'; installed: T; optionalFailures: readonly string[] }
    | { status: 'dependency-failed'; installed: T; error: unknown }
  >
  refreshThenPersistCloudModelState(actions: {
    refreshModels(): Promise<void>
    persistCloudState(): void
  }): Promise<void>
}

const lifecycleModule = await import(
  '../src/services/' + 'extensionModelStoreLifecycle.ts'
).catch(() => null)
assert.ok(
  lifecycleModule,
  'Model-store lifecycle must expose testable install and cloud persistence ordering',
)
const lifecycle = lifecycleModule as unknown as ExtensionModelStoreLifecycle

const dependencyFailure = new Error('required VAD dependency failed')
const installCalls: string[] = []
const dependencyInstallResult = await lifecycle.installLocalModelAndRefresh({
  installModel: async () => {
    installCalls.push('install-main')
    return { id: 'main-model' }
  },
  installDependencies: async () => {
    installCalls.push('install-required-dependency')
    throw dependencyFailure
  },
  refreshModels: async () => {
    installCalls.push('refresh-catalog-and-state')
  },
})
assert.deepEqual(
  installCalls,
  ['install-main', 'install-required-dependency', 'refresh-catalog-and-state'],
  'A successful main install must refresh catalog/state even when a required dependency fails',
)
assert.equal(dependencyInstallResult.status, 'dependency-failed')
if (dependencyInstallResult.status === 'dependency-failed') {
  assert.equal(dependencyInstallResult.installed.id, 'main-model')
  assert.equal(dependencyInstallResult.error, dependencyFailure)
}

const successfulInstallCalls: string[] = []
const locallyInstalledModelIds = new Set<string>()
let refreshedInstalledModelIds: string[] = []
const successfulInstallResult = await lifecycle.installLocalModelAndRefresh({
  installModel: async () => {
    successfulInstallCalls.push('install-main')
    locallyInstalledModelIds.add('main-model')
    return { id: 'main-model' }
  },
  installDependencies: async () => {
    successfulInstallCalls.push('install-required-dependency')
    locallyInstalledModelIds.add('required-dependency')
    return ['optional-resampler']
  },
  refreshModels: async () => {
    successfulInstallCalls.push('refresh-catalog-and-state')
    refreshedInstalledModelIds = [...locallyInstalledModelIds]
  },
})
assert.deepEqual(successfulInstallCalls, [
  'install-main',
  'install-required-dependency',
  'refresh-catalog-and-state',
])
assert.equal(successfulInstallResult.status, 'installed')
if (successfulInstallResult.status === 'installed') {
  assert.equal(successfulInstallResult.installed.id, 'main-model')
  assert.deepEqual(successfulInstallResult.optionalFailures, ['optional-resampler'])
  assert.equal('error' in successfulInstallResult, false)
}
assert.deepEqual(refreshedInstalledModelIds, [
  'main-model',
  'required-dependency',
])

const failedRefresh = new Error('catalog unavailable')
const failedRefreshCalls: string[] = []
const cloudStorageWrites: Array<[string, string]> = []
await assert.rejects(
  lifecycle.refreshThenPersistCloudModelState({
    refreshModels: async () => {
      failedRefreshCalls.push('refresh-catalog-and-state')
      throw failedRefresh
    },
    persistCloudState: () => {
      failedRefreshCalls.push('persist-cloud-state')
      cloudStorageWrites.push(['installed-cloud-models', '["cloud-model"]'])
    },
  }),
  (error) => error === failedRefresh,
)
assert.deepEqual(failedRefreshCalls, ['refresh-catalog-and-state'])
assert.deepEqual(
  cloudStorageWrites,
  [],
  'Cloud installation state must not be persisted when refresh fails',
)

const successfulCloudCalls: string[] = []
await lifecycle.refreshThenPersistCloudModelState({
  refreshModels: async () => {
    successfulCloudCalls.push('refresh-catalog-and-state')
  },
  persistCloudState: () => {
    successfulCloudCalls.push('persist-cloud-state')
  },
})
assert.deepEqual(successfulCloudCalls, [
  'refresh-catalog-and-state',
  'persist-cloud-state',
])

assert.doesNotMatch(modelStoreSource, /services\/harness/u)
for (const lifecycleApi of [
  'getHarnessCatalog',
  'listModelPlugins',
  'installCatalogModel',
  'installRecommendedModelDependency',
  'setModelPluginSidebarVisible',
  'setModelDependencyBinding',
  'uninstallModelPlugin',
]) {
  assert.doesNotMatch(
    modelStoreSource,
    new RegExp(`\\b${lifecycleApi}\\s*\\(`, 'u'),
  )
}
for (const callback of [
  'onRefreshModels',
  'onInstallModel',
  'onInstallModelDependency',
  'onRestoreModel',
  'onUninstallModel',
]) {
  assert.match(modelStoreSource, new RegExp(`${callback}\\s*\\(`, 'u'))
  assert.match(
    modelStoreSource,
    callback === 'onInstallModel'
      ? /await installLocalModelAndRefresh\(/u
      : new RegExp(`await ${callback}\\s*\\(`, 'u'),
  )
  assert.match(
    appSource,
    new RegExp(
      `<ExtensionModelStoreView[\\s\\S]{0,1500}${callback}=\\{`,
      'u',
    ),
  )
}
assert.match(modelStoreSource, /await refreshThenPersistCloudModelState\(/u)
assert.match(
  modelStoreSource,
  /export interface ModelStoreRemoval \{[\s\S]{0,120}retained: boolean[\s\S]{0,120}referencedBy: string\[\]/u,
)
assert.match(
  modelStoreSource,
  /onUninstallModel\(pluginId: string\): Promise<ModelStoreRemoval>/u,
)

function model(
  id: string,
  capability: ModelPlugin['harnessCapabilities'][number],
  installed: boolean,
  extra: Partial<ModelPlugin> = {},
): ModelPlugin {
  return {
    id,
    name: id,
    author: 'Smoke',
    description: '',
    capabilities: [],
    harnessCapabilities: [capability],
    runtime: 'local',
    acceleration: ['CPU'],
    version: '1',
    size: '1 MB',
    installed,
    enabled: true,
    builtin: false,
    tone: 'green',
    providerId: `plugin.${id}`,
    adapter: id,
    installPath: installed ? `/models/${id}` : `catalog://${id}`,
    catalogManaged: true,
    ...extra,
  }
}

const denoiseMissing = resolveOnDemandModelNeed('给这段音频做个降噪', [
  model('xiph.rnnoise', 'audio.enhance', false),
  model('rikorose.deepfilternet3', 'audio.enhance', false),
])

assert.equal(denoiseMissing?.need.id, 'audio-denoise')
assert.equal(denoiseMissing?.installedModel, null)
assert.equal(denoiseMissing?.recommendedModel?.id, 'rikorose.deepfilternet3')
assert.equal(
  planOnDemandModelAction('给这段音频做个降噪', [
    model('rikorose.deepfilternet3', 'audio.enhance', false),
  ], 'ask').kind,
  'ask-install',
)
const askAction = planOnDemandModelAction('给这段音频做个降噪', [
  model('rikorose.deepfilternet3', 'audio.enhance', false),
], 'ask')
assert.equal(askAction.kind, 'ask-install')
if (askAction.kind === 'ask-install') {
  const action = createInstallModelAction(askAction.resolution, askAction.model, {
    prompt: '给这段音频做个降噪',
    selectedModeName: null,
    attachmentHint: '\n\n已选择素材：demo.wav',
    attachment: { path: '/tmp/demo.wav', name: 'demo.wav' },
  })
  assert.equal(action.kind, 'install-on-demand-model')
  assert.equal(action.status, 'pending')
  assert.equal(action.modelId, 'rikorose.deepfilternet3')
  assert.equal(action.capability, 'audio.enhance')
  assert.equal(action.prompt, '给这段音频做个降噪')
  assert.equal(action.attachment?.name, 'demo.wav')
  const executionPlan = createOnDemandModelExecutionPlan(
    askAction.resolution,
    askAction.model,
    { path: '/tmp/longanhuan.wav', name: 'longanhuan.wav' },
  )
  assert.equal(executionPlan?.capability, 'audio.enhance')
  assert.deepEqual(executionPlan?.parameters.operations, ['denoise'])
  assert.equal(executionPlan?.parameters.denoiseStrength, 0.3)
  assert.equal(executionPlan?.outputFileName, 'longanhuan_enhanced.wav')
  assert.equal(executionPlan?.parameters.outputFileName, 'longanhuan_enhanced.wav')
  assert.equal(
    createOnDemandModelExecutionPlan(
      askAction.resolution,
      askAction.model,
      { path: '/tmp/longanhuan.mp3', name: 'longanhuan.mp3' },
    ),
    null,
  )
  assert.equal(
    createOnDemandModelExecutionPlan(
      askAction.resolution,
      model('xiph.rnnoise', 'audio.enhance', true),
      { path: '/tmp/longanhuan.wav', name: 'longanhuan.wav' },
    ),
    null,
  )
}
assert.equal(enhancedAudioFileName('longanhuan.wav'), 'longanhuan_enhanced.wav')
assert.equal(enhancedAudioFileName('/tmp/noisy take.wav'), 'noisy_take_enhanced.wav')
assert.equal(
  planOnDemandModelAction('给这段音频做个降噪', [
    model('rikorose.deepfilternet3', 'audio.enhance', false),
  ], 'auto').kind,
  'auto-install',
)

const denoiseInstalled = resolveOnDemandModelNeed('请把底噪去掉', [
  model('rikorose.deepfilternet3', 'audio.enhance', false),
  model('xiph.rnnoise', 'audio.enhance', true),
])

assert.equal(denoiseInstalled?.installedModel, null)
assert.equal(denoiseInstalled?.recommendedModel?.id, 'rikorose.deepfilternet3')
assert.equal(
  planOnDemandModelAction('请把底噪去掉', [
    model('rikorose.deepfilternet3', 'audio.enhance', false),
    model('xiph.rnnoise', 'audio.enhance', true),
  ], 'ask').kind,
  'ask-install',
)

const deepFilterInstalled = resolveOnDemandModelNeed('请把底噪去掉', [
  model('rikorose.deepfilternet3', 'audio.enhance', true),
  model('xiph.rnnoise', 'audio.enhance', true),
])

assert.equal(deepFilterInstalled?.installedModel?.id, 'rikorose.deepfilternet3')
assert.equal(deepFilterInstalled?.recommendedModel?.id, 'rikorose.deepfilternet3')
assert.equal(
  planOnDemandModelAction('请把底噪去掉', [
    model('rikorose.deepfilternet3', 'audio.enhance', true),
    model('xiph.rnnoise', 'audio.enhance', true),
  ], 'auto').kind,
  'use-installed',
)

const confirmDenoise = resolveOnDemandModelNeed(
  '可以对 longanhuan_enhanced.wav 再用 DeepFilterNet3 的 audio.enhance 做一次降噪。请确认，确认后即可执行。',
  [
    model('rikorose.deepfilternet3', 'audio.enhance', true, {
      adapter: 'deepfilternet',
    }),
  ],
)

assert.equal(confirmDenoise?.need.id, 'audio-denoise')
assert.equal(confirmDenoise?.installedModel?.id, 'rikorose.deepfilternet3')
const confirmDenoiseExecution = resolveOnDemandModelExecution(
  '可以对 longanhuan_enhanced.wav 再用 DeepFilterNet3 的 audio.enhance 做一次降噪。请确认，确认后即可执行。',
  [
    model('rikorose.deepfilternet3', 'audio.enhance', true, {
      adapter: 'deepfilternet',
    }),
  ],
  { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
)

assert.equal(confirmDenoiseExecution?.model.id, 'rikorose.deepfilternet3')
assert.equal(confirmDenoiseExecution?.plan.capability, 'audio.enhance')

const transcribe = resolveOnDemandModelNeed('帮我转写这段录音', [
  model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', false),
])

assert.equal(transcribe?.need.id, 'speech-transcribe')
assert.equal(transcribe?.recommendedModel?.id, 'funaudiollm.sensevoice-small-gguf')
if (transcribe) {
  const transcribePlan = createOnDemandModelExecutionPlan(
    transcribe,
    model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', true, {
      adapter: 'funasr-sensevoice-gguf',
    }),
    { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
  )
  assert.equal(transcribePlan?.capability, 'speech.transcribe')
  assert.equal(transcribePlan?.parameters.language, 'auto')
}
const transcribeExecution = resolveOnDemandModelExecution(
  '确认后用 SenseVoice 执行语音转写。',
  [
    model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', true, {
      adapter: 'funasr-sensevoice-gguf',
    }),
  ],
  { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
)
assert.equal(transcribeExecution?.model.id, 'funaudiollm.sensevoice-small-gguf')
assert.equal(transcribeExecution?.plan.capability, 'speech.transcribe')
const transcribeCandidates = resolveOnDemandModelExecution(
  '确认后执行语音转写。',
  [
    model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', false, {
      adapter: 'funasr-sensevoice-gguf',
    }),
    model('k2-fsa.funasr-nano', 'speech.transcribe', true),
    model('funaudiollm.paraformer-gguf', 'speech.transcribe', false, {
      installable: false,
    }),
  ],
  { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
)
assert.equal(transcribeCandidates?.model.id, 'k2-fsa.funasr-nano')
const transcribeCandidateList = resolveOnDemandModelExecutions(
  '确认后执行语音转写。',
  [
    model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', false, {
      adapter: 'funasr-sensevoice-gguf',
    }),
    model('k2-fsa.funasr-nano', 'speech.transcribe', true),
    model('funaudiollm.paraformer-gguf', 'speech.transcribe', false, {
      installable: false,
    }),
  ],
  { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
)
assert.deepEqual(
  transcribeCandidateList.map(({ model }) => model.id),
  ['funaudiollm.sensevoice-small-gguf', 'k2-fsa.funasr-nano'],
)
assert.deepEqual(
  detectOnDemandModelNeeds('先给这段录音做降噪，然后识别一下内容').map((need) => need.id),
  ['audio-denoise', 'speech-transcribe'],
)
const multiStepResolutions = resolveOnDemandModelNeeds(
  '先给这段录音做降噪，然后识别一下内容',
  [
    model('rikorose.deepfilternet3', 'audio.enhance', true, {
      adapter: 'deepfilternet',
    }),
    model('funaudiollm.sensevoice-small-gguf', 'speech.transcribe', true, {
      adapter: 'funasr-sensevoice-gguf',
    }),
  ],
)
assert.deepEqual(
  multiStepResolutions.map(({ need, installedModel }) => [need.id, installedModel?.id]),
  [
    ['audio-denoise', 'rikorose.deepfilternet3'],
    ['speech-transcribe', 'funaudiollm.sensevoice-small-gguf'],
  ],
)
assert.equal(
  createOnDemandModelExecutionPlan(
    multiStepResolutions[0],
    multiStepResolutions[0].installedModel!,
    { path: '/tmp/longanhuan.wav', name: 'longanhuan.wav' },
  )?.capability,
  'audio.enhance',
)
assert.equal(
  createOnDemandModelExecutionPlan(
    multiStepResolutions[1],
    multiStepResolutions[1].installedModel!,
    { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' },
  )?.capability,
  'speech.transcribe',
)
assert.equal(
  resolveOnDemandModelExecution(
    '确认后做一次人声分离。',
    [
      model('modelscope.mossformer2-separation-8k', 'audio.separate', true),
    ],
    { path: '/tmp/longanhuan.wav', name: 'longanhuan.wav' },
  )?.plan.capability,
  'audio.separate',
)

assert.equal(resolveOnDemandModelNeed('你好，先聊一下', []), null)
assert.equal(planOnDemandModelAction('请降噪', [], 'ask').kind, 'unavailable')
assert.equal(isInstallApproval('帮我安装'), true)
assert.equal(isInstallApproval('先不用'), false)

console.log(JSON.stringify({ status: 'passed', checks: 45 }, null, 2))
