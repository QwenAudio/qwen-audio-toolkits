export interface NormalizedAudioAsset {
  id: string
  name: string
  dataUrl: string
  filePath?: string
  duration?: number
  sampleRate?: number
  channels?: number
  peaks?: number[]
}

export interface NormalizedTimedSegment {
  id: string
  start: number
  end: number
  label: string
  text?: string
}

export interface NormalizedRuntime {
  engine?: string
  inferenceSeconds?: number
  realTimeFactor?: number
}

export interface NormalizedHarnessResult {
  raw: Record<string, unknown>
  sourceAudioUrl?: string
  audio: NormalizedAudioAsset[]
  segments: NormalizedTimedSegment[]
  text?: string
  runtime: NormalizedRuntime
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const numbers = value
    .map(finiteNumber)
    .filter((item): item is number => item !== undefined)
  return numbers.length ? numbers : undefined
}

function segmentEnd(item: Record<string, unknown>, start: number): number {
  const direct = finiteNumber(item.end)
  if (direct !== undefined) return Math.max(start, direct)
  if (Array.isArray(item.timestamps)) {
    const timestamps = item.timestamps
      .map(finiteNumber)
      .filter((value): value is number => value !== undefined)
    if (timestamps.length) return Math.max(start, timestamps.at(-1) ?? start)
  }
  return start
}

function compactSpeakerLabel(
  item: Record<string, unknown>,
  speakerIds: Map<string, number>,
): string | undefined {
  const rawIndex = finiteNumber(item.speakerIndex)
  const rawLabel = stringValue(item.speaker)
  const key =
    rawIndex !== undefined
      ? `index:${rawIndex}`
      : rawLabel
        ? `label:${rawLabel.toLowerCase()}`
        : undefined
  if (!key) return undefined
  let compactIndex = speakerIds.get(key)
  if (compactIndex === undefined) {
    compactIndex = speakerIds.size
    speakerIds.set(key, compactIndex)
  }
  return `SPK ${compactIndex + 1}`
}

function normalizeSegments(
  values: unknown,
  prefix: string,
): NormalizedTimedSegment[] {
  if (!Array.isArray(values)) return []
  const speakerIds = new Map<string, number>()
  return values.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const start = finiteNumber(item.start)
    if (start === undefined) return []
    const speakerLabel = compactSpeakerLabel(item, speakerIds)
    const label =
      speakerLabel ??
      stringValue(item.keyword) ??
      stringValue(item.label) ??
      `${index + 1}`
    return [
      {
        id: stringValue(item.id) ?? `${prefix}-${index}`,
        start,
        end: segmentEnd(item, start),
        label,
        text: stringValue(item.text),
      },
    ]
  })
}

export function normalizeHarnessResult(value: object): NormalizedHarnessResult {
  const raw = value as Record<string, unknown>
  const audio: NormalizedAudioAsset[] = []
  const dataUrl = stringValue(raw.dataUrl)
  if (dataUrl) {
    audio.push({
      id: 'output',
      name: stringValue(raw.fileName) ?? '音频输出',
      dataUrl,
      filePath: stringValue(raw.filePath),
      duration: finiteNumber(raw.duration),
      sampleRate: finiteNumber(raw.sampleRate),
      channels: finiteNumber(raw.channels),
      peaks: numberArray(raw.waveform),
    })
  }
  if (Array.isArray(raw.tracks)) {
    raw.tracks.forEach((track, index) => {
      if (!track || typeof track !== 'object') return
      const item = track as Record<string, unknown>
      const trackUrl = stringValue(item.dataUrl)
      if (!trackUrl) return
      audio.push({
        id: stringValue(item.id) ?? `track-${index}`,
        name: stringValue(item.name) ?? `音轨 ${index + 1}`,
        dataUrl: trackUrl,
        filePath: stringValue(item.filePath),
        duration: finiteNumber(item.duration),
        sampleRate: finiteNumber(item.sampleRate),
        channels: finiteNumber(item.channels),
        peaks: numberArray(item.waveform),
      })
    })
  }

  return {
    raw,
    sourceAudioUrl: stringValue(raw.sourceAudioDataUrl),
    audio,
    segments: [
      ...normalizeSegments(raw.segments, 'segment'),
      ...normalizeSegments(raw.matches, 'match'),
    ],
    text: stringValue(raw.text),
    runtime: {
      engine: stringValue(raw.engine) ?? stringValue(raw.model),
      inferenceSeconds: finiteNumber(raw.inferenceSeconds),
      realTimeFactor: finiteNumber(raw.realTimeFactor),
    },
  }
}
