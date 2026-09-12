import assert from 'node:assert/strict'
import { resolveAcpSelection } from '../src/domain/agentModelSelection'
import { requestAcpConversation, type acpConversationTransport } from '../src/services/acpConversation'
import type { AcpSessionEvent } from '../src/types'
import { parseAcpModelCatalog } from '../src/domain/acpModels'

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

const providers = [{ id: 'codex', name: 'Codex', available: true }, { id: 'qoder', name: 'Qoder', available: true }]
const selection = { transport: 'acp' as const, providerId: 'qoder', modelId: 'agent-advertised-model' }
assert.deepEqual(resolveAcpSelection(selection, providers), selection)
assert.equal(resolveAcpSelection(null, providers).providerId, 'qoder')
assert.equal(resolveAcpSelection({ providerId: 'old.api', modelId: 'old-model' }, providers).providerId, 'qoder', 'old text model choices must not route into ACP')
assert.throws(() => resolveAcpSelection(selection, providers.filter(provider => provider.id !== 'qoder')), 'never silently replace an explicitly chosen Agent')
assert.equal(resolveAcpSelection(null, providers).modelId, '')
assert.throws(() => resolveAcpSelection(null, providers.filter(provider => provider.id !== 'qoder')), 'default Qoder must not silently fall back')
assert.throws(() => resolveAcpSelection(null, []))
let emit!: (event: AcpSessionEvent) => void
let finished = 0
let removed = 0
let permissions = 0
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
    emit({ sessionId: id, kind: 'permission_requested', requestId: 'permission', options: [] })
    emit({ sessionId: id, kind: 'agent_message_chunk', text: 'ACP ' })
    emit({ sessionId: id, kind: 'agent_message_chunk', text: 'reply' })
    emit({ sessionId: id, kind: 'turn_completed' })
  },
  finish: async id => { assert.equal(id, 'session'); finished += 1 },
}
const options = { selection, messages: [
  { id: 'first', role: 'assistant' as const, content: 'Previous answer', createdAt: 1 },
  { id: 'second', role: 'user' as const, content: 'New request', createdAt: 2 },
], onPermission: () => { permissions += 1 } }
assert.equal(await requestAcpConversation(options, transport), 'ACP reply')
assert.equal(finished, 1)
assert.equal(removed, 1)
assert.equal(permissions, 1)
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
console.log('ACP selection: exact Agent/model routing, history, event isolation, permissions, failure, cancellation and cleanup passed.')
