import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  AudioLines,
  BrainCircuit,
  Download,
  GitBranch,
  LoaderCircle,
  Menu,
  Monitor,
  Moon,
  Pin,
  RefreshCw,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Sun,
  TextCursorInput,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { ModelCapabilityIcon } from './components/ModelCapabilityIcon'
import { SidebarCollapseIcon } from './components/SidebarCollapseIcon'
import { initialPlugins, fallbackRuntime } from './data'
import { cloudModelsFromCatalog, isRetiredCloudModelId } from './cloudModels'
import { capabilityDefinition } from './domain/capabilities'
import {
  executeHarnessTask,
  deleteHarnessRun,
  getHarnessCatalog,
  getModelDependencyBindings,
  installRecommendedModelDependency,
  isTauriRuntime,
  listApiModelCatalog,
  listHarnessRuns,
  listModelPlugins,
  refreshModelPlugins,
  replaceModelDependencyBindings,
  setModelDependencyBinding,
  subscribeHarnessRuns,
  uninstallModelPlugin,
} from './services/harness'
import {
  getModelBinding,
  referencingModels,
  recommendedDependencies,
} from './modelDependencies'
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  type AppUpdateInfo,
} from './services/updater'
import {
  listSavedWorkflows,
  type SavedWorkflow,
} from './services/workflowRuntime'
import type {
  ApiModelCatalogEntry,
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessCatalog,
  HarnessExecution,
  HarnessRun,
  ModelDependencyBindings,
  ModelPlugin,
  RuntimeStatus,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from './types'
import type { WorkflowChatTurn } from './views/WorkflowChatView'
import './App.css'

const ModelWorkspaceView = lazy(() =>
  import('./views/ModelWorkspaceView').then((module) => ({
    default: module.ModelWorkspaceView,
  })),
)
const PluginsView = lazy(() =>
  import('./views/PluginsView').then((module) => ({
    default: module.PluginsView,
  })),
)
const WorkflowChatView = lazy(() =>
  import('./views/WorkflowChatView').then((module) => ({
    default: module.WorkflowChatView,
  })),
)
const WorkflowsView = lazy(() =>
  import('./views/WorkflowsView').then((module) => ({
    default: module.WorkflowsView,
  })),
)

type AppView = 'workspace' | 'workflows' | 'plugins'
type ThemePreference = 'system' | 'light' | 'dark'
type AppUpdateState = {
  status:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'unavailable'
    | 'error'
  update?: AppUpdateInfo
  progress?: number
  message?: string
}

const CLOUD_MODELS_STORAGE_KEY = 'qwen-audio-toolkits.installed-cloud-models-v1'
const SIDEBAR_MODEL_ORDER_KEY = 'qwen-audio-toolkits.model-sidebar-order-v1'
const SIDEBAR_PINNED_MODELS_KEY = 'qwen-audio-toolkits.sidebar-pinned-models-v1'
const SIDEBAR_WIDTH_KEY = 'qwen-audio-toolkits.sidebar-width-v8'
const SIDEBAR_COLLAPSED_KEY = 'qwen-audio-toolkits.sidebar-collapsed-v1'
const SIDEBAR_COLLAPSED_GROUPS_KEY =
  'qwen-audio-toolkits.sidebar-collapsed-groups-v1'
const THEME_STORAGE_KEY = 'qwen-audio-toolkits.theme-v1'
const LAST_MODEL_STORAGE_KEY = 'qwen-audio-toolkits.last-model-v1'
const DEFAULT_VOICE_WORKFLOW_MODELS_KEY =
  'qwen-audio-toolkits.default-voice-workflow-models-v2'
const WORKFLOWS_ENABLED = false
const APP_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
const DEFAULT_SIDEBAR_WIDTH = 240
const COLLAPSED_SIDEBAR_WIDTH = 0
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 520
const MIN_WORKSPACE_WIDTH = 480
const SIDEBAR_COLLAPSE_DRAG_THRESHOLD = 120

type SidebarModelGroupId =
  | 'pinned'
  | 'audio'
  | 'understanding'
  | 'text'
  | 'generation'
  | 'workflows'

const SIDEBAR_MODEL_GROUPS: Array<{
  id: SidebarModelGroupId
  label: string
}> = [
  { id: 'pinned', label: '已置顶' },
  { id: 'audio', label: '音频处理' },
  { id: 'understanding', label: '音频理解' },
  { id: 'text', label: '文本智能' },
  { id: 'generation', label: '音频生成' },
]

function getInitialTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function getInitialSidebarWidth() {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  try {
    const value = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (value === null) return DEFAULT_SIDEBAR_WIDTH
    const stored = Number(value)
    if (!Number.isFinite(stored)) return DEFAULT_SIDEBAR_WIDTH
    return Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, stored),
    )
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function getInitialSidebarCollapsed() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function getInitialCollapsedSidebarGroups() {
  if (typeof window === 'undefined') return new Set<SidebarModelGroupId>()
  try {
    const value = JSON.parse(
      window.localStorage.getItem(SIDEBAR_COLLAPSED_GROUPS_KEY) ?? '[]',
    )
    return new Set<SidebarModelGroupId>(
      Array.isArray(value)
        ? value.filter((item): item is SidebarModelGroupId =>
            SIDEBAR_MODEL_GROUPS.some((group) => group.id === item),
          )
        : [],
    )
  } catch {
    return new Set<SidebarModelGroupId>()
  }
}

function getInitialSelectedPluginId(): string {
  if (typeof window === 'undefined') return 'funaudiollm.sensevoice-small-gguf'
  try {
    return (
      window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) ??
      'funaudiollm.sensevoice-small-gguf'
    )
  } catch {
    return 'funaudiollm.sensevoice-small-gguf'
  }
}

function getInitialCloudModels(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(
      window.localStorage.getItem(CLOUD_MODELS_STORAGE_KEY) ?? '[]',
    )
    const installed = Array.isArray(value)
      ? value.filter(
          (item): item is string =>
            typeof item === 'string' && !isRetiredCloudModelId(item),
        )
      : []
    window.localStorage.setItem(
      CLOUD_MODELS_STORAGE_KEY,
      JSON.stringify(installed),
    )
    if (!window.localStorage.getItem(DEFAULT_VOICE_WORKFLOW_MODELS_KEY)) {
      installed.push(
        'bailian-funasr-realtime',
        'bailian-qwen37-plus',
        'bailian-cosyvoice-v2',
      )
      const next = Array.from(new Set(installed))
      window.localStorage.setItem(
        DEFAULT_VOICE_WORKFLOW_MODELS_KEY,
        'installed',
      )
      window.localStorage.setItem(
        CLOUD_MODELS_STORAGE_KEY,
        JSON.stringify(next),
      )
      return next
    }
    return installed
  } catch {
    return []
  }
}

function getInitialSidebarModelOrder(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(
      window.localStorage.getItem(SIDEBAR_MODEL_ORDER_KEY) ?? '[]',
    )
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function getInitialPinnedModels(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(
      window.localStorage.getItem(SIDEBAR_PINNED_MODELS_KEY) ?? '[]',
    )
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function modelSidebarGroup(plugin: ModelPlugin): SidebarModelGroupId {
  const capability = plugin.harnessCapabilities[0]
  if (!capability) return 'understanding'
  switch (capabilityDefinition(capability).category) {
    case '音频处理':
      return 'audio'
    case '文本智能':
      return 'text'
    case '音频生成':
      return 'generation'
    default:
      return 'understanding'
  }
}

function sidebarGroupIcon(group: SidebarModelGroupId) {
  switch (group) {
    case 'pinned':
      return <Pin size={11} />
    case 'audio':
      return <SlidersHorizontal size={11} />
    case 'understanding':
      return <BrainCircuit size={11} />
    case 'text':
      return <TextCursorInput size={11} />
    case 'generation':
      return <WandSparkles size={11} />
    default:
      return null
  }
}

function startModelNameScroll(button: HTMLButtonElement) {
  const text = button.querySelector<HTMLElement>('.activity-model-name-text')
  const viewport = text?.parentElement
  if (!text || !viewport) return
  const compact =
    button.closest<HTMLElement>('.model-sidebar')?.dataset.compact === 'true'
  if (compact) {
    const overflow = text.scrollHeight - viewport.clientHeight
    if (overflow <= 1) return
    text.getAnimations().forEach((animation) => animation.cancel())
    text.animate(
      [
        { transform: 'translateY(0)' },
        { transform: `translateY(-${overflow}px)` },
      ],
      {
        duration: Math.max(1400, overflow * 90),
        delay: 350,
        direction: 'alternate',
        easing: 'ease-in-out',
        iterations: Infinity,
      },
    )
    return
  }
  const overflow = text.scrollWidth - viewport.clientWidth
  if (overflow <= 1) return
  text.getAnimations().forEach((animation) => animation.cancel())
  text.animate(
    [
      { transform: 'translateX(0)' },
      { transform: `translateX(-${overflow}px)` },
    ],
    {
      duration: Math.max(1600, overflow * 32),
      delay: 350,
      direction: 'alternate',
      easing: 'ease-in-out',
      iterations: Infinity,
    },
  )
}

function stopModelNameScroll(button: HTMLButtonElement) {
  const text = button.querySelector<HTMLElement>('.activity-model-name-text')
  text?.getAnimations().forEach((animation) => animation.cancel())
}

function upsertRun(runs: HarnessRun[], run: HarnessRun): HarnessRun[] {
  const existingIndex = runs.findIndex((item) => item.id === run.id)
  if (existingIndex >= 0) {
    const next = [...runs]
    next[existingIndex] = run
    return next
  }
  return [run, ...runs].sort(
    (left, right) => right.createdAt - left.createdAt,
  )
}

function summarizeRun(run: HarnessRun): HarnessRun {
  return {
    ...run,
    artifacts: run.artifacts.map((artifact) => ({
      ...artifact,
      payload: {},
    })),
  }
}

function App() {
  const [view, setView] = useState<AppView>('workspace')
  const [plugins, setPlugins] = useState<ModelPlugin[]>(initialPlugins)
  const [pluginsLoaded, setPluginsLoaded] = useState(() => !isTauriRuntime())
  const [runtime, setRuntime] = useState<RuntimeStatus>(fallbackRuntime)
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(null)
  const [apiModelCatalog, setApiModelCatalog] = useState<
    ApiModelCatalogEntry[]
  >([])
  const [runs, setRuns] = useState<HarnessRun[]>([])
  // Per-provider chat history for text.generate, so the LLM keeps context
  // across turns instead of treating every message as a fresh conversation.
  const [textHistory, setTextHistory] = useState<
    Record<string, { role: 'user' | 'assistant'; content: string }[]>
  >({})
  const [activeRunIds, setActiveRunIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [installedCloudModelIds, setInstalledCloudModelIds] = useState<string[]>(
    getInitialCloudModels,
  )
  const [modelBindings, setModelBindings] = useState<ModelDependencyBindings>(
    {},
  )
  const [modelBindingsLoaded, setModelBindingsLoaded] = useState(
    !isTauriRuntime(),
  )
  const [selectedPluginId, setSelectedPluginId] =
    useState(getInitialSelectedPluginId)
  const [apiConfigurationTargetId, setApiConfigurationTargetId] = useState<
    string | null
  >(null)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>(
    listSavedWorkflows,
  )
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  )
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(
    null,
  )
  const [workflowSelected, setWorkflowSelected] = useState(false)
  const [workflowTurns, setWorkflowTurns] = useState<
    Record<string, WorkflowChatTurn[]>
  >({})
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    getInitialSidebarCollapsed,
  )
  const [sidebarPeek, setSidebarPeek] = useState(false)
  const sidebarPeekTimerRef = useRef<number | null>(null)
  const sidebarPeekNeedsReentryRef = useRef(false)
  const sidebarButtonHoveredRef = useRef(false)
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [collapsedSidebarGroups, setCollapsedSidebarGroups] = useState(
    getInitialCollapsedSidebarGroups,
  )
  const [sidebarModelOrder, setSidebarModelOrder] = useState(
    getInitialSidebarModelOrder,
  )
  const [pinnedModelIds, setPinnedModelIds] = useState(
    getInitialPinnedModels,
  )
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null)
  const [dropTargetModelId, setDropTargetModelId] = useState<string | null>(null)
  const [pendingSidebarRemovalId, setPendingSidebarRemovalId] = useState<
    string | null
  >(null)
  const [railTooltip, setRailTooltip] = useState<{
    name: string
    detail: string
    top: number
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: 'idle' })
  const appUpdateStatusRef = useRef<AppUpdateState['status']>('idle')
  const [toast, setToast] = useState<string | null>(null)
  const repairingDependenciesRef = useRef(new Set<string>())
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getInitialTheme)
  const [systemDark, setSystemDark] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const resolvedTheme =
    themePreference === 'system'
      ? systemDark
        ? 'dark'
        : 'light'
      : themePreference
  const usesOverlayTitlebar =
    typeof navigator !== 'undefined' &&
    /Macintosh|Mac OS X/.test(navigator.userAgent)
  const sidebarCanCollapse = view === 'workspace'

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [settingsOpen])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
    if (isTauriRuntime()) {
      void getCurrentWindow().setTheme(resolvedTheme)
    }
  }, [resolvedTheme])

  const selectTheme = (theme: ThemePreference) => {
    setThemePreference(theme)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Keep the theme for the current session when storage is unavailable.
    }
  }

  const cloudModelPlugins = useMemo<ModelPlugin[]>(() => {
    return cloudModelsFromCatalog(
      catalog,
      installedCloudModelIds,
      apiModelCatalog,
    ).filter((plugin) => plugin.installed)
  }, [apiModelCatalog, catalog, installedCloudModelIds])

  useEffect(() => {
    if (!modelBindingsLoaded) return
    const next: ModelDependencyBindings = {}
    for (const model of [...plugins, ...cloudModelPlugins]) {
      if (!model.installed) continue
      const dependencies = recommendedDependencies(model)
      if (!dependencies.length) continue
      next[model.id] = {}
      for (const dependency of dependencies) {
        const selected = getModelBinding(
          modelBindings,
          model.id,
          dependency.role,
          dependency.default ? dependency.pluginId : '',
        )
        next[model.id][dependency.role] =
          dependency.role === 'speech-segmentation' &&
          selected === 'silero-vad'
            ? dependency.pluginId
            : selected
      }
    }
    if (JSON.stringify(next) === JSON.stringify(modelBindings)) return
    setModelBindings(next)
    if (isTauriRuntime()) {
      void replaceModelDependencyBindings(next).catch((error) =>
        setToast(
          `无法保存模型依赖：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
  }, [cloudModelPlugins, modelBindings, modelBindingsLoaded, plugins])

  const removeModelBindings = (pluginId: string) => {
    setModelBindings((current) => {
      if (!(pluginId in current)) return current
      const next = { ...current }
      delete next[pluginId]
      if (isTauriRuntime()) {
        void replaceModelDependencyBindings(next).catch((error) =>
          setToast(
            `无法清理模型依赖：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
      return next
    })
  }

  const saveModelBinding = (
    pluginId: string,
    role: string,
    dependencyId: string,
  ): Promise<void> => {
    if (!isTauriRuntime()) {
      setModelBindings((current) => ({
        ...current,
        [pluginId]: { ...current[pluginId], [role]: dependencyId },
      }))
      return Promise.resolve()
    }
    return setModelDependencyBinding(pluginId, role, dependencyId).then(
      setModelBindings,
    )
  }

  const setCloudModelInstalled = (modelId: string, installed: boolean) => {
    if (!installed) removeModelBindings(modelId)
    setInstalledCloudModelIds((current) => {
      const next = installed
        ? Array.from(new Set([...current, modelId]))
        : current.filter((id) => id !== modelId)
      try {
        window.localStorage.setItem(
          CLOUD_MODELS_STORAGE_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Keep the current session state when storage is unavailable.
      }
      return next
    })
  }

  const runnablePlugins = useMemo(() => {
    const visible = new Map<string, ModelPlugin>()
    for (const plugin of plugins) {
      if (
        plugin.installed &&
        plugin.sidebarVisible !== false &&
        plugin.providerId
      ) {
        visible.set(plugin.id, plugin)
      }
    }
    for (const plugin of cloudModelPlugins) visible.set(plugin.id, plugin)
    return [...visible.values()]
  }, [cloudModelPlugins, plugins])
  const orderedRunnablePlugins = useMemo(() => {
    const order = new Map(
      sidebarModelOrder.map((pluginId, index) => [pluginId, index]),
    )
    const pinned = new Set(pinnedModelIds)
    return [...runnablePlugins].sort(
      (left, right) =>
        Number(pinned.has(right.id)) - Number(pinned.has(left.id)) ||
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
  }, [pinnedModelIds, runnablePlugins, sidebarModelOrder])
  const groupedRunnablePlugins = useMemo(
    () =>
      ({
        pinned: orderedRunnablePlugins.filter((plugin) =>
          pinnedModelIds.includes(plugin.id),
        ),
        audio: orderedRunnablePlugins.filter(
          (plugin) =>
            !pinnedModelIds.includes(plugin.id) &&
            modelSidebarGroup(plugin) === 'audio',
        ),
        understanding: orderedRunnablePlugins.filter(
          (plugin) =>
            !pinnedModelIds.includes(plugin.id) &&
            modelSidebarGroup(plugin) === 'understanding',
        ),
        text: orderedRunnablePlugins.filter(
          (plugin) =>
            !pinnedModelIds.includes(plugin.id) &&
            modelSidebarGroup(plugin) === 'text',
        ),
        generation: orderedRunnablePlugins.filter(
          (plugin) =>
            !pinnedModelIds.includes(plugin.id) &&
            modelSidebarGroup(plugin) === 'generation',
        ),
        workflows: [],
      }) satisfies Record<SidebarModelGroupId, ModelPlugin[]>,
    [orderedRunnablePlugins, pinnedModelIds],
  )
  const responsiveSidebarMaxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.floor(viewportWidth - MIN_WORKSPACE_WIDTH),
    ),
  )
  const visibleSidebarWidth =
    sidebarCanCollapse && sidebarCollapsed && !sidebarPeek
      ? COLLAPSED_SIDEBAR_WIDTH
      : Math.min(sidebarWidth, responsiveSidebarMaxWidth)
  // Content offset mirrors the sidebar only when it is docked (expanded). When the
  // sidebar is collapsed it overlays the content, so the content stays full-width even
  // while hovering (peek) expands the sidebar.
  const visibleContentOffset =
    sidebarCanCollapse && sidebarCollapsed
      ? COLLAPSED_SIDEBAR_WIDTH
      : Math.min(sidebarWidth, responsiveSidebarMaxWidth)

  const toggleSidebarGroup = (groupId: SidebarModelGroupId) => {
    setCollapsedSidebarGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_GROUPS_KEY,
          JSON.stringify([...next]),
        )
      } catch {
        // Keep the collapsed state for the current session.
      }
      return next
    })
  }
  const selectedPlugin =
    orderedRunnablePlugins.find((plugin) => plugin.id === selectedPluginId) ??
    orderedRunnablePlugins[0] ??
    initialPlugins[0]

  useEffect(() => {
    if (
      view !== 'workspace' ||
      !isTauriRuntime() ||
      !selectedPlugin.installed
    ) {
      return
    }
    const missing = recommendedDependencies(selectedPlugin).filter(
      (dependency) => {
        if (dependency.optional) return false
        const dependencyId = getModelBinding(
          modelBindings,
          selectedPlugin.id,
          dependency.role,
          dependency.default ? dependency.pluginId : '',
        )
        return (
          dependencyId &&
          !plugins.some(
            (candidate) =>
              candidate.id === dependencyId &&
              candidate.installed,
          )
        )
      },
    )
    if (!missing.length || repairingDependenciesRef.current.has(selectedPlugin.id)) {
      return
    }
    repairingDependenciesRef.current.add(selectedPlugin.id)
    void (async () => {
      try {
        notify(`正在补齐 ${selectedPlugin.name} 的配套组件`)
        for (const dependency of missing) {
          const dependencyId = getModelBinding(
            modelBindings,
            selectedPlugin.id,
            dependency.role,
            dependency.default ? dependency.pluginId : '',
          )
          if (dependencyId) await installRecommendedModelDependency(dependencyId)
        }
        const [nextPlugins, nextCatalog] = await Promise.all([
          listModelPlugins(),
          getHarnessCatalog(),
        ])
        setPlugins(nextPlugins)
        setCatalog(nextCatalog)
        notify(`${selectedPlugin.name} 的配套组件已就绪`)
      } catch (error) {
        repairingDependenciesRef.current.delete(selectedPlugin.id)
        notify(
          `配套组件安装失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    })()
  }, [modelBindings, plugins, selectedPlugin, view])

  const recordRun = (run: HarnessRun) => {
    const summary = summarizeRun(run)
    setRuns((current) => upsertRun(current, summary))
    setActiveRunIds((current) => {
      const next = new Set(current)
      if (summary.status === 'running') next.add(summary.id)
      else next.delete(summary.id)
      return next
    })
  }

  useEffect(() => {
    if (!isTauriRuntime()) return

    invoke<RuntimeStatus>('runtime_status')
      .then(setRuntime)
      .catch(() => setRuntime(fallbackRuntime))
    void getHarnessCatalog().then(setCatalog).catch(() => setCatalog(null))
    void listHarnessRuns()
      .then((nextRuns) => setRuns(nextRuns.map(summarizeRun)))
      .catch(() => setRuns([]))
    void listModelPlugins()
      .then(setPlugins)
      .catch(() => setPlugins(initialPlugins))
      .finally(() => setPluginsLoaded(true))
    void listApiModelCatalog().then(setApiModelCatalog).catch(() => undefined)
    void getModelDependencyBindings()
      .then(setModelBindings)
      .catch(() => setModelBindings({}))
      .finally(() => setModelBindingsLoaded(true))
    void refreshModelPlugins()
      .then(setPlugins)
      .then(() => listApiModelCatalog())
      .then(setApiModelCatalog)
      .catch(() => {
        // Cached or built-in catalog remains available when the remote source is offline.
      })

    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeHarnessRuns((run) => {
      if (disposed) return
      recordRun(run)
    }).then((remove) => {
      if (disposed) remove()
      else unlisten = remove
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (
      pluginsLoaded &&
      orderedRunnablePlugins.length &&
      !orderedRunnablePlugins.some((plugin) => plugin.id === selectedPluginId)
    ) {
      setSelectedPluginId(orderedRunnablePlugins[0].id)
    }
  }, [orderedRunnablePlugins, pluginsLoaded, selectedPluginId])

  useEffect(() => {
    if (
      !pluginsLoaded ||
      !orderedRunnablePlugins.some((plugin) => plugin.id === selectedPluginId)
    ) {
      return
    }
    try {
      window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, selectedPluginId)
    } catch {
      // Keep the current session selection when storage is unavailable.
    }
  }, [orderedRunnablePlugins, pluginsLoaded, selectedPluginId])

  useEffect(() => {
    setSidebarModelOrder((current) => {
      const availableIds = new Set(runnablePlugins.map((plugin) => plugin.id))
      const next = [
        ...current.filter((pluginId) => availableIds.has(pluginId)),
        ...runnablePlugins
          .map((plugin) => plugin.id)
          .filter((pluginId) => !current.includes(pluginId)),
      ]
      if (
        next.length === current.length &&
        next.every((pluginId, index) => pluginId === current[index])
      ) {
        return current
      }
      try {
        window.localStorage.setItem(
          SIDEBAR_MODEL_ORDER_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Keep the current session order when storage is unavailable.
      }
      return next
    })
  }, [runnablePlugins])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!pendingSidebarRemovalId) return undefined
    const timer = window.setTimeout(
      () => setPendingSidebarRemovalId(null),
      3200,
    )
    return () => window.clearTimeout(timer)
  }, [pendingSidebarRemovalId])

  const notify = (message: string) => setToast(message)

  const downloadApplicationUpdate = async (silent = false) => {
    if (
      appUpdateStatusRef.current === 'downloading' ||
      appUpdateStatusRef.current === 'downloaded' ||
      appUpdateStatusRef.current === 'installing'
    ) {
      return
    }
    appUpdateStatusRef.current = 'downloading'
    setAppUpdate((current) => ({
      ...current,
      status: 'downloading',
      progress: 0,
    }))
    try {
      await downloadAppUpdate((downloaded, total) => {
        setAppUpdate((current) => ({
          ...current,
          status: 'downloading',
          progress: total
            ? Math.min(100, (downloaded / total) * 100)
            : undefined,
        }))
      })
      appUpdateStatusRef.current = 'downloaded'
      setAppUpdate((current) => ({
        ...current,
        status: 'downloaded',
        progress: 100,
      }))
      if (!silent) notify('更新已下载，点击“重启安装”完成更新')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appUpdateStatusRef.current = 'error'
      setAppUpdate((current) => ({ ...current, status: 'error', message }))
      if (!silent) notify(`下载更新失败：${message}`)
    }
  }

  const checkApplicationUpdate = async (silent = false) => {
    if (
      appUpdateStatusRef.current === 'checking' ||
      appUpdateStatusRef.current === 'downloading' ||
      appUpdateStatusRef.current === 'installing' ||
      (silent &&
        (appUpdateStatusRef.current === 'available' ||
          appUpdateStatusRef.current === 'downloaded'))
    ) {
      return
    }
    appUpdateStatusRef.current = 'checking'
    setAppUpdate({ status: 'checking' })
    try {
      const result = await checkForAppUpdate()
      if (result.status === 'available') {
        appUpdateStatusRef.current = 'available'
        setAppUpdate({ status: 'available', update: result.update })
        if (!silent) notify(`发现新版本 ${result.update.version}，正在后台下载`)
        void downloadApplicationUpdate(silent)
      } else if (result.status === 'current') {
        appUpdateStatusRef.current = 'current'
        setAppUpdate({ status: 'current' })
        if (!silent) notify('当前已是最新版本')
      } else {
        appUpdateStatusRef.current = 'unavailable'
        setAppUpdate({ status: 'unavailable', message: result.message })
        if (!silent) notify(result.message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appUpdateStatusRef.current = 'error'
      setAppUpdate({ status: 'error', message })
      if (!silent) notify(`检查更新失败：${message}`)
    }
  }

  const applyApplicationUpdate = async () => {
    if (activeRunIds.size > 0) {
      notify('请等待当前模型任务结束后再安装更新')
      return
    }
    if (
      appUpdateStatusRef.current === 'downloading' ||
      appUpdateStatusRef.current === 'installing'
    ) {
      return
    }
    if (appUpdateStatusRef.current === 'available') {
      await downloadApplicationUpdate()
    }
    if (appUpdateStatusRef.current !== 'downloaded') return
    appUpdateStatusRef.current = 'installing'
    setAppUpdate((current) => ({ ...current, status: 'installing' }))
    try {
      await installAppUpdate((downloaded, total) => {
        setAppUpdate((current) => ({
          ...current,
          status: 'installing',
          progress: total ? Math.min(100, (downloaded / total) * 100) : undefined,
        }))
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appUpdateStatusRef.current = 'error'
      setAppUpdate((current) => ({ ...current, status: 'error', message }))
      notify(`安装更新失败：${message}`)
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('app-update-check-requested', () => {
      void checkApplicationUpdate()
    }).then((cleanup) => {
      if (disposed) {
        cleanup()
      } else {
        unlisten = cleanup
      }
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.PROD || !isTauriRuntime()) return undefined
    const initialTimer = window.setTimeout(
      () => void checkApplicationUpdate(true),
      10_000,
    )
    const interval = window.setInterval(
      () => void checkApplicationUpdate(true),
      APP_UPDATE_CHECK_INTERVAL_MS,
    )
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [])

  const clearSidebarPeekTimer = () => {
    if (sidebarPeekTimerRef.current === null) return
    window.clearTimeout(sidebarPeekTimerRef.current)
    sidebarPeekTimerRef.current = null
  }
  const openSidebarPeek = () => {
    if (
      !sidebarCanCollapse ||
      !sidebarCollapsed ||
      sidebarPeekNeedsReentryRef.current
    )
      return
    clearSidebarPeekTimer()
    setSidebarPeek(true)
  }
  const scheduleSidebarPeekClose = () => {
    if (!sidebarCanCollapse || !sidebarCollapsed) return
    sidebarPeekNeedsReentryRef.current = false
    clearSidebarPeekTimer()
    sidebarPeekTimerRef.current = window.setTimeout(() => {
      sidebarPeekTimerRef.current = null
      setSidebarPeek(false)
    }, 140)
  }
  const handleSidebarButtonEnter = () => {
    sidebarButtonHoveredRef.current = true
    openSidebarPeek()
  }
  const handleSidebarButtonLeave = () => {
    sidebarButtonHoveredRef.current = false
    scheduleSidebarPeekClose()
  }

  useEffect(() => {
    if (!sidebarCanCollapse || !sidebarCollapsed) {
      clearSidebarPeekTimer()
      setSidebarPeek(false)
      sidebarPeekNeedsReentryRef.current = false
    }
    return clearSidebarPeekTimer
  }, [sidebarCanCollapse, sidebarCollapsed])

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarCollapsed) return
    event.preventDefault()
    let nextWidth = sidebarWidth
    let collapsedByDrag = false
    document.body.classList.add('sidebar-resizing')

    const resize = (pointerEvent: PointerEvent) => {
      if (
        sidebarCanCollapse &&
        pointerEvent.clientX < SIDEBAR_COLLAPSE_DRAG_THRESHOLD
      ) {
        collapsedByDrag = true
        setSidebarCollapsed(true)
        setSidebarPeek(false)
        sidebarPeekNeedsReentryRef.current = false
        try {
          window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true')
        } catch {
          // Keep the collapsed state for the current session.
        }
        finish()
        return
      }
      nextWidth = Math.min(
        responsiveSidebarMaxWidth,
        Math.max(MIN_SIDEBAR_WIDTH, pointerEvent.clientX),
      )
      setSidebarWidth(nextWidth)
    }
    const finish = () => {
      document.body.classList.remove('sidebar-resizing')
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (collapsedByDrag) return
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth))
      } catch {
        // Keep the resized width for the current session.
      }
    }

    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const toggleSidebarCollapsed = () => {
    if (!sidebarCanCollapse) return
    setSidebarCollapsed((current) => {
      const next = !current
      sidebarPeekNeedsReentryRef.current =
        next && sidebarButtonHoveredRef.current
      clearSidebarPeekTimer()
      setSidebarPeek(false)
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      } catch {
        // Keep the collapsed state for the current session.
      }
      return next
    })
  }
  const changeView = (next: AppView) => {
    setView(next)
    setSidebarOpen(false)
  }

  const selectPlugin = (pluginId: string) => {
    setSelectedPluginId(pluginId)
    setWorkflowSelected(false)
    changeView('workspace')
  }

  const updateWorkflowTurns = (
    workflowId: string,
    update: SetStateAction<WorkflowChatTurn[]>,
  ) => {
    setWorkflowTurns((current) => {
      const previous = current[workflowId] ?? []
      return {
        ...current,
        [workflowId]:
          typeof update === 'function' ? update(previous) : update,
      }
    })
  }

  const reorderSidebarPlugin = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    setSidebarModelOrder((current) => {
      const next = [...current]
      const sourceIndex = next.indexOf(sourceId)
      const targetIndex = next.indexOf(targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, sourceId)
      try {
        window.localStorage.setItem(
          SIDEBAR_MODEL_ORDER_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Keep the reordered list for the current session.
      }
      return next
    })
  }

  const togglePinnedModel = (pluginId: string) => {
    setPinnedModelIds((current) => {
      const next = current.includes(pluginId)
        ? current.filter((id) => id !== pluginId)
        : [...current, pluginId]
      try {
        window.localStorage.setItem(
          SIDEBAR_PINNED_MODELS_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Keep the pin state for the current session.
      }
      return next
    })
  }

  const clearAllHistory = async () => {
    const removableRuns = runs.filter(
      (run) => !activeRunIds.has(run.id),
    )
    if (!removableRuns.length && !Object.keys(workflowTurns).length) {
      notify('当前没有历史消息')
      return
    }
    if (
      !window.confirm(
        `确定清除 ${removableRuns.length} 条历史记录吗？此操作无法撤销。`,
      )
    ) {
      return
    }
    setClearingHistory(true)
    try {
      await Promise.all(
        removableRuns.map((run) => deleteHarnessRun(run.id)),
      )
      const removableIds = new Set(removableRuns.map((run) => run.id))
      setRuns((current) =>
        current.filter((run) => !removableIds.has(run.id)),
      )
      setWorkflowTurns({})
      notify('历史消息已清除')
    } catch (error) {
      notify(
        `清除失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setClearingHistory(false)
    }
  }

  const runText = async (
    text: string,
    capability:
      | 'speech.synthesize'
      | 'text.generate'
      | 'text.punctuate'
      | 'text.normalize',
    providerId: string,
    modelId: string,
    modelParameters: Record<string, unknown>,
    dependencyRunIds: string[] = [],
    conversationVisible = true,
  ): Promise<
    HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>
  > => {
    const providerKey = selectedPlugin.providerId ?? ''
    const history = capability === 'text.generate'
      ? (textHistory[providerKey] ?? [])
      : []
    const systemPrompt = typeof modelParameters.systemPrompt === 'string'
      ? modelParameters.systemPrompt.trim()
      : ''
    const messages: {
      role: 'system' | 'user' | 'assistant'
      content: string
    }[] =
      capability === 'text.generate'
        ? [
            ...(systemPrompt
              ? [{ role: 'system' as const, content: systemPrompt }]
              : []),
            ...history,
            { role: 'user' as const, content: text },
          ]
        : []
    const execution = await executeHarnessTask<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >(
      {
        capability,
        providerId,
        conversationProviderId: selectedPlugin.providerId,
        conversationVisible,
        dependencyRunIds,
        routing: capability === 'text.generate' ? 'quality' : 'local',
        title: `${selectedPlugin.name} · ${
          capability === 'text.generate'
            ? '文本生成'
            : capability === 'text.punctuate'
              ? '标点恢复'
              : capability === 'text.normalize'
                ? '文本归一化'
              : '音频生成'
        }`,
        input:
          capability === 'text.generate'
            ? { messages }
            : { text },
        parameters: {
          modelId,
          ...(capability === 'speech.synthesize'
            ? { sid: 3, speed: 0.96, silenceScale: 0.2 }
            : { temperature: 0.7, maxTokens: 1024 }),
          ...modelParameters,
        },
      },
      (run) => {
        recordRun(run)
      },
    )
    recordRun(execution.run)
    if (capability === 'text.generate') {
      const reply = (execution.output as TextGenerateResult).text
      if (typeof reply === 'string') {
        setTextHistory((current) => ({
          ...current,
          [providerKey]: [
            ...(current[providerKey] ?? []),
            { role: 'user' as const, content: text },
            { role: 'assistant' as const, content: reply },
          ].slice(-40),
        }))
      }
    }
    return execution
  }

  const clearTextHistory = (providerId: string) => {
    setTextHistory((current) => {
      const next = { ...current }
      delete next[providerId]
      return next
    })
  }

  const runAudio = async (
    clip: AudioClip,
    capability:
      | 'speech.transcribe'
      | 'speech.detect'
      | 'audio.enhance'
      | 'audio.classify'
      | 'speech.keyword'
      | 'speech.language'
      | 'speaker.embed'
      | 'speaker.diarize'
      | 'audio.separate',
    providerId: string,
    modelId: string,
    modelParameters: Record<string, unknown>,
    conversationVisible = true,
    dependencyRunIds: string[] = [],
    comparisonClip?: AudioClip,
  ): Promise<
    HarnessExecution<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >
  > => {
    const audioDataUrl =
      capability === 'speech.transcribe' || capability === 'speech.detect'
        ? clip.transcriptionAudioUrl
        : clip.processingAudioUrl
    if (!audioDataUrl) {
      throw new Error('该音频无法解码为模型需要的 WAV 格式')
    }
    const comparisonAudioDataUrl = comparisonClip?.processingAudioUrl
    if (comparisonClip && !comparisonAudioDataUrl) {
      throw new Error('第二段音频无法解码为模型需要的 WAV 格式')
    }
    const { speechSegments, ...executionParameters } = modelParameters

    const execution = await executeHarnessTask<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >(
      {
        capability,
        providerId,
        conversationProviderId: selectedPlugin.providerId,
        conversationVisible,
        dependencyRunIds,
        routing: 'local',
        title:
          capability === 'speaker.embed' && comparisonClip
            ? `${clip.name} 与 ${comparisonClip.name} · 声纹比对`
            : capability === 'speech.transcribe'
            ? `${clip.name} · 语音识别`
            : capability === 'speech.detect'
              ? `${clip.name} · 语音活动检测`
            : `${clip.name} · 音频增强`,
        input: {
          audioDataUrl,
          clipName: clip.name,
          ...(comparisonAudioDataUrl
            ? {
                comparisonAudioDataUrl,
                comparisonClipName: comparisonClip.name,
              }
            : {}),
          ...(Array.isArray(speechSegments)
            ? { speechSegments }
            : {}),
        },
        parameters:
          capability === 'audio.enhance'
            ? {
                operations: ['denoise', 'normalize', 'fade'],
                denoiseStrength: 0.58,
                targetLoudnessDb: -16,
                fadeMs: 20,
                modelId,
                ...executionParameters,
              }
            : capability === 'speech.detect'
              ? {
                  threshold: 0.25,
                  minSpeechDuration: 0.18,
                  minSilenceDuration: 0.2,
                  modelId,
                  ...executionParameters,
                }
              : {
                  modelId,
                  ...executionParameters,
                },
      },
      (run) => {
        recordRun(run)
      },
    )
    recordRun(execution.run)
    return execution
  }

  const renderPluginSidebarEntry = (plugin: ModelPlugin) => {
    const group = modelSidebarGroup(plugin)
    const active =
      view === 'workspace' &&
      !workflowSelected &&
      selectedPlugin.id === plugin.id
    const apiPlugin = plugin.providerId?.startsWith('api.') === true
    const pinned = pinnedModelIds.includes(plugin.id)
    const running = runs.some(
      (run) =>
        run.conversationVisible !== false &&
        activeRunIds.has(run.id) &&
        (run.conversationProviderId ?? run.providerId) === plugin.providerId &&
        (!apiPlugin || run.modelId === plugin.version),
    )
    return (
      <div
        className={`installed-model-entry${draggingModelId === plugin.id ? ' dragging' : ''}${dropTargetModelId === plugin.id ? ' drop-target' : ''}`}
        draggable
        key={plugin.id}
        onDragStart={(event) => {
          setRailTooltip(null)
          setDraggingModelId(plugin.id)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            'application/cosy-sidebar-model',
            plugin.id,
          )
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (draggingModelId !== plugin.id) {
            setDropTargetModelId(plugin.id)
          }
        }}
        onDragLeave={() => {
          if (dropTargetModelId === plugin.id) {
            setDropTargetModelId(null)
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          const sourceId =
            event.dataTransfer.getData('application/cosy-sidebar-model') ||
            draggingModelId
          if (sourceId) reorderSidebarPlugin(sourceId, plugin.id)
          setDraggingModelId(null)
          setDropTargetModelId(null)
        }}
        onDragEnd={() => {
          setDraggingModelId(null)
          setDropTargetModelId(null)
        }}
      >
        <button
          className={`installed-model-button${active ? ' active' : ''}`}
          type="button"
          aria-label={plugin.name}
          onMouseEnter={(event) => {
            startModelNameScroll(event.currentTarget)
            const bounds = event.currentTarget.getBoundingClientRect()
            setRailTooltip({
              name: plugin.name,
              detail: plugin.capabilities.slice(0, 2).join(' · '),
              top: Math.min(window.innerHeight - 66, Math.max(8, bounds.top)),
            })
          }}
          onMouseLeave={(event) => {
            stopModelNameScroll(event.currentTarget)
            setRailTooltip(null)
          }}
          onFocus={(event) => {
            startModelNameScroll(event.currentTarget)
            const bounds = event.currentTarget.getBoundingClientRect()
            setRailTooltip({
              name: plugin.name,
              detail: plugin.capabilities.slice(0, 2).join(' · '),
              top: Math.min(window.innerHeight - 66, Math.max(8, bounds.top)),
            })
          }}
          onBlur={(event) => {
            stopModelNameScroll(event.currentTarget)
            setRailTooltip(null)
          }}
          onClick={() => {
            selectPlugin(plugin.id)
          }}
        >
          <span
            className="sidebar-model-icon"
            data-family={group}
            aria-hidden="true"
          >
            <ModelCapabilityIcon capability={plugin.harnessCapabilities[0]} />
          </span>
          <span className="activity-model-name">
            <span className="activity-model-name-text">
              {plugin.name}
            </span>
          </span>
        </button>
        {running && (
          <span
            className="installed-model-running"
            aria-label={`${plugin.name} 运行中`}
          >
            <LoaderCircle className="sidebar-model-spinner" size={14} />
          </span>
        )}
        {draggingModelId === null && (
          <div className={`installed-model-actions${pinned ? ' pinned' : ''}`}>
            <button
              className="installed-model-pin"
              type="button"
              aria-label={`${pinned ? '取消置顶' : '置顶'} ${plugin.name}`}
              title={pinned ? '取消置顶' : '置顶'}
              aria-pressed={pinned}
              draggable={false}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                togglePinnedModel(plugin.id)
              }}
            >
              <Pin
                size={14}
                strokeWidth={1.45}
                fill={pinned ? 'currentColor' : 'none'}
              />
            </button>
            <button
              className={`installed-model-remove${pendingSidebarRemovalId === plugin.id ? ' confirming' : ''}`}
              type="button"
              aria-label={`删除 ${plugin.name}`}
              title={
                running
                  ? '模型运行中，暂时无法删除'
                  : pendingSidebarRemovalId === plugin.id
                    ? '再次点击确认删除'
                    : '删除模型'
              }
              disabled={running}
              draggable={false}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                const references = referencingModels(plugin.id, [
                  ...plugins,
                  ...cloudModelPlugins,
                ], modelBindings)
                if (pendingSidebarRemovalId !== plugin.id) {
                  setPendingSidebarRemovalId(plugin.id)
                  notify(
                    apiPlugin
                      ? `再次点击垃圾桶确认从工作台移除 ${plugin.name}`
                      : references.length
                      ? `${plugin.name} 仍被引用；再次点击将隐藏模型并保留权重`
                      : `再次点击垃圾桶确认删除 ${plugin.name} 的模型权重`,
                  )
                  return
                }
                setPendingSidebarRemovalId(null)
                if (apiPlugin) {
                  setCloudModelInstalled(plugin.id, false)
                  notify(`${plugin.name} 已从侧栏移除`)
                } else {
                  void uninstallModelPlugin(plugin.id)
                    .then(({ plugins: next, removal }) => {
                      setPlugins(next)
                      if (removal.deleted) removeModelBindings(plugin.id)
                      notify(
                        removal.retained
                          ? `${plugin.name} 已隐藏；共享权重仍被 ${removal.referencedBy.length} 个模型引用`
                          : `${plugin.name} 的模型权重已删除`,
                      )
                    })
                    .catch((error) => {
                      notify(
                        `删除失败：${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      )
                    })
                }
              }}
            >
              <Trash2 size={14} strokeWidth={1.45} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`app-shell model-shell${usesOverlayTitlebar ? ' native-titlebar-enabled' : ''}`}
      data-theme={resolvedTheme}
      data-sidebar-collapsed={sidebarCanCollapse && sidebarCollapsed}
      style={
        {
          '--model-sidebar-width': `${visibleSidebarWidth}px`,
          '--model-content-offset': `${visibleContentOffset}px`,
        } as CSSProperties
      }
    >
      {usesOverlayTitlebar && (
        <div
          className="native-titlebar"
          data-tauri-drag-region
          aria-hidden="true"
        />
      )}
      {sidebarCanCollapse && (
        <>
          <div
            className={`sidebar-hover-edge${sidebarCollapsed && !sidebarPeek ? ' active' : ''}`}
            aria-hidden="true"
            onMouseEnter={openSidebarPeek}
            onMouseLeave={scheduleSidebarPeekClose}
          />
          <button
            className="sidebar-collapse-button"
            type="button"
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onMouseEnter={handleSidebarButtonEnter}
            onMouseLeave={handleSidebarButtonLeave}
            onClick={toggleSidebarCollapsed}
          >
            <SidebarCollapseIcon collapsed={sidebarCollapsed} />
          </button>
        </>
      )}
      <aside
        className={`app-sidebar model-sidebar${sidebarOpen ? ' open' : ''}`}
        data-compact={sidebarCanCollapse && sidebarCollapsed && !sidebarPeek}
        data-peek={sidebarCanCollapse && sidebarCollapsed && sidebarPeek}
        onMouseEnter={sidebarCanCollapse ? openSidebarPeek : undefined}
        onMouseLeave={sidebarCanCollapse ? scheduleSidebarPeekClose : undefined}
      >
        <div className="activity-rail-title-spacer" data-tauri-drag-region>
          <div className="activity-rail-brand" data-tauri-drag-region>
            <span>QwenAudio Toolkits</span>
          </div>
        </div>

        <nav className="installed-models" aria-label="已安装模型">
          {SIDEBAR_MODEL_GROUPS.map((group) => {
            const models = groupedRunnablePlugins[group.id]
            if (!models.length) return null
            const collapsed = collapsedSidebarGroups.has(group.id)
            return (
              <section
                className="sidebar-model-group"
                key={group.id}
                aria-label={group.label}
              >
                <button
                  className="sidebar-model-group-label"
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleSidebarGroup(group.id)}
                >
                  {sidebarGroupIcon(group.id)}
                  <span>{group.label}</span>
                </button>
                {!collapsed && (
                  <div className="sidebar-model-group-items">
                    {models.map(renderPluginSidebarEntry)}
                  </div>
                )}
              </section>
            )
          })}
        </nav>

        <div className="sidebar-spacer" />

        <nav className="model-sidebar-utilities" aria-label="资源与设置">
          {WORKFLOWS_ENABLED && (
            <button
              className={view === 'workflows' ? 'active workflow' : 'workflow'}
              type="button"
              onClick={() => {
                setEditingWorkflowId(null)
                changeView('workflows')
              }}
            >
              <GitBranch size={17} />
              <span>流程编排</span>
            </button>
          )}
          <button
            className={view === 'plugins' ? 'active store' : 'store'}
            type="button"
            title="模型商店"
            aria-label="模型商店"
            onClick={() => changeView('plugins')}
          >
            <ShoppingBag size={17} />
            <span>模型商店</span>
          </button>
          <div className="sidebar-settings-row">
            <button
              className="sidebar-settings-button"
              type="button"
              title="设置"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={17} />
              <span>设置</span>
            </button>
            {(appUpdate.status === 'available' ||
              appUpdate.status === 'downloading' ||
              appUpdate.status === 'downloaded' ||
              appUpdate.status === 'installing') && (
              <button
                className={`sidebar-update-icon${
                  appUpdate.status === 'downloading' ? ' downloading' : ''
                }`}
                type="button"
                  title={
                    appUpdate.status === 'downloading'
                      ? appUpdate.progress === undefined
                        ? '正在下载安装包'
                        : `正在下载 ${Math.round(appUpdate.progress)}%`
                      : appUpdate.status === 'installing'
                        ? '正在安装更新'
                        : appUpdate.status === 'downloaded'
                          ? `重启安装 ${appUpdate.update?.version ?? ''}`
                          : `后台下载更新 ${appUpdate.update?.version ?? ''}`
                }
                  aria-label={
                    appUpdate.status === 'downloading'
                      ? '正在下载安装包'
                      : appUpdate.status === 'installing'
                        ? '正在安装更新'
                        : appUpdate.status === 'downloaded'
                          ? '重启安装新版本'
                          : '下载新版本'
                  }
                disabled={
                  appUpdate.status === 'downloading' ||
                  appUpdate.status === 'installing'
                }
                onClick={applyApplicationUpdate}
              >
                {appUpdate.status === 'downloading' ||
                appUpdate.status === 'installing' ? (
                  <LoaderCircle className="model-spin" size={14} />
                ) : (
                  <Download size={14} strokeWidth={2.2} />
                )}
              </button>
            )}
          </div>
        </nav>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          onPointerDown={beginSidebarResize}
        />
      </aside>

      {railTooltip && (
        <div
          className="activity-rail-tooltip"
          style={{ top: railTooltip.top, left: visibleSidebarWidth + 6 }}
        >
          <strong>{railTooltip.name}</strong>
          <span>{railTooltip.detail}</span>
        </div>
      )}

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="app-frame model-app-frame">
        <header className="topbar model-topbar" data-tauri-drag-region>
          <button
            className="mobile-menu-button"
            type="button"
            aria-label="打开导航"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="topbar-title">
            <span>
              {view === 'workspace'
                ? WORKFLOWS_ENABLED && workflowSelected
                  ? workflows.find(
                      (workflow) => workflow.id === selectedWorkflowId,
                    )?.name ?? '虚拟模型'
                  : selectedPlugin.name
                : view === 'workflows'
                  ? '流程编排'
                  : '模型商店'}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="model-runtime-state">
              <i />
              {isTauriRuntime() ? '本地运行' : '界面预览'}
            </span>
          </div>
        </header>

        <div className="view-container model-view-container">
          <Suspense
            fallback={
              <div className="app-view-loading" aria-label="正在加载">
                <LoaderCircle className="model-spin" size={19} />
              </div>
            }
          >
          {view === 'workspace' && (
            WORKFLOWS_ENABLED && workflowSelected && selectedWorkflowId ? (
              <WorkflowChatView
                workflowId={selectedWorkflowId}
                turns={workflowTurns[selectedWorkflowId] ?? []}
                setTurns={(update) =>
                  updateWorkflowTurns(selectedWorkflowId, update)
                }
                onRunUpdate={(run) =>
                  recordRun(run)
                }
                onAction={notify}
              />
            ) : (
              <ModelWorkspaceView
                plugin={selectedPlugin}
                plugins={plugins}
                modelBindings={modelBindings}
                catalog={catalog}
                runs={runs}
                onRunText={runText}
                onRunAudio={runAudio}
                onOpenStore={() => {
                  setApiConfigurationTargetId(
                    selectedPlugin.providerId?.startsWith('api.')
                      ? selectedPlugin.id
                      : null,
                  )
                  changeView('plugins')
                }}
                onAction={notify}
                onClearTextHistory={() =>
                  clearTextHistory(selectedPlugin.providerId ?? '')
                }
              />
            )
          )}
          {view === 'plugins' && (
            <PluginsView
              plugins={plugins}
              modelBindings={modelBindings}
              runtime={runtime}
              catalog={catalog}
              apiModelCatalog={apiModelCatalog}
              installedCloudModelIds={installedCloudModelIds}
              configureApiPluginId={apiConfigurationTargetId}
              onApiConfigurationHandled={() =>
                setApiConfigurationTargetId(null)
              }
              onPluginsChanged={setPlugins}
              onModelBindingsChanged={setModelBindings}
              onRemoveModelBindings={removeModelBindings}
              onSetModelBinding={saveModelBinding}
              onCatalogChanged={setCatalog}
              onCloudModelInstalled={setCloudModelInstalled}
              onAction={notify}
            />
          )}
          {WORKFLOWS_ENABLED && view === 'workflows' && (
            <WorkflowsView
              key={editingWorkflowId ?? 'new-workflow'}
              catalog={catalog}
              models={orderedRunnablePlugins}
              workflows={workflows}
              editingWorkflowId={editingWorkflowId}
              onWorkflowsChanged={(next, workflowId) => {
                setWorkflows(next)
                setEditingWorkflowId(workflowId)
                setSelectedWorkflowId(workflowId)
              }}
              onAction={notify}
            />
          )}
          </Suspense>
        </div>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span className="toast-mark">
            <AudioLines size={15} />
          </span>
          {toast}
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {settingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <section
            className="settings-dialog compact-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="dialog-heading">
              <div>
                <span className="section-kicker">APPLICATION</span>
                <h2 id="settings-title">设置</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭设置"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="settings-content">
              <div className="settings-row theme-settings-row">
                <span>
                  <strong>外观主题</strong>
                  <small>使用系统外观，或固定浅色与深色模式</small>
                </span>
                <div className="theme-segmented" aria-label="外观主题">
                  {(
                    [
                      ['system', Monitor, '跟随系统'],
                      ['light', Sun, '浅色'],
                      ['dark', Moon, '深色'],
                    ] as const
                  ).map(([theme, Icon, label]) => (
                    <button
                      className={themePreference === theme ? 'active' : ''}
                      type="button"
                      key={theme}
                      title={label}
                      aria-label={label}
                      aria-pressed={themePreference === theme}
                      onClick={() => selectTheme(theme)}
                    >
                      <Icon size={14} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span>
                  <strong>软件更新</strong>
                  <small>
                    {appUpdate.status === 'available'
                      ? `版本 ${appUpdate.update?.version} 已可用`
                      : appUpdate.status === 'downloading'
                        ? appUpdate.progress === undefined
                          ? '正在下载安装包'
                          : `正在下载 ${Math.round(appUpdate.progress)}%`
                        : appUpdate.status === 'downloaded'
                          ? `版本 ${appUpdate.update?.version} 已下载，点击重启安装`
                          : appUpdate.status === 'installing'
                            ? '正在安装更新'
                        : appUpdate.status === 'current'
                          ? `QwenAudio Toolkits ${runtime.version} 已是最新版`
                          : appUpdate.message ?? `当前版本 ${runtime.version}`}
                  </small>
                </span>
                <button
                  className="settings-update-action"
                  type="button"
                  disabled={
                    appUpdate.status === 'checking' ||
                    appUpdate.status === 'downloading' ||
                    appUpdate.status === 'installing' ||
                    appUpdate.status === 'unavailable'
                  }
                  onClick={() =>
                    appUpdate.status === 'available' ||
                    appUpdate.status === 'downloaded'
                      ? void applyApplicationUpdate()
                      : void checkApplicationUpdate()
                  }
                >
                  {appUpdate.status === 'checking' ||
                  appUpdate.status === 'downloading' ||
                  appUpdate.status === 'installing' ? (
                    <LoaderCircle className="model-spin" size={13} />
                  ) : appUpdate.status === 'available' ||
                    appUpdate.status === 'downloaded' ? (
                    <Download size={13} />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  {appUpdate.status === 'available'
                    ? '下载并安装'
                    : appUpdate.status === 'downloaded'
                      ? '重启安装'
                    : appUpdate.status === 'checking'
                      ? '检查中'
                        : appUpdate.status === 'downloading'
                          ? '下载中'
                          : appUpdate.status === 'installing'
                            ? '安装中'
                        : appUpdate.status === 'unavailable'
                          ? '开发版本'
                          : '检查更新'}
                </button>
              </div>
              <div className="settings-row">
                <span>
                  <strong>任务数据</strong>
                  <small>输入、结果和运行记录仅保存在本机</small>
                </span>
                <button
                  className="settings-danger-action"
                  type="button"
                  disabled={clearingHistory}
                  onClick={() => void clearAllHistory()}
                >
                  {clearingHistory ? (
                    <LoaderCircle className="model-spin" size={13} />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  清除历史
                </button>
              </div>
              <div className="settings-row">
                <span>
                  <strong>Harness Runtime</strong>
                  <small>{runtime.backend}</small>
                </span>
                <span className="settings-value ready">{runtime.apiUrl}</span>
              </div>
              <div className="settings-row">
                <span>
                  <strong>运行设备</strong>
                  <small>{runtime.platform}</small>
                </span>
                <span className="settings-value">{runtime.device}</span>
              </div>
              <button
                className="secondary-action full-width"
                type="button"
                onClick={() => {
                  setSettingsOpen(false)
                  changeView('plugins')
                }}
              >
                <ShoppingBag size={15} />
                管理模型与插件
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
