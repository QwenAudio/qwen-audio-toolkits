import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  ApiModelCatalogEntry,
  ApiProviderSettings,
  ApiProviderUpdate,
  BailianProviderSettings,
  BailianProviderUpdate,
  BailianVoice,
  BailianVoiceCreateRequest,
  CosyVoiceStreamEvent,
  CosyVoiceStreamStartRequest,
  CosyVoiceStreamStartResponse,
  FunAsrStreamEvent,
  FunAsrStreamStartRequest,
  FunAsrStreamStartResponse,
  HarnessCatalog,
  HarnessExecution,
  HarnessRun,
  HarnessTaskRequest,
  ModelDependencyBindings,
  ModelPlugin,
  PluginRemovalResult,
  VadStreamStartResponse,
  VadStreamUpdate,
  EnhancementStreamStartResponse,
  EnhancementStreamChunk,
} from '../types'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000
const LONG_AUDIO_COMPLETION_GRACE_MS = 5 * 60 * 1000

function runTimeoutMs(request: HarnessTaskRequest): number {
  const duration = Number(request.input.duration)
  if (
    request.capability !== 'speech.transcribe' ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return DEFAULT_RUN_TIMEOUT_MS
  }
  return Math.max(
    DEFAULT_RUN_TIMEOUT_MS,
    duration * 1_250 + LONG_AUDIO_COMPLETION_GRACE_MS,
  )
}

class HarnessRunError extends Error {
  run: HarnessRun

  constructor(run: HarnessRun) {
    super(run.error || (run.status === 'canceled' ? '任务已取消' : '任务执行失败'))
    this.name = 'HarnessRunError'
    this.run = run
  }
}

export function isTauriRuntime(): boolean {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  )
}

export function isTerminalRun(run: HarnessRun): boolean {
  return TERMINAL_STATUSES.has(run.status)
}

interface DroppedAudioFile {
  name: string
  mimeType: string
  dataBase64: string
}

export async function setCloseBehavior(quitOnClose: boolean): Promise<void> {
  await invoke<void>('set_close_behavior', { quitOnClose })
}

export async function appDataDirectory(): Promise<string> {
  return invoke<string>('app_data_directory')
}

export async function revealInFileManager(path: string): Promise<void> {
  await invoke<void>('reveal_in_file_manager', { path })
}

export async function cleanupDownloadCache(): Promise<number> {
  return invoke<number>('cleanup_download_cache')
}

export async function readDroppedAudioFile(path: string): Promise<File> {
  const payload = await invoke<DroppedAudioFile>('read_dropped_audio_file', {
    path,
  })
  const response = await fetch(
    `data:${payload.mimeType};base64,${payload.dataBase64}`,
  )
  const blob = await response.blob()
  return new File([blob], payload.name, { type: payload.mimeType })
}

export async function executeHarnessTask<T>(
  request: HarnessTaskRequest,
  onUpdate?: (run: HarnessRun) => void,
): Promise<HarnessExecution<T>> {
  if (!isTauriRuntime()) {
    throw new Error('真实模型任务需要在 QwenAudio Toolkits 桌面端运行')
  }

  const runId = request.runId ?? `run-${crypto.randomUUID()}`
  let latestTerminal: HarnessRun | null = null
  let settleTerminal!: (run: HarnessRun) => void
  let unlisten: UnlistenFn | undefined
  const terminal = new Promise<HarnessRun>((resolve) => {
    settleTerminal = resolve
  })
  const timeout = window.setTimeout(() => {
    settleTerminal({
      id: runId,
      conversationVisible: request.conversationVisible ?? true,
      dependencyRunIds: request.dependencyRunIds ?? [],
      capability: request.capability,
      title: request.title ?? '音频任务',
      inputSummary: '',
      providerId: request.providerId ?? 'auto',
      providerName: '',
      modelId: '',
      status: 'failed',
      progress: 100,
      createdAt: Date.now(),
      artifacts: [],
      error: '任务等待超时，请在运行记录中检查最终状态',
      retryable: true,
    })
  }, runTimeoutMs(request))

  try {
    unlisten = await listen<HarnessRun>('harness-run-event', (event) => {
      const run = event.payload
      if (run.id !== runId) return
      onUpdate?.(run)
      if (isTerminalRun(run)) {
        latestTerminal = run
        settleTerminal(run)
      }
    })

    const submitted = await invoke<HarnessRun>('harness_start_run', {
      request: { ...request, runId },
    })
    onUpdate?.(submitted)
    if (isTerminalRun(submitted)) {
      latestTerminal = submitted
      settleTerminal(submitted)
    }

    const completed = latestTerminal ?? (await terminal)
    if (completed.status !== 'completed') {
      throw new HarnessRunError(completed)
    }
    return await invoke<HarnessExecution<T>>('harness_get_run_output', {
      runId,
    })
  } finally {
    window.clearTimeout(timeout)
    unlisten?.()
  }
}

export function listHarnessRuns(): Promise<HarnessRun[]> {
  return invoke<HarnessRun[]>('harness_list_runs')
}

export function getHarnessRunOutput<T>(
  runId: string,
): Promise<HarnessExecution<T>> {
  return invoke<HarnessExecution<T>>('harness_get_run_output', { runId })
}

export function getHarnessRunPreview<T>(
  runId: string,
): Promise<HarnessExecution<T>> {
  return invoke<HarnessExecution<T>>('harness_get_run_preview', { runId })
}

export function listBailianVoices(targetModel: string): Promise<BailianVoice[]> {
  return invoke<BailianVoice[]>('harness_list_bailian_voices', { targetModel })
}

export function createBailianVoice(
  request: BailianVoiceCreateRequest,
): Promise<BailianVoice> {
  return invoke<BailianVoice>('harness_create_bailian_voice', { request })
}

export function deleteBailianVoice(voiceId: string): Promise<void> {
  return invoke<void>('harness_delete_bailian_voice', { voiceId })
}

interface SystemAudioChunk {
  sessionId: string
  pcmBase64: string
  sampleRate: number
}

interface SystemAudioSession {
  sessionId: string
  sampleRate: number
}

export function startSystemAudio(
  muteOriginal = false,
): Promise<SystemAudioSession> {
  return invoke<SystemAudioSession>('system_audio_start', { muteOriginal })
}

export function stopSystemAudio(sessionId: string): Promise<void> {
  return invoke('system_audio_stop', { sessionId })
}

export function playSystemAudioChunk(
  sessionId: string,
  pcmBase64: string,
): Promise<void> {
  return invoke('system_audio_play_chunk', { sessionId, pcmBase64 })
}

export async function subscribeSystemAudio(
  listener: (chunk: SystemAudioChunk) => void,
): Promise<UnlistenFn> {
  return listen<SystemAudioChunk>('system-audio-chunk', (event) => {
    listener(event.payload)
  })
}

export function cancelHarnessRun(runId: string): Promise<HarnessRun> {
  return invoke<HarnessRun>('harness_cancel_run', { runId })
}

export function deleteHarnessRun(runId: string): Promise<void> {
  return invoke<void>('harness_delete_run', { runId })
}

export function getHarnessCatalog(): Promise<HarnessCatalog> {
  return invoke<HarnessCatalog>('harness_catalog')
}

export function getApiProviderSettings(): Promise<ApiProviderSettings[]> {
  return invoke<ApiProviderSettings[]>('harness_api_provider_settings')
}

export function deleteApiProviderSettings(
  providerId: string,
): Promise<ApiProviderSettings[]> {
  return invoke<ApiProviderSettings[]>('harness_delete_api_provider', {
    providerId,
  })
}

export function saveApiProviderSettings(
  update: ApiProviderUpdate,
): Promise<ApiProviderSettings> {
  return invoke<ApiProviderSettings>('harness_save_api_provider', { update })
}

export function getBailianProviderSettings(): Promise<BailianProviderSettings> {
  return invoke<BailianProviderSettings>('harness_bailian_provider_settings')
}

export function saveBailianProviderSettings(
  update: BailianProviderUpdate,
): Promise<BailianProviderSettings> {
  return invoke<BailianProviderSettings>('harness_save_bailian_provider', {
    update,
  })
}

export function startFunAsrStream(
  request: FunAsrStreamStartRequest,
): Promise<FunAsrStreamStartResponse> {
  return invoke<FunAsrStreamStartResponse>('harness_start_funasr_stream', {
    request,
  })
}

export function pushFunAsrStream(
  sessionId: string,
  pcmBase64: string,
): Promise<void> {
  return invoke<void>('harness_push_funasr_stream', {
    sessionId,
    pcmBase64,
  })
}

export function finishFunAsrStream(sessionId: string): Promise<void> {
  return invoke<void>('harness_finish_funasr_stream', { sessionId })
}

export function subscribeFunAsrStream(
  callback: (event: FunAsrStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<FunAsrStreamEvent>('funasr-stream-event', (event) =>
    callback(event.payload),
  )
}

export function startVadStream(
  request: {
    providerId?: string
    modelId?: string
    adapter?: string
    threshold?: number
    minSpeechDuration?: number
    minSilenceDuration?: number
  } = {},
): Promise<VadStreamStartResponse> {
  return invoke<VadStreamStartResponse>('harness_start_vad_stream', { request })
}

export function pushVadStream(
  sessionId: string,
  pcmBase64: string,
): Promise<VadStreamUpdate> {
  return invoke<VadStreamUpdate>('harness_push_vad_stream', {
    sessionId,
    pcmBase64,
  })
}

export function finishVadStream(sessionId: string): Promise<void> {
  return invoke<void>('harness_finish_vad_stream', { sessionId })
}

export function startEnhancementStream(
  providerId: string,
  sampleRate = 48_000,
  strength = 1,
): Promise<EnhancementStreamStartResponse> {
  return invoke<EnhancementStreamStartResponse>(
    'harness_start_enhancement_stream',
    { request: { providerId, sampleRate, strength } },
  )
}

export function pushEnhancementStream(
  sessionId: string,
  pcmBase64: string,
): Promise<EnhancementStreamChunk> {
  return invoke<EnhancementStreamChunk>('harness_push_enhancement_stream', {
    sessionId,
    pcmBase64,
  })
}

export function finishEnhancementStream(
  sessionId: string,
): Promise<EnhancementStreamChunk> {
  return invoke<EnhancementStreamChunk>('harness_finish_enhancement_stream', {
    sessionId,
  })
}

export function startCosyVoiceStream(
  request: CosyVoiceStreamStartRequest,
): Promise<CosyVoiceStreamStartResponse> {
  return invoke<CosyVoiceStreamStartResponse>(
    'harness_start_cosyvoice_stream',
    { request },
  )
}

export function subscribeCosyVoiceStream(
  callback: (event: CosyVoiceStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<CosyVoiceStreamEvent>('cosyvoice-stream-event', (event) =>
    callback(event.payload),
  )
}

export function subscribeHarnessRuns(
  callback: (run: HarnessRun) => void,
): Promise<UnlistenFn> {
  return listen<HarnessRun>('harness-run-event', (event) =>
    callback(event.payload),
  )
}

export function listModelPlugins(): Promise<ModelPlugin[]> {
  return invoke<ModelPlugin[]>('plugin_catalog')
}

export function listApiModelCatalog(): Promise<ApiModelCatalogEntry[]> {
  return invoke<ApiModelCatalogEntry[]>('plugin_api_catalog')
}

export function refreshModelPlugins(): Promise<ModelPlugin[]> {
  return invoke<ModelPlugin[]>('plugin_refresh_catalog')
}

export function installCatalogModel(
  pluginId: string,
  variantId?: string,
): Promise<ModelPlugin> {
  return invoke<ModelPlugin>('plugin_install_catalog', { pluginId, variantId })
}

export function installRecommendedModelDependency(
  dependencyId: string,
): Promise<ModelPlugin[]> {
  return invoke<ModelPlugin[]>('plugin_install_recommended_dependency', {
    dependencyId,
  })
}

export function getModelDependencyBindings(): Promise<ModelDependencyBindings> {
  return invoke<ModelDependencyBindings>('plugin_dependency_bindings')
}

export function replaceModelDependencyBindings(
  bindings: ModelDependencyBindings,
): Promise<ModelDependencyBindings> {
  return invoke<ModelDependencyBindings>('plugin_replace_dependency_bindings', {
    bindings,
  })
}

export function setModelDependencyBinding(
  pluginId: string,
  role: string,
  dependencyId: string,
): Promise<ModelDependencyBindings> {
  return invoke<ModelDependencyBindings>('plugin_set_dependency_binding', {
    pluginId,
    role,
    dependencyId,
  })
}

export function setModelDownloadPaused(paused: boolean): Promise<void> {
  return invoke<void>('plugin_set_download_paused', { paused })
}

export function cancelModelDownload(): Promise<void> {
  return invoke<void>('plugin_cancel_download')
}

export function setModelPluginSidebarVisible(
  pluginId: string,
  visible: boolean,
): Promise<ModelPlugin[]> {
  return invoke<ModelPlugin[]>('plugin_set_sidebar_visible', {
    pluginId,
    visible,
  })
}

export function uninstallModelPlugin(
  pluginId: string,
): Promise<PluginRemovalResult> {
  return invoke<PluginRemovalResult>('plugin_uninstall', { pluginId })
}

export function getModelPluginReadme(pluginId: string): Promise<string | null> {
  return invoke<string | null>('plugin_readme', { pluginId })
}

export interface ModelPluginFileEntry {
  path: string
  size: number
}

export function getModelPluginFiles(
  pluginId: string,
): Promise<ModelPluginFileEntry[]> {
  return invoke<ModelPluginFileEntry[]>('plugin_files', { pluginId })
}
