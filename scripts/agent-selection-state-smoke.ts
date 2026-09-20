import assert from 'node:assert/strict'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'
import { reconcilePythonAgentSelection } from '../src/services/agentSidebarState.ts'

const descriptor = { id: 'catalog-agent', title: 'Catalog Agent' }
const registry = createAgentInstallRegistry([descriptor])

registry.transition(descriptor.id, 'installed')
assert.equal(reconcilePythonAgentSelection(descriptor.id, registry.snapshot()), descriptor.id)
registry.transition(descriptor.id, 'uninstalling')
assert.equal(reconcilePythonAgentSelection(descriptor.id, registry.snapshot()), null)
registry.transition(descriptor.id, 'uninstalled')
assert.equal(reconcilePythonAgentSelection(descriptor.id, registry.snapshot()), null)
console.log(JSON.stringify({ status: 'passed', checks: 3 }, null, 2))
