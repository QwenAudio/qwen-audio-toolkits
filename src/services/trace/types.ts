export const TRACE_SCHEMA_VERSION = 1

export type TraceEntry =
  | {
      kind: 'invoke'
      t: number
      seq: number
      command: string
      args: Record<string, unknown> | undefined
      result: unknown
      resultT: number
    }
  | {
      kind: 'invoke-error'
      t: number
      seq: number
      command: string
      args: Record<string, unknown> | undefined
      error: string
      resultT: number
    }
  | {
      kind: 'event'
      t: number
      channel: string
      payload: unknown
    }

export interface TraceManifest {
  schemaVersion: number
  scenarioId: string
  scenarioLabel: string
  appVersion: string
  recordedAt: string
  contractHash: string
  modes: string[]
  conversations: TraceConversationSeed[]
  generalTasks: TraceGeneralTaskSeed[]
  durationMs: number
}

export interface TraceConversationSeed {
  id: string
  mode: string
  title: string
  prompt: string
  sourcePath: string
  videoDubbingMode?: string
  videoDubbingLanguages?: { source: string; target: string }
  videoDubbingStyle?: string
}

export interface TraceGeneralTaskSeed {
  id: string
  title: string
  messages: TraceMessageSeed[]
}

export interface TraceMessageSeed {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface TraceDocument {
  manifest: TraceManifest
  entries: TraceEntry[]
}

export function isTraceEntry(value: unknown): value is TraceEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.t !== 'number' || typeof entry.kind !== 'string') return false
  if (entry.kind === 'event') return typeof entry.channel === 'string'
  if (entry.kind === 'invoke' || entry.kind === 'invoke-error') {
    return typeof entry.seq === 'number' && typeof entry.command === 'string'
  }
  return false
}
