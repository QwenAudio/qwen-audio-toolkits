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
  question?: GeneralAgentAskQuestion
}

export interface GeneralAgentConfirmAction {
  id: string
  kind: 'confirm-agent-plan'
  status: GeneralAgentActionStatus
  label: string
  confirmationText: string
  questions?: GeneralAgentConfirmQuestion[]
}

export interface GeneralAgentAskQuestionOption {
  id: string
  label: string
  description?: string
  installed?: boolean
}

export interface GeneralAgentAskQuestion {
  id: string
  prompt: string
  options: GeneralAgentAskQuestionOption[]
  allowMultiple?: boolean
}

export interface GeneralAgentConfirmOption extends GeneralAgentAskQuestionOption {
  confirmationText: string
}

export interface GeneralAgentConfirmQuestion extends GeneralAgentAskQuestion {
  options: GeneralAgentConfirmOption[]
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

export interface GeneralAgentMessageModelOptions {
  needLabel: string
  actionLabel: string
  selectedOptionId: string
  question: GeneralAgentAskQuestion
}

export interface AgentConversation {
  archived?: boolean
  id: string
  mode: AgentCreationMode
  title: string
  prompt: string
  sourcePath: string
  videoDubbingMode?: VideoDubbingMode
  videoDubbingLanguages?: VideoDubbingLanguages
  videoDubbingStyle?: VideoDubbingStyle
  /** Direct workshop runs stay in the dedicated editor instead of opening Agent chat. */
  launchSource?: 'workshop'
  sourceTaskId?: string
  createdAt?: number
  updatedAt?: number
  /** Restored tasks open for review; execution resumes only on user action. */
  restored?: boolean
}

export interface AgentModelSelection {
  transport?: 'acp'
  providerId: string
  /** API Provider bound to bundled ACP Agents; omitted by legacy and external selections. */
  apiProviderId?: string
  /** ACP model ID advertised by the Agent; empty means its default. */
  modelId: string
}

export interface GeneralAgentTask {
  archived?: boolean
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
  attachments?: GeneralAgentAttachment[]
  createdAt: number
  updatedAt: number
  submitting: boolean
}

export type GeneralAgentProgressStatus = 'running' | 'done' | 'failed' | 'waiting'

export interface GeneralAgentProgressEntry {
  id: string
  label: string
  detail?: string
  status: GeneralAgentProgressStatus
  createdAt: number
  updatedAt: number
}
