import { useEffect, useMemo, useState } from 'react'
import {
  AudioLines,
  Captions,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileAudio,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import {
  cancelHarnessRun,
  deleteHarnessRun,
  getHarnessRunOutput,
  listHarnessRuns,
  retryHarnessRun,
} from '../services/harness'
import { AudioAssetPreview } from '../components/AudioAssetPreview'
import { normalizeHarnessResult } from '../domain/results'
import { formatTime } from '../utils/audio'
import {
  downloadTranscript,
  type TranscriptExportFormat,
} from '../utils/transcript'
import type {
  AsrTranscriptionResult,
  AudioProcessResult,
  HarnessExecution,
  HarnessRun,
  TtsGenerateResult,
} from '../types'

type RunOutput =
  | TtsGenerateResult
  | AudioProcessResult
  | AsrTranscriptionResult
  | Record<string, unknown>

interface LibraryViewProps {
  runs: HarnessRun[]
  onRunsChanged: (runs: HarnessRun[]) => void
  onNewTask: () => void
  onOpenRun: (runId: string) => void
  onAction: (message: string) => void
}

const statusLabels: Record<HarnessRun['status'], string> = {
  queued: '排队中',
  running: '运行中',
  canceling: '取消中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

function RunIcon({ run }: { run: HarnessRun }) {
  if (run.capability === 'speech.synthesize') {
    return <WandSparkles size={16} />
  }
  if (run.capability === 'speech.transcribe') {
    return <Captions size={16} />
  }
  return <AudioLines size={16} />
}

function formatRunTime(milliseconds?: number): string {
  if (milliseconds === undefined) return '--'
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

function formatCreatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function isAudioOutput(
  output: RunOutput,
): output is TtsGenerateResult | AudioProcessResult {
  return 'dataUrl' in output && 'fileName' in output
}

function isTranscriptOutput(
  output: RunOutput,
): output is AsrTranscriptionResult {
  return (
    'text' in output &&
    typeof output.text === 'string' &&
    'clipName' in output &&
    typeof output.clipName === 'string' &&
    'segments' in output &&
    Array.isArray(output.segments)
  )
}

export function LibraryView({
  runs,
  onRunsChanged,
  onNewTask,
  onOpenRun,
  onAction,
}: LibraryViewProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<
    'all' | 'audio' | 'transcript' | 'attention'
  >('all')
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? '')
  const [execution, setExecution] =
    useState<HarnessExecution<RunOutput> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const selectedRun =
    runs.find((run) => run.id === selectedId) ?? runs[0] ?? null

  useEffect(() => {
    if (!runs.length) {
      setSelectedId('')
      return
    }
    if (!runs.some((run) => run.id === selectedId)) {
      setSelectedId(runs[0].id)
    }
  }, [runs, selectedId])

  useEffect(() => {
    let disposed = false
    setExecution(null)
    if (!selectedRun || selectedRun.status !== 'completed') {
      setDetailLoading(false)
      return undefined
    }

    setDetailLoading(true)
    void getHarnessRunOutput<RunOutput>(selectedRun.id)
      .then((result) => {
        if (!disposed) setExecution(result)
      })
      .catch((error) => {
        if (!disposed) {
          onAction(
            `无法读取产物：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .finally(() => {
        if (!disposed) setDetailLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [onAction, selectedRun])

  const filteredRuns = useMemo(
    () =>
      runs.filter((run) => {
        const matchesFilter =
          filter === 'all' ||
          (filter === 'audio' &&
            ['speech.synthesize', 'audio.enhance'].includes(
              run.capability,
            )) ||
          (filter === 'transcript' &&
            run.capability === 'speech.transcribe') ||
          (filter === 'attention' &&
            ['failed', 'canceled'].includes(run.status))
        const query = search.trim().toLowerCase()
        return (
          matchesFilter &&
          (!query ||
            run.title.toLowerCase().includes(query) ||
            run.inputSummary.toLowerCase().includes(query) ||
            run.providerName.toLowerCase().includes(query))
        )
      }),
    [filter, runs, search],
  )

  const refresh = async () => {
    try {
      onRunsChanged(await listHarnessRuns())
    } catch (error) {
      onAction(
        `刷新失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const retry = async (run: HarnessRun) => {
    try {
      const next = await retryHarnessRun(run.id)
      onRunsChanged([next, ...runs])
      setSelectedId(next.id)
      onAction('已重新提交任务')
    } catch (error) {
      onAction(
        `重试失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const cancel = async (run: HarnessRun) => {
    try {
      const next = await cancelHarnessRun(run.id)
      onRunsChanged(
        runs.map((item) => (item.id === next.id ? next : item)),
      )
    } catch (error) {
      onAction(
        `取消失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const remove = async (run: HarnessRun) => {
    if (!window.confirm(`删除“${run.title}”的运行记录？产物文件会保留。`)) {
      return
    }
    try {
      await deleteHarnessRun(run.id)
      onRunsChanged(runs.filter((item) => item.id !== run.id))
      onAction('运行记录已删除，产物文件仍保留在本机')
    } catch (error) {
      onAction(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const exportOutput = (format: TranscriptExportFormat = 'srt') => {
    if (!execution) return
    const output = execution.output
    if (isAudioOutput(output)) {
      const anchor = document.createElement('a')
      anchor.href = output.dataUrl
      anchor.download = output.fileName
      anchor.click()
      onAction(`${anchor.download} 已导出`)
    } else if (isTranscriptOutput(output)) {
      const fileName = downloadTranscript(
        output,
        format,
        output.clipName,
      )
      onAction(`${fileName} 已导出`)
    }
  }

  return (
    <main className="runs-page">
      <section className="runs-heading">
        <div>
          <span className="section-kicker">RUNS & ARTIFACTS</span>
          <h1>运行记录</h1>
          <p>
            {runs.length} 次运行 ·{' '}
            {runs.filter((run) => run.status === 'completed').length} 个完成
          </p>
        </div>
        <div className="runs-heading-actions">
          <button
            className="icon-button"
            type="button"
            title="刷新运行记录"
            aria-label="刷新运行记录"
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
          <button className="primary-action" type="button" onClick={onNewTask}>
            <Plus size={15} />
            新建任务
          </button>
        </div>
      </section>

      <section className="runs-workspace">
        <div className="runs-toolbar">
          <label className="runs-search">
            <Search size={15} />
            <input
              value={search}
              placeholder="搜索输入、Provider 或结果"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="runs-filter" role="group" aria-label="记录类型">
            {(
              [
                ['all', '全部'],
                ['audio', '音频'],
                ['transcript', '文字'],
                ['attention', '需关注'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={filter === id ? 'active' : ''}
                type="button"
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="runs-content-grid">
          <div className="runs-table" role="table" aria-label="运行记录">
            <div className="runs-table-header" role="row">
              <span>任务与输入</span>
              <span>路由</span>
              <span>耗时</span>
              <span>状态</span>
              <span />
            </div>
            {filteredRuns.map((run) => (
              <div
                className={`runs-table-row${selectedRun?.id === run.id ? ' selected' : ''}`}
                role="row"
                key={run.id}
              >
                <button
                  className="runs-row-main"
                  type="button"
                  onClick={() => setSelectedId(run.id)}
                >
                  <span className="runs-output-cell">
                    <span
                      className={`run-kind-icon ${run.capability.replace('.', '-')}`}
                      aria-hidden="true"
                    >
                      <RunIcon run={run} />
                    </span>
                    <span>
                      <strong>{run.title}</strong>
                      <small>
                        {run.inputSummary} · {formatCreatedAt(run.createdAt)}
                      </small>
                    </span>
                  </span>
                  <span className="runs-route">
                    <i />
                    {run.providerName}
                  </span>
                  <span className="runs-duration">
                    <Clock3 size={13} />
                    {formatRunTime(run.durationMs)}
                  </span>
                  <span className={`runs-state status-${run.status}`}>
                    {run.status === 'completed' ? (
                      <Check size={13} />
                    ) : run.status === 'failed' ? (
                      <CircleAlert size={13} />
                    ) : (
                      <LoaderCircle size={13} />
                    )}
                    {statusLabels[run.status]}
                  </span>
                  <ChevronRight size={15} />
                </button>
              </div>
            ))}
            {!filteredRuns.length && (
              <div className="runs-empty">
                <Search size={18} />
                {runs.length ? '没有匹配的运行记录' : '还没有运行记录'}
              </div>
            )}
          </div>

          <aside className="run-detail-panel">
            {selectedRun ? (
              <>
                <div className="run-detail-heading">
                  <span
                    className={`run-kind-icon ${selectedRun.capability.replace('.', '-')}`}
                    aria-hidden="true"
                  >
                    <RunIcon run={selectedRun} />
                  </span>
                  <div>
                    <span className="section-kicker">SELECTED RUN</span>
                    <h2>{selectedRun.title}</h2>
                    <small>{selectedRun.id}</small>
                  </div>
                </div>

                <div className="run-detail-status">
                  <span className={`runs-state status-${selectedRun.status}`}>
                    {statusLabels[selectedRun.status]}
                  </span>
                  <strong>{selectedRun.progress}%</strong>
                  <i>
                    <b style={{ width: `${selectedRun.progress}%` }} />
                  </i>
                </div>

                {selectedRun.error && (
                  <div className="run-error-message">
                    <CircleAlert size={15} />
                    <span>{selectedRun.error}</span>
                  </div>
                )}

                {detailLoading && (
                  <div className="run-detail-loading">
                    <LoaderCircle size={17} />
                    正在读取产物
                  </div>
                )}

                {execution && isAudioOutput(execution.output) && (
                  <div className="run-audio-result">
                    <AudioAssetPreview
                      src={execution.output.dataUrl}
                      role="output"
                      size="compact"
                    />
                    <span>
                      <FileAudio size={14} />
                      {execution.output.fileName} ·{' '}
                      {formatTime(execution.output.duration)}
                    </span>
                  </div>
                )}

                {execution && isTranscriptOutput(execution.output) && (
                  <div className="run-transcript-result">
                    <div>
                      <Captions size={15} />
                      <strong>
                        {execution.output.segments.length} 个时间码片段
                      </strong>
                    </div>
                    <p>{execution.output.text || '没有识别到文本'}</p>
                  </div>
                )}

                {execution &&
                  !isAudioOutput(execution.output) &&
                  !isTranscriptOutput(execution.output) && (
                    <div className="run-transcript-result">
                      <div>
                        <AudioLines size={15} />
                        <strong>结构化结果</strong>
                      </div>
                      <p>
                        {normalizeHarnessResult(execution.output).text ??
                          '结果已生成，可在模型工作区查看详情'}
                      </p>
                    </div>
                  )}

                <dl className="run-detail-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>{selectedRun.providerName}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedRun.modelId || '--'}</dd>
                  </div>
                  <div>
                    <dt>耗时</dt>
                    <dd>{formatRunTime(selectedRun.durationMs)}</dd>
                  </div>
                </dl>

                <div className="run-detail-actions">
                  {selectedRun.status === 'completed' &&
                    selectedRun.capability !== 'speech.transcribe' && (
                      <button
                        className="primary-action"
                        type="button"
                        onClick={() => onOpenRun(selectedRun.id)}
                      >
                        打开结果
                        <ChevronRight size={15} />
                      </button>
                    )}
                  {execution && isAudioOutput(execution.output) && (
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => exportOutput()}
                    >
                      <Download size={15} />
                      导出
                    </button>
                  )}
                  {execution && isTranscriptOutput(execution.output) && (
                    <label className="artifact-export-select">
                      <Download size={15} />
                      <select
                        value=""
                        aria-label="导出转写格式"
                        onChange={(event) =>
                          exportOutput(
                            event.target.value as TranscriptExportFormat,
                          )
                        }
                      >
                        <option value="" disabled>
                          导出格式
                        </option>
                        <option value="srt">SRT 字幕</option>
                        <option value="vtt">WebVTT</option>
                        <option value="txt">带时间码文本</option>
                        <option value="label-studio">
                          Label Studio JSON
                        </option>
                      </select>
                    </label>
                  )}
                  {['queued', 'running', 'canceling'].includes(
                    selectedRun.status,
                  ) && (
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={selectedRun.status === 'canceling'}
                      onClick={() => void cancel(selectedRun)}
                    >
                      <Square size={14} />
                      取消
                    </button>
                  )}
                  {selectedRun.retryable &&
                    ['completed', 'failed', 'canceled'].includes(
                      selectedRun.status,
                    ) && (
                      <button
                        className="secondary-action"
                        type="button"
                        onClick={() => void retry(selectedRun)}
                      >
                        <RotateCcw size={14} />
                        重试
                      </button>
                    )}
                  {!['queued', 'running', 'canceling'].includes(
                    selectedRun.status,
                  ) && (
                    <button
                      className="icon-button danger"
                      type="button"
                      title="删除运行记录"
                      aria-label="删除运行记录"
                      onClick={() => void remove(selectedRun)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="run-detail-empty">
                <AudioLines size={20} />
                选择一条运行查看详情
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  )
}
