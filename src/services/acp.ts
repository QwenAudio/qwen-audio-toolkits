import { isTauri, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AcpProviderInfo,
  AcpQuestionAnswer,
  AcpSessionEvent,
  AcpSessionStartRequest,
  AcpSessionStartResponse,
} from '../types'

/** Clears a persisted reference to the removed bundled provider. */
export function normalizeHiddenAcpProviderId(value: string | null): string | null {
  return value === 'opencode-bundled' ? null : value
}

/** Lists only externally installed ACP providers. This service has no UI consumer. */
export function listAcpProviders(): Promise<AcpProviderInfo[]> {
  if (!isTauri()) return Promise.resolve([])
  return invoke<AcpProviderInfo[]>('acp_list_providers')
}

export function startAcpSession(
  request: AcpSessionStartRequest,
): Promise<AcpSessionStartResponse> {
  return invoke<AcpSessionStartResponse>('acp_start_session', { request })
}

export function sendAcpPrompt(sessionId: string, prompt: string): Promise<void> {
  return invoke<void>('acp_send_prompt', { sessionId, prompt })
}

export function cancelAcpTurn(sessionId: string): Promise<void> {
  return invoke<void>('acp_cancel_turn', { sessionId })
}

export function respondAcpPermission(
  sessionId: string,
  requestId: string,
  optionId?: string,
): Promise<void> {
  return invoke<void>('acp_respond_permission', {
    sessionId,
    requestId,
    optionId,
  })
}

export function respondAcpQuestion(
  sessionId: string,
  requestId: string,
  answers?: AcpQuestionAnswer[],
): Promise<void> {
  return invoke<void>('acp_respond_question', {
    sessionId,
    requestId,
    outcome: answers
      ? { outcome: 'answered', answers }
      : { outcome: 'cancelled' },
  })
}

export function respondAcpPlanApproval(
  sessionId: string,
  requestId: string,
  accepted: boolean,
  reason?: string,
): Promise<void> {
  return invoke<void>('acp_respond_plan_approval', {
    sessionId,
    requestId,
    outcome: accepted
      ? { outcome: 'accepted' }
      : { outcome: 'rejected', reason },
  })
}

export function finishAcpSession(sessionId: string): Promise<void> {
  return invoke<void>('acp_finish_session', { sessionId })
}

export function subscribeAcpSession(
  callback: (event: AcpSessionEvent) => void,
): Promise<UnlistenFn> {
  return listen<AcpSessionEvent>('acp-session-event', event => callback(event.payload))
}
