import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'

interface InlineAudioPlayerProps {
  src: string
  comparisonSrc?: string
  primaryLabel?: string
  comparisonLabel?: string
  duration?: number
  startTime?: number
  endTime?: number
  onTimeChange?: (currentTime: number, duration: number) => void
  onAbsoluteTimeChange?: (currentTime: number) => void
}

function formatPlayerTime(seconds: number, roundUp = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const wholeSeconds =
    roundUp && seconds > 0 ? Math.ceil(seconds) : Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remaining = wholeSeconds % 60
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

export function InlineAudioPlayer({
  src,
  comparisonSrc,
  primaryLabel = '增强',
  comparisonLabel = '原声',
  duration = 0,
  startTime = 0,
  endTime,
  onTimeChange,
  onAbsoluteTimeChange,
}: InlineAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const lastProgressUpdateRef = useRef(0)
  const pendingSourceSwitchRef = useRef<{
    currentTime: number
    resume: boolean
  } | null>(null)
  const [activeSource, setActiveSource] = useState<'primary' | 'comparison'>(
    'primary',
  )
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [resolvedDuration, setResolvedDuration] = useState(duration)

  const stopProgressAnimation = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }

  const updateProgress = () => {
    const audio = audioRef.current
    if (!audio) {
      stopProgressAnimation()
      return
    }
    const now = performance.now()
    if (now - lastProgressUpdateRef.current >= 50) {
      lastProgressUpdateRef.current = now
      setCurrentTime(audio.currentTime)
      onTimeChange?.(audio.currentTime, audio.duration || resolvedDuration)
      onAbsoluteTimeChange?.(audio.currentTime)
    }
    if (!audio.paused && !audio.ended) {
      animationFrameRef.current = requestAnimationFrame(updateProgress)
    } else {
      stopProgressAnimation()
    }
  }

  useEffect(() => {
    setPlaying(false)
    setActiveSource('primary')
    setCurrentTime(startTime)
    setResolvedDuration(endTime ? endTime - startTime : duration)
    stopProgressAnimation()
  }, [comparisonSrc, duration, endTime, src, startTime])

  useEffect(
    () => () => {
      stopProgressAnimation()
    },
    [],
  )

  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      if (
        audio.currentTime < startTime ||
        (endTime !== undefined && audio.currentTime >= endTime)
      ) {
        audio.currentTime = startTime
      }
      onAbsoluteTimeChange?.(audio.currentTime)
      void audio.play()
    } else {
      audio.pause()
    }
  }

  const totalDuration =
    endTime !== undefined
      ? Math.max(0, endTime - startTime)
      : resolvedDuration || audioRef.current?.duration || duration
  const relativeCurrentTime = Math.max(0, currentTime - startTime)
  const progress =
    totalDuration > 0
      ? Math.min(100, Math.max(0, (relativeCurrentTime / totalDuration) * 100))
      : 0
  const playbackReachedEnd =
    totalDuration > 0 && relativeCurrentTime >= totalDuration - 0.01

  return (
    <div className="inline-audio-player">
      <audio
        ref={audioRef}
        preload="metadata"
        src={
          activeSource === 'comparison' && comparisonSrc
            ? comparisonSrc
            : src
        }
        muted={muted}
        onLoadedMetadata={(event) => {
          const pending = pendingSourceSwitchRef.current
          event.currentTarget.currentTime = pending?.currentTime ?? startTime
          pendingSourceSwitchRef.current = null
          if (Number.isFinite(event.currentTarget.duration)) {
            setResolvedDuration(
              endTime
                ? Math.max(0, endTime - startTime)
                : event.currentTarget.duration,
            )
            onTimeChange?.(
              event.currentTarget.currentTime,
              event.currentTarget.duration,
            )
          }
          if (pending?.resume) void event.currentTarget.play()
        }}
        onPlay={() => {
          setPlaying(true)
          stopProgressAnimation()
          lastProgressUpdateRef.current = 0
          animationFrameRef.current = requestAnimationFrame(updateProgress)
        }}
        onTimeUpdate={(event) => {
          if (
            endTime !== undefined &&
            event.currentTarget.currentTime >= endTime
          ) {
            event.currentTarget.pause()
            event.currentTarget.currentTime = startTime
            setCurrentTime(startTime)
          }
        }}
        onPause={(event) => {
          setPlaying(false)
          setCurrentTime(event.currentTarget.currentTime)
          onTimeChange?.(
            event.currentTarget.currentTime,
            event.currentTarget.duration || resolvedDuration,
          )
          onAbsoluteTimeChange?.(event.currentTarget.currentTime)
          stopProgressAnimation()
        }}
        onEnded={() => {
          setPlaying(false)
          setCurrentTime(totalDuration)
          onTimeChange?.(totalDuration, totalDuration)
          stopProgressAnimation()
        }}
      />
      <button
        type="button"
        title={playing ? '暂停' : '播放'}
        aria-label={playing ? '暂停' : '播放'}
        onClick={togglePlayback}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {comparisonSrc && (
        <div className="audio-comparison-switch" aria-label="音频对比">
          {(
            [
              ['primary', primaryLabel],
              ['comparison', comparisonLabel],
            ] as const
          ).map(([source, label]) => (
            <button
              type="button"
              key={source}
              className={activeSource === source ? 'active' : undefined}
              onClick={() => {
                if (activeSource === source) return
                const audio = audioRef.current
                pendingSourceSwitchRef.current = {
                  currentTime: audio?.currentTime ?? startTime,
                  resume: audio ? !audio.paused : false,
                }
                audio?.pause()
                setActiveSource(source)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <span>{formatPlayerTime(relativeCurrentTime, playbackReachedEnd)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(0.01, totalDuration)}
        step={0.01}
        value={Math.min(relativeCurrentTime, Math.max(0.01, totalDuration))}
        aria-label="播放进度"
        style={{
          background: `linear-gradient(90deg, var(--primary) ${progress}%, var(--line) ${progress}%)`,
        }}
        onChange={(event) => {
          const next = Number(event.target.value)
          const absoluteTime = startTime + next
          if (audioRef.current) audioRef.current.currentTime = absoluteTime
          setCurrentTime(absoluteTime)
          onTimeChange?.(next, totalDuration)
          onAbsoluteTimeChange?.(absoluteTime)
        }}
      />
      <span>{formatPlayerTime(totalDuration, true)}</span>
      <button
        type="button"
        title={muted ? '取消静音' : '静音'}
        aria-label={muted ? '取消静音' : '静音'}
        onClick={() => setMuted((value) => !value)}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
    </div>
  )
}
