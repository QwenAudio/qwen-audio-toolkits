import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as harness from '../src/services/harness.ts'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'

const sdkUi = await readFile(new URL('../toolkits/ui.js', import.meta.url), 'utf8')
assert.match(sdkUi, /toolkits-host-ready/, 'SDK iframe must establish a trusted host origin')
assert.doesNotMatch(
  sdkUi,
  /window\.parent\.postMessage\([^,]+,\s*["']\*["']\)/,
  'SDK iframe must not post privileged requests to a wildcard origin',
)

assert.equal(
  typeof harness.createAgentUiHarness,
  'function',
  'Agent UI commands need an injectable typed harness API',
)

const descriptor = {
  uiId: 'captions.agent',
  serverId: 'server.captions',
  title: 'Captions',
}
const registry = createAgentInstallRegistry([descriptor])
const invokes: Array<{ command: string; args?: unknown }> = []
const agentUi = harness.createAgentUiHarness({
  registry,
  invoke: async <T>(command: string, args?: unknown) => {
    invokes.push({ command, args })
    if (command === 'agent_ui_installed') {
      return [{ id: descriptor.serverId, title: descriptor.title, revision: 'r1' }] as T
    }
    return { id: descriptor.serverId, title: descriptor.title, revision: 'r2', url: 'http://127.0.0.1:4123/' } as T
  },
  listen: async () => () => {},
})

await assert.rejects(() => agentUi.openAgentUi('unknown.agent'), /Unknown Agent UI ID/)
assert.deepEqual(invokes, [], 'unknown UI IDs must not reach native IPC')

const session = await agentUi.openAgentUi(descriptor.uiId)
assert.equal(session.url, 'http://127.0.0.1:4123/')
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_open',
  args: { id: descriptor.serverId },
})
assert.deepEqual(registry.assertSession(descriptor.uiId, session), descriptor)

await agentUi.stopAgentUi(descriptor.uiId, session.url)
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_stop',
  args: { id: descriptor.serverId, url: session.url },
})
assert.throws(() => registry.assertSession(descriptor.uiId, session), /not trusted/)

await agentUi.installAgentUi(descriptor.uiId)
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_install',
  args: { id: descriptor.serverId, update: false },
})
await agentUi.installAgentUi(descriptor.uiId, true)
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_install',
  args: { id: descriptor.serverId, update: true },
})
await agentUi.uninstallAgentUi(descriptor.uiId)
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_uninstall',
  args: { id: descriptor.serverId },
})

await agentUi.listInstalledAgentUi()
assert.deepEqual(registry.snapshot(), [{ ...descriptor, status: 'installed', revision: 'r1' }])
assert.deepEqual(invokes.pop(), {
  command: 'agent_ui_installed',
  args: undefined,
})

console.log(JSON.stringify({ status: 'passed', checks: 8 }, null, 2))
