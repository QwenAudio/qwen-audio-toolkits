import { useEffect, useRef } from 'react'

interface WaveformProps {
  samples: number[]
  progress?: number
  selection?: [number, number]
  regions?: [number, number][]
  color?: string
  compact?: boolean
  label?: string
  onSeek?: (ratio: number) => void
  onSelectionChange?: (selection: [number, number]) => void
}

export function Waveform({
  samples,
  progress = 0,
  selection,
  regions = [],
  color = '#827df8',
  compact = false,
  label = '音频波形',
  onSeek,
  onSelectionChange,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragStartRef = useRef<number | null>(null)
  const draggingSelectionRef = useRef(false)
  const hasPlayhead = !compact || Boolean(onSeek)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * scale))
      canvas.height = Math.max(1, Math.floor(rect.height * scale))

      const context = canvas.getContext('2d')
      if (!context) return

      context.scale(scale, scale)
      const width = rect.width
      const height = rect.height
      const center = height / 2
      const gap = compact ? 2 : 2.5
      const barWidth = Math.max(1, width / samples.length - gap)

      context.clearRect(0, 0, width, height)

      for (const region of regions) {
        const start = Math.min(1, Math.max(0, region[0]))
        const end = Math.min(1, Math.max(start, region[1]))
        context.fillStyle = 'rgba(124, 117, 244, 0.14)'
        context.fillRect(start * width, 0, (end - start) * width, height)
      }

      if (selection && selection[1] - selection[0] > 0.001) {
        const selectionX = selection[0] * width
        const selectionWidth = (selection[1] - selection[0]) * width
        context.fillStyle = 'rgba(255, 118, 95, 0.11)'
        context.fillRect(selectionX, 0, selectionWidth, height)
        context.strokeStyle = 'rgba(255, 118, 95, 0.62)'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(selectionX, 0)
        context.lineTo(selectionX, height)
        context.moveTo(selectionX + selectionWidth, 0)
        context.lineTo(selectionX + selectionWidth, height)
        context.stroke()
      }

      const drawBars = (
        fill: string,
        from: number,
        to: number,
        opacity = 1,
      ) => {
        context.save()
        context.beginPath()
        context.rect(from * width, 0, Math.max(0, (to - from) * width), height)
        context.clip()
        context.beginPath()
        context.fillStyle = fill
        context.globalAlpha = opacity

        samples.forEach((sample, index) => {
          const x = (index / samples.length) * width
          const amplitude = Math.max(
            compact ? 2 : 4,
            sample * height * (compact ? 0.78 : 0.72),
          )
          const y = center - amplitude / 2
          context.roundRect(x, y, barWidth, amplitude, barWidth / 2)
        })
        context.fill()
        context.restore()
      }

      const normalizedProgress = Math.min(1, Math.max(0, progress))
      drawBars(compact ? color : '#323735', 0, 1, compact ? 0.42 : 1)
      drawBars(color, 0, normalizedProgress)

      if (hasPlayhead) {
        const playheadX = Math.min(
          width - 1,
          Math.max(1, normalizedProgress * width),
        )
        context.fillStyle = compact ? '#f3f7f4' : color
        context.fillRect(
          playheadX - (compact ? 1 : 0.75),
          compact ? 1 : 0,
          compact ? 2 : 1.5,
          compact ? height - 2 : height,
        )
        context.beginPath()
        if (compact) {
          context.arc(playheadX, 3, 2.5, 0, Math.PI * 2)
        } else {
          context.moveTo(playheadX - 4, 0)
          context.lineTo(playheadX + 4, 0)
          context.lineTo(playheadX, 6)
          context.closePath()
        }
        context.fill()
      }
    }

    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()

    return () => observer.disconnect()
  }, [color, compact, hasPlayhead, progress, regions, samples, selection])

  const ratioFromPointer = (clientX: number) => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  return (
    <canvas
      ref={canvasRef}
      className={`waveform-canvas${compact ? ' waveform-canvas--compact' : ''}`}
      role={onSeek ? 'slider' : 'img'}
      aria-label={label}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      data-selectable={onSelectionChange ? 'true' : undefined}
      onPointerDown={(event) => {
        const ratio = ratioFromPointer(event.clientX)
        if (!onSelectionChange || compact) {
          onSeek?.(ratio)
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        dragStartRef.current = ratio
        draggingSelectionRef.current = false
      }}
      onPointerMove={(event) => {
        const start = dragStartRef.current
        if (start === null || !onSelectionChange) return
        const ratio = ratioFromPointer(event.clientX)
        if (Math.abs(ratio - start) < 0.004 && !draggingSelectionRef.current) {
          return
        }
        draggingSelectionRef.current = true
        onSelectionChange([Math.min(start, ratio), Math.max(start, ratio)])
      }}
      onPointerUp={(event) => {
        const start = dragStartRef.current
        if (start === null) return
        const ratio = ratioFromPointer(event.clientX)
        if (draggingSelectionRef.current) {
          onSelectionChange?.([Math.min(start, ratio), Math.max(start, ratio)])
        } else {
          onSeek?.(ratio)
        }
        dragStartRef.current = null
        draggingSelectionRef.current = false
      }}
      onPointerCancel={() => {
        dragStartRef.current = null
        draggingSelectionRef.current = false
      }}
      onKeyDown={(event) => {
        if (!onSeek) return
        if (event.key === 'ArrowLeft') onSeek(Math.max(0, progress - 0.02))
        if (event.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.02))
      }}
    />
  )
}
