import { TRACE_SCHEMA_VERSION, isTraceEntry, type TraceDocument, type TraceEntry, type TraceManifest } from './types'
import { activateTrace, invoke, isRecording } from './ipcBridge'

export { isRecording, isReplaying, traceMode } from './ipcBridge'

const TRACE_URL_PREFIX = 'trace://'
let currentAppVersion = ''

export function recordScenarioId(): string | null {
  return urlParam('record')
}

export function replayScenarioId(): string | null {
  return urlParam('replay')
}

function urlParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

/**
 * Boot the trace system from the URL. Must run before any service call.
 * In the browser (no Tauri) replay can still run against bundled traces
 * fetched over HTTP; recording requires the desktop runtime.
 */
export function initTraceSystem(appVersion: string): void {
  currentAppVersion = appVersion
  const recordId = recordScenarioId()
  if (recordId) {
    activateTrace('record', recordId)
    return
  }
  const replayId = replayScenarioId()
  if (replayId) {
    void loadAndActivateReplay(replayId)
  }
}

async function loadAndActivateReplay(scenarioId: string): Promise<void> {
  const doc = await fetchTrace(scenarioId)
  if (doc.manifest.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(`Trace schema v${doc.manifest.schemaVersion} unsupported (expected v${TRACE_SCHEMA_VERSION})`)
  }
  activateTrace('replay', scenarioId)
  const { loadTrace } = await import('./replay')
  loadTrace(doc)
}

async function fetchTrace(scenarioId: string): Promise<TraceDocument> {
  if (isTauriRuntime()) {
    const payload = await invoke<{ manifest: TraceManifest; entries: unknown[] }>(
      'read_recording',
      { scenarioId },
    )
    if (!payload.entries.every(isTraceEntry)) {
      throw new Error('Recording contains invalid entries')
    }
    return { manifest: payload.manifest, entries: payload.entries as TraceEntry[] }
  }
  // Browser dev: fetch from the bundled assets directory
  const response = await fetch(`${TRACE_URL_PREFIX}${scenarioId}/trace.json`)
  if (!response.ok) throw new Error(`Trace ${scenarioId} not found`)
  const manifestResponse = await fetch(`${TRACE_URL_PREFIX}${scenarioId}/manifest.json`)
  const manifest = (await manifestResponse.json()) as TraceManifest
  const entries = (await response.json()) as unknown
  if (!Array.isArray(entries) || !entries.every(isTraceEntry)) {
    throw new Error('Recording contains invalid entries')
  }
  return { manifest, entries: entries as TraceEntry[] }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  )
}

/** Persist the in-memory recording. Desktop-only. */
export async function saveRecording(label: string, modes: string[]): Promise<void> {
  if (!isRecording()) throw new Error('Not recording')
  const { recordingEntries, recordingScenarioId, recordingDurationMs } = await import('./recorder')
  const scenarioId = recordingScenarioId()
  const manifest: TraceManifest = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    scenarioId,
    scenarioLabel: label || scenarioId,
    appVersion: currentAppVersion,
    recordedAt: new Date().toISOString(),
    contractHash: computeContractHash(),
    modes,
    conversations: [],
    generalTasks: [],
    durationMs: recordingDurationMs(),
  }
  await invoke('write_recording', {
    scenarioId,
    payload: { manifest, entries: recordingEntries() },
  })
}

export function computeContractHash(): string {
  // Phase 4 will hash the real service surface; a placeholder keeps the
  // manifest shape stable in the meantime.
  return 'sha256:pending'
}
