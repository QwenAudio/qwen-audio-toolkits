import assert from 'node:assert/strict'
import {
  configureVideoDubbing, readVideoDubbingSettings, reusableVideoDubbingDirectory,
  VIDEO_DUBBING_LANGUAGES, videoDubbingFingerprint, type VideoDubbingSettings,
} from '../src/domain/videoDubbingWorkspace'
import { readVideoDubbingSnapshot } from '../src/domain/editorSnapshots'

const source = '/media/interview.mp4'
const settings: VideoDubbingSettings = {
  instruction: '保留原意和节奏', mode: 'translate', sourceLanguage: 'en', targetLanguage: 'zh', style: 'natural',
}
const fingerprint = videoDubbingFingerprint(source, settings)
for (const language of VIDEO_DUBBING_LANGUAGES) {
  const configured = configureVideoDubbing(settings, { sourceLanguage: language, targetLanguage: language })
  assert.deepEqual(readVideoDubbingSettings(JSON.parse(JSON.stringify(configured))), configured,
    `${language} settings round-trip through persisted workspace data`)
}
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

const legacySnapshot = readVideoDubbingSnapshot({ version: 1 }) as { sourcePath?: string }
assert.equal(legacySnapshot.sourcePath, '', 'legacy snapshots default an absent source to empty')
for (const rejectedSource of ['blob:preview-video', 'data:video/mp4;base64,AAAA']) {
  const snapshot = readVideoDubbingSnapshot({ version: 1, sourcePath: rejectedSource }) as { sourcePath?: string }
  assert.equal(snapshot.sourcePath, '', 'snapshots reject non-persistable video URLs')
}

const restored = readVideoDubbingSnapshot({
  version: 1, sourcePath: source, settings, runFingerprint: fingerprint, outputDir: '/cache/old',
  progress: { status: 'running', taskId: 'old-task', stage: 'dubbing', progress: 40 },
})!
const restoredSourcePath = (restored as { sourcePath?: string }).sourcePath
assert.equal(restoredSourcePath, source, 'source path round-trips through the snapshot')
assert.deepEqual(readVideoDubbingSnapshot(JSON.parse(JSON.stringify(restored))), restored)
assert.deepEqual(restored.settings, settings)
assert.equal(restored.runFingerprint, fingerprint)
assert.equal(videoDubbingFingerprint(restoredSourcePath ?? '', restored.settings!), restored.runFingerprint,
  'restored retries fingerprint the persisted source rather than launch-only props')
assert.equal(restored.progress?.status, 'failed')
assert.equal(reusableVideoDubbingDirectory(restored.outputDir, restored.runFingerprint!, fingerprint, restored.progress?.status), '/cache/old',
  'restored interruption can reuse matching completed work')
const edited = configureVideoDubbing(restored.settings!, { instruction: '已经修改但尚未生成的要求' })
const editedSnapshot = readVideoDubbingSnapshot({ ...restored, settings: edited })!
assert.notEqual(videoDubbingFingerprint(restoredSourcePath ?? '', editedSnapshot.settings!), editedSnapshot.runFingerprint,
  'unsynthesized changes remain stale after a restart')
assert.deepEqual(readVideoDubbingSnapshot(JSON.parse(JSON.stringify(editedSnapshot))), editedSnapshot)
for (const invalid of [null, [], 'bad', { ...settings, mode: 'other' }, { ...settings, targetLanguage: 'auto' }]) {
  assert.equal(readVideoDubbingSettings(invalid), undefined)
}
console.log('video dubbing workspace smoke tests passed')
