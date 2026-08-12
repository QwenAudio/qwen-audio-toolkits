import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Boxes,
  BrainCircuit,
  CirclePlus,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  KeyRound,
  PackageCheck,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  Waves,
  Wifi,
  X,
} from 'lucide-react'
import {
  getHarnessCatalog,
  installCatalogModel,
  installRecommendedModelDependency,
  isTauriRuntime,
  listModelPlugins,
  cancelModelDownload,
  setModelPluginSidebarVisible,
  setModelDownloadPaused,
  uninstallModelPlugin,
} from '../services/harness'
import {
  getModelBinding,
  referencingModels,
  recommendedDependencies,
} from '../modelDependencies'
import { cloudModelsFromCatalog } from '../cloudModels'
import {
  advanceInstallProgress,
  parseInstallSpeed,
  type InstallProgressScope,
} from '../services/installProgress'
import type {
  ApiModelCatalogEntry,
  CustomApiModelDefinition,
  HarnessCatalog,
  ModelDependencyBindings,
  ModelPlugin,
  RuntimeStatus,
} from '../types'

interface PluginsViewProps {
  plugins: ModelPlugin[]
  modelBindings: ModelDependencyBindings
  runtime: RuntimeStatus
  catalog: HarnessCatalog | null
  apiModelCatalog: ApiModelCatalogEntry[]
  customApiModels: CustomApiModelDefinition[]
  installedCloudModelIds: string[]
  onCustomApiModelsChanged: (models: CustomApiModelDefinition[]) => void
  onConfigureProvider: (providerId: string) => void
  onPluginsChanged: (plugins: ModelPlugin[]) => void
  onModelBindingsChanged: (bindings: ModelDependencyBindings) => void
  onRemoveModelBindings: (pluginId: string) => void
  onSetModelBinding: (
    pluginId: string,
    role: string,
    dependencyId: string,
  ) => Promise<void>
  onCatalogChanged: (catalog: HarnessCatalog) => void
  onCloudModelInstalled: (modelId: string, installed: boolean) => void
  onAction: (message: string) => void
}

function isApiPlugin(plugin: ModelPlugin): boolean {
  return (
    plugin.providerId?.startsWith('api.') === true ||
    /api|cloud|remote/i.test(plugin.runtime)
  )
}

function displayPluginVersion(plugin: ModelPlugin, apiPlugin: boolean): string {
  const version = plugin.version.trim()
  if (apiPlugin || !version || version.startsWith('v') || !/^\d/.test(version)) {
    return version
  }
  return `v${version}`
}

function compareCatalogModels(left: ModelPlugin, right: ModelPlugin): number {
  return left.name.localeCompare(right.name, 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  })
}

type CatalogInstallJob = {
  pluginId: string
  variantId?: string
  name: string
}

type CatalogInstallState = 'queued' | 'running' | 'paused' | 'canceling'


export function PluginsView({
  plugins,
  modelBindings,
  runtime,
  catalog,
  apiModelCatalog,
  customApiModels,
  installedCloudModelIds,
  onCustomApiModelsChanged,
  onConfigureProvider,
  onPluginsChanged,
  onModelBindingsChanged,
  onRemoveModelBindings,
  onSetModelBinding,
  onCatalogChanged,
  onCloudModelInstalled,
  onAction,
}: PluginsViewProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<
    'all' | 'audio' | 'understanding' | 'text' | 'generation'
  >('all')
  const [runtimeFilter, setRuntimeFilter] = useState<
    'all' | 'offline' | 'api'
  >('all')
  const [selectedId, setSelectedId] = useState(
    plugins.find((plugin) =>
      plugin.harnessCapabilities.includes('speech.synthesize'),
    )?.id ??
      plugins.find((plugin) => plugin.featured)?.id ??
      plugins[0]?.id ??
      '',
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState(0)
  const [installDetail, setInstallDetail] = useState('')
  const [installStage, setInstallStage] = useState('')
  const [installSpeed, setInstallSpeed] = useState('')
  const installProgressScopeRef = useRef<InstallProgressScope>('model')
  const [installJobs, setInstallJobs] = useState<
    Record<string, CatalogInstallState>
  >({})
  const installJobsRef = useRef<Record<string, CatalogInstallJob>>({})
  const canceledInstallIdsRef = useRef(new Set<string>())
  const installChainRef = useRef(Promise.resolve())
  const [cloudBusyIds, setCloudBusyIds] = useState<Set<string>>(
    () => new Set(),
  )
  const cloudBusyIdsRef = useRef(new Set<string>())
  const [selectedVariants, setSelectedVariants] = useState<
    Record<string, string>
  >({})
  const [customModelEditorOpen, setCustomModelEditorOpen] = useState(false)
  const [customModelName, setCustomModelName] = useState('')
  const [customModelServiceId, setCustomModelServiceId] = useState('')
  const [customModelCapability, setCustomModelCapability] = useState<
    CustomApiModelDefinition['capability']
  >('text.generate')
  const customProviders = useMemo(
    () =>
      catalog?.providers.filter(
        ({ id }) =>
          id === 'api.openai-compatible' || id.startsWith('api.custom.'),
      ) ?? [],
    [catalog],
  )
  const [customModelProviderId, setCustomModelProviderId] = useState(
    customProviders[0]?.id ?? 'api.openai-compatible',
  )
  const selectedCustomProvider = customProviders.find(
    ({ id }) => id === customModelProviderId,
  )
  const customCapabilityOptions = [
    ...(selectedCustomProvider?.capabilities.includes('text.generate') !== false
      ? [{ value: 'text.generate' as const, label: 'LLM · 文本生成' }]
      : []),
    ...(selectedCustomProvider?.capabilities.includes('speech.transcribe') !== false
      ? [{ value: 'speech.transcribe' as const, label: 'ASR · 语音识别' }]
      : []),
    ...(selectedCustomProvider?.capabilities.includes('speech.synthesize') !== false
      ? [{ value: 'speech.synthesize' as const, label: 'TTS · 语音合成' }]
      : []),
  ]
  useEffect(() => {
    const provider = customProviders.find(
      ({ id }) => id === customModelProviderId,
    )
    if (!provider && customProviders[0]) {
      setCustomModelProviderId(customProviders[0].id)
      setCustomModelCapability(
        customProviders[0]
          .capabilities[0] as CustomApiModelDefinition['capability'],
      )
      return
    }
    if (provider && !provider.capabilities.includes(customModelCapability)) {
      setCustomModelCapability(
        provider.capabilities[0] as CustomApiModelDefinition['capability'],
      )
    }
  }, [customModelCapability, customModelProviderId, customProviders])
  const [customModelVoice, setCustomModelVoice] = useState('alloy')
  const desktopRuntime = isTauriRuntime()
  const installProgressLabel = `${Math.round(installProgress)}%`
  const compactInstallProgress = installSpeed
    ? `${installProgressLabel} · ${installSpeed}`
    : installProgressLabel
  const cloudModels = useMemo(
    () =>
      cloudModelsFromCatalog(
        catalog,
        installedCloudModelIds,
        apiModelCatalog,
        customApiModels,
      ),
    [apiModelCatalog, catalog, customApiModels, installedCloudModelIds],
  )
  const allModels = useMemo(
    () => [...plugins, ...cloudModels].sort(compareCatalogModels),
    [cloudModels, plugins],
  )

  useEffect(() => {
    if (!pendingDeleteId) return undefined
    const timer = window.setTimeout(() => setPendingDeleteId(null), 3200)
    return () => window.clearTimeout(timer)
  }, [pendingDeleteId])

  useEffect(() => {
    if (!desktopRuntime) return undefined
    let remove: (() => void) | undefined
    void listen<{
      stage: string
      progress: number
      detail: string
    }>('plugin-install-progress', (event) => {
      setInstallProgress((current) =>
        advanceInstallProgress(
          current,
          event.payload.progress,
          installProgressScopeRef.current,
        ),
      )
      setInstallDetail(event.payload.detail)
      setInstallStage(event.payload.stage)
      const speed = parseInstallSpeed(event.payload.detail)
      setInstallSpeed((current) =>
        speed ?? (event.payload.stage === 'downloading' ? current : ''),
      )
    }).then((unlisten) => {
      remove = unlisten
    })
    return () => remove?.()
  }, [desktopRuntime])

  const filteredPlugins = useMemo(
    () =>
      allModels.filter((plugin) => {
        const searchMatch =
          plugin.name.toLowerCase().includes(search.toLowerCase()) ||
          plugin.description.toLowerCase().includes(search.toLowerCase()) ||
          plugin.version.toLowerCase().includes(search.toLowerCase()) ||
          (plugin.apiAliases ?? []).some((alias) =>
            alias.toLowerCase().includes(search.toLowerCase()),
          )
        const filterMatch =
          filter === 'all' ||
          (filter === 'audio' &&
            plugin.harnessCapabilities.some((capability) =>
              [
                'audio.enhance',
                'audio.live',
                'speech.detect',
                'audio.separate',
              ].includes(capability),
            )) ||
          (filter === 'understanding' &&
            plugin.harnessCapabilities.some((capability) =>
              [
                'speech.transcribe',
                'audio.classify',
                'speech.keyword',
                'speech.language',
                'speaker.embed',
                'speaker.diarize',
              ].includes(capability),
            )) ||
          (filter === 'text' &&
            plugin.harnessCapabilities.some((capability) =>
              ['text.generate', 'text.punctuate', 'text.normalize'].includes(
                capability,
              ),
            )) ||
          (filter === 'generation' &&
            plugin.harnessCapabilities.includes('speech.synthesize'))
        const apiPlugin = isApiPlugin(plugin)
        const runtimeMatch =
          runtimeFilter === 'all' ||
          (runtimeFilter === 'api' && apiPlugin) ||
          (runtimeFilter === 'offline' && !apiPlugin)
        return searchMatch && filterMatch && runtimeMatch
      }),
    [allModels, filter, runtimeFilter, search],
  )
  const selectedPlugin =
    filteredPlugins.find((plugin) => plugin.id === selectedId) ??
    filteredPlugins[0]
  const selectedIsApi = selectedPlugin
    ? isApiPlugin(selectedPlugin)
    : false
  const selectedVariant = selectedPlugin?.variants?.find(
    (variant) =>
      variant.id ===
      (selectedVariants[selectedPlugin.id] ??
        selectedPlugin.selectedVariantId ??
        selectedPlugin.defaultVariantId),
  )
  const [, setBindingRevision] = useState(0)
  const selectedDependencies = selectedPlugin
    ? recommendedDependencies(selectedPlugin)
    : []
  const selectedInstallState = selectedPlugin
    ? installJobs[selectedPlugin.id]
    : undefined
  const selectedCanQueueInstall = Boolean(
    selectedPlugin &&
      !selectedIsApi &&
      !selectedPlugin.installed &&
      selectedPlugin.catalogManaged,
  )
  const selectedCloudBusy = Boolean(
    selectedPlugin && selectedIsApi && cloudBusyIds.has(selectedPlugin.id),
  )
  const anotherOperationBusy = Boolean(
    busyId && !installJobsRef.current[busyId],
  )

  const variantIdFor = (plugin: ModelPlugin) =>
    selectedVariants[plugin.id] ??
    plugin.selectedVariantId ??
    plugin.defaultVariantId

  const addCustomApiModel = () => {
    const modelId = customModelServiceId.trim()
    if (!modelId) {
      onAction('请填写 Model ID')
      return
    }
    const id = `custom-api-${crypto.randomUUID()}`
    onCustomApiModelsChanged([
      ...customApiModels,
      {
        id,
        name: customModelName.trim() || modelId,
        modelId,
        providerId: customModelProviderId,
        capability: customModelCapability,
        ...(customModelCapability === 'speech.synthesize'
          ? { defaultVoice: customModelVoice.trim() || 'alloy' }
          : {}),
      },
    ])
    setCustomModelName('')
    setCustomModelServiceId('')
    setCustomModelCapability('text.generate')
    setCustomModelProviderId(customProviders[0]?.id ?? 'api.openai-compatible')
    setCustomModelVoice('alloy')
    setCustomModelEditorOpen(false)
    setFilter('text')
    setRuntimeFilter('api')
    setSelectedId(id)
    onAction('自定义 API 模型已添加到模型商店')
  }

  const setCloudModelInstalled = async (
    plugin: ModelPlugin,
    installed: boolean,
  ) => {
    if (cloudBusyIdsRef.current.has(plugin.id)) return
    cloudBusyIdsRef.current.add(plugin.id)
    setCloudBusyIds((current) => new Set(current).add(plugin.id))
    try {
      let optionalDependencyFailures: string[] = []
      if (installed) {
        setInstallProgress(0)
        setInstallSpeed('')
        setInstallStage('preparing')
        setInstallDetail('正在准备依赖模型')
        installProgressScopeRef.current = 'dependency'
        optionalDependencyFailures = await ensureSelectedDependencies(plugin)
        setInstallProgress(100)
      }
      onCloudModelInstalled(plugin.id, installed)
      await refreshPlugins()
      onAction(
        installed
          ? `${plugin.name} 已添加到工作台${optionalDependencyNotice(optionalDependencyFailures)}`
          : `${plugin.name} 已从工作台移除`,
      )
    } catch (error) {
      onAction(
        `操作失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      cloudBusyIdsRef.current.delete(plugin.id)
      installProgressScopeRef.current = 'model'
      setInstallProgress(0)
      setInstallSpeed('')
      setInstallStage('')
      setInstallDetail('')
      setCloudBusyIds((current) => {
        const next = new Set(current)
        next.delete(plugin.id)
        return next
      })
    }
  }

  const refreshPlugins = async () => {
    const [nextPlugins, nextCatalog] = await Promise.all([
      listModelPlugins(),
      getHarnessCatalog(),
    ])
    onPluginsChanged(nextPlugins)
    onCatalogChanged(nextCatalog)
  }

  const ensureSelectedDependencies = async (plugin: ModelPlugin) => {
    const optionalFailures: string[] = []
    for (const dependency of recommendedDependencies(plugin)) {
      const dependencyId = getModelBinding(
        modelBindings,
        plugin.id,
        dependency.role,
        dependency.default ? dependency.pluginId : '',
      )
      if (
        dependencyId &&
        !allModels.some(
          (candidate) =>
            candidate.id === dependencyId &&
            candidate.installed,
        )
      ) {
        try {
          await installRecommendedModelDependency(dependencyId)
        } catch (error) {
          if (!dependency.optional) throw error
          optionalFailures.push(dependency.label)
        }
      }
    }
    return optionalFailures
  }

  const optionalDependencyNotice = (failures: string[]) => {
    const labels = [...new Set(failures)]
    return labels.length
      ? `；可选组件“${labels.join('、')}”未安装，不影响模型运行`
      : ''
  }

  const enqueueCatalogInstall = (plugin: ModelPlugin) => {
    if (
      plugin.installed ||
      plugin.installable === false ||
      installJobsRef.current[plugin.id]
    ) {
      return
    }

    const job: CatalogInstallJob = {
      pluginId: plugin.id,
      variantId: variantIdFor(plugin),
      name: plugin.name,
    }
    installJobsRef.current[job.pluginId] = job
    setInstallJobs((current) => ({ ...current, [job.pluginId]: 'queued' }))

    const run = installChainRef.current.then(async () => {
      if (
        !installJobsRef.current[job.pluginId] ||
        canceledInstallIdsRef.current.has(job.pluginId)
      ) {
        delete installJobsRef.current[job.pluginId]
        canceledInstallIdsRef.current.delete(job.pluginId)
        return
      }
      setInstallJobs((current) => ({ ...current, [job.pluginId]: 'running' }))
      setBusyId(job.pluginId)
      setInstallProgress(2)
      setInstallStage('preparing')
      setInstallSpeed('')
      installProgressScopeRef.current = 'model'
      setInstallDetail('正在准备模型下载')
      try {
        const latestPlugins = await listModelPlugins()
        const latestPlugin = latestPlugins.find(
          (candidate) => candidate.id === job.pluginId,
        )
        if (latestPlugin?.installed) {
          await refreshPlugins()
          setSelectedId(latestPlugin.id)
          setInstallProgress(100)
          onAction(`${job.name} 已安装，跳过重复下载`)
          return
        }

        const installed = await installCatalogModel(
          job.pluginId,
          job.variantId,
        )
        installProgressScopeRef.current = 'dependency'
        const optionalDependencyFailures =
          await ensureSelectedDependencies(installed)
        setInstallProgress(100)
        await refreshPlugins()
        setSelectedId(installed.id)
        onAction(
          `${installed.name} 已安装并注册到 Harness${optionalDependencyNotice(optionalDependencyFailures)}`,
        )
      } catch (error) {
        if (canceledInstallIdsRef.current.has(job.pluginId)) {
          onAction(`${job.name} 下载已取消，已保留断点`)
        } else {
          onAction(
            `安装失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } finally {
        canceledInstallIdsRef.current.delete(job.pluginId)
        setBusyId(null)
        setInstallProgress(0)
        setInstallStage('')
        setInstallSpeed('')
        installProgressScopeRef.current = 'model'
        setInstallDetail('')
        setInstallJobs((current) => {
          const next = { ...current }
          delete next[job.pluginId]
          return next
        })
        delete installJobsRef.current[job.pluginId]
      }
    })

    installChainRef.current = run.catch(() => undefined)
  }

  const toggleInstallPaused = async (pluginId: string) => {
    const current = installJobs[pluginId]
    if (current !== 'running' && current !== 'paused') return
    const paused = current !== 'paused'
    try {
      await setModelDownloadPaused(paused)
      setInstallJobs((jobs) => ({
        ...jobs,
        [pluginId]: paused ? 'paused' : 'running',
      }))
      setInstallDetail(paused ? '下载已暂停' : '正在继续下载')
    } catch (error) {
      onAction(
        `无法${paused ? '暂停' : '继续'}下载：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const cancelInstall = async (pluginId: string) => {
    const current = installJobs[pluginId]
    if (!current) return
    canceledInstallIdsRef.current.add(pluginId)
    if (current === 'queued') {
      setInstallJobs((jobs) => {
        const next = { ...jobs }
        delete next[pluginId]
        return next
      })
      onAction('已取消排队安装')
      return
    }
    setInstallJobs((jobs) => ({ ...jobs, [pluginId]: 'canceling' }))
    setInstallDetail('正在取消下载')
    try {
      await cancelModelDownload()
    } catch (error) {
      onAction(
        `无法取消下载：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const installOrAddPlugin = async (plugin: ModelPlugin) => {
    if (!plugin.installed) {
      if (plugin.catalogManaged) {
        enqueueCatalogInstall(plugin)
      } else if (!busyId) {
        onAction(`${plugin.name} 不是可下载安装的目录模型，请安装 ModelScope 中的对应模型版本`)
      }
      return
    }
    if (plugin.sidebarVisible !== false) return
    if (busyId || Object.keys(installJobsRef.current).length > 0) return
    setBusyId(plugin.id)
    installProgressScopeRef.current = 'dependency'
    setInstallProgress(0)
    setInstallStage('preparing')
    setInstallSpeed('')
    setInstallDetail('正在准备依赖模型')
    try {
      const optionalDependencyFailures =
        await ensureSelectedDependencies(plugin)
      setInstallProgress(100)
      const next = await setModelPluginSidebarVisible(plugin.id, true)
      onPluginsChanged(next)
      onCatalogChanged(await getHarnessCatalog())
      onAction(
        `${plugin.name} 已添加到工作台${optionalDependencyNotice(optionalDependencyFailures)}`,
      )
    } catch (error) {
      onAction(
        `操作失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setBusyId(null)
      setInstallProgress(0)
      setInstallStage('')
      setInstallSpeed('')
      installProgressScopeRef.current = 'model'
      setInstallDetail('')
    }
  }

  const removePlugin = async (plugin: ModelPlugin) => {
    if (plugin.adapter === 'web-audio' || busyId) return
    if (pendingDeleteId !== plugin.id) {
      setPendingDeleteId(plugin.id)
      onAction(`再次点击删除 ${plugin.name}`)
      return
    }
    setPendingDeleteId(null)
    if (isApiPlugin(plugin)) {
      await setCloudModelInstalled(plugin, false)
      return
    }
    setBusyId(plugin.id)
    try {
      const { plugins: next, removal } = await uninstallModelPlugin(plugin.id)
      onPluginsChanged(next)
      if (removal.deleted) onRemoveModelBindings(plugin.id)
      onCatalogChanged(await getHarnessCatalog())
      setSelectedId(
        next.some((candidate) => candidate.id === plugin.id)
          ? plugin.id
          : (next[0]?.id ?? ''),
      )
      onAction(
        removal.retained
          ? `${plugin.name} 已隐藏；共享权重仍被 ${removal.referencedBy.length} 个模型引用`
          : `${plugin.name} 的模型权重已从本机删除`,
      )
    } catch (error) {
      onAction(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="plugins-page">
      <div className="plugin-toolbar">
        <label className="search-field plugin-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索模型、能力或作者"
            aria-label="搜索插件"
          />
        </label>
        <div className="filter-tabs">
          <button
            className={filter === 'all' ? 'active' : ''}
            type="button"
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            className={filter === 'audio' ? 'active' : ''}
            type="button"
            onClick={() => setFilter('audio')}
          >
            音频处理
          </button>
          <button
            className={filter === 'understanding' ? 'active' : ''}
            type="button"
            onClick={() => setFilter('understanding')}
          >
            音频理解
          </button>
          <button
            className={filter === 'text' ? 'active' : ''}
            type="button"
            onClick={() => setFilter('text')}
          >
            文本智能
          </button>
          <button
            className={filter === 'generation' ? 'active' : ''}
            type="button"
            onClick={() => setFilter('generation')}
          >
            音频生成
          </button>
        </div>
        <button
          className="catalog-add-api-model"
          type="button"
          onClick={() => setCustomModelEditorOpen(true)}
        >
          <CirclePlus size={13} />
          添加 API 模型
        </button>
      </div>

      <div className="plugins-workspace">
        <main className="plugin-catalog">
          <div className="catalog-heading">
            <div className="catalog-heading-actions">
              {Object.keys(installJobs).length > 0 && (
                <span className="catalog-install-status">
                  <RefreshCw size={13} />
                  {Object.values(installJobs).filter(
                    (state) => state === 'running',
                  ).length > 0
                    ? '正在安装'
                    : '等待安装'}{' '}
                  · {Object.values(installJobs).length} 个任务
                </span>
              )}
              <div className="runtime-scope" aria-label="按运行方式筛选">
                <button
                  className={runtimeFilter === 'offline' ? 'active' : ''}
                  type="button"
                  aria-pressed={runtimeFilter === 'offline'}
                  title="仅显示离线模型；再次点击恢复全部"
                  onClick={() =>
                    setRuntimeFilter((current) =>
                      current === 'offline' ? 'all' : 'offline',
                    )
                  }
                >
                  <HardDrive size={13} />
                  离线
                </button>
                <i />
                <button
                  className={runtimeFilter === 'api' ? 'active' : ''}
                  type="button"
                  aria-pressed={runtimeFilter === 'api'}
                  title="仅显示云端 API；再次点击恢复全部"
                  onClick={() =>
                    setRuntimeFilter((current) =>
                      current === 'api' ? 'all' : 'api',
                    )
                  }
                >
                  <Wifi size={13} />
                  云端 API
                </button>
              </div>
            </div>
          </div>

          <div className="plugin-list">
            {!filteredPlugins.length && (
              <div className="plugin-empty-category">
                <BrainCircuit size={22} />
                <strong>
                  这个分类暂时没有模型
                </strong>
                <p>
                  尝试切换分类或搜索其他能力。
                </p>
              </div>
            )}
            {filteredPlugins.map((plugin) => {
              const apiPlugin = isApiPlugin(plugin)
              const requiresApiConfig = apiPlugin && !plugin.enabled
              const installState = installJobs[plugin.id]
              const isQueued = installState === 'queued'
              const isCloudBusy = cloudBusyIds.has(plugin.id)
              const isBusy =
                Boolean(installState && installState !== 'queued') ||
                busyId === plugin.id ||
                isCloudBusy
              const canQueueInstall =
                !apiPlugin &&
                !plugin.installed &&
                plugin.catalogManaged === true
              const dependencyReferences = apiPlugin
                ? []
                : referencingModels(plugin.id, allModels, modelBindings)
              const retainedDependency =
                plugin.installed &&
                plugin.sidebarVisible === false &&
                dependencyReferences.length > 0
              const actionDisabled =
                (!plugin.installed &&
                  !apiPlugin &&
                  (!plugin.catalogManaged || plugin.installable === false)) ||
                retainedDependency ||
                isQueued ||
                (!canQueueInstall && !apiPlugin && Boolean(busyId)) ||
                isCloudBusy ||
                (canQueueInstall && anotherOperationBusy)
              return (
                <article
                  key={plugin.id}
                  className={`plugin-row${plugin.id === selectedPlugin?.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(plugin.id)}
                >
                  <div className="plugin-main-copy">
                    <div className="plugin-title-line">
                      <h2>{plugin.name}</h2>
                      <span
                        className={`execution-mode-tag ${apiPlugin ? 'api' : 'offline'}`}
                      >
                        {apiPlugin ? <Wifi size={11} /> : <HardDrive size={11} />}
                        {apiPlugin ? '云端 API' : '离线运行'}
                      </span>
                    </div>
                    <span className="plugin-author">
                      模型：{plugin.author} ·{' '}
                      {displayPluginVersion(plugin, apiPlugin)}
                    </span>
                    <p>{plugin.description}</p>
                    <div className="plugin-capabilities">
                      <span>
                        {plugin.streamingMode === 'streaming'
                          ? '流式'
                          : '整段处理'}
                      </span>
                      {plugin.capabilities.map((capability) => (
                        <span key={capability}>{capability}</span>
                      ))}
                      <span>{plugin.runtime}</span>
                    </div>
                  </div>
                  <div className="plugin-hardware">
                    {!apiPlugin && (
                      <span>
                        {plugin.variants?.find(
                          (variant) => variant.id === variantIdFor(plugin),
                        )?.size ?? plugin.size}
                      </span>
                    )}
                    <div>
                      {plugin.acceleration.slice(0, 3).map((item) => (
                        <small key={item}>{item}</small>
                      ))}
                    </div>
                  </div>
                  <div className="plugin-row-action">
                    {installState ? (
                      <div
                        className={`installing-state ${installState}`}
                        title={installDetail || undefined}
                      >
                        <div className="installing-state-heading">
                          <span>
                            {installState === 'queued'
                              ? '排队中'
                              : installState === 'paused'
                                ? '已暂停'
                                : installState === 'canceling'
                                  ? '正在取消'
                                  : compactInstallProgress}
                          </span>
                          <span className="install-task-actions">
                            {(installState === 'running' ||
                              installState === 'paused') && (
                              <button
                                type="button"
                                title={installState === 'paused' ? '继续下载' : '暂停下载'}
                                aria-label={installState === 'paused' ? '继续下载' : '暂停下载'}
                                disabled={
                                  installState === 'running' &&
                                  installStage !== 'downloading'
                                }
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void toggleInstallPaused(plugin.id)
                                }}
                              >
                                {installState === 'paused' ? (
                                  <Play size={12} />
                                ) : (
                                  <Pause size={12} />
                                )}
                              </button>
                            )}
                            {installState !== 'canceling' && (
                              <button
                                type="button"
                                title="取消下载"
                                aria-label="取消下载"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void cancelInstall(plugin.id)
                                }}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </span>
                        </div>
                        <i>
                          <b
                            style={{
                              width: `${isQueued ? 0 : installProgress}%`,
                            }}
                          />
                        </i>
                      </div>
                    ) : isBusy ? (
                      <div className="installing-state">
                        <span>{installDetail || '处理中'}</span>
                      </div>
                    ) : (
                      <button
                        className={
                          plugin.installed
                            ? `installed-button${retainedDependency ? ' retained-dependency' : ''}${pendingDeleteId === plugin.id ? ' confirming-delete' : ''}`
                            : 'install-button'
                        }
                        type="button"
                        title={
                          retainedDependency
                            ? `仍被 ${dependencyReferences.length} 个模型使用`
                            : undefined
                        }
                        disabled={actionDisabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (apiPlugin) {
                            if (requiresApiConfig) {
                              onConfigureProvider(plugin.providerId ?? '')
                            } else if (plugin.installed) {
                              void removePlugin(plugin)
                            } else {
                              void setCloudModelInstalled(plugin, true)
                            }
                            return
                          }
                          if (plugin.installed) {
                            void removePlugin(plugin)
                          } else {
                            void installOrAddPlugin(plugin)
                          }
                        }}
                      >
                        {retainedDependency ? (
                          <>
                            <PackageCheck size={15} />
                            依赖中
                          </>
                        ) : apiPlugin ? (
                          <>
                            {requiresApiConfig ? (
                              <KeyRound size={15} />
                            ) : plugin.installed ? (
                              <Trash2 size={15} />
                            ) : (
                              <CirclePlus size={15} />
                            )}
                            {requiresApiConfig
                              ? '配置'
                              : plugin.installed
                                ? '删除'
                                : '添加'}
                          </>
                        ) : plugin.installed ? (
                          <>
                            <Trash2 size={15} />
                            删除
                          </>
                        ) : (
                          <>
                            <Download size={15} />{' '}
                            {plugin.installable === false
                              ? '适配中'
                              : plugin.catalogManaged
                                ? '安装'
                                : '仅兼容'}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>

        </main>

        <aside className="plugin-details">
          {selectedPlugin && (
            <>
              <div className="plugin-details-heading">
                <div>
                  <h2>{selectedPlugin.name}</h2>
                  <small>
                    {displayPluginVersion(selectedPlugin, selectedIsApi)}{' '}
                    · {selectedPlugin.author}
                  </small>
                </div>
              </div>

              {!selectedIsApi &&
                !selectedPlugin.installed &&
                Boolean(selectedPlugin.variants?.length) && (
                  <label className="plugin-variant-field">
                    <span>模型精度</span>
                    <select
                      value={variantIdFor(selectedPlugin)}
                      disabled={Boolean(busyId)}
                      onChange={(event) =>
                        setSelectedVariants((current) => ({
                          ...current,
                          [selectedPlugin.id]: event.target.value,
                        }))
                      }
                    >
                      {selectedPlugin.variants?.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.precision} · {variant.name} · {variant.size}
                        </option>
                      ))}
                    </select>
                    {selectedVariant?.precision.toLowerCase() === 'int8' && (
                      <small>默认版本，体积更小，适合大多数设备</small>
                    )}
                  </label>
                )}

              <div
                className={`plugin-execution-banner ${
                  isApiPlugin(selectedPlugin) ? 'api' : 'offline'
                }`}
              >
                {isApiPlugin(selectedPlugin) ? (
                  <Wifi size={17} />
                ) : (
                  <HardDrive size={17} />
                )}
                <span>
                  <strong>
                    {isApiPlugin(selectedPlugin) ? '云端 API' : '离线运行'}
                  </strong>
                  <small>
                    {isApiPlugin(selectedPlugin)
                      ? selectedPlugin.enabled
                        ? '添加到工作台即可使用'
                        : '先配置 Provider，再添加到工作台'
                      : '模型权重保存在本机，音频无需上传到云端'}
                  </small>
                </span>
              </div>

              {(selectedIsApi ||
                  !selectedPlugin.installed ||
                  selectedPlugin.sidebarVisible === false ||
                  selectedInstallState !== undefined) && (
                <div className="plugin-detail-actions">
                  <button
                    className="secondary-action full-width"
                    type="button"
                    disabled={
                      (!selectedPlugin.installed &&
                        !selectedIsApi &&
                        (!selectedPlugin.catalogManaged ||
                          selectedPlugin.installable === false)) ||
                      selectedInstallState !== undefined ||
                      (!selectedCanQueueInstall &&
                        !selectedIsApi &&
                        Boolean(busyId)) ||
                      selectedCloudBusy ||
                      (selectedCanQueueInstall && anotherOperationBusy)
                    }
                    onClick={() =>
                      selectedIsApi
                        ? selectedPlugin.installed || !selectedPlugin.enabled
                          ? onConfigureProvider(
                              selectedPlugin.providerId ?? '',
                            )
                          : void setCloudModelInstalled(selectedPlugin, true)
                        : void installOrAddPlugin(selectedPlugin)
                    }
                  >
                  {selectedInstallState === 'queued' ? (
                    <>
                      <RefreshCw size={16} />
                      排队中
                    </>
                  ) : selectedInstallState === 'paused' ? (
                    <>
                      <Pause size={16} />
                      下载已暂停
                    </>
                  ) : selectedInstallState === 'canceling' ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      正在取消
                    </>
                  ) : selectedInstallState === 'running' ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      下载中 {compactInstallProgress}
                    </>
                  ) : selectedCloudBusy ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      处理中
                    </>
                  ) : selectedIsApi ? (
                    <>
                      {selectedPlugin.installed || !selectedPlugin.enabled ? (
                        <KeyRound size={16} />
                      ) : (
                        <CirclePlus size={16} />
                      )}
                      {selectedPlugin.installed
                        ? '管理 API 配置'
                        : selectedPlugin.enabled
                          ? '添加到工作台'
                          : '配置 Provider'}
                    </>
                  ) : selectedPlugin.installed ? (
                    <>
                      <CirclePlus size={16} />
                      添加到工作台
                    </>
                  ) : (
                    <>
                      <Download size={16} />{' '}
                      {selectedPlugin.installable === false
                        ? '运行适配中'
                        : selectedPlugin.catalogManaged
                          ? '安装模型'
                          : '仅兼容已安装模型'}
                    </>
                  )}
                  </button>
                {selectedInstallState && (
                  <div className="selected-install-actions">
                    {(selectedInstallState === 'running' ||
                      selectedInstallState === 'paused') && (
                      <button
                        className="icon-button"
                        type="button"
                        title={
                          selectedInstallState === 'paused'
                            ? '继续下载'
                            : '暂停下载'
                        }
                        aria-label={
                          selectedInstallState === 'paused'
                            ? '继续下载'
                            : '暂停下载'
                        }
                        disabled={
                          selectedInstallState === 'running' &&
                          installStage !== 'downloading'
                        }
                        onClick={() =>
                          void toggleInstallPaused(selectedPlugin.id)
                        }
                      >
                        {selectedInstallState === 'paused' ? (
                          <Play size={15} />
                        ) : (
                          <Pause size={15} />
                        )}
                      </button>
                    )}
                    {selectedInstallState !== 'canceling' && (
                      <button
                        className="icon-button danger"
                        type="button"
                        title="取消下载"
                        aria-label="取消下载"
                        onClick={() => void cancelInstall(selectedPlugin.id)}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                )}
                </div>
              )}

              <section className="model-introduction-card">
                <header>
                  <strong>模型介绍</strong>
                </header>
                <div className="model-introduction-body">
                  <p>{selectedPlugin.description}</p>
                  <div className="plugin-capabilities">
                    {selectedPlugin.capabilities.map((capability) => (
                      <span key={capability}>{capability}</span>
                    ))}
                  </div>
                </div>
              </section>

              {selectedDependencies.length > 0 && (
                <section className="runtime-card model-dependencies-card">
                  <header>
                    <PackageCheck size={14} />
                    <strong>配套组件</strong>
                  </header>
                  <div className="model-dependencies-body">
                    {selectedDependencies.map((dependency) => {
                      const candidates = allModels.filter(
                        (candidate) =>
                          candidate.installed &&
                          candidate.harnessCapabilities.includes(
                            dependency.capability,
                          ) &&
                          (dependency.role !== 'reference-transcription' ||
                            candidate.streamingMode !== 'streaming'),
                      )
                      const selectedDependencyId = getModelBinding(
                        modelBindings,
                        selectedPlugin.id,
                        dependency.role,
                        dependency.default ? dependency.pluginId : '',
                      )
                      return (
                        <label key={dependency.role}>
                          <span>{dependency.label}</span>
                          <select
                            value={selectedDependencyId}
                            onChange={(event) => {
                              const dependencyId = event.target.value
                              onModelBindingsChanged({
                                ...modelBindings,
                                [selectedPlugin.id]: {
                                  ...modelBindings[selectedPlugin.id],
                                  [dependency.role]: dependencyId,
                                },
                              })
                              void onSetModelBinding(
                                selectedPlugin.id,
                                dependency.role,
                                dependencyId,
                              ).catch((error) => {
                                onModelBindingsChanged(modelBindings)
                                onAction(
                                  `无法保存配套组件：${error instanceof Error ? error.message : String(error)}`,
                                )
                              })
                              setBindingRevision((value) => value + 1)
                            }}
                          >
                            {dependency.optional && <option value="">无</option>}
                            {candidates.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.name}
                              </option>
                            ))}
                            {!candidates.some(
                              (candidate) => candidate.id === dependency.pluginId,
                            ) && (
                              <option value={dependency.pluginId}>
                                {allModels.find(
                                  (candidate) =>
                                    candidate.id === dependency.pluginId,
                                )?.name ?? dependency.pluginId}{' '}
                                · 安装时尝试下载
                              </option>
                            )}
                          </select>
                        </label>
                      )
                    })}
                    {!selectedPlugin.installed && (
                      <small>
                        默认随模型尝试安装；可选组件失败不影响模型运行，之后也可在这里替换。
                      </small>
                    )}
                  </div>
                </section>
              )}

              <section className="runtime-card">
                <header>
                  <span
                    className={`status-dot${selectedIsApi && !selectedPlugin.enabled ? ' pending' : ''}`}
                  />
                  <strong>运行环境</strong>
                  <small>
                    {selectedIsApi
                      ? selectedPlugin.enabled
                        ? '配置就绪'
                        : selectedPlugin.providerId === 'api.bailian'
                          ? '待配置 AK'
                          : '待配置 Provider'
                      : '运行正常'}
                  </small>
                </header>
                <dl>
                  <div>
                    <dt>
                      {selectedIsApi ? (
                        <Wifi size={14} />
                      ) : (
                        <TerminalSquare size={14} />
                      )}
                      {selectedIsApi ? '服务商' : 'Runtime'}
                    </dt>
                    <dd>
                      {selectedIsApi
                        ? selectedPlugin.author
                        : selectedPlugin.runtime}
                    </dd>
                  </div>
                  {!selectedIsApi && (
                    <div>
                      <dt>
                        <Boxes size={14} /> 引擎作者
                      </dt>
                      <dd>{selectedPlugin.engineAuthor ?? selectedPlugin.runtime}</dd>
                    </div>
                  )}
                  {!selectedIsApi && (
                    <div>
                      <dt>
                        <Boxes size={14} /> 核心
                      </dt>
                      <dd>{runtime.backend}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      {selectedIsApi ? (
                        <TerminalSquare size={14} />
                      ) : (
                        <HardDrive size={14} />
                      )}
                      {selectedIsApi ? '模型 ID' : '模型大小'}
                    </dt>
                    <dd>
                      {selectedIsApi
                        ? selectedPlugin.version
                        : selectedVariant?.size ?? selectedPlugin.size}
                    </dd>
                  </div>
                  {selectedIsApi &&
                    (selectedPlugin.apiAliases?.length ?? 0) > 0 && (
                      <div>
                        <dt>
                          <TerminalSquare size={14} /> 兼容别名
                        </dt>
                        <dd>{selectedPlugin.apiAliases?.join(' / ')}</dd>
                      </div>
                    )}
                  {selectedPlugin.license && (
                    <div>
                      <dt>许可证</dt>
                      <dd>{selectedPlugin.license}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      <Cpu size={14} /> 设备
                    </dt>
                    <dd>{selectedIsApi ? '云端执行' : runtime.device}</dd>
                  </div>
                  {!selectedIsApi && (
                    <div>
                      <dt>
                        <Gauge size={14} /> 加速
                      </dt>
                      <dd>{selectedPlugin.acceleration.join(' / ')}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      <Waves size={14} /> API
                    </dt>
                    <dd>{runtime.apiUrl}</dd>
                  </div>
                </dl>
              </section>
            </>
          )}
        </aside>
      </div>

      {customModelEditorOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCustomModelEditorOpen(false)
            }
          }}
        >
          <section
            className="custom-model-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-model-title"
          >
            <div className="dialog-heading">
              <div>
                <span className="section-kicker">API MODEL</span>
                <h2 id="custom-model-title">添加自定义 API 模型</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setCustomModelEditorOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="custom-model-form">
              <label>
                <span>Provider</span>
                <select value={customModelProviderId} onChange={(event) => {
                  const providerId = event.target.value
                  const provider = customProviders.find(({ id }) => id === providerId)
                  const nextCapability = provider?.capabilities.includes(customModelCapability)
                    ? customModelCapability
                    : (provider?.capabilities[0] as CustomApiModelDefinition['capability'] | undefined)
                  setCustomModelProviderId(providerId)
                  if (nextCapability) setCustomModelCapability(nextCapability)
                }}>
                  {customProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
                <small>连接信息在“设置 → Provider”中统一管理。</small>
              </label>
              <label>
                <span>模型名称</span>
                <input
                  value={customModelName}
                  placeholder="留空则使用 Model ID"
                  onChange={(event) => setCustomModelName(event.target.value)}
                />
              </label>
              <label>
                <span>模型类型</span>
                <select
                  value={customModelCapability}
                  onChange={(event) =>
                    setCustomModelCapability(
                      event.target.value as CustomApiModelDefinition['capability'],
                    )
                  }
                >
                  {customCapabilityOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Model ID</span>
                <input
                  value={customModelServiceId}
                  placeholder={
                    customModelCapability === 'speech.transcribe'
                      ? '例如 gpt-4o-mini-transcribe 或 whisper-1'
                      : customModelCapability === 'speech.synthesize'
                        ? '例如 gpt-4o-mini-tts 或 tts-1'
                        : '例如 qwen3:8b 或 gpt-4o-mini'
                  }
                  onChange={(event) =>
                    setCustomModelServiceId(event.target.value)
                  }
                />
              </label>
              {customModelCapability === 'speech.synthesize' && (
                <label>
                  <span>默认音色</span>
                  <input
                    value={customModelVoice}
                    placeholder="例如 alloy"
                    onChange={(event) => setCustomModelVoice(event.target.value)}
                  />
                  <small>使用时仍可在对话窗口临时切换音色。</small>
                </label>
              )}
              <div className="custom-model-actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() =>
                    onConfigureProvider(customModelProviderId)
                  }
                >
                  <KeyRound size={15} />
                  配置 Provider
                </button>
                <button
                  className="primary-action"
                  type="button"
                  onClick={addCustomApiModel}
                >
                  <CirclePlus size={15} />
                  添加模型
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

    </div>
  )
}
