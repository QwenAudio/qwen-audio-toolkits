import type {
  AgentPlanStep,
  GeneralAgentConfirmAction,
  GeneralAgentConfirmQuestion,
  GeneralAgentMessageAction,
  GeneralAgentStructuredPlanAction,
} from './agents'

const CONFIRM_PATTERNS = [
  /请确认[：:，,]?\s*[^。！？\n]*[？?]?/u,
  /需要确认/u,
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
const QUESTION_LINE_PATTERN = /[？?]\s*$/u
const LIST_PREFIX_PATTERN = /^\s*(?:[-*+]\s+|\d+[.)、]\s*)/u
const INLINE_MARKDOWN_PATTERN = /[*_~`]/gu
const YES_NO_PATTERN = /(?:可以吗|可不可以|是否可以|是否可用|是否确认|要不要|需要吗|行吗|对吗)[？?]?$/u

function cleanInlineText(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(INLINE_MARKDOWN_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function questionStem(value: string): string {
  return cleanInlineText(value).replace(/[？?]\s*$/u, '').trim()
}

function optionFromLeftSide(value: string): string {
  const cleaned = questionStem(value)
  const markers = ['还是', '选择', '采用', '使用', '输出为', '文件名用', '用', '按', '以', '为', '是']
  let result = cleaned
  for (const marker of markers) {
    const index = result.lastIndexOf(marker)
    if (index >= 0 && index + marker.length < result.length) {
      result = result.slice(index + marker.length)
      break
    }
  }
  return result.replace(/[：:，,。；;]\s*$/u, '').trim()
}

function suggestedValueFromQuestion(value: string): string | null {
  const code = /`([^`]+)`/u.exec(value)
  if (code?.[1]?.trim()) return code[1].trim()
  const quoted = /[“"']([^”"']+)[”"']/u.exec(value)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  return null
}

function parseConfirmationQuestion(line: string, index: number): GeneralAgentConfirmQuestion | null {
  const raw = line.replace(LIST_PREFIX_PATTERN, '').trim()
  if (!QUESTION_LINE_PATTERN.test(raw)) return null
  const prompt = questionStem(raw)
  if (!prompt) return null
  if (raw.includes('还是')) {
    const [leftRaw, ...rightParts] = raw.split('还是')
    const left = optionFromLeftSide(leftRaw)
    const right = questionStem(rightParts.join('还是'))
    const options = [left, right]
      .map(cleanInlineText)
      .filter((option, optionIndex, all) => option.length > 0 && all.indexOf(option) === optionIndex)
    if (options.length >= 2) {
      return {
        id: `confirm-question-${index + 1}`,
        prompt,
        options: options.slice(0, 4).map((option, optionIndex) => ({
          id: `option-${optionIndex + 1}`,
          label: option,
          confirmationText: `选择：${option}`,
        })),
      }
    }
  }
  if (YES_NO_PATTERN.test(raw)) {
    const suggested = suggestedValueFromQuestion(raw)
    return {
      id: `confirm-question-${index + 1}`,
      prompt,
      options: [
        {
          id: 'yes',
          label: suggested ? `使用 ${suggested}` : '可以',
          confirmationText: suggested ? `使用 ${suggested}` : '可以',
        },
        {
          id: 'no',
          label: '需要修改',
          confirmationText: '需要修改',
        },
      ],
    }
  }
  return null
}

export function extractConfirmationQuestions(content: string): GeneralAgentConfirmQuestion[] {
  const questions: GeneralAgentConfirmQuestion[] = []
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    const question = parseConfirmationQuestion(line, questions.length)
    if (question) questions.push(question)
  }
  return questions.slice(0, 6)
}

export function buildConfirmAgentResponse(
  action: GeneralAgentConfirmAction,
  selections?: Record<string, string>,
): string {
  if (!action.questions?.length) return action.confirmationText
  const lines = action.questions.map((question) => {
    const option =
      question.options.find((candidate) => candidate.id === selections?.[question.id]) ??
      question.options[0]
    return `- ${question.prompt}：${option.confirmationText}`
  })
  return `确认以下选择：\n${lines.join('\n')}`
}

export function hasConfirmableAgentRequest(content: string): boolean {
  const normalized = content.trim()
  if (!normalized) return false
  if (NEGATIVE_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  return CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function createConfirmAgentAction(content: string): GeneralAgentConfirmAction | undefined {
  if (!hasConfirmableAgentRequest(content)) return undefined
  const questions = extractConfirmationQuestions(content)
  return {
    id: 'confirm-agent-plan',
    kind: 'confirm-agent-plan',
    status: 'pending',
    label: questions.length ? '确认选择' : '确认',
    confirmationText: '确认',
    questions: questions.length ? questions : undefined,
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
