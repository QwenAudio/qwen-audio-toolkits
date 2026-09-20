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
  sourcePath: string
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
    version: 1, sourcePath: path(data.sourcePath), taskId: text(data.taskId),
    outputDir: path(data.outputDir) || progress?.outputDir || '', progress,
    turns: readDubbingTurns(data.turns), audioAnalysis: readAudioAnalysis(data.audioAnalysis) ?? progress?.audioAnalysis,
    settings: readVideoDubbingSettings(data.settings), runFingerprint: text(data.runFingerprint) || undefined,
  }
}
