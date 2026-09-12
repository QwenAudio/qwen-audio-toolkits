import assert from 'node:assert/strict'
import type { AgentConversation, GeneralAgentMessage, GeneralAgentTask } from '../src/domain/agents'
import { appendWorkspaceBrief, ensureWorkspaceTaskLink, findWorkspaceGeneralTask } from '../src/domain/workspaceTaskLink'

const seed = { taskId: 'linked-task', messageId: 'original-brief', now: 300 }
const workspace: AgentConversation = {
  id: 'meeting-workspace', mode: 'meeting-notes', title: '产品周会',
  prompt: '记录产品周会，提取待办和负责人。', sourcePath: '',
  createdAt: 100, updatedAt: 200, restored: true,
}
const created = ensureWorkspaceTaskLink(workspace, [], seed)!
assert.equal(created.conversation.id, workspace.id, 'Linking must preserve the selected workspace identity')
assert.equal(created.conversation.sourceTaskId, seed.taskId)
assert.equal(workspace.sourceTaskId, undefined, 'The source metadata must remain immutable')
assert.equal(created.task.messages[0].content, workspace.prompt)
assert.equal(created.task.messages[0].role, 'user')
assert.equal(created.task.messages[0].createdAt, 100)
assert.equal(created.task.submitting, false, 'Restoring the chat must not submit the brief or restart a meeting')
assert.equal(created.task.draftPrompt, '')
assert.equal(created.task.attachment, null)
assert.equal(created.task.selectedModeId, 'meeting-notes')
assert.equal(created.task.title, workspace.title)
assert.equal(created.task.createdAt, 100)
assert.equal(created.task.updatedAt, 200)

const resolved = ensureWorkspaceTaskLink(created.conversation, [created.task], { ...seed, taskId: 'unused' })!
assert.equal(resolved.task, created.task, 'An existing source conversation must be reused')
assert.equal(resolved.conversation, created.conversation)
const repeatedEffect = ensureWorkspaceTaskLink(workspace, [created.task], seed)!
assert.equal(repeatedEffect.task, created.task, 'Repeating migration with its reserved id must not duplicate a task')
assert.equal(repeatedEffect.conversation.sourceTaskId, seed.taskId)
assert.equal(findWorkspaceGeneralTask([created.task], workspace.id, created.conversation), created.task)
assert.equal(findWorkspaceGeneralTask([created.task], created.task.id, null), created.task)
assert.equal(findWorkspaceGeneralTask([created.task], null, null), null)
assert.equal(findWorkspaceGeneralTask([], workspace.id, created.conversation), null)

const repaired = ensureWorkspaceTaskLink({ ...workspace, sourceTaskId: 'missing-task' }, [], seed)!
assert.equal(repaired.conversation.sourceTaskId, seed.taskId, 'A deleted or missing source conversation needs a new usable link')
assert.equal(ensureWorkspaceTaskLink({ ...workspace, mode: 'agent-chat' }, [], seed)?.task.messages[0]?.content, workspace.prompt)

for (const mode of ['smart-cut', 'ai-podcast', 'video-dubbing'] as const) {
  const project: AgentConversation = {
    ...workspace, mode, sourcePath: '/素材/访谈.mp4',
    videoDubbingMode: 'rewrite', videoDubbingLanguages: { source: 'zh', target: 'en' }, videoDubbingStyle: 'casual',
  }
  const link = ensureWorkspaceTaskLink(project, [], seed)!
  assert.deepEqual(link.task.attachment, { name: '访谈.mp4', path: '/素材/访谈.mp4' })
  assert.deepEqual(link.task.messages[0].attachment, link.task.attachment)
  assert.equal(link.task.selectedModeId, mode)
  assert.equal(link.task.creationOptions?.videoDubbingMode, mode === 'video-dubbing' ? 'rewrite' : undefined)
  if (mode === 'video-dubbing') {
    assert.deepEqual(link.task.creationOptions, {
      videoDubbingMode: 'rewrite', videoDubbingLanguages: { source: 'zh', target: 'en' }, videoDubbingStyle: 'casual',
    })
  }
}
assert.equal(ensureWorkspaceTaskLink({ ...workspace, sourcePath: 'C:\\Media\\clip.mp4' }, [], seed)!.task.attachment?.name, 'clip.mp4')

const initial: GeneralAgentTask = { ...created.task, messages: [], draftPrompt: workspace.prompt }
const brief: GeneralAgentMessage = { id: 'launch-brief', role: 'user', content: workspace.prompt, createdAt: 500, attachment: null }
const recorded = appendWorkspaceBrief(initial, brief)
assert.deepEqual(recorded.messages, [brief])
assert.equal(recorded.draftPrompt, '')
assert.equal(recorded.title, initial.title, 'Starting a workspace should retain the named task')
assert.equal(recorded.submitting, false)
assert.equal(initial.draftPrompt, workspace.prompt, 'Recording must not mutate the original draft')
assert.equal(appendWorkspaceBrief(recorded, { ...brief, id: 'duplicate', createdAt: 600 }).messages, recorded.messages)
const answered = { ...recorded, messages: [...recorded.messages, { ...brief, id: 'answer', role: 'assistant' as const, content: '好的' }] }
assert.equal(appendWorkspaceBrief(answered, brief).messages, answered.messages, 'An assistant reply must not make repeated launch append the same brief')
assert.equal(appendWorkspaceBrief(recorded, { ...brief, content: '仅总结决策' }).messages.length, 2)
assert.equal(appendWorkspaceBrief(recorded, { ...brief, attachment: { path: '/meeting.txt', name: 'meeting.txt' } }).messages.length, 2)
assert.equal(appendWorkspaceBrief({ ...recorded, draftPrompt: workspace.prompt }, brief).draftPrompt, '', 'A reused brief must still clear the launch draft')

console.log('Workspace task links: source chat selection, legacy repair, migration reuse, and brief recording passed.')
