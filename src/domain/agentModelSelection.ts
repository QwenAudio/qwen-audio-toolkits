import type { AcpProviderInfo } from '../types'
import type { AgentModelSelection } from './agents'
import { t } from '../i18n'

export interface AgentModelOption {
  id: string
  name: string
  providerId: string
  available: boolean
}

export const DEFAULT_AGENT_MODEL: AgentModelSelection = {
  transport: 'acp',
  providerId: 'qoder',
  modelId: '',
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
