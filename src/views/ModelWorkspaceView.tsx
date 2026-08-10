import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Activity,
  ArrowUp,
  AudioLines,
  Captions,
  CircleStop,
  Download,
  FileAudio,
  Headphones,
  LoaderCircle,
  Mic,
  MonitorSpeaker,
  PanelLeftClose,
  SlidersHorizontal,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { InlineAudioPlayer } from '../components/InlineAudioPlayer'
import { AudioAssetPreview } from '../components/AudioAssetPreview'
import { AudioFileDropZone } from '../components/AudioFileDropZone'
import { RecordingWaveform } from '../components/RecordingWaveform'
import { VoiceCombobox } from '../components/VoiceCombobox'
import {
  capabilityAcceptsAudio,
  capabilityDefinition,
} from '../domain/capabilities'
import { normalizeHarnessResult } from '../domain/results'
import { cloudVoiceOptions, type VoiceOption } from '../domain/voices'
import {
  finishFunAsrStream,
  finishEnhancementStream,
  createBailianVoice,
  deleteBailianVoice,
  getHarnessRunOutput,
  getHarnessRunPreview,
  listBailianVoices,
  playSystemAudioChunk,
  pushEnhancementStream,
  pushFunAsrStream,
  startCosyVoiceStream,
  startEnhancementStream,
  startSystemAudio,
  stopSystemAudio,
  startFunAsrStream,
  subscribeCosyVoiceStream,
  subscribeSystemAudio,
  subscribeFunAsrStream,
} from '../services/harness'
import {
  audioFileToClip,
  formatFileSize,
  formatTime,
  pcm16ChunksToWavFile,
} from '../utils/audio'
import { getMicrophoneStream } from '../services/audioCapture'
import {
  publishCaptionOutput,
  showCaptionOutput,
  stopCaptionOutput,
} from '../services/captionOutput'
import {
  getModelBinding,
  recommendedDependencies,
} from '../modelDependencies'
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessCapabilityId,
  HarnessCatalog,
  HarnessExecution,
  HarnessRun,
  ModelDependencyBindings,
  ModelPlugin,
  PunctuationResult,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from '../types'

function ttsSpeakerCount(plugin: ModelPlugin): number | null {
  if (plugin.adapter === 'kokoro') return 103
  if (plugin.id === 'k2-fsa.vits-aishell3') return 174
  if (plugin.id === 'k2-fsa.vits-melo-zh-en') return 1
  return null
}

const DETAIL_WIDTH_STORAGE_KEY = 'qwen-audio-toolkits.result-detail-width-v1'
const DEFAULT_DETAIL_WIDTH = 390
const MIN_DETAIL_WIDTH = 330
const MAX_DETAIL_WIDTH = 640

function getInitialDetailWidth() {
  const stored = Number(window.localStorage.getItem(DETAIL_WIDTH_STORAGE_KEY))
  return Number.isFinite(stored)
    ? Math.min(MAX_DETAIL_WIDTH, Math.max(MIN_DETAIL_WIDTH, stored))
    : DEFAULT_DETAIL_WIDTH
}

type AudioOutput = TtsGenerateResult | AudioProcessResult
type TextOutput = TextGenerateResult | PunctuationResult
type RunOutput =
  | AudioOutput
  | AsrTranscriptionResult
  | VadDetectionResult
  | TextOutput
  | Record<string, unknown>

interface ModelWorkspaceViewProps {
  plugin: ModelPlugin
  plugins: ModelPlugin[]
  modelBindings: ModelDependencyBindings
  catalog: HarnessCatalog | null
  runs: HarnessRun[]
  onRunText: (
    text: string,
    capability: Extract<
      HarnessCapabilityId,
      'speech.synthesize' | 'text.generate'
      | 'text.punctuate'
      | 'text.normalize'
    >,
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<
    HarnessExecution<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >
  >
  onRunAudio: (
    clip: AudioClip,
    capability: Extract<
      HarnessCapabilityId,
      'speech.transcribe' | 'speech.detect' | 'audio.enhance'
      | 'audio.classify'
      | 'speech.keyword'
      | 'speech.language'
      | 'speaker.embed'
      | 'speaker.diarize'
      | 'audio.separate'
    >,
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    conversationVisible?: boolean,
    dependencyRunIds?: string[],
  ) => Promise<
    HarnessExecution<
      AsrTranscriptionResult | VadDetectionResult | AudioProcessResult
      | Record<string, unknown>
    >
  >
  onOpenStore: () => void
  onAction: (message: string) => void
  onClearTextHistory?: () => void
}

const statusLabels: Record<HarnessRun['status'], string> = {
  queued: '等待运行',
  running: '正在处理',
  canceling: '正在取消',
  completed: '处理完成',
  failed: '运行失败',
  canceled: '已取消',
}
const CREATED_AT_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})
const MAX_WORKSPACE_PREVIEW_CACHE = 32

function capabilityLabel(capability: HarnessCapabilityId): string {
  return capabilityDefinition(capability).label
}

function capabilityIcon(capability: HarnessCapabilityId) {
  if (capability === 'speech.synthesize') return WandSparkles
  if (capability === 'speech.transcribe') return Captions
  if (capability === 'speech.detect') return Activity
  if (capability === 'audio.enhance') return Sparkles
  if (capability === 'text.generate') return Sparkles
  return AudioLines
}

function isAudioOutput(
  output: RunOutput,
): output is AudioOutput {
  return 'dataUrl' in output && 'waveform' in output
}

function isVadOutput(output: RunOutput): output is VadDetectionResult {
  return 'threshold' in output && 'silenceSeconds' in output
}

function isTextOutput(output: RunOutput): output is TextOutput {
  return (
    'text' in output &&
    typeof output.text === 'string' &&
    !('segments' in output)
  )
}

function isAsrOutput(output: RunOutput): output is AsrTranscriptionResult {
  return (
    'segments' in output &&
    Array.isArray(output.segments) &&
    'language' in output &&
    typeof output.language === 'string' &&
    'realTimeFactor' in output &&
    typeof output.realTimeFactor === 'number'
  )
}

function formatCreatedAt(timestamp: number): string {
  return CREATED_AT_FORMATTER.format(new Date(timestamp))
}

function withBoundedEntry<T>(
  current: Record<string, T>,
  key: string,
  value: T,
): Record<string, T> {
  const next = { ...current }
  delete next[key]
  next[key] = value
  const keys = Object.keys(next)
  for (
    let index = 0;
    index < keys.length - MAX_WORKSPACE_PREVIEW_CACHE;
    index += 1
  ) {
    delete next[keys[index]]
  }
  return next
}

function clipForPreview(clip: AudioClip): AudioClip {
  return {
    ...clip,
    processingAudioUrl: undefined,
    transcriptionAudioUrl: undefined,
  }
}

function withBoundedAttachment(
  current: Record<string, AudioClip>,
  key: string,
  clip: AudioClip,
): Record<string, AudioClip> {
  const next = withBoundedEntry(current, key, clipForPreview(clip))
  Object.entries(current).forEach(([id, previous]) => {
    const previousUrl = previous.url
    if (id in next || !previousUrl?.startsWith('blob:')) return
    URL.revokeObjectURL(previousUrl)
  })
  return next
}

function genericOutputPreview(output: RunOutput): string {
  if (isAsrOutput(output)) return output.text || '未识别到有效语音'
  if (isVadOutput(output)) return `检测到 ${output.segments.length} 个语音片段`
  if (isTextOutput(output)) return output.text
  if ('tags' in output && Array.isArray(output.tags)) {
    return output.tags
      .slice(0, 3)
      .map((item) => String((item as { label?: unknown }).label ?? ''))
      .filter(Boolean)
      .join(' · ')
  }
  if ('detected' in output && typeof output.detected === 'boolean') {
    return output.detected ? '检测到关键词' : '未检测到关键词'
  }
  if ('language' in output && typeof output.language === 'string') {
    return `识别语言：${output.language}`
  }
  if ('dimension' in output && typeof output.dimension === 'number') {
    return `${output.dimension} 维声纹已生成`
  }
  if ('speakerCount' in output && typeof output.speakerCount === 'number') {
    return `检测到 ${output.speakerCount} 位说话人`
  }
  if ('tracks' in output && Array.isArray(output.tracks)) {
    return `已生成 ${output.tracks.length} 条音轨`
  }
  return '查看结果'
}

function RuntimeInfo({
  output,
  fallbackEngine,
  automaticSegmentation,
}: {
  output: Record<string, unknown>
  fallbackEngine?: string
  automaticSegmentation?: { engine: string; segmentCount: number }
}) {
  const engine =
    typeof output.engine === 'string'
      ? output.engine
      : typeof output.model === 'string'
        ? output.model
        : fallbackEngine
  const inferenceSeconds =
    typeof output.inferenceSeconds === 'number'
      ? output.inferenceSeconds
      : null
  const realTimeFactor =
    typeof output.realTimeFactor === 'number' ? output.realTimeFactor : null
  return (
    <dl className="detail-runtime-facts">
      {engine && (
        <div>
          <dt>{typeof output.model === 'string' ? '模型' : '引擎'}</dt>
          <dd>{engine}</dd>
        </div>
      )}
      {automaticSegmentation && (
        <div>
          <dt>自动分段</dt>
          <dd>
            {automaticSegmentation.engine} · {automaticSegmentation.segmentCount} 段
          </dd>
        </div>
      )}
      {inferenceSeconds !== null && (
        <div>
          <dt>推理耗时</dt>
          <dd>{inferenceSeconds.toFixed(2)} s</dd>
        </div>
      )}
      {realTimeFactor !== null && (
        <div>
          <dt>RTF</dt>
          <dd>{realTimeFactor.toFixed(3)}</dd>
        </div>
      )}
      {typeof output.threshold === 'number' && (
        <div>
          <dt>阈值</dt>
          <dd>{output.threshold.toFixed(2)}</dd>
        </div>
      )}
      {typeof output.inputTokens === 'number' && (
        <div>
          <dt>输入 Tokens</dt>
          <dd>{output.inputTokens}</dd>
        </div>
      )}
      {typeof output.outputTokens === 'number' && (
        <div>
          <dt>输出 Tokens</dt>
          <dd>{output.outputTokens}</dd>
        </div>
      )}
    </dl>
  )
}

function DependencyResultDetail({
  execution,
  onSeek,
}: {
  execution: HarnessExecution<RunOutput>
  onSeek?: (seconds: number) => void
}) {
  const { run, output } = execution
  const modelName = run.providerName || run.modelId || '辅助模型'
  return (
    <article className="detail-dependency-item">
      <header>
        <div>
          <strong>{modelName}</strong>
          <span>{capabilityLabel(run.capability)}</span>
        </div>
        {run.durationMs ? (
          <time>{(run.durationMs / 1000).toFixed(1)}s</time>
        ) : null}
      </header>
      {isVadOutput(output) ? (
        <>
          <div className="detail-dependency-summary">
            <strong>{output.segments.length} 个语音片段</strong>
            <span>语音 {formatTime(output.speechSeconds, true)}</span>
          </div>
          <div className="detail-dependency-segments">
            {output.segments.map((segment, index) => (
              <button
                key={segment.id}
                type="button"
                onClick={() => onSeek?.(segment.start)}
              >
                <span>{index + 1}</span>
                <time>
                  {formatTime(segment.start, true)}–
                  {formatTime(segment.end, true)}
                </time>
              </button>
            ))}
          </div>
        </>
      ) : isAsrOutput(output) ? (
        <p className="detail-dependency-text">
          {output.text || '未识别到有效语音'}
        </p>
      ) : isTextOutput(output) ? (
        <p className="detail-dependency-text">{output.text}</p>
      ) : (
        <p className="detail-dependency-text">{genericOutputPreview(output)}</p>
      )}
    </article>
  )
}

function AdvancedResultDetail({
  output,
  onSeek,
}: {
  output: Record<string, unknown>
  onSeek?: (seconds: number) => void
}) {
  const normalized = normalizeHarnessResult(output)
  if (Array.isArray(output.tags)) {
    const tags = output.tags
      .map((item) => item as { label?: string; probability?: number })
      .filter((tag) => tag.label)
      .sort((left, right) => (right.probability ?? 0) - (left.probability ?? 0))
    const highestProbability = Math.max(
      0.01,
      ...tags.map((tag) => tag.probability ?? 0),
    )
    return (
      <section className="audio-tagging-result">
        <header>
          <div>
            <strong>{tags[0]?.label ?? '未识别到音频事件'}</strong>
            <span>最可能的声音</span>
          </div>
          <b>{Math.round((tags[0]?.probability ?? 0) * 100)}%</b>
        </header>
        <div className="audio-tagging-bars">
          {tags.map((tag, index) => {
            const probability = tag.probability ?? 0
            return (
              <div key={`${tag.label}-${index}`}>
                <span>{tag.label}</span>
                <i>
                  <b
                    style={{
                      width: `${Math.max(
                        2,
                        (probability / highestProbability) * 100,
                      )}%`,
                    }}
                  />
                </i>
                <em>{Math.round(probability * 100)}%</em>
              </div>
            )
          })}
        </div>
      </section>
    )
  }
  if (typeof output.detected === 'boolean') {
    return (
      <div className="advanced-result-status">
        <strong>{output.detected ? '检测到关键词' : '未检测到关键词'}</strong>
        {normalized.segments.map((segment) => (
          <button
            className="advanced-result-list advanced-result-segment-row"
            key={segment.id}
            type="button"
            onClick={() => onSeek?.(segment.start)}
          >
            <strong>{segment.label}</strong>
            <time>
              {formatTime(segment.start, true)}–
              {formatTime(segment.end, true)}
            </time>
          </button>
        ))}
      </div>
    )
  }
  if (typeof output.language === 'string') {
    return <div className="advanced-result-status"><strong>{output.language}</strong></div>
  }
  if (typeof output.text === 'string') {
    return (
      <div className="advanced-text-result">
        <p>{output.text}</p>
        {typeof output.originalText === 'string' && (
          <small>原文：{output.originalText}</small>
        )}
      </div>
    )
  }
  if (typeof output.dimension === 'number') {
    return (
      <div className="advanced-result-status">
        <strong>{output.dimension} 维声纹已生成</strong>
        <small>可保存到声纹库用于识别与聚类</small>
      </div>
    )
  }
  if (typeof output.speakerCount === 'number' && Array.isArray(output.segments)) {
    const segments = normalized.segments
    return (
      <div className="vad-result-detail">
        <div className="transcript-result-summary">
          <strong>{output.speakerCount} 位说话人</strong>
          <span>{segments.length} 个片段</span>
        </div>
        <section className="vad-detail-section">
          <header>
            <strong>说话片段</strong>
            <span>{segments.length} SEGMENTS</span>
          </header>
          <div className="transcript-result-segments vad-segment-list">
            {segments.map((segment) => (
              <button
                className="speaker-segment-row"
                key={segment.id}
                type="button"
                onClick={() => onSeek?.(segment.start)}
              >
                <strong>{segment.label}</strong>
                <time>
                  {formatTime(segment.start, true)}–
                  {formatTime(segment.end, true)}
                </time>
                <small>
                  {formatTime(Math.max(0, segment.end - segment.start), true)}
                </small>
              </button>
            ))}
          </div>
        </section>
      </div>
    )
  }
  if (Array.isArray(output.tracks)) {
    return (
      <div className="advanced-audio-tracks">
        {normalized.audio.map((track) => (
          <section key={track.id}>
            <strong>{track.name}</strong>
            <AudioAssetPreview
              src={track.filePath ? convertFileSrc(track.filePath) : track.dataUrl}
              spectrogramSrc={track.dataUrl}
              peaks={track.peaks}
              duration={track.duration}
              role="output"
            />
          </section>
        ))}
      </div>
    )
  }
  return <pre>{JSON.stringify(output, null, 2)}</pre>
}

function pcm16Base64(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16_000,
): string {
  const ratio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(1, Math.floor(samples.length / ratio))
  const bytes = new Uint8Array(outputLength * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < outputLength; index += 1) {
    const sample = samples[Math.min(samples.length - 1, Math.floor(index * ratio))]
    const value = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff)
    view.setInt16(index * 2, value, true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

export function ModelWorkspaceView({
  plugin,
  plugins,
  modelBindings,
  catalog,
  runs,
  onRunText,
  onRunAudio,
  onOpenStore,
  onAction,
  onClearTextHistory,
}: ModelWorkspaceViewProps) {
  const capability =
    plugin.harnessCapabilities[0] ?? 'speech.synthesize'
  const capabilityMeta = capabilityDefinition(capability)
  const provider = catalog?.providers.find(
    (item) => item.id === plugin.providerId,
  )
  const providerReady = provider
    ? provider.status === 'ready'
    : plugin.installed
  const apiModel = plugin.providerId?.startsWith('api.') === true
  const funAsrModel = plugin.adapter === 'bailian-funasr'
  const qwen3AsrModel = plugin.adapter === 'qwen3-asr'
  const canaryModel = plugin.adapter === 'nemo-canary'
  const streamingAsrModel =
    capability === 'speech.transcribe' &&
    plugin.streamingMode === 'streaming'
  const streamingTtsModel =
    capability === 'speech.synthesize' &&
    plugin.adapter === 'bailian-cosyvoice' &&
    plugin.streamingMode === 'streaming'
  const streamingEnhanceModel =
    capability === 'audio.enhance' &&
    plugin.streamingMode === 'streaming'
  const requiresCustomCosyVoice = [
    'cosyvoice-v3.5-plus',
    'cosyvoice-v3.5-flash',
  ].includes(plugin.version)
  const voiceOptions = cloudVoiceOptions(plugin)
  const supportsCloudVoiceCreation =
    plugin.providerId === 'api.bailian' &&
    [
      'qwen-audio-3.0-tts-flash',
      'qwen-audio-3.0-tts-plus',
      'cosyvoice-v3-plus',
      'cosyvoice-v3.5-plus',
      'cosyvoice-v3.5-flash',
    ].includes(plugin.version)
  const supportsVoiceDesign = plugin.version.startsWith('cosyvoice-v3.5-')
  const modelRuns = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            run.conversationVisible !== false &&
            (((run.conversationProviderId ?? run.providerId) ===
              plugin.providerId &&
              (!apiModel || run.modelId === plugin.version)) ||
              (run.capability === capability &&
                run.modelId.toLowerCase().includes(plugin.adapter))),
        )
        .sort((left, right) => left.createdAt - right.createdAt),
    [
      apiModel,
      capability,
      plugin.adapter,
      plugin.providerId,
      plugin.version,
      runs,
    ],
  )
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('longanhuan_v3.6')
  const [customVoices, setCustomVoices] = useState<VoiceOption[]>([])
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false)
  const [voiceCreationMode, setVoiceCreationMode] = useState<
    'clone' | 'design'
  >('clone')
  const [voicePrefix, setVoicePrefix] = useState('myvoice')
  const [voiceLanguage, setVoiceLanguage] = useState('zh')
  const [voicePrompt, setVoicePrompt] = useState('')
  const [voicePreviewText, setVoicePreviewText] = useState(
    '你好，这是一段音色试听。',
  )
  const [voiceCreating, setVoiceCreating] = useState(false)
  const [voiceDialogError, setVoiceDialogError] = useState('')
  const voiceStorageKey = `qwen-audio-toolkits.voice.${plugin.version}`
  const customVoiceStorageKey = `qwen-audio-toolkits.custom-voices.${plugin.version}`
  const cacheCustomVoices = useCallback(
    (options: VoiceOption[]) => {
      window.localStorage.setItem(
        customVoiceStorageKey,
        JSON.stringify(options),
      )
    },
    [customVoiceStorageKey],
  )
  const selectVoice = (value: string) => {
    setVoice(value)
    if (value) {
      window.localStorage.setItem(voiceStorageKey, value)
    } else {
      window.localStorage.removeItem(voiceStorageKey)
    }
  }
  const [speakerId, setSpeakerId] = useState(3)
  const [speed, setSpeed] = useState(1)
  const [ttsLanguage, setTtsLanguage] = useState('en')
  const [ttsReferenceClip, setTtsReferenceClip] = useState<AudioClip | null>(
    null,
  )
  const [ttsReferenceText, setTtsReferenceText] = useState('')
  const [ttsReferenceDependencyRunId, setTtsReferenceDependencyRunId] =
    useState<string | null>(null)
  const [referenceAsrModelId, setReferenceAsrModelId] = useState('')
  const [referenceTranscribing, setReferenceTranscribing] = useState(false)
  const referenceTranscriptionRequestRef = useRef(0)
  const ttsReferenceTextEditedRef = useRef(false)
  const [asrLanguage, setAsrLanguage] = useState('auto')
  const [asrContext, setAsrContext] = useState('')
  const [asrTargetLanguage, setAsrTargetLanguage] = useState('en')
  const [semanticPunctuation, setSemanticPunctuation] = useState(true)
  const availableVoiceOptions = useMemo(
    () => [...voiceOptions, ...customVoices],
    [customVoices, voiceOptions],
  )

  useEffect(() => {
    let disposed = false
    if (!supportsCloudVoiceCreation) {
      setCustomVoices([])
      return undefined
    }
    try {
      const cached = JSON.parse(
        window.localStorage.getItem(customVoiceStorageKey) ?? '[]',
      ) as VoiceOption[]
      setCustomVoices(
        cached.filter(
          (option) =>
            typeof option.id === 'string' && typeof option.name === 'string',
        ),
      )
    } catch {
      setCustomVoices([])
    }
    if (!providerReady) return undefined
    void listBailianVoices(plugin.version)
      .then((voices) => {
        if (disposed) return
        const options = voices.map((item) => ({
            id: item.id,
            name: item.id.split('-').slice(-2, -1)[0] || '自定义音色',
            description: item.createdAt
              ? `自定义音色 · ${item.createdAt}`
              : '自定义音色',
            custom: true,
          }))
        setCustomVoices(options)
        cacheCustomVoices(options)
        if (
          requiresCustomCosyVoice &&
          !window.localStorage.getItem(voiceStorageKey) &&
          options[0]
        ) {
          setVoice(options[0].id)
          window.localStorage.setItem(voiceStorageKey, options[0].id)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [
    plugin.version,
    cacheCustomVoices,
    customVoiceStorageKey,
    providerReady,
    requiresCustomCosyVoice,
    supportsCloudVoiceCreation,
    voiceStorageKey,
  ])
  const automaticVadModel = useMemo(
    () => {
      const dependency = recommendedDependencies(plugin).find(
        (item) => item.role === 'speech-segmentation',
      )
      const binding = getModelBinding(
        modelBindings,
        plugin.id,
        'speech-segmentation',
        dependency?.default ? dependency.pluginId : '',
      )
      return plugins.find(
        (candidate) =>
          candidate.id === binding &&
          candidate.installed &&
          candidate.providerId &&
          candidate.harnessCapabilities.includes('speech.detect'),
      )
    },
    [modelBindings, plugin, plugins],
  )
  const automaticTextNormalizer = useMemo(() => {
    const dependency = recommendedDependencies(plugin).find(
      (item) => item.role === 'text-normalization',
    )
    const binding = getModelBinding(
      modelBindings,
      plugin.id,
      'text-normalization',
      dependency?.default ? dependency.pluginId : '',
    )
    return plugins.find(
      (candidate) =>
        candidate.id === binding &&
        candidate.installed &&
        candidate.providerId &&
        candidate.harnessCapabilities.includes('text.normalize'),
    )
  }, [modelBindings, plugin, plugins])
  const referenceAsrModels = useMemo(
    () =>
      plugins.filter(
        (candidate) =>
          candidate.installed &&
          candidate.providerId &&
          candidate.streamingMode !== 'streaming' &&
          candidate.harnessCapabilities.includes('speech.transcribe'),
      ),
    [plugins],
  )
  const [automaticSegmentationByRunId, setAutomaticSegmentationByRunId] =
    useState<Record<string, { engine: string; segmentCount: number }>>({})
  const [denoiseStrength, setDenoiseStrength] = useState(1)
  const [monitorLatencyMs, setMonitorLatencyMs] = useState<number | null>(
    null,
  )
  const [wetextOperator, setWetextOperator] = useState<'tn' | 'itn'>('tn')
  const [wetextLanguage, setWetextLanguage] = useState('auto')
  const [wetextFullToHalf, setWetextFullToHalf] = useState(true)
  const [keywords, setKeywords] = useState('你好小助手')
  const [audioSource, setAudioSource] = useState<'microphone' | 'system'>(
    'microphone',
  )
  const [audioInputMenuOpen, setAudioInputMenuOpen] = useState(false)
  const audioInputMenuTimerRef = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingTarget, setRecordingTarget] = useState<
    'primary' | 'tts-reference' | null
  >(null)
  const [, setStreamSessionId] = useState<string | null>(null)
  useEffect(() => {
    const dependency = recommendedDependencies(plugin).find(
      (item) => item.role === 'reference-transcription',
    )
    const preferredModelId = getModelBinding(
      modelBindings,
      plugin.id,
      'reference-transcription',
      dependency?.default ? dependency.pluginId : '',
    )
    if (!preferredModelId) {
      setReferenceAsrModelId('')
      return
    }
    if (
      referenceAsrModels.some((candidate) => candidate.id === preferredModelId)
    ) {
      setReferenceAsrModelId(preferredModelId)
      return
    }
    if (
      referenceAsrModelId &&
      referenceAsrModels.some(
        (candidate) => candidate.id === referenceAsrModelId,
      )
    ) {
      return
    }
    setReferenceAsrModelId(referenceAsrModels[0]?.id ?? '')
  }, [modelBindings, plugin, referenceAsrModelId, referenceAsrModels])
  useEffect(() => {
    const stored = window.localStorage.getItem(voiceStorageKey)
    setVoice(
      stored ??
        (requiresCustomCosyVoice ? '' : (voiceOptions[0]?.id ?? '')),
    )
  }, [requiresCustomCosyVoice, voiceOptions, voiceStorageKey])
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null)
  const [liveTranscript, setLiveTranscript] = useState('')
  const liveTranscriptRef = useRef('')
  const ttsStreamSessionRef = useRef<string | null>(null)
  const ttsPlaybackContextRef = useRef<AudioContext | null>(null)
  const ttsPlaybackCursorRef = useRef(0)
  const ttsPlaybackSourcesRef = useRef(new Set<AudioBufferSourceNode>())
  const ttsPlaybackQueueRef = useRef<Promise<void>>(Promise.resolve())
  const ttsPlaybackGenerationRef = useRef(0)
  const ttsLastChunkIndexRef = useRef(0)
  const enhancementSessionRef = useRef<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [visibleRunId, setVisibleRunId] = useState<string | null>(null)
  const [vadPreviewTime, setVadPreviewTime] = useState<number>()
  const [asrPlayRange, setAsrPlayRange] = useState<{
    start: number
    end: number
    requestId: number
    key: string
  }>()
  const [asrPlaybackTime, setAsrPlaybackTime] = useState(0)
  const [execution, setExecution] =
    useState<HarnessExecution<RunOutput> | null>(null)
  const [dependencyExecutions, setDependencyExecutions] = useState<
    HarnessExecution<RunOutput>[]
  >([])
  const [dependencyLoading, setDependencyLoading] = useState(false)
  const [inlineOutputs, setInlineOutputs] = useState<
    Record<string, RunOutput>
  >({})
  const fullExecutionsRef = useRef<
    Record<string, HarnessExecution<RunOutput>>
  >({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailRequestVersion, setDetailRequestVersion] = useState(0)
  const [detailWidth, setDetailWidth] = useState(getInitialDetailWidth)
  const [attachments, setAttachments] = useState<Record<string, AudioClip>>(
    {},
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ttsReferenceInputRef = useRef<HTMLInputElement>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const followLatestRunRef = useRef(true)
  const transcriptResultRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const cancelRecordingRef = useRef(false)
  const streamStartAtRef = useRef(0)
  const pushedAudioMsRef = useRef(0)
  const systemAudioSessionRef = useRef<string | null>(null)
  const systemAudioChunksRef = useRef<string[]>([])
  const systemAudioUnlistenRef = useRef<(() => void) | null>(null)
  const systemAudioRunIdRef = useRef<string | null>(null)

  const beginDetailResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (window.innerWidth <= 880) return
    event.preventDefault()
    // Capture the pointer so pointerup is received even if released outside
    // the window; otherwise `detail-resizing` can get stuck on <body>.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      detailWidth
    const workspaceWidth =
      event.currentTarget.closest('.model-workspace')?.getBoundingClientRect()
        .width ?? window.innerWidth
    const maxWidth = Math.max(
      MIN_DETAIL_WIDTH,
      Math.min(MAX_DETAIL_WIDTH, workspaceWidth * 0.48),
    )
    document.body.classList.add('detail-resizing')
    const safety = window.setTimeout(() => {
      document.body.classList.remove('detail-resizing')
    }, 10_000)

    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(
        maxWidth,
        Math.max(MIN_DETAIL_WIDTH, startWidth - (moveEvent.clientX - startX)),
      )
      setDetailWidth(next)
    }
    const finish = () => {
      window.clearTimeout(safety)
      document.body.classList.remove('detail-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  useEffect(() => {
    window.localStorage.setItem(
      DETAIL_WIDTH_STORAGE_KEY,
      Math.round(detailWidth).toString(),
    )
  }, [detailWidth])

  useEffect(() => {
    const clearDetailResizing = () =>
      document.body.classList.remove('detail-resizing')
    window.addEventListener('blur', clearDetailResizing)
    return () => {
      window.removeEventListener('blur', clearDetailResizing)
      clearDetailResizing()
    }
  }, [])

  const streamSessionRef = useRef<string | null>(null)
  const streamAudioContextRef = useRef<AudioContext | null>(null)
  const streamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const streamGainRef = useRef<GainNode | null>(null)
  const streamPushQueueRef = useRef<Promise<void>>(Promise.resolve())
  const enhancementQueueDepthRef = useRef(0)
  const streamPushFailedRef = useRef(false)
  const requestedPreviewRunsRef = useRef(new Set<string>())
  const onActionRef = useRef(onAction)
  const selectedRun =
    modelRuns.find((run) => run.id === selectedRunId) ?? null
  const selectedRunRef = useRef(selectedRun)
  selectedRunRef.current = selectedRun
  const openRunDetail = (runId: string) => {
    setExecution(null)
    setDependencyExecutions([])
    setDependencyLoading(false)
    setDetailLoading(true)
    setSelectedRunId(runId)
    setDetailRequestVersion((version) => version + 1)
  }
  const outputPreviewRuns = useMemo(() => {
    if (!modelRuns.length) return []
    const runIds = new Set(
      modelRuns.slice(Math.max(0, modelRuns.length - 8)).map((run) => run.id),
    )
    const matchedVisibleIndex = modelRuns.findIndex(
      (run) => run.id === visibleRunId,
    )
    const visibleIndex =
      matchedVisibleIndex >= 0 ? matchedVisibleIndex : modelRuns.length - 1
    modelRuns
      .slice(
        Math.max(0, visibleIndex - 6),
        Math.min(modelRuns.length, visibleIndex + 7),
      )
      .forEach((run) => runIds.add(run.id))
    if (selectedRunId) runIds.add(selectedRunId)
    return modelRuns.filter((run) => runIds.has(run.id))
  }, [modelRuns, selectedRunId, visibleRunId])
  const latestRunId = modelRuns.at(-1)?.id
  const selectedAttachment = selectedRun
    ? attachments[selectedRun.id]
    : undefined
  const selectedSourceAudioUrl =
    selectedAttachment?.url ??
    selectedAttachment?.transcriptionAudioUrl ??
    (execution &&
    'sourceAudioDataUrl' in execution.output &&
    typeof execution.output.sourceAudioDataUrl === 'string'
      ? execution.output.sourceAudioDataUrl
      : execution &&
          'sourceAudioFilePath' in execution.output &&
          typeof execution.output.sourceAudioFilePath === 'string'
        ? convertFileSrc(execution.output.sourceAudioFilePath)
      : undefined)

  const activeAsrTokenKey = useMemo(() => {
    if (!execution || !isAsrOutput(execution.output)) return null
    for (const segment of execution.output.segments) {
      const tokenIndex = segment.tokens.findIndex(
        (token) =>
          asrPlaybackTime >= token.start && asrPlaybackTime < token.end,
      )
      if (tokenIndex >= 0) return `${segment.id}-${tokenIndex}`
    }
    return null
  }, [asrPlaybackTime, execution])
  const Icon = capabilityIcon(capability)
  const declaredTtsReferenceAudio = plugin.inputs?.find(
    (port) => port.type === 'audio',
  )
  const requiresTtsReferenceAudio =
    capability === 'speech.synthesize' &&
    (Boolean(declaredTtsReferenceAudio) ||
      ['zipvoice', 'pocket-tts', 'cosyvoice-local'].includes(plugin.adapter))
  const ttsReferenceAudioLabel =
    declaredTtsReferenceAudio?.label ?? '参考音频'
  const requiresTtsReferenceText = [
    'zipvoice',
    'cosyvoice-local',
  ].includes(plugin.adapter)
  const supportsTtsLanguage = plugin.adapter === 'supertonic'
  const speakerCount = ttsSpeakerCount(plugin)
  const supportsSpeakerSelection =
    !apiModel && speakerCount !== null && speakerCount > 1

  useEffect(() => {
    if (!supportsSpeakerSelection) {
      setSpeakerId(0)
      return
    }
    setSpeakerId((current) =>
      current >= 0 && current < speakerCount ? current : 0,
    )
  }, [speakerCount, supportsSpeakerSelection])

  const disconnectStreamingInput = () => {
    if (streamProcessorRef.current) {
      streamProcessorRef.current.onaudioprocess = null
    }
    streamProcessorRef.current?.disconnect()
    streamProcessorRef.current = null
    streamSourceRef.current?.disconnect()
    streamSourceRef.current = null
    streamGainRef.current?.disconnect()
    streamGainRef.current = null
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
    recordingStreamRef.current = null
  }

  const releaseStreamingAudio = () => {
    disconnectStreamingInput()
    const context = streamAudioContextRef.current
    if (ttsPlaybackContextRef.current === context) {
      stopStreamingTtsPlayback()
      ttsPlaybackContextRef.current = null
    }
    void context?.close()
    streamAudioContextRef.current = null
  }

  const stopStreamingTtsPlayback = () => {
    ttsPlaybackGenerationRef.current += 1
    ttsPlaybackSourcesRef.current.forEach((source) => {
      try {
        source.stop()
      } catch {
        // A source that already ended needs no further cleanup.
      }
    })
    ttsPlaybackSourcesRef.current.clear()
    ttsPlaybackCursorRef.current = 0
    ttsLastChunkIndexRef.current = 0
    ttsPlaybackQueueRef.current = Promise.resolve()
  }

  const playStreamingPcmChunk = async (
    pcmBase64: string,
    sampleRate: number,
    generation: number,
  ) => {
    if (generation !== ttsPlaybackGenerationRef.current) return
    const binary = window.atob(pcmBase64)
    const samples = new Float32Array(Math.floor(binary.length / 2))
    for (let index = 0; index < samples.length; index += 1) {
      const low = binary.charCodeAt(index * 2)
      const high = binary.charCodeAt(index * 2 + 1)
      const value = (high << 8) | low
      samples[index] =
        (value >= 0x8000 ? value - 0x10000 : value) / 0x7fff
    }
    const context =
      ttsPlaybackContextRef.current ??
      new AudioContext({ latencyHint: 'interactive' })
    ttsPlaybackContextRef.current = context
    await context.resume()
    if (generation !== ttsPlaybackGenerationRef.current) return
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(
      context.currentTime + 0.025,
      ttsPlaybackCursorRef.current,
    )
    ttsPlaybackSourcesRef.current.add(source)
    source.addEventListener(
      'ended',
      () => ttsPlaybackSourcesRef.current.delete(source),
      { once: true },
    )
    source.start(startAt)
    ttsPlaybackCursorRef.current = startAt + buffer.duration
  }

  const finishStreamingTtsPlayback = async (generation: number) => {
    await ttsPlaybackQueueRef.current
    const context = ttsPlaybackContextRef.current
    if (!context || generation !== ttsPlaybackGenerationRef.current) return
    const remainingSeconds = Math.max(
      0,
      ttsPlaybackCursorRef.current - context.currentTime,
    )
    if (remainingSeconds > 0) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, remainingSeconds * 1000 + 40),
      )
    }
  }

  useEffect(() => {
    onActionRef.current = onAction
  }, [onAction])

  useEffect(() => {
    setSelectedRunId(null)
    setVisibleRunId(null)
    setExecution(null)
    setDependencyExecutions([])
    setDependencyLoading(false)
    setVadPreviewTime(undefined)
    setAsrPlayRange(undefined)
    setAsrPlaybackTime(0)
    setTtsReferenceClip(null)
    setTtsReferenceText('')
    setTtsReferenceDependencyRunId(null)
    setSpeakerId(
      ['matcha', 'kitten', 'zipvoice', 'pocket-tts', 'supertonic'].includes(
        plugin.adapter,
      )
        ? 0
        : 3,
    )
  }, [plugin.adapter, plugin.id])

  useEffect(() => {
    const container = conversationRef.current
    if (!container || !modelRuns.length) return undefined

    let animationFrame = 0
    const updateVisibleRun = () => {
      const bounds = container.getBoundingClientRect()
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      )
      const exchange = hit?.closest<HTMLElement>('.model-exchange')
      const closestId = exchange?.dataset.runId ?? modelRuns.at(-1)?.id ?? null
      setVisibleRunId((current) =>
        current === closestId ? current : closestId,
      )
    }
    const scheduleVisibleRunUpdate = () => {
      if (animationFrame) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0
        updateVisibleRun()
      })
    }

    scheduleVisibleRunUpdate()
    container.addEventListener('scroll', scheduleVisibleRunUpdate, {
      passive: true,
    })
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      container.removeEventListener('scroll', scheduleVisibleRunUpdate)
    }
  }, [modelRuns])

  useLayoutEffect(() => {
    const container = conversationRef.current
    if (!container) return
    followLatestRunRef.current = true
    container.scrollTop = container.scrollHeight
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [latestRunId, plugin.id])

  useEffect(() => {
    const container = conversationRef.current
    if (!container) return undefined

    const scrollToLatest = () => {
      if (followLatestRunRef.current) {
        container.scrollTop = container.scrollHeight
      }
    }
    const resizeObserver = new ResizeObserver(scrollToLatest)
    resizeObserver.observe(container)
    const latestMessage = container.lastElementChild
    if (latestMessage) resizeObserver.observe(latestMessage)
    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      followLatestRunRef.current = distanceFromBottom < 72
    }

    scrollToLatest()
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('scroll', handleScroll)
    }
  }, [latestRunId, plugin.id])

  useEffect(() => {
    if (!activeAsrTokenKey) return
    const activeToken = Array.from(
      transcriptResultRef.current?.querySelectorAll<HTMLElement>(
        '[data-token-key]',
      ) ?? [],
    ).find((element) => element.dataset.tokenKey === activeAsrTokenKey)
    activeToken?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeAsrTokenKey])

  useEffect(() => {
    outputPreviewRuns.forEach((run) => {
      if (
        run.status !== 'completed' ||
        inlineOutputs[run.id] ||
        requestedPreviewRunsRef.current.has(run.id)
      ) {
        return
      }
      requestedPreviewRunsRef.current.add(run.id)
      void getHarnessRunPreview<RunOutput>(run.id)
        .then((result) => {
          setInlineOutputs((current) =>
            withBoundedEntry(current, run.id, result.output),
          )
        })
        .catch(() => {
          requestedPreviewRunsRef.current.delete(run.id)
        })
    })
  }, [inlineOutputs, outputPreviewRuns])

  useEffect(() => {
    let disposed = false
    const detailRun = selectedRunRef.current
    setAsrPlaybackTime(0)
    if (!detailRun || detailRun.status !== 'completed') {
      setExecution(null)
      setDetailLoading(false)
      return undefined
    }

    const cachedExecution = fullExecutionsRef.current[detailRun.id]
    setExecution(cachedExecution ?? null)
    if (cachedExecution) {
      setDetailLoading(false)
      return undefined
    }
    setDetailLoading(true)
    void getHarnessRunOutput<RunOutput>(detailRun.id)
      .then((result) => {
        if (!disposed) {
          fullExecutionsRef.current = withBoundedEntry(
            fullExecutionsRef.current,
            detailRun.id,
            result,
          )
          setExecution(result)
        }
      })
      .catch((error) => {
        if (!disposed) {
          onActionRef.current(
            `无法读取结果：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .finally(() => {
        if (!disposed) setDetailLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [detailRequestVersion, selectedRun?.id, selectedRun?.status])

  useEffect(() => {
    let disposed = false
    const detailRun = selectedRunRef.current
    const dependencyRunIds = detailRun?.dependencyRunIds ?? []
    setDependencyExecutions([])
    setDependencyLoading(false)
    if (
      !detailRun ||
      detailRun.status !== 'completed' ||
      !dependencyRunIds.length
    ) {
      return undefined
    }

    setDependencyLoading(true)
    void Promise.all(
      dependencyRunIds.map(async (runId) => {
        try {
          return await getHarnessRunOutput<RunOutput>(runId)
        } catch {
          return null
        }
      }),
    )
      .then((results) => {
        if (!disposed) {
          setDependencyExecutions(
            results.filter(
              (result): result is HarnessExecution<RunOutput> => result !== null,
            ),
          )
        }
      })
      .finally(() => {
        if (!disposed) setDependencyLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [
    detailRequestVersion,
    selectedRun?.dependencyRunIds,
    selectedRun?.id,
    selectedRun?.status,
  ])

  useEffect(() => {
    if (!selectedRun) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedRunId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedRun])

  useEffect(() => {
    if (!voiceDialogOpen || voiceCreating) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVoiceDialogOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [voiceCreating, voiceDialogOpen])

  const captionMetrics = () => {
    const startedAt = streamStartAtRef.current
    const elapsedMs = startedAt ? performance.now() - startedAt : 0
    const pushedMs = pushedAudioMsRef.current
    return {
      rtf:
        elapsedMs > 0 && pushedMs > 0
          ? Number((pushedMs / elapsedMs).toFixed(2))
          : undefined,
      vadSilenceMs: 1000,
    }
  }

  useEffect(() => {
    if (!streamingAsrModel) return undefined
    let remove: (() => void) | undefined
    let disposed = false
    void subscribeFunAsrStream((event) => {
      if (event.sessionId !== streamSessionRef.current) return
      const latestText = event.text.trim()
        ? event.text
        : liveTranscriptRef.current
      if (event.kind === 'partial' || event.kind === 'final') {
        liveTranscriptRef.current = event.text
        setLiveTranscript(event.text)
        void publishCaptionOutput(
          event.text,
          event.kind === 'final',
          'speech',
          captionMetrics(),
        )
        return
      }
      if (event.kind === 'completed') {
        streamPushFailedRef.current = true
        void publishCaptionOutput(latestText, true, 'stopped').finally(
          stopCaptionOutput,
        )
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop()
        }
        releaseStreamingAudio()
        streamSessionRef.current = null
        setStreamSessionId(null)
        setStreamingRunId(null)
        setRecording(false)
        setBusy(false)
        onActionRef.current('实时识别已完成')
      } else if (event.kind === 'error') {
        streamPushFailedRef.current = true
        void stopCaptionOutput()
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop()
        }
        releaseStreamingAudio()
        streamSessionRef.current = null
        setStreamSessionId(null)
        setStreamingRunId(null)
        setRecording(false)
        setBusy(false)
        onActionRef.current(event.error || '实时识别失败')
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        remove = unlisten
      }
    })
    return () => {
      disposed = true
      remove?.()
    }
  }, [streamingAsrModel])

  useEffect(() => {
    if (!streamingTtsModel) return undefined
    let remove: (() => void) | undefined
    let disposed = false
    void subscribeCosyVoiceStream((event) => {
      if (event.sessionId !== ttsStreamSessionRef.current) return
      if (event.kind === 'audio' && event.pcmBase64) {
        if (
          event.chunkIndex !== undefined &&
          event.chunkIndex <= ttsLastChunkIndexRef.current
        ) {
          return
        }
        if (event.chunkIndex !== undefined) {
          ttsLastChunkIndexRef.current = event.chunkIndex
        }
        const generation = ttsPlaybackGenerationRef.current
        ttsPlaybackQueueRef.current = ttsPlaybackQueueRef.current.then(() =>
          playStreamingPcmChunk(
            event.pcmBase64 as string,
            event.sampleRate,
            generation,
          ),
        )
        return
      }
      if (event.kind === 'error') {
        ttsStreamSessionRef.current = null
        setStreamingRunId(null)
        setBusy(false)
        stopStreamingTtsPlayback()
        onActionRef.current(event.error || '流式音频生成失败')
      } else {
        const sessionId = event.sessionId
        const generation = ttsPlaybackGenerationRef.current
        void finishStreamingTtsPlayback(generation).then(() => {
          if (
            ttsStreamSessionRef.current !== sessionId ||
            generation !== ttsPlaybackGenerationRef.current
          ) {
            return
          }
          ttsStreamSessionRef.current = null
          setStreamingRunId(null)
          setBusy(false)
          onActionRef.current('流式音频生成完成')
        })
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        remove = unlisten
      }
    })
    return () => {
      disposed = true
      remove?.()
    }
  }, [streamingTtsModel])

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop()
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      releaseStreamingAudio()
      if (streamSessionRef.current) {
        void finishFunAsrStream(streamSessionRef.current)
      }
      if (enhancementSessionRef.current) {
        void finishEnhancementStream(enhancementSessionRef.current)
      }
      stopStreamingTtsPlayback()
      void ttsPlaybackContextRef.current?.close()
      systemAudioUnlistenRef.current?.()
      if (systemAudioSessionRef.current) {
        void stopSystemAudio(systemAudioSessionRef.current)
      }
    },
    [],
  )

  const submitText = async () => {
    const input = text.trim()
    if (!input || !plugin.providerId || busy || recording) return
    if (requiresCustomCosyVoice && !voice.trim()) {
      onAction('CosyVoice v3.5 需要先填写声音复刻或声音设计生成的音色 ID')
      return
    }
    setText('')
    setBusy(true)
    try {
      let synthesisText = input
      const dependencyRunIds = ttsReferenceDependencyRunId
        ? [ttsReferenceDependencyRunId]
        : []
      if (
        capability === 'speech.synthesize' &&
        automaticTextNormalizer?.providerId
      ) {
        const normalized = await onRunText(
          input,
          'text.normalize',
          automaticTextNormalizer.providerId,
          automaticTextNormalizer.version,
          { operator: 'tn', language: 'auto', fullToHalf: true },
          [],
          false,
        )
        const normalizedText = (normalized.output as { text?: unknown }).text
        if (typeof normalizedText === 'string' && normalizedText.trim()) {
          synthesisText = normalizedText.trim()
        }
        dependencyRunIds.push(normalized.run.id)
      }
      if (streamingTtsModel) {
        stopStreamingTtsPlayback()
        const generation = ttsPlaybackGenerationRef.current
        const started = await startCosyVoiceStream({
          text: synthesisText,
          modelId: plugin.version,
          voice,
          speed,
        })
        if (generation !== ttsPlaybackGenerationRef.current) return
        ttsStreamSessionRef.current = started.sessionId
        setStreamingRunId(started.run.id)
        return
      }
      const result = await onRunText(
        input,
        capability as
          | 'speech.synthesize'
          | 'text.generate'
          | 'text.punctuate'
          | 'text.normalize',
        plugin.providerId,
        plugin.version,
        capability === 'text.generate'
          ? { temperature: 0.7, maxTokens: 1024 }
          : capability === 'speech.synthesize'
            ? {
              speed,
              ...(synthesisText !== input ? { synthesisText } : {}),
              ...(apiModel ? { voice } : {}),
              ...(!apiModel
                ? { sid: supportsSpeakerSelection ? speakerId : 0 }
                : {}),
              ...(supportsTtsLanguage ? { language: ttsLanguage } : {}),
              ...(ttsReferenceClip?.transcriptionAudioUrl
                ? {
                    referenceAudioDataUrl:
                      ttsReferenceClip.transcriptionAudioUrl,
                  }
                : {}),
              ...(requiresTtsReferenceText
                ? { referenceText: ttsReferenceText.trim() }
                : {}),
              }
            : capability === 'text.normalize'
              ? {
                operator: wetextOperator,
                language: wetextLanguage,
                fullToHalf: wetextFullToHalf,
              }
              : {},
        dependencyRunIds,
      )
      setInlineOutputs((current) =>
        withBoundedEntry(current, result.run.id, result.output),
      )
    } catch (error) {
      setText((current) => current || input)
      onAction(
        `运行失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (!ttsStreamSessionRef.current) setBusy(false)
    }
  }

  const transcribeTtsReferenceAudio = async (
    clip = ttsReferenceClip,
    modelId = referenceAsrModelId,
    overwrite = false,
  ) => {
    const asrModel = referenceAsrModels.find(
      (candidate) => candidate.id === modelId,
    )
    if (!clip || !asrModel?.providerId) {
      return
    }
    const requestId = referenceTranscriptionRequestRef.current + 1
    referenceTranscriptionRequestRef.current = requestId
    setTtsReferenceDependencyRunId(null)
    if (overwrite) ttsReferenceTextEditedRef.current = false
    setReferenceTranscribing(true)
    try {
      const result = await onRunAudio(
        clip,
        'speech.transcribe',
        asrModel.providerId,
        asrModel.version,
        { language: 'auto' },
        false,
      )
      if (!isAsrOutput(result.output)) {
        throw new Error('识别模型没有返回文本')
      }
      if (
        requestId === referenceTranscriptionRequestRef.current &&
        !ttsReferenceTextEditedRef.current
      ) {
        setTtsReferenceDependencyRunId(result.run.id)
        setTtsReferenceText(result.output.text)
        onAction('参考文本已自动识别，可继续修改')
      }
    } catch (error) {
      if (requestId === referenceTranscriptionRequestRef.current) {
        onAction(
          `参考音频识别失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    } finally {
      if (requestId === referenceTranscriptionRequestRef.current) {
        setReferenceTranscribing(false)
      }
    }
  }

  const prepareTtsReferenceAudio = async (file: File) => {
    try {
      const clip = await audioFileToClip(file)
      setTtsReferenceClip(clip)
      setTtsReferenceText('')
      setTtsReferenceDependencyRunId(null)
      ttsReferenceTextEditedRef.current = false
      void transcribeTtsReferenceAudio(clip)
    } catch (error) {
      onAction(
        `无法读取参考音频：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const createCloudVoice = async () => {
    if (voiceCreating) return
    setVoiceDialogError('')
    const audioDataUrl = ttsReferenceClip?.transcriptionAudioUrl
    if (voiceCreationMode === 'clone' && !audioDataUrl) {
      setVoiceDialogError('请先上传或录制参考音频')
      return
    }
    if (voiceCreationMode === 'design' && voicePrompt.trim().length < 10) {
      setVoiceDialogError('声音描述至少输入 10 个字')
      return
    }
    if (voiceCreationMode === 'design' && voicePreviewText.trim().length < 2) {
      setVoiceDialogError('试听文本至少输入 2 个字')
      return
    }
    setVoiceCreating(true)
    try {
      const created = await createBailianVoice({
        targetModel: plugin.version,
        mode: voiceCreationMode,
        prefix: voicePrefix,
        language: voiceLanguage,
        audioDataUrl,
        voicePrompt: voicePrompt.trim() || undefined,
        previewText: voicePreviewText.trim() || undefined,
      })
      const option = {
        id: created.id,
        name: voicePrefix,
        description:
          voiceCreationMode === 'clone' ? '复刻音色' : '设计音色',
        custom: true,
      }
      setCustomVoices((current) => {
        const next = [
          option,
          ...current.filter((item) => item.id !== created.id),
        ]
        cacheCustomVoices(next)
        return next
      })
      selectVoice(created.id)
      setVoiceDialogOpen(false)
      onAction('音色已创建并选中')
    } catch (error) {
      setVoiceDialogError(
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setVoiceCreating(false)
    }
  }

  const deleteCloudVoice = async (voiceId: string, name: string) => {
    if (!window.confirm(`确定删除音色“${name}”吗？删除后无法恢复。`)) return
    try {
      await deleteBailianVoice(voiceId)
      setCustomVoices((current) => {
        const next = current.filter((item) => item.id !== voiceId)
        cacheCustomVoices(next)
        return next
      })
      if (voice === voiceId) {
        selectVoice(voiceOptions[0]?.id ?? '')
      }
      onAction('音色已删除')
    } catch (error) {
      onAction(
        `删除音色失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const submitAudio = async (file: File) => {
    if (
      !plugin.providerId ||
      !capabilityAcceptsAudio(capability) ||
      busy
    ) {
      return
    }
    if (!providerReady) {
      onAction(
        apiModel
          ? `请先配置 ${plugin.name} 的 API Key`
          : `请先在模型商店启用 ${plugin.name}`,
      )
      onOpenStore()
      return
    }
    setBusy(true)
    onAction('正在准备音频…')
    try {
      const clip = await audioFileToClip(file)
      let speechSegments: VadDetectionResult['segments'] | undefined
      let dependencyRunIds: string[] = []
      if (
        capability === 'speech.transcribe' &&
        automaticVadModel?.providerId
      ) {
        const preprocessed = await onRunAudio(
          clip,
          'speech.detect',
          automaticVadModel.providerId,
          automaticVadModel.version,
          {},
          false,
        )
        dependencyRunIds = [preprocessed.run.id]
        if (!('segments' in preprocessed.output)) {
          throw new Error(`${automaticVadModel.name} 没有返回可用的语音片段`)
        }
        speechSegments = (preprocessed.output as VadDetectionResult).segments
        if (!speechSegments.length) {
          throw new Error(`${automaticVadModel.name} 没有检测到可识别的语音`)
        }
      }
      const result = await onRunAudio(
        clip,
        capability as
          | 'speech.transcribe'
          | 'speech.detect'
          | 'audio.enhance'
          | 'audio.classify'
          | 'speech.keyword'
          | 'speech.language'
          | 'speaker.embed'
          | 'speaker.diarize'
          | 'audio.separate',
        plugin.providerId,
        plugin.version,
        capability === 'speech.keyword'
          ? {
              keywords: keywords
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : funAsrModel
          ? {
              language: asrLanguage,
              context: asrContext,
              semanticPunctuation,
              ...(speechSegments ? { speechSegments } : {}),
            }
          : qwen3AsrModel
          ? {
              hotwords: asrContext,
              ...(speechSegments ? { speechSegments } : {}),
            }
          : canaryModel
          ? {
              sourceLanguage: asrLanguage,
              targetLanguage: asrTargetLanguage,
              punctuation: semanticPunctuation,
              ...(speechSegments ? { speechSegments } : {}),
            }
          : capability === 'audio.enhance'
          ? {
              operations: ['denoise'],
              denoiseStrength,
            }
          : speechSegments
            ? { speechSegments }
            : {},
        true,
        dependencyRunIds,
      )
      setAttachments((current) =>
        withBoundedAttachment(current, result.run.id, clip),
      )
      setInlineOutputs((current) =>
        withBoundedEntry(current, result.run.id, result.output),
      )
      if (speechSegments && automaticVadModel) {
        setAutomaticSegmentationByRunId((current) => ({
          ...current,
          [result.run.id]: {
            engine: automaticVadModel.name,
            segmentCount: speechSegments.length,
          },
        }))
      }
    } catch (error) {
      onAction(
        `运行失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setBusy(false)
    }
  }

  const startRecording = async (
    target: 'primary' | 'tts-reference' = 'primary',
  ) => {
    try {
      const stream = await getMicrophoneStream({
          channelCount: 1,
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
      })
      const recorder = new MediaRecorder(stream)
      recordingStreamRef.current = stream
      recorderRef.current = recorder
      recordingChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        recorderRef.current = null
        setRecording(false)
        setRecordingTarget(null)
        if (cancelRecordingRef.current) {
          cancelRecordingRef.current = false
          return
        }
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        const file = new File(
          [blob],
          `${target === 'tts-reference' ? '参考音频' : '录音'}-${Date.now()}.webm`,
          {
          type: blob.type,
          },
        )
        if (target === 'tts-reference') {
          void prepareTtsReferenceAudio(file)
        } else {
          void submitAudio(file)
        }
      }
      recorder.start(250)
      setRecordingTarget(target)
      setRecording(true)
    } catch (error) {
      setRecordingTarget(null)
      onAction(
        `无法开始录音：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  const cancelActiveRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      cancelRecordingRef.current = true
      recorderRef.current.stop()
    }
    recordingStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop())
    recordingStreamRef.current = null
    recorderRef.current = null
    recordingChunksRef.current = []
    setRecording(false)
    setRecordingTarget(null)
  }

  // Cancel mic recording and any streaming session when switching models, so
  // the input state doesn't carry over to the next model.
  useEffect(() => {
    cancelActiveRecording()
    const sessionId = streamSessionRef.current
    if (sessionId) {
      void finishFunAsrStream(sessionId).catch(() => {})
      streamSessionRef.current = null
      setStreamSessionId(null)
      setStreamingRunId(null)
      setBusy(false)
    }
    // Only run when the selected model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id])

  const startSystemRecording = async () => {
    try {
      setMonitorLatencyMs(null)
      systemAudioChunksRef.current = []
      systemAudioRunIdRef.current = null
      streamPushQueueRef.current = Promise.resolve()
      enhancementQueueDepthRef.current = 0
      streamPushFailedRef.current = false
      if (streamingAsrModel) {
        const started = await startFunAsrStream({
          clipName: `电脑音频-${Date.now()}`,
          providerId: plugin.providerId,
          modelId: plugin.version,
          sampleRate: 48_000,
          language: asrLanguage,
          context: asrContext,
          semanticPunctuation,
        })
        streamSessionRef.current = started.sessionId
        setStreamSessionId(started.sessionId)
        setStreamingRunId(started.run.id)
        systemAudioRunIdRef.current = started.run.id
        liveTranscriptRef.current = ''
        setLiveTranscript('')
      } else if (streamingEnhanceModel && plugin.providerId) {
        const started = await startEnhancementStream(
          plugin.providerId,
          48_000,
          denoiseStrength,
        )
        enhancementSessionRef.current = started.sessionId
      }
      const unlisten = await subscribeSystemAudio((chunk) => {
        const activeSession = systemAudioSessionRef.current
        if (activeSession && chunk.sessionId !== activeSession) return
        if (!streamingEnhanceModel) {
          systemAudioChunksRef.current.push(chunk.pcmBase64)
        }
        const asrSession = streamSessionRef.current
        if (streamingAsrModel && asrSession) {
          streamPushQueueRef.current = streamPushQueueRef.current
            .then(() => pushFunAsrStream(asrSession, chunk.pcmBase64))
            .catch((error) => {
              streamPushFailedRef.current = true
              onActionRef.current(
                `电脑音频流发送失败：${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            })
        } else if (
          streamingEnhanceModel &&
          enhancementSessionRef.current
        ) {
          if (enhancementQueueDepthRef.current >= 12) return
          enhancementQueueDepthRef.current += 1
          const enhancementSession = enhancementSessionRef.current
          const capturedAt = performance.now()
          streamPushQueueRef.current = streamPushQueueRef.current
            .then(async () => {
              const output = await pushEnhancementStream(
                enhancementSession,
                chunk.pcmBase64,
              )
              if (
                output.pcmBase64
              ) {
                const sessionId = systemAudioSessionRef.current
                if (sessionId) {
                  await playSystemAudioChunk(sessionId, output.pcmBase64)
                  const latency = performance.now() - capturedAt
                  setMonitorLatencyMs((current) =>
                    Math.round(
                      current === null
                        ? latency
                        : current * 0.8 + latency * 0.2,
                    ),
                  )
                }
              }
            })
            .catch((error) => {
              streamPushFailedRef.current = true
              onActionRef.current(
                `电脑音频实时增强失败：${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            })
            .finally(() => {
              enhancementQueueDepthRef.current = Math.max(
                0,
                enhancementQueueDepthRef.current - 1,
              )
            })
        }
      })
      systemAudioUnlistenRef.current = unlisten
      const session = await startSystemAudio(streamingEnhanceModel)
      systemAudioSessionRef.current = session.sessionId
      setRecording(true)
      onAction(
        streamingEnhanceModel
          ? '电脑音频监听已开始'
          : '电脑音频采集已开始',
      )
    } catch (error) {
      if (streamSessionRef.current) {
        void finishFunAsrStream(streamSessionRef.current)
        streamSessionRef.current = null
        setStreamSessionId(null)
      }
      if (enhancementSessionRef.current) {
        void finishEnhancementStream(enhancementSessionRef.current)
        enhancementSessionRef.current = null
      }
      if (streamingEnhanceModel) {
        stopStreamingTtsPlayback()
        void ttsPlaybackContextRef.current?.close()
        ttsPlaybackContextRef.current = null
      }
      systemAudioUnlistenRef.current?.()
      systemAudioUnlistenRef.current = null
      onAction(
        `无法采集电脑音频：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const stopSystemRecording = async () => {
    const sessionId = systemAudioSessionRef.current
    if (!sessionId) return
    setRecording(false)
    try {
      await stopSystemAudio(sessionId)
      if (
        streamingEnhanceModel &&
        enhancementSessionRef.current
      ) {
        await streamPushQueueRef.current
        await finishEnhancementStream(enhancementSessionRef.current)
        enhancementSessionRef.current = null
        onAction('实时监听已停止')
      } else {
        const file = pcm16ChunksToWavFile(
          systemAudioChunksRef.current,
          48_000,
          `电脑音频-${Date.now()}.wav`,
        )
        if (file.size <= 44) {
          throw new Error('没有捕获到可用音频，请确认 Chrome 正在播放声音')
        }
        if (streamingAsrModel && streamSessionRef.current) {
        await streamPushQueueRef.current
        const clip = await audioFileToClip(file)
        const runId = systemAudioRunIdRef.current
        if (runId) {
          setAttachments((current) =>
            withBoundedAttachment(current, runId, clip),
          )
        }
        await finishFunAsrStream(streamSessionRef.current)
        } else {
          await submitAudio(file)
        }
      }
    } catch (error) {
      onAction(
        `电脑音频处理失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      systemAudioSessionRef.current = null
      if (!streamingAsrModel) {
        streamSessionRef.current = null
        setStreamSessionId(null)
      }
      systemAudioChunksRef.current = []
      enhancementQueueDepthRef.current = 0
      systemAudioRunIdRef.current = null
      systemAudioUnlistenRef.current?.()
      systemAudioUnlistenRef.current = null
      enhancementSessionRef.current = null
      setMonitorLatencyMs(null)
      if (streamingEnhanceModel) {
        stopStreamingTtsPlayback()
        void ttsPlaybackContextRef.current?.close()
        ttsPlaybackContextRef.current = null
      }
    }
  }

  const startStreamingRecording = async () => {
    let sessionId: string | null = null
    try {
      streamStartAtRef.current = performance.now()
      pushedAudioMsRef.current = 0
      const stream = await getMicrophoneStream({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
      })
      recordingStreamRef.current = stream
      const started = await startFunAsrStream({
        clipName: `实时录音-${Date.now()}`,
        providerId: plugin.providerId,
        modelId: plugin.version,
        sampleRate: 16_000,
        language: asrLanguage,
        context: asrContext,
        semanticPunctuation,
      })
      sessionId = started.sessionId
      streamSessionRef.current = sessionId
      setStreamSessionId(sessionId)
      setStreamingRunId(started.run.id)
      liveTranscriptRef.current = ''
      setLiveTranscript('')
      setSelectedRunId(null)
      streamPushFailedRef.current = false
      streamPushQueueRef.current = Promise.resolve()

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recordingChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        const file = new File([blob], `实时录音-${Date.now()}.webm`, {
          type: blob.type,
        })
        recorderRef.current = null
        void audioFileToClip(file)
          .then((clip) => {
            setAttachments((current) =>
              withBoundedAttachment(current, started.run.id, clip),
            )
          })
          .catch((error) => {
            onActionRef.current(
              `无法准备录音回放：${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          })
      }
      recorder.start(250)

      const audioContext = new AudioContext({ latencyHint: 'interactive' })
      await audioContext.resume()
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const gain = audioContext.createGain()
      gain.gain.value = 0
      processor.onaudioprocess = (event) => {
        const activeSession = streamSessionRef.current
        if (!activeSession || streamPushFailedRef.current) return
        const pcmBase64 = pcm16Base64(
          event.inputBuffer.getChannelData(0),
          audioContext.sampleRate,
        )
        pushedAudioMsRef.current +=
          (event.inputBuffer.length / audioContext.sampleRate) * 1000
        streamPushQueueRef.current = streamPushQueueRef.current
          .then(() => pushFunAsrStream(activeSession, pcmBase64))
          .catch((error) => {
            if (streamPushFailedRef.current) return
            streamPushFailedRef.current = true
            onActionRef.current(
              `实时音频发送失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          })
      }
      source.connect(processor)
      processor.connect(gain)
      gain.connect(audioContext.destination)
      streamAudioContextRef.current = audioContext
      streamSourceRef.current = source
      streamProcessorRef.current = processor
      streamGainRef.current = gain
      setRecording(true)
      onAction('已开始实时识别')
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      recordingStreamRef.current = null
      if (sessionId) {
        void finishFunAsrStream(sessionId)
      }
      streamSessionRef.current = null
      setStreamSessionId(null)
      setStreamingRunId(null)
      onAction(
        `无法开始实时识别：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const stopStreamingRecording = async () => {
    const sessionId = streamSessionRef.current
    if (!sessionId) return
    setRecording(false)
    setBusy(true)
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
    releaseStreamingAudio()
    try {
      await streamPushQueueRef.current
      await finishFunAsrStream(sessionId)
    } catch (error) {
      streamSessionRef.current = null
      setStreamSessionId(null)
      setBusy(false)
      onAction(
        `无法结束实时识别：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const downloadAudioResult = (
    output: TtsGenerateResult | AudioProcessResult,
  ) => {
    const anchor = document.createElement('a')
    anchor.href = output.dataUrl
    anchor.download = output.fileName
    anchor.click()
    onAction(`${output.fileName} 已导出`)
  }

  return (
    <main
      className={`model-workspace${selectedRun ? ' detail-open' : ''}`}
      style={
        {
          '--model-detail-width': `${selectedRun ? detailWidth : 0}px`,
        } as CSSProperties
      }
    >
      <header
        className="model-workspace-heading"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as HTMLElement).closest('button, input, select, textarea')
          ) {
            return
          }
          void getCurrentWindow().startDragging().catch(() => undefined)
        }}
      >
        <div data-tauri-drag-region>
          <h1 data-tauri-drag-region>{plugin.name}</h1>
          <p data-tauri-drag-region>
            {capabilityLabel(capability)} · {plugin.runtime} ·{' '}
            {provider?.models.find((model) => model.loaded)?.name ??
              plugin.version}
          </p>
        </div>
        {selectedRun && (
          <button
            className="icon-button result-detail-close"
            type="button"
            title="收起详情"
            aria-label="收起详情"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setSelectedRunId(null)}
          >
            <PanelLeftClose size={15} strokeWidth={1.8} />
          </button>
        )}
      </header>

      <section className="model-conversation">

        {modelRuns.length > 0 && (
          <nav className="conversation-index" aria-label="对话记录导航">
            {modelRuns.map((run) => (
              <button
                type="button"
                key={run.id}
                className={visibleRunId === run.id ? 'current' : undefined}
                data-preview={run.inputSummary || run.title}
                title={run.inputSummary || run.title}
                aria-label={`跳转到 ${run.inputSummary || run.title}`}
                onClick={() => {
                  document
                    .getElementById(`model-exchange-${run.id}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              />
            ))}
          </nav>
        )}

        <div ref={conversationRef} className="model-message-list">
          {!modelRuns.length && (
            <div className="model-empty-conversation">
              <span className={`model-avatar tone-${plugin.tone}`}>
                <Icon size={22} />
              </span>
              <h2>开始使用 {plugin.name}</h2>
              <p>{plugin.description}</p>
              {!providerReady && (
                <button
                  className="secondary-action"
                  type="button"
                  onClick={onOpenStore}
                >
                  {apiModel ? '配置 API' : '打开模型商店'}
                </button>
              )}
            </div>
          )}

          {modelRuns.map((run) => {
            const inlineOutput = inlineOutputs[run.id]
            const inlineAudioUrl =
              inlineOutput &&
              'dataUrl' in inlineOutput &&
              typeof inlineOutput.dataUrl === 'string'
                ? inlineOutput.dataUrl
                : inlineOutput &&
                    'filePath' in inlineOutput &&
                    typeof inlineOutput.filePath === 'string'
                  ? convertFileSrc(inlineOutput.filePath)
                  : undefined
            const inlineAudioDuration =
              inlineOutput &&
              'duration' in inlineOutput &&
              typeof inlineOutput.duration === 'number'
                ? inlineOutput.duration
                : 0
            const inputAudio = attachments[run.id]
            const inputAudioUrl =
              inputAudio?.url ??
              inputAudio?.transcriptionAudioUrl ??
              (inlineOutput &&
              'sourceAudioDataUrl' in inlineOutput &&
              typeof inlineOutput.sourceAudioDataUrl === 'string'
                ? inlineOutput.sourceAudioDataUrl
                : inlineOutput &&
                    'sourceAudioFilePath' in inlineOutput &&
                    typeof inlineOutput.sourceAudioFilePath === 'string'
                  ? convertFileSrc(inlineOutput.sourceAudioFilePath)
                : undefined)
            const inputAudioDuration =
              inputAudio?.duration ??
              (inlineOutput &&
              'duration' in inlineOutput &&
              typeof inlineOutput.duration === 'number'
                ? inlineOutput.duration
                : 0)
            return (
              <div
                className="model-exchange"
                data-run-id={run.id}
                id={`model-exchange-${run.id}`}
                key={run.id}
              >
                <div className="model-user-message">
                  <div>
                    <strong>{run.inputSummary || run.title}</strong>
                    {inputAudioUrl && (
                      <div className="model-user-audio">
                        <InlineAudioPlayer
                          src={inputAudioUrl}
                          duration={inputAudioDuration}
                        />
                      </div>
                    )}
                    <small>{formatCreatedAt(run.createdAt)}</small>
                  </div>
                </div>
                <article
                  className={`model-result-message status-${run.status}${inlineAudioUrl && run.status === 'completed' ? ' audio-output-preview' : ''}${selectedRunId === run.id ? ' selected' : ''}`}
                >
                  {!(inlineAudioUrl && run.status === 'completed') && (
                    <button
                      className="model-result-summary"
                      type="button"
                      onClick={() => openRunDetail(run.id)}
                    >
                      <span className="model-result-copy">
                        {run.status === 'completed' && inlineOutput ? (
                          <>
                            <p>{genericOutputPreview(inlineOutput)}</p>
                            <small>
                              {isAsrOutput(inlineOutput)
                                ? inlineOutput.language
                                : isVadOutput(inlineOutput)
                                  ? `语音 ${inlineOutput.speechSeconds.toFixed(1)}s · 点击查看片段`
                                  : '点击查看结果详情'}
                            </small>
                          </>
                        ) : (
                          <>
                            <strong>{statusLabels[run.status]}</strong>
                            <small>
                              {run.error ||
                                run.activity ||
                                run.providerName}
                            </small>
                          </>
                        )}
                      </span>
                      <span className="model-result-time">
                        {run.durationMs
                          ? `${(run.durationMs / 1000).toFixed(1)}s`
                          : ''}
                      </span>
                    </button>
                  )}
                  {inlineAudioUrl && (
                    <div className="model-inline-audio">
                      <InlineAudioPlayer
                        src={inlineAudioUrl}
                        duration={inlineAudioDuration}
                      />
                      <button
                        className="audio-output-detail-button"
                        type="button"
                        title="查看波形与频谱"
                        aria-label="查看波形与频谱"
                        onClick={() => openRunDetail(run.id)}
                      >
                        <SlidersHorizontal size={14} />
                      </button>
                    </div>
                  )}
                  {streamingRunId === run.id && (
                    <div className="model-live-transcript" aria-live="polite">
                      <span>
                        <i />
                        {streamingTtsModel ? '正在流式播放' : '实时转写'}
                      </span>
                      <p>
                        {streamingTtsModel
                          ? '音频生成后立即播放'
                          : liveTranscript || '正在聆听…'}
                      </p>
                    </div>
                  )}
                  {streamingRunId === run.id && (
                    <button
                      className="model-result-caption-button"
                      type="button"
                      title="弹出字幕"
                      aria-label="弹出字幕"
                      onClick={() => {
                        void showCaptionOutput()
                        if (liveTranscript) {
                          void publishCaptionOutput(
                            liveTranscript,
                            false,
                            'speech',
                            captionMetrics(),
                          )
                        }
                      }}
                    >
                      <Captions size={16} />
                    </button>
                  )}
                </article>
              </div>
            )
          })}
        </div>

        <footer className="model-composer">
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void submitAudio(file)
              event.target.value = ''
            }}
          />
          <input
            ref={ttsReferenceInputRef}
            className="visually-hidden"
            type="file"
            accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void prepareTtsReferenceAudio(file)
              event.target.value = ''
            }}
          />

          {capabilityMeta.composer === 'text' ? (
            <>
              {capability === 'speech.synthesize' &&
                (apiModel ||
                  supportsSpeakerSelection ||
                  supportsTtsLanguage ||
                  !requiresTtsReferenceAudio) && (
                <div className="model-parameter-bar">
                  {apiModel && (
                    <label className="voice-parameter-field">
                      <span>音色</span>
                      <VoiceCombobox
                        value={voice}
                        options={availableVoiceOptions}
                        placeholder={
                          requiresCustomCosyVoice
                            ? '声音复刻或声音设计音色 ID'
                            : '搜索音色或粘贴自定义 ID'
                        }
                        onChange={selectVoice}
                        onCreate={
                          supportsCloudVoiceCreation
                            ? () => {
                                setVoiceCreationMode('clone')
                                setTtsReferenceClip(null)
                                setVoiceDialogError('')
                                setVoiceDialogOpen(true)
                              }
                            : undefined
                        }
                        onDelete={(option) =>
                          void deleteCloudVoice(option.id, option.name)
                        }
                      />
                    </label>
                  )}
                  {supportsSpeakerSelection && (
                    <label>
                      <span>音色 ID</span>
                      <input
                        type="number"
                        min={0}
                        max={speakerCount - 1}
                        value={speakerId}
                        onChange={(event) =>
                          setSpeakerId(Number(event.target.value))
                        }
                      />
                      <small>0-{speakerCount - 1}</small>
                    </label>
                  )}
                  {supportsTtsLanguage && (
                    <label>
                      <span>语言</span>
                      <select
                        value={ttsLanguage}
                        onChange={(event) =>
                          setTtsLanguage(event.target.value)
                        }
                      >
                        <option value="en">English</option>
                        <option value="ar">العربية</option>
                        <option value="bg">Български</option>
                        <option value="hr">Hrvatski</option>
                        <option value="cs">Čeština</option>
                        <option value="da">Dansk</option>
                        <option value="nl">Nederlands</option>
                        <option value="et">Eesti</option>
                        <option value="fi">Suomi</option>
                        <option value="fr">Français</option>
                        <option value="de">Deutsch</option>
                        <option value="el">Ελληνικά</option>
                        <option value="hi">हिन्दी</option>
                        <option value="hu">Magyar</option>
                        <option value="id">Bahasa Indonesia</option>
                        <option value="it">Italiano</option>
                        <option value="ja">日本語</option>
                        <option value="ko">한국어</option>
                        <option value="lv">Latviešu</option>
                        <option value="lt">Lietuvių</option>
                        <option value="pl">Polski</option>
                        <option value="pt">Português</option>
                        <option value="ro">Română</option>
                        <option value="ru">Русский</option>
                        <option value="sk">Slovenčina</option>
                        <option value="sl">Slovenščina</option>
                        <option value="es">Español</option>
                        <option value="sv">Svenska</option>
                        <option value="tr">Türkçe</option>
                        <option value="uk">Українська</option>
                        <option value="vi">Tiếng Việt</option>
                      </select>
                    </label>
                  )}
                  {!requiresTtsReferenceAudio && (
                    <label>
                      <span>语速</span>
                      <select
                        value={speed}
                        onChange={(event) =>
                          setSpeed(Number(event.target.value))
                        }
                      >
                        <option value={0.8}>0.8x</option>
                        <option value={1}>1.0x</option>
                        <option value={1.2}>1.2x</option>
                        <option value={1.5}>1.5x</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
              {capability === 'speech.synthesize' &&
                requiresTtsReferenceAudio && (
                <div
                  className={`tts-reference-stack${requiresTtsReferenceText ? ' inline' : ''}`}
                >
                  <AudioFileDropZone
                    disabled={busy || recording}
                    onFile={(file) => void prepareTtsReferenceAudio(file)}
                    onInvalidFile={onAction}
                  >
                    <div className="tts-reference-input">
                      <div className="tts-reference-heading">
                        <FileAudio size={15} />
                        <span>
                          <strong>{ttsReferenceAudioLabel}</strong>
                          {(recordingTarget === 'tts-reference' ||
                            ttsReferenceClip) && (
                            <small>
                              {recordingTarget === 'tts-reference'
                                ? '正在通过麦克风录制'
                                : ttsReferenceClip?.name}
                            </small>
                          )}
                        </span>
                      </div>
                      {recordingTarget === 'tts-reference' && (
                        <RecordingWaveform
                          active
                          stream={recordingStreamRef.current}
                          label="参考音频录制中"
                        />
                      )}
                      {ttsReferenceClip?.url &&
                        recordingTarget !== 'tts-reference' && (
                          <InlineAudioPlayer
                            src={ttsReferenceClip.url}
                            duration={ttsReferenceClip.duration}
                          />
                        )}
                      <div className="tts-reference-actions">
                        <button
                          type="button"
                          title="上传参考音频"
                          aria-label="上传参考音频"
                          disabled={busy || recording}
                          onClick={() => ttsReferenceInputRef.current?.click()}
                        >
                          <Upload size={15} />
                          <span>上传</span>
                        </button>
                        <button
                          className={
                            recordingTarget === 'tts-reference'
                              ? 'active'
                              : ''
                          }
                          type="button"
                          title={
                            recordingTarget === 'tts-reference'
                              ? '停止录制'
                              : '录制参考音频'
                          }
                          aria-label={
                            recordingTarget === 'tts-reference'
                              ? '停止录制'
                              : '录制参考音频'
                          }
                          disabled={busy}
                          onClick={() =>
                            recordingTarget === 'tts-reference'
                              ? stopRecording()
                              : void startRecording('tts-reference')
                          }
                        >
                          {recordingTarget === 'tts-reference' ? (
                            <CircleStop size={15} />
                          ) : (
                            <Mic size={15} />
                          )}
                          <span>
                            {recordingTarget === 'tts-reference'
                              ? '停止'
                              : '录制'}
                          </span>
                        </button>
                        {ttsReferenceClip &&
                          recordingTarget !== 'tts-reference' && (
                            <button
                              className="remove"
                              type="button"
                              title="清除参考音频"
                              onClick={() => setTtsReferenceClip(null)}
                            >
                              <X size={15} />
                            </button>
                          )}
                      </div>
                    </div>
                  </AudioFileDropZone>
                  {requiresTtsReferenceText && (
                    <div className="tts-reference-text-field">
                      <label className="context-field">
                        <span>参考文本</span>
                        <input
                          value={ttsReferenceText}
                          placeholder="识别后可继续修改"
                          onChange={(event) =>
                            {
                              ttsReferenceTextEditedRef.current = true
                              setTtsReferenceText(event.target.value)
                            }
                          }
                        />
                      </label>
                    </div>
                  )}
                  <label className="tts-reference-speed-field">
                    <span>语速</span>
                    <select
                      value={speed}
                      onChange={(event) => setSpeed(Number(event.target.value))}
                    >
                      <option value={0.8}>0.8x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.2}>1.2x</option>
                      <option value={1.5}>1.5x</option>
                    </select>
                  </label>
                </div>
                )}
              {capability === 'text.normalize' && (
                <div className="model-parameter-bar">
                  <label>
                    <span>模式</span>
                    <select
                      value={wetextOperator}
                      onChange={(event) =>
                        setWetextOperator(event.target.value as 'tn' | 'itn')
                      }
                    >
                      <option value="tn">TN · 适合合成</option>
                      <option value="itn">ITN · 适合识别</option>
                    </select>
                  </label>
                  <label>
                    <span>语言</span>
                    <select
                      value={wetextLanguage}
                      onChange={(event) => setWetextLanguage(event.target.value)}
                    >
                      <option value="auto">自动</option>
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                      <option value="ja">日本語</option>
                    </select>
                  </label>
                  <label className="parameter-check">
                    <input
                      type="checkbox"
                      checked={wetextFullToHalf}
                      onChange={(event) =>
                        setWetextFullToHalf(event.target.checked)
                      }
                    />
                    <span>半角字符</span>
                  </label>
                </div>
              )}
              {capability === 'text.generate' && onClearTextHistory && (
                <div className="text-composer-toolbar">
                  <button
                    className="text-composer-clear"
                    type="button"
                    onClick={() => {
                      onClearTextHistory()
                      setText('')
                    }}
                  >
                    新对话
                  </button>
                </div>
              )}
              <div className="text-model-composer">
                <textarea
                  value={text}
                  rows={2}
                  maxLength={
                    capability === 'text.generate' ? undefined : 1200
                  }
                  placeholder={
                    capability === 'text.generate'
                      ? `给 ${plugin.name} 发送消息…`
                      : capability === 'text.normalize'
                        ? '输入需要归一化的文本…'
                      : `给 ${plugin.name} 输入要生成的文字…`
                  }
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault()
                      void submitText()
                    }
                  }}
                />
                <button
                  className="composer-send"
                  type="button"
                  title={
                    capability === 'speech.synthesize' ? '生成语音' : '发送'
                  }
                  aria-label={
                    capability === 'speech.synthesize' ? '生成语音' : '发送'
                  }
                  disabled={
                    !text.trim() ||
                    busy ||
                    recording ||
                    referenceTranscribing ||
                    !providerReady ||
                    (requiresTtsReferenceAudio &&
                      !ttsReferenceClip?.transcriptionAudioUrl) ||
                    (requiresTtsReferenceText &&
                      !ttsReferenceText.trim())
                  }
                  onClick={() => void submitText()}
                >
                  {busy ? (
                    <LoaderCircle className="model-spin" size={18} />
                  ) : (
                    <ArrowUp size={17} strokeWidth={2.2} />
                  )}
                </button>
              </div>
            </>
          ) : (
            <AudioFileDropZone
              disabled={busy || recording}
              onFile={(file) => void submitAudio(file)}
              onInvalidFile={onAction}
            >
              <div className="audio-input-stack">
              {funAsrModel && (
                <div className="model-parameter-bar funasr-parameters">
                  <label>
                    <span>语言</span>
                    <select
                      value={asrLanguage}
                      onChange={(event) => setAsrLanguage(event.target.value)}
                    >
                      <option value="auto">自动识别</option>
                      <option value="zh">中文</option>
                      <option value="en">英文</option>
                      <option value="ja">日语</option>
                      <option value="ko">韩语</option>
                    </select>
                  </label>
                  <label className="context-field">
                    <span>上下文</span>
                    <input
                      value={asrContext}
                      maxLength={400}
                      placeholder="人名、术语或对话背景"
                      onChange={(event) => setAsrContext(event.target.value)}
                    />
                  </label>
                  <label className="parameter-check">
                    <input
                      type="checkbox"
                      checked={semanticPunctuation}
                      onChange={(event) =>
                        setSemanticPunctuation(event.target.checked)
                      }
                    />
                    <span>语义断句</span>
                  </label>
                </div>
              )}
              {qwen3AsrModel && (
                <div className="model-parameter-bar">
                  <label className="context-field">
                    <span>热词</span>
                    <input
                      value={asrContext}
                      maxLength={400}
                      placeholder="人名、术语，多个词用逗号分隔"
                      onChange={(event) => setAsrContext(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {canaryModel && (
                <div className="model-parameter-bar funasr-parameters">
                  <label>
                    <span>输入语言</span>
                    <select
                      value={asrLanguage === 'auto' ? 'en' : asrLanguage}
                      onChange={(event) => setAsrLanguage(event.target.value)}
                    >
                      <option value="en">English</option>
                      <option value="es">Español</option>
                      <option value="de">Deutsch</option>
                      <option value="fr">Français</option>
                    </select>
                  </label>
                  <label>
                    <span>输出语言</span>
                    <select
                      value={asrTargetLanguage}
                      onChange={(event) =>
                        setAsrTargetLanguage(event.target.value)
                      }
                    >
                      <option value="en">English</option>
                      <option value="es">Español</option>
                      <option value="de">Deutsch</option>
                      <option value="fr">Français</option>
                    </select>
                  </label>
                  <label className="parameter-check">
                    <input
                      type="checkbox"
                      checked={semanticPunctuation}
                      onChange={(event) =>
                        setSemanticPunctuation(event.target.checked)
                      }
                    />
                    <span>标点</span>
                  </label>
                </div>
              )}
              {capability === 'speech.keyword' && (
                <div className="model-parameter-bar">
                  <label className="context-field">
                    <span>关键词</span>
                    <input
                      value={keywords}
                      placeholder="多个关键词用逗号分隔"
                      onChange={(event) => setKeywords(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {capability === 'audio.enhance' && (
                <div className="model-parameter-bar">
                  <label className="enhance-strength-field">
                    <span>降噪强度</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={denoiseStrength}
                      disabled={recording}
                      onChange={(event) =>
                        setDenoiseStrength(Number(event.target.value))
                      }
                    />
                    <output>{Math.round(denoiseStrength * 100)}%</output>
                  </label>
                  {streamingEnhanceModel && audioSource === 'system' && (
                    <span
                      className={`monitor-latency${recording ? ' active' : ''}`}
                      title="从采集音频块进入处理队列，到增强结果送入系统输出的延迟"
                    >
                      <Activity size={13} />
                      {monitorLatencyMs === null
                        ? '处理延迟 --'
                        : `处理延迟 ≈ ${monitorLatencyMs} ms`}
                    </span>
                  )}
                </div>
              )}
                <div
                  className={`audio-model-composer codex-composer${recording ? ' recording' : ''}`}
                >
                {recording && (
                  <RecordingWaveform
                    active
                    stream={recordingStreamRef.current}
                    label={
                      audioSource === 'system'
                        ? streamingEnhanceModel
                          ? '电脑音频监听中'
                          : '电脑音频采集中'
                        : streamingAsrModel
                          ? '麦克风实时识别中'
                          : '麦克风录音中'
                    }
                  />
                )}
                <div className="audio-composer-toolbar">
                  <div
                    className="audio-input-menu"
                    onMouseLeave={() => { audioInputMenuTimerRef.current = window.setTimeout(() => setAudioInputMenuOpen(false), 300) }}
                    onMouseEnter={() => { if (audioInputMenuTimerRef.current) { clearTimeout(audioInputMenuTimerRef.current); audioInputMenuTimerRef.current = null } }}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        setAudioInputMenuOpen(false)
                      }
                    }}
                  >
                    <button
                      className="composer-tool-button audio-input-menu-trigger"
                      type="button"
                      title="选择音频输入"
                      aria-label="选择音频输入"
                      aria-expanded={audioInputMenuOpen}
                      disabled={busy || recording}
                      onClick={() => setAudioInputMenuOpen((open) => !open)}
                    >
                      <SlidersHorizontal size={17} />
                    </button>
                    {audioInputMenuOpen && (
                      <div className="audio-input-popover">
                        <button
                          type="button"
                          onClick={() => {
                            setAudioInputMenuOpen(false)
                            fileInputRef.current?.click()
                          }}
                        >
                          <Upload size={15} />
                          上传音频
                        </button>
                        <button
                          className={audioSource === 'microphone' ? 'active' : ''}
                          type="button"
                          onClick={() => {
                            setAudioSource('microphone')
                            setAudioInputMenuOpen(false)
                          }}
                        >
                          <Mic size={15} />
                          麦克风
                        </button>
                        <button
                          className={audioSource === 'system' ? 'active' : ''}
                          type="button"
                          onClick={() => {
                            setAudioSource('system')
                            setAudioInputMenuOpen(false)
                          }}
                        >
                          <MonitorSpeaker size={15} />
                          电脑音频
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="audio-input-current">
                    {audioSource === 'system' ? '电脑音频' : '麦克风'}
                  </span>
                <button
                  className={`composer-record-button${recording ? ' active' : ''}`}
                  type="button"
                  title={
                    recording
                      ? streamingEnhanceModel &&
                        audioSource === 'system'
                        ? '停止监听'
                        : '停止'
                      : streamingEnhanceModel &&
                          audioSource === 'system'
                        ? '开始监听'
                        : '开始录音'
                  }
                  disabled={busy || !providerReady}
                  onClick={() =>
                    audioSource === 'system'
                      ? recording
                        ? void stopSystemRecording()
                        : void startSystemRecording()
                      : streamingAsrModel
                      ? recording
                        ? void stopStreamingRecording()
                        : void startStreamingRecording()
                      : recording
                        ? stopRecording()
                        : void startRecording()
                  }
                >
                  {recording ? (
                    <CircleStop size={18} />
                  ) : streamingEnhanceModel &&
                    audioSource === 'system' ? (
                    <Headphones size={17} />
                  ) : (
                    audioSource === 'system' ? (
                      <MonitorSpeaker size={18} />
                    ) : (
                      <Mic size={18} />
                    )
                  )}
                </button>
                  </div>
                </div>
              </div>
            </AudioFileDropZone>
          )}
        </footer>
      </section>

      {voiceDialogOpen && (
        <div
          className="voice-create-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !voiceCreating) {
              setVoiceDialogOpen(false)
            }
          }}
        >
          <section
            className="voice-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-create-title"
          >
            <header>
              <h2 id="voice-create-title">新建音色</h2>
              <button
                type="button"
                title="关闭"
                aria-label="关闭"
                disabled={voiceCreating}
                onClick={() => setVoiceDialogOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            {supportsVoiceDesign && (
              <div className="voice-create-mode" role="tablist">
                <button
                  type="button"
                  className={voiceCreationMode === 'clone' ? 'active' : ''}
                  onClick={() => {
                    setVoiceCreationMode('clone')
                    setVoiceDialogError('')
                  }}
                >
                  声音复刻
                </button>
                <button
                  type="button"
                  className={voiceCreationMode === 'design' ? 'active' : ''}
                  onClick={() => {
                    setVoiceCreationMode('design')
                    setVoiceDialogError('')
                  }}
                >
                  声音设计
                </button>
              </div>
            )}
            <div className="voice-create-fields">
              <label>
                <span>名称</span>
                <input
                  value={voicePrefix}
                  maxLength={10}
                  placeholder="myvoice"
                  onChange={(event) => {
                    setVoicePrefix(
                      event.target.value.replace(/[^a-zA-Z0-9]/g, ''),
                    )
                    setVoiceDialogError('')
                  }}
                />
              </label>
              <label>
                <span>语言</span>
                <select
                  value={voiceLanguage}
                  onChange={(event) => {
                    setVoiceLanguage(event.target.value)
                    setVoiceDialogError('')
                  }}
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                  <option value="ko">한국어</option>
                  <option value="fr">Français</option>
                  <option value="de">Deutsch</option>
                </select>
              </label>
              {voiceCreationMode === 'clone' ? (
                <div className="voice-create-audio">
                  <div>
                    <FileAudio size={16} />
                    <span>
                      <strong>参考音频</strong>
                      <small>
                        {recordingTarget === 'tts-reference'
                          ? '正在录制'
                          : ttsReferenceClip?.name ?? '建议 10-20 秒清晰人声'}
                      </small>
                    </span>
                  </div>
                  {recordingTarget === 'tts-reference' && (
                    <RecordingWaveform
                      active
                      stream={recordingStreamRef.current}
                      label="参考音频录制中"
                    />
                  )}
                  {ttsReferenceClip?.url &&
                    recordingTarget !== 'tts-reference' && (
                      <InlineAudioPlayer
                        src={ttsReferenceClip.url}
                        duration={ttsReferenceClip.duration}
                      />
                    )}
                  <div className="voice-create-audio-actions">
                    <button
                      type="button"
                      disabled={voiceCreating || recording}
                      onClick={() => ttsReferenceInputRef.current?.click()}
                    >
                      <Upload size={15} />
                      上传
                    </button>
                    <button
                      type="button"
                      disabled={voiceCreating}
                      onClick={() =>
                        recordingTarget === 'tts-reference'
                          ? stopRecording()
                          : void startRecording('tts-reference')
                      }
                    >
                      {recordingTarget === 'tts-reference' ? (
                        <CircleStop size={15} />
                      ) : (
                        <Mic size={15} />
                      )}
                      {recordingTarget === 'tts-reference' ? '停止' : '录制'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="wide">
                    <span>声音描述</span>
                    <textarea
                      value={voicePrompt}
                      maxLength={500}
                      rows={3}
                      placeholder="例如：沉稳的中年男性播音员，音色低沉，吐字清晰"
                      onChange={(event) => {
                        setVoicePrompt(event.target.value)
                        setVoiceDialogError('')
                      }}
                    />
                    <small>{voicePrompt.trim().length}/500 · 至少 10 个字</small>
                  </label>
                  <label className="wide">
                    <span>试听文本</span>
                    <input
                      value={voicePreviewText}
                      maxLength={200}
                      onChange={(event) => {
                        setVoicePreviewText(event.target.value)
                        setVoiceDialogError('')
                      }}
                    />
                  </label>
                </>
              )}
              {voiceDialogError && (
                <p className="voice-create-error" role="alert">
                  {voiceDialogError}
                </p>
              )}
            </div>
            <footer>
              <button
                className="secondary-action"
                type="button"
                disabled={voiceCreating}
                onClick={() => setVoiceDialogOpen(false)}
              >
                取消
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={
                  voiceCreating ||
                  !voicePrefix ||
                  (voiceCreationMode === 'clone' &&
                    !ttsReferenceClip?.transcriptionAudioUrl) ||
                  (voiceCreationMode === 'design' &&
                    (!voicePrompt.trim() || !voicePreviewText.trim()))
                }
                onClick={() => void createCloudVoice()}
              >
                {voiceCreating && <LoaderCircle className="model-spin" size={15} />}
                {voiceCreating ? '正在创建' : '创建音色'}
              </button>
            </footer>
          </section>
        </div>
      )}

      <aside className="model-result-detail">
        {selectedRun && (
          <>
          <div
            className="result-detail-resize-handle"
            role="separator"
            aria-label="调整详情宽度"
            aria-orientation="vertical"
            onPointerDown={beginDetailResize}
          />
          {detailLoading && (
            <div className="result-detail-loading">
              <LoaderCircle className="model-spin" size={18} />
              正在读取结果
            </div>
          )}

          {execution && (
            <div className="model-detail-layout">
              <section className="model-detail-card detail-output-card">
                <div className="detail-card-body detail-output-scroll">
                  {selectedSourceAudioUrl &&
                    (isVadOutput(execution.output) ||
                      isAsrOutput(execution.output) ||
                      ('speakerCount' in execution.output &&
                        typeof execution.output.speakerCount === 'number' &&
                        Array.isArray(execution.output.segments))) && (
                      <div className="detail-timed-waveform">
                        <AudioAssetPreview
                          src={selectedSourceAudioUrl}
                          peaks={
                            selectedAttachment?.samples ??
                            ('waveform' in execution.output &&
                            Array.isArray(execution.output.waveform)
                              ? execution.output.waveform
                              : undefined)
                          }
                          duration={
                            selectedAttachment?.duration ??
                            ('duration' in execution.output &&
                            typeof execution.output.duration === 'number'
                              ? execution.output.duration
                              : undefined)
                          }
                          role={isVadOutput(execution.output) ? 'timeline' : 'input'}
                          minPixelsPerSecond={
                            isVadOutput(execution.output) ? 0 : undefined
                          }
                          showMinimap={isVadOutput(execution.output)}
                          seekTime={vadPreviewTime}
                          playRange={
                            isAsrOutput(execution.output)
                              ? asrPlayRange
                              : undefined
                          }
                          regions={
                            isVadOutput(execution.output)
                              ? execution.output.segments.map(
                                  (segment, index) => ({
                                    id: segment.id,
                                    start: segment.start,
                                    end: segment.end,
                                    label: `${index + 1}`,
                                  }),
                                )
                              : isAsrOutput(execution.output)
                                ? []
                                : normalizeHarnessResult(
                                    execution.output,
                                  ).segments.map((segment) => ({
                                    id: segment.id,
                                    start: segment.start,
                                    end: segment.end,
                                    label: segment.label,
                                  }))
                          }
                          onTimeChange={
                            isAsrOutput(execution.output)
                              ? setAsrPlaybackTime
                              : undefined
                          }
                        />
                      </div>
                    )}
                  {isAudioOutput(execution.output) && (
                    <div className="detail-audio-output">
                      <AudioAssetPreview
                        src={convertFileSrc(execution.output.filePath)}
                        spectrogramSrc={execution.output.dataUrl}
                        peaks={execution.output.waveform}
                        duration={execution.output.duration}
                        role="output"
                      />
                      <dl className="detail-output-meta">
                        <div>
                          <dt>文件</dt>
                          <dd>{execution.output.fileName}</dd>
                        </div>
                        <div>
                          <dt>时长</dt>
                          <dd>
                            {formatTime(execution.output.duration, true)}
                          </dd>
                        </div>
                        <div>
                          <dt>采样率</dt>
                          <dd>{execution.output.sampleRate / 1000} kHz</dd>
                        </div>
                        <div>
                          <dt>大小</dt>
                          <dd>
                            {formatFileSize(execution.output.sizeBytes)}
                          </dd>
                        </div>
                      </dl>
                      <button
                        className="primary-action full-width"
                        type="button"
                        onClick={() =>
                          downloadAudioResult(
                            execution.output as
                              | TtsGenerateResult
                              | AudioProcessResult,
                          )
                        }
                      >
                        <Download size={15} />
                        导出音频
                      </button>
                    </div>
                  )}

                  {isVadOutput(execution.output) && (
                    <div className="detail-timed-output">
                      <div className="transcript-result-summary">
                        <strong>
                          {execution.output.segments.length} 个语音片段
                        </strong>
                        <span>
                          语音{' '}
                          {formatTime(
                            execution.output.speechSeconds,
                            true,
                          )}
                        </span>
                      </div>
                      <div className="transcript-result-segments vad-segment-list">
                        {execution.output.segments.map((segment, index) => (
                          <button
                            className="vad-segment-row"
                            type="button"
                            key={segment.id}
                            onClick={() => {
                              setVadPreviewTime(segment.start)
                            }}
                          >
                            <span>{index + 1}</span>
                            <time>
                              {formatTime(segment.start, true)}–
                              {formatTime(segment.end, true)}
                            </time>
                            <small>{formatTime(segment.duration, true)}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {isTextOutput(execution.output) && (
                    <p className="detail-text-output">
                      {execution.output.text}
                    </p>
                  )}

                  {!isAudioOutput(execution.output) &&
                    !isVadOutput(execution.output) &&
                    !isTextOutput(execution.output) &&
                    isAsrOutput(execution.output) && (
                      <div className="detail-transcript-output">
                        <div className="transcript-result-summary">
                          <strong>
                            {execution.output.segments.length} 个文本段 ·{' '}
                            {execution.output.segments.reduce(
                              (count, segment) =>
                                count +
                                segment.tokens.filter((token) =>
                                  token.text.trim(),
                                ).length,
                              0,
                            )}{' '}
                            个字词时间戳
                          </strong>
                          <span>
                            {execution.output.language.toUpperCase()} ·
                            点击字词播放
                          </span>
                        </div>
                        <div
                          ref={transcriptResultRef}
                          className="transcript-result-segments"
                        >
                          {execution.output.segments.map(
                            (segment, segmentIndex) => (
                              <article
                                className="asr-timestamp-segment"
                                key={segment.id}
                              >
                                <div className="asr-segment-heading">
                                  <time>
                                    {formatTime(segment.start, true)}–
                                    {formatTime(segment.end, true)}
                                  </time>
                                  <small>文本段 {segmentIndex + 1}</small>
                                </div>
                                {segment.tokens.some((token) =>
                                  token.text.trim(),
                                ) ? (
                                  <div className="asr-token-list">
                                    {segment.tokens.map((token, tokenIndex) => {
                                      const text = token.text
                                      const accessibleText = text.trim()
                                      if (!accessibleText) return null
                                      const tokenKey = `${segment.id}-${tokenIndex}`
                                      const tokenTime = `${formatTime(
                                        token.start,
                                        true,
                                      )}–${formatTime(token.end, true)}`
                                      return (
                                        <button
                                          aria-label={`${accessibleText}，${tokenTime}`}
                                          className={
                                            activeAsrTokenKey === tokenKey
                                              ? 'asr-token active'
                                              : 'asr-token'
                                          }
                                          data-token-key={tokenKey}
                                          data-time={tokenTime}
                                          key={tokenKey}
                                          type="button"
                                          onClick={() => {
                                            setVadPreviewTime(token.start)
                                            setAsrPlaybackTime(token.start)
                                            setAsrPlayRange({
                                              start: token.start,
                                              end: token.end,
                                              requestId: Date.now(),
                                              key: tokenKey,
                                            })
                                          }}
                                        >
                                          {text}
                                        </button>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <button
                                    className="transcript-segment-button"
                                    type="button"
                                    onClick={() => {
                                      setVadPreviewTime(segment.start)
                                      setAsrPlayRange({
                                        start: segment.start,
                                        end: segment.end,
                                        requestId: Date.now(),
                                        key: segment.id,
                                      })
                                    }}
                                  >
                                    <p>{segment.text}</p>
                                  </button>
                                )}
                              </article>
                            ),
                          )}
                        </div>
                      </div>
                    )}

                  {!isAudioOutput(execution.output) &&
                    !isVadOutput(execution.output) &&
                    !isTextOutput(execution.output) &&
                    !isAsrOutput(execution.output) && (
                      <AdvancedResultDetail
                        output={execution.output}
                        onSeek={setVadPreviewTime}
                      />
                    )}

                  {(dependencyLoading || dependencyExecutions.length > 0) && (
                    <section className="detail-dependency-results">
                      <header>
                        <strong>辅助结果</strong>
                        <span>
                          {dependencyLoading
                            ? '读取中'
                            : `${dependencyExecutions.length} 个`}
                        </span>
                      </header>
                      {dependencyExecutions.map((dependency) => (
                        <DependencyResultDetail
                          key={dependency.run.id}
                          execution={dependency}
                          onSeek={setVadPreviewTime}
                        />
                      ))}
                    </section>
                  )}
                </div>
              </section>

              <section className="model-detail-card detail-runtime-card">
                <header>
                  <strong>运行信息</strong>
                  <span>RUNTIME</span>
                </header>
                <div className="detail-card-body">
                  <RuntimeInfo
                    output={
                      execution.output as unknown as Record<string, unknown>
                    }
                    fallbackEngine={selectedRun.providerName}
                    automaticSegmentation={
                      automaticSegmentationByRunId[selectedRun.id]
                    }
                  />
                </div>
              </section>
            </div>
          )}

          {!detailLoading && !execution && (
            <div className="result-detail-placeholder">
              <Icon size={20} />
              <strong>{statusLabels[selectedRun.status]}</strong>
              <p>
                {selectedRun.error ||
                  '任务完成后，这里会显示波形、文字和运行参数。'}
              </p>
            </div>
          )}
          </>
        )}
      </aside>
    </main>
  )
}
