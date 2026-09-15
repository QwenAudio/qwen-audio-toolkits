import { invoke as tauriInvoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'
import { startRecording, recordInvoke, recordEvent } from './recorder'
import { replayInvoke } from './replay'

export type TraceMode = 'live' | 'record' | 'replay'

let mode: TraceMode = 'live'

export function traceMode(): TraceMode {
  return mode
}

export function isRecording(): boolean {
  return mode === 'record'
}

export function isReplaying(): boolean {
  return mode === 'replay'
}

export function activateTrace(next: TraceMode, scenarioId: string): void {
  if (mode !== 'live') throw new Error('Trace mode already activated')
  mode = next
  if (next === 'record') startRecording(scenarioId)
}

/**
 * Single choke point for all Tauri IPC. Services import invoke/listen from
 * this module instead of @tauri-apps/api directly so recording and replay can
 * intercept every call without touching call sites.
 */
export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (isRecording()) return recordInvoke<T>(command, args, () => tauriInvoke<T>(command, args))
  if (isReplaying()) return replayInvoke<T>(command, args)
  return tauriInvoke<T>(command, args)
}

export async function listen<T>(
  channel: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isReplaying()) {
    const { addReplayListener, removeReplayListener } = await import('./replay')
    addReplayListener<T>(channel, handler)
    return () => removeReplayListener(channel, handler)
  }
  if (isRecording()) {
    return tauriListen<T>(channel, (event) => {
      recordEvent(channel, event.payload)
      handler(event)
    })
  }
  return tauriListen<T>(channel, handler)
}
