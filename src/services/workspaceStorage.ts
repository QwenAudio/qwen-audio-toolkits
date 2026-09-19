import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'

export const WORKSPACE_STORAGE_KEY = 'qwen-audio-workspace-v1'
export const WORKSPACE_VERSION = 1

const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024
const SAVE_DELAY_MS = 500
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/

type ProjectSnapshot = {
  version: 1
  projectId: string
  kind: string
  updatedAt: number
  state: Record<string, unknown>
}

/** Native workspace_save requires these arrays and the selected task identifier. */
export interface WorkspaceMetadata {
  conversations: Array<Record<string, unknown> & { id: string }>
  generalTasks: Array<Record<string, unknown> & { id: string }>
  selectedId: string | null
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

/** Drop binary and unsafe values while retaining file references for extension projects. */
export function serializableWorkspaceState(value: unknown): unknown {
  let count = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 300_000 || depth > 50) {
      throw new Error(t('项目内容过大，无法自动保存。'))
    }
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item === 'string') return /^(?:blob:|data:)/iu.test(item) ? '' : item
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1) ?? null)
    if (!isRecord(item) || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      return undefined
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, entry] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || /(?:base64|dataurl)$/iu.test(key)) continue
      const next = visit(entry, depth + 1)
      if (next !== undefined) result[key] = next
    }
    return result
  }
  return visit(value, 0)
}

function emptyMetadata(): WorkspaceMetadata {
  return { conversations: [], generalTasks: [], selectedId: null }
}

function emptyDocument(): WorkspaceDocument {
  return { version: WORKSPACE_VERSION, revision: 0, updatedAt: 0, metadata: emptyMetadata(), projects: {} }
}

export function parseWorkspaceDocument(payload: string): WorkspaceDocument {
  if (new TextEncoder().encode(payload).byteLength > MAX_WORKSPACE_BYTES) {
    throw new Error(t('已保存的工作区超过大小限制，原文件已保留。'))
  }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error(t('工作区数据损坏，原文件已保留。'))
  }
  if (!isRecord(value) || value.version !== WORKSPACE_VERSION || !isRecord(value.projects)) {
    throw new Error(t('工作区版本不受支持，原文件已保留。'))
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.updatedAt !== 'number') {
    throw new Error(t('工作区数据损坏，原文件已保留。'))
  }
  const document = value.metadata === undefined ? { ...value, metadata: emptyMetadata() } : value
  if (!isRecord(document.metadata) || !isRecord(document.projects)) {
    throw new Error(t('工作区数据损坏，原文件已保留。'))
  }
  const metadata = document.metadata
  const projects = document.projects
  for (const key of ['conversations', 'generalTasks'] as const) {
    const entries = metadata[key]
    if (!Array.isArray(entries) || entries.length > 2_000 || entries.some((entry) =>
      !isRecord(entry) || typeof entry.id !== 'string' || !KEY_PATTERN.test(entry.id))) {
      throw new Error(t('工作区数据损坏，原文件已保留。'))
    }
  }
  if (metadata.selectedId !== null && (typeof metadata.selectedId !== 'string' || !KEY_PATTERN.test(metadata.selectedId))) {
    throw new Error(t('工作区数据损坏，原文件已保留。'))
  }
  if (Object.keys(projects).length > 8_000) {
    throw new Error(t('工作区数据损坏，原文件已保留。'))
  }
  for (const [key, snapshot] of Object.entries(projects)) {
    if (!isRecord(snapshot) || snapshot.version !== 1 || typeof snapshot.projectId !== 'string' ||
      !KEY_PATTERN.test(snapshot.projectId) || typeof snapshot.kind !== 'string' ||
      !KEY_PATTERN.test(snapshot.kind) || key !== `${snapshot.projectId}:${snapshot.kind}` ||
      typeof snapshot.updatedAt !== 'number' || !isRecord(snapshot.state)) {
      throw new Error(t('项目快照损坏或版本不受支持，原文件已保留。'))
    }
  }
  return serializableWorkspaceState(document) as WorkspaceDocument
}

/** A single queue prevents older extension-editor saves from overwriting newer state. */
export class WorkspaceStore {
  readonly disabled: boolean
  private readonly adapter: WorkspaceAdapter
  private document = emptyDocument()
  private status: WorkspaceSaveStatus
  private listeners = new Set<() => void>()
  private initialized = false
  private initialization: Promise<void> | null = null
  private persistedRevision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null

  constructor(adapter: WorkspaceAdapter, disabled = false) {
    this.adapter = adapter
    this.disabled = disabled
    this.status = { status: disabled ? 'disabled' : 'loading', error: null, savedAt: null, canRetry: false }
  }

  getStatus = (): WorkspaceSaveStatus => this.status
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setStatus(status: WorkspaceSaveStatus['status'], error: string | null = null): void {
    this.status = {
      status,
      error,
      savedAt: this.status.savedAt,
      canRetry: status === 'error',
    }
    this.listeners.forEach((listener) => listener())
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      if (this.disabled) {
        this.initialized = true
        return
      }
      try {
        const payload = await this.adapter.read()
        if (payload !== null) {
          this.document = parseWorkspaceDocument(payload)
          this.persistedRevision = this.document.revision
          this.status.savedAt = this.document.updatedAt || null
        }
        this.initialized = true
        this.setStatus('saved')
      } catch (error) {
        this.initialized = true
        this.setStatus('error', error instanceof Error ? error.message : String(error))
      }
    })()
    return this.initialization
  }

  readProject<T>(projectId: string | undefined, kind: string): T | null {
    if (this.disabled || !projectId || !KEY_PATTERN.test(projectId) || !KEY_PATTERN.test(kind)) return null
    const snapshot = this.document.projects[`${projectId}:${kind}`]
    return snapshot ? structuredClone(snapshot.state) as T : null
  }

  writeProject(projectId: string | undefined, kind: string, value: unknown): void {
    if (this.disabled || !projectId || !this.initialized) return
    try {
      if (!KEY_PATTERN.test(projectId) || !KEY_PATTERN.test(kind)) {
        throw new Error(t('项目标识无效，无法自动保存。'))
      }
      const state = serializableWorkspaceState(value)
      if (!isRecord(state)) throw new Error(t('项目快照格式无效，无法自动保存。'))
      const key = `${projectId}:${kind}`
      if (JSON.stringify(state) === JSON.stringify(this.document.projects[key]?.state)) return
      this.document.projects[key] = { version: 1, projectId, kind, updatedAt: Date.now(), state }
      this.document.revision += 1
      this.document.updatedAt = Date.now()
      this.setStatus('saving')
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush().catch(() => undefined)
        }, SAVE_DELAY_MS)
      }
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.disabled || !this.initialized) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (this.persistedRevision === this.document.revision) return Promise.resolve()
    this.inFlight = (async () => {
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
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }
}

function browserDemoMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')
}

function defaultAdapter(): WorkspaceAdapter {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return {
      read: () => invoke<string | null>('workspace_load'),
      write: (payload) => invoke<void>('workspace_save', { payload }),
    }
  }
  return {
    read: () => window.localStorage.getItem(WORKSPACE_STORAGE_KEY),
    write: (payload) => window.localStorage.setItem(WORKSPACE_STORAGE_KEY, payload),
  }
}

let workspaceStore: WorkspaceStore | null = null

export function getWorkspaceStore(disabled = browserDemoMode()): WorkspaceStore {
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
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return { available: unique, missing: [] }
  }
  const available: string[] = []
  const missing: string[] = []
  for (let offset = 0; offset < unique.length; offset += 256) {
    const result = await invoke<RestoredWorkspaceMedia>('workspace_restore_media', {
      paths: unique.slice(offset, offset + 256),
    })
    available.push(...result.available)
    missing.push(...result.missing)
  }
  return { available, missing }
}
