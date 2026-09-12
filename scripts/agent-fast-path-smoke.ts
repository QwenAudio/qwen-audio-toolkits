import { sendGeneralAgentPrompt } from '../src/services/agent'
import { buildGeneralAgentPromptContent } from '../src/hooks/useAgentConversations'
import type { GeneralAgentMessage } from '../src/domain/agents'

function message(content: string): GeneralAgentMessage {
  return {
    id: `msg-${content}`,
    role: 'user',
    content,
    createdAt: Date.now(),
  }
}

const started = performance.now()
const greeting = await sendGeneralAgentPrompt([message('你好')])
const elapsedMs = performance.now() - started
const contextualGreeting = buildGeneralAgentPromptContent(
  '你好',
  '智能剪辑',
  '\n\n用户附件：/tmp/demo.mp4',
)
const contextualTask = buildGeneralAgentPromptContent(
  '剪掉停顿',
  '智能剪辑',
  '\n\n用户附件：/tmp/demo.mp4',
)

if (contextualGreeting !== '你好') {
  throw new Error(`Greeting should not be expanded with hidden context: ${contextualGreeting}`)
}
if (!contextualTask.includes('当前用户选择的技能：智能剪辑') || !contextualTask.includes('/tmp/demo.mp4')) {
  throw new Error(`Task prompt should preserve hidden context: ${contextualTask}`)
}

if (greeting.provider !== 'local' || greeting.stopReason !== 'local_greeting') {
  throw new Error(`Greeting should use local fast path: ${JSON.stringify(greeting)}`)
}
if (!greeting.text.includes('音视频任务')) {
  throw new Error(`Unexpected greeting response: ${greeting.text}`)
}
if (elapsedMs > 50) {
  throw new Error(`Greeting fast path took too long: ${elapsedMs.toFixed(1)}ms`)
}

try {
  await sendGeneralAgentPrompt([message('请帮我剪一个视频')])
  throw new Error('Non-greeting prompt should fall through to the desktop ACP path')
} catch (error) {
  const text = error instanceof Error ? error.message : String(error)
  if (!text.includes('桌面端运行')) {
    throw error
  }
}

console.log(JSON.stringify({
  status: 'passed',
  elapsedMs: Math.round(elapsedMs),
}, null, 2))
