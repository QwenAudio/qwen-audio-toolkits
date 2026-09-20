import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'

const [catalog, app, installer, exporter] = await Promise.all([
  readFile(new URL('../catalog/agent-catalog.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/agent_catalog.rs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/export-agent-repository-catalog.mjs', import.meta.url), 'utf8'),
])
assert.equal(catalog.schemaVersion, 1)
assert.ok(Array.isArray(catalog.agents))
assert.match(installer, /agents\/catalog\.json/)
assert.match(installer, /Agent 包校验失败/)
assert.doesNotMatch(installer, /agent_server/)
assert.match(app, /<AgentCatalogView/)
assert.doesNotMatch(app, /AgentServer|agentServer|PluginsView/)
assert.match(exporter, /archive checksum does not match/)
const registry = createAgentInstallRegistry()
registry.replaceCatalog([{ id: 'meeting.notes', title: '会议纪要', category: 'Text' }])
registry.transition('meeting.notes', 'installed', { revision: 'abc' })
registry.replaceCatalog([{ id: 'meeting.notes', title: '会议纪要', category: 'Text', version: '2' }])
assert.equal(registry.snapshot()[0]?.revision, 'abc')
console.log(JSON.stringify({ status: 'passed', checks: 8 }, null, 2))
