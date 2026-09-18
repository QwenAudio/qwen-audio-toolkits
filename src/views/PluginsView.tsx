import { useEffect, useRef, useState } from 'react'
import { getAgentServerStatus, isTauriRuntime, installPythonAgent, uninstallPythonAgent, type InstalledPythonAgent } from '../services/harness'

import { installationStates, installationListeners, installationChanged } from '../services/agentInstallState'

export function PluginsView({ category, secondary, installedAgents, installedIds, hostInstalledIds, onInstallHost, onUninstallHost, onInstalled, onUninstalled }: { installedAgents: InstalledPythonAgent[]; onUninstalled: (id: string) => void; onUninstallHost: (id: string) => Promise<void>; hostInstalledIds: string[]; onInstallHost: (id: string) => Promise<void>; category: string; secondary: string; onBack: () => void; installedIds: string[]; onInstalled: (agent: InstalledPythonAgent) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const actualPythonAgents = useRef(installedAgents)
  useEffect(() => { actualPythonAgents.current = installedAgents }, [installedAgents])
  const removeCallback = useRef(onUninstalled)
  const hostRemove = useRef(onUninstallHost)
  useEffect(() => { removeCallback.current = onUninstalled; hostRemove.current = onUninstallHost }, [onUninstalled, onUninstallHost])
  const hostCallback = useRef(onInstallHost)
  useEffect(() => { hostCallback.current = onInstallHost }, [onInstallHost])
  const installedCallback = useRef(onInstalled)
  useEffect(() => { installedCallback.current = onInstalled }, [onInstalled])
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let canceled = false
    setUrl(''); setReady(false); setError('')
    const connect = async () => {
      try {
        const status = isTauriRuntime()
          ? await getAgentServerStatus()
          : { url: import.meta.env.VITE_AGENT_SERVER_URL || 'http://127.0.0.1:8787/', available: true, error: null }
        const target = new URL(status.url)
        if (!(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) {
          throw new Error('Agent Server 地址需要 HTTPS 或本机 HTTP')
        }
        if (canceled) return
        if (!status.available) { setError(status.error || '无法连接 Agent Server'); return }
        target.searchParams.set('embedded', '1'); setUrl(target.href)
      } catch (e) { if (!canceled) setError(String(e)) }
    }
    void connect()
    return () => { canceled = true }
  }, [attempt])

  useEffect(() => {
    if (!url) return
    const update = () => frame.current?.contentWindow?.postMessage({ type: 'agent-client:installations', items: [...installationStates.values()] }, new URL(url).origin)
    installationListeners.add(update)
    update()
    return () => { installationListeners.delete(update) }
  }, [url])

  useEffect(() => {
    if (!url) return
    const origin = new URL(url).origin
    // Only the configured website can request a known Agent ID; it never supplies commands or paths.
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return
      if (['agent-server:install', 'agent-server:update', 'agent-server:uninstall'].includes(event.data?.type) && isTauriRuntime() && typeof event.data.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,99}$/.test(event.data.id) && !["installing", "updating", "uninstalling"].includes(installationStates.get(event.data.id)?.status ?? "")) {
        const id = event.data.id
        const kind = event.data.type === 'agent-server:uninstall'
          ? (actualPythonAgents.current.some(agent => agent.id === id) ? undefined : 'host')
          : event.data.kind === 'host' ? 'host' : undefined
        if (event.data.type === 'agent-server:uninstall') {
          installationChanged(id, 'uninstalling', undefined, kind)
          void (kind === 'host' ? hostRemove.current(id) : uninstallPythonAgent(id)).then(() => {
            removeCallback.current(id)
            installationChanged(id, 'uninstalled', undefined, kind)
          }).catch(e => installationChanged(id, 'remove-failed', String(e), kind))
          return
        }
        const update = event.data.type === 'agent-server:update'
        installationChanged(id, update ? 'updating' : 'installing', undefined, kind)
        if (kind === 'host') {
          void hostCallback.current(id).then(() => installationChanged(id, 'installed', undefined, kind)).catch(e => installationChanged(id, 'failed', String(e), kind))
          return
        }
        void installPythonAgent(id, update).then(value => {
          installedCallback.current(value)
          installationChanged(id, 'installed')
        }).catch(e => installationChanged(id, update ? 'update-failed' : 'failed', String(e)))
      }
      if (event.data?.type === 'agent-server:ready') {
        clearTimeout(timeout); setReady(true); setError('')
        frame.current?.contentWindow?.postMessage({ type: 'agent-client:installations', items: [...installationStates.values()] }, origin)
      }
    }
    const timeout = window.setTimeout(() => setError('项目网页未能加载，请检查服务连接后重试。'), 12000)
    window.addEventListener('message', receive)
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive) }
  }, [url])

  useEffect(() => {
    if (url && ready) frame.current?.contentWindow?.postMessage({ type: 'agent-client:category', category, secondary }, new URL(url).origin)
  }, [category, secondary, url, ready])

  useEffect(() => {
    if (url && ready) frame.current?.contentWindow?.postMessage({ type: 'agent-client:installed', installedAgents, installedIds: [...installedIds, ...hostInstalledIds] }, new URL(url).origin)
  }, [url, ready, installedAgents, installedIds, hostInstalledIds])

  return <section className="agent-browser" aria-label="Agents 网页">
    <div className="agent-browser-content">
      {url && <iframe key={`${attempt}:${url}`} ref={frame} src={url} title="Agent Server 项目浏览器"
        onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'agent-client:hello', canInstall: isTauriRuntime(), installedAgents, installedIds: [...installedIds, ...hostInstalledIds] }, new URL(url).origin)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer" />}
      {(!ready || error) && <div className="agent-browser-status" role="status">
        <strong>{error ? '无法打开 Agents 页面' : '正在连接 Agent Server…'}</strong>
        {error && <><p>{error}</p><p>请确认 Agent Server 已启动。</p><button type="button" className="secondary-action" onClick={() => setAttempt(value => value + 1)}>重新连接</button></>}
      </div>}
    </div>
  </section>
}
