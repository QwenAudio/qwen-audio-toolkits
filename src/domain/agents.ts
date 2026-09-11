export type AgentCreationMode = 'smart-cut' | 'ai-podcast' | 'video-dubbing' | 'meeting-notes'
export type VideoDubbingMode = 'translate' | 'rewrite' | 'script'

export type GeneralAgentRole = 'user' | 'assistant'
export type GeneralAgentActionStatus = 'pending' | 'running' | 'done' | 'failed'

export interface GeneralAgentInstallModelAction {
  id: string
  kind: 'install-on-demand-model'
  status: GeneralAgentActionStatus
  modelId: string
  modelName: string
  capability: string
  needLabel: string
  actionLabel: string
  prompt: string
  selectedModeName: string | null
  attachmentHint: string
  attachment?: GeneralAgentAttachment | null
}

export interface GeneralAgentConfirmAction {
  id: string
  kind: 'confirm-agent-plan'
  status: GeneralAgentActionStatus
  label: string
  confirmationText: string
}

export type GeneralAgentMessageAction =
  | GeneralAgentInstallModelAction
  | GeneralAgentConfirmAction

export interface GeneralAgentAttachment {
  path: string
  name: string
}

export interface GeneralAgentMessage {
  id: string
  role: GeneralAgentRole
  content: string
  createdAt: number
  action?: GeneralAgentMessageAction
  attachment?: GeneralAgentAttachment | null
  attachments?: GeneralAgentAttachment[]
}

export interface GeneralAgentModelChoice {
  id: string
  name: string
  description: string
  installed: boolean
}

export interface GeneralAgentMessageModelOptions {
  needLabel: string
  actionLabel: string
  selectedModelId: string
  choices: GeneralAgentModelChoice[]
}

export interface AgentConversation {
  id: string
  mode: AgentCreationMode
  title: string
  prompt: string
  sourcePath: string
  videoDubbingMode?: VideoDubbingMode
}

export interface GeneralAgentTask {
  id: string
  kind: 'general'
  title: string
  draftPrompt: string
  messages: GeneralAgentMessage[]
  selectedModeId: AgentCreationMode | null
  attachment?: {
    path: string
    name: string
  } | null
  createdAt: number
  updatedAt: number
  submitting: boolean
}
