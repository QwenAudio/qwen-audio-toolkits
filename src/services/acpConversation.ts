import { startAcpSession, finishAcpSession, sendAcpPrompt, subscribeAcpSession } from './acp'
import type { AcpSessionEvent } from '../types'
import type { AgentModelSelection, GeneralAgentMessage } from '../domain/agents'
import { t } from '../i18n'

export const acpConversationTransport = {
  start: startAcpSession, finish: finishAcpSession, send: sendAcpPrompt, subscribe: subscribeAcpSession,
}

export async function requestAcpConversation(options: {
  selection: AgentModelSelection
  messages: GeneralAgentMessage[]
  signal?: AbortSignal
  enableTools?: boolean
  onPermission: (event: AcpSessionEvent) => void
}, transport = acpConversationTransport): Promise<string> {
  let sessionId: string | null = null
  let initializedSessionId: string | null = null
  let released = false
  let text = ''
  let settled = false
  const buffered: AcpSessionEvent[] = []
  let resolve!: (value: string) => void
  let reject!: (reason: Error) => void
  const completion = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  void completion.catch(() => undefined)
  const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)) } }
  const abort = () => fail(t('已停止 Agent 回复。'))
  const handle = (event: AcpSessionEvent) => {
    if (event.sessionId !== sessionId || settled) return
    if (event.kind === 'agent_message_chunk') text += event.text ?? ''
    if (event.kind === 'permission_requested') options.onPermission(event)
    if (event.kind === 'turn_completed') {
      if (!text.trim()) fail(t('Agent 没有返回文本结果，请稍后重试。'))
      else { settled = true; resolve(text) }
    }
    if (['turn_failed', 'closed', 'error'].includes(event.kind)) fail(event.error || t('Agent 会话已中断'))
  }
  const remove = await transport.subscribe(event => {
    if (!sessionId) buffered.push(event)
    else handle(event)
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => fail(t('Agent 回复超时，请重试。')), 15 * 60_000)
  try {
    if (options.signal?.aborted) throw new Error(t('已停止 Agent 回复。'))
    const startup = transport.start({
      providerId: options.selection.providerId,
      modelId: options.selection.modelId || undefined,
      enableTools: options.enableTools,
    })
    void startup.then(session => {
      initializedSessionId = session.sessionId
      if (released) return transport.finish(session.sessionId).catch(() => undefined)
    }, () => undefined)
    const session = await Promise.race([startup, completion.then(() => { throw new Error(t('已停止 Agent 回复。')) })])
    sessionId = session.sessionId
    if (options.signal?.aborted || settled) return await completion
    for (const event of buffered) handle(event)
    if (settled) return await completion
    const prompt = `Continue this audio/video task conversation. Reply to the latest user message in the requested format. Previous messages are reference context; do not repeat earlier operations.\n${JSON.stringify(options.messages.map(({ role, content }) => ({ role, content })))}`
    await transport.send(sessionId, prompt)
    return await completion
  } finally {
    released = true
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    remove()
    const startedId = sessionId ?? initializedSessionId
    if (startedId) await transport.finish(startedId).catch(() => undefined)
  }
}
