import { useRef, useState } from 'react'
import {
  Check,
  CircleAlert,
  CirclePlus,
  Clock3,
  Download,
  FileAudio,
  FolderOpen,
  ListChecks,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import {
  cancelHarnessRun,
  executeHarnessTask,
  HarnessRunError,
} from '../services/harness'
import { exportAudioFile } from '../services/fileExport'
import type {
  AudioClip,
  AudioProcessResult,
  HarnessRun,
} from '../types'
import {
  audioFileToClip,
  formatFileSize,
  formatTime,
} from '../utils/audio'
import { filterAudioFiles } from '../utils/audioFiles'

interface BatchViewProps {
  onProcessed: (clip: AudioClip, message: string) => void
  onAction: (message: string) => void
}

type JobState = 'ready' | 'running' | 'done' | 'warning' | 'canceled'

interface BatchJob {
  id: string
  clip: AudioClip
  state: JobState
  progress: number
  error?: string
  runId?: string
  result?: AudioProcessResult
}

function resultToClip(result: AudioProcessResult): AudioClip {
  return {
    id: `processed-${crypto.randomUUID()}`,
    name: result.fileName,
    duration: result.duration,
    sampleRate: result.sampleRate,
    channels: result.channels,
    kind: 'recording',
    samples: result.waveform,
    color: '#827df8',
    sizeLabel: formatFileSize(result.sizeBytes),
    sourceLabel: result.engine,
    url: result.dataUrl,
    processingAudioUrl: result.dataUrl,
    transcriptionAudioUrl: result.dataUrl,
  }
}

export function BatchView({
  onProcessed,
  onAction,
}: BatchViewProps) {
  const [jobs, setJobs] = useState<BatchJob[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cancelRequestedRef = useRef(false)
  const activeRunIdRef = useRef<string | null>(null)

  const addFiles = async (files: FileList | File[]) => {
    const audioFiles = filterAudioFiles(files)
    if (!audioFiles.length) {
      onAction('没有找到可处理的音频文件')
      return
    }

    setIsImporting(true)
    try {
      const clips = await Promise.all(audioFiles.map(audioFileToClip))
      const next = clips.map<BatchJob>((clip) => ({
        id: `batch-${crypto.randomUUID()}`,
        clip,
        state: clip.processingAudioUrl ? 'ready' : 'warning',
        progress: 0,
        error: clip.processingAudioUrl
          ? undefined
          : '当前格式无法解码为本地 WAV',
      }))
      setJobs((current) => [...current, ...next])
      onAction(`已加入 ${clips.length} 个真实音频文件`)
    } finally {
      setIsImporting(false)
    }
  }

  const updateJob = (
    jobId: string,
    change: (job: BatchJob) => BatchJob,
  ) => {
    setJobs((current) =>
      current.map((job) => (job.id === jobId ? change(job) : job)),
    )
  }

  const runQueue = async () => {
    if (isRunning) return
    const pending = jobs.filter(
      (job) => job.state === 'ready' && job.clip.processingAudioUrl,
    )
    if (!pending.length) {
      onAction('队列中没有可处理的文件')
      return
    }

    cancelRequestedRef.current = false
    setIsRunning(true)
    let completed = 0

    for (const job of pending) {
      if (cancelRequestedRef.current) break

      updateJob(job.id, (current) => ({
        ...current,
        state: 'running',
        progress: 1,
        error: undefined,
      }))

      try {
        const execution = await executeHarnessTask<AudioProcessResult>(
          {
            capability: 'audio.enhance',
            routing: 'local',
            title: `批处理 · ${job.clip.name}`,
            input: {
              audioDataUrl: job.clip.processingAudioUrl,
              clipName: job.clip.name,
            },
            parameters: {
              operations: ['denoise', 'silence', 'normalize', 'fade'],
              denoiseStrength: 0.72,
              targetLoudnessDb: -16,
              silencePaddingMs: 120,
              fadeMs: 20,
            },
          },
          (run: HarnessRun) => {
            activeRunIdRef.current =
              run.status === 'running' || run.status === 'canceling'
                ? run.id
                : null
            updateJob(job.id, (current) => ({
              ...current,
              runId: run.id,
              state:
                run.status === 'canceled'
                  ? 'canceled'
                  : run.status === 'failed'
                    ? 'warning'
                    : run.status === 'completed'
                      ? 'done'
                      : 'running',
              progress: run.progress,
              error: run.error ?? undefined,
            }))
          },
        )
        completed += 1
        updateJob(job.id, (current) => ({
          ...current,
          state: 'done',
          progress: 100,
          result: execution.output,
        }))
        onProcessed(
          resultToClip(execution.output),
          `${job.clip.name} 已完成批处理`,
        )
      } catch (error) {
        const canceled =
          error instanceof HarnessRunError &&
          error.run.status === 'canceled'
        updateJob(job.id, (current) => ({
          ...current,
          state: canceled ? 'canceled' : 'warning',
          progress: canceled ? current.progress : 100,
          error:
            error instanceof Error ? error.message : String(error),
        }))
        if (canceled) break
      } finally {
        activeRunIdRef.current = null
      }
    }

    if (cancelRequestedRef.current) {
      onAction('批处理队列已停止')
    } else {
      onAction(`${completed} 个文件已处理完成`)
    }
    setIsRunning(false)
  }

  const cancelQueue = async () => {
    cancelRequestedRef.current = true
    const runId = activeRunIdRef.current
    if (runId) {
      try {
        await cancelHarnessRun(runId)
      } catch (error) {
        onAction(
          `取消失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  const removeJob = (jobId: string) => {
    setJobs((current) => current.filter((job) => job.id !== jobId))
  }

  const retryJob = (jobId: string) => {
    updateJob(jobId, (job) => ({
      ...job,
      state: job.clip.processingAudioUrl ? 'ready' : 'warning',
      progress: 0,
      error: job.clip.processingAudioUrl
        ? undefined
        : '当前格式无法解码为本地 WAV',
      result: undefined,
    }))
  }

  const exportResult = async (job: BatchJob) => {
    if (!job.result) return
    try {
      const destinationPath = await exportAudioFile(job.result)
      if (destinationPath) {
        onAction(`${job.result.fileName} 已保存到 ${destinationPath}`)
      }
    } catch (error) {
      onAction(
        `导出音频失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const completedCount = jobs.filter((job) => job.state === 'done').length
  const totalBytes = jobs.reduce((sum, job) => {
    const match = job.clip.sizeLabel.match(/([\d.]+)\s*(KB|MB|GB)/i)
    if (!match) return sum
    const value = Number(match[1])
    const unit = match[2].toUpperCase()
    const multiplier =
      unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024
    return sum + value * multiplier
  }, 0)
  const totalSize = totalBytes ? formatFileSize(totalBytes) : '0 MB'

  return (
    <div className="batch-page">
      <div className="page-intro">
        <div>
          <span className="section-kicker">AUTOMATION QUEUE</span>
          <h1>批量处理</h1>
          <p>本地人声清理 · WAV 输出 · 每个文件保留独立运行记录</p>
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={isImporting || isRunning}
          onClick={() => fileInputRef.current?.click()}
        >
          <FolderOpen size={16} />
          {isImporting ? '正在读取' : '添加文件'}
        </button>
      </div>

      <div className="batch-summary-strip">
        <div>
          <span className="summary-icon tone-green">
            <ListChecks size={18} />
          </span>
          <span>
            <small>队列文件</small>
            <strong>{jobs.length}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon tone-coral">
            <Clock3 size={18} />
          </span>
          <span>
            <small>执行状态</small>
            <strong>{isRunning ? '本地处理中' : '等待开始'}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon tone-blue">
            <Download size={18} />
          </span>
          <span>
            <small>原始大小</small>
            <strong>{totalSize}</strong>
          </span>
        </div>
        <div className="batch-completion">
          <span>
            {completedCount} / {jobs.length} 完成
          </span>
          <i>
            <b
              style={{
                width: `${jobs.length ? (completedCount / jobs.length) * 100 : 0}%`,
              }}
            />
          </i>
        </div>
      </div>

      <div className="batch-workspace">
        <main className="batch-queue">
          <div className="queue-toolbar">
            <div>
              <strong>处理队列</strong>
              <span>
                {jobs.length} 个文件 · {totalSize}
              </span>
            </div>
            <button
              className="quiet-button"
              type="button"
              disabled={isRunning || !jobs.length}
              onClick={() => setJobs([])}
            >
              <RotateCcw size={14} /> 清空
            </button>
          </div>

          <div className="queue-table">
            <div className="queue-row queue-header">
              <span>文件</span>
              <span>时长</span>
              <span>大小</span>
              <span>状态</span>
              <span />
            </div>
            {jobs.map((job) => (
              <div key={job.id} className="queue-row">
                <span className="queue-file">
                  <i>
                    <FileAudio size={16} />
                  </i>
                  <strong>{job.clip.name}</strong>
                </span>
                <span>{formatTime(job.clip.duration)}</span>
                <span>{job.clip.sizeLabel}</span>
                <span title={job.error}>
                  {job.state === 'done' && (
                    <span className="job-state done">
                      <Check size={13} /> 已完成
                    </span>
                  )}
                  {job.state === 'ready' && (
                    <span className="job-state ready">等待处理</span>
                  )}
                  {job.state === 'warning' && (
                    <button
                      className="job-state warning"
                      type="button"
                      onClick={() => retryJob(job.id)}
                    >
                      <CircleAlert size={13} /> 重试
                    </button>
                  )}
                  {job.state === 'canceled' && (
                    <button
                      className="job-state warning"
                      type="button"
                      onClick={() => retryJob(job.id)}
                    >
                      已取消
                    </button>
                  )}
                  {job.state === 'running' && (
                    <span className="job-progress">
                      <i>
                        <b style={{ width: `${job.progress}%` }} />
                      </i>
                      {job.progress}%
                    </span>
                  )}
                </span>
                {job.result ? (
                  <button
                    className="icon-button"
                    type="button"
                    title={`导出 ${job.result.fileName}`}
                    aria-label={`导出 ${job.result.fileName}`}
                    onClick={() => exportResult(job)}
                  >
                    <Download size={15} />
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    type="button"
                    title={`移除 ${job.clip.name}`}
                    aria-label={`移除 ${job.clip.name}`}
                    disabled={job.state === 'running'}
                    onClick={() => removeJob(job.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            {!jobs.length && (
              <div className="batch-empty-state">
                <FileAudio size={28} />
                <strong>队列还是空的</strong>
                <span>添加 WAV、MP3、FLAC、M4A 或 OGG 音频开始处理</span>
              </div>
            )}
          </div>

          <button
            className="queue-dropzone"
            type="button"
            disabled={isRunning}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              if (!isRunning) void addFiles(event.dataTransfer.files)
            }}
          >
            <CirclePlus size={18} />
            拖放更多音频，或点击选择文件
          </button>
        </main>

        <aside className="batch-settings">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">PIPELINE</span>
              <h2>批处理设置</h2>
            </div>
            <Sparkles size={17} />
          </div>

          <div className="setting-group">
            <label>处理链预设</label>
            <div className="select-button static-value">
              <span>播客人声清理</span>
              <Check size={15} />
            </div>
            <div className="pipeline-preview">
              <span>DPDFNet2</span>
              <i />
              <span>Silero VAD</span>
              <i />
              <span>-16 dB</span>
            </div>
          </div>

          <div className="setting-group">
            <label>导出格式</label>
            <div className="select-button static-value">
              <span>WAV · PCM 16-bit</span>
              <Check size={15} />
            </div>
          </div>

          <div className="setting-group">
            <span className="setting-label">产物位置</span>
            <div className="folder-path static-value">
              <FolderOpen size={15} />
          <span>QwenAudio Toolkits / processed</span>
            </div>
          </div>

          <div className="batch-option-list">
            <label>
              <input type="checkbox" checked readOnly />
              <span />
              AI 降噪
            </label>
            <label>
              <input type="checkbox" checked readOnly />
              <span />
              压缩过长静音
            </label>
            <label>
              <input type="checkbox" checked readOnly />
              <span />
              响度标准化与边缘淡化
            </label>
          </div>

          <button
            className="primary-action full-width batch-run-button"
            type="button"
            disabled={!jobs.length}
            onClick={() =>
              isRunning ? void cancelQueue() : void runQueue()
            }
          >
            {isRunning ? (
              <Square size={15} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            {isRunning
              ? '停止当前队列'
              : `开始处理 ${jobs.filter((job) => job.state === 'ready').length} 个文件`}
          </button>
        </aside>
      </div>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg"
        multiple
        onChange={(event) => {
          if (event.target.files) void addFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}
