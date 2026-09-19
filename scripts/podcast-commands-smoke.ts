import assert from 'node:assert/strict'
import { applyPodcastTurnCommand, podcastWorkspaceActions, PodcastCommandError, validatePodcastCommand, type PodcastCommandState, type ValidatedPodcastCommand } from '../src/domain/podcastCommands'
import { planPodcastAudio, podcastAudioIsCurrent } from '../src/domain/podcastAudio'
import type { PodcastScript } from '../src/domain/podcast'
import { exactWorkspaceCommand } from '../src/services/workspaceAgent'

const script: PodcastScript = {
  title: 'A shared draft', language: 'zh-CN',
  turns: [{ id: 'a', speaker: 'A', text: '为什么要保存？' }, { id: 'b', speaker: 'B', text: '为了继续编辑。' }],
}
const state: PodcastCommandState = {
  script, selectedTtsId: 'local', llmIds: ['llm'],
  ttsModels: [
    { id: 'local', apiModel: false, speakerCount: 10, defaultVoiceA: '0', defaultVoiceB: '1' },
    { id: 'cloud', apiModel: true, speakerCount: 0, defaultVoiceA: 'host', defaultVoiceB: 'guest' },
  ],
}
const validate = (action: string, args: Record<string, unknown>, current = state) => validatePodcastCommand({ action, args }, current)
const reject = (action: string, args: Record<string, unknown>, code: string, current = state) => {
  assert.throws(() => validate(action, args, current), (error: unknown) => error instanceof PodcastCommandError && error.code === code)
}

assert.deepEqual(validate('podcast.configure', { speed: 1.1 }), { action: 'podcast.configure', args: { speed: 1.1 } })
assert.deepEqual(validate('podcast.configure', { selectedTtsId: 'cloud', voiceB: 'custom-voice-id' }).args,
  { selectedTtsId: 'cloud', voiceA: 'host', voiceB: 'custom-voice-id' })
assert.deepEqual(validate('podcast.configure', { selectedTtsId: 'local', voiceA: ' 03 ' }).args,
  { selectedTtsId: 'local', voiceA: '03' })
reject('podcast.configure', { selectedTtsId: 'uninstalled', speed: 1.1 }, 'model')
reject('podcast.configure', { selectedLlmId: 'not-available' }, 'model')
reject('podcast.configure', { voiceA: '-1' }, 'voice')
reject('podcast.configure', { voiceB: '10' }, 'voice')
reject('podcast.configure', { voiceA: '1.1' }, 'voice')
reject('podcast.configure', { voiceA: 'speaker-three' }, 'voice')
for (const speed of [0, 0.74, 1.36, Infinity, NaN, '1.1']) reject('podcast.configure', { speed }, 'arguments')
reject('podcast.configure', {}, 'arguments')
reject('podcast.configure', { speed: 1.1, command: 'arbitrary' }, 'arguments')
reject('podcast.configure', { title: 'New title' }, 'script', { ...state, script: null })
assert.equal(validate('podcast.configure', { speed: 1.1 }, { ...state, script: null, llmIds: [], ttsModels: [] }).action, 'podcast.configure')
reject('podcast.configure', { voiceA: '0' }, 'model', { ...state, ttsModels: [] })
reject('podcast.edit-turn', { turnId: 'a' }, 'arguments')
reject('podcast.edit-turn', { turnId: 'stale', text: 'Do not append accidentally' }, 'turn')
reject('podcast.edit-turn', { turnId: 'a', speaker: 'C' }, 'arguments')
reject('podcast.edit-turn', { turnId: 'a', text: 'x'.repeat(901) }, 'arguments')
reject('podcast.add-turn', { speaker: 'A', text: 'New', afterTurnId: 'stale' }, 'turn')
reject('podcast.add-turn', { speaker: 'A', text: 'New' }, 'script', { ...state, script: null })
reject('podcast.add-turn', { speaker: 'A', text: 'New' }, 'limit', { ...state, script: { ...script, turns: Array.from({ length: 80 }, (_, index) => ({ ...script.turns[0], id: String(index) })) } })
reject('podcast.remove-turn', { turnId: 'missing' }, 'turn')
reject('podcast.synthesize', { modelId: 'arbitrary' }, 'arguments')
reject('podcast.execute-shell', {}, 'arguments')
for (const action of ['podcast.generate-script', 'podcast.synthesize', 'podcast.export']) assert.deepEqual(validate(action, {}).args, {})

type TurnCommand = Extract<ValidatedPodcastCommand, { action: 'podcast.edit-turn' | 'podcast.add-turn' | 'podcast.remove-turn' }>
const edit = (action: string, args: Record<string, unknown>, current = script) => applyPodcastTurnCommand(current, validate(action, args, { ...state, script: current }) as TurnCommand, 'new')
const settings = { modelId: 'local', modelVersion: 'v1', providerId: 'provider', apiModel: false, supportsLanguage: false, voiceA: '0', voiceB: '1', speed: 1 }
const originalPlan = planPodcastAudio(script, settings)
const originalSnapshot = JSON.stringify(script)
const changed = edit('podcast.edit-turn', { turnId: 'b', text: '这是用户刚刚要求修改的台词。', speaker: 'A' })
assert.deepEqual(changed.turns[1], { id: 'b', speaker: 'A', text: '这是用户刚刚要求修改的台词。' })
assert.equal(JSON.stringify(script), originalSnapshot, 'AI edits must not mutate the previous React state or cached version')
assert.equal(podcastAudioIsCurrent(originalPlan.fingerprint, planPodcastAudio(changed, settings)), false)
assert.equal(planPodcastAudio(changed, settings).segments[0].key, originalPlan.segments[0].key, 'unchanged manual/AI turns retain reusable audio')
const added = edit('podcast.add-turn', { speaker: 'B', text: '插入的回答', afterTurnId: 'a' }, changed)
assert.deepEqual(added.turns.map((turn) => turn.id), ['a', 'new', 'b'])
const removed = edit('podcast.remove-turn', { turnId: 'new' }, added)
assert.deepEqual(removed, changed, 'following commands must address the latest shared script')
const cleared = edit('podcast.edit-turn', { turnId: 'a', text: '' })
assert.equal(cleared.turns[0].text, '')
assert.equal(podcastAudioIsCurrent(originalPlan.fingerprint, planPodcastAudio(cleared, settings)), false)
const actions = podcastWorkspaceActions(state)
const editorState = { mode: 'ai-podcast' as const, revision: '0', busy: false, context: {}, actions }
for (const prompt of ['语速设为 1.1 倍', 'Set speed to 1.1x']) {
  assert.deepEqual(exactWorkspaceCommand(prompt, editorState), { action: 'podcast.configure', args: { speed: 1.1 } })
}
for (const prompt of ['生成播客音频', '更新播客音频', 'Generate podcast audio', 'Update podcast audio']) {
  assert.deepEqual(exactWorkspaceCommand(prompt, editorState), { action: 'podcast.synthesize', args: {} })
}
assert.equal(exactWorkspaceCommand('不要更新播客音频', editorState), null)
assert.ok(podcastWorkspaceActions({ ...state, script: null }).every((action) => !['podcast.edit-turn', 'podcast.add-turn', 'podcast.remove-turn'].includes(action.name)))

console.log('Podcast commands: strict arguments, available models and voice bounds, shared immutable edits, stale audio, and sequential turn IDs passed.')
