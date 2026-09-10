import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJsonCache, readJsonIfValid } from './lib/video-dubbing/cache.mjs'
import { isRetryableApiError } from './lib/video-dubbing/harness-client.mjs'
import {
  batchTurns,
  buildTransformationPrompt,
  distributeScriptAcrossTurns,
  normalizeDubbingMode,
} from './lib/video-dubbing/script-planner.mjs'

assert.equal(normalizeDubbingMode('rewrite'), 'rewrite')
assert.equal(normalizeDubbingMode('unknown'), 'translate')
assert.match(buildTransformationPrompt('translate'), /简体中文/u)
assert.match(buildTransformationPrompt('rewrite', '更简洁'), /保持原始语言/u)
assert.match(buildTransformationPrompt('rewrite', '更简洁'), /用户要求：更简洁/u)
assert.equal(isRetryableApiError('connection timed out'), true)
assert.equal(isRetryableApiError('invalid request'), false)

const sourceTurns = [
  { id: 'turn-1', speaker: 'SPK 1', start: 0, end: 2, text: 'first' },
  { id: 'turn-2', speaker: 'SPK 2', start: 2, end: 6, text: 'second' },
]
const script = '大家好，欢迎来到节目。今天我们讨论音频模型。'
const planned = distributeScriptAcrossTurns(script, sourceTurns)
assert.equal(planned.length, sourceTurns.length)
assert.equal(planned.map((turn) => turn.text).join(''), script)
assert.deepEqual(planned.map(({ id, speaker, start, end }) => ({ id, speaker, start, end })), sourceTurns.map(
  ({ id, speaker, start, end }) => ({ id, speaker, start, end }),
))
assert.throws(() => distributeScriptAcrossTurns('', sourceTurns), /完整配音文案/u)
assert.throws(() => distributeScriptAcrossTurns('短', sourceTurns), /新文案过短/u)

const batches = batchTurns([
  { id: '1', text: 'a' },
  { id: '2', text: 'b' },
  { id: '3', text: 'c' },
  { id: '4', text: 'd' },
])
assert.deepEqual(batches.map((batch) => batch.map((turn) => turn.id)), [['1', '2', '3'], ['4']])

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-video-dubbing-'))
try {
  const cache = createJsonCache(temporaryDirectory)
  cache.saveJson('result.json', { status: 'ok' })
  assert.deepEqual(readJsonIfValid(path.join(temporaryDirectory, 'result.json')), { status: 'ok' })
  fs.writeFileSync(path.join(temporaryDirectory, 'result.json'), '{broken')
  let produced = false
  const recovered = await cache.cachedJson('result.json', async () => {
    produced = true
    return { status: 'recovered' }
  })
  assert.equal(produced, true)
  assert.deepEqual(recovered, { status: 'recovered' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'result.json'), 'utf8')), recovered)
  assert.equal(fs.readdirSync(temporaryDirectory).some((name) => name.endsWith('.tmp')), false)
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('video dubbing smoke: ok')
