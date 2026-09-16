import type { GeneralAgentAttachment } from './agents'

export type AgentFileKind = 'audio' | 'image' | 'video' | 'document' | 'file'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'] as const
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif'] as const
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const
const CODE_VIDEO_PATH_PATTERN = /`((?:\/|[A-Za-z]:\\)[^`]+?\.(?:mp4|mov|m4v|webm|mkv))`/giu
const PLAIN_VIDEO_PATH_PATTERN = /((?:\/|[A-Za-z]:\\)[^\n`"'<>]+?\.(?:mp4|mov|m4v|webm|mkv))(?:\b|$)/giu
const TRAILING_PATH_PUNCTUATION = /[，。；;,.!?)）\]}]+$/u

export function agentFileExtension(file: GeneralAgentAttachment): string {
  const source = file.name || file.path
  return source.split('.').at(-1)?.toLowerCase() ?? ''
}

export function agentFileKind(file: GeneralAgentAttachment): AgentFileKind {
  const extension = agentFileExtension(file)
  if (AUDIO_EXTENSIONS.includes(extension as (typeof AUDIO_EXTENSIONS)[number])) return 'audio'
  if (IMAGE_EXTENSIONS.includes(extension as (typeof IMAGE_EXTENSIONS)[number])) return 'image'
  if (VIDEO_EXTENSIONS.includes(extension as (typeof VIDEO_EXTENSIONS)[number])) return 'video'
  if (DOCUMENT_EXTENSIONS.includes(extension as (typeof DOCUMENT_EXTENSIONS)[number])) return 'document'
  return 'file'
}

export function agentFileCanPreview(file: GeneralAgentAttachment): boolean {
  return ['audio', 'image', 'video'].includes(agentFileKind(file))
}

function agentFileNameFromPath(path: string): string {
  return path.split(/[\\/]/u).at(-1) || path
}

function cleanAgentFilePath(rawPath: string): string {
  return rawPath.trim().replace(TRAILING_PATH_PUNCTUATION, '')
}

export function agentVideoAttachmentsFromText(content: string): GeneralAgentAttachment[] {
  const files: GeneralAgentAttachment[] = []
  const addPath = (rawPath: string | undefined) => {
    if (!rawPath) return
    const path = cleanAgentFilePath(rawPath)
    if (!path) return
    const file = { path, name: agentFileNameFromPath(path) }
    if (agentFileKind(file) !== 'video') return
    files.push(file)
  }

  for (const match of content.matchAll(CODE_VIDEO_PATH_PATTERN)) {
    addPath(match[1])
  }

  const textWithoutInlineCode = content.replace(/`[^`]*`/gu, ' ')
  for (const match of textWithoutInlineCode.matchAll(PLAIN_VIDEO_PATH_PATTERN)) {
    addPath(match[1])
  }

  return uniqueAgentFiles(files)
}

export function uniqueAgentFiles(
  files: Array<GeneralAgentAttachment | null | undefined>,
): GeneralAgentAttachment[] {
  const seen = new Set<string>()
  const result: GeneralAgentAttachment[] = []
  for (const file of files) {
    if (!file) continue
    const key = `${file.path}\n${file.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(file)
  }
  return result
}
