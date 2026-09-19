import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { attachAgentAudioBridge } from '../services/agentAudioBridge'
import { agentInstallRegistry } from '../services/agentInstallState'
import { LoaderCircle, Check } from 'lucide-react'
import { getBailianProviderSettings, openAgentUi } from '../services/harness'

export function PythonAgentWorkspace({ id, title, onConfigureAccount }: { id: string; title: string; onConfigureAccount: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const [stages, setStages] = useState<{ message: string; elapsedMs: number }[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [pageReady, setPageReady] = useState(false)
  const [session, setSession] = useState<{ url: string; title: string } | null>(null)
  useEffect(() => {
    if (session && frameRef.current) {
      return attachAgentAudioBridge({ uiId: id, session, frame: frameRef.current })
    }
    return undefined
  }, [id, session])
  const [needsAccount, setNeedsAccount] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let canceled = false
    let unlisten: UnlistenFn | undefined
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 250)
    timerRef.current = timer
    setSession(null); setError(''); setNeedsAccount(false); setPageReady(false); setElapsed(0)
    setStages([{ message: '检查账号与启动条件', elapsedMs: 0 }])
    const start = async () => {
      const serverId = agentInstallRegistry.resolve(id).serverId
      unlisten = await listen<{ id: string; message: string; elapsedMs: number }>('agent-ui-progress', event => {
        if (!canceled && event.payload.id === serverId) setStages(current => [...current.slice(-19), { message: event.payload.message, elapsedMs: Date.now() - started }])
      })
      if (canceled) { unlisten(); return }
      if (["bailian-cosyvoice-v2", "bailian-cosyvoice-v3-plus", "bailian-cosyvoice-v35-flash", "bailian-cosyvoice-v35-plus", "bailian-fun-audio-denoising", "bailian-funasr-8k-realtime", "bailian-funasr-realtime", "bailian-paraformer-8k-realtime-v2", "bailian-paraformer-realtime-v2", "bailian-qwen-audio-asr-filetrans", "bailian-qwen-audio-asr-flash", "bailian-qwen-audio-tts", "bailian-qwen-audio-tts-plus", "bailian-qwen3-asr", "bailian-qwen36-plus", "bailian-qwen37-plus"].includes(serverId)) {
        const account = await getBailianProviderSettings()
        if (canceled) return
        if (account.status !== 'ready') { clearInterval(timer); setNeedsAccount(true); return }
      }
      if (canceled) return
      const value = await openAgentUi(id)

      if (canceled) return
      setSession(value)
    }
    void start().catch(e => { clearInterval(timer); if (!canceled) setError(String(e)) })
    return () => { canceled = true; clearInterval(timer); unlisten?.() }
  }, [id, attempt])
  return <section className="agent-browser" aria-label="本地 Agent">
    <div className="agent-browser-content">
      {needsAccount ? <div className="agent-browser-status">
        <div className="model-empty-conversation">
          <h2>连接账号，开始使用 {title}</h2>
          <p>请先配置阿里云百炼账号。连接后即可使用此 Agent。</p>
          <button type="button" className="secondary-action" onClick={onConfigureAccount}>配置百炼账号</button>
        </div>
      </div> : <>{session && <iframe ref={frameRef} src={session.url} title={session.title} allow="microphone" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerPolicy="no-referrer" onLoad={() => { frameRef.current?.contentWindow?.postMessage({ type: 'toolkits-host-ready' }, new URL(session.url).origin); clearInterval(timerRef.current); setPageReady(true) }} />}
        {!pageReady && <div className="agent-browser-status" role="status"><div className="agent-startup-card">
          <h3>{error ? 'Agent 未能启动' : `正在启动 ${title}`}</h3>
          <p>{error ? '启动未完成，可查看停留的步骤后重试。' : `已等待 ${elapsed.toFixed(1)} 秒`}</p>
          <ol>{stages.map((stage, index) => <li key={index}>
            {index === stages.length - 1 && !error ? <LoaderCircle size={15} className="model-spin" /> : <Check size={15} />}
            <span>{stage.message}</span><time>{((stages[index + 1]?.elapsedMs ?? elapsed * 1000) - stage.elapsedMs > 0 ? ((stages[index + 1]?.elapsedMs ?? elapsed * 1000) - stage.elapsedMs) / 1000 : 0).toFixed(1)}s</time>
          </li>)}</ol>
          {error && <><p className="agent-startup-error">{error}</p><button className="secondary-action" onClick={() => setAttempt(n => n + 1)}>重试</button></>}
        </div></div>}</>}
    </div>
  </section>
}
