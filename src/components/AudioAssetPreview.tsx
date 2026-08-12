import { useEffect, useRef, useState } from 'react'
import {
  AudioPreview,
  type AudioPreviewRegion,
} from './AudioPreview'

interface AudioAssetPreviewProps {
  src: string
  spectrogramSrc?: string
  peaks?: number[]
  duration?: number
  sampleRate?: number
  role: 'input' | 'output' | 'timeline'
  size?: 'compact' | 'detail'
  regions?: AudioPreviewRegion[]
  waveformHeight?: number
  minPixelsPerSecond?: number
  showMinimap?: boolean
  seekTime?: number
  playRange?: {
    start: number
    end: number
    requestId: number
  }
  onTimeChange?: (seconds: number) => void
}

export function AudioAssetPreview({
  src,
  spectrogramSrc,
  peaks,
  duration,
  sampleRate,
  role,
  size = 'detail',
  regions,
  waveformHeight,
  minPixelsPerSecond,
  showMinimap,
  seekTime,
  playRange,
  onTimeChange,
}: AudioAssetPreviewProps) {
  const compact = size === 'compact'
  const timeline = role === 'timeline'
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!compact)

  useEffect(() => {
    if (!compact) {
      setVisible(true)
      return undefined
    }
    const container = containerRef.current
    if (!container || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting)
      },
      { rootMargin: '180px 0px' },
    )
    observer.observe(container)
    return () => observer.disconnect()
  }, [compact, src])

  return (
    <div
      ref={containerRef}
      className={`audio-asset-preview role-${role} size-${size}`}
    >
      {visible && (
        <AudioPreview
          src={src}
          spectrogramSrc={spectrogramSrc}
          peaks={peaks}
          durationHint={duration}
          sampleRate={sampleRate}
          regions={regions}
          showSpectrogram={role === 'output' && !compact}
          waveformHeight={waveformHeight ?? 64}
          spectrogramHeight={compact ? 72 : 96}
          minPixelsPerSecond={minPixelsPerSecond ?? (timeline ? 48 : 0)}
          showMinimap={showMinimap ?? timeline}
          minimal={compact}
          seekTime={seekTime}
          playRange={playRange}
          onTimeChange={onTimeChange}
        />
      )}
    </div>
  )
}
