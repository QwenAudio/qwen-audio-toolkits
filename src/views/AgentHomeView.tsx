import { useEffect, useMemo, useRef, useState } from 'react'
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
import type { AgentCreationMode, VideoDubbingLanguages, VideoDubbingMode, VideoDubbingStyle } from '../domain/agents'
import { t, useLocale } from '../i18n'
import type { ModelPlugin } from '../types'
import './AgentHomeView.css'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

interface AgentHomeViewProps {
  skills: ModelPlugin[]
  selectedModeId: AgentCreationMode | null
  chatAvailable: boolean
  onSelectedModeChange: (mode: AgentCreationMode | null) => void
  onLaunch: (
    mode: AgentCreationMode,
    prompt: string,
    sourcePath: string,
    videoDubbingMode?: VideoDubbingMode,
    videoDubbingLanguages?: VideoDubbingLanguages,
    videoDubbingStyle?: VideoDubbingStyle,
  ) => void
  onOpenStore: () => void
}

const MODE_ORDER: AgentCreationMode[] = [
  'agent-chat',
  'smart-cut',
  'ai-podcast',
  'video-dubbing',
  'meeting-notes',
]

const MODE_ICONS = {
  'agent-chat': MessageSquareText,
  'smart-cut': Scissors,
  'ai-podcast': Radio,
  'video-dubbing': Languages,
  'meeting-notes': Mic2,
} satisfies Record<AgentCreationMode, typeof Scissors>

const PROMPTS: Record<AgentCreationMode, ReadonlyArray<{
  title: string
  detail: string
  dubbingMode?: VideoDubbingMode
}>> = {
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
  'video-dubbing': [
    { title: '自然中文配音', detail: '把英文视频翻译成自然中文，克隆原说话人音色并保留讲话停顿', dubbingMode: 'translate' },
    { title: '忠实双语版', detail: '忠实翻译对白，生成中文配音和中英双语字幕', dubbingMode: 'translate' },
    { title: '精简原稿', detail: '保持原语言和原意，删除口吃、重复和冗余表达，让口播更简洁', dubbingMode: 'rewrite' },
    { title: '专业润色', detail: '保持原语言，把原视频台词改得更自然、专业，并贴合原讲话时长', dubbingMode: 'rewrite' },
    { title: '产品介绍模板', detail: '大家好，欢迎了解我们的产品。接下来，我会用几个简单步骤介绍它的核心功能和使用方式。', dubbingMode: 'script' },
    { title: '教程旁白模板', detail: '这一部分将演示完整的操作流程。请跟随画面中的步骤，依次完成设置、确认和提交。', dubbingMode: 'script' },
  ],
  'meeting-notes': [
    { title: '项目周会', detail: '重点整理项目进展、风险、决策和带负责人的行动项' },
    { title: '需求评审', detail: '记录需求共识、争议点、最终结论和仍待确认的问题' },
    { title: '客户访谈', detail: '提炼客户痛点、原话证据、需求优先级和后续跟进事项' },
  ],
  'agent-chat': [
    { title: '自我介绍', detail: '你好，介绍一下你自己能做什么' },
    { title: '写个示例', detail: '帮我用 Python 写一个快速排序，并解释你的实现思路' },
    { title: '排查问题', detail: '帮我分析一段报错日志，列出可能的原因和排查步骤' },
  ],
}

const VIDEO_DUBBING_MODES: ReadonlyArray<{
  id: VideoDubbingMode
  name: string
  description: string
}> = [
  { id: 'translate', name: '翻译原声', description: '翻译原台词后配音' },
  { id: 'rewrite', name: '修改原稿', description: '按要求改写原台词' },
  { id: 'script', name: '使用新文案', description: '替换为你提供的完整文案' },
]

const DUBBING_LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
]

const DUBBING_STYLE_OPTIONS: ReadonlyArray<{ code: VideoDubbingStyle; name: string }> = [
  { code: 'natural', name: '自然' },
  { code: 'formal', name: '正式' },
  { code: 'casual', name: '口语' },
]

function attachmentMatchesMode(path: string, mode: AgentCreationMode): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return mode === 'meeting-notes'
    ? false
    : mode === 'agent-chat'
      ? true
      : mode === 'ai-podcast'
        ? DOCUMENT_EXTENSIONS.includes(extension as (typeof DOCUMENT_EXTENSIONS)[number])
        : VIDEO_EXTENSIONS.includes(extension as (typeof VIDEO_EXTENSIONS)[number])
}

export function AgentHomeView({
  skills,
  selectedModeId,
  chatAvailable,
  onSelectedModeChange,
  onLaunch,
  onOpenStore,
}: AgentHomeViewProps) {
  useLocale()
  const [videoDubbingMode, setVideoDubbingMode] = useState<VideoDubbingMode>('translate')
  const [sourceLanguage, setSourceLanguage] = useState('auto')
  const [targetLanguage, setTargetLanguage] = useState('zh')
  const [dubbingStyle, setDubbingStyle] = useState<VideoDubbingStyle>('natural')
  const [prompt, setPrompt] = useState('')
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)
  const [greeting, setGreeting] = useState<string | null>(null)
  const [composerHint, setComposerHint] = useState<string | null>(null)
  const [hasGreeted, setHasGreeted] = useState<boolean>(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (greeting) textareaRef.current?.focus()
  }, [greeting])

  useEffect(() => {
    setComposerHint(null)
  }, [selectedModeId])

  const modes = useMemo(
    () =>
      skills
        .filter((skill): skill is ModelPlugin & { workspaceEntry: AgentCreationMode } =>
          Boolean(skill.workspaceEntry) &&
          MODE_ORDER.includes(skill.workspaceEntry as AgentCreationMode),
        )
        .sort(
          (left, right) =>
            MODE_ORDER.indexOf(left.workspaceEntry) -
            MODE_ORDER.indexOf(right.workspaceEntry),
        ),
    [skills],
  )
  const selectedMode = useMemo(
    () => modes.find((candidate) => candidate.workspaceEntry === selectedModeId) ?? null,
    [modes, selectedModeId],
  )
  const selectedEntry = selectedMode?.workspaceEntry ?? null
  const available =
    selectedEntry === 'agent-chat' ? chatAvailable : (selectedMode?.installed ?? false)
  const attachmentCompatible = !attachment || !selectedEntry || attachmentMatchesMode(attachment.path, selectedEntry)

  const getComposerHint = (): string | null => {
    if (!selectedEntry) {
      if (chatAvailable && !attachment) return null
      return t('请先选择一个技能')
    }
    if (!available) {
      return selectedEntry === 'agent-chat'
        ? t('未检测到可用的 Agent CLI，请先安装并登录（如 kimi）')
        : t('请先安装对应技能')
    }
    if (
      selectedEntry !== 'meeting-notes' &&
      selectedEntry !== 'agent-chat' &&
      !attachment
    ) {
      return t('该任务需要文件，请添加文件')
    }
    return null
  }

  const canLaunchFromComposer = (): boolean =>
    (!selectedEntry && chatAvailable) ||
    (Boolean(selectedEntry) &&
      (selectedEntry === 'meeting-notes' ||
        selectedEntry === 'agent-chat' ||
        Boolean(attachment && attachmentCompatible)) &&
      available)

  const showGreeting = () => {
    setGreeting(t('你好，我是 QwenAudio Toolkits，你的本地 AI 音频工作站。我可以帮你完成语音识别、语音合成、音频增强、实时语音对话、视频配音、口播剪辑、AI 播客等任务。选择一个技能或模型开始创作吧！'))
    setPrompt('')
    setHasGreeted(true)
  }

  const chooseMode = (nextMode: AgentCreationMode) => {
    if (nextMode === 'meeting-notes') setAttachment(null)
    onSelectedModeChange(nextMode)
  }

  const launch = () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setGreeting(null)
    if (!selectedEntry) {
      if (chatAvailable) {
        onLaunch('agent-chat', trimmed, attachment?.path ?? '')
        return
      }
      if (!attachment && !hasGreeted) showGreeting()
      return
    }
    if (canLaunchFromComposer()) {
      onLaunch(
        selectedEntry,
        trimmed,
        attachment?.path ?? '',
        selectedEntry === 'video-dubbing' ? videoDubbingMode : undefined,
        selectedEntry === 'video-dubbing'
          ? { source: sourceLanguage, target: targetLanguage }
          : undefined,
        selectedEntry === 'video-dubbing' ? dubbingStyle : undefined,
      )
    } else if (!attachment && !hasGreeted) {
      showGreeting()
    }
  }

  const chooseAttachment = async () => {
    const filters = selectedEntry === 'ai-podcast'
      ? [{ name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] }]
      : selectedEntry === 'smart-cut' || selectedEntry === 'video-dubbing'
        ? [{ name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] }]
        : [{ name: t('所有文件'), extensions: ['*'] }]
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
    setComposerHint(null)
  }

  return (
    <main className="agent-home-view">
      <section className="agent-home-shell">
        <header className="agent-home-heading">
          <div className="agent-home-mark"><Sparkles size={23} strokeWidth={1.65} /></div>
          <span>{t('新任务')}</span>
          <h1>{t('今天想创作什么？')}</h1>
          <p>{t('描述任务，选择技能和模型完成音频创作与处理。')}</p>
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
                onClick={() => {
                  setAttachment(null)
                  setComposerHint(null)
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={3}
            value={prompt}
            placeholder={t(
              selectedEntry === 'video-dubbing' && videoDubbingMode === 'script'
                ? '粘贴完整配音文案'
                : selectedEntry === 'video-dubbing' && videoDubbingMode === 'rewrite'
                  ? '描述你希望如何修改原稿'
                  : !selectedEntry && chatAvailable
                    ? '描述任务，或直接输入与 Agent 对话'
                    : '描述任务，输入/调用技能',
            )}
            onChange={(event) => {
              setPrompt(event.target.value)
              if (composerHint) setComposerHint(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              const trimmed = prompt.trim()
              if (!trimmed) return
              if (canLaunchFromComposer()) {
                event.preventDefault()
                launch()
                return
              }
              if (!attachment && !hasGreeted) {
                event.preventDefault()
                showGreeting()
                return
              }
              const hint = getComposerHint()
              if (hint) {
                event.preventDefault()
                setComposerHint(hint)
              }
            }}
          />
          <div className="agent-home-composer-toolbar">
            <button
              type="button"
              className="agent-attach-button"
              disabled={selectedEntry === 'meeting-notes'}
              onClick={() => void chooseAttachment()}
            >
              <Paperclip size={14} />
              {t('添加文件')}
            </button>
            <span className={attachmentCompatible ? '' : 'invalid'}>
              {!attachmentCompatible && selectedEntry === 'ai-podcast'
                ? t('AI 播客仅支持 PDF、DOCX、TXT 和 Markdown，请更换附件')
                : !attachmentCompatible
                  ? t('此任务仅支持视频文件，请更换附件')
                  : attachment
                    ? selectedEntry === 'agent-chat' || !selectedEntry
                      ? t('文件路径会随消息一起发给 Agent')
                      : t('文件将与 Prompt 一起提交')
                    : selectedEntry === 'agent-chat' || (!selectedEntry && chatAvailable)
                      ? t('直接输入开始对话，也可以附加文件让 Agent 处理')
                      : selectedEntry === 'meeting-notes'
                        ? t('实时会议无需添加文件')
                        : selectedEntry === 'ai-podcast'
                          ? t('支持 PDF、DOCX、TXT 和 Markdown')
                          : selectedEntry
                            ? t('支持 MP4、MOV、M4V、WebM 和 MKV')
                            : t('支持视频、PDF 和文档')}
            </span>
            {selectedMode && !available && selectedEntry !== 'agent-chat' && (
              <button type="button" className="agent-install-link" onClick={onOpenStore}>
                {t('安装对应技能')}
              </button>
            )}
            <button
              className="agent-home-submit"
              type="button"
              disabled={
                !prompt.trim() ||
                (!canLaunchFromComposer() && (hasGreeted || !!attachment))
              }
              aria-label={t('进入技能工作区')}
              onClick={launch}
            >
              <ArrowUp size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        {greeting && (
          <div className="agent-greeting" role="status">
            <p>{greeting}</p>
          </div>
        )}
        {composerHint && (
          <div className="agent-composer-hint" role="alert">
            <p>{composerHint}</p>
          </div>
        )}

        <div className="agent-mode-heading">{t('选择技能')}</div>
        <div className="agent-mode-picker" aria-label={t('选择技能')}>
          {modes.map((item) => {
            const modeId = item.workspaceEntry
            const Icon = MODE_ICONS[modeId]
            const active = modeId === selectedModeId
            return (
              <button
                className={`agent-mode-card ${item.tone}${active ? ' active' : ''}`}
                type="button"
                key={item.id}
                aria-pressed={active}
                onClick={() => chooseMode(modeId)}
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

        {selectedMode && selectedEntry ? (
          <section className="agent-prompt-stage" aria-live="polite">
            <div className="agent-prompt-heading">
              <div>
                <span>{t(selectedMode.name)}</span>
                <h2>{t('选择一个 Prompt 开始')}</h2>
              </div>
              <small>{t('也可以选择后继续修改')}</small>
            </div>

            {selectedEntry === 'video-dubbing' && (
              <>
                <div className="agent-dubbing-mode-picker" role="group" aria-label={t('选择配音方式')}>
                  {VIDEO_DUBBING_MODES.map((item) => (
                    <button
                      type="button"
                      className={videoDubbingMode === item.id ? 'active' : ''}
                      key={item.id}
                      onClick={() => {
                        setVideoDubbingMode(item.id)
                        setPrompt('')
                      }}
                    >
                      <strong>{t(item.name)}</strong>
                      <small>{t(item.description)}</small>
                    </button>
                  ))}
                </div>
                <div className="agent-dubbing-language-row">
                  <label>
                    {t('源语言')}
                    <select
                      value={sourceLanguage}
                      onChange={(event) => setSourceLanguage(event.target.value)}
                    >
                      <option value="auto">{t('自动检测')}</option>
                      {DUBBING_LANGUAGE_OPTIONS.map((option) => (
                        <option key={option.code} value={option.code}>{option.name}</option>
                      ))}
                    </select>
                  </label>
                  {videoDubbingMode === 'translate' && (
                    <label>
                      {t('目标语言')}
                      <select
                        value={targetLanguage}
                        onChange={(event) => setTargetLanguage(event.target.value)}
                      >
                        {DUBBING_LANGUAGE_OPTIONS.map((option) => (
                          <option key={option.code} value={option.code}>{option.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {videoDubbingMode !== 'script' && (
                    <label>
                      {t('风格')}
                      <select
                        value={dubbingStyle}
                        onChange={(event) => setDubbingStyle(event.target.value as VideoDubbingStyle)}
                      >
                        {DUBBING_STYLE_OPTIONS.map((option) => (
                          <option key={option.code} value={option.code}>{option.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {videoDubbingMode === 'script' && (
                  <p className="agent-dubbing-note">
                    {t('新文案会按原视频的人声时间轴分配；当前不支持无对白视频的画面理解配音。')}
                  </p>
                )}
              </>
            )}

            <div className="agent-prompt-list">
              {PROMPTS[selectedEntry]
                .filter((suggestion) => selectedEntry !== 'video-dubbing' || suggestion.dubbingMode === videoDubbingMode)
                .map((suggestion) => {
                  const active = prompt === suggestion.detail
                  return (
                    <button
                      type="button"
                      className={active ? 'active' : ''}
                      key={suggestion.title}
                      onClick={() => {
                        if (suggestion.dubbingMode) setVideoDubbingMode(suggestion.dubbingMode)
                        setPrompt(suggestion.detail)
                      }}
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
