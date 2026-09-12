import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { flushSync } from 'react-dom'
import { open, save } from '@tauri-apps/plugin-dialog'
import {
  ArrowUp,
  Check,
  Captions,
  ChevronLeft,
  Download,
  Eye,
  FileVideo,
  LoaderCircle,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react'
import {
  activeSmartCutWordId,
  buildSmartCutCandidates,
  buildSmartCutSubtitleCues,
  buildSmartCutTextSegments,
  deletedDuration,
  keepRangesFromCuts,
  hasUsableSmartCutTimeline,
  manualWordCandidate,
  mergeSmartCutPreferences,
  modelSupportsSmartCutTimeline,
  normalizeSmartCutTranscription,
  parseSmartCutInstruction,
  parseSmartCutPlannerOutput,
  selectedDeleteRanges,
  SMART_CUT_PLANNER_SYSTEM_PROMPT,
  smartCutWords,
  type SmartCutCandidate,
  type SmartCutInstructionPreferences,
  type SmartCutWord,
} from '../domain/smartCut'
import { audioFileToClip, formatFileSize, formatTime } from '../utils/audio'
import { readDroppedAudioFile } from '../services/harness'
import {
  analyzeCutBoundaries,
  exportSmartCut,
  localVideoUrl,
  localizeVideoEditorMessage,
  prepareVideoMedia,
  videoEditorStatus,
  type PreparedVideoMedia,
  type VideoEditorStatus,
} from '../services/videoEditor'
import { t, useLocale } from '../i18n'
import { readSmartCutSnapshot } from '../domain/editorSnapshots'
import { readProjectSnapshot, restoreWorkspaceMedia } from '../services/workspaceStorage'
import { useProjectAutosave } from '../hooks/useProjectAutosave'
import { useWorkspaceController } from '../hooks/useWorkspaceController'
import { ensureSmartCutContentRemaining, manualRangeCandidate, SMART_CUT_ACTIONS, validateSmartCutCommand, type SmartCutConfiguration } from '../domain/smartCutCommands'
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessCatalog,
  HarnessCapabilityId,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from '../types'
import './SmartCutView.css'

type AnalysisStage =
  | 'empty'
  | 'planning'
  | 'preparing'
  | 'ready'
  | 'transcribing'
  | 'review'
  | 'preview'
  | 'exporting'

interface SmartCutViewProps {
  projectId?: string
  panelMode?: boolean
  autoStart?: boolean
  initialInstruction?: string
  initialSourcePath?: string
  initialLaunchId?: number
  models: ModelPlugin[]
  catalog: HarnessCatalog | null
  onRunAudio: (
    clip: AudioClip,
    capability: Extract<
      HarnessCapabilityId,
      'speech.transcribe' | 'speech.detect' | 'audio.enhance'
    >,
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    conversationVisible?: boolean,
  ) => Promise<
    HarnessExecution<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >
  >
  onRunText: (
    text: string,
    capability:
      | 'speech.synthesize'
      | 'text.generate'
      | 'text.punctuate'
      | 'text.normalize',
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<
    HarnessExecution<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >
  >
  onOpenStore: () => void
  onAction: (message: string) => void
}

const REASON_LABELS: Record<SmartCutCandidate['reason'], string> = {
  silence: '静音片段',
  filler: '口水词',
  repetition: '重复',
  manual: '手动',
}

function isAsrResult(value: unknown): value is AsrTranscriptionResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'text' in value &&
      'segments' in value,
  )
}

function isVadResult(value: unknown): value is VadDetectionResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'speechSeconds' in value &&
      'silenceSeconds' in value &&
      'segments' in value,
  )
}

function isTextResult(value: unknown): value is TextGenerateResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'text' in value &&
      typeof (value as { text?: unknown }).text === 'string',
  )
}

function modelReady(model: ModelPlugin, catalog: HarnessCatalog | null): boolean {
  const provider = catalog?.providers.find((item) => item.id === model.providerId)
  return model.installed && Boolean(model.providerId) && (!provider || provider.status === 'ready')
}

function clipNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'smart-cut'
}

function compactCandidateLabel(candidate: SmartCutCandidate): string {
  return candidate.label.replace(/^(?:口水词|重复词)/u, '')
}

function candidateLabel(candidate: SmartCutCandidate): string {
  if (candidate.label === '片头静音' || candidate.label === '片尾静音' || candidate.label === '停顿') {
    return t(candidate.label)
  }
  const dynamic = candidate.label.match(/^(口水词|重复词|手动删除)「(.+)」$/u)
  if (dynamic) return t(`${dynamic[1]}「{0}」`, [dynamic[2]])
  return t(candidate.label)
}

function candidateDetail(candidate: SmartCutCandidate): string {
  const silence = candidate.detail.match(/^([\d.]+) 秒无语音$/u)
  if (silence) return t('{0} 秒无语音', [silence[1]])
  return t(candidate.detail)
}

function statusCopy(stage: AnalysisStage): string {
  if (stage === 'planning') return t('正在理解剪辑指令…')
  if (stage === 'preparing') return t('正在提取音轨并读取视频信息…')
  if (stage === 'transcribing') return t('正在识别语音、检测停顿并检查画面切口…')
  if (stage === 'exporting') return t('正在生成 MP4，请勿关闭窗口…')
  return ''
}

export function SmartCutView({
  projectId,
  panelMode = false,
  autoStart = true,
  initialInstruction,
  initialSourcePath,
  initialLaunchId,
  models,
  catalog,
  onRunAudio,
  onRunText,
  onOpenStore,
  onAction,
}: SmartCutViewProps) {
  useLocale()
  const [restored] = useState(() => readSmartCutSnapshot(readProjectSnapshot(projectId, 'smart-cut')))
  const videoRef = useRef<HTMLVideoElement>(null)
  const segmentListRef = useRef<HTMLDivElement>(null)
  const segmentElementRefs = useRef(new Map<string, HTMLElement>())
  const wordDragRef = useRef<{
    deleting: boolean
    visited: Set<string>
  } | null>(null)
  const autoAnalyzeRef = useRef(false)
  const commandBusyRef = useRef(false)
  const plannerPreferencesRef = useRef<SmartCutInstructionPreferences | null>(restored?.plannerPreferences ?? null)
  const appliedInitialLaunchRef = useRef(0)
  const submittedInitialLaunchRef = useRef(0)
  const [engine, setEngine] = useState<VideoEditorStatus | null>(null)
  const [stage, setStage] = useState<AnalysisStage>(restored?.stage ?? 'empty')
  const [media, setMedia] = useState<PreparedVideoMedia | null>(restored?.media ?? null)
  const [audioClip, setAudioClip] = useState<AudioClip | null>(null)
  const [transcription, setTranscription] =
    useState<AsrTranscriptionResult | null>(restored?.transcription ?? null)
  const [vadResult, setVadResult] = useState<VadDetectionResult | null>(restored?.vadResult ?? null)
  const [candidates, setCandidates] = useState<SmartCutCandidate[]>(restored?.candidates ?? [])
  const [history, setHistory] = useState<SmartCutCandidate[][]>(restored?.history ?? [])
  const [minimumSilence, setMinimumSilence] = useState(restored?.minimumSilence ?? 0.65)
  const [edgePadding, setEdgePadding] = useState(restored?.edgePadding ?? 0.12)
  const [selectedAsrModelId, setSelectedAsrModelId] = useState(restored?.selectedAsrModelId ?? '')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string | null>(restored?.selectedLlmModelId ?? null)
  const [plannerName, setPlannerName] = useState(restored?.plannerName ?? '')
  const [instruction, setInstruction] = useState(restored?.instruction ?? initialInstruction ?? '')
  const [draftVideo, setDraftVideo] = useState<{
    path: string
    name: string
  } | null>(() => restored ? restored.draftVideo : initialSourcePath ? {
    path: initialSourcePath,
    name: initialSourcePath.split(/[\\/]/u).at(-1) || t('未命名视频'),
  } : null)
  const [currentTime, setCurrentTime] = useState(restored?.currentTime ?? 0)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')
  const [showRestoredNotice, setShowRestoredNotice] = useState(Boolean(restored))
  const [previewReady, setPreviewReady] = useState(!restored?.media)
  const [exportedVideoPath, setExportedVideoPath] = useState(restored?.exportedVideoPath ?? '')
  const [activeAudition, setActiveAudition] = useState<{
    id: string
    start: number
    end: number
  } | null>(null)

  useEffect(() => {
    if (
      !autoStart || restored ||
      !initialLaunchId ||
      !initialSourcePath ||
      !initialInstruction?.trim() ||
      appliedInitialLaunchRef.current === initialLaunchId
    ) return
    appliedInitialLaunchRef.current = initialLaunchId
    submittedInitialLaunchRef.current = 0
    videoRef.current?.pause()
    autoAnalyzeRef.current = false
    plannerPreferencesRef.current = null
    setMedia(null)
    setAudioClip(null)
    setTranscription(null)
    setVadResult(null)
    setCandidates([])
    setHistory([])
    setCurrentTime(0)
    setActiveAudition(null)
    setDraftVideo({
      path: initialSourcePath,
      name: initialSourcePath.split(/[\\/]/u).at(-1) || t('未命名视频'),
    })
    setInstruction(initialInstruction)
    setPlannerName('')
    setStage('empty')
    setError('')
  }, [autoStart, initialInstruction, initialLaunchId, initialSourcePath, restored])
  const [auditionMode, setAuditionMode] = useState<'comparison' | 'removed'>(restored?.auditionMode ?? 'comparison')
  const [includeSubtitles, setIncludeSubtitles] = useState(restored?.includeSubtitles ?? true)
  const busy = stage === 'planning' || stage === 'preparing' || stage === 'transcribing' || stage === 'exporting'
  const samples = useMemo(() => audioClip?.samples ?? restored?.samples ?? [], [audioClip, restored])
  useProjectAutosave(projectId, 'smart-cut', useMemo(() => readSmartCutSnapshot({
    version: 1, stage, media, transcription, vadResult, candidates, history,
    minimumSilence, edgePadding, selectedAsrModelId, selectedLlmModelId,
    instruction, draftVideo, plannerName, plannerPreferences: plannerPreferencesRef.current,
    includeSubtitles, auditionMode, currentTime, samples, exportedVideoPath,
  }), [stage, media, transcription, vadResult, candidates, history, minimumSilence,
    edgePadding, selectedAsrModelId, selectedLlmModelId, instruction, draftVideo,
    plannerName, includeSubtitles, auditionMode, currentTime, samples, exportedVideoPath]))

  useEffect(() => {
    if (!restored?.media) return
    let disposed = false
    void restoreWorkspaceMedia([restored.media.sourcePath]).then(({ missing }) => {
      if (disposed) return
      if (missing.length) setError(t('原视频文件已移动或删除，编辑内容仍已保留：{0}', [missing[0]]))
      else setPreviewReady(true)
    }).catch((reason) => {
      if (!disposed) setError(localizeVideoEditorMessage(reason))
    })
    return () => { disposed = true }
  }, [restored])

  const asrModels = useMemo(
    () =>
      models
        .filter(
          (model) =>
            modelReady(model, catalog) &&
            model.streamingMode !== 'streaming' &&
            modelSupportsSmartCutTimeline(model) &&
            model.harnessCapabilities.includes('speech.transcribe'),
        )
        .sort((left, right) => {
          const leftLocal = left.providerId?.startsWith('api.') ? 1 : 0
          const rightLocal = right.providerId?.startsWith('api.') ? 1 : 0
          return leftLocal - rightLocal || left.name.localeCompare(right.name)
        }),
    [catalog, models],
  )
  const vadModel = useMemo(
    () =>
      models.find(
        (model) =>
          modelReady(model, catalog) &&
          model.streamingMode !== 'streaming' &&
          model.harnessCapabilities.includes('speech.detect'),
      ),
    [catalog, models],
  )
  const llmModels = useMemo(
    () =>
      models.filter(
        (model) =>
          modelReady(model, catalog) &&
          model.harnessCapabilities.includes('text.generate'),
      ),
    [catalog, models],
  )

  useEffect(() => {
    void videoEditorStatus()
      .then(setEngine)
      .catch((reason) =>
        setEngine({
          available: false,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      )
  }, [])

  useEffect(() => {
    if (!asrModels.length) return
    if (asrModels.some((model) => model.id === selectedAsrModelId)) return
    setSelectedAsrModelId(asrModels[0]?.id ?? '')
  }, [asrModels, selectedAsrModelId])

  useEffect(() => {
    if (!llmModels.length) return
    if (selectedLlmModelId === '') return
    if (llmModels.some((model) => model.id === selectedLlmModelId)) return
    setSelectedLlmModelId(llmModels[0]?.id ?? '')
  }, [llmModels, selectedLlmModelId])

  useEffect(() => {
    return () => {
      if (audioClip?.url?.startsWith('blob:')) URL.revokeObjectURL(audioClip.url)
    }
  }, [audioClip])

  const aiCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.reason !== 'manual'),
    [candidates],
  )
  const manualCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.reason === 'manual' && candidate.selected),
    [candidates],
  )
  const transcriptWords = useMemo(
    () => (transcription ? smartCutWords(transcription) : []),
    [transcription],
  )
  const wordsById = useMemo(
    () => new Map(transcriptWords.map((word) => [word.id, word])),
    [transcriptWords],
  )
  const activeWordId = useMemo(
    () => activeSmartCutWordId(transcriptWords, currentTime),
    [currentTime, transcriptWords],
  )
  const textSegments = useMemo(
    () => transcription
      ? buildSmartCutTextSegments(transcription, vadResult)
      : [],
    [transcription, vadResult],
  )
  const activeTextSegmentId = useMemo(
    () => textSegments.find(
      (segment) => currentTime >= segment.start && currentTime < segment.end,
    )?.id ?? null,
    [currentTime, textSegments],
  )

  useEffect(() => {
    if (!playing || !activeTextSegmentId) return
    const container = segmentListRef.current
    const segment = segmentElementRefs.current.get(activeTextSegmentId)
    if (!container || !segment) return
    const top = segment.offsetTop
    const bottom = top + segment.offsetHeight
    const visibleTop = container.scrollTop
    const visibleBottom = visibleTop + container.clientHeight
    if (top >= visibleTop && bottom <= visibleBottom) return
    container.scrollTo({
      top: Math.max(0, top - 7),
      behavior: 'smooth',
    })
  }, [activeTextSegmentId, playing])
  const manualGroups = useMemo(() => {
    const selected = new Map(
      manualCandidates.map((candidate) => [candidate.id, candidate]),
    )
    const groups: Array<{
      id: string
      text: string
      start: number
      end: number
    }> = []
    let activeGroup: (typeof groups)[number] | null = null
    for (const word of transcriptWords) {
      const candidate = selected.get(`manual-${word.id}`)
      if (!candidate) {
        activeGroup = null
        continue
      }
      if (activeGroup && candidate.start - activeGroup.end > 0.35) {
        activeGroup = null
      }
      if (!activeGroup) {
        activeGroup = {
          id: `manual-group-${word.id}`,
          text: word.text,
          start: candidate.start,
          end: candidate.end,
        }
        groups.push(activeGroup)
        continue
      }
      const joinWithoutSpace =
        /[\u3400-\u9fff]$/u.test(activeGroup.text) &&
        /^[\u3400-\u9fff]/u.test(word.text)
      activeGroup.text += `${joinWithoutSpace ? '' : ' '}${word.text}`
      activeGroup.end = candidate.end
    }
    const rangeGroups = manualCandidates
      .filter((candidate) => !wordsById.has(candidate.id.replace(/^manual-/u, '')))
      .map((candidate) => ({ id: candidate.id, text: candidate.label, start: candidate.start, end: candidate.end }))
    return [...groups, ...rangeGroups].sort((left, right) => left.start - right.start)
  }, [manualCandidates, transcriptWords, wordsById])
  const removedSeconds = media ? deletedDuration(candidates, media.duration) : 0
  const outputDuration = media ? Math.max(0, media.duration - removedSeconds) : 0
  const cuts = useMemo(
    () => (media ? selectedDeleteRanges(candidates, media.duration) : []),
    [candidates, media],
  )

  const updateCandidates = useCallback(
    (update: (current: SmartCutCandidate[]) => SmartCutCandidate[]) => {
      const next = update(candidates)
      if (next === candidates) return
      setHistory((snapshots) => [...snapshots.slice(-19), candidates])
      setCandidates(next)
    },
    [candidates],
  )

  const applyManualWordSelection = useCallback(
    (word: SmartCutWord, deleting: boolean) => {
      setCandidates((current) => {
        const id = `manual-${word.id}`
        const midpoint = (word.start + word.end) / 2
        const withoutWord = current
          .filter((candidate) => candidate.id !== id)
          .map((candidate) =>
            !deleting &&
            candidate.selected &&
            midpoint >= candidate.start &&
            midpoint < candidate.end
              ? { ...candidate, selected: false }
              : candidate,
          )
        if (!deleting) return withoutWord
        return [...withoutWord, manualWordCandidate(word)].sort(
          (left, right) => left.start - right.start,
        )
      })
    },
    [],
  )

  const beginWordSelection = (
    event: ReactPointerEvent<HTMLSpanElement>,
    word: SmartCutWord,
  ) => {
    if (stage !== 'review' || event.button !== 0) return
    event.preventDefault()
    const midpoint = (word.start + word.end) / 2
    const deleting = !candidates.some(
      (candidate) =>
        candidate.selected &&
        midpoint >= candidate.start &&
        midpoint < candidate.end,
    )
    wordDragRef.current = { deleting, visited: new Set([word.id]) }
    setHistory((snapshots) => [...snapshots.slice(-19), candidates])
    applyManualWordSelection(word, deleting)
    if (videoRef.current) videoRef.current.currentTime = word.start
  }

  const continueWordSelection = (word: SmartCutWord) => {
    const drag = wordDragRef.current
    if (!drag || stage !== 'review' || drag.visited.has(word.id)) return
    drag.visited.add(word.id)
    applyManualWordSelection(word, drag.deleting)
  }

  useEffect(() => {
    const finishSelection = () => {
      wordDragRef.current = null
    }
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', finishSelection)
    return () => {
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', finishSelection)
    }
  }, [])

  const resetProject = () => {
    videoRef.current?.pause()
    autoAnalyzeRef.current = false
    plannerPreferencesRef.current = null
    setMedia(null)
    setAudioClip(null)
    setTranscription(null)
    setVadResult(null)
    setCandidates([])
    setHistory([])
    setError('')
    setStage('empty')
    setCurrentTime(0)
    setActiveAudition(null)
    setDraftVideo(null)
    setInstruction('')
    setPlannerName('')
    setShowRestoredNotice(false)
    setExportedVideoPath('')
  }

  const chooseVideo = async () => {
    if (!engine?.available) {
      setError(engine?.message ?? t('视频引擎尚未就绪'))
      return
    }
    const selection = await open({
      title: t('选择要剪辑的口播视频'),
      multiple: false,
      directory: false,
      filters: [
        { name: t('视频文件'), extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] },
      ],
    })
    const sourcePath = typeof selection === 'string' ? selection : null
    if (!sourcePath) return
    setDraftVideo({
      path: sourcePath,
      name: sourcePath.split(/[\\/]/u).at(-1) || t('未命名视频'),
    })
    setError('')
  }

  const submitDraft = useCallback(async (options: { throwOnError?: boolean; autoAnalyze?: boolean } = {}) => {
    if (!draftVideo) {
      setError(t('请先上传一个视频'))
      return
    }
    if (!instruction.trim()) {
      setError(t('请输入剪辑指令'))
      return
    }
    videoRef.current?.pause()
    autoAnalyzeRef.current = options.autoAnalyze ?? true
    setMedia(null)
    setAudioClip(null)
    setTranscription(null)
    setVadResult(null)
    setCandidates([])
    setHistory([])
    setCurrentTime(0)
    setActiveAudition(null)
    setError('')
    setPlannerName('')
    setShowRestoredNotice(false)
    setExportedVideoPath('')
    const configuredPreferences = plannerPreferencesRef.current
    const localPreferences = { ...parseSmartCutInstruction(instruction), ...configuredPreferences }
    const llmModel = llmModels.find((model) => model.id === selectedLlmModelId)
    plannerPreferencesRef.current = localPreferences
    if (llmModel?.providerId) {
      setStage('planning')
      try {
        const execution = await onRunText(
          instruction.trim(),
          'text.generate',
          llmModel.providerId,
          llmModel.version,
          {
            systemPrompt: SMART_CUT_PLANNER_SYSTEM_PROMPT,
            temperature: 0,
            maxTokens: 320,
          },
          [],
          false,
        )
        if (!isTextResult(execution.output)) {
          throw new Error('planner did not return text')
        }
        plannerPreferencesRef.current = {
          ...mergeSmartCutPreferences(localPreferences, parseSmartCutPlannerOutput(execution.output.text)),
          ...configuredPreferences,
        }
        setPlannerName(llmModel.name)
        onAction(t('已使用 {0} 理解剪辑指令', [llmModel.name]))
      } catch {
        plannerPreferencesRef.current = localPreferences
        setPlannerName(t('本地规则'))
        onAction(t('{0} 暂时无法解析指令，已改用本地规则', [llmModel.name]))
      }
    } else {
      setPlannerName(t('本地规则'))
    }
    setStage('preparing')
    try {
      const prepared = await prepareVideoMedia(draftVideo.path).catch((reason) => {
        throw new Error(t('视频准备失败：{0}', [localizeVideoEditorMessage(reason)]))
      })
      const audioFile = await readDroppedAudioFile(prepared.audioPath).catch((reason) => {
        throw new Error(t('读取视频音轨失败：{0}', [localizeVideoEditorMessage(reason)]))
      })
      const clip = await audioFileToClip(audioFile).catch((reason) => {
        throw new Error(t('解析视频音轨失败：{0}', [localizeVideoEditorMessage(reason)]))
      })
      setMedia(prepared)
      setPreviewReady(true)
      setAudioClip({ ...clip, name: prepared.sourceName })
      setStage('ready')
      return { media: prepared, clip: { ...clip, name: prepared.sourceName } }
    } catch (reason) {
      autoAnalyzeRef.current = false
      setStage('empty')
      setError(localizeVideoEditorMessage(reason))
      if (options.throwOnError) throw reason
    }
  }, [draftVideo, instruction, llmModels, onAction, onRunText, selectedLlmModelId])

  useEffect(() => {
    if (
      !autoStart || restored ||
      !initialLaunchId ||
      !initialSourcePath ||
      !initialInstruction?.trim() ||
      appliedInitialLaunchRef.current !== initialLaunchId ||
      submittedInitialLaunchRef.current === initialLaunchId ||
      stage !== 'empty' ||
      draftVideo?.path !== initialSourcePath ||
      instruction.trim() !== initialInstruction.trim()
    ) return
    if (engine?.available === false) {
      submittedInitialLaunchRef.current = initialLaunchId
      setError(engine.message || t('视频引擎尚未就绪'))
      return
    }
    if (engine?.available !== true) return
    submittedInitialLaunchRef.current = initialLaunchId
    void submitDraft()
  }, [
    autoStart,
    restored,
    draftVideo,
    engine,
    initialInstruction,
    initialLaunchId,
    initialSourcePath,
    instruction,
    stage,
    submitDraft,
  ])

  const analyze = useCallback(async (options: { throwOnError?: boolean; preparedMedia?: PreparedVideoMedia; preparedClip?: AudioClip } = {}) => {
    const asrModel = asrModels.find((model) => model.id === selectedAsrModelId)
    const sourceMedia = options.preparedMedia ?? media
    if (!sourceMedia || !asrModel?.providerId) return
    videoRef.current?.pause()
    setActiveAudition(null)
    const preferences = plannerPreferencesRef.current ?? parseSmartCutInstruction(instruction)
    const effectiveMinimumSilence = preferences.minimumSilence ?? minimumSilence
    const effectiveEdgePadding = preferences.edgePadding ?? edgePadding
    if (preferences.minimumSilence !== undefined) {
      setMinimumSilence(preferences.minimumSilence)
    }
    if (preferences.includeSubtitles !== undefined) {
      setIncludeSubtitles(preferences.includeSubtitles)
    }
    if (preferences.edgePadding !== undefined) {
      setEdgePadding(preferences.edgePadding)
    }
    setStage('transcribing')
    setError('')
    setShowRestoredNotice(false)
    try {
      // Restoring a project never reads or reprocesses audio until the user resumes analysis.
      let clip = options.preparedClip ?? audioClip
      if (!clip) {
        const file = await readDroppedAudioFile(sourceMedia.audioPath).catch(async () => {
          const prepared = await prepareVideoMedia(sourceMedia.sourcePath)
          setMedia(prepared)
          setPreviewReady(true)
          return readDroppedAudioFile(prepared.audioPath)
        })
        clip = { ...await audioFileToClip(file), name: sourceMedia.sourceName }
        setAudioClip(clip)
      }
      const asrExecution = await onRunAudio(
        clip,
        'speech.transcribe',
        asrModel.providerId,
        asrModel.version,
        { language: 'auto' },
        false,
      )
      if (!isAsrResult(asrExecution.output)) {
        throw new Error(t('识别模型没有返回带时间轴的文本'))
      }
      const asr = normalizeSmartCutTranscription(
        asrExecution.output,
        sourceMedia.duration,
      )
      if (!hasUsableSmartCutTimeline(asr)) {
        throw new Error(t('识别模型没有返回可用于剪辑的词级或分段时间戳'))
      }
      let vad: VadDetectionResult | null = null
      if (vadModel?.providerId) {
        try {
          const vadExecution = await onRunAudio(
            clip,
            'speech.detect',
            vadModel.providerId,
            vadModel.version,
            {
              threshold: 0.25,
              minSpeechDuration: 0.18,
              minSilenceDuration: 0.2,
            },
            false,
          )
          if (isVadResult(vadExecution.output)) vad = vadExecution.output
        } catch {
          onAction(t('VAD 暂时不可用，已根据识别时间戳推断停顿'))
        }
      }
      let next = buildSmartCutCandidates(asr, vad, sourceMedia.duration, {
        minimumSilence: effectiveMinimumSilence,
        edgePadding: effectiveEdgePadding,
      })
      const visualTargets = next
        .filter((candidate) => candidate.reason === 'silence')
        .map(({ id, start, end }) => ({ id, start, end }))
      if (visualTargets.length) {
        const analyses = await analyzeCutBoundaries(sourceMedia.sourcePath, visualTargets)
        const byId = new Map(analyses.map((item) => [item.id, item]))
        next = next.map((candidate) => {
          const visual = byId.get(candidate.id)
          if (!visual) return candidate
          return {
            ...candidate,
            visualSimilarity: visual.similarity,
            visualStable: visual.stable,
            visualAvailable: visual.available,
            selected:
              candidate.reason === 'silence' &&
              candidate.confidence === 'high' &&
              visual.stable,
          }
        })
      }
      next = next.map((candidate) => {
        if (candidate.reason === 'filler' && preferences.removeFillers !== undefined) {
          return { ...candidate, selected: preferences.removeFillers }
        }
        if (candidate.reason === 'repetition' && preferences.removeRepetitions !== undefined) {
          return { ...candidate, selected: preferences.removeRepetitions }
        }
        if (candidate.reason !== 'silence') return candidate
        const preserveEdge =
          (preferences.preserveLeadingSilence && candidate.label === '片头静音') ||
          (preferences.preserveTrailingSilence && candidate.label === '片尾静音')
        return preferences.removeSilences === false || preserveEdge
          ? { ...candidate, selected: false }
          : candidate
      })
      setTranscription(asr)
      setVadResult(vad)
      setCandidates(next)
      setHistory([])
      setStage('review')
      onAction(t('分析完成：找到 {0} 个候选，请先校对再生成剪辑结果', [next.length]))
      return next.length
    } catch (reason) {
      setStage('ready')
      setError(localizeVideoEditorMessage(reason))
      if (options.throwOnError) throw reason
    }
  }, [
    asrModels,
    audioClip,
    edgePadding,
    instruction,
    media,
    minimumSilence,
    onAction,
    onRunAudio,
    selectedAsrModelId,
    vadModel,
  ])

  useEffect(() => {
    if (stage !== 'ready' || !autoAnalyzeRef.current || !media || !audioClip) return
    autoAnalyzeRef.current = false
    const asrModel = asrModels.find((model) => model.id === selectedAsrModelId)
    if (!asrModel?.providerId) {
      onAction(t('视频和剪辑指令已添加，请先安装或选择识别模型'))
      return
    }
    void analyze()
  }, [analyze, audioClip, asrModels, media, onAction, selectedAsrModelId, stage])

  const rebuildSilences = (configuration: Pick<SmartCutConfiguration, 'minimumSilence' | 'edgePadding'> = {}) => {
    if (!transcription || !media) return
    const preferences = plannerPreferencesRef.current ?? parseSmartCutInstruction(instruction)
    const rebuilt = buildSmartCutCandidates(
      transcription,
      vadResult,
      media.duration,
      { minimumSilence: configuration.minimumSilence ?? minimumSilence, edgePadding: configuration.edgePadding ?? edgePadding },
    )
    const visualByWindow = candidates
      .filter((candidate) => candidate.reason === 'silence')
      .map((candidate) => candidate)
    const selectedById = new Map(
      candidates.map((candidate) => [candidate.id, candidate.selected]),
    )
    const manual = candidates.filter((candidate) => candidate.reason === 'manual')
    updateCandidates(() =>
      [...rebuilt.map((candidate) => {
        if (candidate.reason !== 'silence') return candidate
        const nearest = visualByWindow.find(
          (current) =>
            Math.abs(current.start - candidate.start) < 0.2 &&
            Math.abs(current.end - candidate.end) < 0.2,
        )
        return nearest
          ? {
              ...candidate,
              visualSimilarity: nearest.visualSimilarity,
              visualStable: nearest.visualStable,
              visualAvailable: nearest.visualAvailable,
              selected:
                preferences.removeSilences === false ||
                (preferences.preserveLeadingSilence && candidate.label === '片头静音') ||
                (preferences.preserveTrailingSilence && candidate.label === '片尾静音')
                  ? false
                  : Boolean(nearest.visualStable && candidate.confidence === 'high'),
            }
          : preferences.removeSilences === false ||
              (preferences.preserveLeadingSilence && candidate.label === '片头静音') ||
              (preferences.preserveTrailingSilence && candidate.label === '片尾静音')
            ? { ...candidate, selected: false }
            : candidate
      }).map((candidate) => candidate.reason === 'silence'
        ? candidate
        : { ...candidate, selected: selectedById.get(candidate.id) ?? candidate.selected }), ...manual]
        .sort((left, right) => left.start - right.start),
    )
  }

  const previewCandidate = (candidate: { id: string; start: number; end: number }) => {
    const video = videoRef.current
    if (!video) return
    setAuditionMode('comparison')
    setActiveAudition(candidate)
    video.currentTime = Math.max(0, candidate.start - 1.2)
    void video.play()
  }

  const previewRemovedCandidate = (candidate: { id: string; start: number; end: number }) => {
    const video = videoRef.current
    if (!video) return
    setAuditionMode('removed')
    setActiveAudition(candidate)
    video.currentTime = candidate.start
    void video.play()
  }

  const handleVideoTime = () => {
    const video = videoRef.current
    if (!video) return
    let time = video.currentTime
    const previewCuts = activeAudition && auditionMode === 'comparison'
      ? [activeAudition]
      : stage === 'preview'
        ? cuts
        : []
    const containing = previewCuts.find(
      (range) => time >= range.start && time < range.end,
    )
    if (containing) {
      video.currentTime = Math.min(media?.duration ?? containing.end, containing.end + 0.015)
      time = video.currentTime
    }
    if (activeAudition) {
      const candidate = activeAudition
      const finishedRemoved = candidate && auditionMode === 'removed' && time >= candidate.end
      const finishedComparison = candidate && auditionMode === 'comparison' && time > candidate.end + 1.2
      if (candidate && (finishedRemoved || finishedComparison)) {
        video.pause()
        if (finishedRemoved) {
          video.currentTime = candidate.end
          time = candidate.end
        }
        setActiveAudition(null)
      }
    }
    setCurrentTime(time)
  }

  const seekTimeline = (event: MouseEvent<HTMLDivElement>) => {
    if (!media || !videoRef.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    videoRef.current.currentTime = ratio * media.duration
  }

  const exportVideo = async (options: { throwOnError?: boolean } = {}) => {
    if (!media) return
    const previousStage = stage
    setStage('exporting')
    setError('')
    try {
      const destinationPath = await save({
        title: t('导出口播剪辑视频'),
        defaultPath: `${clipNameWithoutExtension(media.sourceName)}-smart-cut.mp4`,
        canCreateDirectories: true,
        filters: [{ name: t('MP4 视频'), extensions: ['mp4'] }],
      })
      if (!destinationPath) {
        setStage(previousStage)
        return null
      }
      await exportSmartCut(
        media.sourcePath,
        destinationPath,
        keepRangesFromCuts(candidates, media.duration),
        includeSubtitles && transcription
          ? buildSmartCutSubtitleCues(
              transcription,
              candidates,
              media.duration,
              {},
              vadResult,
            )
          : [],
      )
      setStage('preview')
      setExportedVideoPath(destinationPath)
      onAction(t('剪辑视频已保存到 {0}', [destinationPath]))
      return destinationPath
    } catch (reason) {
      setStage(previousStage)
      setError(localizeVideoEditorMessage(reason))
      if (options.throwOnError) throw reason
    }
  }

  const undoCandidates = () => {
    const previous = history.at(-1)
    if (!previous) return false
    videoRef.current?.pause()
    setActiveAudition(null)
    setStage('review')
    setCandidates(previous)
    setHistory((current) => current.slice(0, -1))
    return true
  }

  const startPreview = async () => {
    const video = videoRef.current
    if (!video || !previewReady) throw new Error(t('视频预览尚未就绪。'))
    setActiveAudition(null)
    // Flush before playback so time updates skip the current selected cuts.
    flushSync(() => setStage('preview'))
    video.currentTime = 0
    await video.play()
  }

  const configureCut = (configuration: SmartCutConfiguration, applySuggestions = true) => {
    if (configuration.instruction !== undefined) {
      setInstruction(configuration.instruction)
      plannerPreferencesRef.current = parseSmartCutInstruction(configuration.instruction)
      setPlannerName(t('本地规则'))
    }
    plannerPreferencesRef.current = {
      ...(plannerPreferencesRef.current ?? parseSmartCutInstruction(instruction)),
      ...(configuration.minimumSilence !== undefined ? { minimumSilence: configuration.minimumSilence } : {}),
      ...(configuration.edgePadding !== undefined ? { edgePadding: configuration.edgePadding } : {}),
      ...(configuration.includeSubtitles !== undefined ? { includeSubtitles: configuration.includeSubtitles } : {}),
    }
    if (configuration.minimumSilence !== undefined) setMinimumSilence(configuration.minimumSilence)
    if (configuration.edgePadding !== undefined) setEdgePadding(configuration.edgePadding)
    if (configuration.includeSubtitles !== undefined) setIncludeSubtitles(configuration.includeSubtitles)
    if (configuration.asrModelId !== undefined) setSelectedAsrModelId(configuration.asrModelId)
    if (configuration.llmModelId !== undefined) setSelectedLlmModelId(configuration.llmModelId)
    if (applySuggestions && (configuration.minimumSilence !== undefined || configuration.edgePadding !== undefined)) {
      rebuildSilences(configuration)
    }
  }

  const controllerRevision = useMemo(() => JSON.stringify({
    sourcePath: media?.sourcePath ?? draftVideo?.path ?? null,
    duration: media?.duration ?? null,
    instruction, minimumSilence, edgePadding, includeSubtitles,
    selectedAsrModelId, selectedLlmModelId, transcription, candidates, history,
  }), [media?.sourcePath, media?.duration, draftVideo?.path, instruction, minimumSilence,
    edgePadding, includeSubtitles, selectedAsrModelId, selectedLlmModelId, transcription, candidates, history])

  useWorkspaceController(projectId, {
    getState: () => ({
      mode: 'smart-cut', revision: controllerRevision, busy: busy || commandBusyRef.current,
      context: {
        stage, instruction,
        source: media ? { path: media.sourcePath, name: media.sourceName, duration: media.duration } : draftVideo,
        settings: { minimumSilence, edgePadding, includeSubtitles, selectedAsrModelId, selectedLlmModelId },
        engineReady: engine?.available === true,
        availableAsrModels: asrModels.map(({ id, name }) => ({ id, name })),
        availablePlannerModels: [{ id: '', name: t('本地规则') }, ...llmModels.map(({ id, name }) => ({ id, name }))],
        candidates: candidates.map(({ id, start, end, reason, label, selected }) => ({ id, start, end, reason, label, selected })),
        transcription: transcription ? { text: transcription.text, segments: transcription.segments, words: transcriptWords } : null,
        undoAvailable: history.length > 0, outputDuration,
        error: error || null,
      },
      actions: SMART_CUT_ACTIONS,
    }),
    execute: async (rawCommand) => {
      if (busy || commandBusyRef.current) throw new Error(t('剪辑正在处理中，请完成后再修改。'))
      const command = validateSmartCutCommand(rawCommand, {
        candidates, duration: media?.duration ?? null,
        asrModelIds: asrModels.map(({ id }) => id), llmModelIds: llmModels.map(({ id }) => id),
      })
      const requireReview = () => {
        if (!media || !transcription || (stage !== 'review' && stage !== 'preview')) throw new Error(t('请先完成视频分析，再编辑剪辑候选。'))
      }
      const resumeReview = () => {
        videoRef.current?.pause()
        setActiveAudition(null)
        setStage('review')
      }
      const ensureKeptContent = (next: SmartCutCandidate[]) => {
        ensureSmartCutContentRemaining(next, media?.duration ?? 0)
      }
      commandBusyRef.current = true
      try {
        switch (command.action) {
          case 'cut.configure':
            flushSync(() => {
              if (stage === 'preview') resumeReview()
              configureCut(command.args)
            })
            return { message: t('已更新右侧的剪辑设置。') }
          case 'cut.select': {
            requireReview()
            const ids = new Set(command.args.ids)
            const changed = candidates.filter((candidate) => ids.has(candidate.id) && candidate.selected !== command.args.selected).length
            const next = candidates.map((candidate) => ids.has(candidate.id) ? { ...candidate, selected: command.args.selected } : candidate)
            ensureKeptContent(next)
            if (changed) flushSync(() => { resumeReview(); updateCandidates(() => next) })
            return { message: command.args.selected ? t('已将 {0} 个片段标记为删除。', [changed]) : t('已将 {0} 个片段恢复为保留。', [changed]) }
          }
          case 'cut.remove-range': {
            requireReview()
            const next = [...candidates, manualRangeCandidate(command.args.start, command.args.end)].sort((left, right) => left.start - right.start)
            ensureKeptContent(next)
            flushSync(() => { resumeReview(); updateCandidates(() => next) })
            return { message: t('已标记删除 {0}–{1} 秒，可在右侧校对或撤销。', [command.args.start, command.args.end]) }
          }
          case 'cut.undo':
            requireReview()
            if (!history.length) throw new Error(t('当前没有可撤销的剪辑修改。'))
            flushSync(undoCandidates)
            return { message: t('已撤销上一次剪辑候选修改。') }
          case 'cut.analyze': {
            if (engine?.available !== true) throw new Error(engine?.message || t('视频引擎尚未就绪'))
            if (!asrModels.some(({ id, providerId }) => id === selectedAsrModelId && providerId)) throw new Error(t('请选择当前可用的识别模型。'))
            if (!instruction.trim()) throw new Error(t('请输入剪辑指令'))
            if (!media && !draftVideo) throw new Error(t('请先上传一个视频'))
            const prepared = media ? undefined : await submitDraft({ throwOnError: true, autoAnalyze: false })
            const count = await analyze({ throwOnError: true, preparedMedia: prepared?.media, preparedClip: prepared?.clip })
            if (count === undefined) throw new Error(t('视频分析未能开始，请检查素材和识别模型。'))
            return { message: t('分析完成：找到 {0} 个候选，请先校对再生成剪辑结果', [count]) }
          }
          case 'cut.preview':
            requireReview()
            ensureKeptContent(candidates)
            await startPreview()
            return { message: t('正在右侧播放剪辑预览。') }
          case 'cut.export': {
            requireReview()
            ensureKeptContent(candidates)
            const path = await exportVideo({ throwOnError: true })
            return { message: path ? t('剪辑视频已保存到 {0}', [path]) : t('已取消导出，剪辑内容仍保留。') }
          }
        }
      } finally {
        commandBusyRef.current = false
      }
    },
  })

  if (!media) {
    const draftBusy = stage === 'planning' || stage === 'preparing'
    const agentLaunchBusy = Boolean(
      initialLaunchId &&
      initialSourcePath &&
      initialInstruction?.trim() &&
      (submittedInitialLaunchRef.current !== initialLaunchId || draftBusy),
    )
    const promptSuggestions = [
      '删除口水词和超过 0.8 秒的静音，保留片头，并生成字幕',
      '只删除明显的口水词，保留所有停顿',
      '去掉长静音，不要字幕',
    ]
    if (autoStart && !restored && initialLaunchId && initialSourcePath && initialInstruction?.trim() && !error) {
      return (
        <main className={`smart-cut-view project agent-cut-initializing${panelMode ? ' in-panel' : ''}`}>
          <header className="smart-cut-project-header">
            <div>
              <span className="smart-cut-kicker">TALKING-HEAD EDITOR</span>
              <h1>{draftVideo?.name ?? t('视频剪辑')}</h1>
              <p className="smart-cut-project-instruction">{t('剪辑要求：{0}', [instruction])}</p>
            </div>
            <div className="smart-cut-stage-indicator">
              <span className="active">1. {t('识别分析')}</span>
              <span>2. {t('人工校对')}</span>
              <span>3. {t('预览导出')}</span>
            </div>
          </header>
          <div className="smart-cut-layout">
            <section className="smart-cut-preview-panel">
              <div className="smart-cut-video-shell">
                <div className="smart-cut-busy-overlay">
                  {agentLaunchBusy && <LoaderCircle className="model-spin" size={24} />}
                  <strong>
                    {error
                      ? t('视频任务暂未开始')
                      : t('正在载入视频并开始分析…')}
                  </strong>
                </div>
              </div>
            </section>
            <aside className="smart-cut-review-panel agent-cut-submission">
              <span className="smart-cut-kicker">{t('已提交的任务')}</span>
              <div className="smart-cut-video-attachment">
                <FileVideo size={17} />
                <span>
                  <strong>{draftVideo?.name ?? t('未命名视频')}</strong>
                  <small>{t('视频附件')}</small>
                </span>
              </div>
              <p>{instruction}</p>
              {error && <div className="smart-cut-error">{error}</div>}
            </aside>
          </div>
        </main>
      )
    }
    return (
      <main className={`smart-cut-view empty${panelMode ? ' in-panel' : ''}`}>
        {showRestoredNotice && <p className="smart-cut-restored-note" role="status">{t('已恢复剪辑草稿，点击开始分析以继续。')}</p>}
        <section className="smart-cut-hero">
          <div className="smart-cut-hero-icon"><Scissors size={26} /></div>
          <span className="smart-cut-kicker">TALKING-HEAD EDITOR</span>
          <h1>{t('告诉我你想怎么剪')}</h1>
          <p>
            {t('上传视频并输入剪辑要求。系统会先识别和分析，再让你逐项校对，原视频始终不变。')}
          </p>
        </section>
        <section className="smart-cut-composer" aria-label={t('口播剪辑任务')}>
          {draftVideo && (
            <div className="smart-cut-video-attachment">
              <FileVideo size={17} />
              <span>
                <strong>{draftVideo.name}</strong>
                <small>{t('视频附件')}</small>
              </span>
              <button
                type="button"
                title={t('移除视频')}
                aria-label={t('移除视频')}
                disabled={draftBusy}
                onClick={() => setDraftVideo(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <textarea
            value={instruction}
            rows={4}
            maxLength={2000}
            placeholder={t('例如：删除口水词和超过 0.8 秒的静音，保留片头，并生成字幕')}
            disabled={draftBusy}
            onChange={(event) => configureCut({ instruction: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (draftVideo && instruction.trim() && engine?.available) void submitDraft()
            }}
          />
          <div className="smart-cut-composer-toolbar">
            <button
              className="smart-cut-attach-button"
              type="button"
              title={draftVideo ? t('更换视频') : t('上传视频')}
              disabled={draftBusy || engine?.available !== true}
              onClick={() => void chooseVideo()}
            >
              <Paperclip size={16} />
              <span>{draftVideo ? t('更换视频') : t('上传视频')}</span>
            </button>
            <label className="smart-cut-planner-model" title={t('指令解析模型')}>
              <Sparkles size={14} />
              <select
                value={selectedLlmModelId ?? ''}
                disabled={draftBusy}
                aria-label={t('指令解析模型')}
                onChange={(event) => setSelectedLlmModelId(event.target.value)}
              >
                <option value="">{t('本地规则')}</option>
                {llmModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
            </label>
            <small>{t('支持 MP4、MOV、M4V、WebM 和 MKV')}</small>
            <button
              className="smart-cut-send"
              type="button"
              title={t('发送并开始分析')}
              aria-label={t('发送并开始分析')}
              disabled={
                draftBusy ||
                engine?.available !== true ||
                !draftVideo ||
                !instruction.trim()
              }
              onClick={() => void submitDraft()}
            >
              {draftBusy ? (
                <LoaderCircle className="model-spin" size={17} />
              ) : (
                <ArrowUp size={17} strokeWidth={2.2} />
              )}
            </button>
          </div>
          <div className="smart-cut-draft-settings">
            <label className="smart-cut-subtitle-toggle">
              <input type="checkbox" checked={includeSubtitles} disabled={draftBusy} onChange={(event) => configureCut({ includeSubtitles: event.target.checked })} />
              <Captions size={15} /> {t('内嵌字幕')}
            </label>
            <label>
              {t('最短静音')}
              <input type="number" min="0.3" max="2" step="0.05" value={minimumSilence} disabled={draftBusy} onChange={(event) => {
                const value = event.target.valueAsNumber
                if (Number.isFinite(value) && value >= 0.3 && value <= 2) configureCut({ minimumSilence: value })
              }} />
              <span>s</span>
            </label>
            <label>
              {t('切口缓冲')}
              <input type="number" min="0.04" max="0.35" step="0.01" value={edgePadding} disabled={draftBusy} onChange={(event) => {
                const value = event.target.valueAsNumber
                if (Number.isFinite(value) && value >= 0.04 && value <= 0.35) configureCut({ edgePadding: value })
              }} />
              <span>s</span>
            </label>
          </div>
        </section>
        <div className="smart-cut-prompt-suggestions" aria-label={t('示例指令')}>
          {promptSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={draftBusy}
              onClick={() => configureCut({ instruction: suggestion })}
            >
              {t(suggestion)}
            </button>
          ))}
        </div>
        <section className="smart-cut-entry-status">
          <div className={`smart-cut-engine${engine?.available === false ? ' error' : ''}`}>
            <i />
            {draftBusy
              ? statusCopy(stage)
              : engine?.message
                ? localizeVideoEditorMessage(engine.message)
                : t('正在检查视频引擎…')}
          </div>
          {error && <div className="smart-cut-error">{error}</div>}
        </section>
      </main>
    )
  }

  return (
    <main className={`smart-cut-view project${panelMode ? ' in-panel' : ''}`}>
      <header className="smart-cut-project-header">
        <div>
          <button className="smart-cut-back" type="button" onClick={resetProject} disabled={busy}>
            <ChevronLeft size={15} /> {t('新建项目')}
          </button>
          <h1>{media.sourceName}</h1>
          <p className="smart-cut-project-instruction">
            {t('剪辑要求：{0}', [instruction])}
            {plannerName && <span>{t(' · 由 {0} 解析', [plannerName])}</span>}
          </p>
        </div>
        <div className="smart-cut-stage-indicator">
          {['识别分析', '人工校对', '预览导出'].map((label, index) => {
            const activeIndex = stage === 'ready' || stage === 'transcribing' ? 0 : stage === 'review' ? 1 : 2
            return <span key={label} className={index <= activeIndex ? 'active' : ''}>{index + 1}. {t(label)}</span>
          })}
        </div>
      </header>

      {showRestoredNotice && <p className="smart-cut-restored-note" role="status">{restored?.interrupted
        ? t('上次处理已中断，剪辑内容已恢复；请检查后继续。')
        : t('已恢复剪辑内容和手动修改。')}</p>}

      <div className="smart-cut-layout">
        <section className="smart-cut-preview-panel">
          <div className="smart-cut-video-shell">
            <video
              ref={videoRef}
              src={previewReady ? localVideoUrl(media.sourcePath) : undefined}
              onLoadedMetadata={(event) => { event.currentTarget.currentTime = currentTime }}
              onTimeUpdate={handleVideoTime}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              playsInline
            />
            {busy && (
              <div className="smart-cut-busy-overlay">
                <LoaderCircle className="model-spin" size={24} />
                <strong>{statusCopy(stage)}</strong>
              </div>
            )}
          </div>
          <div className="smart-cut-player-controls">
            <button
              type="button"
              aria-label={playing ? t('暂停') : t('播放')}
              onClick={() => {
                const video = videoRef.current
                if (!video) return
                if (video.paused) void video.play()
                else video.pause()
              }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <span>{formatTime(currentTime, true)} / {formatTime(media.duration, true)}</span>
            {stage === 'preview' && <em><Sparkles size={13} /> {t('正在预览剪辑结果')}</em>}
          </div>
          <div className="smart-cut-timeline-heading">
            <span className="smart-cut-timeline-meta">
              {formatTime(media.duration)} · {media.width}×{media.height}
              {media.fps > 0 ? ` · ${media.fps.toFixed(1)} fps` : ''} · {formatFileSize(media.sizeBytes)}
            </span>
          </div>
          <div className="smart-cut-timeline" onClick={seekTimeline} role="slider" aria-label={t('视频时间线')} tabIndex={0}>
            <div className="smart-cut-waveform" aria-hidden="true">
              {samples.slice(0, 180).map((sample, index) => (
                <i key={index} style={{ height: `${Math.max(8, sample * 86)}%` }} />
              ))}
            </div>
            {candidates.map((candidate) => (
              <span
                key={candidate.id}
                className={`smart-cut-range ${candidate.reason}${candidate.selected ? ' selected' : ''}`}
                style={{
                  left: `${(candidate.start / media.duration) * 100}%`,
                  width: `${Math.max(0.2, ((candidate.end - candidate.start) / media.duration) * 100)}%`,
                }}
                title={candidateLabel(candidate)}
              />
            ))}
            <b style={{ left: `${(currentTime / media.duration) * 100}%` }} />
          </div>

          {stage === 'ready' && (
            <section className="smart-cut-setup-card">
              <div>
                <span className="smart-cut-kicker">STEP 1</span>
                <h2>{t('识别视频内容')}</h2>
                <p>{t('建议使用带词级时间戳的本地批处理模型；安装 VAD 后会得到更可靠的静音边界。')}</p>
              </div>
              {asrModels.length ? (
                <>
                  <label>
                    {t('识别模型')}
                    <select value={selectedAsrModelId} onChange={(event) => setSelectedAsrModelId(event.target.value)}>
                      {asrModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                    </select>
                  </label>
                  <button className="smart-cut-primary" type="button" onClick={() => void analyze()}>
                    <Sparkles size={16} /> {t('开始分析')}
                  </button>
                </>
              ) : (
                <div className="smart-cut-no-model">
                  <p>{t('还没有可用且支持时间戳的批处理语音识别模型。')}</p>
                  <button type="button" onClick={onOpenStore}>{t('打开 Agents 安装模型')}</button>
                </div>
              )}
            </section>
          )}

          <details className="smart-cut-edit-settings">
            <summary>{t('剪辑要求与模型')}</summary>
            <label>
              {t('剪辑要求')}
              <textarea
                rows={3}
                maxLength={2000}
                value={instruction}
                disabled={busy}
                onChange={(event) => configureCut({ instruction: event.target.value })}
              />
            </label>
            <label>
              {t('识别模型')}
              <select value={selectedAsrModelId} disabled={busy} onChange={(event) => configureCut({ asrModelId: event.target.value })}>
                {!asrModels.length && <option value="">{t('没有可用模型')}</option>}
                {asrModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            <label>
              {t('指令解析模型')}
              <select value={selectedLlmModelId ?? ''} disabled={busy} onChange={(event) => configureCut({ llmModelId: event.target.value })}>
                <option value="">{t('本地规则')}</option>
                {llmModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            {(stage === 'review' || stage === 'preview') && (
              <button
                className="smart-cut-primary"
                type="button"
                disabled={busy || !instruction.trim() || !asrModels.some(({ id }) => id === selectedAsrModelId)}
                title={t('重新分析会更新识别结果和剪辑候选。')}
                onClick={() => void analyze()}
              >
                <RotateCcw size={14} /> {t('重新分析')}
              </button>
            )}
          </details>

          {(stage === 'review' || stage === 'preview' || stage === 'exporting') && transcription && (
            <section className="smart-cut-transcript">
              <div className="smart-cut-section-heading">
                <div>
                  <span className="smart-cut-kicker">TEXT-BASED EDITING</span>
                  <h2>{t('按文字剪辑')}</h2>
                </div>
                <span>
                  {transcription.engine} · {transcription.language} ·{' '}
                  {transcriptWords.length ? t('词级时间轴 · {0} 段', [textSegments.length]) : t('句段时间轴')}
                </span>
              </div>
              {transcriptWords.length > 0 && (
                <div className="smart-cut-word-toolbar">
                  <p>{t('点击或拖过文字即可标记删除；再次操作可恢复。')}</p>
                  <div>
                    <span className="suggested">{t('AI 建议')}</span>
                    <span className="deleted">{t('将删除')}</span>
                    <strong>{t('{0} 个手动选择', [manualCandidates.length])}</strong>
                  </div>
                </div>
              )}
              <div className="smart-cut-segments" ref={segmentListRef}>
                {textSegments.map((segment) => {
                  const segmentWords = segment.wordIds
                    .map((wordId) => wordsById.get(wordId))
                    .filter((word): word is SmartCutWord => Boolean(word))
                  return (
                  <article
                    key={segment.id}
                    className={activeTextSegmentId === segment.id ? 'active' : ''}
                    ref={(element) => {
                      if (element) segmentElementRefs.current.set(segment.id, element)
                      else segmentElementRefs.current.delete(segment.id)
                    }}
                  >
                    <button
                      type="button"
                      aria-label={t('跳到 {0}，本段结束于 {1}', [formatTime(segment.start, true), formatTime(segment.end, true)])}
                      title={t('开始时间–结束时间')}
                      onClick={() => {
                        if (videoRef.current) videoRef.current.currentTime = segment.start
                      }}
                    >
                      {formatTime(segment.start, true)}–{formatTime(segment.end, true)}
                    </button>
                    <div className="smart-cut-segment-content">
                      {segmentWords.length > 0 ? (
                        <div className="smart-cut-word-line">
                          {segmentWords.map((word) => {
                            const midpoint = (word.start + word.end) / 2
                            const related = candidates.filter(
                              (candidate) =>
                                candidate.reason !== 'manual' &&
                                midpoint >= candidate.start &&
                                midpoint < candidate.end,
                            )
                            const manuallyDeleted = manualCandidates.some(
                              (candidate) => candidate.id === `manual-${word.id}`,
                            )
                            const aiDeleted = related.some((candidate) => candidate.selected)
                            const suggested = related.length > 0 && !aiDeleted
                            const current = activeWordId === word.id
                            return (
                              <span
                                key={word.id}
                                role="button"
                                tabIndex={stage === 'review' ? 0 : -1}
                                className={`${manuallyDeleted || aiDeleted ? 'deleted' : ''}${suggested ? ' suggested' : ''}${current ? ' current' : ''}${manuallyDeleted ? ' manual' : ''}`}
                                title={`${formatTime(word.start, true)}–${formatTime(word.end, true)}`}
                                onPointerDown={(event) => beginWordSelection(event, word)}
                                onPointerEnter={() => continueWordSelection(word)}
                                onKeyDown={(event) => {
                                  if (stage !== 'review') return
                                  if (event.key !== 'Enter' && event.key !== ' ') return
                                  event.preventDefault()
                                  setHistory((snapshots) => [...snapshots.slice(-19), candidates])
                                  applyManualWordSelection(word, !(manuallyDeleted || aiDeleted))
                                }}
                              >
                                {word.text}
                              </span>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="smart-cut-no-word-timeline">
                          {t('当前模型没有返回词级时间戳，只能按句段校对，不能自由选择单词。')}
                        </p>
                      )}
                    </div>
                  </article>
                )})}
              </div>
            </section>
          )}
        </section>

        <aside className="smart-cut-review-panel">
          {(stage === 'review' || stage === 'preview' || stage === 'exporting') ? (
            <>
              <div className="smart-cut-section-heading">
                <div>
                  <span className="smart-cut-kicker">REVIEW</span>
                  <h2>{t('删除候选')}</h2>
                </div>
                <strong>{t('AI {0}/{1} · 手动 {2}', [aiCandidates.filter((candidate) => candidate.selected).length, aiCandidates.length, manualCandidates.length])}</strong>
              </div>
              <div className="smart-cut-summary">
                <div><small>{t('原时长')}</small><strong>{formatTime(media.duration, true)}</strong></div>
                <div><small>{t('预计删除')}</small><strong>-{formatTime(removedSeconds, true)}</strong></div>
                <div><small>{t('剪辑后')}</small><strong>{formatTime(outputDuration, true)}</strong></div>
              </div>
              <div className="smart-cut-tuning">
                <label>
                  {t('最短静音')} <strong>{minimumSilence.toFixed(2)}s</strong>
                  <input type="range" min="0.3" max="2" step="0.05" value={minimumSilence} disabled={stage !== 'review'} onChange={(event) => configureCut({ minimumSilence: Number(event.target.value) }, false)} />
                </label>
                <label>
                  {t('切口缓冲')} <strong>{edgePadding.toFixed(2)}s</strong>
                  <input type="range" min="0.04" max="0.35" step="0.01" value={edgePadding} disabled={stage !== 'review'} onChange={(event) => configureCut({ edgePadding: Number(event.target.value) }, false)} />
                </label>
                {stage === 'review' && <button type="button" onClick={() => rebuildSilences()}>{t('应用参数')}</button>}
              </div>
              <div className="smart-cut-batch-actions">
                <button
                  type="button"
                  disabled={!history.length || stage !== 'review'}
                  onClick={undoCandidates}
                ><RotateCcw size={14} /> {t('撤销')}</button>
                <button
                  type="button"
                  disabled={stage !== 'review'}
                  onClick={() => updateCandidates((current) => current
                    .filter((item) => item.reason !== 'manual')
                    .map((item) => ({ ...item, selected: false })))}
                >{t('全部保留')}</button>
                <button
                  type="button"
                  disabled={stage !== 'review'}
                  onClick={() => updateCandidates((current) => current
                    .filter((item) => item.reason !== 'manual')
                    .map((item) => ({
                      ...item,
                      selected: item.reason === 'silence'
                        ? Boolean(item.visualStable && item.confidence === 'high')
                        : item.confidence === 'high',
                    })))}
                ><ShieldCheck size={14} /> {t('保守建议')}</button>
              </div>
              {manualCandidates.length > 0 && (
                <div className="smart-cut-manual-summary">
                  <div className="smart-cut-manual-heading">
                    <div>
                      <Scissors size={14} />
                      <span>{t('手动选择')} <strong>{t('{0} 个标记 · {1} 组', [manualCandidates.length, manualGroups.length])}</strong></span>
                    </div>
                    <button
                      type="button"
                      disabled={stage !== 'review'}
                      onClick={() => updateCandidates((current) =>
                        current.filter((candidate) => candidate.reason !== 'manual'))}
                    >{t('全部恢复')}</button>
                  </div>
                  <div className="smart-cut-manual-list">
                    {manualGroups.map((group) => (
                      <div className="smart-cut-manual-row" key={group.id}>
                        <button
                          type="button"
                          className="smart-cut-manual-word"
                          title={t('定位到这个删除单元')}
                          onClick={() => {
                            if (videoRef.current) videoRef.current.currentTime = group.start
                          }}
                        >{group.text}</button>
                        <time>{formatTime(group.start, true)}–{formatTime(group.end, true)}</time>
                        <button
                          type="button"
                          className="smart-cut-manual-icon"
                          aria-label={t('试听切前切后：{0}', [group.text])}
                          title={t('试听切前/切后')}
                          onClick={() => previewCandidate(group)}
                        ><Scissors size={12} /></button>
                        <button
                          type="button"
                          className="smart-cut-manual-icon"
                          aria-label={t('试听待删除片段：{0}', [group.text])}
                          title={t('试听待删除片段')}
                          onClick={() => previewRemovedCandidate(group)}
                        ><Volume2 size={12} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="smart-cut-candidates">
                {aiCandidates.length ? aiCandidates.map((candidate) => (
                  <article
                    key={candidate.id}
                    className={candidate.selected ? 'selected' : ''}
                    title={candidateDetail(candidate)}
                  >
                    <label className="smart-cut-candidate-choice">
                      <input
                        type="checkbox"
                        checked={candidate.selected}
                        disabled={stage !== 'review'}
                        onChange={() => updateCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, selected: !item.selected } : item))}
                      />
                      <span className={`smart-cut-reason ${candidate.reason}`}>{t(REASON_LABELS[candidate.reason])}</span>
                      <strong>{compactCandidateLabel(candidate)}</strong>
                    </label>
                    <div className="smart-cut-candidate-inline-meta">
                      <time>{formatTime(candidate.start, true)}–{formatTime(candidate.end, true)}</time>
                      {candidate.reason === 'silence' && (
                        candidate.visualAvailable
                          ? <span
                              className={candidate.visualStable ? 'stable' : 'unstable'}
                              title={t('画面相似度 {0}%', [Math.round((candidate.visualSimilarity ?? 0) * 100)])}
                              aria-label={t('画面相似度 {0}%', [Math.round((candidate.visualSimilarity ?? 0) * 100)])}
                            >
                              <Eye size={12} />
                            </span>
                          : <span title={t('未取得画面帧')} aria-label={t('未取得画面帧')}><Eye size={12} /></span>
                      )}
                    </div>
                    <div className="smart-cut-audition-actions" aria-label={t('候选片段试听')}>
                      <button
                        type="button"
                        className="smart-cut-audition"
                        aria-label={t('试听切前切后')}
                        title={t('试听切前/切后')}
                        onClick={() => previewCandidate(candidate)}
                      >
                        <Scissors size={13} />
                      </button>
                      <button
                        type="button"
                        className="smart-cut-audition"
                        aria-label={t('试听待删除片段')}
                        title={t('试听待删除片段')}
                        onClick={() => previewRemovedCandidate(candidate)}
                      >
                        <Volume2 size={13} />
                      </button>
                    </div>
                  </article>
                )) : <div className="smart-cut-empty-candidates"><Check size={18} /><p>{t('没有找到 AI 删除建议，你仍可在左侧手动选择文字。')}</p></div>}
              </div>
              <div className="smart-cut-review-footer">
                <label className="smart-cut-subtitle-toggle">
                  <input
                    type="checkbox"
                    checked={includeSubtitles}
                    disabled={stage === 'exporting'}
                    onChange={(event) => configureCut({ includeSubtitles: event.target.checked })}
                  />
                  <Captions size={15} /> {t('内嵌字幕')}
                </label>
                {stage === 'review' ? (
                  <button className="smart-cut-primary" type="button" onClick={() => void startPreview().catch((reason) => setError(localizeVideoEditorMessage(reason)))}>
                    <Scissors size={16} /> {t('生成剪辑预览')}
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={() => {
                      videoRef.current?.pause()
                      setStage('review')
                    }}>{t('返回校对')}</button>
                    <button className="smart-cut-primary" type="button" disabled={stage === 'exporting'} onClick={() => void exportVideo()}>
                      {stage === 'exporting' ? <LoaderCircle className="model-spin" size={16} /> : <Download size={16} />}
                      {t('导出 MP4')}
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="smart-cut-placeholder">
              <FileVideo size={24} />
              <h2>{t('等待内容分析')}</h2>
              <p>{t('识别完成后，这里会列出每个建议删除的片段和画面检查结果。')}</p>
            </div>
          )}
          {error && <div className="smart-cut-error">{error}</div>}
        </aside>
      </div>
    </main>
  )
}
