import type { AcpProviderInfo } from '../types'
import type { AgentModelSelection } from './agents'
import { t } from '../i18n'

export interface AgentModelOption {
  id: string
  name: string
  providerId: string
  available: boolean
}

export function resolveAcpSelection(selection: AgentModelSelection | null | undefined, providers: AcpProviderInfo[]): AgentModelSelection {
  const saved = selection?.transport === 'acp' ? selection : null
  const provider = saved ? providers.find(item => item.id === saved.providerId)
    : providers.find(item => item.id === 'codex' && item.available) ?? providers.find(item => item.available)
  if (!provider?.available) throw new Error(t('未找到可用的 ACP Agent，请先安装并登录所选 Agent。'))
  return { transport: 'acp', providerId: provider.id, modelId: saved?.modelId ?? '' }
}
