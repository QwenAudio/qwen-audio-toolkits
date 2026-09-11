import assert from 'node:assert/strict'
import {
  agentFileCanPreview,
  agentFileExtension,
  agentFileKind,
  uniqueAgentFiles,
} from '../src/domain/agentFiles'

const audio = { path: '/tmp/longanhuan_enhanced.wav', name: 'longanhuan_enhanced.wav' }
const video = { path: '/tmp/cut.mov', name: 'cut.mov' }
const document = { path: '/tmp/script.md', name: 'script.md' }
const unknown = { path: '/tmp/archive.bin', name: 'archive.bin' }

assert.equal(agentFileExtension(audio), 'wav')
assert.equal(agentFileKind(audio), 'audio')
assert.equal(agentFileCanPreview(audio), true)
assert.equal(agentFileKind(video), 'video')
assert.equal(agentFileCanPreview(video), false)
assert.equal(agentFileKind(document), 'document')
assert.equal(agentFileKind(unknown), 'file')
assert.deepEqual(uniqueAgentFiles([audio, audio, null, document]), [audio, document])

console.log(JSON.stringify({ status: 'passed', checks: 8 }, null, 2))
