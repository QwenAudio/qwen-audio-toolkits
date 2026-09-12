import type { PodcastLength, PodcastScript, PodcastTurn } from './podcast'
import type { PodcastSegmentCache } from './podcastAudio'
import type { PodcastAudioResult, SourceDocument } from '../services/podcast'

export interface PodcastProjectSnapshot {
  version: 1
  source: SourceDocument | null
  sourcePath: string
  instruction: string
  length: PodcastLength
  language: 'auto' | 'zh-CN' | 'en'
  selectedLlmId: string
  selectedTtsId: string
  voiceA: string
  voiceB: string
  speakerAName: string
  speakerBName: string
  speed: number
  script: PodcastScript | null
  output: Omit<PodcastAudioResult, 'dataUrl'> | null
  outputFingerprint: string | null
  segmentCache: PodcastSegmentCache
  dismissedInitialLaunch: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function finite(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
}

function filePath(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value) && !value.includes('\0')
}

function scriptFrom(value: unknown): PodcastScript | null {
  if (!record(value)) return null
  const ids = new Set<string>()
  const turns: PodcastTurn[] = []
  for (const [index, turn] of (Array.isArray(value.turns) ? value.turns : []).entries()) {
    if (!record(turn) || typeof turn.text !== 'string') continue
    let id = text(turn.id).trim() || `podcast-restored-turn-${index + 1}`
    while (ids.has(id)) id = `${id}-restored`
    ids.add(id)
    // Preserve recoverable text even when its role or identifier needs repairing.
    turns.push({ id, speaker: turn.speaker === 'B' ? 'B' : 'A', text: turn.text })
  }
  return { title: text(value.title), language: text(value.language, 'auto'), turns }
}

function outputFrom(value: unknown): PodcastProjectSnapshot['output'] {
  if (!record(value) || !filePath(value.filePath) || !finite(value.duration) || !finite(value.sampleRate, 1) ||
    !finite(value.channels, 1) || !finite(value.sizeBytes) || !finite(value.segmentCount) ||
    !Array.isArray(value.waveform) || !value.waveform.every((point) => typeof point === 'number' && Number.isFinite(point)) ||
    !Array.isArray(value.cues)) return null
  const cues: PodcastAudioResult['cues'] = []
  let previousEnd = 0
  for (const cue of value.cues) {
    if (!record(cue) || typeof cue.turnId !== 'string' || !finite(cue.start, previousEnd) ||
      !finite(cue.end, cue.start) || cue.end > value.duration + 0.001) return null
    cues.push({ turnId: cue.turnId, start: cue.start, end: cue.end })
    previousEnd = cue.end
  }
  return {
    filePath: value.filePath,
    fileName: text(value.fileName, value.filePath.split(/[\\/]/u).at(-1)),
    duration: value.duration, sampleRate: value.sampleRate, channels: value.channels,
    sizeBytes: value.sizeBytes, segmentCount: value.segmentCount, waveform: [...value.waveform], cues,
  }
}

function validCacheKey(key: string): boolean {
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'podcast-segment-v1' ||
      !value.slice(1, 5).every((field) => typeof field === 'string') || !record(value[5])) return false
    const parameters = value[5]
    return finite(parameters.speed, 0.01) &&
      (parameters.voice === undefined || typeof parameters.voice === 'string') &&
      (parameters.sid === undefined || (finite(parameters.sid) && Number.isInteger(parameters.sid))) &&
      (parameters.language === undefined || typeof parameters.language === 'string')
  } catch {
    return false
  }
}

/** Decode each field independently so damaged audio metadata cannot hide a usable draft. */
export function readPodcastSnapshot(value: unknown): PodcastProjectSnapshot | null {
  if (!record(value) || value.version !== 1) return null
  const sourcePath = filePath(value.sourcePath) ? value.sourcePath : ''
  const source = record(value.source) && typeof value.source.text === 'string' ? {
    text: value.source.text,
    fileName: text(value.source.fileName, sourcePath.split(/[\\/]/u).at(-1)),
    characterCount: value.source.text.length,
    truncated: value.source.truncated === true,
  } : null
  const script = scriptFrom(value.script)
  const output = script ? outputFrom(value.output) : null
  const segmentCache = Object.fromEntries(Object.entries(record(value.segmentCache) ? value.segmentCache : {})
    .filter(([key, path]) => validCacheKey(key) && filePath(path)).slice(-400)) as PodcastSegmentCache
  return {
    version: 1, source, sourcePath, script, output, segmentCache,
    instruction: text(value.instruction),
    length: value.length === 'standard' || value.length === 'deep' ? value.length : 'brief',
    language: value.language === 'zh-CN' || value.language === 'en' ? value.language : 'auto',
    selectedLlmId: text(value.selectedLlmId), selectedTtsId: text(value.selectedTtsId),
    voiceA: text(value.voiceA), voiceB: text(value.voiceB),
    speakerAName: text(value.speakerAName), speakerBName: text(value.speakerBName),
    speed: finite(value.speed, 0.75) && value.speed <= 1.35 ? value.speed : 1,
    outputFingerprint: output && typeof value.outputFingerprint === 'string' ? value.outputFingerprint : null,
    dismissedInitialLaunch: value.dismissedInitialLaunch === true,
  }
}
