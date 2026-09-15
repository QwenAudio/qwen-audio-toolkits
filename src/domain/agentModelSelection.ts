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

export const AGENT_MODEL_PREFERENCE_STORAGE_KEY = 'qwen-audio-toolkits.agent-model-selection-v1'

type AgentModelPreferenceReader = Pick<Storage, 'getItem'>
type AgentModelPreferenceWriter = Pick<Storage, 'setItem'>

export function initialAgentModelSelection(
  selection: AgentModelSelection = DEFAULT_AGENT_MODEL,
): AgentModelSelection {
  return { ...selection, transport: 'acp' }
}

export function loadAgentModelPreference(
  storage?: AgentModelPreferenceReader,
): AgentModelSelection {
  try {
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    const value = JSON.parse(source?.getItem(AGENT_MODEL_PREFERENCE_STORAGE_KEY) ?? 'null')
    if (
      value?.transport === 'acp' &&
      typeof value.providerId === 'string' &&
      typeof value.modelId === 'string' &&
      (value.apiProviderId === undefined || typeof value.apiProviderId === 'string')
    ) {
      return initialAgentModelSelection(value)
    }
  } catch {
    return initialAgentModelSelection()
  }
  return initialAgentModelSelection()
}

export function saveAgentModelPreference(
  selection: AgentModelSelection,
  storage?: AgentModelPreferenceWriter,
): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    target?.setItem(
      AGENT_MODEL_PREFERENCE_STORAGE_KEY,
      JSON.stringify(initialAgentModelSelection(selection)),
    )
  } catch {
    return
  }
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
