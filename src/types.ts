export type ViewId =
  | 'home'
  | 'library'
  | 'edit'
  | 'generate'
  | 'live'
  | 'batch'
  | 'plugins'

export type ClipKind = 'recording' | 'generated' | 'music' | 'stream'

export interface AudioClip {
  id: string
  name: string
  duration: number
  sampleRate: number
  channels: number
  kind: ClipKind
  samples: number[]
  color: string
  sizeLabel: string
  sourceLabel: string
  url?: string
  processingAudioUrl?: string
  transcriptionAudioUrl?: string
}

export interface ProcessingEffect {
  id: string
  name: string
  description: string
  enabled: boolean
  value: number
  valueLabel: string
  tone: 'green' | 'coral' | 'yellow' | 'blue'
}

export interface ModelPlugin {
  id: string
  name: string
  author: string
  engineAuthor?: string
  description: string
  license?: string
  capabilities: string[]
  harnessCapabilities: HarnessCapabilityId[]
  runtime: string
  acceleration: string[]
  version: string
  size: string
  installed: boolean
  enabled: boolean
  sidebarVisible?: boolean
  builtin: boolean
  featured?: boolean
  installCount?: number
  tone: 'green' | 'coral' | 'yellow' | 'blue' | 'violet'
  providerId?: string
  adapter: string
  installPath: string
  catalogManaged?: boolean
  streamingMode?: 'streaming' | 'batch'
  apiAliases?: string[]
  defaultVoice?: string
  variants?: ModelVariant[]
  selectedVariantId?: string
  defaultVariantId?: string
  installable?: boolean
  inputs?: PluginPortDefinition[]
  outputs?: PluginPortDefinition[]
  parameterSchema?: PluginParameterDefinition[]
  recommendedDependencies?: ModelDependencyDefinition[]
}

export interface ModelDependencyDefinition {
  role: 'speech-segmentation' | 'reference-transcription' | string
  label: string
  pluginId: string
  capability: HarnessCapabilityId
  default: boolean
  optional: boolean
}

export type ModelDependencyBindings = Record<string, Record<string, string>>

export interface PluginRemovalResult {
  plugins: ModelPlugin[]
  removal: {
    pluginId: string
    deleted: boolean
    retained: boolean
    referencedBy: string[]
  }
}

export interface ApiModelCatalogEntry {
  id: string
  name: string
  author: string
  description: string
  capabilities: string[]
  harnessCapability: HarnessCapabilityId
  providerId: string
  adapter: string
  modelId: string
  aliases: string[]
  streamingMode: 'streaming' | 'batch'
  featured: boolean
  visible: boolean
}

export interface CustomApiModelDefinition {
  id: string
  name: string
  modelId: string
  providerId: string
  capability: Extract<
    HarnessCapabilityId,
    'text.generate' | 'speech.transcribe' | 'speech.synthesize'
  >
  defaultVoice?: string
}

export type PluginPortType =
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

export interface PluginPortDefinition {
  name: string
  label?: string
  type: PluginPortType
  modes?: Array<'batch' | 'stream'>
  optional?: boolean
}

export interface PluginParameterOption {
  label: string
  value: string | number | boolean
}

export interface PluginParameterDefinition {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  description?: string
  default?: string | number | boolean
  min?: number
  max?: number
  step?: number
  options?: PluginParameterOption[]
  multiline?: boolean
}

export interface ModelVariant {
  id: string
  name: string
  precision: string
  size: string
}

export interface RuntimeStatus {
  apiUrl: string
  backend: string
  device: string
  platform: string
  version: string
}

export interface TtsModelStatus {
  id: string
  name: string
  installed: boolean
  loaded: boolean
  path: string
  sampleRate: number
  speakerCount: number
  runtime: string
}

export interface TtsGenerateResult {
  fileName: string
  filePath: string
  dataUrl: string
  duration: number
  sampleRate: number
  channels: number
  sizeBytes: number
  waveform: number[]
  inferenceSeconds: number
  realTimeFactor: number
  sid: number
  engine: string
}

export interface AsrModelStatus {
  id: string
  name: string
  installed: boolean
  loaded: boolean
  path: string
  sampleRate: number
  languages: string[]
  tokenTimestamps: boolean
  vad: boolean
  runtime: string
}

export interface AsrToken {
  text: string
  start: number
  end: number
}

export interface AsrSegment {
  id: string
  start: number
  end: number
  text: string
  tokens: AsrToken[]
}

export interface AsrTranscriptionResult {
  clipName: string
  sourceAudioDataUrl?: string
  sourceAudioFilePath?: string
  text: string
  language: string
  duration: number
  speechSeconds: number
  waveform?: number[]
  segments: AsrSegment[]
  inferenceSeconds: number
  realTimeFactor: number
  engine: string
}

export interface VadSegment {
  id: string
  start: number
  end: number
  duration: number
}

export interface VadDetectionResult {
  clipName: string
  sourceAudioDataUrl?: string
  sourceAudioFilePath?: string
  duration: number
  speechSeconds: number
  silenceSeconds: number
  segments: VadSegment[]
  waveform: number[]
  inferenceSeconds: number
  realTimeFactor: number
  threshold: number
  engine: string
}

export interface TextGenerateResult {
  text: string
  model: string
  inferenceSeconds: number
  inputTokens?: number
  outputTokens?: number
  engine: string
}

export interface PunctuationResult {
  text: string
  originalText: string
  engine: string
  inferenceSeconds: number
}

export interface AudioProcessorStatus {
  id: string
  name: string
  installed: boolean
  loaded: boolean
  path: string
  sampleRate: number
  vadInstalled: boolean
  runtime: string
}

export type AudioProcessOperation =
  | 'trim'
  | 'denoise'
  | 'silence'
  | 'normalize'
  | 'fade'

export interface AudioProcessResult {
  fileName: string
  filePath: string
  dataUrl: string
  duration: number
  inputDuration: number
  sampleRate: number
  channels: number
  sizeBytes: number
  waveform: number[]
  inferenceSeconds: number
  operation: string
  engine: string
  detail: string
  peakBeforeDb: number
  peakAfterDb: number
  loudnessBeforeDb: number
  loudnessAfterDb: number
  removedSeconds: number
}

export type HarnessCapabilityId =
  | 'speech.synthesize'
  | 'speech.transcribe'
  | 'speech.detect'
  | 'text.generate'
  | 'audio.enhance'
  | 'audio.live'
  | 'audio.classify'
  | 'speech.keyword'
  | 'speech.language'
  | 'text.punctuate'
  | 'text.normalize'
  | 'speaker.embed'
  | 'speaker.diarize'
  | 'audio.separate'

export type HarnessRunStatus =
  | 'queued'
  | 'running'
  | 'canceling'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface HarnessTaskRequest {
  runId?: string
  conversationProviderId?: string
  conversationVisible?: boolean
  dependencyRunIds?: string[]
  capability: HarnessCapabilityId
  providerId?: string
  routing?: 'smart' | 'local' | 'quality'
  title?: string
  input: Record<string, unknown>
  parameters?: Record<string, unknown>
}

export interface HarnessArtifact {
  id: string
  kind: 'audio' | 'transcript' | 'stream' | 'data'
  name: string
  mimeType: string
  filePath?: string
  duration?: number
  sizeBytes?: number
  payload: Record<string, unknown>
}

export interface HarnessRun {
  id: string
  conversationProviderId?: string
  conversationVisible?: boolean
  dependencyRunIds?: string[]
  capability: HarnessCapabilityId
  title: string
  inputSummary: string
  providerId: string
  providerName: string
  modelId: string
  status: HarnessRunStatus
  progress: number
  activity?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  artifacts: HarnessArtifact[]
  error?: string
  retryable: boolean
}

export interface HarnessExecution<T = unknown> {
  run: HarnessRun
  output: T
}

export interface FunAsrStreamStartRequest {
  clipName: string
  providerId?: string
  modelId?: string
  sampleRate: number
  language?: string
  context?: string
  semanticPunctuation?: boolean
}

export interface FunAsrStreamStartResponse {
  sessionId: string
  run: HarnessRun
}

export interface FunAsrStreamEvent {
  sessionId: string
  runId: string
  kind: 'partial' | 'final' | 'completed' | 'error'
  text: string
  error?: string
}

export interface VadStreamStartResponse {
  sessionId: string
}

export interface VadStreamUpdate {
  speechDetected: boolean
  speechStarted: boolean
  speechEnded: boolean
}

export interface EnhancementStreamStartResponse {
  sessionId: string
  sampleRate: number
}

export interface EnhancementStreamChunk {
  pcmBase64: string
  sampleRate: number
}

export interface CosyVoiceStreamStartRequest {
  text: string
  modelId?: string
  voice?: string
  speed?: number
}

export interface CosyVoiceStreamStartResponse {
  sessionId: string
  run: HarnessRun
}

export interface CosyVoiceStreamEvent {
  sessionId: string
  runId: string
  kind: 'audio' | 'completed' | 'error'
  pcmBase64?: string
  sampleRate: number
  chunkIndex?: number
  error?: string
}

export interface HarnessCapability {
  id: HarnessCapabilityId
  name: string
  description: string
  input: string
  output: string
  supportsBatch: boolean
  supportsStreaming: boolean
}

export interface HarnessModel {
  id: string
  name: string
  installed: boolean
  loaded: boolean
}

export interface HarnessProvider {
  id: string
  name: string
  kind: 'local-model' | 'local-runtime' | 'plugin' | 'api'
  runtime: string
  status: 'ready' | 'missing' | 'disabled' | 'unconfigured'
  configured: boolean
  local: boolean
  capabilities: HarnessCapabilityId[]
  models: HarnessModel[]
}

export interface HarnessCatalog {
  capabilities: HarnessCapability[]
  providers: HarnessProvider[]
}

export interface ApiProviderSettings {
  id: string
  name: string
  baseUrl: string
  apiKeyConfigured: boolean
  ttsModel: string
  ttsVoice: string
  asrModel: string
  llmModel: string
  enabled: boolean
  status: 'ready' | 'unconfigured'
  llmEnabled: boolean
  asrEnabled: boolean
  ttsEnabled: boolean
  authType: ApiAuthType
  authHeader: string
  extraHeaders: Record<string, string>
  llmPath: string
  asrMode: ApiAsrMode
  asrPath: string
  asrBodyTemplate: string
  asrModelField: string
  asrLanguageField: string
  asrPromptField: string
  asrTextPointer: string
  ttsMode: ApiTtsMode
  ttsPath: string
  ttsBodyTemplate: string
  ttsResponseEncoding: ApiAudioResponseEncoding
  ttsAudioPointer: string
  ttsAudioFormat: ApiAudioFormat
  ttsSampleRate: number
}

export type ApiAuthType = 'bearer' | 'token' | 'custom-header' | 'none'
export type ApiAsrMode = 'multipart' | 'binary' | 'template-json-base64'
export type ApiTtsMode =
  | 'standard-json'
  | 'voice-path-json'
  | 'nested-voice-json'
  | 'query-model-json'
  | 'template-json'
export type ApiAudioResponseEncoding = 'raw' | 'hex' | 'base64' | 'stream-base64'
export type ApiAudioFormat = 'wav' | 'pcm16'

export interface ApiProviderUpdate {
  id?: string
  name: string
  baseUrl: string
  apiKey?: string
  enabled: boolean
  llmEnabled: boolean
  asrEnabled: boolean
  ttsEnabled: boolean
  authType: ApiAuthType
  authHeader: string
  extraHeaders: Record<string, string>
  llmPath: string
  asrMode: ApiAsrMode
  asrPath: string
  asrBodyTemplate: string
  asrModelField: string
  asrLanguageField: string
  asrPromptField: string
  asrTextPointer: string
  ttsMode: ApiTtsMode
  ttsPath: string
  ttsBodyTemplate: string
  ttsResponseEncoding: ApiAudioResponseEncoding
  ttsAudioPointer: string
  ttsAudioFormat: ApiAudioFormat
  ttsSampleRate: number
}

export interface BailianProviderSettings {
  id: string
  name: string
  apiKeyConfigured: boolean
  enabled: boolean
  status: 'ready' | 'unconfigured'
}

export interface BailianProviderUpdate {
  apiKey?: string
}

export interface BailianVoice {
  id: string
  targetModel: string
  status: string
  createdAt?: string
}

export interface BailianVoiceCreateRequest {
  targetModel: string
  mode: 'clone' | 'design'
  prefix: string
  language?: string
  audioDataUrl?: string
  voicePrompt?: string
  previewText?: string
}
