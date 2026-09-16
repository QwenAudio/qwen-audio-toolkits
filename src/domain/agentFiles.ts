import type { GeneralAgentAttachment } from './agents'

export type AgentFileKind = 'audio' | 'image' | 'video' | 'document' | 'file'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'] as const
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif'] as const
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown', 'srt', 'ass', 'vtt', 'json', 'csv'] as const
const AGENT_OUTPUT_EXTENSIONS = [
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
] as const
const CODE_VIDEO_PATH_PATTERN = /`((?:\/|[A-Za-z]:\\)[^`]+?\.(?:mp4|mov|m4v|webm|mkv))`/giu
const PLAIN_VIDEO_PATH_PATTERN = /((?:\/|[A-Za-z]:\\)[^\n`"'<>]+?\.(?:mp4|mov|m4v|webm|mkv))(?:\b|$)/giu
const OUTPUT_EXTENSION_PATTERN = AGENT_OUTPUT_EXTENSIONS.join('|')
const CODE_OUTPUT_PATH_PATTERN = new RegExp('`([^`]+?\\.(?:' + OUTPUT_EXTENSION_PATTERN + '))`', 'giu')
const BOLD_OUTPUT_PATH_PATTERN = new RegExp('\\*\\*([^*\\n]+?\\.(?:' + OUTPUT_EXTENSION_PATTERN + '))\\*\\*', 'giu')
const ABSOLUTE_OUTPUT_PATH_PATTERN = new RegExp("((?:/|[A-Za-z]:\\\\)[^\\n`\"'<>]+?\\.(?:" + OUTPUT_EXTENSION_PATTERN + "))(?:\\b|$)", 'giu')
const TRAILING_PATH_PUNCTUATION = /[，。；;,.!?)）\]}]+$/u

export function agentVideoThumbnailTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0.6) return 0
  return Math.min(3, Math.max(0.3, duration * 0.08))
}

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

function agentParentPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function agentPathBaseName(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized
}

function agentHomePath(path: string): string {
  const match = path.match(/^(\/Users\/[^/]+)/u)
  return match?.[1] ?? ''
}

function isAbsoluteAgentPath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/u.test(path)
}

function cleanAgentFilePath(rawPath: string): string {
  return rawPath.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/gu, '').replace(TRAILING_PATH_PUNCTUATION, '')
}

function agentOutputFileReferencesFromText(content: string): string[] {
  const references: string[] = []
  const addReference = (value: string | undefined) => {
    const path = cleanAgentFilePath(value ?? '')
    if (!path) return
    references.push(path)
  }

  for (const match of content.matchAll(CODE_OUTPUT_PATH_PATTERN)) addReference(match[1])
  for (const match of content.matchAll(BOLD_OUTPUT_PATH_PATTERN)) addReference(match[1])
  const textWithoutDecorators = content
    .replace(/`[^`]*`/gu, ' ')
    .replace(/\*\*[^*\n]+?\*\*/gu, ' ')
  for (const match of textWithoutDecorators.matchAll(ABSOLUTE_OUTPUT_PATH_PATTERN)) addReference(match[1])
  return [...new Set(references)]
}

function agentCandidatePathsForReference(
  reference: string,
  contextFiles: GeneralAgentAttachment[],
): string[] {
  const cleaned = cleanAgentFilePath(reference)
  if (!cleaned) return []
  if (isAbsoluteAgentPath(cleaned)) return [cleaned]

  const contextPaths = contextFiles.map(file => file.path).filter(Boolean)
  const baseDirectories = [...new Set(contextPaths.map(agentParentPath).filter(Boolean))]
  const homeDirectories = [...new Set(contextPaths.map(agentHomePath).filter(Boolean))]
  const candidates: string[] = []
  const add = (path: string) => {
    if (!path || candidates.includes(path)) return
    candidates.push(path)
  }

  if (cleaned.startsWith('~/')) {
    for (const home of homeDirectories) add(`${home}/${cleaned.slice(2)}`)
    return candidates
  }

  const normalized = cleaned.replace(/\\/gu, '/')
  if (normalized.includes('/')) {
    for (const home of homeDirectories) {
      if (normalized.startsWith('Downloads/')) add(`${home}/${normalized}`)
    }
    for (const base of baseDirectories) {
      const baseName = agentPathBaseName(base)
      const parent = agentParentPath(base)
      if (baseName && normalized.startsWith(`${baseName}/`) && parent) {
        add(`${parent}/${normalized}`)
      } else {
        add(`${base}/${normalized}`)
      }
    }
    return candidates
  }

  for (const base of baseDirectories) add(`${base}/${normalized}`)
  return candidates
}

export function agentOutputAttachmentsFromText(
  content: string,
  contextFiles: GeneralAgentAttachment[],
): GeneralAgentAttachment[] {
  const files: GeneralAgentAttachment[] = []
  for (const reference of agentOutputFileReferencesFromText(content)) {
    for (const path of agentCandidatePathsForReference(reference, contextFiles)) {
      const file = { path, name: agentFileNameFromPath(path) }
      if (agentFileKind(file) === 'file') continue
      files.push(file)
    }
  }
  return uniqueAgentFiles(files)
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
