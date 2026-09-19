import assert from 'node:assert/strict'
import {
  WorkspaceStore,
  parseWorkspaceDocument,
  type WorkspaceAdapter,
  type WorkspaceDocument,
} from '../src/services/workspaceStorage'

const nativeMetadata = {
  conversations: [],
  generalTasks: [],
  selectedId: null,
}

function projectDocument(): WorkspaceDocument {
  return {
    version: 1,
    revision: 7,
    updatedAt: 700,
    metadata: nativeMetadata,
    projects: {
      'project-1:podcast': {
        version: 1,
        projectId: 'project-1',
        kind: 'podcast',
        updatedAt: 700,
        state: { script: 'persisted script' },
      },
    },
  }
}

let resolveRead: ((payload: string | null) => void) | undefined
const deferredWrites: string[] = []
const deferredAdapter: WorkspaceAdapter = {
  read: () => new Promise<string | null>((resolve) => { resolveRead = resolve }),
  write: (payload) => { deferredWrites.push(payload) },
}
const deferredStore = new WorkspaceStore(deferredAdapter)
const hydration = deferredStore.initialize()
deferredStore.writeProject('project-1', 'podcast', { script: 'must not replace persisted data' })
assert.equal(
  deferredStore.readProject<{ script: string }>('project-1', 'podcast'),
  null,
  'writes before hydration are ignored rather than replacing the unread document',
)
assert.equal(deferredWrites.length, 0, 'pre-hydration writes never reach the adapter')
resolveRead?.(JSON.stringify(projectDocument()))
await hydration
assert.equal(
  deferredStore.readProject<{ script: string }>('project-1', 'podcast')?.script,
  'persisted script',
  'hydrated project snapshots are available before any editor reads them',
)
await deferredStore.flush()
assert.equal(deferredWrites.length, 0, 'ignored pre-hydration writes never overwrite the persisted snapshot')

let savedPayload: string | null = null
const writingStore = new WorkspaceStore({
  read: () => null,
  write: (payload) => { savedPayload = payload },
})
await writingStore.initialize()
writingStore.writeProject('project-2', 'video-dubbing', { sourcePath: '/media/interview.mp4' })
await writingStore.flush()
const emitted = JSON.parse(savedPayload ?? '') as WorkspaceDocument
assert.deepEqual(
  emitted.metadata,
  nativeMetadata,
  'every emitted document includes the native workspace metadata envelope',
)
assert.equal(emitted.projects['project-2:video-dubbing'].state.sourcePath, '/media/interview.mp4')

const legacy = parseWorkspaceDocument(JSON.stringify({
  version: 1,
  revision: 2,
  updatedAt: 200,
  projects: projectDocument().projects,
  ignoredLegacyEnvelope: { version: 'old' },
}))
assert.deepEqual(JSON.parse(JSON.stringify(legacy.metadata)), nativeMetadata, 'legacy documents without metadata receive the native default envelope')
assert.equal(legacy.projects['project-1:podcast'].state.script, 'persisted script')

const futureMetadata = parseWorkspaceDocument(JSON.stringify({
  ...projectDocument(),
  metadata: { ...nativeMetadata, futureMetadata: { retained: true } },
  futureEnvelope: { retained: true },
})) as WorkspaceDocument & {
  futureEnvelope?: { retained?: boolean }
  metadata: WorkspaceDocument['metadata'] & { futureMetadata?: { retained?: boolean } }
}
assert.equal(futureMetadata.metadata.futureMetadata?.retained, true, 'safe metadata extensions survive parsing')
assert.equal(futureMetadata.futureEnvelope?.retained, true, 'safe document extensions survive parsing')

console.log('Workspace storage: hydration gate, native metadata envelope, and legacy-compatible parsing passed.')
