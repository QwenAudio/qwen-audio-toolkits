import {
  agentInstallRegistry,
  type AgentInstallationState,
} from './services/agentInstallState'
import {
  buildPythonAgentSidebarGroups,
  reconcilePythonAgentSelection,
} from './services/agentSidebarState'
import {
  extensionWorkbenchPageLabels,
  readExtensionWorkbenchEnabled,
  resolveExtensionWorkbenchPage,
  writeExtensionWorkbenchEnabled,
  type ExtensionWorkbenchPage,
} from './services/extensionWorkbenchState'
import { refreshThenPersistCloudModelState } from './services/extensionModelStoreLifecycle'
import { useWorkspaceCloseFlush, useWorkspaceReady } from './hooks/useProjectAutosave'
import { PythonAgentWorkspace } from './views/PythonAgentWorkspace'
import type { ExtensionExecutionContext } from './views/ExtensionWorkbenchView'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowLeft,
  AudioLines,
  Bot,
  Check,
  Download,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Menu,
  Monitor,
  Moon,
  Pin,
  RefreshCw,
  Palette,
  Settings,
  Settings2,
  ShoppingBag,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import {
  ProviderSettings,
} from './components/ProviderSettings'
import { initialPlugins, fallbackRuntime } from './data'
import { cloudModelsFromCatalog, isRetiredCloudModelId } from './cloudModels'
import { resolveRunnerAttribution } from './domain/executionAttribution'
import { modelTaxonomy } from './domain/modelTaxonomy'
import { setLocale, t, useLocale, type Locale } from './i18n'
import {
  appDataDirectory,
  cleanupDownloadCache,
  executeHarnessTask,
  deleteHarnessRun,
  getHarnessCatalog,
  getModelDependencyBindings,
  installAgentUi,
  installCatalogModel,
  installRecommendedModelDependency,
  isTauriRuntime,
  listApiModelCatalog,
  listAgentCatalog,
  listHarnessRuns,
  listInstalledAgentUi,
  listModelPlugins,
  refreshModelPlugins,
  replaceModelDependencyBindings,
  revealInFileManager,
  setCloseBehavior,
  setModelDependencyBinding,
  setModelPluginSidebarVisible,
  subscribeHarnessRuns,
  uninstallAgentUi,
  uninstallModelPlugin,
  type AgentCatalogEntry,
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
  CustomApiModelDefinition,
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
const AgentCatalogView = lazy(() =>
  import('./views/AgentCatalogView').then((module) => ({
    default: module.AgentCatalogView,
  })),
)
const ExtensionWorkbenchView = lazy(() =>
  import('./views/ExtensionWorkbenchView').then((module) => ({
    default: module.ExtensionWorkbenchView,
  })),
)
const ExtensionModelStoreView = lazy(() =>
  import('./views/ExtensionModelStoreView').then((module) => ({
    default: module.ExtensionModelStoreView,
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

type AppView = 'workspace' | 'workflows'
type AppRunnerMode = 'boss' | 'workbench'
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
const CUSTOM_API_MODELS_STORAGE_KEY =
  'qwen-audio-toolkits.custom-api-models-v1'
const RUNS_REMOVED_EVENT = 'harness-runs-removed'
const HISTORY_CLEARED_EVENT = 'harness-history-cleared'
const SIDEBAR_MODEL_ORDER_KEY = 'qwen-audio-toolkits.model-sidebar-order-v1'
const SIDEBAR_PINNED_MODELS_KEY = 'qwen-audio-toolkits.sidebar-pinned-models-v1'
const SIDEBAR_WIDTH_KEY = 'qwen-audio-toolkits.sidebar-width-v8'
const SIDEBAR_COLLAPSED_GROUPS_KEY =
  'qwen-audio-toolkits.sidebar-collapsed-groups-v1'
const THEME_STORAGE_KEY = 'qwen-audio-toolkits.theme-v1'
const ACCENT_STORAGE_KEY = 'qwen-audio-toolkits.accent-v1'
const SIDEBAR_DENSITY_STORAGE_KEY = 'qwen-audio-toolkits.sidebar-density-v1'
const CLOSE_BEHAVIOR_STORAGE_KEY = 'qwen-audio-toolkits.close-behavior-v1'
const AUTO_UPDATE_STORAGE_KEY = 'qwen-audio-toolkits.auto-update-v1'
const LAST_MODEL_STORAGE_KEY = 'qwen-audio-toolkits.last-model-v1'
const DEFAULT_VOICE_WORKFLOW_MODELS_KEY =
  'qwen-audio-toolkits.default-voice-workflow-models-v2'
const WORKFLOWS_ENABLED = false
const APP_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60_000
const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 160
const MAX_SIDEBAR_WIDTH = 520
const MIN_WORKSPACE_WIDTH = 480
const LOCALE_OPTIONS: ReadonlyArray<readonly [Locale, string]> = [
  ['zh-CN', '简体中文'],
  ['en', 'English'],
]

interface SidebarModelGroup {
  id: string
  label: string
  models: ModelPlugin[]
}

// 复用扩展页 taxonomy 分类（Audio-to-Text 等）作为侧边栏分组
const SIDEBAR_TAXONOMY_GROUP_ORDER = [
  'Audio-to-Text',
  'Text-to-Audio',
  'Audio-to-Audio',
  'Text-to-Text',
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

function getInitialAccent(): AccentColor {
  if (typeof window === 'undefined') return 'mint'
  try {
    const value = window.localStorage.getItem(ACCENT_STORAGE_KEY)
    return value === 'indigo' || value === 'amber' || value === 'rose'
      ? value
      : 'mint'
  } catch {
    return 'mint'
  }
}

function getInitialSidebarDensity(): SidebarDensity {
  if (typeof window === 'undefined') return 'comfortable'
  try {
    const value = window.localStorage.getItem(SIDEBAR_DENSITY_STORAGE_KEY)
    return value === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

function getInitialCloseBehavior(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(CLOSE_BEHAVIOR_STORAGE_KEY) === 'quit'
  } catch {
    return false
  }
}

function getInitialAutoUpdate(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(AUTO_UPDATE_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

function getInitialExtensionWorkbenchEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return readExtensionWorkbenchEnabled(window.localStorage)
  } catch {
    return false
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

function getInitialCollapsedSidebarGroups() {
  if (typeof window === 'undefined') return new Set<string>()
  try {
    const value = JSON.parse(
      window.localStorage.getItem(SIDEBAR_COLLAPSED_GROUPS_KEY) ?? '[]',
    )
    return new Set<string>(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [],
    )
  } catch {
    return new Set<string>()
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

function getInitialCustomApiModels(): CustomApiModelDefinition[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(
      window.localStorage.getItem(CUSTOM_API_MODELS_STORAGE_KEY) ?? '[]',
    )
    if (!Array.isArray(value)) return []
    return value.flatMap((item): CustomApiModelDefinition[] => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.modelId !== 'string' ||
        typeof item.providerId !== 'string' ||
        !item.providerId.startsWith('api.')
      ) {
        return []
      }
      const capability = [
        'text.generate',
        'speech.transcribe',
        'speech.synthesize',
      ].includes(item.capability)
        ? item.capability
        : 'text.generate'
      return [
        {
          id: item.id,
          name: item.name,
          modelId: item.modelId,
          providerId: item.providerId,
          capability,
          ...(typeof item.defaultVoice === 'string'
            ? { defaultVoice: item.defaultVoice }
            : {}),
        } as CustomApiModelDefinition,
      ]
    })
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

type ShellPage =
  | 'workspace'
  | 'extensions'
  | 'agent-catalog'
  | 'extension-workbench'
  | 'settings'
type SettingsSection = 'general' | 'appearance' | 'storage' | 'accounts'

type AccentColor = 'mint' | 'indigo' | 'amber' | 'rose'

const ACCENT_OPTIONS: {
  id: AccentColor
  label: string
  swatch: string
}[] = [
  { id: 'mint', label: '青瓷绿', swatch: '#4c7e6c' },
  { id: 'indigo', label: '靛蓝', swatch: '#4d63b0' },
  { id: 'amber', label: '琥珀', swatch: '#9a7a2f' },
  { id: 'rose', label: '玫瑰', swatch: '#a95f6f' },
]

type SidebarDensity = 'comfortable' | 'compact'

const SIDEBAR_DENSITY_OPTIONS: {
  id: SidebarDensity
  label: string
}[] = [
  { id: 'comfortable', label: '舒适' },
  { id: 'compact', label: '紧凑' },
]

const SETTINGS_SECTIONS: {
  id: SettingsSection
  label: string
  Icon: typeof Palette
}[] = [
  { id: 'general', label: '常规', Icon: Settings2 },
  { id: 'appearance', label: '外观', Icon: Palette },
  { id: 'storage', label: '模型与存储', Icon: HardDrive },
  { id: 'accounts', label: '账号与服务', Icon: Settings2 },
]

function App() {
  const locale = useLocale()
  const [view, setView] = useState<AppView>('workspace')
  const [shellPage, setShellPage] = useState<ShellPage>('workspace')
  const [agentCategory, setAgentCategory] = useState('all')
  const [expandedAgentCategory, setExpandedAgentCategory] = useState<string | null>(null)
  const [agentSecondary, setAgentSecondary] = useState('all')
  const [agentCatalog, setAgentCatalog] = useState<readonly AgentCatalogEntry[]>([])
  const [agentCatalogRefreshing, setAgentCatalogRefreshing] = useState(false)
  const [agentCatalogError, setAgentCatalogError] = useState<string | null>(null)
  const [pythonAgents, setPythonAgents] = useState<readonly AgentInstallationState[]>(
    () => agentInstallRegistry.snapshot(),
  )
  const refreshAgentCatalog = useCallback(async () => {
    if (!isTauriRuntime()) return
    setAgentCatalogRefreshing(true)
    setAgentCatalogError(null)
    try {
      const catalog = await listAgentCatalog()
      const entries = catalog.agents.map((entry) => ({
        id: entry.id,
        title: entry.name,
        description: entry.description,
        version: entry.version,
        category: entry.category,
      }))
      agentInstallRegistry.replaceCatalog(entries)
      setAgentCatalog(catalog.agents)
      await listInstalledAgentUi()
    } catch (error) {
      setAgentCatalogError(String(error))
    } finally {
      setAgentCatalogRefreshing(false)
    }
  }, [])
  useEffect(() => {
    const unsubscribe = agentInstallRegistry.subscribe(setPythonAgents)
    setPythonAgents(agentInstallRegistry.snapshot())
    if (isTauriRuntime()) {
      void refreshAgentCatalog()
    }
    return unsubscribe
  }, [refreshAgentCatalog])
  const visiblePythonAgents = useMemo(
    () => pythonAgents.filter((agent) => agent.status !== 'uninstalled'),
    [pythonAgents],
  )
  const [selectedPythonAgent, setSelectedPythonAgent] = useState<string | null>(null)
  const activePythonAgent = useMemo(
    () => reconcilePythonAgentSelection(selectedPythonAgent, pythonAgents),
    [pythonAgents, selectedPythonAgent],
  )
  useEffect(() => {
    if (selectedPythonAgent !== activePythonAgent) {
      setSelectedPythonAgent(activePythonAgent)
    }
  }, [activePythonAgent, selectedPythonAgent])

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
  const [customApiModels, setCustomApiModels] = useState<
    CustomApiModelDefinition[]
  >(getInitialCustomApiModels)
  const [modelBindings, setModelBindings] = useState<ModelDependencyBindings>(
    {},
  )
  const [modelBindingsLoaded, setModelBindingsLoaded] = useState(
    !isTauriRuntime(),
  )
  const [selectedPluginId, setSelectedPluginId] =
    useState(getInitialSelectedPluginId)
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
  const extensionsTriggerRef = useRef<HTMLButtonElement>(null)
  const agentCatalogTriggerRef = useRef<HTMLButtonElement>(null)
  const extensionWorkbenchTriggerRef = useRef<HTMLButtonElement>(null)
  const extensionsReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | 'all'>('all')
  const [clearingHistory, setClearingHistory] = useState(false)
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: 'idle' })
  const appUpdateStatusRef = useRef<AppUpdateState['status']>('idle')
  const [toast, setToast] = useState<string | null>(null)
  const repairingDependenciesRef = useRef(new Set<string>())
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getInitialTheme)
  const [accent, setAccent] = useState<AccentColor>(getInitialAccent)
  const [sidebarDensity, setSidebarDensity] = useState<SidebarDensity>(
    getInitialSidebarDensity,
  )
  const [quitOnClose, setQuitOnClose] = useState<boolean>(
    getInitialCloseBehavior,
  )
  const [autoUpdateCheck, setAutoUpdateCheck] = useState<boolean>(
    getInitialAutoUpdate,
  )
  const [extensionWorkbenchEnabled, setExtensionWorkbenchEnabled] =
    useState(getInitialExtensionWorkbenchEnabled)
  const [extensionWorkbenchPage, setExtensionWorkbenchPage] =
    useState<ExtensionWorkbenchPage>(
      () =>
        resolveExtensionWorkbenchPage(
          getInitialExtensionWorkbenchEnabled(),
          null,
        ) ?? 'models',
    )
  const workbenchWorkspaceReady = useWorkspaceReady(extensionWorkbenchEnabled)
  useWorkspaceCloseFlush(extensionWorkbenchEnabled)
  const [dataDirectory, setDataDirectory] = useState<string | null>(null)
  const [cleaningCache, setCleaningCache] = useState(false)
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
  const leaveShellPage = useCallback(() => {
    const leaving = shellPage
    setShellPage('workspace')
    const returnTarget = extensionsReturnFocusRef.current
    window.requestAnimationFrame(() => {
      const trigger =
        leaving === 'settings'
          ? settingsTriggerRef.current
          : leaving === 'agent-catalog'
            ? agentCatalogTriggerRef.current
          : leaving === 'extension-workbench'
            ? extensionWorkbenchTriggerRef.current
            : extensionsTriggerRef.current
      const target = returnTarget?.isConnected ? returnTarget : trigger
      target?.focus()
    })
  }, [shellPage])

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
    if (shellPage === 'workspace') return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      leaveShellPage()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [leaveShellPage, shellPage])

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

  useEffect(() => {
    document.documentElement.dataset.accent = accent
    document.documentElement.dataset.density = sidebarDensity
  }, [accent, sidebarDensity])

  const selectAccent = (value: AccentColor) => {
    setAccent(value)
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, value)
    } catch {
      // Keep the accent for the current session when storage is unavailable.
    }
  }

  const selectSidebarDensity = (value: SidebarDensity) => {
    setSidebarDensity(value)
    try {
      window.localStorage.setItem(SIDEBAR_DENSITY_STORAGE_KEY, value)
    } catch {
      // Keep the density for the current session when storage is unavailable.
    }
  }

  const selectCloseBehavior = (quit: boolean) => {
    setQuitOnClose(quit)
    try {
      window.localStorage.setItem(CLOSE_BEHAVIOR_STORAGE_KEY, quit ? 'quit' : 'dock')
    } catch {
      // Keep the preference for the current session when storage is unavailable.
    }
    if (isTauriRuntime()) {
      void setCloseBehavior(quit)
    }
  }

  const selectAutoUpdateCheck = (enabled: boolean) => {
    setAutoUpdateCheck(enabled)
    try {
      window.localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      // Keep the preference for the current session when storage is unavailable.
    }
  }

  const selectExtensionWorkbenchEnabled = (enabled: boolean) => {
    setExtensionWorkbenchEnabled(enabled)
    const resolvedPage = resolveExtensionWorkbenchPage(
      enabled,
      extensionWorkbenchPage,
    )
    if (resolvedPage) setExtensionWorkbenchPage(resolvedPage)
    try {
      writeExtensionWorkbenchEnabled(window.localStorage, enabled)
    } catch {
      // Keep the preference for the current session when storage is unavailable.
    }
    if (!enabled && shellPage === 'extension-workbench') {
      setShellPage('workspace')
      setView('workspace')
    }
  }

  const changeExtensionWorkbenchPage = (page: ExtensionWorkbenchPage) => {
    const resolvedPage = resolveExtensionWorkbenchPage(
      extensionWorkbenchEnabled,
      page,
    )
    if (resolvedPage) setExtensionWorkbenchPage(resolvedPage)
  }

  const revealDataDirectory = async () => {
    if (!dataDirectory) return
    try {
      await revealInFileManager(dataDirectory)
    } catch (error) {
      notify(
        `无法打开数据目录：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const cleanDownloadCache = async () => {
    setCleaningCache(true)
    try {
      const removed = await cleanupDownloadCache()
      notify(removed > 0 ? `已清理 ${removed} 个下载缓存文件` : '没有可清理的下载缓存')
    } catch (error) {
      notify(
        `清理下载缓存失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setCleaningCache(false)
    }
  }

  const cloudModelPlugins = useMemo<ModelPlugin[]>(() => {
    return cloudModelsFromCatalog(
      catalog,
      installedCloudModelIds,
      apiModelCatalog,
      customApiModels,
    ).filter((plugin) => plugin.installed)
  }, [apiModelCatalog, catalog, customApiModels, installedCloudModelIds])

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
          plugins,
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

  const saveModelDependencyBinding = async (
    pluginId: string,
    role: string,
    dependencyId: string,
  ) => {
    const next = await setModelDependencyBinding(pluginId, role, dependencyId)
    setModelBindings(next)
  }

  const refreshModelStore = async (): Promise<void> => {
    const [nextPlugins, nextCatalog] = await Promise.all([
      listModelPlugins(),
      getHarnessCatalog(),
    ])
    setPlugins(nextPlugins)
    setCatalog(nextCatalog)
  }
  const installModelStoreModel = (
    pluginId: string,
    variantId?: string,
  ) => installCatalogModel(pluginId, variantId)
  const installModelStoreDependency = async (
    dependencyId: string,
  ): Promise<void> => {
    await installRecommendedModelDependency(dependencyId)
  }
  const restoreModelStoreModel = async (pluginId: string): Promise<void> => {
    await setModelPluginSidebarVisible(pluginId, true)
  }
  const uninstallModelStoreModel = async (pluginId: string) => {
    const { plugins: nextPlugins, removal } = await uninstallModelPlugin(pluginId)
    setPlugins(nextPlugins)
    if (removal.deleted) removeModelBindings(pluginId)
    setCatalog(await getHarnessCatalog())
    return removal
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
  const sidebarModelGroups = useMemo<SidebarModelGroup[]>(() => {
    const taxonomyGroups = new Map<string, ModelPlugin[]>()
    for (const plugin of orderedRunnablePlugins) {
      if (pinnedModelIds.includes(plugin.id)) continue
      const label = modelTaxonomy(plugin).secondaryCategory
      const models = taxonomyGroups.get(label) ?? []
      models.push(plugin)
      taxonomyGroups.set(label, models)
    }
    const rank = (label: string) => {
      const index = SIDEBAR_TAXONOMY_GROUP_ORDER.indexOf(label)
      return index === -1 ? SIDEBAR_TAXONOMY_GROUP_ORDER.length : index
    }
    const orderedLabels = [...taxonomyGroups.keys()].sort(
      (left, right) => rank(left) - rank(right) || left.localeCompare(right),
    )
    return [
      {
        id: 'pinned',
        label: '已置顶',
        models: orderedRunnablePlugins.filter((plugin) =>
          pinnedModelIds.includes(plugin.id),
        ),
      },
      ...orderedLabels.map((label) => ({
        id: label,
        label,
        models: taxonomyGroups.get(label) ?? [],
      })),
    ]
  }, [pinnedModelIds, orderedRunnablePlugins])
  const sidebarAgentGroups = useMemo(() => {
    const definitions = [
      ...plugins,
      ...cloudModelsFromCatalog(
        catalog,
        installedCloudModelIds,
        apiModelCatalog,
        customApiModels,
      ),
    ]
    return buildPythonAgentSidebarGroups({
      modelGroups: sidebarModelGroups,
      agents: visiblePythonAgents,
      definitions,
      groupOrder: SIDEBAR_TAXONOMY_GROUP_ORDER,
      categoryForModel: (model) => modelTaxonomy(model).secondaryCategory,
    })
  }, [sidebarModelGroups, visiblePythonAgents, plugins, catalog, installedCloudModelIds, apiModelCatalog, customApiModels])
  const responsiveSidebarMaxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.floor(viewportWidth - MIN_WORKSPACE_WIDTH),
    ),
  )
  const visibleSidebarWidth = Math.min(sidebarWidth, responsiveSidebarMaxWidth)
  const visibleContentOffset = viewportWidth <= 900 ? 0 : visibleSidebarWidth

  const toggleSidebarGroup = (groupId: string) => {
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
          plugins,
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
            plugins,
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

    let disposed = false
    const refreshCatalog = () => {
      void refreshModelPlugins()
        .then((nextPlugins) => {
          if (!disposed) setPlugins(nextPlugins)
          return listApiModelCatalog()
        })
        .then((nextApiModels) => {
          if (!disposed) setApiModelCatalog(nextApiModels)
        })
        .catch(() => {
          // Cached or built-in catalog remains available when the remote source is offline.
        })
    }

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
    refreshCatalog()
    const catalogRefreshTimer = window.setInterval(
      refreshCatalog,
      MODEL_CATALOG_REFRESH_INTERVAL_MS,
    )

    let unlisten: (() => void) | undefined
    void subscribeHarnessRuns((run) => {
      if (disposed) return
      recordRun(run)
    }).then((remove) => {
      if (disposed) remove()
      else unlisten = remove
    })

    let unlistenRemoved: (() => void) | undefined
    void listen<string[]>(RUNS_REMOVED_EVENT, (event) => {
      if (disposed) return
      const removed = new Set(event.payload)
      setRuns((current) => {
        const next = current.filter((run) => !removed.has(run.id))
        return next.length === current.length ? current : next
      })
    }).then((remove) => {
      if (disposed) remove()
      else unlistenRemoved = remove
    })

    let unlistenHistoryCleared: (() => void) | undefined
    void listen(HISTORY_CLEARED_EVENT, () => {
      if (disposed) return
      setRuns((current) => (current.length ? [] : current))
      setWorkflowTurns((current) =>
        Object.keys(current).length ? {} : current,
      )
    }).then((remove) => {
      if (disposed) remove()
      else unlistenHistoryCleared = remove
    })

    // Fallback: whenever this window regains focus, re-sync history from the backend so
    // clears performed in another window are reflected even if an event was missed.
    const refetchRunsOnFocus = () => {
      if (disposed || !isTauriRuntime()) return
      void listHarnessRuns()
        .then((nextRuns) => {
          if (!disposed) setRuns(nextRuns.map(summarizeRun))
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refetchRunsOnFocus)

    return () => {
      disposed = true
      window.clearInterval(catalogRefreshTimer)
      window.removeEventListener('focus', refetchRunsOnFocus)
      unlisten?.()
      unlistenRemoved?.()
      unlistenHistoryCleared?.()
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
    if (!import.meta.env.PROD || !isTauriRuntime() || !autoUpdateCheck) {
      return undefined
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUpdateCheck])

  useEffect(() => {
    if (!isTauriRuntime()) return
    void setCloseBehavior(getInitialCloseBehavior())
  }, [])

  useEffect(() => {
    if (shellPage !== 'settings' || (settingsSection !== 'storage' && settingsSection !== 'all')) return
    if (!isTauriRuntime() || dataDirectory !== null) return
    let disposed = false
    void appDataDirectory()
      .then((dir) => {
        if (!disposed) setDataDirectory(dir)
      })
      .catch(() => {
        if (!disposed) setDataDirectory('')
      })
    return () => {
      disposed = true
    }
  }, [shellPage, settingsSection, dataDirectory])

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    let nextWidth = sidebarWidth
    let finished = false
    document.body.classList.add('sidebar-resizing')
    handle.setPointerCapture(pointerId)

    function resize(pointerEvent: PointerEvent) {
      nextWidth = Math.min(
        responsiveSidebarMaxWidth,
        Math.max(MIN_SIDEBAR_WIDTH, pointerEvent.clientX),
      )
      setSidebarWidth(nextWidth)
    }

    function finish() {
      if (finished) return
      finished = true
      document.body.classList.remove('sidebar-resizing')
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      handle.removeEventListener('lostpointercapture', finish)
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth))
      } catch {
        // Keep the resized width for the current session.
      }
    }

    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    handle.addEventListener('lostpointercapture', finish)
  }
  const changeView = (next: AppView) => {
    setView(next)
    setSidebarOpen(false)
  }
  const syncExtensionsState = useCallback(async () => {
    try {
      const [nextPlugins, nextCatalog, nextApiModels, nextBindings] =
        await Promise.all([
          listModelPlugins(),
          getHarnessCatalog(),
          listApiModelCatalog(),
          getModelDependencyBindings(),
        ])
      setPlugins(nextPlugins)
      setPluginsLoaded(true)
      setCatalog(nextCatalog)
      setApiModelCatalog(nextApiModels)
      setModelBindings(nextBindings)
      setModelBindingsLoaded(true)
      setInstalledCloudModelIds(getInitialCloudModels())
      setCustomApiModels(getInitialCustomApiModels())
    } catch (error) {
      setToast(
        `无法同步扩展状态：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<{ stage: string }>('plugin-install-progress', (event) => {
      if (!disposed && event.payload.stage === 'complete') {
        void syncExtensionsState()
      }
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [syncExtensionsState])
  const openShellPage = (page: Exclude<ShellPage, 'workspace'>) => {
    if (shellPage === 'workspace' && document.activeElement instanceof HTMLElement) {
      extensionsReturnFocusRef.current = document.activeElement
    }
    setShellPage(page)
    setSidebarOpen(false)
  }
  const openExtensions = () => openShellPage('extensions')
  const openAgentCatalog = () => openShellPage('agent-catalog')
  const openExtensionWorkbench = () => {
    const resolvedPage = resolveExtensionWorkbenchPage(
      extensionWorkbenchEnabled,
      extensionWorkbenchPage,
    )
    if (!resolvedPage) return
    setExtensionWorkbenchPage(resolvedPage)
    openShellPage('extension-workbench')
  }
  const openExtensionModelStore = () => {
    if (!extensionWorkbenchEnabled) return
    setExtensionWorkbenchPage('models')
    if (shellPage !== 'extension-workbench') {
      openShellPage('extension-workbench')
    }
  }
  const openSettings = () => {
    setSettingsSection('all')
    openShellPage('settings')
  }

  const openProviderSettings = (providerId: string) => {
    if (providerId === 'api.openai-compatible' || providerId.startsWith('api.custom.')) {
      notify('通用自定义服务配置已移除，请在对应 Agent 中配置账号。')
      return
    }
    setSettingsSection('accounts')
    openShellPage('settings')
  }

  const notifyModelStoreProviderConfiguration = (providerId: string) => {
    const providerName =
      catalog?.providers.find((provider) => provider.id === providerId)?.name ??
      providerId
    notify(t('{0} 尚未配置；请完成账号配置后返回当前模型商店。', [providerName]))
  }

  const selectPlugin = (pluginId: string) => {
    setSelectedPythonAgent(null)
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
      if (isTauriRuntime()) {
        void emit(HISTORY_CLEARED_EVENT, {}).catch(() => undefined)
      }
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
    runnerMode: AppRunnerMode = 'boss',
  ): Promise<
    HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>
  > => {
    const attribution = resolveRunnerAttribution({
      mode: runnerMode,
      providerId,
      modelId,
      selectedPlugin,
      plugins,
    })
    const providerKey = selectedPlugin.providerId ?? ''
    const history =
      capability === 'text.generate' && attribution.readsBossTextHistory
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
            ...(attribution.includesSystemPrompt && systemPrompt
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
        conversationProviderId: attribution.conversationProviderId,
        conversationVisible,
        dependencyRunIds,
        routing: capability === 'text.generate' ? 'quality' : 'local',
        title: `${attribution.titlePluginName} · ${
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
    if (capability === 'text.generate' && attribution.appendsBossTextHistory) {
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

  const clearConversationRuns = async (runIds: string[]): Promise<boolean> => {
    const removableIds = runIds.filter((id) => !activeRunIds.has(id))
    if (!removableIds.length) {
      notify('当前没有可清除的对话记录')
      return false
    }
    if (!window.confirm(`确定清除当前模型的 ${removableIds.length} 条对话记录吗？`)) {
      return false
    }
    try {
      await Promise.all(removableIds.map((id) => deleteHarnessRun(id)))
      const removed = new Set(removableIds)
      setRuns((current) => current.filter((run) => !removed.has(run.id)))
      if (isTauriRuntime()) {
        void emit(RUNS_REMOVED_EVENT, removableIds).catch(() => undefined)
      }
      notify('当前模型的对话记录已清除')
      return true
    } catch (error) {
      notify(`清除失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
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
    runnerMode: AppRunnerMode = 'boss',
  ): Promise<
    HarnessExecution<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >
  > => {
    const attribution = resolveRunnerAttribution({
      mode: runnerMode,
      providerId,
      modelId,
      selectedPlugin,
      plugins,
    })
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
        conversationProviderId: attribution.conversationProviderId,
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
          duration: clip.duration,
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

  const runWorkbenchText: ExtensionExecutionContext['runText'] = (
    text,
    capability,
    providerId,
    modelId,
    modelParameters,
    dependencyRunIds,
    conversationVisible,
  ) =>
    runText(
      text,
      capability,
      providerId,
      modelId,
      modelParameters,
      dependencyRunIds,
      conversationVisible,
      'workbench',
    )
  const runWorkbenchAudio: ExtensionExecutionContext['runAudio'] = (
    clip,
    capability,
    providerId,
    modelId,
    modelParameters,
    conversationVisible,
    dependencyRunIds,
    comparisonClip,
  ) =>
    runAudio(
      clip,
      capability,
      providerId,
      modelId,
      modelParameters,
      conversationVisible,
      dependencyRunIds,
      comparisonClip,
      'workbench',
    )

  const extensionExecutionContext: ExtensionExecutionContext = {
    models: orderedRunnablePlugins,
    catalog,
    runText: runWorkbenchText,
    runAudio: runWorkbenchAudio,
    openModelStore: openExtensionModelStore,
    notify,
  }

  const renderPluginSidebarEntry = (plugin: ModelPlugin) => {
    const active =
      view === 'workspace' &&
      !workflowSelected &&
      !activePythonAgent &&
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
          title={plugin.name}
          aria-current={active ? 'page' : undefined}
          onMouseEnter={(event) => {
            startModelNameScroll(event.currentTarget)
          }}
          onMouseLeave={(event) => {
            stopModelNameScroll(event.currentTarget)
          }}
          onFocus={(event) => {
            startModelNameScroll(event.currentTarget)
          }}
          onBlur={(event) => {
            stopModelNameScroll(event.currentTarget)
          }}
          onClick={() => {
            setSelectedPythonAgent(null)
            selectPlugin(plugin.id)
          }}
        >
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
                  void refreshThenPersistCloudModelState({
                    refreshModels: refreshModelStore,
                    persistCloudState: () =>
                      setCloudModelInstalled(plugin.id, false),
                  })
                    .then(() => notify(`${plugin.name} 已从侧栏移除`))
                    .catch((error) =>
                      notify(
                        `移除失败：${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      ),
                    )
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

  const settingsRows: Record<SettingsSection, ReactNode> = {
    accounts: <div className="provider-account-dialog provider-account-page">
      <p className="account-dialog-description">管理 Agent 使用的云端服务账号。配置后返回 Agent 即可使用。</p>
      <ProviderSettings onCatalogChanged={setCatalog} onAction={notify} />
    </div>,
    general: (
      <>
        <div className="settings-card">
        <div className="settings-row">
          <span>
            <strong>界面语言</strong>
            <small>选择界面显示语言，立即生效</small>
          </span>
          <div className="settings-segmented" aria-label="界面语言">
            {LOCALE_OPTIONS.map(([value, label]) => (
              <button
                className={locale === value ? 'active' : ''}
                type="button"
                key={value}
                lang={value}
                aria-pressed={locale === value}
                onClick={() => setLocale(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>
            <strong>关闭窗口时</strong>
            <small>隐藏到程序坞可以快速唤回，退出则完全关闭应用</small>
          </span>
          <div className="settings-segmented" aria-label="关闭窗口时">
            {(
              [
                [false, '隐藏到程序坞'],
                [true, '退出应用'],
              ] as const
            ).map(([quit, label]) => (
              <button
                className={quitOnClose === quit ? 'active' : ''}
                type="button"
                key={label}
                aria-pressed={quitOnClose === quit}
                onClick={() => selectCloseBehavior(quit)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>
            <strong>自动检查更新</strong>
            <small>应用运行期间定期检查是否有新版本</small>
          </span>
          <button
            className="settings-switch"
            type="button"
            role="switch"
            aria-checked={autoUpdateCheck}
            aria-label="自动检查更新"
            onClick={() => selectAutoUpdateCheck(!autoUpdateCheck)}
          />
        </div>
        <div className="settings-row">
          <span>
            <strong>{t('扩展工作台')}</strong>
            <small>{t('启用后可从程序坞访问扩展工具')}</small>
          </span>
          <button
            className="settings-switch"
            type="button"
            role="switch"
            aria-checked={extensionWorkbenchEnabled}
            aria-label={t('扩展工作台')}
            onClick={() =>
              selectExtensionWorkbenchEnabled(!extensionWorkbenchEnabled)
            }
          />
        </div>
        </div>
        <div className="settings-group-label">更新与数据</div>
        <div className="settings-card">
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
          <strong>应用版本</strong>
          <small>QwenAudio Toolkits 桌面版</small>
        </span>
        <span className="settings-value">v{runtime.version}</span>
      </div>
      </div>
      <div className="settings-group-label">运行环境</div>
      <div className="settings-card">
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
      </div>
      </>
    ),
    appearance: (
      <>
        <div className="settings-card">
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
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <span>
          <strong>强调色</strong>
          <small>按钮、选中项与高亮状态使用的主题色</small>
        </span>
        <div className="accent-swatches" aria-label="强调色">
          {ACCENT_OPTIONS.map(({ id, label, swatch }) => (
            <button
              className={`accent-swatch${accent === id ? ' active' : ''}`}
              type="button"
              key={id}
              title={label}
              aria-label={label}
              aria-pressed={accent === id}
              style={{ '--swatch': swatch } as CSSProperties}
              onClick={() => selectAccent(id)}
            >
              {accent === id && <Check size={12} strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <span>
          <strong>侧边栏密度</strong>
          <small>紧凑模式可以在模型列表中显示更多条目</small>
        </span>
        <div className="settings-segmented" aria-label="侧边栏密度">
          {SIDEBAR_DENSITY_OPTIONS.map(({ id, label }) => (
            <button
              className={sidebarDensity === id ? 'active' : ''}
              type="button"
              key={id}
              aria-pressed={sidebarDensity === id}
              onClick={() => selectSidebarDensity(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      </div>
      </>
    ),
    storage: (
      <>
        <div className="settings-card">
        <div className="settings-row">
          <span>
            <strong>模型与数据目录</strong>
            <small>
              {dataDirectory === null
                ? '正在读取目录位置…'
                : dataDirectory || '仅桌面版可查看数据目录'}
            </small>
          </span>
          <button
            className="settings-update-action"
            type="button"
            disabled={!dataDirectory}
            onClick={() => void revealDataDirectory()}
          >
            在访达中显示
          </button>
        </div>
        <div className="settings-row">
          <span>
            <strong>下载缓存</strong>
            <small>已完成的模型安装包会保留在本地，可手动清理以释放空间</small>
          </span>
          <button
            className="settings-update-action"
            type="button"
            disabled={cleaningCache || !isTauriRuntime()}
            onClick={() => void cleanDownloadCache()}
          >
            {cleaningCache ? (
              <LoaderCircle className="model-spin" size={13} />
            ) : null}
            清理缓存
          </button>
        </div>
        </div>
      </>
    ),
  }
  const activeSettingsSection =
    SETTINGS_SECTIONS.find((section) => section.id === settingsSection) ??
    { label: '全部' }

  return (
    <div
      className={`app-shell model-shell${usesOverlayTitlebar ? ' native-titlebar-enabled' : ''} shell-page-${shellPage}`}
      data-theme={resolvedTheme}
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
      <aside
        className={`app-sidebar model-sidebar${sidebarOpen ? ' open' : ''}`}
      >
        <div className="activity-rail-title-spacer" data-tauri-drag-region />

        {shellPage !== 'workspace' && (
          <div className="sidebar-page-nav">
            <button
              className="sidebar-back-button"
              type="button"
              autoFocus
              onClick={leaveShellPage}
            >
              <ArrowLeft size={15} />
              <span>返回</span>
            </button>
            {shellPage === 'agent-catalog' ? (
              <nav className="sidebar-page-nav-body settings-nav" aria-label="Agent 分类">
                {[['all', '全部'], ...[...new Set(agentCatalog.map((agent) => agent.category))].sort().map((category) => [category, category])].map(([id, label]) => {
                  const selected = agentCategory === id
                  const expanded = expandedAgentCategory === id
                  const children: string[] = []
                  return <div key={id}>
                    <button className={selected ? 'active' : ''} aria-expanded={id === 'all' ? undefined : expanded} onClick={() => { setExpandedAgentCategory(current => id === 'all' || current === id ? null : id); setAgentCategory(id); setAgentSecondary('all') }} aria-current={selected && agentSecondary === 'all' ? 'page' : undefined}><span aria-hidden="true">{id === 'all' ? '' : expanded ? '⌄' : '›'}</span><span>{label}</span></button>
                    {expanded && id !== 'all' && <div className="taxonomy-secondary-group">{children.map(child => <button key={child} className={agentSecondary === child ? 'active' : ''} aria-current={agentSecondary === child ? 'page' : undefined} onClick={() => setAgentSecondary(child)}>{child}</button>)}</div>}
                  </div>
                })}
              </nav>
            ) : shellPage === 'settings' ? (
              <nav
                className="sidebar-page-nav-body settings-nav"
                aria-label="设置分类"
              >
                <button
                  className={settingsSection === 'all' ? 'active' : ''}
                  type="button"
                  aria-current={settingsSection === 'all' ? 'page' : undefined}
                  onClick={() => setSettingsSection('all')}
                >
                  <span>全部</span>
                </button>
                {SETTINGS_SECTIONS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={settingsSection === id ? 'active' : ''}
                    type="button"
                    aria-current={settingsSection === id ? 'page' : undefined}
                    onClick={() => setSettingsSection(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
            ) : null}
          </div>
        )}


        {shellPage === 'workspace' && (
        <nav className="installed-models" aria-label="已安装 Agents">
          {sidebarAgentGroups.map((group) => {
            const models = group.models
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
                  <span>{group.label}</span>
                  <span className="sidebar-group-count">{models.length + group.agents.length}</span>
                </button>
                {!collapsed && (
                  <div className="sidebar-model-group-items">
                    {models.map(renderPluginSidebarEntry)}
                    {group.agents.map(agent => <div key={agent.id} className="installed-model-entry python-agent-entry">
                      <button className={`installed-model-button${activePythonAgent === agent.id ? ' active' : ''}`} title={agent.error ?? agent.title} disabled={agent.status === 'installing' || agent.status === 'uninstalling'} aria-current={activePythonAgent === agent.id ? 'page' : undefined} onClick={() => { if (agent.status === 'error') { openAgentCatalog(); return }; setSelectedPythonAgent(agent.id); setView('workspace'); setWorkflowSelected(false) }}><span className="activity-model-name"><span className="activity-model-name-text">{agent.title}</span></span></button>
                      <span className="python-agent-action">{agent.status === 'installing' ? <span className="python-agent-progress" title="安装中"><LoaderCircle size={14} className="model-spin" /><span className="agent-install-label">安装中</span></span> : agent.status === 'error' ? <span className="agent-install-label" title={agent.error}>安装失败</span> : <button className="installed-model-pin" aria-label={`卸载 ${agent.title}`} title="卸载" disabled={agent.status === 'uninstalling'} onClick={() => {
                        void uninstallAgentUi(agent.id).then(() => {
                          if (selectedPythonAgent === agent.id) setSelectedPythonAgent(null)
                          notify(`${agent.title} 已卸载`)
                        }).catch(error => notify(`卸载失败：${String(error)}`))
                      }}>{agent.status === 'uninstalling' ? <LoaderCircle size={14} className="model-spin" /> : <Trash2 size={14} />}</button>}</span>
                    </div>)}
                  </div>
                )}
              </section>
            )
          })}
        </nav>
        )}

        {shellPage === 'workspace' && <div className="sidebar-spacer" />}

        <nav className="sidebar-dock" aria-label="资源与设置">
          <button
            ref={extensionsTriggerRef}
            className={`sidebar-dock-button${shellPage === 'extensions' ? ' active' : ''}`}
            type="button"
            aria-label="模型商店"
            aria-pressed={shellPage === 'extensions'}
            data-tooltip="模型商店"
            onClick={shellPage === 'extensions' ? leaveShellPage : openExtensions}
          >
            <ShoppingBag size={18} />
          </button>
          <button
            ref={agentCatalogTriggerRef}
            className={`sidebar-dock-button${shellPage === 'agent-catalog' ? ' active' : ''}`}
            type="button"
            aria-label="Agents"
            aria-pressed={shellPage === 'agent-catalog'}
            data-tooltip="Agents"
            onClick={shellPage === 'agent-catalog' ? leaveShellPage : openAgentCatalog}
          >
            <Bot size={18} />
          </button>
          {extensionWorkbenchEnabled && (
            <button
              ref={extensionWorkbenchTriggerRef}
              className={`sidebar-dock-button${
                shellPage === 'extension-workbench' ? ' active' : ''
              }`}
              type="button"
              aria-label={t('扩展工作台')}
              aria-pressed={shellPage === 'extension-workbench'}
              data-tooltip={t('扩展工作台')}
              onClick={
                shellPage === 'extension-workbench'
                  ? leaveShellPage
                  : openExtensionWorkbench
              }
            >
              <Settings2 size={18} />
            </button>
          )}
          <button
            ref={settingsTriggerRef}
            className={`sidebar-dock-button${shellPage === 'settings' ? ' active' : ''}`}
            type="button"
            aria-label="设置"
            aria-pressed={shellPage === 'settings'}
            data-tooltip="设置"
            onClick={shellPage === 'settings' ? leaveShellPage : openSettings}
          >
            <Settings size={18} />
          </button>
          {WORKFLOWS_ENABLED && (
            <button
              className={`sidebar-dock-button${
                shellPage === 'workspace' && view === 'workflows' ? ' active' : ''
              }`}
              type="button"
              aria-label="流程编排"
              data-tooltip="流程编排"
              onClick={() => {
                setEditingWorkflowId(null)
                changeView('workflows')
              }}
            >
              <GitBranch size={18} />
            </button>
          )}
          {(appUpdate.status === 'available' ||
            appUpdate.status === 'downloading' ||
            appUpdate.status === 'downloaded' ||
            appUpdate.status === 'installing') && (
            <button
              className={`sidebar-dock-button sidebar-update-icon${
                appUpdate.status === 'downloading' ? ' downloading' : ''
              }`}
              type="button"
              data-tooltip={
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
                <LoaderCircle className="model-spin" size={16} />
              ) : (
                <Download size={16} strokeWidth={2.2} />
              )}
            </button>
          )}
        </nav>
        <div
          className="sidebar-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={responsiveSidebarMaxWidth}
          aria-valuenow={visibleSidebarWidth}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const direction = event.key === 'ArrowLeft' ? -1 : 1
            const nextWidth = Math.min(
              responsiveSidebarMaxWidth,
              Math.max(
                MIN_SIDEBAR_WIDTH,
                visibleSidebarWidth + direction * 16,
              ),
            )
            setSidebarWidth(nextWidth)
            try {
              window.localStorage.setItem(
                SIDEBAR_WIDTH_KEY,
                String(nextWidth),
              )
            } catch {
              // Keep the resized width for the current session.
            }
          }}
          onPointerDown={beginSidebarResize}
        />
      </aside>

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
              {shellPage === 'extensions'
                ? '模型商店'
                : shellPage === 'agent-catalog'
                  ? 'Agents'
                : shellPage === 'extension-workbench'
                  ? t(extensionWorkbenchPageLabels[extensionWorkbenchPage])
                  : shellPage === 'settings'
                    ? `设置 · ${activeSettingsSection.label}`
                    : view === 'workspace'
                ? WORKFLOWS_ENABLED && workflowSelected
                  ? workflows.find(
                      (workflow) => workflow.id === selectedWorkflowId,
                    )?.name ?? '虚拟模型'
                  : pythonAgents.find(agent => agent.id === activePythonAgent)?.title ?? selectedPlugin.name
                : '流程编排'}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="model-runtime-state">
              <i />
              {isTauriRuntime() ? '本地运行' : '界面预览'}
            </span>
          </div>
        </header>

        <div
          className={`view-container model-view-container${shellPage !== 'workspace' ? ` page-${shellPage}` : ''}`}
        >
          <Suspense
            fallback={
              <div className="app-view-loading" aria-label="正在加载">
                <LoaderCircle className="model-spin" size={19} />
              </div>
            }
          >
          {shellPage === 'extensions' && (
            <ExtensionModelStoreView
              catalogKind="models"
              plugins={plugins}
              modelBindings={modelBindings}
              runtime={runtime}
              catalog={catalog}
              apiModelCatalog={apiModelCatalog}
              customApiModels={customApiModels}
              installedCloudModelIds={installedCloudModelIds}
              onConfigureProvider={notifyModelStoreProviderConfiguration}
              onRefreshModels={refreshModelStore}
              onInstallModel={installModelStoreModel}
              onInstallModelDependency={installModelStoreDependency}
              onRestoreModel={restoreModelStoreModel}
              onUninstallModel={uninstallModelStoreModel}
              onSetModelBinding={saveModelDependencyBinding}
              onCloudModelInstalled={setCloudModelInstalled}
              onAction={notify}
            />
          )}
          {shellPage === 'agent-catalog' && (
            <AgentCatalogView
              agents={agentCatalog}
              installations={pythonAgents}
              category={agentCategory}
              secondary={agentSecondary}
              refreshing={agentCatalogRefreshing}
              error={agentCatalogError}
              onRefresh={() => { void refreshAgentCatalog() }}
              onInstall={(id, update) => { void installAgentUi(id, update).catch((error) => notify(`安装失败：${String(error)}`)) }}
              onUninstall={(id) => { void uninstallAgentUi(id).catch((error) => notify(`卸载失败：${String(error)}`)) }}
            />
          )}
          {extensionWorkbenchEnabled && shellPage === 'extension-workbench' && !workbenchWorkspaceReady && (
            <div className="app-view-loading" role="status" aria-label={t('正在加载')}>
              <LoaderCircle className="model-spin" size={19} />
            </div>
          )}
          {extensionWorkbenchEnabled && shellPage === 'extension-workbench' && workbenchWorkspaceReady && (
            <ExtensionWorkbenchView
              page={extensionWorkbenchPage}
              context={extensionExecutionContext}
              onPageChange={changeExtensionWorkbenchPage}
              onClose={leaveShellPage}
            >
              {extensionWorkbenchPage === 'models' ? (
                <ExtensionModelStoreView
                  catalogKind="models"
                  plugins={plugins}
                  modelBindings={modelBindings}
                  runtime={runtime}
                  catalog={catalog}
                  apiModelCatalog={apiModelCatalog}
                  customApiModels={customApiModels}
                  installedCloudModelIds={installedCloudModelIds}
                  onConfigureProvider={notifyModelStoreProviderConfiguration}
                  onRefreshModels={refreshModelStore}
                  onInstallModel={installModelStoreModel}
                  onInstallModelDependency={installModelStoreDependency}
                  onRestoreModel={restoreModelStoreModel}
                  onUninstallModel={uninstallModelStoreModel}
                  onSetModelBinding={saveModelDependencyBinding}
                  onCloudModelInstalled={setCloudModelInstalled}
                  onAction={notify}
                />
              ) : null}
            </ExtensionWorkbenchView>
          )}
          {shellPage === 'settings' && (
            <section
              className="settings-page"
              aria-labelledby="settings-title"
            >
              <header className="settings-overview-heading">
                <h1 id="settings-title">设置</h1>
              </header>
              {SETTINGS_SECTIONS.map(({ id, label }) => (
                <section key={id} className="settings-category" hidden={settingsSection !== 'all' && settingsSection !== id} aria-labelledby={`settings-heading-${id}`}>
                  <header className="settings-page-heading">
                    <h2 id={`settings-heading-${id}`}>{label}</h2>
                  </header>
                  {settingsRows[id]}
                </section>
              ))}
            </section>
          )}
          {shellPage === 'workspace' && view === 'workspace' && (
            activePythonAgent ? <PythonAgentWorkspace key={activePythonAgent} id={activePythonAgent} title={pythonAgents.find(agent => agent.id === activePythonAgent)?.title ?? activePythonAgent} /> : WORKFLOWS_ENABLED && workflowSelected && selectedWorkflowId ? (
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
                onOpenStore={openExtensions}
                onConfigureProvider={() =>
                  openProviderSettings(selectedPlugin.providerId ?? '')
                }
                onAction={notify}
                onClearTextHistory={() =>
                  clearTextHistory(selectedPlugin.providerId ?? '')
                }
                onClearConversation={clearConversationRuns}
              />
            )
          )}
          {shellPage === 'workspace' && WORKFLOWS_ENABLED && view === 'workflows' && (
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


    </div>
  )
}

export default App
