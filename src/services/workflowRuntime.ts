import { executeHarnessTask, startCosyVoiceStream } from './harness'
import {
  planWorkflow,
  type WorkflowPlan,
} from './workflowPlanner'
import { audioFileToClip } from '../utils/audio'
import type { WorkflowPortType } from '../domain/capabilities'
import type {
  AsrTranscriptionResult,
  AudioProcessResult,
  HarnessCapabilityId,
  HarnessExecution,
  HarnessRun,
  CosyVoiceStreamStartResponse,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
  VadSegment,
} from '../types'

export const WORKFLOW_STORAGE_KEY = 'qwen-audio-toolkits.visual-workflow-v4'
export const SAVED_WORKFLOWS_STORAGE_KEY = 'qwen-audio.saved-workflows-v1'
const DEFAULT_WORKFLOWS_STORAGE_KEY =
  'qwen-audio.default-workflows-installed-v2'
const WORKFLOW_ITN_MIGRATION_KEY =
  'qwen-audio.caption-itn-migration-v1'

type WorkflowAudioOutput = TtsGenerateResult | AudioProcessResult

export interface StoredWorkflowNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data: {
    kind: string
    label: string
    pluginId?: string
    capability?: HarnessCapabilityId
    providerId?: string
    modelId?: string
    adapter?: string
    streamingMode?: 'streaming' | 'batch'
    parameters?: Record<string, string | number | boolean>
    inputTypes?: WorkflowPortType[]
    outputType?: WorkflowPortType
    state?: 'idle' | 'running' | 'completed' | 'failed'
  }
}

export interface StoredWorkflowEdge {
  id?: string
  source: string
  target: string
}

export interface StoredWorkflow {
  nodes: StoredWorkflowNode[]
  edges: StoredWorkflowEdge[]
}

export interface SavedWorkflow extends StoredWorkflow {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface WorkflowTemplate extends StoredWorkflow {
  id: string
  name: string
}

export interface WorkflowConversationOutput {
  transcript: string
  transcription: AsrTranscriptionResult | null
  reply: string
  audio: WorkflowAudioOutput | null
  steps: string[]
  nodeResults: WorkflowNodeResult[]
}

export interface StreamingWorkflowOutput {
  reply: string
  audio: WorkflowAudioOutput | null
  steps: string[]
  ttsStream: CosyVoiceStreamStartResponse | null
  nodeResults: WorkflowNodeResult[]
}

export interface WorkflowNodeResult {
  nodeId: string
  order: number
  label: string
  capability: HarnessCapabilityId
  outputType?: WorkflowPortType
  output: Record<string, unknown>
  run?: HarnessRun
  exposedAs: string[]
}

export interface WorkflowStreamingAsrConfig {
  providerId?: string
  modelId?: string
  adapter?: string
  parameters: Record<string, string | number | boolean>
}

export interface WorkflowStreamingVadConfig {
  providerId?: string
  modelId?: string
  adapter?: string
  parameters: Record<string, string | number | boolean>
}

export interface WorkflowStreamingEnhancementConfig {
  providerId: string
  modelId?: string
  adapter?: string
  parameters: Record<string, string | number | boolean>
}

export const DEFAULT_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'default-realtime-voice-assistant',
    name: '实时语音助手',
    nodes: [
    {
      id: 'input',
        type: 'workflow',
        position: { x: 20, y: 90 },
        data: {
          kind: 'input',
          label: '音频输入',
          parameters: {},
          inputTypes: [],
          outputType: 'audio',
          state: 'idle',
        },
    },
    {
      id: 'vad',
        type: 'workflow',
        position: { x: 250, y: 90 },
      data: {
        kind: 'vad',
        label: 'Silero VAD',
        capability: 'speech.detect',
        providerId: 'local.silero-vad',
        parameters: {
          threshold: 0.25,
          minSpeechDuration: 0.18,
          minSilenceDuration: 0.2,
        },
          inputTypes: ['audio'],
          outputType: 'speech-segments',
          state: 'idle',
      },
    },
    {
      id: 'asr',
        type: 'workflow',
        position: { x: 480, y: 90 },
      data: {
        kind: 'asr',
        label: 'FunASR Realtime',
        capability: 'speech.transcribe',
        providerId: 'api.bailian',
        modelId: 'fun-asr-realtime',
        adapter: 'bailian-funasr',
        streamingMode: 'streaming',
        parameters: {
          language: 'auto',
          context: '',
          semanticPunctuation: true,
        },
          inputTypes: ['audio', 'speech-segments'],
          outputType: 'transcript',
          state: 'idle',
      },
    },
    {
      id: 'llm',
        type: 'workflow',
        position: { x: 20, y: 290 },
      data: {
        kind: 'llm',
        label: 'Qwen3.7 Plus',
        capability: 'text.generate',
        providerId: 'api.bailian',
        modelId: 'qwen3.7-plus',
        adapter: 'bailian-llm',
        parameters: {
          temperature: 0.7,
          maxTokens: 320,
          systemPrompt:
            '你是一个简洁自然的语音助手。直接回答问题，回复适合朗读，不使用 Markdown。',
        },
          inputTypes: ['transcript', 'text'],
          outputType: 'text',
          state: 'idle',
      },
    },
    {
      id: 'tts',
        type: 'workflow',
        position: { x: 250, y: 290 },
      data: {
        kind: 'tts',
        label: 'CosyVoice v2',
        capability: 'speech.synthesize',
        providerId: 'api.bailian',
        modelId: 'cosyvoice-v2',
        adapter: 'bailian-cosyvoice',
        streamingMode: 'streaming',
        parameters: { voice: 'longxiaochun_v2', speed: 1 },
          inputTypes: ['text', 'transcript'],
          outputType: 'audio',
          state: 'idle',
      },
    },
    {
      id: 'output',
        type: 'workflow',
        position: { x: 480, y: 290 },
        data: {
          kind: 'output',
          label: '播放输出',
          parameters: {},
          inputTypes: ['audio'],
          state: 'idle',
        },
    },
  ],
    edges: [
      { id: 'input-vad', source: 'input', target: 'vad' },
      { id: 'vad-asr', source: 'vad', target: 'asr' },
      { id: 'asr-llm', source: 'asr', target: 'llm' },
      { id: 'llm-tts', source: 'llm', target: 'tts' },
      { id: 'tts-output', source: 'tts', target: 'output' },
  ],
  },
  {
    id: 'default-noisy-meeting-briefing',
    name: '嘈杂会议摘要',
    nodes: [
      {
        id: 'input',
        type: 'workflow',
        position: { x: 20, y: 80 },
        data: {
          kind: 'input',
          label: '会议录音',
          parameters: {},
          inputTypes: [],
          outputType: 'audio',
          state: 'idle',
        },
      },
      {
        id: 'enhance',
        type: 'workflow',
        position: { x: 250, y: 80 },
        data: {
          kind: 'enhance',
          label: 'DPDFNet2',
          capability: 'audio.enhance',
          providerId: 'local.dpdfnet2',
          parameters: { denoiseStrength: 0.68 },
          inputTypes: ['audio'],
          outputType: 'audio',
          state: 'idle',
        },
      },
      {
        id: 'vad',
        type: 'workflow',
        position: { x: 480, y: 80 },
        data: {
          kind: 'vad',
          label: 'Silero VAD',
          capability: 'speech.detect',
          providerId: 'local.silero-vad',
          parameters: {
            threshold: 0.25,
            minSpeechDuration: 0.18,
            minSilenceDuration: 0.35,
          },
          inputTypes: ['audio'],
          outputType: 'speech-segments',
          state: 'idle',
        },
      },
      {
        id: 'asr',
        type: 'workflow',
        position: { x: 710, y: 80 },
        data: {
          kind: 'asr',
          label: 'SenseVoice Small GGUF',
          capability: 'speech.transcribe',
          providerId: 'plugin.funaudiollm.sensevoice-small-gguf',
          adapter: 'funasr-sensevoice-gguf',
          streamingMode: 'batch',
          parameters: { language: 'auto' },
          inputTypes: ['audio', 'speech-segments'],
          outputType: 'transcript',
          state: 'idle',
        },
      },
      {
        id: 'llm',
        type: 'workflow',
        position: { x: 250, y: 280 },
        data: {
          kind: 'llm',
          label: 'Qwen3.7 Plus',
          capability: 'text.generate',
          providerId: 'api.bailian',
          modelId: 'qwen3.7-plus',
          adapter: 'bailian-llm',
          parameters: {
            temperature: 0.3,
            maxTokens: 480,
            systemPrompt:
              '你是会议摘要助手。提炼结论、决定、待办事项和负责人；忽略寒暄与重复内容。输出一段适合直接朗读的中文摘要，不使用 Markdown。',
          },
          inputTypes: ['transcript', 'text'],
          outputType: 'text',
          state: 'idle',
        },
      },
      {
        id: 'tts',
        type: 'workflow',
        position: { x: 480, y: 280 },
        data: {
          kind: 'tts',
          label: 'CosyVoice v2',
          capability: 'speech.synthesize',
          providerId: 'api.bailian',
          modelId: 'cosyvoice-v2',
          adapter: 'bailian-cosyvoice',
          streamingMode: 'streaming',
          parameters: { voice: 'longxiaochun_v2', speed: 1.03 },
          inputTypes: ['text', 'transcript'],
          outputType: 'audio',
          state: 'idle',
        },
      },
      {
        id: 'output',
        type: 'workflow',
        position: { x: 710, y: 280 },
        data: {
          kind: 'output',
          label: '摘要播报',
          parameters: {},
          inputTypes: ['audio'],
          state: 'idle',
        },
      },
    ],
    edges: [
      { id: 'input-enhance', source: 'input', target: 'enhance' },
      { id: 'enhance-vad', source: 'enhance', target: 'vad' },
      { id: 'vad-asr', source: 'vad', target: 'asr' },
      { id: 'asr-llm', source: 'asr', target: 'llm' },
      { id: 'llm-tts', source: 'llm', target: 'tts' },
      { id: 'tts-output', source: 'tts', target: 'output' },
    ],
  },
  {
    id: 'default-live-captions',
    name: '实时字幕',
    nodes: [
      {
        id: 'input',
        type: 'workflow',
        position: { x: 30, y: 150 },
        data: {
          kind: 'input',
          label: '音频输入',
          parameters: {},
          inputTypes: [],
          outputType: 'audio',
          state: 'idle',
        },
      },
      {
        id: 'vad',
        type: 'workflow',
        position: { x: 270, y: 150 },
        data: {
          kind: 'vad',
          label: 'Silero VAD',
          capability: 'speech.detect',
          providerId: 'local.silero-vad',
          parameters: {
            threshold: 0.25,
            minSpeechDuration: 0.18,
            minSilenceDuration: 0.55,
          },
          inputTypes: ['audio'],
          outputType: 'speech-segments',
          state: 'idle',
        },
      },
      {
        id: 'asr',
        type: 'workflow',
        position: { x: 510, y: 150 },
        data: {
          kind: 'asr',
          label: 'FunASR Realtime',
          capability: 'speech.transcribe',
          providerId: 'api.bailian',
          modelId: 'fun-asr-realtime',
          adapter: 'bailian-funasr',
          streamingMode: 'streaming',
          parameters: {
            language: 'auto',
            context: '',
            semanticPunctuation: true,
          },
          inputTypes: ['audio', 'speech-segments'],
          outputType: 'transcript',
          state: 'idle',
        },
      },
      {
        id: 'output',
        type: 'workflow',
        position: { x: 750, y: 150 },
        data: {
          kind: 'output',
          label: '字幕输出',
          parameters: { outputMode: 'captions' },
          inputTypes: ['transcript', 'text'],
          state: 'idle',
        },
      },
    ],
    edges: [
      { id: 'input-vad', source: 'input', target: 'vad' },
      { id: 'vad-asr', source: 'vad', target: 'asr' },
      { id: 'asr-output', source: 'asr', target: 'output' },
    ],
  },
]

const fallbackWorkflow: StoredWorkflow = DEFAULT_WORKFLOW_TEMPLATES[0]

function installDefaultWorkflows(): void {
  if (window.localStorage.getItem(DEFAULT_WORKFLOWS_STORAGE_KEY)) return
  const now = Date.now()
  let current: SavedWorkflow[] = []
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY) ?? '[]',
    ) as SavedWorkflow[]
    if (Array.isArray(parsed)) current = parsed
  } catch {
    current = []
  }
  const existingIds = new Set(current.map((workflow) => workflow.id))
  const defaults = DEFAULT_WORKFLOW_TEMPLATES.filter(
    (workflow) => !existingIds.has(workflow.id),
  ).map((workflow, index) => ({
    ...workflow,
    createdAt: now - index,
    updatedAt: now - index,
  }))
  window.localStorage.setItem(
    SAVED_WORKFLOWS_STORAGE_KEY,
    JSON.stringify([...defaults, ...current]),
  )
  window.localStorage.setItem(DEFAULT_WORKFLOWS_STORAGE_KEY, 'installed')
}

function migrateCaptionNormalization(): void {
  if (window.localStorage.getItem(WORKFLOW_ITN_MIGRATION_KEY)) return
  try {
    const workflows = JSON.parse(
      window.localStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY) ?? '[]',
    ) as SavedWorkflow[]
    let changed = false
    for (const workflow of workflows) {
      const incoming = new Map(
        workflow.edges.map((edge) => [edge.target, edge.source]),
      )
      const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
      const hasAsrUpstream = (nodeId: string) => {
        const visited = new Set<string>()
        let current = incoming.get(nodeId)
        while (current && !visited.has(current)) {
          visited.add(current)
          if (nodes.get(current)?.data.capability === 'speech.transcribe') {
            return true
          }
          current = incoming.get(current)
        }
        return false
      }
      const captionSources = workflow.nodes
        .filter(
          (node) =>
            node.data.kind === 'output' &&
            node.data.parameters?.outputMode === 'captions',
        )
        .map((node) => incoming.get(node.id))
        .filter((source): source is string => Boolean(source))
      for (const sourceId of captionSources) {
        let current: string | undefined = sourceId
        const visited = new Set<string>()
        while (current && !visited.has(current)) {
          visited.add(current)
          const node = nodes.get(current)
          if (
            node?.data.capability === 'text.normalize' &&
            hasAsrUpstream(node.id) &&
            node.data.parameters?.operator === 'tn'
          ) {
            node.data.parameters = {
              ...node.data.parameters,
              operator: 'itn',
            }
            changed = true
          }
          current = incoming.get(current)
        }
      }
    }
    if (changed) {
      window.localStorage.setItem(
        SAVED_WORKFLOWS_STORAGE_KEY,
        JSON.stringify(workflows),
      )
    }
  } finally {
    window.localStorage.setItem(WORKFLOW_ITN_MIGRATION_KEY, 'migrated')
  }
}

export function listSavedWorkflows(): SavedWorkflow[] {
  try {
    installDefaultWorkflows()
    migrateCaptionNormalization()
    const parsed = JSON.parse(
      window.localStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY) ?? '[]',
    ) as SavedWorkflow[]
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (workflow) =>
              workflow?.id &&
              workflow?.name &&
              Array.isArray(workflow.nodes) &&
              Array.isArray(workflow.edges),
          )
          .sort((left, right) => right.updatedAt - left.updatedAt)
      : []
  } catch {
    return []
  }
}

export function saveStoredWorkflow(
  workflow: Omit<SavedWorkflow, 'createdAt' | 'updatedAt'> & {
    createdAt?: number
  },
): SavedWorkflow[] {
  const now = Date.now()
  const current = listSavedWorkflows()
  const existing = current.find((item) => item.id === workflow.id)
  const saved: SavedWorkflow = {
    ...workflow,
    createdAt: existing?.createdAt ?? workflow.createdAt ?? now,
    updatedAt: now,
  }
  const next = [saved, ...current.filter((item) => item.id !== saved.id)]
  window.localStorage.setItem(
    SAVED_WORKFLOWS_STORAGE_KEY,
    JSON.stringify(next),
  )
  return next
}

export function removeStoredWorkflow(workflowId: string): SavedWorkflow[] {
  const next = listSavedWorkflows().filter(
    (workflow) => workflow.id !== workflowId,
  )
  window.localStorage.setItem(
    SAVED_WORKFLOWS_STORAGE_KEY,
    JSON.stringify(next),
  )
  return next
}

function loadWorkflow(workflowId?: string): StoredWorkflow {
  if (workflowId) {
    const saved = listSavedWorkflows().find(
      (workflow) => workflow.id === workflowId,
    )
    if (!saved) throw new Error('该流程不存在或已被删除')
    return saved
  }
  try {
    const saved = window.localStorage.getItem(WORKFLOW_STORAGE_KEY)
    if (!saved) return fallbackWorkflow
    const parsed = JSON.parse(saved) as StoredWorkflow
    if (!parsed.nodes?.length || !Array.isArray(parsed.edges)) {
      return fallbackWorkflow
    }
    return parsed
  } catch {
    return fallbackWorkflow
  }
}

function exposedOutputLabels(
  plan: WorkflowPlan<StoredWorkflowNode>,
  nodeId: string,
): string[] {
  return plan.outputs
    .filter((binding) => binding.sourceId === nodeId)
    .map((binding) => binding.node.data.label)
}

function createNodeResult(
  plan: WorkflowPlan<StoredWorkflowNode>,
  node: StoredWorkflowNode,
  execution: HarnessExecution<unknown>,
): WorkflowNodeResult {
  if (!node.data.capability) {
    throw new Error(`${node.data.label} 缺少能力声明`)
  }
  return {
    nodeId: node.id,
    order: plan.chain.findIndex((item) => item.id === node.id),
    label: node.data.label,
    capability: node.data.capability,
    outputType: node.data.outputType,
    output: execution.output as Record<string, unknown>,
    run: execution.run,
    exposedAs: exposedOutputLabels(plan, node.id),
  }
}

export function validateStoredWorkflow(
  workflow: StoredWorkflow,
): string | null {
  try {
    planWorkflow(workflow)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function numericParameter(
  value: string | number | boolean | undefined,
  fallback: number,
): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function executeWorkflowTextNode(
  providerId: string,
  parameters: Record<string, string | number | boolean>,
  currentText: string,
  title: string,
  onRunUpdate: (run: HarnessRun) => void,
): Promise<HarnessExecution<TextGenerateResult>> {
  return executeHarnessTask<TextGenerateResult>(
    {
      capability: 'text.generate',
      providerId,
      routing: 'quality',
      title,
      input: {
        messages: [
          {
            role: 'system',
            content: String(parameters.systemPrompt ?? ''),
          },
          { role: 'user', content: currentText },
        ],
      },
      parameters: {
        ...parameters,
        temperature: numericParameter(parameters.temperature, 0.7),
        maxTokens: numericParameter(parameters.maxTokens, 320),
      },
    },
    onRunUpdate,
  )
}

async function executeWorkflowTtsNode(
  providerId: string,
  parameters: Record<string, string | number | boolean>,
  currentText: string,
  title: string,
  onRunUpdate: (run: HarnessRun) => void,
): Promise<HarnessExecution<TtsGenerateResult>> {
  return executeHarnessTask<TtsGenerateResult>(
    {
      capability: 'speech.synthesize',
      providerId,
      routing: 'local',
      title,
      input: { text: currentText },
      parameters,
    },
    onRunUpdate,
  )
}

export function getWorkflowSummary(workflowId?: string): string {
  try {
    return planWorkflow(loadWorkflow(workflowId))
      .chain
      .filter(
        (node) => node.data.kind !== 'input',
      )
      .map((node) => node.data.label)
      .join(' → ')
  } catch {
    return '当前编排'
  }
}

export function getWorkflowStreamingAsrConfig(
  workflowId?: string,
): WorkflowStreamingAsrConfig | null {
  try {
    const plan = planWorkflow(loadWorkflow(workflowId))
    const nodeIndex = plan.chain.findIndex(
      (item) => item.data.capability === 'speech.transcribe',
    )
    const node = plan.chain[nodeIndex]
    if (
      !node ||
      (node.data.streamingMode !== 'streaming' &&
        ![
          'bailian-funasr',
          'streaming-zipformer',
          'streaming-paraformer',
        ].includes(node.data.adapter ?? ''))
    ) {
      return null
    }
    const upstreamEnhancers = plan.chain
      .slice(1, nodeIndex)
      .filter((item) => item.data.capability === 'audio.enhance')
    const unsupportedUpstream = plan.chain
      .slice(1, nodeIndex)
      .some(
        (item) =>
          item.data.capability !== 'speech.detect' &&
          item.data.capability !== 'audio.enhance',
      )
    if (
      unsupportedUpstream ||
      upstreamEnhancers.length > 1 ||
      upstreamEnhancers.some(
        (item) =>
          item.data.streamingMode !== 'streaming' &&
          !['deepfilternet', 'rnnoise'].includes(item.data.adapter ?? ''),
      )
    ) {
      return null
    }
    return {
      providerId: node.data.providerId,
      modelId: node.data.modelId,
      adapter: node.data.adapter,
      parameters: node.data.parameters ?? {},
    }
  } catch {
    return null
  }
}

export function getWorkflowStreamingEnhancementConfig(
  workflowId?: string,
): WorkflowStreamingEnhancementConfig | null {
  try {
    const plan = planWorkflow(loadWorkflow(workflowId))
    const asrIndex = plan.chain.findIndex(
      (item) => item.data.capability === 'speech.transcribe',
    )
    if (asrIndex < 0) return null
    const node = plan.chain
      .slice(1, asrIndex)
      .find((item) => item.data.capability === 'audio.enhance')
    if (
      !node?.data.providerId ||
      (node.data.streamingMode !== 'streaming' &&
        !['deepfilternet', 'rnnoise'].includes(node.data.adapter ?? ''))
    ) {
      return null
    }
    return {
      providerId: node.data.providerId,
      modelId: node.data.modelId,
      adapter: node.data.adapter,
      parameters: node.data.parameters ?? {},
    }
  } catch {
    return null
  }
}

export function getWorkflowStreamingVadConfig(
  workflowId?: string,
): WorkflowStreamingVadConfig | null {
  try {
    const node = planWorkflow(loadWorkflow(workflowId)).chain.find(
      (item) => item.data.capability === 'speech.detect',
    )
    if (!node) return null
    return {
      providerId: node.data.providerId,
      modelId: node.data.modelId,
      adapter: node.data.adapter,
      parameters: node.data.parameters ?? {},
    }
  } catch {
    return null
  }
}

export function workflowUsesCaptionOutput(workflowId?: string): boolean {
  try {
    return planWorkflow(loadWorkflow(workflowId)).outputs.some(
      ({ node }) => node.data.parameters?.outputMode === 'captions',
    )
  } catch {
    return false
  }
}

export function workflowCaptionNeedsFinalization(workflowId?: string): boolean {
  try {
    const plan = planWorkflow(loadWorkflow(workflowId))
    const asrIndex = plan.chain.findIndex(
      (node) => node.data.capability === 'speech.transcribe',
    )
    if (asrIndex < 0) return false
    const captionSources = new Set(
      plan.outputs
        .filter(({ node }) => node.data.parameters?.outputMode === 'captions')
        .map(({ sourceId }) => sourceId),
    )
    return plan.chain
      .slice(asrIndex + 1)
      .some((node) => captionSources.has(node.id))
  } catch {
    return false
  }
}

export function workflowIsCaptionOnly(workflowId?: string): boolean {
  try {
    const plan = planWorkflow(loadWorkflow(workflowId))
    const asrIndex = plan.chain.findIndex(
      (node) => node.data.capability === 'speech.transcribe',
    )
    const downstream = plan.chain.slice(asrIndex + 1)
    const lastNode = plan.chain.at(-1)
    return (
      asrIndex >= 0 &&
      downstream.every((node) =>
        ['text.normalize', 'text.punctuate'].includes(
          node.data.capability ?? '',
        ),
      ) &&
      plan.outputs.some(
        ({ node, sourceId }) =>
          sourceId === lastNode?.id &&
          node.data.parameters?.outputMode === 'captions',
      )
    )
  } catch {
    return false
  }
}

export function workflowSupportsTranscriptExport(workflowId?: string): boolean {
  try {
    const capabilities = planWorkflow(loadWorkflow(workflowId)).chain.map(
      (node) => node.data.capability,
    )
    return (
      capabilities.includes('speech.detect') &&
      capabilities.includes('speech.transcribe')
    )
  } catch {
    return false
  }
}

export function workflowNodeResultForCapability(
  capability: HarnessCapabilityId,
  output: Record<string, unknown>,
  run?: HarnessRun,
  workflowId?: string,
): WorkflowNodeResult | null {
  try {
    const plan = planWorkflow(loadWorkflow(workflowId))
    const node = plan.chain.find(
      (item) => item.data.capability === capability,
    )
    if (!node) return null
    return {
      nodeId: node.id,
      order: plan.chain.findIndex((item) => item.id === node.id),
      label: node.data.label,
      capability,
      outputType: node.data.outputType,
      output,
      run,
      exposedAs: exposedOutputLabels(plan, node.id),
    }
  } catch {
    return null
  }
}

export async function executeVoiceWorkflow(
  file: File,
  onRunUpdate: (run: HarnessRun) => void,
  workflowId?: string,
  onNodeResult?: (result: WorkflowNodeResult) => void,
): Promise<WorkflowConversationOutput> {
  const plan = planWorkflow(loadWorkflow(workflowId))
  const chain = plan.chain
  const clip = await audioFileToClip(file)
  let audioDataUrl =
    clip.processingAudioUrl ?? clip.transcriptionAudioUrl
  if (!audioDataUrl) {
    throw new Error('音频无法转换为流程需要的 WAV 输入')
  }

  let transcript = ''
  let transcription: AsrTranscriptionResult | null = null
  let currentText = ''
  let reply = ''
  let audio: WorkflowAudioOutput | null = null
  let speechSegments: VadSegment[] = []
  const steps: string[] = []
  const nodeResults: WorkflowNodeResult[] = []
  const recordResult = (
    node: StoredWorkflowNode,
    execution: HarnessExecution<unknown>,
  ) => {
    const result = createNodeResult(plan, node, execution)
    nodeResults.push(result)
    onNodeResult?.(result)
  }

  for (const [index, node] of chain.slice(1).entries()) {
    const capability = node.data.capability
    const providerId = node.data.providerId
    const parameters: Record<string, string | number | boolean> = {
      ...(node.data.parameters ?? {}),
      ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    }
    if (!capability || !providerId) {
      throw new Error(`${node.data.label} 尚未绑定可用模型`)
    }
    steps.push(node.data.label)

    if (capability === 'audio.enhance') {
      const result: HarnessExecution<AudioProcessResult> =
        await executeHarnessTask<AudioProcessResult>(
        {
          capability,
          providerId,
          routing: 'local',
          title: `${clip.name} · 流程降噪`,
          input: { audioDataUrl, clipName: clip.name },
          parameters: {
            ...parameters,
            operations: ['denoise', 'normalize', 'fade'],
            denoiseStrength: Number(parameters.denoiseStrength) || 0.58,
            targetLoudnessDb: -16,
            fadeMs: 20,
          },
        },
        onRunUpdate,
      )
      audioDataUrl = result.output.dataUrl
      audio = result.output
      recordResult(node, result)
      continue
    }

    if (capability === 'speech.detect') {
      const result = await executeHarnessTask<VadDetectionResult>(
        {
          capability,
          providerId,
          routing: 'local',
          title: `${clip.name} · 流程 VAD`,
          input: { audioDataUrl, clipName: clip.name },
          parameters,
        },
        onRunUpdate,
      )
      speechSegments = result.output.segments
      recordResult(node, result)
      const hasDownstreamAsr = chain
        .slice(index + 2)
        .some((item) => item.data.capability === 'speech.transcribe')
      if (!speechSegments.length && hasDownstreamAsr) {
        throw new Error('VAD 没有检测到可识别的语音')
      }
      continue
    }

    if (capability === 'speech.transcribe') {
      const result = await executeHarnessTask<AsrTranscriptionResult>(
        {
          capability,
          providerId,
          routing: 'local',
          title: `${clip.name} · 流程 ASR`,
          input: {
            audioDataUrl,
            clipName: clip.name,
            speechSegments,
          },
          parameters,
        },
        onRunUpdate,
      )
      transcript = result.output.text
      transcription = result.output
      currentText = transcript
      recordResult(node, result)
      continue
    }

    if (capability === 'text.generate') {
      if (!currentText) throw new Error('LLM 节点前没有可用文本')
      const result = await executeWorkflowTextNode(
        providerId,
        parameters,
        currentText,
        `${clip.name} · 流程 LLM`,
        onRunUpdate,
      )
      reply = result.output.text
      currentText = reply
      recordResult(node, result)
      continue
    }

    if (capability === 'speech.synthesize') {
      if (!currentText) throw new Error('TTS 节点前没有可用文本')
      const result = await executeWorkflowTtsNode(
        providerId,
        parameters,
        currentText,
        `${clip.name} · 流程 TTS`,
        onRunUpdate,
      )
      audio = result.output
      audioDataUrl = audio.dataUrl
      recordResult(node, result)
      continue
    }

    const textInput = capability.startsWith('text.')
    if (textInput && !currentText) {
      throw new Error(`${node.data.label} 前没有可用文本`)
    }
    const result: HarnessExecution<Record<string, unknown>> =
      await executeHarnessTask<Record<string, unknown>>(
      {
        capability,
        providerId,
        routing: 'local',
        title: `${clip.name} · ${node.data.label}`,
        input: textInput
          ? { text: currentText }
          : {
              audioDataUrl,
              clipName: clip.name,
              ...(speechSegments.length ? { speechSegments } : {}),
            },
        parameters,
      },
      onRunUpdate,
    )
    const outputText =
      typeof result.output.text === 'string' ? result.output.text : ''
    if (outputText) {
      currentText = outputText
      reply = outputText
    }
    if (typeof result.output.dataUrl === 'string') {
      audioDataUrl = result.output.dataUrl
      audio = result.output as unknown as WorkflowAudioOutput
    }
    recordResult(node, result)
  }

  return { transcript, transcription, reply, audio, steps, nodeResults }
}

export async function continueVoiceWorkflowFromTranscript(
  transcript: string,
  onRunUpdate: (run: HarnessRun) => void,
  workflowId?: string,
  onNodeResult?: (result: WorkflowNodeResult) => void,
): Promise<StreamingWorkflowOutput> {
  const plan = planWorkflow(loadWorkflow(workflowId))
  const chain = plan.chain
  const asrIndex = chain.findIndex(
    (node) => node.data.capability === 'speech.transcribe',
  )
  if (asrIndex < 0) throw new Error('实时流程缺少语音识别节点')

  let currentText = transcript
  let reply = ''
  let audio: WorkflowAudioOutput | null = null
  let ttsStream: CosyVoiceStreamStartResponse | null = null
  const nodeResults: WorkflowNodeResult[] = []
  const recordResult = (
    node: StoredWorkflowNode,
    execution: HarnessExecution<unknown>,
  ) => {
    const result = createNodeResult(plan, node, execution)
    nodeResults.push(result)
    onNodeResult?.(result)
  }
  const steps = chain
    .slice(1, asrIndex + 1)
    .map((node) => node.data.label)

  for (const node of chain.slice(asrIndex + 1)) {
    const capability = node.data.capability
    const providerId = node.data.providerId
    const parameters: Record<string, string | number | boolean> = {
      ...(node.data.parameters ?? {}),
      ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    }
    if (!capability || !providerId) {
      throw new Error(`${node.data.label} 尚未绑定可用模型`)
    }
    steps.push(node.data.label)

    if (capability === 'text.generate') {
      const result = await executeWorkflowTextNode(
        providerId,
        parameters,
        currentText,
        '实时语音对话 · LLM',
        onRunUpdate,
      )
      reply = result.output.text
      currentText = reply
      recordResult(node, result)
      continue
    }

    if (capability === 'speech.synthesize') {
      if (
        node.data.streamingMode === 'streaming' &&
        node.data.adapter === 'bailian-cosyvoice'
      ) {
        ttsStream = await startCosyVoiceStream({
          text: currentText,
          modelId: node.data.modelId,
          voice: String(
            parameters.voice ??
              (node.data.modelId === 'cosyvoice-v2'
                ? 'longxiaochun_v2'
                : ''),
          ),
          speed: Number(parameters.speed ?? 1),
        })
        onRunUpdate(ttsStream.run)
      } else {
        const result = await executeWorkflowTtsNode(
          providerId,
          parameters,
          currentText,
          '实时语音对话 · TTS',
          onRunUpdate,
        )
        audio = result.output
        recordResult(node, result)
      }
      continue
    }

    if (capability.startsWith('text.')) {
      const result: HarnessExecution<Record<string, unknown>> =
        await executeHarnessTask<Record<string, unknown>>(
        {
          capability,
          providerId,
          routing: 'local',
          title: `实时语音对话 · ${node.data.label}`,
          input: { text: currentText },
          parameters,
        },
        onRunUpdate,
      )
      if (typeof result.output.text === 'string') {
        currentText = result.output.text
        reply = result.output.text
      }
      recordResult(node, result)
    }
  }

  return { reply, audio, steps, ttsStream, nodeResults }
}

export async function continueVoiceWorkflowToCaptionOutput(
  transcript: string,
  onRunUpdate: (run: HarnessRun) => void,
  workflowId?: string,
  onNodeResult?: (result: WorkflowNodeResult) => void,
): Promise<StreamingWorkflowOutput> {
  const plan = planWorkflow(loadWorkflow(workflowId))
  const asrIndex = plan.chain.findIndex(
    (node) => node.data.capability === 'speech.transcribe',
  )
  const captionBinding = plan.outputs.find(
    ({ node }) => node.data.parameters?.outputMode === 'captions',
  )
  const captionSourceIndex = captionBinding
    ? plan.chain.findIndex((node) => node.id === captionBinding.sourceId)
    : -1
  if (asrIndex < 0 || captionSourceIndex < asrIndex) {
    throw new Error('字幕输出没有连接到语音识别结果')
  }

  let currentText = transcript
  const nodeResults: WorkflowNodeResult[] = []
  const steps = plan.chain
    .slice(1, asrIndex + 1)
    .map((node) => node.data.label)

  for (const node of plan.chain.slice(asrIndex + 1, captionSourceIndex + 1)) {
    const capability = node.data.capability
    const providerId = node.data.providerId
    const parameters: Record<string, string | number | boolean> = {
      ...(node.data.parameters ?? {}),
      ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    }
    if (!capability?.startsWith('text.') || !providerId) {
      throw new Error(`${node.data.label} 不能生成字幕文本`)
    }
    steps.push(node.data.label)
    const execution =
      capability === 'text.generate'
        ? await executeWorkflowTextNode(
            providerId,
            parameters,
            currentText,
            `实时字幕 · ${node.data.label}`,
            onRunUpdate,
          )
        : await executeHarnessTask<Record<string, unknown>>(
            {
              capability,
              providerId,
              routing: 'local',
              title: `实时字幕 · ${node.data.label}`,
              input: { text: currentText },
              parameters,
            },
            onRunUpdate,
          )
    if (typeof execution.output.text !== 'string') {
      throw new Error(`${node.data.label} 没有返回文本`)
    }
    currentText = execution.output.text
    const result = createNodeResult(plan, node, execution)
    nodeResults.push(result)
    onNodeResult?.(result)
  }

  return {
    reply: currentText,
    audio: null,
    steps,
    ttsStream: null,
    nodeResults,
  }
}