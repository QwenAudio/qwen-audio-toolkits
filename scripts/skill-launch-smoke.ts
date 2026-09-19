import assert from 'node:assert/strict'
import { matchingSkillConversation, resolveSkillLaunchInput, skillAcceptsFile } from '../src/domain/skillLaunch'
import type { AgentConversation, GeneralAgentMessage } from '../src/domain/agents'

const video = { path: '/fixtures/interview.MP4', name: 'interview.MP4' }
const document = { path: '/fixtures/paper.pdf', name: 'paper.pdf' }
const messages: GeneralAgentMessage[] = [
  { id: 'u1', role: 'user', content: '清理采访视频中的长停顿', createdAt: 1, attachment: video },
  { id: 'a1', role: 'assistant', content: 'ASSISTANT_PLAN_MUST_NOT_REPLACE_THE_USER_BRIEF', createdAt: 2 },
  { id: 'u2', role: 'user', content: '保留原字幕', createdAt: 3 },
  { id: 'u3', role: 'user', content: '确认', createdAt: 4 },
]
assert.equal(skillAcceptsFile('smart-cut', video.path), true)
assert.equal(skillAcceptsFile('ai-podcast', video.path), false)
assert.equal(skillAcceptsFile('ai-podcast', document.path), true)
const fromConversation = resolveSkillLaunchInput('smart-cut', '', null, messages)
assert.deepEqual(fromConversation, { prompt: '清理采访视频中的长停顿\n\n保留原字幕', source: video, missing: null })
assert.equal(resolveSkillLaunchInput('smart-cut', '新的剪辑要求', document, messages).missing, 'file-type', 'Explicit incompatible input must not fall back to a different historical file')
assert.equal(resolveSkillLaunchInput('ai-podcast', '制作播客', null, messages).missing, 'file')
assert.equal(resolveSkillLaunchInput('smart-cut', '', video, []).missing, 'prompt')
assert.deepEqual(resolveSkillLaunchInput('meeting-notes', '记录项目周会', video, []), {
  prompt: '记录项目周会', source: null, missing: null,
})
assert.equal(resolveSkillLaunchInput('smart-cut', '只保留第一段', null, messages).prompt, '只保留第一段')

const request: Omit<AgentConversation, 'id'> = {
  sourceTaskId: 'source-1', mode: 'video-dubbing', title: '配音', prompt: '翻译视频', sourcePath: video.path,
  videoDubbingMode: 'translate', videoDubbingLanguages: { source: 'auto', target: 'en' }, videoDubbingStyle: 'natural',
}
const existing = { ...request, id: 'project-1', restored: true }
assert.equal(matchingSkillConversation([existing], request)?.id, 'project-1', 'Repeated launch should reopen the existing project')
for (const changed of [
  { prompt: '改写视频' }, { sourceTaskId: 'another-task' }, { sourcePath: '/fixtures/another.mp4' },
  { videoDubbingLanguages: { source: 'auto', target: 'ja' } }, { videoDubbingStyle: 'formal' as const },
]) {
  assert.equal(matchingSkillConversation([existing], { ...request, ...changed }), undefined)
}
assert.equal(matchingSkillConversation([existing], { ...request, sourceTaskId: undefined }), undefined)
console.log('Skill launch: briefs, attachments, validation, and project reuse passed.')
