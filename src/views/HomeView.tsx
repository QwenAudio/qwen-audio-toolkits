import { useMemo, useState } from 'react'
import {
  ArrowRight,
  AudioLines,
  Blocks,
  Captions,
  CircleAlert,
  CircleCheck,
  ChevronRight,
  Clock3,
  FileAudio,
  Gauge,
  History,
  Layers3,
  LoaderCircle,
  Mic2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import { formatTime } from '../utils/audio'
import { filterAudioFiles } from '../utils/audioFiles'
import type {
  HarnessCapabilityId,
  HarnessCatalog,
  HarnessRun,
  RuntimeStatus,
} from '../types'

export type HarnessIntent = 'tts' | 'clean' | 'transcribe' | 'live'

interface HomeViewProps {
  runtime: RuntimeStatus
  catalog: HarnessCatalog | null
  recentRuns: HarnessRun[]
  activeRun: HarnessRun | null
  onStartTextTask: (
    text: string,
    routing: 'smart' | 'local' | 'quality',
  ) => void
  onRequestAudioTask: (
    intent: 'clean' | 'transcribe',
    files?: File[],
    routing?: 'smart' | 'local' | 'quality',
  ) => void
  onStartLiveTask: () => void
  onOpenRun: (runId: string) => void
  onOpenHistory: () => void
  onOpenBatch: () => void
  onOpenPlugins: () => void
}

const intents: Array<{
  id: HarnessIntent
  label: string
  description: string
  icon: typeof WandSparkles
  provider: string
  capability: HarnessCapabilityId
}> = [
  {
    id: 'tts',
    label: '生成语音',
    description: '输入文字',
    icon: WandSparkles,
    provider: 'Kokoro TTS',
    capability: 'speech.synthesize',
  },
  {
    id: 'clean',
    label: '清理录音',
    description: '降噪与响度',
    icon: Sparkles,
    provider: 'DPDFNet2 + Silero',
    capability: 'audio.enhance',
  },
  {
    id: 'transcribe',
    label: '转成文字',
    description: '识别与时间戳',
    icon: Captions,
    provider: 'SenseVoice Small',
    capability: 'speech.transcribe',
  },
  {
    id: 'live',
    label: '实时处理',
    description: '麦克风音频流',
    icon: Mic2,
    provider: 'Local Stream Chain',
    capability: 'audio.live',
  },
]

const defaultText =
  '让每一段声音都更清晰、更自然，也更接近真正想表达的样子。'

export function HomeView({
  runtime,
  catalog,
  recentRuns,
  activeRun,
  onStartTextTask,
  onRequestAudioTask,
  onStartLiveTask,
  onOpenRun,
  onOpenHistory,
  onOpenBatch,
  onOpenPlugins,
}: HomeViewProps) {
  const [intent, setIntent] = useState<HarnessIntent>('tts')
  const [text, setText] = useState(defaultText)
  const [routing, setRouting] = useState<'smart' | 'local' | 'quality'>(
    'smart',
  )
  const selectedIntent =
    intents.find((item) => item.id === intent) ?? intents[0]
  const recent = useMemo(() => recentRuns.slice(0, 4), [recentRuns])
  const isBusy =
    activeRun?.status === 'queued' ||
    activeRun?.status === 'running' ||
    activeRun?.status === 'canceling'
  const compatibleProviders = catalog?.providers.filter((provider) =>
    provider.capabilities.includes(selectedIntent.capability),
  )
  const routedProvider =
    (routing === 'quality'
      ? compatibleProviders?.find(
          (provider) => !provider.local && provider.status === 'ready',
        )
      : undefined) ??
    compatibleProviders?.find(
      (provider) => provider.local && provider.status === 'ready',
    )

  const startTask = () => {
    if (intent === 'tts') {
      onStartTextTask(text, routing)
    } else if (intent === 'live') {
      onStartLiveTask()
    } else {
      onRequestAudioTask(intent, undefined, routing)
    }
  }

  const actionLabel =
    intent === 'tts'
      ? '生成语音'
      : intent === 'live'
        ? '打开实时处理'
        : intent === 'clean'
          ? '选择音频并清理'
          : '选择音频并识别'

  return (
    <main className="harness-page">
      <section className="harness-heading">
        <div>
          <span className="section-kicker">AUDIO HARNESS</span>
          <h1>今天想处理什么？</h1>
          <p>选择目标，系统会自动匹配本地模型或 API。</p>
        </div>
        <button
          className="secondary-action harness-history-button"
          type="button"
          onClick={onOpenHistory}
        >
          <History size={15} />
          运行记录
        </button>
      </section>

      <section className="harness-composer" aria-label="新建音频任务">
        <div className="intent-selector" role="radiogroup" aria-label="任务目标">
          {intents.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={intent === item.id ? 'active' : ''}
                type="button"
                role="radio"
                aria-checked={intent === item.id}
                onClick={() => setIntent(item.id)}
              >
                <span className="intent-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            )
          })}
        </div>

        <div className="task-input-area">
          {intent === 'tts' && (
            <div className="text-task-input">
              <div className="task-field-label">
                <span>文本</span>
                <small>{text.length} / 1,200</small>
              </div>
              <textarea
                value={text}
                maxLength={1200}
                aria-label="要生成的语音文本"
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          )}

          {(intent === 'clean' || intent === 'transcribe') && (
            <button
              className="audio-task-dropzone"
              type="button"
              onClick={() => onRequestAudioTask(intent)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const files = filterAudioFiles(event.dataTransfer.files)
                if (files.length) onRequestAudioTask(intent, files, routing)
              }}
            >
              <span className="dropzone-icon">
                <FileAudio size={22} />
              </span>
              <span>
                <strong>选择或拖入音频</strong>
                <small>WAV、MP3、FLAC、M4A</small>
              </span>
              <ChevronRight size={17} />
            </button>
          )}

          {intent === 'live' && (
            <div className="live-task-source">
              <span className="dropzone-icon">
                <Mic2 size={22} />
              </span>
              <span>
                <strong>MacBook 麦克风</strong>
                <small>系统默认输入 · 48 kHz</small>
              </span>
              <span className="source-ready">
                <i />
                已连接
              </span>
            </div>
          )}
        </div>

        <div className="harness-runbar">
          <div className="routing-preference">
            <span>运行方式</span>
            <div className="compact-segments" role="group" aria-label="运行方式">
              <button
                className={routing === 'smart' ? 'active' : ''}
                type="button"
                onClick={() => setRouting('smart')}
              >
                智能
              </button>
              <button
                className={routing === 'local' ? 'active' : ''}
                type="button"
                onClick={() => setRouting('local')}
              >
                仅本地
              </button>
              <button
                className={routing === 'quality' ? 'active' : ''}
                type="button"
                onClick={() => setRouting('quality')}
              >
                质量优先
              </button>
            </div>
          </div>

          <button
            className="provider-route"
            type="button"
            onClick={onOpenPlugins}
          >
            <span className="status-dot" />
            <span>
              <small>{routing === 'quality' ? '自动选择' : '本地路由'}</small>
              <strong>{routedProvider?.name ?? selectedIntent.provider}</strong>
            </span>
            <ChevronRight size={14} />
          </button>

          <button
            className="primary-action harness-run-button"
            type="button"
            disabled={(intent === 'tts' && !text.trim()) || isBusy}
            onClick={startTask}
          >
            {isBusy ? '任务运行中' : actionLabel}
            <ArrowRight size={15} />
          </button>
        </div>

        {activeRun && (
          <button
            className={`active-run-strip status-${activeRun.status}`}
            type="button"
            onClick={() => onOpenRun(activeRun.id)}
          >
            <span className="active-run-state" aria-hidden="true">
              {activeRun.status === 'completed' ? (
                <CircleCheck size={17} />
              ) : activeRun.status === 'failed' ? (
                <CircleAlert size={17} />
              ) : (
                <LoaderCircle size={17} />
              )}
            </span>
            <span className="active-run-copy">
              <strong>{activeRun.title}</strong>
              <small>
                {activeRun.status === 'completed'
                  ? `${activeRun.providerName} · 已完成`
                  : activeRun.status === 'failed'
                    ? activeRun.error
                    : `${activeRun.providerName} · ${activeRun.progress}%`}
              </small>
            </span>
            <span className="active-run-progress">
              <i style={{ width: `${activeRun.progress}%` }} />
            </span>
            <ChevronRight size={15} />
          </button>
        )}
      </section>

      <section className="harness-lower-grid">
        <div className="recent-runs">
          <div className="section-heading-row">
            <div>
              <span className="section-kicker">RECENT</span>
              <h2>最近结果</h2>
            </div>
            <button className="quiet-button" type="button" onClick={onOpenHistory}>
              查看全部
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="recent-run-list">
            {recent.map((run) => (
              <button
                className="recent-run-row"
                type="button"
                key={run.id}
                onClick={() => onOpenRun(run.id)}
              >
                <span
                  className={`run-kind-icon ${run.capability.replace('.', '-')}`}
                  aria-hidden="true"
                >
                  {run.capability === 'speech.synthesize' ? (
                    <WandSparkles size={16} />
                  ) : run.capability === 'speech.transcribe' ? (
                    <Captions size={16} />
                  ) : (
                    <AudioLines size={16} />
                  )}
                </span>
                <span className="run-copy">
                  <strong>{run.title}</strong>
                  <small>
                    {run.providerName}
                    {run.artifacts[0]?.duration
                      ? ` · ${formatTime(run.artifacts[0].duration)}`
                      : ''}
                  </small>
                </span>
                <span className={`run-status status-${run.status}`}>
                  <i />
                  {run.status === 'completed'
                    ? '完成'
                    : run.status === 'failed'
                      ? '失败'
                      : run.status === 'canceled'
                        ? '已取消'
                        : `${run.progress}%`}
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!recent.length && (
              <div className="recent-runs-empty">
                <AudioLines size={18} />
                完成的任务会出现在这里
              </div>
            )}
          </div>
        </div>

        <aside className="harness-status-panel">
          <div className="section-heading-row">
            <div>
              <span className="section-kicker">RUNTIME</span>
              <h2>Harness 状态</h2>
            </div>
            <span className="runtime-ready-pill">就绪</span>
          </div>

          <dl className="harness-facts">
            <div>
              <dt>
                <ShieldCheck size={15} />
                默认策略
              </dt>
              <dd>本地优先</dd>
            </div>
            <div>
              <dt>
                <Gauge size={15} />
                运行设备
              </dt>
              <dd>{runtime.device}</dd>
            </div>
            <div>
              <dt>
                <Blocks size={15} />
                可用能力
              </dt>
              <dd>{catalog?.capabilities.length ?? 4} 项</dd>
            </div>
            <div>
              <dt>
                <Clock3 size={15} />
                本地服务
              </dt>
              <dd>{runtime.apiUrl.replace('http://', '')}</dd>
            </div>
          </dl>

          <button
            className="harness-batch-link"
            type="button"
            onClick={onOpenBatch}
          >
            <span>
              <Layers3 size={16} />
              批量处理
            </span>
            <ChevronRight size={15} />
          </button>
        </aside>
      </section>
    </main>
  )
}
