import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  Copy,
  File,
  FileAudio,
  FileText,
  FileVideo,
  Languages,
  LoaderCircle,
  MessageSquareText,
  Mic2,
  PackagePlus,
  Paperclip,
  Check,
  Radio,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  AgentCreationMode,
  GeneralAgentAttachment,
  GeneralAgentMessage,
  GeneralAgentMessageModelOptions,
} from '../domain/agents'
import {
  agentFileCanPreview,
  agentFileKind,
  uniqueAgentFiles,
} from '../domain/agentFiles'
import type { OnDemandModelInstallMode } from '../domain/onDemandModels'
import { t, useLocale } from '../i18n'
import type { ModelPlugin } from '../types'
import './AgentHomeView.css'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'] as const
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

interface AgentHomeViewProps {
  skills: ModelPlugin[]
  taskId: string | null
  messages: GeneralAgentMessage[]
  draftPrompt: string
  attachment: { path: string; name: string } | null
  submitting: boolean
  modelInstallMode: OnDemandModelInstallMode
  messageModelOptions: Record<string, GeneralAgentMessageModelOptions>
  selectedModeId: AgentCreationMode | null
  onModelInstallModeChange: (mode: OnDemandModelInstallMode) => void
  onMessageModelSelect: (messageId: string, modelId: string) => void
  onSelectedModeChange: (mode: AgentCreationMode | null) => void
  onDraftPromptChange: (prompt: string) => void
  onAttachmentChange: (attachment: { path: string; name: string } | null) => void
  onSubmitPrompt: (request: {
    content: string
    selectedModeName: string | null
    attachmentHint: string
    attachment: { path: string; name: string } | null
  }) => void
  onRunMessageAction: (message: GeneralAgentMessage, modelId?: string | null) => void
  onOpenStore: () => void
}

const MODE_ORDER: AgentCreationMode[] = [
  'smart-cut',
  'ai-podcast',
  'video-dubbing',
  'meeting-notes',
]

const MODE_ICONS = {
  'smart-cut': Scissors,
  'ai-podcast': Radio,
  'video-dubbing': Languages,
  'meeting-notes': Mic2,
} satisfies Record<AgentCreationMode, typeof Scissors>

const QUICK_PROMPTS: ReadonlyArray<{
  label: string
  prompt: string
  mode?: AgentCreationMode
}> = [
  {
    label: '视频翻译规划',
    mode: 'video-dubbing',
    prompt: '我想把一个英文视频做成中文配音版，请先帮我规划 workflow、需要哪些模型、哪些地方需要人工确认。',
  },
  {
    label: 'AI 播客规划',
    mode: 'ai-podcast',
    prompt: '我想把一篇文档做成双人 AI 播客，请给出从导入、脚本、配音到导出的执行计划。',
  },
  {
    label: '智能剪辑规划',
    mode: 'smart-cut',
    prompt: '我想自动清理一段口播视频里的静音、口水词和重复表达，请先给我一个可审阅的剪辑方案。',
  },
]

function attachmentHint(path: string): string {
  return `\n\n已选择素材：${path}\n请在规划时考虑这个素材，但当前阶段不要直接处理或修改文件。`
}

function attachmentMatchesMode(path: string, mode: AgentCreationMode | null): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  if (!mode) {
    return [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...DOCUMENT_EXTENSIONS].includes(
      extension as
        | (typeof AUDIO_EXTENSIONS)[number]
        | (typeof VIDEO_EXTENSIONS)[number]
        | (typeof DOCUMENT_EXTENSIONS)[number],
    )
  }
  return mode === 'meeting-notes'
    ? false
    : mode === 'ai-podcast'
      ? DOCUMENT_EXTENSIONS.includes(extension as (typeof DOCUMENT_EXTENSIONS)[number])
      : VIDEO_EXTENSIONS.includes(extension as (typeof VIDEO_EXTENSIONS)[number])
}

function formatAgentTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function agentFileIcon(file: GeneralAgentAttachment): typeof File {
  const kind = agentFileKind(file)
  if (kind === 'audio') return FileAudio
  if (kind === 'video') return FileVideo
  if (kind === 'document') return FileText
  return File
}

function AgentFilePreview({
  file,
  compact = false,
  invalid = false,
  disabled = false,
  onRemove,
}: {
  file: GeneralAgentAttachment
  compact?: boolean
  invalid?: boolean
  disabled?: boolean
  onRemove?: () => void
}) {
  const Icon = agentFileIcon(file)
  const canPreview = agentFileCanPreview(file)
  const source = canPreview ? convertFileSrc(file.path) : ''
  return (
    <div
      className={`agent-file-preview${compact ? ' compact' : ''}${invalid ? ' invalid' : ''}`}
      title={file.path}
    >
      <div className="agent-file-preview-icon">
        <Icon size={compact ? 14 : 17} strokeWidth={1.8} />
      </div>
      <div className="agent-file-preview-body">
        <strong>{file.name}</strong>
        <span>{file.path}</span>
        {canPreview && (
          <audio
            controls
            preload="metadata"
            src={source}
            aria-label={t('播放 {0}', [file.name])}
          />
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={t('移除附件')}
          disabled={disabled}
          onClick={onRemove}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

export function AgentHomeView({
  skills,
  taskId,
  messages,
  draftPrompt,
  attachment,
  submitting,
  modelInstallMode,
  messageModelOptions,
  selectedModeId,
  onModelInstallModeChange,
  onMessageModelSelect,
  onSelectedModeChange,
  onDraftPromptChange,
  onAttachmentChange,
  onSubmitPrompt,
  onRunMessageAction,
  onOpenStore,
}: AgentHomeViewProps) {
  useLocale()
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [expandedModelChoices, setExpandedModelChoices] = useState<Set<string>>(() => new Set())
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

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
  const attachmentCompatible = !attachment || attachmentMatchesMode(attachment.path, selectedModeId)
  const hasConversation = messages.length > 0 || submitting
  const visibleMessageCount = messages.length + (submitting ? 1 : 0)
  const showSkillRow = modes.length > 0

  useEffect(() => {
    if (!hasConversation) return
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [
    attachment?.path,
    hasConversation,
    messages.length,
    selectedModeId,
    submitting,
  ])

  useEffect(() => {
    setExpandedModelChoices(new Set())
  }, [taskId])

  const chooseAttachment = async () => {
    const filters = selectedModeId === 'ai-podcast'
      ? [{ name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] }]
      : selectedModeId === 'smart-cut' || selectedModeId === 'video-dubbing'
        ? [{ name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] }]
        : [
            { name: t('音频文件'), extensions: [...AUDIO_EXTENSIONS] },
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
    onAttachmentChange({
      path,
      name: path.split(/[\\/]/u).at(-1) || t('未命名文件'),
    })
    promptRef.current?.focus()
  }

  const submitPrompt = async () => {
    const trimmed = draftPrompt.trim()
    if (!trimmed || submitting || !attachmentCompatible) return
    onSubmitPrompt({
      content: trimmed,
      selectedModeName: selectedMode ? t(selectedMode.name) : null,
      attachmentHint: attachment ? attachmentHint(attachment.path) : '',
      attachment,
    })
    if (attachment) onAttachmentChange(null)
  }

  const copyMessage = async (message: GeneralAgentMessage) => {
    const content = message.content.trim()
    if (!content) return
    await copyTextToClipboard(content)
    setCopiedMessageId(message.id)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === message.id ? null : current)
    }, 1200)
  }

  return (
    <main className={`agent-home-view${hasConversation ? ' has-conversation' : ''}`}>
      <div
        className="agent-home-drag-region"
        data-tauri-drag-region
        aria-hidden="true"
        onMouseDown={(event) => {
          if (event.button !== 0) return
          void getCurrentWindow().startDragging().catch(() => undefined)
        }}
      />
      <section className="agent-home-shell">
        {!hasConversation && (
          <header className="agent-home-heading">
            <div className="agent-home-mark"><Sparkles size={23} strokeWidth={1.65} /></div>
            <span>{t('新任务')}</span>
            <h1>{t('今天想创作什么？')}</h1>
            <p>{t('直接和 Agent 对话，让它先理解目标、规划流程、识别需要的模型能力。')}</p>
          </header>
        )}

        <section className="agent-chat-panel" aria-label={t('通用 Agent 对话')}>
          {hasConversation && (
            <div
	              className={`agent-message-list${visibleMessageCount <= 2 ? ' is-short' : ''}`}
              ref={messageListRef}
              aria-live="polite"
            >
	              {messages.map((message) => (
	                <article
	                  key={message.id}
	                  className={`agent-message ${message.role}`}
	                >
	                  <div className="agent-message-avatar">
	                    {message.role === 'assistant' ? <Bot size={16} /> : <MessageSquareText size={16} />}
	                  </div>
	                  <div className="agent-message-body">
	                    <div className="agent-message-bubble">
	                      <p>{message.content}</p>
	                      {uniqueAgentFiles([
	                        message.attachment,
	                        ...(message.attachments ?? []),
	                      ]).map((file) => (
	                        <AgentFilePreview file={file} key={`${file.path}-${file.name}`} />
	                      ))}
	                      {message.action && (() => {
	                        const modelOptions = messageModelOptions[message.id]
	                        const expanded = expandedModelChoices.has(message.id)
	                        const visibleChoices = modelOptions
	                          ? expanded
	                            ? modelOptions.choices
	                            : modelOptions.choices.slice(0, 3)
	                          : []
	                        const hiddenChoiceCount = modelOptions
	                          ? Math.max(0, modelOptions.choices.length - visibleChoices.length)
	                          : 0
	                        return (
	                          <div className={`agent-message-action ${message.action.status}`}>
	                            <div className="agent-message-action-head">
	                              <div>
	                                <strong>
	                                  {message.action.kind === 'install-on-demand-model'
	                                    ? message.action.modelName
	                                    : t('需要确认')}
	                                </strong>
	                                <span>
	                                  {message.action.kind === 'install-on-demand-model'
	                                    ? t('用于{0}', [message.action.needLabel])
	                                    : modelOptions
	                                      ? t('选择用于{0}的模型', [modelOptions.needLabel])
	                                      : t('确认后继续')}
	                                </span>
	                              </div>
	                              <button
	                                type="button"
	                                disabled={submitting || message.action.status === 'running' || message.action.status === 'done'}
	                                onClick={() => onRunMessageAction(message, modelOptions?.selectedModelId)}
	                              >
	                                {message.action.status === 'running' ? (
	                                  <LoaderCircle className="model-spin" size={14} />
	                                ) : message.action.kind === 'confirm-agent-plan' ? (
	                                  <Check size={14} />
	                                ) : (
	                                  <PackagePlus size={14} />
	                                )}
	                                {message.action.kind === 'install-on-demand-model'
	                                  ? message.action.status === 'done'
	                                    ? t('已安装')
	                                    : message.action.status === 'failed'
	                                      ? t('重试安装')
	                                      : message.action.status === 'running'
	                                        ? t('正在安装')
	                                        : t('安装并继续')
	                                  : message.action.status === 'done'
	                                    ? t('已确认')
	                                    : message.action.status === 'running'
	                                      ? t('正在确认')
	                                      : t(message.action.label)}
	                              </button>
	                            </div>
	                            {modelOptions && (
	                              <div className="agent-model-choice-panel" aria-label={t('选择模型')}>
	                                <div className="agent-model-choice-list">
	                                  {visibleChoices.map((choice) => (
	                                    <button
	                                      type="button"
	                                      className={choice.id === modelOptions.selectedModelId ? 'selected' : ''}
	                                      disabled={submitting || message.action?.status === 'running' || message.action?.status === 'done'}
	                                      key={choice.id}
	                                      title={choice.description}
	                                      onClick={() => onMessageModelSelect(message.id, choice.id)}
	                                    >
	                                      <span>{choice.name}</span>
	                                      <small>{choice.installed ? t('已安装') : t('待安装')}</small>
	                                    </button>
	                                  ))}
	                                </div>
	                                {modelOptions.choices.length > 3 && (
	                                  <button
	                                    type="button"
	                                    className="agent-model-choice-toggle"
	                                    onClick={() => setExpandedModelChoices((current) => {
	                                      const next = new Set(current)
	                                      if (next.has(message.id)) {
	                                        next.delete(message.id)
	                                      } else {
	                                        next.add(message.id)
	                                      }
	                                      return next
	                                    })}
	                                  >
	                                    {expanded
	                                      ? t('收起模型')
	                                      : t('展开其余 {0} 个模型', [hiddenChoiceCount])}
	                                  </button>
	                                )}
	                              </div>
	                            )}
	                          </div>
	                        )
	                      })()}
	                    </div>
	                    <div className="agent-message-tools">
	                      <time>{formatAgentTime(message.createdAt)}</time>
	                      <button
	                        type="button"
	                        className="agent-message-copy"
	                        aria-label={copiedMessageId === message.id ? t('已复制') : t('复制消息')}
	                        title={copiedMessageId === message.id ? t('已复制') : t('复制消息')}
	                        onClick={() => void copyMessage(message)}
	                      >
	                        {copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}
	                      </button>
	                    </div>
	                  </div>
	                </article>
	              ))}
	              {submitting && (
	                <article className="agent-message assistant">
	                  <div className="agent-message-avatar"><Bot size={16} /></div>
	                  <div className="agent-message-body">
	                    <div className="agent-message-bubble">
	                      <p className="agent-thinking">
	                        <LoaderCircle className="model-spin" size={14} />
	                        {t('正在处理当前任务…')}
	                      </p>
	                    </div>
	                  </div>
	                </article>
	              )}
            </div>
          )}

          <div className="agent-home-composer">
            {showSkillRow && (
              <div className={`agent-context-row${hasConversation ? ' compact' : ''}`} aria-label={t('技能选择')}>
                {modes.map((item) => {
                  const modeId = item.workspaceEntry
                  const Icon = MODE_ICONS[modeId]
                  const active = modeId === selectedModeId
                  return (
                    <button
                      className={`agent-context-chip ${item.tone}${active ? ' active' : ''}`}
                      type="button"
                      key={item.id}
                      disabled={submitting}
                      aria-pressed={active}
                      onClick={() => {
                        onSelectedModeChange(active ? null : modeId)
                        promptRef.current?.focus()
                      }}
                    >
                      <Icon size={14} strokeWidth={1.8} />
                      <span>{t(item.name)}</span>
                    </button>
                  )
                })}
                <button type="button" className="agent-context-chip store" disabled={submitting} onClick={onOpenStore}>
                  {t('管理技能和模型')}
                </button>
              </div>
            )}
	            {attachment && (
	              <AgentFilePreview
	                compact
	                file={attachment}
	                invalid={!attachmentCompatible}
	                disabled={submitting}
	                onRemove={() => onAttachmentChange(null)}
	              />
	            )}
            <textarea
              ref={promptRef}
              rows={3}
              value={draftPrompt}
              disabled={submitting}
              placeholder={t('描述你想完成的音视频任务，例如：把这个视频翻译成中文配音版，并保留原说话节奏')}
              onChange={(event) => onDraftPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                void submitPrompt()
              }}
            />
            <div className="agent-home-composer-toolbar">
              <button type="button" className="agent-attach-button" disabled={submitting} onClick={() => void chooseAttachment()}>
                <Paperclip size={14} />
                {t('添加文件')}
              </button>
              <button
                type="button"
                className="agent-install-mode-toggle"
                disabled={submitting}
                title={t('控制缺少开源模型时是先询问还是自动安装')}
                onClick={() =>
                  onModelInstallModeChange(modelInstallMode === 'ask' ? 'auto' : 'ask')
                }
              >
                {modelInstallMode === 'ask' ? t('询问') : t('自动')}
              </button>
	              <span className={attachmentCompatible ? '' : 'invalid'}>
	                {submitting
	                  ? t('正在处理当前任务…')
	                  : !attachmentCompatible && selectedModeId === 'ai-podcast'
	                  ? t('AI 播客仅支持 PDF、DOCX、TXT 和 Markdown，请更换附件')
	                  : !attachmentCompatible
	                    ? t('当前技能不支持这个文件类型，请更换附件或取消技能选择')
                    : attachment
                      ? t('文件路径会作为上下文发送给 Agent')
                      : t('可选：添加音频、视频、PDF 或文档作为任务上下文')}
              </span>
              <button
                className="agent-home-submit"
                type="button"
                disabled={!draftPrompt.trim() || submitting || !attachmentCompatible}
                aria-label={t('发送给 Agent')}
                onClick={() => void submitPrompt()}
              >
                {submitting ? <LoaderCircle className="model-spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.2} />}
              </button>
            </div>
          </div>
        </section>

        {!hasConversation && (
          <section className="agent-prompt-stage" aria-label={t('快速开始')}>
            <div className="agent-prompt-list">
              {QUICK_PROMPTS.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion.label}
                  onClick={() => {
                    if (suggestion.mode) onSelectedModeChange(suggestion.mode)
                    onDraftPromptChange(suggestion.prompt)
                    window.requestAnimationFrame(() => promptRef.current?.focus())
                  }}
                >
                  <MessageSquareText size={16} strokeWidth={1.65} />
                  <span>
                    <strong>{t(suggestion.label)}</strong>
                    <small>{t(suggestion.prompt)}</small>
                  </span>
                  <ArrowUp size={15} className="agent-prompt-arrow" />
                </button>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  )
}
