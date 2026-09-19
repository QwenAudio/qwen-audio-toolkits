import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXTENSION_WORKBENCH_STORAGE_KEY,
  extensionWorkbenchPages,
  readExtensionWorkbenchEnabled,
  resolveExtensionWorkbenchPage,
} from '../src/services/extensionWorkbenchState'
import { normalizeHiddenAcpProviderId } from '../src/services/acp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string) =>
  readFileSync(join(root, relativePath), 'utf8')
const appSource = read('src/App.tsx')

function memoryStorage(
  entries: Readonly<Record<string, string>> = {},
): Pick<Storage, 'getItem'> {
  const values = new Map(Object.entries(entries))
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
  }
}

const disabledWorkbenchEnabled = readExtensionWorkbenchEnabled(memoryStorage())
assert.equal(
  disabledWorkbenchEnabled,
  false,
  'the extension workbench must be opt-in when no preference exists',
)
assert.deepEqual(
  extensionWorkbenchPages(disabledWorkbenchEnabled),
  [],
  'an absent preference must not expose extension workbench pages',
)
assert.equal(
  resolveExtensionWorkbenchPage(disabledWorkbenchEnabled, null),
  null,
  'a disabled extension workbench must not resolve a landing page',
)
assert.equal(
  resolveExtensionWorkbenchPage(disabledWorkbenchEnabled, 'models'),
  null,
  'a disabled extension workbench must not resolve a requested page',
)
assert.equal(
  readExtensionWorkbenchEnabled(
    memoryStorage({ [EXTENSION_WORKBENCH_STORAGE_KEY]: 'false' }),
  ),
  false,
  'the extension workbench must remain disabled for an explicit false preference',
)

const enabledWorkbenchEnabled = readExtensionWorkbenchEnabled(
  memoryStorage({ [EXTENSION_WORKBENCH_STORAGE_KEY]: 'true' }),
)
assert.equal(
  enabledWorkbenchEnabled,
  true,
  'an explicit preference may enable the extension workbench',
)
const expectedExtensionWorkbenchPages = [
  'models',
  'smart-cut',
  'podcast',
  'meeting-notes',
  'video-dubbing',
]
assert.deepEqual(
  extensionWorkbenchPages(enabledWorkbenchEnabled),
  expectedExtensionWorkbenchPages,
  'an enabled extension workbench must expose its supported pages',
)
assert.equal(
  resolveExtensionWorkbenchPage(enabledWorkbenchEnabled, null),
  'models',
  'an enabled extension workbench must fall back to models without a page',
)
assert.equal(
  resolveExtensionWorkbenchPage(enabledWorkbenchEnabled, 'unknown'),
  'models',
  'an enabled extension workbench must fall back to models for an unknown page',
)
for (const page of expectedExtensionWorkbenchPages) {
  assert.equal(
    resolveExtensionWorkbenchPage(enabledWorkbenchEnabled, page),
    page,
    `an enabled extension workbench must resolve its ${page} page`,
  )
}

assert.match(
  appSource,
  /const \[view, setView\] = useState<AppView>\('workspace'\)/u,
  'the application must open in the boss workspace',
)
assert.match(
  appSource,
  /const \[shellPage, setShellPage\] = useState<ShellPage>\('workspace'\)/u,
  'the shell must default to the boss workspace rather than an extension page',
)
assert.match(
  appSource,
  /function getInitialExtensionWorkbenchEnabled\(\): boolean \{[\s\S]{0,280}?typeof window === 'undefined'\) return false[\s\S]{0,280}?return readExtensionWorkbenchEnabled\(window\.localStorage\)[\s\S]{0,280}?catch \{\s*return false\s*\}/u,
  'the shell must fail closed when the extension preference is unavailable',
)
assert.match(
  appSource,
  /const \[extensionWorkbenchEnabled, setExtensionWorkbenchEnabled\] =\s*useState\(getInitialExtensionWorkbenchEnabled\)/u,
  'App must initialize the enabled state through the extension workbench reader',
)
assert.match(
  appSource,
  /shellPage === 'workspace' && \(\s*<nav className="installed-models" aria-label="已安装 Agents">/u,
  'the boss workspace must retain the installed Agent sidebar',
)
assert.match(
  appSource,
  /const visiblePythonAgents = useMemo\(\s*\(\) => pythonAgents\.filter\(\(agent\) => agent\.status !== 'uninstalled'\),/u,
  'the boss sidebar must continue to derive installed Agents from its registry state',
)
assert.match(
  appSource,
  /shellPage === 'extensions' && \(\s*<PluginsView\s+agentRegistry=\{agentInstallRegistry\}/u,
  'the existing Agent catalog route must remain available from the boss shell',
)
assert.match(
  appSource,
  /\{extensionWorkbenchEnabled && \(\s*<button[\s\S]{0,520}?onClick=\{[\s\S]{0,180}?openExtensionWorkbench/u,
  'the extension entry must be conditionally rendered behind its opt-in flag',
)
assert.match(
  appSource,
  /extensionWorkbenchEnabled && shellPage === 'extension-workbench'/u,
  'the extension workbench mount must remain gated by its opt-in flag',
)
assert.doesNotMatch(
  appSource,
  /shellPage === 'workspace' &&[\s\S]{0,240}<ExtensionWorkbenchView/u,
  'the extension workbench must never be part of the default boss workspace',
)

for (const productView of [
  'SmartCutView',
  'AiPodcastView',
  'MeetingNotesView',
  'VideoDubbingView',
]) {
  assert.doesNotMatch(
    appSource,
    new RegExp(
      `(?:^|\\n)import(?:\\s+type)?[\\s\\S]*?from\\s+['"][^'"]*${productView}['"]`,
      'u',
    ),
    `App must not import the ${productView} product directly`,
  )
}
for (const [forbiddenPattern, message] of [
  [/\bAgentHomeView\b/u, 'App must not restore the removed Agent home view'],
  [/\bopencode-bundled\b/iu, 'App must not restore the bundled ACP provider'],
  [
    /\b(?:AcpProvider|AcpSession|AcpConversation|ProviderSelector)\b/u,
    'App must not restore dedicated ACP selector or session UI',
  ],
  [
    /from\s+['"][^'"]*(?:services\/acp|acpConversation)['"]/u,
    'App must not mount ACP services directly',
  ],
  [
    /(?:fetch-opencode-sidecar|opencode-sidecar-smoke|binaries\/opencode)/iu,
    'App must not reference bundled OpenCode sidecar artifacts',
  ],
] as const) {
  assert.doesNotMatch(appSource, forbiddenPattern, message)
}
assert.equal(
  normalizeHiddenAcpProviderId('opencode-bundled'),
  null,
  'the legacy bundled provider preference must normalize away',
)
assert.equal(
  normalizeHiddenAcpProviderId('qoder'),
  'qoder',
  'non-legacy ACP provider preferences must remain intact',
)

const buildHookSources = ['package.json', 'scripts/desktop.mjs']
const tauriConfigPaths = readdirSync(join(root, 'src-tauri'))
  .filter((entry) => /^tauri.*\.json$/u.test(entry))
  .map((entry) => join('src-tauri', entry))

function externalBinaryPaths(sourcePath: string, source: string): string[] {
  const config = JSON.parse(source) as {
    bundle?: { externalBin?: unknown }
  }
  const externalBin = config.bundle?.externalBin
  if (externalBin === undefined) return []
  assert.ok(
    Array.isArray(externalBin),
    `${sourcePath} bundle.externalBin must be an array when configured`,
  )
  const paths = externalBin.filter((entry): entry is string => typeof entry === 'string')
  assert.equal(
    paths.length,
    externalBin.length,
    `${sourcePath} bundle.externalBin entries must be strings`,
  )
  return paths
}

function assertNoOpenCodeExternalBinary(sourcePath: string, source: string): void {
  for (const externalBinaryPath of externalBinaryPaths(sourcePath, source)) {
    assert.doesNotMatch(
      externalBinaryPath,
      /(?:^|[\\/])opencode(?:[-_.\\/]|$)/iu,
      `${sourcePath} must not configure an OpenCode external binary`,
    )
  }
}

const harmlessFutureSidecarConfig = JSON.stringify({
  bundle: { externalBin: ['binaries/node'] },
})
assert.doesNotThrow(
  () => assertNoOpenCodeExternalBinary('synthetic-node-sidecar.json', harmlessFutureSidecarConfig),
  'an unrelated Tauri external binary must remain permitted',
)
for (const sourcePath of tauriConfigPaths) {
  assertNoOpenCodeExternalBinary(sourcePath, read(sourcePath))
}
for (const sourcePath of buildHookSources) {
  assert.doesNotMatch(
    read(sourcePath),
    /(?:fetch-opencode-sidecar|opencode-sidecar-smoke|binaries\/opencode)/iu,
    `${sourcePath} must not configure a bundled OpenCode sidecar`,
  )
}
for (const sidecarPath of [
  'scripts/fetch-opencode-sidecar.mjs',
  'scripts/opencode-sidecar-smoke.mjs',
  'src-tauri/binaries/opencode',
]) {
  assert.equal(
    existsSync(join(root, sidecarPath)),
    false,
    `${sidecarPath} must not remain in the repository`,
  )
}

function splitShellAndCommands(pipeline: string): string[] {
  const commands: string[] = []
  let start = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  for (let index = 0; index < pipeline.length; index += 1) {
    const character = pipeline[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '&' && pipeline[index + 1] === '&') {
      commands.push(pipeline.slice(start, index).trim())
      start = index + 2
      index += 1
    }
  }
  commands.push(pipeline.slice(start).trim())
  return commands
}

function parseTestCommands(packageSource: string): string[] {
  const packageManifest = JSON.parse(packageSource) as { scripts?: unknown }
  assert.ok(
    packageManifest.scripts &&
      typeof packageManifest.scripts === 'object' &&
      !Array.isArray(packageManifest.scripts),
    'package.json must define scripts as an object',
  )
  const testPipeline = (packageManifest.scripts as Record<string, unknown>).test
  assert.ok(typeof testPipeline === 'string', 'package.json must define npm test')

  const commands = splitShellAndCommands(testPipeline)
  assert.ok(commands.length > 0, 'npm test must contain at least one command')
  for (const [index, command] of commands.entries()) {
    assert.notEqual(command, '', `npm test command ${index + 1} must not be empty`)
  }
  const normalizedCommands = commands.map((command) =>
    command.replace(/\s+/gu, ' '),
  )
  assert.equal(
    new Set(normalizedCommands).size,
    normalizedCommands.length,
    'npm test must not contain duplicate command entries',
  )
  return commands
}

const testCommands = parseTestCommands(read('package.json'))
function positionOfRequiredCheck(check: string): number {
  const positions = testCommands.flatMap((command, index) =>
    command.includes(check) ? [index] : [],
  )
  assert.equal(positions.length, 1, `npm test must run ${check} exactly once`)
  return positions[0]
}

const requiredTestStages = [
  ['catalog', ['scripts/agent-server-catalog-smoke.ts']],
  ['boss shell', ['scripts/boss-default-shell-smoke.ts']],
  [
    'workbench/model',
    [
      'scripts/extension-workbench-smoke.ts',
      'scripts/on-demand-model-store-smoke.ts',
      'scripts/model-taxonomy-smoke.mjs',
    ],
  ],
  [
    'product',
    [
      'scripts/smart-cut-smoke.ts',
      'scripts/podcast-smoke.ts',
      'scripts/podcast-audio-smoke.ts',
      'scripts/meeting-commands-smoke.ts',
      'scripts/video-dubbing-smoke.mjs',
      'scripts/video-dubbing-workspace-smoke.ts',
    ],
  ],
  [
    'ACP',
    [
      'scripts/agent-acp-smoke.mjs',
      'scripts/acp-bundled-removal-smoke.mjs',
    ],
  ],
] as const
const stageBounds = requiredTestStages.map(([name, checks]) => {
  const positions = checks.map(positionOfRequiredCheck)
  return {
    name,
    first: Math.min(...positions),
    last: Math.max(...positions),
  }
})
for (let index = 1; index < stageBounds.length; index += 1) {
  const previousStage = stageBounds[index - 1]
  const currentStage = stageBounds[index]
  assert.ok(
    previousStage.last < currentStage.first,
    `npm test must run ${previousStage.name} checks before ${currentStage.name} checks`,
  )
}

console.log('boss default shell smoke passed')
