export type AgentCreationMode =
  | 'smart-cut'
  | 'ai-podcast'
  | 'video-dubbing'
  | 'meeting-notes'
  | 'agent-chat'
export type VideoDubbingMode = 'translate' | 'rewrite' | 'script'
export type VideoDubbingStyle = 'natural' | 'formal' | 'casual'

export interface VideoDubbingLanguages {
  source: string
  target: string
}

export interface AgentCreationOptions {
  videoDubbingMode?: VideoDubbingMode
  videoDubbingLanguages?: VideoDubbingLanguages
  videoDubbingStyle?: VideoDubbingStyle
}

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

export interface AgentPlanStep {
  id: string
  capability: string
  description: string
  modelPreference?: string[]
  parameters?: Record<string, unknown>
  status: GeneralAgentActionStatus
  result?: string
}

export interface GeneralAgentStructuredPlanAction {
  id: string
  kind: 'structured-agent-plan'
  status: GeneralAgentActionStatus
  steps: AgentPlanStep[]
  confirmationText: string
}

export type GeneralAgentMessageAction =
  | GeneralAgentInstallModelAction
  | GeneralAgentConfirmAction
  | GeneralAgentStructuredPlanAction

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
  videoDubbingLanguages?: VideoDubbingLanguages
  videoDubbingStyle?: VideoDubbingStyle
  sourceTaskId?: string
  createdAt?: number
  updatedAt?: number
  /** Restored tasks open for review; execution resumes only on user action. */
  restored?: boolean
}

export interface AgentModelSelection {
  transport?: 'acp'
  providerId: string
  /** ACP model ID advertised by the Agent; empty means its default. */
  modelId: string
}

export interface GeneralAgentTask {
  id: string
  kind: 'general'
  title: string
  draftPrompt: string
  messages: GeneralAgentMessage[]
  selectedModeId: AgentCreationMode | null
  chatModel?: AgentModelSelection | null
  creationOptions?: AgentCreationOptions
  attachment?: {
    path: string
    name: string
  } | null
  createdAt: number
  updatedAt: number
  submitting: boolean
}
