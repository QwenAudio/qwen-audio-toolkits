import type { AgentInstallationState } from './agentInstallState'

export interface PythonAgentModelDefinition {
  id: string
}

export interface PythonAgentModelGroup<TModel extends PythonAgentModelDefinition> {
  id: string
  label: string
  models: readonly TModel[]
}

export interface PythonAgentSidebarGroup<TModel extends PythonAgentModelDefinition> {
  id: string
  label: string
  models: TModel[]
  agents: AgentInstallationState[]
}

export function reconcilePythonAgentSelection(
  selectedId: string | null,
  agents: readonly AgentInstallationState[],
): string | null {
  return selectedId && agents.some(
    (agent) => agent.id === selectedId && agent.status === 'installed',
  )
    ? selectedId
    : null
}

/** Installed Agents are first-class tasks, not replacements for model-store entries. */
export function buildPythonAgentSidebarGroups<TModel extends PythonAgentModelDefinition>({
  modelGroups,
  agents,
}: {
  modelGroups: readonly PythonAgentModelGroup<TModel>[]
  agents: readonly AgentInstallationState[]
  definitions: readonly TModel[]
  groupOrder: readonly string[]
  categoryForModel: (model: TModel) => string
}): PythonAgentSidebarGroup<TModel>[] {
  const groups: PythonAgentSidebarGroup<TModel>[] = modelGroups.map((group) => ({
    ...group,
    models: [...group.models],
    agents: [],
  }))
  const installedAgents = agents.filter((agent) => agent.status !== 'uninstalled')
  if (installedAgents.length > 0) {
    groups.unshift({ id: 'agents', label: '我的 Agents', models: [], agents: installedAgents })
  }
  return groups
}
