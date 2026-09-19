import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/views/ExtensionWorkbenchView.tsx', import.meta.url), 'utf8')

assert.match(
  appSource,
  /import \{ useWorkspaceCloseFlush, useWorkspaceReady \} from '\.\/hooks\/useProjectAutosave'/,
  'App owns the shared workspace lifecycle rather than individual product views',
)
assert.match(
  appSource,
  /const workbenchWorkspaceReady = useWorkspaceReady\(extensionWorkbenchEnabled\)/,
  'workbench readiness starts only after the optional extension workbench is enabled',
)
assert.match(
  appSource,
  /useWorkspaceCloseFlush\(extensionWorkbenchEnabled\)/,
  'one parent close-flush lifecycle is active for the enabled workbench',
)
assert.match(
  appSource,
  /extensionWorkbenchEnabled && shellPage === 'extension-workbench' && workbenchWorkspaceReady &&\s*\(\s*<ExtensionWorkbenchView/,
  'the workbench cannot mount before shared workspace hydration resolves',
)
assert.match(
  appSource,
  /extensionWorkbenchEnabled && shellPage === 'extension-workbench' && !workbenchWorkspaceReady &&\s*\(\s*<div className="app-view-loading"/,
  'the pending workbench route renders a shared loading state instead of a product editor',
)

for (const [viewName, projectId] of [
  ['SmartCutView', 'extension-smart-cut'],
  ['AiPodcastView', 'extension-ai-podcast'],
  ['MeetingNotesView', 'extension-meeting-notes'],
  ['VideoDubbingView', 'extension-video-dubbing'],
] as const) {
  const importers = readdirSync('src', { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.tsx'))
    .map((entry) => `src/${entry}`)
    .filter((filePath) => new RegExp(`from ['"][^'"]*${viewName}['"]`, 'u').test(readFileSync(filePath, 'utf8')))
    .sort()
  assert.deepEqual(importers, ['src/views/ExtensionWorkbenchView.tsx'])
  assert.match(workbenchSource, new RegExp(`<${viewName}[\\s\\S]{0,500}projectId="${projectId}"`, 'u'))
}

console.log('Workspace hydration: all extension product branches share the App readiness gate.')
