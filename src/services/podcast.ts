import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'

export interface SourceDocument {
  fileName: string
  text: string
  characterCount: number
  truncated: boolean
}

export interface PodcastAudioSegment {
  filePath: string
  pauseAfterMs: number
}

export interface PodcastAudioResult {
  fileName: string
  filePath: string
  dataUrl: string
  duration: number
  sampleRate: number
  channels: number
  sizeBytes: number
  waveform: number[]
  segmentCount: number
}

export async function readSourceDocument(path: string): Promise<SourceDocument> {
  return invoke<SourceDocument>('read_source_document', { path })
}

export async function composePodcastAudio(
  segments: PodcastAudioSegment[],
  title: string,
): Promise<PodcastAudioResult> {
  return invoke<PodcastAudioResult>('compose_podcast_audio', { segments, title })
}

export function localizePodcastError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (message.startsWith('DOCUMENT_TOO_LARGE')) return t('文档不能超过 64 MB')
  if (message.startsWith('DOCUMENT_UNSUPPORTED')) return t('仅支持 PDF、DOCX、TXT 和 Markdown 文档')
  if (message.startsWith('DOCUMENT_EMPTY')) return t('没有从文档中提取到正文；扫描版 PDF 需要先进行 OCR')
  if (message.startsWith('DOCUMENT_INVALID_PDF')) return t('PDF 无法解析或已损坏')
  if (message.startsWith('DOCUMENT_INVALID_DOCX')) return t('DOCX 无法解析或已损坏')
  if (message.startsWith('DOCUMENT_READ')) return t('无法读取所选文档')
  if (message.startsWith('PODCAST_NO_SEGMENTS')) return t('播客脚本中没有可合成的台词')
  if (message.startsWith('PODCAST_TOO_MANY_SEGMENTS')) return t('播客台词超过 100 段，请缩短脚本')
  if (message.startsWith('PODCAST_AUDIO_READ')) return t('无法读取已生成的分段音频')
  if (message.startsWith('PODCAST_AUDIO_INVALID')) return t('分段音频格式无效，无法拼接')
  if (message.startsWith('PODCAST_OUTPUT')) return t('无法保存播客音频')
  return message
}
