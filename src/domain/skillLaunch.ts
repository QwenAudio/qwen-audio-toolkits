import type {
  AgentConversation,
  AgentCreationMode,
  GeneralAgentAttachment,
  GeneralAgentMessage,
} from './agents'
import { isInstallApproval } from './onDemandModels'

export const SKILL_VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
export const SKILL_DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

export function skillAcceptsFile(mode: AgentCreationMode, path: string): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  if (mode === 'meeting-notes') return false
  if (mode === 'agent-chat') return true
  const extensions: readonly string[] = mode === 'ai-podcast' ? SKILL_DOCUMENT_EXTENSIONS : SKILL_VIDEO_EXTENSIONS
  return extensions.includes(extension)
}

export function resolveSkillLaunchInput(
  mode: AgentCreationMode,
  draftPrompt: string,
  attachment: GeneralAgentAttachment | null,
  messages: GeneralAgentMessage[],
) {
  const userMessages = messages.filter(message => message.role === 'user')
  // Keep the user's brief and follow-up requirements together, without using
  // assistant output or short model-install approvals as execution instructions.
  const prompt = draftPrompt.trim() || userMessages
    .map(message => message.content.trim())
    .filter(content => content && !isInstallApproval(content))
    .join('\n\n')
  const previousAttachment = userMessages.slice().reverse()
    .flatMap(message => [message.attachment, ...(message.attachments ?? [])])
    .find(file => file && skillAcceptsFile(mode, file.path)) ?? null
  const source = mode === 'meeting-notes' ? null : attachment ?? previousAttachment
  const missing: 'prompt' | 'file' | 'file-type' | null = !prompt
    ? 'prompt'
    : mode === 'meeting-notes' || mode === 'agent-chat'
      ? null
      : !source
        ? 'file'
        : !skillAcceptsFile(mode, source.path) ? 'file-type' : null
  return { prompt, source, missing }
}

export function matchingSkillConversation(
  conversations: AgentConversation[],
  request: Omit<AgentConversation, 'id'>,
): AgentConversation | undefined {
  if (!request.sourceTaskId) return undefined
  return conversations.find(conversation =>
    conversation.sourceTaskId === request.sourceTaskId &&
    conversation.mode === request.mode &&
    conversation.prompt === request.prompt &&
    conversation.sourcePath === request.sourcePath &&
    (conversation.videoDubbingMode ?? 'translate') === (request.videoDubbingMode ?? 'translate') &&
    (conversation.videoDubbingStyle ?? 'natural') === (request.videoDubbingStyle ?? 'natural') &&
    (conversation.videoDubbingLanguages?.source ?? 'auto') === (request.videoDubbingLanguages?.source ?? 'auto') &&
    (conversation.videoDubbingLanguages?.target ?? 'zh') === (request.videoDubbingLanguages?.target ?? 'zh'),
  )
}
