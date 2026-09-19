import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createAgentServerCatalogBridge,
  resolveAgentServerCatalogConnection,
} from '../src/services/agentServerCatalogBridge.ts'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'

const [appSource, pluginsViewSource, packageSource, workflowSource, exporterSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/views/PluginsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  readFile(new URL('./export-agent-server-catalog.mjs', import.meta.url), 'utf8'),
])

assert.match(
  packageSource,
  /"agents:export": "tsx scripts\/export-agent-server-catalog\.mjs"/u,
  'the Agent Server catalog export must remain available for the sibling repository',
)
assert.doesNotMatch(
  packageSource,
  /"agents:check":/u,
  'a cross-repository catalog comparison must not be exposed as a local package check',
)
assert.doesNotMatch(
  workflowSource,
  /agents:check/u,
  'CI must not depend on an Agent Server checkout that this repository does not provide',
)
assert.doesNotMatch(
  exporterSource,
  /assert\.equal\(entries\.length,\s*\d+\)/u,
  'the exported catalog total must derive from the current supported model sources',
)

assert.match(
  appSource,
  /shellPage === 'extensions'[\s\S]{0,320}<PluginsView\s+agentRegistry=\{agentInstallRegistry\}\s+installationState=\{pythonAgents\}\s+getAgentServerStatus=\{getAgentServerStatus\}\s+catalogActions=\{agentServerCatalogActions\}\s+category=\{agentCategory\}\s+secondary=\{agentSecondary\}/u,
  'the extensions mount must retain the trusted catalog bridge contract',
)
assert.match(
  pluginsViewSource,
  /agentRegistry: AgentInstallRegistry[\s\S]*installationState: readonly AgentInstallationState\[\][\s\S]*getAgentServerStatus\(\): Promise<AgentServerCatalogStatus>[\s\S]*catalogActions: AgentServerCatalogActions/u,
  'PluginsView must receive its registry, installation state, status callback, and native actions from the shell',
)
assert.doesNotMatch(
  appSource,
  /on(?:Install|Uninstall)Host=/u,
  'the trusted catalog bridge must not restore legacy host mutation callbacks',
)

assert.throws(
  () => createAgentInstallRegistry([
    { uiId: 'python.first', serverId: 'agent.same', title: 'First' },
    { uiId: 'python.second', serverId: 'agent.same', title: 'Second' },
  ]),
  /Duplicate Agent server ID/u,
)

class FakeWindow {
  private readonly listeners = new Set<(event: MessageEvent) => void>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message' && typeof listener === 'function') {
      this.listeners.add(listener as (event: MessageEvent) => void)
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message' && typeof listener === 'function') {
      this.listeners.delete(listener as (event: MessageEvent) => void)
    }
  }

  dispatch(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>): void {
    for (const listener of this.listeners) listener(event as MessageEvent)
  }
}

function frame() {
  const messages: Array<{ data: unknown; origin: string }> = []
  const contentWindow = {
    postMessage(data: unknown, origin: string) {
      messages.push({ data, origin })
    },
  }
  return {
    messages,
    element: { contentWindow } as HTMLIFrameElement,
    source: contentWindow,
  }
}

const connection = resolveAgentServerCatalogConnection({
  url: 'https://agents.example.test',
  available: true,
  error: null,
})
assert.equal(connection.ok, true, 'a healthy native Agent Server status must build the embedded URL')
if (!connection.ok) throw new Error(connection.error)
assert.equal(connection.sourceUrl, 'https://agents.example.test/')
assert.equal(connection.iframeUrl, 'https://agents.example.test/?embedded=1')
assert.equal(connection.origin, 'https://agents.example.test')

const unavailable = resolveAgentServerCatalogConnection({
  url: 'https://agents.example.test',
  available: false,
  error: 'Agent Server is unavailable',
})
assert.deepEqual(
  unavailable,
  { ok: false, error: 'Agent Server is unavailable' },
  'an unavailable native status must not yield an iframe connection',
)

const descriptor = {
  uiId: 'catalog.agent',
  serverId: 'server.catalog',
  title: 'Catalog Agent',
}
assert.throws(
  () => createAgentInstallRegistry([
    descriptor,
    { uiId: 'catalog.other', serverId: descriptor.serverId, title: 'Other Agent' },
  ]),
  /Duplicate Agent server ID/u,
  'remote catalog server IDs must resolve to one trusted Python-agent descriptor',
)

const restartedRegistry = createAgentInstallRegistry([descriptor])
await restartedRegistry.rehydrate(async () => [
  { id: descriptor.serverId, title: descriptor.title, revision: 'rev-1' },
])
assert.deepEqual(
  restartedRegistry.snapshot(),
  [{ ...descriptor, status: 'installed', revision: 'rev-1' }],
  'restart reconciliation must restore a known catalog agent without creating model records',
)

const registry = createAgentInstallRegistry([descriptor])
const installedServerIds = new Set<string>()
const calls: Array<{ method: string; uiId?: string; update?: boolean }> = []
const confirmationRequests: Array<{ type: string; uiId: string }> = []
let mutationsPermitted = false
let blockAgentActions = false
let actionsInFlight = 0
let maximumActionsInFlight = 0
let blockedActionStarted: (() => void) | null = null
const releaseBlockedActions: Array<() => void> = []
let rehydrates = 0
let nativeMutationFailure: string | null = null
const typedActions = {
  async installAgentUi(uiId: string, update = false) {
    actionsInFlight += 1
    maximumActionsInFlight = Math.max(maximumActionsInFlight, actionsInFlight)
    try {
      if (blockAgentActions) {
        blockedActionStarted?.()
        await new Promise<void>((resolve) => releaseBlockedActions.push(resolve))
      }
      calls.push({ method: 'install', uiId, update })
      if (nativeMutationFailure) {
        registry.transition(uiId, 'error', { error: nativeMutationFailure })
        throw new Error(nativeMutationFailure)
      }
      installedServerIds.add(registry.resolve(uiId).serverId)
      return { id: registry.resolve(uiId).serverId, title: 'Catalog Agent' }
    } finally {
      actionsInFlight -= 1
    }
  },
  async uninstallAgentUi(uiId: string) {
    calls.push({ method: 'uninstall', uiId })
    installedServerIds.delete(registry.resolve(uiId).serverId)
  },
  async listInstalledAgentUi() {
    rehydrates += 1
    return registry.rehydrate(async () =>
      [...installedServerIds].map((id) => ({ id, title: 'Catalog Agent' })),
    )
  },
}

const events = new FakeWindow()
const catalogFrame = frame()
const bridge = createAgentServerCatalogBridge({
  registry,
  actions: typedActions,
  confirmMutation: async (request, uiId) => {
    confirmationRequests.push({ type: request.type, uiId })
    return mutationsPermitted
  },
  eventTarget: events,
  frame: catalogFrame.element,
  expectedOrigin: connection.origin,
})
const detach = bridge.attach()

bridge.sendHello()
assert.deepEqual(catalogFrame.messages, [
  {
    data: {
      type: 'agent-client:hello',
      installations: [{ serverId: 'server.catalog', status: 'uninstalled' }],
    },
    origin: 'https://agents.example.test',
  },
])
assert.deepEqual(calls, [], 'loading the catalog must not install or launch an agent')

assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:ready' },
  }),
  true,
)
assert.deepEqual(catalogFrame.messages.at(-1), {
  data: {
    type: 'agent-client:installations',
    installations: [{ serverId: 'server.catalog', status: 'uninstalled' }],
  },
  origin: 'https://agents.example.test',
})

for (const rejected of [
  { source: {}, origin: 'https://agents.example.test', data: { type: 'agent-server:install', id: 'server.catalog' } },
  { source: catalogFrame.source, origin: 'https://other.example.test', data: { type: 'agent-server:install', id: 'server.catalog' } },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: null },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: { type: 'agent-server:ready', extra: true } },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: { type: 'agent-server:install', id: 7 } },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: { type: 'agent-server:install', id: 'server.catalog', kind: 'host' } },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: { type: 'agent-server:install', id: 'server.unknown' } },
  { source: catalogFrame.source, origin: 'https://agents.example.test', data: { type: 'agent-server:launch', id: 'server.catalog' } },
]) {
  assert.equal(await bridge.receive(rejected), false, 'only exact protocol messages from the bound iframe are accepted')
}
assert.deepEqual(calls, [], 'rejected messages must never reach typed install actions')

assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:install', id: 'server.catalog' },
  }),
  true,
)
assert.deepEqual(
  confirmationRequests,
  [{ type: 'agent-server:install', uiId: 'catalog.agent' }],
  'trusted catalog requests must ask the host before installation',
)
assert.deepEqual(calls, [], 'a declined catalog installation must not invoke native actions')
assert.equal(rehydrates, 0, 'a declined catalog installation must not rehydrate state')

mutationsPermitted = true
assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:install', id: 'server.catalog' },
  }),
  true,
)
assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:update', id: 'server.catalog' },
  }),
  true,
)
assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:uninstall', id: 'server.catalog' },
  }),
  true,
)
assert.deepEqual(calls, [
  { method: 'install', uiId: 'catalog.agent', update: false },
  { method: 'install', uiId: 'catalog.agent', update: true },
  { method: 'uninstall', uiId: 'catalog.agent' },
])
assert.equal(rehydrates, 3, 'every accepted mutation must rehydrate installed state')
assert.deepEqual(catalogFrame.messages.slice(-2), [
  {
    data: {
      type: 'agent-client:installations',
      installations: [{ serverId: 'server.catalog', status: 'uninstalled' }],
    },
    origin: 'https://agents.example.test',
  },
  {
    data: {
      type: 'agent-client:installed',
      serverId: 'server.catalog',
      status: 'uninstalled',
    },
    origin: 'https://agents.example.test',
  },
])
assert.ok(
  catalogFrame.messages.every((message) => message.origin === 'https://agents.example.test'),
  'parent messages must use the exact iframe target origin, never a wildcard',
)
assert.doesNotMatch(
  JSON.stringify(catalogFrame.messages),
  /catalog\.agent|session|https:\/\/agents\.example\.test\/\?embedded/u,
  'parent messages must expose only server IDs and installation status',
)

blockAgentActions = true
const firstBlockedAction = new Promise<void>((resolve) => {
  blockedActionStarted = resolve
})
const firstUpdate = bridge.receive({
  source: catalogFrame.source,
  origin: 'https://agents.example.test',
  data: { type: 'agent-server:update', id: 'server.catalog' },
})
const secondUpdate = bridge.receive({
  source: catalogFrame.source,
  origin: 'https://agents.example.test',
  data: { type: 'agent-server:update', id: 'server.catalog' },
})
await firstBlockedAction
await new Promise<void>((resolve) => queueMicrotask(resolve))
assert.equal(
  releaseBlockedActions.length,
  1,
  'catalog mutations for one agent must wait for the prior native action',
)
blockAgentActions = false
for (const release of releaseBlockedActions) release()
await Promise.all([firstUpdate, secondUpdate])
assert.equal(
  maximumActionsInFlight,
  1,
  'catalog mutations must never invoke native agent actions concurrently',
)

nativeMutationFailure = 'Native update failed: disk is full'
assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:update', id: 'server.catalog' },
  }),
  true,
)
assert.equal(
  rehydrates,
  5,
  'a failed native mutation must not immediately rehydrate away its error state',
)
assert.deepEqual(catalogFrame.messages.slice(-2), [
  {
    data: {
      type: 'agent-client:installations',
      installations: [{
        serverId: 'server.catalog',
        status: 'error',
        error: 'Native update failed: disk is full',
      }],
    },
    origin: 'https://agents.example.test',
  },
  {
    data: {
      type: 'agent-client:installed',
      serverId: 'server.catalog',
      status: 'error',
      error: 'Native update failed: disk is full',
    },
    origin: 'https://agents.example.test',
  },
], 'the catalog must receive native mutation errors before any later reconciliation')

nativeMutationFailure = null
assert.equal(
  await bridge.receive({
    source: catalogFrame.source,
    origin: 'https://agents.example.test',
    data: { type: 'agent-server:uninstall', id: 'server.catalog' },
  }),
  true,
)
assert.equal(rehydrates, 6, 'a later queued mutation must still rehydrate native state')
assert.deepEqual(catalogFrame.messages.slice(-1), [{
  data: {
    type: 'agent-client:installed',
    serverId: 'server.catalog',
    status: 'uninstalled',
  },
  origin: 'https://agents.example.test',
}], 'a later successful mutation must recover the catalog from the reported error')

 detach()
events.dispatch({
  source: catalogFrame.source,
  origin: 'https://agents.example.test',
  data: { type: 'agent-server:install', id: 'server.catalog' },
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, 7, 'detaching must stop remote actions')

console.log(JSON.stringify({ status: 'passed', checks: 14 }, null, 2))
