import type { GeneralAgentConfirmAction, GeneralAgentMessageAction } from './agents'

const CONFIRM_PATTERNS = [
  /请确认[：:，,]?\s*[^。！？\n]*[？?]?/u,
  /回复[“"']?确认[”"']?/u,
  /确认后/u,
  /确认以上/u,
  /确认这个方案/u,
  /确认该方案/u,
  /如果.*(?:没有问题|可以|同意).*确认/u,
  /点击.*确认/u,
]

const NEGATIVE_CONFIRM_PATTERNS = [
  /无需确认/u,
  /不用确认/u,
  /不需要确认/u,
  /无需人工确认/u,
]

export function hasConfirmableAgentRequest(content: string): boolean {
  const normalized = content.trim()
  if (!normalized) return false
  if (NEGATIVE_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  return CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function createConfirmAgentAction(content: string): GeneralAgentConfirmAction | undefined {
  if (!hasConfirmableAgentRequest(content)) return undefined
  return {
    id: 'confirm-agent-plan',
    kind: 'confirm-agent-plan',
    status: 'pending',
    label: '确认',
    confirmationText: '确认',
  }
}

export function inferAgentMessageAction(content: string): GeneralAgentMessageAction | undefined {
  return createConfirmAgentAction(content)
}

