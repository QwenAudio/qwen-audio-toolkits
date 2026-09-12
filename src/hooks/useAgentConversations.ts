import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import type {
  AgentConversation,
  AgentCreationMode,
  GeneralAgentActionStatus,
  GeneralAgentAttachment,
  GeneralAgentMessage,
  GeneralAgentMessageAction,
  GeneralAgentStructuredPlanAction,
  GeneralAgentTask,
} from '../domain/agents'
import { DEFAULT_AGENT_MODEL } from '../domain/agentModelSelection'
import { inferAgentMessageAction } from '../domain/agentMessageActions'
import { appendWorkspaceBrief, ensureWorkspaceTaskLink, findWorkspaceGeneralTask } from '../domain/workspaceTaskLink'
import type { WorkspaceTaskLinkSeed } from '../domain/workspaceTaskLink'
import { isLocalGreetingContent, sendGeneralAgentPrompt } from '../services/agent'
import { getWorkspaceStore } from '../services/workspaceStorage'
import { useWorkspaceCloseFlush } from './useProjectAutosave'

type GeneralAgentTaskDraft = {
  selectedModeId?: AgentCreationMode | null
  attachment?: GeneralAgentTask['attachment']
}

type GeneralAgentLocalResponse =
  | string
  | {
      content: string
      action?: GeneralAgentMessageAction
      attachments?: GeneralAgentAttachment[]
    }

function newMessage(
  role: 'user' | 'assistant',
  content: string,
  action?: GeneralAgentMessageAction,
  attachment?: GeneralAgentAttachment | null,
  attachments?: GeneralAgentAttachment[],
): GeneralAgentMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    action,
    attachment,
    attachments,
  }
}

function summarizeTaskTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  if (!compact) return t('未命名任务')
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact
}

export function buildGeneralAgentPromptContent(
  content: string,
  selectedModeName?: string | null,
  attachmentHint = '',
): string {
  const trimmed = content.trim()
  if (isLocalGreetingContent(trimmed)) return trimmed
  const selectedSkillHint = selectedModeName
    ? `\n\n当前用户选择的技能：${selectedModeName}。`
    : ''
  return `${trimmed}${selectedSkillHint}${attachmentHint}`
}

function bringGeneralTaskToFront(
  tasks: GeneralAgentTask[],
  taskId: string,
  patch: Partial<GeneralAgentTask>,
): GeneralAgentTask[] {
  const existing = tasks.find((task) => task.id === taskId)
  if (!existing) return tasks
  const next = { ...existing, ...patch, updatedAt: Date.now() }
  return [next, ...tasks.filter((task) => task.id !== taskId)]
}

export function appendVisibleGeneralUserMessage(
  messages: GeneralAgentMessage[],
  userMessage: GeneralAgentMessage,
  appendUserMessage = true,
): GeneralAgentMessage[] {
  return appendUserMessage ? [...messages, userMessage] : messages
}

export function useAgentConversations(
  initialConversations?: AgentConversation[],
  initialTasks?: GeneralAgentTask[],
) {
  const [store] = useState(() => getWorkspaceStore(initialConversations !== undefined || initialTasks !== undefined))
  const [ready, setReady] = useState(store.disabled)
  const [restored, setRestored] = useState(false)
  const [restoredSelectedId, setRestoredSelectedId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<AgentConversation[]>(
    initialConversations ?? [],
  )
  const [generalTasks, setGeneralTasks] = useState<GeneralAgentTask[]>(
    initialTasks ?? [],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const activeGeneralPromptIdsRef = useRef(new Set<string>())
  const workspaceTaskSeedsRef = useRef(new Map<string, WorkspaceTaskLinkSeed>())
  useWorkspaceCloseFlush()
  useEffect(() => {
    let active = true
    void store.initialize().then((metadata) => {
      if (!active) return
      if (!store.disabled) {
        setConversations(metadata.conversations)
        setGeneralTasks(metadata.generalTasks)
        setSelectedId(metadata.selectedId)
        setRestoredSelectedId(metadata.selectedId)
        setRestored(metadata.conversations.length > 0 || metadata.generalTasks.length > 0)
      }
      setReady(true)
    })
    return () => { active = false }
  }, [store])
  useEffect(() => {
    if (ready) store.writeMetadata({ conversations, generalTasks, selectedId })
  }, [store, ready, conversations, generalTasks, selectedId])
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  )
  const selectedGeneralTask = useMemo(
    () => findWorkspaceGeneralTask(generalTasks, selectedId, selectedConversation),
    [generalTasks, selectedId, selectedConversation],
  )
  const ensureSelectedWorkspaceTask = useCallback(() => {
    if (selectedGeneralTask) return selectedGeneralTask
    if (!selectedConversation || selectedConversation.mode === 'agent-chat') return null
    let seed = workspaceTaskSeedsRef.current.get(selectedConversation.id)
    if (!seed) {
      seed = { taskId: crypto.randomUUID(), messageId: crypto.randomUUID(), now: Date.now() }
      workspaceTaskSeedsRef.current.set(selectedConversation.id, seed)
    }
    const link = ensureWorkspaceTaskLink(selectedConversation, generalTasks, seed)
    if (!link) return null
    setGeneralTasks((current) => current.some((task) => task.id === link.task.id)
      ? current
      : [link.task, ...current])
    setConversations((current) => current.map((conversation) =>
      conversation.id === link.conversation.id && conversation.sourceTaskId !== link.task.id
        ? { ...conversation, sourceTaskId: link.task.id }
        : conversation,
    ))
    return link.task
  }, [generalTasks, selectedConversation, selectedGeneralTask])
  useEffect(() => {
    if (ready) ensureSelectedWorkspaceTask()
  }, [ready, ensureSelectedWorkspaceTask])
  const createConversation = useCallback((draft: Omit<AgentConversation, 'id'>) => {
    const conversation = { ...draft, id: crypto.randomUUID() }
    setConversations((current) => [conversation, ...current])
    setSelectedId(conversation.id)
    return conversation
  }, [])
  const setTaskArchived = useCallback((id: string, archived: boolean) => {
    const conversation = conversations.find(item => item.id === id)
    const sourceId = conversation?.sourceTaskId ?? id
    const linkedIds = new Set(conversations.filter(item => item.id === id || item.sourceTaskId === sourceId).map(item => item.id))
    setConversations(current => current.map(item => linkedIds.has(item.id) ? { ...item, archived } : item))
    setGeneralTasks(current => current.map(item => item.id === sourceId ? { ...item, archived } : item))
  }, [conversations])
  const reportTaskProgress = useCallback((taskId: string, message: string) => {
    if (!message) return
    setGeneralTasks(current => current.map(task => {
      if (task.id !== taskId || task.messages.at(-1)?.content === message) return task
      return { ...task, updatedAt: Date.now(), messages: [...task.messages, newMessage('assistant', message)] }
    }))
  }, [])
  const startNewConversation = useCallback(() => setSelectedId(null), [])
  const createGeneralTask = useCallback((draft: GeneralAgentTaskDraft = {}) => {
    const now = Date.now()
    const task: GeneralAgentTask = {
      id: crypto.randomUUID(),
      kind: 'general',
      title: t('新任务'),
      draftPrompt: '',
      messages: [],
      selectedModeId: draft.selectedModeId ?? null,
      chatModel: { ...DEFAULT_AGENT_MODEL },
      attachment: draft.attachment ?? null,
      createdAt: now,
      updatedAt: now,
      submitting: false,
    }
    setSelectedId(task.id)
    return task
  }, [])
  const ensureGeneralTask = useCallback((draft: GeneralAgentTaskDraft = {}) => {
    const workspaceTask = ensureSelectedWorkspaceTask()
    if (workspaceTask) return workspaceTask
    const task = createGeneralTask(draft)
    setGeneralTasks((current) => [task, ...current])
    return task
  }, [createGeneralTask, ensureSelectedWorkspaceTask])
  const updateGeneralTask = useCallback((
    taskId: string,
    update: Partial<Pick<GeneralAgentTask, 'selectedModeId' | 'attachment' | 'draftPrompt' | 'creationOptions' | 'chatModel'>>,
  ) => {
    setGeneralTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task
        const draftTitle = update.draftPrompt !== undefined && task.messages.length === 0
          ? summarizeTaskTitle(update.draftPrompt)
          : task.title
        return { ...task, ...update, title: draftTitle, updatedAt: Date.now() }
      }),
    )
  }, [])
  const recordWorkspaceBrief = useCallback((
    taskId: string,
    prompt: string,
    attachment?: GeneralAgentAttachment | null,
  ) => {
    const content = prompt.trim()
    if (!content) return
    const message = newMessage('user', content, undefined, attachment)
    setGeneralTasks((current) => current.map((task) => task.id === taskId
      ? appendWorkspaceBrief(task, {
          ...message,
          attachment: attachment === undefined ? task.attachment : attachment,
        })
      : task))
  }, [])
  const updateGeneralMessageActionStatus = useCallback((
    taskId: string,
    messageId: string,
    status: GeneralAgentActionStatus,
  ) => {
    setGeneralTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task
        return {
          ...task,
          updatedAt: Date.now(),
          messages: task.messages.map((message) =>
            message.id === messageId && message.action
              ? { ...message, action: { ...message.action, status } }
              : message,
          ),
        }
      }),
    )
  }, [])
  const updateStructuredPlanStep = useCallback((
    taskId: string,
    messageId: string,
    stepId: string,
    update: { status: GeneralAgentActionStatus; result?: string },
  ) => {
    setGeneralTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task
        return {
          ...task,
          updatedAt: Date.now(),
          messages: task.messages.map((message) => {
            if (message.id !== messageId || message.action?.kind !== 'structured-agent-plan') {
              return message
            }
            const action = message.action as GeneralAgentStructuredPlanAction
            return {
              ...message,
              action: {
                ...action,
                steps: action.steps.map((step) =>
                  step.id === stepId ? { ...step, ...update } : step,
                ),
              },
            }
          }),
        }
      }),
    )
  }, [])
  const submitGeneralPrompt = useCallback(async (request: {
    task: GeneralAgentTask
    content: string
    selectedModeName?: string | null
    attachmentHint?: string
    attachment?: GeneralAgentAttachment | null
    appendUserMessage?: boolean
    localResponse?: () => Promise<GeneralAgentLocalResponse> | GeneralAgentLocalResponse
    agentResponse?: (messages: GeneralAgentMessage[]) => Promise<string>
    onError?: (message: string) => void
  }) => {
    const trimmed = request.content.trim()
    if (!trimmed) return
    if (request.task.submitting || activeGeneralPromptIdsRef.current.has(request.task.id)) return
    activeGeneralPromptIdsRef.current.add(request.task.id)

    const appendUserMessage = request.appendUserMessage !== false
    const userMessage = newMessage('user', trimmed, undefined, request.attachment ?? null)
    const agentMessage: GeneralAgentMessage = {
      ...userMessage,
      content: buildGeneralAgentPromptContent(
        trimmed,
        request.selectedModeName,
        request.attachmentHint,
      ),
    }
    const startedAt = Date.now()
    const agentMessages = [...request.task.messages, agentMessage]

    setGeneralTasks((current) => {
      const task = current.find((candidate) => candidate.id === request.task.id) ?? request.task
      if (!task || task.submitting) return current
      const base = current.some((candidate) => candidate.id === task.id)
        ? current
        : [task, ...current]
      return bringGeneralTaskToFront(base, task.id, {
        draftPrompt: '',
        messages: appendVisibleGeneralUserMessage(task.messages, userMessage, appendUserMessage),
        title: appendUserMessage && task.messages.length === 0
          ? summarizeTaskTitle(trimmed)
          : task.title,
        submitting: true,
        updatedAt: startedAt,
      })
    })

    try {
      const response = request.localResponse
        ? await request.localResponse()
        : { content: request.agentResponse ? await request.agentResponse(agentMessages) : (await sendGeneralAgentPrompt(agentMessages)).text }
      const responseContent = typeof response === 'string' ? response : response.content
      const responseAction =
        typeof response === 'string'
          ? inferAgentMessageAction(responseContent)
          : response.action ?? inferAgentMessageAction(responseContent)
      setGeneralTasks((current) =>
        bringGeneralTaskToFront(current, request.task.id, {
          messages: [
            ...(current.find((task) => task.id === request.task.id)?.messages ?? []),
            newMessage(
              'assistant',
              responseContent || t('Agent 没有返回文本结果，请稍后重试。'),
              responseAction,
              null,
              typeof response === 'string' ? [] : response.attachments,
            ),
          ],
          submitting: false,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const text = t('Agent 调用失败：{0}', [message])
      setGeneralTasks((current) =>
        bringGeneralTaskToFront(current, request.task.id, {
          messages: [
            ...(current.find((task) => task.id === request.task.id)?.messages ?? []),
            newMessage('assistant', text),
          ],
          submitting: false,
        }),
      )
      request.onError?.(text)
    } finally {
      activeGeneralPromptIdsRef.current.delete(request.task.id)
    }
  }, [])

  return {
    ready,
    restored,
    restoredSelectedId,
    conversations,
    generalTasks,
    setTaskArchived,
    reportTaskProgress,
    selectedId,
    selectedConversation,
    selectedGeneralTask,
    createConversation,
    createGeneralTask,
    ensureGeneralTask,
    updateGeneralTask,
    recordWorkspaceBrief,
    updateGeneralMessageActionStatus,
    updateStructuredPlanStep,
    submitGeneralPrompt,
    selectConversation: setSelectedId,
    startNewConversation,
  }
}
