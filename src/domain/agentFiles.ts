import type { GeneralAgentAttachment } from './agents'

export type AgentFileKind = 'audio' | 'video' | 'document' | 'file'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'] as const
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

export function agentFileExtension(file: GeneralAgentAttachment): string {
  const source = file.name || file.path
  return source.split('.').at(-1)?.toLowerCase() ?? ''
}

export function agentFileKind(file: GeneralAgentAttachment): AgentFileKind {
  const extension = agentFileExtension(file)
  if (AUDIO_EXTENSIONS.includes(extension as (typeof AUDIO_EXTENSIONS)[number])) return 'audio'
  if (VIDEO_EXTENSIONS.includes(extension as (typeof VIDEO_EXTENSIONS)[number])) return 'video'
  if (DOCUMENT_EXTENSIONS.includes(extension as (typeof DOCUMENT_EXTENSIONS)[number])) return 'document'
  return 'file'
}

export function agentFileCanPreview(file: GeneralAgentAttachment): boolean {
  return agentFileKind(file) === 'audio'
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
