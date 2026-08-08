import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AudioWaveform,
  Cable,
  CirclePlus,
  CircleStop,
  Gauge,
  HardDrive,
  Headphones,
  Mic2,
  Radio,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  Waves,
  Wifi,
  X,
} from 'lucide-react'
import { executeHarnessTask } from '../services/harness'
import { getMicrophoneStream } from '../services/audioCapture'
import { formatTime } from '../utils/audio'

interface LiveViewProps {
  onRecorded: (file: File) => void
  onOpenPlugins: () => void
  onAction: (message: string) => void
}

const idleMeters = [9, 11, 8, 12, 10, 8, 11, 9, 12, 8, 10, 9]

function gainFromControl(value: number): number {
  const decibels = (value - 76) / 3
  return 10 ** (decibels / 20)
}

function encodeMonoWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const bytes = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(bytes)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)

  let offset = 44
  for (const chunk of chunks) {
    for (const rawSample of chunk) {
      const sample = Number.isFinite(rawSample)
        ? Math.max(-1, Math.min(1, rawSample))
        : 0
      view.setInt16(
        offset,
        Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff),
        true,
      )
      offset += 2
    }
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取录音数据'))
    reader.readAsDataURL(blob)
  })
}

export function LiveView({
  onRecorded,
  onOpenPlugins,
  onAction,
}: LiveViewProps) {
  const [isLive, setIsLive] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [inputGain, setInputGain] = useState(76)
  const [mix, setMix] = useState(82)
  const [record, setRecord] = useState(true)
  const [bypass, setBypass] = useState(false)
  const [chainOpen, setChainOpen] = useState(false)
  const [meters, setMeters] = useState(idleMeters)
  const [levelDb, setLevelDb] = useState(-60)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [sampleRate, setSampleRate] = useState(48_000)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('default')
  const [lastRecordingUrl, setLastRecordingUrl] = useState<string | null>(
    null,
  )
  const [deviceError, setDeviceError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const inputGainRef = useRef<GainNode | null>(null)
  const dryGainRef = useRef<GainNode | null>(null)
  const wetGainRef = useRef<GainNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const animationRef = useRef<number | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const recordRef = useRef(record)
  const startedAtRef = useRef(0)

  const selectedDevice =
    devices.find((device) => device.deviceId === selectedDeviceId) ??
    devices[0]
  const selectedDeviceLabel =
    selectedDevice?.label || '系统默认麦克风'

  useEffect(() => {
    recordRef.current = record
  }, [record])

  useEffect(() => {
    const loadDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return
      const allDevices = await navigator.mediaDevices.enumerateDevices()
      setDevices(allDevices.filter((device) => device.kind === 'audioinput'))
    }
    void loadDevices()
    navigator.mediaDevices?.addEventListener('devicechange', loadDevices)
    return () =>
      navigator.mediaDevices?.removeEventListener(
        'devicechange',
        loadDevices,
      )
  }, [])

  useEffect(() => {
    const node = inputGainRef.current
    if (node) {
      node.gain.setTargetAtTime(
        gainFromControl(inputGain),
        node.context.currentTime,
        0.015,
      )
    }
  }, [inputGain])

  useEffect(() => {
    const dry = dryGainRef.current
    const wet = wetGainRef.current
    if (!dry || !wet) return
    const wetValue = bypass ? 0 : mix / 100
    const dryValue = bypass ? 1 : 1 - wetValue
    dry.gain.setTargetAtTime(dryValue, dry.context.currentTime, 0.015)
    wet.gain.setTargetAtTime(wetValue, wet.context.currentTime, 0.015)
  }, [bypass, mix])

  useEffect(
    () => () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current)
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      processorRef.current?.disconnect()
      void contextRef.current?.close()
    },
    [],
  )

  useEffect(
    () => () => {
      if (lastRecordingUrl) URL.revokeObjectURL(lastRecordingUrl)
    },
    [lastRecordingUrl],
  )

  const startMeter = (analyser: AnalyserNode, context: AudioContext) => {
    const values = new Float32Array(analyser.fftSize)
    let lastUpdate = 0
    const tick = (now: number) => {
      analyser.getFloatTimeDomainData(values)
      if (now - lastUpdate > 48) {
        lastUpdate = now
        let squareSum = 0
        for (const value of values) squareSum += value * value
        const rms = Math.sqrt(squareSum / values.length)
        setLevelDb(
          rms > 0.000_001 ? Math.max(-60, 20 * Math.log10(rms)) : -60,
        )
        const block = Math.floor(values.length / 12)
        setMeters(
          Array.from({ length: 12 }, (_, index) => {
            let peak = 0
            const start = index * block
            const end = Math.min(values.length, start + block)
            for (let offset = start; offset < end; offset += 1) {
              peak = Math.max(peak, Math.abs(values[offset]))
            }
            return Math.max(5, Math.min(100, peak * 170))
          }),
        )
        setElapsed((now - startedAtRef.current) / 1000)
      }
      if (context.state !== 'closed') {
        animationRef.current = requestAnimationFrame(tick)
      }
    }
    animationRef.current = requestAnimationFrame(tick)
  }

  const startLive = async () => {
    if (isStarting || isLive) return
    if (!navigator.mediaDevices?.getUserMedia) {
      onAction('当前系统 WebView 不支持麦克风访问')
      return
    }

    setIsStarting(true)
    setDeviceError(null)
    try {
      const stream = await getMicrophoneStream({
          deviceId:
            selectedDeviceId === 'default'
              ? undefined
              : { exact: selectedDeviceId },
          channelCount: 1,
          sampleRate: { ideal: 48_000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
      })
      const context = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: 48_000,
      })
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      const inputNode = context.createGain()
      const dryNode = context.createGain()
      const wetNode = context.createGain()
      const compressor = context.createDynamicsCompressor()
      const outputBus = context.createGain()
      const analyser = context.createAnalyser()
      const processor = context.createScriptProcessor(4096, 1, 1)
      const silentOutput = context.createGain()

      inputNode.gain.value = gainFromControl(inputGain)
      dryNode.gain.value = bypass ? 1 : 1 - mix / 100
      wetNode.gain.value = bypass ? 0 : mix / 100
      compressor.threshold.value = -24
      compressor.knee.value = 16
      compressor.ratio.value = 4
      compressor.attack.value = 0.004
      compressor.release.value = 0.18
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.68
      silentOutput.gain.value = 0

      source.connect(inputNode)
      inputNode.connect(dryNode)
      inputNode.connect(compressor)
      compressor.connect(wetNode)
      dryNode.connect(outputBus)
      wetNode.connect(outputBus)
      outputBus.connect(analyser)
      outputBus.connect(processor)
      processor.connect(silentOutput)
      silentOutput.connect(context.destination)
      processor.onaudioprocess = (event) => {
        if (!recordRef.current) return
        chunksRef.current.push(
          new Float32Array(event.inputBuffer.getChannelData(0)),
        )
      }

      streamRef.current = stream
      contextRef.current = context
      inputGainRef.current = inputNode
      dryGainRef.current = dryNode
      wetGainRef.current = wetNode
      analyserRef.current = analyser
      processorRef.current = processor
      chunksRef.current = []
      startedAtRef.current = performance.now()
      setElapsed(0)
      setSampleRate(context.sampleRate)
      const contextWithOutputLatency = context as AudioContext & {
        outputLatency?: number
      }
      setLatencyMs(
        (context.baseLatency + (contextWithOutputLatency.outputLatency ?? 0)) *
          1000,
      )
      setIsLive(true)
      startMeter(analyser, context)

      const allDevices = await navigator.mediaDevices.enumerateDevices()
      setDevices(allDevices.filter((device) => device.kind === 'audioinput'))
      const track = stream.getAudioTracks()[0]
      if (selectedDeviceId === 'default' && track?.getSettings().deviceId) {
        setSelectedDeviceId(track.getSettings().deviceId ?? 'default')
      }
      onAction('麦克风已连接，本地实时处理开始运行')
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
        ? '没有麦克风权限，请在系统设置中允许 QwenAudio Toolkits 访问麦克风'
          : error instanceof Error
            ? error.message
            : String(error)
      setDeviceError(message)
      onAction(message)
    } finally {
      setIsStarting(false)
    }
  }

  const stopLive = async () => {
    if (!isLive) return
    const duration = Math.max(
      0,
      (performance.now() - startedAtRef.current) / 1000,
    )
    const chunks = chunksRef.current
    const context = contextRef.current
    const stream = streamRef.current
    setIsLive(false)
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    processorRef.current?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    if (context && context.state !== 'closed') await context.close()
    streamRef.current = null
    contextRef.current = null
    inputGainRef.current = null
    dryGainRef.current = null
    wetGainRef.current = null
    analyserRef.current = null
    processorRef.current = null
    setMeters(idleMeters)
    setLevelDb(-60)

    try {
      if (record && chunks.length) {
        const blob = encodeMonoWav(chunks, sampleRate)
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19)
        const file = new File([blob], `实时录音_${timestamp}.wav`, {
          type: 'audio/wav',
        })
        setLastRecordingUrl((current) => {
          if (current) URL.revokeObjectURL(current)
          return URL.createObjectURL(file)
        })
        onRecorded(file)
        const audioDataUrl = await blobDataUrl(blob)
        await executeHarnessTask({
          capability: 'audio.live',
          providerId: 'local.web-audio',
          routing: 'local',
          title: `实时录音 · ${formatTime(duration)}`,
          input: {
            audioDataUrl,
            clipName: file.name,
            inputDevice: selectedDeviceLabel,
            outputDevice: '系统默认输出',
          },
          parameters: {
            record: true,
            duration,
            sampleRate,
            inputGain,
            mix,
            bypass,
          },
        })
        onAction('实时处理已停止，WAV 录音已加入素材与运行记录')
      } else {
        await executeHarnessTask({
          capability: 'audio.live',
          providerId: 'local.web-audio',
          routing: 'local',
          title: `实时监听 · ${formatTime(duration)}`,
          input: {
            inputDevice: selectedDeviceLabel,
            outputDevice: '系统默认输出',
          },
          parameters: { record: false, duration, sampleRate },
        })
        onAction('实时监听已停止')
      }
    } catch (error) {
      onAction(
        `录音保存失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const levelWidth = Math.max(
    4,
    Math.min(100, ((levelDb + 60) / 60) * 100),
  )

  return (
    <div className="live-page">
      <div className="page-intro">
        <div>
          <span className="section-kicker">LOW-LATENCY ROUTING</span>
          <h1>实时音频流</h1>
          <p>真实麦克风输入 · 本地 Web Audio 处理 · WAV 录音</p>
        </div>
        <div className={`live-state-pill${isLive ? ' live' : ''}`}>
          <span className="status-dot" />
          {isLive
            ? `Live · ${latencyMs?.toFixed(1) ?? '--'} ms`
            : deviceError
              ? '需要设备权限'
              : 'Ready · 等待连接'}
        </div>
      </div>

      <div className="live-routing-row">
        <label className="routing-select">
          <span className="routing-icon tone-green">
            <Mic2 size={18} />
          </span>
          <span>
            <small>INPUT</small>
            <strong>{selectedDeviceLabel}</strong>
          </span>
          <select
            value={selectedDeviceId}
            disabled={isLive}
            aria-label="输入设备"
            onChange={(event) => setSelectedDeviceId(event.target.value)}
          >
            {!devices.length && <option value="default">系统默认麦克风</option>}
            {devices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `麦克风 ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <span className="route-line">
          <i />
          <Cable size={15} />
          <i />
        </span>
        <div className="routing-processor">
          <span className="routing-icon tone-coral">
            <Sparkles size={18} />
          </span>
          <span>
            <small>CHAIN</small>
            <strong>Voice Clean · 3 个本地节点</strong>
          </span>
          <ShieldCheck size={16} />
        </div>
        <span className="route-line">
          <i />
          <Cable size={15} />
          <i />
        </span>
        <div className="routing-select">
          <span className="routing-icon tone-blue">
            <Headphones size={18} />
          </span>
          <span>
            <small>OUTPUT</small>
            <strong>录音总线 · 不回放</strong>
          </span>
        </div>
      </div>

      <div className={`live-workspace${chainOpen ? ' chain-open' : ''}`}>
        <main className="live-monitor">
          <div className="monitor-header">
            <div>
              <AudioWaveform size={17} />
              <strong>Signal Monitor</strong>
              <span>{sampleRate / 1000} kHz / 2048 samples</span>
            </div>
            <div className="monitor-header-actions">
              <button
                className={`live-chain-toggle${chainOpen ? ' active' : ''}`}
                type="button"
                aria-pressed={chainOpen}
                onClick={() => setChainOpen((value) => !value)}
              >
                <Settings2 size={13} />
                处理链
              </button>
              <button
                className={`monitor-bypass${bypass ? ' active' : ''}`}
                type="button"
                onClick={() => setBypass((value) => !value)}
              >
                {bypass ? 'Bypassed' : 'Processed'}
              </button>
            </div>
          </div>

          <div className="signal-display">
            <div className="signal-grid" />
            <div className={`signal-wave${isLive ? ' active' : ''}`}>
              {meters.map((level, index) => (
                <i key={index} style={{ height: `${level}%` }} />
              ))}
            </div>
            <div className="signal-centerline" />
            <div className="signal-labels">
              <span>-48</span>
              <span>-24</span>
              <span>-12</span>
              <span>-6</span>
              <span>0 dB</span>
            </div>
            <div className="latency-readout">
              <small>AUDIO CONTEXT</small>
              <strong>{latencyMs?.toFixed(1) ?? '--'} ms</strong>
            </div>
          </div>

          <div className="meter-controls">
            <label className="meter-control">
              <span>
                <Mic2 size={15} /> 输入增益
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={inputGain}
                onChange={(event) => setInputGain(Number(event.target.value))}
              />
              <strong>{Math.round((inputGain - 76) / 3)} dB</strong>
            </label>
            <label className="meter-control">
              <span>
                <Waves size={15} /> 压缩混合
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={mix}
                onChange={(event) => setMix(Number(event.target.value))}
              />
              <strong>{mix}%</strong>
            </label>
            <div className="output-meter">
              <span>
                <Volume2 size={15} /> OUT
              </span>
              <i>
                <b style={{ width: `${levelWidth}%` }} />
              </i>
              <strong>{isLive ? levelDb.toFixed(1) : '-∞'} dB</strong>
            </div>
          </div>

          <div className="live-transport">
            <div className="live-clock">
              <span className={isLive ? 'recording-dot' : ''} />
              <strong>{formatTime(elapsed, true)}</strong>
              <small>
                {record ? `REC · WAV ${sampleRate / 1000} kHz` : 'MONITOR ONLY'}
              </small>
            </div>
            <button
              className={`live-main-button${isLive ? ' stop' : ''}`}
              type="button"
              disabled={isStarting}
              onClick={() => void (isLive ? stopLive() : startLive())}
            >
              {isLive ? (
                <>
                  <CircleStop size={18} fill="currentColor" />
                  停止处理
                </>
              ) : (
                <>
                  <Radio size={18} />
                  {isStarting ? '正在连接' : '开始实时处理'}
                </>
              )}
            </button>
            <label className="record-toggle">
              <input
                type="checkbox"
                checked={record}
                disabled={isLive}
                onChange={(event) => setRecord(event.target.checked)}
              />
              <span />
              同时录制
            </label>
          </div>

          {lastRecordingUrl && (
            <div className="last-live-recording">
              <AudioWaveform size={15} />
              <span>上次录音</span>
              <audio controls src={lastRecordingUrl} />
            </div>
          )}
        </main>

        {chainOpen && (
          <aside className="live-chain-panel">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">STREAM CHAIN</span>
                <h2>实时处理链</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭实时处理链"
                title="关闭实时处理链"
                onClick={() => setChainOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="stream-effect-list">
              <div className="stream-effect active">
                <span className="effect-glyph tone-green">
                  <Sparkles size={16} />
                </span>
                <span>
                  <strong>系统语音降噪</strong>
                  <small>MediaTrack · 本地设备</small>
                </span>
                <Activity size={15} />
              </div>
              <div className="stream-effect active">
                <span className="effect-glyph tone-coral">
                  <Waves size={16} />
                </span>
                <span>
                  <strong>动态压缩</strong>
                  <small>Web Audio · 4:1</small>
                </span>
                <Activity size={15} />
              </div>
              <div className="stream-effect active">
                <span className="effect-glyph tone-yellow">
                  <SlidersHorizontal size={16} />
                </span>
                <span>
                  <strong>输入增益</strong>
                  <small>Web Audio · {Math.round((inputGain - 76) / 3)} dB</small>
                </span>
                <Activity size={15} />
              </div>
            </div>

            <button
              className="add-effect-button"
              type="button"
              onClick={onOpenPlugins}
            >
              <CirclePlus size={16} /> 添加实时处理器
            </button>

            <div className="stream-diagnostics">
              <div>
                <span>
                  <Wifi size={14} /> Run API
                </span>
                <strong>127.0.0.1:3847</strong>
              </div>
              <div>
                <span>
                  <HardDrive size={14} /> Buffer
                </span>
                <strong>4096 samples</strong>
              </div>
              <div>
                <span>
                  <Gauge size={14} /> Context
                </span>
                <strong>{isLive ? 'Active' : 'Idle'}</strong>
              </div>
            </div>

            <div className="secondary-action full-width static-value">
              <Cable size={16} /> 虚拟音频设备未连接
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
