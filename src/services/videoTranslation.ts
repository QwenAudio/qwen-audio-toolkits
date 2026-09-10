import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type VideoTranslationStatus = 'running' | 'completed' | 'failed' | 'canceled'

export interface VideoTranslationRhythmSegment {
  id: string
  start: number
  end: number
  sourceText: string
  text?: string
}

export interface VideoTranslationTurn {
  id: string
  speaker: string
  start: number
  end: number
  sourceText: string
  text: string
  rhythmSegments?: VideoTranslationRhythmSegment[]
}

export interface VideoTranslationProgress {
  taskId: string
  status: VideoTranslationStatus
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
  turns?: VideoTranslationTurn[]
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

export interface VideoTranslationStartResult {
  taskId: string
  outputDir: string
}

export async function subscribeVideoTranslation(
  listener: (progress: VideoTranslationProgress) => void,
): Promise<UnlistenFn> {
  return listen<VideoTranslationProgress>('video-translation-progress', (event) => listener(event.payload))
}

export async function startVideoTranslation(
  inputPath: string,
  prompt: string,
  outputDir?: string,
): Promise<VideoTranslationStartResult> {
  return invoke<VideoTranslationStartResult>('start_video_translation', {
    request: { inputPath, prompt, mode: 'bailian', outputDir },
  })
}

export async function cancelVideoTranslation(taskId: string): Promise<void> {
  await invoke('cancel_video_translation', { taskId })
}
