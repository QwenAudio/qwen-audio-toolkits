import type { AgentCreationMode } from '../domain/agents'

export interface WorkspaceCommand {
  action: string
  args: Record<string, unknown>
}

export interface WorkspaceActionDefinition {
  name: string
  description: string
  /** A JSON Schema object describing the allowed arguments. */
  parameters: Record<string, unknown>
  /** Exact commands that can run without a model; never substring matching. */
  quickCommands?: Array<{ text: string; args: Record<string, unknown> }>
  allowedWhileBusy?: boolean
}

export interface WorkspaceEditorState {
  mode: AgentCreationMode
  /** Change when editable content changes, excluding playback/progress ticks. */
  revision: string
  busy: boolean
  context: Record<string, unknown>
  actions: WorkspaceActionDefinition[]
}

export interface WorkspaceCommandResult {
  /** Describe an observed change or a started operation, never predicted completion. */
  message: string
}

export interface WorkspaceController {
  getState: () => WorkspaceEditorState
  /** Validate all arguments and use the same handlers/state as the manual UI. */
  execute: (command: WorkspaceCommand) => Promise<WorkspaceCommandResult>
}

const controllers = new Map<string, WorkspaceController>()

export function registerWorkspaceController(projectId: string, controller: WorkspaceController): () => void {
  controllers.set(projectId, controller)
  return () => { if (controllers.get(projectId) === controller) controllers.delete(projectId) }
}

export function getWorkspaceController(projectId: string): WorkspaceController | null {
  return controllers.get(projectId) ?? null
}
