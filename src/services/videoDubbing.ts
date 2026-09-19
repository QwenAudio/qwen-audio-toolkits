import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { VideoDubbingLanguages, VideoDubbingMode, VideoDubbingStyle } from '../domain/agents'

export type VideoDubbingStatus = 'running' | 'completed' | 'failed' | 'canceled'

export interface VideoDubbingRhythmSegment {
  id: string
  start: number
  end: number
  sourceText: string
  text?: string
}

export interface VideoDubbingTurn {
  id: string
  speaker: string
  start: number
  end: number
  sourceText: string
  text: string
  rhythmSegments?: VideoDubbingRhythmSegment[]
}

export interface VideoDubbingProgress {
  taskId: string
  status: VideoDubbingStatus
  stage: string
  progress: number
  message: string
  error?: string
  outputDir?: string
  outputVideoPath?: string
  subtitlePath?: string
  reportPath?: string
  completedUnits?: number
  totalUnits?: number
  turns?: VideoDubbingTurn[]
  sourceTurnsPath?: string
  translatedTurnsPath?: string
  rhythmPlanPath?: string
  retryAttempt?: number
  retryLimit?: number
  audioAnalysis?: {
    engine: string
    musicScore: number
    decision: 'separate_and_mix' | 'skip_separation_mix'
    tags: Array<{ label: string; probability: number }>
  }
}

export interface VideoDubbingStartResult {
  taskId: string
  outputDir: string
}

const progressListeners = new Set<(progress: VideoDubbingProgress) => void>()
let stopProgressBridge: UnlistenFn | null = null
let progressBridgePromise: Promise<void> | null = null

async function ensureProgressBridge(): Promise<void> {
  if (stopProgressBridge || progressBridgePromise) return progressBridgePromise ?? Promise.resolve()
  progressBridgePromise = listen<VideoDubbingProgress>('video-translation-progress', (event) => {
    for (const listener of progressListeners) listener(event.payload)
  }).then((unlisten) => {
    if (progressListeners.size === 0) unlisten()
    else stopProgressBridge = unlisten
  }).finally(() => {
    progressBridgePromise = null
  })
  return progressBridgePromise
}

export async function subscribeVideoDubbing(
  listener: (progress: VideoDubbingProgress) => void,
): Promise<UnlistenFn> {
  progressListeners.add(listener)
  try {
    await ensureProgressBridge()
  } catch (error) {
    progressListeners.delete(listener)
    throw error
  }
  return () => {
    progressListeners.delete(listener)
    if (progressListeners.size === 0 && stopProgressBridge) {
      stopProgressBridge()
      stopProgressBridge = null
    }
  }
}

export async function startVideoDubbing(
  inputPath: string,
  prompt: string,
  dubbingMode: VideoDubbingMode,
  outputDir?: string,
  languages?: VideoDubbingLanguages,
  style?: VideoDubbingStyle,
): Promise<VideoDubbingStartResult> {
  return invoke<VideoDubbingStartResult>('start_video_translation', {
    request: {
      inputPath,
      prompt,
      mode: 'bailian',
      dubbingMode,
      outputDir,
      sourceLanguage: languages?.source,
      targetLanguage: languages?.target,
      dubbingStyle: style,
    },
  })
}

export async function cancelVideoDubbing(taskId: string): Promise<void> {
  await invoke('cancel_video_translation', { taskId })
}
