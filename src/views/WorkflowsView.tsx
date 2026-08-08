import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  capabilityDefinition,
  parameterDefaults,
  parameterSchemaForModel,
  workflowParametersForModel,
  type WorkflowNodeKind,
  type WorkflowPortType,
} from '../domain/capabilities'
import {
  Activity,
  BrainCircuit,
  Captions,
  Check,
  FileAudio,
  LoaderCircle,
  MonitorSpeaker,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import {
  DEFAULT_WORKFLOW_TEMPLATES,
  WORKFLOW_STORAGE_KEY,
  saveStoredWorkflow,
  validateStoredWorkflow,
  type SavedWorkflow,
} from '../services/workflowRuntime'
import type {
  HarnessCapabilityId,
  HarnessCatalog,
  ModelPlugin,
  PluginParameterDefinition,
} from '../types'

type NodeKind = 'input' | WorkflowNodeKind | 'output'
type PortType = WorkflowPortType
type StepState = 'idle' | 'running' | 'completed' | 'failed'
type NodeParameter = string | number | boolean

interface WorkflowNodeData extends Record<string, unknown> {
  kind: NodeKind
  label: string
  pluginId?: string
  capability?: HarnessCapabilityId
  providerId?: string
  modelId?: string
  adapter?: string
  streamingMode?: 'streaming' | 'batch'
  inputTypes: PortType[]
  outputType?: PortType
  parameters: Record<string, NodeParameter>
  parameterSchema?: PluginParameterDefinition[]
  state: StepState
  modelName?: string
  local?: boolean
}

type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
type WorkflowEdge = Edge

interface PaletteItem {
  id: string
  kind: NodeKind
  label: string
  description: string
  category: '输入输出' | '音频处理' | '音频理解' | '文本智能' | '音频生成'
  capability?: HarnessCapabilityId
  providerId?: string
  modelId?: string
  adapter?: string
  streamingMode?: 'streaming' | 'batch'
  inputTypes: PortType[]
  outputType?: PortType
  parameters?: Record<string, NodeParameter>
  parameterSchema?: PluginParameterDefinition[]
}

interface WorkflowsViewProps {
  catalog: HarnessCatalog | null
  models: ModelPlugin[]
  workflows: SavedWorkflow[]
  editingWorkflowId: string | null
  onWorkflowsChanged: (
    workflows: SavedWorkflow[],
    selectedWorkflowId: string,
  ) => void
  onAction: (message: string) => void
}

const paletteItems: PaletteItem[] = [
  {
    id: 'audio-input',
    kind: 'input',
    label: '音频输入',
    description: '文件或麦克风',
    category: '输入输出',
    inputTypes: [],
    outputType: 'audio',
  },
  {
    id: 'audio-output',
    kind: 'output',
    label: '播放输出',
    description: '播放与导出音频',
    category: '输入输出',
    inputTypes: ['audio'],
  },
  {
    id: 'caption-output',
    kind: 'output',
    label: '字幕输出',
    description: '悬浮显示实时字幕',
    category: '输入输出',
    inputTypes: ['transcript', 'text'],
    parameters: { outputMode: 'captions' },
  },
  {
    id: 'result-output',
    kind: 'output',
    label: '结果输出',
    description: '在详情中暴露节点结果',
    category: '输入输出',
    inputTypes: [
      'audio',
      'speech-segments',
      'transcript',
      'text',
      'boolean',
      'keyword-events',
      'audio-tags',
      'language',
      'speaker-embedding',
      'speaker-segments',
      'audio-tracks',
    ],
    parameters: { outputMode: 'result' },
  },
  {
    id: 'local-dpdfnet2',
    kind: 'enhance',
    label: 'DPDFNet2',
    description: '降噪与响度处理',
    category: '音频处理',
    capability: 'audio.enhance',
    providerId: 'local.dpdfnet2',
    inputTypes: ['audio'],
    outputType: 'audio',
    parameters: { denoiseStrength: 0.58 },
  },
  {
    id: 'local-silero-vad',
    kind: 'vad',
    label: 'Silero VAD',
    description: '检测语音区间',
    category: '音频处理',
    capability: 'speech.detect',
    providerId: 'local.silero-vad',
    inputTypes: ['audio'],
    outputType: 'speech-segments',
    parameters: {
      threshold: 0.25,
      minSpeechDuration: 0.18,
      minSilenceDuration: 0.2,
    },
  },
  {
    id: 'local-sensevoice',
    kind: 'asr',
    label: 'SenseVoice Small GGUF',
    description: '语音转写与时间戳',
    category: '音频理解',
    capability: 'speech.transcribe',
    providerId: 'plugin.funaudiollm.sensevoice-small-gguf',
    inputTypes: ['audio', 'speech-segments'],
    outputType: 'transcript',
  },
  {
    id: 'compatible-llm-placeholder',
    kind: 'llm',
    label: '文本 LLM',
    description: '理解并生成回复',
    category: '文本智能',
    capability: 'text.generate',
    providerId: 'api.openai-compatible',
    inputTypes: ['transcript', 'text'],
    outputType: 'text',
    parameters: {
      temperature: 0.7,
      maxTokens: 320,
      systemPrompt:
        '你是一个简洁自然的语音助手。直接回答问题，回复适合朗读，不使用 Markdown。',
    },
  },
  {
    id: 'local-kokoro',
    kind: 'tts',
    label: 'Kokoro TTS',
    description: '文字生成语音',
    category: '音频生成',
    capability: 'speech.synthesize',
    providerId: 'local.kokoro',
    inputTypes: ['text', 'transcript'],
    outputType: 'audio',
    parameters: { sid: 3, speed: 0.96, silenceScale: 0.2 },
  },
]

function paletteItemFromModel(model: ModelPlugin): PaletteItem | null {
  const capability = model.harnessCapabilities[0]
  if (!capability || capability === 'audio.live') return null
  const definition = capabilityDefinition(capability)
  const parameterSchema = parameterSchemaForModel(capability, model)
  const shared = {
    id: model.id,
    label: model.name,
    description: model.capabilities.slice(0, 3).join(' · '),
    capability,
    providerId: model.providerId,
    modelId: model.selectedVariantId ?? model.version,
    adapter: model.adapter,
    streamingMode: model.streamingMode,
  }
  return {
    ...shared,
    kind: definition.nodeKind,
    category: definition.category,
    inputTypes:
      model.inputs?.length
        ? model.inputs.map((port) => port.type)
        : definition.inputTypes,
    outputType: model.outputs?.[0]?.type ?? definition.outputType,
    parameterSchema,
    parameters: {
      ...workflowParametersForModel(capability, model),
      ...parameterDefaults(parameterSchema),
    },
  }
}

const defaultPositions: Record<NodeKind, { x: number; y: number }> = {
  input: { x: 20, y: 90 },
  enhance: { x: 250, y: 270 },
  vad: { x: 250, y: 90 },
  asr: { x: 480, y: 90 },
  llm: { x: 20, y: 290 },
  tts: { x: 250, y: 290 },
  output: { x: 480, y: 290 },
}

function nodeFromPalette(
  item: PaletteItem,
  id: string,
  position = defaultPositions[item.kind],
): WorkflowNode {
  return {
    id,
    type: 'workflow',
    position,
    data: {
      kind: item.kind,
      label: item.label,
      pluginId: item.id,
      capability: item.capability,
      providerId: item.providerId,
      modelId: item.modelId,
      adapter: item.adapter,
      streamingMode: item.streamingMode,
      inputTypes: item.inputTypes,
      outputType: item.outputType,
      parameters: { ...(item.parameters ?? {}) },
      parameterSchema: item.parameterSchema,
      state: 'idle',
    },
  }
}

function defaultWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const template = DEFAULT_WORKFLOW_TEMPLATES[0]
  const nodes = template.nodes.map((node) => {
    const kind = node.data.kind as NodeKind
    const definition = node.data.capability
      ? capabilityDefinition(node.data.capability)
      : null
    return {
      id: node.id,
      type: 'workflow',
      position: node.position ?? defaultPositions[kind],
      data: {
        ...node.data,
        kind,
        inputTypes: node.data.inputTypes ?? definition?.inputTypes ?? [],
        outputType: node.data.outputType ?? definition?.outputType,
        parameters: { ...(node.data.parameters ?? {}) },
        state: 'idle',
      },
    } satisfies WorkflowNode
  })
  const edges = template.edges.map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
  return { nodes, edges }
}

function loadWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  try {
    const saved = window.localStorage.getItem(WORKFLOW_STORAGE_KEY)
    if (!saved) return defaultWorkflow()
    const parsed = JSON.parse(saved) as {
      nodes?: WorkflowNode[]
      edges?: WorkflowEdge[]
    }
    if (!parsed.nodes?.length || !Array.isArray(parsed.edges)) {
      return defaultWorkflow()
    }
    return {
      nodes: parsed.nodes.map((node) => ({
        ...node,
        data: { ...node.data, state: 'idle' },
      })),
      edges: parsed.edges,
    }
  } catch {
    return defaultWorkflow()
  }
}

function iconForKind(
  kind: NodeKind,
  parameters?: Record<string, NodeParameter>,
) {
  if (kind === 'input') return FileAudio
  if (kind === 'output') {
    return parameters?.outputMode === 'captions' ? Captions : MonitorSpeaker
  }
  if (kind === 'enhance') return Sparkles
  if (kind === 'vad') return Activity
  if (kind === 'asr') return Captions
  if (kind === 'llm') return BrainCircuit
  return WandSparkles
}

function VisualNode({ id, data, selected }: NodeProps<WorkflowNode>) {
  const Icon = iconForKind(data.kind, data.parameters)
  const structuralNode = data.kind === 'input' || data.kind === 'output'
  const showStatusIcon =
    structuralNode ||
    data.state === 'running' ||
    data.state === 'completed' ||
    data.state === 'failed'
  const { deleteElements } = useReactFlow<WorkflowNode, WorkflowEdge>()
  const status =
    data.state === 'running'
      ? '运行中'
      : data.state === 'completed'
        ? '完成'
      : data.state === 'failed'
          ? '失败'
          : data.capability
            ? '待运行'
            : '就绪'

  return (
    <article
      className={`visual-flow-node node-${data.kind} state-${data.state}${selected ? ' selected' : ''}`}
    >
      {data.inputTypes.length > 0 && (
        <Handle
          id="input"
          type="target"
          position={Position.Left}
          className="visual-port visual-port-input"
        />
      )}
      <header className={showStatusIcon ? 'with-status-icon' : undefined}>
        {showStatusIcon && (
          <span>
            {data.state === 'running' ? (
              <LoaderCircle className="model-spin" size={17} />
            ) : data.state === 'completed' ? (
              <Check size={17} />
            ) : data.state === 'failed' ? (
              <X size={17} />
            ) : (
              <Icon size={17} />
            )}
          </span>
        )}
        <div>
          <small>{data.capability ?? 'audio.device'}</small>
          <strong>{data.label}</strong>
        </div>
        <button
          className="visual-node-delete"
          type="button"
          title="删除节点"
          aria-label={`删除 ${data.label}`}
          onClick={(event) => {
            event.stopPropagation()
            void deleteElements({ nodes: [{ id }] })
          }}
        >
          <Trash2 size={12} />
        </button>
      </header>
      <footer>
        <span>
          {data.modelName ??
            (data.kind === 'input'
              ? '文件 / 麦克风'
              : data.parameters.outputMode === 'captions'
                ? '悬浮字幕窗口'
                : data.parameters.outputMode === 'result'
                  ? '流程结果'
                : '音频设备')}
        </span>
        <b>{status}</b>
      </footer>
      {data.outputType && (
        <Handle
          id="output"
          type="source"
          position={Position.Right}
          className="visual-port visual-port-output"
        />
      )}
    </article>
  )
}

const nodeTypes = { workflow: VisualNode }

function compatible(source: WorkflowNode, target: WorkflowNode): boolean {
  const output = source.data.outputType
  return Boolean(output && target.data.inputTypes.includes(output))
}

function createsCycle(
  sourceId: string,
  targetId: string,
  edges: WorkflowEdge[],
): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ])
  }
  adjacency.set(sourceId, [...(adjacency.get(sourceId) ?? []), targetId])
  const stack = [targetId]
  const visited = new Set<string>()
  while (stack.length) {
    const current = stack.pop()
    if (!current) continue
    if (current === sourceId) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(adjacency.get(current) ?? []))
  }
  return false
}

function WorkflowEditor({
  catalog,
  models,
  workflows,
  editingWorkflowId,
  onWorkflowsChanged,
  onAction,
}: WorkflowsViewProps) {
  const availablePaletteItems = useMemo(
    () => [
      ...paletteItems.filter(
        (item) =>
          (item.kind === 'input' ||
            item.kind === 'output' ||
            !models.some(
              (model) =>
                model.providerId === item.providerId &&
                model.harnessCapabilities.includes(
                  item.capability ?? 'audio.live',
                ),
            )) &&
          (item.id !== 'compatible-llm-placeholder' ||
            !models.some((model) =>
              model.harnessCapabilities.includes('text.generate'),
            )),
      ),
      ...models
        .map(paletteItemFromModel)
        .filter((item): item is PaletteItem => item !== null),
    ],
    [models],
  )
  const editingWorkflow = workflows.find(
    (workflow) => workflow.id === editingWorkflowId,
  )
  const initial = useMemo(
    () =>
      editingWorkflow
        ? {
            nodes: editingWorkflow.nodes as WorkflowNode[],
            edges: editingWorkflow.edges as WorkflowEdge[],
          }
        : loadWorkflow(),
    [editingWorkflow],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(
    initial.nodes,
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowEdge>(
    initial.edges,
  )
  const [workflowName, setWorkflowName] = useState(
    editingWorkflow?.name ?? '',
  )
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{
    item: PaletteItem
    x: number
    y: number
  } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const suppressPaletteClickRef = useRef(false)
  const { screenToFlowPosition, fitView, deleteElements } =
    useReactFlow<WorkflowNode, WorkflowEdge>()

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const provider = catalog?.providers.find(
          (item) => item.id === node.data.providerId,
        )
        const model = node.data.modelId
          ? provider?.models.find((item) => item.id === node.data.modelId)
          : node.data.kind === 'llm'
            ? provider?.models.at(-1)
            : provider?.models[0]
        return {
          ...node,
          data: {
            ...node.data,
            modelName: model?.name ?? node.data.modelName,
            local: provider?.local,
          },
        }
      }),
    [catalog, nodes],
  )
  const selectedNode = displayNodes.find(
    (node) => node.id === selectedNodeId,
  )
  const saveWorkflow = () => {
    const name = workflowName.trim()
    if (!name) {
      onAction('请先填写流程名称')
      return
    }
    if (!nodes.some((node) => node.data.kind === 'input')) {
      onAction('流程需要一个输入节点')
      return
    }
    if (!nodes.some((node) => node.data.kind === 'output')) {
      onAction('流程需要一个输出节点')
      return
    }
    const validationError = validateStoredWorkflow({ nodes, edges })
    if (validationError) {
      onAction(validationError)
      return
    }
    const id = editingWorkflow?.id ?? `workflow-${crypto.randomUUID()}`
    const next = saveStoredWorkflow({
      id,
      name,
      nodes: nodes.map((node) => ({
        ...node,
        data: { ...node.data, state: 'idle' },
        selected: false,
      })),
      edges,
    })
    onWorkflowsChanged(next, id)
    onAction(editingWorkflow ? `${name} 已更新` : `${name} 已保存并添加到左栏`)
  }

  const resetTemplate = () => {
    const next = defaultWorkflow()
    setNodes(next.nodes)
    setEdges(next.edges)
    setSelectedNodeId(null)
    window.setTimeout(() => void fitView({ padding: 0.16 }), 0)
    onAction('已恢复语音对话模板')
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((node) => node.id === connection.source)
      const target = nodes.find((node) => node.id === connection.target)
      if (!source || !target) return
      if (!compatible(source, target)) {
        onAction(
          `无法连接：${source.data.outputType ?? '无输出'} 不能输入到 ${target.data.label}`,
        )
        return
      }
      const targetIsOutput = target.data.kind === 'output'
      const remaining = edges.filter((edge) => {
        if (edge.target === connection.target) return false
        if (targetIsOutput || edge.source !== connection.source) return true
        const existingTarget = nodes.find(
          (node) => node.id === edge.target,
        )
        return existingTarget?.data.kind === 'output'
      })
      if (createsCycle(connection.source, connection.target, remaining)) {
        onAction('流程不能形成循环')
        return
      }
      setEdges(
        addEdge(
          {
            ...connection,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          remaining,
        ),
      )
    },
    [edges, nodes, onAction, setEdges],
  )

  const addPaletteItem = useCallback(
    (item: PaletteItem, position?: { x: number; y: number }) => {
      const sameKindCount = nodes.filter(
        (node) => node.data.kind === item.kind,
      ).length
      const nextPosition =
        position ??
        {
          x:
            defaultPositions[item.kind].x +
            Math.floor(sameKindCount / 3) * 240,
          y:
            defaultPositions[item.kind].y +
            (sameKindCount % 3) * 120,
        }
      const id = `${item.kind}-${crypto.randomUUID().slice(0, 8)}`
      setNodes((current) => [
        ...current,
        nodeFromPalette(item, id, nextPosition),
      ])
      setSelectedNodeId(id)
      onAction(`${item.label} 已添加到画布`)
    },
    [nodes, onAction, setNodes],
  )

  const beginPaletteDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, item: PaletteItem) => {
      if (event.button !== 0) return

      event.preventDefault()
      window.getSelection()?.removeAllRanges()
      dragCleanupRef.current?.()
      const startX = event.clientX
      const startY = event.clientY
      let moved = false

      const cleanup = () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        dragCleanupRef.current = null
        setDragPreview(null)
      }
      const onMouseMove = (moveEvent: MouseEvent) => {
        if (
          !moved &&
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >
            5
        ) {
          moved = true
        }
        if (!moved) return
        moveEvent.preventDefault()
        window.getSelection()?.removeAllRanges()
        setDragPreview({
          item,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        })
      }
      const onMouseUp = (upEvent: MouseEvent) => {
        cleanup()
        if (!moved) return

        suppressPaletteClickRef.current = true
        window.setTimeout(() => {
          suppressPaletteClickRef.current = false
        }, 0)
        const canvas = canvasRef.current?.getBoundingClientRect()
        if (
          !canvas ||
          upEvent.clientX < canvas.left ||
          upEvent.clientX > canvas.right ||
          upEvent.clientY < canvas.top ||
          upEvent.clientY > canvas.bottom
        ) {
          return
        }
        addPaletteItem(
          item,
          screenToFlowPosition({
            x: upEvent.clientX,
            y: upEvent.clientY,
          }),
        )
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      dragCleanupRef.current = cleanup
    },
    [addPaletteItem, screenToFlowPosition],
  )

  useEffect(
    () => () => {
      dragCleanupRef.current?.()
    },
    [],
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const paletteId =
        event.dataTransfer.getData('application/cosy-node') ||
        event.dataTransfer.getData('text/plain')
      const item = availablePaletteItems.find(
        (candidate) => candidate.id === paletteId,
      )
      if (!item) return
      addPaletteItem(
        item,
        screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
      )
    },
    [addPaletteItem, availablePaletteItems, screenToFlowPosition],
  )

  const updateParameter = (key: string, value: NodeParameter) => {
    if (!selectedNodeId) return
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? {
              ...node,
              data: {
                ...node.data,
                parameters: { ...node.data.parameters, [key]: value },
              },
            }
          : node,
      ),
    )
  }

  const updateSelectedNodeLabel = (label: string) => {
    if (!selectedNodeId) return
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? { ...node, data: { ...node.data, label } }
          : node,
      ),
    )
  }

  const replaceSelectedModel = (item: PaletteItem) => {
    if (!selectedNodeId || !item.capability) return
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedNodeId) return node
        const parameterNames = new Set(
          item.parameterSchema?.map((parameter) => parameter.name) ?? [],
        )
        const retainedParameters = Object.fromEntries(
          Object.entries(node.data.parameters).filter(([key]) =>
            parameterNames.has(key),
          ),
        )
        return {
          ...node,
          data: {
            ...node.data,
            kind: item.kind,
            label: item.label,
            pluginId: item.id,
            capability: item.capability,
            providerId: item.providerId,
            modelId: item.modelId,
            adapter: item.adapter,
            streamingMode: item.streamingMode,
            inputTypes: item.inputTypes,
            outputType: item.outputType,
            parameters: {
              ...(item.parameters ?? {}),
              ...retainedParameters,
            },
            parameterSchema: item.parameterSchema,
            state: 'idle',
            modelName: undefined,
            local: undefined,
          },
        }
      }),
    )
    onAction(`已替换为 ${item.label}`)
  }

  const renderInspector = () => {
    if (!selectedNode) {
      return (
        <div className="visual-inspector-empty">
          <Settings2 size={19} />
          <strong>选择一个节点</strong>
          <p>查看节点状态并调整本次流程的运行参数。</p>
        </div>
      )
    }
    const parameters = selectedNode.data.parameters
    const modelOptions = selectedNode.data.capability
      ? availablePaletteItems.filter(
          (item) =>
            item.capability === selectedNode.data.capability &&
            item.kind === selectedNode.data.kind,
        )
      : []
    const selectedModelOption = modelOptions.find(
      (item) =>
        item.id === selectedNode.data.pluginId ||
        (item.providerId === selectedNode.data.providerId &&
          item.modelId === selectedNode.data.modelId) ||
        (item.providerId === selectedNode.data.providerId &&
          item.adapter === selectedNode.data.adapter),
    )
    const parameterSchema = selectedNode.data.capability
      ? selectedNode.data.parameterSchema ??
        parameterSchemaForModel(selectedNode.data.capability, {
          adapter: selectedNode.data.adapter ?? '',
        })
      : []
    return (
      <>
        <div className="visual-inspector-heading">
          {(selectedNode.data.kind === 'input' ||
            selectedNode.data.kind === 'output') && (
            <span
              className={`visual-palette-icon node-${selectedNode.data.kind}`}
            >
              {(() => {
                const Icon = iconForKind(
                  selectedNode.data.kind,
                  selectedNode.data.parameters,
                )
                return <Icon size={16} />
              })()}
            </span>
          )}
          <div>
            <small>{selectedNode.data.capability ?? 'audio.device'}</small>
            <strong>{selectedNode.data.label}</strong>
          </div>
        </div>
        {selectedNode.data.capability && (
          <div className="visual-node-runtime">
            <span>执行模型</span>
            <select
              aria-label="执行模型"
              value={selectedModelOption?.id ?? ''}
              onChange={(event) => {
                const item = modelOptions.find(
                  (candidate) => candidate.id === event.target.value,
                )
                if (item) replaceSelectedModel(item)
              }}
            >
              {!selectedModelOption && (
                <option value="">
                  {selectedNode.data.modelName ?? selectedNode.data.label}
                </option>
              )}
              {modelOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.streamingMode === 'streaming' ? ' · 流式' : ''}
                </option>
              ))}
            </select>
            <small
              className="ready"
            >
              {(selectedNode.data.local ??
              !selectedNode.data.providerId?.startsWith('api.'))
                ? '本地模型'
                : '云端模型'}
            </small>
          </div>
        )}
        {selectedNode.data.kind === 'output' && (
          <label className="visual-field">
            <span>输出名称</span>
            <input
              type="text"
              maxLength={24}
              value={selectedNode.data.label}
              onChange={(event) =>
                updateSelectedNodeLabel(event.target.value)
              }
            />
          </label>
        )}
        {parameterSchema.map((parameter) => {
          const value =
            parameters[parameter.name] ?? parameter.default ?? ''
          if (parameter.type === 'boolean') {
            return (
              <label className="visual-check-field" key={parameter.name}>
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) =>
                    updateParameter(parameter.name, event.target.checked)
                  }
                />
                <span>{parameter.label}</span>
              </label>
            )
          }
          if (parameter.type === 'enum') {
            return (
              <label className="visual-field" key={parameter.name}>
                <span>{parameter.label}</span>
                <select
                  value={String(value)}
                  onChange={(event) =>
                    updateParameter(parameter.name, event.target.value)
                  }
                >
                  {parameter.options?.map((option) => (
                    <option
                      key={String(option.value)}
                      value={String(option.value)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )
          }
          if (parameter.type === 'number') {
            return (
              <label className="visual-field" key={parameter.name}>
                <span>
                  {parameter.label}
                  <b>{Number(value)}</b>
                </span>
                <input
                  type="range"
                  min={parameter.min}
                  max={parameter.max}
                  step={parameter.step}
                  value={Number(value)}
                  onChange={(event) =>
                    updateParameter(
                      parameter.name,
                      Number(event.target.value),
                    )
                  }
                />
              </label>
            )
          }
          return (
            <label className="visual-field" key={parameter.name}>
              <span>{parameter.label}</span>
              {parameter.multiline ? (
                <textarea
                  rows={parameter.name === 'systemPrompt' ? 5 : 3}
                  value={String(value)}
                  onChange={(event) =>
                    updateParameter(parameter.name, event.target.value)
                  }
                />
              ) : (
                <input
                  type="text"
                  value={String(value)}
                  onChange={(event) =>
                    updateParameter(parameter.name, event.target.value)
                  }
                />
              )}
            </label>
          )
        })}
        <div className="visual-node-contract">
          <span>
            输入
            <b>{selectedNode.data.inputTypes.join(' / ') || '无'}</b>
          </span>
          <span>
            输出
            <b>{selectedNode.data.outputType ?? '无'}</b>
          </span>
        </div>
        <button
          className="secondary-action full-width visual-delete-action"
          type="button"
          onClick={() => {
            void deleteElements({ nodes: [{ id: selectedNode.id }] })
            setSelectedNodeId(null)
          }}
        >
          <Trash2 size={14} />
          删除节点
        </button>
      </>
    )
  }

  return (
    <main className="workflow-workspace visual-workflow-workspace">
      <section className="visual-editor">
        <aside className="visual-palette">
          <header>
            <strong>节点</strong>
            <span>拖动或点击</span>
          </header>
          {(
            [
              '输入输出',
              '音频处理',
              '音频理解',
              '文本智能',
              '音频生成',
            ] as const
          ).map((category) => (
            <div className="visual-palette-group" key={category}>
              <span>{category}</span>
              {availablePaletteItems
                .filter((item) => item.category === category)
                .map((item) => {
                  const Icon = iconForKind(item.kind, item.parameters)
                  return (
                    <div
                      className={`visual-palette-item${item.kind === 'input' || item.kind === 'output' ? '' : ' no-icon'}`}
                      role="button"
                      tabIndex={0}
                      key={item.id}
                      title={`将 ${item.label} 添加到画布`}
                      onMouseDown={(event) => beginPaletteDrag(event, item)}
                      onClick={() => {
                        if (suppressPaletteClickRef.current) return
                        addPaletteItem(item)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        addPaletteItem(item)
                      }}
                    >
                      {(item.kind === 'input' || item.kind === 'output') && (
                        <span
                          className={`visual-palette-icon node-${item.kind}`}
                        >
                          <Icon size={15} />
                        </span>
                      )}
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                    </div>
                  )
                })}
            </div>
          ))}
        </aside>

        <div
          ref={canvasRef}
          className="visual-canvas"
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDrop={onDrop}
        >
          <ReactFlow<WorkflowNode, WorkflowEdge>
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.35}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Panel position="top-right" className="visual-canvas-actions">
              <label className="workflow-save-name">
                <input
                  value={workflowName}
                  maxLength={40}
                  placeholder="流程名称"
                  onChange={(event) => setWorkflowName(event.target.value)}
                />
              </label>
              <button
                className="primary-action"
                type="button"
                onClick={saveWorkflow}
              >
                <Save size={13} />
                {editingWorkflow ? '更新流程' : '保存流程'}
              </button>
              <button
                className="secondary-action"
                type="button"
                title="恢复默认流程模板"
                onClick={resetTemplate}
              >
                <RotateCcw size={13} />
                恢复模板
              </button>
            </Panel>
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="#d7d7df"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="visual-inspector">
          <header>
            <strong>节点设置</strong>
            <span>PARAMETERS</span>
          </header>
          <div>{renderInspector()}</div>
        </aside>
      </section>

      {dragPreview && (
        <div
          className="visual-drag-preview"
          style={{ left: dragPreview.x + 12, top: dragPreview.y + 12 }}
        >
          {dragPreview.item.label}
        </div>
      )}
    </main>
  )
}

export function WorkflowsView(props: WorkflowsViewProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditor {...props} />
    </ReactFlowProvider>
  )
}