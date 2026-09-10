import type { ModelPlugin, WorkspaceAgentEntry } from './types'

export const INSTALLED_APP_AGENTS_STORAGE_KEY =
  'qwen-audio-toolkits.installed-app-agents-v1'

const APP_AGENT_DEFINITIONS = [
  {
    id: 'qwenaudio.smart-cut',
    name: '口播剪辑',
    author: 'QwenAudio',
    description:
      '识别视频语音，检测静音、口水词和手动选词，生成可预览、可复核并带字幕的剪辑结果。',
    license: 'Apache-2.0',
    capabilities: ['口播剪辑', '语音识别', '静音检测', '内嵌字幕'],
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
      task: '从视频语音和画面信息生成可人工复核的口播剪辑方案，并导出视频与字幕。',
      usage: {
        inputRequirements: [
          '输入包含音轨的视频文件。',
          '至少安装一个支持词级时间戳的批量语音识别模型。',
        ],
        limitations: [
          '自动删除结果需要人工复核，背景音乐和多人重叠说话会影响识别与停顿检测。',
          '没有词级时间戳的识别模型不会出现在口播剪辑模型列表中。',
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
] as const satisfies ReadonlyArray<Omit<ModelPlugin, 'installed'>>

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
