import { useEffect, useRef, useState } from 'react'
import { isTauriRuntime } from '../services/harness'
import type {
  AgentInstallRegistry,
  AgentInstallationState,
} from '../services/agentInstallState'
import {
  createAgentServerCatalogBridge,
  resolveAgentServerCatalogConnection,
  type AgentServerCatalogActions,
  type AgentServerCatalogBridge,
  type AgentServerCatalogStatus,
} from '../services/agentServerCatalogBridge'

interface PluginsViewProps {
  agentRegistry: AgentInstallRegistry
  installationState: readonly AgentInstallationState[]
  getAgentServerStatus(): Promise<AgentServerCatalogStatus>
  catalogActions: AgentServerCatalogActions
  category: string
  secondary: string
}

function isReadyMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const message = data as Record<string, unknown>
  return Object.keys(message).length === 1 && message.type === 'agent-server:ready'
}

export function PluginsView({
  agentRegistry,
  installationState,
  getAgentServerStatus,
  catalogActions,
  category,
  secondary,
}: PluginsViewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const bridge = useRef<AgentServerCatalogBridge | null>(null)
  const catalogLoadTimeout = useRef<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState('')
  const [origin, setOrigin] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let canceled = false
    setUrl('')
    setOrigin('')
    setReady(false)
    setError('')
    const connect = async () => {
      try {
        const status = isTauriRuntime()
          ? await getAgentServerStatus()
          : {
              url: import.meta.env.VITE_AGENT_SERVER_URL || 'http://127.0.0.1:8787/',
              available: true,
              error: null,
            }
        const connection = resolveAgentServerCatalogConnection(status)
        if (!connection.ok) throw new Error(connection.error)
        if (canceled) return
        setUrl(connection.iframeUrl)
        setOrigin(connection.origin)
      } catch (connectError) {
        if (!canceled) setError(String(connectError))
      }
    }
    void connect()
    return () => {
      canceled = true
    }
  }, [attempt])

  useEffect(() => {
    if (!url || !origin || !frame.current) return undefined
    const currentFrame = frame.current
    const clearCatalogLoadTimeout = () => {
      if (catalogLoadTimeout.current !== null) {
        window.clearTimeout(catalogLoadTimeout.current)
        catalogLoadTimeout.current = null
      }
    }
    const catalogBridge = createAgentServerCatalogBridge({
      registry: agentRegistry,
      actions: catalogActions,
      confirmMutation: async (mutation, uiId) => {
        const agent = agentRegistry.resolve(uiId)
        const action = mutation.type === 'agent-server:install'
          ? '安装'
          : mutation.type === 'agent-server:update'
            ? '更新'
            : '卸载'
        return window.confirm(`允许 Agent 目录${action}“${agent.title}”？`)
      },
      eventTarget: window,
      frame: currentFrame,
      expectedOrigin: origin,
    })
    bridge.current = catalogBridge
    const detach = catalogBridge.attach()
    const unsubscribe = agentRegistry.subscribe(() => {
      catalogBridge.sendInstallations()
    })
    const receiveReady = (event: MessageEvent) => {
      if (
        event.source === currentFrame.contentWindow &&
        event.origin === origin &&
        isReadyMessage(event.data)
      ) {
        clearCatalogLoadTimeout()
        setReady(true)
        setError('')
      }
    }
    catalogLoadTimeout.current = window.setTimeout(() => {
      catalogLoadTimeout.current = null
      setError('项目网页未能加载，请检查服务连接后重试。')
    }, 12_000)
    window.addEventListener('message', receiveReady)
    return () => {
      clearCatalogLoadTimeout()
      window.removeEventListener('message', receiveReady)
      unsubscribe()
      detach()
      if (bridge.current === catalogBridge) bridge.current = null
    }
  }, [agentRegistry, catalogActions, origin, url])

  useEffect(() => {
    bridge.current?.sendInstallations()
  }, [installationState])

  useEffect(() => {
    if (url && ready) {
      frame.current?.contentWindow?.postMessage(
        { type: 'agent-client:category', category, secondary },
        origin,
      )
    }
  }, [category, secondary, origin, ready, url])

  return <section className="agent-browser" aria-label="Agents 网页">
    <div className="agent-browser-content">
      {url && <iframe
        key={`${attempt}:${url}`}
        ref={frame}
        src={url}
        title="Agent Server 项目浏览器"
        onLoad={() => bridge.current?.sendHello()}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />}
      {(!ready || error) && <div className="agent-browser-status" role="status">
        <strong>{error ? '无法打开 Agents 页面' : '正在连接 Agent Server…'}</strong>
        {error && <>
          <p>{error}</p>
          <p>请确认 Agent Server 已启动。</p>
          <button
            type="button"
            className="secondary-action"
            onClick={() => setAttempt(value => value + 1)}
          >
            重新连接
          </button>
        </>}
      </div>}
    </div>
  </section>
}
