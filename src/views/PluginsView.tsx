import { t, useLocale, getLocale } from "../i18n"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { open } from '@tauri-apps/plugin-dialog'
import { AgentProjectCard } from '../components/AgentProjectCard'
import { isWorkspaceAgent } from '../appAgents'
import Markdown from 'react-markdown'
import { listen } from '@tauri-apps/api/event'
import {
  Boxes,
  BrainCircuit,
  ChevronRight,
  CirclePlus,
  Cpu,
  Download,
  FileText,
  Gauge,
  HardDrive,
  EyeOff,
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
  getModelPluginFiles,
  getModelPluginReadme,
  installCatalogModel,
  installAgentProject,
  installRecommendedModelDependency,
  isTauriRuntime,
  listModelPlugins,
  cancelModelDownload,
  setModelPluginSidebarVisible,
  setModelDownloadPaused,
  uninstallModelPlugin,
  type ModelPluginFileEntry,
} from '../services/harness'
import {
  getModelBinding,
  referencingModels,
  recommendedDependencies,
} from '../modelDependencies'
import { cloudModelsFromCatalog } from '../cloudModels'
import { getModelNote } from '../content/modelNotes'
import { formatFileSize } from '../utils/audio'
import {
  MODEL_PRIMARY_CATEGORIES,
  modelTaxonomy,
  type ModelPrimaryCategory,
} from '../domain/modelTaxonomy'
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
  catalogKind?: 'skills' | 'models'
  plugins: ModelPlugin[]
  modelBindings: ModelDependencyBindings
  runtime: RuntimeStatus
  catalog: HarnessCatalog | null
  apiModelCatalog: ApiModelCatalogEntry[]
  customApiModels: CustomApiModelDefinition[]
  appAgents: ModelPlugin[]
  installedCloudModelIds: string[]
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
  onAppAgentInstalled: (agentId: string, installed: boolean) => void
  onAction: (message: string) => void
  /** When set, the category tree renders into this element (the app sidebar). */
  taxonomyHost?: HTMLElement | null
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

function displayPluginName(plugin: ModelPlugin): string {
  return isWorkspaceAgent(plugin) ? t(plugin.name) : plugin.name
}

function compareCatalogModels(left: ModelPlugin, right: ModelPlugin): number {
  return left.name.localeCompare(right.name, getLocale(), {
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
  catalogKind = 'models',
  plugins,
  modelBindings,
  runtime,
  catalog,
  apiModelCatalog,
  customApiModels,
  appAgents,
  installedCloudModelIds,
  onConfigureProvider,
  onPluginsChanged,
  onModelBindingsChanged,
  onRemoveModelBindings,
  onSetModelBinding,
  onCatalogChanged,
  onCloudModelInstalled,
  onAppAgentInstalled,
  onAction,
  taxonomyHost,
}: PluginsViewProps) {
  const locale = useLocale()
  const skillsCatalog = catalogKind === 'skills'

  const [importingAgent, setImportingAgent] = useState(false)
  const importAgent = async (directory = true) => {
    if (!isTauriRuntime()) {
      onAction(t("请在桌面端导入技能项目"))
      return
    }
    setImportingAgent(true)
    try {
      const path = await open({
        title: directory ? t("选择包含 agent.json 的技能项目文件夹") : t("导入技能安装包"),
        multiple: false,
        directory,
        ...(directory ? {} : { filters: [{ name: t("技能安装包"), extensions: ['zip', 'cspkg'] }] }),
      })
      if (!path) return
      const installed = await installAgentProject(path)
      const [nextPlugins, nextCatalog] = await Promise.all([listModelPlugins(), getHarnessCatalog()])
      onPluginsChanged(nextPlugins)
      onCatalogChanged(nextCatalog)
      setSearch('')
      setPrimaryFilter('all')
      setSecondaryFilter('all')
      setRuntimeFilter('all')
      setSelectedId(installed.id)
      onAction(t("{0} 已安装", [installed.name]))
    } catch (error) {
      onAction(t("技能导入失败：{0}", [error instanceof Error ? error.message : String(error)]))
    } finally {
      setImportingAgent(false)
    }
  }
  const [search, setSearch] = useState('')
  const [primaryFilter, setPrimaryFilter] = useState<
    'all' | ModelPrimaryCategory
  >('all')
  const [secondaryFilter, setSecondaryFilter] = useState('all')
  const [runtimeFilter, setRuntimeFilter] = useState<
    'all' | 'offline' | 'api'
  >('all')
  const [selectedId, setSelectedId] = useState(
    '',
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [detailsWidth, setDetailsWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('plugins-details-width'))
      return Number.isFinite(saved) && saved >= 380 ? saved : 0
    } catch {
      return 0
    }
  })
  const [resizingDetails, setResizingDetails] = useState(false)

  const startDetailsResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    setResizingDetails(true)
    const onMove = (ev: PointerEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.round(rect.right - ev.clientX - 3)
      setDetailsWidth(
        Math.min(Math.max(width, 380), Math.round(rect.width) - 340),
      )
    }
    const onUp = () => {
      setResizingDetails(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDetailsWidth((width) => {
        if (width) {
          try {
            localStorage.setItem('plugins-details-width', String(width))
          } catch {
            /* ignore */
          }
        }
        return width
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
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
  const [selectedReadme, setSelectedReadme] = useState<string | null>(null)
  const [detailsTab, setDetailsTab] = useState<'card' | 'files'>('card')
  const [selectedFiles, setSelectedFiles] = useState<
    ModelPluginFileEntry[] | null
  >(null)
  const desktopRuntime = isTauriRuntime()
  const installProgressLabel = `${Math.round(installProgress)}%`
  const compactInstallProgress = installSpeed
    ? `${installProgressLabel} · ${installSpeed}`
    : installProgressLabel

  useEffect(() => {
    setPrimaryFilter('all')
    setSecondaryFilter('all')
    setRuntimeFilter('all')
  }, [skillsCatalog])

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
    () =>
      skillsCatalog
        ? [...appAgents]
        : [...plugins, ...cloudModels].sort(compareCatalogModels),
    [appAgents, cloudModels, plugins, skillsCatalog],
  )
  const taxonomyByModelId = useMemo(
    () =>
      new Map(
        allModels.map((model) => [model.id, modelTaxonomy(model)] as const),
      ),
    [allModels],
  )
  const categoryTree = useMemo(
    () =>
      MODEL_PRIMARY_CATEGORIES.map((category) => {
        const categoryModels = allModels.filter(
          (model) =>
            taxonomyByModelId.get(model.id)?.primaryCategory === category.id,
        )
        const secondaryCounts = new Map<string, number>()
        if (category.id !== 'agents') {
          for (const model of categoryModels) {
            const secondaryCategory =
              taxonomyByModelId.get(model.id)?.secondaryCategory
            if (!secondaryCategory) continue
            secondaryCounts.set(
              secondaryCategory,
              (secondaryCounts.get(secondaryCategory) ?? 0) + 1,
            )
          }
        }
        return {
          ...category,
          count: categoryModels.length,
          secondary: [...secondaryCounts.entries()]
            .map(([id, count]) => ({ id, count }))
            .sort((left, right) => left.id.localeCompare(right.id, 'en')),
        }
      }),
    [allModels, taxonomyByModelId],
  )
  const activeCategory =
    primaryFilter === 'all'
      ? undefined
      : categoryTree.find((category) => category.id === primaryFilter)

  useEffect(() => {
    if (!pendingDeleteId) return undefined
    const timer = window.setTimeout(() => setPendingDeleteId(null), 3200)
    return () => window.clearTimeout(timer)
  }, [pendingDeleteId])


  useEffect(() => {
    if (
      secondaryFilter !== 'all' &&
      !activeCategory?.secondary.some(
        (category) => category.id === secondaryFilter,
      )
    ) {
      setSecondaryFilter('all')
    }
  }, [activeCategory, secondaryFilter])

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
          t(plugin.name, [], locale).toLowerCase().includes(search.toLowerCase()) ||
          plugin.description.toLowerCase().includes(search.toLowerCase()) ||
          t(plugin.description, [], locale).toLowerCase().includes(search.toLowerCase()) ||
          plugin.version.toLowerCase().includes(search.toLowerCase()) ||
          (plugin.apiAliases ?? []).some((alias) =>
            alias.toLowerCase().includes(search.toLowerCase()),
          )
        const taxonomy = taxonomyByModelId.get(plugin.id)
        const filterMatch =
          skillsCatalog ||
          primaryFilter === 'all' ||
          (taxonomy?.primaryCategory === primaryFilter &&
            (secondaryFilter === 'all' ||
              taxonomy.secondaryCategory === secondaryFilter))
        const apiPlugin = isApiPlugin(plugin)
        const runtimeMatch =
          skillsCatalog ||
          runtimeFilter === 'all' ||
          (runtimeFilter === 'api' && apiPlugin) ||
          (runtimeFilter === 'offline' && !apiPlugin)
        return searchMatch && filterMatch && runtimeMatch
      }),
    [
      locale,
      allModels,
      primaryFilter,
      runtimeFilter,
      search,
      secondaryFilter,
      skillsCatalog,
      taxonomyByModelId,
    ],
  )
  const selectedPlugin =
    filteredPlugins.find((plugin) => plugin.id === selectedId) ??
    filteredPlugins[0]
  const selectedIsApi = selectedPlugin
    ? isApiPlugin(selectedPlugin)
    : false
  const selectedIsAppAgent = selectedPlugin
    ? isWorkspaceAgent(selectedPlugin)
    : false
  const selectedNote = selectedPlugin
    ? getModelNote(selectedPlugin.id)
    : undefined
  const selectedPluginId = selectedPlugin?.id
  useEffect(() => {
    let cancelled = false
    if (!selectedPluginId || !isTauriRuntime() || selectedIsAppAgent) {
      setSelectedReadme(null)
      return undefined
    }
    setSelectedReadme(null)
    getModelPluginReadme(selectedPluginId)
      .then((readme) => {
        if (!cancelled) setSelectedReadme(readme)
      })
      .catch(() => {
        if (!cancelled) setSelectedReadme(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedIsAppAgent, selectedPluginId])
  const selectedHasFiles = Boolean(
    selectedPlugin &&
      !selectedIsApi &&
      !selectedIsAppAgent &&
      selectedPlugin.installed &&
      isTauriRuntime(),
  )
  useEffect(() => {
    let cancelled = false
    setDetailsTab('card')
    setSelectedFiles(null)
    if (!selectedPluginId || !isTauriRuntime() || !selectedHasFiles) {
      return () => {
        cancelled = true
      }
    }
    getModelPluginFiles(selectedPluginId)
      .then((files) => {
        if (!cancelled) setSelectedFiles(files)
      })
      .catch(() => {
        if (!cancelled) setSelectedFiles(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPluginId, selectedHasFiles])
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
      !selectedIsAppAgent &&
      !selectedIsApi &&
      !selectedPlugin.installed &&
      selectedPlugin.catalogManaged,
  )
  const selectedCloudBusy = Boolean(
    selectedPlugin && selectedIsApi && cloudBusyIds.has(selectedPlugin.id),
  )
  const selectedDependencyReferences =
    selectedPlugin && !selectedIsApi
      ? referencingModels(selectedPlugin.id, allModels, modelBindings)
      : []
  const selectedRetainedDependency = Boolean(
    selectedPlugin?.installed &&
      selectedPlugin.sidebarVisible === false &&
      selectedDependencyReferences.length > 0,
  )
  const anotherOperationBusy = importingAgent || Boolean(
    busyId && !installJobsRef.current[busyId],
  )

  useEffect(() => {
    if (!filteredPlugins.length) {
      if (selectedId) setSelectedId('')
      return
    }
    if (!filteredPlugins.some((plugin) => plugin.id === selectedId)) {
      setSelectedId(filteredPlugins[0].id)
    }
  }, [filteredPlugins, selectedId])

  const variantIdFor = (plugin: ModelPlugin) =>
    selectedVariants[plugin.id] ??
    plugin.selectedVariantId ??
    plugin.defaultVariantId


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
        setInstallDetail(t("正在准备依赖模型"))
        installProgressScopeRef.current = 'dependency'
        optionalDependencyFailures = await ensureSelectedDependencies(plugin)
        setInstallProgress(100)
      }
      onCloudModelInstalled(plugin.id, installed)
      await refreshPlugins()
      onAction(
        installed
          ? t("{0} 已添加到工作台{1}", [plugin.name, optionalDependencyNotice(optionalDependencyFailures)])
          : t("{0} 已从工作台移除", [plugin.name]),
      )
    } catch (error) {
      onAction(
        t("操作失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
        allModels,
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
      ? t("；可选组件“{0}”未安装，不影响模型运行", [labels.join('、')])
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
      setInstallDetail(t("正在准备模型下载"))
      try {
        const latestPlugins = await listModelPlugins()
        const latestPlugin = latestPlugins.find(
          (candidate) => candidate.id === job.pluginId,
        )
        if (latestPlugin?.installed) {
          await refreshPlugins()
          setSelectedId(latestPlugin.id)
          setInstallProgress(100)
          onAction(t("{0} 已安装，跳过重复下载", [job.name]))
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
          t("{0} 已安装并注册到 Harness{1}", [installed.name, optionalDependencyNotice(optionalDependencyFailures)]),
        )
      } catch (error) {
        if (canceledInstallIdsRef.current.has(job.pluginId)) {
          onAction(t("{0} 下载已取消，已保留断点", [job.name]))
        } else {
          onAction(
            t("安装失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
      setInstallDetail(paused ? t("下载已暂停") : t("正在继续下载"))
    } catch (error) {
      onAction(
        t("无法{0}下载：{1}", [paused ? t("暂停") : t("继续"), error instanceof Error ? error.message : String(error)]),
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
      onAction(t("已取消排队安装"))
      return
    }
    setInstallJobs((jobs) => ({ ...jobs, [pluginId]: 'canceling' }))
    setInstallDetail(t("正在取消下载"))
    try {
      await cancelModelDownload()
    } catch (error) {
      onAction(
        t("无法取消下载：{0}", [error instanceof Error ? error.message : String(error)]),
      )
    }
  }

  const installOrAddPlugin = async (plugin: ModelPlugin) => {
    if (isWorkspaceAgent(plugin)) {
      if (!plugin.installed) {
        onAppAgentInstalled(plugin.id, true)
        onAction(t('{0} 已安装并添加到工作台', [displayPluginName(plugin)]))
      }
      return
    }
    if (!plugin.installed) {
      if (plugin.catalogManaged) {
        enqueueCatalogInstall(plugin)
      } else if (!busyId) {
        onAction(t("{0} 不是可下载安装的目录模型，请安装 ModelScope 中的对应模型版本", [plugin.name]))
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
    setInstallDetail(t("正在准备依赖模型"))
    try {
      const optionalDependencyFailures =
        await ensureSelectedDependencies(plugin)
      setInstallProgress(100)
      const next = await setModelPluginSidebarVisible(plugin.id, true)
      onPluginsChanged(next)
      onCatalogChanged(await getHarnessCatalog())
      onAction(
        t("{0} 已添加到工作台{1}", [plugin.name, optionalDependencyNotice(optionalDependencyFailures)]),
      )
    } catch (error) {
      onAction(
        t("操作失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
      onAction(
        isWorkspaceAgent(plugin)
          ? t("再次点击隐藏 {0}", [displayPluginName(plugin)])
          : t("再次点击删除 {0}", [plugin.name]),
      )
      return
    }
    setPendingDeleteId(null)
    if (isWorkspaceAgent(plugin)) {
      onAppAgentInstalled(plugin.id, false)
      onAction(t('{0} 已隐藏', [displayPluginName(plugin)]))
      return
    }
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
          ? t("{0} 已隐藏；共享权重仍被 {1} 个模型引用", [plugin.name, removal.referencedBy.length])
          : t("{0} 的模型权重已从本机删除", [plugin.name]),
      )
    } catch (error) {
      onAction(
        t("删除失败：{0}", [error instanceof Error ? error.message : String(error)]),
      )
    } finally {
      setBusyId(null)
    }
  }

  const taxonomy = skillsCatalog ? null : (
    <aside
      className="catalog-taxonomy"
      aria-label={t("模型分类")}
    >
      <div className="taxonomy-heading">
        <span>{t("模型分类")}</span>
        <small>{allModels.length}</small>
      </div>
      <nav className="taxonomy-tree" role="tree">
          <button
            className={`taxonomy-all${primaryFilter === 'all' ? ' active' : ''}`}
            type="button"
            role="treeitem"
            aria-current={primaryFilter === 'all' ? 'page' : undefined}
            onClick={() => {
              setPrimaryFilter('all')
              setSecondaryFilter('all')
            }}
          >
            <span>{t("全部模型")}</span>
            <small>{allModels.length}</small>
          </button>
          {categoryTree.filter((category) => category.id !== 'agents').map((category) => {
            const expanded = primaryFilter === category.id
            return (
              <div
                key={category.id}
                className={`taxonomy-branch${expanded ? ' expanded' : ''}`}
              >
                <button
                  className="taxonomy-primary"
                  type="button"
                  role="treeitem"
                  aria-expanded={expanded && category.secondary.length > 0}
                  aria-current={expanded ? 'page' : undefined}
                  onClick={() => {
                    setPrimaryFilter(category.id)
                    setSecondaryFilter('all')
                  }}
                >
                  <ChevronRight size={13} />
                  <span>{category.label}</span>
                  <small>{category.count}</small>
                </button>
                {expanded && category.secondary.length > 0 && (
                  <div className="taxonomy-secondary-group" role="group">
                    <button
                      className={secondaryFilter === 'all' ? 'active' : ''}
                      type="button"
                      role="treeitem"
                      aria-current={
                        secondaryFilter === 'all' ? 'page' : undefined
                      }
                      onClick={() => setSecondaryFilter('all')}
                    >
                      <span>{t("全部")}</span>
                      <small>{category.count}</small>
                    </button>
                    {category.secondary.map((secondary) => (
                      <button
                        key={secondary.id}
                        className={
                          secondaryFilter === secondary.id ? 'active' : ''
                        }
                        type="button"
                        role="treeitem"
                        title={secondary.id}
                        aria-current={
                          secondaryFilter === secondary.id ? 'page' : undefined
                        }
                        onClick={() => setSecondaryFilter(secondary.id)}
                      >
                        <span>{secondary.id}</span>
                        <small>{secondary.count}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
      </nav>
    </aside>
  )

  return (
    <div
      className={`plugins-page${taxonomyHost ? ' embedded' : ''}${
        skillsCatalog ? ' skills-catalog' : ''
      }`}
    >
      {taxonomy && (taxonomyHost ? createPortal(taxonomy, taxonomyHost) : taxonomy)}

      <div
        ref={workspaceRef}
        className="plugins-workspace"
        style={
          detailsWidth
            ? ({ '--plugins-details-w': `${detailsWidth}px` } as CSSProperties)
            : undefined
        }
      >
        <main className="plugin-catalog">
          <div className="agent-catalog-heading">
            <div>
              <h1>{skillsCatalog ? t("技能") : t("模型商店")}</h1>
              <p>
                {skillsCatalog
                  ? t("面向任务的音频工作流，可调用已安装模型完成创作。")
                  : t("识别、合成、降噪、声纹和云端 API，组成技能可调用的基础能力。")}
              </p>
            </div>
            {skillsCatalog && (
              <div className="agent-import-actions">
                <button type="button" className="secondary-action" onClick={() => void importAgent()}
                  disabled={importingAgent || Boolean(busyId) || Object.keys(installJobs).length > 0}>
                  {importingAgent ? <RefreshCw size={15} className="model-spin" /> : <CirclePlus size={15} />}
                  {importingAgent ? t("正在导入") : t("导入技能")}
                </button>
                <button type="button" className="icon-button" title={t("导入 ZIP 安装包")} aria-label={t("导入 ZIP 安装包")}
                  onClick={() => void importAgent(false)}
                  disabled={importingAgent || Boolean(busyId) || Object.keys(installJobs).length > 0}>
                  <Boxes size={17} />
                </button>
              </div>
            )}
          </div>
          <div className="plugin-catalog-head">
            <label className="search-field plugin-search">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={skillsCatalog ? t("搜索技能、能力或作者") : t("搜索模型、能力或作者")}
                aria-label={skillsCatalog ? t("搜索技能") : t("搜索模型")}
              />
            </label>
            {Object.keys(installJobs).length > 0 && (
                <span className="catalog-install-status">
                  <RefreshCw size={13} />
                  {Object.values(installJobs).filter(
                    (state) => state === 'running',
                  ).length > 0
                    ? t("正在安装")
                    : t("等待安装")}{' '}
                  · {Object.values(installJobs).length} {t(" 个任务")}</span>
              )}
            {!skillsCatalog && (
              <div className="runtime-scope" aria-label={t("按运行方式筛选")}>
                <button
                  className={runtimeFilter === 'offline' ? 'active' : ''}
                  type="button"
                  aria-pressed={runtimeFilter === 'offline'}
                  title={t("仅显示离线模型；再次点击恢复全部")}
                  onClick={() =>
                    setRuntimeFilter((current) =>
                      current === 'offline' ? 'all' : 'offline',
                    )
                  }
                >
                  <HardDrive size={13} />
                  {t("离线")}</button>
                <i />
                <button
                  className={runtimeFilter === 'api' ? 'active' : ''}
                  type="button"
                  aria-pressed={runtimeFilter === 'api'}
                  title={t("仅显示云端 API；再次点击恢复全部")}
                  onClick={() =>
                    setRuntimeFilter((current) =>
                      current === 'api' ? 'all' : 'api',
                    )
                  }
                >
                  <Wifi size={13} />
                  {t("云端 API")}</button>
              </div>
            )}
          </div>


          <div className="plugin-list">
            {!filteredPlugins.length && (
              <div className="plugin-empty-category">
                <BrainCircuit size={22} />
                <strong>
                  {skillsCatalog ? t("这个分类暂时没有技能") : t("这个分类暂时没有模型")}</strong>
                <p>
                  {t("尝试切换分类或搜索其他能力。")}</p>
              </div>
            )}
            {filteredPlugins.map((plugin) => {
              const apiPlugin = isApiPlugin(plugin)
              const appAgent = isWorkspaceAgent(plugin)
              const installState = installJobs[plugin.id]
              const requiresApiConfig = apiPlugin && !plugin.enabled
              const isCloudBusy = cloudBusyIds.has(plugin.id)
              const dependencyReferences = apiPlugin
                ? []
                : referencingModels(plugin.id, allModels, modelBindings)
              const retainedDependency =
                plugin.installed &&
                plugin.sidebarVisible === false &&
                dependencyReferences.length > 0
              const installDisabled =
                (!appAgent &&
                  (!plugin.catalogManaged || plugin.installable === false)) ||
                retainedDependency ||
                Boolean(busyId) ||
                anotherOperationBusy
              return (
                <article
                  key={plugin.id}
                  className={`plugin-row${plugin.id === selectedPlugin?.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(plugin.id)}
                >
                  <div className="plugin-main-copy">
                    <div className="plugin-title-line">
                      <h2>{displayPluginName(plugin)}</h2>
                      <div className="plugin-row-action">
                    {appAgent ? (
                      <button
                        className={
                          plugin.installed
                            ? `installed-button hide-skill-button${pendingDeleteId === plugin.id ? ' confirming-delete' : ''}`
                            : 'install-button'
                        }
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (plugin.installed) void removePlugin(plugin)
                          else void installOrAddPlugin(plugin)
                        }}
                      >
                        {plugin.installed ? (
                          <>
                            <EyeOff size={14} />
                            {pendingDeleteId === plugin.id ? t('确认隐藏') : t('隐藏')}
                          </>
                        ) : (
                          <>
                            <Download size={14} />
                            {t('安装')}
                          </>
                        )}
                      </button>
                    ) : installState ? (
                      <button
                        className="install-button installing"
                        type="button"
                        disabled
                        title={installDetail || undefined}
                      >
                        <RefreshCw className="model-spin" size={14} />
                        {installState === 'queued'
                          ? t("排队中")
                          : installState === 'paused'
                            ? t("已暂停")
                            : installState === 'canceling'
                              ? t("取消中")
                              : compactInstallProgress}
                      </button>
                    ) : apiPlugin ? (
                      requiresApiConfig ? (
                        <button
                          className="install-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            onConfigureProvider(plugin.providerId ?? '')
                          }}
                        >
                          <KeyRound size={14} />
                          {t("配置")}</button>
                      ) : (
                        <button
                          className={
                            plugin.installed
                              ? `installed-button${pendingDeleteId === plugin.id ? ' confirming-delete' : ''}`
                              : 'install-button'
                          }
                          type="button"
                          disabled={isCloudBusy || Boolean(busyId)}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (plugin.installed) void removePlugin(plugin)
                            else void setCloudModelInstalled(plugin, true)
                          }}
                        >
                          {plugin.installed ? (
                            <>
                              <Trash2 size={14} />
                              {pendingDeleteId === plugin.id ? t("确认") : t("删除")}
                            </>
                          ) : (
                            <>
                              <CirclePlus size={14} />
                              {t("添加")}</>
                          )}
                        </button>
                      )
                    ) : plugin.installed ? (
                      <button
                        className={`installed-button${retainedDependency ? ' retained-dependency' : ''}${pendingDeleteId === plugin.id ? ' confirming-delete' : ''}`}
                        type="button"
                        title={
                          retainedDependency
                            ? t("仍被 {0} 个模型使用", [dependencyReferences.length])
                            : undefined
                        }
                        disabled={retainedDependency || Boolean(busyId)}
                        onClick={(event) => {
                          event.stopPropagation()
                          void removePlugin(plugin)
                        }}
                      >
                        {retainedDependency ? (
                          <>
                            <PackageCheck size={14} />
                            {t("依赖中")}</>
                        ) : (
                          <>
                            <Trash2 size={14} />
                            {pendingDeleteId === plugin.id ? t("确认") : t("删除")}
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        className="install-button"
                        type="button"
                        disabled={installDisabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          void installOrAddPlugin(plugin)
                        }}
                      >
                        <Download size={14} />
                        {plugin.installable === false
                          ? t("适配中")
                          : plugin.catalogManaged
                            ? t("安装")
                            : t("导入资源")}
                      </button>
                    )}
                      </div>
                    </div>
                    <span className="plugin-author">
                      {appAgent ? t("技能") : plugin.agent ? t("模型") : t("兼容扩展")} · {plugin.author} ·{' '}
                      {displayPluginVersion(plugin, apiPlugin)}
                    </span>
                    <p>{t(plugin.description)}</p>
                    <div className="plugin-capabilities">
                      <span
                        className={`execution-mode-tag ${apiPlugin ? 'api' : 'offline'}`}
                      >
                        {apiPlugin ? <Wifi size={11} /> : <HardDrive size={11} />}
                        {appAgent
                          ? t("技能")
                          : apiPlugin
                            ? t("云端 API")
                            : t("离线运行")}
                      </span>
                      <span>
                        {appAgent
                          ? t("工作流")
                          : plugin.streamingMode === 'streaming'
                          ? t("流式")
                          : t("整段处理")}
                      </span>
                      {plugin.capabilities.map((capability) => (
                        <span key={capability}>{t(capability)}</span>
                      ))}
                      <span>{plugin.runtime}</span>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </main>

        <div
          className={`plugins-resize-handle${resizingDetails ? ' active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("调整展示区宽度")}
          onPointerDown={startDetailsResize}
        />

        <aside className="plugin-details">
          {!selectedPlugin && (
            <div className="plugin-empty-category plugin-details-empty">
              <BrainCircuit size={22} />
              <strong>{skillsCatalog ? t("选择一个技能查看详情") : t("选择一个模型查看详情")}</strong>
              <p>
                {skillsCatalog
                  ? t("选择一个技能，查看使用说明、所需模型与安装选项。")
                  : t("选择一个模型，查看能力、运行资源与安装选项。")}
              </p>
            </div>
          )}

          {selectedPlugin && (
            <>
              <div className="plugin-project-header">
                <div className="plugin-project-title">
                  <span className="plugin-project-owner">
                    {selectedPlugin.author}
                  </span>
                  <span className="plugin-project-sep">/</span>
                  <h2>{displayPluginName(selectedPlugin)}</h2>
                </div>
                {selectedPlugin.description && (
                  <p className="plugin-project-description">
                    {t(selectedPlugin.description)}
                  </p>
                )}
                <div className="plugin-project-meta">
                  <span>
                    {displayPluginVersion(selectedPlugin, selectedIsApi)}
                  </span>
                  {selectedPlugin.license && <span>{selectedPlugin.license}</span>}
                  {!selectedIsApi && (
                    <span>{selectedIsAppAgent ? t(selectedPlugin.size) : selectedVariant?.size ?? selectedPlugin.size}</span>
                  )}
                  <span>
                    {selectedIsAppAgent
                      ? t("技能")
                      : selectedIsApi
                        ? t("云端 API")
                        : t("离线运行")}
                  </span>
                </div>
                <div className="plugin-capabilities">
                  {selectedPlugin.capabilities.map((capability) => (
                    <span key={capability}>{t(capability)}</span>
                  ))}
                </div>
              </div>

              {!selectedIsApi &&
                !selectedPlugin.installed &&
                Boolean(selectedPlugin.variants?.length) && (
                  <label className="plugin-variant-field">
                    <span>{t("模型精度")}</span>
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
                      <small>{t("默认版本，体积更小，适合大多数设备")}</small>
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
                    {selectedIsAppAgent
                      ? t("应用工作流")
                      : isApiPlugin(selectedPlugin)
                        ? t("云端 API")
                        : t("离线运行")}
                  </strong>
                  <small>
                    {selectedIsAppAgent
                      ? t("安装后显示在工作台侧栏；识别模型和 VAD 组件单独选择")
                      : isApiPlugin(selectedPlugin)
                      ? selectedPlugin.enabled
                        ? t("添加到工作台即可使用")
                        : t("先配置 Provider，再添加到工作台")
                      : t("模型权重保存在本机，音频无需上传到云端")}
                  </small>
                </span>
              </div>

              <div className="plugin-detail-actions">
                {(selectedIsApi ||
                  !selectedPlugin.installed ||
                  selectedPlugin.sidebarVisible === false ||
                  selectedInstallState !== undefined) && (
                  <button
                    className="secondary-action full-width"
                    type="button"
                    disabled={
                      (!selectedPlugin.installed &&
                        !selectedIsApi &&
                        !selectedIsAppAgent &&
                        (!selectedPlugin.catalogManaged ||
                          selectedPlugin.installable === false)) ||
                      selectedInstallState !== undefined ||
                      (!selectedCanQueueInstall &&
                        !selectedIsApi &&
                        !selectedIsAppAgent &&
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
                  {selectedIsAppAgent ? (
                    <>
                      <Download size={16} />
                      {t('安装技能')}
                    </>
                  ) : selectedInstallState === 'queued' ? (
                    <>
                      <RefreshCw size={16} />
                      {t("排队中")}</>
                  ) : selectedInstallState === 'paused' ? (
                    <>
                      <Pause size={16} />
                      {t("下载已暂停")}</>
                  ) : selectedInstallState === 'canceling' ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      {t("正在取消")}</>
                  ) : selectedInstallState === 'running' ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      {t("下载中 ")}{compactInstallProgress}
                    </>
                  ) : selectedCloudBusy ? (
                    <>
                      <RefreshCw className="model-spin" size={16} />
                      {t("处理中")}</>
                  ) : selectedIsApi ? (
                    <>
                      {selectedPlugin.installed || !selectedPlugin.enabled ? (
                        <KeyRound size={16} />
                      ) : (
                        <CirclePlus size={16} />
                      )}
                      {selectedPlugin.installed
                        ? t("管理 API 配置")
                        : selectedPlugin.enabled
                          ? t("添加到工作台")
                          : t("配置 Provider")}
                    </>
                  ) : selectedPlugin.installed ? (
                    <>
                      <CirclePlus size={16} />
                      {t("添加到工作台")}</>
                  ) : (
                    <>
                      <Download size={16} />{' '}
                      {selectedPlugin.installable === false
                          ? t("运行适配中")
                        : selectedPlugin.catalogManaged
                          ? t("安装模型")
                          : t("需导入完整项目资源")}
                    </>
                  )}
                  </button>
                )}
                {selectedInstallState && (
                  <div className="selected-install-actions">
                    {(selectedInstallState === 'running' ||
                      selectedInstallState === 'paused') && (
                      <button
                        className="icon-button"
                        type="button"
                        title={
                          selectedInstallState === 'paused'
                            ? t("继续下载")
                            : t("暂停下载")
                        }
                        aria-label={
                          selectedInstallState === 'paused'
                            ? t("继续下载")
                            : t("暂停下载")
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
                        title={t("取消下载")}
                        aria-label={t("取消下载")}
                        onClick={() => void cancelInstall(selectedPlugin.id)}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                )}
                {selectedPlugin.installed &&
                  !selectedInstallState &&
                  !selectedCloudBusy &&
                  selectedPlugin.adapter !== 'web-audio' && (
                    <button
                      className={`installed-button plugin-detail-remove${
                        selectedIsAppAgent ? ' hide-skill-button' : ''
                      }${
                        selectedRetainedDependency ? ' retained-dependency' : ''
                      }${pendingDeleteId === selectedPlugin.id ? ' confirming-delete' : ''}`}
                      type="button"
                      title={
                        selectedRetainedDependency
                          ? t("仍被 {0} 个模型使用", [selectedDependencyReferences.length])
                          : undefined
                      }
                      disabled={selectedRetainedDependency || Boolean(busyId)}
                      onClick={() => void removePlugin(selectedPlugin)}
                    >
                      {selectedRetainedDependency ? (
                        <>
                          <PackageCheck size={15} />
                          {t("依赖中")}</>
                      ) : (
                        <>
                          {selectedIsAppAgent ? <EyeOff size={15} /> : <Trash2 size={15} />}
                          {pendingDeleteId === selectedPlugin.id
                            ? selectedIsAppAgent
                              ? t("再次点击确认隐藏")
                              : t("再次点击确认删除")
                            : selectedIsAppAgent
                              ? t("隐藏技能")
                              : selectedIsApi
                              ? t("从工作台移除")
                              : t("删除模型")}
                        </>
                      )}
                    </button>
                  )}
              </div>

              <div className="plugin-project-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailsTab === 'card'}
                  className={detailsTab === 'card' ? 'active' : ''}
                  onClick={() => setDetailsTab('card')}
                >
                  {skillsCatalog ? t("技能说明") : t("模型说明")}</button>
                {selectedHasFiles && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailsTab === 'files'}
                    className={detailsTab === 'files' ? 'active' : ''}
                    onClick={() => setDetailsTab('files')}
                  >
                    {t("文件")}</button>
                )}
              </div>

              {detailsTab === 'files' ? (
                <section className="plugin-files-card">
                  {selectedFiles === null ? (
                    <p className="plugin-files-empty">{t("正在读取文件…")}</p>
                  ) : selectedFiles.length === 0 ? (
                    <p className="plugin-files-empty">{t("暂无文件")}</p>
                  ) : (
                    <ul className="plugin-files-list">
                      {selectedFiles.map((file) => (
                        <li key={file.path}>
                          <FileText size={14} />
                          <span className="plugin-file-path">{file.path}</span>
                          <span className="plugin-file-size">
                            {formatFileSize(file.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : (
                <section className="model-introduction-card">
                  <AgentProjectCard plugin={selectedPlugin} />
                  <div className="model-introduction-body">
                    {selectedReadme || selectedNote ? (
                      <div className="model-note">
                        <Markdown
                          components={{
                            a: ({ href, children }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {selectedReadme ?? selectedNote ?? ''}
                        </Markdown>
                      </div>
                    ) : (
                      <p>{t(selectedPlugin.description)}</p>
                    )}
                  </div>
                </section>
              )}

              {selectedDependencies.length > 0 && (
                <section className="runtime-card model-dependencies-card">
                  <header>
                    <PackageCheck size={14} />
                    <strong>{t("配套组件")}</strong>
                  </header>
                  <div className="model-dependencies-body">
                    {selectedDependencies.map((dependency) => {
                      const candidates = allModels.filter(
                        (candidate) =>
                          !candidate.agent &&
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
                        allModels,
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
                                  t("无法保存配套组件：{0}", [error instanceof Error ? error.message : String(error)]),
                                )
                              })
                              setBindingRevision((value) => value + 1)
                            }}
                          >
                            {dependency.optional && <option value="">{t("无")}</option>}
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
                                {t("· 安装时尝试下载")}</option>
                            )}
                          </select>
                        </label>
                      )
                    })}
                    {!selectedPlugin.installed && (
                      <small>
                        {t("默认随模型尝试安装；可选组件失败不影响模型运行，之后也可在这里替换。")}</small>
                    )}
                  </div>
                </section>
              )}

              <section className="runtime-card">
                <header>
                  <span
                    className={`status-dot${selectedIsApi && !selectedPlugin.enabled ? ' pending' : ''}`}
                  />
                  <strong>{t("运行环境")}</strong>
                  <small>
                    {selectedIsApi
                      ? selectedPlugin.enabled
                        ? t("配置就绪")
                        : selectedPlugin.providerId === 'api.bailian'
                          ? t("待配置 AK")
                          : t("待配置 Provider")
                      : t("运行正常")}
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
                      {selectedIsApi ? t("服务商") : 'Runtime'}
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
                        <Boxes size={14} /> {t(" 引擎作者")}</dt>
                      <dd>{selectedPlugin.engineAuthor ?? selectedPlugin.runtime}</dd>
                    </div>
                  )}
                  {!selectedIsApi && (
                    <div>
                      <dt>
                        <Boxes size={14} /> {t(" 核心")}</dt>
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
                      {selectedIsApi ? t("模型 ID") : t("模型大小")}
                    </dt>
                    <dd>
                      {selectedIsApi
                        ? selectedPlugin.version
                        : selectedIsAppAgent
                          ? t(selectedPlugin.size)
                          : selectedVariant?.size ?? selectedPlugin.size}
                    </dd>
                  </div>
                  {selectedIsApi &&
                    (selectedPlugin.apiAliases?.length ?? 0) > 0 && (
                      <div>
                        <dt>
                          <TerminalSquare size={14} /> {t(" 兼容别名")}</dt>
                        <dd>{selectedPlugin.apiAliases?.join(' / ')}</dd>
                      </div>
                    )}
                  {selectedPlugin.license && (
                    <div>
                      <dt>{t("许可证")}</dt>
                      <dd>{selectedPlugin.license}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      <Cpu size={14} /> {t(" 设备")}</dt>
                    <dd>{selectedIsApi ? t("云端执行") : runtime.device}</dd>
                  </div>
                  {!selectedIsApi && (
                    <div>
                      <dt>
                        <Gauge size={14} /> {t(" 加速")}</dt>
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


    </div>
  )
}
