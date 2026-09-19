import assert from 'node:assert/strict'
import type { ModelPlugin } from '../src/types.ts'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'
import { buildPythonAgentSidebarGroups } from '../src/services/agentSidebarState.ts'

const builtin = {
  uiId: 'python.builtin-agent',
  serverId: 'catalog-builtin-agent',
  title: 'Builtin Agent',
}
const unmatched = {
  uiId: 'python.unmatched-agent',
  serverId: 'catalog-unmatched-agent',
  title: 'Unmatched Agent',
}
const registry = createAgentInstallRegistry([builtin, unmatched])
registry.transition(builtin.uiId, 'installed')
registry.transition(unmatched.uiId, 'installed')

const builtinModel = { id: builtin.serverId } as ModelPlugin
const groups = buildPythonAgentSidebarGroups({
  modelGroups: [{
    id: 'Text-to-Audio',
    label: 'Text-to-Audio',
    models: [builtinModel],
  }],
  agents: registry.snapshot(),
  definitions: [builtinModel],
  groupOrder: ['Text-to-Audio'],
  categoryForModel: () => 'Text-to-Audio',
})

const builtinGroup = groups.find((group) => group.id === 'Text-to-Audio')
assert.deepEqual(
  builtinGroup?.models,
  [],
  'an installed built-in Agent must replace its matching server-ID model entry',
)
assert.deepEqual(
  builtinGroup?.agents.map((agent) => agent.uiId),
  [builtin.uiId],
  'the built-in Agent must use the matching model taxonomy group',
)

const otherGroup = groups.find((group) => group.id === '其他')
assert.deepEqual(
  otherGroup?.agents.map((agent) => agent.uiId),
  [unmatched.uiId],
  'only an installed Agent without a server-ID model definition belongs in Other',
)

registry.transition(builtin.uiId, 'uninstalling')
const uninstallingGroups = buildPythonAgentSidebarGroups({
  modelGroups: [{
    id: 'Text-to-Audio',
    label: 'Text-to-Audio',
    models: [builtinModel],
  }],
  agents: registry.snapshot(),
  definitions: [],
  groupOrder: ['Text-to-Audio'],
  categoryForModel: () => 'Text-to-Audio',
})
const uninstallingBuiltinGroup = uninstallingGroups.find(
  (group) => group.id === 'Text-to-Audio',
)
assert.deepEqual(
  uninstallingBuiltinGroup?.models,
  [],
  'an uninstalling Agent must continue to replace its matching server-ID model entry',
)
assert.deepEqual(
  uninstallingBuiltinGroup?.agents.map((agent) => agent.uiId),
  [builtin.uiId],
  'an uninstalling Agent with a matching sidebar model must remain in that model group',
)
assert.deepEqual(
  uninstallingGroups.find((group) => group.id === '其他')?.agents.map((agent) => agent.uiId),
  [unmatched.uiId],
  'Other must retain only agents without a matching server-ID model',
)

console.log(JSON.stringify({ status: 'passed', checks: 6 }, null, 2))
