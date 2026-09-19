import type {
  AgentInstallRegistry,
  AgentInstallationState,
  AgentInstallationStatus,
} from './agentInstallState'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const INSTALLATION_STATUSES: ReadonlySet<AgentInstallationStatus> = new Set([
  'uninstalled',
  'installing',
  'installed',
  'uninstalling',
  'error',
])

type AgentServerRequestType =
  | 'agent-server:ready'
  | 'agent-server:install'
  | 'agent-server:update'
  | 'agent-server:uninstall'

interface ReadyRequest {
  type: 'agent-server:ready'
}

export interface AgentServerCatalogMutation {
  type: Exclude<AgentServerRequestType, 'agent-server:ready'>
  serverId: string
}

type AgentServerRequest = ReadyRequest | AgentServerCatalogMutation

export interface AgentServerCatalogStatus {
  url: string
  available: boolean
  error: string | null
}

export interface AgentServerCatalogConnection {
  ok: true
  sourceUrl: string
  iframeUrl: string
  origin: string
}

export interface AgentServerCatalogConnectionError {
  ok: false
  error: string
}

export interface AgentServerCatalogActions {
  installAgentUi(uiId: string, update?: boolean): Promise<unknown>
  uninstallAgentUi(uiId: string): Promise<void>
  listInstalledAgentUi(): Promise<readonly AgentInstallationState[]>
}

export interface AgentServerCatalogBridgeDependencies {
  registry: Pick<AgentInstallRegistry, 'snapshot' | 'uiIdForServerId'>
  actions: AgentServerCatalogActions
  confirmMutation(
    mutation: AgentServerCatalogMutation,
    uiId: string,
  ): Promise<boolean>
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>
  frame: Pick<HTMLIFrameElement, 'contentWindow'>
  expectedOrigin: string
}

export interface AgentServerCatalogBridge {
  attach(): () => void
  receive(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>): Promise<boolean>
  sendHello(): void
  sendInstallations(): void
}

interface RemoteInstallation {
  serverId: string
  status: AgentInstallationStatus
  error?: string
}

type ParentMessage =
  | { type: 'agent-client:hello'; installations: readonly RemoteInstallation[] }
  | { type: 'agent-client:installations'; installations: readonly RemoteInstallation[] }
  | ({ type: 'agent-client:installed' } & RemoteInstallation)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSafeAgentServerUrl(url: URL): boolean {
  return (
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/'
  )
}

function exactKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(data)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function parseRequest(data: unknown): AgentServerRequest | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const message = data as Record<string, unknown>
  if (message.type === 'agent-server:ready') {
    return exactKeys(message, ['type']) ? { type: 'agent-server:ready' } : null
  }
  if (
    message.type !== 'agent-server:install' &&
    message.type !== 'agent-server:update' &&
    message.type !== 'agent-server:uninstall'
  ) {
    return null
  }
  if (!exactKeys(message, ['type', 'id']) || typeof message.id !== 'string') {
    return null
  }
  return { type: message.type, serverId: message.id }
}

function expectedOrigin(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.origin !== origin || !isSafeAgentServerUrl(new URL(`${parsed.origin}/`))) {
    throw new Error('Agent Server target origin is invalid')
  }
  return parsed.origin
}

function isInstallationStatus(value: unknown): value is AgentInstallationStatus {
  return typeof value === 'string' && INSTALLATION_STATUSES.has(value as AgentInstallationStatus)
}

function isTrustedEvent(
  event: Pick<MessageEvent, 'source' | 'origin'>,
  frame: Pick<HTMLIFrameElement, 'contentWindow'>,
  origin: string,
): boolean {
  return event.source === frame.contentWindow && event.origin === origin
}

function remoteInstallations(
  registry: Pick<AgentInstallRegistry, 'snapshot' | 'uiIdForServerId'>,
): readonly RemoteInstallation[] {
  return registry.snapshot().flatMap((installation) => {
    if (
      !isInstallationStatus(installation.status) ||
      registry.uiIdForServerId(installation.serverId) !== installation.uiId
    ) {
      return []
    }
    return [{
      serverId: installation.serverId,
      status: installation.status,
      ...(installation.status === 'error' && installation.error
        ? { error: installation.error }
        : {}),
    }]
  })
}

function installationFor(
  registry: Pick<AgentInstallRegistry, 'snapshot' | 'uiIdForServerId'>,
  serverId: string,
): RemoteInstallation | null {
  return (
    remoteInstallations(registry).find(
      (installation) => installation.serverId === serverId,
    ) ?? null
  )
}

export function resolveAgentServerCatalogConnection(
  status: AgentServerCatalogStatus,
): AgentServerCatalogConnection | AgentServerCatalogConnectionError {
  if (!status.available) {
    return { ok: false, error: status.error || 'Agent Server is unavailable' }
  }
  try {
    const source = new URL(status.url)
    if (!isSafeAgentServerUrl(source)) {
      return { ok: false, error: 'Agent Server URL is invalid' }
    }
    const embedded = new URL(source.href)
    embedded.searchParams.set('embedded', '1')
    return {
      ok: true,
      sourceUrl: source.href,
      iframeUrl: embedded.href,
      origin: source.origin,
    }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export function createAgentServerCatalogBridge(
  dependencies: AgentServerCatalogBridgeDependencies,
): AgentServerCatalogBridge {
  const origin = expectedOrigin(dependencies.expectedOrigin)
  const mutationQueues = new Map<string, Promise<void>>()

  const post = (message: ParentMessage) => {
    dependencies.frame.contentWindow?.postMessage(message, origin)
  }

  const sendInstallations = () => {
    post({
      type: 'agent-client:installations',
      installations: remoteInstallations(dependencies.registry),
    })
  }

  const sendInstalled = (serverId: string) => {
    const installation = installationFor(dependencies.registry, serverId)
    if (!installation) return
    post({ type: 'agent-client:installed', ...installation })
  }

  const receive = async (
    event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  ): Promise<boolean> => {
    if (!isTrustedEvent(event, dependencies.frame, origin)) return false
    const request = parseRequest(event.data)
    if (!request) return false
    if (request.type === 'agent-server:ready') {
      sendInstallations()
      return true
    }

    const uiId = dependencies.registry.uiIdForServerId(request.serverId)
    if (!uiId) return false

    const previous = mutationQueues.get(request.serverId) ?? Promise.resolve()
    const mutation = previous.then(async () => {
      try {
        if (!await dependencies.confirmMutation(request, uiId)) return
      } catch {
        return
      }

      let nativeMutationFailed = false
      try {
        if (request.type === 'agent-server:uninstall') {
          await dependencies.actions.uninstallAgentUi(uiId)
        } else {
          await dependencies.actions.installAgentUi(
            uiId,
            request.type === 'agent-server:update',
          )
        }
      } catch {
        nativeMutationFailed = true
      }

      if (!nativeMutationFailed) {
        try {
          await dependencies.actions.listInstalledAgentUi()
        } catch {
          // Keep the current trusted snapshot when native rehydration is unavailable.
        }
      }
      sendInstallations()
      sendInstalled(request.serverId)
    })
    const completion = mutation.catch(() => undefined)
    mutationQueues.set(request.serverId, completion)
    void completion.then(() => {
      if (mutationQueues.get(request.serverId) === completion) {
        mutationQueues.delete(request.serverId)
      }
    })
    await completion
    return true
  }

  const onMessage = (event: MessageEvent) => {
    void receive(event)
  }

  return {
    attach() {
      dependencies.eventTarget.addEventListener('message', onMessage)
      return () => dependencies.eventTarget.removeEventListener('message', onMessage)
    },
    receive,
    sendHello() {
      post({
        type: 'agent-client:hello',
        installations: remoteInstallations(dependencies.registry),
      })
    },
    sendInstallations,
  }
}
