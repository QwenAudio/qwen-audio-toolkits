import assert from 'node:assert/strict'
import * as agentModelSelection from '../src/domain/agentModelSelection'
import { inspectAcpModels } from '../src/services/acp'
import { requestAcpConversation, type acpConversationTransport } from '../src/services/acpConversation'
import type { AcpSessionEvent } from '../src/types'
import { parseAcpModelCatalog } from '../src/domain/acpModels'

const { DEFAULT_AGENT_MODEL, resolveAcpSelection } = agentModelSelection
const preferenceApi = agentModelSelection as typeof agentModelSelection & {
  loadAgentModelPreference?: (storage: Pick<Storage, 'getItem'>) => typeof DEFAULT_AGENT_MODEL
  saveAgentModelPreference?: (selection: typeof DEFAULT_AGENT_MODEL, storage: Pick<Storage, 'setItem'>) => void
  initialAgentModelSelection?: (selection: typeof DEFAULT_AGENT_MODEL) => typeof DEFAULT_AGENT_MODEL
}
assert.equal(typeof preferenceApi.loadAgentModelPreference, 'function', 'Agent settings must load the preferred selection')
assert.equal(typeof preferenceApi.saveAgentModelPreference, 'function', 'Agent settings must persist the preferred selection')
assert.equal(typeof preferenceApi.initialAgentModelSelection, 'function', 'new conversations must inherit the preferred selection')
if (!preferenceApi.loadAgentModelPreference || !preferenceApi.saveAgentModelPreference || !preferenceApi.initialAgentModelSelection) {
  throw new Error('missing Agent model preference persistence')
}
const preferenceStorage = new Map<string, string>()
const storage = {
  getItem: (key: string) => preferenceStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { preferenceStorage.set(key, value) },
}
const preferredSelection = {
  transport: 'acp' as const,
  providerId: 'opencode-bundled',
  apiProviderId: 'api.bailian',
  modelId: 'qwen-plus',
}
preferenceApi.saveAgentModelPreference(preferredSelection, storage)
const restoredPreference = preferenceApi.loadAgentModelPreference(storage)
assert.deepEqual(restoredPreference, preferredSelection)
const newConversationSelection = preferenceApi.initialAgentModelSelection(restoredPreference)
assert.deepEqual(newConversationSelection, preferredSelection)
assert.notEqual(newConversationSelection, restoredPreference, 'each new conversation must own its selection object')

assert.deepEqual(parseAcpModelCatalog({ configOptions: [{ id: 'choice', category: 'model', type: 'select', currentValue: 'a', options: [
  { value: 'a', name: 'Model A' }, { group: 'Other', options: [{ value: 'b', name: 'Model B' }] },
] }], models: { availableModels: [{ modelId: 'stale', name: 'Stale' }] } }), {
  models: [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }], currentModelId: 'a',
})
assert.deepEqual(parseAcpModelCatalog({ models: { currentModelId: 'legacy', availableModels: [{ modelId: 'legacy', name: 'Legacy' }] } }), {
  models: [{ id: 'legacy', name: 'Legacy' }], currentModelId: 'legacy',
})
assert.deepEqual(parseAcpModelCatalog({ models: [{ id: 'older', name: 'Older' }] }).models, [{ id: 'older', name: 'Older' }])
assert.deepEqual(parseAcpModelCatalog({}), { models: [], currentModelId: null })

const providers = [
  { id: 'codex', name: 'Codex', available: true, requiresApiProvider: false },
  { id: 'qoder', name: 'Qoder', available: true, requiresApiProvider: false },
  { id: 'opencode', name: 'opencode', available: true, requiresApiProvider: false },
  { id: 'opencode-bundled', name: 'OpenCode（内置）', available: true, requiresApiProvider: true },
]
const selection = { transport: 'acp' as const, providerId: 'qoder', modelId: 'agent-advertised-model' }
const bundledSelection = { transport: 'acp' as const, providerId: 'opencode-bundled', apiProviderId: 'api.custom.first', modelId: 'agent-advertised-model' }
const legacyExternalOpenCode = { transport: 'acp' as const, providerId: 'opencode', modelId: 'legacy-model' }

assert.deepEqual(DEFAULT_AGENT_MODEL, { transport: 'acp', providerId: 'opencode-bundled', apiProviderId: '', modelId: '' })
assert.deepEqual(resolveAcpSelection(selection, providers), selection)
assert.deepEqual(resolveAcpSelection(legacyExternalOpenCode, providers), legacyExternalOpenCode, 'legacy external OpenCode selections remain valid')
assert.equal(resolveAcpSelection(null, providers).providerId, 'opencode-bundled')
assert.equal(resolveAcpSelection({ providerId: 'old.api', modelId: 'old-model' }, providers).providerId, 'opencode-bundled', 'old text model choices must not route into ACP')
assert.deepEqual(resolveAcpSelection({ transport: 'acp', providerId: 'opencode-bundled', apiProviderId: '', modelId: '' }, providers), {
  transport: 'acp', providerId: 'opencode-bundled', apiProviderId: '', modelId: '',
}, 'missing API bindings must reach the native bundled Agent unchanged')
assert.throws(() => resolveAcpSelection(selection, providers.filter(provider => provider.id !== 'qoder')), 'never silently replace an explicitly chosen Agent')
assert.equal(resolveAcpSelection(null, providers).modelId, '')
assert.throws(() => resolveAcpSelection(null, providers.filter(provider => provider.id !== 'opencode-bundled')), 'default bundled OpenCode must not silently fall back')
assert.throws(() => resolveAcpSelection(null, []))

const acpModelCacheKey = (agentModelSelection as { acpModelCacheKey?: unknown }).acpModelCacheKey
assert.equal(typeof acpModelCacheKey, 'function', 'model cache key must include the selected API Provider')
if (typeof acpModelCacheKey !== 'function') throw new Error('missing ACP model cache key')
assert.notEqual(acpModelCacheKey('opencode-bundled', 'api.custom.first'), acpModelCacheKey('opencode-bundled', 'api.custom.second'), 'bundled endpoints must not share models')
assert.equal(acpModelCacheKey('opencode-bundled', 'api.custom.first'), acpModelCacheKey('opencode-bundled', 'api.custom.first'))

const resolveOpenCodeApiBinding = (agentModelSelection as { resolveOpenCodeApiBinding?: unknown }).resolveOpenCodeApiBinding
assert.equal(typeof resolveOpenCodeApiBinding, 'function', 'bundled Agents must resolve eligible API Provider bindings')
if (typeof resolveOpenCodeApiBinding !== 'function') throw new Error('missing OpenCode API binding resolver')
const connections = [
  { id: 'api.bailian', name: 'Bailian', providerSlug: 'bailian', eligible: true },
  { id: 'api.custom.invalid', name: 'Incomplete gateway', providerSlug: 'openai', eligible: false, reason: '缺少 API Key' },
]
const eligibleBinding = resolveOpenCodeApiBinding('api.bailian', connections)
assert.deepEqual(eligibleBinding.eligible.map(connection => connection.id), ['api.bailian'])
assert.equal(eligibleBinding.isEligible, true)
assert.equal(eligibleBinding.selected?.name, 'Bailian')
const ineligibleBinding = resolveOpenCodeApiBinding('api.custom.invalid', connections)
assert.equal(ineligibleBinding.isEligible, false)
assert.equal(ineligibleBinding.selected?.reason, '缺少 API Key', 'the UI needs the reason an API Provider cannot be selected')
assert.equal(resolveOpenCodeApiBinding('', connections).isEligible, false, 'a bundled Agent needs an explicit eligible API Provider binding')

let discoveredApiProviderIds: string[] = []
let inspectionSessions = 0
const inspectionTransport = {
  listOpenCodeModels: async (apiProviderId: string) => {
    discoveredApiProviderIds.push(apiProviderId)
    return ['endpoint-model']
  },
  start: async () => { inspectionSessions += 1; throw new Error('bundled model discovery must not start an ACP session') },
  finish: async () => { inspectionSessions += 1 },
}
assert.deepEqual(await inspectAcpModels(providers[3], 'api.custom.first', inspectionTransport), {
  models: [{ id: 'endpoint-model', name: 'endpoint-model' }], currentModelId: null,
})
assert.deepEqual(discoveredApiProviderIds, ['api.custom.first'])
assert.deepEqual(await inspectAcpModels(providers[3], '', inspectionTransport), { models: [], currentModelId: null })
assert.equal(inspectionSessions, 0, 'missing bundled bindings must not start ACP sessions')
assert.deepEqual(discoveredApiProviderIds, ['api.custom.first'], 'missing bundled bindings must not query API-provider discovery')
let emit!: (event: AcpSessionEvent) => void
let finished = 0
let removed = 0
let permissions = 0
let questions = 0
let planApprovals = 0
let progressEvents: AcpSessionEvent[] = []
const transport: typeof acpConversationTransport = {
  subscribe: async callback => { emit = callback; return () => { removed += 1 } },
  start: async request => {
    assert.equal(request.providerId, 'qoder')
    assert.equal(request.modelId, 'agent-advertised-model')
    return { sessionId: 'session', providerId: 'qoder', providerName: 'Qoder', models: [], modes: [] }
  },
  send: async (id, prompt) => {
    assert.equal(id, 'session')
    assert.ok(prompt.includes('Previous answer') && prompt.includes('New request'))
    emit({ sessionId: 'other', kind: 'agent_message_chunk', text: 'wrong task' })
    emit({ sessionId: 'other', kind: 'tool_call', toolCallId: 'wrong-tool', toolTitle: 'Wrong tool' })
    emit({ sessionId: id, kind: 'permission_requested', requestId: 'permission', options: [] })
    emit({ sessionId: id, kind: 'question_requested', requestId: 'question', questions: [{
      id: 'q1',
      prompt: 'Use which style?',
      options: [{ id: 'simple', label: 'Simple' }, { id: 'detailed', label: 'Detailed' }],
    }] })
    emit({ sessionId: id, kind: 'plan_approval_requested', requestId: 'plan', title: 'Execution plan', plan: [{ content: 'Render video', status: 'pending' }] })
    emit({ sessionId: id, kind: 'tool_call', toolCallId: 'shell', toolTitle: 'Run shell command', status: 'running' })
    emit({ sessionId: id, kind: 'tool_call_update', toolCallId: 'shell', toolTitle: 'Run shell command', status: 'completed' })
    emit({ sessionId: id, kind: 'agent_message_chunk', text: 'ACP ' })
    emit({ sessionId: id, kind: 'agent_message_chunk', text: 'reply' })
    emit({ sessionId: id, kind: 'turn_completed' })
  },
  finish: async id => { assert.equal(id, 'session'); finished += 1 },
}
const options = { selection, provider: providers[1], messages: [
  { id: 'first', role: 'assistant' as const, content: 'Previous answer', createdAt: 1 },
  { id: 'second', role: 'user' as const, content: 'New request', createdAt: 2 },
], onPermission: () => { permissions += 1 }, onQuestion: () => { questions += 1 }, onPlanApproval: () => { planApprovals += 1 }, onProgress: (event: AcpSessionEvent) => { progressEvents.push(event) } }
assert.equal(await requestAcpConversation(options, transport), 'ACP reply')
assert.equal(finished, 1)
assert.equal(removed, 1)
assert.equal(permissions, 1)
assert.equal(questions, 1)
assert.equal(planApprovals, 1)
assert.deepEqual(progressEvents.map(event => event.kind), [
  'permission_requested',
  'question_requested',
  'plan_approval_requested',
  'tool_call',
  'tool_call_update',
  'agent_message_chunk',
  'agent_message_chunk',
  'turn_completed',
])
assert.deepEqual(progressEvents.filter(event => event.kind === 'tool_call' || event.kind === 'tool_call_update').map(event => event.toolCallId), ['shell', 'shell'])
progressEvents = []
await assert.rejects(requestAcpConversation(options, { ...transport, send: async id => {
  emit({ sessionId: id, kind: 'turn_failed', error: 'actual provider failure' })
} }), /actual provider failure/)
const controller = new AbortController()
await assert.rejects(requestAcpConversation({ ...options, signal: controller.signal }, { ...transport,
  send: async () => { controller.abort() },
}))
assert.equal(finished, 3, 'failed and canceled ACP sessions must be released')
assert.equal(removed, 3)
let begin!: () => void
const starting = new Promise<void>(resolve => { begin = resolve })
let startReady!: (session: Awaited<ReturnType<typeof transport.start>>) => void
const startup = new Promise<Awaited<ReturnType<typeof transport.start>>>(resolve => { startReady = resolve })
const earlyAbort = new AbortController()
const pending = requestAcpConversation({ ...options, signal: earlyAbort.signal }, { ...transport,
  start: async () => { begin(); return startup },
  send: async () => { assert.fail('a canceled startup must not send a prompt') },
})
await starting
earlyAbort.abort()
await assert.rejects(pending)
startReady({ sessionId: 'session', providerId: 'qoder', providerName: 'Qoder', models: [], modes: [] })
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(finished, 4, 'late startup after cancellation must still release the session')

async function assertApiBindingForwarded(
  selected: { transport: 'acp'; providerId: string; apiProviderId?: string; modelId: string },
  provider: typeof providers[number],
  expectedApiProviderId: string | undefined,
) {
  let localEmit!: (event: AcpSessionEvent) => void
  const bindingTransport: typeof acpConversationTransport = {
    subscribe: async callback => { localEmit = callback; return () => {} },
    start: async request => {
      assert.equal(request.providerId, selected.providerId)
      assert.equal(request.modelId, selected.modelId)
      assert.equal(request.apiProviderId, expectedApiProviderId)
      return { sessionId: 'binding-session', providerId: selected.providerId, providerName: provider.name, models: [], modes: [] }
    },
    send: async sessionId => {
      localEmit({ sessionId, kind: 'agent_message_chunk', text: 'bound reply' })
      localEmit({ sessionId, kind: 'turn_completed' })
    },
    finish: async () => {},
  }
  assert.equal(await requestAcpConversation({
    selection: selected,
    provider,
    messages: [{ id: 'binding-message', role: 'user', content: 'Use the selected Agent.', createdAt: 1 }],
    onPermission: () => {},
  }, bindingTransport), 'bound reply')
}

await assertApiBindingForwarded(bundledSelection, providers[3], 'api.custom.first')
await assertApiBindingForwarded({ ...bundledSelection, apiProviderId: '' }, providers[3], undefined)
await assertApiBindingForwarded({ ...bundledSelection, providerId: 'opencode', apiProviderId: 'api.custom.first' }, providers[2], undefined)
console.log('ACP selection: bundled default, API binding routing/cache isolation, legacy external OpenCode, history, event isolation, permissions, failure, cancellation and cleanup passed.')
