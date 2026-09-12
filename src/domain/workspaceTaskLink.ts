import type { AgentConversation, GeneralAgentMessage, GeneralAgentTask } from './agents'

export interface WorkspaceTaskLinkSeed {
  taskId: string
  messageId: string
  now: number
}

export function appendWorkspaceBrief(
  task: GeneralAgentTask,
  message: GeneralAgentMessage,
): GeneralAgentTask {
  const lastUserMessage = [...task.messages].reverse().find((item) => item.role === 'user')
  const repeated = lastUserMessage?.content.trim() === message.content.trim() &&
    (lastUserMessage?.attachment?.path ?? '') === (message.attachment?.path ?? '')
  return {
    ...task,
    draftPrompt: '',
    messages: repeated ? task.messages : [...task.messages, message],
    updatedAt: message.createdAt,
  }
}

export function findWorkspaceGeneralTask(
  tasks: GeneralAgentTask[],
  selectedId: string | null,
  conversation: AgentConversation | null,
): GeneralAgentTask | null {
  const directTask = tasks.find((task) => task.id === selectedId)
  if (directTask) return directTask
  return tasks.find((task) => task.id === conversation?.sourceTaskId) ?? null
}

/** Rebuild only the conversation context of a legacy workspace, never its execution. */
export function ensureWorkspaceTaskLink(
  conversation: AgentConversation,
  tasks: GeneralAgentTask[],
  seed: WorkspaceTaskLinkSeed,
): { conversation: AgentConversation; task: GeneralAgentTask } | null {
  const existing = tasks.find((task) => task.id === conversation.sourceTaskId)
  if (existing) return { conversation, task: existing }

  const attachment = conversation.sourcePath
    ? {
        path: conversation.sourcePath,
        name: conversation.sourcePath.split(/[\\/]/).pop() || conversation.sourcePath,
      }
    : null
  const createdAt = conversation.createdAt ?? seed.now
  const task = tasks.find((candidate) => candidate.id === seed.taskId) ?? {
    id: seed.taskId,
    kind: 'general' as const,
    title: conversation.title,
    draftPrompt: '',
    messages: conversation.prompt.trim()
      ? [{
          id: seed.messageId,
          role: 'user' as const,
          content: conversation.prompt,
          createdAt,
          attachment,
        }]
      : [],
    selectedModeId: conversation.mode,
    creationOptions: conversation.mode === 'video-dubbing'
      ? {
          videoDubbingMode: conversation.videoDubbingMode,
          videoDubbingLanguages: conversation.videoDubbingLanguages,
          videoDubbingStyle: conversation.videoDubbingStyle,
        }
      : undefined,
    attachment,
    createdAt,
    updatedAt: conversation.updatedAt ?? createdAt,
    submitting: false,
  }
  return { conversation: { ...conversation, sourceTaskId: task.id }, task }
}
