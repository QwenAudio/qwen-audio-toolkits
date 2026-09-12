import assert from 'node:assert/strict'
import { mock } from 'node:test'
import {
  WorkspaceStore,
  parseWorkspaceDocument,
  restoreWorkspaceMetadata,
  serializableWorkspaceState,
  type WorkspaceAdapter,
  type WorkspaceDocument,
  type WorkspaceMetadata,
} from '../src/services/workspaceStorage'

const metadata: WorkspaceMetadata = {
  conversations: [{ archived: true, id: 'project-1', title: '播客草稿', mode: 'ai-podcast', prompt: '聊聊音乐', sourcePath: '/audio/source.wav' }],
  generalTasks: [{
    archived: true, id: 'task-1', kind: 'general', title: '创作', draftPrompt: '保留草稿', selectedModeId: 'video-dubbing',
    chatModel: { transport: 'acp', providerId: 'codex', modelId: '' },
    creationOptions: { videoDubbingMode: 'rewrite', videoDubbingStyle: 'casual', videoDubbingLanguages: { source: 'zh', target: 'en' } },
    createdAt: 1, updatedAt: 2, submitting: true,
    messages: [{ id: 'message-1', role: 'assistant', content: '执行中', createdAt: 1,
      action: { id: 'plan-1', kind: 'structured-agent-plan', status: 'running', confirmationText: '开始', steps: [
        { id: 'step-1', status: 'done', capability: 'speech.transcribe', description: '识别', result: '已识别' },
        { id: 'step-2', status: 'running', capability: 'speech.synthesize', description: '生成' },
      ] },
    }],
  }],
  selectedId: 'project-1',
}

function memoryAdapter() {
  let payload: string | null = null
  let writes = 0
  return {
    read: () => payload,
    write: (next: string) => { payload = next; writes += 1 },
    writes: () => writes,
  }
}

const adapter = memoryAdapter()
const store = new WorkspaceStore(adapter)
assert.equal(store.getStatus().status, 'loading')
await store.initialize()
store.writeMetadata(metadata)
store.writeProject('project-1', 'podcast', { script: '编辑后的台词', path: '/audio/out.wav', source: 'blob:temporary', dataUrl: 'data:audio/wav;base64,AA==', bytes: new Uint8Array([1, 2]) })
await store.flush()
assert.equal(store.getStatus().status, 'saved')
assert.equal(adapter.writes(), 1, 'metadata and editor updates share one document')
const parsed = parseWorkspaceDocument(adapter.read()!)
assert.equal(parsed.projects['project-1:podcast'].version, 1)
assert.deepEqual(Object.keys(parsed.projects['project-1:podcast'].state).sort(), ['path', 'script', 'source'])
assert.equal(parsed.projects['project-1:podcast'].state.source, '')
assert.equal(parsed.metadata.generalTasks[0].creationOptions?.videoDubbingMode, 'rewrite')

const reopened = new WorkspaceStore(adapter)
const restored = await reopened.initialize()
assert.equal(restored.conversations[0].restored, true)
assert.equal(restored.selectedId, 'project-1')
assert.equal(restored.conversations[0].archived, true)
assert.equal(restored.generalTasks[0].archived, true)
assert.equal(restored.generalTasks[0].submitting, false)
assert.deepEqual({ ...restored.generalTasks[0].chatModel }, metadata.generalTasks[0].chatModel, 'restore the task-specific provider and model')
assert.equal(restored.generalTasks[0].messages[0].action?.status, 'failed')
const action = restored.generalTasks[0].messages[0].action
assert.equal(action?.kind, 'structured-agent-plan')
if (action?.kind === 'structured-agent-plan') {
  assert.equal(action.steps[0].status, 'done')
  assert.equal(action.steps[1].status, 'failed')
}
assert.equal(restored.generalTasks[0].messages.length, 2, 'explain the interrupted task without replaying it')
assert.equal(reopened.readProject<{ script: string }>('project-1', 'podcast')?.script, '编辑后的台词')
await reopened.flush()
const reopenedAgain = new WorkspaceStore(adapter)
assert.equal((await reopenedAgain.initialize()).generalTasks[0].messages.length, 2, 'interruption notice does not duplicate on the next restart')
assert.equal(restoreWorkspaceMetadata({ ...metadata, selectedId: 'missing-id' }).selectedId, null)

for (const bad of ['{broken', '{"version":99}', JSON.stringify({ ...parsed, projects: { 'project-1:podcast': { ...parsed.projects['project-1:podcast'], version: 99 } } })]) {
  let writes = 0
  const broken = new WorkspaceStore({ read: () => bad, write: () => { writes += 1 } })
  await broken.initialize()
  assert.equal(broken.getStatus().status, 'error')
  broken.writeMetadata(metadata)
  broken.writeProject('project-1', 'podcast', { script: '可继续在内存编辑' })
  await assert.rejects(broken.flush())
  assert.equal(writes, 0, 'corrupt and unknown versions must not be overwritten')
  assert.equal(broken.getStatus().status, 'error')
  assert.equal(broken.getStatus().canRetry, false)
}

let failedWrites = 0
const failures = new WorkspaceStore({ read: () => null, write: () => { if (++failedWrites === 1) throw new Error('disk full') } })
await failures.initialize()
failures.writeMetadata(metadata)
await assert.rejects(failures.flush(), /disk full/)
assert.equal(failures.getStatus().status, 'error')
assert.equal(failures.getStatus().canRetry, true)
assert.equal(failures.getStatus().savedAt, null)
await failures.flush()
assert.equal(failures.getStatus().status, 'saved', 'explicit retry only reports success after a successful write')

let demoAccesses = 0
const demo = new WorkspaceStore({ read: () => { demoAccesses += 1; return adapter.read() }, write: () => { demoAccesses += 1 } }, true)
assert.deepEqual(await demo.initialize(), { conversations: [], generalTasks: [], selectedId: null })
demo.writeMetadata(metadata)
demo.writeProject('project-1', 'podcast', { script: 'demo' })
await demo.flush()
assert.equal(demo.readProject('project-1', 'podcast'), null)
assert.equal(demoAccesses, 0)
assert.equal(demo.getStatus().status, 'disabled')

const pending: Array<{ payload: WorkspaceDocument; resolve: () => void }> = []
const orderedAdapter: WorkspaceAdapter = { read: () => null, write: (payload) => new Promise<void>((resolve) => pending.push({ payload: JSON.parse(payload), resolve })) }
const ordered = new WorkspaceStore(orderedAdapter)
await ordered.initialize()
ordered.writeProject('project-1', 'podcast', { script: 'first' })
const firstFlush = ordered.flush()
ordered.writeProject('project-1', 'podcast', { script: 'latest' })
const secondFlush = ordered.flush()
assert.equal(firstFlush, secondFlush)
assert.equal(pending.length, 1, 'only one native write is in flight')
pending[0].resolve()
await Promise.resolve()
assert.equal(pending.length, 2)
assert.equal(pending[1].payload.projects['project-1:podcast'].state.script, 'latest')
assert.ok(pending[1].payload.revision > pending[0].payload.revision)
pending[1].resolve()
await secondFlush
assert.equal(ordered.getStatus().status, 'saved')
ordered.writeProject('project-1', 'podcast', { script: 'latest' })
ordered.writeProject(undefined, 'podcast', { script: 'ignored' })
await ordered.flush()
assert.equal(pending.length, 2, 'unchanged state and unnamed projects do not save')

const invalid = new WorkspaceStore(memoryAdapter())
await invalid.initialize()
invalid.writeProject('project-1', 'podcast', null)
assert.equal(invalid.getStatus().status, 'error')
invalid.writeMetadata(metadata)
await assert.rejects(invalid.flush())
assert.equal(invalid.getStatus().status, 'error', 'unrelated successful saves cannot hide a rejected editor snapshot')
invalid.writeProject('project-1', 'podcast', { script: 'fixed' })
await invalid.flush()
assert.equal(invalid.getStatus().status, 'saved')
assert.deepEqual(JSON.parse(JSON.stringify(serializableWorkspaceState({ a: 'blob:temp', filePath: '/safe.wav', nested: { pcmBase64: 'AAAA' } }))), { a: '', filePath: '/safe.wav', nested: {} })

mock.timers.enable({ apis: ['setTimeout'] })
try {
  const liveAdapter = memoryAdapter()
  const live = new WorkspaceStore(liveAdapter)
  await live.initialize()
  for (let index = 0; index < 12; index += 1) {
    live.writeProject('project-1', 'meeting-notes', { transcript: `live transcript ${index}` })
    mock.timers.tick(100)
    await Promise.resolve()
  }
  assert.ok(liveAdapter.writes() >= 2, 'continuous 100 ms updates must still persist each 500 ms batch')
  await live.flush()
  assert.equal(parseWorkspaceDocument(liveAdapter.read()!).projects['project-1:meeting-notes'].state.transcript, 'live transcript 11')
} finally {
  mock.timers.reset()
}

console.log('Workspace storage: roundtrip, interruption recovery, corruption protection, failure retry, demo isolation, media stripping, deduplication, write ordering and bounded live autosave passed.')
