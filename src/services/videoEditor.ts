import { convertFileSrc, invoke } from '@tauri-apps/api/core'

export interface VideoEditorStatus {
  available: boolean
  ffmpegPath?: string
  ffprobePath?: string
  message: string
}

export interface PreparedVideoMedia {
  sourcePath: string
  sourceName: string
  audioPath: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  sizeBytes: number
}

export interface CutBoundaryAnalysis {
  id: string
  similarity: number
  stable: boolean
  available: boolean
}

export interface VideoSubtitleCue {
  start: number
  end: number
  text: string
}

function isTauriRuntime(): boolean {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  )
}

export function videoEditorStatus(): Promise<VideoEditorStatus> {
  if (!isTauriRuntime()) {
    return Promise.resolve({
      available: false,
      message: '请在 QwenAudio Toolkits 桌面端使用口播剪辑',
    })
  }
  return invoke<VideoEditorStatus>('video_editor_status')
}

export function prepareVideoMedia(sourcePath: string): Promise<PreparedVideoMedia> {
  return invoke<PreparedVideoMedia>('prepare_video_media', { sourcePath })
}

export function analyzeCutBoundaries(
  sourcePath: string,
  boundaries: Array<{ id: string; start: number; end: number }>,
): Promise<CutBoundaryAnalysis[]> {
  return invoke<CutBoundaryAnalysis[]>('analyze_cut_boundaries', {
    sourcePath,
    boundaries,
  })
}

export function exportSmartCut(
  sourcePath: string,
  destinationPath: string,
  keepRanges: Array<{ start: number; end: number }>,
  subtitleCues: VideoSubtitleCue[] = [],
): Promise<number> {
  return invoke<number>('export_smart_cut', {
    sourcePath,
    destinationPath,
    keepRanges,
    subtitleCues,
  })
}

export function localVideoUrl(path: string): string {
  return convertFileSrc(path)
}
