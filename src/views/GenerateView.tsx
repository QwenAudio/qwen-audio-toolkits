import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Check,
  ChevronDown,
  Clock3,
  Languages,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import { Waveform } from '../components/Waveform'
import { createWaveSamples } from '../data'
import { executeHarnessTask } from '../services/harness'
import { formatTime } from '../utils/audio'
import type {
  AudioClip,
  HarnessCatalog,
  TtsGenerateResult,
  TtsModelStatus,
} from '../types'

interface GenerateViewProps {
  initialText?: string
  catalog: HarnessCatalog | null
  onGenerated: (clip: AudioClip) => void
  onOpenEditor: () => void
  onAction: (message: string) => void
}

const voices = [
  {
    id: 'zf_001',
    sid: 3,
    name: '中文女声 01',
    note: 'Kokoro · 清晰',
    initials: '女1',
    tone: 'coral',
  },
  {
    id: 'zf_059',
    sid: 34,
    name: '中文女声 59',
    note: 'Kokoro · 柔和',
    initials: '女2',
    tone: 'green',
  },
  {
    id: 'zm_009',
    sid: 58,
    name: '中文男声 09',
    note: 'Kokoro · 沉稳',
    initials: '男1',
    tone: 'blue',
  },
]

interface TtsProgressEvent {
  stage: 'loading' | 'generating' | 'complete'
  progress: number
}

function isTauriRuntime(): boolean {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function GenerateView({
  initialText,
  catalog,
  onGenerated,
  onOpenEditor,
  onAction,
}: GenerateViewProps) {
  const [text, setText] = useState(
    initialText?.trim() ||
      '声音不是最后一步才添加的装饰。它从脚本开始，在每一次停顿、重音和呼吸里，慢慢变成真正的表达。',
  )
  const [voiceId, setVoiceId] = useState('zf_001')
  const [style, setStyle] = useState<'natural' | 'precise' | 'expressive'>(
    'natural',
  )
  const [speed, setSpeed] = useState(96)
  const [pauseLength, setPauseLength] = useState(20)
  const [progress, setProgress] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [takeCount, setTakeCount] = useState(2)
  const [modelStatus, setModelStatus] = useState<TtsModelStatus | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [generatedAudio, setGeneratedAudio] =
    useState<TtsGenerateResult | null>(null)
  const [providerId, setProviderId] = useState('plugin.k2-fsa.vits-aishell3')
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const previewAudioRef = useRef<HTMLAudioElement>(null)
  const desktopRuntime = isTauriRuntime()
  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? voices[0]
  const ttsProviders = useMemo(
    () =>
      catalog?.providers.filter(
        (provider) =>
          provider.local &&
          provider.capabilities.includes('speech.synthesize'),
      ) ?? [],
    [catalog],
  )
  const selectedProvider = ttsProviders.find(
    (provider) => provider.id === providerId,
  )
  const providerReady = catalog
    ? selectedProvider?.status === 'ready'
    : Boolean(modelStatus?.installed)
  const estimatedDuration = Math.max(2.4, text.length / 4.6 / (speed / 100))
  const placeholderSamples = useMemo(
    () => createWaveSamples(text.length + voiceId.length, 240, 0.76),
    [text.length, voiceId],
  )
  const previewSamples = generatedAudio?.waveform ?? placeholderSamples
  const previewDuration = generatedAudio?.duration ?? estimatedDuration
  const previewProgress =
    generatedAudio && previewDuration > 0
      ? Math.min(1, Math.max(0, previewCurrentTime / previewDuration))
      : 0

  useEffect(() => {
    if (!desktopRuntime) return undefined

    let disposed = false
    let removeProgressListener: (() => void) | undefined

    invoke<TtsModelStatus>('tts_model_status')
      .then((status) => {
        if (!disposed) setModelStatus(status)
      })
      .catch((error) => {
        if (!disposed) setGenerationError(errorMessage(error))
      })

    void listen<TtsProgressEvent>(
      'tts-generation-progress',
      (event) => {
        if (!disposed) setProgress(event.payload.progress)
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
    if (!isPreviewPlaying) return undefined

    const syncPlaybackTime = () => {
      const audio = previewAudioRef.current
      if (audio) setPreviewCurrentTime(audio.currentTime)
    }
    syncPlaybackTime()
    const timer = window.setInterval(syncPlaybackTime, 50)

    return () => window.clearInterval(timer)
  }, [isPreviewPlaying])

  const selectStyle = (
    nextStyle: 'natural' | 'precise' | 'expressive',
  ) => {
    setStyle(nextStyle)
    if (nextStyle === 'natural') {
      setSpeed(96)
      setPauseLength(20)
    } else if (nextStyle === 'precise') {
      setSpeed(100)
      setPauseLength(12)
    } else {
      setSpeed(92)
      setPauseLength(32)
    }
  }

  const addSmartBreaks = () => {
    const formatted = text
      .replace(/\s*\n\s*/g, '')
      .replace(/([。！？!?；;])/g, '$1\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
    setText(formatted)
    onAction('已按语义标点加入建议停顿')
  }

  const generate = async () => {
    if (!text.trim() || isGenerating) return

    setIsGenerating(true)
    setGenerationError(null)
    setProgress(3)

    try {
      const execution = await executeHarnessTask<TtsGenerateResult>(
        {
          capability: 'speech.synthesize',
          providerId,
          routing: 'local',
          title: `生成语音 · ${selectedVoice.name}`,
          input: { text },
          parameters: {
            sid: selectedVoice.sid,
            speed: speed / 100,
            silenceScale: pauseLength / 100,
          },
        },
        (run) => setProgress((value) => Math.max(value, run.progress)),
      )
      const result = execution.output
      const nextTake = takeCount + 1
      const clip: AudioClip = {
        id: `generated-${crypto.randomUUID()}`,
        name: `旁白_${selectedVoice.id}_Take${nextTake}.wav`,
        duration: result.duration,
        sampleRate: result.sampleRate,
        channels: result.channels,
        kind: 'generated',
        samples: result.waveform,
        color: '#ff765f',
        sizeLabel: formatSize(result.sizeBytes),
        sourceLabel: result.engine,
        url: result.dataUrl,
        processingAudioUrl: result.dataUrl,
        transcriptionAudioUrl: result.dataUrl,
      }

      previewAudioRef.current?.pause()
      setPreviewCurrentTime(0)
      setIsPreviewPlaying(false)
      setGeneratedAudio(result)
      setTakeCount(nextTake)
      setModelStatus((current) =>
        current ? { ...current, loaded: true } : current,
      )
      onGenerated(clip)
    } catch (error) {
      const message = errorMessage(error)
      setGenerationError(message)
      onAction(`生成失败：${message}`)
    } finally {
      setIsGenerating(false)
    }
  }

  const togglePreview = () => {
    const audio = previewAudioRef.current
    if (!generatedAudio || !audio) {
      onAction('请先生成一段真实音频')
      return
    }

    if (!audio.paused && !audio.ended) {
      audio.pause()
    } else {
      if (
        audio.ended ||
        audio.currentTime >= generatedAudio.duration - 0.05
      ) {
        audio.currentTime = 0
        setPreviewCurrentTime(0)
      }
      audio.play().catch(() => onAction('无法播放生成的 WAV 文件'))
    }
  }

  const seekPreview = (ratio: number) => {
    const audio = previewAudioRef.current
    if (!generatedAudio || !audio) return

    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : generatedAudio.duration
    const nextTime = Math.min(duration, Math.max(0, ratio * duration))
    audio.currentTime = nextTime
    setPreviewCurrentTime(nextTime)
  }

  return (
    <div className="generate-page">
      <div className="page-intro">
        <div>
          <span className="section-kicker">GENERATIVE SOURCE</span>
          <h1>文字生成音频</h1>
          <p>
            当前项目 · {selectedProvider?.name ?? 'Kokoro v1.1'} ·{' '}
            {selectedProvider?.runtime ?? 'sherpa-onnx'} · 24 kHz Mono
          </p>
        </div>
        <label
          className={`engine-pill${!providerReady ? ' unavailable' : ''}`}
        >
          <span className="status-dot" />
          <select
            value={providerId}
            aria-label="音频生成 Provider"
            onChange={(event) => setProviderId(event.target.value)}
          >
            {ttsProviders.length ? (
              ttsProviders.map((provider) => (
                <option
                  key={provider.id}
                  value={provider.id}
                  disabled={provider.status !== 'ready'}
                >
                  {provider.name} ·{' '}
                  {provider.status === 'ready' ? '本地就绪' : '不可用'}
                </option>
              ))
            ) : (
              <option value="plugin.k2-fsa.vits-aishell3">
                {desktopRuntime ? '正在检查本地模型' : '仅桌面端可用'}
              </option>
            )}
          </select>
          <ChevronDown size={14} />
        </label>
      </div>

      <div className="generate-workspace">
        <main className="script-composer">
          <div className="composer-toolbar">
            <span className="composer-mode-label">单段脚本</span>
            <button
              className="quiet-button"
              type="button"
              onClick={() => setText('')}
            >
              <RotateCcw size={14} /> 清空
            </button>
          </div>

          <label className="script-editor">
            <span>脚本</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="输入要生成的内容..."
              maxLength={1200}
            />
            <small>
              {text.length} / 1,200 字 · 预计 {formatTime(estimatedDuration, true)}
            </small>
          </label>

          <div className="pronunciation-row">
            <button
              className="quiet-button"
              type="button"
              onClick={addSmartBreaks}
            >
              <Sparkles size={15} />
              智能断句
            </button>
            <span className="composer-language">
              <Languages size={15} /> 中文
            </span>
          </div>

          <section className="voice-section">
            <div className="subsection-heading">
              <div>
                <span className="section-kicker">VOICE</span>
                <h2>选择声音</h2>
              </div>
              <span className="voice-count">3 个常用音色</span>
            </div>

            <div className="voice-options">
              {voices.map((voice) => (
                <button
                  key={voice.id}
                  className={`voice-option tone-${voice.tone}${voice.id === voiceId ? ' selected' : ''}`}
                  type="button"
                  onClick={() => setVoiceId(voice.id)}
                >
                  <span className="voice-avatar">{voice.initials}</span>
                  <span>
                    <strong>{voice.name}</strong>
                    <small>{voice.note}</small>
                  </span>
                  {voice.id === voiceId && (
                    <span className="selected-check">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>

          <section className="take-preview">
            <div className="take-header">
              <span className="take-number">TAKE {takeCount}</span>
              <strong>{selectedVoice.name} · {style === 'natural' ? '自然' : style === 'precise' ? '精准' : '情绪'}</strong>
              <span className="take-time">
                {generatedAudio
                  ? `${formatTime(previewCurrentTime, true)} / ${formatTime(previewDuration, true)}`
                  : formatTime(previewDuration, true)}
              </span>
            </div>
            <div className="take-wave">
              <button
                className="round-play"
                type="button"
                aria-label={isPreviewPlaying ? '暂停当前片段' : '试听当前片段'}
                onClick={togglePreview}
              >
                {isPreviewPlaying ? (
                  <Pause size={15} fill="currentColor" />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}
              </button>
              <Waveform
                samples={previewSamples}
                progress={previewProgress}
                compact
                color="#ff765f"
                label={`当前生成片段预览，播放到 ${formatTime(previewCurrentTime, true)}`}
                onSeek={generatedAudio ? seekPreview : undefined}
              />
            </div>
            <audio
              ref={previewAudioRef}
              className="visually-hidden"
              src={generatedAudio?.dataUrl}
              onPlay={() => setIsPreviewPlaying(true)}
              onPause={() => setIsPreviewPlaying(false)}
              onTimeUpdate={(event) =>
                setPreviewCurrentTime(event.currentTarget.currentTime)
              }
              onSeeked={(event) =>
                setPreviewCurrentTime(event.currentTarget.currentTime)
              }
              onEnded={(event) => {
                setPreviewCurrentTime(event.currentTarget.duration)
                setIsPreviewPlaying(false)
              }}
            />
          </section>
        </main>

        <aside className="generation-settings">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">VOICE DIRECTION</span>
              <h2>生成设置</h2>
            </div>
            <SlidersHorizontal size={17} />
          </div>

          <div className="setting-group">
            <label>表达方式</label>
            <div className="style-options">
              <button
                className={style === 'natural' ? 'active' : ''}
                type="button"
                onClick={() => selectStyle('natural')}
              >
                自然
              </button>
              <button
                className={style === 'precise' ? 'active' : ''}
                type="button"
                onClick={() => selectStyle('precise')}
              >
                精准
              </button>
              <button
                className={style === 'expressive' ? 'active' : ''}
                type="button"
                onClick={() => selectStyle('expressive')}
              >
                情绪
              </button>
            </div>
          </div>

          <div className="setting-group">
            <div className="setting-label">
              <label htmlFor="speed">语速</label>
              <span>{(speed / 100).toFixed(2)}×</span>
            </div>
            <input
              id="speed"
              type="range"
              min="70"
              max="130"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
            <div className="range-labels">
              <span>慢</span>
              <span>快</span>
            </div>
          </div>

          <div className="setting-group">
            <div className="setting-label">
              <label htmlFor="pause-length">停顿长度</label>
              <span>{(pauseLength / 100).toFixed(2)}×</span>
            </div>
            <input
              id="pause-length"
              type="range"
              min="5"
              max="60"
              value={pauseLength}
              onChange={(event) => setPauseLength(Number(event.target.value))}
            />
            <div className="range-labels">
              <span>紧凑</span>
              <span>舒展</span>
            </div>
          </div>

          <div className="setting-group">
            <label>输出格式</label>
            <div className="select-button static-value">
              <span>
                <AudioLines size={15} /> WAV · 24 kHz · Mono
              </span>
              <Check size={15} />
            </div>
          </div>

          <div className="generation-cost">
            <span>
              <Clock3 size={14} /> 本地预计耗时
            </span>
            <strong>
              {generatedAudio
                ? `${generatedAudio.inferenceSeconds.toFixed(2)} 秒 · RTF ${generatedAudio.realTimeFactor.toFixed(2)}`
                : modelStatus?.loaded
                  ? '模型已加载'
                  : '首次生成需加载模型'}
            </strong>
          </div>

          <div className="generation-footer">
            {generationError && (
              <div className="generation-error" role="alert">
                {generationError}
              </div>
            )}
            {isGenerating && (
              <div className="generation-progress">
                <div>
                  <span>正在本地生成</span>
                  <strong>{progress}%</strong>
                </div>
                <i>
                  <span style={{ width: `${progress}%` }} />
                </i>
              </div>
            )}
            <button
              className="primary-action full-width generate-button"
              type="button"
              disabled={
                !text.trim() ||
                isGenerating ||
                !desktopRuntime ||
                !providerReady
              }
              onClick={() => void generate()}
            >
              <WandSparkles size={17} />
              {isGenerating
                ? '本地生成中…'
                : !desktopRuntime
                  ? '请在桌面端生成'
                  : !providerReady
                    ? '模型未安装'
                    : '生成音频'}
            </button>
            <button
              className="secondary-action full-width"
              type="button"
              disabled={!generatedAudio}
              onClick={onOpenEditor}
            >
              在编辑器中打开
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}
