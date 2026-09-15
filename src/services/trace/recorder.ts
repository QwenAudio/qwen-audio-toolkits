import type { InvokeArgs } from '@tauri-apps/api/core'
import type { TraceEntry } from './types'

const entries: TraceEntry[] = []
let startMs = 0
let seq = 0
let scenarioId = ''

export function startRecording(id: string): void {
  scenarioId = id
  entries.length = 0
  seq = 0
  startMs = performance.now()
}

export async function recordInvoke<T>(
  command: string,
  args: InvokeArgs | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const t = Math.round(performance.now() - startMs)
  const entrySeq = ++seq
  try {
    const result = await execute()
    entries.push({
      kind: 'invoke',
      t,
      seq: entrySeq,
      command,
      args: normalize(args),
      result: normalize(result),
      resultT: Math.round(performance.now() - startMs),
    })
    return result
  } catch (error) {
    entries.push({
      kind: 'invoke-error',
      t,
      seq: entrySeq,
      command,
      args: normalize(args),
      error: error instanceof Error ? error.message : String(error),
      resultT: Math.round(performance.now() - startMs),
    })
    throw error
  }
}

export function recordEvent(channel: string, payload: unknown): void {
  if (!entries) return
  entries.push({
    kind: 'event',
    t: Math.round(performance.now() - startMs),
    channel,
    payload: normalize(payload),
  })
}

function normalize(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value instanceof Uint8Array) {
    return { __type: 'uint8array', length: value.length }
  }
  if (typeof value === 'bigint') return { __type: 'bigint', value: String(value) }
  return JSON.parse(JSON.stringify(value ?? null))
}

export function recordingEntries(): TraceEntry[] {
  return entries
}

export function recordingScenarioId(): string {
  return scenarioId
}

export function recordingDurationMs(): number {
  return Math.round(performance.now() - startMs)
}

export function resetRecording(): void {
  entries.length = 0
  seq = 0
}
