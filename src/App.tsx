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
  RefreshCw,
  Palette,
  Settings,
  Settings2,
  ShoppingBag,
  Sparkles,
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
  defaultInstalledAppAgentIds,
  INSTALLED_APP_AGENTS_STORAGE_KEY,
  sanitizeInstalledAppAgentIds,
} from './appAgents'
import { initialPlugins, fallbackRuntime } from './data'
import { cloudModelsFromCatalog, isRetiredCloudModelId } from './cloudModels'
import {
  appDataDirectory,
  cleanupDownloadCache,
  executeHarnessTask,
  deleteHarnessRun,
  getHarnessCatalog,
  getModelDependencyBindings,
  installCatalogModel,
  installRecommendedModelDependency,
  isTauriRuntime,
  listApiModelCatalog,
  listHarnessRuns,
  listModelPlugins,
  readDroppedAudioFile,
  refreshModelPlugins,
  replaceModelDependencyBindings,
  revealInFileManager,
  setCloseBehavior,
  setModelDependencyBinding,
  subscribeHarnessRuns,
} from './services/harness'
import {
  getModelBinding,
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
import type {
  AgentCreationMode,
  GeneralAgentAttachment,
  GeneralAgentMessageModelOptions,
  GeneralAgentMessage,
  GeneralAgentTask,
} from './domain/agents'
import {
  createOnDemandModelExecutionPlan,
  createInstallModelAction,
  isInstallApproval,
  planOnDemandModelAction,
  resolveOnDemandModelExecutions,
  type OnDemandModelExecutionCandidate,
  type OnDemandModelInstallMode,
  type OnDemandModelResolution,
} from './domain/onDemandModels'
import { agentFileKind } from './domain/agentFiles'
import { useAgentConversations } from './hooks/useAgentConversations'
import { audioFileToClip } from './utils/audio'
import appIconUrl from '../src-tauri/icons/128x128.png'
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
const VideoDubbingView = lazy(() =>
  import('./views/VideoDubbingView').then((module) => ({
    default: module.VideoDubbingView,
  })),
)

type AppView = 'workspace' | 'agents' | AgentCreationMode | 'workflows'
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
const SIDEBAR_WIDTH_KEY = 'qwen-audio-toolkits.sidebar-width-v8'
const THEME_STORAGE_KEY = 'qwen-audio-toolkits.theme-v1'
const ACCENT_STORAGE_KEY = 'qwen-audio-toolkits.accent-v1'
const SIDEBAR_DENSITY_STORAGE_KEY = 'qwen-audio-toolkits.sidebar-density-v1'
const CLOSE_BEHAVIOR_STORAGE_KEY = 'qwen-audio-toolkits.close-behavior-v1'
const AUTO_UPDATE_STORAGE_KEY = 'qwen-audio-toolkits.auto-update-v1'
const LAST_MODEL_STORAGE_KEY = 'qwen-audio-toolkits.last-model-v1'
const DEFAULT_VOICE_WORKFLOW_MODELS_KEY =
  'qwen-audio-toolkits.default-voice-workflow-models-v2'
const WORKFLOWS_ENABLED = false
const NATIVE_TITLEBAR_HEIGHT = 46
const DRAG_REGION_INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, video, [contenteditable], [role="button"], [role="link"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], [role="dialog"], .modal-backdrop'
const APP_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60_000
const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 520
const MIN_WORKSPACE_WIDTH = 480

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
  if (typeof window === 'undefined') return defaultInstalledAppAgentIds()
  try {
    const saved = window.localStorage.getItem(INSTALLED_APP_AGENTS_STORAGE_KEY)
    if (saved === null) return defaultInstalledAppAgentIds()
    return sanitizeInstalledAppAgentIds(JSON.parse(
      saved,
    ))
  } catch {
    return defaultInstalledAppAgentIds()
  }
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

type ShellPage = 'workspace' | 'skills' | 'models' | 'settings'
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

interface PendingOnDemandInstall {
  resolution: OnDemandModelResolution
  prompt: string
  selectedModeName: string | null
  attachmentHint: string
  attachment: GeneralAgentAttachment | null
}

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

  const [view, setView] = useState<AppView>('agents')
  const {
    conversations: agentConversations,
    generalTasks,
    selectedId: selectedAgentConversationId,
    selectedConversation: selectedAgentConversation,
    selectedGeneralTask,
    createGeneralTask,
    ensureGeneralTask,
    updateGeneralTask,
    updateGeneralMessageActionStatus,
    submitGeneralPrompt,
    selectConversation: setSelectedAgentConversationId,
  } = useAgentConversations()
  const [agentHomeMode, setAgentHomeMode] = useState<AgentCreationMode | null>(null)
  const pendingGeneralTaskRef = useRef<GeneralAgentTask | null>(null)
  const pendingOnDemandModelRef = useRef(new Map<string, PendingOnDemandInstall>())
  const [agentModelInstallMode, setAgentModelInstallMode] =
    useState<OnDemandModelInstallMode>('ask')
  const [agentMessageModelSelections, setAgentMessageModelSelections] =
    useState<Record<string, string>>({})
  const [shellPage, setShellPage] = useState<ShellPage>('workspace')
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

  useEffect(() => {
    if (selectedGeneralTask) pendingGeneralTaskRef.current = null
  }, [selectedGeneralTask])
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

  // The overlay titlebar hides the native drag area; make the window's top
  // strip draggable anywhere except on interactive controls.
  useEffect(() => {
    if (!usesOverlayTitlebar || !isTauriRuntime()) return undefined
    const startDragFromTitlebarStrip = (event: MouseEvent) => {
      if (event.button !== 0 || event.clientY > NATIVE_TITLEBAR_HEIGHT) return
      const target = event.target as HTMLElement | null
      if (!target || target.closest(DRAG_REGION_INTERACTIVE_SELECTOR)) return
      void getCurrentWindow().startDragging().catch(() => undefined)
    }
    document.addEventListener('mousedown', startDragFromTitlebarStrip)
    return () =>
      document.removeEventListener('mousedown', startDragFromTitlebarStrip)
  }, [usesOverlayTitlebar])

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
    if (!installed && agent?.workspaceEntry === view) changeView('agents')
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
    return runnablePlugins
  }, [runnablePlugins])
  const responsiveSidebarMaxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.floor(viewportWidth - MIN_WORKSPACE_WIDTH),
    ),
  )
  const visibleSidebarWidth = Math.min(sidebarWidth, responsiveSidebarMaxWidth)
  const visibleContentOffset = viewportWidth <= 900 ? 0 : visibleSidebarWidth

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
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

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
  const materializeGeneralTask = (
    draft: {
      selectedModeId?: AgentCreationMode | null
      attachment?: GeneralAgentTask['attachment']
    } = {},
  ) => {
    if (selectedGeneralTask) {
      pendingGeneralTaskRef.current = null
      return selectedGeneralTask
    }
    if (pendingGeneralTaskRef.current) return pendingGeneralTaskRef.current
    const task = ensureGeneralTask({
      selectedModeId: draft.selectedModeId ?? agentHomeMode,
      attachment: draft.attachment ?? null,
    })
    pendingGeneralTaskRef.current = task
    return task
  }
  const updateAgentHomeMode = (mode: AgentCreationMode | null) => {
    setAgentHomeMode(mode)
    if (selectedGeneralTask || mode) {
      const task = materializeGeneralTask({ selectedModeId: mode })
      updateGeneralTask(task.id, { selectedModeId: mode })
    }
  }
  const updateAgentHomeDraft = (prompt: string) => {
    if (!selectedGeneralTask && !prompt.trim()) return
    const task = materializeGeneralTask()
    updateGeneralTask(task.id, { draftPrompt: prompt })
  }
  const updateAgentHomeAttachment = (
    attachment: GeneralAgentTask['attachment'],
  ) => {
    if (!selectedGeneralTask && !attachment) return
    const task = materializeGeneralTask({ attachment })
    updateGeneralTask(task.id, { attachment })
  }
  const refreshModelStoreState = async () => {
    const [nextPlugins, nextCatalog] = await Promise.all([
      listModelPlugins(),
      getHarnessCatalog(),
    ])
    setPlugins(nextPlugins)
    setCatalog(nextCatalog)
    return nextPlugins
  }
  const installOnDemandModel = async (
    resolution: OnDemandModelResolution,
  ): Promise<ModelPlugin> => {
    const model = resolution.recommendedModel
    if (!model) {
      throw new Error(t('模型商店暂时没有可用于 {0} 的开源模型', [resolution.need.label]))
    }
    if (model.installed) return model
    if (!model.catalogManaged || model.installable === false) {
      throw new Error(t('{0} 不是可自动安装的模型，请打开模型商店手动处理', [model.name]))
    }
    if (!isTauriRuntime()) {
      throw new Error(t('按需安装需要在桌面端运行'))
    }
    notify(t('正在安装按需模型 {0}', [model.name]))
    const installed = await installCatalogModel(model.id, model.defaultVariantId)
    await refreshModelStoreState()
    return installed
  }
  const onDemandModelContext = (
    resolution: OnDemandModelResolution,
    model: ModelPlugin,
  ): string =>
    `\n\n按需模型商店：检测到用户需要「${resolution.need.label}」。` +
    `模型商店已安装开源模型「${model.name}」（${model.id}），` +
    `可直接使用 ${resolution.need.capability} 能力执行${resolution.need.actionLabel}。` +
    '请在回复中明确使用该模型，并给出下一步可审阅处理计划。'
  const latestAgentAttachments = (
    task: GeneralAgentTask,
    messageId: string,
  ): GeneralAgentAttachment[] => {
    const messageIndex = task.messages.findIndex((item) => item.id === messageId)
    const messages = messageIndex >= 0
      ? task.messages.slice(0, messageIndex + 1)
      : task.messages
    const candidates: GeneralAgentAttachment[] = []
    if (task.attachment) candidates.push(task.attachment)
    for (const item of messages) {
      if (item.attachment) candidates.push(item.attachment)
      if (item.attachments?.length) candidates.push(...item.attachments)
    }
    return candidates.reverse().filter((file) =>
      ['audio', 'video', 'document'].includes(agentFileKind(file)),
    )
  }
  const resolveConfirmExecutionCandidates = (
    task: GeneralAgentTask,
    message: GeneralAgentMessage,
  ): { attachment: GeneralAgentAttachment; candidates: OnDemandModelExecutionCandidate[] } | null => {
    if (!message.action || message.action.kind !== 'confirm-agent-plan') return null
    const recentContext = [
      ...task.messages.slice(-6).map((item) => item.content),
      message.action.confirmationText,
    ].join('\n')
    for (const attachment of latestAgentAttachments(task, message.id)) {
      const candidates = resolveOnDemandModelExecutions(recentContext, plugins, attachment)
      if (candidates.length) return { attachment, candidates }
    }
    return null
  }
  const selectOnDemandExecutionCandidate = (
    candidates: OnDemandModelExecutionCandidate[],
    selectedModelId?: string | null,
  ): OnDemandModelExecutionCandidate | null =>
    (selectedModelId
      ? candidates.find(({ model }) => model.id === selectedModelId)
      : null) ??
    candidates.find(({ model }) => model.installed) ??
    candidates.find(({ model }) => model.catalogManaged && model.installable !== false) ??
    null
  const resolveConfirmExecution = (
    task: GeneralAgentTask,
    message: GeneralAgentMessage,
    selectedModelId?: string | null,
  ): PendingOnDemandInstall | null => {
    const resolved = resolveConfirmExecutionCandidates(task, message)
    if (!resolved) return null
    const candidate = selectOnDemandExecutionCandidate(resolved.candidates, selectedModelId)
    if (!candidate) return null
    return {
      resolution: candidate.resolution,
      prompt: message.action?.kind === 'confirm-agent-plan'
        ? message.action.confirmationText
        : '',
      selectedModeName: null,
      attachmentHint: `\n\n已选择素材：${resolved.attachment.name}\n文件路径：${resolved.attachment.path}`,
      attachment: resolved.attachment,
    }
  }
  const resolveMessageModelOptions = (
    task: GeneralAgentTask,
    message: GeneralAgentMessage,
  ): GeneralAgentMessageModelOptions | null => {
    const resolved = resolveConfirmExecutionCandidates(task, message)
    if (!resolved || resolved.candidates.length < 2) return null
    const selected =
      selectOnDemandExecutionCandidate(
        resolved.candidates,
        agentMessageModelSelections[message.id],
      ) ?? resolved.candidates[0]
    return {
      needLabel: selected.resolution.need.label,
      actionLabel: selected.resolution.need.actionLabel,
      selectedModelId: selected.model.id,
      choices: resolved.candidates.map(({ model }) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        installed: model.installed,
      })),
    }
  }
  const resolveTaskMessageModelOptions = (
    task: GeneralAgentTask | null,
  ): Record<string, GeneralAgentMessageModelOptions> => {
    if (!task) return {}
    return Object.fromEntries(
      task.messages.flatMap((message) => {
        if (message.action?.kind !== 'confirm-agent-plan') return []
        const options = resolveMessageModelOptions(task, message)
        return options ? [[message.id, options]] : []
      }),
    )
  }
  const runOnDemandModelExecution = async (
    pending: PendingOnDemandInstall,
    model: ModelPlugin,
  ): Promise<{ content: string; attachments: GeneralAgentAttachment[] } | null> => {
    const plan = createOnDemandModelExecutionPlan(
      pending.resolution,
      model,
      pending.attachment,
    )
    if (!plan) return null
    const attachment = pending.attachment
    if (!attachment) return null
    const providerId = model.providerId ?? model.id
    notify(t('正在使用 {0} 处理 {1}', [model.name, attachment.name]))
    const file = await readDroppedAudioFile(attachment.path)
    const clip = await audioFileToClip(file)
    const audioDataUrl =
      plan.capability === 'speech.transcribe'
        ? clip.transcriptionAudioUrl
        : clip.processingAudioUrl ?? clip.transcriptionAudioUrl
    if (!audioDataUrl) {
      throw new Error(t('该音频无法解码为模型需要的 WAV 格式'))
    }
    if (plan.capability === 'speech.transcribe') {
      const execution = await executeHarnessTask<AsrTranscriptionResult>(
        {
          capability: plan.capability,
          providerId,
          conversationProviderId: providerId,
          conversationVisible: true,
          routing: 'local',
          title: t('{0} · 语音识别', [attachment.name]),
          input: {
            audioDataUrl,
            clipName: attachment.name,
            duration: clip.duration,
          },
          parameters: {
            modelId: model.version || model.id,
            ...plan.parameters,
          },
        },
        recordRun,
      )
      recordRun(execution.run)
      const transcript = execution.output.text.trim() || t('未识别到可用文本。')
      return {
        content: t('已完成语音识别，结果如下：\n\n{0}', [transcript]),
        attachments: [],
      }
    }
    const execution = await executeHarnessTask<AudioProcessResult>(
      {
        capability: plan.capability,
        providerId,
        conversationProviderId: providerId,
        conversationVisible: true,
        routing: 'local',
        title: t('{0} · 音频降噪', [attachment.name]),
        input: {
          audioDataUrl,
          clipName: attachment.name,
          duration: clip.duration,
        },
        parameters: {
          modelId: model.version || model.id,
          ...plan.parameters,
        },
      },
      recordRun,
    )
    recordRun(execution.run)
    return {
      content: t('已完成降噪，输出新文件 `{0}`。文件位置：{1}', [
        execution.output.fileName,
        execution.output.filePath,
      ]),
      attachments: [
        {
          path: execution.output.filePath,
          name: execution.output.fileName,
        },
      ],
    }
  }
  const continueWithInstalledOnDemandModel = (
    task: GeneralAgentTask,
    pending: PendingOnDemandInstall,
    model: ModelPlugin,
  ) => {
    pendingOnDemandModelRef.current.delete(task.id)
    const directPlan = createOnDemandModelExecutionPlan(
      pending.resolution,
      model,
      pending.attachment,
    )
    void submitGeneralPrompt({
      task,
      content: pending.prompt,
      selectedModeName: pending.selectedModeName,
      attachmentHint:
        pending.attachmentHint +
        onDemandModelContext(pending.resolution, model),
      attachment: pending.attachment,
      appendUserMessage: false,
      ...(directPlan
        ? {
            localResponse: async () =>
              (await runOnDemandModelExecution(pending, model)) ??
              t('已安装 {0}。当前任务还需要 Agent 继续规划，请补充处理参数。', [
                model.name,
              ]),
          }
        : {}),
      onError: notify,
    })
  }
  const runAgentMessageAction = (
    task: GeneralAgentTask | null,
    message: GeneralAgentMessage,
    selectedModelId?: string | null,
  ) => {
    if (!task || !message.action) return
    if (message.action.kind === 'confirm-agent-plan') {
      const action = message.action
      const directExecution = resolveConfirmExecution(task, message, selectedModelId)
      updateGeneralMessageActionStatus(task.id, message.id, 'running')
      void (async () => {
        await submitGeneralPrompt({
          task,
          content: action.confirmationText,
          selectedModeName: null,
          attachmentHint: directExecution?.attachmentHint ?? '',
          attachment: directExecution?.attachment ?? null,
          ...(directExecution
            ? {
                localResponse: async () => {
                  const model =
                    directExecution.resolution.installedModel ??
                    await installOnDemandModel(directExecution.resolution)
                  return (
                    (await runOnDemandModelExecution(directExecution, model)) ??
                    t('已确认。当前任务还需要 Agent 继续规划，请补充处理参数。')
                  )
                },
              }
            : {}),
          onError: notify,
        })
        updateGeneralMessageActionStatus(task.id, message.id, 'done')
      })()
      return
    }
    if (message.action.kind !== 'install-on-demand-model') return
    const action = message.action
    updateGeneralMessageActionStatus(task.id, message.id, 'running')
    const model = plugins.find((candidate) => candidate.id === action.modelId)
    const resolution: OnDemandModelResolution = {
      need: {
        id: action.id,
        capability: action.capability as ModelPlugin['harnessCapabilities'][number],
        label: action.needLabel,
        actionLabel: action.actionLabel,
        preferredModelIds: [action.modelId],
      },
      installedModel: model?.installed ? model : null,
      recommendedModel: model ?? null,
    }
    void (async () => {
      try {
        const installed = await installOnDemandModel(resolution)
        updateGeneralMessageActionStatus(task.id, message.id, 'done')
        continueWithInstalledOnDemandModel(task, {
          resolution,
          prompt: action.prompt,
          selectedModeName: action.selectedModeName,
          attachmentHint: action.attachmentHint,
          attachment: action.attachment ?? null,
        }, installed)
      } catch (error) {
        updateGeneralMessageActionStatus(task.id, message.id, 'failed')
        notify(
          t('按需模型安装失败：{0}', [error instanceof Error ? error.message : String(error)]),
        )
      }
    })()
  }
  const submitAgentHomePrompt = (request: {
    content: string
    selectedModeName: string | null
    attachmentHint: string
    attachment: GeneralAgentAttachment | null
  }) => {
    const task = selectedGeneralTask ?? pendingGeneralTaskRef.current ?? createGeneralTask({
      selectedModeId: agentHomeMode,
      attachment: null,
    })
    pendingGeneralTaskRef.current = task
    const pendingInstall = pendingOnDemandModelRef.current.get(task.id)
    if (pendingInstall && isInstallApproval(request.content)) {
      pendingOnDemandModelRef.current.delete(task.id)
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: '',
        attachment: null,
        localResponse: async () => {
          const model = await installOnDemandModel(pendingInstall.resolution)
          window.setTimeout(() => continueWithInstalledOnDemandModel(task, pendingInstall, model), 0)
          return t('已安装 {0}。正在继续处理原请求。', [
            model.name,
          ])
        },
        onError: notify,
      })
      return
    }

    const modelAction = planOnDemandModelAction(
      request.content,
      plugins,
      agentModelInstallMode,
    )
    if (modelAction.kind === 'use-installed') {
      pendingOnDemandModelRef.current.delete(task.id)
      const pendingExecution: PendingOnDemandInstall = {
        resolution: modelAction.resolution,
        prompt: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: request.attachmentHint,
        attachment: request.attachment,
      }
      const directPlan = createOnDemandModelExecutionPlan(
        pendingExecution.resolution,
        modelAction.model,
        pendingExecution.attachment,
      )
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint:
          request.attachmentHint +
          onDemandModelContext(modelAction.resolution, modelAction.model),
        attachment: request.attachment,
        ...(directPlan
          ? {
              localResponse: async () =>
                (await runOnDemandModelExecution(pendingExecution, modelAction.model)) ??
                t('模型 {0} 已就绪。当前任务还需要 Agent 继续规划，请补充处理参数。', [
                  modelAction.model.name,
                ]),
            }
          : {}),
        onError: notify,
      })
      return
    }

    if (modelAction.kind === 'auto-install') {
      pendingOnDemandModelRef.current.delete(task.id)
      const pendingExecution: PendingOnDemandInstall = {
        resolution: modelAction.resolution,
        prompt: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: request.attachmentHint,
        attachment: request.attachment,
      }
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: '',
        attachment: request.attachment,
        localResponse: async () => {
          const model = await installOnDemandModel(modelAction.resolution)
          const directResult = await runOnDemandModelExecution(pendingExecution, model)
          if (directResult) return directResult
          return t('已自动安装 {0}。当前任务还需要 Agent 继续规划，请补充处理参数。', [
            model.name,
          ])
        },
        onError: notify,
      })
      return
    }

    if (modelAction.kind === 'ask-install') {
      const pendingInstallRequest: PendingOnDemandInstall = {
        resolution: modelAction.resolution,
        prompt: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: request.attachmentHint,
        attachment: request.attachment,
      }
      pendingOnDemandModelRef.current.set(task.id, pendingInstallRequest)
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: '',
        attachment: request.attachment,
        localResponse: () => ({
          content: t('需要先安装开源模型 {0} 才能处理「{1}」。点击下方按钮即可安装并继续，或回复“安装”。', [
            modelAction.model.name,
            modelAction.resolution.need.label,
          ]),
          action: createInstallModelAction(modelAction.resolution, modelAction.model, {
            prompt: request.content,
            selectedModeName: request.selectedModeName,
            attachmentHint: request.attachmentHint,
            attachment: request.attachment,
          }),
        }),
        onError: notify,
      })
      return
    }

    if (modelAction.kind === 'unavailable') {
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: '',
        attachment: request.attachment,
        localResponse: () =>
          t('模型商店暂时没有可用于 {0} 的开源模型', [modelAction.resolution.need.label]),
        onError: notify,
      })
      return
    }

    void submitGeneralPrompt({
      task,
      content: request.content,
      selectedModeName: request.selectedModeName,
      attachmentHint: request.attachmentHint,
      attachment: request.attachment,
      onError: notify,
    })
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
  const openNewTask = () => {
    pendingGeneralTaskRef.current = null
    setShellPage('workspace')
    setAgentHomeMode(null)
    setSelectedAgentConversationId(null)
    setWorkflowSelected(false)
    changeView('agents')
  }
  const openSkills = () => {
    setShellPage('skills')
    setSidebarOpen(false)
  }
  const openModelStore = () => openShellPage('models')
  const openExtensions = openModelStore
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

        <div className="sidebar-brand">
          <span className="sidebar-brand-mark app-icon">
            <img src={appIconUrl} alt="QwenAudio Toolkits" />
          </span>
          <span className="sidebar-brand-name">QwenAudio Toolkits</span>
        </div>

        {shellPage === 'settings' ? (
          <nav className="sidebar-primary-nav sidebar-return-nav" aria-label={t("应用导航")}>
            <button
              className="sidebar-primary-button sidebar-return-button"
              type="button"
              onClick={openNewTask}
            >
              <ArrowLeft size={17} />
              <span>{t("返回应用")}</span>
            </button>
          </nav>
        ) : (
          <nav className="sidebar-primary-nav" aria-label={t("主导航")}>
            <button
              className={`sidebar-primary-button${
                shellPage === 'workspace' && view === 'agents' && !selectedAgentConversationId
                  ? ' active'
                  : ''
              }`}
              type="button"
              aria-current={
                shellPage === 'workspace' && view === 'agents' && !selectedAgentConversationId
                  ? 'page'
                  : undefined
              }
              onClick={openNewTask}
            >
              <SquarePen size={17} />
              <span>{t("新任务")}</span>
            </button>
            <button
              ref={extensionsTriggerRef}
              className={`sidebar-primary-button${shellPage === 'skills' ? ' active' : ''}`}
              type="button"
              aria-current={shellPage === 'skills' ? 'page' : undefined}
              onClick={shellPage === 'skills' ? leaveShellPage : openSkills}
            >
              <Sparkles size={17} />
              <span>{t("技能")}</span>
            </button>
            <button
              className={`sidebar-primary-button${shellPage === 'models' ? ' active' : ''}`}
              type="button"
              aria-current={shellPage === 'models' ? 'page' : undefined}
              onClick={shellPage === 'models' ? leaveShellPage : openModelStore}
            >
              <ShoppingBag size={17} />
              <span>{t("模型商店")}</span>
            </button>
          </nav>
        )}

        {shellPage === 'settings' && (
          <nav className="sidebar-settings-nav settings-nav" aria-label={t("设置分类")}>
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

        {shellPage !== 'settings' && (
        <nav className="installed-models sidebar-recent-tasks" aria-label={t("最近任务")}>
          <div className="sidebar-agent-history-header">
            <button
              className="sidebar-agents-entry"
              type="button"
              disabled
            >
              <span>{t('最近')}</span>
              <ChevronDown size={14} />
            </button>
            <button
              className="sidebar-new-agent-conversation"
              type="button"
              aria-label={t('新建会话')}
              title={t('新建会话')}
              onClick={openNewTask}
            >
              <SquarePen size={16} />
            </button>
          </div>
          {(generalTasks.length > 0 || agentConversations.length > 0) && (
            <div className="sidebar-agent-conversations" aria-label={t('最近任务')}>
              {generalTasks.map((task) => {
                const active = shellPage === 'workspace' && selectedAgentConversationId === task.id && view === 'agents'
                return (
                  <button
                    className={`installed-model-button agent-conversation-button${active ? ' active' : ''}`}
                    type="button"
                    key={task.id}
                    title={task.title}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      pendingGeneralTaskRef.current = null
                      setShellPage('workspace')
                      setAgentHomeMode(task.selectedModeId)
                      setSelectedAgentConversationId(task.id)
                      setWorkflowSelected(false)
                      changeView('agents')
                    }}
                  >
                    <span>{task.title}</span>
                    {task.submitting && <small>{t('运行中')}</small>}
                  </button>
                )
              })}
              {agentConversations.map((conversation) => {
                const active =
                  shellPage === 'workspace' &&
                  selectedAgentConversationId === conversation.id &&
                  view === conversation.mode
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
                      pendingGeneralTaskRef.current = null
                      setShellPage('workspace')
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
          {generalTasks.length === 0 && agentConversations.length === 0 && (
            <p className="sidebar-recent-empty">{t("暂无最近任务")}</p>
          )}
        </nav>
        )}

        <div className="sidebar-spacer" />

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
            ref={settingsTriggerRef}
            className={`sidebar-dock-button${shellPage === 'settings' ? ' active' : ''}`}
            type="button"
            aria-label={t("设置")}
            aria-pressed={shellPage === 'settings'}
            data-tooltip={t("设置")}
            onClick={openSettings}
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
              {shellPage === 'skills'
                ? t("技能")
                : shellPage === 'models'
                  ? t("模型商店")
                : shellPage === 'settings'
                  ? t("设置 · {0}", [activeSettingsSection.label])
                  : view === 'agents'
                    ? t("新任务")
                    : view === 'smart-cut' || view === 'ai-podcast' || view === 'video-dubbing' || view === 'meeting-notes'
                      ? selectedAgentConversation?.title ?? t('技能任务')
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
          {shellPage === 'skills' && (
            <PluginsView
              catalogKind="skills"
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
            />
          )}
          {shellPage === 'models' && (
            <PluginsView
              catalogKind="models"
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
              skills={appAgents}
              taskId={selectedGeneralTask?.id ?? null}
              messages={selectedGeneralTask?.messages ?? []}
              draftPrompt={selectedGeneralTask?.draftPrompt ?? ''}
              attachment={selectedGeneralTask?.attachment ?? null}
              submitting={selectedGeneralTask?.submitting ?? false}
              modelInstallMode={agentModelInstallMode}
              messageModelOptions={resolveTaskMessageModelOptions(selectedGeneralTask)}
              selectedModeId={selectedGeneralTask?.selectedModeId ?? agentHomeMode}
              onModelInstallModeChange={setAgentModelInstallMode}
              onMessageModelSelect={(messageId, modelId) =>
                setAgentMessageModelSelections((current) => ({
                  ...current,
                  [messageId]: modelId,
                }))
              }
              onSelectedModeChange={updateAgentHomeMode}
              onDraftPromptChange={updateAgentHomeDraft}
              onAttachmentChange={updateAgentHomeAttachment}
              onSubmitPrompt={submitAgentHomePrompt}
              onRunMessageAction={(message, modelId) =>
                runAgentMessageAction(selectedGeneralTask, message, modelId)
              }
              onOpenStore={openSkills}
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
            .filter((conversation) => conversation.mode === 'video-dubbing')
            .map((conversation) => (
                <div
                  key={conversation.id}
                  className="agent-workspace-session"
                  hidden={view !== 'video-dubbing' || selectedAgentConversationId !== conversation.id}
                  inert={view !== 'video-dubbing' || selectedAgentConversationId !== conversation.id}
                >
                  <VideoDubbingView
                    initialInstruction={conversation.prompt}
	                    initialSourcePath={conversation.sourcePath}
	                    initialLaunchId={1}
	                    dubbingMode={conversation.videoDubbingMode ?? 'translate'}
	                    dubbingLanguages={conversation.videoDubbingLanguages}
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
