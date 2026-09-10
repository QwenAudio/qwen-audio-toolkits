import { t, useLocale, setLocale } from "./i18n"
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
  Check,
  ChevronDown,
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
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import {
  ProviderSettings,
  type ProviderSettingsKind,
} from './components/ProviderSettings'
import {
  appAgentsWithInstallState,
  INSTALLED_APP_AGENTS_STORAGE_KEY,
  sanitizeInstalledAppAgentIds,
} from './appAgents'
import { initialPlugins, fallbackRuntime } from './data'
import { cloudModelsFromCatalog, isRetiredCloudModelId } from './cloudModels'
import { modelTaxonomy } from './domain/modelTaxonomy'
import {
  appDataDirectory,
  cleanupDownloadCache,
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
  revealInFileManager,
  setCloseBehavior,
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
import type { AgentCreationMode } from './views/AgentHomeView'
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
const SmartCutView = lazy(() =>
  import('./views/SmartCutView').then((module) => ({
    default: module.SmartCutView,
  })),
)
const AiPodcastView = lazy(() =>
  import('./views/AiPodcastView').then((module) => ({
    default: module.AiPodcastView,
  })),
)
const AgentHomeView = lazy(() =>
  import('./views/AgentHomeView').then((module) => ({
    default: module.AgentHomeView,
  })),
)
const MeetingNotesView = lazy(() =>
  import('./views/MeetingNotesView').then((module) => ({
    default: module.MeetingNotesView,
  })),
)
const VideoTranslationView = lazy(() =>
  import('./views/VideoTranslationView').then((module) => ({
    default: module.VideoTranslationView,
  })),
)

type AppView = 'workspace' | 'agents' | AgentCreationMode | 'workflows'
type AgentConversation = {
  id: string
  mode: AgentCreationMode
  title: string
  prompt: string
  sourcePath: string
}
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
const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 520
const MIN_WORKSPACE_WIDTH = 480

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

function getInitialInstalledAppAgents(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return sanitizeInstalledAppAgentIds(JSON.parse(
      window.localStorage.getItem(INSTALLED_APP_AGENTS_STORAGE_KEY) ?? '[]',
    ))
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

type ShellPage = 'workspace' | 'extensions' | 'settings'
type SettingsSection = 'general' | 'appearance' | 'storage'

type AccentColor = 'mint' | 'indigo' | 'amber' | 'rose'

const ACCENT_OPTIONS: {
  id: AccentColor
  label: string
  swatch: string
}[] = [
  { id: 'mint', get label() { return t("青瓷绿") }, swatch: '#4c7e6c' },
  { id: 'indigo', get label() { return t("靛蓝") }, swatch: '#4d63b0' },
  { id: 'amber', get label() { return t("琥珀") }, swatch: '#9a7a2f' },
  { id: 'rose', get label() { return t("玫瑰") }, swatch: '#a95f6f' },
]

type SidebarDensity = 'comfortable' | 'compact'

const SIDEBAR_DENSITY_OPTIONS: {
  id: SidebarDensity
  label: string
}[] = [
  { id: 'comfortable', get label() { return t("舒适") } },
  { id: 'compact', get label() { return t("紧凑") } },
]

const SETTINGS_SECTIONS: {
  id: SettingsSection
  label: string
  Icon: typeof Palette
}[] = [
  { id: 'general', get label() { return t("常规") }, Icon: Settings2 },
  { id: 'appearance', get label() { return t("外观") }, Icon: Palette },
  { id: 'storage', get label() { return t("模型与存储") }, Icon: HardDrive },
]

function App() {
  const locale = useLocale()

  useEffect(() => {
    if (!isTauriRuntime()) return
    void invoke('set_ui_language', { language: locale }).catch(error => {
      console.error('Could not update the native menu language', error)
    })
  }, [locale])

  const [view, setView] = useState<AppView>('workspace')
  const [agentConversations, setAgentConversations] = useState<AgentConversation[]>([])
  const [selectedAgentConversationId, setSelectedAgentConversationId] = useState<string | null>(null)
  const selectedAgentConversation = agentConversations.find(
    (conversation) => conversation.id === selectedAgentConversationId,
  ) ?? null
  const [shellPage, setShellPage] = useState<ShellPage>('workspace')
  const [extensionsNavHost, setExtensionsNavHost] =
    useState<HTMLDivElement | null>(null)
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
  const [installedAppAgentIds, setInstalledAppAgentIds] = useState<string[]>(
    getInitialInstalledAppAgents,
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
  const extensionsReturnFocusRef = useRef<HTMLElement | null>(null)
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('appearance')
  const [settingsProvider, setSettingsProvider] =
    useState<ProviderSettingsKind>('bailian')
  const [settingsCustomProviderId, setSettingsCustomProviderId] = useState(
    'api.openai-compatible',
  )
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
          : extensionsTriggerRef.current
      const target = returnTarget?.isConnected ? returnTarget : trigger
      target?.focus()
    })
  }, [shellPage])
  const closeProviderDialog = useCallback(() => {
    setProviderDialogOpen(false)
    const returnTarget = settingsReturnFocusRef.current
    window.requestAnimationFrame(() => {
      const target = returnTarget?.isConnected
        ? returnTarget
        : settingsTriggerRef.current
      target?.focus()
    })
  }, [])

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
    if (!providerDialogOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeProviderDialog()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [closeProviderDialog, providerDialogOpen])

  useEffect(() => {
    if (shellPage === 'workspace' || providerDialogOpen) return undefined
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
  }, [leaveShellPage, providerDialogOpen, shellPage])

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

  const revealDataDirectory = async () => {
    if (!dataDirectory) return
    try {
      await revealInFileManager(dataDirectory)
    } catch (error) {
      notify(
        t("无法打开数据目录：{0}", [error instanceof Error ? error.message : String(error)]),
      )
    }
  }

  const cleanDownloadCache = async () => {
    setCleaningCache(true)
    try {
      const removed = await cleanupDownloadCache()
      notify(removed > 0 ? t("已清理 {0} 个下载缓存文件", [removed]) : t("没有可清理的下载缓存"))
    } catch (error) {
      notify(
        t("清理下载缓存失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
  const appAgents = useMemo(
    () => appAgentsWithInstallState(installedAppAgentIds),
    [installedAppAgentIds],
  )
  const installedAppAgents = useMemo(
    () => appAgents.filter((agent) => agent.installed),
    [appAgents],
  )

  const setAppAgentInstalled = (agentId: string, installed: boolean) => {
    setInstalledAppAgentIds((current) => {
      const next = sanitizeInstalledAppAgentIds(
        installed
          ? [...current, agentId]
          : current.filter((id) => id !== agentId),
      )
      try {
        window.localStorage.setItem(
          INSTALLED_APP_AGENTS_STORAGE_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Keep the current session state when storage is unavailable.
      }
      return next
    })
    const agent = appAgents.find((candidate) => candidate.id === agentId)
    if (!installed && agent?.workspaceEntry === view) changeView('workspace')
  }

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
          t("无法保存模型依赖：{0}", [error instanceof Error ? error.message : String(error)]),
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
            t("无法清理模型依赖：{0}", [error instanceof Error ? error.message : String(error)]),
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
        get label() { return t("已置顶") },
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
        notify(t("正在补齐 {0} 的配套组件", [selectedPlugin.name]))
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
        notify(t("{0} 的配套组件已就绪", [selectedPlugin.name]))
      } catch (error) {
        repairingDependenciesRef.current.delete(selectedPlugin.id)
        notify(
          t("配套组件安装失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
      if (!silent) notify(t("更新已下载，点击“重启安装”完成更新"))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appUpdateStatusRef.current = 'error'
      setAppUpdate((current) => ({ ...current, status: 'error', message }))
      if (!silent) notify(t("下载更新失败：{0}", [message]))
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
        if (!silent) notify(t("发现新版本 {0}，正在后台下载", [result.update.version]))
        void downloadApplicationUpdate(silent)
      } else if (result.status === 'current') {
        appUpdateStatusRef.current = 'current'
        setAppUpdate({ status: 'current' })
        if (!silent) notify(t("当前已是最新版本"))
      } else {
        appUpdateStatusRef.current = 'unavailable'
        setAppUpdate({ status: 'unavailable', message: result.message })
        if (!silent) notify(result.message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appUpdateStatusRef.current = 'error'
      setAppUpdate({ status: 'error', message })
      if (!silent) notify(t("检查更新失败：{0}", [message]))
    }
  }

  const applyApplicationUpdate = async () => {
    if (activeRunIds.size > 0) {
      notify(t("请等待当前模型任务结束后再安装更新"))
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
      notify(t("安装更新失败：{0}", [message]))
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
    if (shellPage !== 'settings' || settingsSection !== 'storage') return
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
  const launchCreationAgent = (
    mode: AgentCreationMode,
    prompt: string,
    sourcePath: string,
  ) => {
    const modeLabel = mode === 'smart-cut'
      ? t('视频剪辑')
      : mode === 'ai-podcast'
        ? t('AI 播客')
        : mode === 'video-translation'
          ? t('视频翻译')
          : t('会议纪要')
    const normalizedPrompt = prompt.replace(/\s+/gu, ' ').trim()
    const promptTitle = normalizedPrompt.length > 22
      ? `${normalizedPrompt.slice(0, 22)}…`
      : normalizedPrompt
    const conversation: AgentConversation = {
      id: crypto.randomUUID(),
      mode,
      title: `${modeLabel} · ${promptTitle}`,
      prompt,
      sourcePath,
    }
    setAgentConversations((current) => [conversation, ...current])
    setSelectedAgentConversationId(conversation.id)
    setWorkflowSelected(false)
    changeView(mode)
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
        t("无法同步扩展状态：{0}", [error instanceof Error ? error.message : String(error)]),
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
  const openSettings = () => {
    setSettingsSection('general')
    openShellPage('settings')
  }

  const openProviderSettings = (providerId: string) => {
    if (
      providerId === 'api.openai-compatible' ||
      providerId.startsWith('api.custom.')
    ) {
      setSettingsCustomProviderId(providerId)
    }
    setSettingsProvider(
      providerId === 'api.openai-compatible' ||
        providerId.startsWith('api.custom.')
        ? 'custom'
        : 'bailian',
    )
    if (!providerDialogOpen && document.activeElement instanceof HTMLElement) {
      settingsReturnFocusRef.current = document.activeElement
    }
    setProviderDialogOpen(true)
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
      notify(t("当前没有历史消息"))
      return
    }
    if (
      !window.confirm(
        t("确定清除 {0} 条历史记录吗？此操作无法撤销。", [removableRuns.length]),
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
      notify(t("历史消息已清除"))
    } catch (error) {
      notify(
        t("清除失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
    const executionPlugin = orderedRunnablePlugins.find(
      (plugin) =>
        plugin.providerId === providerId &&
        (plugin.version === modelId || plugin.id === modelId),
    )
    const providerKey = providerId
    const history = capability === 'text.generate' && conversationVisible
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
        conversationProviderId: providerId,
        conversationVisible,
        dependencyRunIds,
        routing: capability === 'text.generate' ? 'quality' : 'local',
        title: `${executionPlugin?.name ?? modelId} · ${
          capability === 'text.generate'
            ? t("文本生成")
            : capability === 'text.punctuate'
              ? t("标点恢复")
              : capability === 'text.normalize'
                ? t("文本归一化")
              : t("音频生成")
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
    if (capability === 'text.generate' && conversationVisible) {
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
      notify(t("当前没有可清除的对话记录"))
      return false
    }
    if (!window.confirm(t("确定清除当前模型的 {0} 条对话记录吗？", [removableIds.length]))) {
      return false
    }
    try {
      await Promise.all(removableIds.map((id) => deleteHarnessRun(id)))
      const removed = new Set(removableIds)
      setRuns((current) => current.filter((run) => !removed.has(run.id)))
      if (isTauriRuntime()) {
        void emit(RUNS_REMOVED_EVENT, removableIds).catch(() => undefined)
      }
      notify(t("当前模型的对话记录已清除"))
      return true
    } catch (error) {
      notify(t("清除失败：{0}", [error instanceof Error ? error.message : String(error)]))
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
      throw new Error(t("该音频无法解码为模型需要的 WAV 格式"))
    }
    const comparisonAudioDataUrl = comparisonClip?.processingAudioUrl
    if (comparisonClip && !comparisonAudioDataUrl) {
      throw new Error(t("第二段音频无法解码为模型需要的 WAV 格式"))
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
            ? t("{0} 与 {1} · 声纹比对", [clip.name, comparisonClip.name])
            : capability === 'speech.transcribe'
            ? t("{0} · 语音识别", [clip.name])
            : capability === 'speech.detect'
              ? t("{0} · 语音活动检测", [clip.name])
            : t("{0} · 音频增强", [clip.name]),
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

  const renderPluginSidebarEntry = (plugin: ModelPlugin) => {
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
            aria-label={t("{0} 运行中", [plugin.name])}
          >
            <LoaderCircle className="sidebar-model-spinner" size={14} />
          </span>
        )}
        {draggingModelId === null && (
          <div className={`installed-model-actions${pinned ? ' pinned' : ''}`}>
            <button
              className="installed-model-pin"
              type="button"
              aria-label={`${pinned ? t("取消置顶") : t("置顶")} ${plugin.name}`}
              title={pinned ? t("取消置顶") : t("置顶")}
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
              aria-label={t("删除 {0}", [plugin.name])}
              title={
                running
                  ? t("模型运行中，暂时无法删除")
                  : pendingSidebarRemovalId === plugin.id
                    ? t("再次点击确认删除")
                    : t("删除模型")
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
                      ? t("再次点击垃圾桶确认从工作台移除 {0}", [plugin.name])
                      : references.length
                      ? t("{0} 仍被引用；再次点击将隐藏模型并保留权重", [plugin.name])
                      : t("再次点击垃圾桶确认删除 {0} 的模型权重", [plugin.name]),
                  )
                  return
                }
                setPendingSidebarRemovalId(null)
                if (apiPlugin) {
                  setCloudModelInstalled(plugin.id, false)
                  notify(t("{0} 已从侧栏移除", [plugin.name]))
                } else {
                  void uninstallModelPlugin(plugin.id)
                    .then(({ plugins: next, removal }) => {
                      setPlugins(next)
                      if (removal.deleted) removeModelBindings(plugin.id)
                      notify(
                        removal.retained
                          ? t("{0} 已隐藏；共享权重仍被 {1} 个模型引用", [plugin.name, removal.referencedBy.length])
                          : t("{0} 的模型权重已删除", [plugin.name]),
                      )
                    })
                    .catch((error) => {
                      notify(
                        t("删除失败：{0}", [error instanceof Error ? error.message : String(error)]),
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
    general: (
      <>
        <div className="settings-card">
        <div className="settings-row">
          <span>
            <strong>{t('界面语言')}</strong>
            <small>{t('选择界面显示语言，立即生效')}</small>
          </span>
          <div className="settings-segmented" aria-label={t('界面语言')}>
            {([['zh-CN', '简体中文'], ['en', 'English']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                lang={value}
                className={locale === value ? 'active' : ''}
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
            <strong>{t("关闭窗口时")}</strong>
            <small>{t("隐藏到程序坞可以快速唤回，退出则完全关闭应用")}</small>
          </span>
          <div className="settings-segmented" aria-label={t("关闭窗口时")}>
            {(
              [
                [false, t("隐藏到程序坞")],
                [true, t("退出应用")],
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
            <strong>{t("自动检查更新")}</strong>
            <small>{t("应用运行期间定期检查是否有新版本")}</small>
          </span>
          <button
            className="settings-switch"
            type="button"
            role="switch"
            aria-checked={autoUpdateCheck}
            aria-label={t("自动检查更新")}
            onClick={() => selectAutoUpdateCheck(!autoUpdateCheck)}
          />
        </div>
        </div>
        <div className="settings-group-label">{t("更新与数据")}</div>
        <div className="settings-card">
        <div className="settings-row">
        <span>
          <strong>{t("软件更新")}</strong>
          <small>
            {appUpdate.status === 'available'
              ? t("版本 {0} 已可用", [appUpdate.update?.version])
              : appUpdate.status === 'downloading'
                ? appUpdate.progress === undefined
                  ? t("正在下载安装包")
                  : t("正在下载 {0}%", [Math.round(appUpdate.progress)])
                : appUpdate.status === 'downloaded'
                  ? t("版本 {0} 已下载，点击重启安装", [appUpdate.update?.version])
                  : appUpdate.status === 'installing'
                    ? t("正在安装更新")
                    : appUpdate.status === 'current'
                      ? t("QwenAudio Toolkits {0} 已是最新版", [runtime.version])
                      : appUpdate.message ?? t("当前版本 {0}", [runtime.version])}
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
            ? t("下载并安装")
            : appUpdate.status === 'downloaded'
              ? t("重启安装")
              : appUpdate.status === 'checking'
                ? t("检查中")
                : appUpdate.status === 'downloading'
                  ? t("下载中")
                  : appUpdate.status === 'installing'
                    ? t("安装中")
                    : appUpdate.status === 'unavailable'
                      ? t("开发版本")
                      : t("检查更新")}
        </button>
      </div>
      <div className="settings-row">
        <span>
          <strong>{t("任务数据")}</strong>
          <small>{t("输入、结果和运行记录仅保存在本机")}</small>
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
          {t("清除历史")}</button>
      </div>
      <div className="settings-row">
        <span>
          <strong>{t("应用版本")}</strong>
          <small>{t("QwenAudio Toolkits 桌面版")}</small>
        </span>
        <span className="settings-value">v{runtime.version}</span>
      </div>
      </div>
      <div className="settings-group-label">{t("运行环境")}</div>
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
          <strong>{t("运行设备")}</strong>
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
          <strong>{t("外观主题")}</strong>
          <small>{t("使用系统外观，或固定浅色与深色模式")}</small>
        </span>
        <div className="theme-segmented" aria-label={t("外观主题")}>
          {(
            [
              ['system', Monitor, t("跟随系统")],
              ['light', Sun, t("浅色")],
              ['dark', Moon, t("深色")],
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
          <strong>{t("强调色")}</strong>
          <small>{t("按钮、选中项与高亮状态使用的主题色")}</small>
        </span>
        <div className="accent-swatches" aria-label={t("强调色")}>
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
          <strong>{t("侧边栏密度")}</strong>
          <small>{t("紧凑模式可以在模型列表中显示更多条目")}</small>
        </span>
        <div className="settings-segmented" aria-label={t("侧边栏密度")}>
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
            <strong>{t("模型与数据目录")}</strong>
            <small>
              {dataDirectory === null
                ? t("正在读取目录位置…")
                : dataDirectory || t("仅桌面版可查看数据目录")}
            </small>
          </span>
          <button
            className="settings-update-action"
            type="button"
            disabled={!dataDirectory}
            onClick={() => void revealDataDirectory()}
          >
            {t("在访达中显示")}</button>
        </div>
        <div className="settings-row">
          <span>
            <strong>{t("下载缓存")}</strong>
            <small>{t("已完成的模型安装包会保留在本地，可手动清理以释放空间")}</small>
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
            {t("清理缓存")}</button>
        </div>
        </div>
      </>
    ),
  }
  const activeSettingsSection =
    SETTINGS_SECTIONS.find((section) => section.id === settingsSection) ??
    SETTINGS_SECTIONS[0]

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
              <span>{t("返回")}</span>
            </button>
            <div className="sidebar-page-title">
              {shellPage === 'extensions' ? (
                <ShoppingBag size={15} />
              ) : (
                <Settings size={15} />
              )}
              <span>{shellPage === 'extensions' ? 'Agents' : t("设置")}</span>
            </div>
            {shellPage === 'extensions' ? (
              <div
                ref={setExtensionsNavHost}
                className="sidebar-page-nav-body"
              />
            ) : (
              <nav
                className="sidebar-page-nav-body settings-nav"
                aria-label={t("设置分类")}
              >
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
            )}
          </div>
        )}


        {shellPage === 'workspace' && (
        <nav className="installed-models" aria-label={t("已安装 Agents")}>
          {sidebarModelGroups.map((group) => {
            const models = group.models
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
                  <span>{group.label}</span>
                  <span className="sidebar-group-count">{models.length}</span>
                </button>
                {!collapsed && (
                  <div className="sidebar-model-group-items">
                    {models.map(renderPluginSidebarEntry)}
                  </div>
                )}
              </section>
            )
          })}
          <div className="sidebar-agent-history-header">
            <button
              className={`sidebar-agents-entry${view === 'agents' ? ' active' : ''}`}
              type="button"
              aria-current={view === 'agents' ? 'page' : undefined}
              onClick={() => {
                setSelectedAgentConversationId(null)
                setWorkflowSelected(false)
                changeView('agents')
              }}
            >
              <span>{t('最近')}</span>
              <ChevronDown size={14} />
            </button>
            <button
              className="sidebar-new-agent-conversation"
              type="button"
              aria-label={t('新建会话')}
              title={t('新建会话')}
              onClick={() => {
                setSelectedAgentConversationId(null)
                setWorkflowSelected(false)
                changeView('agents')
              }}
            >
              <SquarePen size={16} />
            </button>
          </div>
          {agentConversations.length > 0 && (
            <div className="sidebar-agent-conversations" aria-label={t('Agent 对话')}>
              {agentConversations.map((conversation) => {
                const active = selectedAgentConversationId === conversation.id && view === conversation.mode
                const fileName = conversation.sourcePath
                  ? conversation.sourcePath.split(/[\\/]/u).at(-1) ?? conversation.sourcePath
                  : t('实时会议')
                return (
                  <button
                    className={`installed-model-button agent-conversation-button${active ? ' active' : ''}`}
                    type="button"
                    key={conversation.id}
                    title={`${conversation.title}\n${fileName}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setSelectedAgentConversationId(conversation.id)
                      setWorkflowSelected(false)
                      changeView(conversation.mode)
                    }}
                  >
                    <span>{conversation.title}</span>
                  </button>
                )
              })}
            </div>
          )}
        </nav>
        )}

        {shellPage === 'workspace' && <div className="sidebar-spacer" />}

        <nav className="sidebar-dock" aria-label={t("资源与设置")}>
          {WORKFLOWS_ENABLED && (
            <button
              className={`sidebar-dock-button${
                shellPage === 'workspace' && view === 'workflows' ? ' active' : ''
              }`}
              type="button"
              aria-label={t("流程编排")}
              data-tooltip={t("流程编排")}
              onClick={() => {
                setEditingWorkflowId(null)
                changeView('workflows')
              }}
            >
              <GitBranch size={18} />
            </button>
          )}
          <button
            ref={extensionsTriggerRef}
            className={`sidebar-dock-button${shellPage === 'extensions' ? ' active' : ''}`}
            type="button"
            aria-label={t('Agent 商店')}
            aria-pressed={shellPage === 'extensions'}
            data-tooltip={t('Agent 商店')}
            onClick={shellPage === 'extensions' ? leaveShellPage : openExtensions}
          >
            <ShoppingBag size={18} />
          </button>
          <button
            ref={settingsTriggerRef}
            className={`sidebar-dock-button${shellPage === 'settings' ? ' active' : ''}`}
            type="button"
            aria-label={t("设置")}
            aria-pressed={shellPage === 'settings'}
            data-tooltip={t("设置")}
            onClick={shellPage === 'settings' ? leaveShellPage : openSettings}
          >
            <Settings size={18} />
          </button>
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
                    ? t("正在下载安装包")
                    : t("正在下载 {0}%", [Math.round(appUpdate.progress)])
                  : appUpdate.status === 'installing'
                    ? t("正在安装更新")
                    : appUpdate.status === 'downloaded'
                      ? t("重启安装 {0}", [appUpdate.update?.version ?? ''])
                      : t("后台下载更新 {0}", [appUpdate.update?.version ?? ''])
              }
              aria-label={
                appUpdate.status === 'downloading'
                  ? t("正在下载安装包")
                  : appUpdate.status === 'installing'
                    ? t("正在安装更新")
                    : appUpdate.status === 'downloaded'
                      ? t("重启安装新版本")
                      : t("下载新版本")
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
          aria-label={t("调整左侧栏宽度")}
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
          aria-label={t("关闭导航")}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="app-frame model-app-frame">
        <header className="topbar model-topbar" data-tauri-drag-region>
          <button
            className="mobile-menu-button"
            type="button"
            aria-label={t("打开导航")}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="topbar-title">
            <span>
              {shellPage === 'extensions'
                ? 'Agents'
                : shellPage === 'settings'
                  ? t("设置 · {0}", [activeSettingsSection.label])
                  : view === 'agents'
                    ? 'Agents'
                    : view === 'smart-cut' || view === 'ai-podcast' || view === 'video-translation' || view === 'meeting-notes'
                      ? selectedAgentConversation?.title ?? t('Agent 对话')
                    : view === 'workspace'
                ? WORKFLOWS_ENABLED && workflowSelected
                  ? workflows.find(
                      (workflow) => workflow.id === selectedWorkflowId,
                    )?.name ?? t("虚拟模型")
                  : selectedPlugin.name
                : t("流程编排")}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="model-runtime-state">
              <i />
              {isTauriRuntime() ? t("本地运行") : t("界面预览")}
            </span>
          </div>
        </header>

        <div
          className={`view-container model-view-container${shellPage !== 'workspace' ? ` page-${shellPage}` : ''}`}
        >
          <Suspense
            fallback={
              <div className="app-view-loading" aria-label={t("正在加载")}>
                <LoaderCircle className="model-spin" size={19} />
              </div>
            }
          >
          {shellPage === 'extensions' && (
            <PluginsView
              plugins={plugins}
              modelBindings={modelBindings}
              runtime={runtime}
              catalog={catalog}
              apiModelCatalog={apiModelCatalog}
              customApiModels={customApiModels}
              appAgents={appAgents}
              installedCloudModelIds={installedCloudModelIds}
              onConfigureProvider={openProviderSettings}
              onPluginsChanged={setPlugins}
              onModelBindingsChanged={setModelBindings}
              onRemoveModelBindings={removeModelBindings}
              onSetModelBinding={saveModelBinding}
              onCatalogChanged={setCatalog}
              onCloudModelInstalled={setCloudModelInstalled}
              onAppAgentInstalled={setAppAgentInstalled}
              onAction={notify}
              taxonomyHost={extensionsNavHost}
            />
          )}
          {shellPage === 'settings' && (
            <section
              className="settings-page"
              aria-labelledby="settings-page-title"
            >
              <header className="settings-page-heading">
                <h2 id="settings-page-title">{activeSettingsSection.label}</h2>
              </header>
              {settingsRows[settingsSection]}
            </section>
          )}
          {/* Keep draft inputs and live sessions alive while changing settings. */}
          <div
            className="workspace-session"
            hidden={shellPage !== 'workspace'}
            inert={shellPage !== 'workspace'}
          >
          {view === 'agents' && (
            <AgentHomeView
              smartCutAvailable={installedAppAgents.some(
                (agent) => agent.workspaceEntry === 'smart-cut',
              )}
              podcastAvailable={installedAppAgents.some(
                (agent) => agent.workspaceEntry === 'ai-podcast',
              )}
              onLaunch={launchCreationAgent}
              onOpenStore={openExtensions}
            />
          )}
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
          {agentConversations
            .filter((conversation) => conversation.mode === 'smart-cut')
            .map((conversation) => (
              <div
                key={conversation.id}
                className="agent-workspace-session"
                hidden={view !== 'smart-cut' || selectedAgentConversationId !== conversation.id}
                inert={view !== 'smart-cut' || selectedAgentConversationId !== conversation.id}
              >
                <SmartCutView
                  initialInstruction={conversation.prompt}
                  initialSourcePath={conversation.sourcePath}
                  initialLaunchId={1}
                  models={orderedRunnablePlugins}
                  catalog={catalog}
                  onRunAudio={runAudio}
                  onRunText={runText}
                  onOpenStore={openExtensions}
                  onAction={notify}
                />
              </div>
            ))}
          {agentConversations
            .filter((conversation) => conversation.mode === 'ai-podcast')
            .map((conversation) => (
              <div
                key={conversation.id}
                className="agent-workspace-session"
                hidden={view !== 'ai-podcast' || selectedAgentConversationId !== conversation.id}
                inert={view !== 'ai-podcast' || selectedAgentConversationId !== conversation.id}
              >
                <AiPodcastView
                  initialInstruction={conversation.prompt}
                  initialSourcePath={conversation.sourcePath}
                  initialLaunchId={1}
                  models={orderedRunnablePlugins}
                  catalog={catalog}
                  onRunText={runText}
                  onOpenStore={openExtensions}
                  onAction={notify}
                />
              </div>
            ))}
          {agentConversations
            .filter((conversation) => conversation.mode === 'video-translation')
            .map((conversation) => (
                <div
                  key={conversation.id}
                  className="agent-workspace-session"
                  hidden={view !== 'video-translation' || selectedAgentConversationId !== conversation.id}
                  inert={view !== 'video-translation' || selectedAgentConversationId !== conversation.id}
                >
                  <VideoTranslationView
                    initialInstruction={conversation.prompt}
                    initialSourcePath={conversation.sourcePath}
                    initialLaunchId={1}
                    onAction={notify}
                  />
                </div>
            ))}
          {agentConversations
            .filter((conversation) => conversation.mode === 'meeting-notes')
            .map((conversation) => (
              <div
                key={conversation.id}
                className="agent-workspace-session"
                hidden={view !== 'meeting-notes' || selectedAgentConversationId !== conversation.id}
                inert={view !== 'meeting-notes' || selectedAgentConversationId !== conversation.id}
              >
                <MeetingNotesView
                  initialInstruction={conversation.prompt}
                  models={orderedRunnablePlugins}
                  onRunText={runText}
                  onRunAudio={runAudio}
                  onOpenStore={openExtensions}
                  onAction={notify}
                />
              </div>
            ))}
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
          </div>
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
            aria-label={t("关闭通知")}
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {providerDialogOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeProviderDialog()
          }}
        >
          <section
            className="settings-dialog application-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-dialog-title"
          >
            <div className="dialog-heading">
              <div>
                <span className="section-kicker">PROVIDER</span>
                <h2 id="provider-dialog-title">{t("Provider 配置")}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                autoFocus
                aria-label={t("关闭 Provider 配置")}
                onClick={closeProviderDialog}
              >
                <X size={17} />
              </button>
            </div>
            <div className="settings-layout single">
              <div className="settings-content provider-settings-content">
                <ProviderSettings
                  provider={settingsProvider}
                  onProviderChange={setSettingsProvider}
                  runtime={runtime}
                  catalog={catalog}
                  onCatalogChanged={setCatalog}
                  onAction={notify}
                  customProviderId={settingsCustomProviderId}
                />
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
