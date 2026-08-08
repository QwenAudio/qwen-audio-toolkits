import { useEffect, useRef, useState } from 'react'

interface SpectrogramProps {
  audioUrl?: string
  progress?: number
  selection?: [number, number]
  onSeek?: (ratio: number) => void
  onSelectionChange?: (selection: [number, number]) => void
}

interface SpectrogramData {
  width: number
  height: number
  duration: number
  maxFrequency: number
  pixels: Uint8ClampedArray
}

interface MelFilter {
  start: number
  center: number
  end: number
  weightSum: number
}

const cache = new Map<string, SpectrogramData>()
const CACHE_VERSION = 'v6-mel-axes'
const FFT_SIZE = 1024
const MIN_FRAMES = 320
const MAX_FRAMES = 768
const FRAMES_PER_SECOND = 48
const MEL_BANDS = 128
const HANN_WINDOW = Float64Array.from(
  { length: FFT_SIZE },
  (_, index) =>
    0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1)),
)

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1
    for (; reversed & bit; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index < reversed) {
      ;[real[index], real[reversed]] = [real[reversed], real[index]]
      ;[imaginary[index], imaginary[reversed]] = [
        imaginary[reversed],
        imaginary[index],
      ]
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const phaseReal = Math.cos(angle)
    const phaseImaginary = Math.sin(angle)
    for (let offset = 0; offset < size; offset += length) {
      let rotationReal = 1
      let rotationImaginary = 0
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index
        const odd = even + length / 2
        const oddReal =
          real[odd] * rotationReal - imaginary[odd] * rotationImaginary
        const oddImaginary =
          real[odd] * rotationImaginary + imaginary[odd] * rotationReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextRotationReal =
          rotationReal * phaseReal - rotationImaginary * phaseImaginary
        rotationImaginary =
          rotationReal * phaseImaginary + rotationImaginary * phaseReal
        rotationReal = nextRotationReal
      }
    }
  }
}

function colorForEnergy(
  energy: number,
): [red: number, green: number, blue: number] {
  const stops = [
    [18, 19, 32],
    [62, 58, 122],
    [108, 83, 194],
    [229, 104, 116],
    [255, 205, 131],
    [255, 246, 224],
  ]
  const position = Math.min(0.999, Math.max(0, energy)) * (stops.length - 1)
  const index = Math.floor(position)
  const mix = position - index
  return stops[index].map((value, channel) =>
    Math.round(value + (stops[index + 1][channel] - value) * mix),
  ) as [number, number, number]
}

function hzToMel(hertz: number): number {
  return 2595 * Math.log10(1 + hertz / 700)
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

function createMelFilters(sampleRate: number): MelFilter[] {
  const maxBin = FFT_SIZE / 2 - 1
  const minMel = hzToMel(20)
  const maxMel = hzToMel(sampleRate / 2)
  const bins = Array.from({ length: MEL_BANDS + 2 }, (_, index) => {
    const mel =
      minMel + ((maxMel - minMel) * index) / (MEL_BANDS + 1)
    return Math.max(
      1,
      Math.min(
        maxBin,
        Math.floor(((FFT_SIZE + 1) * melToHz(mel)) / sampleRate),
      ),
    )
  })

  return Array.from({ length: MEL_BANDS }, (_, index) => {
    const start = Math.min(maxBin - 2, bins[index])
    const center = Math.min(
      maxBin - 1,
      Math.max(start + 1, bins[index + 1]),
    )
    const end = Math.min(
      maxBin,
      Math.max(center + 1, bins[index + 2]),
    )
    let weightSum = 0
    for (let bin = start; bin <= center; bin += 1) {
      weightSum += (bin - start) / Math.max(1, center - start)
    }
    for (let bin = center + 1; bin < end; bin += 1) {
      weightSum += (end - bin) / Math.max(1, end - center)
    }
    return { start, center, end, weightSum: Math.max(1, weightSum) }
  })
}

function computeSpectrogram(buffer: AudioBuffer): SpectrogramData {
  const samples = buffer.getChannelData(0)
  const width = Math.max(
    MIN_FRAMES,
    Math.min(
      MAX_FRAMES,
      Math.ceil(buffer.duration * FRAMES_PER_SECOND),
    ),
  )
  const height = MEL_BANDS
  const hop = Math.max(1, Math.floor(samples.length / width))
  const pixels = new Uint8ClampedArray(width * height * 4)
  const real = new Float64Array(FFT_SIZE)
  const imaginary = new Float64Array(FFT_SIZE)
  const powerSpectrum = new Float64Array(FFT_SIZE / 2)
  const melFilters = createMelFilters(buffer.sampleRate)
  const powerScale = FFT_SIZE * FFT_SIZE

  for (let frame = 0; frame < width; frame += 1) {
    const start = Math.min(
      Math.max(0, samples.length - FFT_SIZE),
      frame * hop,
    )
    imaginary.fill(0)
    for (let index = 0; index < FFT_SIZE; index += 1) {
      real[index] =
        (samples[start + index] ?? 0) * HANN_WINDOW[index]
    }
    fft(real, imaginary)
    for (let bin = 1; bin < FFT_SIZE / 2; bin += 1) {
      powerSpectrum[bin] =
        (real[bin] * real[bin] +
          imaginary[bin] * imaginary[bin]) /
        powerScale
    }

    for (let band = 0; band < MEL_BANDS; band += 1) {
      const filter = melFilters[band]
      let melPower = 0
      for (let bin = filter.start; bin <= filter.center; bin += 1) {
        const weight =
          (bin - filter.start) /
          Math.max(1, filter.center - filter.start)
        melPower += powerSpectrum[bin] * weight
      }
      for (
        let bin = filter.center + 1;
        bin < filter.end;
        bin += 1
      ) {
        const weight =
          (filter.end - bin) /
          Math.max(1, filter.end - filter.center)
        melPower += powerSpectrum[bin] * weight
      }
      melPower /= filter.weightSum
      const decibels = 10 * Math.log10(melPower + 1e-12)
      const energy = Math.pow(
        Math.min(1, Math.max(0, (decibels + 78) / 72)),
        0.8,
      )
      const [red, green, blue] = colorForEnergy(energy)
      const row = MEL_BANDS - 1 - band
      const offset = (row * width + frame) * 4
      pixels[offset] = red
      pixels[offset + 1] = green
      pixels[offset + 2] = blue
      pixels[offset + 3] = 255
    }
  }
  return {
    width,
    height,
    duration: buffer.duration,
    maxFrequency: buffer.sampleRate / 2,
    pixels,
  }
}

function formatAxisTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function frequencyTicks(maxFrequency: number): number[] {
  const candidates = [0, 2_000, 4_000, 8_000, 16_000, 24_000]
  const ticks = candidates.filter((frequency) => frequency < maxFrequency)
  ticks.push(maxFrequency)
  if (ticks.length <= 4) return ticks
  return ticks.filter(
    (_, index) => index === 0 || index === ticks.length - 1 || index % 2 === 0,
  )
}

function audioFingerprint(audioUrl: string): string {
  const sampleCount = 32
  let hash = 2166136261
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = Math.floor(
      (index * Math.max(0, audioUrl.length - 1)) /
        Math.max(1, sampleCount - 1),
    )
    hash ^= audioUrl.charCodeAt(offset)
    hash = Math.imul(hash, 16777619)
  }
  return `${audioUrl.length}:${(hash >>> 0).toString(16)}`
}

function decodeDataUrl(audioUrl: string): ArrayBuffer | null {
  if (!audioUrl.startsWith('data:')) return null
  const separator = audioUrl.indexOf(',')
  if (separator < 0) throw new Error('音频 data URL 缺少内容')
  const metadata = audioUrl.slice(0, separator)
  const payload = audioUrl.slice(separator + 1)
  if (!metadata.toLowerCase().includes(';base64')) {
    return new TextEncoder().encode(decodeURIComponent(payload)).buffer
  }
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

async function readAudioBytes(audioUrl: string): Promise<ArrayBuffer> {
  const inline = decodeDataUrl(audioUrl)
  if (inline) return inline
  const response = await fetch(audioUrl)
  if (!response.ok) {
    throw new Error(`音频请求失败: ${response.status}`)
  }
  return response.arrayBuffer()
}

export function Spectrogram({
  audioUrl,
  progress = 0,
  selection,
  onSeek,
  onSelectionChange,
}: SpectrogramProps) {
  const cacheKey = audioUrl
    ? `${CACHE_VERSION}:${audioFingerprint(audioUrl)}`
    : ''
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef<(() => void) | null>(null)
  const progressRef = useRef(progress)
  const selectionRef = useRef(selection)
  const dragStartRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const [data, setData] = useState<SpectrogramData | null>(
    cacheKey ? cache.get(cacheKey) ?? null : null,
  )
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    audioUrl ? (data ? 'ready' : 'loading') : 'idle',
  )

  useEffect(() => {
    if (!audioUrl) {
      setData(null)
      setStatus('idle')
      return undefined
    }
    const cached = cache.get(cacheKey)
    if (cached) {
      setData(cached)
      setStatus('ready')
      return undefined
    }

    let disposed = false
    setStatus('loading')
    const context = new AudioContext()
    const closeContext = () => {
      if (context.state !== 'closed') {
        void context.close().catch(() => undefined)
      }
    }
    void readAudioBytes(audioUrl)
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => computeSpectrogram(buffer))
      .then((next) => {
        if (disposed) return
        if (cache.size >= 8) {
          const oldestKey = cache.keys().next().value
          if (oldestKey) cache.delete(oldestKey)
        }
        cache.set(cacheKey, next)
        setData(next)
        setStatus('ready')
      })
      .catch(() => {
        if (!disposed) setStatus('error')
      })
      .finally(closeContext)

    return () => {
      disposed = true
      closeContext()
    }
  }, [audioUrl, cacheKey])

  useEffect(() => {
    progressRef.current = progress
    selectionRef.current = selection
    drawRef.current?.()
  }, [progress, selection])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return undefined

    const image = new ImageData(data.width, data.height)
    image.data.set(data.pixels)
    const baseCanvas = document.createElement('canvas')
    baseCanvas.width = data.width
    baseCanvas.height = data.height
    baseCanvas.getContext('2d')?.putImageData(image, 0, 0)

    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * scale))
      canvas.height = Math.max(1, Math.floor(rect.height * scale))
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.imageSmoothingEnabled = false

      context.drawImage(baseCanvas, 0, 0, rect.width, rect.height)

      const normalizedProgress = Math.min(
        1,
        Math.max(0, progressRef.current),
      )
      const playheadX = normalizedProgress * rect.width
      context.fillStyle = 'rgba(16, 16, 28, 0.2)'
      context.fillRect(playheadX, 0, rect.width - playheadX, rect.height)

      const currentSelection = selectionRef.current
      if (
        currentSelection &&
        currentSelection[1] - currentSelection[0] > 0.001
      ) {
        const start = currentSelection[0] * rect.width
        const width =
          (currentSelection[1] - currentSelection[0]) * rect.width
        context.fillStyle = 'rgba(255, 118, 95, 0.15)'
        context.fillRect(start, 0, width, rect.height)
        context.strokeStyle = 'rgba(255, 118, 95, 0.9)'
        context.strokeRect(start, 0.5, width, rect.height - 1)
      }

      context.save()
      context.font = '10px SFMono-Regular, Consolas, monospace'
      context.lineWidth = 1
      context.strokeStyle = 'rgba(255, 255, 255, 0.15)'
      context.fillStyle = 'rgba(255, 255, 255, 0.72)'
      context.textBaseline = 'bottom'
      const timeTickCount = rect.width < 420 ? 3 : 4
      for (let index = 0; index < timeTickCount; index += 1) {
        const ratio = index / (timeTickCount - 1)
        const x = Math.round(ratio * rect.width) + 0.5
        context.beginPath()
        context.moveTo(x, 0)
        context.lineTo(x, rect.height)
        context.stroke()
        context.textAlign =
          index === 0 ? 'left' : index === timeTickCount - 1 ? 'right' : 'center'
        context.fillText(
          formatAxisTime(data.duration * ratio),
          Math.min(rect.width - 4, Math.max(4, x)),
          rect.height - 4,
        )
      }

      const minMel = hzToMel(20)
      const maxMel = hzToMel(data.maxFrequency)
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      for (const frequency of frequencyTicks(data.maxFrequency)) {
        const mel = hzToMel(Math.max(20, frequency))
        const ratio = (mel - minMel) / Math.max(1, maxMel - minMel)
        const y = Math.min(rect.height - 9, Math.max(9, (1 - ratio) * rect.height))
        context.beginPath()
        context.moveTo(0, Math.round(y) + 0.5)
        context.lineTo(rect.width, Math.round(y) + 0.5)
        context.stroke()
        const label =
          frequency === 0
            ? '0'
            : `${Number((frequency / 1000).toFixed(1))}k`
        context.fillText(label, 5, y)
      }
      context.restore()

      context.fillStyle = '#ef4444'
      context.fillRect(Math.max(0, playheadX - 1), 0, 2, rect.height)
    }

    drawRef.current = draw
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => {
      observer.disconnect()
      drawRef.current = null
    }
  }, [data])

  const ratioFromPointer = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  if (status !== 'ready') {
    return (
      <div className="spectrogram-state" role="status">
        {status === 'loading'
          ? '正在分析 Mel 频谱…'
          : status === 'error'
            ? '无法读取该音频的 Mel 频谱'
            : '导入真实音频后可查看 Mel 频谱'}
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className="spectrogram-canvas"
      role="slider"
      aria-label="音频 Mel 频谱图"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        const ratio = ratioFromPointer(event.clientX)
        if (!onSelectionChange) {
          onSeek?.(ratio)
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        dragStartRef.current = ratio
        draggingRef.current = false
      }}
      onPointerMove={(event) => {
        const start = dragStartRef.current
        if (start === null || !onSelectionChange) return
        const ratio = ratioFromPointer(event.clientX)
        if (Math.abs(ratio - start) < 0.004 && !draggingRef.current) return
        draggingRef.current = true
        onSelectionChange([Math.min(start, ratio), Math.max(start, ratio)])
      }}
      onPointerUp={(event) => {
        const start = dragStartRef.current
        if (start === null) return
        const ratio = ratioFromPointer(event.clientX)
        if (draggingRef.current) {
          onSelectionChange?.([Math.min(start, ratio), Math.max(start, ratio)])
        } else {
          onSeek?.(ratio)
        }
        dragStartRef.current = null
        draggingRef.current = false
      }}
      onPointerCancel={() => {
        dragStartRef.current = null
        draggingRef.current = false
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onSeek?.(Math.max(0, progress - 0.02))
        if (event.key === 'ArrowRight') onSeek?.(Math.min(1, progress + 0.02))
      }}
    />
  )
}
