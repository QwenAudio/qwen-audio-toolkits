import { t, useLocale, setLocale } from "./i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Maximize2,
  Menu,
  Minimize2,
  Monitor,
  Moon,
  RefreshCw,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Settings2,
  ShoppingBag,
  MessageSquareText,
  Sparkles,
  SquarePen,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  ProviderSettings,
  type ProviderSettingsKind,
} from "./components/ProviderSettings";
import { WorkspaceSaveIndicator } from "./components/WorkspaceSaveIndicator";
import { runWorkspaceAgentRequest } from "./services/workspaceAgent";
import { getAgentSelection, resolveAcpSelection, type AgentModelOption } from "./domain/agentModelSelection";
import { requestAcpConversation } from "./services/acpConversation";
import {
  appAgentsWithInstallState,
  defaultInstalledAppAgentIds,
  INSTALLED_APP_AGENTS_STORAGE_KEY,
  sanitizeInstalledAppAgentIds,
} from "./appAgents";
import { initialPlugins, fallbackRuntime } from "./data";
import {
  isDemoMode,
  demoPlugins,
  demoCatalog,
  demoMessages,
  demoConversations,
} from "./demo";
import { cloudModelsFromCatalog, isRetiredCloudModelId } from "./cloudModels";
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
} from "./services/harness";
import { getModelBinding, recommendedDependencies } from "./modelDependencies";
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  type AppUpdateInfo,
} from "./services/updater";
import {
  listSavedWorkflows,
  type SavedWorkflow,
} from "./services/workflowRuntime";
import { listAcpProviders, inspectAcpModels, respondAcpPermission } from "./services/acp";
import type { AcpProviderInfo, AcpSessionEvent } from "./types";
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
} from "./types";
import type { WorkflowChatTurn } from "./views/WorkflowChatView";
import type {
  AgentCreationMode,
  AgentCreationOptions,
  GeneralAgentAttachment,
  GeneralAgentMessage,
  GeneralAgentMessageModelOptions,
  GeneralAgentStructuredPlanAction,
  GeneralAgentTask,
  VideoDubbingLanguages,
  VideoDubbingMode,
  VideoDubbingStyle,
} from "./domain/agents";
import { capabilityDefinition } from "./domain/capabilities";
import {
  createOnDemandModelExecutionPlan,
  createInstallModelAction,
  isInstallApproval,
  planOnDemandModelAction,
  resolveOnDemandModelNeeds,
  resolveOnDemandModelExecutions,
  TEXT_INPUT_CAPABILITIES,
  type OnDemandModelExecutionCandidate,
  type OnDemandModelInstallMode,
  type OnDemandModelResolution,
} from "./domain/onDemandModels";
import { agentFileKind } from "./domain/agentFiles";
import { useAgentConversations } from "./hooks/useAgentConversations";
import { matchingSkillConversation, skillAcceptsFile } from "./domain/skillLaunch";
import { audioFileToClip } from "./utils/audio";
import appIconUrl from "../src-tauri/icons/128x128.png";
import "./App.css";

const ModelWorkspaceView = lazy(() =>
  import("./views/ModelWorkspaceView").then((module) => ({
    default: module.ModelWorkspaceView,
  })),
);
const PluginsView = lazy(() =>
  import("./views/PluginsView").then((module) => ({
    default: module.PluginsView,
  })),
);
const WorkflowChatView = lazy(() =>
  import("./views/WorkflowChatView").then((module) => ({
    default: module.WorkflowChatView,
  })),
);
const WorkflowsView = lazy(() =>
  import("./views/WorkflowsView").then((module) => ({
    default: module.WorkflowsView,
  })),
);
const SmartCutView = lazy(() =>
  import("./views/SmartCutView").then((module) => ({
    default: module.SmartCutView,
  })),
);
const AiPodcastView = lazy(() =>
  import("./views/AiPodcastView").then((module) => ({
    default: module.AiPodcastView,
  })),
);
const AgentHomeView = lazy(() =>
  import("./views/AgentHomeView").then((module) => ({
    default: module.AgentHomeView,
  })),
);
const MeetingNotesView = lazy(() =>
  import("./views/MeetingNotesView").then((module) => ({
    default: module.MeetingNotesView,
  })),
);
const VideoDubbingView = lazy(() =>
  import("./views/VideoDubbingView").then((module) => ({
    default: module.VideoDubbingView,
  })),
);
const AgentChatView = lazy(() =>
  import("./views/AgentChatView").then((module) => ({
    default: module.AgentChatView,
  })),
);

type AppView = "workspace" | "agents" | AgentCreationMode | "workflows";
type ThemePreference = "system" | "light" | "dark";
type AppUpdateState = {
  status:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "unavailable"
    | "error";
  update?: AppUpdateInfo;
  progress?: number;
  message?: string;
};

const CLOUD_MODELS_STORAGE_KEY =
  "qwen-audio-toolkits.installed-cloud-models-v1";
const CUSTOM_API_MODELS_STORAGE_KEY =
  "qwen-audio-toolkits.custom-api-models-v1";
const RUNS_REMOVED_EVENT = "harness-runs-removed";
const HISTORY_CLEARED_EVENT = "harness-history-cleared";
const SIDEBAR_WIDTH_KEY = "qwen-audio-toolkits.sidebar-width-v8";
const THEME_STORAGE_KEY = "qwen-audio-toolkits.theme-v1";
const ACCENT_STORAGE_KEY = "qwen-audio-toolkits.accent-v1";
const SIDEBAR_DENSITY_STORAGE_KEY = "qwen-audio-toolkits.sidebar-density-v1";
const CLOSE_BEHAVIOR_STORAGE_KEY = "qwen-audio-toolkits.close-behavior-v1";
const AUTO_UPDATE_STORAGE_KEY = "qwen-audio-toolkits.auto-update-v1";
const LAST_MODEL_STORAGE_KEY = "qwen-audio-toolkits.last-model-v1";
const DEFAULT_VOICE_WORKFLOW_MODELS_KEY =
  "qwen-audio-toolkits.default-voice-workflow-models-v2";
const WORKFLOWS_ENABLED = false;
const NATIVE_TITLEBAR_HEIGHT = 46;
const DRAG_REGION_INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, video, [contenteditable], [role="button"], [role="link"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], [role="dialog"], .modal-backdrop';
const SHOW_INSTALLED_MODELS_SIDEBAR = false;
const APP_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_WORKSPACE_WIDTH = 480;
const WORKSPACE_TASK_MODES: ReadonlySet<AppView> = new Set([
  "smart-cut", "ai-podcast", "video-dubbing", "meeting-notes",
]);

function getInitialTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function getInitialAccent(): AccentColor {
  if (typeof window === "undefined") return "mint";
  try {
    const value = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return value === "indigo" || value === "amber" || value === "rose"
      ? value
      : "mint";
  } catch {
    return "mint";
  }
}

function getInitialSidebarDensity(): SidebarDensity {
  if (typeof window === "undefined") return "comfortable";
  try {
    const value = window.localStorage.getItem(SIDEBAR_DENSITY_STORAGE_KEY);
    return value === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function getInitialCloseBehavior(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CLOSE_BEHAVIOR_STORAGE_KEY) === "quit";
  } catch {
    return false;
  }
}

function getInitialAutoUpdate(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AUTO_UPDATE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function getInitialSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  try {
    const value = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (value === null) return DEFAULT_SIDEBAR_WIDTH;
    const stored = Number(value);
    if (!Number.isFinite(stored)) return DEFAULT_SIDEBAR_WIDTH;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function getInitialSelectedPluginId(): string {
  if (typeof window === "undefined") return "funaudiollm.sensevoice-small-gguf";
  try {
    return (
      window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) ??
      "funaudiollm.sensevoice-small-gguf"
    );
  } catch {
    return "funaudiollm.sensevoice-small-gguf";
  }
}

function getInitialCloudModels(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(CLOUD_MODELS_STORAGE_KEY) ?? "[]",
    );
    const installed = Array.isArray(value)
      ? value.filter(
          (item): item is string =>
            typeof item === "string" && !isRetiredCloudModelId(item),
        )
      : [];
    window.localStorage.setItem(
      CLOUD_MODELS_STORAGE_KEY,
      JSON.stringify(installed),
    );
    if (!window.localStorage.getItem(DEFAULT_VOICE_WORKFLOW_MODELS_KEY)) {
      installed.push(
        "bailian-funasr-realtime",
        "bailian-qwen37-plus",
        "bailian-cosyvoice-v2",
      );
      const next = Array.from(new Set(installed));
      window.localStorage.setItem(
        DEFAULT_VOICE_WORKFLOW_MODELS_KEY,
        "installed",
      );
      window.localStorage.setItem(
        CLOUD_MODELS_STORAGE_KEY,
        JSON.stringify(next),
      );
      return next;
    }
    return installed;
  } catch {
    return [];
  }
}

function getInitialCustomApiModels(): CustomApiModelDefinition[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(CUSTOM_API_MODELS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): CustomApiModelDefinition[] => {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.modelId !== "string" ||
        typeof item.providerId !== "string" ||
        !item.providerId.startsWith("api.")
      ) {
        return [];
      }
      const capability = [
        "text.generate",
        "speech.transcribe",
        "speech.synthesize",
      ].includes(item.capability)
        ? item.capability
        : "text.generate";
      return [
        {
          id: item.id,
          name: item.name,
          modelId: item.modelId,
          providerId: item.providerId,
          capability,
          ...(typeof item.defaultVoice === "string"
            ? { defaultVoice: item.defaultVoice }
            : {}),
        } as CustomApiModelDefinition,
      ];
    });
  } catch {
    return [];
  }
}

function getInitialInstalledAppAgents(): string[] {
  if (typeof window === "undefined") return defaultInstalledAppAgentIds();
  try {
    const saved = window.localStorage.getItem(INSTALLED_APP_AGENTS_STORAGE_KEY);
    if (saved === null) return defaultInstalledAppAgentIds();
    return sanitizeInstalledAppAgentIds(JSON.parse(saved));
  } catch {
    return defaultInstalledAppAgentIds();
  }
}

function upsertRun(runs: HarnessRun[], run: HarnessRun): HarnessRun[] {
  const existingIndex = runs.findIndex((item) => item.id === run.id);
  if (existingIndex >= 0) {
    const next = [...runs];
    next[existingIndex] = run;
    return next;
  }
  return [run, ...runs].sort((left, right) => right.createdAt - left.createdAt);
}

function summarizeRun(run: HarnessRun): HarnessRun {
  return {
    ...run,
    artifacts: run.artifacts.map((artifact) => ({
      ...artifact,
      payload: {},
    })),
  };
}

type ShellPage = "workspace" | "skills" | "models" | "settings";
type SettingsSection = "general" | "appearance" | "storage";

type AccentColor = "mint" | "indigo" | "amber" | "rose";

const ACCENT_OPTIONS: {
  id: AccentColor;
  label: string;
  swatch: string;
}[] = [
  {
    id: "mint",
    get label() {
      return t("青瓷绿");
    },
    swatch: "#4c7e6c",
  },
  {
    id: "indigo",
    get label() {
      return t("靛蓝");
    },
    swatch: "#4d63b0",
  },
  {
    id: "amber",
    get label() {
      return t("琥珀");
    },
    swatch: "#9a7a2f",
  },
  {
    id: "rose",
    get label() {
      return t("玫瑰");
    },
    swatch: "#a95f6f",
  },
];

type SidebarDensity = "comfortable" | "compact";

interface PendingOnDemandInstall {
  resolution: OnDemandModelResolution
  prompt: string
  selectedModeName: string | null
  attachmentHint: string
  attachment: GeneralAgentAttachment | null
  chain?: {
    resolutions: OnDemandModelResolution[]
  }
}

const SIDEBAR_DENSITY_OPTIONS: {
  id: SidebarDensity;
  label: string;
}[] = [
  {
    id: "comfortable",
    get label() {
      return t("舒适");
    },
  },
  {
    id: "compact",
    get label() {
      return t("紧凑");
    },
  },
];

const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  Icon: typeof Palette;
}[] = [
  {
    id: "general",
    get label() {
      return t("常规");
    },
    Icon: Settings2,
  },
  {
    id: "appearance",
    get label() {
      return t("外观");
    },
    Icon: Palette,
  },
  {
    id: "storage",
    get label() {
      return t("模型与存储");
    },
    Icon: HardDrive,
  },
];

function App() {
  const locale = useLocale();

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke("set_ui_language", { language: locale }).catch((error) => {
      console.error("Could not update the native menu language", error);
    });
  }, [locale]);

  const demoMode = isDemoMode();
  const demoTaskSeed = demoMode
    ? [
        {
          id: 'demo-task-1',
          kind: 'general' as const,
          title: '删除口水词和静音',
          draftPrompt: '',
          messages: demoMessages,
          selectedModeId: null as AgentCreationMode | null,
          attachment: null,
          createdAt: Date.now() - 120_000,
          updatedAt: Date.now() - 60_000,
          submitting: false,
        },
      ]
    : undefined;
  const [view, setView] = useState<AppView>("agents");
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspacePanelFocused, setWorkspacePanelFocused] = useState(false);
  const {
    conversations: agentConversations,
    generalTasks,
    selectedId: selectedAgentConversationId,
    selectedConversation: selectedAgentConversation,
    selectedGeneralTask,
    createGeneralTask,
    ensureGeneralTask,
    updateGeneralTask,
    recordWorkspaceBrief,
    updateGeneralMessageActionStatus,
    updateStructuredPlanStep,
    submitGeneralPrompt: submitGeneralPromptToTask,
    selectConversation: setSelectedAgentConversationId,
    createConversation: createAgentConversation,
    ready: workspaceReady,
    restoredSelectedId,
  } = useAgentConversations(
    demoMode ? demoConversations : undefined,
    demoTaskSeed,
  );
  const initialViewRestoredRef = useRef(false);
  const [openedAgentIds, setOpenedAgentIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!workspaceReady || initialViewRestoredRef.current) return;
    initialViewRestoredRef.current = true;
    if (restoredSelectedId) setView(selectedAgentConversation?.mode ?? "agents");
  }, [workspaceReady, restoredSelectedId, selectedAgentConversation]);
  useEffect(() => {
    if (!selectedAgentConversation) return;
    setOpenedAgentIds(current => current.has(selectedAgentConversation.id)
      ? current : new Set([...current, selectedAgentConversation.id]));
  }, [selectedAgentConversation]);
  const openedAgentConversations = agentConversations.filter(conversation =>
    openedAgentIds.has(conversation.id) || conversation.id === selectedAgentConversationId,
  );
  const isWorkspaceTaskView = WORKSPACE_TASK_MODES.has(view);
  const activeWorkspaceRef = useRef({ id: null as string | null, epoch: 0 });
  useLayoutEffect(() => {
    const id = isWorkspaceTaskView ? selectedAgentConversationId : null;
    if (activeWorkspaceRef.current.id !== id) {
      activeWorkspaceRef.current = { id, epoch: activeWorkspaceRef.current.epoch + 1 };
    }
  }, [isWorkspaceTaskView, selectedAgentConversationId]);
  useEffect(() => {
    if (isWorkspaceTaskView && selectedAgentConversationId) {
      setWorkspacePanelOpen(true);
      setWorkspacePanelFocused(false);
    }
  }, [isWorkspaceTaskView, selectedAgentConversationId]);
  const [agentHomeMode, setAgentHomeMode] = useState<AgentCreationMode | null>(
    null,
  );
  const pendingGeneralTaskRef = useRef<GeneralAgentTask | null>(null);
  const pendingOnDemandModelRef = useRef(
    new Map<string, PendingOnDemandInstall>(),
  );
  const [agentModelInstallMode, setAgentModelInstallMode] =
    useState<OnDemandModelInstallMode>("ask");
  const [agentMessageModelSelections, setAgentMessageModelSelections] =
    useState<Record<string, string>>({});
  const [agentChatAvailable, setAgentChatAvailable] = useState(false);
  const [acpProviders, setAcpProviders] = useState<AcpProviderInfo[]>(demoMode ? [
    { id: 'qoder', name: 'Qoder', available: true }, { id: 'kimi', name: 'Kimi Code', available: true },
    { id: 'codex', name: 'Codex', available: true }, { id: 'qwen-code', name: 'Qwen Code', available: true },
  ] : []);
  const [acpModels, setAcpModels] = useState<Record<string, { loading: boolean; options: AgentModelOption[]; error?: string }>>({});
  const acpModelLoads = useRef(new Set<string>());
  const acpTurns = useRef(new Map<string, AbortController>());
  const [activeAcpTasks, setActiveAcpTasks] = useState<string[]>([]);
  const [acpPermissions, setAcpPermissions] = useState<Array<{ taskId: string; event: AcpSessionEvent }>>([]);
  useEffect(() => () => { for (const controller of acpTurns.current.values()) controller.abort(); }, []);
  const [shellPage, setShellPage] = useState<ShellPage>("workspace");
  const [plugins, setPlugins] = useState<ModelPlugin[]>(
    demoMode ? demoPlugins : initialPlugins,
  );
  const [pluginsLoaded, setPluginsLoaded] = useState(() => demoMode || !isTauriRuntime());
  const [runtime, setRuntime] = useState<RuntimeStatus>(fallbackRuntime);
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(
    demoMode ? demoCatalog : null,
  );
  const [apiModelCatalog, setApiModelCatalog] = useState<
    ApiModelCatalogEntry[]
  >([]);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  // Per-provider chat history for text.generate, so the LLM keeps context
  // across turns instead of treating every message as a fresh conversation.
  const [textHistory, setTextHistory] = useState<
    Record<string, { role: "user" | "assistant"; content: string }[]>
  >({});

  useEffect(() => {
    if (selectedGeneralTask) pendingGeneralTaskRef.current = null;
  }, [selectedGeneralTask]);
  const [activeRunIds, setActiveRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [installedCloudModelIds, setInstalledCloudModelIds] = useState<
    string[]
  >(getInitialCloudModels);
  const [installedAppAgentIds, setInstalledAppAgentIds] = useState<string[]>(
    getInitialInstalledAppAgents,
  );
  const [customApiModels, setCustomApiModels] = useState<
    CustomApiModelDefinition[]
  >(getInitialCustomApiModels);
  const [modelBindings, setModelBindings] = useState<ModelDependencyBindings>(
    {},
  );
  const [modelBindingsLoaded, setModelBindingsLoaded] =
    useState(!isTauriRuntime());
  const [selectedPluginId, setSelectedPluginId] = useState(
    getInitialSelectedPluginId,
  );
  const [workflows, setWorkflows] =
    useState<SavedWorkflow[]>(listSavedWorkflows);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  );
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(
    null,
  );
  const [workflowSelected, setWorkflowSelected] = useState(false);
  const [workflowTurns, setWorkflowTurns] = useState<
    Record<string, WorkflowChatTurn[]>
  >({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recentTasksExpanded, setRecentTasksExpanded] = useState(true);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const extensionsTriggerRef = useRef<HTMLButtonElement>(null);
  const extensionsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const [settingsProvider, setSettingsProvider] =
    useState<ProviderSettingsKind>("bailian");
  const [settingsCustomProviderId, setSettingsCustomProviderId] = useState(
    "api.openai-compatible",
  );
  const [clearingHistory, setClearingHistory] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    status: "idle",
  });
  const appUpdateStatusRef = useRef<AppUpdateState["status"]>("idle");
  const [toast, setToast] = useState<string | null>(null);
  const repairingDependenciesRef = useRef(new Set<string>());
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getInitialTheme);
  const [accent, setAccent] = useState<AccentColor>(getInitialAccent);
  const [sidebarDensity, setSidebarDensity] = useState<SidebarDensity>(
    getInitialSidebarDensity,
  );
  const [installedModelsExpanded, setInstalledModelsExpanded] = useState(true);
  const [expandedModelCategories, setExpandedModelCategories] = useState<
    Set<string>
  >(new Set());
  const [quitOnClose, setQuitOnClose] = useState<boolean>(
    getInitialCloseBehavior,
  );
  const [autoUpdateCheck, setAutoUpdateCheck] =
    useState<boolean>(getInitialAutoUpdate);
  const [dataDirectory, setDataDirectory] = useState<string | null>(null);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [systemDark, setSystemDark] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme =
    themePreference === "system"
      ? systemDark
        ? "dark"
        : "light"
      : themePreference;
  const usesOverlayTitlebar =
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent);
  const leaveShellPage = useCallback(() => {
    const leaving = shellPage;
    setShellPage("workspace");
    setSidebarOpen(false);
    const returnTarget = extensionsReturnFocusRef.current;
    window.requestAnimationFrame(() => {
      const trigger =
        leaving === "settings"
          ? settingsTriggerRef.current
          : extensionsTriggerRef.current;
      const target = window.innerWidth <= 900
        ? sidebarTriggerRef.current
        : returnTarget?.isConnected ? returnTarget : trigger;
      target?.focus();
    });
  }, [shellPage]);
  const closeProviderDialog = useCallback(() => {
    setProviderDialogOpen(false);
    const returnTarget = settingsReturnFocusRef.current;
    window.requestAnimationFrame(() => {
      const target = returnTarget?.isConnected
        ? returnTarget
        : settingsTriggerRef.current;
      target?.focus();
    });
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    if (viewportWidth > 900) setSidebarOpen(false);
  }, [viewportWidth]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSidebar();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeSidebar, sidebarOpen]);

  useEffect(() => {
    if (!providerDialogOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeProviderDialog();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [closeProviderDialog, providerDialogOpen]);

  useEffect(() => {
    if (shellPage === "workspace" || providerDialogOpen || sidebarOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      leaveShellPage();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [leaveShellPage, providerDialogOpen, shellPage, sidebarOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    if (isTauriRuntime()) {
      void getCurrentWindow().setTheme(resolvedTheme);
    }
  }, [resolvedTheme]);

  // The overlay titlebar hides the native drag area; make the window's top
  // strip draggable anywhere except on interactive controls.
  useEffect(() => {
    if (!usesOverlayTitlebar || !isTauriRuntime()) return undefined;
    const startDragFromTitlebarStrip = (event: MouseEvent) => {
      if (event.button !== 0 || event.clientY > NATIVE_TITLEBAR_HEIGHT) return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest(DRAG_REGION_INTERACTIVE_SELECTOR)) return;
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    };
    document.addEventListener("mousedown", startDragFromTitlebarStrip);
    return () =>
      document.removeEventListener("mousedown", startDragFromTitlebarStrip);
  }, [usesOverlayTitlebar]);

  const selectTheme = (theme: ThemePreference) => {
    setThemePreference(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the theme for the current session when storage is unavailable.
    }
  };

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    document.documentElement.dataset.density = sidebarDensity;
  }, [accent, sidebarDensity]);

  const selectAccent = (value: AccentColor) => {
    setAccent(value);
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, value);
    } catch {
      // Keep the accent for the current session when storage is unavailable.
    }
  };

  const selectSidebarDensity = (value: SidebarDensity) => {
    setSidebarDensity(value);
    try {
      window.localStorage.setItem(SIDEBAR_DENSITY_STORAGE_KEY, value);
    } catch {
      // Keep the density for the current session when storage is unavailable.
    }
  };

  const selectCloseBehavior = (quit: boolean) => {
    setQuitOnClose(quit);
    try {
      window.localStorage.setItem(
        CLOSE_BEHAVIOR_STORAGE_KEY,
        quit ? "quit" : "dock",
      );
    } catch {
      // Keep the preference for the current session when storage is unavailable.
    }
    if (isTauriRuntime()) {
      void setCloseBehavior(quit);
    }
  };

  const selectAutoUpdateCheck = (enabled: boolean) => {
    setAutoUpdateCheck(enabled);
    try {
      window.localStorage.setItem(
        AUTO_UPDATE_STORAGE_KEY,
        enabled ? "on" : "off",
      );
    } catch {
      // Keep the preference for the current session when storage is unavailable.
    }
  };

  const revealDataDirectory = async () => {
    if (!dataDirectory) return;
    try {
      await revealInFileManager(dataDirectory);
    } catch (error) {
      notify(
        t("无法打开数据目录：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    }
  };

  const cleanDownloadCache = async () => {
    setCleaningCache(true);
    try {
      const removed = await cleanupDownloadCache();
      notify(
        removed > 0
          ? t("已清理 {0} 个下载缓存文件", [removed])
          : t("没有可清理的下载缓存"),
      );
    } catch (error) {
      notify(
        t("清理下载缓存失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    } finally {
      setCleaningCache(false);
    }
  };

  const cloudModelPlugins = useMemo<ModelPlugin[]>(() => {
    return cloudModelsFromCatalog(
      catalog,
      installedCloudModelIds,
      apiModelCatalog,
      customApiModels,
    ).filter((plugin) => plugin.installed);
  }, [apiModelCatalog, catalog, customApiModels, installedCloudModelIds]);
  const appAgents = useMemo(
    () => appAgentsWithInstallState(installedAppAgentIds),
    [installedAppAgentIds],
  );
  const setAppAgentInstalled = (agentId: string, installed: boolean) => {
    setInstalledAppAgentIds((current) => {
      const next = sanitizeInstalledAppAgentIds(
        installed
          ? [...current, agentId]
          : current.filter((id) => id !== agentId),
      );
      try {
        window.localStorage.setItem(
          INSTALLED_APP_AGENTS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Keep the current session state when storage is unavailable.
      }
      return next;
    });
    const agent = appAgents.find((candidate) => candidate.id === agentId);
    if (!installed && agent?.workspaceEntry === view) changeView("agents");
  };

  useEffect(() => {
    if (!modelBindingsLoaded) return;
    const next: ModelDependencyBindings = {};
    for (const model of [...plugins, ...cloudModelPlugins]) {
      if (!model.installed) continue;
      const dependencies = recommendedDependencies(model);
      if (!dependencies.length) continue;
      next[model.id] = {};
      for (const dependency of dependencies) {
        const selected = getModelBinding(
          modelBindings,
          model.id,
          dependency.role,
          dependency.default ? dependency.pluginId : "",
          plugins,
        );
        next[model.id][dependency.role] =
          dependency.role === "speech-segmentation" && selected === "silero-vad"
            ? dependency.pluginId
            : selected;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(modelBindings)) return;
    setModelBindings(next);
    if (isTauriRuntime()) {
      void replaceModelDependencyBindings(next).catch((error) =>
        setToast(
          t("无法保存模型依赖：{0}", [
            error instanceof Error ? error.message : String(error),
          ]),
        ),
      );
    }
  }, [cloudModelPlugins, modelBindings, modelBindingsLoaded, plugins]);

  const removeModelBindings = (pluginId: string) => {
    setModelBindings((current) => {
      if (!(pluginId in current)) return current;
      const next = { ...current };
      delete next[pluginId];
      if (isTauriRuntime()) {
        void replaceModelDependencyBindings(next).catch((error) =>
          setToast(
            t("无法清理模型依赖：{0}", [
              error instanceof Error ? error.message : String(error),
            ]),
          ),
        );
      }
      return next;
    });
  };

  const saveModelBinding = (
    pluginId: string,
    role: string,
    dependencyId: string,
  ): Promise<void> => {
    if (!isTauriRuntime()) {
      setModelBindings((current) => ({
        ...current,
        [pluginId]: { ...current[pluginId], [role]: dependencyId },
      }));
      return Promise.resolve();
    }
    return setModelDependencyBinding(pluginId, role, dependencyId).then(
      setModelBindings,
    );
  };

  const setCloudModelInstalled = (modelId: string, installed: boolean) => {
    if (!installed) removeModelBindings(modelId);
    setInstalledCloudModelIds((current) => {
      const next = installed
        ? Array.from(new Set([...current, modelId]))
        : current.filter((id) => id !== modelId);
      try {
        window.localStorage.setItem(
          CLOUD_MODELS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Keep the current session state when storage is unavailable.
      }
      return next;
    });
  };

  const runnablePlugins = useMemo(() => {
    const visible = new Map<string, ModelPlugin>();
    for (const plugin of plugins) {
      if (
        plugin.installed &&
        plugin.sidebarVisible !== false &&
        plugin.providerId
      ) {
        visible.set(plugin.id, plugin);
      }
    }
    for (const plugin of cloudModelPlugins) visible.set(plugin.id, plugin);
    return [...visible.values()];
  }, [cloudModelPlugins, plugins]);
  const orderedRunnablePlugins = useMemo(() => {
    return runnablePlugins;
  }, [runnablePlugins]);
  const selectedChatModel = getAgentSelection(selectedGeneralTask?.chatModel);
  const chosenAcpProvider = selectedChatModel.providerId;
  const chatModelOptions = Object.values(acpModels).flatMap(value => value.options);
  const loadAcpModels = useCallback(async (providerId: string) => {
    if (acpModelLoads.current.has(providerId)) return;
    acpModelLoads.current.add(providerId);
    setAcpModels(current => ({ ...current, [providerId]: { loading: true, options: [] } }));
    try {
      const { models } = await inspectAcpModels(providerId);
      setAcpModels(current => ({ ...current, [providerId]: { loading: false,
        options: models.map(model => ({ ...model, providerId, available: true })) } }));
    } catch (error) {
      setAcpModels(current => ({ ...current, [providerId]: { loading: false, options: [], error: String(error) } }));
    } finally { acpModelLoads.current.delete(providerId); }
  }, []);
  useEffect(() => {
    if (chosenAcpProvider && !acpModels[chosenAcpProvider] && acpProviders.some(provider => provider.id === chosenAcpProvider && provider.available)) {
      void loadAcpModels(chosenAcpProvider);
    }
  }, [chosenAcpProvider, acpModels, acpProviders, loadAcpModels]);
  const requestTaskAgentReply = async (task: GeneralAgentTask, messages: GeneralAgentMessage[], workspacePlanning = false) => {
    if (!isTauriRuntime()) throw new Error(t('ACP Agent 对话需要在桌面端运行。'));
    const selection = resolveAcpSelection(task.chatModel, acpProviders);
    const controller = new AbortController();
    acpTurns.current.set(task.id, controller);
    setActiveAcpTasks(current => [...current.filter(id => id !== task.id), task.id]);
    try {
      return await requestAcpConversation({ selection, messages, signal: controller.signal, enableTools: !workspacePlanning,
        onPermission: event => setAcpPermissions(current => [...current.filter(item => item.event.requestId !== event.requestId || item.event.sessionId !== event.sessionId), { taskId: task.id, event }]),
      });
    } finally {
      acpTurns.current.delete(task.id);
      setActiveAcpTasks(current => current.filter(id => id !== task.id));
      setAcpPermissions(current => current.filter(item => item.taskId !== task.id));
    }
  };
  const submitGeneralPrompt = (request: Parameters<typeof submitGeneralPromptToTask>[0]) => submitGeneralPromptToTask({
    ...request, agentResponse: request.agentResponse ?? (messages => requestTaskAgentReply(request.task, messages)),
  });
  const responsiveSidebarMaxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.floor(viewportWidth - MIN_WORKSPACE_WIDTH),
    ),
  );
  const visibleSidebarWidth = Math.min(sidebarWidth, responsiveSidebarMaxWidth);
  const visibleContentOffset = viewportWidth <= 900 ? 0 : visibleSidebarWidth;
  const compactWorkspace = viewportWidth - visibleContentOffset < 760;
  const editorVisible = isWorkspaceTaskView && workspacePanelOpen;
  const editorFillsWorkspace = editorVisible && (compactWorkspace || workspacePanelFocused);

  const selectedPlugin =
    orderedRunnablePlugins.find((plugin) => plugin.id === selectedPluginId) ??
    orderedRunnablePlugins[0] ??
    initialPlugins[0];

  useEffect(() => {
    if (
      view !== "workspace" ||
      !isTauriRuntime() ||
      !selectedPlugin.installed
    ) {
      return;
    }
    const missing = recommendedDependencies(selectedPlugin).filter(
      (dependency) => {
        if (dependency.optional) return false;
        const dependencyId = getModelBinding(
          modelBindings,
          selectedPlugin.id,
          dependency.role,
          dependency.default ? dependency.pluginId : "",
          plugins,
        );
        return (
          dependencyId &&
          !plugins.some(
            (candidate) => candidate.id === dependencyId && candidate.installed,
          )
        );
      },
    );
    if (
      !missing.length ||
      repairingDependenciesRef.current.has(selectedPlugin.id)
    ) {
      return;
    }
    repairingDependenciesRef.current.add(selectedPlugin.id);
    void (async () => {
      try {
        notify(t("正在补齐 {0} 的配套组件", [selectedPlugin.name]));
        for (const dependency of missing) {
          const dependencyId = getModelBinding(
            modelBindings,
            selectedPlugin.id,
            dependency.role,
            dependency.default ? dependency.pluginId : "",
            plugins,
          );
          if (dependencyId)
            await installRecommendedModelDependency(dependencyId);
        }
        const [nextPlugins, nextCatalog] = await Promise.all([
          listModelPlugins(),
          getHarnessCatalog(),
        ]);
        setPlugins(nextPlugins);
        setCatalog(nextCatalog);
        notify(t("{0} 的配套组件已就绪", [selectedPlugin.name]));
      } catch (error) {
        repairingDependenciesRef.current.delete(selectedPlugin.id);
        notify(
          t("配套组件安装失败：{0}", [
            error instanceof Error ? error.message : String(error),
          ]),
        );
      }
    })();
  }, [modelBindings, plugins, selectedPlugin, view]);

  const recordRun = (run: HarnessRun) => {
    const summary = summarizeRun(run);
    setRuns((current) => upsertRun(current, summary));
    setActiveRunIds((current) => {
      const next = new Set(current);
      if (summary.status === "running") next.add(summary.id);
      else next.delete(summary.id);
      return next;
    });
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    const refreshCatalog = () => {
      void refreshModelPlugins()
        .then((nextPlugins) => {
          if (!disposed) setPlugins(nextPlugins);
          return listApiModelCatalog();
        })
        .then((nextApiModels) => {
          if (!disposed) setApiModelCatalog(nextApiModels);
        })
        .catch(() => {
          // Cached or built-in catalog remains available when the remote source is offline.
        });
    };

    invoke<RuntimeStatus>("runtime_status")
      .then(setRuntime)
      .catch(() => setRuntime(fallbackRuntime));
    void getHarnessCatalog()
      .then(setCatalog)
      .catch(() => setCatalog(null));
    void listHarnessRuns()
      .then((nextRuns) => setRuns(nextRuns.map(summarizeRun)))
      .catch(() => setRuns([]));
    void listModelPlugins()
      .then(setPlugins)
      .catch(() => setPlugins(initialPlugins))
      .finally(() => setPluginsLoaded(true));
    void listApiModelCatalog()
      .then(setApiModelCatalog)
      .catch(() => undefined);
    void getModelDependencyBindings()
      .then(setModelBindings)
      .catch(() => setModelBindings({}))
      .finally(() => setModelBindingsLoaded(true));
    refreshCatalog();
    const catalogRefreshTimer = window.setInterval(
      refreshCatalog,
      MODEL_CATALOG_REFRESH_INTERVAL_MS,
    );

    let unlisten: (() => void) | undefined;
    void subscribeHarnessRuns((run) => {
      if (disposed) return;
      recordRun(run);
    }).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });

    let unlistenRemoved: (() => void) | undefined;
    void listen<string[]>(RUNS_REMOVED_EVENT, (event) => {
      if (disposed) return;
      const removed = new Set(event.payload);
      setRuns((current) => {
        const next = current.filter((run) => !removed.has(run.id));
        return next.length === current.length ? current : next;
      });
    }).then((remove) => {
      if (disposed) remove();
      else unlistenRemoved = remove;
    });

    let unlistenHistoryCleared: (() => void) | undefined;
    void listen(HISTORY_CLEARED_EVENT, () => {
      if (disposed) return;
      setRuns((current) => (current.length ? [] : current));
      setWorkflowTurns((current) =>
        Object.keys(current).length ? {} : current,
      );
    }).then((remove) => {
      if (disposed) remove();
      else unlistenHistoryCleared = remove;
    });

    // Fallback: whenever this window regains focus, re-sync history from the backend so
    // clears performed in another window are reflected even if an event was missed.
    const refetchRunsOnFocus = () => {
      if (disposed || !isTauriRuntime()) return;
      void listHarnessRuns()
        .then((nextRuns) => {
          if (!disposed) setRuns(nextRuns.map(summarizeRun));
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refetchRunsOnFocus);

    return () => {
      disposed = true;
      window.clearInterval(catalogRefreshTimer);
      window.removeEventListener("focus", refetchRunsOnFocus);
      unlisten?.();
      unlistenRemoved?.();
      unlistenHistoryCleared?.();
    };
  }, []);

  useEffect(() => {
    if (
      pluginsLoaded &&
      orderedRunnablePlugins.length &&
      !orderedRunnablePlugins.some((plugin) => plugin.id === selectedPluginId)
    ) {
      setSelectedPluginId(orderedRunnablePlugins[0].id);
    }
  }, [orderedRunnablePlugins, pluginsLoaded, selectedPluginId]);

  useEffect(() => {
    if (
      !pluginsLoaded ||
      !orderedRunnablePlugins.some((plugin) => plugin.id === selectedPluginId)
    ) {
      return;
    }
    try {
      window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, selectedPluginId);
    } catch {
      // Keep the current session selection when storage is unavailable.
    }
  }, [orderedRunnablePlugins, pluginsLoaded, selectedPluginId]);

  useEffect(() => {
    if (!pluginsLoaded || expandedModelCategories.size > 0) return;
    const categories = new Set<string>();
    for (const plugin of runnablePlugins) {
      const capability = plugin.harnessCapabilities[0];
      if (!capability) continue;
      categories.add(capabilityDefinition(capability).category);
    }
    setExpandedModelCategories(categories);
  }, [runnablePlugins, pluginsLoaded, expandedModelCategories]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = (message: string) => setToast(message);

  const downloadApplicationUpdate = async (silent = false) => {
    if (
      appUpdateStatusRef.current === "downloading" ||
      appUpdateStatusRef.current === "downloaded" ||
      appUpdateStatusRef.current === "installing"
    ) {
      return;
    }
    appUpdateStatusRef.current = "downloading";
    setAppUpdate((current) => ({
      ...current,
      status: "downloading",
      progress: 0,
    }));
    try {
      await downloadAppUpdate((downloaded, total) => {
        setAppUpdate((current) => ({
          ...current,
          status: "downloading",
          progress: total
            ? Math.min(100, (downloaded / total) * 100)
            : undefined,
        }));
      });
      appUpdateStatusRef.current = "downloaded";
      setAppUpdate((current) => ({
        ...current,
        status: "downloaded",
        progress: 100,
      }));
      if (!silent) notify(t("更新已下载，点击“重启安装”完成更新"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appUpdateStatusRef.current = "error";
      setAppUpdate((current) => ({ ...current, status: "error", message }));
      if (!silent) notify(t("下载更新失败：{0}", [message]));
    }
  };

  const checkApplicationUpdate = async (silent = false) => {
    if (
      appUpdateStatusRef.current === "checking" ||
      appUpdateStatusRef.current === "downloading" ||
      appUpdateStatusRef.current === "installing" ||
      (silent &&
        (appUpdateStatusRef.current === "available" ||
          appUpdateStatusRef.current === "downloaded"))
    ) {
      return;
    }
    appUpdateStatusRef.current = "checking";
    setAppUpdate({ status: "checking" });
    try {
      const result = await checkForAppUpdate();
      if (result.status === "available") {
        appUpdateStatusRef.current = "available";
        setAppUpdate({ status: "available", update: result.update });
        if (!silent)
          notify(t("发现新版本 {0}，正在后台下载", [result.update.version]));
        void downloadApplicationUpdate(silent);
      } else if (result.status === "current") {
        appUpdateStatusRef.current = "current";
        setAppUpdate({ status: "current" });
        if (!silent) notify(t("当前已是最新版本"));
      } else {
        appUpdateStatusRef.current = "unavailable";
        setAppUpdate({ status: "unavailable", message: result.message });
        if (!silent) notify(result.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appUpdateStatusRef.current = "error";
      setAppUpdate({ status: "error", message });
      if (!silent) notify(t("检查更新失败：{0}", [message]));
    }
  };

  const applyApplicationUpdate = async () => {
    if (activeRunIds.size > 0) {
      notify(t("请等待当前模型任务结束后再安装更新"));
      return;
    }
    if (
      appUpdateStatusRef.current === "downloading" ||
      appUpdateStatusRef.current === "installing"
    ) {
      return;
    }
    if (appUpdateStatusRef.current === "available") {
      await downloadApplicationUpdate();
    }
    if (appUpdateStatusRef.current !== "downloaded") return;
    appUpdateStatusRef.current = "installing";
    setAppUpdate((current) => ({ ...current, status: "installing" }));
    try {
      await installAppUpdate((downloaded, total) => {
        setAppUpdate((current) => ({
          ...current,
          status: "installing",
          progress: total
            ? Math.min(100, (downloaded / total) * 100)
            : undefined,
        }));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appUpdateStatusRef.current = "error";
      setAppUpdate((current) => ({ ...current, status: "error", message }));
      notify(t("安装更新失败：{0}", [message]));
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("app-update-check-requested", () => {
      void checkApplicationUpdate();
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !isTauriRuntime() || !autoUpdateCheck) {
      return undefined;
    }
    const initialTimer = window.setTimeout(
      () => void checkApplicationUpdate(true),
      10_000,
    );
    const interval = window.setInterval(
      () => void checkApplicationUpdate(true),
      APP_UPDATE_CHECK_INTERVAL_MS,
    );
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUpdateCheck]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void setCloseBehavior(getInitialCloseBehavior());
  }, []);

  useEffect(() => {
    if (shellPage !== "settings" || settingsSection !== "storage") return;
    if (!isTauriRuntime() || dataDirectory !== null) return;
    let disposed = false;
    void appDataDirectory()
      .then((dir) => {
        if (!disposed) setDataDirectory(dir);
      })
      .catch(() => {
        if (!disposed) setDataDirectory("");
      });
    return () => {
      disposed = true;
    };
  }, [shellPage, settingsSection, dataDirectory]);

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    let nextWidth = sidebarWidth;
    let finished = false;
    document.body.classList.add("sidebar-resizing");
    handle.setPointerCapture(pointerId);

    function resize(pointerEvent: PointerEvent) {
      nextWidth = Math.min(
        responsiveSidebarMaxWidth,
        Math.max(MIN_SIDEBAR_WIDTH, pointerEvent.clientX),
      );
      setSidebarWidth(nextWidth);
    }

    function finish() {
      if (finished) return;
      finished = true;
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
      } catch {
        // Keep the resized width for the current session.
      }
    }

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    handle.addEventListener("lostpointercapture", finish);
  };
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
  const updateAgentCreationOptions = (creationOptions: AgentCreationOptions) => {
    const task = materializeGeneralTask();
    updateGeneralTask(task.id, { creationOptions });
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
    promptText?: string,
  ): Promise<{ content: string; attachments: GeneralAgentAttachment[] } | null> => {
    const plan = createOnDemandModelExecutionPlan(
      pending.resolution,
      model,
      pending.attachment,
      promptText ?? pending.prompt,
    )
    if (!plan) return null
    const providerId = model.providerId ?? model.id
    const isTextInput = TEXT_INPUT_CAPABILITIES.has(plan.capability)
    const attachment = pending.attachment

    if (isTextInput) {
      const text = promptText?.trim() || pending.prompt.trim()
      if (!text) return null
      notify(t('正在使用 {0} 处理', [model.name]))
      if (plan.capability === 'speech.synthesize') {
        const execution = await executeHarnessTask<TtsGenerateResult>(
          {
            capability: plan.capability,
            providerId,
            conversationProviderId: providerId,
            conversationVisible: true,
            routing: 'local',
            title: t('语音合成'),
            input: { text },
            parameters: {
              modelId: model.version || model.id,
              ...plan.parameters,
            },
          },
          recordRun,
        )
        recordRun(execution.run)
        const filePath = (execution.output as { filePath?: string }).filePath ?? ''
        return {
          content: t('已完成语音合成，输出文件：{0}', [filePath]),
          attachments: filePath ? [{ path: filePath, name: filePath.split(/[\\/]/u).at(-1) ?? 'tts.wav' }] : [],
        }
      }
      if (plan.capability === 'text.generate') {
        const execution = await executeHarnessTask<TextGenerateResult | Record<string, unknown>>(
          {
            capability: plan.capability,
            providerId,
            conversationProviderId: providerId,
            conversationVisible: true,
            routing: 'local',
            title: t('文本生成'),
            input: { text },
            parameters: {
              modelId: model.version || model.id,
              ...plan.parameters,
            },
          },
          recordRun,
        )
        recordRun(execution.run)
        const generatedText = (execution.output as { text?: string }).text?.trim() || ''
        return {
          content: generatedText || t('模型未返回有效文本。'),
          attachments: [],
        }
      }
      const execution = await executeHarnessTask<Record<string, unknown>>(
        {
          capability: plan.capability,
          providerId,
          conversationProviderId: providerId,
          conversationVisible: true,
          routing: 'local',
          title: t('文本规范化'),
          input: { text },
          parameters: {
            modelId: model.version || model.id,
            ...plan.parameters,
          },
        },
        recordRun,
      )
      recordRun(execution.run)
      const outputText = (execution.output as { text?: string }).text?.trim() || JSON.stringify(execution.output)
      return {
        content: t('已完成文本规范化：\n\n{0}', [outputText]),
        attachments: [],
      }
    }

    if (!attachment) return null
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
    if (plan.capability === 'speech.detect') {
      const execution = await executeHarnessTask<VadDetectionResult>(
        {
          capability: plan.capability,
          providerId,
          conversationProviderId: providerId,
          conversationVisible: true,
          routing: 'local',
          title: t('{0} · 语音检测', [attachment.name]),
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
      const segments = execution.output.segments ?? []
      const summary = segments.length
        ? segments.map((seg: { start: number; end: number }) =>
            `${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`).join('\n')
        : t('未检测到语音活动段。')
      return {
        content: t('已完成语音活动检测，共 {0} 段：\n\n{1}', [String(segments.length), summary]),
        attachments: [],
      }
    }
    if (plan.capability === 'speaker.embed') {
      const execution = await executeHarnessTask<Record<string, unknown>>(
        {
          capability: plan.capability,
          providerId,
          conversationProviderId: providerId,
          conversationVisible: true,
          routing: 'local',
          title: t('{0} · 声纹识别', [attachment.name]),
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
        content: t('已完成声纹特征提取。'),
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
        title: plan.capability === 'audio.separate'
          ? t('{0} · 音频分离', [attachment.name])
          : t('{0} · 音频降噪', [attachment.name]),
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
    const actionLabel = plan.capability === 'audio.separate'
      ? t('已完成音频分离，输出新文件 `{0}`。文件位置：{1}', [
          execution.output.fileName,
          execution.output.filePath,
        ])
      : t('已完成降噪，输出新文件 `{0}`。文件位置：{1}', [
          execution.output.fileName,
          execution.output.filePath,
        ])
    return {
      content: actionLabel,
      attachments: [
        {
          path: execution.output.filePath,
          name: execution.output.fileName,
        },
      ],
    }
  }
  const runOnDemandModelExecutionSequence = async (
    pending: PendingOnDemandInstall,
    resolutions: OnDemandModelResolution[],
    installMissing: boolean,
  ): Promise<{ content: string; attachments: GeneralAgentAttachment[] } | null> => {
    let currentAttachment = pending.attachment
    const contents: string[] = []
    const attachments: GeneralAgentAttachment[] = []
    for (const resolution of resolutions) {
      const model = resolution.installedModel ?? (
        installMissing ? await installOnDemandModel(resolution) : null
      )
      if (!model) return null
      const result = await runOnDemandModelExecution({
        ...pending,
        resolution: {
          ...resolution,
          installedModel: model,
          recommendedModel: model,
        },
        attachment: currentAttachment,
      }, model)
      if (!result) return null
      contents.push(result.content)
      if (result.attachments.length) {
        attachments.push(...result.attachments)
        currentAttachment = result.attachments[0]
      }
    }
    if (contents.length === 1) {
      return { content: contents[0], attachments }
    }
    return {
      content: t('已完成 {0} 个步骤：\n\n{1}', [
        String(contents.length),
        contents.map((content, index) => `${index + 1}. ${content}`).join('\n\n'),
      ]),
      attachments,
    }
  }
  const continueWithInstalledOnDemandModel = (
    task: GeneralAgentTask,
    pending: PendingOnDemandInstall,
    model: ModelPlugin,
  ) => {
    pendingOnDemandModelRef.current.delete(task.id)
    if (pending.chain) {
      const resolutions = pending.chain.resolutions.map((resolution) =>
        resolution.need.id === pending.resolution.need.id
          ? { ...resolution, installedModel: model, recommendedModel: model }
          : resolution,
      )
      void submitGeneralPrompt({
        task,
        content: pending.prompt,
        selectedModeName: pending.selectedModeName,
        attachmentHint: pending.attachmentHint,
        attachment: pending.attachment,
        appendUserMessage: false,
        localResponse: async () =>
          (await runOnDemandModelExecutionSequence(pending, resolutions, true)) ??
          t('已安装 {0}。当前任务还需要 Agent 继续规划，请补充处理参数。', [
            model.name,
          ]),
        onError: notify,
      })
      return
    }
    const directPlan = createOnDemandModelExecutionPlan(
      pending.resolution,
      model,
      pending.attachment,
      pending.prompt,
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
              (await runOnDemandModelExecution(pending, model, pending.prompt)) ??
              t('已安装 {0}。当前任务还需要 Agent 继续规划，请补充处理参数。', [
                model.name,
              ]),
          }
        : {}),
      onError: notify,
    })
  }
  const executeStructuredPlan = async (
    task: GeneralAgentTask,
    message: GeneralAgentMessage,
  ) => {
    const action = message.action as GeneralAgentStructuredPlanAction | undefined
    if (!action || action.kind !== 'structured-agent-plan') return
    updateGeneralMessageActionStatus(task.id, message.id, 'running')
    const attachments = (() => {
      const candidates: GeneralAgentAttachment[] = []
      if (task.attachment) candidates.push(task.attachment)
      const messageIndex = task.messages.findIndex((item) => item.id === message.id)
      const previousMessages = messageIndex >= 0
        ? task.messages.slice(0, messageIndex + 1)
        : task.messages
      for (const item of previousMessages) {
        if (item.attachment) candidates.push(item.attachment)
        if (item.attachments?.length) candidates.push(...item.attachments)
      }
      return candidates.reverse().filter((file) =>
        ['audio', 'video', 'document'].includes(agentFileKind(file)),
      )
    })()
    const primaryAttachment = attachments[0] ?? null
    let previousOutput: { kind: 'text' | 'audio'; value: string; attachment?: GeneralAgentAttachment } | null = null
    try {
      for (const step of action.steps) {
        updateStructuredPlanStep(task.id, message.id, step.id, { status: 'running' })
        const isAudioInput = !TEXT_INPUT_CAPABILITIES.has(step.capability)
        const candidateModel = step.modelPreference?.length
          ? plugins.find((p) => step.modelPreference!.includes(p.id) && p.harnessCapabilities.includes(step.capability as ModelPlugin['harnessCapabilities'][number]))
          : null
        const model = candidateModel
          ?? plugins.find((p) => p.installed && p.harnessCapabilities.includes(step.capability as ModelPlugin['harnessCapabilities'][number]))
          ?? plugins.find((p) => p.harnessCapabilities.includes(step.capability as ModelPlugin['harnessCapabilities'][number]))
        if (!model) {
          updateStructuredPlanStep(task.id, message.id, step.id, {
            status: 'failed',
            result: t('未找到可用模型'),
          })
          updateGeneralMessageActionStatus(task.id, message.id, 'failed')
          return
        }
        const resolvedModel = model.installed ? model : await installOnDemandModel({
          need: {
            id: step.capability,
            capability: step.capability as ModelPlugin['harnessCapabilities'][number],
            label: step.description,
            actionLabel: step.description,
            preferredModelIds: [model.id],
          },
          installedModel: null,
          recommendedModel: model,
        })
        const providerId = resolvedModel.providerId ?? resolvedModel.id
        let input: Record<string, unknown> = {}
        if (isAudioInput) {
          const audioSource = previousOutput?.kind === 'audio' && previousOutput.attachment
            ? previousOutput.attachment
            : primaryAttachment
          if (!audioSource) {
            updateStructuredPlanStep(task.id, message.id, step.id, {
              status: 'failed',
              result: t('缺少音频输入文件'),
            })
            updateGeneralMessageActionStatus(task.id, message.id, 'failed')
            return
          }
          const file = await readDroppedAudioFile(audioSource.path)
          const clip = await audioFileToClip(file)
          const audioDataUrl = step.capability === 'speech.transcribe'
            ? clip.transcriptionAudioUrl
            : clip.processingAudioUrl ?? clip.transcriptionAudioUrl
          if (!audioDataUrl) {
            updateStructuredPlanStep(task.id, message.id, step.id, {
              status: 'failed',
              result: t('无法解码音频'),
            })
            updateGeneralMessageActionStatus(task.id, message.id, 'failed')
            return
          }
          input = { audioDataUrl, clipName: audioSource.name, duration: clip.duration }
        } else {
          const text = previousOutput?.kind === 'text' ? previousOutput.value : ''
          if (!text) {
            updateStructuredPlanStep(task.id, message.id, step.id, {
              status: 'failed',
              result: t('缺少文本输入'),
            })
            updateGeneralMessageActionStatus(task.id, message.id, 'failed')
            return
          }
          input = { text }
        }
        const execution = await executeHarnessTask<Record<string, unknown>>(
          {
            capability: step.capability as ModelPlugin['harnessCapabilities'][number],
            providerId,
            conversationProviderId: providerId,
            conversationVisible: true,
            routing: 'local',
            title: step.description,
            input,
            parameters: {
              modelId: resolvedModel.version || resolvedModel.id,
              ...step.parameters,
            },
          },
          recordRun,
        )
        recordRun(execution.run)
        const output = execution.output
        const textOutput = typeof output.text === 'string' ? output.text.trim() : ''
        const filePath = typeof output.filePath === 'string' ? output.filePath : ''
        const fileName = typeof output.fileName === 'string' ? output.fileName : ''
        let resultText = ''
        if (step.capability === 'speech.transcribe') {
          resultText = textOutput || t('未识别到文本')
          previousOutput = { kind: 'text', value: resultText }
        } else if (TEXT_INPUT_CAPABILITIES.has(step.capability)) {
          if (step.capability === 'speech.synthesize') {
            resultText = filePath ? t('输出文件：{0}', [filePath]) : t('合成完成')
            previousOutput = filePath
              ? { kind: 'audio', value: filePath, attachment: { path: filePath, name: fileName || filePath.split(/[\\/]/u).at(-1) || 'tts.wav' } }
              : null
          } else {
            resultText = textOutput || JSON.stringify(output)
            previousOutput = { kind: 'text', value: resultText }
          }
        } else if (filePath) {
          resultText = t('输出文件：{0}', [filePath])
          previousOutput = {
            kind: 'audio',
            value: filePath,
            attachment: { path: filePath, name: fileName || filePath.split(/[\\/]/u).at(-1) || 'output.wav' },
          }
        } else if (textOutput) {
          resultText = textOutput
          previousOutput = { kind: 'text', value: textOutput }
        } else {
          resultText = JSON.stringify(output).slice(0, 200)
          previousOutput = { kind: 'text', value: resultText }
        }
        updateStructuredPlanStep(task.id, message.id, step.id, {
          status: 'done',
          result: resultText,
        })
      }
      updateGeneralMessageActionStatus(task.id, message.id, 'done')
      if (previousOutput?.kind === 'text' && previousOutput.value) {
        void submitGeneralPrompt({
          task,
          content: previousOutput.value,
          selectedModeName: null,
          appendUserMessage: false,
          localResponse: () => t('以上是多步执行计划的最终结果。'),
          onError: notify,
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const currentStep = action.steps.find((s) => s.status === 'running')
      if (currentStep) {
        updateStructuredPlanStep(task.id, message.id, currentStep.id, {
          status: 'failed',
          result: errorMessage,
        })
      }
      updateGeneralMessageActionStatus(task.id, message.id, 'failed')
      notify(t('执行计划失败：{0}', [errorMessage]))
    }
  }
  const runAgentMessageAction = (
    task: GeneralAgentTask | null,
    message: GeneralAgentMessage,
    selectedModelId?: string | null,
  ) => {
    if (!task || !message.action) return
    if (message.action.kind === 'structured-agent-plan') {
      void executeStructuredPlan(task, message)
      return
    }
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
    const pendingFromPrompt = pendingOnDemandModelRef.current.get(task.id)
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
        continueWithInstalledOnDemandModel(
          task,
          pendingFromPrompt?.resolution.recommendedModel?.id === action.modelId
            ? pendingFromPrompt
            : {
                resolution,
                prompt: action.prompt,
                selectedModeName: action.selectedModeName,
                attachmentHint: action.attachmentHint,
                attachment: action.attachment ?? null,
              },
          installed,
        )
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
    if (isWorkspaceTaskView && selectedAgentConversation) {
      const projectId = selectedAgentConversation.id;
      const workspaceEpoch = activeWorkspaceRef.current.epoch;
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachment: null,
        localResponse: async () => runWorkspaceAgentRequest({
          projectId,
          prompt: request.content,
          isCurrent: () => activeWorkspaceRef.current.id === projectId && activeWorkspaceRef.current.epoch === workspaceEpoch,
          afterCommit: () => new Promise(resolve => {
            const timeout = window.setTimeout(resolve, 100);
            window.requestAnimationFrame(() => { window.clearTimeout(timeout); resolve(); });
          }),
          requestPlan: prompt => requestTaskAgentReply(task, [...task.messages.slice(-8), {
            id: crypto.randomUUID(), role: 'user', content: prompt, createdAt: Date.now(),
          }], true),
        }),
        onError: notify,
      });
      return;
    }
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

    const modelSequence = resolveOnDemandModelNeeds(request.content, plugins)
    if (modelSequence.length > 1) {
      const unavailable = modelSequence.find((resolution) =>
        !resolution.installedModel && !resolution.recommendedModel,
      )
      if (unavailable) {
        void submitGeneralPrompt({
          task,
          content: request.content,
          selectedModeName: request.selectedModeName,
          attachmentHint: '',
          attachment: request.attachment,
          localResponse: () =>
            t('模型商店暂时没有可用于 {0} 的开源模型', [unavailable.need.label]),
          onError: notify,
        })
        return
      }

      const missing = modelSequence.find((resolution) => !resolution.installedModel)
      const missingModel = missing?.recommendedModel ?? null
      if (missing && agentModelInstallMode === 'ask' && missingModel) {
        const pendingInstallRequest: PendingOnDemandInstall = {
          resolution: missing,
          prompt: request.content,
          selectedModeName: request.selectedModeName,
          attachmentHint: request.attachmentHint,
          attachment: request.attachment,
          chain: { resolutions: modelSequence },
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
              missingModel.name,
              missing.need.label,
            ]),
            action: createInstallModelAction(missing, missingModel, {
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

      const pendingExecution: PendingOnDemandInstall = {
        resolution: modelSequence[0],
        prompt: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: request.attachmentHint,
        attachment: request.attachment,
        chain: { resolutions: modelSequence },
      }
      const context = modelSequence
        .map((resolution) => {
          const model = resolution.installedModel ?? resolution.recommendedModel
          return model ? onDemandModelContext(resolution, model) : ''
        })
        .join('')
      void submitGeneralPrompt({
        task,
        content: request.content,
        selectedModeName: request.selectedModeName,
        attachmentHint: request.attachmentHint + context,
        attachment: request.attachment,
        localResponse: async () =>
          (await runOnDemandModelExecutionSequence(
            pendingExecution,
            modelSequence,
            agentModelInstallMode === 'auto',
          )) ??
          t('当前任务还需要 Agent 继续规划，请补充处理参数。'),
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
  const launchCreationAgent = (
    mode: AgentCreationMode,
    prompt: string,
    sourcePath: string,
    videoDubbingMode?: VideoDubbingMode,
    videoDubbingLanguages?: VideoDubbingLanguages,
    videoDubbingStyle?: VideoDubbingStyle,
  ) => {
    const skill = appAgents.find((agent) => agent.workspaceEntry === mode);
    if (!skill?.installed) {
      notify(t("请先安装此技能，当前要求和素材已保留。"));
      openSkills();
      return;
    }
    if (!prompt.trim() || (mode !== "meeting-notes" && mode !== "agent-chat" &&
      (!sourcePath || !skillAcceptsFile(mode, sourcePath)))) {
      notify(t("请先填写创作要求并选择适用的素材。"));
      return;
    }
    const sourceTask = materializeGeneralTask({ selectedModeId: mode });
    const modeLabel = skill.name;
    const normalizedPrompt = prompt.replace(/\s+/gu, " ").trim();
    const promptTitle =
      normalizedPrompt.length > 22
        ? `${normalizedPrompt.slice(0, 22)}…`
        : normalizedPrompt;
    const request = {
      mode,
      title: `${modeLabel} · ${promptTitle}`,
      prompt,
      sourcePath,
      videoDubbingMode,
      videoDubbingLanguages,
      videoDubbingStyle,
      sourceTaskId: sourceTask.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const existing = matchingSkillConversation(agentConversations, request);
    if (existing) setSelectedAgentConversationId(existing.id);
    else createAgentConversation(request);
    if (sourceTask.draftPrompt.trim() || !sourceTask.messages.some(message => message.role === 'user')) {
      recordWorkspaceBrief(sourceTask.id, prompt, sourceTask.attachment);
    }
    pendingGeneralTaskRef.current = null;
    setShellPage("workspace");
    setWorkflowSelected(false);
    changeView(mode);
  };
  const syncExtensionsState = useCallback(async () => {
    try {
      const [nextPlugins, nextCatalog, nextApiModels, nextBindings] =
        await Promise.all([
          listModelPlugins(),
          getHarnessCatalog(),
          listApiModelCatalog(),
          getModelDependencyBindings(),
        ]);
      setPlugins(nextPlugins);
      setPluginsLoaded(true);
      setCatalog(nextCatalog);
      setApiModelCatalog(nextApiModels);
      setModelBindings(nextBindings);
      setModelBindingsLoaded(true);
      setInstalledCloudModelIds(getInitialCloudModels());
      setCustomApiModels(getInitialCustomApiModels());
    } catch (error) {
      setToast(
        t("无法同步扩展状态：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    }
  }, []);
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ stage: string }>("plugin-install-progress", (event) => {
      if (!disposed && event.payload.stage === "complete") {
        void syncExtensionsState();
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [syncExtensionsState]);
  useEffect(() => {
    if (!isTauriRuntime() && !import.meta.env.DEV) return undefined;
    let disposed = false;
    void listAcpProviders()
      .then((providers) => {
        if (!disposed) {
          setAcpProviders(providers);
          setAgentChatAvailable(providers.some(provider => provider.available));
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);
  const openShellPage = (page: Exclude<ShellPage, "workspace">) => {
    if (
      shellPage === "workspace" &&
      document.activeElement instanceof HTMLElement
    ) {
      extensionsReturnFocusRef.current = document.activeElement;
    }
    setShellPage(page);
    setSidebarOpen(false);
  };
  const openNewTask = () => {
    pendingGeneralTaskRef.current = null;
    setShellPage("workspace");
    setAgentHomeMode(null);
    setSelectedAgentConversationId(null);
    setWorkflowSelected(false);
    setWorkspacePanelOpen(false);
    changeView("agents");
  };
  const openSkills = () => openShellPage("skills");
  const openModelStore = () => openShellPage("models");
  const openExtensions = openModelStore;
  const openSettings = () => {
    setSettingsSection("general");
    openShellPage("settings");
  };

  const openProviderSettings = (providerId: string) => {
    if (
      providerId === "api.openai-compatible" ||
      providerId.startsWith("api.custom.")
    ) {
      setSettingsCustomProviderId(providerId);
    }
    setSettingsProvider(
      providerId === "api.openai-compatible" ||
        providerId.startsWith("api.custom.")
        ? "custom"
        : "bailian",
    );
    if (!providerDialogOpen && document.activeElement instanceof HTMLElement) {
      settingsReturnFocusRef.current = document.activeElement;
    }
    setProviderDialogOpen(true);
  };

  const updateWorkflowTurns = (
    workflowId: string,
    update: SetStateAction<WorkflowChatTurn[]>,
  ) => {
    setWorkflowTurns((current) => {
      const previous = current[workflowId] ?? [];
      return {
        ...current,
        [workflowId]: typeof update === "function" ? update(previous) : update,
      };
    });
  };

  const clearAllHistory = async () => {
    const removableRuns = runs.filter((run) => !activeRunIds.has(run.id));
    if (!removableRuns.length && !Object.keys(workflowTurns).length) {
      notify(t("当前没有历史消息"));
      return;
    }
    if (
      !window.confirm(
        t("确定清除 {0} 条历史记录吗？此操作无法撤销。", [
          removableRuns.length,
        ]),
      )
    ) {
      return;
    }
    setClearingHistory(true);
    try {
      await Promise.all(removableRuns.map((run) => deleteHarnessRun(run.id)));
      const removableIds = new Set(removableRuns.map((run) => run.id));
      setRuns((current) => current.filter((run) => !removableIds.has(run.id)));
      setWorkflowTurns({});
      if (isTauriRuntime()) {
        void emit(HISTORY_CLEARED_EVENT, {}).catch(() => undefined);
      }
      notify(t("历史消息已清除"));
    } catch (error) {
      notify(
        t("清除失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    } finally {
      setClearingHistory(false);
    }
  };

  const runText = async (
    text: string,
    capability:
      | "speech.synthesize"
      | "text.generate"
      | "text.punctuate"
      | "text.normalize",
    providerId: string,
    modelId: string,
    modelParameters: Record<string, unknown>,
    dependencyRunIds: string[] = [],
    conversationVisible = true,
  ): Promise<
    HarnessExecution<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >
  > => {
    const executionPlugin = orderedRunnablePlugins.find(
      (plugin) =>
        plugin.providerId === providerId &&
        (plugin.version === modelId || plugin.id === modelId),
    );
    const providerKey = providerId;
    const history =
      capability === "text.generate" && conversationVisible
        ? (textHistory[providerKey] ?? [])
        : [];
    const systemPrompt =
      typeof modelParameters.systemPrompt === "string"
        ? modelParameters.systemPrompt.trim()
        : "";
    const messages: {
      role: "system" | "user" | "assistant";
      content: string;
    }[] =
      capability === "text.generate"
        ? [
            ...(systemPrompt
              ? [{ role: "system" as const, content: systemPrompt }]
              : []),
            ...history,
            { role: "user" as const, content: text },
          ]
        : [];
    const execution = await executeHarnessTask<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >(
      {
        capability,
        providerId,
        conversationProviderId: providerId,
        conversationVisible,
        dependencyRunIds,
        routing: capability === "text.generate" ? "quality" : "local",
        title: `${executionPlugin?.name ?? modelId} · ${
          capability === "text.generate"
            ? t("文本生成")
            : capability === "text.punctuate"
              ? t("标点恢复")
              : capability === "text.normalize"
                ? t("文本归一化")
                : t("音频生成")
        }`,
        input: capability === "text.generate" ? { messages } : { text },
        parameters: {
          modelId,
          ...(capability === "speech.synthesize"
            ? { sid: 3, speed: 0.96, silenceScale: 0.2 }
            : { temperature: 0.7, maxTokens: 1024 }),
          ...modelParameters,
        },
      },
      (run) => {
        recordRun(run);
      },
    );
    recordRun(execution.run);
    if (capability === "text.generate" && conversationVisible) {
      const reply = (execution.output as TextGenerateResult).text;
      if (typeof reply === "string") {
        setTextHistory((current) => ({
          ...current,
          [providerKey]: [
            ...(current[providerKey] ?? []),
            { role: "user" as const, content: text },
            { role: "assistant" as const, content: reply },
          ].slice(-40),
        }));
      }
    }
    return execution;
  };

  const clearTextHistory = (providerId: string) => {
    setTextHistory((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  };

  const clearConversationRuns = async (runIds: string[]): Promise<boolean> => {
    const removableIds = runIds.filter((id) => !activeRunIds.has(id));
    if (!removableIds.length) {
      notify(t("当前没有可清除的对话记录"));
      return false;
    }
    if (
      !window.confirm(
        t("确定清除当前模型的 {0} 条对话记录吗？", [removableIds.length]),
      )
    ) {
      return false;
    }
    try {
      await Promise.all(removableIds.map((id) => deleteHarnessRun(id)));
      const removed = new Set(removableIds);
      setRuns((current) => current.filter((run) => !removed.has(run.id)));
      if (isTauriRuntime()) {
        void emit(RUNS_REMOVED_EVENT, removableIds).catch(() => undefined);
      }
      notify(t("当前模型的对话记录已清除"));
      return true;
    } catch (error) {
      notify(
        t("清除失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
      return false;
    }
  };

  const runAudio = async (
    clip: AudioClip,
    capability:
      | "speech.transcribe"
      | "speech.detect"
      | "audio.enhance"
      | "audio.classify"
      | "speech.keyword"
      | "speech.language"
      | "speaker.embed"
      | "speaker.diarize"
      | "audio.separate",
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
      capability === "speech.transcribe" || capability === "speech.detect"
        ? clip.transcriptionAudioUrl
        : clip.processingAudioUrl;
    if (!audioDataUrl) {
      throw new Error(t("该音频无法解码为模型需要的 WAV 格式"));
    }
    const comparisonAudioDataUrl = comparisonClip?.processingAudioUrl;
    if (comparisonClip && !comparisonAudioDataUrl) {
      throw new Error(t("第二段音频无法解码为模型需要的 WAV 格式"));
    }
    const { speechSegments, ...executionParameters } = modelParameters;

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
        routing: "local",
        title:
          capability === "speaker.embed" && comparisonClip
            ? t("{0} 与 {1} · 声纹比对", [clip.name, comparisonClip.name])
            : capability === "speech.transcribe"
              ? t("{0} · 语音识别", [clip.name])
              : capability === "speech.detect"
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
          ...(Array.isArray(speechSegments) ? { speechSegments } : {}),
        },
        parameters:
          capability === "audio.enhance"
            ? {
                operations: ["denoise", "normalize", "fade"],
                denoiseStrength: 0.58,
                targetLoudnessDb: -16,
                fadeMs: 20,
                modelId,
                ...executionParameters,
              }
            : capability === "speech.detect"
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
        recordRun(run);
      },
    );
    recordRun(execution.run);
    return execution;
  };

  const settingsRows: Record<SettingsSection, ReactNode> = {
    general: (
      <>
        <div className="settings-card">
          <div className="settings-row">
            <span>
              <strong>{t("界面语言")}</strong>
              <small>{t("选择界面显示语言，立即生效")}</small>
            </span>
            <div className="settings-segmented" aria-label={t("界面语言")}>
              {(
                [
                  ["zh-CN", "简体中文"],
                  ["en", "English"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  lang={value}
                  className={locale === value ? "active" : ""}
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
                  className={quitOnClose === quit ? "active" : ""}
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
                {appUpdate.status === "available"
                  ? t("版本 {0} 已可用", [appUpdate.update?.version])
                  : appUpdate.status === "downloading"
                    ? appUpdate.progress === undefined
                      ? t("正在下载安装包")
                      : t("正在下载 {0}%", [Math.round(appUpdate.progress)])
                    : appUpdate.status === "downloaded"
                      ? t("版本 {0} 已下载，点击重启安装", [
                          appUpdate.update?.version,
                        ])
                      : appUpdate.status === "installing"
                        ? t("正在安装更新")
                        : appUpdate.status === "current"
                          ? t("QwenAudio Toolkits {0} 已是最新版", [
                              runtime.version,
                            ])
                          : (appUpdate.message ??
                            t("当前版本 {0}", [runtime.version]))}
              </small>
            </span>
            <button
              className="settings-update-action"
              type="button"
              disabled={
                appUpdate.status === "checking" ||
                appUpdate.status === "downloading" ||
                appUpdate.status === "installing" ||
                appUpdate.status === "unavailable"
              }
              onClick={() =>
                appUpdate.status === "available" ||
                appUpdate.status === "downloaded"
                  ? void applyApplicationUpdate()
                  : void checkApplicationUpdate()
              }
            >
              {appUpdate.status === "checking" ||
              appUpdate.status === "downloading" ||
              appUpdate.status === "installing" ? (
                <LoaderCircle className="model-spin" size={13} />
              ) : appUpdate.status === "available" ||
                appUpdate.status === "downloaded" ? (
                <Download size={13} />
              ) : (
                <RefreshCw size={13} />
              )}
              {appUpdate.status === "available"
                ? t("下载并安装")
                : appUpdate.status === "downloaded"
                  ? t("重启安装")
                  : appUpdate.status === "checking"
                    ? t("检查中")
                    : appUpdate.status === "downloading"
                      ? t("下载中")
                      : appUpdate.status === "installing"
                        ? t("安装中")
                        : appUpdate.status === "unavailable"
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
              {t("清除历史")}
            </button>
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
                  ["system", Monitor, t("跟随系统")],
                  ["light", Sun, t("浅色")],
                  ["dark", Moon, t("深色")],
                ] as const
              ).map(([theme, Icon, label]) => (
                <button
                  className={themePreference === theme ? "active" : ""}
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
                  className={`accent-swatch${accent === id ? " active" : ""}`}
                  type="button"
                  key={id}
                  title={label}
                  aria-label={label}
                  aria-pressed={accent === id}
                  style={{ "--swatch": swatch } as CSSProperties}
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
                  className={sidebarDensity === id ? "active" : ""}
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
              {t("在访达中显示")}
            </button>
          </div>
          <div className="settings-row">
            <span>
              <strong>{t("下载缓存")}</strong>
              <small>
                {t("已完成的模型安装包会保留在本地，可手动清理以释放空间")}
              </small>
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
              {t("清理缓存")}
            </button>
          </div>
        </div>
      </>
    ),
  };
  const activeSettingsSection =
    SETTINGS_SECTIONS.find((section) => section.id === settingsSection) ??
    SETTINGS_SECTIONS[0];

  if (!workspaceReady) {
    return <main className="workspace-restoring" role="status"><LoaderCircle className="model-spin" size={20} />{t("正在恢复任务…")}</main>;
  }

  return (
    <div
      className={`app-shell model-shell${usesOverlayTitlebar ? " native-titlebar-enabled" : ""} shell-page-${shellPage}`}
      data-theme={resolvedTheme}
      style={
        {
          "--model-sidebar-width": `${visibleSidebarWidth}px`,
          "--model-content-offset": `${visibleContentOffset}px`,
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
        id="app-navigation"
        className={`app-sidebar model-sidebar${sidebarOpen ? " open" : ""}`}
        inert={providerDialogOpen || (viewportWidth <= 900 && !sidebarOpen)}
      >
        <div className="activity-rail-title-spacer" data-tauri-drag-region />

        <div className="sidebar-brand">
          <span className="sidebar-brand-mark app-icon">
            <img src={appIconUrl} alt="QwenAudio Toolkits" />
          </span>
          <span className="sidebar-brand-name">QwenAudio Toolkits</span>
        </div>
        {demoMode && (
          <div className="sidebar-demo-badge">
            Demo Mode — UI Preview
          </div>
        )}

        {shellPage === "settings" ? (
          <nav
            className="sidebar-primary-nav sidebar-return-nav"
            aria-label={t("应用导航")}
          >
            <button
              className="sidebar-primary-button sidebar-return-button"
              type="button"
              onClick={leaveShellPage}
            >
              <ArrowLeft size={17} />
              <span>{t("返回应用")}</span>
            </button>
          </nav>
        ) : (
          <nav className="sidebar-primary-nav" aria-label={t("主导航")}>
            <button
              className={`sidebar-primary-button${
                shellPage === "workspace" && view === "agents" && !selectedAgentConversationId
                  ? " active"
                  : ""
              }`}
              type="button"
              aria-current={
                shellPage === "workspace" && view === "agents" && !selectedAgentConversationId
                  ? "page"
                  : undefined
              }
              onClick={openNewTask}
            >
              <SquarePen size={17} />
              <span>{t("新任务")}</span>
            </button>
            <button
              ref={extensionsTriggerRef}
              className={`sidebar-primary-button${shellPage === "skills" ? " active" : ""}`}
              type="button"
              aria-current={shellPage === "skills" ? "page" : undefined}
              onClick={shellPage === "skills" ? leaveShellPage : openSkills}
            >
              <Sparkles size={17} />
              <span>{t("技能")}</span>
            </button>
            <button
              className={`sidebar-primary-button${shellPage === "models" ? " active" : ""}`}
              type="button"
              aria-current={shellPage === "models" ? "page" : undefined}
              onClick={shellPage === "models" ? leaveShellPage : openModelStore}
            >
              <ShoppingBag size={17} />
              <span>{t("模型商店")}</span>
            </button>
          </nav>
        )}

        {shellPage === "settings" && (
          <nav
            className="sidebar-settings-nav settings-nav"
            aria-label={t("设置分类")}
          >
            {SETTINGS_SECTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={settingsSection === id ? "active" : ""}
                type="button"
                aria-current={settingsSection === id ? "page" : undefined}
                onClick={() => {
                  setSettingsSection(id);
                  setSidebarOpen(false);
                }}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}

        {SHOW_INSTALLED_MODELS_SIDEBAR && shellPage !== "settings" && (
          <nav className="installed-models" aria-label={t("已安装模型")}>
            <div className="sidebar-agent-history-header">
              <button
                className="sidebar-agents-entry"
                type="button"
                onClick={() => setInstalledModelsExpanded((open) => !open)}
                aria-expanded={installedModelsExpanded}
              >
                <span>{t("已安装模型")}</span>
                <ChevronDown
                  size={14}
                  className={installedModelsExpanded ? "" : "collapsed"}
                />
              </button>
            </div>
            {installedModelsExpanded && (
              <div
                className="sidebar-agent-conversations"
                aria-label={t("已安装模型")}
              >
                {(() => {
                  const groups = new Map<string, typeof runnablePlugins>();
                  for (const plugin of runnablePlugins) {
                    const capability = plugin.harnessCapabilities[0];
                    const category = capability
                      ? capabilityDefinition(capability).category
                      : t("其他");
                    const list = groups.get(category) ?? [];
                    list.push(plugin);
                    groups.set(category, list);
                  }
                  return [...groups.entries()].map(([category, plugins]) => (
                    <div key={category} className="sidebar-model-group">
                      <button
                        className="sidebar-model-group-label"
                        type="button"
                        onClick={() =>
                          setExpandedModelCategories((current) => {
                            const next = new Set(current);
                            if (next.has(category)) {
                              next.delete(category);
                            } else {
                              next.add(category);
                            }
                            return next;
                          })
                        }
                        aria-expanded={expandedModelCategories.has(category)}
                      >
                        <ChevronDown
                          size={14}
                          className={
                            expandedModelCategories.has(category)
                              ? ""
                              : "collapsed"
                          }
                        />
                        <span>{t(category)}</span>
                      </button>
                      {expandedModelCategories.has(category) && (
                        <div className="sidebar-model-group-items">
                          {plugins.map((plugin) => {
                            const active =
                              shellPage === "workspace" &&
                              view === "workspace" &&
                              selectedPluginId === plugin.id;
                            return (
                              <button
                                className={`installed-model-button${
                                  active ? " active" : ""
                                }`}
                                type="button"
                                key={plugin.id}
                                title={plugin.name}
                                aria-current={active ? "page" : undefined}
                                onClick={() => {
                                  setSelectedPluginId(plugin.id);
                                  setAgentHomeMode(null);
                                  setSelectedAgentConversationId(null);
                                  setWorkflowSelected(false);
                                  setShellPage("workspace");
                                  changeView("workspace");
                                }}
                              >
                                <span>{plugin.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ));
                })()}
              </div>
            )}
          </nav>
        )}

        {shellPage !== 'settings' && (
        <nav className="installed-models sidebar-recent-tasks" aria-label={t("最近任务")}>
          <div className="sidebar-agent-history-header">
            <button
              className="sidebar-agents-entry"
              type="button"
              aria-expanded={recentTasksExpanded}
              aria-controls="recent-task-list"
              onClick={() => setRecentTasksExpanded((expanded) => !expanded)}
            >
              <span>{t('最近')}</span>
              <ChevronDown size={14} className={recentTasksExpanded ? '' : 'collapsed'} />
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
          <div id="recent-task-list" hidden={!recentTasksExpanded}>
          {(generalTasks.length > 0 || agentConversations.length > 0) && (
            <div className="sidebar-agent-conversations" aria-label={t('最近任务')}>
              {generalTasks.filter(task => !agentConversations.some(conversation =>
                conversation.sourceTaskId === task.id && WORKSPACE_TASK_MODES.has(conversation.mode),
              )).map((task) => {
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
                    <MessageSquareText className="recent-task-icon" size={14} />
                    <span>{task.title}</span>
                    {task.submitting && <LoaderCircle className="model-spin" size={13} aria-label={t('运行中')} />}
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
                  : conversation.mode === 'agent-chat'
                    ? t('Agent 对话')
                    : conversation.mode === 'meeting-notes' ? t('实时会议') : ''
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
                    <Sparkles className="recent-task-icon" size={14} />
                    <span>{conversation.title}</span>
                  </button>
                )
              })}
            </div>
          )}
          {generalTasks.length === 0 && agentConversations.length === 0 && (
            <p className="sidebar-recent-empty">{t("暂无最近任务")}</p>
          )}
          </div>
        </nav>        )}

        <div className="sidebar-spacer" />

        <nav className="sidebar-dock" aria-label={t("资源与设置")}>
          {WORKFLOWS_ENABLED && (
            <button
              className={`sidebar-dock-button${
                shellPage === "workspace" && view === "workflows"
                  ? " active"
                  : ""
              }`}
              type="button"
              aria-label={t("流程编排")}
              data-tooltip={t("流程编排")}
              onClick={() => {
                setEditingWorkflowId(null);
                changeView("workflows");
              }}
            >
              <GitBranch size={18} />
            </button>
          )}
          <button
            ref={settingsTriggerRef}
            className={`sidebar-dock-button${shellPage === "settings" ? " active" : ""}`}
            type="button"
            aria-label={t("设置")}
            aria-pressed={shellPage === "settings"}
            data-tooltip={t("设置")}
            onClick={openSettings}
          >
            <Settings size={18} />
          </button>
          {(appUpdate.status === "available" ||
            appUpdate.status === "downloading" ||
            appUpdate.status === "downloaded" ||
            appUpdate.status === "installing") && (
            <button
              className={`sidebar-dock-button sidebar-update-icon${
                appUpdate.status === "downloading" ? " downloading" : ""
              }`}
              type="button"
              data-tooltip={
                appUpdate.status === "downloading"
                  ? appUpdate.progress === undefined
                    ? t("正在下载安装包")
                    : t("正在下载 {0}%", [Math.round(appUpdate.progress)])
                  : appUpdate.status === "installing"
                    ? t("正在安装更新")
                    : appUpdate.status === "downloaded"
                      ? t("重启安装 {0}", [appUpdate.update?.version ?? ""])
                      : t("后台下载更新 {0}", [appUpdate.update?.version ?? ""])
              }
              aria-label={
                appUpdate.status === "downloading"
                  ? t("正在下载安装包")
                  : appUpdate.status === "installing"
                    ? t("正在安装更新")
                    : appUpdate.status === "downloaded"
                      ? t("重启安装新版本")
                      : t("下载新版本")
              }
              disabled={
                appUpdate.status === "downloading" ||
                appUpdate.status === "installing"
              }
              onClick={applyApplicationUpdate}
            >
              {appUpdate.status === "downloading" ||
              appUpdate.status === "installing" ? (
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
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            const nextWidth = Math.min(
              responsiveSidebarMaxWidth,
              Math.max(MIN_SIDEBAR_WIDTH, visibleSidebarWidth + direction * 16),
            );
            setSidebarWidth(nextWidth);
            try {
              window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
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
          onClick={closeSidebar}
        />
      )}

      <div className="app-frame model-app-frame" inert={providerDialogOpen || (viewportWidth <= 900 && sidebarOpen)}>
        <header className="topbar model-topbar" data-tauri-drag-region>
          <button
            ref={sidebarTriggerRef}
            className="mobile-menu-button"
            type="button"
            aria-label={t("打开导航")}
            aria-controls="app-navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="topbar-title">
            <span>
              {shellPage === "skills"
                ? t("技能")
                : shellPage === "models"
                  ? t("模型商店")
                  : shellPage === "settings"
                    ? t("设置 · {0}", [activeSettingsSection.label])
                    : isWorkspaceTaskView
                      ? (selectedAgentConversation?.title ?? t("新任务"))
                      : view === "agents"
                        ? (selectedGeneralTask?.title ?? t("新任务"))
                        : view === "agent-chat"
                          ? (selectedAgentConversation?.title ?? t("技能任务"))
                          : view === "workspace"
                            ? WORKFLOWS_ENABLED && workflowSelected
                              ? (workflows.find(
                                  (workflow) =>
                                    workflow.id === selectedWorkflowId,
                                )?.name ?? t("虚拟模型"))
                              : selectedPlugin.name
                            : t("流程编排")}
            </span>
          </div>
          <div className="topbar-actions">
            <WorkspaceSaveIndicator />
            {shellPage === "workspace" && isWorkspaceTaskView && (
              <div className="workspace-view-switch" role="group" aria-label={t('工作区视图')}>
                <button type="button" aria-pressed={!workspacePanelOpen} onClick={() => {
                  setWorkspacePanelOpen(false);
                  setWorkspacePanelFocused(false);
                }}>
                  {t('对话')}
                </button>
                <button type="button" aria-pressed={workspacePanelOpen && !workspacePanelFocused} onClick={() => {
                  setWorkspacePanelOpen(true);
                  setWorkspacePanelFocused(false);
                }}>
                  <PanelRightOpen size={14} />{compactWorkspace ? t('结果') : t('对话与结果')}
                </button>
              </div>
            )}
            <span className="model-runtime-state">
              <i />
              {isTauriRuntime() ? t("本地运行") : t("界面预览")}
            </span>
          </div>
        </header>

        <div
          className={`view-container model-view-container${shellPage !== "workspace" ? ` page-${shellPage}` : ""}`}
        >
          <Suspense
            fallback={
              <div className="app-view-loading" aria-label={t("正在加载")}>
                <LoaderCircle className="model-spin" size={19} />
              </div>
            }
          >
            {shellPage === "skills" && (
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
            {shellPage === "models" && (
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
            {shellPage === "settings" && (
              <section
                className="settings-page"
                aria-labelledby="settings-page-title"
              >
                <header className="settings-page-heading">
                  <h2 id="settings-page-title">
                    {activeSettingsSection.label}
                  </h2>
                </header>
                {settingsRows[settingsSection]}
              </section>
            )}
            {/* Keep draft inputs and live sessions alive while changing settings. */}
            <div
              className={`workspace-session${editorVisible ? ' editor-open' : ''}${editorFillsWorkspace ? ' editor-focused' : ''}`}
              hidden={shellPage !== "workspace"}
              inert={shellPage !== "workspace"}
            >
              <div className="workspace-center" inert={editorFillsWorkspace}>
              <div
                className="agent-workspace-session"
                hidden={view !== "agents" && !isWorkspaceTaskView}
                inert={view !== "agents" && !isWorkspaceTaskView}
              >
                <AgentHomeView
                  skills={appAgents}
                  chatModelOptions={chatModelOptions}
                  acpProviders={acpProviders}
                  chatModel={selectedChatModel}
                  chatModelLoading={Boolean(chosenAcpProvider && acpModels[chosenAcpProvider]?.loading)}
                  chatModelError={chosenAcpProvider ? acpModels[chosenAcpProvider]?.error : undefined}
                  onRetryModels={() => { if (chosenAcpProvider) void loadAcpModels(chosenAcpProvider); }}
                  acpPermissions={acpPermissions.filter(item => item.taskId === selectedGeneralTask?.id).map(item => item.event)}
                  onAcpPermission={(event, optionId) => {
                    if (!event.requestId) return;
                    void respondAcpPermission(event.sessionId, event.requestId, optionId).then(() =>
                      setAcpPermissions(current => current.filter(item => item.event.sessionId !== event.sessionId || item.event.requestId !== event.requestId)),
                    ).catch(error => notify(String(error)));
                  }}
                  acpRunning={Boolean(selectedGeneralTask && activeAcpTasks.includes(selectedGeneralTask.id))}
                  onCancelAcp={() => { if (selectedGeneralTask) acpTurns.current.get(selectedGeneralTask.id)?.abort(); }}
                  onChatModelChange={chatModel => {
                    const task = materializeGeneralTask();
                    const agentLocked = isWorkspaceTaskView || task.messages.length > 0 || task.submitting;
                    if (agentLocked && getAgentSelection(chatModel).providerId !== getAgentSelection(task.chatModel).providerId) return;
                    pendingGeneralTaskRef.current = { ...task, chatModel };
                    updateGeneralTask(task.id, { chatModel });
                  }}
                  workspaceTitle={isWorkspaceTaskView ? selectedAgentConversation?.title : undefined}
                  workspaceCanOperate={isWorkspaceTaskView}
                  taskId={selectedGeneralTask?.id ?? null}
                  messages={selectedGeneralTask?.messages ?? []}
                  draftPrompt={selectedGeneralTask?.draftPrompt ?? ""}
                  attachment={selectedGeneralTask?.attachment ?? null}
                  submitting={selectedGeneralTask?.submitting ?? false}
                  modelInstallMode={agentModelInstallMode}
                  messageModelOptions={resolveTaskMessageModelOptions(selectedGeneralTask)}
                  selectedModeId={isWorkspaceTaskView ? selectedAgentConversation?.mode ?? null : selectedGeneralTask?.selectedModeId ?? agentHomeMode}
                  creationOptions={selectedGeneralTask?.creationOptions}
                  onCreationOptionsChange={updateAgentCreationOptions}
                  chatAvailable={agentChatAvailable}
                  onModelInstallModeChange={setAgentModelInstallMode}
                  onMessageModelSelect={(messageId, modelId) => {
                    setAgentMessageModelSelections((current) => ({
                      ...current,
                      [messageId]: modelId,
                    }));
                  }}
                  onSelectedModeChange={updateAgentHomeMode}
                  onDraftPromptChange={updateAgentHomeDraft}
                  onAttachmentChange={updateAgentHomeAttachment}
                  onSubmitPrompt={submitAgentHomePrompt}
                  onRunMessageAction={(message, modelId) =>
                    runAgentMessageAction(selectedGeneralTask, message, modelId)
                  }
                  onLaunch={launchCreationAgent}
                  onOpenStore={openSkills}
                />
              </div>
              {view === "workspace" &&
                (WORKFLOWS_ENABLED && workflowSelected && selectedWorkflowId ? (
                  <WorkflowChatView
                    workflowId={selectedWorkflowId}
                    turns={workflowTurns[selectedWorkflowId] ?? []}
                    setTurns={(update) =>
                      updateWorkflowTurns(selectedWorkflowId, update)
                    }
                    onRunUpdate={(run) => recordRun(run)}
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
                      openProviderSettings(selectedPlugin.providerId ?? "")
                    }
                    onAction={notify}
                    onClearTextHistory={() =>
                      clearTextHistory(selectedPlugin.providerId ?? "")
                    }
                    onClearConversation={clearConversationRuns}
                  />
                ))}
              {openedAgentConversations
                .filter((conversation) => conversation.mode === "agent-chat")
                .map((conversation) => (
                  <div
                    key={conversation.id}
                    className="agent-workspace-session"
                    hidden={
                      view !== "agent-chat" ||
                      selectedAgentConversationId !== conversation.id
                    }
                    inert={
                      view !== "agent-chat" ||
                      selectedAgentConversationId !== conversation.id
                    }
                  >
                    <AgentChatView
                      initialInstruction={conversation.prompt}
                      initialSourcePath={conversation.sourcePath}
                      initialLaunchId={conversation.restored ? 0 : 1}
                      models={orderedRunnablePlugins}
                      onRunText={runText}
                      onRunAudio={runAudio}
                      onOpenStore={openExtensions}
                      onAction={notify}
                    />
                  </div>
                ))}
              {WORKFLOWS_ENABLED && view === "workflows" && (
                <WorkflowsView
                  key={editingWorkflowId ?? "new-workflow"}
                  catalog={catalog}
                  models={orderedRunnablePlugins}
                  workflows={workflows}
                  editingWorkflowId={editingWorkflowId}
                  onWorkflowsChanged={(next, workflowId) => {
                    setWorkflows(next);
                    setEditingWorkflowId(workflowId);
                    setSelectedWorkflowId(workflowId);
                  }}
                  onAction={notify}
                />
              )}
              </div>
              <aside
                id="task-editor"
                className="workspace-panel"
                hidden={!editorVisible}
                inert={!editorVisible}
                aria-label={view === 'meeting-notes' ? t('会议结果') : t('任务结果')}
              >
                <div className="workspace-panel-header">
                  <h3>{view === 'meeting-notes' ? t('会议结果') : t('任务结果')}</h3>
                  {!compactWorkspace && (
                    <button
                      type="button"
                      aria-label={workspacePanelFocused ? t('退出专注模式') : t('专注编辑')}
                      title={workspacePanelFocused ? t('退出专注模式') : t('专注编辑')}
                      aria-pressed={workspacePanelFocused}
                      onClick={() => setWorkspacePanelFocused((focused) => !focused)}
                    >
                      {workspacePanelFocused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t('收起结果，继续对话')}
                    title={t('收起结果，继续对话')}
                    onClick={() => setWorkspacePanelOpen(false)}
                  >
                    <PanelRightClose size={16} />
                  </button>
                </div>
                <div className="workspace-panel-body">
                  {openedAgentConversations
                    .filter((conversation) => conversation.mode === "smart-cut")
                    .map((conversation) => (
                      <div
                        key={conversation.id}
                        className="agent-workspace-session"
                        hidden={
                          view !== "smart-cut" ||
                          selectedAgentConversationId !== conversation.id
                        }
                        inert={
                          view !== "smart-cut" ||
                          selectedAgentConversationId !== conversation.id
                        }
                      >
                        <SmartCutView
                          panelMode
                          projectId={conversation.id}
                          autoStart={!conversation.restored}
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
                  {openedAgentConversations
                    .filter((conversation) => conversation.mode === "ai-podcast")
                    .map((conversation) => (
                      <div
                        key={conversation.id}
                        className="agent-workspace-session"
                        hidden={
                          view !== "ai-podcast" ||
                          selectedAgentConversationId !== conversation.id
                        }
                        inert={
                          view !== "ai-podcast" ||
                          selectedAgentConversationId !== conversation.id
                        }
                      >
                        <AiPodcastView
                          panelMode
                          projectId={conversation.id}
                          autoStart={!conversation.restored}
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
                  {openedAgentConversations
                    .filter((conversation) => conversation.mode === "video-dubbing")
                    .map((conversation) => (
                      <div
                        key={conversation.id}
                        className="agent-workspace-session"
                        hidden={
                          view !== "video-dubbing" ||
                          selectedAgentConversationId !== conversation.id
                        }
                        inert={
                          view !== "video-dubbing" ||
                          selectedAgentConversationId !== conversation.id
                        }
                      >
                        <VideoDubbingView
                          panelMode
                          projectId={conversation.id}
                          autoStart={!conversation.restored}
                          initialInstruction={conversation.prompt}
                          initialSourcePath={conversation.sourcePath}
                          initialLaunchId={1}
                          dubbingMode={conversation.videoDubbingMode ?? "translate"}
                          dubbingLanguages={conversation.videoDubbingLanguages}
                          dubbingStyle={conversation.videoDubbingStyle}
                          onAction={notify}
                        />
                      </div>
                    ))}
                  {openedAgentConversations
                    .filter((conversation) => conversation.mode === "meeting-notes")
                    .map((conversation) => (
                      <div
                        key={conversation.id}
                        className="agent-workspace-session"
                        hidden={
                          view !== "meeting-notes" ||
                          selectedAgentConversationId !== conversation.id
                        }
                        inert={
                          view !== "meeting-notes" ||
                          selectedAgentConversationId !== conversation.id
                        }
                      >
                        <MeetingNotesView
                          panelMode
                          projectId={conversation.id}
                          autoStart={!conversation.restored}
                          initialInstruction={conversation.prompt}
                          models={orderedRunnablePlugins}
                          onRunText={runText}
                          onRunAudio={runAudio}
                          onOpenStore={openExtensions}
                          onAction={notify}
                        />
                      </div>
                    ))}
                </div>
              </aside>
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
            if (event.target === event.currentTarget) closeProviderDialog();
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
  );
}

export default App;
