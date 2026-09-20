import assert from 'node:assert/strict'
import type { ModelPlugin } from '../src/types.ts'
import { createAgentInstallRegistry } from '../src/services/agentInstallState.ts'
import { buildPythonAgentSidebarGroups } from '../src/services/agentSidebarState.ts'

const first = { id: 'catalog-meeting-agent', title: 'Meeting Agent' }
const second = { id: 'catalog-video-agent', title: 'Video Agent' }
const registry = createAgentInstallRegistry([first, second])
registry.transition(first.id, 'installed')
registry.transition(second.id, 'installed')
const model = { id: 'local-model' } as ModelPlugin
const groups = buildPythonAgentSidebarGroups({
  modelGroups: [{ id: 'Text-to-Audio', label: 'Text-to-Audio', models: [model] }],
  agents: registry.snapshot(), definitions: [model], groupOrder: ['Text-to-Audio'], categoryForModel: () => 'Text-to-Audio',
})
assert.deepEqual(groups.find((group) => group.id === 'Text-to-Audio')?.models, [model])
assert.deepEqual(groups.find((group) => group.id === 'agents')?.agents.map((agent) => agent.id).sort(), [first.id, second.id].sort())
console.log(JSON.stringify({ status: 'passed', checks: 2 }, null, 2))
