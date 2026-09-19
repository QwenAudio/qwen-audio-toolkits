import type { AgentInstallationState } from './agentInstallState'

export interface PythonAgentModelDefinition {
  id: string
}

export interface PythonAgentModelGroup<
  TModel extends PythonAgentModelDefinition,
> {
  id: string
  label: string
  models: readonly TModel[]
}

export interface PythonAgentSidebarGroup<
  TModel extends PythonAgentModelDefinition,
> {
  id: string
  label: string
  models: TModel[]
  agents: AgentInstallationState[]
}

export function reconcilePythonAgentSelection(
  selectedUiId: string | null,
  agents: readonly AgentInstallationState[],
): string | null {
  return selectedUiId && agents.some(
    (agent) => agent.uiId === selectedUiId && agent.status === 'installed',
  )
    ? selectedUiId
    : null
}

export function buildPythonAgentSidebarGroups<
  TModel extends PythonAgentModelDefinition,
>({
  modelGroups,
  agents,
  definitions,
  groupOrder,
  categoryForModel,
}: {
  modelGroups: readonly PythonAgentModelGroup<TModel>[]
  agents: readonly AgentInstallationState[]
  definitions: readonly TModel[]
  groupOrder: readonly string[]
  categoryForModel: (model: TModel) => string
}): PythonAgentSidebarGroup<TModel>[] {
  const replacingServerIds = new Set(
    agents
      .filter(
        (agent) => agent.status === 'installed' || agent.status === 'uninstalling',
      )
      .map((agent) => agent.serverId),
  )
  const modelGroupIds = new Map<string, string>()
  for (const group of modelGroups) {
    for (const model of group.models) modelGroupIds.set(model.id, group.id)
  }
  const groups: PythonAgentSidebarGroup<TModel>[] = modelGroups.map((group) => ({
    ...group,
    models: group.models.filter(
      (model) => !replacingServerIds.has(model.id),
    ),
    agents: [],
  }))

  for (const agent of agents) {
    if (agent.status === 'uninstalled') continue
    const definition = definitions.find(
      (model) => model.id === agent.serverId,
    )
    const id = modelGroupIds.get(agent.serverId)
      ?? (definition ? categoryForModel(definition) : '其他')
    let group = groups.find((item) => item.id === id)
    if (!group) {
      group = { id, label: id, models: [], agents: [] }
      groups.push(group)
    }
    group.agents.push(agent)
  }

  const rank = (id: string) =>
    id === 'pinned'
      ? -1
      : groupOrder.includes(id)
        ? groupOrder.indexOf(id)
        : groupOrder.length
  return groups
    .filter((group) => group.models.length + group.agents.length > 0)
    .sort((left, right) => rank(left.id) - rank(right.id))
}
