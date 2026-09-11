import type { ModelPlugin, WorkspaceAgentEntry } from './types'

export const INSTALLED_APP_AGENTS_STORAGE_KEY =
  'qwen-audio-toolkits.installed-app-agents-v2'

const APP_AGENT_DEFINITIONS = [
  {
    id: 'qwenaudio.smart-cut',
    name: '视频剪辑',
    author: 'QwenAudio',
    description:
      '识别视频语音，检测静音、口水词和手动选词，生成可预览、可复核并带字幕的剪辑结果。',
    license: 'Apache-2.0',
    capabilities: ['视频剪辑', '语音识别', '静音检测', '内嵌字幕'],
    harnessCapabilities: [],
    runtime: 'QwenAudio Toolkits',
    acceleration: ['CPU', 'Apple Silicon'],
    version: '1.1.0',
    size: '内置',
    enabled: true,
    sidebarVisible: true,
    builtin: true,
    featured: true,
    tone: 'green',
    adapter: 'smart-cut',
    installPath: '',
    catalogManaged: true,
    installable: true,
    extensionKind: 'workspace-agent',
    workspaceEntry: 'smart-cut',
    agent: {
      task: '从视频语音和画面信息生成可人工复核的视频剪辑方案，并导出视频与字幕。',
      usage: {
        inputRequirements: [
          '输入包含音轨的视频文件。',
          '至少安装一个支持词级时间戳的批量语音识别模型。',
        ],
        limitations: [
          '自动删除结果需要人工复核，背景音乐和多人重叠说话会影响识别与停顿检测。',
          '没有词级时间戳的识别模型不会出现在视频剪辑模型列表中。',
        ],
        examples: [
          '删除口水词和长静音后导出带字幕的视频。',
          '逐词选择需要删除的内容并试听切口。',
        ],
      },
      harness: {
        kind: 'app-workflow',
        entry: 'smart-cut',
      },
    },
    inputs: [
      { name: 'video', label: '视频', type: 'video', modes: ['batch'] },
      { name: 'instruction', label: '剪辑指令', type: 'text', modes: ['batch'] },
    ],
    outputs: [
      { name: 'video', label: '剪辑视频', type: 'video', modes: ['batch'] },
      { name: 'subtitles', label: '字幕', type: 'transcript', modes: ['batch'] },
    ],
  },
  {
    id: 'qwenaudio.ai-podcast',
    name: 'AI 播客',
    author: 'QwenAudio',
    description:
      '把论文或文档整理成可编辑的双人对话，并用两种音色合成为完整播客。',
    license: 'Apache-2.0',
    capabilities: ['文档解析', '双人脚本', '语音合成', '音频导出'],
    harnessCapabilities: [],
    runtime: 'QwenAudio Toolkits',
    acceleration: ['CPU', 'Apple Silicon', '云端 API'],
    version: '1.0.0',
    size: '内置',
    enabled: true,
    sidebarVisible: true,
    builtin: true,
    featured: true,
    tone: 'violet',
    adapter: 'ai-podcast',
    installPath: '',
    catalogManaged: true,
    installable: true,
    extensionKind: 'workspace-agent',
    workspaceEntry: 'ai-podcast',
    agent: {
      task: '从论文或文档中提炼事实，生成可人工复核的双人播客脚本，并合成为音频。',
      usage: {
        inputRequirements: [
          '输入 PDF、DOCX、TXT 或 Markdown 文档。',
          '至少配置一个文本生成模型和一个无需参考音频的语音合成模型。',
        ],
        limitations: [
          '扫描版 PDF 暂不支持 OCR，需要先转换为可选择文本的 PDF。',
          '生成脚本可能遗漏或误述原文信息，请在语音合成前复核。',
        ],
        examples: [
          '把一篇论文做成五分钟的中文双人解读播客。',
          '用主持人与专家访谈的方式解释技术报告。',
        ],
      },
      harness: {
        kind: 'app-workflow',
        entry: 'ai-podcast',
      },
    },
    inputs: [
      { name: 'document', label: '论文或文档', type: 'text', modes: ['batch'] },
      { name: 'instruction', label: '创作要求', type: 'text', modes: ['batch'], optional: true },
    ],
    outputs: [
      { name: 'script', label: '双人播客脚本', type: 'text', modes: ['batch'] },
      { name: 'audio', label: '播客音频', type: 'audio', modes: ['batch'] },
    ],
  },
  {
    id: 'qwenaudio.video-dubbing',
    name: '视频配音',
    author: 'QwenAudio',
    description:
      '翻译、改写或替换口播，并自动克隆音色、对齐节奏。',
    license: 'Apache-2.0',
    capabilities: ['视频配音', '语音识别', '文本翻译', '语音合成', '字幕生成'],
    harnessCapabilities: [],
    runtime: 'QwenAudio Toolkits',
    acceleration: ['CPU', 'Apple Silicon', '云端 API'],
    version: '1.0.0',
    size: '内置',
    enabled: true,
    sidebarVisible: true,
    builtin: true,
    featured: true,
    tone: 'blue',
    adapter: 'video-dubbing',
    installPath: '',
    catalogManaged: true,
    installable: true,
    extensionKind: 'workspace-agent',
    workspaceEntry: 'video-dubbing',
    agent: {
      task: '把视频对白翻译、改写或替换为新文案，生成可复核的配音、字幕和节奏对齐结果。',
      usage: {
        inputRequirements: [
          '输入包含音轨的视频文件。',
          '至少配置一个文本生成模型，并准备可用的语音识别和语音合成能力。',
        ],
        limitations: [
          '多人重叠说话、背景噪声和音乐会影响转写与配音节奏。',
          '配音和字幕结果需要人工复核后再用于正式发布。',
        ],
        examples: [
          '把英文产品演示视频翻译成自然中文配音。',
          '用新文案替换原视频口播，并保留画面节奏。',
        ],
      },
      harness: {
        kind: 'app-workflow',
        entry: 'video-dubbing',
      },
    },
    inputs: [
      { name: 'video', label: '视频', type: 'video', modes: ['batch'] },
      { name: 'instruction', label: '配音要求', type: 'text', modes: ['batch'], optional: true },
    ],
    outputs: [
      { name: 'video', label: '配音视频', type: 'video', modes: ['batch'] },
      { name: 'subtitles', label: '字幕', type: 'transcript', modes: ['batch'] },
    ],
  },
  {
    id: 'qwenaudio.meeting-notes',
    name: '会议纪要',
    author: 'QwenAudio',
    description:
      '实时采集会议音频，滚动转写并生成结构化纪要、决策和行动项。',
    license: 'Apache-2.0',
    capabilities: ['实时转写', '会议纪要', '行动项', '结构化总结'],
    harnessCapabilities: [],
    runtime: 'QwenAudio Toolkits',
    acceleration: ['CPU', 'Apple Silicon', '云端 API'],
    version: '1.0.0',
    size: '内置',
    enabled: true,
    sidebarVisible: true,
    builtin: true,
    featured: true,
    tone: 'coral',
    adapter: 'meeting-notes',
    installPath: '',
    catalogManaged: true,
    installable: true,
    extensionKind: 'workspace-agent',
    workspaceEntry: 'meeting-notes',
    agent: {
      task: '从麦克风或系统音频中实时记录会议内容，并生成可分享的结构化纪要。',
      usage: {
        inputRequirements: [
          '授予麦克风或系统音频采集权限。',
          '至少配置一个语音识别模型和一个文本生成模型。',
        ],
        limitations: [
          '嘈杂环境、远场收音和多人同时说话会影响转写准确率。',
          '实时纪要会持续修正，最终版本应在会议结束后复核。',
        ],
        examples: [
          '记录项目周会，整理进展、风险、决策和行动项。',
          '记录客户访谈，提炼痛点、证据和后续跟进事项。',
        ],
      },
      harness: {
        kind: 'app-workflow',
        entry: 'meeting-notes',
      },
    },
    inputs: [
      { name: 'audio', label: '会议音频', type: 'audio', modes: ['stream'] },
      { name: 'instruction', label: '纪要要求', type: 'text', modes: ['stream'], optional: true },
    ],
    outputs: [
      { name: 'transcript', label: '会议转写', type: 'transcript', modes: ['stream'] },
      { name: 'notes', label: '会议纪要', type: 'text', modes: ['stream'] },
    ],
  },
] as const satisfies ReadonlyArray<Omit<ModelPlugin, 'installed'>>

export function defaultInstalledAppAgentIds(): string[] {
  return APP_AGENT_DEFINITIONS.map((agent) => agent.id)
}

export function isWorkspaceAgent(
  extension: Pick<ModelPlugin, 'extensionKind' | 'workspaceEntry'>,
): extension is ModelPlugin & {
  extensionKind: 'workspace-agent'
  workspaceEntry: WorkspaceAgentEntry
} {
  return (
    extension.extensionKind === 'workspace-agent' &&
    Boolean(extension.workspaceEntry)
  )
}

export function appAgentsWithInstallState(
  installedIds: readonly string[],
): ModelPlugin[] {
  const installed = new Set(installedIds)
  return APP_AGENT_DEFINITIONS.map((definition) => ({
    ...definition,
    inputs: definition.inputs.map((port) => ({ ...port, modes: [...port.modes] })),
    outputs: definition.outputs.map((port) => ({ ...port, modes: [...port.modes] })),
    capabilities: [...definition.capabilities],
    harnessCapabilities: [...definition.harnessCapabilities],
    acceleration: [...definition.acceleration],
    installed: installed.has(definition.id),
  }))
}

export function sanitizeInstalledAppAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const known = new Set<string>(APP_AGENT_DEFINITIONS.map((agent) => agent.id))
  return [...new Set(value)].filter(
    (id): id is string => typeof id === 'string' && known.has(id),
  )
}
