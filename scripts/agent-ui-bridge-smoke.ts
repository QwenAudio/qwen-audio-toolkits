import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as harness from '../src/services/harness.ts'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'

const sdkUi = await readFile(new URL('../toolkits/ui.js', import.meta.url), 'utf8')
assert.match(sdkUi, /toolkits-host-ready/)
assert.doesNotMatch(sdkUi, /window\.parent\.postMessage\([^,]+,\s*["']\*["']\)/)
const descriptor = { id: 'captions.agent', title: 'Captions' }
const registry = createAgentInstallRegistry([descriptor])
const invokes: Array<{ command: string; args?: unknown }> = []
const agentUi = harness.createAgentUiHarness({
  registry,
  invoke: async <T>(command: string, args?: unknown) => {
    invokes.push({ command, args })
    if (command === 'agent_ui_installed') return [{ id: descriptor.id, title: descriptor.title, revision: 'r1' }] as T
    return { id: descriptor.id, title: descriptor.title, revision: 'r2', url: 'http://127.0.0.1:4123/' } as T
  },
  listen: async () => () => {},
})
await assert.rejects(() => agentUi.openAgentUi('unknown.agent'), /Unknown Agent ID/)
const session = await agentUi.openAgentUi(descriptor.id)
assert.deepEqual(invokes.pop(), { command: 'agent_ui_open', args: { id: descriptor.id } })
assert.deepEqual(registry.assertSession(descriptor.id, session), descriptor)
await agentUi.stopAgentUi(descriptor.id, session.url)
assert.deepEqual(invokes.pop(), { command: 'agent_ui_stop', args: { id: descriptor.id, url: session.url } })
await agentUi.installAgentUi(descriptor.id)
assert.deepEqual(invokes.pop(), { command: 'agent_ui_install', args: { id: descriptor.id, update: false } })
await agentUi.uninstallAgentUi(descriptor.id)
assert.deepEqual(invokes.pop(), { command: 'agent_ui_uninstall', args: { id: descriptor.id } })
await agentUi.listInstalledAgentUi()
assert.equal(registry.snapshot()[0]?.status, 'installed')
console.log(JSON.stringify({ status: 'passed', checks: 7 }, null, 2))
