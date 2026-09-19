import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { initialPlugins } from '../src/data.ts'
import { cloudModelsFromCatalog } from '../src/cloudModels.ts'
import { modelTaxonomy } from '../src/domain/modelTaxonomy.ts'
import { capabilityDefinition } from '../src/domain/capabilities.ts'
import { readApiModelCatalog } from './lib/api-model-catalog.mjs'

const source = await readFile('src-tauri/src/plugins.rs', 'utf8')
const manifests = [...source.matchAll(/const\s+([A-Z0-9_]+_MANIFEST):\s*&str\s*=\s*r#"([\s\S]*?)"#;/g)]
  .map(match => JSON.parse(match[2]))
const authorFunction = source.split('fn canonical_model_author(')[1].split('fn runtime_author(')[0]
const authors = new Map([...authorFunction.matchAll(/((?:"[^"]+"\s*(?:\|\s*)?)+)=>\s*\{?\s*"([^"]+)"/g)]
  .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(id => [id[1], match[2]])))
assert.equal(authors.get('k2-fsa.speaker-embedding'), 'Alibaba DAMO Academy')
const apiEntries = await readApiModelCatalog()
const api = cloudModelsFromCatalog({ providers: [...new Set(apiEntries.map(p => p.providerId))].map(id => ({ id, name: id, status: 'ready' })) })
const repository = 'https://github.com/QwenAudio/qwen-audio-toolkits'
const categories = { audio: 'Audio', text: 'Text', vision: 'Vision', multimodal: 'Multimodal' }
const entries = []

async function entry(model, metadata, mode) {
  const taxonomy = modelTaxonomy(model)
  let readme = ''
  try { readme = await readFile(`src/content/model-notes/${model.id}.md`, 'utf8') }
  catch (e) { if (e.code !== 'ENOENT') throw e }
  assert.ok(model.agent?.harness && model.inputs.length && model.outputs.length, model.id)
  entries.push({ id: model.id, name: model.name, repository, description: model.description,
    category: categories[taxonomy.primaryCategory], runtime: mode,
    metadata: { execution: 'host-adapter', source_id: model.id, author: model.author,
      catalog_version: model.version, secondary_category: taxonomy.secondaryCategory,
      capabilities: model.capabilities, agent: model.agent, inputs: model.inputs, outputs: model.outputs,
      readme, ...metadata } })
}

for (const manifest of manifests) {
  await entry({ ...manifest, author: authors.get(manifest.id) || manifest.publisher,
    capabilities: manifest.displayCapabilities || [capabilityDefinition(manifest.agent.harness.capability).label],
    harnessCapabilities: [manifest.agent.harness.capability] }, {
    models: manifest.models, license: manifest.license || '',
    runtime_engine: manifest.runtime.entry, parameters: manifest.parameters || [],
    manifest,
  }, 'offline')
}
const silero = initialPlugins.find(model => model.id === 'silero-vad')
assert.ok(silero)
await entry(silero, { runtime_engine: silero.runtime, models: [{
  id: 'silero-vad', name: 'Silero VAD', files: ['silero_vad.onnx'],
  source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
}] }, 'offline')
for (const model of api) {
  const definition = apiEntries.find(p => p.id === model.id)
  await entry(model, { runtime_engine: model.runtime, provider_id: definition.providerId,
    model_id: definition.modelId, streaming_mode: definition.streamingMode, api_definition: definition }, 'api')
}
assert.equal(new Set(entries.map(p => p.id)).size, entries.length)
assert.equal(manifests.length, 34)
entries.sort((a, b) => a.id.localeCompare(b.id, 'en'))
const output = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!output) throw new Error('请传入 agent-server 仓库的 agent_server/builtin-agents.json 输出路径')
const value = { schemaVersion: 1, source: repository, agents: entries }
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value, 'Run npm run agents:export')
} else {
  await writeFile(output, JSON.stringify(value, null, 2) + '\n')
}
console.log(`Agent Server catalog: ${entries.length} projects (35 local, ${api.length} API).`)
