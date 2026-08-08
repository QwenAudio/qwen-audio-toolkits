import { useEffect, useRef, useState } from 'react'
import { formatTime } from '../utils/audio'

interface RecordingWaveformProps {
  active: boolean
  stream?: MediaStream | null
  label: string
}

export function RecordingWaveform({
  active,
  stream,
  label,
}: RecordingWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const startedAtRef = useRef(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0)
      return
    }

    startedAtRef.current = performance.now()
    const updateElapsed = () =>
      setElapsedSeconds(
        Math.floor((performance.now() - startedAtRef.current) / 1000),
      )
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 250)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (!active) return

    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    let animationFrame = 0
    let audioContext: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    let samples: Uint8Array<ArrayBuffer> | null = null
    const startedAt = performance.now()

    if (stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      audioContext = new AudioContext({ latencyHint: 'interactive' })
      source = audioContext.createMediaStreamSource(stream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      samples = new Uint8Array(analyser.frequencyBinCount)
      source.connect(analyser)
      void audioContext.resume()
    }

    const draw = (now: number) => {
      const bounds = canvas.getBoundingClientRect()
      const pixelRatio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(bounds.width * pixelRatio))
      const height = Math.max(1, Math.round(bounds.height * pixelRatio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      context.clearRect(0, 0, width, height)
      context.lineWidth = Math.max(1.5, 1.5 * pixelRatio)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.strokeStyle = getComputedStyle(canvas).color
      context.beginPath()

      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples)
        const step = width / Math.max(1, samples.length - 1)
        for (let index = 0; index < samples.length; index += 1) {
          const x = index * step
          const normalized = (samples[index] - 128) / 128
          const y = height / 2 + normalized * height * 0.42
          if (index === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
      } else {
        const phase = (now - startedAt) / 180
        const points = Math.max(24, Math.floor(bounds.width / 5))
        for (let index = 0; index < points; index += 1) {
          const progress = index / Math.max(1, points - 1)
          const envelope = 0.35 + Math.sin(progress * Math.PI) * 0.65
          const wave =
            Math.sin(progress * 20 + phase) * 0.16 +
            Math.sin(progress * 43 - phase * 0.7) * 0.06
          const x = progress * width
          const y = height / 2 + wave * envelope * height
          if (index === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
      }

      context.stroke()
      animationFrame = window.requestAnimationFrame(draw)
    }

    animationFrame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      source?.disconnect()
      analyser?.disconnect()
      if (audioContext) void audioContext.close()
    }
  }, [active, stream])

  if (!active) return null

  return (
    <div className="recording-waveform" aria-label={label}>
      <span className="recording-waveform-state">
        <i aria-hidden="true" />
        {label}
      </span>
      <canvas ref={canvasRef} />
      <time>{formatTime(elapsedSeconds)}</time>
    </div>
  )
}
