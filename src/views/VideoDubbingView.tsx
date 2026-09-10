import { convertFileSrc } from '@tauri-apps/api/core'
import { Captions, Check, Circle, FolderOpen, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { revealInFileManager } from '../services/harness'
import {
  cancelVideoDubbing,
  startVideoDubbing,
  subscribeVideoDubbing,
  type VideoDubbingProgress,
  type VideoDubbingTurn,
} from '../services/videoDubbing'
import type { VideoDubbingMode } from '../domain/agents'
import { t, useLocale } from '../i18n'
import './VideoDubbingView.css'

interface VideoDubbingViewProps {
  initialInstruction: string
  initialSourcePath: string
  initialLaunchId: number
  dubbingMode: VideoDubbingMode
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

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path
}

function timestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, seconds - minutes * 60)
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`
}

export function VideoDubbingView({
  initialInstruction,
  initialSourcePath,
  initialLaunchId,
  dubbingMode,
  onAction,
}: VideoDubbingViewProps) {
  useLocale()
  const [taskId, setTaskId] = useState('')
  const [progress, setProgress] = useState<VideoDubbingProgress | null>(null)
  const [starting, setStarting] = useState(false)
  const [turns, setTurns] = useState<VideoDubbingTurn[]>([])
  const [audioAnalysis, setAudioAnalysis] = useState<VideoDubbingProgress['audioAnalysis']>()
  const appliedLaunchRef = useRef(0)
  const activeTaskRef = useRef('')
  const outputDirRef = useRef('')

  const run = useCallback(async () => {
    if (!initialSourcePath || starting) return
    setStarting(true)
    setProgress({
      taskId: '', status: 'running', stage: 'preparing', progress: 1,
      message: t('正在启动视频配音'),
    })
    try {
      const result = await startVideoDubbing(
        initialSourcePath,
        initialInstruction,
        dubbingMode,
        outputDirRef.current || undefined,
      )
      activeTaskRef.current = result.taskId
      outputDirRef.current = result.outputDir
      setTaskId(result.taskId)
    } catch (error) {
      setProgress({
        taskId: '', status: 'failed', stage: 'failed', progress: 100,
        message: t('视频配音启动失败'), error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStarting(false)
    }
  }, [dubbingMode, initialInstruction, initialSourcePath, starting])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeVideoDubbing((update) => {
      if (update.taskId === activeTaskRef.current) {
        setProgress(update)
        if (update.turns?.length) setTurns(update.turns)
        if (update.audioAnalysis) setAudioAnalysis(update.audioAnalysis)
      }
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!initialLaunchId || appliedLaunchRef.current === initialLaunchId) return
    appliedLaunchRef.current = initialLaunchId
    void run()
  }, [initialLaunchId, run])

  const cancel = async () => {
    if (!taskId) return
    try {
      await cancelVideoDubbing(taskId)
      setProgress((current) => current ? { ...current, message: t('正在取消视频配音') } : current)
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error))
    }
  }

  const retry = () => {
    activeTaskRef.current = ''
    setTaskId('')
    setProgress(null)
    setTurns([])
    setAudioAnalysis(undefined)
    void run()
  }

  const currentStage = stageOrder.get(progress?.stage ?? '') ?? -1
  const completed = progress?.status === 'completed'
  const failed = progress?.status === 'failed' || progress?.status === 'canceled'

  return (
    <main className="video-translation-view">
      <header className="video-translation-header">
        <div>
          <span>{t('视频配音')}</span>
          <h1>{t('生成视频配音')}</h1>
        </div>
        {progress?.status === 'running' && taskId && (
          <button type="button" onClick={() => void cancel()}><Square size={13} />{t('取消')}</button>
        )}
      </header>

      <section className="video-translation-source">
        <strong>{fileName(initialSourcePath)}</strong>
        <small>{t(dubbingMode === 'translate' ? '翻译原声' : dubbingMode === 'rewrite' ? '修改原稿' : '使用新文案')}</small>
        <p>{initialInstruction}</p>
      </section>

      <section className="video-translation-card">
        <div className="video-translation-summary">
          <div>
            {progress?.status === 'running' && <LoaderCircle className="video-translation-spin" size={18} />}
            {completed && <Check size={18} />}
            {failed && <Circle size={18} />}
            <strong>{completed ? t('视频配音已完成') : failed ? t('视频配音未完成') : t('正在生成视频配音')}</strong>
          </div>
          <span>{Math.round(progress?.progress ?? 0)}%</span>
        </div>
        <div className="video-translation-progress"><i style={{ width: `${progress?.progress ?? 0}%` }} /></div>
        <p className={failed ? 'error' : ''}>{progress?.error || progress?.message || t('正在启动视频配音')}</p>
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

        {failed && <button className="video-translation-retry" type="button" onClick={retry}><RotateCcw size={13} />{t('重试')}</button>}

        {completed && progress?.outputVideoPath && (
          <div className="video-translation-result">
            <video controls preload="metadata" src={convertFileSrc(progress.outputVideoPath)} />
            <div>
              <span>{fileName(progress.outputVideoPath)}</span>
              <span className="video-translation-result-actions">
                {progress.subtitlePath && (
                  <button type="button" onClick={() => void revealInFileManager(progress.subtitlePath!)}>
                    <Captions size={13} />{t(dubbingMode === 'translate' ? '双语字幕 SRT' : '配音字幕 SRT')}
                  </button>
                )}
                <button type="button" onClick={() => void revealInFileManager(progress.outputVideoPath!)}>
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
