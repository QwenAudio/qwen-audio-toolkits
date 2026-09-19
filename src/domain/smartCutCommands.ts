import type { WorkspaceActionDefinition, WorkspaceCommand } from '../services/workspaceController'
import { keepRangesFromCuts, type SmartCutCandidate } from './smartCut'
import { t } from '../i18n'

export interface SmartCutConfiguration {
  instruction?: string
  minimumSilence?: number
  edgePadding?: number
  includeSubtitles?: boolean
  asrModelId?: string
  llmModelId?: string
}

export type SmartCutCommand =
  | { action: 'cut.configure'; args: SmartCutConfiguration }
  | { action: 'cut.select'; args: { ids: string[]; selected: boolean } }
  | { action: 'cut.remove-range'; args: { start: number; end: number } }
  | { action: 'cut.undo' | 'cut.analyze' | 'cut.preview' | 'cut.export'; args: Record<string, never> }

export const SMART_CUT_ACTIONS: WorkspaceActionDefinition[] = [
  {
    name: 'cut.configure',
    description: 'Update the current editing instruction, silence threshold in seconds, cut padding in seconds, subtitles, or ready models. Threshold and padding changes rebuild suggestions while retaining manual selections. Does not run speech recognition.',
    parameters: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        instruction: { type: 'string', minLength: 1, maxLength: 2000 },
        minimumSilence: { type: 'number', minimum: 0.3, maximum: 2 },
        edgePadding: { type: 'number', minimum: 0.04, maximum: 0.35 },
        includeSubtitles: { type: 'boolean' },
        asrModelId: { type: 'string', minLength: 1 },
        llmModelId: { type: 'string', description: 'Empty string selects local rules.' },
      },
    },
    quickCommands: [
      { text: '关闭字幕', args: { includeSubtitles: false } },
      { text: '开启字幕', args: { includeSubtitles: true } },
      { text: 'Disable subtitles', args: { includeSubtitles: false } },
      { text: 'Close captions', args: { includeSubtitles: false } },
      { text: 'Enable subtitles', args: { includeSubtitles: true } },
    ],
  },
  {
    name: 'cut.select',
    description: 'Set selected on specific existing candidate IDs. selected=true means delete that interval; false means retain it. Never invent IDs.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ids', 'selected'],
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: 5000, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        selected: { type: 'boolean' },
      },
    },
  },
  {
    name: 'cut.remove-range',
    description: 'Mark a specific time interval in seconds for removal. Requires 0 <= start < end <= video duration; the whole video cannot be removed. This is reversible via cut.undo.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['start', 'end'],
      properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', exclusiveMinimum: 0 } },
    },
  },
  ...(['cut.undo', 'cut.analyze', 'cut.preview', 'cut.export'] as const).map((name) => ({
    name,
    description: {
      'cut.undo': 'Undo the most recent candidate edit. Does not undo settings or recognition.',
      'cut.analyze': 'Prepare the attached video if needed, then run recognition and rebuild edit suggestions. Replaces previous recognition and candidate edits.',
      'cut.preview': 'Start playback of the edited video, skipping selected removal intervals.',
      'cut.export': 'Open the native save dialog and export the current cut. The user chooses the output file.',
    }[name],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    ...(name === 'cut.undo' ? { quickCommands: [
      { text: '撤销剪辑', args: {} }, { text: 'Undo cut', args: {} },
    ] } : {}),
  })),
]

function exactKeys(args: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(args).some((key) => !keys.includes(key))) throw new Error(t('剪辑操作包含不支持的参数。'))
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

/** Reject malformed or stale commands before touching editor state. */
export function validateSmartCutCommand(
  command: WorkspaceCommand,
  context: { candidates: SmartCutCandidate[]; duration: number | null; asrModelIds: string[]; llmModelIds: string[] },
): SmartCutCommand {
  const { action, args } = command
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(t('剪辑操作参数格式无效。'))
  switch (action) {
    case 'cut.configure': {
      exactKeys(args, ['instruction', 'minimumSilence', 'edgePadding', 'includeSubtitles', 'asrModelId', 'llmModelId'])
      if (!Object.keys(args).length) throw new Error(t('请提供要修改的剪辑设置。'))
      if ('instruction' in args && (typeof args.instruction !== 'string' || !args.instruction.trim() || args.instruction.length > 2000)) throw new Error(t('剪辑要求须为 1–2000 个字符。'))
      if ('minimumSilence' in args && !finiteRange(args.minimumSilence, 0.3, 2)) throw new Error(t('最短静音须在 0.3–2 秒之间。'))
      if ('edgePadding' in args && !finiteRange(args.edgePadding, 0.04, 0.35)) throw new Error(t('切口缓冲须在 0.04–0.35 秒之间。'))
      if ('includeSubtitles' in args && typeof args.includeSubtitles !== 'boolean') throw new Error(t('字幕开关须为布尔值。'))
      if ('asrModelId' in args && (typeof args.asrModelId !== 'string' || !context.asrModelIds.includes(args.asrModelId))) throw new Error(t('请选择当前可用的识别模型。'))
      if ('llmModelId' in args && (typeof args.llmModelId !== 'string' || (args.llmModelId !== '' && !context.llmModelIds.includes(args.llmModelId)))) throw new Error(t('请选择当前可用的指令解析模型。'))
      return { action, args: { ...args } as SmartCutConfiguration }
    }
    case 'cut.select': {
      exactKeys(args, ['ids', 'selected'])
      if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 5000 || args.ids.some((id) => typeof id !== 'string' || !id) || new Set(args.ids).size !== args.ids.length || typeof args.selected !== 'boolean') throw new Error(t('请提供不重复的候选编号和删除开关。'))
      const existing = new Set(context.candidates.map(({ id }) => id))
      if (args.ids.some((id) => !existing.has(id as string))) throw new Error(t('部分剪辑候选已变化，请根据最新候选重新操作。'))
      return { action, args: { ids: args.ids as string[], selected: args.selected } }
    }
    case 'cut.remove-range': {
      exactKeys(args, ['start', 'end'])
      if (!context.duration || !finiteRange(args.start, 0, context.duration) || !finiteRange(args.end, 0, context.duration) || args.start >= args.end) throw new Error(t('删除范围须位于视频内，且结束时间晚于开始时间。'))
      return { action, args: { start: args.start, end: args.end } }
    }
    case 'cut.undo':
    case 'cut.analyze':
    case 'cut.preview':
    case 'cut.export':
      exactKeys(args, [])
      return { action, args: {} }
    default:
      throw new Error(t('此剪辑操作不受支持。'))
  }
}

export function manualRangeCandidate(start: number, end: number): SmartCutCandidate {
  return {
    id: `manual-range-${crypto.randomUUID()}`,
    reason: 'manual', start, end,
    label: `${start.toFixed(2)}–${end.toFixed(2)}s`,
    detail: t('按时间范围标记删除'), confidence: 'high', selected: true,
  }
}

export function ensureSmartCutContentRemaining(candidates: SmartCutCandidate[], duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0 || !keepRangesFromCuts(candidates, duration).length) {
    throw new Error(t('请至少保留一段视频内容。'))
  }
}
