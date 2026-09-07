import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Deliberately scoped to the isolated Agent preview, never the production API.
const api = 'http://127.0.0.1:3848/v1'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-validation-'))
const stamp = Date.now()
const installed = new Set()
const runs = []
const checks = []
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(api + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  return { status: response.status, data }
}
function project(label) {
  return {
    kind: 'data-processing-agent', schemaVersion: 1,
    id: `validation.${label}-${stamp}`, name: label, version: '1', publisher: 'Local validation',
    task: '本地测试降噪', usage: { inputRequirements: ['PCM 音频'], limitations: ['测试项目'], examples: ['清理测试音频'] },
    harness: { kind: 'host-adapter', adapter: 'rnnoise', capability: 'audio.enhance' },
    runtime: { kind: 'native', entry: 'nnnoiseless' },
    models: [{ id: 'embedded', source: '', files: [] }],
    inputs: [{ name: 'audio', type: 'audio' }], outputs: [{ name: 'audio', type: 'audio' }],
  }
}
function fixture(label, value = project(label)) {
  const directory = path.join(root, label)
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'agent.json'), JSON.stringify(value))
  fs.writeFileSync(path.join(directory, 'README.md'), 'Validation project\n')
  fs.writeFileSync(path.join(directory, 'resources', 'usage.txt'), 'Project-owned resource\n')
  return directory
}
async function install(source, expected = 200, message) {
  const result = await request('/plugins', { path: source })
  if (result.status === 200) installed.add(result.data.id)
  assert.equal(result.status, expected, JSON.stringify(result.data))
  if (message) assert.match(result.data.error, message)
  return result.data
}
async function execute(providerId, capability, input, parameters = {}, expected = 'completed') {
  const result = await request('/runs', { providerId, capability, input, parameters, title: 'Agent validation' })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  runs.push(result.data.id)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { data } = await request(`/runs/${result.data.id}`)
    if (['completed', 'failed', 'canceled'].includes(data.status)) {
      assert.equal(data.status, expected, JSON.stringify(data.error))
      return expected === 'completed' ? (await request(`/runs/${data.id}/output`)).data.output : data
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Run timeout: ${result.data.id}`)
}
function syntheticWav() {
  const count = 32_000
  const bytes = Buffer.alloc(44 + count * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / 16_000) * 2000), 44 + i * 2)
  return bytes
}
try {
  const { data: catalog, status } = await request('/plugins')
  assert.equal(status, 200)
  assert.ok(catalog.length >= 35)
  assert.ok(catalog.every(p => p.agent && p.inputs.length && p.outputs.length))
  checks.push('catalog-contracts')
  const directory = fixture('folder')
  const plugin = await install(directory)
  assert.equal(fs.readFileSync(path.join(plugin.installPath, 'resources', 'usage.txt'), 'utf8'), 'Project-owned resource\n')
  assert.equal(fs.readFileSync(path.join(plugin.installPath, 'README.md'), 'utf8'), 'Validation project\n')
  checks.push('folder-and-resources')
  const duplicate = project('folder')
  duplicate.models[0].source = 'https://127.0.0.1:1/must-not-download.onnx'
  fs.writeFileSync(path.join(directory, 'agent.json'), JSON.stringify(duplicate))
  await install(directory, 400, /已安装/)
  checks.push('duplicate-rejected-before-download')
  await install(path.join(fixture('manifest'), 'agent.json'))
  checks.push('direct-manifest-import')
  const zipSource = fixture('zip')
  const archive = path.join(root, 'project.zip')
  execFileSync('python3', ['-m', 'zipfile', '-c', archive, zipSource])
  await install(archive)
  checks.push('zip-import')
  for (const [name, modify] of [
    ['dependency', p => { p.recommendedDependencies = [{ pluginId: 'other.agent' }] }],
    ['executable', p => { p.harness.kind = 'shell' }],
    ['bundles', p => { p.models.push(p.models[0]) }],
    ['empty-input', p => { p.inputs = [] }],
    ['duplicate-port', p => { p.inputs.push(p.inputs[0]) }],
    ['invalid-port', p => { p.outputs[0].type = 'not-a-port' }],
    ['path-traversal', p => { p.models[0].files = ['../outside'] }],
  ]) {
    const invalid = project(name); modify(invalid)
    await install(fixture(name, invalid), 400)
    checks.push(`reject-${name}`)
  }
  const ambiguous = fixture('ambiguous')
  fs.copyFileSync(path.join(ambiguous, 'agent.json'), path.join(ambiguous, 'plugin.json'))
  await install(ambiguous, 400)
  const linked = fixture('symlink')
  fs.symlinkSync(path.join(directory, 'README.md'), path.join(linked, 'linked-readme'))
  await install(linked, 400)
  checks.push('reject-ambiguous-and-symlink')
  const previousBindings = (await request('/plugin-bindings')).data
  const denied = await request('/plugin-bindings', { ...previousBindings, [plugin.id]: { vad: 'silero-vad' } }, 'PUT')
  assert.equal(denied.status, 400)
  assert.deepEqual((await request('/plugin-bindings')).data, previousBindings)
  checks.push('cross-agent-bindings-rejected-without-mutation')
  const audio = process.env.QWEN_AUDIO_AGENT_SMOKE_WAV ? fs.readFileSync(process.env.QWEN_AUDIO_AGENT_SMOKE_WAV) : syntheticWav()
  const input = { clipName: 'agent-validation.wav', audioDataUrl: `data:audio/wav;base64,${audio.toString('base64')}` }
  const output = await execute(`plugin.${plugin.id}`, 'audio.enhance', input, { operations: ['denoise'] })
  assert.ok(output.duration > 0 && output.sampleRate > 0)
  assert.equal(Buffer.from(output.dataUrl.split(',')[1], 'base64').toString('ascii', 0, 4), 'RIFF')
  assert.ok(fs.statSync(output.filePath).size > 44)
  checks.push('rnnoise-execution-and-wav-artifact')
  await execute(`plugin.${plugin.id}`, 'audio.enhance', { ...input, audioDataUrl: 'data:audio/wav;base64,bm90LXdhdg==' }, { operations: ['denoise'] }, 'failed')
  checks.push('invalid-audio-fails-cleanly')
  if (catalog.some(p => p.id === 'k2-fsa.speaker-embedding' && p.installed)) {
    const embedding = await execute('plugin.k2-fsa.speaker-embedding', 'speaker.embed', input)
    assert.equal(embedding.dimension, 192); assert.equal(embedding.embedding.length, 192)
    assert.ok(embedding.embedding.every(Number.isFinite))
    const compared = await execute('plugin.k2-fsa.speaker-embedding', 'speaker.embed', { ...input, comparisonAudioDataUrl: input.audioDataUrl })
    assert.ok(compared.cosineSimilarity > 0.999)
    checks.push('speaker-embedding-and-identical-audio-comparison')
  }
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2))
} finally {
  for (const id of runs) await request(`/runs/${id}`, undefined, 'DELETE')
  for (const id of installed) await request(`/plugins/${encodeURIComponent(id)}`, undefined, 'DELETE')
  fs.rmSync(root, { recursive: true, force: true })
}
