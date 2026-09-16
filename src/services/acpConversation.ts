import { startAcpSession, finishAcpSession, sendAcpPrompt, subscribeAcpSession } from './acp'
import type { AcpProviderInfo, AcpSessionEvent } from '../types'
import { acpApiProviderId } from '../domain/agentModelSelection'
import type { AgentModelSelection, GeneralAgentMessage } from '../domain/agents'
import { uniqueAgentFiles } from '../domain/agentFiles'
import { t } from '../i18n'

export const acpConversationTransport = {
  start: startAcpSession, finish: finishAcpSession, send: sendAcpPrompt, subscribe: subscribeAcpSession,
}

function acpConversationMessageContext(messages: GeneralAgentMessage[]) {
  return messages.map(({ role, content, attachment, attachments }) => {
    const files = uniqueAgentFiles([attachment, ...(attachments ?? [])])
    return {
      role,
      content,
      ...(files.length
        ? {
            attachments: files.map((file) => ({
              name: file.name,
              path: file.path,
            })),
          }
        : {}),
    }
  })
}

export async function requestAcpConversation(options: {
  selection: AgentModelSelection
  provider: AcpProviderInfo
  messages: GeneralAgentMessage[]
  signal?: AbortSignal
  enableTools?: boolean
  onPermission: (event: AcpSessionEvent) => void
  onQuestion?: (event: AcpSessionEvent) => void
  onPlanApproval?: (event: AcpSessionEvent) => void
  onProgress?: (event: AcpSessionEvent) => void
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
    options.onProgress?.(event)
    if (event.kind === 'agent_message_chunk') text += event.text ?? ''
    if (event.kind === 'permission_requested') options.onPermission(event)
    if (event.kind === 'question_requested') options.onQuestion?.(event)
    if (event.kind === 'plan_approval_requested') options.onPlanApproval?.(event)
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
      apiProviderId: acpApiProviderId(options.selection, options.provider),
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
    const prompt = `Continue this audio/video task conversation. Reply to the latest user message in the requested format. Previous messages are reference context; do not repeat earlier operations. When a message includes attachments, use their absolute file paths as the source material. If you need the user to choose among concrete options, prefer the ACP cursor/ask_question request when available. If you need approval before executing a multi-step plan, prefer cursor/create_plan when available; otherwise ask concise confirmation questions in the message.\n${JSON.stringify(acpConversationMessageContext(options.messages))}`
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
