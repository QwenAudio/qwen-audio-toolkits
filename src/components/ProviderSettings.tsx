import { useEffect, useState } from 'react'
import {
  BrainCircuit,
  Check,
  Cloud,
  CirclePlus,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
} from 'lucide-react'
import {
  getApiProviderSettings,
  deleteApiProviderSettings,
  getBailianProviderSettings,
  getHarnessCatalog,
  isTauriRuntime,
  saveApiProviderSettings,
  saveBailianProviderSettings,
} from '../services/harness'
import type {
  ApiProviderSettings,
  BailianProviderSettings,
  HarnessCatalog,
  HarnessProvider,
  RuntimeStatus,
} from '../types'

export type ProviderSettingsKind = 'bailian' | 'custom'

interface ProviderSettingsProps {
  provider: ProviderSettingsKind
  onProviderChange: (provider: ProviderSettingsKind) => void
  runtime: RuntimeStatus
  catalog: HarnessCatalog | null
  onCatalogChanged: (catalog: HarnessCatalog) => void
  onAction: (message: string) => void
  customProviderId?: string
}

const fallbackBailianSettings: BailianProviderSettings = {
  id: 'api.bailian',
  name: '阿里云百炼',
  apiKeyConfigured: false,
  enabled: false,
  status: 'unconfigured',
}

const fallbackApiSettings: ApiProviderSettings = {
  id: 'api.openai-compatible',
  name: 'Custom Provider',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyConfigured: false,
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'alloy',
  asrModel: 'gpt-4o-mini-transcribe',
  llmModel: 'gpt-4o-mini',
  enabled: false,
  status: 'unconfigured',
  llmEnabled: true,
  asrEnabled: true,
  ttsEnabled: true,
  authType: 'bearer',
  authHeader: 'x-api-key',
  extraHeaders: {},
  llmPath: '/chat/completions',
  asrMode: 'multipart',
  asrPath: '/audio/transcriptions',
  asrBodyTemplate: '{\n  "audio": { "data": "{audioBase64}" },\n  "request": { "model_name": "{model}" }\n}',
  asrModelField: 'model',
  asrLanguageField: 'language',
  asrPromptField: 'prompt',
  asrTextPointer: '/text',
  ttsMode: 'standard-json',
  ttsPath: '/audio/speech',
  ttsBodyTemplate: '{\n  "user": { "uid": "desktop-client" },\n  "req_params": {\n    "text": "{text}",\n    "speaker": "{voice}",\n    "audio_params": { "format": "{audioFormat}", "sample_rate": "{sampleRate}" }\n  }\n}',
  ttsResponseEncoding: 'raw',
  ttsAudioPointer: '/data/audio',
  ttsAudioFormat: 'wav',
  ttsSampleRate: 24000,
}

const providerStatusLabels: Record<HarnessProvider['status'], string> = {
  ready: '已连接',
  missing: '组件缺失',
  disabled: '已停用',
  unconfigured: '未配置',
}

function headersToText(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

function textToHeaders(value: string) {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':')
        return separator < 1
          ? [line, '']
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
      }),
  )
}

function BailianProviderPanel({
  runtime,
  catalog,
  onCatalogChanged,
  onAction,
}: Omit<ProviderSettingsProps, 'provider' | 'onProviderChange'>) {
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
      onAction('请先填写百炼 Access Key')
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
      onAction('百炼 AK 已保存')
    } catch (error) {
      onAction(
        `保存失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const provider = catalog?.providers.find((item) => item.id === 'api.bailian')

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
            <p>保存访问凭据后，可在扩展中按需添加在线模型。</p>
          </div>
          <span
            className={`provider-health ${settings.status === 'ready' ? 'ready' : ''}`}
          >
            <i />
            {settings.status === 'ready' ? 'AK 已配置' : '待配置 AK'}
          </span>
        </div>

        <div className="provider-form-grid">
          <label className="provider-key-field">
            <span>Access Key（AK）</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={
                settings.apiKeyConfigured
                  ? 'AK 已保存 · 留空保持不变'
                  : '输入百炼 AK'
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </div>

        <div className="provider-save-row provider-save-row-simple">
          <span className="provider-storage-note">
            <ShieldCheck size={15} />
            AK 仅保存在本机应用配置
          </span>
          <button
            className="primary-action"
            type="button"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <RefreshCw size={15} /> : <Check size={15} />}
            {saving ? '保存中' : '保存'}
          </button>
        </div>
      </section>

      <aside className="api-provider-summary">
        <span className="section-kicker">PROVIDER</span>
        <h2>连接状态</h2>
        <p className="provider-summary-copy">
          凭据只用于连接服务。需要使用的模型请在扩展中单独添加。
        </p>
        <dl className="provider-contract-facts">
          <div>
            <dt>状态</dt>
            <dd>{providerStatusLabels[provider?.status ?? settings.status]}</dd>
          </div>
          <div>
            <dt>本地 API</dt>
            <dd>{runtime.apiUrl}</dd>
          </div>
          <div>
            <dt>模型参数</dt>
            <dd>扩展中选择</dd>
          </div>
        </dl>
        <div className="provider-safety-note">
          <ShieldCheck size={16} />
          <span>
            <strong>显式云端执行</strong>
            <small>只有选择百炼模型时，输入才会发送到百炼 API。</small>
          </span>
        </div>
      </aside>
    </div>
  )
}

function CustomProviderPanel({
  runtime,
  catalog,
  onCatalogChanged,
  onAction,
  customProviderId,
}: Omit<ProviderSettingsProps, 'provider' | 'onProviderChange'>) {
  const [providers, setProviders] = useState<ApiProviderSettings[]>([])
  const [settings, setSettings] = useState(fallbackApiSettings)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const desktopRuntime = isTauriRuntime()

  const selectProvider = (next: ApiProviderSettings) => {
    setSettings(next)
    setApiKey('')
  }

  useEffect(() => {
    if (!desktopRuntime) return
    void getApiProviderSettings()
      .then((next) => {
        setProviders(next)
        selectProvider(
          next.find(({ id }) => id === customProviderId) ??
            next[0] ??
            fallbackApiSettings,
        )
      })
      .catch((error) =>
        onAction(
          `无法读取自定义 Provider：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
  }, [customProviderId, desktopRuntime, onAction])

  const save = async () => {
    if (!desktopRuntime || saving) return
    const localEndpoint =
      /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
        settings.baseUrl.trim(),
      )
    if (!settings.name.trim()) {
      onAction('请填写 Provider 名称')
      return
    }
    if (!settings.baseUrl.trim()) {
      onAction('请填写 API Base URL')
      return
    }
    if (!settings.llmEnabled && !settings.asrEnabled && !settings.ttsEnabled) {
      onAction('请至少启用一种 Provider 能力')
      return
    }
    if (
      settings.authType !== 'none' &&
      !localEndpoint &&
      !settings.apiKeyConfigured &&
      !apiKey.trim()
    ) {
      onAction('远程 Provider 需要填写 API Key')
      return
    }
    setSaving(true)
    try {
      const next = await saveApiProviderSettings({
        ...settings,
        id: settings.id.startsWith('api.new.') ? undefined : settings.id,
        name: settings.name.trim(),
        baseUrl: settings.baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        enabled: true,
      })
      setProviders((current) => {
        const exists = current.some(({ id }) => id === next.id)
        return exists
          ? current.map((item) => (item.id === next.id ? next : item))
          : [...current, next]
      })
      selectProvider(next)
      setApiKey('')
      onCatalogChanged(await getHarnessCatalog())
      onAction('自定义 Provider 已保存')
    } catch (error) {
      onAction(
        `保存失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const addProvider = () => {
    selectProvider({
      ...fallbackApiSettings,
      id: `api.new.${crypto.randomUUID()}`,
      name: '',
      baseUrl: '',
    })
  }

  const removeProvider = async () => {
    if (!desktopRuntime || settings.id.startsWith('api.new.')) {
      selectProvider(providers[0] ?? fallbackApiSettings)
      return
    }
    if (
      !window.confirm(
        `删除 Provider“${settings.name}”？绑定它的自定义模型将不再显示。`,
      )
    ) {
      return
    }
    try {
      const next = await deleteApiProviderSettings(settings.id)
      setProviders(next)
      selectProvider(next[0] ?? fallbackApiSettings)
      onCatalogChanged(await getHarnessCatalog())
      onAction('自定义 Provider 已删除；引用它的模型将不再显示')
    } catch (error) {
      onAction(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const update = <Key extends keyof ApiProviderSettings>(
    key: Key,
    value: ApiProviderSettings[Key],
  ) => setSettings((current) => ({ ...current, [key]: value }))

  const provider = catalog?.providers.find(({ id }) => id === settings.id)

  return (
    <div className="api-provider-workspace">
      <section className="api-provider-form">
        <div className="api-provider-heading">
          <span className="plugin-logo tone-violet">
            <BrainCircuit size={20} />
          </span>
          <div>
            <div className="api-provider-tags">
              <span className="execution-mode-tag api">
                <Wifi size={11} />
                通用 REST API
              </span>
              <span className="adapter-installed-tag">
                <PackageCheck size={11} />
                适配器已安装
              </span>
            </div>
            <h2>自定义 Provider</h2>
            <p>连接、鉴权和能力协议在这里配置；模型只保存 Model ID。</p>
          </div>
          <span
            className={`provider-health ${settings.status === 'ready' ? 'ready' : ''}`}
          >
            <i />
            {settings.status === 'ready' ? '已连接' : '待配置'}
          </span>
        </div>

        <div className="provider-picker-row">
          <label>
            <span>已保存的 Provider</span>
            <select
              value={settings.id}
              onChange={(event) => {
                const next = providers.find(({ id }) => id === event.target.value)
                if (next) selectProvider(next)
              }}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
              {settings.id.startsWith('api.new.') && (
                <option value={settings.id}>新 Provider</option>
              )}
            </select>
          </label>
          <button className="secondary-action" type="button" onClick={addProvider}>
            <CirclePlus size={15} />新增
          </button>
          <button className="icon-button danger" type="button" aria-label="删除 Provider" onClick={() => void removeProvider()}>
            <Trash2 size={16} />
          </button>
        </div>

        <div className="provider-form-grid">
          <label>
            <span>Provider 名称</span>
            <input
              value={settings.name}
              placeholder="例如团队网关或本地服务"
              onChange={(event) => update('name', event.target.value)}
            />
          </label>
          <label className="provider-endpoint-field">
            <span>API Base URL</span>
            <input
              value={settings.baseUrl}
              inputMode="url"
              placeholder="https://api.example.com/v1"
              onChange={(event) => update('baseUrl', event.target.value)}
            />
          </label>
          <label>
            <span>鉴权方式</span>
            <select value={settings.authType} onChange={(event) => update('authType', event.target.value as ApiProviderSettings['authType'])}>
              <option value="bearer">Authorization: Bearer</option>
              <option value="token">Authorization: Token</option>
              <option value="custom-header">自定义 Header</option>
              <option value="none">无需鉴权</option>
            </select>
          </label>
          {settings.authType === 'custom-header' && (
            <label>
              <span>鉴权 Header</span>
              <input value={settings.authHeader} placeholder="x-api-key" onChange={(event) => update('authHeader', event.target.value)} />
            </label>
          )}
          <label className="provider-key-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={
                settings.apiKeyConfigured
                  ? 'API Key 已保存 · 留空保持不变'
                  : '本机 localhost 服务可留空'
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="provider-key-field">
            <span>附加请求 Header</span>
            <textarea
              value={headersToText(settings.extraHeaders)}
              placeholder={'X-Resource-Id: service-id\nX-Request-Id: {uuid}'}
              onChange={(event) => update('extraHeaders', textToHeaders(event.target.value))}
            />
            <small>每行一个 Name: Value；支持 {'{model}'}、{'{voice}'}、{'{uuid}'} 变量</small>
          </label>
        </div>

        <div className="provider-capability-grid">
          <label><input type="checkbox" checked={settings.llmEnabled} onChange={(event) => update('llmEnabled', event.target.checked)} /><span>LLM</span></label>
          <label><input type="checkbox" checked={settings.asrEnabled} onChange={(event) => update('asrEnabled', event.target.checked)} /><span>ASR</span></label>
          <label><input type="checkbox" checked={settings.ttsEnabled} onChange={(event) => update('ttsEnabled', event.target.checked)} /><span>TTS</span></label>
        </div>

        <div className="provider-protocol-sections">
          {settings.llmEnabled && (
            <details open><summary>LLM 接口</summary><div className="provider-form-grid"><label><span>Chat Completions 路径</span><input value={settings.llmPath} onChange={(event) => update('llmPath', event.target.value)} /></label></div></details>
          )}
          {settings.asrEnabled && (
            <details><summary>ASR 接口</summary><div className="provider-form-grid">
              <label><span>请求格式</span><select value={settings.asrMode} onChange={(event) => update('asrMode', event.target.value as ApiProviderSettings['asrMode'])}><option value="multipart">Multipart 文件上传</option><option value="binary">原始音频 Body</option><option value="template-json-base64">JSON 模板（Base64 音频）</option></select></label>
              <label><span>接口路径</span><input value={settings.asrPath} placeholder="/audio/transcriptions" onChange={(event) => update('asrPath', event.target.value)} /></label>
              {settings.asrMode === 'multipart' && <><label><span>模型字段</span><input value={settings.asrModelField} onChange={(event) => update('asrModelField', event.target.value)} /></label><label><span>语言字段</span><input value={settings.asrLanguageField} onChange={(event) => update('asrLanguageField', event.target.value)} /></label><label><span>提示词字段</span><input value={settings.asrPromptField} onChange={(event) => update('asrPromptField', event.target.value)} /></label></>}
              {settings.asrMode === 'template-json-base64' && <label className="provider-key-field"><span>请求 JSON 模板</span><textarea value={settings.asrBodyTemplate} onChange={(event) => update('asrBodyTemplate', event.target.value)} /><small>支持 {'{audioBase64}'}、{'{model}'}、{'{language}'}、{'{prompt}'}、{'{uuid}'}</small></label>}
              <label><span>文本响应路径</span><input value={settings.asrTextPointer} placeholder="/text" onChange={(event) => update('asrTextPointer', event.target.value)} /><small>使用 JSON Pointer，例如 /channel/alternatives/0/transcript</small></label>
            </div></details>
          )}
          {settings.ttsEnabled && (
            <details><summary>TTS 接口</summary><div className="provider-form-grid">
              <label><span>请求格式</span><select value={settings.ttsMode} onChange={(event) => update('ttsMode', event.target.value as ApiProviderSettings['ttsMode'])}><option value="standard-json">标准 JSON（model/input/voice）</option><option value="voice-path-json">音色在 URL（text/model_id）</option><option value="nested-voice-json">嵌套音色与音频设置</option><option value="query-model-json">模型在 URL 或查询参数</option><option value="template-json">自定义 JSON 模板</option></select></label>
              <label><span>接口路径</span><input value={settings.ttsPath} placeholder="/audio/speech" onChange={(event) => update('ttsPath', event.target.value)} /><small>可使用 {'{model}'}、{'{voice}'} 和 {'{speed}'} 变量</small></label>
              {settings.ttsMode === 'template-json' && <label className="provider-key-field"><span>请求 JSON 模板</span><textarea value={settings.ttsBodyTemplate} onChange={(event) => update('ttsBodyTemplate', event.target.value)} /><small>支持 {'{text}'}、{'{model}'}、{'{voice}'}、{'{speed}'}、{'{speechRate}'}、{'{sampleRate}'}、{'{audioFormat}'}、{'{uuid}'}</small></label>}
              <label><span>响应编码</span><select value={settings.ttsResponseEncoding} onChange={(event) => update('ttsResponseEncoding', event.target.value as ApiProviderSettings['ttsResponseEncoding'])}><option value="raw">原始音频</option><option value="hex">JSON 中的 Hex</option><option value="base64">JSON 中的 Base64</option><option value="stream-base64">分块 JSON / SSE Base64</option></select></label>
              {settings.ttsResponseEncoding !== 'raw' && <label><span>音频响应路径</span><input value={settings.ttsAudioPointer} placeholder="/data/audio" onChange={(event) => update('ttsAudioPointer', event.target.value)} /></label>}
              <label><span>音频格式</span><select value={settings.ttsAudioFormat} onChange={(event) => update('ttsAudioFormat', event.target.value as ApiProviderSettings['ttsAudioFormat'])}><option value="wav">WAV</option><option value="pcm16">PCM16 单声道</option></select></label>
              <label><span>采样率</span><input type="number" min="8000" max="96000" value={settings.ttsSampleRate} onChange={(event) => update('ttsSampleRate', Number(event.target.value))} /></label>
            </div></details>
          )}
        </div>

        <div className="provider-save-row provider-save-row-simple">
          <span className="provider-storage-note">
            <ShieldCheck size={15} />
            API Key 仅保存在本机应用配置
          </span>
          <button
            className="primary-action"
            type="button"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? (
              <RefreshCw className="model-spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            {saving ? '保存中' : '保存并启用'}
          </button>
        </div>
      </section>

      <aside className="api-provider-summary">
        <span className="section-kicker">PROVIDER</span>
        <h2>连接信息</h2>
        <p className="provider-summary-copy">
          Provider 只负责连接；模型名称与 Model ID 在扩展中管理。
        </p>
        <dl className="provider-contract-facts">
          <div>
            <dt>状态</dt>
            <dd>{providerStatusLabels[provider?.status ?? settings.status]}</dd>
          </div>
          <div>
            <dt>接口</dt>
            <dd>{[settings.llmEnabled && 'LLM', settings.asrEnabled && 'ASR', settings.ttsEnabled && 'TTS'].filter(Boolean).join(' · ') || '未启用'}</dd>
          </div>
          <div>
            <dt>本地 API</dt>
            <dd>{runtime.apiUrl}</dd>
          </div>
        </dl>
        <div className="provider-safety-note">
          <ShieldCheck size={16} />
          <span>
            <strong>显式云端执行</strong>
            <small>只有使用其模型时，消息才会发送到配置的地址。</small>
          </span>
        </div>
      </aside>
    </div>
  )
}

export function ProviderSettings({
  provider,
  onProviderChange,
  runtime,
  catalog,
  onCatalogChanged,
  onAction,
  customProviderId,
}: ProviderSettingsProps) {
  const bailian = catalog?.providers.find(({ id }) => id === 'api.bailian')
  const custom = catalog?.providers.find(
    ({ id }) => id === 'api.openai-compatible',
  )

  return (
    <div className="provider-settings">
      <div className="cloud-provider-tabs" aria-label="选择 Provider">
        <button
          className={provider === 'bailian' ? 'active' : ''}
          type="button"
          onClick={() => onProviderChange('bailian')}
        >
          <Sparkles size={17} />
          <span>
            <strong>阿里云百炼</strong>
            <small>Qwen、FunASR 与 CosyVoice</small>
          </span>
          <i className={`status-dot${bailian?.status === 'ready' ? '' : ' pending'}`} />
        </button>
        <button
          className={provider === 'custom' ? 'active' : ''}
          type="button"
          onClick={() => onProviderChange('custom')}
        >
          <Cloud size={17} />
          <span>
            <strong>自定义</strong>
            <small>通用 LLM、ASR 与 TTS API</small>
          </span>
          <i className={`status-dot${custom?.status === 'ready' ? '' : ' pending'}`} />
        </button>
      </div>

      {provider === 'bailian' ? (
        <BailianProviderPanel
          runtime={runtime}
          catalog={catalog}
          onCatalogChanged={onCatalogChanged}
          onAction={onAction}
          customProviderId={customProviderId}
        />
      ) : (
        <CustomProviderPanel
          runtime={runtime}
          catalog={catalog}
          onCatalogChanged={onCatalogChanged}
          onAction={onAction}
        />
      )}
    </div>
  )
}
