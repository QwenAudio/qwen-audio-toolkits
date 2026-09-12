import type { AsrTranscriptionResult, VadDetectionResult } from '../types'
import type { SmartCutCandidate, SmartCutInstructionPreferences } from './smartCut'
import type { PreparedVideoMedia } from '../services/videoEditor'
import type { VideoDubbingProgress, VideoDubbingTurn } from '../services/videoDubbing'
import { readVideoDubbingSettings, type VideoDubbingSettings } from './videoDubbingWorkspace'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const number = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const nonnegative = (value: unknown, fallback = 0) => Math.max(0, number(value, fallback))
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const path = (value: unknown) => {
  const candidate = text(value)
  return /^(?:blob:|data:)/iu.test(candidate) ? '' : candidate
}
const waveform = (value: unknown) => array(value).filter(
  (item): item is number => typeof item === 'number' && Number.isFinite(item),
).slice(0, 1000)

function readAsr(value: unknown): AsrTranscriptionResult | null {
  const data = record(value)
  if (!data || typeof data.text !== 'string' || !Array.isArray(data.segments)) return null
  return {
    clipName: text(data.clipName), text: data.text, language: text(data.language),
    duration: nonnegative(data.duration), speechSeconds: nonnegative(data.speechSeconds),
    inferenceSeconds: nonnegative(data.inferenceSeconds), realTimeFactor: nonnegative(data.realTimeFactor),
    engine: text(data.engine), sourceAudioFilePath: path(data.sourceAudioFilePath) || undefined,
    waveform: waveform(data.waveform),
    segments: data.segments.flatMap((value, index) => {
      const segment = record(value)
      if (!segment || typeof segment.text !== 'string') return []
      const start = nonnegative(segment.start)
      return [{
        id: text(segment.id, `segment-${index}`), text: segment.text, start,
        end: Math.max(start, number(segment.end)),
        tokens: array(segment.tokens).flatMap((value) => {
          const token = record(value)
          if (!token || typeof token.text !== 'string') return []
          const start = nonnegative(token.start)
          return [{ text: token.text, start, end: Math.max(start, number(token.end)) }]
        }),
      }]
    }),
  }
}

function readVad(value: unknown): VadDetectionResult | null {
  const data = record(value)
  if (!data || !Array.isArray(data.segments)) return null
  return {
    clipName: text(data.clipName), duration: nonnegative(data.duration),
    speechSeconds: nonnegative(data.speechSeconds), silenceSeconds: nonnegative(data.silenceSeconds),
    inferenceSeconds: nonnegative(data.inferenceSeconds), realTimeFactor: nonnegative(data.realTimeFactor),
    threshold: number(data.threshold), engine: text(data.engine), waveform: waveform(data.waveform),
    sourceAudioFilePath: path(data.sourceAudioFilePath) || undefined,
    segments: data.segments.flatMap((value, index) => {
      const segment = record(value)
      if (!segment) return []
      const start = nonnegative(segment.start)
      const end = Math.max(start, number(segment.end))
      return [{ id: text(segment.id, `vad-${index}`), start, end, duration: end - start }]
    }),
  }
}

function readCandidates(value: unknown): SmartCutCandidate[] {
  return array(value).flatMap((value) => {
    const candidate = record(value)
    if (!candidate || typeof candidate.id !== 'string' ||
      !['silence', 'filler', 'repetition', 'manual'].includes(text(candidate.reason))) return []
    const start = nonnegative(candidate.start)
    const end = nonnegative(candidate.end)
    if (end <= start) return []
    return [{
      id: candidate.id, reason: candidate.reason as SmartCutCandidate['reason'], start, end,
      label: text(candidate.label), detail: text(candidate.detail),
      confidence: ['high', 'medium', 'low'].includes(text(candidate.confidence))
        ? candidate.confidence as SmartCutCandidate['confidence'] : 'low',
      selected: candidate.selected === true,
      visualSimilarity: typeof candidate.visualSimilarity === 'number' ? number(candidate.visualSimilarity) : undefined,
      visualStable: typeof candidate.visualStable === 'boolean' ? candidate.visualStable : undefined,
      visualAvailable: typeof candidate.visualAvailable === 'boolean' ? candidate.visualAvailable : undefined,
    }]
  })
}

export interface SmartCutSnapshot {
  version: 1
  stage: 'empty' | 'ready' | 'review' | 'preview'
  interrupted: boolean
  media: PreparedVideoMedia | null
  transcription: AsrTranscriptionResult | null
  vadResult: VadDetectionResult | null
  candidates: SmartCutCandidate[]
  history: SmartCutCandidate[][]
  minimumSilence: number
  edgePadding: number
  selectedAsrModelId: string
  selectedLlmModelId: string | null
  instruction: string
  draftVideo: { path: string; name: string } | null
  plannerName: string
  plannerPreferences: SmartCutInstructionPreferences | null
  includeSubtitles: boolean
  auditionMode: 'comparison' | 'removed'
  currentTime: number
  samples: number[]
  exportedVideoPath: string
}

/** Whitelist persisted fields so native handles and embedded audio never enter a snapshot. */
export function readSmartCutSnapshot(value: unknown): SmartCutSnapshot | null {
  const data = record(value)
  if (!data || data.version !== 1) return null
  const rawMedia = record(data.media)
  const media: PreparedVideoMedia | null = rawMedia && path(rawMedia.sourcePath) && number(rawMedia.duration) > 0 ? {
    sourcePath: path(rawMedia.sourcePath), sourceName: text(rawMedia.sourceName),
    audioPath: path(rawMedia.audioPath), duration: number(rawMedia.duration),
    width: nonnegative(rawMedia.width), height: nonnegative(rawMedia.height),
    fps: nonnegative(rawMedia.fps), sizeBytes: nonnegative(rawMedia.sizeBytes), hasAudio: rawMedia.hasAudio === true,
  } : null
  const transcription = readAsr(data.transcription)
  const draft = record(data.draftVideo)
  const preferences = record(data.plannerPreferences)
  const plannerPreferences: SmartCutInstructionPreferences = {}
  if (preferences) {
    for (const key of ['preserveLeadingSilence', 'preserveTrailingSilence', 'removeSilences', 'removeFillers', 'removeRepetitions', 'includeSubtitles'] as const) {
      if (typeof preferences[key] === 'boolean') plannerPreferences[key] = preferences[key]
    }
    if (typeof preferences.minimumSilence === 'number') plannerPreferences.minimumSilence = Math.max(0.1, number(preferences.minimumSilence, 0.65))
    if (typeof preferences.edgePadding === 'number') plannerPreferences.edgePadding = nonnegative(preferences.edgePadding, 0.12)
  }
  const stage = !media ? 'empty' : transcription && transcription.segments.length
    ? data.stage === 'preview' || data.stage === 'exporting' ? 'preview' : 'review'
    : 'ready'
  return {
    version: 1, stage,
    interrupted: data.interrupted === true || ['planning', 'preparing', 'transcribing', 'exporting'].includes(text(data.stage)),
    media, transcription, vadResult: readVad(data.vadResult),
    candidates: readCandidates(data.candidates), history: array(data.history).slice(-20).map(readCandidates),
    minimumSilence: Math.max(0.1, number(data.minimumSilence, 0.65)), edgePadding: nonnegative(data.edgePadding, 0.12),
    selectedAsrModelId: text(data.selectedAsrModelId),
    selectedLlmModelId: typeof data.selectedLlmModelId === 'string' ? data.selectedLlmModelId : null,
    instruction: text(data.instruction), plannerName: text(data.plannerName),
    plannerPreferences: preferences ? plannerPreferences : null,
    draftVideo: draft && path(draft.path) ? { path: path(draft.path), name: text(draft.name) } : null,
    includeSubtitles: data.includeSubtitles !== false,
    auditionMode: data.auditionMode === 'removed' ? 'removed' : 'comparison',
    currentTime: Math.min(media?.duration ?? 0, nonnegative(data.currentTime)), samples: waveform(data.samples).slice(0, 180),
    exportedVideoPath: path(data.exportedVideoPath),
  }
}

export interface MeetingTurn {
  id: string
  text: string
  start: number
  end: number
  speaker: number | null
}

export interface MeetingSnapshot {
  version: 1
  source: 'microphone' | 'system'
  turns: MeetingTurn[]
  elapsed: number
  summary: string
  summaryView: 'notes' | 'mindmap'
  summaryUpdatedAt: number | null
  interrupted: boolean
}

export function readMeetingSnapshot(value: unknown): MeetingSnapshot | null {
  const data = record(value)
  if (!data || data.version !== 1) return null
  const turns = array(data.turns).flatMap((value, index) => {
    const turn = record(value)
    if (!turn || typeof turn.text !== 'string') return []
    const start = nonnegative(turn.start)
    return [{
      id: text(turn.id, `turn-${index}`), text: turn.text, start, end: Math.max(start, number(turn.end)),
      speaker: typeof turn.speaker === 'number' && Number.isInteger(turn.speaker) && turn.speaker > 0 ? turn.speaker : null,
    }]
  })
  return {
    version: 1, source: data.source === 'system' ? 'system' : 'microphone', turns,
    elapsed: turns.reduce((end, turn) => Math.max(end, turn.end), nonnegative(data.elapsed)),
    summary: text(data.summary), summaryView: data.summaryView === 'mindmap' ? 'mindmap' : 'notes',
    summaryUpdatedAt: typeof data.summaryUpdatedAt === 'number' ? nonnegative(data.summaryUpdatedAt) : null,
    interrupted: data.interrupted === true || data.recording === true || data.stopping === true,
  }
}

function readDubbingTurns(value: unknown): VideoDubbingTurn[] {
  return array(value).flatMap((value, index) => {
    const turn = record(value)
    if (!turn || typeof turn.sourceText !== 'string') return []
    const start = nonnegative(turn.start)
    return [{
      id: text(turn.id, `turn-${index}`), speaker: text(turn.speaker), start,
      end: Math.max(start, number(turn.end)), sourceText: turn.sourceText, text: text(turn.text),
      rhythmSegments: array(turn.rhythmSegments).flatMap((value, index) => {
        const segment = record(value)
        if (!segment || typeof segment.sourceText !== 'string') return []
        const start = nonnegative(segment.start)
        return [{
          id: text(segment.id, `rhythm-${index}`), start, end: Math.max(start, number(segment.end)),
          sourceText: segment.sourceText, text: text(segment.text),
        }]
      }),
    }]
  })
}

function readAudioAnalysis(value: unknown): VideoDubbingProgress['audioAnalysis'] {
  const data = record(value)
  if (!data || !['separate_and_mix', 'skip_separation_mix'].includes(text(data.decision))) return undefined
  return {
    engine: text(data.engine), musicScore: Math.max(0, Math.min(1, number(data.musicScore))),
    decision: data.decision as 'separate_and_mix' | 'skip_separation_mix',
    tags: array(data.tags).flatMap((value) => {
      const tag = record(value)
      return tag && typeof tag.label === 'string' ? [{ label: tag.label, probability: number(tag.probability) }] : []
    }),
  }
}

export interface VideoDubbingSnapshot {
  version: 1
  taskId: string
  outputDir: string
  progress: VideoDubbingProgress | null
  turns: VideoDubbingTurn[]
  audioAnalysis: VideoDubbingProgress['audioAnalysis']
  settings?: VideoDubbingSettings
  runFingerprint?: string
}

export function readVideoDubbingSnapshot(value: unknown): VideoDubbingSnapshot | null {
  const data = record(value)
  if (!data || data.version !== 1) return null
  const rawProgress = record(data.progress)
  let progress: VideoDubbingProgress | null = null
  if (rawProgress) {
    const interrupted = data.starting === true || rawProgress.status === 'running' || rawProgress.stage === 'interrupted'
    const status = interrupted ? 'failed' : ['completed', 'failed', 'canceled'].includes(text(rawProgress.status))
      ? rawProgress.status as VideoDubbingProgress['status'] : 'failed'
    progress = {
      taskId: text(rawProgress.taskId), status, stage: interrupted ? 'interrupted' : text(rawProgress.stage),
      progress: Math.min(100, nonnegative(rawProgress.progress)), message: interrupted ? '' : text(rawProgress.message),
      error: interrupted ? undefined : text(rawProgress.error) || undefined,
      outputDir: path(rawProgress.outputDir) || undefined,
      outputVideoPath: path(rawProgress.outputVideoPath) || undefined,
      subtitlePath: path(rawProgress.subtitlePath) || undefined,
      reportPath: path(rawProgress.reportPath) || undefined,
      sourceTurnsPath: path(rawProgress.sourceTurnsPath) || undefined,
      translatedTurnsPath: path(rawProgress.translatedTurnsPath) || undefined,
      rhythmPlanPath: path(rawProgress.rhythmPlanPath) || undefined,
      completedUnits: nonnegative(rawProgress.completedUnits), totalUnits: nonnegative(rawProgress.totalUnits),
      turns: readDubbingTurns(rawProgress.turns), audioAnalysis: readAudioAnalysis(rawProgress.audioAnalysis),
    }
  }
  return {
    version: 1, taskId: text(data.taskId), outputDir: path(data.outputDir) || progress?.outputDir || '', progress,
    turns: readDubbingTurns(data.turns), audioAnalysis: readAudioAnalysis(data.audioAnalysis) ?? progress?.audioAnalysis,
    settings: readVideoDubbingSettings(data.settings), runFingerprint: text(data.runFingerprint) || undefined,
  }
}
