import { convertFileSrc } from '@tauri-apps/api/core'
import { Captions, Check, Circle, FolderOpen, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { isTauriRuntime, revealInFileManager } from '../services/harness'
import {
  cancelVideoDubbing,
  startVideoDubbing,
  subscribeVideoDubbing,
  type VideoDubbingProgress,
  type VideoDubbingTurn,
} from '../services/videoDubbing'
import type { VideoDubbingLanguages, VideoDubbingMode, VideoDubbingStyle } from '../domain/agents'
import { t, useLocale } from '../i18n'
import { isDemoMode, demoVideoDubbingTurns } from '../demo'
import { readVideoDubbingSnapshot } from '../domain/editorSnapshots'
import { readProjectSnapshot, restoreWorkspaceMedia } from '../services/workspaceStorage'
import { useProjectAutosave } from '../hooks/useProjectAutosave'
import { useWorkspaceController } from '../hooks/useWorkspaceController'
import {
  configureVideoDubbing, reusableVideoDubbingDirectory, videoDubbingFingerprint,
  VIDEO_DUBBING_LANGUAGES, type VideoDubbingSettings,
} from '../domain/videoDubbingWorkspace'
import './VideoDubbingView.css'

interface VideoDubbingViewProps {
  projectId?: string
  autoStart?: boolean
  panelMode?: boolean
  initialInstruction: string
  initialSourcePath: string
  initialLaunchId: number
  dubbingMode: VideoDubbingMode
  dubbingLanguages?: VideoDubbingLanguages
  dubbingStyle?: VideoDubbingStyle
  onAction: (message: string) => void
}

const stages = [
  ['separating', '检测与准备音轨'],
  ['diarizing', '区分说话人'],
  ['transcribing', '识别原始对白'],
  ['translating', '准备配音文案'],
  ['aligning', '对齐原始讲话节奏'],
  ['voices', '准备说话人音色'],
  ['dubbing', '生成视频配音'],
  ['mixing', '混合音轨'],
  ['subtitles', '生成配音字幕'],
  ['rendering', '渲染最终视频'],
] as const

const stageOrder = new Map<string, number>(stages.map(([stage], index) => [stage, index]))
const languageLabels: Record<string, string> = { zh: '中文', en: '英文', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语' }

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path
}

function timestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, seconds - minutes * 60)
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`
}

export function VideoDubbingView({
  projectId,
  autoStart = true,
  panelMode = false,
  initialInstruction,
  initialSourcePath,
  initialLaunchId,
  dubbingMode,
  dubbingLanguages,
  dubbingStyle,
  onAction,
}: VideoDubbingViewProps) {
  useLocale()
  const [restored] = useState(() => readVideoDubbingSnapshot(readProjectSnapshot(projectId, 'video-dubbing')))
  const [settings, setSettings] = useState<VideoDubbingSettings>(() => restored?.settings ?? {
    instruction: initialInstruction, mode: dubbingMode,
    sourceLanguage: dubbingLanguages?.source ?? 'auto', targetLanguage: dubbingLanguages?.target ?? 'zh',
    style: dubbingStyle ?? 'natural',
  })
  const currentFingerprint = videoDubbingFingerprint(initialSourcePath, settings)
  const initialFingerprintRef = useRef(currentFingerprint)
  const [runFingerprint, setRunFingerprint] = useState(() => restored?.runFingerprint ?? (restored?.outputDir ? currentFingerprint : ''))
  const [taskId, setTaskId] = useState(restored?.taskId ?? '')
  const [progress, setProgress] = useState<VideoDubbingProgress | null>(restored?.progress ?? null)
  const [starting, setStarting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [turns, setTurns] = useState<VideoDubbingTurn[]>(restored?.turns ?? [])
  const [audioAnalysis, setAudioAnalysis] = useState<VideoDubbingProgress['audioAnalysis']>(restored?.audioAnalysis)
  const [mediaError, setMediaError] = useState('')
  const [previewReady, setPreviewReady] = useState(!restored?.progress?.outputVideoPath)
  const appliedLaunchRef = useRef(0)
  const activeTaskRef = useRef('')
  const busyRef = useRef(false)
  const cancelingRef = useRef(false)
  const progressBridgeRef = useRef<Promise<void> | null>(null)
  const pendingUpdatesRef = useRef(new Map<string, VideoDubbingProgress>())
  const outputDirRef = useRef(restored?.outputDir ?? '')
  const outputDir = progress?.outputDir || outputDirRef.current
  useProjectAutosave(projectId, 'video-dubbing', useMemo(() => ({
    version: 1, taskId, outputDir, progress, starting, turns, audioAnalysis, settings, runFingerprint,
  }), [taskId, outputDir, progress, starting, turns, audioAnalysis, settings, runFingerprint]))

  const applyProgress = useCallback((update: VideoDubbingProgress) => {
    setProgress(current => ({ ...current, ...update }))
    if (update.outputDir) outputDirRef.current = update.outputDir
    if (update.turns) setTurns(update.turns)
    if (update.audioAnalysis) setAudioAnalysis(update.audioAnalysis)
    if (update.status !== 'running') {
      busyRef.current = false
      cancelingRef.current = false
      setCanceling(false)
    }
  }, [])

  useEffect(() => {
    const outputVideoPath = restored?.progress?.outputVideoPath
    if (!outputVideoPath) return
    let disposed = false
    void restoreWorkspaceMedia([outputVideoPath]).then(({ missing }) => {
      if (disposed) return
      if (missing.length) setMediaError(t('生成的视频已移动或删除，配音稿仍已保留：{0}', [missing[0]]))
      else setPreviewReady(true)
    }).catch((error) => {
      if (!disposed) setMediaError(error instanceof Error ? error.message : String(error))
    })
    return () => { disposed = true }
  }, [restored])

  const run = useCallback(async () => {
    if (busyRef.current) throw new Error(t('视频配音正在处理，请等待完成或先取消。'))
    if (!initialSourcePath) throw new Error(t('请先选择视频文件。'))
    if (!settings.instruction.trim()) throw new Error(t('请先填写配音要求或完整文案。'))
    if (!isTauriRuntime()) throw new Error(t('请在桌面应用中运行视频配音。'))
    busyRef.current = true
    activeTaskRef.current = ''
    pendingUpdatesRef.current.clear()
    setStarting(true)
    setCanceling(false)
    setMediaError('')
    setPreviewReady(true)
    const reuseDirectory = reusableVideoDubbingDirectory(
      outputDirRef.current, runFingerprint, currentFingerprint, progress?.status,
    )
    if (!reuseDirectory) {
      outputDirRef.current = ''
      setTurns([])
      setAudioAnalysis(undefined)
    }
    setTaskId('')
    setRunFingerprint(currentFingerprint)
    setProgress({
      taskId: '', status: 'running', stage: 'preparing', progress: 1,
      message: t('正在启动视频配音'), outputDir: reuseDirectory,
    })
    try {
      // Subscribe before spawning so fast native failures are not missed.
      if (!progressBridgeRef.current) throw new Error(t('视频配音进度连接尚未就绪，请重试。'))
      await progressBridgeRef.current
      const result = await startVideoDubbing(
        initialSourcePath,
        settings.instruction.trim(), settings.mode, reuseDirectory,
        { source: settings.sourceLanguage, target: settings.targetLanguage }, settings.style,
      )
      activeTaskRef.current = result.taskId
      outputDirRef.current = result.outputDir
      setTaskId(result.taskId)
      setProgress(current => current ? { ...current, taskId: result.taskId, outputDir: result.outputDir } : current)
      const pending = pendingUpdatesRef.current.get(result.taskId)
      pendingUpdatesRef.current.clear()
      if (pending) applyProgress(pending)
      if (pending?.status === 'failed') throw new Error(pending.error || pending.message)
      return { message: t('视频配音任务已启动，可在右侧查看进度。') }
    } catch (error) {
      busyRef.current = false
      activeTaskRef.current = ''
      setProgress({
        taskId: '', status: 'failed', stage: 'failed', progress: 100,
        message: t('视频配音启动失败'), error: error instanceof Error ? error.message : String(error),
        outputDir: outputDirRef.current || undefined,
      })
      throw error
    } finally {
      setStarting(false)
    }
  }, [settings, initialSourcePath, runFingerprint, currentFingerprint, progress?.status, applyProgress])

  useEffect(() => {
    if (isDemoMode()) {
      if (restored) return
      setTurns(demoVideoDubbingTurns)
      setRunFingerprint(initialFingerprintRef.current)
      setProgress({
        taskId: 'demo-task', status: 'completed', stage: 'subtitles', progress: 100,
        message: t('配音完成'),
      })
      return
    }
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const ready = subscribeVideoDubbing((update) => {
      if (update.taskId === activeTaskRef.current) {
        applyProgress(update)
      } else if (busyRef.current && !activeTaskRef.current) {
        pendingUpdatesRef.current.set(update.taskId, {
          ...pendingUpdatesRef.current.get(update.taskId), ...update,
        })
      }
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    progressBridgeRef.current = ready
    void ready.catch((error) => {
      if (!disposed) setMediaError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [restored, applyProgress])

  useEffect(() => {
    if (!autoStart || restored || !initialLaunchId || appliedLaunchRef.current === initialLaunchId) return
    appliedLaunchRef.current = initialLaunchId
    if (isDemoMode()) return
    void run().catch(error => onAction(error instanceof Error ? error.message : String(error)))
  }, [autoStart, initialLaunchId, restored, run, onAction])

  const cancel = async () => {
    if (!busyRef.current || !activeTaskRef.current) throw new Error(t('当前没有可取消的配音任务。'))
    if (cancelingRef.current) throw new Error(t('已请求取消，请等待当前配音停止。'))
    cancelingRef.current = true
    setCanceling(true)
    try {
      await cancelVideoDubbing(activeTaskRef.current)
      setProgress((current) => current ? { ...current, message: t('正在取消视频配音') } : current)
      return { message: t('已请求取消视频配音，正在等待任务停止。') }
    } catch (error) {
      cancelingRef.current = false
      setCanceling(false)
      throw error
    }
  }

  const configure = (args: Record<string, unknown>) => {
    if (busyRef.current) throw new Error(t('视频配音正在处理，请等待完成或先取消。'))
    const next = configureVideoDubbing(settings, args)
    flushSync(() => setSettings(next))
    return { message: t('配音设置已更新，生成后即可查看新结果。') }
  }

  const showError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setMediaError(message)
    onAction(message)
  }

  const currentStage = stageOrder.get(progress?.stage ?? '') ?? -1
  const completed = progress?.status === 'completed'
  const failed = progress?.status === 'failed' || progress?.status === 'canceled'
  const idle = !progress && !starting
  const interrupted = progress?.stage === 'interrupted'
  const busy = starting || progress?.status === 'running'
  const stale = Boolean(runFingerprint && runFingerprint !== currentFingerprint)

  useWorkspaceController(projectId, {
    getState: () => ({
      mode: 'video-dubbing', busy: busyRef.current,
      revision: JSON.stringify([settings, runFingerprint, progress?.status, turns, progress?.outputVideoPath, mediaError]),
      context: {
        sourcePath: initialSourcePath, settings, progress, turns, audioAnalysis,
        outputs: {
          stale, outputDir, videoPath: progress?.outputVideoPath ?? null,
          subtitlePath: progress?.subtitlePath ?? null, reportPath: progress?.reportPath ?? null,
        },
        transcriptEditing: 'Read-only generated transcript. To change the script, configure instruction and mode, then start a new rendering.',
        error: mediaError || progress?.error || null,
      },
      actions: [
        {
          name: 'dubbing.configure', description: '修改视频配音要求、模式、语言和风格；更新右侧相同设置。生成期间不可修改。参数变化后旧结果过期，需再调用 dubbing.start。mode=script 时 instruction 必须是完整配音文案。rewrite/script 沿用原始语言，targetLanguage 仅适用于 translate。',
          quickCommands: [{ text: '配音风格设为轻松', args: { style: 'casual' } }, { text: 'Set dubbing style to casual', args: { style: 'casual' } }],
          parameters: { type: 'object', properties: {
            instruction: { type: 'string', maxLength: 50000 },
            mode: { type: 'string', enum: ['translate', 'rewrite', 'script'] },
            sourceLanguage: { type: 'string', enum: ['auto', ...VIDEO_DUBBING_LANGUAGES] },
            targetLanguage: { type: 'string', enum: VIDEO_DUBBING_LANGUAGES },
            style: { type: 'string', enum: ['natural', 'formal', 'casual'] },
          }, additionalProperties: false, minProperties: 1 },
        },
        {
          name: 'dubbing.start', description: '使用当前右侧设置启动视频配音；已完成任务会重新生成，变更设置后使用新缓存目录。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          quickCommands: [{ text: '开始配音', args: {} }, { text: '开始视频配音', args: {} }, { text: '重新生成配音', args: {} }, { text: 'Start dubbing', args: {} }, { text: 'Regenerate dubbing', args: {} }],
        },
        {
          name: 'dubbing.retry', description: '重试失败或取消的配音；仅参数相同才复用已完成步骤。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          quickCommands: [{ text: '重试配音', args: {} }],
        },
        {
          name: 'dubbing.cancel', description: '请求停止正在运行的视频配音；等待任务停止后才能再次修改或生成。',
          parameters: { type: 'object', properties: {}, additionalProperties: false }, allowedWhileBusy: true,
          quickCommands: [{ text: '取消配音', args: {} }, { text: '取消视频配音', args: {} }],
        },
      ],
    }),
    execute: async command => {
      if (command.action === 'dubbing.configure') return configure(command.args)
      if (Object.keys(command.args).length) throw new Error(t('此配音操作不接受额外参数。'))
      if (command.action === 'dubbing.start') return run()
      if (command.action === 'dubbing.retry') {
        if (!failed) throw new Error(t('当前配音无需重试，请使用开始配音。'))
        return run()
      }
      if (command.action === 'dubbing.cancel') return cancel()
      throw new Error(t('不支持的配音操作。'))
    },
  })

  return (
    <main className={`video-translation-view${panelMode ? ' video-translation-view--panel' : ''}`}>
      <header className="video-translation-header">
        <div>
          {!panelMode && <span>{t('视频配音')}</span>}
          <h1>{panelMode ? t('配音工作区') : t('生成视频配音')}</h1>
        </div>
        {progress?.status === 'running' && taskId && (
          <button type="button" disabled={canceling} onClick={() => void cancel().catch(showError)}><Square size={13} />{canceling ? t('正在取消…') : t('取消')}</button>
        )}
      </header>

      <section className="video-translation-settings" aria-label={t('配音设置')}>
        <div className="video-translation-source-file" title={initialSourcePath}><strong>{fileName(initialSourcePath)}</strong><small>{t('原始视频')}</small></div>
        <fieldset disabled={busy}>
          <div className="video-translation-settings-grid">
            <label>{t('配音方式')}<select value={settings.mode} onChange={event => configure({ mode: event.target.value })}>
              <option value="translate">{t('翻译原声')}</option>
              <option value="rewrite">{t('修改原稿')}</option>
              <option value="script">{t('使用新文案')}</option>
            </select></label>
            <label>{t('配音风格')}<select value={settings.style} onChange={event => configure({ style: event.target.value })}>
              <option value="natural">{t('自然')}</option><option value="formal">{t('正式')}</option><option value="casual">{t('轻松')}</option>
            </select></label>
            <label>{t('原始语言')}<select value={settings.sourceLanguage} onChange={event => configure({ sourceLanguage: event.target.value })}>
              <option value="auto">{t('自动识别')}</option>
              {VIDEO_DUBBING_LANGUAGES.map(language => <option key={language} value={language}>{t(languageLabels[language])}</option>)}
            </select></label>
            <label>{t('目标语言')}<select value={settings.targetLanguage} disabled={settings.mode !== 'translate'} onChange={event => configure({ targetLanguage: event.target.value })}>
              {VIDEO_DUBBING_LANGUAGES.map(language => <option key={language} value={language}>{t(languageLabels[language])}</option>)}
            </select></label>
          </div>
          <label className="video-translation-instruction">{settings.mode === 'script' ? t('完整配音文案') : t('配音要求')}
            <textarea value={settings.instruction} maxLength={50000} rows={3} onChange={event => configure({ instruction: event.target.value })} />
          </label>
        </fieldset>
        <p>{busy ? t('正在按当前设置生成，取消后可继续修改。') : settings.mode !== 'translate' ? t('修改原稿和新文案模式沿用原始语言。') : t('可直接修改设置，也可以在左侧对话中提出要求。')}</p>
      </section>

      <section className="video-translation-card">
        <div className="video-translation-summary">
          <div>
            {progress?.status === 'running' && <LoaderCircle className="video-translation-spin" size={18} />}
            {completed && !stale && <Check size={18} />}
            {failed && <Circle size={18} />}
            <strong>{stale ? t('配音设置已修改') : completed ? t('视频配音已完成') : failed ? t('视频配音未完成') : idle ? t('视频配音待开始') : t('正在生成视频配音')}</strong>
          </div>
          {!stale && <span>{Math.round(progress?.progress ?? 0)}%</span>}
        </div>
        {!stale && <div className="video-translation-progress"><i style={{ width: `${progress?.progress ?? 0}%` }} /></div>}
        {!stale && <p className={failed ? 'error' : ''}>{interrupted
          ? t('上次配音已中断，已保留完成的步骤和配音稿。点击重试继续处理。')
          : progress?.error || progress?.message || (idle ? t('点击开始生成视频配音。') : t('正在启动视频配音'))}</p>}
        {mediaError && <p className="error" role="alert">{mediaError}</p>}
        {stale && <p className="video-translation-stale" role="status">{t('设置已修改，请重新生成配音。旧视频和配音稿仅供参考。')}</p>}
        {audioAnalysis && (
          <p className="video-translation-audio-decision">
            {audioAnalysis.decision === 'separate_and_mix'
              ? t('检测到音乐背景，已启用人声分离')
              : t('未检测到明显音乐背景，已跳过人声分离')}
            <span>{t('音乐置信度 {0}%', [Math.round(audioAnalysis.musicScore * 100)])}</span>
          </p>
        )}

        {!failed && (
          <ol className="video-translation-stages">
            {stages.map(([stage, label], index) => {
              const done = completed || index < currentStage
              const active = stage === progress?.stage || (progress?.stage === 'preparing' && index === 0)
              return (
                <li key={stage} className={done ? 'done' : active ? 'active' : ''}>
                  {done ? <Check size={12} /> : active ? <LoaderCircle className="video-translation-spin" size={12} /> : <Circle size={10} />}
                  <span>{t(label)}</span>
                </li>
              )
            })}
          </ol>
        )}

        {!busy && <button className="video-translation-retry" type="button" disabled={!initialSourcePath || !settings.instruction.trim()} onClick={() => void run().catch(showError)}><RotateCcw size={13} />{stale || completed ? t('重新生成配音') : idle ? t('开始生成') : t('重试')}</button>}

        {completed && progress?.outputVideoPath && (
          <div className="video-translation-result">
            <video controls preload="metadata" src={previewReady ? convertFileSrc(progress.outputVideoPath) : undefined} />
            <div>
              <span>{fileName(progress.outputVideoPath)}</span>
              <span className="video-translation-result-actions">
                {progress.subtitlePath && (
                  <button type="button" disabled={stale} onClick={() => void revealInFileManager(progress.subtitlePath!).catch(showError)}>
                    <Captions size={13} />{t(settings.mode === 'translate' ? '双语字幕 SRT' : '配音字幕 SRT')}
                  </button>
                )}
                <button type="button" disabled={stale || !previewReady || Boolean(mediaError)} onClick={() => void revealInFileManager(progress.outputVideoPath!).catch(showError)}>
                  <FolderOpen size={13} />{t('在 Finder 中显示')}
                </button>
              </span>
            </div>
          </div>
        )}
      </section>

      {turns.length > 0 && (
        <section className="video-translation-timeline">
          <header>
            <div>
              <strong>{t('配音稿与节奏')}</strong>
              <small>{t('逐段保留原台词、配音稿、说话人和时间信息')}</small>
            </div>
            <span>{t('{0} 段对白', [turns.length])}</span>
          </header>
          <div className="video-translation-turns">
            {turns.map((turn) => (
              <article key={turn.id}>
                <div className="video-translation-turn-meta">
                  <strong>{turn.speaker}</strong>
                  <time>{timestamp(turn.start)}–{timestamp(turn.end)}</time>
                </div>
                <p className="source">{turn.sourceText}</p>
                {turn.text
                  ? <p className="translation">{turn.text}</p>
                  : <p className="translation pending">{t('等待生成…')}</p>}
                {(turn.rhythmSegments?.length ?? 0) > 1 && (
                  <div className="video-translation-rhythm">
                    {turn.rhythmSegments!.map((segment) => (
                      <span key={segment.id}>
                        <time>{timestamp(segment.start)}–{timestamp(segment.end)}</time>
                        <b>{segment.text || segment.sourceText}</b>
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
