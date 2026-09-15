import type { TraceDocument, TraceEntry } from './types'

type Listener = (payload: unknown) => void

let document: TraceDocument | null = null
let invokeCursor = 0
const listeners = new Map<string, Set<Listener>>()
let schedulerStarted = false
let readyResolvers: Array<() => void> = []
let ready = false

function fingerprint(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(args ?? {})
}

export function loadTrace(next: TraceDocument): void {
  document = next
  invokeCursor = 0
  ready = true
  const pending = readyResolvers
  readyResolvers = []
  for (const resolve of pending) resolve()
  startScheduler()
}

async function waitReady(): Promise<void> {
  if (ready) return
  await new Promise<void>(resolve => readyResolvers.push(resolve))
}

export function traceDocument(): TraceDocument | null {
  return document
}

export async function replayInvoke<T>(
  command: string,
  args: Record<string, unknown> | undefined,
): Promise<T> {
  await waitReady()
  const trace = document
  if (!trace) throw new Error('Replay active but no trace loaded')
  const fp = fingerprint(args)
  const entries = trace.entries
  // Find next unused invoke entry matching (command, fingerprint)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind === 'event') continue
    if (entry.command !== command) continue
    if (i < invokeCursor) continue
    if (fingerprint(entry.args) !== fp) continue
    invokeCursor = i + 1
    // Preserve perceived latency
    const delay = entry.resultT - entry.t
    if (delay > 16) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 2000)))
    if (entry.kind === 'invoke-error') throw new Error(entry.error)
    return structuredClone(entry.result) as T
  }
  throw new Error(
    `Replay mismatch: no recorded entry for ${command} with args ${fp}. ` +
    'The service contract changed; re-record this scenario.',
  )
}

export function addReplayListener<T>(channel: string, handler: (event: { payload: T }) => void): void {
  const set = listeners.get(channel) ?? new Set<Listener>()
  set.add(handler as Listener)
  listeners.set(channel, set)
  startScheduler()
}

export function removeReplayListener(channel: string, handler: unknown): void {
  const set = listeners.get(channel)
  if (!set) return
  set.delete(handler as Listener)
  if (!set.size) listeners.delete(channel)
}

function startScheduler(): void {
  if (schedulerStarted || !ready || !document) return
  schedulerStarted = true
  const events = document.entries.filter(
    (entry): entry is Extract<TraceEntry, { kind: 'event' }> => entry.kind === 'event',
  )
  const startMs = performance.now()
  // Events that already elapsed fire immediately in order.
  const overdue: Array<{ channel: string; payload: unknown }> = []
  for (const event of events) {
    const delay = event.t - (performance.now() - startMs)
    if (delay > 0) {
      setTimeout(() => emit(event.channel, event.payload), delay)
    } else {
      overdue.push(event)
    }
  }
  for (const event of overdue) emit(event.channel, event.payload)
}

function emit(channel: string, payload: unknown): void {
  const set = listeners.get(channel)
  if (!set) return
  const clone = structuredClone(payload)
  for (const listener of set) listener(clone)
}
