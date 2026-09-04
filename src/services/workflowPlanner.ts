interface WorkflowPlanNode {
  id: string
  data: {
    kind: string
    label: string
    capability?: string
    providerId?: string
    adapter?: string
    streamingMode?: 'streaming' | 'batch'
    inputTypes?: string[]
    outputType?: string
  }
}

interface WorkflowPlanEdge {
  id?: string
  source: string
  target: string
}

interface WorkflowOutputBinding<Node extends WorkflowPlanNode> {
  node: Node
  sourceId: string
}

export interface WorkflowPlan<Node extends WorkflowPlanNode> {
  chain: Node[]
  outputs: WorkflowOutputBinding<Node>[]
}

function assertUniqueIds<Node extends WorkflowPlanNode>(
  nodes: Node[],
  edges: WorkflowPlanEdge[],
) {
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`流程包含重复节点：${node.id}`)
    nodeIds.add(node.id)
  }

  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (!edge.id) continue
    if (edgeIds.has(edge.id)) throw new Error(`流程包含重复连接：${edge.id}`)
    edgeIds.add(edge.id)
  }
}

function validateStreamingTopology<Node extends WorkflowPlanNode>(
  chain: Node[],
) {
  const asrIndex = chain.findIndex(
    (node) =>
      node.data.capability === 'speech.transcribe' &&
      (node.data.streamingMode === 'streaming' ||
        [
          'bailian-funasr',
          'streaming-zipformer',
          'streaming-paraformer',
        ].includes(node.data.adapter ?? '')),
  )
  if (asrIndex < 0) return

  for (const node of chain.slice(1, asrIndex)) {
    if (!['audio.enhance', 'speech.detect'].includes(node.data.capability ?? '')) {
      throw new Error(`${node.data.label} 不能放在实时语音识别之前`)
    }
    if (node.data.streamingMode !== 'streaming') {
      throw new Error(`${node.data.label} 不支持实时处理，不能接入实时语音识别`)
    }
    if (
      node.data.capability === 'speech.detect' &&
      node.data.adapter !== 'silero-vad'
    ) {
      throw new Error(`${node.data.label} 尚未提供实时 VAD 适配器`)
    }
  }

  const downstreamAudioNode = chain
    .slice(asrIndex + 1)
    .find(
      (node) =>
        ![
          'text.normalize',
          'text.punctuate',
          'text.generate',
          'speech.synthesize',
        ].includes(node.data.capability ?? ''),
    )
  if (downstreamAudioNode) {
    throw new Error(
      `${downstreamAudioNode.data.label} 不能接在实时语音识别的文本结果之后`,
    )
  }

  const ttsIndex = chain.findIndex(
    (node, index) =>
      index > asrIndex && node.data.capability === 'speech.synthesize',
  )
  if (ttsIndex >= 0 && ttsIndex !== chain.length - 1) {
    throw new Error('实时语音合成必须是处理主链的最后一个模型')
  }
}

export function planWorkflow<Node extends WorkflowPlanNode>(
  workflow: { nodes: Node[]; edges: WorkflowPlanEdge[] },
): WorkflowPlan<Node> {
  assertUniqueIds(workflow.nodes, workflow.edges)

  const inputNodes = workflow.nodes.filter(
    (node) => node.data.kind === 'input',
  )
  if (inputNodes.length !== 1) {
    throw new Error(
      inputNodes.length ? '流程只能有一个音频输入节点' : '流程缺少音频输入节点',
    )
  }
  const input = inputNodes[0]
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, WorkflowPlanEdge[]>()
  const outgoing = new Map<string, WorkflowPlanEdge[]>()

  for (const edge of workflow.edges) {
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) throw new Error('流程包含失效连接')
    if (source.id === target.id) throw new Error('流程不能连接节点自身')
    const outputType = source.data.outputType
    const inputTypes = target.data.inputTypes ?? []
    if (!outputType || !inputTypes.includes(outputType)) {
      throw new Error(
        `${source.data.label} 的 ${outputType ?? '空结果'} 不能输入到 ${target.data.label}`,
      )
    }
    incoming.set(target.id, [...(incoming.get(target.id) ?? []), edge])
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), edge])
  }

  for (const node of workflow.nodes) {
    if (!node.data.label.trim()) throw new Error('节点名称不能为空')
    const nodeIncoming = incoming.get(node.id) ?? []
    const nodeOutgoing = outgoing.get(node.id) ?? []
    if (node.data.kind === 'input') {
      if (nodeIncoming.length) throw new Error('音频输入节点不能有输入连接')
      continue
    }
    if (node.data.kind === 'output') {
      if (nodeOutgoing.length) throw new Error('输出节点不能继续连接其他节点')
      if (nodeIncoming.length !== 1) {
        throw new Error(`${node.data.label} 需要且只能连接一个结果`)
      }
      if (nodeIncoming[0].source === input.id) {
        throw new Error(`${node.data.label} 需要连接模型结果`)
      }
      continue
    }
    if (!node.data.capability || !node.data.providerId) {
      throw new Error(`${node.data.label} 尚未绑定可用模型`)
    }
    if (nodeIncoming.length !== 1) {
      throw new Error(`${node.data.label} 需要且只能连接一个上游节点`)
    }
  }

  const chain = [input]
  const visited = new Set([input.id])
  let current = input
  while (true) {
    const processingTargets = (outgoing.get(current.id) ?? [])
      .map((edge) => nodesById.get(edge.target))
      .filter(
        (node): node is Node =>
          Boolean(node && node.data.kind !== 'output'),
      )
    if (processingTargets.length > 1) {
      throw new Error(`${current.data.label} 只能连接一个后续处理节点`)
    }
    const next = processingTargets[0]
    if (!next) break
    if (visited.has(next.id)) throw new Error('流程不能包含循环')
    visited.add(next.id)
    chain.push(next)
    current = next
  }

  const disconnectedProcessors = workflow.nodes.filter(
    (node) => node.data.kind !== 'output' && !visited.has(node.id),
  )
  if (disconnectedProcessors.length) {
    throw new Error(
      `流程包含未连接节点：${disconnectedProcessors
        .map((node) => node.data.label)
        .join('、')}`,
    )
  }
  if (chain.length === 1) throw new Error('流程至少需要一个模型节点')

  const outputs = workflow.nodes
    .filter((node) => node.data.kind === 'output')
    .map((node) => ({
      node,
      sourceId: (incoming.get(node.id) ?? [])[0]?.source ?? '',
    }))
  if (!outputs.length) throw new Error('流程至少需要一个输出节点')
  const disconnectedOutputs = outputs.filter(
    (binding) => !visited.has(binding.sourceId),
  )
  if (disconnectedOutputs.length) {
    throw new Error(
      `流程包含未连接输出：${disconnectedOutputs
        .map((binding) => binding.node.data.label)
        .join('、')}`,
    )
  }
  if (!outputs.some((binding) => binding.sourceId === chain.at(-1)?.id)) {
    throw new Error('处理主链的最后一个节点需要连接输出')
  }

  validateStreamingTopology(chain)
  return { chain, outputs }
}
