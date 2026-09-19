import assert from 'node:assert/strict'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'
import { reconcilePythonAgentSelection } from '../src/services/agentSidebarState.ts'

const descriptor = {
  uiId: 'python.catalog-agent',
  serverId: 'catalog-agent',
  title: 'Catalog Agent',
}
const registry = createAgentInstallRegistry([descriptor])

registry.transition(descriptor.uiId, 'installed')
assert.equal(
  reconcilePythonAgentSelection(descriptor.uiId, registry.snapshot()),
  descriptor.uiId,
  'an installed Agent remains selectable',
)

registry.transition(descriptor.uiId, 'uninstalling')
assert.equal(
  reconcilePythonAgentSelection(descriptor.uiId, registry.snapshot()),
  null,
  'an uninstalling Agent must immediately return the workspace to the boss',
)

registry.transition(descriptor.uiId, 'uninstalled')
assert.equal(
  reconcilePythonAgentSelection(descriptor.uiId, registry.snapshot()),
  null,
  'an uninstalled Agent must not be remounted by a stale selection',
)

console.log(JSON.stringify({ status: 'passed', checks: 3 }, null, 2))
