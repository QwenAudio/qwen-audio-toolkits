import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'

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

const VIDEO_EDITOR_ERROR_PREFIXES = [
  ['无法读取视频:', '无法读取视频：{0}'],
  ['无法授权视频预览:', '无法授权视频预览：{0}'],
  ['无法读取视频信息:', '无法读取视频信息：{0}'],
  ['视频信息读取失败:', '视频信息读取失败：{0}'],
  ['视频信息格式无效:', '视频信息格式无效：{0}'],
  ['无法定位应用数据目录:', '无法定位应用数据目录：{0}'],
  ['无法创建剪辑缓存:', '无法创建剪辑缓存：{0}'],
  ['无法提取视频音轨:', '无法提取视频音轨：{0}'],
  ['视频音轨提取失败:', '视频音轨提取失败：{0}'],
  ['无法读取视频大小:', '无法读取视频大小：{0}'],
  ['无法生成字幕轨道:', '无法生成字幕轨道：{0}'],
  ['无法启动视频导出:', '无法启动视频导出：{0}'],
  ['视频导出失败:', '视频导出失败：{0}'],
  ['无法读取导出文件:', '无法读取导出文件：{0}'],
  ['视频准备任务异常退出:', '视频准备任务异常退出：{0}'],
  ['画面分析任务异常退出:', '画面分析任务异常退出：{0}'],
  ['视频导出任务异常退出:', '视频导出任务异常退出：{0}'],
] as const

export function localizeVideoEditorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  const direct = t(message)
  if (direct !== message) return direct
  for (const [prefix, source] of VIDEO_EDITOR_ERROR_PREFIXES) {
    if (message.startsWith(prefix)) {
      return t(source, [message.slice(prefix.length).trim()])
    }
  }
  return message
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
      message: t('请在 QwenAudio Toolkits 桌面端使用口播剪辑'),
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
