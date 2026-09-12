import { FileText, FolderOpen, Play } from 'lucide-react'
import type {
  AgentCreationMode,
  AgentCreationOptions,
  GeneralAgentAttachment,
  GeneralAgentMessage,
} from '../domain/agents'
import { resolveSkillLaunchInput } from '../domain/skillLaunch'
import { t, useLocale } from '../i18n'

interface SkillLaunchPanelProps {
  mode: Exclude<AgentCreationMode, 'agent-chat'>
  name: string
  draftPrompt: string
  attachment: GeneralAgentAttachment | null
  messages: GeneralAgentMessage[]
  options: AgentCreationOptions
  disabled: boolean
  installed: boolean
  onOpenStore: () => void
  onChooseFile: () => void
  onOptionsChange: (options: AgentCreationOptions) => void
  onLaunch: (mode: AgentCreationMode, prompt: string, path: string,
    dubbingMode?: AgentCreationOptions['videoDubbingMode'],
    languages?: AgentCreationOptions['videoDubbingLanguages'],
    style?: AgentCreationOptions['videoDubbingStyle']) => void
}

const LANGUAGES = [
  ['zh', '中文'], ['en', '英文'], ['ja', '日语'], ['ko', '韩语'],
  ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'],
] as const

export function SkillLaunchPanel({ mode, name, draftPrompt, attachment, messages,
  options, disabled, installed, onOpenStore, onChooseFile, onOptionsChange, onLaunch }: SkillLaunchPanelProps) {
  useLocale()
  const input = resolveSkillLaunchInput(mode, draftPrompt, attachment, messages)
  const dubbingMode = options.videoDubbingMode ?? 'translate'
  const languages = options.videoDubbingLanguages ?? { source: 'auto', target: 'zh' }
  const help = !installed ? t('安装此技能后即可开始制作，当前要求和素材会保留。') : input.missing === 'prompt'
    ? t('先填写创作要求，或与 Agent 讨论方案。')
    : input.missing === 'file'
      ? mode === 'ai-podcast' ? t('添加文档后即可开始制作。') : t('添加视频后即可开始制作。')
      : input.missing === 'file-type'
        ? t('当前素材类型不适用于此技能，请更换文件。')
        : mode === 'meeting-notes'
          ? t('进入会议工作区后，手动开始录音。')
          : t('开始后将在工作区处理素材，你可以审阅和调整结果。')

  return (
    <section className="skill-launch-panel" aria-label={t('开始技能任务')}>
      <div className="skill-launch-heading">
        <div><strong>{t('开始制作 · {0}', [name])}</strong><p>{help}</p></div>
        <button type="button" className="skill-launch-action" disabled={disabled || (installed && input.missing !== null)}
          onClick={() => {
            if (disabled) return
            if (!installed) { onOpenStore(); return }
            if (input.missing) return
            onLaunch(mode, input.prompt, input.source?.path ?? '',
              mode === 'video-dubbing' ? dubbingMode : undefined,
              mode === 'video-dubbing' ? languages : undefined,
              mode === 'video-dubbing' ? options.videoDubbingStyle ?? 'natural' : undefined)
          }}>
          <Play size={14} />{!installed ? t('前往安装') : mode === 'meeting-notes' ? t('进入会议') : t('开始制作')}
        </button>
      </div>
      {mode !== 'meeting-notes' && (
        <button className={`skill-launch-source${input.missing === 'file-type' ? ' invalid' : ''}`} type="button"
          disabled={disabled} title={input.source?.path} onClick={onChooseFile}>
          {input.source ? <FileText size={15} /> : <FolderOpen size={15} />}
          <span>{input.source?.name ?? (mode === 'ai-podcast' ? t('选择论文或文档') : t('选择视频'))}</span>
          {input.source && <small>{t('更换文件')}</small>}
        </button>
      )}
      {mode === 'video-dubbing' && (
        <fieldset className="skill-launch-options" disabled={disabled}>
          <legend>{t('配音设置')}</legend>
          <label>{t('配音方式')}
            <select value={dubbingMode} onChange={event => onOptionsChange({ ...options,
              videoDubbingMode: event.target.value as AgentCreationOptions['videoDubbingMode'] })}>
              <option value="translate">{t('翻译原声')}</option>
              <option value="rewrite">{t('改写台词')}</option>
              <option value="script">{t('使用新文案')}</option>
            </select>
          </label>
          <label>{t('原始语言')}
            <select value={languages.source} onChange={event => onOptionsChange({ ...options,
              videoDubbingLanguages: { ...languages, source: event.target.value } })}>
              <option value="auto">{t('自动识别')}</option>
              {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>
          <label>{t('目标语言')}
            <select value={languages.target} onChange={event => onOptionsChange({ ...options,
              videoDubbingLanguages: { ...languages, target: event.target.value } })}>
              {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>
          <label>{t('配音风格')}
            <select value={options.videoDubbingStyle ?? 'natural'} onChange={event => onOptionsChange({ ...options,
              videoDubbingStyle: event.target.value as AgentCreationOptions['videoDubbingStyle'] })}>
              <option value="natural">{t('自然')}</option>
              <option value="formal">{t('正式')}</option>
              <option value="casual">{t('轻松')}</option>
            </select>
          </label>
        </fieldset>
      )}
    </section>
  )
}
