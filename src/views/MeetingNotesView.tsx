import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  CircleStop,
  Clock3,
  FileText,
  LoaderCircle,
  Mic2,
  MonitorSpeaker,
  Network,
  RefreshCw,
  Sparkles,
  Store,
  Users,
} from 'lucide-react'
import Markdown from 'react-markdown'
import { t, useLocale } from '../i18n'
import { normalizeHarnessResult } from '../domain/results'
import {
  finishFunAsrStream,
  pushFunAsrStream,
  startFunAsrStream,
  startSystemAudio,
  stopSystemAudio,
  subscribeFunAsrStream,
  subscribeSystemAudio,
} from '../services/harness'
import { getMicrophoneStream } from '../services/audioCapture'
import { audioFileToClip, pcm16ChunksToWavFile } from '../utils/audio'
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from '../types'
import './MeetingNotesView.css'

type MeetingSource = 'microphone' | 'system'

interface MeetingTurn {
  id: string
  text: string
  start: number
  end: number
  speaker: number | null
}

interface AudioChunk {
  pcmBase64: string
  start: number
  end: number
}

interface SpeakerSegment {
  start: number
  end: number
  speaker: number
}

interface MindMapNode {
  id: string
  label: string
  children: MindMapNode[]
}

interface MeetingNotesViewProps {
  initialInstruction: string
  models: ModelPlugin[]
  onRunText: (
    text: string,
    capability: 'text.generate',
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>>
  onRunAudio: (
    clip: AudioClip,
    capability: 'speaker.diarize',
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    conversationVisible?: boolean,
    dependencyRunIds?: string[],
  ) => Promise<
    HarnessExecution<
      AsrTranscriptionResult | VadDetectionResult | AudioProcessResult | Record<string, unknown>
    >
  >
  onOpenStore: () => void
  onAction: (message: string) => void
}

const DIARIZATION_INTERVAL_SECONDS = 12
const DIARIZATION_WINDOW_SECONDS = 36
const SUMMARY_INTERVAL_SECONDS = 45

function encodePcm16(samples: Float32Array, inputRate: number, outputRate = 16_000): string {
  const ratio = inputRate / outputRate
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const bytes = new Uint8Array(length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < length; index += 1) {
    const sample = samples[Math.min(samples.length - 1, Math.floor(index * ratio))]
    view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

function overlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB))
}

function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

function outputText(output: TtsGenerateResult | TextGenerateResult | Record<string, unknown>): string {
  const text = (output as { text?: unknown }).text
  return typeof text === 'string' ? text.trim() : ''
}

function markdownMindMap(markdown: string): MindMapNode {
  const root: MindMapNode = { id: 'root', label: t('会议纪要'), children: [] }
  let current = root
  markdown.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line) return
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      const node = { id: `heading-${index}`, label: heading[2].replace(/[*_`]/gu, ''), children: [] }
      root.children.push(node)
      current = node
      return
    }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line)
    const label = (item?.[1] ?? line).replace(/[*_`]/gu, '').trim()
    if (label) current.children.push({ id: `item-${index}`, label, children: [] })
  })
  if (!root.children.length && markdown.trim()) {
    root.children.push({ id: 'content', label: markdown.trim(), children: [] })
  }
  return root
}

function MindMapBranch({ node, root = false }: { node: MindMapNode; root?: boolean }) {
  return (
    <div className={`meeting-mindmap-branch${root ? ' root' : ''}`}>
      <div className="meeting-mindmap-node">{node.label}</div>
      {node.children.length > 0 && (
        <div className="meeting-mindmap-children">
          {node.children.map((child) => <MindMapBranch key={child.id} node={child} />)}
        </div>
      )}
    </div>
  )
}

export function MeetingNotesView({
  initialInstruction,
  models,
  onRunText,
  onRunAudio,
  onOpenStore,
  onAction,
}: MeetingNotesViewProps) {
  useLocale()
  const streamingAsr = useMemo(
    () => {
      const candidates = models.filter((model) =>
        model.installed &&
        model.providerId &&
        model.streamingMode === 'streaming' &&
        model.harnessCapabilities.includes('speech.transcribe'),
      )
      return candidates.find((model) => model.adapter === 'bailian-funasr')
        ?? candidates.find((model) => model.adapter === 'funasr-nano')
        ?? candidates[0]
    },
    [models],
  )
  const diarizationModel = useMemo(
    () => models.find((model) =>
      model.installed &&
      model.providerId &&
      model.harnessCapabilities.includes('speaker.diarize'),
    ),
    [models],
  )
  const summaryModel = useMemo(
    () => models.find((model) =>
      model.installed &&
      model.providerId &&
      model.harnessCapabilities.includes('text.generate'),
    ),
    [models],
  )

  const [source, setSource] = useState<MeetingSource>('microphone')
  const [recording, setRecording] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [engineLoading, setEngineLoading] = useState(false)
  const [turns, setTurns] = useState<MeetingTurn[]>([])
  const [partialText, setPartialText] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [summary, setSummary] = useState('')
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryView, setSummaryView] = useState<'notes' | 'mindmap'>('notes')
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState<number | null>(null)
  const [diarizationBusy, setDiarizationBusy] = useState(false)

  const sessionRef = useRef<string | null>(null)
  const systemSessionRef = useRef<string | null>(null)
  const systemUnlistenRef = useRef<(() => void) | null>(null)
  const microphoneRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const pushQueueRef = useRef<Promise<void>>(Promise.resolve())
  const audioChunksRef = useRef<AudioChunk[]>([])
  const turnsRef = useRef<MeetingTurn[]>([])
  const speakerTimelineRef = useRef<SpeakerSegment[]>([])
  const nextSpeakerRef = useRef(1)
  const meetingStartRef = useRef(0)
  const captureRateRef = useRef(16_000)
  const nextDiarizationAtRef = useRef(DIARIZATION_INTERVAL_SECONDS)
  const diarizationBusyRef = useRef(false)
  const summaryBusyRef = useRef(false)
  const summarizedCharactersRef = useRef(0)
  const engineFinalTextRef = useRef('')
  const completedByUserRef = useRef(false)
  const completionResolverRef = useRef<(() => void) | null>(null)
  const onActionRef = useRef(onAction)
  const runDiarizationRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined)
  const summarizeRef = useRef<(final?: boolean) => Promise<void>>(async () => undefined)
  const commitStableTextRef = useRef<(text: string) => void>(() => undefined)
  onActionRef.current = onAction

  const updateTurns = (updater: (current: MeetingTurn[]) => MeetingTurn[]) => {
    setTurns((current) => {
      const next = updater(current)
      turnsRef.current = next
      return next
    })
  }

  const meetingSeconds = () => meetingStartRef.current
    ? (performance.now() - meetingStartRef.current) / 1000
    : 0

  const appendAudioChunk = (pcmBase64: string, duration: number) => {
    const end = meetingSeconds()
    const start = Math.max(0, end - duration)
    audioChunksRef.current.push({ pcmBase64, start, end })
    audioChunksRef.current = audioChunksRef.current.filter(
      (chunk) => chunk.end >= end - DIARIZATION_WINDOW_SECONDS - 4,
    )
  }

  const stopInputNodes = () => {
    if (processorRef.current) processorRef.current.onaudioprocess = null
    processorRef.current?.disconnect()
    sourceNodeRef.current?.disconnect()
    gainRef.current?.disconnect()
    microphoneRef.current?.getTracks().forEach((track) => track.stop())
    processorRef.current = null
    sourceNodeRef.current = null
    gainRef.current = null
    microphoneRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
  }

  const applySpeakerWindow = (
    localSegments: Array<{ start: number; end: number; label: string }>,
    windowStart: number,
    windowEnd: number,
  ) => {
    const previous = speakerTimelineRef.current
    const labels = [...new Set(localSegments.map((segment) => segment.label))]
    const mapping = new Map<string, number>()
    for (const label of labels) {
      const candidates = new Map<number, number>()
      localSegments.filter((segment) => segment.label === label).forEach((segment) => {
        const absoluteStart = windowStart + segment.start
        const absoluteEnd = windowStart + segment.end
        previous.forEach((known) => {
          const score = overlap(absoluteStart, absoluteEnd, known.start, known.end)
          if (score > 0) candidates.set(known.speaker, (candidates.get(known.speaker) ?? 0) + score)
        })
      })
      const best = [...candidates.entries()].sort((left, right) => right[1] - left[1])[0]
      if (best && best[1] >= 0.8) mapping.set(label, best[0])
    }
    labels.forEach((label) => {
      if (!mapping.has(label)) {
        mapping.set(label, nextSpeakerRef.current)
        nextSpeakerRef.current += 1
      }
    })
    const absoluteSegments = localSegments.map((segment) => ({
      start: windowStart + segment.start,
      end: windowStart + segment.end,
      speaker: mapping.get(segment.label) ?? 1,
    }))
    speakerTimelineRef.current = [
      ...previous.filter((segment) => segment.end < windowStart || segment.start > windowEnd),
      ...absoluteSegments,
    ].sort((left, right) => left.start - right.start)

    updateTurns((current) => current.map((turn) => {
      if (turn.end < windowStart || turn.start > windowEnd) return turn
      const best = absoluteSegments
        .map((segment) => ({ segment, score: overlap(turn.start, turn.end, segment.start, segment.end) }))
        .sort((left, right) => right.score - left.score)[0]
      return best && best.score > 0 ? { ...turn, speaker: best.segment.speaker } : turn
    }))
  }

  const runRollingDiarization = async (force = false) => {
    if (!diarizationModel?.providerId || diarizationBusyRef.current) return
    const now = meetingSeconds()
    if (!force && now < nextDiarizationAtRef.current) return
    const chunks = audioChunksRef.current.filter(
      (chunk) => chunk.end >= Math.max(0, now - DIARIZATION_WINDOW_SECONDS),
    )
    if (!chunks.length || chunks.at(-1)!.end - chunks[0].start < 4) return
    nextDiarizationAtRef.current = now + DIARIZATION_INTERVAL_SECONDS
    diarizationBusyRef.current = true
    setDiarizationBusy(true)
    const windowStart = chunks[0].start
    const windowEnd = chunks.at(-1)!.end
    try {
      const file = pcm16ChunksToWavFile(
        chunks.map((chunk) => chunk.pcmBase64),
        captureRateRef.current,
        `meeting-speakers-${Date.now()}.wav`,
      )
      const clip = await audioFileToClip(file)
      const execution = await onRunAudio(
        clip,
        'speaker.diarize',
        diarizationModel.providerId,
        diarizationModel.version,
        {},
        false,
      )
      const normalized = normalizeHarnessResult(execution.output)
      applySpeakerWindow(normalized.segments, windowStart, windowEnd)
      if (clip.url) URL.revokeObjectURL(clip.url)
    } catch (error) {
      onAction(t('说话人识别暂时失败：{0}', [error instanceof Error ? error.message : String(error)]))
    } finally {
      diarizationBusyRef.current = false
      setDiarizationBusy(false)
    }
  }

  const summarize = async (final = false) => {
    if (!summaryModel?.providerId || summaryBusyRef.current) return
    const transcript = turnsRef.current
      .map((turn) => `${formatElapsed(turn.start)} 说话人 ${turn.speaker ?? '待识别'}：${turn.text}`)
      .join('\n')
    if (!transcript.trim()) return
    if (!final && transcript.length - summarizedCharactersRef.current < 80) return
    summaryBusyRef.current = true
    setSummaryBusy(true)
    try {
      const request = [
        '你是实时会议纪要助手。请只根据下面已经稳定的转写更新滚动纪要。',
        '使用简洁 Markdown，固定包含：当前结论、讨论要点、行动项、待确认问题。',
        '行动项尽量写明负责人和时间；未明确的信息标注“待确认”，不要猜测。',
        final ? '这是会议结束后的最终版本，请合并重复内容并形成可直接分享的纪要。' : '这是会议中的阶段版本，保留仍在讨论中的不确定性。',
        initialInstruction.trim() ? `用户关注重点：${initialInstruction.trim()}` : '',
        `会议转写：\n${transcript}`,
      ].filter(Boolean).join('\n\n')
      const execution = await onRunText(
        request,
        'text.generate',
        summaryModel.providerId,
        summaryModel.version,
        { temperature: 0.2, maxTokens: final ? 1600 : 1000 },
        [],
        false,
      )
      const next = outputText(execution.output)
      if (next) {
        setSummary(next)
        setSummaryUpdatedAt(Date.now())
        summarizedCharactersRef.current = transcript.length
      }
    } catch (error) {
      onAction(t('会议纪要更新失败：{0}', [error instanceof Error ? error.message : String(error)]))
    } finally {
      summaryBusyRef.current = false
      setSummaryBusy(false)
    }
  }
  const commitStableText = (stableText: string) => {
    const stable = stableText.trim()
    const previous = engineFinalTextRef.current.trim()
    if (!stable || stable === previous) return
    const delta = stable.startsWith(previous)
      ? stable.slice(previous.length).trim()
      : stable
    engineFinalTextRef.current = stable
    const additions = delta.split(/\n+/u).map((line) => line.trim()).filter(Boolean)
    if (!additions.length) return
    const end = meetingSeconds()
    const firstStart = turnsRef.current.at(-1)?.end ?? Math.max(0, end - additions.length * 3)
    const duration = Math.max(0.1, end - firstStart) / additions.length
    updateTurns((current) => [
      ...current,
      ...additions.map((text, index) => ({
        id: crypto.randomUUID(),
        text,
        start: firstStart + duration * index,
        end: firstStart + duration * (index + 1),
        speaker: null,
      })),
    ])
    void runDiarizationRef.current()
  }
  runDiarizationRef.current = runRollingDiarization
  summarizeRef.current = summarize
  commitStableTextRef.current = commitStableText

  useEffect(() => {
    let remove: (() => void) | undefined
    let disposed = false
    void subscribeFunAsrStream((event) => {
      if (event.sessionId !== sessionRef.current) return
      if (event.kind === 'partial') {
        setEngineLoading(false)
        const lineBoundary = event.text.lastIndexOf('\n')
        const punctuationMatches = [...event.text.matchAll(/[。！？.!?](?=\s|$)/gu)]
        const punctuationBoundary = punctuationMatches.at(-1)?.index
        const stableBoundary = Math.max(
          lineBoundary,
          punctuationBoundary === undefined ? -1 : punctuationBoundary + 1,
        )
        if (stableBoundary > 0) {
          commitStableTextRef.current(event.text.slice(0, stableBoundary))
        }
        const committed = engineFinalTextRef.current
        const text = event.text.startsWith(committed)
          ? event.text.slice(committed.length).trim()
          : event.text.slice(Math.max(0, stableBoundary)).trim()
        setPartialText(text)
        return
      }
      if (event.kind === 'final') {
        setEngineLoading(false)
        commitStableTextRef.current(event.text)
        setPartialText('')
        return
      }
      if (event.kind === 'error') {
        completionResolverRef.current?.()
        completionResolverRef.current = null
        setEngineLoading(false)
        setRecording(false)
        onActionRef.current(event.error || t('实时识别失败'))
      } else if (event.kind === 'completed' && !completedByUserRef.current) {
        completionResolverRef.current?.()
        completionResolverRef.current = null
        setEngineLoading(false)
        setRecording(false)
      } else if (event.kind === 'completed') {
        completionResolverRef.current?.()
        completionResolverRef.current = null
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else remove = unlisten
    })
    return () => {
      disposed = true
      remove?.()
    }
  }, [])

  useEffect(() => {
    if (!recording) return undefined
    const timer = window.setInterval(() => {
      const seconds = meetingSeconds()
      setElapsed(seconds)
      if (seconds >= nextDiarizationAtRef.current) void runDiarizationRef.current()
      if (Math.floor(seconds) > 0 && Math.floor(seconds) % SUMMARY_INTERVAL_SECONDS === 0) {
        void summarizeRef.current()
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  const startMeeting = async () => {
    if (!streamingAsr?.providerId) {
      onAction(t('请先安装一个流式语音识别模型'))
      return
    }
    try {
      completedByUserRef.current = false
      meetingStartRef.current = performance.now() - elapsed * 1000
      nextDiarizationAtRef.current = elapsed + DIARIZATION_INTERVAL_SECONDS
      audioChunksRef.current = []
      pushQueueRef.current = Promise.resolve()
      engineFinalTextRef.current = ''
      const sampleRate = source === 'system' ? 48_000 : 16_000
      captureRateRef.current = sampleRate
      const started = await startFunAsrStream({
        clipName: t('会议记录-{0}', [Date.now()]),
        providerId: streamingAsr.providerId,
        modelId: streamingAsr.version,
        sampleRate,
        language: 'auto',
        semanticPunctuation: true,
        context: initialInstruction,
      })
      sessionRef.current = started.sessionId
      setEngineLoading(true)

      if (source === 'system') {
        systemUnlistenRef.current = await subscribeSystemAudio((chunk) => {
          if (chunk.sessionId !== systemSessionRef.current || !sessionRef.current) return
          const duration = atob(chunk.pcmBase64).length / 2 / chunk.sampleRate
          appendAudioChunk(chunk.pcmBase64, duration)
          pushQueueRef.current = pushQueueRef.current.then(() =>
            pushFunAsrStream(sessionRef.current!, chunk.pcmBase64),
          )
        })
        const system = await startSystemAudio(false)
        systemSessionRef.current = system.sessionId
      } else {
        const stream = await getMicrophoneStream({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        })
        microphoneRef.current = stream
        const context = new AudioContext({ latencyHint: 'interactive' })
        await context.resume()
        const input = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4096, 1, 1)
        const gain = context.createGain()
        gain.gain.value = 0
        processor.onaudioprocess = (event) => {
          const sessionId = sessionRef.current
          if (!sessionId) return
          const pcmBase64 = encodePcm16(event.inputBuffer.getChannelData(0), context.sampleRate)
          const duration = atob(pcmBase64).length / 2 / 16_000
          appendAudioChunk(pcmBase64, duration)
          pushQueueRef.current = pushQueueRef.current.then(() => pushFunAsrStream(sessionId, pcmBase64))
        }
        input.connect(processor)
        processor.connect(gain)
        gain.connect(context.destination)
        contextRef.current = context
        sourceNodeRef.current = input
        processorRef.current = processor
        gainRef.current = gain
      }
      setRecording(true)
      onAction(t('会议记录已开始'))
    } catch (error) {
      stopInputNodes()
      if (systemSessionRef.current) void stopSystemAudio(systemSessionRef.current)
      systemUnlistenRef.current?.()
      if (sessionRef.current) void finishFunAsrStream(sessionRef.current)
      sessionRef.current = null
      systemSessionRef.current = null
      setEngineLoading(false)
      onAction(t('无法开始会议记录：{0}', [error instanceof Error ? error.message : String(error)]))
    }
  }

  const stopMeeting = async () => {
    const sessionId = sessionRef.current
    if (!sessionId) return
    setStopping(true)
    setRecording(false)
    completedByUserRef.current = true
    stopInputNodes()
    try {
      if (systemSessionRef.current) await stopSystemAudio(systemSessionRef.current)
      systemUnlistenRef.current?.()
      systemUnlistenRef.current = null
      systemSessionRef.current = null
      await pushQueueRef.current
      const completed = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          completionResolverRef.current = null
          resolve()
        }, 5000)
        completionResolverRef.current = () => {
          window.clearTimeout(timeout)
          resolve()
        }
      })
      await finishFunAsrStream(sessionId)
      await completed
      await runRollingDiarization(true)
      await summarize(true)
      onAction(t('会议纪要已生成'))
    } catch (error) {
      onAction(t('结束会议记录失败：{0}', [error instanceof Error ? error.message : String(error)]))
    } finally {
      sessionRef.current = null
      setStopping(false)
      setEngineLoading(false)
    }
  }

  useEffect(() => () => {
    stopInputNodes()
    systemUnlistenRef.current?.()
    if (systemSessionRef.current) void stopSystemAudio(systemSessionRef.current)
    if (sessionRef.current) void finishFunAsrStream(sessionRef.current)
  }, [])

  const missing = [
    !streamingAsr && t('流式识别'),
    !diarizationModel && t('说话人识别'),
    !summaryModel && t('文本总结'),
  ].filter(Boolean) as string[]
  const mindMap = useMemo(() => markdownMindMap(summary), [summary])

  return (
    <main className="meeting-notes-view">
      <header className="meeting-notes-header">
        <div>
          <span><Sparkles size={14} /> {t('实时会议纪要')}</span>
          <h1>{initialInstruction || t('新会议')}</h1>
        </div>
        <div className="meeting-status-cluster">
          <span className={recording ? 'recording' : ''}>
            <i /> {recording ? t('记录中') : stopping ? t('正在整理') : t('尚未开始')}
          </span>
          <strong>{formatElapsed(elapsed)}</strong>
        </div>
      </header>

      <div className="meeting-toolbar">
        <div className="meeting-source-picker" aria-label={t('会议音频来源')}>
          <button type="button" className={source === 'microphone' ? 'active' : ''} disabled={recording || stopping} onClick={() => setSource('microphone')}>
            <Mic2 size={15} /> {t('麦克风')}
          </button>
          <button type="button" className={source === 'system' ? 'active' : ''} disabled={recording || stopping} onClick={() => setSource('system')}>
            <MonitorSpeaker size={15} /> {t('电脑音频')}
          </button>
        </div>
        {missing.length > 0 ? (
          <button type="button" className="meeting-store-button" onClick={onOpenStore}>
            <Store size={15} /> {t('安装所需模型')} · {missing.join(' / ')}
          </button>
        ) : recording ? (
          <button type="button" className="meeting-stop-button" onClick={() => void stopMeeting()}>
            <CircleStop size={16} /> {t('结束会议')}
          </button>
        ) : (
          <button type="button" className="meeting-start-button" disabled={stopping} onClick={() => void startMeeting()}>
            {stopping ? <LoaderCircle className="model-spin" size={16} /> : <AudioLines size={16} />}
            {stopping ? t('正在生成最终纪要') : turns.length ? t('继续记录') : t('开始记录')}
          </button>
        )}
      </div>

      <div className="meeting-panels">
        <section className="meeting-transcript-panel">
          <header>
            <div><Users size={16} /><strong>{t('实时转写')}</strong></div>
            <span>{diarizationBusy ? <><LoaderCircle className="model-spin" size={12} /> {t('正在更新说话人')}</> : t('说话人约延迟 10–15 秒')}</span>
          </header>
          <div className="meeting-transcript-scroll">
            {!turns.length && !partialText ? (
              <div className="meeting-empty-state">
                <Mic2 size={26} />
                <strong>{t('发言内容会实时显示在这里')}</strong>
                <span>{t('说话人标签会在短暂分析后原位更新')}</span>
              </div>
            ) : (
              <>
                {turns.map((turn) => (
                  <article className="meeting-turn" key={turn.id}>
                    <button
                      type="button"
                      className={turn.speaker ? '' : 'pending'}
                      title={t('点击可手动校正说话人')}
                      onClick={() => updateTurns((current) => current.map((item) =>
                        item.id === turn.id
                          ? { ...item, speaker: ((item.speaker ?? 0) % Math.max(2, nextSpeakerRef.current - 1)) + 1 }
                          : item,
                      ))}
                    >
                      {turn.speaker ? t('说话人 {0}', [turn.speaker]) : t('识别中')}
                    </button>
                    <div>
                      <time>{formatElapsed(turn.start)}</time>
                      <p>{turn.text}</p>
                    </div>
                  </article>
                ))}
                {(partialText || engineLoading) && (
                  <article className="meeting-turn partial">
                    <span className="pending">{t('实时')}</span>
                    <div>
                      <time>{formatElapsed(elapsed)}</time>
                      <p>{partialText || t('识别引擎加载中…')}</p>
                    </div>
                  </article>
                )}
              </>
            )}
          </div>
        </section>

        <section className="meeting-summary-panel">
          <header>
            <div><Sparkles size={16} /><strong>{t('滚动纪要')}</strong></div>
            <div className="meeting-summary-header-actions">
              {summary && (
                <div className="meeting-summary-view-switch" aria-label={t('纪要视图')}>
                  <button type="button" className={summaryView === 'notes' ? 'active' : ''} onClick={() => setSummaryView('notes')} title={t('Markdown 纪要')}>
                    <FileText size={13} />
                  </button>
                  <button type="button" className={summaryView === 'mindmap' ? 'active' : ''} onClick={() => setSummaryView('mindmap')} title={t('思维导图')}>
                    <Network size={13} />
                  </button>
                </div>
              )}
              <span>
                {summaryBusy ? <><LoaderCircle className="model-spin" size={12} /> {t('正在更新')}</> : summaryUpdatedAt ? <><Clock3 size={12} /> {t('刚刚已更新')}</> : t('约每 45 秒更新')}
              </span>
            </div>
          </header>
          <div className="meeting-summary-content">
            {summary ? summaryView === 'notes' ? (
              <article className="meeting-markdown"><Markdown>{summary}</Markdown></article>
            ) : (
              <div className="meeting-mindmap"><MindMapBranch node={mindMap} root /></div>
            ) : (
              <div className="meeting-empty-state summary">
                <RefreshCw size={24} />
                <strong>{t('纪要会在内容稳定后出现')}</strong>
                <span>{t('右侧会持续整理结论、要点、行动项和待确认问题')}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
