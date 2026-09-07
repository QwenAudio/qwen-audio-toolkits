import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getModelBinding, recommendedDependencies, referencingModels } from '../src/modelDependencies.ts'

const project = JSON.parse(readFileSync(new URL('../examples/agents/audio-to-text/agent.json', import.meta.url)))
const independent = {
  id: project.id,
  installed: true,
  adapter: project.harness.adapter,
  harnessCapabilities: [project.harness.capability],
  agent: { task: project.task, harness: project.harness, usage: project.usage },
  recommendedDependencies: [{ role: 'speech-segmentation', pluginId: 'other.vad', default: true }],
}
const legacy = {
  id: 'legacy.asr', installed: true, adapter: 'qwen3-asr', harnessCapabilities: ['speech.transcribe'],
}
assert.deepEqual(recommendedDependencies(independent), [])
assert.equal(recommendedDependencies(legacy).length, 1)
assert.equal(getModelBinding({}, legacy.id, 'reference-transcription', independent.id, [legacy, independent]), '')
assert.equal(getModelBinding({ [independent.id]: { vad: legacy.id } }, independent.id, 'vad', '', [legacy, independent]), '')
assert.deepEqual(referencingModels(independent.id, [independent, legacy], { [legacy.id]: { vad: independent.id } }), [])
assert.ok(project.models[0].files.includes('fsmn-vad.gguf'))
console.log('Agent projects: independent bindings, legacy compatibility and bundled VAD passed.')

const { cloudModelsFromCatalog } = await import('../src/cloudModels.ts')
const { initialPlugins } = await import('../src/data.ts')
const apiEntries = JSON.parse(readFileSync(new URL('../catalog/api-models.json', import.meta.url)))
const providers = [...new Set(apiEntries.map(entry => entry.providerId))].map(id => ({ id, name: id, status: 'ready' }))
providers.push({ id: 'api.custom.smoke', name: 'Smoke provider', status: 'ready' })
const apiAgents = cloudModelsFromCatalog({ providers }, [], [], [{
  id: 'custom-smoke', providerId: 'api.custom.smoke', modelId: 'test-model', name: 'Test API', capability: 'text.generate',
}])
assert.ok(apiAgents.length > 1)
for (const model of [...initialPlugins, ...apiAgents]) {
  assert.ok(model.agent, model.id)
  assert.equal(model.agent.harness.adapter, model.adapter)
  assert.equal(model.agent.harness.capability, model.harnessCapabilities[0])
  assert.ok(model.inputs.length && model.outputs.length)
  assert.deepEqual(recommendedDependencies(model), [])
}
console.log(`Agent coverage: ${apiAgents.length} API projects and browser builtins passed.`)
