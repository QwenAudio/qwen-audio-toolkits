import assert from 'node:assert/strict'
import { appendVisibleGeneralUserMessage } from '../src/hooks/useAgentConversations'
import type { GeneralAgentMessage } from '../src/domain/agents'

const original: GeneralAgentMessage = {
  id: 'original',
  role: 'user',
  content: '识别一下音频中的文字',
  createdAt: 1,
  attachment: {
    path: '/Users/binbzha/Downloads/longanhuan.wav',
    name: 'longanhuan.wav',
  },
}

const retry: GeneralAgentMessage = {
  ...original,
  id: 'retry',
  createdAt: 2,
}

assert.deepEqual(
  appendVisibleGeneralUserMessage([original], retry, false).map((message) => message.id),
  ['original'],
)

assert.deepEqual(
  appendVisibleGeneralUserMessage([original], retry, true).map((message) => message.id),
  ['original', 'retry'],
)

assert.deepEqual(
  appendVisibleGeneralUserMessage([original], retry).map((message) => message.id),
  ['original', 'retry'],
)

console.log(JSON.stringify({ status: 'passed', checks: 3 }, null, 2))
