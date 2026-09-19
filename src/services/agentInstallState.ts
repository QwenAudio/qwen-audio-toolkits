export interface PythonAgentDescriptor {
  uiId: string
  serverId: string
  title: string
}

export interface AgentUiSession {
  url: string
  title: string
}

export interface NativeInstalledAgent {
  id: string
  title: string
  revision?: string | null
}

export type AgentInstallationStatus =
  | 'uninstalled'
  | 'installing'
  | 'installed'
  | 'uninstalling'
  | 'error'

export interface AgentInstallationState extends PythonAgentDescriptor {
  status: AgentInstallationStatus
  revision?: string
  error?: string
}

export type NativeInstalledAgentLoader = () => Promise<NativeInstalledAgent[]>
export type AgentInstallationListener = (
  snapshot: readonly AgentInstallationState[],
) => void

const ID_PATTERN = /^(?!\.)(?!.*\.\.)[A-Za-z0-9.-]{1,100}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function assertId(id: string, label: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`${label} is invalid`)
  }
}

function assertDescriptor(descriptor: PythonAgentDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('Agent descriptor is required')
  }
  assertId(descriptor.uiId, 'Agent UI ID')
  assertId(descriptor.serverId, 'Agent server ID')
  if (descriptor.uiId === descriptor.serverId) {
    throw new Error('Agent UI ID and server ID must be distinct')
  }
  if (typeof descriptor.title !== 'string' || !descriptor.title.trim()) {
    throw new Error('Agent title is required')
  }
}

function trustedOrigin(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Agent UI session URL is invalid')
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Agent UI session URL must use a loopback HTTP origin')
  }
  return parsed.origin
}

function stateFor(descriptor: PythonAgentDescriptor): AgentInstallationState {
  return { ...descriptor, status: 'uninstalled' }
}

function sameState(
  left: AgentInstallationState,
  right: AgentInstallationState,
): boolean {
  return (
    left.status === right.status &&
    left.revision === right.revision &&
    left.error === right.error
  )
}

export interface AgentInstallRegistry {
  register(descriptor: PythonAgentDescriptor): void
  resolve(uiId: string): Readonly<PythonAgentDescriptor>
  uiIdForServerId(serverId: string): string | undefined
  snapshot(): readonly AgentInstallationState[]
  subscribe(listener: AgentInstallationListener): () => void
  transition(
    uiId: string,
    status: AgentInstallationStatus,
    details?: Pick<AgentInstallationState, 'revision' | 'error'>,
  ): void
  rehydrate(loader: NativeInstalledAgentLoader): Promise<readonly AgentInstallationState[]>
  bindSession(uiId: string, session: AgentUiSession): void
  clearSession(uiId: string): void
  assertSessionUrl(uiId: string, url: string): Readonly<PythonAgentDescriptor>
  assertSession(
    uiId: string,
    session: AgentUiSession,
  ): Readonly<PythonAgentDescriptor>
}

/** Holds trusted local descriptors; remote catalog data never becomes identity. */
export function createAgentInstallRegistry(
  descriptors: readonly PythonAgentDescriptor[] = [],
): AgentInstallRegistry {
  const descriptorsByUiId = new Map<string, PythonAgentDescriptor>()
  const uiIdByServerId = new Map<string, string>()
  const states = new Map<string, AgentInstallationState>()
  const sessions = new Map<string, AgentUiSession>()
  const listeners = new Set<AgentInstallationListener>()

  const snapshot = (): readonly AgentInstallationState[] =>
    [...descriptorsByUiId.keys()].map((uiId) => ({ ...states.get(uiId)! }))

  const notify = () => {
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }

  const resolve = (uiId: string): Readonly<PythonAgentDescriptor> => {
    if (typeof uiId !== 'string') throw new Error('Agent UI ID is invalid')
    const descriptor = descriptorsByUiId.get(uiId)
    if (!descriptor) throw new Error(`Unknown Agent UI ID: ${uiId}`)
    return descriptor
  }

  const register = (descriptor: PythonAgentDescriptor): void => {
    assertDescriptor(descriptor)
    if (descriptorsByUiId.has(descriptor.uiId)) {
      throw new Error(`Duplicate Agent UI ID: ${descriptor.uiId}`)
    }
    if (uiIdByServerId.has(descriptor.serverId)) {
      throw new Error(`Duplicate Agent server ID: ${descriptor.serverId}`)
    }
    const trusted = { ...descriptor, title: descriptor.title.trim() }
    descriptorsByUiId.set(trusted.uiId, trusted)
    uiIdByServerId.set(trusted.serverId, trusted.uiId)
    states.set(trusted.uiId, stateFor(trusted))
  }

  const transition = (
    uiId: string,
    status: AgentInstallationStatus,
    details: Pick<AgentInstallationState, 'revision' | 'error'> = {},
  ): void => {
    const descriptor = resolve(uiId)
    const current = states.get(descriptor.uiId)!
    const next: AgentInstallationState = {
      ...descriptor,
      status,
      ...(status === 'installed' && details.revision
        ? { revision: details.revision }
        : {}),
      ...(status === 'error' && details.error ? { error: details.error } : {}),
    }
    if (sameState(current, next)) return
    states.set(descriptor.uiId, next)
    if (status === 'uninstalled') sessions.delete(descriptor.uiId)
    notify()
  }

  const bindSession = (uiId: string, session: AgentUiSession): void => {
    const descriptor = resolve(uiId)
    if (!session || typeof session.title !== 'string') {
      throw new Error('Agent UI session is invalid')
    }
    trustedOrigin(session.url)
    sessions.set(descriptor.uiId, { ...session })
  }

  for (const descriptor of descriptors) register(descriptor)

  return {
    register,
    resolve,
    uiIdForServerId(serverId) {
      return uiIdByServerId.get(serverId)
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    transition,
    async rehydrate(loader) {
      const installed = await loader()
      const nativeByServerId = new Map<string, NativeInstalledAgent>()
      for (const native of installed) {
        if (!native || typeof native.id !== 'string') continue
        const uiId = uiIdByServerId.get(native.id)
        if (uiId) nativeByServerId.set(native.id, native)
      }
      let changed = false
      for (const descriptor of descriptorsByUiId.values()) {
        const native = nativeByServerId.get(descriptor.serverId)
        const next: AgentInstallationState = native
          ? {
              ...descriptor,
              status: 'installed',
              ...(typeof native.revision === 'string'
                ? { revision: native.revision }
                : {}),
            }
          : stateFor(descriptor)
        const current = states.get(descriptor.uiId)!
        if (!native) sessions.delete(descriptor.uiId)
        if (!sameState(current, next)) {
          states.set(descriptor.uiId, next)
          changed = true
        }
      }
      if (changed) notify()
      return snapshot()
    },
    bindSession,
    clearSession(uiId) {
      sessions.delete(resolve(uiId).uiId)
    },
    assertSessionUrl(uiId, url) {
      const descriptor = resolve(uiId)
      const trusted = sessions.get(descriptor.uiId)
      if (!trusted || trusted.url !== url) {
        throw new Error('Agent UI session is not trusted')
      }
      trustedOrigin(trusted.url)
      return descriptor
    },
    assertSession(uiId, session) {
      const descriptor = resolve(uiId)
      const trusted = sessions.get(descriptor.uiId)
      if (
        !trusted ||
        trusted.url !== session.url ||
        trusted.title !== session.title
      ) {
        throw new Error('Agent UI session is not trusted')
      }
      trustedOrigin(trusted.url)
      return descriptor
    },
  }
}

export const BUILTIN_PYTHON_AGENT_DESCRIPTORS: readonly PythonAgentDescriptor[] = [
  { uiId: 'python.bailian-cosyvoice-v2', serverId: 'bailian-cosyvoice-v2', title: 'CosyVoice v2' },
  { uiId: 'python.bailian-cosyvoice-v3-plus', serverId: 'bailian-cosyvoice-v3-plus', title: 'CosyVoice v3 Plus' },
  { uiId: 'python.bailian-cosyvoice-v35-flash', serverId: 'bailian-cosyvoice-v35-flash', title: 'CosyVoice v3.5 Flash' },
  { uiId: 'python.bailian-cosyvoice-v35-plus', serverId: 'bailian-cosyvoice-v35-plus', title: 'CosyVoice v3.5 Plus' },
  { uiId: 'python.bailian-fun-audio-denoising', serverId: 'bailian-fun-audio-denoising', title: 'Fun Audio Denoising' },
  { uiId: 'python.bailian-funasr-8k-realtime', serverId: 'bailian-funasr-8k-realtime', title: 'FunASR 8k Realtime' },
  { uiId: 'python.bailian-funasr-realtime', serverId: 'bailian-funasr-realtime', title: 'FunASR Realtime' },
  { uiId: 'python.bailian-paraformer-8k-realtime-v2', serverId: 'bailian-paraformer-8k-realtime-v2', title: 'Paraformer 8k Realtime v2' },
  { uiId: 'python.bailian-paraformer-realtime-v2', serverId: 'bailian-paraformer-realtime-v2', title: 'Paraformer Realtime v2' },
  { uiId: 'python.bailian-qwen-audio-asr-filetrans', serverId: 'bailian-qwen-audio-asr-filetrans', title: 'Qwen Audio ASR FileTrans' },
  { uiId: 'python.bailian-qwen-audio-asr-flash', serverId: 'bailian-qwen-audio-asr-flash', title: 'Qwen Audio ASR Flash' },
  { uiId: 'python.bailian-qwen-audio-tts', serverId: 'bailian-qwen-audio-tts', title: 'Qwen Audio TTS' },
  { uiId: 'python.bailian-qwen-audio-tts-plus', serverId: 'bailian-qwen-audio-tts-plus', title: 'Qwen Audio TTS Plus' },
  { uiId: 'python.bailian-qwen3-asr', serverId: 'bailian-qwen3-asr', title: 'Qwen3 ASR' },
  { uiId: 'python.bailian-qwen36-plus', serverId: 'bailian-qwen36-plus', title: 'Qwen 3.6 Plus' },
  { uiId: 'python.bailian-qwen37-plus', serverId: 'bailian-qwen37-plus', title: 'Qwen 3.7 Plus' },
]

export const agentInstallRegistry = createAgentInstallRegistry(
  BUILTIN_PYTHON_AGENT_DESCRIPTORS,
)
