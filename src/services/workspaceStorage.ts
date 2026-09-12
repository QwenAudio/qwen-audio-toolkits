import { invoke } from '@tauri-apps/api/core'
import type { AgentConversation, GeneralAgentMessage, GeneralAgentTask } from '../domain/agents'
import { t } from '../i18n'

export const WORKSPACE_STORAGE_KEY = 'qwen-audio-workspace-v1'
export const WORKSPACE_VERSION = 1
const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024
const SAVE_DELAY_MS = 500
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/
const MODES = new Set(['smart-cut', 'ai-podcast', 'video-dubbing', 'meeting-notes', 'agent-chat'])
const ACTION_STATUSES = new Set(['pending', 'running', 'done', 'failed'])

export interface WorkspaceMetadata {
  conversations: AgentConversation[]
  generalTasks: GeneralAgentTask[]
  selectedId: string | null
}

interface ProjectSnapshot {
  version: 1
  projectId: string
  kind: string
  updatedAt: number
  state: Record<string, unknown>
}

export interface WorkspaceDocument {
  version: 1
  revision: number
  updatedAt: number
  metadata: WorkspaceMetadata
  projects: Record<string, ProjectSnapshot>
}

export interface WorkspaceSaveStatus {
  status: 'loading' | 'saving' | 'saved' | 'error' | 'disabled'
  error: string | null
  savedAt: number | null
  canRetry: boolean
}

export interface WorkspaceAdapter {
  read(): string | null | Promise<string | null>
  write(payload: string): void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAttachment(value: unknown): boolean {
  return value == null || (isRecord(value) && typeof value.path === 'string' && typeof value.name === 'string')
}

function validAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || !ACTION_STATUSES.has(String(value.status))) return false
  if (value.kind === 'confirm-agent-plan') return typeof value.label === 'string' && typeof value.confirmationText === 'string'
  if (value.kind === 'install-on-demand-model') return ['modelId', 'modelName', 'capability', 'needLabel', 'actionLabel', 'prompt', 'attachmentHint'].every((key) => typeof value[key] === 'string') &&
    (value.selectedModeName === null || typeof value.selectedModeName === 'string') && isAttachment(value.attachment)
  if (value.kind !== 'structured-agent-plan' || typeof value.confirmationText !== 'string') return false
  return Array.isArray(value.steps) && value.steps.every((step) =>
    isRecord(step) && typeof step.id === 'string' && typeof step.description === 'string' &&
    typeof step.capability === 'string' && ACTION_STATUSES.has(String(step.status)) &&
    (step.result === undefined || typeof step.result === 'string') &&
    (step.modelPreference === undefined || (Array.isArray(step.modelPreference) && step.modelPreference.every((id) => typeof id === 'string'))) &&
    (step.parameters === undefined || isRecord(step.parameters)))
}

function validMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || !['user', 'assistant'].includes(String(value.role)) ||
    typeof value.content !== 'string' || typeof value.createdAt !== 'number' || !isAttachment(value.attachment)) return false
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || !value.attachments.every((attachment) => attachment !== null && isAttachment(attachment)))) return false
  if (value.action !== undefined && !validAction(value.action)) return false
  return true
}

function validConversation(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && KEY_PATTERN.test(value.id) &&
    MODES.has(String(value.mode)) && typeof value.title === 'string' &&
    typeof value.prompt === 'string' && typeof value.sourcePath === 'string' && validCreationOptions(value)
}

function validGeneralTask(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && KEY_PATTERN.test(value.id) && value.kind === 'general' &&
    typeof value.title === 'string' && typeof value.draftPrompt === 'string' &&
    typeof value.submitting === 'boolean' && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number' &&
    (value.selectedModeId === null || MODES.has(String(value.selectedModeId))) && isAttachment(value.attachment) &&
    validCreationOptions(value.creationOptions) &&
    (value.chatModel == null || (isRecord(value.chatModel) &&
      typeof value.chatModel.providerId === 'string' && value.chatModel.providerId.length > 0 &&
      typeof value.chatModel.modelId === 'string' &&
      (value.chatModel.transport === undefined || value.chatModel.transport === 'acp'))) &&
    Array.isArray(value.messages) && value.messages.length <= 10_000 && value.messages.every(validMessage)
}

function validCreationOptions(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return (value.videoDubbingMode === undefined || ['translate', 'rewrite', 'script'].includes(String(value.videoDubbingMode))) &&
    (value.videoDubbingStyle === undefined || ['natural', 'formal', 'casual'].includes(String(value.videoDubbingStyle))) &&
    (value.videoDubbingLanguages === undefined || (isRecord(value.videoDubbingLanguages) &&
      typeof value.videoDubbingLanguages.source === 'string' && typeof value.videoDubbingLanguages.target === 'string'))
}

/** Drop ephemeral media and binary values; references to files remain recoverable. */
export function serializableWorkspaceState(value: unknown): unknown {
  let count = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 300_000 || depth > 50) throw new Error(t('项目内容过大，无法自动保存。'))
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item === 'string') return /^(?:blob:|data:)/i.test(item) ? '' : item
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1) ?? null)
    if (!isRecord(item) || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) return undefined
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, entry] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || /(?:base64|dataurl)$/i.test(key)) continue
      const next = visit(entry, depth + 1)
      if (next !== undefined) result[key] = next
    }
    return result
  }
  return visit(value, 0)
}

function emptyDocument(): WorkspaceDocument {
  return { version: WORKSPACE_VERSION, revision: 0, updatedAt: 0, metadata: { conversations: [], generalTasks: [], selectedId: null }, projects: {} }
}

/** Validate the envelope before allowing any recovered data into the UI. */
export function parseWorkspaceDocument(payload: string): WorkspaceDocument {
  if (new TextEncoder().encode(payload).byteLength > MAX_WORKSPACE_BYTES) throw new Error(t('已保存的工作区超过大小限制，原文件已保留。'))
  let value: unknown
  try { value = JSON.parse(payload) }
  catch { throw new Error(t('工作区数据损坏，原文件已保留。')) }
  if (!isRecord(value) || value.version !== WORKSPACE_VERSION) throw new Error(t('工作区版本不受支持，原文件已保留。'))
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.updatedAt !== 'number' || !isRecord(value.metadata) || !isRecord(value.projects)) throw new Error(t('工作区数据损坏，原文件已保留。'))
  const metadata = value.metadata
  if (!Array.isArray(metadata.conversations) || metadata.conversations.length > 2_000 || !metadata.conversations.every(validConversation) ||
    !Array.isArray(metadata.generalTasks) || metadata.generalTasks.length > 2_000 || !metadata.generalTasks.every(validGeneralTask) ||
    (metadata.selectedId !== null && typeof metadata.selectedId !== 'string') || Object.keys(value.projects).length > 8_000) throw new Error(t('工作区数据损坏，原文件已保留。'))
  const ids = [...metadata.conversations, ...metadata.generalTasks].map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw new Error(t('工作区任务标识重复，原文件已保留。'))
  for (const [key, snapshot] of Object.entries(value.projects)) {
    if (!isRecord(snapshot) || snapshot.version !== 1 || typeof snapshot.projectId !== 'string' || !KEY_PATTERN.test(snapshot.projectId) ||
      typeof snapshot.kind !== 'string' || !KEY_PATTERN.test(snapshot.kind) || key !== `${snapshot.projectId}:${snapshot.kind}` ||
      typeof snapshot.updatedAt !== 'number' || !isRecord(snapshot.state)) throw new Error(t('项目快照损坏或版本不受支持，原文件已保留。'))
  }
  return serializableWorkspaceState(value) as WorkspaceDocument
}

/** Recover an interrupted session without replaying model calls or editor work. */
export function restoreWorkspaceMetadata(metadata: WorkspaceMetadata): WorkspaceMetadata {
  const interruptedText = t('上次任务因应用关闭而中断。已保留现有内容，请重新发送需求或重试未完成的步骤。')
  const generalTasks = metadata.generalTasks.map((task) => {
    let interrupted = task.submitting
    const messages = task.messages.map((message) => {
      if (!message.action) return message
      const action = { ...message.action }
      if (action.status === 'running') { action.status = 'failed'; interrupted = true }
      if (action.kind === 'structured-agent-plan') {
        action.steps = action.steps.map((step) => {
          if (step.status !== 'running') return step
          interrupted = true
          return { ...step, status: 'failed' as const, result: interruptedText }
        })
      }
      return { ...message, action }
    })
    if (interrupted) messages.push({ id: `interrupted-${task.id}-${task.updatedAt}`, role: 'assistant', content: interruptedText, createdAt: Date.now() } as GeneralAgentMessage)
    return { ...task, submitting: false, messages }
  })
  const conversations = metadata.conversations.map((conversation) => ({ ...conversation, restored: true }))
  const selectedId = [...conversations, ...generalTasks].some((item) => item.id === metadata.selectedId) ? metadata.selectedId : null
  return { conversations, generalTasks, selectedId }
}

/** One queue owns all metadata and editor writes so slower saves cannot win. */
export class WorkspaceStore {
  private adapter: WorkspaceAdapter
  readonly disabled: boolean
  private document = emptyDocument()
  private status: WorkspaceSaveStatus
  private listeners = new Set<() => void>()
  private initialization: Promise<WorkspaceMetadata> | null = null
  private initialized = false
  private blocked = false
  private persistedRevision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private validationErrors = new Map<string, string>()

  constructor(adapter: WorkspaceAdapter, disabled = false) {
    this.adapter = adapter
    this.disabled = disabled
    this.status = { status: disabled ? 'disabled' : 'loading', error: null, savedAt: null, canRetry: false }
  }

  getStatus = (): WorkspaceSaveStatus => this.status
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getMetadata = (): WorkspaceMetadata => this.document.metadata

  private setStatus(status: WorkspaceSaveStatus['status'], error: string | null = null) {
    if (this.validationErrors.size > 0 && status !== 'loading' && status !== 'disabled') {
      status = 'error'
      error = this.validationErrors.values().next().value ?? error
    }
    this.status = { status, error, savedAt: this.status.savedAt, canRetry: status === 'error' && !this.blocked && this.validationErrors.size === 0 }
    this.listeners.forEach((listener) => listener())
  }

  initialize(): Promise<WorkspaceMetadata> {
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      if (this.disabled) { this.initialized = true; return this.document.metadata }
      try {
        let normalized = false
        const payload = await this.adapter.read()
        if (payload !== null) {
          this.document = parseWorkspaceDocument(payload)
          this.persistedRevision = this.document.revision
          this.status.savedAt = this.document.updatedAt || null
          const metadata = restoreWorkspaceMetadata(this.document.metadata)
          normalized = JSON.stringify(metadata) !== JSON.stringify(this.document.metadata)
          this.document.metadata = metadata
        }
        this.initialized = true
        this.setStatus('saved')
        if (normalized) this.changed()
      } catch (error) {
        // Do not silently replace unreadable data with a new empty workspace.
        this.blocked = true
        this.initialized = true
        this.setStatus('error', error instanceof Error ? error.message : String(error))
      }
      return this.document.metadata
    })()
    return this.initialization
  }

  readProject<T>(projectId: string | undefined, kind: string): T | null {
    if (this.disabled || !projectId || !KEY_PATTERN.test(projectId) || !KEY_PATTERN.test(kind)) return null
    const snapshot = this.document.projects[`${projectId}:${kind}`]
    return snapshot ? structuredClone(snapshot.state) as T : null
  }

  writeMetadata(metadata: WorkspaceMetadata): void {
    if (this.disabled || !this.initialized) return
    try {
      const state = serializableWorkspaceState(metadata) as WorkspaceMetadata
      const clearedError = this.validationErrors.delete('metadata')
      if (JSON.stringify(state) === JSON.stringify(this.document.metadata)) {
        if (clearedError && !this.blocked) {
          this.setStatus(this.persistedRevision === this.document.revision ? 'saved' : 'saving')
          if (this.persistedRevision !== this.document.revision) void this.flush().catch(() => {})
        }
        return
      }
      this.document.metadata = state
      this.changed()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.validationErrors.set('metadata', message)
      this.setStatus('error', message)
    }
  }

  writeProject(projectId: string | undefined, kind: string, value: unknown): void {
    if (this.disabled || !projectId || !this.initialized) return
    try {
      if (!KEY_PATTERN.test(projectId) || !KEY_PATTERN.test(kind)) throw new Error(t('项目标识无效，无法自动保存。'))
      const state = serializableWorkspaceState(value)
      if (!isRecord(state)) throw new Error(t('项目快照格式无效，无法自动保存。'))
      const key = `${projectId}:${kind}`
      const clearedError = this.validationErrors.delete(key)
      if (JSON.stringify(state) === JSON.stringify(this.document.projects[key]?.state)) {
        if (clearedError && !this.blocked) {
          this.setStatus(this.persistedRevision === this.document.revision ? 'saved' : 'saving')
          if (this.persistedRevision !== this.document.revision) void this.flush().catch(() => {})
        }
        return
      }
      this.document.projects[key] = { version: 1, projectId, kind, updatedAt: Date.now(), state }
      this.changed()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.validationErrors.set(`${projectId}:${kind}`, message)
      this.setStatus('error', message)
    }
  }

  private changed(): void {
    this.document.revision += 1
    this.document.updatedAt = Date.now()
    if (this.blocked) return
    this.setStatus('saving')
    // Bound the wait from the first dirty update. Live transcripts and playback
    // can keep changing indefinitely, so restarting a trailing timer can lose
    // an entire session if the process exits unexpectedly.
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {}) }, SAVE_DELAY_MS)
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.disabled || !this.initialized) return Promise.resolve()
    if (this.validationErrors.size > 0 || (this.blocked && this.document.revision !== this.persistedRevision)) return Promise.reject(new Error(this.status.error ?? t('工作区尚未保存，请先解决保存错误。')))
    if (this.blocked) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (this.persistedRevision === this.document.revision) return Promise.resolve()
    this.inFlight = this.drain().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async drain(): Promise<void> {
    try {
      while (this.persistedRevision !== this.document.revision) {
        const revision = this.document.revision
        const payload = JSON.stringify(this.document)
        parseWorkspaceDocument(payload)
        this.setStatus('saving')
        await this.adapter.write(payload)
        this.persistedRevision = revision
      }
      this.status.savedAt = this.document.updatedAt
      this.setStatus('saved')
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

function browserDemoMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')
}

function defaultAdapter(): WorkspaceAdapter {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return { read: () => invoke<string | null>('workspace_load'), write: (payload) => invoke<void>('workspace_save', { payload }) }
  }
  return { read: () => window.localStorage.getItem(WORKSPACE_STORAGE_KEY), write: (payload) => window.localStorage.setItem(WORKSPACE_STORAGE_KEY, payload) }
}

let workspaceStore: WorkspaceStore | null = null

export function getWorkspaceStore(disabled = browserDemoMode()): WorkspaceStore {
  // The conversation hook chooses demo isolation before mounting any editor.
  if (!workspaceStore) workspaceStore = new WorkspaceStore(defaultAdapter(), disabled)
  return workspaceStore
}

export function readProjectSnapshot<T>(projectId: string | undefined, kind: string): T | null {
  return getWorkspaceStore().readProject<T>(projectId, kind)
}

export function writeProjectSnapshot(projectId: string | undefined, kind: string, state: unknown): void {
  getWorkspaceStore().writeProject(projectId, kind, state)
}

export function flushWorkspace(): Promise<void> {
  return getWorkspaceStore().flush()
}

export interface RestoredWorkspaceMedia {
  available: string[]
  missing: string[]
}

export async function restoreWorkspaceMedia(paths: string[]): Promise<RestoredWorkspaceMedia> {
  const unique = [...new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))]
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return { available: unique, missing: [] }
  // Chunk long podcasts while keeping each native IPC request bounded.
  const available: string[] = []
  const missing: string[] = []
  for (let offset = 0; offset < unique.length; offset += 256) {
    const result = await invoke<RestoredWorkspaceMedia>('workspace_restore_media', { paths: unique.slice(offset, offset + 256) })
    available.push(...result.available)
    missing.push(...result.missing)
  }
  return { available, missing }
}
