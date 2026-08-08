import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Volume2 } from 'lucide-react'
import WaveSurfer from 'wavesurfer.js'
import type { GenericPlugin } from 'wavesurfer.js/dist/base-plugin.js'
import Hover from 'wavesurfer.js/dist/plugins/hover.esm.js'
import Minimap from 'wavesurfer.js/dist/plugins/minimap.esm.js'
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js'
import Timeline from 'wavesurfer.js/dist/plugins/timeline.esm.js'
import { Spectrogram as MelSpectrogram } from './Spectrogram'

export interface AudioPreviewRegion {
  id: string
  start: number
  end: number
  label?: string
  color?: string
}

interface AudioPreviewProps {
  src: string
  peaks?: number[]
  durationHint?: number
  regions?: AudioPreviewRegion[]
  showSpectrogram?: boolean
  waveformHeight?: number
  spectrogramHeight?: number
  minPixelsPerSecond?: number
  showMinimap?: boolean
  minimal?: boolean
  seekTime?: number
  playRange?: {
    start: number
    end: number
    requestId: number
  }
  onTimeChange?: (seconds: number) => void
}

const EMPTY_REGIONS: AudioPreviewRegion[] = []

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function addRegions(
  plugin: ReturnType<typeof Regions.create>,
  regions: AudioPreviewRegion[],
) {
  regions.forEach((region) => {
    plugin.addRegion({
      id: region.id,
      start: region.start,
      end: region.end,
      content: region.label,
      color: region.color ?? 'rgba(255, 255, 255, 0.16)',
      drag: false,
      resize: false,
    })
  })
}

export function AudioPreview({
  src,
  peaks,
  durationHint,
  regions = EMPTY_REGIONS,
  showSpectrogram = false,
  waveformHeight = 96,
  spectrogramHeight = 220,
  minPixelsPerSecond = 0,
  showMinimap = false,
  minimal = false,
  seekTime,
  playRange,
  onTimeChange,
}: AudioPreviewProps) {
  const waveformRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const waveSurferRef = useRef<WaveSurfer | null>(null)
  const regionPluginRef = useRef<ReturnType<typeof Regions.create> | null>(null)
  const regionsRef = useRef(regions)
  const onTimeChangeRef = useRef(onTimeChange)
  const lastTimeUpdateRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showDeferredSpectrogram, setShowDeferredSpectrogram] = useState(false)
  const regionsKey = useMemo(
    () =>
      regions
        .map(
          (region) =>
            `${region.id}:${region.start}:${region.end}:${region.label ?? ''}:${region.color ?? ''}`,
        )
        .join('|'),
    [regions],
  )
  const normalizedPeaks = useMemo(
    () => (peaks?.length ? [Float32Array.from(peaks)] : undefined),
    [peaks],
  )

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange
  }, [onTimeChange])

  useEffect(() => {
    regionsRef.current = regions
  }, [regions])

  useEffect(() => {
    const waveform = waveformRef.current
    const timeline = timelineRef.current
    if (!waveform || (!minimal && !timeline) || !src) return undefined

    setReady(false)
    setPlaying(false)
    setCurrentTime(0)
    setShowDeferredSpectrogram(false)

    const regionPlugin = Regions.create()
    regionPluginRef.current = regionPlugin
    const plugins: GenericPlugin[] = [regionPlugin]
    if (!minimal && timeline) {
      plugins.push(
        Timeline.create({
          container: timeline,
          height: 18,
          style: {
            color: '#8d9690',
            fontSize: '9px',
            backgroundColor: '#080a09',
          },
        }),
        Hover.create({
          lineColor: '#f4fff9',
          labelBackground: '#111713',
          labelColor: '#dff8e9',
          labelSize: 10,
        }),
      )
    }

    if (showMinimap) {
      plugins.push(
        Minimap.create({
          height: 34,
          waveColor: 'rgba(255, 255, 255, 0.58)',
          progressColor: 'rgba(255, 255, 255, 0.94)',
          cursorColor: '#ef4444',
          cursorWidth: 1,
          overlayColor: 'transparent',
          hideScrollbar: true,
        }),
      )
    }

    const instance = WaveSurfer.create({
      container: waveform,
      url: src,
      backend: 'MediaElement',
      peaks: normalizedPeaks,
      duration: durationHint,
      height: waveformHeight,
      waveColor: '#2fcf78',
      progressColor: '#8af2b8',
      cursorColor: '#ef4444',
      cursorWidth: 1,
      minPxPerSec: minPixelsPerSecond,
      autoScroll: true,
      autoCenter: true,
      hideScrollbar: true,
      normalize: true,
      dragToSeek: true,
      plugins,
    })
    waveSurferRef.current = instance

    const removeReady = instance.on('ready', (nextDuration) => {
      setDuration(nextDuration)
      setReady(true)
      regionPlugin.clearRegions()
      addRegions(regionPlugin, regionsRef.current)
    })
    const removeTime = instance.on('timeupdate', (seconds) => {
      const now = performance.now()
      if (now - lastTimeUpdateRef.current < 50) return
      lastTimeUpdateRef.current = now
      setCurrentTime(seconds)
      onTimeChangeRef.current?.(seconds)
    })
    const removePlay = instance.on('play', () => setPlaying(true))
    const removePause = instance.on('pause', () => setPlaying(false))
    const removeFinish = instance.on('finish', () => setPlaying(false))
    const removeRegionClick = regionPlugin.on('region-clicked', (region) => {
      instance.setTime(region.start)
    })

    return () => {
      removeReady()
      removeTime()
      removePlay()
      removePause()
      removeFinish()
      removeRegionClick()
      instance.destroy()
      waveSurferRef.current = null
      regionPluginRef.current = null
    }
  }, [
    showMinimap,
    src,
    waveformHeight,
    minPixelsPerSecond,
    minimal,
    normalizedPeaks,
    durationHint,
  ])

  useEffect(() => {
    if (!ready || !showSpectrogram) return undefined
    const schedule =
      window.requestIdleCallback ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () => callback({ didTimeout: false, timeRemaining: () => 0 }),
          120,
        ))
    const cancel =
      window.cancelIdleCallback ??
      ((handle: number) => window.clearTimeout(handle))
    const handle = schedule(() => setShowDeferredSpectrogram(true), {
      timeout: 500,
    })
    return () => cancel(handle)
  }, [ready, showSpectrogram, src])

  useEffect(() => {
    const plugin = regionPluginRef.current
    if (!ready || !plugin) return
    plugin.clearRegions()
    addRegions(plugin, regionsRef.current)
  }, [ready, regionsKey])

  useEffect(() => {
    if (seekTime === undefined || !waveSurferRef.current) return
    waveSurferRef.current.setTime(seekTime)
  }, [seekTime])

  useEffect(() => {
    if (!ready || !playRange || !waveSurferRef.current) return
    const start = Math.max(0, playRange.start)
    const end = Math.max(start, playRange.end)
    waveSurferRef.current.setTime(start)
    void waveSurferRef.current.play(start, end)
  }, [playRange, ready])

  return (
    <div className="audio-preview">
      <div className="audio-preview-waveform" ref={waveformRef} />
      {!minimal && <div className="audio-preview-timeline" ref={timelineRef} />}
      {showSpectrogram && (
        <div
          className="audio-preview-spectrogram"
          style={{ height: spectrogramHeight }}
        >
          {showDeferredSpectrogram && (
            <MelSpectrogram
              audioUrl={src}
              progress={duration ? currentTime / duration : 0}
              onSeek={(ratio) =>
                waveSurferRef.current?.setTime(ratio * duration)
              }
            />
          )}
        </div>
      )}
      <div className="audio-preview-controls">
        <button
          type="button"
          title={playing ? '暂停' : '播放'}
          aria-label={playing ? '暂停' : '播放'}
          disabled={!ready}
          onClick={() => void waveSurferRef.current?.playPause()}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span>{formatTime(currentTime)}</span>
        <div className="audio-preview-progress">
          <i
            style={{
              width: `${duration ? (currentTime / duration) * 100 : 0}%`,
            }}
          />
        </div>
        <span>{formatTime(duration)}</span>
        <Volume2 size={15} />
      </div>
    </div>
  )
}
