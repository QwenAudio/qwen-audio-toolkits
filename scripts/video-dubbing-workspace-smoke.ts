import assert from 'node:assert/strict'
import {
  configureVideoDubbing, readVideoDubbingSettings, reusableVideoDubbingDirectory,
  videoDubbingFingerprint, type VideoDubbingSettings,
} from '../src/domain/videoDubbingWorkspace'
import { readVideoDubbingSnapshot } from '../src/domain/editorSnapshots'

const source = '/media/interview.mp4'
const settings: VideoDubbingSettings = {
  instruction: '保留原意和节奏', mode: 'translate', sourceLanguage: 'en', targetLanguage: 'zh', style: 'natural',
}
const fingerprint = videoDubbingFingerprint(source, settings)
assert.deepEqual(configureVideoDubbing(settings, { targetLanguage: 'ja', style: 'casual' }), {
  ...settings, targetLanguage: 'ja', style: 'casual',
})
assert.equal(settings.targetLanguage, 'zh', 'configuring does not mutate the prior project state')
for (const args of [{}, { outputDir: '/other' }, { mode: 'invalid' }, { sourceLanguage: '??' },
  { targetLanguage: 'auto' }, { style: 'loud' }, { instruction: 42 }, { instruction: 'x'.repeat(50001) }]) {
  assert.throws(() => configureVideoDubbing(settings, args))
}
for (const args of [
  { instruction: '使用更短的句子' }, { mode: 'rewrite' }, { sourceLanguage: 'ja' },
  { targetLanguage: 'en' }, { style: 'formal' },
]) {
  const next = videoDubbingFingerprint(source, configureVideoDubbing(settings, args))
  assert.notEqual(next, fingerprint, `changed ${Object.keys(args)[0]} invalidates prior outputs`)
  assert.equal(reusableVideoDubbingDirectory('/cache/old', fingerprint, next, 'failed'), undefined,
    'changed settings never reuse the native pipeline directory cache')
}
assert.notEqual(videoDubbingFingerprint('/media/other.mp4', settings), fingerprint)
assert.equal(videoDubbingFingerprint(source, { ...settings, instruction: '  保留原意和节奏  ' }), fingerprint)
const rewrite = { ...settings, mode: 'rewrite' as const }
assert.equal(videoDubbingFingerprint(source, rewrite), videoDubbingFingerprint(source, { ...rewrite, targetLanguage: 'ja' }),
  'rewrite uses the source language; inactive target selection does not affect rendered output')
assert.equal(reusableVideoDubbingDirectory('/cache/old', fingerprint, fingerprint, 'failed'), '/cache/old')
assert.equal(reusableVideoDubbingDirectory('/cache/old', fingerprint, fingerprint, 'canceled'), '/cache/old')
for (const status of [undefined, 'running', 'completed']) {
  assert.equal(reusableVideoDubbingDirectory('/cache/old', fingerprint, fingerprint, status), undefined)
}
assert.equal(reusableVideoDubbingDirectory('', fingerprint, fingerprint, 'failed'), undefined)

const restored = readVideoDubbingSnapshot({
  version: 1, settings, runFingerprint: fingerprint, outputDir: '/cache/old',
  progress: { status: 'running', taskId: 'old-task', stage: 'dubbing', progress: 40 },
})!
assert.deepEqual(restored.settings, settings)
assert.equal(restored.runFingerprint, fingerprint)
assert.equal(restored.progress?.status, 'failed')
assert.equal(reusableVideoDubbingDirectory(restored.outputDir, restored.runFingerprint!, fingerprint, restored.progress?.status), '/cache/old',
  'restored interruption can reuse matching completed work')
const edited = configureVideoDubbing(restored.settings!, { instruction: '已经修改但尚未生成的要求' })
const editedSnapshot = readVideoDubbingSnapshot({ ...restored, settings: edited })!
assert.notEqual(videoDubbingFingerprint(source, editedSnapshot.settings!), editedSnapshot.runFingerprint,
  'unsynthesized changes remain stale after a restart')
assert.deepEqual(readVideoDubbingSnapshot(JSON.parse(JSON.stringify(editedSnapshot))), editedSnapshot)
for (const invalid of [null, [], 'bad', { ...settings, mode: 'other' }, { ...settings, targetLanguage: 'auto' }]) {
  assert.equal(readVideoDubbingSettings(invalid), undefined)
}
console.log('video dubbing workspace smoke tests passed')
