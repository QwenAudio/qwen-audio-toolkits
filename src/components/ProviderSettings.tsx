import { useEffect, useState } from 'react'
import { Check, PackageCheck, RefreshCw, ShieldCheck, Sparkles, Wifi } from 'lucide-react'
import { getBailianProviderSettings, getHarnessCatalog, isTauriRuntime, saveBailianProviderSettings } from '../services/harness'
import type { BailianProviderSettings, HarnessCatalog } from '../types'

interface ProviderSettingsProps {
  onCatalogChanged: (catalog: HarnessCatalog) => void
  onAction: (message: string) => void
}

const fallbackBailianSettings: BailianProviderSettings = {
  id: 'api.bailian',
  name: '阿里云百炼',
  apiKeyConfigured: false,
  enabled: false,
  status: 'unconfigured',
}

export function ProviderSettings({
  onCatalogChanged,
  onAction,
}: ProviderSettingsProps) {
  const [settings, setSettings] = useState<BailianProviderSettings>(
    fallbackBailianSettings,
  )
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const desktopRuntime = isTauriRuntime()

  useEffect(() => {
    if (!desktopRuntime) return
    void getBailianProviderSettings()
      .then(setSettings)
      .catch((error) =>
        onAction(
          `无法读取百炼配置：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }, [desktopRuntime, onAction])

  const save = async () => {
    if (!desktopRuntime || saving) return
    if (!settings.apiKeyConfigured && !apiKey.trim()) {
      onAction('请先填写百炼 API Key')
      return
    }
    setSaving(true)
    try {
      const next = await saveBailianProviderSettings({
        apiKey: apiKey.trim() || undefined,
      })
      setSettings(next)
      setApiKey('')
      onCatalogChanged(await getHarnessCatalog())
      onAction('百炼 API Key 已保存')
    } catch (error) {
      onAction(
        `保存失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setSaving(false)
    }
  }


  return (
    <div className="api-provider-workspace">
      <section className="api-provider-form">
        <div className="api-provider-heading">
          <span className="plugin-logo tone-violet">
            <Sparkles size={20} />
          </span>
          <div>
            <div className="api-provider-tags">
              <span className="execution-mode-tag api">
                <Wifi size={11} />
                云端 API
              </span>
              <span className="adapter-installed-tag">
                <PackageCheck size={11} />
                适配器已安装
              </span>
            </div>
            <h2>阿里云百炼</h2>
            <p>连接后，即可在 Agent 中使用语音合成、识别和对话服务。</p>
          </div>
          <span
            className={`provider-health ${settings.status === 'ready' ? 'ready' : ''}`}
          >
            <i />
            {settings.status === 'ready' ? '已配置' : '未配置'}
          </span>
        </div>

        <div className="provider-form-grid">
          <label className="provider-key-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={
                settings.apiKeyConfigured
                  ? 'API Key 已保存 · 留空保持不变'
                  : '输入百炼 API Key'
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </div>

        <div className="provider-save-row provider-save-row-simple">
          <span className="provider-storage-note">
            <ShieldCheck size={15} />
            凭据仅保存在本机
          </span>
          <button
            className="primary-action"
            type="button"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <RefreshCw size={15} /> : <Check size={15} />}
            {saving ? '保存中…' : '保存账号'}
          </button>
        </div>
      </section>


    </div>
  )
}
