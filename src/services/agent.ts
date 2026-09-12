import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'
import type { GeneralAgentMessage } from '../domain/agents'
import { isTauriRuntime } from './harness'

interface AcpAgentPromptResponse {
  text: string
  stopReason: string
  sessionId: string
  model: string
  provider: string
  toolCalls: Array<{
    title: string
    status: string
  }>
}

function normalizeGreeting(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[!！.。?？,，\s]/gu, '')
}

export function isLocalGreetingContent(content: string): boolean {
  return ['hi', 'hello', 'hey', '你好', '您好', '在吗', '在么'].includes(
    normalizeGreeting(content),
  )
}

function localGreetingResponse(messages: GeneralAgentMessage[]): AcpAgentPromptResponse | null {
  if (messages.length !== 1) return null
  const [{ role, content }] = messages
  if (role !== 'user') return null
  if (!isLocalGreetingContent(content)) return null
  return {
    text: t('你好，我在。你想创作或处理什么音视频任务？'),
    stopReason: 'local_greeting',
    sessionId: 'local-greeting',
    model: 'local',
    provider: 'local',
    toolCalls: [],
  }
}

export async function sendGeneralAgentPrompt(
  messages: GeneralAgentMessage[],
): Promise<AcpAgentPromptResponse> {
  const greeting = localGreetingResponse(messages)
  if (greeting) return greeting
  if (!isTauriRuntime()) {
    throw new Error(t('通用 Agent 对话需要在 QwenAudio Toolkits 桌面端运行'))
  }
  return invoke<AcpAgentPromptResponse>('agent_acp_prompt', {
    request: {
      messages: messages.map(({ role, content }) => ({ role, content })),
      cwd: null,
    },
  })
}
