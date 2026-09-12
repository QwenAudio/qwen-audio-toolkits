import assert from 'node:assert/strict'
import { registerWorkspaceController, getWorkspaceController, type WorkspaceEditorState } from '../src/services/workspaceController'
import { exactWorkspaceCommand, parseWorkspaceAgentPlan, runWorkspaceAgentRequest, validateWorkspaceArguments, workspacePlannerPrompt } from '../src/services/workspaceAgent'

const state: WorkspaceEditorState = {
  mode: 'smart-cut', revision: '0', busy: false, context: { includeSubtitles: true, text: 'source data' },
  actions: [
    { name: 'cut.configure', description: 'Configure captions', parameters: { type: 'object', properties: { includeSubtitles: { type: 'boolean' } }, required: ['includeSubtitles'], additionalProperties: false }, quickCommands: [{ text: '关闭字幕', args: { includeSubtitles: false } }] },
    { name: 'cut.fail', description: 'Fail', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'cut.cancel', description: 'Cancel', parameters: { type: 'object', properties: {}, additionalProperties: false }, allowedWhileBusy: true },
  ],
}
const command = { action: 'cut.configure', args: { includeSubtitles: false } }
const plan = JSON.stringify({ reply: 'Do not trust this completion claim', commands: [command] })
assert.deepEqual(exactWorkspaceCommand(' 关闭字幕！ ', state), command)
for (const text of ['不要关闭字幕', '关闭字幕会怎样', '关闭字幕再导出']) assert.equal(exactWorkspaceCommand(text, state), null)
assert.equal(parseWorkspaceAgentPlan('```json\n' + plan + '\n```', state.actions).commands.length, 1)
for (const malformed of ['I did it', '{"commands":[]}', JSON.stringify({ reply: '', commands: [{ action: 'shell.exec', args: {} }] }), JSON.stringify({ reply: '', commands: [{ ...command, args: { includeSubtitles: 'no' } }] })]) {
  assert.throws(() => parseWorkspaceAgentPlan(malformed, state.actions))
}
assert.throws(() => validateWorkspaceArguments({ includeSubtitles: false, arbitraryPath: '/tmp/file' }, state.actions[0].parameters))
assert.throws(() => validateWorkspaceArguments({ value: NaN }, { type: 'object', properties: { value: { type: 'number', minimum: 0 } } }))
assert.throws(() => validateWorkspaceArguments([1, 2, 3], { type: 'array', maxItems: 2, items: { type: 'number' } }))
assert.throws(() => validateWorkspaceArguments({}, { type: 'object', minProperties: 1 }))
assert.throws(() => validateWorkspaceArguments(['a', 'a'], { type: 'array', uniqueItems: true }))
assert.throws(() => validateWorkspaceArguments(0, { type: 'number', exclusiveMinimum: 0 }))
assert.doesNotThrow(() => validateWorkspaceArguments(null, { type: ['null', 'string'] }))
assert.doesNotThrow(() => validateWorkspaceArguments({ speed: 1.1 }, { type: 'object', properties: { speed: { type: 'number', minimum: 0.75, maximum: 1.35 } }, required: ['speed'] }))
assert.match(workspacePlannerPrompt('Please change it', state), /source data/)

let calls = 0
let current = true
const stop = registerWorkspaceController('test-workspace', {
  getState: () => structuredClone(state),
  execute: async command => {
    calls++
    if (command.action === 'cut.fail') throw new Error('real operation failed')
    state.revision = String(Number(state.revision) + 1)
    if (command.action === 'cut.configure') state.context.includeSubtitles = command.args.includeSubtitles
    return { message: 'Observed change applied' }
  },
})
const request = (prompt = 'change captions') => ({ projectId: 'test-workspace', prompt, isCurrent: () => current, requestPlan: async () => plan })
const result = await runWorkspaceAgentRequest({ ...request('关闭字幕'), requestPlan: async () => { throw new Error('Exact command must not call a model') } })
assert.equal(result, 'Observed change applied')
assert.equal(state.context.includeSubtitles, false)
assert.equal(calls, 1)
assert.equal(await runWorkspaceAgentRequest({ ...request(), requestPlan: async () => JSON.stringify({ reply: 'Answer about current captions', commands: [] }) }), 'Answer about current captions')
assert.equal(calls, 1)

await assert.rejects(runWorkspaceAgentRequest({ ...request(), requestPlan: async () => { state.revision = '2'; return plan } }), /右侧内容已发生变化/)
assert.equal(calls, 1, 'A manual edit while the model plans must cancel the stale plan')
await assert.rejects(runWorkspaceAgentRequest({ ...request(), requestPlan: async () => { current = false; return plan } }), /切换任务/)
assert.equal(calls, 1)
current = true
state.busy = true
await assert.rejects(runWorkspaceAgentRequest(request()), /工作区正在处理/)
await runWorkspaceAgentRequest({ ...request(), requestPlan: async () => JSON.stringify({ reply: '', commands: [{ action: 'cut.cancel', args: {} }] }) })
state.busy = false

const beforeInvalidPlan = calls
await assert.rejects(runWorkspaceAgentRequest({ ...request(), requestPlan: async () => JSON.stringify({ reply: '', commands: [command, { action: 'cut.unknown', args: {} }] }) }))
assert.equal(calls, beforeInvalidPlan, 'Validate every planned command before the first mutation')
const partial = await runWorkspaceAgentRequest({ ...request(), requestPlan: async () => JSON.stringify({ reply: 'All succeeded', commands: [command, { action: 'cut.fail', args: {} }] }) })
assert.match(partial, /Observed change applied/)
assert.match(partial, /real operation failed/)
assert.doesNotMatch(partial, /All succeeded/)

const beforeManualEdit = calls
const interruptedByManualEdit = await runWorkspaceAgentRequest({
  ...request(),
  requestPlan: async () => JSON.stringify({ reply: '', commands: [command, command] }),
  afterCommit: async () => {
    if (calls === beforeManualEdit + 1) {
      // The user restores captions between the first command and the next frame.
      state.context.includeSubtitles = true
      state.revision = String(Number(state.revision) + 1)
    }
  },
})
assert.equal(calls, beforeManualEdit + 1, 'Do not absorb a manual edit into the expected revision after yielding')
assert.equal(state.context.includeSubtitles, true, 'The second AI command must not overwrite the manual change')
assert.match(interruptedByManualEdit, /Observed change applied/, 'Keep the real result of the already completed operation')
assert.match(interruptedByManualEdit, /右侧内容已发生变化/)

const beforeSequence = calls
const sequence = await runWorkspaceAgentRequest({
  ...request(), afterCommit: async () => {},
  requestPlan: async () => JSON.stringify({ reply: '', commands: [command, { ...command, args: { includeSubtitles: true } }] }),
})
assert.equal(calls, beforeSequence + 2, 'The first committed AI revision must allow the next planned operation')
assert.equal(state.context.includeSubtitles, true)
assert.equal(sequence.split('\n').length, 2)

const beforeSwitch = calls
await runWorkspaceAgentRequest({ ...request(), afterCommit: async () => { current = false }, requestPlan: async () => JSON.stringify({ reply: '', commands: [command, command] }) })
assert.equal(calls, beforeSwitch + 1, 'Switching away stops the remaining commands')
current = true
const newerStop = registerWorkspaceController('test-workspace', { getState: () => state, execute: async () => ({ message: 'new' }) })
stop()
assert.ok(getWorkspaceController('test-workspace'), 'An old cleanup cannot unregister a newer editor instance')
newerStop()
await assert.rejects(runWorkspaceAgentRequest(request()), /工作区正在准备/)
console.log('Workspace AI: exact commands, schema validation, current state, manual edit conflicts, task switching, busy guards, partial failures, and registration lifecycle passed.')
