import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Copy,
  File,
  FileAudio,
  FileText,
  FileVideo,
  Languages,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Mic2,
  PackagePlus,
  Paperclip,
  Play,
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
  AgentCreationOptions,
  GeneralAgentAttachment,
  GeneralAgentMessage,
  GeneralAgentMessageModelOptions,
  VideoDubbingLanguages,
  VideoDubbingMode,
  VideoDubbingStyle,
} from '../domain/agents'
import {
  agentFileCanPreview,
  agentFileKind,
  uniqueAgentFiles,
} from '../domain/agentFiles'
import type { OnDemandModelInstallMode } from '../domain/onDemandModels'
import { t, useLocale } from '../i18n'
import type { ModelPlugin, AcpProviderInfo, AcpSessionEvent } from '../types'
import type { AgentModelSelection } from '../domain/agents'
import type { AgentModelOption } from '../domain/agentModelSelection'
import './AgentHomeView.css'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'] as const
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

interface AgentHomeViewProps {
  skills: ModelPlugin[]
  acpProviders: AcpProviderInfo[]
  chatModelLoading: boolean
  chatModelError?: string
  onRetryModels: () => void
  acpPermissions: AcpSessionEvent[]
  onAcpPermission: (event: AcpSessionEvent, optionId?: string) => void
  acpRunning: boolean
  onCancelAcp: () => void
  chatModelOptions: AgentModelOption[]
  chatModel: AgentModelSelection | null
  onChatModelChange: (selection: AgentModelSelection | null) => void
  workspaceTitle?: string
  workspaceCanOperate?: boolean
  taskId: string | null
  messages: GeneralAgentMessage[]
  draftPrompt: string
  attachment: { path: string; name: string } | null
  submitting: boolean
  modelInstallMode: OnDemandModelInstallMode
  messageModelOptions: Record<string, GeneralAgentMessageModelOptions>
  selectedModeId: AgentCreationMode | null
  creationOptions?: AgentCreationOptions
  onCreationOptionsChange: (options: AgentCreationOptions) => void
  onModelInstallModeChange: (mode: OnDemandModelInstallMode) => void
  onMessageModelSelect: (messageId: string, modelId: string) => void
  chatAvailable: boolean
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

const TASK_PROMPTS: Partial<Record<AgentCreationMode, string>> = {
  'video-dubbing': '我想把一个英文视频做成中文配音版，请先帮我规划 workflow、需要哪些模型、哪些地方需要人工确认。',
  'ai-podcast': '我想把一篇文档做成双人 AI 播客，请给出从导入、脚本、配音到导出的执行计划。',
  'smart-cut': '我想自动清理一段口播视频里的静音、口水词和重复表达，请先给我一个可审阅的剪辑方案。',
  'meeting-notes': '帮我整理会议记录，识别发言内容，总结关键结论、待办事项和负责人。',
}

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
    : mode === 'agent-chat'
      ? true
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
  try {
    textarea.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed')
  } finally {
    textarea.remove()
  }
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
  acpProviders, chatModelLoading, chatModelError, onRetryModels, acpPermissions, onAcpPermission, acpRunning, onCancelAcp,
  chatModelOptions,
  chatModel,
  onChatModelChange,
  workspaceTitle,
  workspaceCanOperate = false,
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
}: AgentHomeViewProps) {
  useLocale()
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [expandedModelChoices, setExpandedModelChoices] = useState<Set<string>>(() => new Set())
  const [choosingAttachment, setChoosingAttachment] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const followMessagesRef = useRef(true)
  const attachmentRequestRef = useRef(0)
  const copyTimeoutRef = useRef<number | null>(null)
  const wasSubmittingRef = useRef(false)

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
  const inWorkspace = workspaceTitle !== undefined
  const hasConversation = inWorkspace || messages.length > 0 || submitting
  const visibleMessageCount = messages.length + (submitting ? 1 : 0)
  const showSkillRow = !inWorkspace && modes.length > 0

  useEffect(() => {
    setExpandedModelChoices(new Set())
    setComposerError(null)
    setChoosingAttachment(false)
    setCopiedMessageId(null)
    setHasUnreadMessages(false)
    followMessagesRef.current = true
    const list = messageListRef.current
    if (list) list.scrollTop = list.scrollHeight
    return () => {
      attachmentRequestRef.current += 1
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current)
    }
  }, [taskId])

  useLayoutEffect(() => {
    const prompt = promptRef.current
    if (!prompt) return
    prompt.style.height = 'auto'
    const height = Math.min(prompt.scrollHeight, 200)
    prompt.style.height = `${height}px`
    prompt.style.overflowY = prompt.scrollHeight > 200 ? 'auto' : 'hidden'
    const list = messageListRef.current
    if (list && followMessagesRef.current) list.scrollTop = list.scrollHeight
  }, [draftPrompt, hasConversation, attachment?.path, selectedModeId])

  useEffect(() => {
    const list = messageListRef.current
    if (!list) return
    if (followMessagesRef.current) {
      list.scrollTop = list.scrollHeight
    } else {
      setHasUnreadMessages(true)
    }
  }, [messages, submitting])

  useEffect(() => {
    if (wasSubmittingRef.current && !submitting && document.activeElement === document.body) {
      promptRef.current?.focus()
    }
    wasSubmittingRef.current = submitting
  }, [submitting])

  const selectedEntry = selectedMode?.workspaceEntry ?? null
  const providerModels = chatModelOptions.filter(model => model.providerId === chatModel?.providerId)
  const selectedChatModel = providerModels.find(model => model.id === chatModel?.modelId)
  const chatModelUnavailable = Boolean(chatModel && (!acpProviders.some(provider => provider.id === chatModel.providerId && provider.available) ||
    (chatModel.modelId && !chatModelLoading && !selectedChatModel?.available)))
  const workspaceExamples = !workspaceCanOperate ? []
    : selectedEntry === 'smart-cut' ? [t('关闭字幕'), t('撤销剪辑')]
      : selectedEntry === 'ai-podcast' ? [t('语速设为 1.1 倍'), t('更新播客音频')]
        : selectedEntry === 'meeting-notes' ? [t('查看会议总结'), t('查看实时转写')]
        : [t('配音风格设为轻松'), t('开始配音')]
  const attachmentCompatible = workspaceCanOperate || !attachment || !selectedEntry || attachmentMatchesMode(attachment.path, selectedEntry)
  const canSubmit = Boolean(draftPrompt.trim()) && !submitting && !choosingAttachment && attachmentCompatible && !chatModelUnavailable
  const attachmentHelp = !attachmentCompatible && selectedModeId === 'ai-podcast'
    ? t('AI 播客仅支持 PDF、DOCX、TXT 和 Markdown，请更换附件')
    : !attachmentCompatible
      ? t('当前技能不支持这个文件类型，请更换附件或取消技能选择')
      : workspaceCanOperate ? t('可以直接操作右侧界面，也可以告诉 AI 要修改什么。')
      : selectedEntry === 'meeting-notes'
        ? inWorkspace ? t('在右侧开始记录，查看实时转写和会议总结。') : t('会议纪要使用实时音频，请先描述会议目标和记录要求')
        : attachment
          ? t('文件路径会作为上下文发送给 Agent')
          : selectedEntry === 'ai-podcast'
            ? t('可添加 PDF、DOCX、TXT 或 Markdown 文档')
            : selectedEntry === 'smart-cut' || selectedEntry === 'video-dubbing'
              ? t('可添加 MP4、MOV、M4V、WebM 或 MKV 视频')
              : t('可选：添加音频、视频、PDF 或文档作为任务上下文')

  const chooseAttachment = async () => {
    if (choosingAttachment || submitting) return
    const requestId = ++attachmentRequestRef.current
    setChoosingAttachment(true)
    setComposerError(null)
    const filters = selectedModeId === 'ai-podcast'
      ? [{ name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] }]
      : selectedModeId === 'smart-cut' || selectedModeId === 'video-dubbing'
        ? [{ name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] }]
        : [
            { name: t('音频文件'), extensions: [...AUDIO_EXTENSIONS] },
            { name: t('视频文件'), extensions: [...VIDEO_EXTENSIONS] },
            { name: t('文档'), extensions: [...DOCUMENT_EXTENSIONS] },
          ]
    try {
      const selection = await open({
        title: t('添加创作素材'),
        multiple: false,
        directory: false,
        filters,
      })
      if (requestId !== attachmentRequestRef.current) return
      const path = typeof selection === 'string' ? selection : null
      if (path) {
        onAttachmentChange({
          path,
          name: path.split(/[\\/]/u).at(-1) || t('未命名文件'),
        })
      }
    } catch {
      if (requestId === attachmentRequestRef.current) {
        setComposerError(t('无法打开文件选择器，请在桌面端重试'))
      }
    } finally {
      if (requestId === attachmentRequestRef.current) {
        setChoosingAttachment(false)
        promptRef.current?.focus()
      }
    }
  }

  const submitPrompt = () => {
    const trimmed = draftPrompt.trim()
    if (!canSubmit) return
    setComposerError(null)
    followMessagesRef.current = true
    setHasUnreadMessages(false)
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
    try {
      await copyTextToClipboard(content)
      setComposerError(null)
      setCopiedMessageId(message.id)
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = window.setTimeout(() => setCopiedMessageId(null), 1600)
    } catch {
      setComposerError(t('复制失败，请手动选择消息内容'))
    }
  }

  return (
    <main className={`agent-home-view${hasConversation ? ' has-conversation' : ''}${inWorkspace ? ' task-conversation' : ''}`}>
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
        {inWorkspace && (
          <header className="task-conversation-heading">
            <div><MessageSquareText size={15} /><h2>{t('任务对话')}</h2></div>
            <span title={workspaceTitle}>{workspaceTitle}</span>
          </header>
        )}
        {!hasConversation && (
          <header className="agent-home-heading">
            <div className="agent-home-mark"><Sparkles size={23} strokeWidth={1.65} /></div>
            <span>{t('新任务')}</span>
            <h1>{t('今天想创作什么？')}</h1>
            <p>{t('直接和 Agent 对话，让它先理解目标、规划流程、识别需要的模型能力。')}</p>
          </header>
        )}

        <section className="agent-home-chat-panel" aria-label={inWorkspace ? t('任务对话') : t('通用 Agent 对话')}>
          {hasConversation && (
            <div className="agent-conversation-history">
            <div
	              className={`agent-message-list${visibleMessageCount <= 2 ? ' is-short' : ''}`}
              ref={messageListRef}
              role="log"
              aria-label={t('消息记录')}
              aria-live="polite"
              aria-relevant="additions text"
              tabIndex={0}
              onScroll={(event) => {
                const list = event.currentTarget
                const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 64
                followMessagesRef.current = nearBottom
                if (nearBottom) setHasUnreadMessages(false)
              }}
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
	                      {message.action && message.action.kind === 'structured-agent-plan' && (() => {
                        const action = message.action
                        const isRunning = action.status === 'running'
                        const isDone = action.status === 'done'
                        return (
                          <div className={`agent-message-action ${action.status}`}>
                            <div className="agent-message-plan-steps">
                              <div className="agent-plan-header">
                                <ListChecks size={14} />
                                <strong>{t('执行计划')}</strong>
                                <span>{t('{0} 个步骤', [String(action.steps.length)])}</span>
                              </div>
                              <ol className="agent-plan-step-list">
                                {action.steps.map((step, index) => (
                                  <li className={`agent-plan-step ${step.status}`} key={step.id}>
                                    <span className="agent-plan-step-index">{index + 1}</span>
                                    <div className="agent-plan-step-body">
                                      <span className="agent-plan-step-desc">{step.description}</span>
                                      <small className="agent-plan-step-cap">{step.capability}</small>
                                      {step.result && (
                                        <pre className="agent-plan-step-result">{step.result}</pre>
                                      )}
                                    </div>
                                    <span className="agent-plan-step-status">
                                      {step.status === 'running' ? (
                                        <LoaderCircle className="model-spin" size={12} />
                                      ) : step.status === 'done' ? (
                                        <Check size={12} />
                                      ) : step.status === 'failed' ? (
                                        <X size={12} />
                                      ) : null}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                            </div>
                            <button
                              type="button"
                              disabled={submitting || isRunning || isDone}
                              onClick={() => onRunMessageAction(message)}
                            >
                              {isRunning ? (
                                <LoaderCircle className="model-spin" size={14} />
                              ) : isDone ? (
                                <Check size={14} />
                              ) : (
                                <Play size={14} />
                              )}
                              {isDone
                                ? t('已完成')
                                : isRunning
                                  ? t('执行中')
                                  : action.status === 'failed'
                                    ? t('重试')
                                    : t('执行计划')}
                            </button>
                          </div>
                        )
                      })()}
                      {message.action && message.action.kind !== 'structured-agent-plan' && (() => {
	                        const modelOptions = messageModelOptions[message.id]
	                        const expanded = expandedModelChoices.has(message.id)
	                        const choices = modelOptions?.choices ?? []
                          const firstChoices = choices.slice(0, 3)
                          const selectedChoice = choices.find((choice) => choice.id === modelOptions?.selectedModelId)
                          const visibleChoices = expanded
                            ? choices
                            : selectedChoice && !firstChoices.includes(selectedChoice)
                              ? [...firstChoices.slice(0, 2), selectedChoice]
                              : firstChoices
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
	                                      aria-pressed={choice.id === modelOptions.selectedModelId}
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
	                                    aria-expanded={expanded}
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
	                      {copiedMessageId === message.id && <span className="agent-copy-feedback" role="status">{t('已复制')}</span>}
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
            {hasUnreadMessages && (
              <button
                type="button"
                className="agent-jump-to-latest"
                onClick={() => {
                  followMessagesRef.current = true
                  const list = messageListRef.current
                  if (list) list.scrollTop = list.scrollHeight
                  setHasUnreadMessages(false)
                }}
              >
                <ArrowDown size={14} />
                {t('查看最新消息')}
              </button>
            )}
            </div>
          )}

          {acpPermissions.map(event => <section className="agent-acp-permission" key={`${event.sessionId}:${event.requestId}`} aria-label={t('Agent 请求权限')}>
            <strong>{event.title || t('Agent 请求权限')}</strong>
            <div>{event.options?.map(option => <button type="button" key={option.optionId}
              onClick={() => onAcpPermission(event, option.optionId)}>{option.name}</button>)}
              <button type="button" onClick={() => onAcpPermission(event)}>{t('拒绝')}</button>
            </div>
          </section>)}
          <div className="agent-home-composer" aria-busy={submitting}>
            {workspaceExamples.length > 0 && !draftPrompt && (
              <div className="workspace-chat-examples" aria-label={t('试试这样操作')}>
                {workspaceExamples.map(example => <button type="button" key={example} disabled={submitting}
                  onClick={() => { onDraftPromptChange(example); promptRef.current?.focus() }}>
                  {example}
                </button>)}
              </div>
            )}

	            {attachment && !workspaceCanOperate && (
	              <AgentFilePreview
	                compact
	                file={attachment}
	                invalid={!attachmentCompatible}
	                disabled={submitting || choosingAttachment}
	                onRemove={() => {
                    onAttachmentChange(null)
                    setComposerError(null)
                    promptRef.current?.focus()
                  }}
	              />
	            )}
            <textarea
              ref={promptRef}
              rows={2}
              value={draftPrompt}
              disabled={submitting}
              aria-label={t('描述任务')}
              aria-describedby="agent-composer-status agent-composer-keyboard-hint"
              aria-invalid={!attachmentCompatible}
              placeholder={workspaceCanOperate ? t('告诉 AI 怎样修改右侧内容…') : inWorkspace ? t('继续补充任务要求，或与 Agent 讨论…') : t('描述你想完成的音视频任务，例如：把这个视频翻译成中文配音版，并保留原说话节奏')}
              onChange={(event) => onDraftPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                event.preventDefault()
                void submitPrompt()
              }}
            />
            <div className="agent-home-composer-toolbar">
              {!workspaceCanOperate && <button
                type="button"
                className="agent-attach-button"
                disabled={submitting || choosingAttachment || selectedEntry === 'meeting-notes'}
                title={attachmentHelp}
                onClick={() => void chooseAttachment()}
              >
                {choosingAttachment ? <LoaderCircle className="model-spin" size={14} /> : <Paperclip size={14} />}
                {attachment ? t('更换文件') : t('添加文件')}
              </button>}
              {!workspaceCanOperate && <button
                type="button"
                className="agent-install-mode-toggle"
                disabled={submitting}
                title={t('控制缺少开源模型时是先询问还是自动安装')}
                onClick={() =>
                  onModelInstallModeChange(modelInstallMode === 'ask' ? 'auto' : 'ask')
                }
              >
                {t('模型安装：{0}', [modelInstallMode === 'ask' ? t('询问') : t('自动')])}
              </button>}
              <div className="agent-composer-send-controls">
                <div className="agent-chat-model-selectors" role="group" aria-label={t('ACP Agent 与模型')}>
                  <label>
                    <span>Agent</span>
                    <select aria-label={t('ACP Agent')} title={t('ACP Agent')} value={chatModel?.providerId ?? ''} disabled={submitting}
                      onChange={event => {
                        onChatModelChange({ transport: 'acp', providerId: event.target.value, modelId: '' })
                        setComposerError(null)
                      }}>
                      {chatModel && !acpProviders.some(provider => provider.id === chatModel.providerId) &&
                        <option value={chatModel.providerId} disabled>{chatModel.providerId} · {t('不可用')}</option>}
                      {acpProviders.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>
                        {provider.name}{provider.available ? '' : ` · ${t('不可用')}`}
                      </option>)}
                    </select>
                  </label>
                  <label>
                    <span>{t('模型')}</span>
                    <select aria-label={t('Agent 模型')} title={t('Agent 模型')} value={chatModel?.modelId ?? ''}
                      disabled={submitting || !chatModel || chatModelLoading || providerModels.length === 0}
                      onChange={event => {
                        if (chatModel) onChatModelChange({ ...chatModel, modelId: event.target.value })
                        setComposerError(null)
                      }}>
                      <option value="">{chatModelLoading ? t('正在读取…') : t('Agent 默认模型')}</option>
                      {chatModel?.modelId && !selectedChatModel && <option value={chatModel.modelId} disabled>{chatModel.modelId} · {t('不可用')}</option>}
                      {providerModels.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.name}</option>)}
                    </select>
                  </label>
                </div>
              <button
                className="agent-home-submit"
                type="button"
                disabled={!canSubmit && !acpRunning}
                aria-label={acpRunning ? t('停止 Agent 回复') : submitting ? t('正在处理当前任务…') : t('发送给 Agent')}
                title={submitting ? t('正在处理当前任务…') : !attachmentCompatible ? attachmentHelp : t('发送给 Agent')}
                onClick={() => acpRunning ? onCancelAcp() : void submitPrompt()}
              >
                {acpRunning ? <span aria-hidden="true">■</span> : submitting ? <LoaderCircle className="model-spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.2} />}
              </button>
              </div>
            </div>
            {chatModelError && <div className="agent-model-notice" role="status">
              <span>{chatModelError}</span><button type="button" disabled={chatModelLoading || submitting} onClick={onRetryModels}>{t('重试')}</button>
            </div>}
            <div className="agent-home-composer-footer">
              <span
                id="agent-composer-status"
                className={`agent-composer-status${composerError || !attachmentCompatible || chatModelUnavailable ? ' invalid' : ''}`}
                role={composerError || !attachmentCompatible || chatModelUnavailable ? 'alert' : 'status'}
              >
                {composerError ?? (submitting ? t('正在处理当前任务…') : chatModelUnavailable ? t('所选对话模型不可用，请重新选择 Agent 和模型。') : attachmentHelp)}
              </span>
              <span id="agent-composer-keyboard-hint" className="agent-composer-keyboard-hint">
                <kbd>Enter</kbd> {t('发送')}<span aria-hidden="true"> · </span><kbd>Shift + Enter</kbd> {t('换行')}
              </span>
            </div>
          </div>
          {showSkillRow && (
            <div className={`agent-context-row${hasConversation ? ' compact' : ''}`} aria-label={t('技能选择')}>
              {modes.filter(item => item.workspaceEntry !== 'agent-chat').map((item) => {
                const modeId = item.workspaceEntry
                const Icon = MODE_ICONS[modeId]
                const active = modeId === selectedModeId
                return (
                  <button
                    className={`agent-context-chip ${item.tone}${active ? ' active' : ''}`}
                    type="button"
                    key={item.id}
                    disabled={submitting || choosingAttachment}
                    aria-pressed={active}
                    onClick={() => {
                      setComposerError(null)
                      onSelectedModeChange(active ? null : modeId)
                      const preset = TASK_PROMPTS[modeId]
                      if (preset && (!active || draftPrompt === t(preset))) {
                        onDraftPromptChange(active ? '' : t(preset))
                      }
                      promptRef.current?.focus()
                    }}
                  >
                    <Icon size={14} strokeWidth={1.8} />
                    <span>{t(item.name)}</span>
                  </button>
                )
              })}
            </div>
          )}

        </section>


      </section>
    </main>
  )
}
