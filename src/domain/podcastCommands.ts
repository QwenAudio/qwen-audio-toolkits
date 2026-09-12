import type { PodcastLength, PodcastScript, PodcastSpeaker } from './podcast'
import type { WorkspaceActionDefinition, WorkspaceCommand } from '../services/workspaceController'

export interface PodcastModelChoice {
  id: string
  apiModel: boolean
  speakerCount: number
  defaultVoiceA: string
  defaultVoiceB: string
}

export interface PodcastCommandState {
  script: PodcastScript | null
  selectedTtsId: string
  llmIds: string[]
  ttsModels: PodcastModelChoice[]
}

export interface PodcastConfiguration {
  title?: string
  instruction?: string
  length?: PodcastLength
  language?: 'auto' | 'zh-CN' | 'en'
  selectedLlmId?: string
  selectedTtsId?: string
  speakerAName?: string
  speakerBName?: string
  voiceA?: string
  voiceB?: string
  speed?: number
}

export type ValidatedPodcastCommand =
  | { action: 'podcast.configure'; args: PodcastConfiguration }
  | { action: 'podcast.edit-turn'; args: { turnId: string; speaker?: PodcastSpeaker; text?: string } }
  | { action: 'podcast.add-turn'; args: { speaker: PodcastSpeaker; text: string; afterTurnId?: string } }
  | { action: 'podcast.remove-turn'; args: { turnId: string } }
  | { action: 'podcast.generate-script' | 'podcast.synthesize' | 'podcast.export'; args: Record<string, never> }

export type PodcastCommandErrorCode = 'arguments' | 'model' | 'voice' | 'script' | 'turn' | 'limit'

export class PodcastCommandError extends Error {
  code: PodcastCommandErrorCode
  constructor(code: PodcastCommandErrorCode) {
    super(`Invalid podcast command: ${code}`)
    this.code = code
  }
}

function invalid(code: PodcastCommandErrorCode = 'arguments'): never {
  throw new PodcastCommandError(code)
}

function fields(args: Record<string, unknown>, keys: string[], required: string[] = []): void {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(args, key))) invalid()
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid()
  return value
}

function speaker(value: unknown): PodcastSpeaker {
  if (value !== 'A' && value !== 'B') invalid()
  return value
}

function turnId(value: unknown, script: PodcastScript | null): string {
  const id = text(value, 200)
  if (!script?.turns.some((turn) => turn.id === id)) invalid('turn')
  return id
}

function voice(value: unknown, model: PodcastModelChoice | undefined): string {
  if (!model) invalid('model')
  const result = text(value, 200).trim()
  if (!model.apiModel && (!/^\d+$/u.test(result) || Number(result) >= model.speakerCount)) invalid('voice')
  return result
}

/** Reject the whole command before changing state, including unknown fields and stale turn IDs. */
export function validatePodcastCommand(command: WorkspaceCommand, state: PodcastCommandState): ValidatedPodcastCommand {
  const { action, args } = command
  switch (action) {
    case 'podcast.configure': {
      fields(args, ['title', 'instruction', 'length', 'language', 'selectedLlmId', 'selectedTtsId', 'speakerAName', 'speakerBName', 'voiceA', 'voiceB', 'speed'])
      if (!Object.keys(args).length) invalid()
      const next: PodcastConfiguration = {}
      if (Object.hasOwn(args, 'title')) {
        if (!state.script) invalid('script')
        next.title = text(args.title, 100)
      }
      if (Object.hasOwn(args, 'instruction')) next.instruction = text(args.instruction, 12_000, true)
      if (Object.hasOwn(args, 'length')) {
        if (!['brief', 'standard', 'deep'].includes(String(args.length))) invalid()
        next.length = args.length as PodcastLength
      }
      if (Object.hasOwn(args, 'language')) {
        if (!['auto', 'zh-CN', 'en'].includes(String(args.language))) invalid()
        next.language = args.language as PodcastConfiguration['language']
      }
      if (Object.hasOwn(args, 'selectedLlmId')) {
        const id = text(args.selectedLlmId, 300)
        if (!state.llmIds.includes(id)) invalid('model')
        next.selectedLlmId = id
      }
      if (Object.hasOwn(args, 'selectedTtsId')) {
        const id = text(args.selectedTtsId, 300)
        const model = state.ttsModels.find((item) => item.id === id)
        if (!model) invalid('model')
        next.selectedTtsId = id
        if (id !== state.selectedTtsId) {
          next.voiceA = model.defaultVoiceA
          next.voiceB = model.defaultVoiceB
        }
      }
      for (const key of ['speakerAName', 'speakerBName'] as const) {
        if (Object.hasOwn(args, key)) next[key] = text(args[key], 80)
      }
      const model = state.ttsModels.find((item) => item.id === (next.selectedTtsId ?? state.selectedTtsId))
      for (const key of ['voiceA', 'voiceB'] as const) {
        if (Object.hasOwn(args, key)) next[key] = voice(args[key], model)
      }
      if (Object.hasOwn(args, 'speed')) {
        if (typeof args.speed !== 'number' || !Number.isFinite(args.speed) || args.speed < 0.75 || args.speed > 1.35) invalid()
        next.speed = args.speed
      }
      return { action, args: next }
    }
    case 'podcast.edit-turn': {
      fields(args, ['turnId', 'speaker', 'text'], ['turnId'])
      if (!Object.hasOwn(args, 'speaker') && !Object.hasOwn(args, 'text')) invalid()
      return { action, args: {
        turnId: turnId(args.turnId, state.script),
        ...(Object.hasOwn(args, 'speaker') ? { speaker: speaker(args.speaker) } : {}),
        ...(Object.hasOwn(args, 'text') ? { text: text(args.text, 900, true) } : {}),
      } }
    }
    case 'podcast.add-turn': {
      fields(args, ['speaker', 'text', 'afterTurnId'], ['speaker', 'text'])
      if (!state.script) invalid('script')
      if (state.script.turns.length >= 80) invalid('limit')
      return { action, args: {
        speaker: speaker(args.speaker), text: text(args.text, 900),
        ...(Object.hasOwn(args, 'afterTurnId') ? { afterTurnId: turnId(args.afterTurnId, state.script) } : {}),
      } }
    }
    case 'podcast.remove-turn':
      fields(args, ['turnId'], ['turnId'])
      return { action, args: { turnId: turnId(args.turnId, state.script) } }
    case 'podcast.generate-script':
    case 'podcast.synthesize':
    case 'podcast.export':
      fields(args, [])
      return { action, args: {} }
    default:
      return invalid()
  }
}

/** Both manual and conversational edits use this update path and the same audio fingerprint. */
export function applyPodcastTurnCommand(
  script: PodcastScript,
  command: Extract<ValidatedPodcastCommand, { action: 'podcast.edit-turn' | 'podcast.add-turn' | 'podcast.remove-turn' }>,
  newId: string,
): PodcastScript {
  if (command.action === 'podcast.edit-turn') return {
    ...script,
    turns: script.turns.map((turn) => turn.id === command.args.turnId ? {
      ...turn,
      ...(command.args.text !== undefined ? { text: command.args.text } : {}),
      ...(command.args.speaker !== undefined ? { speaker: command.args.speaker } : {}),
    } : turn),
  }
  if (command.action === 'podcast.remove-turn') return { ...script, turns: script.turns.filter((turn) => turn.id !== command.args.turnId) }
  const afterIndex = command.args.afterTurnId ? script.turns.findIndex((turn) => turn.id === command.args.afterTurnId) : script.turns.length - 1
  const turns = [...script.turns]
  turns.splice(afterIndex + 1, 0, { id: newId, speaker: command.args.speaker, text: command.args.text })
  return { ...script, turns }
}

export function podcastWorkspaceActions(state: PodcastCommandState): WorkspaceActionDefinition[] {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
  const turn = { type: 'string', enum: state.script?.turns.map((item) => item.id) ?? [] }
  return [
    {
      name: 'podcast.configure',
      description: '修改当前播客设置。模型 ID 只能使用可用模型列表；本地音色是范围内的数字 ID。更换语音模型默认重置音色，可在同一操作中指定两位角色的音色。title 需要已有脚本；language 影响生成语言及现有稿件语言标签，不自动翻译台词。',
      parameters: object({
        title: { type: 'string', minLength: 1, maxLength: 100 },
        instruction: { type: 'string', maxLength: 12000 },
        length: { type: 'string', enum: ['brief', 'standard', 'deep'] },
        language: { type: 'string', enum: ['auto', 'zh-CN', 'en'] },
        selectedLlmId: { type: 'string', enum: state.llmIds },
        selectedTtsId: { type: 'string', enum: state.ttsModels.map((item) => item.id) },
        speakerAName: { type: 'string', minLength: 1, maxLength: 80 },
        speakerBName: { type: 'string', minLength: 1, maxLength: 80 },
        voiceA: { type: 'string', minLength: 1, maxLength: 200 },
        voiceB: { type: 'string', minLength: 1, maxLength: 200 },
        speed: { type: 'number', minimum: 0.75, maximum: 1.35 },
      }),
      quickCommands: [{ text: '语速设为 1.1 倍', args: { speed: 1.1 } }, { text: 'Set speed to 1.1x', args: { speed: 1.1 } }],
    },
    ...(state.script ? [
      {
        name: 'podcast.edit-turn', description: '根据当前 turnId 修改一段台词和/或说话人，已有音频会按实际修改标为待更新。',
        parameters: object({ turnId: turn, speaker: { type: 'string', enum: ['A', 'B'] }, text: { type: 'string', maxLength: 900 } }, ['turnId']),
      },
      {
        name: 'podcast.add-turn', description: '新增一段台词，默认追加到结尾；afterTurnId 可指定插入到哪段之后。最多 80 段。',
        parameters: object({ speaker: { type: 'string', enum: ['A', 'B'] }, text: { type: 'string', minLength: 1, maxLength: 900 }, afterTurnId: turn }, ['speaker', 'text']),
      },
      {
        name: 'podcast.remove-turn', description: '删除指定 turnId 的台词；导出之前需要更新音频。',
        parameters: object({ turnId: turn }, ['turnId']),
      },
    ] : []),
    {
      name: 'podcast.generate-script', description: '使用当前文档、创作要求和文本模型生成双人脚本，会替换现有稿件。', parameters: object({}),
      quickCommands: [{ text: '生成播客脚本', args: {} }, { text: 'Generate podcast script', args: {} }],
    },
    {
      name: 'podcast.synthesize', description: '合成当前已编辑脚本。复用未改变的片段，只生成缺失或修改过的语音，然后重新拼接。', parameters: object({}),
      quickCommands: [{ text: '生成播客音频', args: {} }, { text: '更新播客音频', args: {} }, { text: 'Generate podcast audio', args: {} }, { text: 'Update podcast audio', args: {} }],
    },
    { name: 'podcast.export', description: '导出与当前文稿和声音设置一致的 WAV 音频。打开保存窗口由用户选择位置；过期音频无法导出。', parameters: object({}) },
  ]
}
