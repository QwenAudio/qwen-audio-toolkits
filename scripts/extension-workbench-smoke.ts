import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  EXTENSION_WORKBENCH_STORAGE_KEY,
  extensionWorkbenchPages,
  readExtensionWorkbenchEnabled,
  resolveExtensionWorkbenchPage,
  writeExtensionWorkbenchEnabled,
} from '../src/services/extensionWorkbenchState'

function storageWith(value: string | null): Pick<Storage, 'getItem'> {
  return {
    getItem(key) {
      return key === EXTENSION_WORKBENCH_STORAGE_KEY ? value : null
    },
  }
}

const emptyStorage = storageWith(null)

assert.equal(readExtensionWorkbenchEnabled(emptyStorage), false)
assert.equal(readExtensionWorkbenchEnabled(storageWith('true')), true)
assert.equal(readExtensionWorkbenchEnabled(storageWith('false')), false)
assert.equal(readExtensionWorkbenchEnabled(storageWith('corrupt')), false)

const writes: Array<[string, string]> = []
const writableStorage: Pick<Storage, 'setItem'> = {
  setItem(key, value) {
    writes.push([key, value])
  },
}
writeExtensionWorkbenchEnabled(writableStorage, true)
writeExtensionWorkbenchEnabled(writableStorage, false)
assert.deepEqual(writes, [
  [EXTENSION_WORKBENCH_STORAGE_KEY, 'true'],
  [EXTENSION_WORKBENCH_STORAGE_KEY, 'false'],
])

assert.deepEqual(extensionWorkbenchPages(false), [])
assert.deepEqual(extensionWorkbenchPages(true), [
  'models',
  'podcast',
  'meeting-notes',
  'video-dubbing',
])
assert.equal(resolveExtensionWorkbenchPage(false, 'models'), null)
assert.equal(resolveExtensionWorkbenchPage(false, null), null)
assert.equal(resolveExtensionWorkbenchPage(true, 'unknown'), 'models')
assert.equal(resolveExtensionWorkbenchPage(true, null), 'models')
assert.equal(resolveExtensionWorkbenchPage(true, 'models'), 'models')
assert.equal(resolveExtensionWorkbenchPage(true, 'podcast'), 'podcast')
assert.equal(resolveExtensionWorkbenchPage(true, 'meeting-notes'), 'meeting-notes')
assert.equal(resolveExtensionWorkbenchPage(true, 'video-dubbing'), 'video-dubbing')

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const workbenchUrl = new URL('../src/views/ExtensionWorkbenchView.tsx', import.meta.url)
const workbenchSource = existsSync(workbenchUrl)
  ? readFileSync(workbenchUrl, 'utf8')
  : ''

assert.notEqual(workbenchSource, '')
assert.match(
  appSource,
  /const ExtensionWorkbenchView = lazy\(\(\) =>\s*import\('\.\/views\/ExtensionWorkbenchView'\)/,
)
assert.match(
  appSource,
  /resolveExtensionWorkbenchPage\(\s*extensionWorkbenchEnabled,\s*extensionWorkbenchPage,\s*\)/,
)
assert.match(
  appSource,
  /extensionWorkbenchEnabled && shellPage === 'extension-workbench'[\s\S]{0,240}<ExtensionWorkbenchView/,
)
assert.match(workbenchSource, /extensionWorkbenchPages\(true\)\.map/)
assert.match(workbenchSource, /page: ExtensionWorkbenchPage/)
assert.match(workbenchSource, /onPageChange\(page: ExtensionWorkbenchPage\): void/)
assert.match(workbenchSource, /onClose\(\): void/)
assert.match(workbenchSource, /children: ReactNode/)
assert.match(workbenchSource, /onClick=\{onClose\}/)
assert.doesNotMatch(
  workbenchSource,
  /(?:^|\n)\s*import[\s\S]*?(?:ModelWorkspaceView|PluginsView|PythonAgentWorkspace|WorkflowChatView|WorkflowsView)/,
)

assert.match(readFileSync('src/views/AgentCatalogView.tsx', 'utf8'), /安装后可离线运行/u)
assert.match(readFileSync('src/views/ExtensionModelStoreView.tsx', 'utf8'), /catalogKind/u)
assert.match(
  appSource,
  /const ExtensionModelStoreView = lazy\(\(\) =>\s*import\('\.\/views\/ExtensionModelStoreView'\)/,
)
assert.match(
  appSource,
  /extensionWorkbenchEnabled && shellPage === 'extension-workbench'[\s\S]{0,900}extensionWorkbenchPage === 'models'[\s\S]{0,500}<ExtensionModelStoreView/,
)
const modelStoreRoute = appSource.match(
  /\{shellPage === 'extensions' && \(([\s\S]*?)\n\s*\)\}\n\s*\{shellPage === 'agent-catalog'/,
)?.[1] ?? ''
assert.match(modelStoreRoute, /<ExtensionModelStoreView/)
assert.doesNotMatch(modelStoreRoute, /AgentCatalogView/)
const agentCatalogRoute = appSource.match(
  /\{shellPage === 'agent-catalog' && \(([\s\S]*?)\n\s*\)\}\n\s*\{extensionWorkbenchEnabled/,
)?.[1] ?? ''
assert.match(agentCatalogRoute, /<AgentCatalogView/)
assert.doesNotMatch(agentCatalogRoute, /ExtensionModelStoreView/)
assert.match(
  appSource,
  /const notifyModelStoreProviderConfiguration = \(providerId: string\) => \{[\s\S]{0,240}notify\(/,
)
assert.match(
  appSource,
  /<ExtensionModelStoreView[\s\S]{0,900}onConfigureProvider=\{notifyModelStoreProviderConfiguration\}/,
)
assert.doesNotMatch(
  appSource,
  /<ExtensionModelStoreView[\s\S]{0,900}onConfigureProvider=\{openProviderSettings\}/,
)
assert.match(workbenchSource, /context: ExtensionExecutionContext/)
assert.match(appSource, /context=\{extensionExecutionContext\}/)
assert.match(
  appSource,
  /const runWorkbenchText[\s\S]{0,300}\(\s*text,\s*capability,\s*providerId,\s*modelId,\s*modelParameters,\s*dependencyRunIds,\s*conversationVisible,\s*\)[\s\S]{0,300}runText\(\s*text,\s*capability,\s*providerId,\s*modelId,\s*modelParameters,\s*dependencyRunIds,\s*conversationVisible,\s*'workbench',\s*\)/,
)
assert.match(
  appSource,
  /const runWorkbenchAudio[\s\S]{0,300}\(\s*clip,\s*capability,\s*providerId,\s*modelId,\s*modelParameters,\s*conversationVisible,\s*dependencyRunIds,\s*comparisonClip,\s*\)[\s\S]{0,300}runAudio\(\s*clip,\s*capability,\s*providerId,\s*modelId,\s*modelParameters,\s*conversationVisible,\s*dependencyRunIds,\s*comparisonClip,\s*'workbench',\s*\)/,
)
assert.match(
  appSource,
  /const extensionExecutionContext: ExtensionExecutionContext = \{[\s\S]{0,360}runText: runWorkbenchText,[\s\S]{0,160}runAudio: runWorkbenchAudio,/,
)
assert.doesNotMatch(
  appSource,
  /const extensionExecutionContext: ExtensionExecutionContext = \{[\s\S]{0,360}runText,\s*\n\s*runAudio,/,
)

const videoDubbingSource = readFileSync(new URL('../src/views/VideoDubbingView.tsx', import.meta.url), 'utf8')
assert.match(videoDubbingSource, /import \{ open \} from '@tauri-apps\/plugin-dialog'/)
assert.match(videoDubbingSource, /const \[sourcePath, setSourcePath\] = useState\(\(\) => restored\?\.sourcePath \|\| initialSourcePath\)/)
assert.match(videoDubbingSource, /const chooseSource = async \(\) => \{[\s\S]{0,500}await open\(/)
assert.match(videoDubbingSource, /filters: \[\s*\{ name: t\('视频文件'\), extensions: \['mp4', 'mov', 'm4v', 'webm', 'mkv'\] \},?\s*\]/)
assert.match(videoDubbingSource, /<textarea[\s\S]{0,200}value=\{settings\.instruction\}[\s\S]{0,200}onChange=\{event => configure\(\{ instruction: event\.target\.value \}\)\}/)
assert.match(
  workbenchSource,
  /<VideoDubbingView\s+projectId="extension-video-dubbing"\s+initialInstruction=""\s+initialSourcePath=""\s+initialLaunchId=\{0\}\s+dubbingMode="translate"/,
)

for (const [viewName, projectId] of [
  ['AiPodcastView', 'extension-ai-podcast'],
  ['MeetingNotesView', 'extension-meeting-notes'],
  ['VideoDubbingView', 'extension-video-dubbing'],
] as const) {
  const importers = readdirSync('src', { recursive: true })
    .filter((entry): entry is string =>
      typeof entry === 'string' && entry.endsWith('.tsx'),
    )
    .map((entry) => `src/${entry}`)
    .filter((filePath) =>
      new RegExp(`from ['"][^'"]*${viewName}['"]`, 'u').test(
        readFileSync(filePath, 'utf8'),
      ),
    )
    .sort()
  assert.deepEqual(importers, ['src/views/ExtensionWorkbenchView.tsx'])
  assert.match(workbenchSource, new RegExp(`<${viewName}[\\s\\S]{0,500}projectId="${projectId}"`, 'u'))
  assert.doesNotMatch(appSource, new RegExp(`from ['"][^'"]*${viewName}['"]`, 'u'))
}

console.log('extension workbench smoke passed')
