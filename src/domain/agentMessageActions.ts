import type {
  AgentPlanStep,
  GeneralAgentConfirmAction,
  GeneralAgentMessageAction,
  GeneralAgentStructuredPlanAction,
} from './agents'

const CONFIRM_PATTERNS = [
  /请确认[：:，,]?\s*[^。！？\n]*[？?]?/u,
  /回复[“”']?确认[“”']?/u,
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

const VALID_PLAN_CAPABILITIES = new Set([
  'speech.transcribe',
  'speech.synthesize',
  'audio.enhance',
  'audio.separate',
  'text.generate',
  'speech.detect',
  'text.normalize',
  'speaker.embed',
])

const PLAN_BLOCK_PATTERN = /```plan\s*\n([\s\S]*?)\n```/u

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

export function extractStructuredPlan(
  content: string,
): GeneralAgentStructuredPlanAction | undefined {
  const match = PLAN_BLOCK_PATTERN.exec(content)
  if (!match) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const rawSteps = (parsed as Record<string, unknown>).steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return undefined
  const steps: AgentPlanStep[] = []
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') return undefined
    const step = raw as Record<string, unknown>
    const id = typeof step.id === 'string' ? step.id : `step-${steps.length + 1}`
    const capability = typeof step.capability === 'string' ? step.capability : ''
    const description = typeof step.description === 'string' ? step.description : ''
    if (!capability || !VALID_PLAN_CAPABILITIES.has(capability)) return undefined
    if (!description) return undefined
    const modelPreference = Array.isArray(step.modelPreference)
      ? step.modelPreference.filter((item): item is string => typeof item === 'string')
      : undefined
    const parameters =
      step.parameters && typeof step.parameters === 'object'
        ? (step.parameters as Record<string, unknown>)
        : undefined
    steps.push({
      id,
      capability,
      description,
      modelPreference: modelPreference?.length ? modelPreference : undefined,
      parameters,
      status: 'pending',
    })
  }
  if (!steps.length) return undefined
  return {
    id: 'structured-agent-plan',
    kind: 'structured-agent-plan',
    status: 'pending',
    steps,
    confirmationText: '执行计划',
  }
}

export function inferAgentMessageAction(content: string): GeneralAgentMessageAction | undefined {
  return extractStructuredPlan(content) ?? createConfirmAgentAction(content)
}

