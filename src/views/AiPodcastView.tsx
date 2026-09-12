import { demoProjectSnapshot } from '../demo'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Play,
  Download,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Plus,
  Radio,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { AudioAssetPreview } from '../components/AudioAssetPreview'
import {
  chunkPodcastSource,
  parsePodcastScript,
  PODCAST_NOTES_SYSTEM_PROMPT,
  PODCAST_SCRIPT_SYSTEM_PROMPT,
  podcastScriptPrompt,
  type PodcastLength,
  type PodcastScript,
  type PodcastSpeaker,
} from '../domain/podcast'
import { planPodcastAudio, podcastAudioIsCurrent, resolvePodcastSegments, type PodcastSegmentCache } from '../domain/podcastAudio'
import { readPodcastSnapshot, type PodcastProjectSnapshot } from '../domain/podcastSnapshot'
import { readProjectSnapshot, restoreWorkspaceMedia } from '../services/workspaceStorage'
import { useProjectAutosave } from '../hooks/useProjectAutosave'
import { useWorkspaceController } from '../hooks/useWorkspaceController'
import { applyPodcastTurnCommand, podcastWorkspaceActions, PodcastCommandError, validatePodcastCommand, type PodcastCommandState, type ValidatedPodcastCommand } from '../domain/podcastCommands'
import { modelInputProfile } from '../domain/modelInputs'
import { cloudVoiceOptions } from '../domain/voices'
import { exportAudioFile } from '../services/fileExport'
import {
  composePodcastAudio,
  localizePodcastError,
  readSourceDocument,
  type PodcastAudioResult,
  type SourceDocument,
} from '../services/podcast'
import { formatFileSize, formatTime } from '../utils/audio'
import { t, useLocale } from '../i18n'
import type {
  HarnessCatalog,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
} from '../types'
import './SmartCutView.css'
import './AiPodcastView.css'

type PodcastStage =
  | 'empty'
  | 'extracting'
  | 'ready'
  | 'summarizing'
  | 'scripting'
  | 'review'
  | 'synthesizing'
  | 'complete'

interface AiPodcastViewProps {
  projectId?: string
  autoStart?: boolean
  panelMode?: boolean
  initialInstruction?: string
  initialSourcePath?: string
  initialLaunchId?: number
  models: ModelPlugin[]
  catalog: HarnessCatalog | null
  onGenerateText?: (prompt: string, systemPrompt: string) => Promise<string>
  onRunText: (
    text: string,
    capability: 'speech.synthesize' | 'text.generate' | 'text.punctuate' | 'text.normalize',
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<HarnessExecution<TtsGenerateResult | TextGenerateResult | Record<string, unknown>>>
  onOpenStore: () => void
  onAction: (message: string) => void
}

function modelReady(model: ModelPlugin, catalog: HarnessCatalog | null): boolean {
  const provider = catalog?.providers.find((item) => item.id === model.providerId)
  return model.installed && Boolean(model.providerId) && (!provider || provider.status === 'ready')
}

function isTextResult(value: unknown): value is TextGenerateResult {
  return Boolean(value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string')
}

function isTtsResult(value: unknown): value is TtsGenerateResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { filePath?: unknown }).filePath === 'string' &&
      typeof (value as { duration?: unknown }).duration === 'number',
  )
}

function stageMessage(stage: PodcastStage, completed: number, total: number): string {
  if (stage === 'extracting') return t('正在读取文档…')
  if (stage === 'summarizing') return t('正在整理长文档 {0}/{1}…', [completed, total])
  if (stage === 'scripting') return t('正在生成双人播客脚本…')
  if (stage === 'synthesizing') return completed === total && total > 0
    ? t('正在拼接播客音频…')
    : t('正在合成第 {0}/{1} 段台词…', [Math.min(completed + 1, total), total])
  return ''
}

function persistableOutput(output: PodcastAudioResult | null): PodcastProjectSnapshot['output'] {
  if (!output) return null
  const { dataUrl: _dataUrl, ...reference } = output
  return reference
}

export function AiPodcastView({
  projectId,
  autoStart = true,
  panelMode = false,
  initialInstruction,
  initialSourcePath,
  initialLaunchId,
  models,
  catalog,
  onRunText,
  onGenerateText,
  onOpenStore,
  onAction,
}: AiPodcastViewProps) {
  useLocale()
  const [restored] = useState(() => readPodcastSnapshot(readProjectSnapshot(projectId, 'podcast') ?? demoProjectSnapshot(projectId)))
  const [stage, setStage] = useState<PodcastStage>(() => restored?.script ? (restored.output ? 'complete' : 'review') : restored?.source ? 'ready' : 'empty')
  const [source, setSource] = useState<SourceDocument | null>(restored?.source ?? null)
  const [sourcePath, setSourcePath] = useState(restored?.sourcePath ?? '')
  const autoSynthesizeRef = useRef(false)
  const [instruction, setInstruction] = useState(restored?.instruction ?? initialInstruction ?? '')
  const [length, setLength] = useState<PodcastLength>(restored?.length ?? 'brief')
  const [language, setLanguage] = useState<'auto' | 'zh-CN' | 'en'>(restored?.language ?? 'auto')
  const [selectedLlmId, setSelectedLlmId] = useState(restored?.selectedLlmId ?? '')
  const [selectedTtsId, setSelectedTtsId] = useState(restored?.selectedTtsId ?? '')
  const [voiceA, setVoiceA] = useState(restored?.voiceA ?? '')
  const [voiceB, setVoiceB] = useState(restored?.voiceB ?? '')
  const [speakerAName, setSpeakerAName] = useState(restored?.speakerAName ?? t('主持人'))
  const [speakerBName, setSpeakerBName] = useState(restored?.speakerBName ?? t('嘉宾'))
  const [speed, setSpeed] = useState(restored?.speed ?? 1)
  const [script, setScript] = useState<PodcastScript | null>(restored?.script ?? null)
  const [output, setOutput] = useState<PodcastAudioResult | null>(() => restored?.output ? { ...restored.output, dataUrl: '' } : null)
  const [outputFingerprint, setOutputFingerprint] = useState<string | null>(restored?.outputFingerprint ?? null)
  const [segmentCache, setSegmentCache] = useState<PodcastSegmentCache>(restored?.segmentCache ?? {})
  const [dismissedInitialLaunch, setDismissedInitialLaunch] = useState(restored?.dismissedInitialLaunch ?? false)
  const [mediaReady, setMediaReady] = useState(!restored?.output && !Object.keys(restored?.segmentCache ?? {}).length)
  const [playbackTime, setPlaybackTime] = useState(0)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const operationRef = useRef(false)
  const turnElementRefs = useRef(new Map<string, HTMLElement>())
  const appliedInitialLaunchRef = useRef(0)
  const submittedInitialLaunchRef = useRef(0)
  const voiceModelRef = useRef(restored?.selectedTtsId ?? '')

  const snapshot = useMemo<PodcastProjectSnapshot>(() => ({
    version: 1, source, sourcePath, instruction, length, language, selectedLlmId, selectedTtsId,
    voiceA, voiceB, speakerAName, speakerBName, speed, script,
    output: persistableOutput(output),
    outputFingerprint, segmentCache, dismissedInitialLaunch,
  }), [source, sourcePath, instruction, length, language, selectedLlmId, selectedTtsId, voiceA, voiceB, speakerAName, speakerBName, speed, script, output, outputFingerprint, segmentCache, dismissedInitialLaunch])
  useProjectAutosave(projectId, 'podcast', snapshot)

  useEffect(() => {
    const paths = [...new Set([
      ...(restored?.output ? [restored.output.filePath] : []),
      ...Object.values(restored?.segmentCache ?? {}),
    ])]
    if (!paths.length) return
    let cancelled = false
    void restoreWorkspaceMedia(paths).then(({ available, missing }) => {
      if (cancelled) return
      const files = new Set(available)
      if (missing.length) {
        setSegmentCache((cache) => Object.fromEntries(Object.entries(cache).filter(([, path]) => files.has(path))))
        if (restored?.output && !files.has(restored.output.filePath)) {
          setOutput(null)
          setOutputFingerprint(null)
          setStage(restored.script ? 'review' : restored.source ? 'ready' : 'empty')
        }
        setError(t('部分音频文件已移动或删除，文稿已保留，可继续生成缺失片段'))
      }
      setMediaReady(true)
    }).catch((reason: unknown) => {
      if (cancelled) return
      setOutput(null)
      setOutputFingerprint(null)
      setSegmentCache({})
      setError(`${t('无法恢复音频文件，文稿已保留，请重新生成音频')}：${localizePodcastError(reason)}`)
      setMediaReady(true)
    })
    return () => { cancelled = true }
  }, [restored])

  const llmModels = useMemo(
    () => models.filter((model) => modelReady(model, catalog) && model.harnessCapabilities.includes('text.generate')),
    [catalog, models],
  )
  const ttsModels = useMemo(
    () =>
      models.filter((model) => {
        if (!modelReady(model, catalog) || !model.harnessCapabilities.includes('speech.synthesize')) return false
        const profile = modelInputProfile(model)
        return !profile.requiresTtsReferenceAudio && (profile.apiModel || profile.supportsSpeakerSelection)
      }),
    [catalog, models],
  )
  const selectedLlm = llmModels.find((model) => model.id === selectedLlmId)
  const selectedTts = ttsModels.find((model) => model.id === selectedTtsId)
  const ttsProfile = selectedTts ? modelInputProfile(selectedTts) : null
  const configuredTts = models.find((model) => model.id === selectedTtsId)
  const synthesisPlan = useMemo(() => {
    if (!script || !configuredTts?.providerId) return null
    const profile = modelInputProfile(configuredTts)
    return planPodcastAudio(script, {
      modelId: configuredTts.id, providerId: configuredTts.providerId, modelVersion: configuredTts.version,
      apiModel: profile.apiModel, supportsLanguage: profile.supportsTtsLanguage,
      voiceA, voiceB, speed,
    })
  }, [script, configuredTts, voiceA, voiceB, speed])
  const outputCurrent = podcastAudioIsCurrent(outputFingerprint, synthesisPlan)
  const pendingSegments = synthesisPlan?.segments.filter((segment) => !segmentCache[segment.key]).length ?? 0
  const presetVoices = selectedTts ? cloudVoiceOptions(selectedTts) : []
  const busy = exporting || !mediaReady || ['extracting', 'summarizing', 'scripting', 'synthesizing'].includes(stage)
  const activeTurnId = useMemo(() => {
    if (!output || !outputCurrent) return null
    return output.cues.find((cue, index) =>
      playbackTime >= cue.start &&
      (playbackTime < cue.end || (index === output.cues.length - 1 && playbackTime <= cue.end)),
    )?.turnId ?? null
  }, [output, outputCurrent, playbackTime])

  useEffect(() => {
    if (!activeTurnId) return
    turnElementRefs.current.get(activeTurnId)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [activeTurnId])

  useEffect(() => {
    if (selectedLlmId) return
    setSelectedLlmId(llmModels[0]?.id ?? '')
  }, [llmModels, selectedLlmId])

  useEffect(() => {
    if (selectedTtsId) return
    setSelectedTtsId(ttsModels[0]?.id ?? '')
  }, [selectedTtsId, ttsModels])

  useEffect(() => {
    if (!selectedTts || !ttsProfile || voiceModelRef.current === selectedTts.id) return
    voiceModelRef.current = selectedTts.id
    if (ttsProfile.apiModel) {
      const first = selectedTts.defaultVoice ?? presetVoices[0]?.id ?? ''
      const second = presetVoices.find((voice) => voice.id !== first)?.id ?? ''
      setVoiceA(first)
      setVoiceB(second)
    } else {
      setVoiceA('0')
      setVoiceB(ttsProfile.speakerCount > 1 ? '1' : '0')
    }
  }, [selectedTts?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDocument = useCallback(async (path: string, throwOnError = false) => {
    setStage('extracting')
    setError('')
    setScript(null)
    setOutput(null)
    setOutputFingerprint(null)
    setSegmentCache({})
    try {
      const document = await readSourceDocument(path)
      setSource(document)
      setSourcePath(path)
      setStage('ready')
      if (document.truncated) onAction(t('文档很长，已读取前 30 万个字符'))
      return document
    } catch (reason) {
      setSource(null)
      setSourcePath('')
      setStage('empty')
      setError(localizePodcastError(reason))
      if (throwOnError) throw new Error(localizePodcastError(reason))
      return null
    }
  }, [onAction])

  useEffect(() => {
    if (
      !autoStart || restored || dismissedInitialLaunch ||
      !initialLaunchId ||
      !initialSourcePath ||
      !initialInstruction?.trim() ||
      appliedInitialLaunchRef.current === initialLaunchId
    ) return
    appliedInitialLaunchRef.current = initialLaunchId
    submittedInitialLaunchRef.current = 0
    setInstruction(initialInstruction)
    setSource(null)
    setSourcePath('')
    setScript(null)
    setOutput(null)
    setProgress({ completed: 0, total: 0 })
    setError('')
    void loadDocument(initialSourcePath)
  }, [autoStart, restored, dismissedInitialLaunch, initialInstruction, initialLaunchId, initialSourcePath, loadDocument])

  const chooseDocument = async () => {
    const selection = await open({
      title: t('选择论文或文档'),
      multiple: false,
      directory: false,
      filters: [{ name: t('文档'), extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] }],
    })
    const path = typeof selection === 'string' ? selection : null
    if (!path) return
    const document = await loadDocument(path)
    if (document && onGenerateText) void generateScript(document)
  }

  const reset = () => {
    setDismissedInitialLaunch(true)
    setStage('empty')
    setSource(null)
    setSourcePath('')
    setInstruction('')
    setScript(null)
    setOutput(null)
    setOutputFingerprint(null)
    setSegmentCache({})
    setProgress({ completed: 0, total: 0 })
    setError('')
  }

  const generateScript = useCallback(async (document = source) => {
    const reject = (message: string) => { setError(message); return { ok: false, message } }
    if (busy || operationRef.current) return reject(t('播客正在处理，请稍后再试'))
    if (!document) {
      return reject(t('请先上传论文或文档'))
    }
    if (!onGenerateText && !selectedLlm?.providerId) {
      return reject(t('请先安装并配置一个文本生成模型'))
    }
    const generateText = async (prompt: string, systemPrompt: string, maxTokens: number) => {
      if (onGenerateText) return onGenerateText(prompt, systemPrompt)
      const execution = await onRunText(prompt, 'text.generate', selectedLlm!.providerId!, selectedLlm!.version,
        { systemPrompt, maxTokens }, [], false)
      if (!isTextResult(execution.output)) throw new Error(t('文本生成模型没有返回有效内容'))
      return execution.output.text
    }
    const { chunks, truncated } = chunkPodcastSource(document.text)
    if (!chunks.length) {
      return reject(t('文档中没有可用于生成播客的正文'))
    }
    operationRef.current = true
    setError('')
    try {
      let material = chunks[0]
      if (chunks.length > 1) {
        const notes: string[] = []
        setStage('summarizing')
        setProgress({ completed: 0, total: chunks.length })
        for (let index = 0; index < chunks.length; index += 1) {
          const text = await generateText(
            `${t('文档片段')} ${index + 1}/${chunks.length}\n<source>\n${chunks[index]}\n</source>`,
            PODCAST_NOTES_SYSTEM_PROMPT, 900)
          notes.push(`${t('片段')} ${index + 1}\n${text.trim()}`)
          setProgress({ completed: index + 1, total: chunks.length })
        }
        material = notes.join('\n\n')
      }
      setStage('scripting')
      const text = await generateText(podcastScriptPrompt(material, instruction, length, language),
        PODCAST_SCRIPT_SYSTEM_PROMPT, length === 'deep' ? 6200 : length === 'standard' ? 4000 : 2600)
      const next = parsePodcastScript(text)
      autoSynthesizeRef.current = Boolean(onGenerateText)
      setScript(next)
      setStage('review')
      setProgress({ completed: 0, total: 0 })
      if (truncated) onAction(t('来源超过长文档处理上限，脚本基于前 {0} 个片段生成', [chunks.length]))
      onAction(t('双人脚本已生成，请复核后再合成语音'))
      return { ok: true, message: t('双人脚本已生成，请复核后再合成语音') }
    } catch (reason) {
      setStage(script ? 'review' : 'ready')
      const message = reason instanceof Error ? reason.message : String(reason)
      return reject(message.includes('script needs two speakers') || message.includes('invalid')
        ? t('模型返回的脚本格式不完整，请重试或换一个文本生成模型')
        : localizePodcastError(reason))
    } finally {
      operationRef.current = false
    }
  }, [busy, instruction, language, length, onAction, onRunText, onGenerateText, script, selectedLlm, source])

  useEffect(() => {
    if (
      !autoStart || restored || dismissedInitialLaunch ||
      !initialLaunchId ||
      !initialSourcePath ||
      !initialInstruction?.trim() ||
      appliedInitialLaunchRef.current !== initialLaunchId ||
      submittedInitialLaunchRef.current === initialLaunchId ||
      stage !== 'ready' ||
      !source ||
      sourcePath !== initialSourcePath ||
      instruction.trim() !== initialInstruction.trim()
    ) return
    if (!onGenerateText && !selectedLlm) {
      if (!selectedLlmId && llmModels.length) return
      submittedInitialLaunchRef.current = initialLaunchId
      setError(t('请先安装并配置一个文本生成模型'))
      return
    }
    submittedInitialLaunchRef.current = initialLaunchId
    void generateScript()
  }, [
    autoStart,
    restored,
    dismissedInitialLaunch,
    initialInstruction,
    initialLaunchId,
    initialSourcePath,
    instruction,
    llmModels.length,
    selectedLlm,
    selectedLlmId,
    onGenerateText,
    source,
    sourcePath,
    stage,
    generateScript,
  ])

  const applyTurnEdit = (command: Extract<ValidatedPodcastCommand, { action: 'podcast.edit-turn' | 'podcast.add-turn' | 'podcast.remove-turn' }>) => {
    const newId = `podcast-turn-${crypto.randomUUID()}`
    setScript((current) => current ? applyPodcastTurnCommand(current, command, newId) : current)
  }

  const updateTurn = (index: number, text: string) => {
    const turnId = script?.turns[index]?.id
    if (turnId) applyTurnEdit({ action: 'podcast.edit-turn', args: { turnId, text } })
  }

  const updateSpeaker = (index: number, speaker: PodcastSpeaker) => {
    const turnId = script?.turns[index]?.id
    if (turnId) applyTurnEdit({ action: 'podcast.edit-turn', args: { turnId, speaker } })
  }

  const removeTurn = (index: number) => {
    const turnId = script?.turns[index]?.id
    if (turnId) applyTurnEdit({ action: 'podcast.remove-turn', args: { turnId } })
  }

  const addTurn = () => {
    if (script) applyTurnEdit({ action: 'podcast.add-turn', args: { speaker: script.turns.at(-1)?.speaker === 'A' ? 'B' : 'A', text: '' } })
  }

  const synthesize = async () => {
    const reject = (message: string) => { setError(message); return { ok: false, message } }
    if (busy || operationRef.current) return reject(t('播客正在处理，请稍后再试'))
    if (!script || !selectedTts?.providerId || !ttsProfile || !synthesisPlan) {
      return reject(t('请先选择可用的语音合成模型'))
    }
    const turns = script.turns.filter((turn) => turn.text.trim())
    if (turns.length < 2 || !turns.some((turn) => turn.speaker === 'A') || !turns.some((turn) => turn.speaker === 'B')) {
      return reject(t('脚本需要至少包含主持人和嘉宾各一段台词'))
    }
    const firstA = synthesisPlan.segments[turns.findIndex((turn) => turn.speaker === 'A')]
    const firstB = synthesisPlan.segments[turns.findIndex((turn) => turn.speaker === 'B')]
    if (firstA && firstB && JSON.stringify(firstA.parameters) === JSON.stringify(firstB.parameters)) {
      return reject(t('请为两位角色选择不同音色'))
    }
    if (output && outputCurrent) return { ok: true, message: t('音频已更新') }
    operationRef.current = true
    setStage('synthesizing')
    setPlaybackTime(0)
    setError('')
    setProgress({ completed: 0, total: turns.length })
    try {
      const audioSegments = await resolvePodcastSegments(
        synthesisPlan,
        segmentCache,
        async (segment) => {
          const execution = await onRunText(
            segment.text, 'speech.synthesize', selectedTts.providerId!, selectedTts.version,
            segment.parameters, [], false,
          )
          if (!isTtsResult(execution.output)) throw new Error(t('语音合成模型没有返回有效音频'))
          return execution.output.filePath
        },
        setSegmentCache,
        (completed, total) => setProgress({ completed, total }),
      )
      const mixed = await composePodcastAudio(audioSegments, script.title)
      setOutput(mixed)
      setOutputFingerprint(synthesisPlan.fingerprint)
      setStage('complete')
      onAction(t('播客音频已生成'))
      return { ok: true, message: t('播客音频已生成') }
    } catch (reason) {
      setStage('review')
      const message = reason instanceof Error ? reason.message : String(reason)
      if (message.startsWith('PODCAST_AUDIO_READ') || message.startsWith('PODCAST_AUDIO_INVALID')) {
        const failedIndex = Number(message.match(/^PODCAST_AUDIO_(?:READ|INVALID):(\d+):/u)?.[1]) - 1
        const failedSegment = synthesisPlan.segments[failedIndex]
        const invalidKeys = new Set(failedSegment ? [failedSegment.key] : synthesisPlan.segments.map((segment) => segment.key))
        setSegmentCache((cache) => Object.fromEntries(Object.entries(cache).filter(([key]) => !invalidKeys.has(key))))
        return reject(t('缓存音频文件不可用，请重新生成；文稿已保留'))
      } else {
        return reject(`${localizePodcastError(reason)} · ${t('已保留成功片段，重试会继续未完成部分')}`)
      }
    } finally {
      operationRef.current = false
    }
  }

  const exportPodcast = async () => {
    const reject = (message: string) => { setError(message); return { ok: false, message } }
    if (busy || operationRef.current) return reject(t('播客正在处理，请稍后再试'))
    if (!output) return reject(t('请先生成播客音频'))
    if (!podcastAudioIsCurrent(outputFingerprint, synthesisPlan)) {
      return reject(t('文稿或声音已修改，请先更新音频再导出'))
    }
    operationRef.current = true
    setExporting(true)
    try {
      const fileName = `${(script?.title ?? '').replace(/[\\/:*?"<>|]/gu, '_').trim() || t('AI 播客')}.wav`
      const destination = await exportAudioFile({ ...output, fileName })
      if (destination) onAction(t('播客已导出到 {0}', [destination]))
      return { ok: true, message: destination ? t('播客已导出到 {0}', [destination]) : t('已取消导出') }
    } catch (reason) {
      return reject(localizePodcastError(reason))
    } finally {
      operationRef.current = false
      setExporting(false)
    }
  }

  const commandState: PodcastCommandState = {
    script, selectedTtsId, llmIds: llmModels.map((model) => model.id),
    ttsModels: ttsModels.map((model) => {
      const profile = modelInputProfile(model)
      const voices = cloudVoiceOptions(model)
      const first = model.defaultVoice ?? voices[0]?.id ?? ''
      return {
        id: model.id, apiModel: profile.apiModel, speakerCount: profile.speakerCount,
        defaultVoiceA: profile.apiModel ? first : '0',
        defaultVoiceB: profile.apiModel ? voices.find((item) => item.id !== first)?.id ?? '' : profile.speakerCount > 1 ? '1' : '0',
      }
    }),
  }
  useEffect(() => {
    if (!autoSynthesizeRef.current || stage !== 'review' || busy) return
    autoSynthesizeRef.current = false
    void synthesize()
  })

  useWorkspaceController(projectId, {
    getState: () => ({
      mode: 'ai-podcast',
      presentation: {
        hasArtifact: Boolean(script), busy,
        message: busy ? stageMessage(stage, progress.completed, progress.total) : outputCurrent ? t('播客音频已生成，可在右侧试听。') : script ? (demoProjectSnapshot(projectId) ? t('示例播客脚本已就绪。') : t('播客脚本已生成，正在准备音频。')) : '',
        issue: error || (!source && !busy ? t('请在对话中添加播客来源文档。') : script && !selectedTts && !demoProjectSnapshot(projectId) ? t('缺少语音合成模型，请在对话中让我安装语音合成模型。') : ''),
      },
      revision: JSON.stringify({ sourcePath, instruction, length, language, selectedLlmId, selectedTtsId, voiceA, voiceB, speakerAName, speakerBName, speed, script }),
      busy: busy || operationRef.current,
      context: {
        source: source ? { fileName: source.fileName, characterCount: source.characterCount, excerpt: source.text.slice(0, 6000) } : null,
        instruction, length, language, selectedLlmId, selectedTtsId, voiceA, voiceB, speakerAName, speakerBName, speed, script,
        audio: { available: Boolean(output), current: outputCurrent, pendingSegments },
        llmModels: llmModels.map((model) => ({ id: model.id, name: model.name })),
        ttsModels: ttsModels.map((model) => ({
          ...commandState.ttsModels.find((item) => item.id === model.id), name: model.name,
          presetVoices: cloudVoiceOptions(model).map((item) => ({ id: item.id, name: item.name })),
          customVoiceIdsAllowed: modelInputProfile(model).apiModel,
        })),
      },
      actions: podcastWorkspaceActions(commandState),
    }),
    execute: async (command) => {
      if (busy || operationRef.current) throw new Error(t('播客正在处理，请稍后再试'))
      let validated: ValidatedPodcastCommand
      try {
        validated = validatePodcastCommand(command, commandState)
      } catch (reason) {
        if (!(reason instanceof PodcastCommandError)) throw reason
        if (reason.code === 'model') throw new Error(t('所选模型当前不可用，请从可用模型中选择'))
        if (reason.code === 'voice') throw new Error(t('音色 ID 超出当前模型的可用范围'))
        if (reason.code === 'script') throw new Error(t('请先生成播客脚本'))
        if (reason.code === 'turn') throw new Error(t('这段台词已变更或不存在，请重新读取文稿'))
        if (reason.code === 'limit') throw new Error(t('播客最多支持 80 段台词'))
        throw new Error(t('播客操作参数无效，请检查后重试'))
      }
      if (validated.action === 'podcast.configure') {
        const next = validated.args
        flushSync(() => {
          if (next.instruction !== undefined) setInstruction(next.instruction)
          if (next.length !== undefined) setLength(next.length)
          if (next.language !== undefined) setLanguage(next.language)
          if (next.selectedLlmId !== undefined) setSelectedLlmId(next.selectedLlmId)
          if (next.selectedTtsId !== undefined) {
            voiceModelRef.current = next.selectedTtsId
            setSelectedTtsId(next.selectedTtsId)
          }
          if (next.voiceA !== undefined) setVoiceA(next.voiceA)
          if (next.voiceB !== undefined) setVoiceB(next.voiceB)
          if (next.speakerAName !== undefined) setSpeakerAName(next.speakerAName)
          if (next.speakerBName !== undefined) setSpeakerBName(next.speakerBName)
          if (next.speed !== undefined) setSpeed(next.speed)
          if (next.title !== undefined || next.language !== undefined) setScript((current) => current ? {
            ...current,
            ...(next.title !== undefined ? { title: next.title } : {}),
            ...(next.language !== undefined ? { language: next.language } : {}),
          } : current)
          setError('')
        })
        return { message: t('播客设置已更新，可在右侧继续调整') }
      }
      if (validated.action === 'podcast.edit-turn' || validated.action === 'podcast.add-turn' || validated.action === 'podcast.remove-turn') {
        flushSync(() => { applyTurnEdit(validated); setError('') })
        return { message: t('播客文稿已更新，请复核后合成音频') }
      }
      const document = validated.action === 'podcast.generate-script' && !source && (sourcePath || initialSourcePath)
        ? await loadDocument(sourcePath || initialSourcePath!, true) : source
      const result = validated.action === 'podcast.generate-script'
        ? await generateScript(document)
        : validated.action === 'podcast.synthesize' ? await synthesize() : await exportPodcast()
      if (!result.ok) throw new Error(result.message)
      return { message: result.message }
    },
  })

  const renderVoiceField = (
    label: string,
    value: string,
    setValue: (value: string) => void,
  ) => (
    <label className="podcast-field podcast-voice-field">
      <span>{label}</span>
      <input
        type={ttsProfile?.apiModel ? 'text' : 'number'}
        min={ttsProfile?.apiModel ? undefined : 0}
        max={ttsProfile?.apiModel ? undefined : Math.max(0, (ttsProfile?.speakerCount ?? 1) - 1)}
        list={ttsProfile?.apiModel && presetVoices.length ? `podcast-${label}-voices` : undefined}
        value={value}
        maxLength={200}
        disabled={busy || !mediaReady}
        placeholder={ttsProfile?.apiModel ? t('输入音色 ID') : t('音色 ID')}
        onChange={(event) => setValue(event.target.value)}
      />
      {ttsProfile?.apiModel && presetVoices.length > 0 && (
        <datalist id={`podcast-${label}-voices`}>
          {presetVoices.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}
        </datalist>
      )}
    </label>
  )

  if (!script) {
    const agentLaunchBusy = Boolean(
      !error && !dismissedInitialLaunch &&
      initialLaunchId &&
      initialSourcePath &&
      initialInstruction?.trim() &&
      (busy || (autoStart && !restored && submittedInitialLaunchRef.current !== initialLaunchId)),
    )
    if (!dismissedInitialLaunch && initialLaunchId && initialSourcePath && initialInstruction?.trim()) {
      const taskFileName = source?.fileName ?? initialSourcePath.split(/[\\/]/u).at(-1) ?? t('未命名文件')
      const taskTitle = taskFileName.replace(/\.[^.]+$/u, '') || t('AI 播客')
      return (
        <main className={`ai-podcast-view project podcast-task-initializing${panelMode ? ' panel-mode' : ''}`}>
      <header className="podcast-project-header">
            <div>
              <span className="podcast-kicker">AI PODCAST</span>
              <h1 className="podcast-task-title">{taskTitle}</h1>
              <p>{taskFileName}</p>
            </div>
          </header>
          <section className="podcast-workspace">
            <aside className="podcast-settings-card podcast-task-submission">
              <div className="podcast-section-heading">
                <FileText size={16} />
                <div><strong>{t('已提交的任务')}</strong><small>{taskFileName}</small></div>
              </div>
              <p>{instruction}</p>
              {!onGenerateText && (<label className="podcast-field podcast-retry-model">
                <span>{t('文本生成模型')}</span>
                <select value={selectedLlmId} disabled={busy} onChange={(event) => setSelectedLlmId(event.target.value)}>
                  {selectedLlmId && !selectedLlm && <option value={selectedLlmId}>{t('已保存的模型暂不可用')}</option>}
                  {!selectedLlmId && !llmModels.length && <option value="">{t('无可用 LLM')}</option>}
                  {llmModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
                </select>
              </label>)}
              {error && <p className="podcast-error compact">{error}</p>}
              {!onGenerateText && !llmModels.length && (
                <button className="podcast-store-link full" type="button" onClick={onOpenStore}>
                  {t('前往模型商店安装或配置 LLM')}
                </button>
              )}
              {!agentLaunchBusy && (
                <button
                  className="podcast-primary-action"
                  type="button"
                  disabled={busy || (!onGenerateText && !selectedLlm)}
                  onClick={() => void (async () => {
                    // Mark this as submitted before loading, so the launch effect cannot submit twice.
                    submittedInitialLaunchRef.current = initialLaunchId
                    if (source) await generateScript()
                    else {
                      const document = await loadDocument(initialSourcePath)
                      if (document) await generateScript(document)
                    }
                  })()}
                >
                  <RotateCcw size={15} />{error ? t('重试生成脚本') : t('继续生成脚本')}
                </button>
              )}
              {!agentLaunchBusy && !source && <button className="podcast-store-link full" type="button" disabled={busy} onClick={() => void chooseDocument()}>{t('重新选择文档')}</button>}
            </aside>
            <section className="podcast-script-card">
              <div className="podcast-script-heading">
                <div><strong>{t('双人脚本')}</strong><small>{t('生成后可以继续修改台词、角色和顺序')}</small></div>
              </div>
              <div className="podcast-task-generating">
                {agentLaunchBusy && <LoaderCircle className="podcast-spin" size={22} />}
                <strong>{agentLaunchBusy ? t('正在生成双人脚本…') : error ? t('播客任务暂未开始') : t('任务已恢复，等待继续')}</strong>
                {agentLaunchBusy && (
                  <small>{stageMessage(stage, progress.completed, progress.total) || t('正在读取文档…')}</small>
                )}
                {!agentLaunchBusy && !error && <small>{t('确认模型后继续生成，已保存的文稿不会被自动覆盖')}</small>}
              </div>
            </section>
          </section>
        </main>
      )
    }
    return (
      <main className={`smart-cut-view ai-podcast-view empty${panelMode ? ' panel-mode' : ''}`}>
        <section className="smart-cut-hero podcast-hero">
          <div className="smart-cut-hero-icon podcast-hero-icon"><Radio size={27} strokeWidth={1.55} /></div>
          <span className="smart-cut-kicker podcast-kicker">AI PODCAST</span>
          <h1>{t('AI 播客')}</h1>
          <p>{t('上传论文或文档，先生成可以复核的主持人与嘉宾对话，再用两种音色合成为完整音频。')}</p>
        </section>
        <section className="editor-setup">
          {source && (
            <div className="smart-cut-video-attachment podcast-document-chip">
              <FileText size={18} />
              <span>
                <strong>{source.fileName}</strong>
                <small>{t('{0} 个字符', [source.characterCount.toLocaleString()])}</small>
              </span>
              <button type="button" aria-label={t('移除文档')} onClick={() => { setSource(null); setSourcePath(''); setStage('empty') }}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className="editor-setup-fields">
            <button className="smart-cut-attach-button podcast-attach" type="button" disabled={busy} onClick={() => void chooseDocument()}>
              <Paperclip size={15} /> <span>{source ? t('替换文档') : t('上传文档')}</span>
            </button>
            {!onGenerateText && (<label className="smart-cut-planner-model">
              <span>{t('文本生成模型')}</span>
              <select value={selectedLlmId} disabled={busy} onChange={(event) => setSelectedLlmId(event.target.value)}>
                {selectedLlmId && !selectedLlm && <option value={selectedLlmId}>{t('已保存的模型暂不可用')}</option>}
                {!llmModels.length && <option value="">{t('无可用 LLM')}</option>}
                {llmModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
            </label>)}
            {!onGenerateText && (<label>
              <span>{t('时长')}</span>
              <select value={length} disabled={busy} onChange={(event) => setLength(event.target.value as PodcastLength)}>
                <option value="brief">{t('约 3 分钟')}</option>
                <option value="standard">{t('约 6 分钟')}</option>
                <option value="deep">{t('约 10 分钟')}</option>
              </select>
            </label>)}
            {!onGenerateText && (<label>
              <span>{t('语言')}</span>
              <select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as 'auto' | 'zh-CN' | 'en')}>
                <option value="auto">{t('自动语言')}</option>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </label>)}
            <button
              className="editor-setup-action"
              type="button"
              disabled={busy || !source || (!onGenerateText && !selectedLlm)}
              aria-label={t('生成播客脚本')}
              onClick={() => void generateScript()}
            >
              {busy ? <LoaderCircle className="podcast-spin" size={16} /> : <Play size={17} />}
              {t('生成播客脚本')}
            </button>
          </div>
        </section>

        <section className="smart-cut-entry-status podcast-entry-status">
          {busy && <p className="podcast-status">{stageMessage(stage, progress.completed, progress.total)}</p>}
          {!onGenerateText && !llmModels.length && (
            <button className="podcast-store-link" type="button" onClick={onOpenStore}>{t('前往模型商店安装或配置 LLM')}</button>
          )}
          {error && <p className="podcast-error">{error}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className={`ai-podcast-view project${demoProjectSnapshot(projectId) ? ' demo-results' : ''}${output ? ' has-output' : ''}${panelMode ? ' panel-mode' : ''}`}>
          {Boolean(demoProjectSnapshot(projectId)) && <div className="demo-artifact-audio">
        <strong>音频预览 · 示例波形</strong>
        <div aria-label="示例音频波形">{Array.from({ length: 48 }, (_, index) => <i key={index} style={{ height: 8 + ((index * 17) % 32) }} />)}</div>
        <small>仅展示生成结果布局，不包含可播放音频</small>
      </div>}
      <header className="podcast-project-header">
        <div>
          <span className="podcast-kicker">AI PODCAST</span>
          <input
            className="podcast-title-input"
            value={script.title}
            maxLength={100}
            disabled={busy}
            aria-label={t('播客标题')}
            onChange={(event) => setScript({ ...script, title: event.target.value })}
          />
          <p>{source?.fileName} · {t('{0} 段对话', [script.turns.length])}</p>
        </div>
        <button className="podcast-reset" type="button" disabled={busy} onClick={reset}><RotateCcw size={14} />{t('新建播客')}</button>
      </header>

      <section className="podcast-workspace">
        <aside className="podcast-settings-card">
          <div className="podcast-section-heading">
            <MessageSquareText size={16} />
            <div><strong>{t('角色与声音')}</strong><small>{t('两位角色使用同一模型的不同音色')}</small></div>
          </div>
          <label className="podcast-field">
            <span>{t('语音合成模型')}</span>
            <select value={selectedTtsId} disabled={busy} onChange={(event) => setSelectedTtsId(event.target.value)}>
              {selectedTtsId && !selectedTts && <option value={selectedTtsId}>{t('已保存的模型暂不可用')}</option>}
              {!ttsModels.length && <option value="">{t('无可用双音色 TTS')}</option>}
              {ttsModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
            </select>
          </label>
          <div className="podcast-speaker-setting">
            <label className="podcast-field"><span>{t('角色 A')}</span><input value={speakerAName} maxLength={80} disabled={busy} onChange={(event) => setSpeakerAName(event.target.value)} /></label>
            {renderVoiceField(t('声音 A'), voiceA, setVoiceA)}
          </div>
          <div className="podcast-speaker-setting">
            <label className="podcast-field"><span>{t('角色 B')}</span><input value={speakerBName} maxLength={80} disabled={busy} onChange={(event) => setSpeakerBName(event.target.value)} /></label>
            {renderVoiceField(t('声音 B'), voiceB, setVoiceB)}
          </div>
          <label className="podcast-field">
            <span>{t('语速')} · {speed.toFixed(2)}×</span>
            <input type="range" min="0.75" max="1.35" step="0.05" value={speed} disabled={busy} onChange={(event) => setSpeed(Number(event.target.value))} />
          </label>
          {!ttsModels.length && <button className="podcast-store-link full" type="button" onClick={onOpenStore}>{t('前往模型商店安装或配置 TTS')}</button>}
          {output && !outputCurrent && (
            <div className="podcast-update-notice" role="status">
              <strong>{t('音频待更新')}</strong>
              <span>{t('文稿或声音已修改，下方为上一版音频。更新后即可导出。')}</span>
            </div>
          )}
          {!mediaReady && <p className="podcast-status" role="status">{t('正在恢复音频文件…')}</p>}
          {mediaReady && synthesisPlan && !busy && !outputCurrent && (
            <p className="podcast-cache-summary">{t('本次生成 {0} 段，复用 {1} 段', [pendingSegments, synthesisPlan.segments.length - pendingSegments])}</p>
          )}
          <button className="podcast-primary-action" type="button" disabled={busy || !selectedTts || Boolean(output && outputCurrent)} onClick={() => void synthesize()}>
            {stage === 'synthesizing' ? <LoaderCircle className="podcast-spin" size={16} /> : <Radio size={16} />}
            {stage === 'synthesizing' ? stageMessage(stage, progress.completed, progress.total) : outputCurrent && output ? t('音频已更新') : output ? t('更新播客音频') : Object.keys(segmentCache).length ? t('继续生成音频') : t('生成播客音频')}
          </button>
          <details className="podcast-script-options">
            <summary>{t('脚本生成设置')}</summary>
            {!onGenerateText && (<label className="podcast-field">
              <span>{t('文本生成模型')}</span>
              <select value={selectedLlmId} disabled={busy} onChange={(event) => setSelectedLlmId(event.target.value)}>
                {selectedLlmId && !selectedLlm && <option value={selectedLlmId}>{t('已保存的模型暂不可用')}</option>}
                {!llmModels.length && <option value="">{t('无可用 LLM')}</option>}
                {llmModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
            </label>)}
            <div className="podcast-speaker-setting">
              <label className="podcast-field">
                <span>{t('目标长度')}</span>
                <select value={length} disabled={busy} onChange={(event) => setLength(event.target.value as PodcastLength)}>
                  <option value="brief">{t('约 3 分钟')}</option>
                  <option value="standard">{t('约 6 分钟')}</option>
                  <option value="deep">{t('约 10 分钟')}</option>
                </select>
              </label>
              <label className="podcast-field">
                <span>{t('输出语言')}</span>
                <select value={language} disabled={busy} onChange={(event) => {
                  const next = event.target.value as 'auto' | 'zh-CN' | 'en'
                  setLanguage(next)
                  setScript((current) => current ? { ...current, language: next } : current)
                }}>
                  <option value="auto">{t('自动语言')}</option>
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <button className="podcast-reset" type="button" disabled={busy || !source || (!onGenerateText && !selectedLlm)} onClick={() => void generateScript()}>
              <RotateCcw size={14} />{t('重新生成并替换脚本')}
            </button>
          </details>
          {error && <p className="podcast-error compact">{error}</p>}
        </aside>

        <section className="podcast-script-card">
          <div className="podcast-script-heading">
            <div><strong>{t('双人脚本')}</strong><small>{t('合成前可以修改台词、角色和顺序')}</small></div>
            <button type="button" disabled={busy || script.turns.length >= 80} onClick={addTurn}><Plus size={14} />{t('添加一段')}</button>
          </div>
          <div className="podcast-turn-list">
            {script.turns.map((turn, index) => (
              <article
                className={`podcast-turn speaker-${turn.speaker.toLowerCase()}${activeTurnId === turn.id ? ' playing' : ''}`}
                key={turn.id}
                ref={(element) => {
                  if (element) turnElementRefs.current.set(turn.id, element)
                  else turnElementRefs.current.delete(turn.id)
                }}
                aria-current={activeTurnId === turn.id ? 'true' : undefined}
              >
                <header className="podcast-turn-header">
                  <div className="podcast-speaker-identity">
                    <span className="podcast-speaker-mark">{turn.speaker}</span>
                    <select value={turn.speaker} disabled={busy} aria-label={t('说话人')} onChange={(event) => updateSpeaker(index, event.target.value as PodcastSpeaker)}>
                      <option value="A">{speakerAName || t('主持人')}</option>
                      <option value="B">{speakerBName || t('嘉宾')}</option>
                    </select>
                  </div>
                  {turn.text.trim() && synthesisPlan && (
                    <span className={`podcast-turn-status${segmentCache[synthesisPlan.segments.find((segment) => segment.turnId === turn.id)?.key ?? ''] ? ' ready' : ''}`}>
                      {segmentCache[synthesisPlan.segments.find((segment) => segment.turnId === turn.id)?.key ?? ''] ? t('已生成') : t('待生成')}
                    </span>
                  )}
                  <span className="podcast-turn-number">#{String(index + 1).padStart(2, '0')}</span>
                  <button type="button" disabled={busy} aria-label={t('删除这段台词')} onClick={() => removeTurn(index)}><Trash2 size={13} /></button>
                </header>
                <textarea
                  value={turn.text}
                  aria-label={t('第 {0} 段台词', [index + 1])}
                  maxLength={900}
                  rows={Math.min(6, Math.max(2, Math.ceil(turn.text.length / 52)))}
                  disabled={busy}
                  onChange={(event) => updateTurn(index, event.target.value)}
                />
              </article>
            ))}
          </div>
        </section>
      </section>

      {output && mediaReady && (
        <section className={`podcast-player-bar${outputCurrent ? '' : ' stale'}`} aria-label={outputCurrent ? t('播客音频') : t('上一版音频')}>
          <div className="podcast-player-summary">
            <span><Radio size={18} /></span>
            <div>
              <strong>{outputCurrent ? t('播客音频') : t('上一版音频')}</strong>
              <small>{script.title}</small>
            </div>
          </div>
          <AudioAssetPreview
            src={convertFileSrc(output.filePath)}
            peaks={output.waveform}
            duration={output.duration}
            sampleRate={output.sampleRate}
            role="output"
            size="compact"
            waveformHeight={54}
            onTimeChange={setPlaybackTime}
          />
          <div className="podcast-player-actions">
            <div className="podcast-output-meta">
              <span>{formatTime(output.duration, true)}</span>
              <span>{output.sampleRate / 1000} kHz</span>
              <span>{formatFileSize(output.sizeBytes)}</span>
            </div>
            <button className="podcast-export" type="button" disabled={busy || !outputCurrent} title={outputCurrent ? undefined : t('文稿或声音已修改，请先更新音频再导出')} onClick={() => void exportPodcast()}><Download size={14} />{outputCurrent ? t('导出 WAV') : t('更新后导出')}</button>
          </div>
        </section>
      )}
    </main>
  )
}
