import { startSystemAudio, stopSystemAudio, subscribeSystemAudio } from './harness'
import { showCaptionOutput, publishCaptionSnapshot, stopCaptionOutput } from './captionOutput'
import { agentInstallRegistry, type AgentUiSession } from './agentInstallState'
import { pcm16ChunksToWavFile } from '../utils/audio'

/** Restrict capture requests to the registry-bound local Agent frame. */
export function attachAgentAudioBridge({
  uiId,
  session,
  frame,
}: {
  uiId: string
  session: AgentUiSession
  frame: HTMLIFrameElement
}) {
  agentInstallRegistry.assertSession(uiId, session)
  const origin = new URL(session.url).origin
  frame.contentWindow?.postMessage({ type: 'toolkits-host-ready' }, origin)
  let sessionId: string | null = null
  let chunks: string[] = []
  let rate = 48000
  let streaming = false
  let busy = false
  let disposed = false
  let captionsOpened = false
  let captionQueue: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let unlisten: (() => void) | undefined
  const stop = async () => {
    clearTimeout(timer)
    const id = sessionId
    sessionId = null
    try { if (id) await stopSystemAudio(id) }
    finally { unlisten?.(); unlisten = undefined }
  }
  const receive = async (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return
    if (event.data?.type === 'toolkits-captions') {
      const {action, text, requestId} = event.data
      if (!['open', 'update', 'stop'].includes(action) || typeof text !== 'string' || text.length > 200000) return
      captionQueue = captionQueue.then(async () => {
        if (disposed) return
        if (action === 'open') { await showCaptionOutput(); captionsOpened = true }
        if (captionsOpened) {
          if (action === 'stop') await stopCaptionOutput()
          else await publishCaptionSnapshot(text)
        }
        if (action === 'open') frame.contentWindow?.postMessage({type:'toolkits-captions-result',requestId}, origin)
      }).catch(() => {
        frame.contentWindow?.postMessage({type:'toolkits-captions-result',requestId,error:'无法打开字幕窗口'}, origin)
      })
      return
    }
    if (event.data?.type !== 'toolkits-system-audio') return
    const { action, requestId } = event.data
    if (!['start', 'stop'].includes(action) || typeof requestId !== 'string') return
    const reply = (payload: object) => { if (!disposed) frame.contentWindow?.postMessage({ type: 'toolkits-system-audio-result', requestId, ...payload }, origin) }
    if (busy) { reply({ error: '音频操作尚未完成' }); return }
    busy = true
    try {
      if (action === 'start') {
        if (sessionId) throw Error('电脑音频已在录制')
        chunks = []
        streaming = event.data.streaming === true
        unlisten = await subscribeSystemAudio(chunk => {
          if (chunk.sessionId === sessionId) {
            if (streaming) frame.contentWindow?.postMessage({type:'toolkits-system-audio-chunk', data:chunk.pcmBase64, sampleRate:rate}, origin)
            else chunks.push(chunk.pcmBase64)
          }
        })
        const started = await startSystemAudio()
        sessionId = started.sessionId; rate = started.sampleRate
        if (disposed) { await stop(); return }
        timer = setTimeout(() => {
          void stop().finally(() => frame.contentWindow?.postMessage({ type: 'toolkits-system-audio-ended' }, origin))
        }, 300000)
        reply({ ok: true })
      } else {
        await stop()
        if (streaming) { streaming = false; reply({ok:true}); return }
        const file = pcm16ChunksToWavFile(chunks, rate, '电脑音频.wav')
        chunks = []
        if (file.size <= 44) throw Error('没有捕获到音频，请确认电脑正在播放声音')
        if (file.size > 32 * 1024 * 1024) throw Error('录音超过 32 MiB，请缩短录制时间')
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(Error('无法读取录音'))
          reader.readAsDataURL(file)
        })
        reply({ data, name: file.name })
      }
    } catch (error) {
      if (action === 'start') await stop().catch(() => {})
      reply({ error: String(error) })
    } finally { busy = false }
  }
  window.addEventListener('message', receive)
  return () => {
    disposed = true
    if (captionsOpened) void stopCaptionOutput()
    window.removeEventListener('message', receive)
    void stop().catch(() => {})
  }
}
