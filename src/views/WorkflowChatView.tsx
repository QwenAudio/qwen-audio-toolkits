import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  Captions,
  CircleStop,
  Download,
  GitBranch,
  LoaderCircle,
  Mic,
  MonitorSpeaker,
  Upload,
  X,
} from 'lucide-react'
import { AudioAssetPreview } from '../components/AudioAssetPreview'
import { AudioFileDropZone } from '../components/AudioFileDropZone'
import { InlineAudioPlayer } from '../components/InlineAudioPlayer'
import { RecordingWaveform } from '../components/RecordingWaveform'
import {
  continueVoiceWorkflowFromTranscript,
  continueVoiceWorkflowToCaptionOutput,
  executeVoiceWorkflow,
  getWorkflowStreamingAsrConfig,
  getWorkflowStreamingEnhancementConfig,
  getWorkflowStreamingVadConfig,
  getWorkflowSummary,
  workflowCaptionNeedsFinalization,
  workflowIsCaptionOnly,
  workflowNodeResultForCapability,
  workflowUsesCaptionOutput,
  workflowSupportsTranscriptExport,
  type WorkflowNodeResult,
} from '../services/workflowRuntime'
import { normalizeHarnessResult } from '../domain/results'
import {
  publishCaptionOutput,
  showCaptionOutput,
  stopCaptionOutput,
  updateCaptionOutputStatus,
} from '../services/captionOutput'
import {
  finishFunAsrStream,
  finishEnhancementStream,
  finishVadStream,
  getHarnessRunOutput,
  pushFunAsrStream,
  pushEnhancementStream,
  pushVadStream,
  startSystemAudio,
  startFunAsrStream,
  startEnhancementStream,
  startVadStream,
  stopSystemAudio,
  subscribeCosyVoiceStream,
  subscribeFunAsrStream,
  subscribeSystemAudio,
} from '../services/harness'
import { RealtimeSessionController } from '../services/realtimeSession'
import { getMicrophoneStream } from '../services/audioCapture'
import {
  audioFileToClip,
  pcm16ChunksToWavFile,
} from '../utils/audio'
import { downloadTranscript } from '../utils/transcript'
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  CosyVoiceStreamEvent,
  HarnessRun,
  TtsGenerateResult,
} from '../types'

type WorkflowAudioOutput = TtsGenerateResult | AudioProcessResult
type WorkflowTurnStatus = 'running' | 'completed' | 'failed' | 'canceled'

export interface WorkflowChatTurn {
  id: string
  fileName: string
  createdAt: number
  status: WorkflowTurnStatus
  currentStep: string
  transcript: string
  transcription?: AsrTranscriptionResult | null
  reply: string
  inputAudio?: AudioClip | null
  audio: WorkflowAudioOutput | null
  steps: string[]
  nodeResults: WorkflowNodeResult[]
  error?: string
}

interface WorkflowChatViewProps {
  workflowId: string
  turns: WorkflowChatTurn[]
  setTurns: Dispatch<SetStateAction<WorkflowChatTurn[]>>
  onRunUpdate: (run: HarnessRun) => void
  onAction: (message: string) => void
}

function formatCreatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
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

function resamplePcm16Base64(
  pcmBase64: string,
  inputSampleRate: number,
  outputSampleRate = 16_000,
): string {
  if (inputSampleRate === outputSampleRate) return pcmBase64
  const binary = window.atob(pcmBase64)
  const inputLength = Math.floor(binary.length / 2)
  if (!inputLength) return ''
  const input = new Int16Array(inputLength)
  for (let index = 0; index < inputLength; index += 1) {
    const value =
      binary.charCodeAt(index * 2) |
      (binary.charCodeAt(index * 2 + 1) << 8)
    input[index] = value >= 0x8000 ? value - 0x10000 : value
  }
  const ratio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(1, Math.floor(inputLength / ratio))
  const bytes = new Uint8Array(outputLength * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const left = Math.min(inputLength - 1, Math.floor(position))
    const right = Math.min(inputLength - 1, left + 1)
    const weight = position - left
    const sample = Math.round(
      input[left] * (1 - weight) + input[right] * weight,
    )
    view.setInt16(index * 2, sample, true)
  }
  let output = ''
  for (const byte of bytes) output += String.fromCharCode(byte)
  return window.btoa(output)
}

function mergeStreamingTranscript(previous: string, candidate: string): string {
  const text = candidate.trim()
  if (!text || previous.endsWith(text)) return previous
  if (!previous) return text
  if (text.startsWith(previous)) return text
  const maximum = Math.min(previous.length, text.length)
  for (let length = maximum; length >= 2; length -= 1) {
    if (previous.slice(-length) === text.slice(0, length)) {
      return previous + text.slice(length)
    }
  }
  return previous + text
}

function uncommittedStreamingText(
  committed: string,
  candidate: string,
): string {
  const text = candidate.trim()
  const prefix = committed.trim()
  if (!prefix) return text
  if (text.startsWith(prefix)) return text.slice(prefix.length).trim()
  if (prefix.startsWith(text)) return ''
  let common = 0
  const maximum = Math.min(prefix.length, text.length)
  while (common < maximum && prefix[common] === text[common]) common += 1
  return text.slice(common).trim()
}

function formatResultTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, seconds - minutes * 60)
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

function resultFallbackText(output: Record<string, unknown>): string {
  if (Array.isArray(output.tags)) {
    return output.tags
      .slice(0, 5)
      .map((item) =>
        typeof item === 'object' && item
          ? String((item as { label?: unknown }).label ?? '')
          : '',
      )
      .filter(Boolean)
      .join(' · ')
  }
  if (typeof output.detected === 'boolean') {
    return output.detected ? '检测到目标事件' : '未检测到目标事件'
  }
  if (typeof output.language === 'string') {
    return `语言：${output.language}`
  }
  if (typeof output.speakerCount === 'number') {
    return `${output.speakerCount} 位说话人`
  }
  if (typeof output.dimension === 'number') {
    return `${output.dimension} 维向量`
  }
  return '结果已生成'
}

function WorkflowNodeResultCard({
  result,
}: {
  result: WorkflowNodeResult
}) {
  const normalized = normalizeHarnessResult(result.output)
  return (
    <article
      className={`workflow-node-result${result.exposedAs.length ? ' exposed' : ''}`}
    >
      <header>
        <div>
          <strong>{result.label}</strong>
          <small>{result.capability}</small>
        </div>
        {result.exposedAs.length > 0 && (
          <span>{result.exposedAs.join(' · ')}</span>
        )}
      </header>
      {normalized.text && <p>{normalized.text}</p>}
      {normalized.audio.map((asset) =>
        result.exposedAs.length > 0 && normalized.audio.length === 1 ? (
          <AudioAssetPreview
            key={asset.id}
            src={asset.dataUrl}
            peaks={asset.peaks}
            duration={asset.duration}
            role="output"
          />
        ) : (
          <InlineAudioPlayer
            key={asset.id}
            src={asset.dataUrl}
            duration={asset.duration ?? 0}
          />
        ),
      )}
      {normalized.segments.length > 0 && (
        <div className="workflow-node-segments">
          {normalized.segments.slice(0, 12).map((segment) => (
            <div key={segment.id}>
              <time>
                {formatResultTime(segment.start)}–{formatResultTime(segment.end)}
              </time>
              <span>{segment.text ?? segment.label}</span>
            </div>
          ))}
          {normalized.segments.length > 12 && (
            <small>另有 {normalized.segments.length - 12} 个片段</small>
          )}
        </div>
      )}
      {!normalized.text &&
        !normalized.audio.length &&
        !normalized.segments.length && (
          <p>{resultFallbackText(result.output)}</p>
        )}
      {(normalized.runtime.engine ||
        normalized.runtime.inferenceSeconds !== undefined ||
        normalized.runtime.realTimeFactor !== undefined) && (
        <footer>
          {normalized.runtime.engine && <span>{normalized.runtime.engine}</span>}
          {normalized.runtime.inferenceSeconds !== undefined && (
            <span>{normalized.runtime.inferenceSeconds.toFixed(2)} s</span>
          )}
          {normalized.runtime.realTimeFactor !== undefined && (
            <span>RTF {normalized.runtime.realTimeFactor.toFixed(3)}</span>
          )}
        </footer>
      )}
    </article>
  )
}

export function WorkflowChatView({
  workflowId,
  turns,
  setTurns,
  onRunUpdate,
  onAction,
}: WorkflowChatViewProps) {
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [audioSource, setAudioSource] = useState<'microphone' | 'system'>(
    'microphone',
  )
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const streamStartAtRef = useRef(0)
  const pushedAudioMsRef = useRef(0)
  const systemAudioSessionRef = useRef<string | null>(null)
  const systemAudioChunksRef = useRef<string[]>([])
  const enhancementAudioChunksRef = useRef<string[]>([])
  const systemAudioUnlistenRef = useRef<(() => void) | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  const asrSessionRef = useRef<string | null>(null)
  const vadSessionRef = useRef<string | null>(null)
  const enhancementSessionRef = useRef<string | null>(null)
  const captureContextRef = useRef<AudioContext | null>(null)
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const captureGainRef = useRef<GainNode | null>(null)
  const streamQueueRef = useRef<Promise<void>>(Promise.resolve())
  const speechStartedRef = useRef(false)
  const finishingRef = useRef(false)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const playbackCursorRef = useRef(0)
  const realtimeSessionRef = useRef(new RealtimeSessionController())
  const asrGenerationsRef = useRef(new Map<string, number>())
  const ttsTurnsRef = useRef(
    new Map<string, { turnId: string; generation: number }>(),
  )
  const unboundTtsEventsRef = useRef(
    new Map<string, CosyVoiceStreamEvent[]>(),
  )
  const captionTranscriptRef = useRef('')
  const captionLatestRawRef = useRef('')
  const captionFinalizedRawRef = useRef('')
  const captionFinalizedTextRef = useRef('')
  const captionFinalizeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const captionSpeechActiveRef = useRef(false)
  const captionPreRollRef = useRef<string[]>([])
  const onRunUpdateRef = useRef(onRunUpdate)
  const onActionRef = useRef(onAction)
  const selectedTurn =
    turns.find((turn) => turn.id === selectedTurnId) ?? null
  const workflowSummary = getWorkflowSummary(workflowId)
  const workflowStepLabels = useMemo(
    () => workflowSummary.split(' → ').filter(Boolean),
    [workflowSummary],
  )
  const streamingAsrConfig = getWorkflowStreamingAsrConfig(workflowId)
  const streamingEnhancementConfig =
    getWorkflowStreamingEnhancementConfig(workflowId)
  const streamingVadConfig = getWorkflowStreamingVadConfig(workflowId)
  const streamingAsrLabel =
    streamingAsrConfig?.adapter === 'streaming-zipformer'
      ? 'Streaming Zipformer'
      : streamingAsrConfig?.adapter === 'streaming-paraformer'
        ? 'Streaming Paraformer'
        : streamingAsrConfig?.adapter === 'bailian-funasr'
          ? 'FunASR Realtime'
          : '流式 ASR'
  const transcriptExportEnabled =
    workflowSupportsTranscriptExport(workflowId)
  const captionOutputEnabled = workflowUsesCaptionOutput(workflowId)
  const captionOnlyWorkflow = workflowIsCaptionOnly(workflowId)
  const captionNeedsFinalization =
    workflowCaptionNeedsFinalization(workflowId)
  const vadSilenceMsRef = useRef(1000)
  vadSilenceMsRef.current = streamingVadConfig
    ? Number(streamingVadConfig.parameters.minSilenceDuration ?? 0.55) * 1000
    : 1000

  useEffect(() => {
    onRunUpdateRef.current = onRunUpdate
    onActionRef.current = onAction
  }, [onAction, onRunUpdate])

  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [turns])

  const updateTurn = useCallback(
    (id: string, update: Partial<WorkflowChatTurn>) => {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id ? { ...turn, ...update } : turn,
        ),
      )
    },
    [setTurns],
  )

  const updateNodeResult = useCallback(
    (turnId: string, result: WorkflowNodeResult) => {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                nodeResults: [
                  ...(turn.nodeResults ?? []).filter(
                    (item) => item.nodeId !== result.nodeId,
                  ),
                  result,
                ].sort((left, right) => left.order - right.order),
              }
            : turn,
        ),
      )
    },
    [setTurns],
  )

  const clearActiveTurn = useCallback((turnId: string) => {
    if (activeTurnRef.current === turnId) {
      activeTurnRef.current = null
    }
  }, [])

  const releaseCapture = useCallback(() => {
    captureProcessorRef.current?.disconnect()
    captureProcessorRef.current = null
    captureSourceRef.current?.disconnect()
    captureSourceRef.current = null
    captureGainRef.current?.disconnect()
    captureGainRef.current = null
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
    recordingStreamRef.current = null
    void captureContextRef.current?.close()
    captureContextRef.current = null
  }, [])

  const finishActiveEnhancement = useCallback(
    async (forwardTail: boolean) => {
      const sessionId = enhancementSessionRef.current
      enhancementSessionRef.current = null
      if (!sessionId) return
      try {
        const output = await finishEnhancementStream(sessionId)
        if (output.pcmBase64) {
          enhancementAudioChunksRef.current.push(output.pcmBase64)
        }
        const asrSession = asrSessionRef.current
        if (forwardTail && output.pcmBase64 && asrSession) {
          await pushFunAsrStream(asrSession, output.pcmBase64)
        }
      } catch (error) {
        if (forwardTail) throw error
      } finally {
        if (!forwardTail) enhancementAudioChunksRef.current = []
      }
    },
    [],
  )

  const recordEnhancementResult = useCallback(
    async (turnId: string) => {
      if (
        !streamingEnhancementConfig ||
        !enhancementAudioChunksRef.current.length
      ) {
        return
      }
      const file = pcm16ChunksToWavFile(
        enhancementAudioChunksRef.current,
        48_000,
        `实时增强-${Date.now()}.wav`,
      )
      enhancementAudioChunksRef.current = []
      const clip = await audioFileToClip(file)
      const dataUrl = clip.processingAudioUrl ?? clip.url
      if (!dataUrl) return
      const result = workflowNodeResultForCapability(
        'audio.enhance',
        {
          dataUrl,
          fileName: file.name,
          duration: clip.duration,
          sampleRate: 48_000,
          channels: 1,
          engine:
            streamingEnhancementConfig.adapter ??
            streamingEnhancementConfig.providerId,
        },
        undefined,
        workflowId,
      )
      if (result) updateNodeResult(turnId, result)
    },
    [
      streamingEnhancementConfig,
      updateNodeResult,
      workflowId,
    ],
  )

  const pushCaptionAudio = useCallback(
    async (
      asrSession: string,
      vadSession: string,
      asrPcm: string,
      vadPcm: string,
      preRollChunkCount: number,
    ) => {
      captionPreRollRef.current.push(asrPcm)
      if (captionPreRollRef.current.length > preRollChunkCount) {
        captionPreRollRef.current.splice(
          0,
          captionPreRollRef.current.length - preRollChunkCount,
        )
      }
      const update = await pushVadStream(vadSession, vadPcm)
      if (update.speechStarted) captionSpeechActiveRef.current = true
      if (captionSpeechActiveRef.current) {
        const chunks = captionPreRollRef.current.splice(0)
        for (const chunk of chunks) {
          await pushFunAsrStream(asrSession, chunk)
        }
      }
      if (update.speechEnded) captionSpeechActiveRef.current = false
      return update
    },
    [],
  )

  const finalizeCaptionSegment = useCallback(
    (
      turnId: string,
      generation: number,
      status: 'listening' | 'stopped' = 'listening',
    ) => {
      const raw = captionLatestRawRef.current.trim()
      const delta = uncommittedStreamingText(
        captionFinalizedRawRef.current,
        raw,
      )
      if (!delta) return captionFinalizeQueueRef.current
      captionFinalizedRawRef.current = raw
      captionFinalizeQueueRef.current = captionFinalizeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          const output = captionNeedsFinalization
            ? await continueVoiceWorkflowToCaptionOutput(
                delta,
                (run) => {
                  realtimeSessionRef.current.trackRun(run, generation)
                  if (realtimeSessionRef.current.isCurrent(generation)) {
                    onRunUpdateRef.current(run)
                  }
                },
                workflowId,
                (result) => updateNodeResult(turnId, result),
              )
            : null
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          const finalized = output?.reply || delta
          captionFinalizedTextRef.current = [
            captionFinalizedTextRef.current,
            finalized,
          ]
            .filter(Boolean)
            .join('\n')
          updateTurn(turnId, {
            transcript: captionFinalizedTextRef.current,
            reply: captionFinalizedTextRef.current,
            currentStep:
              status === 'stopped' ? '字幕已停止' : 'VAD · 等待声音',
          })
          await publishCaptionOutput(finalized, true, status)
        })
      return captionFinalizeQueueRef.current
    },
    [
      captionNeedsFinalization,
      updateNodeResult,
      updateTurn,
      workflowId,
    ],
  )

  const playPcmChunk = useCallback(
    async (pcmBase64: string, sampleRate: number, generation: number) => {
      if (!realtimeSessionRef.current.isCurrent(generation)) return
      const binary = window.atob(pcmBase64)
      const samples = new Float32Array(Math.floor(binary.length / 2))
      for (let index = 0; index < samples.length; index += 1) {
        const low = binary.charCodeAt(index * 2)
        const high = binary.charCodeAt(index * 2 + 1)
        const value = (high << 8) | low
        samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / 0x7fff
      }
      const context =
        playbackContextRef.current ??
        new AudioContext({ latencyHint: 'interactive' })
      playbackContextRef.current = context
      await context.resume()
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      if (
        !realtimeSessionRef.current.trackAudioSource(source, generation)
      ) {
        return
      }
      const startAt = Math.max(context.currentTime + 0.025, playbackCursorRef.current)
      source.start(startAt)
      playbackCursorRef.current = startAt + buffer.duration
    },
    [],
  )

  useEffect(() => {
    let disposed = false
    let removeAsr: (() => void) | undefined
    let removeTts: (() => void) | undefined

    const handleCosyVoiceEvent = (event: CosyVoiceStreamEvent) => {
      const turn = ttsTurnsRef.current.get(event.sessionId)
      if (
        !turn ||
        !realtimeSessionRef.current.isCurrent(turn.generation)
      ) {
        return
      }
      const { turnId, generation } = turn
      if (event.kind === 'audio' && event.pcmBase64) {
        updateTurn(turnId, { currentStep: '正在播放合成语音' })
        void playPcmChunk(event.pcmBase64, event.sampleRate, generation)
        return
      }
      ttsTurnsRef.current.delete(event.sessionId)
      if (event.kind === 'error') {
        updateTurn(turnId, {
          status: 'failed',
          currentStep: '合成失败',
          error: event.error || '流式语音合成失败',
        })
        clearActiveTurn(turnId)
        setBusy(false)
        onActionRef.current(event.error || '流式语音合成失败')
        return
      }
      void getHarnessRunOutput<TtsGenerateResult>(event.runId)
        .then((result) => {
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          const nodeResult = workflowNodeResultForCapability(
            'speech.synthesize',
            result.output as unknown as Record<string, unknown>,
            undefined,
            workflowId,
          )
          if (nodeResult) updateNodeResult(turnId, nodeResult)
          updateTurn(turnId, {
            status: 'completed',
            currentStep: '处理完成',
            audio: result.output,
          })
          setSelectedTurnId(turnId)
          onActionRef.current('语音对话完成')
        })
        .catch(() => {
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          updateTurn(turnId, {
            status: 'completed',
            currentStep: '处理完成',
          })
        })
        .finally(() => {
          if (realtimeSessionRef.current.isCurrent(generation)) {
            clearActiveTurn(turnId)
            setBusy(false)
          }
        })
    }

    void subscribeFunAsrStream((event) => {
      if (event.sessionId !== asrSessionRef.current) return
      const generation = asrGenerationsRef.current.get(event.sessionId)
      if (
        generation === undefined ||
        !realtimeSessionRef.current.isCurrent(generation)
      ) {
        return
      }
      const turnId = activeTurnRef.current
      if (!turnId) return
      const captionMetrics = () => {
        return { vadSilenceMs: vadSilenceMsRef.current }
      }
      if (event.kind === 'partial' || event.kind === 'final') {
        const rawTranscript = captionOutputEnabled
          ? mergeStreamingTranscript(
              captionTranscriptRef.current,
              event.text,
            )
          : event.text
        if (captionOutputEnabled && captionNeedsFinalization) {
          captionLatestRawRef.current = event.text
        } else if (captionOutputEnabled && event.kind === 'final') {
          captionTranscriptRef.current = rawTranscript
        }
        if (captionOutputEnabled) {
          const liveText = captionNeedsFinalization
            ? uncommittedStreamingText(
                captionFinalizedRawRef.current,
                event.text,
              )
            : event.text
          void publishCaptionOutput(
            liveText,
            event.kind === 'final' && !captionNeedsFinalization,
            'speech',
            captionMetrics(),
          )
        } else {
          // Mirror the live transcript to the caption window even when the
          // workflow isn't caption-output, so the caption button has content.
          void publishCaptionOutput(
            event.text,
            event.kind === 'final',
            'speech',
            captionMetrics(),
          )
        }
        if (
          captionOutputEnabled &&
          captionNeedsFinalization &&
          event.kind === 'final'
        ) {
          void finalizeCaptionSegment(turnId, generation)
        }
        const transcript = captionNeedsFinalization
          ? [
              captionFinalizedTextRef.current,
              uncommittedStreamingText(
                captionFinalizedRawRef.current,
                event.text,
              ),
            ]
              .filter(Boolean)
              .join('\n')
          : rawTranscript
        updateTurn(turnId, {
          transcript,
          currentStep: captionOnlyWorkflow
            ? '字幕输出 · 实时更新'
            : `${streamingAsrLabel} · 流式识别`,
        })
        return
      }
      if (event.kind === 'error') {
        asrSessionRef.current = null
        void finishActiveEnhancement(false)
        if (vadSessionRef.current) {
          void finishVadStream(vadSessionRef.current)
          vadSessionRef.current = null
        }
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop()
        }
        releaseCapture()
        systemAudioUnlistenRef.current?.()
        systemAudioUnlistenRef.current = null
        if (systemAudioSessionRef.current) {
          void stopSystemAudio(systemAudioSessionRef.current)
          systemAudioSessionRef.current = null
        }
        setRecording(false)
        if (captionOutputEnabled) {
          void publishCaptionOutput(
            event.error || '流式识别失败',
            false,
            'error',
          )
        }
        updateTurn(turnId, {
          status: 'failed',
          currentStep: '识别失败',
          error: event.error || '流式 ASR 识别失败',
        })
        asrGenerationsRef.current.delete(event.sessionId)
        clearActiveTurn(turnId)
        setBusy(false)
        onActionRef.current(event.error || '流式 ASR 识别失败')
        return
      }

      asrSessionRef.current = null
      asrGenerationsRef.current.delete(event.sessionId)
      updateTurn(turnId, {
        transcript: captionOutputEnabled
          ? captionTranscriptRef.current || event.text
          : event.text,
        currentStep: captionOnlyWorkflow
          ? '字幕输出 · 正在结束'
          : '正在生成回复',
      })
      void getHarnessRunOutput<AsrTranscriptionResult>(event.runId)
        .then((result) => {
          updateTurn(turnId, { transcription: result.output })
          const nodeResult = workflowNodeResultForCapability(
            'speech.transcribe',
            result.output as unknown as Record<string, unknown>,
            undefined,
            workflowId,
          )
          if (nodeResult) updateNodeResult(turnId, nodeResult)
        })
        .catch(() => undefined)
      if (captionOnlyWorkflow) {
        captionLatestRawRef.current = event.text
        const finalize = captionNeedsFinalization
          ? finalizeCaptionSegment(turnId, generation, 'stopped')
          : publishCaptionOutput(event.text, true, 'stopped')
        void finalize
          .then(async () => {
            if (!realtimeSessionRef.current.isCurrent(generation)) return
            const finalText =
              captionFinalizedTextRef.current || event.text
            updateTurn(turnId, {
              transcript: finalText,
              reply: finalText,
              status: 'completed',
              currentStep: '字幕已停止',
              steps: workflowStepLabels,
            })
            await stopCaptionOutput()
            clearActiveTurn(turnId)
            setBusy(false)
          })
          .catch((error) => {
            if (!realtimeSessionRef.current.isCurrent(generation)) return
            const message =
              error instanceof Error ? error.message : String(error)
            updateTurn(turnId, {
              status: 'failed',
              currentStep: '字幕处理失败',
              error: message,
            })
            if (captionOutputEnabled) {
              void publishCaptionOutput(message, false, 'error')
            }
            clearActiveTurn(turnId)
            setBusy(false)
            onActionRef.current(`字幕处理失败：${message}`)
          })
        return
      }
      if (captionNeedsFinalization) {
        void captionFinalizeQueueRef.current.finally(stopCaptionOutput)
      } else {
        void publishCaptionOutput(event.text, true, 'stopped').finally(
          stopCaptionOutput,
        )
      }
      void continueVoiceWorkflowFromTranscript(
        event.text,
        (run) => {
          realtimeSessionRef.current.trackRun(run, generation)
          if (realtimeSessionRef.current.isCurrent(generation)) {
            onRunUpdateRef.current(run)
          }
        },
        workflowId,
        (result) => updateNodeResult(turnId, result),
      )
        .then((output) => {
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          updateTurn(turnId, {
            reply: output.reply,
            audio: output.audio,
            steps: output.steps,
            status: output.ttsStream ? 'running' : 'completed',
            currentStep: output.ttsStream
              ? '正在流式合成'
              : '处理完成',
          })
          if (output.ttsStream) {
            ttsTurnsRef.current.set(output.ttsStream.sessionId, {
              turnId,
              generation,
            })
            const pending =
              unboundTtsEventsRef.current.get(output.ttsStream.sessionId) ?? []
            unboundTtsEventsRef.current.delete(output.ttsStream.sessionId)
            pending.forEach(handleCosyVoiceEvent)
            realtimeSessionRef.current.trackRun(
              output.ttsStream.run,
              generation,
            )
            onRunUpdateRef.current(output.ttsStream.run)
          } else {
            clearActiveTurn(turnId)
            setBusy(false)
            setSelectedTurnId(turnId)
          }
        })
        .catch((error) => {
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          const message = error instanceof Error ? error.message : String(error)
          updateTurn(turnId, {
            status: 'failed',
            currentStep: '运行失败',
            error: message,
          })
          clearActiveTurn(turnId)
          setBusy(false)
          onActionRef.current(`流程失败：${message}`)
        })
    }).then((remove) => {
      if (disposed) remove()
      else removeAsr = remove
    })

    void subscribeCosyVoiceStream((event) => {
      if (!ttsTurnsRef.current.has(event.sessionId)) {
        const pending =
          unboundTtsEventsRef.current.get(event.sessionId) ?? []
        if (pending.length < 128) pending.push(event)
        unboundTtsEventsRef.current.set(event.sessionId, pending)
        return
      }
      handleCosyVoiceEvent(event)
    }).then((remove) => {
      if (disposed) remove()
      else removeTts = remove
    })

    return () => {
      disposed = true
      removeAsr?.()
      removeTts?.()
    }
  }, [
    clearActiveTurn,
    captionOutputEnabled,
    captionNeedsFinalization,
    captionOnlyWorkflow,
    finalizeCaptionSegment,
    finishActiveEnhancement,
    playPcmChunk,
    releaseCapture,
    streamingAsrLabel,
    updateNodeResult,
    updateTurn,
    workflowStepLabels,
    workflowId,
  ])

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop()
      }
      releaseCapture()
      if (asrSessionRef.current) {
        void finishFunAsrStream(asrSessionRef.current)
      }
      void finishActiveEnhancement(false)
      if (vadSessionRef.current) {
        void finishVadStream(vadSessionRef.current)
      }
      systemAudioUnlistenRef.current?.()
      if (systemAudioSessionRef.current) {
        void stopSystemAudio(systemAudioSessionRef.current)
      }
      realtimeSessionRef.current.cancel('dispose')
      void playbackContextRef.current?.close()
    },
    [finishActiveEnhancement, releaseCapture],
  )

  const submitAudio = async (file: File) => {
    if (busy) return
    const generation = realtimeSessionRef.current.beginTurn()
    const id = `workflow-turn-${crypto.randomUUID()}`
    activeTurnRef.current = id
    playbackCursorRef.current = 0
    const turn: WorkflowChatTurn = {
      id,
      fileName: file.name,
      createdAt: Date.now(),
      status: 'running',
      currentStep: '准备音频',
      transcript: '',
      reply: '',
      inputAudio: null,
      audio: null,
      steps: [],
      nodeResults: [],
    }
    setTurns((current) => [...current, turn])
    setBusy(true)
    try {
      const inputAudio = await audioFileToClip(file)
      updateTurn(id, { inputAudio })
      const output = await executeVoiceWorkflow(
        file,
        (run) => {
          realtimeSessionRef.current.trackRun(run, generation)
          if (!realtimeSessionRef.current.isCurrent(generation)) return
          onRunUpdate(run)
          updateTurn(id, {
            currentStep: `${run.providerName || run.modelId} · ${run.progress}%`,
          })
        },
        workflowId,
        (result) => updateNodeResult(id, result),
      )
      if (!realtimeSessionRef.current.isCurrent(generation)) return
      if (captionOutputEnabled && output.transcript) {
        await showCaptionOutput()
        await publishCaptionOutput(output.transcript, true, 'stopped')
      }
      updateTurn(id, {
        status: 'completed',
        currentStep: '处理完成',
        transcript: output.transcript,
        transcription: output.transcription,
        reply: output.reply,
        audio: output.audio,
        steps: output.steps,
        nodeResults: output.nodeResults,
      })
      if (!captionOnlyWorkflow) setSelectedTurnId(id)
      onAction(
        captionOnlyWorkflow ? '字幕流程执行完成' : '语音对话流程执行完成',
      )
    } catch (error) {
      if (!realtimeSessionRef.current.isCurrent(generation)) return
      const message =
        error instanceof Error ? error.message : String(error)
      updateTurn(id, {
        status: 'failed',
        currentStep: '运行失败',
        error: message,
      })
      setSelectedTurnId(id)
      onAction(`流程失败：${message}`)
    } finally {
      if (realtimeSessionRef.current.isCurrent(generation)) {
        clearActiveTurn(id)
        setBusy(false)
      }
    }
  }

  const stopStreamingRecording = async () => {
    if (finishingRef.current) return
    finishingRef.current = true
    setRecording(false)
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
    releaseCapture()
    const turnId = activeTurnRef.current
    if (turnId) {
      updateTurn(turnId, {
        currentStep: captionOnlyWorkflow
          ? '字幕输出 · 正在结束'
          : `${streamingAsrLabel} · 正在完成识别`,
      })
    }
    try {
      await streamQueueRef.current
      await finishActiveEnhancement(true)
      if (turnId) await recordEnhancementResult(turnId)
      if (vadSessionRef.current) {
        await finishVadStream(vadSessionRef.current)
        vadSessionRef.current = null
      }
      if (asrSessionRef.current) {
        await finishFunAsrStream(asrSessionRef.current)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (turnId) {
        updateTurn(turnId, {
          status: 'failed',
          currentStep: '结束识别失败',
          error: message,
        })
        clearActiveTurn(turnId)
      }
      setBusy(false)
      onAction(`无法结束实时识别：${message}`)
    }
  }

  const startStreamingSystemRecording = async () => {
    if (!streamingAsrConfig) {
      onAction('当前编排没有流式 ASR')
      return
    }
    const generation = realtimeSessionRef.current.beginTurn()
    const turnId = `workflow-turn-${crypto.randomUUID()}`
    setTurns((current) => [
      ...current,
      {
        id: turnId,
        fileName: captionOnlyWorkflow
          ? '实时字幕 · 电脑音频'
          : '实时电脑音频',
        createdAt: Date.now(),
        status: 'running',
        currentStep: streamingVadConfig
          ? 'VAD · 等待声音'
          : `${streamingAsrLabel} · 等待声音`,
        transcript: '',
        reply: '',
        inputAudio: null,
        audio: null,
        steps: workflowStepLabels,
        nodeResults: [],
      },
    ])
    activeTurnRef.current = turnId
    captionTranscriptRef.current = ''
    captionLatestRawRef.current = ''
    captionFinalizedRawRef.current = ''
    captionFinalizedTextRef.current = ''
    captionFinalizeQueueRef.current = Promise.resolve()
    captionSpeechActiveRef.current = false
    captionPreRollRef.current = []
    speechStartedRef.current = false
    finishingRef.current = false
    streamQueueRef.current = Promise.resolve()
    streamStartAtRef.current = performance.now()
    pushedAudioMsRef.current = 0
    systemAudioChunksRef.current = []
    enhancementAudioChunksRef.current = []
    setBusy(true)

    try {
      if (captionOutputEnabled) await showCaptionOutput()
      const asr = await startFunAsrStream({
        clipName: `${
          captionOnlyWorkflow ? '实时字幕' : '实时对话'
        }-电脑音频-${Date.now()}`,
        providerId: streamingAsrConfig.providerId,
        modelId: streamingAsrConfig.modelId,
        sampleRate: 48_000,
        language: String(streamingAsrConfig.parameters.language ?? 'auto'),
        context: String(streamingAsrConfig.parameters.context ?? ''),
        semanticPunctuation:
          streamingAsrConfig.parameters.semanticPunctuation !== false,
      })
      asrSessionRef.current = asr.sessionId
      asrGenerationsRef.current.set(asr.sessionId, generation)
      realtimeSessionRef.current.trackRun(asr.run, generation)
      onRunUpdate(asr.run)

      if (streamingEnhancementConfig) {
        const enhancement = await startEnhancementStream(
          streamingEnhancementConfig.providerId,
          48_000,
          Number(
            streamingEnhancementConfig.parameters.denoiseStrength ?? 1,
          ),
        )
        enhancementSessionRef.current = enhancement.sessionId
      }

      if (streamingVadConfig) {
        const vad = await startVadStream({
          providerId: streamingVadConfig.providerId,
          modelId: streamingVadConfig.modelId,
          adapter: streamingVadConfig.adapter,
          threshold: Number(
            streamingVadConfig.parameters.threshold ?? 0.25,
          ),
          minSpeechDuration: Number(
            streamingVadConfig.parameters.minSpeechDuration ?? 0.18,
          ),
          minSilenceDuration: Number(
            streamingVadConfig.parameters.minSilenceDuration ?? 0.55,
          ),
        })
        vadSessionRef.current = vad.sessionId
      }

      systemAudioUnlistenRef.current = await subscribeSystemAudio((chunk) => {
        if (
          chunk.sessionId !== systemAudioSessionRef.current ||
          finishingRef.current
        ) {
          return
        }
        const asrSession = asrSessionRef.current
        const vadSession = vadSessionRef.current
        if (!asrSession) return
        pushedAudioMsRef.current +=
          (window.atob(chunk.pcmBase64).length / 2 / chunk.sampleRate) * 1000
        if (!captionOnlyWorkflow) {
          systemAudioChunksRef.current.push(chunk.pcmBase64)
        }
        streamQueueRef.current = streamQueueRef.current
          .then(async () => {
            let asrPcm = chunk.pcmBase64
            let asrSampleRate = chunk.sampleRate
            if (enhancementSessionRef.current) {
              const enhanced = await pushEnhancementStream(
                enhancementSessionRef.current,
                asrPcm,
              )
              if (!enhanced.pcmBase64) return
              enhancementAudioChunksRef.current.push(enhanced.pcmBase64)
              asrPcm = enhanced.pcmBase64
              asrSampleRate = enhanced.sampleRate
            }
            const vadPcm = resamplePcm16Base64(
              asrPcm,
              asrSampleRate,
            )
            if (!vadSession) {
              await pushFunAsrStream(asrSession, asrPcm)
              updateTurn(turnId, {
                currentStep: `${streamingAsrLabel} · 流式识别`,
              })
              return
            }
            const vadUpdate = captionOutputEnabled
              ? await pushCaptionAudio(
                  asrSession,
                  vadSession,
                  asrPcm,
                  vadPcm,
                  32,
                )
              : await (async () => {
                  await pushFunAsrStream(asrSession, asrPcm)
                  return pushVadStream(vadSession, vadPcm)
                })()
            if (vadUpdate.speechStarted) {
              speechStartedRef.current = true
              updateTurn(turnId, {
                currentStep: captionOnlyWorkflow
                  ? '字幕输出 · 实时更新'
                  : `${streamingAsrLabel} · 流式识别`,
              })
              if (captionOnlyWorkflow) {
                await updateCaptionOutputStatus('speech')
              }
            } else if (
              vadUpdate.speechEnded &&
              speechStartedRef.current
            ) {
              if (captionOnlyWorkflow) {
                speechStartedRef.current = false
                updateTurn(turnId, {
                  currentStep: 'VAD · 等待声音',
                })
                void finalizeCaptionSegment(turnId, generation)
                await updateCaptionOutputStatus('listening')
              } else {
                void stopStreamingSystemRecording()
              }
            }
          })
          .catch((error) => {
            if (finishingRef.current) return
            finishingRef.current = true
            const message =
              error instanceof Error ? error.message : String(error)
            systemAudioUnlistenRef.current?.()
            systemAudioUnlistenRef.current = null
            if (systemAudioSessionRef.current) {
              void stopSystemAudio(systemAudioSessionRef.current)
              systemAudioSessionRef.current = null
            }
            void finishActiveEnhancement(false)
            if (vadSessionRef.current) {
              void finishVadStream(vadSessionRef.current)
              vadSessionRef.current = null
            }
            if (asrSessionRef.current) {
              void finishFunAsrStream(asrSessionRef.current)
            }
            updateTurn(turnId, {
              status: 'failed',
              currentStep: '电脑音频流失败',
              error: message,
            })
            if (captionOutputEnabled) {
              void publishCaptionOutput(message, false, 'error')
            }
            clearActiveTurn(turnId)
            setRecording(false)
            setBusy(false)
            onActionRef.current(`电脑音频流失败：${message}`)
          })
      })
      const session = await startSystemAudio(false)
      systemAudioSessionRef.current = session.sessionId
      setRecording(true)
      onAction(
        captionOnlyWorkflow
          ? '实时字幕已开始'
          : '电脑音频实时对话已开始',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      systemAudioUnlistenRef.current?.()
      systemAudioUnlistenRef.current = null
      if (systemAudioSessionRef.current) {
        void stopSystemAudio(systemAudioSessionRef.current)
        systemAudioSessionRef.current = null
      }
      void finishActiveEnhancement(false)
      if (vadSessionRef.current) {
        void finishVadStream(vadSessionRef.current)
        vadSessionRef.current = null
      }
      if (asrSessionRef.current) {
        void finishFunAsrStream(asrSessionRef.current)
      }
      if (captionOutputEnabled) {
        void publishCaptionOutput(message, false, 'error')
      }
      updateTurn(turnId, {
        status: 'failed',
        currentStep: '无法启动电脑音频流',
        error: message,
      })
      clearActiveTurn(turnId)
      setBusy(false)
      onAction(`无法启动电脑音频流：${message}`)
    }
  }

  const stopStreamingSystemRecording = async () => {
    if (finishingRef.current) return
    finishingRef.current = true
    setRecording(false)
    const turnId = activeTurnRef.current
    try {
      const systemSession = systemAudioSessionRef.current
      systemAudioSessionRef.current = null
      if (systemSession) await stopSystemAudio(systemSession)
      systemAudioUnlistenRef.current?.()
      systemAudioUnlistenRef.current = null
      await streamQueueRef.current
      await finishActiveEnhancement(true)
      if (turnId) await recordEnhancementResult(turnId)
      if (!captionOnlyWorkflow && turnId && systemAudioChunksRef.current.length) {
        const file = pcm16ChunksToWavFile(
          systemAudioChunksRef.current,
          48_000,
          `实时电脑音频-${Date.now()}.wav`,
        )
        void audioFileToClip(file)
          .then((inputAudio) => updateTurn(turnId, { inputAudio }))
          .catch((error) =>
            onActionRef.current(
              `无法准备电脑音频回放：${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
      }
      systemAudioChunksRef.current = []
      if (vadSessionRef.current) {
        await finishVadStream(vadSessionRef.current)
        vadSessionRef.current = null
      }
      if (asrSessionRef.current) {
        await finishFunAsrStream(asrSessionRef.current)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (turnId) {
        updateTurn(turnId, {
          status: 'failed',
          currentStep: '结束电脑音频流失败',
          error: message,
        })
        clearActiveTurn(turnId)
      }
      if (captionOutputEnabled) {
        void publishCaptionOutput(message, false, 'error')
      }
      setBusy(false)
      onAction(`无法结束电脑音频流：${message}`)
    }
  }

  const startSystemRecording = async () => {
    if (busy) return
    if (streamingAsrConfig) {
      await startStreamingSystemRecording()
      return
    }
    try {
      systemAudioChunksRef.current = []
      const unlisten = await subscribeSystemAudio((chunk) => {
        if (chunk.sessionId !== systemAudioSessionRef.current) return
        systemAudioChunksRef.current.push(chunk.pcmBase64)
      })
      systemAudioUnlistenRef.current = unlisten
      const session = await startSystemAudio()
      systemAudioSessionRef.current = session.sessionId
      setRecording(true)
      onAction('电脑音频采集已开始')
    } catch (error) {
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
    if (asrSessionRef.current && busy) {
      await stopStreamingSystemRecording()
      return
    }
    const sessionId = systemAudioSessionRef.current
    if (!sessionId) return
    setRecording(false)
    try {
      await stopSystemAudio(sessionId)
      const file = pcm16ChunksToWavFile(
        systemAudioChunksRef.current,
        48_000,
        `电脑音频-${Date.now()}.wav`,
      )
      if (file.size <= 44) {
        throw new Error('没有捕获到可用音频，请确认 Chrome 正在播放声音')
      }
      await submitAudio(file)
    } catch (error) {
      onAction(
        `电脑音频处理失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      systemAudioSessionRef.current = null
      systemAudioChunksRef.current = []
      systemAudioUnlistenRef.current?.()
      systemAudioUnlistenRef.current = null
    }
  }

  const startRecording = async () => {
    if (busy && asrSessionRef.current) return
    if (!streamingAsrConfig) {
      onAction('当前编排没有流式 ASR，请上传音频或换用流式识别模型')
      return
    }
    const interruptedTurnId = activeTurnRef.current
    if (interruptedTurnId) {
      updateTurn(interruptedTurnId, {
        status: 'canceled',
        currentStep: '已被新一轮对话打断',
      })
    }
    const generation = realtimeSessionRef.current.beginTurn()
    ttsTurnsRef.current.clear()
    unboundTtsEventsRef.current.clear()
    const turnId = `workflow-turn-${crypto.randomUUID()}`
    const turn: WorkflowChatTurn = {
      id: turnId,
      fileName: captionOnlyWorkflow ? '实时字幕 · 麦克风' : '实时麦克风',
      createdAt: Date.now(),
      status: 'running',
      currentStep: streamingVadConfig
        ? 'VAD · 等待说话'
        : `${streamingAsrLabel} · 等待说话`,
      transcript: '',
      reply: '',
      inputAudio: null,
      audio: null,
      steps: workflowStepLabels,
      nodeResults: [],
    }
    setTurns((current) => [...current, turn])
    activeTurnRef.current = turnId
    captionTranscriptRef.current = ''
    captionLatestRawRef.current = ''
    captionFinalizedRawRef.current = ''
    captionFinalizedTextRef.current = ''
    captionFinalizeQueueRef.current = Promise.resolve()
    captionSpeechActiveRef.current = false
    captionPreRollRef.current = []
    speechStartedRef.current = false
    finishingRef.current = false
    streamQueueRef.current = Promise.resolve()
    playbackCursorRef.current = 0
    enhancementAudioChunksRef.current = []
    setBusy(true)

    try {
      if (captionOutputEnabled) await showCaptionOutput()
      streamStartAtRef.current = performance.now()
      pushedAudioMsRef.current = 0
      const stream = await getMicrophoneStream({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
      })
      recordingStreamRef.current = stream
      const asr = await startFunAsrStream({
        clipName: `实时对话-${Date.now()}`,
        providerId: streamingAsrConfig?.providerId,
        modelId: streamingAsrConfig?.modelId,
        sampleRate: streamingEnhancementConfig ? 48_000 : 16_000,
        language: String(
          streamingAsrConfig?.parameters.language ?? 'auto',
        ),
        context: String(streamingAsrConfig?.parameters.context ?? ''),
        semanticPunctuation:
          streamingAsrConfig?.parameters.semanticPunctuation !== false,
      })
      asrSessionRef.current = asr.sessionId
      asrGenerationsRef.current.set(asr.sessionId, generation)
      if (streamingEnhancementConfig) {
        const enhancement = await startEnhancementStream(
          streamingEnhancementConfig.providerId,
          48_000,
          Number(
            streamingEnhancementConfig.parameters.denoiseStrength ?? 1,
          ),
        )
        enhancementSessionRef.current = enhancement.sessionId
      }
      if (streamingVadConfig) {
        const vad = await startVadStream({
          providerId: streamingVadConfig.providerId,
          modelId: streamingVadConfig.modelId,
          adapter: streamingVadConfig.adapter,
          threshold: Number(
            streamingVadConfig.parameters.threshold ?? 0.25,
          ),
          minSpeechDuration: Number(
            streamingVadConfig.parameters.minSpeechDuration ?? 0.18,
          ),
          minSilenceDuration: Number(
            streamingVadConfig.parameters.minSilenceDuration ?? 0.55,
          ),
        })
        vadSessionRef.current = vad.sessionId
      }
      realtimeSessionRef.current.trackRun(asr.run, generation)
      onRunUpdate(asr.run)

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
        const file = new File([blob], `实时对话-${Date.now()}.webm`, {
          type: blob.type,
        })
        recorderRef.current = null
        void audioFileToClip(file)
          .then((inputAudio) => updateTurn(turnId, { inputAudio }))
          .catch((error) => {
            onActionRef.current(
              `无法准备发言回放：${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          })
      }
      recorder.start(250)

      const context = new AudioContext({ latencyHint: 'interactive' })
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const gain = context.createGain()
      gain.gain.value = 0
      processor.onaudioprocess = (event) => {
        const asrSession = asrSessionRef.current
        const vadSession = vadSessionRef.current
        if (!asrSession || finishingRef.current) return
        pushedAudioMsRef.current +=
          (event.inputBuffer.length / context.sampleRate) * 1000
        const pcmBase64 = pcm16Base64(
          event.inputBuffer.getChannelData(0),
          context.sampleRate,
          streamingEnhancementConfig ? 48_000 : 16_000,
        )
        streamQueueRef.current = streamQueueRef.current
          .then(async () => {
            let asrPcm = pcmBase64
            let asrSampleRate = streamingEnhancementConfig
              ? 48_000
              : 16_000
            if (enhancementSessionRef.current) {
              const enhanced = await pushEnhancementStream(
                enhancementSessionRef.current,
                asrPcm,
              )
              if (!enhanced.pcmBase64) return
              enhancementAudioChunksRef.current.push(enhanced.pcmBase64)
              asrPcm = enhanced.pcmBase64
              asrSampleRate = enhanced.sampleRate
            }
            const vadPcm = resamplePcm16Base64(
              asrPcm,
              asrSampleRate,
            )
            if (!vadSession) {
              await pushFunAsrStream(asrSession, asrPcm)
              updateTurn(turnId, {
                currentStep: `${streamingAsrLabel} · 流式识别`,
              })
              return
            }
            const vadUpdate = captionOutputEnabled
              ? await pushCaptionAudio(
                  asrSession,
                  vadSession,
                  asrPcm,
                  vadPcm,
                  2,
                )
              : await (async () => {
                  await pushFunAsrStream(asrSession, asrPcm)
                  return pushVadStream(vadSession, vadPcm)
                })()
            if (vadUpdate.speechStarted) {
              speechStartedRef.current = true
              updateTurn(turnId, {
                currentStep: captionOnlyWorkflow
                  ? '字幕输出 · 实时更新'
                  : `${streamingAsrLabel} · 流式识别`,
              })
              if (captionOnlyWorkflow) {
                await updateCaptionOutputStatus('speech')
              }
            }
            if (vadUpdate.speechEnded && speechStartedRef.current) {
              if (captionOnlyWorkflow) {
                speechStartedRef.current = false
                updateTurn(turnId, {
                  currentStep: 'VAD · 等待说话',
                })
                void finalizeCaptionSegment(turnId, generation)
                await updateCaptionOutputStatus('listening')
              } else {
                void stopStreamingRecording()
              }
            }
          })
          .catch((error) => {
            if (finishingRef.current) return
            finishingRef.current = true
            if (recorderRef.current?.state === 'recording') {
              recorderRef.current.stop()
            }
            releaseCapture()
            void finishActiveEnhancement(false)
            const message = error instanceof Error ? error.message : String(error)
            updateTurn(turnId, {
              status: 'failed',
              currentStep: '实时音频失败',
              error: message,
            })
            clearActiveTurn(turnId)
            setRecording(false)
            setBusy(false)
            if (captionOutputEnabled) {
              void publishCaptionOutput(message, false, 'error')
            }
            onAction(`实时音频失败：${message}`)
          })
      }
      source.connect(processor)
      processor.connect(gain)
      gain.connect(context.destination)
      captureContextRef.current = context
      captureSourceRef.current = source
      captureProcessorRef.current = processor
      captureGainRef.current = gain
      setRecording(true)
    } catch (error) {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop()
      }
      releaseCapture()
      void finishActiveEnhancement(false)
      if (asrSessionRef.current) {
        void finishFunAsrStream(asrSessionRef.current)
      }
      if (vadSessionRef.current) {
        void finishVadStream(vadSessionRef.current)
      }
      asrSessionRef.current = null
      vadSessionRef.current = null
      const message = error instanceof Error ? error.message : String(error)
      updateTurn(turnId, {
        status: 'failed',
        currentStep: '无法开始实时对话',
        error: message,
      })
      clearActiveTurn(turnId)
      setBusy(false)
      if (captionOutputEnabled) {
        void publishCaptionOutput(message, false, 'error')
      }
      onAction(`无法开始实时对话：${message}`)
    }
  }

  return (
    <main
      className={`model-workspace workflow-chat-workspace${selectedTurn ? ' detail-open' : ''}`}
      style={
        {
          '--model-detail-width': `${selectedTurn ? 390 : 0}px`,
        } as CSSProperties
      }
    >
      <section className="model-conversation">
        <header className="model-workspace-heading">
          <div>
            <h1>{captionOnlyWorkflow ? '实时字幕' : '语音对话流程'}</h1>
            <p>虚拟模型 · {workflowSummary}</p>
          </div>
          <span className="model-ready-state ready">
            <i />
            可运行
          </span>
        </header>

        {turns.length > 0 && (
          <nav className="conversation-index" aria-label="对话记录导航">
            {turns.map((turn) => (
              <button
                type="button"
                key={turn.id}
                data-preview={turn.fileName}
                title={turn.fileName}
                aria-label={`跳转到 ${turn.fileName}`}
                onClick={() => {
                  document
                    .getElementById(`workflow-exchange-${turn.id}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              />
            ))}
          </nav>
        )}

        <div ref={conversationRef} className="model-message-list">
          {!turns.length && (
            <div className="model-empty-conversation">
              <span className="model-avatar tone-violet">
                <GitBranch size={22} />
              </span>
              <h2>
                {captionOnlyWorkflow ? '开始实时字幕' : '开始语音对话'}
              </h2>
              <p>
                {captionOnlyWorkflow
                  ? '选择麦克风或电脑音频，识别结果会显示在独立字幕窗口。'
                  : '上传音频或直接录音，输入会交给当前保存的编排流程。'}
              </p>
            </div>
          )}

          {turns.map((turn) => (
            <div
              className="model-exchange"
              id={`workflow-exchange-${turn.id}`}
              key={turn.id}
            >
              <div className="model-user-message">
                <div>
                  <strong>{turn.fileName}</strong>
                  {(turn.inputAudio?.url ||
                    turn.inputAudio?.transcriptionAudioUrl) && (
                    <div className="model-user-audio">
                      <InlineAudioPlayer
                        src={
                          turn.inputAudio.url ??
                          turn.inputAudio.transcriptionAudioUrl ??
                          ''
                        }
                        duration={turn.inputAudio.duration}
                      />
                    </div>
                  )}
                  <small>{formatCreatedAt(turn.createdAt)}</small>
                </div>
              </div>
              <article
                className={`model-result-message status-${turn.status}${selectedTurnId === turn.id ? ' selected' : ''}`}
              >
                <button
                  className="model-result-summary"
                  type="button"
                  onClick={() => setSelectedTurnId(turn.id)}
                >
                  <span className="model-result-copy">
                    {turn.status === 'completed' ? (
                      <>
                        <p>
                          {turn.reply ||
                            turn.transcript ||
                            '流程已生成结果'}
                        </p>
                        <small>{turn.steps.join(' → ')}</small>
                      </>
                    ) : (
                      <>
                        <strong>
                          {turn.status === 'running'
                            ? '正在执行流程'
                            : turn.status === 'canceled'
                              ? '已打断'
                              : '运行失败'}
                        </strong>
                        <small>{turn.error || turn.currentStep}</small>
                      </>
                    )}
                    {turn.status === 'running' && (
                      <i>
                        <b style={{ width: '58%' }} />
                      </i>
                    )}
                  </span>
                </button>
                {turn.status === 'running' && turn.transcript && (
                  <div className="workflow-inline-reply">
                    <span>实时识别</span>
                    <p>{turn.transcript}</p>
                  </div>
                )}
                {turn.audio && (
                  <div className="model-inline-audio">
                    <InlineAudioPlayer
                      src={turn.audio.dataUrl}
                      duration={turn.audio.duration}
                    />
                  </div>
                )}
                {turn.status === 'running' && (
                  <button
                    className="model-result-caption-button"
                    type="button"
                    title="弹出字幕"
                    aria-label="弹出字幕"
                    onClick={() => {
                      void showCaptionOutput()
                      if (turn.transcript) {
                        void publishCaptionOutput(
                          turn.transcript,
                          false,
                          'speech',
                        )
                      }
                    }}
                  >
                    <Captions size={16} />
                  </button>
                )}
              </article>
            </div>
          ))}
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
          <AudioFileDropZone
            disabled={busy || recording}
            onFile={(file) => void submitAudio(file)}
            onInvalidFile={onAction}
          >
            <div className="audio-model-composer codex-composer">
            <div className="audio-composer-prompt">
              <strong>
                {recording
                    ? captionOnlyWorkflow
                      ? audioSource === 'system'
                        ? '正在为电脑音频生成字幕'
                        : speechStartedRef.current
                          ? '正在识别你的声音'
                          : '正在等待你说话'
                      : audioSource === 'system'
                        ? streamingAsrConfig
                          ? '正在实时识别电脑音频'
                          : '正在采集电脑音频'
                        : speechStartedRef.current
                          ? '正在聆听，停顿后自动提交'
                          : '正在等待你说话'
                  : busy
                    ? captionOnlyWorkflow
                      ? '正在结束字幕'
                      : '正在执行语音对话流程'
                    : captionOnlyWorkflow
                      ? '打开实时字幕'
                      : '说点什么，或上传一段音频'}
              </strong>
              <small>
                {workflowSummary}
              </small>
            </div>
            <RecordingWaveform
              active={recording}
              stream={recordingStreamRef.current}
              label={
                audioSource === 'system' ? '电脑音频采集中' : '麦克风录音中'
              }
            />
            <div className="audio-composer-toolbar">
              <div className="audio-composer-left">
                <button
                  className="composer-tool-button"
                  type="button"
                  title="上传音频"
                  disabled={busy || recording}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                </button>
                <div className="audio-source-switch">
                  <button
                    className={audioSource === 'microphone' ? 'active' : ''}
                    type="button"
                    disabled={recording || busy}
                    onClick={() => setAudioSource('microphone')}
                  >
                    <Mic size={13} />
                    麦克风
                  </button>
                  <button
                    className={audioSource === 'system' ? 'active' : ''}
                    type="button"
                    disabled={recording || busy}
                    onClick={() => setAudioSource('system')}
                  >
                    <MonitorSpeaker size={13} />
                    电脑音频
                  </button>
                </div>
              </div>
              <button
                className={`composer-record-button${recording ? ' active' : ''}`}
                type="button"
                title={
                  recording
                    ? '结束录音'
                    : audioSource === 'system'
                      ? captionOnlyWorkflow
                        ? '开始电脑音频字幕'
                        : streamingAsrConfig
                          ? '开始电脑音频实时对话'
                          : '采集电脑音频'
                      : captionOnlyWorkflow
                        ? '开始麦克风字幕'
                        : '开始实时对话'
                }
                disabled={
                  busy && Boolean(asrSessionRef.current) && !recording
                }
                onClick={() =>
                  audioSource === 'system'
                    ? recording
                      ? void stopSystemRecording()
                      : void startSystemRecording()
                    : recording
                      ? void stopStreamingRecording()
                      : void startRecording()
                }
              >
                {recording ? (
                  <CircleStop size={16} />
                ) : audioSource === 'system' ? (
                  <MonitorSpeaker size={16} />
                ) : (
                  <Mic size={16} />
                )}
              </button>
              </div>
            </div>
          </AudioFileDropZone>
        </footer>
      </section>

      <aside className="model-result-detail">
        {selectedTurn && (
          <>
          <header className="result-detail-toolbar">
            <button
              className="icon-button"
              type="button"
              title="关闭详情"
              aria-label="关闭详情"
              onClick={() => setSelectedTurnId(null)}
            >
              <X size={16} />
            </button>
          </header>

          <div className="workflow-conversation-detail">
            {selectedTurn.status === 'running' && (
              <div className="result-detail-loading">
                <LoaderCircle className="model-spin" size={18} />
                {selectedTurn.currentStep}
              </div>
            )}
            {selectedTurn.error && (
              <div className="workflow-error">{selectedTurn.error}</div>
            )}
            {selectedTurn.nodeResults?.length > 0 ? (
              <section className="workflow-node-results">
                <header>
                  <strong>流程结果</strong>
                  {transcriptExportEnabled &&
                    Boolean(selectedTurn.transcription?.segments.length) && (
                      <button
                        className="secondary-action"
                        type="button"
                        onClick={() => {
                          const fileName = downloadTranscript(
                            selectedTurn.transcription as AsrTranscriptionResult,
                            'srt',
                            selectedTurn.fileName,
                          )
                          onAction(`${fileName} 已导出`)
                        }}
                      >
                        <Download size={14} />
                        下载字幕
                      </button>
                    )}
                </header>
                <div>
                  {selectedTurn.nodeResults.map((result) => (
                    <WorkflowNodeResultCard
                      key={result.nodeId}
                      result={result}
                    />
                  ))}
                </div>
              </section>
            ) : (
              <>
            {selectedTurn.transcript && (
              <section className="workflow-text-result">
                <header>
                  <strong>识别文本</strong>
                  {transcriptExportEnabled &&
                    Boolean(selectedTurn.transcription?.segments.length) && (
                      <button
                        className="secondary-action"
                        type="button"
                        onClick={() => {
                          const fileName = downloadTranscript(
                            selectedTurn.transcription as AsrTranscriptionResult,
                            'srt',
                            selectedTurn.fileName,
                          )
                          onAction(`${fileName} 已导出`)
                        }}
                      >
                        <Download size={14} />
                        下载字幕
                      </button>
                    )}
                </header>
                <p>{selectedTurn.transcript}</p>
              </section>
            )}
            {selectedTurn.reply && (
              <section className="workflow-text-result assistant">
                <header>
                  <strong>模型回复</strong>
                  <span>LLM</span>
                </header>
                <p>{selectedTurn.reply}</p>
              </section>
            )}
            {selectedTurn.audio && (
              <AudioAssetPreview
                src={selectedTurn.audio.dataUrl}
                peaks={selectedTurn.audio.waveform}
                duration={selectedTurn.audio.duration}
                role="output"
              />
            )}
              </>
            )}
          </div>
          </>
        )}
      </aside>
    </main>
  )
}
