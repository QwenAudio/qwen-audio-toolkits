import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  AudioLines,
  Captions,
  ChevronDown,
  CirclePlus,
  Download,
  FileAudio,
  FolderOpen,
  Gauge,
  GripVertical,
  Headphones,
  Layers3,
  ListMusic,
  MoreHorizontal,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Undo2,
  Volume2,
  WandSparkles,
  Waves,
  X,
} from 'lucide-react'
import { Spectrogram } from '../components/Spectrogram'
import { Waveform } from '../components/Waveform'
import { executeHarnessTask } from '../services/harness'
import { formatFileSize, formatTime } from '../utils/audio'
import {
  downloadTranscript,
  type TranscriptExportFormat,
} from '../utils/transcript'
import type {
  AsrTranscriptionResult,
  AudioProcessOperation,
  AudioProcessResult,
  AudioClip,
  AudioProcessorStatus,
  HarnessCatalog,
  ProcessingEffect,
} from '../types'

interface EditViewProps {
  launchMode?: 'edit' | 'clean' | 'transcribe'
  catalog: HarnessCatalog | null
  clips: AudioClip[]
  selectedClip: AudioClip
  effects: ProcessingEffect[]
  isPlaying: boolean
  currentTime: number
  volume: number
  onSelectClip: (clipId: string) => void
  onImport: () => void
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onToggleEffect: (effectId: string) => void
  onEffectChange: (effectId: string, value: number) => void
  onAddEffect: () => void
  onExport: () => void
  onCreateClip: (clip: AudioClip, message: string) => void
  canUndo: boolean
  onUndo: () => void
  onOpenGenerate: () => void
  onOpenBatch: () => void
  onAction: (message: string) => void
}

interface AsrProgressEvent {
  stage: 'preparing' | 'loading' | 'vad' | 'recognizing' | 'complete'
  progress: number
  detail: string
}

interface AudioProcessingProgressEvent {
  operation: string
  stage:
    | 'preparing'
    | 'trimming'
    | 'denoising'
    | 'vad'
    | 'normalizing'
    | 'fading'
    | 'encoding'
    | 'complete'
  progress: number
  detail: string
}

function isTauriRuntime(): boolean {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    zh: '中文',
    en: '英文',
    ja: '日文',
    ko: '韩文',
    yue: '粤语',
  }
  return labels[language] ?? language.toUpperCase()
}

function EffectGlyph({ effectId }: { effectId: string }) {
  if (effectId === 'denoise') return <Sparkles size={16} />
  if (effectId === 'silence') return <Waves size={16} />
  if (effectId === 'loudness') return <Gauge size={16} />
  return <SlidersVertical size={16} />
}

function operationForEffect(
  effectId: string,
): AudioProcessOperation | undefined {
  if (effectId === 'loudness') return 'normalize'
  if (
    effectId === 'denoise' ||
    effectId === 'silence' ||
    effectId === 'fade'
  ) {
    return effectId
  }
  return undefined
}

export function EditView({
  launchMode = 'edit',
  catalog,
  clips,
  selectedClip,
  effects,
  isPlaying,
  currentTime,
  volume,
  onSelectClip,
  onImport,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleEffect,
  onEffectChange,
  onAddEffect,
  onExport,
  onCreateClip,
  canUndo,
  onUndo,
  onOpenGenerate,
  onOpenBatch,
  onAction,
}: EditViewProps) {
  const [search, setSearch] = useState('')
  const [editorMode, setEditorMode] = useState<
    'waveform' | 'spectrogram' | 'transcript'
  >(launchMode === 'transcribe' ? 'transcript' : 'waveform')
  const [mediaOpen, setMediaOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(
    launchMode === 'clean',
  )
  const [timelineVisible, setTimelineVisible] = useState(true)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [transcriptions, setTranscriptions] = useState<
    Record<string, AsrTranscriptionResult>
  >({})
  const [transcribingClipId, setTranscribingClipId] = useState<string | null>(
    null,
  )
  const [transcriptionProgress, setTranscriptionProgress] = useState(0)
  const [transcriptionDetail, setTranscriptionDetail] = useState('')
  const [transcriptionError, setTranscriptionError] = useState<string | null>(
    null,
  )
  const [selection, setSelection] = useState<[number, number] | undefined>()
  const [processorStatus, setProcessorStatus] =
    useState<AudioProcessorStatus | null>(null)
  const [processingOperations, setProcessingOperations] = useState<
    AudioProcessOperation[] | null
  >(null)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [processingDetail, setProcessingDetail] = useState('')
  const [processingError, setProcessingError] = useState<string | null>(null)
  const [lastProcessResult, setLastProcessResult] =
    useState<AudioProcessResult | null>(null)
  const [extraTrackCount, setExtraTrackCount] = useState(0)
  const [monitoredTracks, setMonitoredTracks] = useState<Set<string>>(
    () => new Set(['voice']),
  )
  const [asrProviderId, setAsrProviderId] = useState(
    'plugin.funaudiollm.sensevoice-small-gguf',
  )
  const [enhanceProviderId, setEnhanceProviderId] =
    useState('plugin.rikorose.deepfilternet3')
  const [transcriptExportOpen, setTranscriptExportOpen] = useState(false)
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const transcriptExportRef = useRef<HTMLDivElement>(null)
  const desktopRuntime = isTauriRuntime()
  const transcription = transcriptions[selectedClip.id]
  const isCurrentTranscribing = transcribingClipId === selectedClip.id
  const asrProviders = useMemo(
    () =>
      catalog?.providers.filter(
        (provider) =>
          provider.local &&
          provider.capabilities.includes('speech.transcribe'),
      ) ?? [],
    [catalog],
  )
  const enhanceProviders = useMemo(
    () =>
      catalog?.providers.filter(
        (provider) =>
          provider.local &&
          provider.capabilities.includes('audio.enhance'),
      ) ?? [],
    [catalog],
  )
  const selectedAsrProvider = asrProviders.find(
    (provider) => provider.id === asrProviderId,
  )
  const selectedEnhanceProvider = enhanceProviders.find(
    (provider) => provider.id === enhanceProviderId,
  )
  const asrProviderReady = catalog
    ? selectedAsrProvider?.status === 'ready'
    : false
  const enhanceProviderReady = catalog
    ? selectedEnhanceProvider?.status === 'ready'
    : Boolean(processorStatus?.installed)
  const progress = selectedClip.duration
    ? currentTime / selectedClip.duration
    : 0
  const filteredClips = useMemo(
    () =>
      clips.filter((clip) =>
        clip.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [clips, search],
  )
  const ruler = Array.from({ length: 7 }, (_, index) => {
    const value = (selectedClip.duration / 6) * index
    return formatTime(value)
  })
  const toggleTrackMonitor = (trackId: string) => {
    setMonitoredTracks((current) => {
      const next = new Set(current)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }
  const enabledOperations = effects
    .filter(
      (effect) =>
        effect.enabled &&
        ['denoise', 'silence', 'loudness', 'fade'].includes(effect.id),
    )
    .map((effect) =>
      effect.id === 'loudness'
        ? 'normalize'
        : (effect.id as AudioProcessOperation),
    )
  const isProcessing = processingOperations !== null

  useEffect(() => {
    if (!sourceMenuOpen) return undefined

    const closeMenu = (event: PointerEvent) => {
      if (!sourceMenuRef.current?.contains(event.target as Node)) {
        setSourceMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSourceMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [sourceMenuOpen])

  useEffect(() => {
    if (!transcriptExportOpen) return undefined
    const closeMenu = (event: PointerEvent) => {
      if (!transcriptExportRef.current?.contains(event.target as Node)) {
        setTranscriptExportOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTranscriptExportOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [transcriptExportOpen])

  useEffect(() => {
    if (!desktopRuntime) return undefined

    let disposed = false
    let removeProgressListener: (() => void) | undefined

    void listen<AsrProgressEvent>(
      'asr-transcription-progress',
      (event) => {
        if (disposed) return
        setTranscriptionProgress(event.payload.progress)
        setTranscriptionDetail(event.payload.detail)
      },
    ).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        removeProgressListener = unlisten
      }
    })

    return () => {
      disposed = true
      removeProgressListener?.()
    }
  }, [desktopRuntime])

  useEffect(() => {
    setSelection(undefined)
    setProcessingError(null)
  }, [selectedClip.id])

  useEffect(() => {
    if (!desktopRuntime) return undefined

    let disposed = false
    let removeProgressListener: (() => void) | undefined

    invoke<AudioProcessorStatus>('audio_processor_status')
      .then((status) => {
        if (!disposed) setProcessorStatus(status)
      })
      .catch((error) => {
        if (!disposed) setProcessingError(errorMessage(error))
      })

    void listen<AudioProcessingProgressEvent>(
      'audio-processing-progress',
      (event) => {
        if (disposed) return
        setProcessingProgress(event.payload.progress)
        setProcessingDetail(event.payload.detail)
      },
    ).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        removeProgressListener = unlisten
      }
    })

    return () => {
      disposed = true
      removeProgressListener?.()
    }
  }, [desktopRuntime])

  const processSelectedClip = async (
    operations: AudioProcessOperation[],
  ) => {
    const clip = selectedClip
    if (isProcessing) return
    if (!clip.processingAudioUrl) {
      onAction('请先导入或生成一段真实音频')
      return
    }
    if (!desktopRuntime) {
      onAction('本地音频处理仅在桌面端可用')
      return
    }
    if (operations.includes('denoise') && !enhanceProviderReady) {
      onAction('DPDFNet2 降噪模型尚未安装')
      return
    }
    if (operations.includes('silence') && !processorStatus?.vadInstalled) {
      onAction('Silero VAD 模型尚未安装')
      return
    }
    if (
      operations.includes('trim') &&
      (!selection || selection[1] - selection[0] < 0.001)
    ) {
      onAction('请先在波形上拖出需要保留的选区')
      return
    }

    const denoise = effects.find((effect) => effect.id === 'denoise')
    const silence = effects.find((effect) => effect.id === 'silence')
    const loudness = effects.find((effect) => effect.id === 'loudness')
    const fade = effects.find((effect) => effect.id === 'fade')
    setProcessingOperations(operations)
    setProcessingProgress(2)
    setProcessingDetail('正在准备全质量音频')
    setProcessingError(null)

    try {
      const execution = await executeHarnessTask<AudioProcessResult>(
        {
          capability: 'audio.enhance',
          providerId: enhanceProviderId,
          routing: 'local',
          title: `${clip.name} · ${operations.join(' + ')}`,
          input: {
            audioDataUrl: clip.processingAudioUrl,
            clipName: clip.name,
          },
          parameters: {
            operations,
            selectionStart: selection
              ? selection[0] * clip.duration
              : undefined,
            selectionEnd: selection
              ? selection[1] * clip.duration
              : undefined,
            denoiseStrength: (denoise?.value ?? 72) / 100,
            targetLoudnessDb: -23 + (loudness?.value ?? 70) / 10,
            silencePaddingMs: Math.round(
              60 + (silence?.value ?? 40) * 1.5,
            ),
            fadeMs: Math.round(5 + (fade?.value ?? 34) * 0.45),
          },
        },
        (run) =>
          setProcessingProgress((value) => Math.max(value, run.progress)),
      )
      const result = execution.output
      const nextClip: AudioClip = {
        id: `processed-${crypto.randomUUID()}`,
        name: result.fileName,
        duration: result.duration,
        sampleRate: result.sampleRate,
        channels: result.channels,
        kind: clip.kind,
        samples: result.waveform,
        color: operations.includes('denoise') ? '#827df8' : '#ff765f',
        sizeLabel: formatFileSize(result.sizeBytes),
        sourceLabel: result.engine,
        url: result.dataUrl,
        processingAudioUrl: result.dataUrl,
        transcriptionAudioUrl: result.dataUrl,
      }
      setLastProcessResult(result)
      setProcessorStatus((current) =>
        current && operations.includes('denoise')
          ? { ...current, loaded: true }
          : current,
      )
      onCreateClip(
        nextClip,
        `${result.operation}完成，已创建新 Take · ${result.detail}`,
      )
    } catch (error) {
      const message = errorMessage(error)
      setProcessingError(message)
      onAction(`处理失败：${message}`)
    } finally {
      setProcessingOperations(null)
    }
  }

  const transcribeSelectedClip = async () => {
    const clip = selectedClip
    if (!clip.transcriptionAudioUrl || transcribingClipId) {
      if (!clip.transcriptionAudioUrl) {
        onAction('请先导入真实音频，或选择一段已生成的音频')
      }
      return
    }
    if (!desktopRuntime || !asrProviderReady) {
      onAction('当前没有可用的本地语音识别 Provider')
      return
    }

    setTranscribingClipId(clip.id)
    setTranscriptionError(null)
    setTranscriptionProgress(2)
    setTranscriptionDetail('正在准备音频')

    try {
      const execution = await executeHarnessTask<AsrTranscriptionResult>(
        {
          capability: 'speech.transcribe',
          providerId: asrProviderId,
          routing: 'local',
          title: `${clip.name} · 语音识别`,
          input: {
            audioDataUrl: clip.transcriptionAudioUrl,
            clipName: clip.name,
          },
          parameters: {},
        },
        (run) =>
          setTranscriptionProgress((value) => Math.max(value, run.progress)),
      )
      const result = execution.output
      setTranscriptions((current) => ({
        ...current,
        [clip.id]: result,
      }))
      onAction(`已识别 ${result.segments.length} 个带时间码片段`)
    } catch (error) {
      const message = errorMessage(error)
      setTranscriptionError(message)
      onAction(`识别失败：${message}`)
    } finally {
      setTranscribingClipId(null)
    }
  }

  const exportTranscript = (format: TranscriptExportFormat) => {
    if (!transcription) return
    const fileName = downloadTranscript(
      transcription,
      format,
      selectedClip.name,
    )
    setTranscriptExportOpen(false)
    onAction(`${fileName} 已导出`)
  }

  return (
    <div
      className={[
        'editor-layout',
        mediaOpen ? 'media-open' : '',
        inspectorOpen ? 'inspector-open' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {mediaOpen && (
        <aside className="media-panel panel-column">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">PROJECT</span>
              <h2>素材</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              title="关闭素材栏"
              aria-label="关闭素材栏"
              onClick={() => setMediaOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          <button className="import-button" type="button" onClick={onImport}>
            <FolderOpen size={17} />
            导入音频
          </button>

          <label className="search-field">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索素材"
              aria-label="搜索素材"
            />
          </label>

          <div className="media-filter-row">
            <button className="text-filter active" type="button">
              全部 <span>{clips.length}</span>
            </button>
            <button className="text-filter" type="button">
              音频
            </button>
            <button className="text-filter" type="button">
              生成
            </button>
          </div>

          <div className="media-list">
            {filteredClips.map((clip) => (
              <button
                key={clip.id}
                type="button"
                className={`media-item${clip.id === selectedClip.id ? ' selected' : ''}`}
                onClick={() => onSelectClip(clip.id)}
              >
                <span
                  className="media-type-mark"
                  style={{ '--clip-color': clip.color } as CSSProperties}
                >
                  {clip.kind === 'generated' ? (
                    <WandSparkles size={15} />
                  ) : clip.kind === 'music' ? (
                    <ListMusic size={15} />
                  ) : (
                    <AudioLines size={15} />
                  )}
                </span>
                <span className="media-copy">
                  <strong>{clip.name}</strong>
                  <small>
                    {formatTime(clip.duration)} · {clip.sizeLabel}
                  </small>
                </span>
                <span className="media-more" aria-hidden="true">
                  <MoreHorizontal size={15} />
                </span>
              </button>
            ))}
          </div>

          <div className="media-panel-footer">
            <span>
              <FileAudio size={14} /> {clips.length} 个素材
            </span>
            <span>56.4 MB</span>
          </div>
        </aside>
      )}

      <main
        className={`editor-stage${timelineVisible ? ' timeline-visible' : ' timeline-hidden'}`}
      >
        <div className="editor-commandbar">
          <div className="workbench-tools">
            <button
              className={`workspace-panel-button${mediaOpen ? ' active' : ''}`}
              type="button"
              title={mediaOpen ? '关闭素材栏' : '打开素材栏'}
              aria-label={mediaOpen ? '关闭素材栏' : '打开素材栏'}
              aria-pressed={mediaOpen}
              onClick={() => setMediaOpen((value) => !value)}
            >
              <ListMusic size={16} />
              <span>素材</span>
            </button>

            <div ref={sourceMenuRef} className="source-menu-anchor">
              <button
                className="add-source-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                onClick={() => setSourceMenuOpen((value) => !value)}
              >
                <CirclePlus size={15} />
                添加素材
                <ChevronDown size={13} />
              </button>
              {sourceMenuOpen && (
                <div className="source-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSourceMenuOpen(false)
                      onImport()
                    }}
                  >
                    <FolderOpen size={16} />
                    <span>
                      <strong>导入音频</strong>
                      <small>WAV、MP3、FLAC 或 M4A</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSourceMenuOpen(false)
                      onOpenGenerate()
                    }}
                  >
                    <WandSparkles size={16} />
                    <span>
                      <strong>文字生成音频</strong>
                      <small>使用本地 TTS 创建片段</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSourceMenuOpen(false)
                      onOpenBatch()
                    }}
                  >
                    <Layers3 size={16} />
                    <span>
                      <strong>批量处理</strong>
                      <small>对多个文件应用同一预设</small>
                    </span>
                  </button>
                </div>
              )}
            </div>

            <span className="toolbar-divider" />
            <button
              className="icon-button"
              type="button"
              title="撤销"
              aria-label="撤销"
              disabled={!canUndo || isProcessing}
              onClick={onUndo}
            >
              <Undo2 size={16} />
            </button>
            <button
              className="icon-button muted"
              type="button"
              title="重做"
              aria-label="重做"
              disabled
            >
              <Redo2 size={16} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="裁剪为选区"
              aria-label="裁剪为选区"
              disabled={!selection || !selectedClip.processingAudioUrl || isProcessing}
              onClick={() => void processSelectedClip(['trim'])}
            >
              <Scissors size={16} />
            </button>
          </div>

          <div className="segmented-control" aria-label="编辑器视图">
            <button
              className={editorMode === 'waveform' ? 'active' : ''}
              type="button"
              onClick={() => setEditorMode('waveform')}
            >
              波形
            </button>
            <button
              className={editorMode === 'spectrogram' ? 'active' : ''}
              type="button"
              onClick={() => setEditorMode('spectrogram')}
            >
              Mel 频谱
            </button>
            <button
              className={editorMode === 'transcript' ? 'active' : ''}
              type="button"
              onClick={() => setEditorMode('transcript')}
            >
              文本
            </button>
          </div>

          <div className="context-tools">
            <button
              className={`quick-process-button${enabledOperations.length ? ' active' : ''}`}
              type="button"
              disabled={
                !enabledOperations.length ||
                !selectedClip.processingAudioUrl ||
                isProcessing
              }
              onClick={() => void processSelectedClip(enabledOperations)}
            >
              {isProcessing ? (
                <RefreshCw className="processing-spin" size={14} />
              ) : (
                <Sparkles size={14} />
              )}
              {isProcessing ? `${processingProgress}%` : '应用处理链'}
            </button>
            <button
              className={`workspace-panel-button${timelineVisible ? ' active' : ''}`}
              type="button"
              title={timelineVisible ? '隐藏时间线' : '显示时间线'}
              aria-label={timelineVisible ? '隐藏时间线' : '显示时间线'}
              aria-pressed={timelineVisible}
              onClick={() => setTimelineVisible((value) => !value)}
            >
              <Layers3 size={16} />
              <span>时间线</span>
            </button>
            <button
              className={`workspace-panel-button${inspectorOpen ? ' active' : ''}`}
              type="button"
              title={inspectorOpen ? '关闭高级处理' : '打开高级处理'}
              aria-label={inspectorOpen ? '关闭高级处理' : '打开高级处理'}
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen((value) => !value)}
            >
              <SlidersHorizontal size={16} />
              <span>处理器</span>
            </button>
          </div>
        </div>

        <section className="wave-editor" aria-label="波形编辑器">
          <div className="clip-title-row">
            <div>
              <span className="clip-origin">{selectedClip.sourceLabel}</span>
              <h1>{selectedClip.name}</h1>
            </div>
            <div className="clip-metadata">
              <span>{selectedClip.sampleRate / 1000} kHz</span>
              <span>{selectedClip.channels === 1 ? 'Mono' : 'Stereo'}</span>
              <button
                className="icon-button"
                type="button"
                title="片段选项"
                aria-label="片段选项"
              >
                <MoreHorizontal size={17} />
              </button>
            </div>
          </div>

          <div className="ruler">
            {ruler.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>

          {editorMode === 'waveform' ? (
            <div className="waveform-workarea">
              <Waveform
                samples={selectedClip.samples}
                progress={progress}
                selection={selection}
                color={selectedClip.color}
                onSeek={(ratio) => onSeek(ratio * selectedClip.duration)}
                onSelectionChange={setSelection}
              />
              {selection && selection[1] - selection[0] > 0.001 && (
                <div
                  className="selection-label"
                  style={{
                    left: `${Math.min(78, Math.max(2, selection[0] * 100))}%`,
                  }}
                >
                  选区 {formatTime(selection[0] * selectedClip.duration, true)} -{' '}
                  {formatTime(selection[1] * selectedClip.duration, true)}
                </div>
              )}
              <div className="wave-channel-label">L</div>
            </div>
          ) : editorMode === 'spectrogram' ? (
            <div className="spectrogram-workarea">
              <Spectrogram
                audioUrl={
                  selectedClip.url ?? selectedClip.processingAudioUrl
                }
                progress={progress}
                selection={selection}
                onSeek={(ratio) => onSeek(ratio * selectedClip.duration)}
                onSelectionChange={setSelection}
              />
              {selection && selection[1] - selection[0] > 0.001 && (
                <div
                  className="selection-label"
                  style={{
                    left: `${Math.min(78, Math.max(2, selection[0] * 100))}%`,
                  }}
                >
                  选区 {formatTime(selection[0] * selectedClip.duration, true)} -{' '}
                  {formatTime(selection[1] * selectedClip.duration, true)}
                </div>
              )}
              <div className="spectrogram-axis" aria-hidden="true">
                <span>高频</span>
                <span>低频</span>
              </div>
            </div>
          ) : (
            <div className="transcript-workarea">
              <div className="transcript-toolbar">
                <div className="transcript-engine">
                  <span
                    className={`status-dot${asrProviderReady ? '' : ' unavailable'}`}
                  />
                  <span>
                    <strong>
                      {selectedAsrProvider?.name ?? 'SenseVoice Small'}
                    </strong>
                    <small>
                      {asrProviderReady
                        ? '本地就绪 · 自动语言 · Token 时间戳'
                        : desktopRuntime
                          ? '正在检查本地模型'
                          : '仅桌面端可用'}
                    </small>
                  </span>
                  {asrProviders.length > 1 && (
                    <select
                      className="runtime-provider-select"
                      value={asrProviderId}
                      aria-label="语音识别 Provider"
                      disabled={Boolean(transcribingClipId)}
                      onChange={(event) =>
                        setAsrProviderId(event.target.value)
                      }
                    >
                      {asrProviders.map((provider) => (
                        <option
                          key={provider.id}
                          value={provider.id}
                          disabled={provider.status !== 'ready'}
                        >
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {transcription && (
                  <div className="transcript-actions">
                    <button
                      className="icon-button"
                      type="button"
                      title="重新识别"
                      aria-label="重新识别"
                      disabled={Boolean(transcribingClipId)}
                      onClick={() => void transcribeSelectedClip()}
                    >
                      <RefreshCw size={15} />
                    </button>
                    <div
                      ref={transcriptExportRef}
                      className="transcript-export"
                    >
                      <button
                        className="quiet-button"
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={transcriptExportOpen}
                        onClick={() =>
                          setTranscriptExportOpen((value) => !value)
                        }
                      >
                        <Download size={14} />
                        导出
                        <ChevronDown size={12} />
                      </button>
                      {transcriptExportOpen && (
                        <div className="transcript-export-menu" role="menu">
                          {(
                            [
                              ['srt', 'SRT 字幕', '通用播放器与剪辑软件'],
                              ['vtt', 'WebVTT', '网页视频与流媒体'],
                              ['txt', '带时间码文本', '审阅与内容整理'],
                              [
                                'label-studio',
                                'Label Studio JSON',
                                '训练数据标注',
                              ],
                            ] as const
                          ).map(([format, label, hint]) => (
                            <button
                              key={format}
                              type="button"
                              role="menuitem"
                              onClick={() => exportTranscript(format)}
                            >
                              <span>{label}</span>
                              <small>{hint}</small>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {isCurrentTranscribing ? (
                <div className="transcript-processing" role="status">
                  <span className="transcript-processing-icon">
                    <Captions size={20} />
                  </span>
                  <strong>{transcriptionDetail}</strong>
                  <span>{transcriptionProgress}%</span>
                  <i>
                    <span style={{ width: `${transcriptionProgress}%` }} />
                  </i>
                </div>
              ) : transcription ? (
                <>
                  <div className="transcript-summary">
                    <span>{transcription.segments.length} 段</span>
                    <span>{languageLabel(transcription.language)}</span>
                    <span>
                      {transcription.inferenceSeconds.toFixed(2)} 秒 · RTF{' '}
                      {transcription.realTimeFactor.toFixed(2)}
                    </span>
                  </div>
                  <div className="transcript-segments">
                    {transcription.segments.map((segment) => {
                      const segmentActive =
                        currentTime >= segment.start &&
                        currentTime < segment.end
                      return (
                        <article
                          key={segment.id}
                          className={`transcript-segment${segmentActive ? ' active' : ''}`}
                        >
                          <button
                            className="transcript-timecode"
                            type="button"
                            onClick={() => onSeek(segment.start)}
                          >
                            {formatTime(segment.start, true)}
                          </button>
                          <div>
                            <span className="speaker-label">声轨 1</span>
                            <p>
                              {segment.tokens.length
                                ? segment.tokens.map((token, index) => (
                                    <span
                                      key={`${segment.id}-${index}`}
                                      className={
                                        currentTime >= token.start &&
                                        currentTime < token.end
                                          ? 'active'
                                          : undefined
                                      }
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => onSeek(token.start)}
                                      onKeyDown={(event) => {
                                        if (
                                          event.key === 'Enter' ||
                                          event.key === ' '
                                        ) {
                                          onSeek(token.start)
                                        }
                                      }}
                                    >
                                      {token.text}
                                    </span>
                                  ))
                                : segment.text}
                            </p>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="transcript-empty">
                  <span className="transcript-empty-icon">
                    <Captions size={22} />
                  </span>
                  <h3>当前片段尚未识别</h3>
                  <p>
                    {selectedClip.transcriptionAudioUrl
                      ? `${selectedAsrProvider?.name ?? 'SenseVoice Small'} · 本地识别`
                      : '请导入真实音频或选择生成片段'}
                  </p>
                  {transcriptionError && (
                    <div className="transcription-error" role="alert">
                      {transcriptionError}
                    </div>
                  )}
                  <button
                    className="primary-action"
                    type="button"
                    disabled={
                      !desktopRuntime ||
                      !asrProviderReady ||
                      !selectedClip.transcriptionAudioUrl ||
                      Boolean(transcribingClipId)
                    }
                    onClick={() => void transcribeSelectedClip()}
                  >
                    <Captions size={16} />
                    {!desktopRuntime
                      ? '请在桌面端识别'
                      : !asrProviderReady
                        ? '模型未安装'
                        : '开始识别'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {timelineVisible && (
          <section className="timeline-section">
            <div className="timeline-heading">
              <div>
                <strong>时间线</strong>
                <span className="timeline-summary">
                  {2 + extraTrackCount} 条轨道 · 3 个片段
                </span>
              </div>
              <button
                className="quiet-button"
                type="button"
                onClick={() => {
                  setExtraTrackCount((count) => count + 1)
                  onAction('已创建一条空白音轨')
                }}
              >
                <CirclePlus size={15} /> 添加轨道
              </button>
            </div>

            <div className="timeline-tracks">
              <div className="track-label">
                <span className="track-settings-icon">
                  <SlidersHorizontal size={14} />
                </span>
                <span>
                  <strong>Voice</strong>
                  <small>主声道</small>
                </span>
                <button
                  className={`track-monitor${monitoredTracks.has('voice') ? ' active' : ''}`}
                  type="button"
                  title={
                    monitoredTracks.has('voice') ? '关闭监听' : '监听轨道'
                  }
                  aria-label={
                    monitoredTracks.has('voice') ? '关闭监听' : '监听轨道'
                  }
                  aria-pressed={monitoredTracks.has('voice')}
                  onClick={() => toggleTrackMonitor('voice')}
                >
                  M
                </button>
              </div>
              <div className="track-lane">
                <div className="clip-block clip-block--voice">
                  <span className="clip-block-label">
                    <GripVertical size={12} />
                    {selectedClip.name}
                  </span>
                  <Waveform
                    samples={selectedClip.samples.slice(0, 170)}
                    compact
                    color={selectedClip.color}
                  />
                </div>
                <div className="clip-block clip-block--generated">
                  <span className="clip-block-label">修补_02</span>
                  <Waveform
                    samples={clips[3]?.samples ?? selectedClip.samples}
                    compact
                    color="#ff765f"
                  />
                </div>
              </div>

              <div className="track-label">
                <span className="track-settings-icon">
                  <SlidersHorizontal size={14} />
                </span>
                <span>
                  <strong>Music</strong>
                  <small>-12.0 dB</small>
                </span>
                <button
                  className={`track-monitor${monitoredTracks.has('music') ? ' active' : ''}`}
                  type="button"
                  title={
                    monitoredTracks.has('music') ? '关闭监听' : '监听轨道'
                  }
                  aria-label={
                    monitoredTracks.has('music') ? '关闭监听' : '监听轨道'
                  }
                  aria-pressed={monitoredTracks.has('music')}
                  onClick={() => toggleTrackMonitor('music')}
                >
                  M
                </button>
              </div>
              <div className="track-lane">
                <div className="clip-block clip-block--music">
                  <span className="clip-block-label">opening_theme.flac</span>
                  <Waveform
                    samples={clips[2]?.samples ?? selectedClip.samples}
                    compact
                    color="#6c9cff"
                  />
                </div>
              </div>

              {Array.from({ length: extraTrackCount }, (_, index) => {
                const trackId = `track-${index + 3}`
                return (
                  <Fragment key={trackId}>
                    <div className="track-label">
                      <span className="track-settings-icon">
                        <SlidersHorizontal size={14} />
                      </span>
                      <span>
                        <strong>Track {index + 3}</strong>
                        <small>空白轨道</small>
                      </span>
                      <button
                        className={`track-monitor${monitoredTracks.has(trackId) ? ' active' : ''}`}
                        type="button"
                        title={
                          monitoredTracks.has(trackId)
                            ? '关闭监听'
                            : '监听轨道'
                        }
                        aria-label={
                          monitoredTracks.has(trackId)
                            ? '关闭监听'
                            : '监听轨道'
                        }
                        aria-pressed={monitoredTracks.has(trackId)}
                        onClick={() => toggleTrackMonitor(trackId)}
                      >
                        M
                      </button>
                    </div>
                    <div className="track-lane track-lane--empty" />
                  </Fragment>
                )
              })}
            </div>
          </section>
        )}

        <div className="transport-bar">
          <div className="transport-time">
            <strong>{formatTime(currentTime, true)}</strong>
            <span>/ {formatTime(selectedClip.duration, true)}</span>
          </div>
          <div className="transport-main">
            <button
              className="icon-button"
              type="button"
              title="后退 5 秒"
              aria-label="后退 5 秒"
              onClick={() => onSeek(Math.max(0, currentTime - 5))}
            >
              <SkipBack size={18} />
            </button>
            <button
              className="play-button"
              type="button"
              aria-label={isPlaying ? '暂停' : '播放'}
              onClick={onTogglePlay}
            >
              {isPlaying ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              type="button"
              title="前进 5 秒"
              aria-label="前进 5 秒"
              onClick={() =>
                onSeek(Math.min(selectedClip.duration, currentTime + 5))
              }
            >
              <SkipForward size={18} />
            </button>
          </div>
          <div className="transport-output">
            <Headphones size={15} />
            <Volume2 size={16} />
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              aria-label="监听音量"
              onChange={(event) => onVolumeChange(Number(event.target.value))}
            />
            <span>{volume}%</span>
          </div>
        </div>
      </main>

      {inspectorOpen && (
        <aside className="inspector-panel panel-column">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">ADVANCED</span>
              <h2>高级处理</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              title="关闭高级处理"
              aria-label="关闭高级处理"
              onClick={() => setInspectorOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="preset-select">
            <span>
              <WandSparkles size={16} />
              播客人声清理
            </span>
            <small>{enabledOperations.length} 个处理器</small>
          </div>

          <div
            className={`processor-runtime-state${enhanceProviderReady ? ' ready' : ''}`}
          >
            <span className="status-dot" />
            <span>
              <strong>
                {selectedEnhanceProvider?.name ??
                  processorStatus?.name ??
                  '本地处理引擎'}
              </strong>
              <small>
                {enhanceProviderReady
                  ? `${processorStatus?.loaded ? '已加载' : '本地就绪'} · 48 kHz`
                  : desktopRuntime
                    ? '正在检查 DPDFNet2'
                    : '仅桌面端可用'}
              </small>
            </span>
            {enhanceProviders.length > 1 && (
              <select
                className="runtime-provider-select"
                value={enhanceProviderId}
                aria-label="音频增强 Provider"
                disabled={isProcessing}
                onChange={(event) =>
                  setEnhanceProviderId(event.target.value)
                }
              >
                {enhanceProviders.map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={provider.status !== 'ready'}
                  >
                    {provider.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="effect-list">
            {effects.map((effect, index) => {
              const operation = operationForEffect(effect.id)
              const modelUnavailable =
                (operation === 'denoise' && !enhanceProviderReady) ||
                (operation === 'silence' && !processorStatus?.vadInstalled)
              return (
                <div
                  key={effect.id}
                  className={`effect-item tone-${effect.tone}${effect.enabled ? '' : ' disabled'}`}
                >
                  <div className="effect-row">
                    <GripVertical size={14} className="drag-handle" />
                    <span className="effect-glyph">
                      <EffectGlyph effectId={effect.id} />
                    </span>
                    <span className="effect-copy">
                      <strong>
                        {index + 1}. {effect.name}
                      </strong>
                      <small>{effect.description}</small>
                    </span>
                    {operation && (
                      <button
                        type="button"
                        className="effect-run-button"
                        title={`单独应用${effect.name}`}
                        aria-label={`单独应用${effect.name}`}
                        disabled={
                          modelUnavailable ||
                          !selectedClip.processingAudioUrl ||
                          isProcessing
                        }
                        onClick={() => void processSelectedClip([operation])}
                      >
                        <Play size={12} fill="currentColor" />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`toggle${effect.enabled ? ' on' : ''}`}
                      role="switch"
                      aria-checked={effect.enabled}
                      aria-label={`${effect.name}${effect.enabled ? '已开启' : '已关闭'}`}
                      onClick={() => onToggleEffect(effect.id)}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="effect-parameter">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={effect.value}
                      disabled={!effect.enabled}
                      aria-label={`${effect.name}强度`}
                      onChange={(event) =>
                        onEffectChange(effect.id, Number(event.target.value))
                      }
                    />
                    <span>{effect.valueLabel}</span>
                  </div>
                </div>
              )
            })}
          </div>

          <button
            className="add-effect-button"
            type="button"
            onClick={onAddEffect}
          >
            <CirclePlus size={16} />
            添加处理器
          </button>

          {isProcessing && (
            <div className="processor-progress" role="status">
              <div>
                <RefreshCw className="processing-spin" size={15} />
                <strong>{processingDetail}</strong>
                <span>{processingProgress}%</span>
              </div>
              <i>
                <span style={{ width: `${processingProgress}%` }} />
              </i>
            </div>
          )}

          {processingError && (
            <div className="processor-error" role="alert">
              {processingError}
            </div>
          )}

          <div className="render-summary">
            <div>
              <span>输入峰值</span>
              <strong>
                {lastProcessResult
                  ? `${lastProcessResult.peakBeforeDb.toFixed(1)} dB`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>输出峰值</span>
              <strong>
                {lastProcessResult
                  ? `${lastProcessResult.peakAfterDb.toFixed(1)} dB`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>语音响度</span>
              <strong>
                {lastProcessResult
                  ? `${lastProcessResult.loudnessAfterDb.toFixed(1)} dB`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>移除时长</span>
              <strong>
                {lastProcessResult
                  ? `${lastProcessResult.removedSeconds.toFixed(1)} s`
                  : '—'}
              </strong>
            </div>
            <div className="mini-levels" aria-label="输出电平">
              {(lastProcessResult?.waveform.slice(-10) ??
                [0.2, 0.28, 0.22, 0.34, 0.3, 0.24, 0.32, 0.2, 0.26, 0.22]
              ).map((level, index) => (
                <i
                  key={index}
                  style={{ height: `${Math.max(12, level * 100)}%` }}
                />
              ))}
            </div>
          </div>

          <div className="processor-footer-actions">
            <button
              className="primary-action full-width"
              type="button"
              disabled={
                !enabledOperations.length ||
                !selectedClip.processingAudioUrl ||
                isProcessing
              }
              onClick={() => void processSelectedClip(enabledOperations)}
            >
              {isProcessing ? (
                <RefreshCw className="processing-spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {isProcessing ? `处理中 ${processingProgress}%` : '生成新 Take'}
            </button>
            <button
              className="quiet-button full-width"
              type="button"
              disabled={!selectedClip.url}
              onClick={onExport}
            >
              <Download size={15} />
              导出当前 WAV
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}
