import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Copy,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Languages,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Mic2,
  PackagePlus,
  Play,
  Plus,
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
  GeneralAgentProgressEntry,
} from '../domain/agents'
import {
  agentFileCanPreview,
  agentFileKind,
  agentOutputAttachmentsFromText,
  agentVideoAttachmentsFromText,
  agentVideoThumbnailTime,
  uniqueAgentFiles,
} from '../domain/agentFiles'
import type { OnDemandModelInstallMode } from '../domain/onDemandModels'
import { t, useLocale } from '../i18n'
import { revealInFileManager } from '../services/harness'
import { restoreWorkspaceMedia } from '../services/workspaceStorage'
import type { ModelPlugin, AcpQuestionAnswer, AcpSessionEvent } from '../types'
import './AgentHomeView.css'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'] as const

interface AgentHomeViewProps {
  skills: ModelPlugin[]
  acpPermissions: AcpSessionEvent[]
  onAcpPermission: (event: AcpSessionEvent, optionId?: string) => void
  acpQuestions: AcpSessionEvent[]
  onAcpQuestion: (event: AcpSessionEvent, answers?: AcpQuestionAnswer[]) => void
  acpPlanApprovals: AcpSessionEvent[]
  onAcpPlanApproval: (event: AcpSessionEvent, accepted: boolean) => void
  acpRunning: boolean
  onCancelAcp: () => void
  chatModelUnavailable: boolean
  chatModelOptions: Array<{ id: string; name: string; available: boolean }>
  chatModelId: string
  chatModelDefaultName?: string
  chatModelLoading: boolean
  chatModelLocked: boolean
  onChatModelChange: (modelId: string) => void
  workspaceTitle?: string
  workspaceCanOperate?: boolean
  taskId: string | null
  messages: GeneralAgentMessage[]
  draftPrompt: string
  attachment: { path: string; name: string } | null
  attachments: GeneralAgentAttachment[]
  submitting: boolean
  agentProgress: GeneralAgentProgressEntry[]
  modelInstallMode: OnDemandModelInstallMode
  messageModelOptions: Record<string, GeneralAgentMessageModelOptions>
  selectedModeId: AgentCreationMode | null
  onModelInstallModeChange: (mode: OnDemandModelInstallMode) => void
  chatAvailable: boolean
  onSelectedModeChange: (mode: AgentCreationMode | null) => void
  onDraftPromptChange: (prompt: string) => void
  onAttachmentsChange: (attachments: GeneralAgentAttachment[]) => void
  onSubmitPrompt: (request: {
    content: string
    selectedModeName: string | null
    attachmentHint: string
    attachment: { path: string; name: string } | null
    attachments: GeneralAgentAttachment[]
  }) => void
  onRunMessageAction: (
    message: GeneralAgentMessage,
    modelId?: string | null,
    confirmationSelections?: Record<string, string>,
  ) => void

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

function attachmentsHint(files: GeneralAgentAttachment[]): string {
  if (!files.length) return ''
  const list = files.map((file, index) => `${index + 1}. ${file.name}\n文件路径：${file.path}`).join('\n')
  return `\n\n已选择素材：\n${list}\n请在规划时考虑这些素材，但当前阶段不要直接处理或修改文件。`
}

function attachmentMatchesMode(path: string, mode: AgentCreationMode | null): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  if (!extension) return true
  if (!mode) {
    return true
  }
  return mode === 'meeting-notes'
    ? true
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
  if (kind === 'image') return FileImage
  if (kind === 'video') return FileVideo
  if (kind === 'document') return FileText
  return File
}

function messageContextFiles(messages: GeneralAgentMessage[], index: number): GeneralAgentAttachment[] {
  const previous = messages.slice(0, Math.max(0, index + 1))
  return uniqueAgentFiles(previous.flatMap((item) => [
    item.attachment,
    ...(item.attachments ?? []),
  ]))
}

function messagePreviewFiles(
  message: GeneralAgentMessage,
  contextFiles: GeneralAgentAttachment[] = [],
): GeneralAgentAttachment[] {
  return uniqueAgentFiles([
    message.attachment,
    ...(message.attachments ?? []),
    ...(message.role === 'assistant' ? agentVideoAttachmentsFromText(message.content) : []),
    ...(message.role === 'assistant' ? agentOutputAttachmentsFromText(message.content, contextFiles) : []),
  ])
}

const restoredAgentPreviewFiles = new Set<string>()

function useAgentPreviewSource(file: GeneralAgentAttachment, canPreview: boolean): string {
  const [previewReady, setPreviewReady] = useState(() => canPreview && restoredAgentPreviewFiles.has(file.path))

  useEffect(() => {
    if (!canPreview) {
      setPreviewReady(false)
      return
    }
    if (restoredAgentPreviewFiles.has(file.path)) {
      setPreviewReady(true)
      return
    }
    let active = true
    setPreviewReady(false)
    void restoreWorkspaceMedia([file.path])
      .then(({ available }) => {
        const allowed = available.includes(file.path)
        if (allowed) restoredAgentPreviewFiles.add(file.path)
        if (active) setPreviewReady(allowed)
      })
      .catch(() => {
        if (active) setPreviewReady(false)
      })
    return () => {
      active = false
    }
  }, [canPreview, file.path])

  return canPreview && previewReady ? convertFileSrc(file.path) : ''
}

function useAgentVideoPoster(source: string, enabled: boolean): string {
  const [poster, setPoster] = useState('')

  useEffect(() => {
    if (!enabled || !source) {
      setPoster('')
      return
    }
    let active = true
    let seekingPoster = false
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'

    const clear = () => {
      video.removeAttribute('src')
      video.load()
    }
    const capture = () => {
      if (!active || !video.videoWidth || !video.videoHeight) return
      const targetWidth = Math.min(480, video.videoWidth)
      const targetHeight = Math.max(1, Math.round((targetWidth / video.videoWidth) * video.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const context = canvas.getContext('2d')
      if (!context) return
      try {
        context.drawImage(video, 0, 0, targetWidth, targetHeight)
        setPoster(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        setPoster('')
      }
    }
    video.addEventListener('loadedmetadata', () => {
      const seekTime = agentVideoThumbnailTime(video.duration)
      if (seekTime <= 0) {
        capture()
        return
      }
      try {
        seekingPoster = true
        video.currentTime = seekTime
      } catch {
        seekingPoster = false
        capture()
      }
    }, { once: true })
    video.addEventListener('seeked', () => {
      seekingPoster = false
      capture()
    }, { once: true })
    video.addEventListener('loadeddata', () => {
      if (!seekingPoster) capture()
    }, { once: true })
    video.addEventListener('error', () => {
      if (active) setPoster('')
    }, { once: true })
    setPoster('')
    video.src = source
    video.load()
    return () => {
      active = false
      clear()
    }
  }, [enabled, source])

  return poster
}

function AgentVideoPlayer({ source, name, poster }: { source: string; name: string; poster?: string }) {
  const attemptedSeekRef = useRef(false)
  const previewTimeRef = useRef(0)

  useEffect(() => {
    attemptedSeekRef.current = false
    previewTimeRef.current = 0
  }, [source, poster])

  return (
    <video
      className="agent-file-video-player"
      controls
      preload="metadata"
      playsInline
      poster={poster || undefined}
      src={source}
      aria-label={t('播放视频 {0}', [name])}
      onLoadedMetadata={(event) => {
        if (poster || attemptedSeekRef.current) return
        attemptedSeekRef.current = true
        const video = event.currentTarget
        const seekTime = agentVideoThumbnailTime(video.duration)
        if (seekTime <= 0) return
        try {
          previewTimeRef.current = seekTime
          video.currentTime = seekTime
        } catch {
          previewTimeRef.current = 0
        }
      }}
      onPlay={(event) => {
        const previewTime = previewTimeRef.current
        if (poster || previewTime <= 0) return
        const video = event.currentTarget
        if (Math.abs(video.currentTime - previewTime) <= 0.6) {
          video.currentTime = 0
        }
      }}
    />
  )
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
  const kind = agentFileKind(file)
  const canPreview = agentFileCanPreview(file)
  const source = useAgentPreviewSource(file, canPreview)
  const videoPoster = useAgentVideoPoster(source, kind === 'video' && Boolean(source))
  const hasIconMedia = kind === 'image' && Boolean(source)
  return (
    <div
      className={`agent-file-preview${compact ? ' compact' : ''}${hasIconMedia ? ' has-media' : ''}${invalid ? ' invalid' : ''}`}
      title={file.path}
    >
      <div className={`agent-file-preview-icon ${hasIconMedia ? 'media' : ''}`}>
        {kind === 'image' && source ? (
          <img src={source} alt="" loading="lazy" />
        ) : (
          <Icon size={compact ? 14 : 17} strokeWidth={1.8} />
        )}
      </div>
      <div className="agent-file-preview-body">
        <strong>{file.name}</strong>
        <span>{file.path}</span>
        {kind === 'audio' && source && (
          <audio
            controls
            preload="metadata"
            src={source}
            aria-label={t('播放 {0}', [file.name])}
          />
        )}
        {kind === 'video' && !compact && source && (
          <AgentVideoPlayer source={source} name={file.name} poster={videoPoster} />
        )}
      </div>
      <div className="agent-file-preview-actions">
        <button
          type="button"
          aria-label={t('在访达中显示 {0}', [file.name])}
          disabled={disabled}
          title={t('在访达中显示')}
          onClick={() => void revealInFileManager(file.path).catch(() => undefined)}
        >
          <FolderOpen size={13} />
        </button>
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
    </div>
  )
}

export function AgentHomeView({
  skills,
  acpPermissions = [], onAcpPermission, acpQuestions = [], onAcpQuestion, acpPlanApprovals = [], onAcpPlanApproval, acpRunning, onCancelAcp,
  chatModelUnavailable,
  chatModelOptions,
  chatModelId,
  chatModelDefaultName,
  chatModelLoading,
  chatModelLocked,
  onChatModelChange,
  workspaceTitle,
  workspaceCanOperate = false,
  taskId,
  messages,
  draftPrompt,
  attachment,
  attachments,
  submitting,
  agentProgress,
  modelInstallMode,
  messageModelOptions,
  selectedModeId,
  onModelInstallModeChange,
  onSelectedModeChange,
  onDraftPromptChange,
  onAttachmentsChange,
  onSubmitPrompt,
  onRunMessageAction,
}: AgentHomeViewProps) {
  useLocale()
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [expandedModelChoices, setExpandedModelChoices] = useState<Set<string>>(() => new Set())
  const [confirmationSelections, setConfirmationSelections] = useState<Record<string, Record<string, string>>>({})
  const [acpQuestionSelections, setAcpQuestionSelections] = useState<Record<string, Record<string, string[]>>>({})
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
  const visibleAgentProgress = agentProgress.slice(-5)
  const showSkillRow = !hasConversation && modes.length > 0
  const selectedAttachments = useMemo(
    () => uniqueAgentFiles([
      attachment,
      ...attachments,
    ]),
    [attachment, attachments],
  )
  const selectedAttachmentSignature = selectedAttachments
    .map((file) => `${file.path}\n${file.name}`)
    .join('\n')

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
  }, [draftPrompt, hasConversation, selectedAttachmentSignature, selectedModeId])

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
  const workspaceExamples = !workspaceCanOperate ? []
    : selectedEntry === 'smart-cut' ? [t('关闭字幕'), t('撤销剪辑')]
      : selectedEntry === 'ai-podcast' ? [t('语速设为 1.1 倍'), t('更新播客音频')]
        : selectedEntry === 'meeting-notes' ? [t('查看会议总结'), t('查看实时转写')]
        : [t('配音风格设为轻松'), t('开始配音')]
  const hasModeSpecificAttachments = Boolean(selectedEntry) && selectedAttachments.some(file => !attachmentMatchesMode(file.path, selectedEntry))
  const canSubmit = Boolean(draftPrompt.trim() || selectedAttachments.length > 0) && !submitting && !choosingAttachment && !chatModelUnavailable
  const attachmentHelp = hasModeSpecificAttachments
    ? t('已添加任意文件；当前技能可能只会直接处理其中支持的素材类型。')
    : workspaceCanOperate ? t('可以直接操作右侧界面，也可以告诉 AI 要修改什么。')
      : selectedEntry === 'meeting-notes'
        ? inWorkspace ? t('在右侧开始记录，也可以添加任意文件作为上下文。') : t('可添加任意文件作为会议上下文，也可以先描述会议目标和记录要求')
        : selectedAttachments.length > 0
          ? t('文件路径会作为上下文发送给 Agent')
        : selectedEntry === 'ai-podcast'
            ? t('可添加任意文件；播客工作流会优先处理文档类素材')
            : selectedEntry === 'smart-cut' || selectedEntry === 'video-dubbing'
            ? t('可添加任意文件；视频工作流会优先处理视频类素材')
            : t('可选：添加任意类型文件作为任务上下文')

  const acpInteractiveKey = (event: AcpSessionEvent) =>
    `${event.sessionId}:${event.requestId ?? event.toolCallId ?? event.title ?? 'request'}`

  const toggleAcpQuestionOption = (
    event: AcpSessionEvent,
    questionId: string,
    optionId: string,
    allowMultiple = false,
  ) => {
    const eventKey = acpInteractiveKey(event)
    setAcpQuestionSelections(current => {
      const eventSelections = current[eventKey] ?? {}
      const selected = eventSelections[questionId] ?? []
      const nextQuestion = allowMultiple
        ? selected.includes(optionId)
          ? selected.filter(id => id !== optionId)
          : [...selected, optionId]
        : [optionId]
      return {
        ...current,
        [eventKey]: {
          ...eventSelections,
          [questionId]: nextQuestion,
        },
      }
    })
  }

  const acpQuestionAnswers = (event: AcpSessionEvent): AcpQuestionAnswer[] => {
    const eventSelections = acpQuestionSelections[acpInteractiveKey(event)] ?? {}
    return (event.questions ?? []).map(question => ({
      questionId: question.id,
      selectedOptionIds: eventSelections[question.id] ?? [],
    }))
  }

  const acpQuestionComplete = (event: AcpSessionEvent) => {
    const questions = event.questions ?? []
    return questions.length > 0 && acpQuestionAnswers(event).every(answer => answer.selectedOptionIds.length > 0)
  }

  const chooseAttachment = async () => {
    if (choosingAttachment || submitting) return
    const requestId = ++attachmentRequestRef.current
    setChoosingAttachment(true)
    setComposerError(null)
    try {
      const selection = await open({
        title: t('添加创作素材'),
        multiple: true,
        directory: false,
      })
      if (requestId !== attachmentRequestRef.current) return
      const paths = Array.isArray(selection)
        ? selection
        : typeof selection === 'string'
          ? [selection]
          : []
      if (paths.length) {
        onAttachmentsChange(uniqueAgentFiles([
          ...selectedAttachments,
          ...paths.map((path) => ({
          path,
          name: path.split(/[\\/]/u).at(-1) || t('未命名文件'),
          })),
        ]))
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
    const trimmed = draftPrompt.trim() || messages.find(message => message.role === 'user')?.content || t('请按任务要求处理这个素材。')
    if (!canSubmit) return
    setComposerError(null)
    followMessagesRef.current = true
    setHasUnreadMessages(false)
    onSubmitPrompt({
      content: trimmed,
      selectedModeName: selectedMode ? t(selectedMode.name) : null,
      attachmentHint: attachmentsHint(selectedAttachments),
      attachment: selectedAttachments[0] ?? null,
      attachments: selectedAttachments,
    })
    if (selectedAttachments.length) onAttachmentsChange([])
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
	              {messages.map((message, index) => (
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
                      {messagePreviewFiles(message, messageContextFiles(messages, index)).map((file) => (
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
                          const confirmQuestions = message.action.kind === 'confirm-agent-plan'
                            ? message.action.questions ?? []
                            : []
                          const installQuestion = message.action.kind === 'install-on-demand-model'
                            ? message.action.question
                            : undefined
                          const modelQuestion = modelOptions?.question ?? installQuestion
                          const selectedConfirmOptions = confirmationSelections[message.id] ?? {}
                          const confirmationReady = confirmQuestions.every((question) => selectedConfirmOptions[question.id])
                          const modelOptionsList = modelQuestion?.options ?? []
                          const firstModelOptions = modelOptionsList.slice(0, 3)
                          const defaultModelOptionId = modelOptions?.selectedOptionId ?? (
                            message.action.kind === 'install-on-demand-model'
                              ? message.action.modelId
                              : undefined
                          )
                          const selectedModelOptionId = modelQuestion
                            ? selectedConfirmOptions[modelQuestion.id] ?? defaultModelOptionId
                            : undefined
                          const selectedModelOption = modelOptionsList.find((option) => option.id === selectedModelOptionId)
                          const installModelName = message.action.kind === 'install-on-demand-model'
                            ? selectedModelOption?.label ?? message.action.modelName
                            : ''
                          const visibleModelOptions = expanded
                            ? modelOptionsList
                            : selectedModelOption && !firstModelOptions.includes(selectedModelOption)
                              ? [...firstModelOptions.slice(0, 2), selectedModelOption]
                              : firstModelOptions
	                        const hiddenChoiceCount = modelQuestion
	                          ? Math.max(0, modelQuestion.options.length - visibleModelOptions.length)
	                          : 0
                          const askQuestions = [
                            ...confirmQuestions,
                            ...(modelQuestion
                              ? [{ ...modelQuestion, options: visibleModelOptions }]
                              : []),
                          ]
                          const actionDisabled = submitting ||
                            message.action.status === 'running' ||
                            message.action.status === 'done' ||
                            (confirmQuestions.length > 0 && !confirmationReady) ||
                            (Boolean(modelQuestion) && !selectedModelOptionId)
	                        return (
	                          <div className={`agent-message-action ${message.action.status}`}>
	                            <div className="agent-message-action-head">
	                              <div>
	                                <strong>
	                                  {message.action.kind === 'install-on-demand-model'
	                                    ? installModelName
	                                    : t('需要确认')}
	                                </strong>
	                                <span>
	                                  {message.action.kind === 'install-on-demand-model'
	                                    ? t('用于{0}', [message.action.needLabel])
                                      : askQuestions.length
                                        ? t('请选择 {0} 个确认项', [String(askQuestions.length)])
	                                    : modelOptions
	                                      ? t('选择用于{0}的模型', [modelOptions.needLabel])
	                                      : t('确认后继续')}
	                                </span>
	                              </div>
	                              <button
	                                type="button"
	                                disabled={actionDisabled}
	                                onClick={() => onRunMessageAction(message, selectedModelOptionId, selectedConfirmOptions)}
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
                              {askQuestions.length > 0 && (
                                <div className="agent-confirm-choice-panel" aria-label={t('选择确认项')}>
                                  {askQuestions.map((question) => (
                                    <div className="agent-confirm-choice-group" key={question.id}>
                                      <span>{question.prompt}</span>
                                      <div className="agent-confirm-choice-list">
                                        {question.options.map((option) => (
                                          <button
                                            type="button"
                                            className={(selectedConfirmOptions[question.id] ?? (question.id === modelQuestion?.id ? defaultModelOptionId : undefined)) === option.id ? 'selected' : ''}
                                            aria-pressed={(selectedConfirmOptions[question.id] ?? (question.id === modelQuestion?.id ? defaultModelOptionId : undefined)) === option.id}
                                            disabled={submitting || message.action?.status === 'running' || message.action?.status === 'done'}
                                            key={option.id}
                                            title={option.description}
                                            onClick={() => setConfirmationSelections((current) => ({
                                              ...current,
                                              [message.id]: {
                                                ...(current[message.id] ?? {}),
                                                [question.id]: option.id,
                                              },
                                            }))}
                                          >
                                            <span>{option.label}</span>
                                            {typeof option.installed === 'boolean' && (
                                              <small>{option.installed ? t('已安装') : t('待安装')}</small>
                                            )}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                  {modelQuestion && modelQuestion.options.length > 3 && (
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
	                      {visibleAgentProgress.length > 0 && (
	                        <ol className="agent-progress-list" aria-label={t('Agent 执行进度')}>
	                          {visibleAgentProgress.map((entry) => (
	                            <li key={entry.id} className={`agent-progress-item ${entry.status}`}>
	                              <span className="agent-progress-icon" aria-hidden="true">
	                                {entry.status === 'done'
	                                  ? <Check size={12} />
	                                  : entry.status === 'failed'
	                                    ? <X size={12} />
	                                    : entry.status === 'waiting'
	                                      ? <span className="agent-progress-dot" />
	                                      : <LoaderCircle className="model-spin" size={12} />}
	                              </span>
	                              <span className="agent-progress-copy">
	                                <span className="agent-progress-label">{entry.label}</span>
	                                {entry.detail && <span className="agent-progress-detail">{entry.detail}</span>}
	                              </span>
	                            </li>
	                          ))}
	                        </ol>
	                      )}
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
          {acpQuestions.map(event => {
            const eventKey = acpInteractiveKey(event)
            const eventSelections = acpQuestionSelections[eventKey] ?? {}
            const complete = acpQuestionComplete(event)
            return (
              <section className="agent-acp-interaction" key={eventKey} aria-label={t('Agent 请求选择')}>
                <strong>{event.title || t('Agent 请求选择')}</strong>
                <div className="agent-acp-question-list">
                  {(event.questions ?? []).map(question => (
                    <div className="agent-acp-question" key={question.id}>
                      <span>{question.prompt}</span>
                      <div className="agent-acp-option-list">
                        {question.options.map(option => {
                          const selected = (eventSelections[question.id] ?? []).includes(option.id)
                          return (
                            <button
                              type="button"
                              className={selected ? 'selected' : undefined}
                              key={option.id}
                              onClick={() => toggleAcpQuestionOption(event, question.id, option.id, question.allowMultiple)}
                            >
                              {option.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="agent-acp-actions">
                  <button type="button" disabled={!complete} onClick={() => onAcpQuestion(event, acpQuestionAnswers(event))}>{t('提交选择')}</button>
                  <button type="button" onClick={() => onAcpQuestion(event)}>{t('取消')}</button>
                </div>
              </section>
            )
          })}
          {acpPlanApprovals.map(event => {
            const eventKey = acpInteractiveKey(event)
            const hasPlan = Boolean(event.plan?.length || event.phases?.length)
            return (
              <section className="agent-acp-interaction" key={eventKey} aria-label={t('Agent 请求确认计划')}>
                <strong>{event.title || t('Agent 请求确认计划')}</strong>
                {event.content && <p>{event.content}</p>}
                {hasPlan && (
                  <div className="agent-acp-plan">
                    {event.plan?.length ? (
                      <ul>
                        {event.plan.map((item, index) => <li key={item.id ?? `${index}`}>{item.content}</li>)}
                      </ul>
                    ) : null}
                    {event.phases?.map((phase, index) => (
                      <div className="agent-acp-plan-phase" key={phase.id ?? `${index}`}>
                        <span>{phase.name || t('阶段 {0}', [String(index + 1)])}</span>
                        <ul>
                          {(phase.todos ?? []).map((item, itemIndex) => <li key={item.id ?? `${itemIndex}`}>{item.content}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                <div className="agent-acp-actions">
                  <button type="button" onClick={() => onAcpPlanApproval(event, true)}>{t('批准执行')}</button>
                  <button type="button" onClick={() => onAcpPlanApproval(event, false)}>{t('拒绝')}</button>
                </div>
              </section>
            )
          })}
          <div className="agent-home-composer" aria-busy={submitting}>
            {workspaceExamples.length > 0 && !draftPrompt && (
              <div className="workspace-chat-examples" aria-label={t('试试这样操作')}>
                {workspaceExamples.map(example => <button type="button" key={example} disabled={submitting}
                  onClick={() => { onDraftPromptChange(example); promptRef.current?.focus() }}>
                  {example}
                </button>)}
              </div>
            )}

	            {selectedAttachments.map((file) => (
	              <AgentFilePreview
		                compact
		                file={file}
		                key={`${file.path}-${file.name}`}
		                disabled={submitting || choosingAttachment}
	                onRemove={() => {
                    onAttachmentsChange(selectedAttachments.filter(candidate => candidate.path !== file.path || candidate.name !== file.name))
                    setComposerError(null)
                    promptRef.current?.focus()
                  }}
	              />
	            ))}
            <textarea
              ref={promptRef}
              rows={2}
              value={draftPrompt}
              disabled={submitting}
              aria-label={t('描述任务')}
	              aria-describedby={composerError || chatModelUnavailable || hasModeSpecificAttachments ? 'agent-composer-status' : undefined}
	              aria-invalid={Boolean(composerError)}
              placeholder={workspaceCanOperate ? t('继续补充要求、添加素材，或让 Agent 修改结果…') : inWorkspace ? t('继续补充任务要求，或与 Agent 讨论…') : t('描述你想完成的音视频任务，例如：把这个视频翻译成中文配音版，并保留原说话节奏')}
              onChange={(event) => onDraftPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                event.preventDefault()
                void submitPrompt()
              }}
            />
            <div className="agent-home-composer-toolbar">
              {<button
	                type="button"
	                className="agent-attach-button"
	                disabled={submitting || choosingAttachment}
                aria-label={t('添加文件')}
                title={attachmentHelp}
                onClick={() => void chooseAttachment()}
              >
                {choosingAttachment ? <LoaderCircle className="model-spin" size={14} /> : <Plus size={16} strokeWidth={2.2} />}
              </button>}
              {<button
                type="button"
                className="agent-install-mode-toggle"
                disabled={submitting}
                title={t('控制缺少开源模型时是先询问还是自动安装')}
                onClick={() =>
                  onModelInstallModeChange(modelInstallMode === 'ask' ? 'auto' : 'ask')
                }
              >
                {modelInstallMode === 'ask' ? t('询问') : t('自动')}
              </button>}
              <div className="agent-composer-send-controls">
                <div className="agent-chat-model-selectors">
                  <label>
                    <span>{t('Agent 模型')}</span>
                    <select
                      value={chatModelId}
                      disabled={chatModelLocked || chatModelLoading || chatModelOptions.length === 0}
                      aria-label={t('Agent 模型')}
                      onChange={(event) => onChatModelChange(event.target.value)}
                    >
                      <option value="">
                        {chatModelLoading ? t('正在读取…') : chatModelDefaultName || t('Agent 默认模型')}
                      </option>
                      {chatModelId && !chatModelOptions.some(model => model.id === chatModelId) && (
                        <option value={chatModelId} disabled>{chatModelId} · {t('不可用')}</option>
                      )}
                      {chatModelOptions.map(model => (
                        <option key={model.id} value={model.id} disabled={!model.available}>{model.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              <button
                className="agent-home-submit"
	                type="button"
	                disabled={!canSubmit && !acpRunning}
	                aria-label={acpRunning ? t('停止 Agent 回复') : submitting ? t('正在处理当前任务…') : t('发送给 Agent')}
	                title={submitting ? t('正在处理当前任务…') : hasModeSpecificAttachments ? attachmentHelp : t('发送给 Agent')}
	                onClick={() => acpRunning ? onCancelAcp() : void submitPrompt()}
              >
                {acpRunning ? <span aria-hidden="true">■</span> : submitting ? <LoaderCircle className="model-spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.2} />}
              </button>
              </div>
            </div>
	            {(composerError || chatModelUnavailable || hasModeSpecificAttachments) && (
	              <div className="agent-home-composer-footer">
	                <span
                    id="agent-composer-status"
                    className={`agent-composer-status${composerError || chatModelUnavailable ? ' invalid' : ''}`}
                    role={composerError || chatModelUnavailable ? 'alert' : 'status'}
                  >
	                  {composerError ?? (chatModelUnavailable ? t('所选对话模型不可用，请到设置里的 Agent 设置重新选择。') : attachmentHelp)}
	                </span>
	              </div>
	            )}
          </div>
          {showSkillRow && (
            <div className="agent-context-row" aria-label={t('技能选择')}>
              {modes.map((item) => {
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
