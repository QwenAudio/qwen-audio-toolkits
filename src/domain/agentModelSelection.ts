import type { AcpProviderInfo, OpenCodeConnection } from '../types'
import type { AgentModelSelection } from './agents'
import { t } from '../i18n'

export interface AgentModelOption {
  id: string
  name: string
  providerId: string
  available: boolean
}

export interface OpenCodeApiBindingResolution {
  selected: OpenCodeConnection | null
  eligible: OpenCodeConnection[]
  isEligible: boolean
}

/** Preserve a saved binding for display, but only allow eligible API Providers to power bundled Agents. */
export function resolveOpenCodeApiBinding(
  apiProviderId: string | undefined,
  connections: OpenCodeConnection[],
): OpenCodeApiBindingResolution {
  const selectedId = apiProviderId?.trim() || ''
  const selected = connections.find(connection => connection.id === selectedId) ?? null
  return {
    selected,
    eligible: connections.filter(connection => connection.eligible),
    isEligible: Boolean(selected?.eligible),
  }
}

export const DEFAULT_AGENT_MODEL: AgentModelSelection = {
  transport: 'acp',
  providerId: 'opencode-bundled',
  apiProviderId: '',
  modelId: '',
}

/** Only bundled ACP providers receive the separately configured API Provider binding. */
export function acpApiProviderId(
  selection: AgentModelSelection,
  provider: AcpProviderInfo | undefined,
): string | undefined {
  if (!provider?.requiresApiProvider) return undefined
  return selection.apiProviderId?.trim() || undefined
}

/** Keep discovered models scoped to both the ACP runtime and its selected API endpoint. */
export function acpModelCacheKey(providerId: string, apiProviderId?: string): string {
  return JSON.stringify([providerId, apiProviderId?.trim() || ''])
}

export function getAgentSelection(selection: AgentModelSelection | null | undefined): AgentModelSelection {
  return selection?.transport === 'acp' ? selection : DEFAULT_AGENT_MODEL
}

export function resolveAcpSelection(selection: AgentModelSelection | null | undefined, providers: AcpProviderInfo[]): AgentModelSelection {
  const saved = getAgentSelection(selection)
  const provider = providers.find(item => item.id === saved.providerId)
  if (!provider?.available) throw new Error(t('未找到可用的 ACP Agent，请先安装并登录所选 Agent。'))
  return { ...saved }
}
