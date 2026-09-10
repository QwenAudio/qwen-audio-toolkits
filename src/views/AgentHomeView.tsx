import { useMemo, useState } from 'react'
import {
  ArrowUp,
  Check,
  Languages,
  MessageSquareText,
  Mic2,
  Paperclip,
  Radio,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { t, useLocale } from '../i18n'
import './AgentHomeView.css'

export type AgentCreationMode = 'smart-cut' | 'ai-podcast' | 'video-translation' | 'meeting-notes'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

interface AgentHomeViewProps {
  smartCutAvailable: boolean
  podcastAvailable: boolean
  onLaunch: (mode: AgentCreationMode, prompt: string, sourcePath: string) => void
  onOpenStore: () => void
}

const MODES = [
  {
    id: 'smart-cut',
    name: '视频剪辑',
    description: '识别口播，校对后删除停顿、口水词和重录片段',
    icon: Scissors,
    tone: 'green',
  },
  {
    id: 'ai-podcast',
    name: 'AI 播客',
    description: '把论文或文档变成可编辑的双人对话节目',
    icon: Radio,
    tone: 'violet',
  },
  {
    id: 'video-translation',
    name: '视频翻译',
    description: '翻译对白、克隆音色，并保留原讲话节奏',
    icon: Languages,
    tone: 'blue',
  },
  {
    id: 'meeting-notes',
    name: '会议纪要',
    description: '实时转写并滚动识别说话人，延迟生成结构化纪要',
    icon: Mic2,
    tone: 'coral',
  },
] as const

const PROMPTS: Record<AgentCreationMode, ReadonlyArray<{ title: string; detail: string }>> = {
  'smart-cut': [
    { title: '保守粗剪', detail: '删除明显口水词和超过 0.8 秒的静音，保留自然停顿并生成字幕' },
    { title: '只清理口水词', detail: '保留所有停顿，只删除高置信度口水词和重复表达' },
    { title: '压缩口播节奏', detail: '去掉长静音和说错重录，逐项让我确认后再导出' },
  ],
  'ai-podcast': [
    { title: '大众解读', detail: '用轻松中文解释文档重点，也讲清结论的限制' },
    { title: '主持人访谈', detail: '整理成主持人与专家的对话，保留专业细节和争议' },
    { title: '快速摘要', detail: '生成约三分钟的双人播客，只保留最重要的发现和启示' },
  ],
  'video-translation': [
    { title: '自然中文配音', detail: '把英文视频翻译成自然中文，克隆原说话人音色并保留讲话停顿' },
    { title: '忠实双语版', detail: '忠实翻译对白，生成中文配音和中英双语字幕' },
    { title: '适配时长', detail: '翻译并调整措辞，使中文配音自然贴合每段原始时长' },
  ],
  'meeting-notes': [
    { title: '项目周会', detail: '重点整理项目进展、风险、决策和带负责人的行动项' },
    { title: '需求评审', detail: '记录需求共识、争议点、最终结论和仍待确认的问题' },
    { title: '客户访谈', detail: '提炼客户痛点、原话证据、需求优先级和后续跟进事项' },
  ],
}

function attachmentMatchesMode(path: string, mode: AgentCreationMode): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return mode === 'meeting-notes'
    ? false
    : mode === 'ai-podcast'
    ? DOCUMENT_EXTENSIONS.includes(extension as (typeof DOCUMENT_EXTENSIONS)[number])
    : VIDEO_EXTENSIONS.includes(extension as (typeof VIDEO_EXTENSIONS)[number])
}

export function AgentHomeView({
  smartCutAvailable,
  podcastAvailable,
  onLaunch,
  onOpenStore,
}: AgentHomeViewProps) {
  useLocale()
  const [mode, setMode] = useState<AgentCreationMode | null>(null)
  const [prompt, setPrompt] = useState('')
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)

  const selectedMode = useMemo(
    () => MODES.find((candidate) => candidate.id === mode) ?? null,
    [mode],
  )
  const available = mode === 'smart-cut'
    ? smartCutAvailable
    : mode === 'ai-podcast'
      ? podcastAvailable
      : mode === 'video-translation' || mode === 'meeting-notes'
  const attachmentCompatible = !attachment || !mode || attachmentMatchesMode(attachment.path, mode)

  const chooseMode = (nextMode: AgentCreationMode) => {
    if (nextMode === 'meeting-notes') setAttachment(null)
    setMode(nextMode)
  }

  const chooseAttachment = async () => {
    const filters = mode === 'ai-podcast'
      ? [{ name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] }]
      : mode === 'smart-cut' || mode === 'video-translation'
        ? [{ name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] }]
        : [
            { name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] },
            { name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] },
          ]
    const selection = await open({
      title: t('添加创作素材'),
      multiple: false,
      directory: false,
      filters,
    })
    const path = typeof selection === 'string' ? selection : null
    if (!path) return
    setAttachment({
      path,
      name: path.split(/[\\/]/u).at(-1) || t('未命名文件'),
    })
  }

  return (
    <main className="agent-home-view">
      <section className="agent-home-shell">
        <header className="agent-home-heading">
          <div className="agent-home-mark"><Sparkles size={23} strokeWidth={1.65} /></div>
          <span>{t('AI 创作 Agent')}</span>
          <h1>{t('今天想创作什么？')}</h1>
          <p>{t('描述你的创作需求，或从下方选择任务类型和推荐 Prompt。')}</p>
        </header>

        <div className="agent-home-composer">
          {attachment && (
            <div
              className={`agent-attachment-chip${attachmentCompatible ? '' : ' invalid'}`}
              aria-invalid={!attachmentCompatible}
            >
              <Paperclip size={14} />
              <span title={attachment.path}>{attachment.name}</span>
              <button
                type="button"
                aria-label={t('移除附件')}
                onClick={() => setAttachment(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <textarea
            rows={3}
            value={prompt}
            placeholder={t('描述你的创作要求')}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (
                selectedMode &&
                (selectedMode.id === 'meeting-notes' || (attachment && attachmentCompatible)) &&
                prompt.trim() &&
                available
              ) {
                onLaunch(selectedMode.id, prompt.trim(), attachment?.path ?? '')
              }
            }}
          />
          <div className="agent-home-composer-toolbar">
            <button type="button" className="agent-attach-button" disabled={mode === 'meeting-notes'} onClick={() => void chooseAttachment()}>
              <Paperclip size={14} />
              {t('添加文件')}
            </button>
            <span className={attachmentCompatible ? '' : 'invalid'}>
              {!attachmentCompatible && mode === 'ai-podcast'
                ? t('AI 播客仅支持 PDF、DOCX、TXT 和 Markdown，请更换附件')
                : !attachmentCompatible
                  ? t('此任务仅支持视频文件，请更换附件')
                  : attachment
                    ? t('文件将与 Prompt 一起提交')
                    : mode === 'meeting-notes'
                      ? t('实时会议无需添加文件')
                    : mode === 'ai-podcast'
                      ? t('支持 PDF、DOCX、TXT 和 Markdown')
                      : mode
                        ? t('支持 MP4、MOV、M4V、WebM 和 MKV')
                        : t('支持视频、PDF 和文档')}
            </span>
            {selectedMode && !available && (
              <button type="button" className="agent-install-link" onClick={onOpenStore}>
                {t('安装对应 Agent')}
              </button>
            )}
            <button
              className="agent-home-submit"
              type="button"
              disabled={
                !selectedMode ||
                (selectedMode?.id !== 'meeting-notes' && (!attachment || !attachmentCompatible)) ||
                !prompt.trim() ||
                !available
              }
              aria-label={t('进入 Agent 工作区')}
              onClick={() => {
                if (selectedMode && (selectedMode.id === 'meeting-notes' || (attachment && attachmentCompatible))) {
                  onLaunch(selectedMode.id, prompt.trim(), attachment?.path ?? '')
                }
              }}
            >
              <ArrowUp size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="agent-mode-heading">{t('选择创作类型')}</div>
        <div className="agent-mode-picker" aria-label={t('选择创作类型')}>
          {MODES.map((item) => {
            const Icon = item.icon
            const active = item.id === mode
            return (
              <button
                className={`agent-mode-card ${item.tone}${active ? ' active' : ''}`}
                type="button"
                key={item.id}
                aria-pressed={active}
                onClick={() => chooseMode(item.id)}
              >
                <span className="agent-mode-icon"><Icon size={19} strokeWidth={1.7} /></span>
                <span className="agent-mode-copy">
                  <strong>{t(item.name)}</strong>
                  <small>{t(item.description)}</small>
                </span>
                {active && <Check className="agent-mode-check" size={16} />}
              </button>
            )
          })}
        </div>

        {selectedMode ? (
          <section className="agent-prompt-stage" aria-live="polite">
            <div className="agent-prompt-heading">
              <div>
                <span>{t(selectedMode.name)}</span>
                <h2>{t('选择一个 Prompt 开始')}</h2>
              </div>
              <small>{t('也可以选择后继续修改')}</small>
            </div>

            <div className="agent-prompt-list">
              {PROMPTS[selectedMode.id].map((suggestion) => {
                const active = prompt === suggestion.detail
                return (
                  <button
                    type="button"
                    className={active ? 'active' : ''}
                    key={suggestion.title}
                    onClick={() => setPrompt(suggestion.detail)}
                  >
                    <MessageSquareText size={16} strokeWidth={1.65} />
                    <span>
                      <strong>{t(suggestion.title)}</strong>
                      <small>{t(suggestion.detail)}</small>
                    </span>
                    <ArrowUp size={15} className="agent-prompt-arrow" />
                  </button>
                )
              })}
            </div>

          </section>
        ) : null}
      </section>
    </main>
  )
}
