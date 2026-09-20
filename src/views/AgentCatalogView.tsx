import type { AgentCatalogEntry } from '../services/harness'
import type { AgentInstallationState } from '../services/agentInstallState'

interface AgentCatalogViewProps {
  agents: readonly AgentCatalogEntry[]
  installations: readonly AgentInstallationState[]
  category: string
  secondary: string
  refreshing: boolean
  error: string | null
  onRefresh(): void
  onInstall(id: string, update?: boolean): void
  onUninstall(id: string): void
}

function stateFor(
  entry: AgentCatalogEntry,
  installations: readonly AgentInstallationState[],
): AgentInstallationState | undefined {
  return installations.find((installation) => installation.id === entry.id)
}

export function AgentCatalogView({
  agents,
  installations,
  category,
  secondary,
  refreshing,
  error,
  onRefresh,
  onInstall,
  onUninstall,
}: AgentCatalogViewProps) {
  const visible = agents.filter((entry) => {
    const primary = category === 'all' || entry.category.toLowerCase() === category.toLowerCase()
    const secondaryMatches = secondary === 'all' || entry.category === secondary
    return primary && secondaryMatches
  })
  return <section className="agent-catalog" aria-labelledby="agent-catalog-title">
    <header className="agent-catalog-heading">
      <div>
        <h1 id="agent-catalog-title">Agent 目录</h1>
        <p>安装后可离线运行，并会出现在左侧栏，随时继续对话。</p>
      </div>
      <button className="secondary-action" type="button" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? '正在刷新…' : '刷新目录'}
      </button>
    </header>
    {error && <div className="agent-catalog-notice" role="status">
      <strong>使用本地目录</strong><span>{error}</span>
    </div>}
    {visible.length === 0 ? <div className="model-empty-conversation">
      <h2>{refreshing ? '正在读取 Agent 目录…' : '暂时没有可安装的 Agent'}</h2>
      <p>新的 Agent 发布后会出现在这里。</p>
    </div> : <div className="agent-catalog-grid">
      {visible.map((entry) => {
        const installation = stateFor(entry, installations)
        const installed = installation?.status === 'installed'
        const updating = installed && installation?.revision !== entry.sha256
        const busy = installation?.status === 'installing' || installation?.status === 'uninstalling'
        return <article key={entry.id} className="agent-catalog-card">
          <div className="agent-catalog-card-copy">
            <div className="agent-catalog-meta"><span>{entry.category}</span><span>v{entry.version}</span></div>
            <h2>{entry.name}</h2>
            <p>{entry.description}</p>
            <small>{entry.publisher}</small>
          </div>
          <div className="agent-catalog-actions">
            {installation?.status === 'error' && <span className="agent-install-label" title={installation.error}>安装失败</span>}
            {installed ? <>
              <button type="button" className="secondary-action" disabled={busy} onClick={() => onUninstall(entry.id)}>卸载</button>
              {updating && <button type="button" className="primary-action" disabled={busy} onClick={() => onInstall(entry.id, true)}>更新</button>}
            </> : <button type="button" className="primary-action" disabled={busy} onClick={() => onInstall(entry.id)}>
              {installation?.status === 'installing' ? '安装中…' : '安装'}
            </button>}
          </div>
        </article>
      })}
    </div>}
  </section>
}
