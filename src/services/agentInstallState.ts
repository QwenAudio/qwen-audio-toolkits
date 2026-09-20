export interface PythonAgentDescriptor {
  id: string
  title: string
  description?: string
  version?: string
  category?: string
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

function assertId(id: string, label = 'Agent ID'): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`${label} is invalid`)
  }
}

function assertDescriptor(descriptor: PythonAgentDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('Agent descriptor is required')
  }
  assertId(descriptor.id)
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
    left.id === right.id &&
    left.title === right.title &&
    left.description === right.description &&
    left.version === right.version &&
    left.category === right.category &&
    left.status === right.status &&
    left.revision === right.revision &&
    left.error === right.error
  )
}

export interface AgentInstallRegistry {
  replaceCatalog(descriptors: readonly PythonAgentDescriptor[]): void
  resolve(id: string): Readonly<PythonAgentDescriptor>
  snapshot(): readonly AgentInstallationState[]
  subscribe(listener: AgentInstallationListener): () => void
  transition(
    id: string,
    status: AgentInstallationStatus,
    details?: Pick<AgentInstallationState, 'revision' | 'error'>,
  ): void
  rehydrate(loader: NativeInstalledAgentLoader): Promise<readonly AgentInstallationState[]>
  bindSession(id: string, session: AgentUiSession): void
  clearSession(id: string): void
  assertSessionUrl(id: string, url: string): Readonly<PythonAgentDescriptor>
  assertSession(
    id: string,
    session: AgentUiSession,
  ): Readonly<PythonAgentDescriptor>
}

/** Stores catalog entries delivered by the native ModelScope client, never by remote page code. */
export function createAgentInstallRegistry(
  initialDescriptors: readonly PythonAgentDescriptor[] = [],
): AgentInstallRegistry {
  const descriptors = new Map<string, PythonAgentDescriptor>()
  const states = new Map<string, AgentInstallationState>()
  const sessions = new Map<string, AgentUiSession>()
  const listeners = new Set<AgentInstallationListener>()

  const snapshot = (): readonly AgentInstallationState[] =>
    [...states.values()]
      .map((state) => ({ ...state }))
      .sort((left, right) => left.title.localeCompare(right.title))

  const notify = () => {
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }

  const replaceCatalog = (nextDescriptors: readonly PythonAgentDescriptor[]) => {
    const next = new Map<string, PythonAgentDescriptor>()
    for (const candidate of nextDescriptors) {
      assertDescriptor(candidate)
      if (next.has(candidate.id)) throw new Error(`Duplicate Agent ID: ${candidate.id}`)
      next.set(candidate.id, {
        ...candidate,
        title: candidate.title.trim(),
        description: candidate.description?.trim(),
        version: candidate.version?.trim(),
        category: candidate.category?.trim(),
      })
    }
    let changed = false
    for (const [id, descriptor] of next) {
      const current = states.get(id)
      const replacement: AgentInstallationState = current
        ? {
            ...descriptor,
            status: current.status,
            ...(current.revision ? { revision: current.revision } : {}),
            ...(current.error ? { error: current.error } : {}),
          }
        : stateFor(descriptor)
      if (!current || !sameState(current, replacement)) {
        states.set(id, replacement)
        changed = true
      }
    }
    for (const [id, state] of states) {
      if (!next.has(id) && state.status === 'uninstalled') {
        states.delete(id)
        sessions.delete(id)
        changed = true
      }
    }
    descriptors.clear()
    for (const [id, descriptor] of next) descriptors.set(id, descriptor)
    if (changed) notify()
  }

  const resolve = (id: string): Readonly<PythonAgentDescriptor> => {
    if (typeof id !== 'string') throw new Error('Agent ID is invalid')
    const descriptor = descriptors.get(id)
    if (!descriptor) throw new Error(`Unknown Agent ID: ${id}`)
    return descriptor
  }

  const transition = (
    id: string,
    status: AgentInstallationStatus,
    details: Pick<AgentInstallationState, 'revision' | 'error'> = {},
  ): void => {
    const descriptor = resolve(id)
    const current = states.get(descriptor.id) ?? stateFor(descriptor)
    const next: AgentInstallationState = {
      ...descriptor,
      status,
      ...(status === 'installed' && details.revision
        ? { revision: details.revision }
        : status === 'installed' && current.revision
          ? { revision: current.revision }
          : {}),
      ...(status === 'error' && details.error ? { error: details.error } : {}),
    }
    if (sameState(current, next)) return
    states.set(descriptor.id, next)
    if (status === 'uninstalled') sessions.delete(descriptor.id)
    notify()
  }

  for (const descriptor of initialDescriptors) {
    assertDescriptor(descriptor)
    descriptors.set(descriptor.id, { ...descriptor, title: descriptor.title.trim() })
    states.set(descriptor.id, stateFor(descriptor))
  }

  return {
    replaceCatalog,
    resolve,
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    transition,
    async rehydrate(loader) {
      const installed = await loader()
      const nativeById = new Map<string, NativeInstalledAgent>()
      for (const native of installed) {
        if (!native || typeof native.id !== 'string' || !ID_PATTERN.test(native.id)) continue
        nativeById.set(native.id, native)
        if (!descriptors.has(native.id)) {
          const descriptor = { id: native.id, title: native.title?.trim() || native.id }
          descriptors.set(native.id, descriptor)
          states.set(native.id, stateFor(descriptor))
        }
      }
      let changed = false
      for (const [id, descriptor] of descriptors) {
        const native = nativeById.get(id)
        const current = states.get(id) ?? stateFor(descriptor)
        const next = native
          ? {
              ...descriptor,
              title: descriptor.title || native.title,
              status: 'installed' as const,
              ...(typeof native.revision === 'string' ? { revision: native.revision } : {}),
            }
          : stateFor(descriptor)
        if (!native) sessions.delete(id)
        if (!sameState(current, next)) {
          states.set(id, next)
          changed = true
        }
      }
      if (changed) notify()
      return snapshot()
    },
    bindSession(id, session) {
      const descriptor = resolve(id)
      if (!session || typeof session.title !== 'string') {
        throw new Error('Agent UI session is invalid')
      }
      trustedOrigin(session.url)
      sessions.set(descriptor.id, { ...session })
    },
    clearSession(id) {
      sessions.delete(resolve(id).id)
    },
    assertSessionUrl(id, url) {
      const descriptor = resolve(id)
      const trusted = sessions.get(descriptor.id)
      if (!trusted || trusted.url !== url) {
        throw new Error('Agent UI session is not trusted')
      }
      trustedOrigin(trusted.url)
      return descriptor
    },
    assertSession(id, session) {
      const descriptor = resolve(id)
      const trusted = sessions.get(descriptor.id)
      if (!trusted || trusted.url !== session.url || trusted.title !== session.title) {
        throw new Error('Agent UI session is not trusted')
      }
      trustedOrigin(trusted.url)
      return descriptor
    },
  }
}

export const agentInstallRegistry = createAgentInstallRegistry()
