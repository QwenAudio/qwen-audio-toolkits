import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const exists = relativePath => fs.existsSync(path.join(root, relativePath))

const acpService = read('src/services/acp.ts')
const helperMatch = acpService.match(
  /export function normalizeHiddenAcpProviderId\(value: string \| null\): string \| null \{\n  return value === 'opencode-bundled' \? null : value\n\}/u,
)
assert.ok(helperMatch, 'ACP migration helper must remain exported with its pure compatibility behavior')
const normalizeHiddenAcpProviderId = Function(
  `${helperMatch[0]
    .replace('export ', '')
    .replace('(value: string | null): string | null', '(value)')}\nreturn normalizeHiddenAcpProviderId`,
)()
assert.equal(normalizeHiddenAcpProviderId(null), null)
assert.equal(normalizeHiddenAcpProviderId('opencode-bundled'), null)
assert.equal(normalizeHiddenAcpProviderId('qoder'), 'qoder')

const acpBackend = read('src-tauri/src/acp.rs')
const tauriEntry = read('src-tauri/src/lib.rs')
for (const protocolSurface of [
  'acp_list_providers',
  'acp_start_session',
  'acp_send_prompt',
  'acp_cancel_turn',
  'acp_respond_permission',
  'acp_finish_session',
  'session/request_permission',
  '"plan"',
  'process_tree::configure_command',
  'process_tree::terminate_process_group',
]) {
  assert.ok(acpBackend.includes(protocolSurface), `ACP protocol surface is missing ${protocolSurface}`)
}
assert.ok(!exists('src-tauri/src/acp_agent.rs'), 'dedicated ACP agent module must be deleted')
for (const removedEntryPoint of ['mod acp_agent;', 'acp_agent::agent_acp_prompt']) {
  assert.ok(!tauriEntry.includes(removedEntryPoint), `removed ACP entry point remains: ${removedEntryPoint}`)
}
const providerRegistryStart = acpBackend.indexOf('const ACP_PROVIDERS:')
const providerRegistryEnd = acpBackend.indexOf('\n];', providerRegistryStart)
assert.ok(providerRegistryStart >= 0 && providerRegistryEnd > providerRegistryStart, 'ACP provider registry is missing')
const providerRegistry = acpBackend.slice(providerRegistryStart, providerRegistryEnd)
for (const removedProvider of ['id: "codex"', 'id: "qwen-code"', 'command: &["npx"', '"-y"']) {
  assert.ok(!providerRegistry.includes(removedProvider), `remote npx ACP provider remains: ${removedProvider}`)
}
assert.doesNotMatch(
  providerRegistry,
  /\bkind:\s*AcpProviderKind::Bundled\b/u,
  'the current ACP provider registry must remain external-only',
)

const bundledOpenCodePatterns = [
  /\bid:\s*"opencode-bundled"\b/iu,
  /\b(?:bundled|sidecar)_opencode(?:_[a-z0-9]+)*\b/iu,
  /\bopencode(?:_[a-z0-9]+)*_(?:bundled|sidecar)(?:_[a-z0-9]+)*\b/iu,
  /\bopencode_(?:launch|path|command)_config\b/iu,
  /\b(?:resolve|launch|path|command|config)_[a-z0-9_]*(?:bundled|sidecar)[a-z0-9_]*\s*\([^)]*['"]opencode['"]/iu,
]
const harmlessBundledProviderFixture = [
  'kind: AcpProviderKind::Bundled',
  'fn resolve_bundled_sidecar() {}',
  'resolve_bundled_sidecar("node")',
].join('\n')
for (const pattern of bundledOpenCodePatterns) {
  assert.doesNotMatch(
    harmlessBundledProviderFixture,
    pattern,
    'an unrelated bundled provider kind and sidecar helper must remain permitted',
  )
  assert.doesNotMatch(
    acpBackend,
    pattern,
    `bundled OpenCode implementation remains: ${pattern}`,
  )
}

const opencodeBundledBuildArtifact = /(?:fetch-opencode-sidecar|opencode-sidecar-smoke|binaries[\\/]opencode(?:[-_.\\/]|$))/iu
const packageJson = read('package.json')
const desktopScript = read('scripts/desktop.mjs')
const tauriConfigSources = fs
  .readdirSync(path.join(root, 'src-tauri'))
  .filter(entry => /^tauri.*\.json$/u.test(entry))
  .map(entry => read(path.join('src-tauri', entry)))
for (const source of [packageJson, desktopScript, ...tauriConfigSources]) {
  assert.doesNotMatch(source, opencodeBundledBuildArtifact, 'OpenCode bundled build artifact remains')
}
for (const bundledFile of [
  'scripts/fetch-opencode-sidecar.mjs',
  'scripts/opencode-sidecar-smoke.mjs',
]) {
  assert.ok(!exists(bundledFile), `bundled file remains: ${bundledFile}`)
}
const binaryDirectory = 'src-tauri/binaries'
if (exists(binaryDirectory)) {
  for (const binaryFile of fs.readdirSync(path.join(root, binaryDirectory))) {
    assert.doesNotMatch(
      binaryFile,
      /^opencode(?:[-_.]|$)/iu,
      `OpenCode binary remains: ${path.join(binaryDirectory, binaryFile)}`,
    )
  }
}
for (const hiddenUiFile of [
  'src/views/AgentHomeView.tsx',
  'src/views/AgentHomeView.css',
  'src/hooks/useAgentConversations.ts',
  'src/services/acpConversation.ts',
]) {
  assert.ok(!exists(hiddenUiFile), `normal ACP UI artifact remains: ${hiddenUiFile}`)
}
assert.ok(!read('src/App.tsx').includes('services/acp'), 'App must not mount ACP UI services')

console.log(JSON.stringify({ status: 'passed', checks: 27 }))
